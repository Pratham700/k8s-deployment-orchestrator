import { describe, expect, it } from 'vitest';
import { FAST_TIMING, OrchestrationEngine, type Role, RunStore, type Run, SimulatedCluster } from '@kdo/core';
import { createApp } from './app';
import { API_KEY } from './auth';

function makeApp() {
  const cluster = new SimulatedCluster();
  const store = new RunStore();
  const engine = new OrchestrationEngine(cluster, store, FAST_TIMING);
  return createApp({ store, engine });
}

async function login(app: ReturnType<typeof makeApp>, role: Role, apiKey: string = API_KEY): Promise<string> {
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey, role }),
  });
  const body = (await res.json()) as { token: string };
  return body.token;
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

const post = (app: ReturnType<typeof makeApp>, body: unknown, token: string) =>
  app.request('/api/deployments', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth(token) },
    body: JSON.stringify(body),
  });

async function waitForTerminal(app: ReturnType<typeof makeApp>, id: string, token: string): Promise<Run> {
  for (let i = 0; i < 300; i++) {
    const res = await app.request(`/api/deployments/${id}`, { headers: auth(token) });
    const run = (await res.json()) as Run;
    if (['succeeded', 'failed', 'rolled_back'].includes(run.status)) return run;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('run did not reach a terminal state');
}

describe('API — auth', () => {
  it('reports health without auth', async () => {
    const res = await makeApp().request('/api/health');
    expect(res.status).toBe(200);
  });

  it('issues a token for a valid key + role, rejects a bad key/role', async () => {
    const app = makeApp();
    const ok = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: API_KEY, role: 'platform-team' }),
    });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { token: string }).token).toBeTruthy();

    const badKey = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: 'nope', role: 'platform-team' }),
    });
    expect(badKey.status).toBe(401);

    const badRole = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ apiKey: API_KEY, role: 'intern' }),
    });
    expect(badRole.status).toBe(400);
  });

  it('rejects unauthenticated access to deployments', async () => {
    const res = await makeApp().request('/api/deployments');
    expect(res.status).toBe(401);
  });
});

describe('API — RBAC', () => {
  it('forbids an engineering-manager from creating a deployment (403)', async () => {
    const app = makeApp();
    const token = await login(app, 'engineering-manager');
    const res = await post(app, { name: 'web', image: 'nginx:1.27', replicas: 2 }, token);
    expect(res.status).toBe(403);
  });

  it('lets an engineering-manager read deployments', async () => {
    const app = makeApp();
    const token = await login(app, 'engineering-manager');
    const res = await app.request('/api/deployments', { headers: auth(token) });
    expect(res.status).toBe(200);
  });

  it('lets a platform-team member deploy and drives it to success', async () => {
    const app = makeApp();
    const token = await login(app, 'platform-team');
    const res = await post(
      app,
      { name: 'web', namespace: 'demo', image: 'nginx:1.27', replicas: 2, failureMode: 'none' },
      token,
    );
    expect(res.status).toBe(202);
    const run = (await res.json()) as Run;
    const final = await waitForTerminal(app, run.id, token);
    expect(final.status).toBe('succeeded');
  });
});

describe('API — deployments', () => {
  it('rejects an invalid spec with 400 (when authorized)', async () => {
    const app = makeApp();
    const token = await login(app, 'devops-engineer');
    const res = await post(app, { name: 'web', image: 'nginx' }, token);
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown run', async () => {
    const app = makeApp();
    const token = await login(app, 'devops-engineer');
    const res = await app.request('/api/deployments/dep-nope', { headers: auth(token) });
    expect(res.status).toBe(404);
  });
});
