import { describe, expect, it } from 'vitest';
import { OrchestrationEngine } from './engine';
import { RunStore } from './store';
import { SimulatedCluster } from './cluster';
import { DeploymentSpecSchema, FAST_TIMING, type DeploymentSpec, type Run, type StepId } from './types';

function spec(overrides: Partial<DeploymentSpec> = {}): DeploymentSpec {
  return DeploymentSpecSchema.parse({
    name: 'web',
    namespace: 'demo',
    image: 'nginx:1.27',
    replicas: 3,
    ...overrides,
  });
}

/** Run a single deployment to completion on a fresh stack. */
async function runOnce(overrides: Partial<DeploymentSpec> = {}): Promise<Run> {
  const cluster = new SimulatedCluster();
  const store = new RunStore();
  const engine = new OrchestrationEngine(cluster, store, FAST_TIMING);
  const run = engine.createRun(spec(overrides));
  await engine.execute(run.id);
  return store.get(run.id)!;
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
});

describe('OrchestrationEngine — failure modes (no prior stable revision)', () => {
  for (const failureMode of ['image-pull', 'crash-loop', 'readiness-timeout'] as const) {
    it(`fails closed on ${failureMode} and reports no rollback target`, async () => {
      const run = await runOnce({ failureMode, replicas: 2 });

      expect(run.status).toBe('failed');
      // The rollout (or its health gate) is where it breaks...
      const broke =
        stepStatus(run, 'rollout') === 'failed' || stepStatus(run, 'health-gate') === 'failed';
      expect(broke).toBe(true);
      // ...promote never runs, and rollback runs but has nothing to restore.
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

    // Revision 1: healthy, gets promoted to stable.
    const first = engine.createRun(spec({ failureMode: 'none' }));
    await engine.execute(first.id);
    expect(store.get(first.id)!.status).toBe('succeeded');

    // Revision 2: broken — should fall back to revision 1.
    const second = engine.createRun(spec({ failureMode: 'crash-loop' }));
    expect(second.revision).toBe(2);
    expect(second.previousRevision).toBe(1);
    await engine.execute(second.id);

    const run = store.get(second.id)!;
    expect(run.status).toBe('rolled_back');
    expect(run.message).toMatch(/restored stable revision 1/i);
    expect(stepStatus(run, 'rollback')).toBe('succeeded');
    // Cluster is back to a healthy, fully-ready state.
    expect(run.rollout).toMatchObject({ revision: 1, desired: 3, ready: 3 });
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
});
