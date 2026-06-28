# ⎈ kdo — Kubernetes Deploy Orchestrator

You hand kdo a deployment spec. It runs the rollout one step at a time against a simulated Kubernetes
cluster, checks the pods are genuinely healthy before calling it done, and rolls back on its own if
they aren't. You watch the whole thing happen live.

It was built as a take-home, so the goal was one real operational workflow done properly rather than a
wide, shallow dashboard.

**Why this problem?** `kubectl apply` tells you Kubernetes *accepted* your change, not that the app is
actually *healthy*. That gap between "accepted" and "healthy" is where bad deploys hide, and most
teams paper over it with rollout polling and rollback runbooks stuck in CI logs. kdo turns that into a
visible, self-service workflow with the safety net built in. That is the whole platform-engineering
idea here: give people a golden path to ship safely, and make failure boring.

## Run it (pick one)

You don't need a Kubernetes cluster, a cloud account, or any API key. The cluster is faked in-process
on purpose, so everything runs on a laptop. New to this stack? You only need one of the two options.

### Option A: Docker (the only thing you install is Docker)

```bash
docker compose up --build
```

Wait for the logs to settle, then open http://localhost:3000.

The `web` container waits until the `api` container reports healthy before it starts. Same idea as
bringing up an app only once its infrastructure is ready.

### Option B: Node + pnpm (one command)

You'll need Node 22 and pnpm 10. If you use `mise`, run `mise install`; otherwise any Node 22 is fine.

```bash
pnpm start
```

That single command installs dependencies, builds the packages in the right order, starts the API,
waits for it to pass its health check, then starts the web console. Open http://localhost:3000.

## Walk through the demo (about 3 minutes)

1. **Sign in.** The login form already has the demo API key filled in. Leave it, choose **Platform
   Team**, and sign in. (The roles are real. We come back to that in step 5.)

2. **Ship a healthy deploy.** The form is pre-filled with a sensible example, so just click **Deploy**.
   Watch the right-hand panel: each step turns green in turn (validate, render manifest, apply, roll
   out pods), the pods move from Pending to Running to Ready, and the run finishes as `succeeded`.
   Revision 1 is now the known-good version.

3. **Break it on purpose.** Under **failure injection**, pick `crash-loop` and click **Deploy** again.
   The new pods come up, start crashing, the health gate refuses to promote them, and kdo **rolls back
   to revision 1** by itself. The run ends as `rolled_back`, the cluster is back on the healthy
   version, and nobody got paged. Two more failure modes are worth a try: `image-pull` (the image
   never pulls) and `readiness-timeout` (pods run but never pass readiness).

4. **Look at the artifact.** Expand "rendered manifest" on any run. That's the Kubernetes YAML kdo
   would apply, with standard labels attached. It's also the file a GitOps tool like Argo CD would
   pick up later.

5. **Try the guardrail.** Sign out (top right), then sign back in as **Engineering Manager**. The
   Deploy button is now disabled, and the API rejects deploys from that role. Managers can watch; they
   can't ship. That's intentional.

6. **Optional: the same thing from a terminal.** With the app running, open another shell:

   ```bash
   pnpm kdo apply -f examples/deployments.yaml
   ```

   It reads three deployments from a YAML file (one healthy, one canary, one that fails), runs each,
   prints progress, and exits non-zero if any of them fail. That exit code is what lets it act as a CI
   gate.

## How it reflects platform-engineering principles

- **A golden path.** One form, or one YAML file, takes you from spec to a safe, promoted deploy. No
  tribal knowledge needed.
- **Safe by default.** Health is checked before anything is promoted, and rollback is automatic. The
  easy path is also the safe one.
- **Guardrails over gates.** Roles decide who can ship and who can only watch, without getting in the
  way of the people who should be shipping.
- **Observable.** Every step, log line, and pod state shows up live instead of hiding in a CI log.
- **Built to extend.** A new deploy strategy or a real cluster slots in behind an existing interface,
  so the tool grows by addition rather than rewrite.

## Under the hood (the short version)

Four small packages under `packages/`, wired together by Nx:

- `@kdo/core` holds the engine, the simulated cluster, the run store, and the types. It does no I/O.
  This is the brain.
- `@kdo/api` is a thin Hono HTTP layer. It validates input, runs the workflow, and streams progress
  over SSE (a simple one-way channel where the server pushes updates to the browser).
- `@kdo/web` is a minimal Next.js console. It displays state and holds no business logic of its own.
- `@kdo/cli` runs the same workflow from a YAML file, for engineers and CI.

The web app and the CLI are both just clients of the one API. The API and the engine never assume a
real cluster: they talk to a `ClusterDriver` interface, and the in-process simulator is one
implementation of it. A real Kubernetes or Argo CD driver would be another.

The design notes, data model, and trade-offs live in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Project layout

```
packages/
  core/   engine, simulated cluster, run store, strategy registry, types
  api/    Hono REST + SSE
  web/    Next.js operator console
  cli/    "kdo apply -f" client
examples/deployments.yaml    sample CLI config
Dockerfile, docker-compose.yml
docs/ARCHITECTURE.md         design and trade-offs
AI_LOG.md                    how this was built with AI
```

## Check the build yourself

```bash
pnpm verify   # typecheck + tests + build across every package
pnpm test     # tests only
pnpm lint     # lint only
```

The 26 tests cover the engine (happy path, every failure mode, rollback to a previous revision), the
API (auth and role permissions), and the CLI config parser.

## A few notes for the reviewer

The auth layer is deliberately simple: one shared key, three roles, in-memory sessions. It shows the
RBAC idea without a real identity provider, which the brief didn't ask for. Override the key with
`KDO_API_KEY`.

Canary and Blue-Green are modeled but not executed yet. You can select them and see their plan and
manifest annotations, but the traffic-shifting itself is the documented next step. I'd rather ship an
honest seam than fake the mechanism.

If I kept going, the next steps would be a real `kind`-cluster driver, then an Argo CD / GitOps driver,
then the canary traffic mechanics. The interfaces for all three already exist.

This project was built with AI assistance, which the brief required. The full interaction log, showing
what I directed versus delegated, is in [docs/ai_transcript.jsonl](docs/ai_transcript.jsonl).
