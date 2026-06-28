'use client';

import type { Run } from '@kdo/core';
import { StatusBadge } from './StatusBadge';

export function RunList({
  runs,
  selectedId,
  onSelect,
}: {
  runs: Run[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="panel">
      <h2>Runs</h2>
      {runs.length === 0 ? (
        <div className="empty">No runs yet. Submit a deployment above.</div>
      ) : (
        <div className="runlist">
          {runs.map((run) => (
            <div
              key={run.id}
              className={`runitem${run.id === selectedId ? ' active' : ''}`}
              onClick={() => onSelect(run.id)}
            >
              <div className="meta">
                <div className="name">
                  {run.spec.namespace}/{run.spec.name}
                </div>
                <div className="id">
                  {run.id} · rev {run.revision}
                </div>
              </div>
              <StatusBadge status={run.status} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
