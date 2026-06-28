// Client-side session: persists the token + role from /api/auth/login in
// localStorage. Demo-only — a real app would use httpOnly cookies.
import type { Role } from '@kdo/core';

const STORAGE_KEY = 'kdo.session';

export interface Session {
  token: string;
  role: Role;
  permissions: string[];
}

export function loadSession(): Session | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function saveSession(session: Session): void {
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  window.localStorage.removeItem(STORAGE_KEY);
}

export const canDeploy = (session: Session | null): boolean =>
  session?.permissions.includes('deployments:create') ?? false;
