import type { DeploymentSpec, DeploymentStrategy } from './types';
import { assertNever } from './util';

/**
 * Render a Kubernetes Deployment manifest from a spec.
 *
 * Hand-rolled YAML (rather than pulling in a serializer) keeps the output
 * tightly controlled and readable — this is what the operator inspects in the
 * UI before the rollout is applied, so it doubles as a "dry run". The manifest
 * carries the standard `app.kubernetes.io/*` recommended labels and a
 * `managed-by: kdo` marker, so it is also the natural GitOps artifact (e.g.
 * committed to a repo for Argo CD to reconcile). See docs/ARCHITECTURE.md.
 */
export function renderDeploymentManifest(spec: DeploymentSpec, revision: number): string {
  const version = spec.image.split(':').at(-1) ?? 'latest';
  const { type, annotations } = strategyManifest(spec.strategy);

  const selectorLabels = `app.kubernetes.io/name: ${spec.name}`;
  const allAnnotations = { 'kdo.dev/revision': `"${revision}"`, ...annotations };

  const annotationLines = Object.entries(allAnnotations)
    .map(([k, v]) => `    ${k}: ${v}`)
    .join('\n');

  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${spec.name}
  namespace: ${spec.namespace}
  labels:
    app.kubernetes.io/name: ${spec.name}
    app.kubernetes.io/version: "${version}"
    app.kubernetes.io/managed-by: kdo
  annotations:
${annotationLines}
spec:
  replicas: ${spec.replicas}
  strategy:
    type: ${type}
  selector:
    matchLabels:
      ${selectorLabels}
  template:
    metadata:
      labels:
        ${selectorLabels}
    spec:
      containers:
        - name: ${spec.name}
          image: ${spec.image}
          ports:
            - containerPort: 8080
          readinessProbe:
            httpGet:
              path: /healthz
              port: 8080
            initialDelaySeconds: 2
            periodSeconds: 5
`;
}

/**
 * Translate a strategy into a vanilla Deployment `strategy.type` plus tracking
 * annotations. Blue-Green and Canary are not native Deployment strategies, so
 * they map onto RollingUpdate at the Deployment level and record their intent
 * in `kdo.dev/*` annotations — exactly how a rollout controller (e.g. Argo
 * Rollouts) would discover them.
 */
function strategyManifest(strategy: DeploymentStrategy): {
  type: 'RollingUpdate' | 'Recreate';
  annotations: Record<string, string>;
} {
  switch (strategy.kind) {
    case 'RollingUpdate':
      return { type: 'RollingUpdate', annotations: { 'kdo.dev/strategy': 'RollingUpdate' } };
    case 'Recreate':
      return { type: 'Recreate', annotations: { 'kdo.dev/strategy': 'Recreate' } };
    case 'BlueGreen':
      return { type: 'RollingUpdate', annotations: { 'kdo.dev/strategy': 'BlueGreen' } };
    case 'Canary':
      return {
        type: 'RollingUpdate',
        annotations: {
          'kdo.dev/strategy': 'Canary',
          'kdo.dev/canary-traffic-percent': `"${strategy.trafficPercent}"`,
          'kdo.dev/canary-bake-seconds': `"${strategy.bakeSeconds}"`,
        },
      };
    default:
      return assertNever(strategy, 'strategy');
  }
}
