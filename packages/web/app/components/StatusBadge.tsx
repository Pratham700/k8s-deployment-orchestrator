// A status pill (and a bare dot variant) shared by runs, steps, and pods.
type Status = string;

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span className={`badge s-${status}`}>
      <span className="dot" />
      {status.replace('_', ' ')}
    </span>
  );
}

export function StatusDot({ status }: { status: Status }) {
  return <span className={`s-${status}`}><span className="dot" /></span>;
}
