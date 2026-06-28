import type { DeploymentSpec, Role, Run } from '@kdo/core';

/** Error talking to the orchestrator API; carries Zod issues when present. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly issues?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const bearer = (token: string): Record<string, string> => ({ Authorization: `Bearer ${token}` });

export async function checkHealth(apiBase: string): Promise<void> {
  const res = await fetch(`${apiBase}/api/health`).catch(() => null);
  if (!res || !res.ok) {
    throw new ApiError(`cannot reach API at ${apiBase} — is it running? (pnpm --filter @kdo/api dev)`);
  }
}

/** Exchange the shared API key + role for a session token. */
export async function login(apiBase: string, apiKey: string, role: Role): Promise<string> {
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ apiKey, role }),
  });
  const body: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(`login failed (${res.status}): ${(body as { error?: string }).error ?? ''}`);
  }
  return (body as { token: string }).token;
}

export async function submitDeployment(
  apiBase: string,
  token: string,
  spec: DeploymentSpec,
): Promise<Run> {
  const res = await fetch(`${apiBase}/api/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...bearer(token) },
    body: JSON.stringify(spec),
  });
  const body: unknown = await res.json();
  if (res.status !== 202) {
    const issues = (body as { issues?: unknown }).issues;
    throw new ApiError(`API rejected spec (${res.status}): ${(body as { error?: string }).error ?? ''}`, issues);
  }
  return body as Run;
}

export async function getRun(apiBase: string, token: string, id: string): Promise<Run> {
  const res = await fetch(`${apiBase}/api/deployments/${id}`, { headers: bearer(token) });
  if (!res.ok) throw new ApiError(`failed to fetch run ${id} (${res.status})`);
  return (await res.json()) as Run;
}
