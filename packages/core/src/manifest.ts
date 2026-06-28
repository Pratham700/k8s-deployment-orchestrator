import type { DeploymentSpec } from './types';

/**
 * Render a Kubernetes Deployment manifest from a spec.
 *
 * Hand-rolled YAML (rather than pulling in a serializer) keeps the output
 * tightly controlled and readable — this is what the operator inspects in the
 * UI before the rollout is applied, so it doubles as a "dry run".
 */
export function renderDeploymentManifest(spec: DeploymentSpec, revision: number): string {
  const labels = `app: ${spec.name}`;
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${spec.name}
  namespace: ${spec.namespace}
  annotations:
    kdo.dev/revision: "${revision}"
  labels:
    ${labels}
spec:
  replicas: ${spec.replicas}
  strategy:
    type: ${spec.strategy}
  selector:
    matchLabels:
      ${labels}
  template:
    metadata:
      labels:
        ${labels}
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
