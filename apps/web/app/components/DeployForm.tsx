'use client';

import { useState } from 'react';
import { createDeployment, type DeploySpecInput, type ValidationError } from '../../lib/api';

// Option lists are duplicated here (rather than imported as values from
// @kdo/core) to keep the client bundle free of any server runtime.
const STRATEGIES = ['RollingUpdate', 'Recreate'] as const;
const FAILURE_MODES = [
  { value: 'none', label: 'none — healthy rollout' },
  { value: 'image-pull', label: 'image-pull — ImagePullBackOff' },
  { value: 'crash-loop', label: 'crash-loop — CrashLoopBackOff' },
  { value: 'readiness-timeout', label: 'readiness-timeout — never ready' },
] as const;

const DEFAULTS: DeploySpecInput = {
  name: 'checkout-api',
  namespace: 'demo',
  image: 'ghcr.io/acme/checkout:1.4.2',
  replicas: 3,
  strategy: 'RollingUpdate',
  failureMode: 'none',
};

export function DeployForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [form, setForm] = useState<DeploySpecInput>(DEFAULTS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof DeploySpecInput>(key: K, value: DeploySpecInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const run = await createDeployment(form);
      onCreated(run.id);
    } catch (err) {
      const v = err as ValidationError;
      setError(
        v.issues
          ? v.issues.map((i) => `${i.path.join('.') || 'spec'}: ${i.message}`).join('\n')
          : 'Request failed — is the API running on :3001?',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="panel"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h2>New deployment</h2>
      <div className="body">
        <div className="row">
          <div>
            <label htmlFor="name">name</label>
            <input id="name" value={form.name} onChange={(e) => set('name', e.target.value)} />
          </div>
          <div>
            <label htmlFor="namespace">namespace</label>
            <input
              id="namespace"
              value={form.namespace}
              onChange={(e) => set('namespace', e.target.value)}
            />
          </div>
        </div>

        <label htmlFor="image">image</label>
        <input id="image" value={form.image} onChange={(e) => set('image', e.target.value)} />

        <div className="row">
          <div>
            <label htmlFor="replicas">replicas</label>
            <input
              id="replicas"
              type="number"
              min={1}
              max={10}
              value={form.replicas}
              onChange={(e) => set('replicas', Number(e.target.value))}
            />
          </div>
          <div>
            <label htmlFor="strategy">strategy</label>
            <select
              id="strategy"
              value={form.strategy}
              onChange={(e) => set('strategy', e.target.value as DeploySpecInput['strategy'])}
            >
              {STRATEGIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </div>

        <label htmlFor="failureMode">failure injection (demo)</label>
        <select
          id="failureMode"
          value={form.failureMode}
          onChange={(e) => set('failureMode', e.target.value as DeploySpecInput['failureMode'])}
        >
          {FAILURE_MODES.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <div className="hint">
          Pick a failure mode to watch the health gate trip and the rollout roll back.
        </div>

        {error && <div className="errbox">{error}</div>}

        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Submitting…' : 'Deploy'}
        </button>
      </div>
    </form>
  );
}
