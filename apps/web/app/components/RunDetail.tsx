'use client';

import { useState } from 'react';
import type { Pod, Run, Step } from '@kdo/core';
import { StatusBadge } from './StatusBadge';

function duration(step: Step): string {
  if (!step.startedAt) return '';
  const end = step.finishedAt ? Date.parse(step.finishedAt) : Date.now();
  const ms = end - Date.parse(step.startedAt);
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// Map a pod's K8s-style status onto our shared status colour classes.
function podClass(status: Pod['status']): string {
  switch (status) {
    case 'Ready':
      return 'succeeded';
    case 'ImagePullBackOff':
    case 'CrashLoopBackOff':
      return 'failed';
    case 'Terminating':
      return 'skipped';
    default:
      return 'running';
  }
}

function PodGrid({ pods }: { pods: Pod[] }) {
  return (
    <div className="pods">
      {pods.map((pod) => (
        <div className="pod" key={pod.name} title={pod.reason ?? pod.status}>
          <div className="pname">{pod.name}</div>
          <div className={`pstatus s-${podClass(pod.status)}`}>
            <span className="dot" />
            {pod.status}
            {pod.restarts > 0 && <span className="restarts">↻{pod.restarts}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}

function StepRow({ step }: { step: Step }) {
  const [open, setOpen] = useState(step.status === 'failed');
  const hasLogs = step.logs.length > 0;
  return (
    <li className="step">
      <div
        className="head"
        style={{ cursor: hasLogs ? 'pointer' : 'default' }}
        onClick={() => hasLogs && setOpen((o) => !o)}
      >
        <StatusBadge status={step.status} />
        <span className="label">{step.name}</span>
        <span className="dur">{duration(step)}</span>
      </div>
      {open && hasLogs && (
        <pre className="logs">
          {step.logs.map((line, i) => (
            <div key={i} className={line.includes('error:') ? 'err' : undefined}>
              {line}
            </div>
          ))}
        </pre>
      )}
    </li>
  );
}

export function RunDetail({ run }: { run: Run | null }) {
  const [showManifest, setShowManifest] = useState(false);

  if (!run) {
    return (
      <div className="panel">
        <h2>Run detail</h2>
        <div className="empty">Select or create a run to watch it execute.</div>
      </div>
    );
  }

  const ready = run.rollout?.ready ?? 0;
  const desired = run.rollout?.desired ?? run.spec.replicas;
  const pct = desired > 0 ? Math.round((ready / desired) * 100) : 0;

  return (
    <div className="panel">
      <div className="detail-head">
        <span className="title">
          {run.spec.namespace}/{run.spec.name}
        </span>
        <StatusBadge status={run.status} />
        <span className="dur" style={{ marginLeft: 'auto' }}>
          {run.id} · rev {run.revision}
          {run.previousRevision != null && ` (prev ${run.previousRevision})`}
        </span>
      </div>
      {run.message && <div className="message">{run.message}</div>}

      <div style={{ padding: '0 14px 14px' }}>
        <div className="dur" style={{ marginBottom: 4 }}>
          replicas ready {ready}/{desired}
        </div>
        <div className="progress">
          <span style={{ width: `${pct}%` }} />
        </div>
      </div>

      <ul className="steps">
        {run.steps.map((step) => (
          <StepRow key={step.id} step={step} />
        ))}
      </ul>

      {run.rollout && run.rollout.pods.length > 0 && (
        <>
          <div className="sectlabel">Pods</div>
          <PodGrid pods={run.rollout.pods} />
        </>
      )}

      {run.manifest && (
        <>
          <div className="sectlabel" style={{ cursor: 'pointer' }} onClick={() => setShowManifest((s) => !s)}>
            Rendered manifest {showManifest ? '▾' : '▸'}
          </div>
          {showManifest && <pre className="manifest">{run.manifest}</pre>}
        </>
      )}
    </div>
  );
}
