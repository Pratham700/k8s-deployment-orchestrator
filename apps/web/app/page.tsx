'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Run } from '@kdo/core';
import { DeployForm } from './components/DeployForm';
import { RunList } from './components/RunList';
import { RunDetail } from './components/RunDetail';
import { LoginGate } from './components/LoginGate';
import { AuthError, getRun, listRuns, streamRun } from '../lib/api';
import { canDeploy, clearSession, loadSession, type Session } from '../lib/auth';

const isTerminal = (s: Run['status']): boolean =>
  s === 'succeeded' || s === 'failed' || s === 'rolled_back';

export default function Page() {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Run | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  // Restore any saved session on first paint (avoids an SSR/client mismatch).
  useEffect(() => {
    setSession(loadSession());
    setReady(true);
  }, []);

  const signOut = useCallback(() => {
    unsubRef.current?.();
    clearSession();
    setSession(null);
    setRuns([]);
    setSelected(null);
    setSelectedId(null);
  }, []);

  const refreshList = useCallback(async () => {
    try {
      setRuns(await listRuns());
      setOnline(true);
    } catch (err) {
      if (err instanceof AuthError) return signOut();
      setOnline(false);
    }
  }, [signOut]);

  const applyUpdate = useCallback((run: Run) => {
    setSelected(run);
    setRuns((prev) => {
      const idx = prev.findIndex((r) => r.id === run.id);
      if (idx === -1) return [run, ...prev];
      const next = [...prev];
      next[idx] = run;
      return next;
    });
  }, []);

  const selectRun = useCallback(
    async (id: string) => {
      unsubRef.current?.();
      unsubRef.current = null;
      setSelectedId(id);
      try {
        const run = await getRun(id);
        setSelected(run);
        if (!isTerminal(run.status)) {
          unsubRef.current = streamRun(id, applyUpdate, () => void refreshList());
        }
      } catch (err) {
        if (err instanceof AuthError) signOut();
      }
    },
    [applyUpdate, refreshList, signOut],
  );

  useEffect(() => {
    if (!session) return;
    void refreshList();
    return () => unsubRef.current?.();
  }, [session, refreshList]);

  if (!ready) return null;
  if (!session) return <LoginGate onAuthenticated={setSession} />;

  return (
    <>
      <header className="topbar">
        <h1>⎈ kdo</h1>
        <span className="sub">Kubernetes Deploy Orchestrator</span>
        <span className="spacer" />
        <span className="badge s-succeeded" title={session.role}>
          <span className="dot" />
          {session.role.replace('-', ' ')}
        </span>
        <span className={`badge s-${online === false ? 'failed' : online ? 'succeeded' : 'pending'}`}>
          <span className="dot" />
          {online === false ? 'API offline' : online ? 'API online' : 'connecting'}
        </span>
        <button className="linkbtn" onClick={signOut}>
          sign out
        </button>
      </header>

      <div className="layout">
        <div>
          <DeployForm
            canDeploy={canDeploy(session)}
            onCreated={(id) => {
              void refreshList();
              void selectRun(id);
            }}
          />
          <RunList runs={runs} selectedId={selectedId} onSelect={(id) => void selectRun(id)} />
        </div>
        <RunDetail run={selected} />
      </div>
    </>
  );
}
