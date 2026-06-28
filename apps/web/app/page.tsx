'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Run } from '@kdo/core';
import { DeployForm } from './components/DeployForm';
import { RunList } from './components/RunList';
import { RunDetail } from './components/RunDetail';
import { getRun, listRuns, streamRun } from '../lib/api';

const isTerminal = (s: Run['status']): boolean =>
  s === 'succeeded' || s === 'failed' || s === 'rolled_back';

export default function Page() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Run | null>(null);
  const [online, setOnline] = useState<boolean | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const refreshList = useCallback(async () => {
    try {
      setRuns(await listRuns());
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, []);

  // Patch a single run into both the detail view and the list as it streams.
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

      const run = await getRun(id);
      setSelected(run);
      if (!isTerminal(run.status)) {
        unsubRef.current = streamRun(id, applyUpdate, () => void refreshList());
      }
    },
    [applyUpdate, refreshList],
  );

  useEffect(() => {
    void refreshList();
    return () => unsubRef.current?.();
  }, [refreshList]);

  return (
    <>
      <header className="topbar">
        <h1>⎈ kdo</h1>
        <span className="sub">Kubernetes Deploy Orchestrator</span>
        <span className="spacer" />
        <span className={`badge s-${online === false ? 'failed' : online ? 'succeeded' : 'pending'}`}>
          <span className="dot" />
          {online === false ? 'API offline' : online ? 'API online' : 'connecting'}
        </span>
      </header>

      <div className="layout">
        <div>
          <DeployForm
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
