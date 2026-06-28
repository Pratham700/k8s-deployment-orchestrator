import { randomUUID } from 'node:crypto';
import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { type Permission, type Role, roleHasPermission } from '@kdo/core';

/**
 * The one hardcoded API key. Demo-only: override via env in any real use.
 * Documented in the README so the app can be evaluated with zero setup.
 */
export const API_KEY = process.env.KDO_API_KEY ?? 'kdo-dev-key-2026';

export interface AuthVariables {
  role: Role;
}

/**
 * In-memory session store: opaque token -> role. Same shape/lifetime as the
 * RunStore (lost on restart, which is fine for a demo). A real system would
 * use signed, expiring tokens and a shared session backend.
 */
const sessions = new Map<string, Role>();

export function createSession(role: Role): string {
  const token = randomUUID();
  sessions.set(token, role);
  return token;
}

export function isValidApiKey(key: unknown): boolean {
  return typeof key === 'string' && key === API_KEY;
}

function extractToken(c: Context): string | undefined {
  const header = c.req.header('Authorization');
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length);
  // SSE fallback: EventSource cannot set headers, so accept ?token= too.
  return c.req.query('token');
}

/** Reject unless a valid session token is present; attaches the role. */
export const requireAuth = createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
  const token = extractToken(c);
  const role = token ? sessions.get(token) : undefined;
  if (!role) {
    return c.json({ error: 'unauthorized — sign in to obtain a token' }, 401);
  }
  c.set('role', role);
  await next();
  return;
});

/** Reject unless the authenticated role holds the given permission. */
export const requirePermission = (permission: Permission) =>
  createMiddleware<{ Variables: AuthVariables }>(async (c, next) => {
    const role = c.get('role');
    if (!roleHasPermission(role, permission)) {
      return c.json({ error: `forbidden — role '${role}' lacks '${permission}'` }, 403);
    }
    await next();
    return;
  });
