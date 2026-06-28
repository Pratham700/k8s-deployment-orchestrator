import { describe, expect, it } from 'vitest';
import { OrchestrationEngine } from './engine';
import { RunStore } from './store';
import { SimulatedCluster } from './cluster';
import { renderDeploymentManifest } from './manifest';
import {
  DeploymentSpecSchema,
  FAST_TIMING,
  type DeploymentSpec,
  type Run,
  type RunId,
  type StepId,
} from './types';

function spec(overrides: Partial<DeploymentSpec> = {}): DeploymentSpec {
  return DeploymentSpecSchema.parse({
    name: 'web',
    namespace: 'demo',
    image: 'nginx:1.27',
    replicas: 3,
    ...overrides,
  });
}

/** Fetch a run that must exist (avoids non-null assertions in tests). */
function mustGet(store: RunStore, id: RunId): Run {
  const run = store.get(id);
  if (!run) throw new Error(`run ${id} not found`);
  return run;
}

/** Run a single deployment to completion on a fresh stack. */
async function runOnce(overrides: Partial<DeploymentSpec> = {}): Promise<Run> {
  const cluster = new SimulatedCluster();
  const store = new RunStore();
  const engine = new OrchestrationEngine(cluster, store, FAST_TIMING);
  const run = engine.createRun(spec(overrides));
  await engine.execute(run.id);
  return mustGet(store, run.id);
}

const stepStatus = (run: Run, id: StepId): string | undefined =>
  run.steps.find((s) => s.id === id)?.status;

describe('OrchestrationEngine — happy path', () => {
  it('promotes a healthy rollout and skips rollback', async () => {
    const run = await runOnce({ failureMode: 'none', replicas: 3 });

    expect(run.status).toBe('succeeded');
    expect(run.rollout).toMatchObject({ desired: 3, ready: 3 });
    expect(stepStatus(run, 'rollout')).toBe('succeeded');
    expect(stepStatus(run, 'promote')).toBe('succeeded');
    expect(stepStatus(run, 'rollback')).toBe('skipped');
    expect(run.manifest).toContain('kind: Deployment');
  });

  it('runs the Recreate strategy (parallel pacing) to success', async () => {
    const run = await runOnce({ strategy: { kind: 'Recreate' }, replicas: 4 });
    expect(run.status).toBe('succeeded');
    expect(run.rollout).toMatchObject({ desired: 4, ready: 4 });
  });
});

describe('OrchestrationEngine — failure modes (no prior stable revision)', () => {
  for (const failureMode of ['image-pull', 'crash-loop', 'readiness-timeout'] as const) {
    it(`fails closed on ${failureMode} and reports no rollback target`, async () => {
      const run = await runOnce({ failureMode, replicas: 2 });

      expect(run.status).toBe('failed');
      const broke =
        stepStatus(run, 'rollout') === 'failed' || stepStatus(run, 'health-gate') === 'failed';
      expect(broke).toBe(true);
      expect(stepStatus(run, 'promote')).toBe('skipped');
      expect(stepStatus(run, 'rollback')).toBe('succeeded');
      expect(run.message).toMatch(/no stable revision/i);
    });
  }
});

describe('OrchestrationEngine — rollback to previous revision', () => {
  it('restores the last promoted revision when a new rollout fails', async () => {
    const cluster = new SimulatedCluster();
    const store = new RunStore();
    const engine = new OrchestrationEngine(cluster, store, FAST_TIMING);

    const first = engine.createRun(spec({ failureMode: 'none' }));
    await engine.execute(first.id);
    expect(mustGet(store, first.id).status).toBe('succeeded');

    const second = engine.createRun(spec({ failureMode: 'crash-loop' }));
    expect(second.revision).toBe(2);
    expect(second.previousRevision).toBe(1);
    await engine.execute(second.id);

    const run = mustGet(store, second.id);
    expect(run.status).toBe('rolled_back');
    expect(run.message).toMatch(/restored stable revision 1/i);
    expect(stepStatus(run, 'rollback')).toBe('succeeded');
    expect(run.rollout).toMatchObject({ revision: 1, desired: 3, ready: 3 });
  });
});

describe('Strategy model — planned strategies are typed, validated, and runnable', () => {
  it('runs a Canary spec (mechanics planned) and logs the plan', async () => {
    const run = await runOnce({ strategy: { kind: 'Canary', trafficPercent: 20, bakeSeconds: 30 } });
    expect(run.status).toBe('succeeded');
    const rolloutLogs = run.steps.find((s) => s.id === 'rollout')?.logs.join('\n') ?? '';
    expect(rolloutLogs).toMatch(/route 20% of traffic/);
    expect(rolloutLogs).toMatch(/not enforced in this build/);
  });

  it('renders strategy intent + recommended labels into the manifest', () => {
    const yaml = renderDeploymentManifest(
      spec({ strategy: { kind: 'Canary', trafficPercent: 25, bakeSeconds: 60 } }),
      1,
    );
    expect(yaml).toContain('app.kubernetes.io/managed-by: kdo');
    expect(yaml).toContain('kdo.dev/strategy: Canary');
    expect(yaml).toContain('kdo.dev/canary-traffic-percent: "25"');
    expect(yaml).toContain('kdo.dev/canary-bake-seconds: "60"');
  });
});

describe('DeploymentSpecSchema validation', () => {
  it('rejects an image without an explicit tag', () => {
    expect(() => spec({ image: 'nginx' })).toThrow(/explicit tag/);
  });
  it('rejects replica counts outside 1..10', () => {
    expect(() => spec({ replicas: 0 })).toThrow();
    expect(() => spec({ replicas: 99 })).toThrow();
  });
  it('rejects non DNS-1123 names', () => {
    expect(() => spec({ name: 'Web_Server' })).toThrow(/DNS-1123/);
  });
  it('rejects a Canary traffic percent outside 1..100', () => {
    expect(() =>
      spec({ strategy: { kind: 'Canary', trafficPercent: 250, bakeSeconds: 10 } }),
    ).toThrow();
  });
});
