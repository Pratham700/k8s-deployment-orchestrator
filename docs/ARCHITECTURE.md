# Architecture

This document covers the system design, the API layer, the data/state model, and the trade-offs
behind **kdo**. For setup and usage, see the [README](../README.md).

## 1. System design

Three layers, each with a single responsibility and a clean boundary:

```
┌─────────────────────────────────────────────────────────────────────┐
│  @kdo/web  (Next 15 / React 19)                                       │
│  • DeployForm → POST spec        • RunList / RunDetail → render state  │
│  • EventSource → live updates    • NO business logic                  │
└───────────────┬───────────────────────────────────────────────────────┘
                │ HTTP: fetch (REST) + EventSource (SSE)   [CORS]
┌───────────────▼───────────────────────────────────────────────────────┐
│  @kdo/api  (Hono / Node 22)                                            │
│  • Zod-validate spec at the boundary   • route + stream                │
│  • createRun() then execute() async    • thin; no domain logic         │
└───────────────┬───────────────────────────────────────────────────────┘
                │ in-process calls
┌───────────────▼───────────────────────────────────────────────────────┐
│  @kdo/core  (pure TypeScript, no I/O)                                  │
│                                                                        │
│   OrchestrationEngine ──tick()──▶ SimulatedCluster                     │
│     │  workflow state machine        pod lifecycle + failure injection │
│     │  mutates Run, store.touch()                                      │
│     ▼                                                                  │
│   RunStore  (Map + EventEmitter)  ──subscribe()──▶ (SSE in the API)    │
└───────────────────────────────────────────────────────────────────────┘
```

Why this split: the **engine and cluster are pure and I/O-free**, so they're unit-testable with
injected timing and have no idea an HTTP server or browser exists. The API is a replaceable
transport. The UI is a replaceable view. Each layer could be swapped without touching the others.

## 2. The workflow (state machine)

A run executes an ordered list of steps. Each step transitions
`pending → running → (succeeded | failed)`; steps after a failure become `skipped`.

```
validate → ensure-namespace → render-manifest → apply → rollout → health-gate → promote
                                                            │            │
                                                     (fails here)  (times out here)
                                                            └──────┬─────┘
                                                                   ▼
                                                              rollback
                                                          ┌────────┴────────┐
                                              stable revision?         no stable revision?
                                                    │                        │
                                         restore it → ROLLED_BACK   scale to 0 → FAILED
```

Terminal run states:

| State | Meaning |
|---|---|
| `succeeded` | rollout reached desired readiness, health gate passed, revision promoted to stable |
| `rolled_back` | rollout failed **and** a previous stable revision was restored |
| `failed` | rollout failed and there was nothing stable to fall back to (failed deployment scaled to 0) |

### The simulated cluster

`SimulatedCluster` is **tick-driven**, not timer-driven: the engine calls `tick()` to advance pods
one lifecycle step at a time. This makes rollouts deterministic and trivially testable while
reproducing real Kubernetes behaviour:

- pod lifecycle: `Pending → ContainerCreating → Running → Ready`
- `RollingUpdate` brings pods up gradually (one new pod per tick); `Recreate` brings them up together
- failure injection per pod: `ImagePullBackOff` (at image pull), `CrashLoopBackOff` (after Running,
  with incrementing restart count), or a readiness stall (stays `Running`, never `Ready`)

The rollout step ticks until either all pods are ready (**success**), no pod can make further
progress (**fail fast** — image-pull/crash-loop), or the health-gate budget elapses (**timeout** —
readiness stall). On `promote`, the current revision is snapshotted as the **stable** fallback target;
`rollback` restores it.

## 3. API layer

`@kdo/api` is built as a **factory over its dependencies** (`createApp({ store, engine })`) so tests
drive it in-process with `app.request(...)` and a fast-timing engine — no socket needed.

- **`POST /api/deployments`** validates the body with the shared Zod schema. Invalid → `400` with the
  raw issues. Valid → `createRun()` (registers a `pending` run), then `execute()` is **fired without
  awaiting** and the run is returned `202`. Execution streams its progress into the store; the client
  observes it via polling or SSE. This keeps the request fast and the workflow long-running.
- **`GET /api/deployments/:id/events`** is the live channel (SSE). It subscribes to the store, and a
  small writer loop emits **at most one frame per ~150 ms**, coalescing the engine's rapid `touch()`
  calls. This keeps SSE writes strictly ordered (no interleaving) and the stream cheap. On a terminal
  state it sends a `done` event so the browser closes instead of reconnecting.

## 4. State management

The **Run** is the single source of truth (see `packages/core/src/types.ts`):

```ts
interface Run {
  id: string;                 // "dep-xxxxxxxx"
  spec: DeploymentSpec;       // validated input
  status: RunStatus;          // pending | running | succeeded | failed | rolled_back
  revision: number;           // monotonic per namespace/name
  previousRevision?: number;  // stable target at submit time (undefined on first deploy)
  steps: Step[];              // ordered; each has status, timestamps, logs[]
  rollout?: RolloutSnapshot;  // { desired, ready, revision, pods[] } — live
  manifest?: string;          // rendered Deployment YAML (dry-run artifact)
  message?: string;           // human-readable outcome
  createdAt, updatedAt;
}
```

**Ownership & flow of change:**

- The **engine** mutates the Run in place as the single writer during execution, and calls
  `store.touch(id)` after each transition.
- The **store** (`Map` + `EventEmitter`) stamps `updatedAt` and emits a per-run event.
- **SSE subscribers** receive the event and stream the (coalesced) serialized Run.
- The **UI** patches the run into both the detail view and the list, so the list badge and the detail
  stay consistent from one stream.

Holding state by reference + an event bus is what makes the whole thing feel live without polling,
and the `RunStore` surface (`create / get / list / touch / subscribe`) is intentionally the seam where
a durable store (Postgres/Redis) would drop in.

## 5. Key trade-offs

| Decision | Alternative | Why this way |
|---|---|---|
| Simulated cluster | real `kind` cluster | zero-setup evaluation, deterministic tests; kept behind a swappable class |
| In-memory store | Postgres/Redis | right size for a single-node demo; tiny interface to swap later |
| SSE | WebSockets / polling | one-way server→client, simpler, proxy-friendly, auto-reconnect |
| `tsx` runtime, typecheck-as-build | compiled `dist` | removes a build step + monorepo path-resolution pain locally |
| Type-only sharing UI↔core | duplicate types / REST codegen | one source of truth, no server runtime in the client bundle |
| Fire-and-forget `execute()` | await + long request | fast response; long workflow observed via SSE/polling |
| Failure injection as a spec field | separate chaos endpoint | every failure path is reproducible in one click for the demo |

## 6. Testing strategy

- **Engine** (`packages/core/src/engine.test.ts`) — happy path, all three failure modes, and
  rollback-to-previous-revision, all on `FAST_TIMING` so they run in milliseconds.
- **API** (`apps/api/src/app.test.ts`) — health, `400` validation, `202` + drive-to-success, `404`,
  via `app.request()` (no network).
- **Determinism** comes from the tick-based cluster + injectable `Timing`: no sleeps, no flakes.
