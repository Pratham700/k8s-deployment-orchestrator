import { z } from 'zod';

/**
 * Domain types for the deployment orchestrator.
 *
 * The model is deliberately a *simplified* mirror of real Kubernetes objects
 * (Deployment -> ReplicaSet -> Pods, with a readiness condition). Enough to be
 * recognisable to anyone who has operated K8s, without the full API surface.
 */

// ---------------------------------------------------------------------------
// Input: the deployment spec an operator submits
// ---------------------------------------------------------------------------

/** Demo-only knob so an operator can deterministically trigger each failure path. */
export const FAILURE_MODES = ['none', 'image-pull', 'crash-loop', 'readiness-timeout'] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

export const ROLLOUT_STRATEGIES = ['RollingUpdate', 'Recreate'] as const;
export type RolloutStrategy = (typeof ROLLOUT_STRATEGIES)[number];

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
  strategy: z.enum(ROLLOUT_STRATEGIES).default('RollingUpdate'),
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
  name: string;
  status: PodStatus;
  ready: boolean;
  restarts: number;
  reason?: string;
}

/** A point-in-time view of a Deployment's rollout, surfaced to the UI. */
export interface RolloutSnapshot {
  desired: number;
  ready: number;
  revision: number;
  pods: Pod[];
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
  id: StepId;
  name: string;
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
  id: string;
  spec: DeploymentSpec;
  status: RunStatus;
  revision: number;
  /** Stable revision we can fall back to; undefined on a first-ever deploy. */
  previousRevision?: number;
  steps: Step[];
  rollout?: RolloutSnapshot;
  manifest?: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Timing — tunable so the demo is watchable but tests run instantly
// ---------------------------------------------------------------------------

export interface Timing {
  /** Pause between workflow steps, purely for visual pacing. */
  stepDelayMs: number;
  /** Wall-clock per rollout tick (one pod-lifecycle advancement). */
  tickMs: number;
  /** Health gate budget: rollout must reach desired readiness within this. */
  healthTimeoutMs: number;
  /** Stability hold after readiness, to catch pods that flip to CrashLoop. */
  stabilityMs: number;
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
