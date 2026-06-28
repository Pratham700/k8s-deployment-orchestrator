// The browser talks directly to the control-plane API. Types are imported
// type-only from @kdo/core, so no server code is ever bundled into the client.
import type { DeploymentSpec, Role, Run } from '@kdo/core';
import { loadSession, type Session } from './auth';

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? 'http://localhost:3001';

export type DeploySpecInput = Pick<
  DeploymentSpec,
  'name' | 'namespace' | 'image' | 'replicas' | 'strategy' | 'failureMode'
>;

export interface ValidationError {
  error: string;
  issues: { path: (string | number)[]; message: string }[];
}

/** Raised when the session is missing/expired (HTTP 401) so the UI can re-auth. */
export class AuthError extends Error {}

function authHeaders(): Record<string, string> {
  const token = loadSession()?.token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function guard(res: Response): Promise<Response> {
  if (res.status === 401) throw new AuthError('session expired — please sign in again');
  return res;
}

/** Exchange the shared API key + role for a session. */
export async function login(apiKey: string, role: Role): Promise<Session> {
  const res = await fetch(`${API_BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey, role }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `login failed (${res.status})`);
  }
  return (await res.json()) as Session;
}

export async function listRuns(): Promise<Run[]> {
  const res = await guard(await fetch(`${API_BASE}/api/deployments`, { headers: authHeaders(), cache: 'no-store' }));
  if (!res.ok) throw new Error(`failed to list runs: ${res.status}`);
  return ((await res.json()) as { runs: Run[] }).runs;
}

export async function getRun(id: string): Promise<Run> {
  const res = await guard(
    await fetch(`${API_BASE}/api/deployments/${id}`, { headers: authHeaders(), cache: 'no-store' }),
  );
  if (!res.ok) throw new Error(`failed to fetch run ${id}: ${res.status}`);
  return (await res.json()) as Run;
}

/** Submit a spec. Resolves to the created Run, or rejects with a ValidationError. */
export async function createDeployment(spec: DeploySpecInput): Promise<Run> {
  const res = await guard(
    await fetch(`${API_BASE}/api/deployments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify(spec),
    }),
  );
  if (res.status === 403) throw new Error('your role is read-only — you cannot trigger deployments');
  const body = await res.json();
  if (res.status === 202) return body as Run;
  throw body as ValidationError;
}

/**
 * Subscribe to a run's live state via Server-Sent Events.
 * EventSource can't set headers, so the token is passed as a query param.
 * Returns an unsubscribe function. Calls `onDone` once the run is terminal.
 */
export function streamRun(id: string, onUpdate: (run: Run) => void, onDone?: () => void): () => void {
  const token = loadSession()?.token ?? '';
  const url = `${API_BASE}/api/deployments/${id}/events?token=${encodeURIComponent(token)}`;
  const source = new EventSource(url);

  source.addEventListener('update', (e) => {
    onUpdate(JSON.parse((e as MessageEvent).data) as Run);
  });
  source.addEventListener('done', () => {
    source.close();
    onDone?.();
  });
  source.onerror = () => {
    if (source.readyState === EventSource.CLOSED) onDone?.();
  };

  return () => source.close();
}
