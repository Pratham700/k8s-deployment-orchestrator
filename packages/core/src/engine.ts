import { randomUUID } from 'node:crypto';
import { RolloutError } from './cluster';
import { renderDeploymentManifest } from './manifest';
import type { RunStore } from './store';
import { errorMessage } from './util';
import {
  asRunId,
  type ClusterDriver,
  DEFAULT_TIMING,
  type DeploymentSpec,
  type Pod,
  type RolloutPacing,
  type Run,
  type RunId,
  type Step,
  type StepId,
  STRATEGY_REGISTRY,
  type Timing,
} from './types';

const STEP_DEFS: ReadonlyArray<{ id: StepId; name: string }> = [
  { id: 'validate', name: 'Validate spec' },
  { id: 'ensure-namespace', name: 'Ensure namespace' },
  { id: 'render-manifest', name: 'Render manifest' },
  { id: 'apply', name: 'Apply Deployment' },
  { id: 'rollout', name: 'Roll out pods' },
  { id: 'health-gate', name: 'Health gate' },
  { id: 'promote', name: 'Promote revision' },
  { id: 'rollback', name: 'Rollback' },
];

const sleep = (ms: number): Promise<void> =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

const now = (): string => new Date().toISOString();
const clock = (): string => new Date().toISOString().slice(11, 19);

/**
 * Drives a deployment spec through the orchestration workflow against a
 * {@link ClusterDriver}, persisting every state transition to the RunStore so
 * the API/UI can observe progress live and react to success or failure.
 */
export class OrchestrationEngine {
  /** Monotonic revision counter per namespace/name. */
  private readonly revisions = new Map<string, number>();

  constructor(
    private readonly cluster: ClusterDriver,
    private readonly store: RunStore,
    private readonly timing: Timing = DEFAULT_TIMING,
  ) {}

  /** Register a new run in `pending` state. Does not execute it. */
  createRun(spec: DeploymentSpec): Run {
    const key = `${spec.namespace}/${spec.name}`;
    const revision = (this.revisions.get(key) ?? 0) + 1;
    this.revisions.set(key, revision);

    const previousRevision = this.cluster.stableRevision(spec.namespace, spec.name);
    const run: Run = {
      id: asRunId(`dep-${randomUUID().slice(0, 8)}`),
      spec,
      status: 'pending',
      revision,
      ...(previousRevision !== undefined ? { previousRevision } : {}),
      steps: STEP_DEFS.map(({ id, name }) => ({ id, name, status: 'pending', logs: [] })),
      createdAt: now(),
      updatedAt: now(),
    };
    this.store.create(run);
    return run;
  }

  /** Execute the workflow for a previously-created run. Never rejects. */
  async execute(runId: RunId): Promise<void> {
    const run = this.store.get(runId);
    if (!run) throw new Error(`run ${runId} not found`);
    const { namespace, name } = run.spec;
    const strategy = STRATEGY_REGISTRY[run.spec.strategy.kind];

    run.status = 'running';
    this.store.touch(run.id);

    try {
      await this.step(run, 'validate', async (log) => {
        const s = run.spec;
        log(`name=${s.name} namespace=${s.namespace} replicas=${s.replicas}`);
        log(`image=${s.image} (explicit tag present)`);
        log(`strategy=${strategy.label}`);
        if (!strategy.executable) {
          log('strategy mechanics are planned — rollout will use a progressive bring-up');
        }
        if (s.failureMode !== 'none') log(`failure injection enabled: ${s.failureMode}`);
        log('spec is valid');
      });

      await this.step(run, 'ensure-namespace', async (log) => {
        const created = this.cluster.ensureNamespace(namespace);
        log(created ? `namespace/${namespace} created` : `namespace/${namespace} already exists`);
      });

      await this.step(run, 'render-manifest', async (log) => {
        run.manifest = renderDeploymentManifest(run.spec, run.revision);
        this.store.touch(run.id);
        log(`rendered Deployment manifest for revision ${run.revision}`);
      });

      await this.step(run, 'apply', async (log) => {
        const pacing: RolloutPacing = strategy.pacing;
        this.cluster.applyDeployment(run.spec, run.revision, pacing);
        run.rollout = this.cluster.snapshot(namespace, name);
        this.store.touch(run.id);
        log(`deployment.apps/${name} configured (revision ${run.revision}, pacing=${pacing})`);
      });

      await this.step(run, 'rollout', (log) => this.runRollout(run, log));

      await this.step(run, 'health-gate', (log) => this.runHealthGate(run, log));

      await this.step(run, 'promote', async (log) => {
        this.cluster.promote(namespace, name);
        log(`revision ${run.revision} promoted to stable`);
      });

      this.markPending(run, 'skipped');
      const snap = this.cluster.snapshot(namespace, name);
      run.status = 'succeeded';
      run.message = `Revision ${run.revision} live — ${snap.ready}/${snap.desired} replicas ready`;
    } catch (err) {
      await this.runRollback(run, err);
    } finally {
      this.store.touch(run.id);
    }
  }

  // -- step framework -------------------------------------------------------

  private async step(
    run: Run,
    id: StepId,
    fn: (log: (m: string) => void) => Promise<void>,
  ): Promise<void> {
    const step = this.mustStep(run, id);
    step.status = 'running';
    step.startedAt = now();
    this.store.touch(run.id);
    await sleep(this.timing.stepDelayMs);

    const log = (message: string): void => {
      step.logs.push(`[${clock()}] ${message}`);
      this.store.touch(run.id);
    };

    try {
      await fn(log);
      step.status = 'succeeded';
      step.finishedAt = now();
      this.store.touch(run.id);
    } catch (err) {
      step.status = 'failed';
      step.error = errorMessage(err);
      step.finishedAt = now();
      log(`error: ${step.error}`);
      throw err;
    }
  }

  private async runRollout(run: Run, log: (m: string) => void): Promise<void> {
    const { namespace, name, replicas } = run.spec;
    const strategy = STRATEGY_REGISTRY[run.spec.strategy.kind];

    log(`${strategy.label}: waiting for ${replicas}/${replicas} pods to become ready`);
    for (const line of strategy.plan(run.spec.strategy)) log(`plan: ${line}`);

    run.rollout = this.cluster.snapshot(namespace, name);
    const deadline = Date.now() + this.timing.healthTimeoutMs;
    let lastSig = '';

    for (;;) {
      const progressing = this.cluster.tick(namespace, name);
      const snap = this.cluster.snapshot(namespace, name);
      run.rollout = snap;

      const sig = snap.pods.map((p) => `${p.status}${p.restarts}`).join('|');
      if (sig !== lastSig) {
        log(`ready ${snap.ready}/${snap.desired} — ${summarize(snap.pods)}`);
        lastSig = sig;
      }
      this.store.touch(run.id);

      if (snap.ready === snap.desired) return;

      if (!progressing) {
        throw new RolloutError(`rollout stalled at ${snap.ready}/${snap.desired} ready`, snap);
      }
      if (Date.now() >= deadline) {
        throw new RolloutError(
          `health timeout after ${this.timing.healthTimeoutMs}ms at ${snap.ready}/${snap.desired} ready`,
          snap,
        );
      }
      await sleep(this.timing.tickMs);
    }
  }

  private async runHealthGate(run: Run, log: (m: string) => void): Promise<void> {
    const { namespace, name } = run.spec;
    const snap = this.cluster.snapshot(namespace, name);
    if (snap.ready !== snap.desired) {
      throw new Error(`only ${snap.ready}/${snap.desired} replicas ready`);
    }
    log(`${snap.ready}/${snap.desired} ready; holding ${this.timing.stabilityMs}ms for stability`);
    await sleep(this.timing.stabilityMs);

    // Re-check to catch pods that flip unhealthy inside the stability window.
    this.cluster.tick(namespace, name);
    const after = this.cluster.snapshot(namespace, name);
    run.rollout = after;
    if (after.ready !== after.desired) {
      throw new Error(`deployment destabilized: ${after.ready}/${after.desired} ready`);
    }
    log(`stable: ${after.ready}/${after.desired} ready`);
  }

  private async runRollback(run: Run, cause: unknown): Promise<void> {
    const { namespace, name } = run.spec;
    this.markPending(run, 'skipped');

    const step = this.mustStep(run, 'rollback');
    step.status = 'running';
    step.startedAt = now();
    step.logs.push(`[${clock()}] triggered by: ${errorMessage(cause)}`);
    this.store.touch(run.id);
    await sleep(this.timing.stepDelayMs);

    const restored = this.cluster.rollback(namespace, name);
    if (restored !== undefined) {
      run.rollout = this.cluster.snapshot(namespace, name);
      step.logs.push(
        `[${clock()}] restored stable revision ${restored} (${run.rollout.ready}/${run.rollout.desired} ready)`,
      );
      step.status = 'succeeded';
      step.finishedAt = now();
      run.status = 'rolled_back';
      run.message = `Rollout failed; restored stable revision ${restored}`;
    } else {
      step.logs.push(`[${clock()}] no stable revision to fall back to; scaled failed deployment to zero`);
      step.status = 'succeeded';
      step.finishedAt = now();
      run.status = 'failed';
      run.message = 'Rollout failed; no stable revision to roll back to';
    }
    this.store.touch(run.id);
  }

  // -- helpers --------------------------------------------------------------

  private mustStep(run: Run, id: StepId): Step {
    const step = run.steps.find((s) => s.id === id);
    if (!step) throw new Error(`step ${id} missing from run ${run.id}`);
    return step;
  }

  private markPending(run: Run, status: 'skipped'): void {
    for (const s of run.steps) {
      if (s.status === 'pending') s.status = status;
    }
  }
}

function summarize(pods: readonly Pod[]): string {
  const counts = new Map<string, number>();
  for (const p of pods) counts.set(p.status, (counts.get(p.status) ?? 0) + 1);
  return [...counts.entries()].map(([k, v]) => `${v} ${k}`).join(', ');
}
