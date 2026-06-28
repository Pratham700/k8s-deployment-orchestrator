import type { DeploymentSpec, Pod, PodStatus, RolloutSnapshot } from './types';

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
  pods: Pod[];
}

const keyOf = (namespace: string, name: string): string => `${namespace}/${name}`;

function shortHash(seed: string): string {
  // Deterministic-ish short suffix to imitate a ReplicaSet pod-template hash.
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) & 0xffffff;
  return h.toString(16).padStart(6, '0').slice(0, 5);
}

/**
 * An in-process stand-in for the Kubernetes control plane.
 *
 * It is intentionally NOT timer-driven: the workflow engine advances pods one
 * `tick()` at a time. That makes rollouts deterministic, observable, and
 * trivially testable, while still reproducing the state transitions a real
 * Deployment goes through (Pending -> ContainerCreating -> Running -> Ready,
 * plus the ImagePullBackOff / CrashLoopBackOff / readiness-stall failure paths).
 */
export class SimulatedCluster {
  private readonly namespaces = new Set<string>(['default', 'kube-system']);
  private readonly deployments = new Map<string, DeploymentRecord>();
  /** Last successfully promoted revision per deployment, used as a rollback target. */
  private readonly stable = new Map<string, DeploymentRecord>();

  hasNamespace(ns: string): boolean {
    return this.namespaces.has(ns);
  }

  /** @returns true if the namespace was newly created. */
  ensureNamespace(ns: string): boolean {
    if (this.namespaces.has(ns)) return false;
    this.namespaces.add(ns);
    return true;
  }

  stableRevision(namespace: string, name: string): number | undefined {
    return this.stable.get(keyOf(namespace, name))?.revision;
  }

  /** Create/replace the Deployment record with pods not yet scheduled. */
  applyDeployment(spec: DeploymentSpec, revision: number): void {
    const hash = shortHash(`${spec.name}-${revision}`);
    const pods: Pod[] = Array.from({ length: spec.replicas }, (_, i) => ({
      name: `${spec.name}-${hash}-${i.toString().padStart(2, '0')}`,
      status: 'Pending' as PodStatus,
      ready: false,
      restarts: 0,
    }));
    this.deployments.set(keyOf(spec.namespace, spec.name), { spec, revision, pods });
  }

  /**
   * Advance the rollout by one step.
   *
   * RollingUpdate brings pods up gradually (one fresh pod starts per tick);
   * Recreate brings them all up together. Returns true while progress is still
   * possible, false once every pod is in a terminal state (ready or backoff).
   */
  tick(namespace: string, name: string): boolean {
    const rec = this.mustGet(namespace, name);
    const rolling = rec.spec.strategy === 'RollingUpdate';

    let startedThisTick = false;
    for (const pod of rec.pods) {
      // RollingUpdate: only let one not-yet-started pod begin per tick.
      if (pod.status === 'Pending') {
        if (rolling && startedThisTick) continue;
        pod.status = 'ContainerCreating';
        startedThisTick = true;
        continue;
      }
      this.advancePod(pod, rec.spec.failureMode);
    }

    return rec.pods.some((p) => isProgressing(p));
  }

  private advancePod(pod: Pod, failureMode: DeploymentSpec['failureMode']): void {
    switch (pod.status) {
      case 'ContainerCreating':
        if (failureMode === 'image-pull') {
          pod.status = 'ImagePullBackOff';
          pod.reason = `Failed to pull image: not found in registry`;
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
      default:
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
      spec: rec.spec,
      revision: rec.revision,
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
    const hash = shortHash(`${prev.spec.name}-${prev.revision}`);
    const pods: Pod[] = Array.from({ length: prev.spec.replicas }, (_, i) => ({
      name: `${prev.spec.name}-${hash}-${i.toString().padStart(2, '0')}`,
      status: 'Ready',
      ready: true,
      restarts: 0,
    }));
    this.deployments.set(key, { spec: prev.spec, revision: prev.revision, pods });
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
    default:
      return false;
  }
}
