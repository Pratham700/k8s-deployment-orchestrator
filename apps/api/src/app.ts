import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import {
  DeploymentSpecSchema,
  type OrchestrationEngine,
  type Run,
  type RunStore,
} from '@kdo/core';

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
export function createApp({ store, engine }: AppDeps): Hono {
  const app = new Hono();

  // The operator console is served from a different origin (Next on :3000).
  app.use('/api/*', cors());

  app.get('/api/health', (c) => c.json({ status: 'ok', time: new Date().toISOString() }));

  // List runs (newest first).
  app.get('/api/deployments', (c) => c.json({ runs: store.list() }));

  // Submit a deployment spec -> create a run and kick off execution async.
  app.post('/api/deployments', async (c) => {
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

  // Fetch a single run's full state (polling fallback for the UI).
  app.get('/api/deployments/:id', (c) => {
    const run = store.get(c.req.param('id'));
    if (!run) return c.json({ error: 'run not found' }, 404);
    return c.json(run);
  });

  // Live progress: Server-Sent Events. Coalesces rapid state changes into at
  // most one frame per tick to keep writes ordered and the stream cheap.
  app.get('/api/deployments/:id/events', (c) => {
    const id = c.req.param('id');
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
