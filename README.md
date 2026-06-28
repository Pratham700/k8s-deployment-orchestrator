# ⎈ kdo — Kubernetes Deploy Orchestrator

A small, end-to-end **platform engineering tool** that takes a deployment spec, drives it through a
progressive rollout against a (simulated) Kubernetes cluster, **health-gates** the result, and
**automatically rolls back** to the last healthy revision when a rollout goes bad — all observable
live in an operator console.

> **Timebox:** built as a take-home assessment. The emphasis is a well-scoped problem executed
> thoroughly: clean separation of UI / API / engine, sensible state model, honest failure handling,
> and a UI an operator would actually use.

---

## The problem (why this use case)

"Did my deploy actually come up healthy, and what happens when it doesn't?" is the question every
platform team builds tooling around. A raw `kubectl apply` returns immediately — it tells you the
objects were *accepted*, not that the workload is *healthy*. Teams then bolt on rollout-status
polling, readiness gates, and rollback runbooks, usually buried in CI logs where an operator can't
see what's happening.

**kdo** models that control loop as a first-class workflow with visible state:

- **input** → a deployment spec (image, replicas, namespace, strategy)
- **workflow** → validate → ensure namespace → render manifest → apply → roll out → **health gate** → promote
- **failure** → if the rollout can't reach its desired ready state, it **rolls back** to the last
  promoted revision (or tears the failed deployment down if there's nothing stable to fall back to)
- **result** → a clear terminal state (`succeeded` / `rolled_back` / `failed`) with per-step logs

It's deliberately the "small, thorough" end of the spectrum from the brief: one real operational
loop, done properly, instead of a broad-but-shallow dashboard.

## What you can see it do

The deploy form has a **failure injection** dropdown so the interesting paths are reproducible on
demand against the in-process cluster simulator:

| Failure mode | What the cluster does | What the workflow does |
|---|---|---|
| `none` | pods reach `Ready` | health gate passes → **promote** → `succeeded` |
| `image-pull` | pods stick in `ImagePullBackOff` | rollout fails fast → **rollback** |
| `crash-loop` | pods reach `Running` then `CrashLoopBackOff` | rollout fails fast → **rollback** |
| `readiness-timeout` | pods stay `Running`, never `Ready` | health gate **times out** → **rollback** |

Deploy once with `none` (promotes revision 1), then again with `crash-loop`, and you'll watch it
fail and **restore revision 1** — the full safe-deploy story.

### Deployment strategies (extensible)

The strategy is a discriminated union backed by a single `STRATEGY_REGISTRY`, so adding one is a
single entry rather than scattered conditionals:

| Strategy | Status | Behaviour |
|---|---|---|
| `RollingUpdate` | executable | surge one pod at a time |
| `Recreate` | executable | bring all pods up together |
| `BlueGreen` | typed/validated; **mechanics planned** | rollout logs the plan, runs a progressive bring-up |
| `Canary` | typed/validated; **mechanics planned** | requires `trafficPercent` + `bakeSeconds`; plan is logged |

Blue-Green and Canary are intentionally **not yet executed** as traffic-management mechanisms — they
are fully modelled (types, Zod validation, UI inputs, manifest annotations, registry) so the feature
is a drop-in later. Selecting Canary in the UI reveals its **traffic %** and **bake period** inputs;
the rendered manifest records the intent as `kdo.dev/strategy: Canary` + `kdo.dev/canary-*`
annotations — exactly how a rollout controller (e.g. Argo Rollouts) would discover them.

---

## Architecture at a glance

```
  Operator console (Next/React)          kdo CLI (YAML config, CI)
        │  fetch + EventSource (SSE)            │  fetch (REST), exit codes
        └───────────────┬──────────────────────┘
                        ▼
  @kdo/api — Hono on Node 22   (the single control plane)
        │  createRun() → execute() [async, fire-and-forget]
        ▼
  @kdo/core
     ├── OrchestrationEngine ──tick()──▶ ClusterDriver  ◀── SimulatedCluster (today)
     │        │ consults STRATEGY_REGISTRY                  └─ KubernetesDriver / Argo GitOps (future)
     │        │ mutates run state + store.touch()
     │        ▼
     └── RunStore (in-memory Map + EventEmitter) ──subscribe()──▶ SSE stream back to clients
```

Two clients (UI + CLI), one API, one engine, one validation schema — that uniformity is deliberate.

- **UI** initiates a run and renders live progress; it holds **zero** business logic.
- **API** is a thin, well-typed HTTP boundary (validation + routing + streaming).
- **Engine** owns the workflow state machine; the **cluster** owns resource state; the **store** owns
  persistence + change notification.

A full write-up — data model, state transitions, and the key trade-offs — is in
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Monorepo | **pnpm 10** workspaces + **Nx 20** | task graph, caching, `affected`; one place for shared config |
| Language | **TypeScript 5.9** (strict, `noUncheckedIndexedAccess`) | production stack; types shared UI↔API↔engine |
| Backend | **Hono 4** + `@hono/node-server` | tiny, fast, first-class streaming (SSE); Lambda-portable |
| Validation | **Zod** | spec is validated once at the API boundary; types inferred from the schema |
| Frontend | **Next 15** (App Router) + **React 19** | required stack; minimal hand-rolled UI, no component library |
| CLI | **TypeScript** + **yaml** + **zod** | config-file driven, HTTP client to the API, CI exit codes |
| Tests | **Vitest** | fast; deterministic engine tests via injectable timing |
| Runtime | **Node 22** (pinned via `mise` / `.nvmrc`) | matches the brief |

Type safety throughout: `strict` + `noUncheckedIndexedAccess` + `noImplicitReturns` +
`noFallthroughCasesInSwitch` + `noUnusedLocals/Parameters`, a branded `RunId`, discriminated unions
with `assertNever` exhaustiveness guards, and Zod at every external boundary (no `any`; `unknown` only
where it's correct — caught errors and parsed JSON — then narrowed).

---

## Quickstart

**No cloud account, cluster, or API key is required** — the Kubernetes control plane is simulated
in-process. Pick whichever path you prefer:

### Option A — Docker (zero local installs)

Only Docker is required. One command builds the image and starts both services:

```bash
docker compose up --build
```

`web` waits for `api` to report healthy before it starts (Compose `depends_on: service_healthy`).
Then open **http://localhost:3000**.

### Option B — Node + Nx (one command)

**Prerequisites:** Node 22 + pnpm 10 (`mise install` reads `mise.toml`; `.nvmrc` pins Node 22).
A single command installs, builds, and starts both servers **in order** (api → health-gate → web):

```bash
pnpm start
```

This runs the Nx `@kdo/web:serve` target, whose `dependsOn` builds `@kdo/core`, `@kdo/api`, and
`@kdo/web` first (the same "build the infra before the app" ordering an IDP uses), then an
orchestrator starts the API, waits for `/api/health`, and only then starts the web console.

Then open **http://localhost:3000**. The login form pre-fills the demo API key — pick a role
(start with **Platform Team**) and sign in, then click **Deploy**. See [Authentication &
RBAC](#authentication--rbac-deliberately-simple).

> For an iterative dev loop with hot reload use `pnpm dev` (both apps via `nx run-many`), or run
> them separately: `pnpm --filter @kdo/api dev` and `pnpm --filter @kdo/web dev`.

### Verify / quality gates

```bash
pnpm verify           # typecheck + test + build across all projects (Nx)
pnpm test             # unit + API tests (Vitest)
pnpm lint             # ESLint v9 flat config
```

---

## API reference

Base URL: `http://localhost:3001`

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/health` | public | liveness probe |
| `POST` | `/api/auth/login` | public | exchange `{apiKey, role}` for a session token |
| `GET` | `/api/auth/me` | any role | current role + permissions |
| `GET` | `/api/deployments` | any role | list runs (newest first) |
| `POST` | `/api/deployments` | `deployments:create` | submit a spec → `202` with the created run (executes async) |
| `GET` | `/api/deployments/:id` | any role | full run state (polling fallback) |
| `GET` | `/api/deployments/:id/manifest` | any role | rendered Deployment YAML (the GitOps artifact) |
| `GET` | `/api/deployments/:id/events` | any role | **SSE** stream of live run state; emits a terminal `done` event |

Authenticated routes expect `Authorization: Bearer <token>` (the SSE route also accepts `?token=`
since `EventSource` can't set headers). Missing/invalid token → `401`; insufficient role → `403`.

**Submit a deployment:**

```bash
curl -X POST localhost:3001/api/deployments \
  -H 'content-type: application/json' \
  -d '{"name":"checkout-api","namespace":"demo","image":"ghcr.io/acme/checkout:1.4.2","replicas":3,"failureMode":"crash-loop"}'
```

An invalid spec returns `400` with structured Zod issues (e.g. an image without an explicit tag,
replicas outside `1..10`, or a non-DNS-1123 name).

## Authentication & RBAC (deliberately simple)

A thin auth layer demonstrates the platform-RBAC concern of *who may trigger a deploy vs. who only
observes* — without standing up a real identity provider (which the assignment doesn't require). It's
**demo-only**: one shared API key, a fixed role catalogue, and in-memory sessions.

- **Login**: `POST /api/auth/login` with the shared key + a role returns an opaque session token.
- **Roles & permissions**:

  | Role | View | Trigger deploys |
  |---|---|---|
  | Platform Team | ✅ | ✅ |
  | DevOps Engineer | ✅ | ✅ |
  | Engineering Manager | ✅ | ❌ (read-only) |

- **Zero-friction evaluation**: the login form pre-fills the dev key (`kdo-dev-key-2026`) — just pick a
  role and sign in. Try **Engineering Manager** to see the Deploy button disabled and `POST` return
  `403`. Override the key with `KDO_API_KEY`.

> Not production auth: no token signing/expiry, no password store, sessions reset on API restart. The
> seam (`requireAuth` / `requirePermission` middleware, role→permission map) is what a real
> OIDC/JWT integration would slot into.

## CLI — config-file driven (for engineers & CI)

The UI is for operators; the CLI is the same workflow for technical users, scripts, and CI. It reads
a YAML config (validated against the **same** Zod schema as the API/UI), submits each deployment, and
follows it to a terminal state — exiting non-zero if any rollout fails.

```bash
# start the API first (pnpm --filter @kdo/api dev), then:
pnpm kdo apply -f examples/deployments.yaml
```

```
▶ demo/checkout-api (ghcr.io/acme/checkout:1.4.2, RollingUpdate)
  ✓ Validate spec 451ms
  ✓ Roll out pods 2.7s
  ✓ Promote revision 452ms
  · Rollback (skipped)
  succeeded — Revision 1 live — 3/3 replicas ready
...
✓ all 3 deployment(s) succeeded
```

Flags: `--api <url>` (or `$KDO_API`), `--api-key <key>` (or `$KDO_API_KEY`, defaults to the dev key),
`--role <role>` (default `devops-engineer`), `--json` (machine-readable output), `--no-follow` (fire
and exit). The CLI logs in for a token before submitting. **Exit codes:** `0` all succeeded · `1` a
rollout failed/rolled back · `2` usage/auth/connection error — so `kdo apply` drops into a CI gate.

## Project structure

All projects live under `packages/` and are managed by Nx.

```
k8s-deploy-orchestrator/
├── packages/
│   ├── core/           @kdo/core — engine, simulated cluster, store, strategy registry, types
│   ├── api/            @kdo/api  — Hono REST + SSE (thin HTTP boundary)
│   ├── web/            @kdo/web  — Next 15 operator console
│   └── cli/            @kdo/cli  — `kdo apply -f` config-driven client (CI)
├── examples/deployments.yaml
├── Dockerfile · docker-compose.yml · .dockerignore
├── docs/ARCHITECTURE.md
├── AI_LOG.md           — how this was built with AI (interaction log)
├── nx.json · tsconfig.base.json · pnpm-workspace.yaml · eslint.config.mjs
```

## State model (short version)

A **Run** is the unit of state: a spec, a `revision`, an ordered list of **Steps** (each with status,
timestamps, and logs), a live **RolloutSnapshot** (desired/ready/pods), the rendered manifest, and a
terminal `status`. The engine mutates the Run in place and calls `store.touch()` after every
transition; the store emits a change event; the SSE handler coalesces those into at most one frame
per tick and streams them to the browser. See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the
full transition diagram.

## Key design decisions & trade-offs

- **Simulated cluster over a real one.** Evaluation must work with zero setup, so the cluster is an
  in-process, **tick-based** simulator modelled on real K8s objects (Deployment → pods, readiness,
  `*BackOff` states). It's deterministic and testable, and `SimulatedCluster` is a seam — a real
  `@kubernetes/client-node` implementation could sit behind the same engine. *(See "what's next".)*
- **In-memory store behind a tiny interface.** State lives in a `Map` + `EventEmitter`. Right call for
  a single-node demo; the `RunStore` shape is deliberately swappable for Postgres/Redis.
- **SSE over WebSockets.** Progress is one-directional server→client; SSE is simpler, proxy-friendly,
  and auto-reconnects. Writes are coalesced to keep the stream ordered and cheap.
- **Engine runs via `tsx`, not a compiled `dist`.** For a local tool this removes a build step and a
  whole class of monorepo path-resolution pain; `build` is a strict typecheck. A published service
  would compile.
- **Types shared, runtime not.** The web app imports types from `@kdo/core` *type-only*, so no server
  code leaks into the browser bundle (105 kB first load).
- **Failure injection is a spec field.** Pragmatic way to make every failure path reproducible in a
  demo without breaking real inputs.
- **Extension via seams, not rewrites.** The `ClusterDriver` interface and the `STRATEGY_REGISTRY`
  mean a real K8s/Argo backend or a new strategy is an addition, not a refactor — uniformity by design.
- **Type safety as a guardrail.** Branded ids, discriminated unions + `assertNever`, `readonly` state,
  and Zod boundaries mean whole classes of mistakes (mixed-up ids, unhandled strategy, mutated
  snapshots) fail to compile rather than at runtime.

## What I'd build next

The codebase already has the seams; these fill them in (priority order):

1. **Real cluster driver** — implement the `ClusterDriver` interface with `@kubernetes/client-node`
   against a local `kind` cluster; select via env. The engine wouldn't change.
2. **Argo CD / GitOps driver** — a `ClusterDriver` that renders the manifest, commits it to a Git repo,
   and reads back Argo `Application` sync/health status instead of applying directly. The manifest
   already carries the `app.kubernetes.io/*` + `kdo.dev/*` labels Argo/rollout-controllers key on.
3. **Execute Canary / Blue-Green** — the types, validation, UI, manifest annotations, and registry are
   in place; implement the traffic-shift + bake-gate mechanics behind the existing strategy descriptor.
4. **Durable state** — swap `RunStore` for Postgres so runs survive restarts; add history/audit.
5. **Manual controls** — "Roll back now" / "Pause-Resume rollout" (the engine is already step-structured).
6. **Concurrency guard** — reject/queue a second in-flight rollout for the same namespace/name.
7. **AuthN/Z + multi-tenant namespaces**, and structured logging/metrics on the API.

## AI collaboration

This project was built with AI assistance under the assessment's "AI usage required" guideline. The
interaction log — what was directed vs delegated, and how the output was iterated — is in
[`AI_LOG.md`](AI_LOG.md).
