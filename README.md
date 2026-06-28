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

---

## Architecture at a glance

```
  Browser — Next 15 / React 19 operator console
     │  fetch (REST)  +  EventSource (Server-Sent Events)
     ▼
  @kdo/api — Hono on Node 22
     │  createRun() → execute() [async, fire-and-forget]
     ▼
  @kdo/core
     ├── OrchestrationEngine ── tick() ──▶ SimulatedCluster   (pod lifecycle + failure injection)
     │        │ mutates run state + store.touch()
     │        ▼
     └── RunStore  (in-memory Map + EventEmitter)  ── subscribe() ──▶  SSE stream back to the browser
```

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
| Tests | **Vitest** | fast; deterministic engine tests via injectable timing |
| Runtime | **Node 22** (pinned via `mise` / `.nvmrc`) | matches the brief |

---

## Quickstart

**Prerequisites:** Node 22 and pnpm 10. (`mise install` will read `mise.toml` and set both up;
otherwise use your own version manager — `.nvmrc` pins Node 22.) **No cloud account, cluster, or API
key is required** — the Kubernetes control plane is simulated in-process.

```bash
pnpm install          # install workspace deps
pnpm dev              # starts the API (:3001) and the web console (:3000) together
```

Then open **http://localhost:3000** and click **Deploy**.

> `pnpm dev` runs both apps via `nx run-many`. To run them separately:
> `pnpm --filter @kdo/api dev` and `pnpm --filter @kdo/web dev`.

### Verify / quality gates

```bash
pnpm verify           # typecheck + test + build across all projects (Nx)
pnpm test             # unit + API tests (Vitest)
pnpm lint             # ESLint v9 flat config
```

---

## API reference

Base URL: `http://localhost:3001`

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | liveness probe |
| `GET` | `/api/deployments` | list runs (newest first) |
| `POST` | `/api/deployments` | submit a spec → `202` with the created run (executes async) |
| `GET` | `/api/deployments/:id` | full run state (polling fallback) |
| `GET` | `/api/deployments/:id/events` | **SSE** stream of live run state; emits a terminal `done` event |

**Submit a deployment:**

```bash
curl -X POST localhost:3001/api/deployments \
  -H 'content-type: application/json' \
  -d '{"name":"checkout-api","namespace":"demo","image":"ghcr.io/acme/checkout:1.4.2","replicas":3,"failureMode":"crash-loop"}'
```

An invalid spec returns `400` with structured Zod issues (e.g. an image without an explicit tag,
replicas outside `1..10`, or a non-DNS-1123 name).

## Project structure

```
k8s-deploy-orchestrator/
├── apps/
│   ├── api/            @kdo/api  — Hono REST + SSE (thin HTTP boundary)
│   └── web/            @kdo/web  — Next 15 operator console
├── packages/
│   └── core/           @kdo/core — engine, simulated cluster, store, types (the brains)
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

## What I'd build next

Given more time, in priority order:

1. **Real cluster adapter** — implement the `SimulatedCluster` interface with `@kubernetes/client-node`
   against a local `kind` cluster; select via env. The engine wouldn't change.
2. **Durable state** — swap `RunStore` for Postgres so runs survive restarts; add run history/audit.
3. **Manual controls** — a "Roll back now" button and "Pause/Resume rollout" (the engine is already
   step-structured for this).
4. **Canary / progressive traffic** — extend the strategy model beyond RollingUpdate/Recreate to a
   percentage-based canary with metric-based promotion.
5. **Concurrency guard** — reject/queue a second in-flight rollout for the same namespace/name.
6. **AuthN/Z + multi-tenant namespaces**, and structured logging/metrics on the API.

## AI collaboration

This project was built with AI assistance under the assessment's "AI usage required" guideline. The
interaction log — what was directed vs delegated, and how the output was iterated — is in
[`AI_LOG.md`](AI_LOG.md).
