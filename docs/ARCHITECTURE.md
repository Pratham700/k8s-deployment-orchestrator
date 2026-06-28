# Architecture

This document covers the system design, the API layer, the data/state model, and the trade-offs
behind **kdo**. For setup and usage, see the [README](../README.md).

## 1. System design

Three layers, each with a single responsibility and a clean boundary:

```
┌────────────────────────────────────┐   ┌────────────────────────────────────┐
│  @kdo/web (Next 15 / React 19)      │   │  @kdo/cli (`kdo apply -f`)          │
│  operator console, live via SSE     │   │  YAML config, CI exit codes         │
└──────────────────┬──────────────────┘   └──────────────────┬──────────────────┘
                   │ fetch (REST) + EventSource (SSE)         │ fetch (REST)
                   └────────────────────┬─────────────────────┘            [CORS]
┌───────────────────────────────────────▼───────────────────────────────────────┐
│  @kdo/api  (Hono / Node 22)                                                    │
│  • Zod-validate spec at the boundary   • route + stream   • thin, no domain    │
└───────────────────────────────────────┬───────────────────────────────────────┘
                │ in-process calls
┌───────────────▼───────────────────────────────────────────────────────────────┐
│  @kdo/core  (pure TypeScript, no I/O)                                          │
│                                                                                │
│   OrchestrationEngine ──tick()──▶  ClusterDriver  (interface)                  │
│     │  workflow state machine          ▲   implemented today by SimulatedCluster│
│     │  consults STRATEGY_REGISTRY      └── future: KubernetesDriver / Argo GitOps│
│     │  mutates Run, store.touch()                                              │
│     ▼                                                                          │
│   RunStore  (Map + EventEmitter)  ──subscribe()──▶ (SSE in the API)            │
└─────────────────────────────────────────────────────────────────────────────┘
```

Two clients, one API, one engine, one `DeploymentSpec` schema. The engine depends on the
`ClusterDriver` *interface*, never the concrete simulator.

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

### Strategies (the extension point)

`DeploymentStrategy` is a discriminated union and every strategy has one entry in `STRATEGY_REGISTRY`:

```ts
interface StrategyDescriptor {
  kind: StrategyKind;
  label: string;
  executable: boolean;              // are the strategy's mechanics built?
  pacing: 'gradual' | 'parallel';   // how the cluster brings pods up
  plan(strategy): readonly string[]; // human plan, surfaced in the rollout log
}
```

The engine reads the descriptor — it never branches on the strategy string. `RollingUpdate` and
`Recreate` are `executable`. `BlueGreen` and `Canary` are `executable: false`: fully typed, validated
(Canary requires `trafficPercent` + `bakeSeconds`), rendered into manifest annotations, and shown in
the UI/CLI — but their traffic mechanics aren't built yet, so the rollout logs their `plan()` ("not
enforced in this build") and runs a progressive bring-up. Implementing one later means filling in a
descriptor + a rollout branch, not reworking the engine.

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
| Simulated cluster | real `kind` cluster | zero-setup evaluation, deterministic tests; behind the swappable `ClusterDriver` interface |
| In-memory store | Postgres/Redis | right size for a single-node demo; tiny interface to swap later |
| SSE | WebSockets / polling | one-way server→client, simpler, proxy-friendly, auto-reconnect |
| `tsx` runtime, typecheck-as-build | compiled `dist` | removes a build step + monorepo path-resolution pain locally |
| Type-only sharing UI↔core | duplicate types / REST codegen | one source of truth, no server runtime in the client bundle |
| Fire-and-forget `execute()` | await + long request | fast response; long workflow observed via SSE/polling |
| Failure injection as a spec field | separate chaos endpoint | every failure path is reproducible in one click for the demo |

## 6. GitOps readiness (designed for, not built)

The tool is shaped so an Argo CD / GitOps backend is an addition, not a rewrite:

- **The seam is the `ClusterDriver` interface.** Today `SimulatedCluster` implements it. A
  `GitOpsClusterDriver` would, behind the same methods, render the manifest → commit it to a Git repo
  (or upsert an Argo `Application`) → and translate Argo's sync/health status back into the same
  `RolloutSnapshot` the engine already consumes. The workflow, store, API, and UI stay untouched.
- **The manifest is already the GitOps artifact.** `renderDeploymentManifest` emits the recommended
  `app.kubernetes.io/{name,version,managed-by}` labels and `kdo.dev/*` annotations (incl. canary
  weight/bake), and is exposed at `GET /api/deployments/:id/manifest` — ready to be committed/diffed.
- **Declarative input.** A `DeploymentSpec` is a serializable declaration, and the CLI already drives
  the system from a YAML file — the same shape a GitOps reconciler would consume.

## 7. CLI as a first-class client

`@kdo/cli` (`kdo apply -f`) is not a separate code path to the engine: it is an HTTP client of the
same API the UI uses. It loads a YAML config, validates it with the **shared** `DeploymentSpecSchema`,
submits each deployment, and polls to a terminal state, printing steps as they settle. It exits `0`
(all succeeded), `1` (a rollout failed/rolled back), or `2` (usage/connection) so it fits a CI gate.
Keeping the API as the single control plane is what makes the UI and CLI behave identically.

## 8. Authentication & RBAC (demo-only)

A thin layer demonstrates platform RBAC — *who may trigger a deploy vs. who only observes* — without a
real IdP (out of scope for the assignment). The pieces:

- **Roles & permissions live in `@kdo/core`** (`ROLES`, `ROLE_PERMISSIONS`, `roleHasPermission`) — a
  pure data model shared by the API (enforcement) and reused conceptually by the UI/CLI.
  `engineering-manager` holds only `deployments:read`; `devops-engineer` and `platform-team` also hold
  `deployments:create`.
- **One shared API key** (`KDO_API_KEY`, default `kdo-dev-key-2026`) exchanged at `POST
  /api/auth/login` for an opaque session token; the API holds a `Map<token, role>` (same in-memory,
  reset-on-restart shape as the RunStore).
- **Two middlewares** (`apps/api/src/auth.ts`): `requireAuth` (valid token → attaches `role` to the
  Hono context) guards every `/api/deployments*` route; `requirePermission('deployments:create')`
  gates `POST /api/deployments`. The SSE route reads the token from `?token=` because `EventSource`
  can't send headers.
- **Defence in depth in the UI**: the read-only role sees the Deploy button disabled *and* the API
  returns `403` if it tries anyway.

This is explicitly *not* production auth (no signing/expiry/hashing). The value is the **seam**: swap
the login handler + `requireAuth` for OIDC/JWT and the role→permission map is unchanged.

## 9. Type safety

- **Branded `RunId`** (`string & { __brand }`) — a plain string can't be passed where a run id is
  expected; `asRunId()` is the one sanctioned crossing point, used at the HTTP boundary.
- **Discriminated unions + `assertNever`** — strategy and pod-status switches fail to compile if a new
  variant isn't handled.
- **`readonly` state + defensive copies** — `RolloutSnapshot`/`Pod` are readonly and the cluster
  returns copies, so serialized run state can't be mutated by a consumer.
- **Zod at every boundary** — the spec is parsed (not cast) in the API and the CLI; `any` is absent and
  `unknown` appears only where it's correct (caught errors, parsed JSON) and is then narrowed.
- **Compiler**: `strict`, `noUncheckedIndexedAccess`, `noImplicitReturns`,
  `noFallthroughCasesInSwitch`, `noUnusedLocals/Parameters`.

## 10. Testing strategy

- **Engine + auth** (`packages/core`, 15 tests) — happy path, Recreate, all three failure modes,
  rollback-to-previous-revision, Canary plan logging, manifest annotations, spec validation, and the
  role→permission matrix.
- **API** (`apps/api/src/app.test.ts`, 8 tests) — health, login (valid/bad key/bad role),
  unauthenticated `401`, RBAC `403` for a manager + `202` for platform-team, `400` validation, `404`.
- **CLI** (`apps/cli/src/config.test.ts`) — config parsing, schema defaults, invalid-canary rejection.
- **Determinism** comes from the tick-based cluster + injectable `Timing`: no sleeps, no flakes.
