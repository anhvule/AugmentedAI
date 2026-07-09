import React from 'react';

const STATUS_COLOR = {
  pending: 'tan', planned: 'blue', implemented: 'blue', reviewed: 'blue',
  test_planned: 'blue', tested: 'green', done: 'green', failed: 'red', archived: 'gray',
  running: 'blue', ready: 'tan', blocked: 'gray', stopped: 'red', idle: 'gray', queued: 'tan',
  healthy: 'green', 'needs attention': 'red', approved: 'green', rejected: 'red',
};

export function StatusBadge({ status, children }) {
  if (!status) return null;
  return <span className={`badge ${STATUS_COLOR[status] || ''}`}>{children || status.replace(/_/g, ' ')}</span>;
}

export function Kicker({ children }) {
  return <div className="kicker">{children}</div>;
}

export function ScoreChips({ scores }) {
  if (!scores) return null;
  return (
    <div className="chips">
      {Object.entries(scores).map(([k, v]) => (
        <span className="chip" key={k}>
          {k} <b>{v}/10</b>
        </span>
      ))}
    </div>
  );
}

export function ScoreTotal({ scores, label }) {
  const total = Object.values(scores || {}).reduce((a, b) => a + Number(b || 0), 0);
  return (
    <div>
      <div className="score-big">
        {total}<small> / 60</small>
      </div>
      {label && <div className="meta">{label}</div>}
    </div>
  );
}

export function Section({ kicker, title, right, children, strip }) {
  return (
    <div className="card" style={{ marginTop: 18 }}>
      {strip && <div className="phase-strip" />}
      <div className="row between">
        <div>
          <Kicker>{kicker}</Kicker>
          {title && <h2 style={{ marginTop: 2 }}>{title}</h2>}
        </div>
        <div className="row">{right}</div>
      </div>
      {children}
    </div>
  );
}
