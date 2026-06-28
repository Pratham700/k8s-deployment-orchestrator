import type { DeploymentSpec, Run } from '@kdo/core';

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

export async function checkHealth(apiBase: string): Promise<void> {
  const res = await fetch(`${apiBase}/api/health`).catch(() => null);
  if (!res || !res.ok) {
    throw new ApiError(`cannot reach API at ${apiBase} — is it running? (pnpm --filter @kdo/api dev)`);
  }
}

export async function submitDeployment(apiBase: string, spec: DeploymentSpec): Promise<Run> {
  const res = await fetch(`${apiBase}/api/deployments`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(spec),
  });
  const body: unknown = await res.json();
  if (res.status !== 202) {
    const issues = (body as { issues?: unknown }).issues;
    throw new ApiError(`API rejected spec (${res.status})`, issues);
  }
  return body as Run;
}

export async function getRun(apiBase: string, id: string): Promise<Run> {
  const res = await fetch(`${apiBase}/api/deployments/${id}`);
  if (!res.ok) throw new ApiError(`failed to fetch run ${id} (${res.status})`);
  return (await res.json()) as Run;
}
