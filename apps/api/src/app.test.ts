import { describe, expect, it } from 'vitest';
import { FAST_TIMING, OrchestrationEngine, RunStore, SimulatedCluster, type Run } from '@kdo/core';
import { createApp } from './app';

function makeApp() {
  const cluster = new SimulatedCluster();
  const store = new RunStore();
  const engine = new OrchestrationEngine(cluster, store, FAST_TIMING);
  return createApp({ store, engine });
}

const post = (app: ReturnType<typeof makeApp>, body: unknown) =>
  app.request('/api/deployments', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

async function waitForTerminal(app: ReturnType<typeof makeApp>, id: string): Promise<Run> {
  for (let i = 0; i < 300; i++) {
    const res = await app.request(`/api/deployments/${id}`);
    const run = (await res.json()) as Run;
    if (['succeeded', 'failed', 'rolled_back'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('run did not reach a terminal state');
}

describe('API', () => {
  it('reports health', async () => {
    const res = await makeApp().request('/api/health');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('ok');
  });

  it('rejects an invalid spec with 400 and zod issues', async () => {
    const res = await post(makeApp(), { name: 'web', image: 'nginx' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: unknown[] };
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('accepts a spec (202), then drives it to success', async () => {
    const app = makeApp();
    const res = await post(app, {
      name: 'web',
      namespace: 'demo',
      image: 'nginx:1.27',
      replicas: 2,
      failureMode: 'none',
    });
    expect(res.status).toBe(202);
    const run = (await res.json()) as Run;
    expect(run.id).toMatch(/^dep-/);

    const final = await waitForTerminal(app, run.id);
    expect(final.status).toBe('succeeded');
    expect(final.rollout).toMatchObject({ desired: 2, ready: 2 });
  });

  it('returns 404 for an unknown run', async () => {
    const res = await makeApp().request('/api/deployments/dep-nope');
    expect(res.status).toBe(404);
  });
});
