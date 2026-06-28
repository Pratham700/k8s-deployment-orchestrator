// The browser talks directly to the control-plane API. Types are imported
// type-only from @kdo/core, so no server code is ever bundled into the client.
import type { DeploymentSpec, Run } from '@kdo/core';

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export type DeploySpecInput = Pick<
  DeploymentSpec,
  'name' | 'namespace' | 'image' | 'replicas' | 'strategy' | 'failureMode'
>;

export interface ValidationError {
  error: string;
  issues: { path: (string | number)[]; message: string }[];
}

export async function listRuns(): Promise<Run[]> {
  const res = await fetch(`${API_BASE}/api/deployments`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`failed to list runs: ${res.status}`);
  return ((await res.json()) as { runs: Run[] }).runs;
}

export async function getRun(id: string): Promise<Run> {
  const res = await fetch(`${API_BASE}/api/deployments/${id}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`failed to fetch run ${id}: ${res.status}`);
  return (await res.json()) as Run;
}

/** Submit a spec. Resolves to the created Run, or rejects with a ValidationError. */
export async function createDeployment(spec: DeploySpecInput): Promise<Run> {
  const res = await fetch(`${API_BASE}/api/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  });
  const body = await res.json();
  if (res.status === 202) return body as Run;
  throw body as ValidationError;
}

/**
 * Subscribe to a run's live state via Server-Sent Events.
 * Returns an unsubscribe function. Calls `onDone` once the run is terminal.
 */
export function streamRun(
  id: string,
  onUpdate: (run: Run) => void,
  onDone?: () => void,
): () => void {
  const source = new EventSource(`${API_BASE}/api/deployments/${id}/events`);

  source.addEventListener('update', (e) => {
    onUpdate(JSON.parse((e as MessageEvent).data) as Run);
  });
  source.addEventListener('done', () => {
    source.close();
    onDone?.();
  });
  source.onerror = () => {
    // The server closes the stream on completion; suppress the resulting
    // reconnect attempt once we've already seen a terminal "done".
    if (source.readyState === EventSource.CLOSED) onDone?.();
  };

  return () => source.close();
}
