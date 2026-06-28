import { serve } from '@hono/node-server';
import { OrchestrationEngine, RunStore, SimulatedCluster } from '@kdo/core';
import { createApp } from './app';

// Single shared control-plane state for the process. Swap these three for
// persistent/distributed implementations and the API surface is unchanged.
const cluster = new SimulatedCluster();
const store = new RunStore();
const engine = new OrchestrationEngine(cluster, store);

const app = createApp({ store, engine });
const port = Number(process.env.PORT ?? 3001);

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`kdo-api listening on http://localhost:${info.port}`);
});
