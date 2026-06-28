import type {
  ClusterDriver,
  DeploymentSpec,
  FailureMode,
  Pod,
  RolloutPacing,
  RolloutSnapshot,
} from './types';

/** Thrown when a rollout cannot reach the desired ready state. */
export class RolloutError extends Error {
  constructor(
    message: string,
    readonly snapshot: RolloutSnapshot,
  ) {
    super(message);
    this.name = 'RolloutError';
  }
}

interface DeploymentRecord {
  spec: DeploymentSpec;
  revision: number;
  pacing: RolloutPacing;
  pods: Pod[];
}

const keyOf = (namespace: string, name: string): string => `${namespace}/${name}`;

function shortHash(seed: string): string {
  // Deterministic-ish short suffix to imitate a ReplicaSet pod-template hash.
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) & 0xffffff;
  return h.toString(16).padStart(6, '0').slice(0, 5);
}

function makePods(name: string, revision: number, replicas: number, ready: boolean): Pod[] {
  const hash = shortHash(`${name}-${revision}`);
  return Array.from({ length: replicas }, (_, i) => ({
    name: `${name}-${hash}-${i.toString().padStart(2, '0')}`,
    status: ready ? 'Ready' : 'Pending',
    ready,
    restarts: 0,
  }));
}

/**
 * An in-process stand-in for the Kubernetes control plane (a {@link ClusterDriver}).
 *
 * It is intentionally NOT timer-driven: the workflow engine advances pods one
 * `tick()` at a time. That makes rollouts deterministic, observable, and
 * trivially testable, while still reproducing the state transitions a real
 * Deployment goes through (Pending -> ContainerCreating -> Running -> Ready,
 * plus the ImagePullBackOff / CrashLoopBackOff / readiness-stall failure paths).
 */
export class SimulatedCluster implements ClusterDriver {
  private readonly namespaces = new Set<string>(['default', 'kube-system']);
  private readonly deployments = new Map<string, DeploymentRecord>();
  /** Last successfully promoted revision per deployment, used as a rollback target. */
  private readonly stable = new Map<string, DeploymentRecord>();

  hasNamespace(namespace: string): boolean {
    return this.namespaces.has(namespace);
  }

  /** @returns true if the namespace was newly created. */
  ensureNamespace(namespace: string): boolean {
    if (this.namespaces.has(namespace)) return false;
    this.namespaces.add(namespace);
    return true;
  }

  stableRevision(namespace: string, name: string): number | undefined {
    return this.stable.get(keyOf(namespace, name))?.revision;
  }

  /** Create/replace the Deployment record with pods not yet scheduled. */
  applyDeployment(spec: DeploymentSpec, revision: number, pacing: RolloutPacing): void {
    this.deployments.set(keyOf(spec.namespace, spec.name), {
      spec,
      revision,
      pacing,
      pods: makePods(spec.name, revision, spec.replicas, false),
    });
  }

  /**
   * Advance the rollout by one step. `gradual` pacing brings one fresh pod up
   * per tick (RollingUpdate); `parallel` brings them all up together (Recreate
   * / Blue-Green). Returns true while progress is still possible, false once
   * every pod is in a terminal state (ready or backoff).
   */
  tick(namespace: string, name: string): boolean {
    const rec = this.mustGet(namespace, name);
    const gradual = rec.pacing === 'gradual';

    let startedThisTick = false;
    for (const pod of rec.pods) {
      if (pod.status === 'Pending') {
        if (gradual && startedThisTick) continue;
        pod.status = 'ContainerCreating';
        startedThisTick = true;
        continue;
      }
      this.advancePod(pod, rec.spec.failureMode);
    }

    return rec.pods.some((p) => isProgressing(p));
  }

  private advancePod(pod: Pod, failureMode: FailureMode): void {
    switch (pod.status) {
      case 'ContainerCreating':
        if (failureMode === 'image-pull') {
          pod.status = 'ImagePullBackOff';
          pod.reason = 'Failed to pull image: not found in registry';
        } else {
          pod.status = 'Running';
        }
        return;
      case 'Running':
        if (failureMode === 'crash-loop') {
          pod.status = 'CrashLoopBackOff';
          pod.restarts += 1;
          pod.reason = 'Back-off restarting failed container';
        } else if (failureMode === 'readiness-timeout') {
          // Stays Running forever — readiness probe never passes.
          pod.reason = 'Readiness probe failed: HTTP 503';
        } else {
          pod.status = 'Ready';
          pod.ready = true;
          pod.reason = undefined;
        }
        return;
      case 'CrashLoopBackOff':
        pod.restarts += 1;
        return;
      // Pending is handled in tick(); the rest are terminal — nothing to advance.
      case 'Pending':
      case 'Ready':
      case 'ImagePullBackOff':
      case 'Terminating':
        return;
    }
  }

  snapshot(namespace: string, name: string): RolloutSnapshot {
    const rec = this.mustGet(namespace, name);
    return {
      desired: rec.spec.replicas,
      ready: rec.pods.filter((p) => p.ready).length,
      revision: rec.revision,
      // Return copies so callers (and serialized run state) can't mutate us.
      pods: rec.pods.map((p) => ({ ...p })),
    };
  }

  /** Promote the current revision as the stable fallback target. */
  promote(namespace: string, name: string): void {
    const rec = this.mustGet(namespace, name);
    this.stable.set(keyOf(namespace, name), {
      ...rec,
      pods: rec.pods.map((p) => ({ ...p })),
    });
  }

  /**
   * Restore the last stable revision. Returns the revision restored, or
   * undefined when there is nothing to roll back to (a first-ever deploy).
   */
  rollback(namespace: string, name: string): number | undefined {
    const key = keyOf(namespace, name);
    const prev = this.stable.get(key);
    if (!prev) {
      // Nothing stable to fall back to: tear the failed deployment down.
      this.deployments.delete(key);
      return undefined;
    }
    this.deployments.set(key, {
      ...prev,
      pods: makePods(prev.spec.name, prev.revision, prev.spec.replicas, true),
    });
    return prev.revision;
  }

  private mustGet(namespace: string, name: string): DeploymentRecord {
    const rec = this.deployments.get(keyOf(namespace, name));
    if (!rec) throw new Error(`deployment ${keyOf(namespace, name)} not found`);
    return rec;
  }
}

/** A pod is still "progressing" if it could yet become ready on a future tick. */
function isProgressing(pod: Pod): boolean {
  switch (pod.status) {
    case 'Pending':
    case 'ContainerCreating':
      return true;
    // Running-but-not-ready is the readiness-stall path: never advances, so it
    // rides the health-gate timeout rather than failing fast.
    case 'Running':
      return !pod.ready;
    // Ready / ImagePullBackOff / CrashLoopBackOff / Terminating are terminal here.
    case 'Ready':
    case 'ImagePullBackOff':
    case 'CrashLoopBackOff':
    case 'Terminating':
      return false;
  }
}
