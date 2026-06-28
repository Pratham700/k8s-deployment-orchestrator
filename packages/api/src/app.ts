import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import {
  asRunId,
  DeploymentSpecSchema,
  isRole,
  type OrchestrationEngine,
  ROLE_PERMISSIONS,
  type Run,
  type RunStore,
} from '@kdo/core';
import { type AuthVariables, createSession, isValidApiKey, requireAuth, requirePermission } from './auth';

export interface AppDeps {
  store: RunStore;
  engine: OrchestrationEngine;
}

const isTerminal = (status: Run['status']): boolean =>
  status === 'succeeded' || status === 'failed' || status === 'rolled_back';

/**
 * HTTP API for the orchestrator. Built as a factory over its dependencies so
 * tests can drive it with a fast-timing engine via `app.request(...)`.
 */
export function createApp({ store, engine }: AppDeps): Hono<{ Variables: AuthVariables }> {
  const app = new Hono<{ Variables: AuthVariables }>();

  // The operator console (and the CLI) are separate origins — allow them,
  // including the Authorization header used to carry the session token.
  app.use('/api/*', cors({ origin: '*', allowHeaders: ['Content-Type', 'Authorization'] }));

  // --- public routes -------------------------------------------------------

  app.get('/api/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

  // Exchange the shared API key + a chosen role for a session token.
  app.post('/api/auth/login', async (c) => {
    const body: unknown = await c.req.json().catch(() => null);
    const { apiKey, role } = (body ?? {}) as { apiKey?: unknown; role?: unknown };
    if (!isValidApiKey(apiKey)) return c.json({ error: 'invalid API key' }, 401);
    if (!isRole(role)) return c.json({ error: 'unknown role' }, 400);
    const token = createSession(role);
    return c.json({ token, role, permissions: ROLE_PERMISSIONS[role] });
  });

  // --- authenticated routes ------------------------------------------------

  app.use('/api/auth/me', requireAuth);
  app.get('/api/auth/me', (c) => {
    const role = c.get('role');
    return c.json({ role, permissions: ROLE_PERMISSIONS[role] });
  });

  // Every deployment route requires a valid session.
  app.use('/api/deployments', requireAuth);
  app.use('/api/deployments/*', requireAuth);

  // List runs (newest first).
  app.get('/api/deployments', (c) => c.json({ runs: store.list() }));

  // Submit a deployment spec -> create a run and kick off execution async.
  // Mutating the platform requires the 'deployments:create' permission.
  app.post('/api/deployments', requirePermission('deployments:create'), async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = DeploymentSpecSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid deployment spec', issues: parsed.error.issues }, 400);
    }

    const run = engine.createRun(parsed.data);
    // Fire-and-forget: the workflow streams its progress into the store, which
    // the client observes via GET /:id or the SSE stream below.
    void engine.execute(run.id);
    return c.json(run, 202);
  });

  // Fetch a single run's full state (polling fallback for the UI and CLI).
  app.get('/api/deployments/:id', (c) => {
    const run = store.get(asRunId(c.req.param('id')));
    if (!run) return c.json({ error: 'run not found' }, 404);
    return c.json(run);
  });

  // The rendered Deployment manifest as raw YAML — the GitOps artifact, also
  // handy for `kdo` CLI users and CI to diff/commit.
  app.get('/api/deployments/:id/manifest', (c) => {
    const run = store.get(asRunId(c.req.param('id')));
    if (!run) return c.json({ error: 'run not found' }, 404);
    if (!run.manifest) return c.json({ error: 'manifest not rendered yet' }, 409);
    return c.body(run.manifest, 200, { 'content-type': 'application/yaml' });
  });

  // Live progress: Server-Sent Events. Coalesces rapid state changes into at
  // most one frame per tick to keep writes ordered and the stream cheap.
  app.get('/api/deployments/:id/events', (c) => {
    const id = asRunId(c.req.param('id'));
    if (!store.get(id)) return c.json({ error: 'run not found' }, 404);

    return streamSSE(c, async (stream) => {
      let aborted = false;
      stream.onAbort(() => {
        aborted = true;
      });

      let latest = store.get(id);
      let dirty = true;
      const unsubscribe = store.subscribe(id, (run) => {
        latest = run;
        dirty = true;
      });

      try {
        while (!aborted) {
          if (dirty && latest) {
            dirty = false;
            await stream.writeSSE({ event: 'update', data: JSON.stringify(latest) });
            if (isTerminal(latest.status)) {
              // Signal completion so the client can close instead of reconnecting.
              await stream.writeSSE({ event: 'done', data: latest.status });
              break;
            }
          }
          await stream.sleep(150);
        }
      } finally {
        unsubscribe();
      }
    });
  });

  return app;
}
