'use client';

import { useState } from 'react';
import type { Role } from '@kdo/core';
import { login } from '../../lib/api';
import { saveSession, type Session } from '../../lib/auth';

// Role catalogue duplicated here (values, not types) to keep core's runtime out
// of the client bundle — mirrors @kdo/core's ROLE_INFO.
const ROLE_OPTIONS: { role: Role; label: string; description: string }[] = [
  { role: 'platform-team', label: 'Platform Team', description: 'Full access — deploy + observe.' },
  { role: 'devops-engineer', label: 'DevOps Engineer', description: 'Trigger deployments + observe.' },
  {
    role: 'engineering-manager',
    label: 'Engineering Manager',
    description: 'Read-only — observe deployments and status.',
  },
];

// Pre-filled so the app can be evaluated with zero setup (demo-only key).
const DEV_API_KEY = 'kdo-dev-key-2026';

export function LoginGate({ onAuthenticated }: { onAuthenticated: (session: Session) => void }) {
  const [apiKey, setApiKey] = useState(DEV_API_KEY);
  const [role, setRole] = useState<Role>('platform-team');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const session = await login(apiKey, role);
      saveSession(session);
      onAuthenticated(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'login failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form
        className="panel login-card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2>Sign in</h2>
        <div className="body">
          <label htmlFor="apiKey">API key</label>
          <input id="apiKey" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          <div className="hint">Demo key pre-filled. Override the server key with $KDO_API_KEY.</div>

          <label htmlFor="role">Sign in as</label>
          <select id="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLE_OPTIONS.map((r) => (
              <option key={r.role} value={r.role}>
                {r.label}
              </option>
            ))}
          </select>
          <div className="hint">{ROLE_OPTIONS.find((r) => r.role === role)?.description}</div>

          {error && <div className="errbox">{error}</div>}

          <button className="primary" type="submit" disabled={busy}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </div>
      </form>
    </div>
  );
}
