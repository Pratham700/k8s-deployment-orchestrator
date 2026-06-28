import { z } from 'zod';

/**
 * Domain types for the deployment orchestrator.
 *
 * The model is deliberately a *simplified* mirror of real Kubernetes objects
 * (Deployment -> ReplicaSet -> Pods, with a readiness condition). Enough to be
 * recognisable to anyone who has operated K8s, without the full API surface.
 */

// ---------------------------------------------------------------------------
// Branded identifiers
// ---------------------------------------------------------------------------

declare const runIdBrand: unique symbol;
/** A run identifier. Branded so a bare string can't be passed where one is expected. */
export type RunId = string & { readonly [runIdBrand]: 'RunId' };
/** Smart constructor — the single sanctioned way to mint/accept a RunId. */
export const asRunId = (value: string): RunId => value as RunId;

// ---------------------------------------------------------------------------
// Deployment strategy (discriminated union, open for extension)
// ---------------------------------------------------------------------------

export const STRATEGY_KINDS = ['RollingUpdate', 'Recreate', 'BlueGreen', 'Canary'] as const;
export type StrategyKind = (typeof STRATEGY_KINDS)[number];

export const DeploymentStrategySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('RollingUpdate') }),
  z.object({ kind: z.literal('Recreate') }),
  z.object({ kind: z.literal('BlueGreen') }),
  z.object({
    kind: z.literal('Canary'),
    /** Percentage of traffic to shift to the new revision before promotion. */
    trafficPercent: z.number().int().min(1).max(100),
    /** How long to bake the canary (observe health) before promoting. */
    bakeSeconds: z.number().int().min(0).max(3600),
  }),
]);
export type DeploymentStrategy = z.infer<typeof DeploymentStrategySchema>;
export type CanaryStrategy = Extract<DeploymentStrategy, { kind: 'Canary' }>;

/** How the simulator brings pods up for a given strategy. */
export type RolloutPacing = 'gradual' | 'parallel';

/**
 * Per-strategy behaviour, in one registry so adding a strategy is a single
 * entry rather than scattered `if`s. `executable: false` strategies are fully
 * typed/validated/rendered but their traffic mechanics are not enforced yet —
 * the rollout logs their `plan()` and proceeds with a progressive bring-up.
 */
export interface StrategyDescriptor {
  readonly kind: StrategyKind;
  readonly label: string;
  readonly executable: boolean;
  readonly pacing: RolloutPacing;
  /** Human-readable rollout plan, surfaced in the step logs. */
  plan(strategy: DeploymentStrategy): readonly string[];
}

export const STRATEGY_REGISTRY: Readonly<Record<StrategyKind, StrategyDescriptor>> = {
  RollingUpdate: {
    kind: 'RollingUpdate',
    label: 'Rolling update',
    executable: true,
    pacing: 'gradual',
    plan: () => ['surge one new pod at a time; old pods retire as new pods become ready'],
  },
  Recreate: {
    kind: 'Recreate',
    label: 'Recreate',
    executable: true,
    pacing: 'parallel',
    plan: () => ['terminate the old pods, then bring all new pods up together'],
  },
  BlueGreen: {
    kind: 'BlueGreen',
    label: 'Blue/Green',
    executable: false,
    pacing: 'parallel',
    plan: () => [
      'bring the green (new) stack up fully alongside blue (current)',
      'switch traffic to green atomically once healthy, then retire blue',
      'note: traffic switch is planned — not enforced in this build',
    ],
  },
  Canary: {
    kind: 'Canary',
    label: 'Canary',
    executable: false,
    pacing: 'gradual',
    plan: (s) =>
      s.kind === 'Canary'
        ? [
            `route ${s.trafficPercent}% of traffic to the new revision`,
            `bake for ${s.bakeSeconds}s while watching health/metrics`,
            'promote to 100% if healthy, otherwise auto-rollback',
            'note: traffic shaping + bake gating are planned — not enforced in this build',
          ]
        : [],
  },
};

// ---------------------------------------------------------------------------
// Input: the deployment spec an operator submits
// ---------------------------------------------------------------------------

/** Demo-only knob so an operator can deterministically trigger each failure path. */
export const FAILURE_MODES = ['none', 'image-pull', 'crash-loop', 'readiness-timeout'] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

/** DNS-1123 label, the rule K8s applies to resource names and namespaces. */
const dns1123 = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/, 'must be a valid DNS-1123 label (lowercase, digits, dashes)');

export const DeploymentSpecSchema = z.object({
  name: dns1123,
  namespace: dns1123.default('default'),
  /** A container image reference; we require an explicit tag (no implicit :latest). */
  image: z
    .string()
    .min(1)
    .regex(/^[\w./-]+:[\w.-]+$/, 'image must include an explicit tag, e.g. "nginx:1.27"'),
  replicas: z.number().int().min(1).max(10),
  strategy: DeploymentStrategySchema.default({ kind: 'RollingUpdate' }),
  failureMode: z.enum(FAILURE_MODES).default('none'),
});

export type DeploymentSpec = z.infer<typeof DeploymentSpecSchema>;

// ---------------------------------------------------------------------------
// Cluster state
// ---------------------------------------------------------------------------

/** Simplified pod status. Real K8s splits phase + readiness condition; we flatten. */
export const POD_STATUSES = [
  'Pending',
  'ContainerCreating',
  'Running',
  'Ready',
  'ImagePullBackOff',
  'CrashLoopBackOff',
  'Terminating',
] as const;
export type PodStatus = (typeof POD_STATUSES)[number];

export interface Pod {
  readonly name: string;
  status: PodStatus;
  ready: boolean;
  restarts: number;
  reason?: string;
}

/** A point-in-time view of a Deployment's rollout, surfaced to the UI. */
export interface RolloutSnapshot {
  readonly desired: number;
  readonly ready: number;
  readonly revision: number;
  readonly pods: readonly Pod[];
}

/**
 * The control-plane seam. `SimulatedCluster` implements this today; a real
 * `@kubernetes/client-node` driver or an Argo CD GitOps driver (render manifest
 * -> commit to Git -> read sync/health status) could implement it tomorrow
 * without the engine changing. See docs/ARCHITECTURE.md "GitOps readiness".
 */
export interface ClusterDriver {
  hasNamespace(namespace: string): boolean;
  ensureNamespace(namespace: string): boolean;
  stableRevision(namespace: string, name: string): number | undefined;
  applyDeployment(spec: DeploymentSpec, revision: number, pacing: RolloutPacing): void;
  tick(namespace: string, name: string): boolean;
  snapshot(namespace: string, name: string): RolloutSnapshot;
  promote(namespace: string, name: string): void;
  rollback(namespace: string, name: string): number | undefined;
}

// ---------------------------------------------------------------------------
// Workflow steps
// ---------------------------------------------------------------------------

export const STEP_IDS = [
  'validate',
  'ensure-namespace',
  'render-manifest',
  'apply',
  'rollout',
  'health-gate',
  'promote',
  'rollback',
] as const;
export type StepId = (typeof STEP_IDS)[number];

export type StepStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped';

export interface Step {
  readonly id: StepId;
  readonly name: string;
  status: StepStatus;
  startedAt?: string;
  finishedAt?: string;
  logs: string[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Run (one execution of the workflow)
// ---------------------------------------------------------------------------

export type RunStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'rolled_back';

export interface Run {
  readonly id: RunId;
  readonly spec: DeploymentSpec;
  status: RunStatus;
  readonly revision: number;
  /** Stable revision we can fall back to; undefined on a first-ever deploy. */
  readonly previousRevision?: number;
  steps: Step[];
  rollout?: RolloutSnapshot;
  manifest?: string;
  message?: string;
  readonly createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Timing — tunable so the demo is watchable but tests run instantly
// ---------------------------------------------------------------------------

export interface Timing {
  /** Pause between workflow steps, purely for visual pacing. */
  readonly stepDelayMs: number;
  /** Wall-clock per rollout tick (one pod-lifecycle advancement). */
  readonly tickMs: number;
  /** Health gate budget: rollout must reach desired readiness within this. */
  readonly healthTimeoutMs: number;
  /** Stability hold after readiness, to catch pods that flip to CrashLoop. */
  readonly stabilityMs: number;
}

export const DEFAULT_TIMING: Timing = {
  stepDelayMs: 450,
  tickMs: 550,
  healthTimeoutMs: 9000,
  stabilityMs: 700,
};

/** Near-zero timing for unit tests. */
export const FAST_TIMING: Timing = {
  stepDelayMs: 0,
  tickMs: 0,
  healthTimeoutMs: 150,
  stabilityMs: 0,
};
