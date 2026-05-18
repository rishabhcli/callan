import React from 'react';
import MemoryConsole from '../components/MemoryConsole.jsx';

export default function MemoryView({ focusedLeadId }) {
  return (
    <div className="nyna-memory-shell">
      <header className="nyna-memory-header">
        <div>
          <div className="nyna-detail-subtitle">supermemory · knowledge surface</div>
          <div className="nyna-detail-title">memory floor</div>
          <p className="nyna-memory-tag">
            Every business, evidence shard, transcript, postmortem, mail thread, invoice
            and build outcome ends up here as a linked document. The graph below is
            served by Supermemory; the table beneath shows what we've mirrored locally.
          </p>
        </div>
        <a className="nyna-action nyna-action-primary" href="https://app.supermemory.ai" target="_blank" rel="noreferrer">
          open Supermemory console ↗
        </a>
      </header>

      <div className="nyna-memory-graph">
        <SupermemoryEmbed />
      </div>

      <div className="nyna-card" style={{ padding: 0, overflow: 'hidden' }}>
        <MemoryConsole leadId={focusedLeadId} />
      </div>
    </div>
  );
}

function SupermemoryEmbed() {
  // Supermemory's hosted graph requires auth to embed, so we render an in-app
  // animated synopsis and link out for the live view. When Supermemory ships
  // a token-embeddable graph, swap this for an iframe.
  return (
    <div className="nyna-memory-graph-card">
      <div className="nyna-memory-graph-eye">interactive synopsis</div>
      <Spiderweb />
      <div className="nyna-memory-graph-legend">
        <Legend color="var(--apricot)" label="business profiles" count="—" />
        <Legend color="var(--candy)"   label="evidence shards"   count="—" />
        <Legend color="var(--pearl)"   label="call transcripts"  count="—" />
        <Legend color="var(--brown-red)" label="outcomes / builds" count="—" />
      </div>
    </div>
  );
}

function Legend({ color, label, count }) {
  return (
    <div className="nyna-memory-legend-item">
      <span className="nyna-memory-legend-dot" style={{ background: color }} />
      <div>
        <div className="nyna-memory-legend-label">{label}</div>
        <div className="nyna-memory-legend-count">{count}</div>
      </div>
    </div>
  );
}

function Spiderweb() {
  // Decorative SVG only — animated nodes orbiting a centroid.
  const nodes = React.useMemo(() => {
    const center = { x: 0, y: 0, r: 12, color: '#D8973C' };
    const orbiters = [];
    const COLORS = ['#FD9BB7', '#F3E6BD', '#AD2831', '#D8973C'];
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const radius = 90 + (i % 4) * 22;
      orbiters.push({
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius * 0.6,
        r: 4 + (i % 3) * 1.5,
        color: COLORS[i % COLORS.length]
      });
    }
    const fringe = [];
    for (let i = 0; i < 36; i++) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 180 + Math.random() * 90;
      fringe.push({
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius * 0.6,
        r: 1.4 + Math.random() * 1.6,
        color: COLORS[Math.floor(Math.random() * COLORS.length)]
      });
    }
    const points = [center, ...orbiters, ...fringe];
    const edges = [];
    orbiters.forEach((o) => edges.push({ x1: 0, y1: 0, x2: o.x, y2: o.y }));
    for (let i = 0; i < orbiters.length; i++) {
      const next = orbiters[(i + 1) % orbiters.length];
      edges.push({ x1: orbiters[i].x, y1: orbiters[i].y, x2: next.x, y2: next.y });
    }
    fringe.forEach((f, i) => {
      const anchor = orbiters[i % orbiters.length];
      edges.push({ x1: anchor.x, y1: anchor.y, x2: f.x, y2: f.y });
    });
    return { points, edges };
  }, []);

  return (
    <svg viewBox="-300 -170 600 340" className="nyna-memory-svg">
      {nodes.edges.map((e, i) => (
        <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
          stroke="rgba(216, 151, 60, 0.28)" strokeWidth="0.5" />
      ))}
      {nodes.points.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={p.r * 2.2}
            fill={p.color} opacity="0.18" />
          <circle cx={p.x} cy={p.y} r={p.r}
            fill={p.color}
            stroke="rgba(243, 230, 189, 0.4)"
            strokeWidth="0.4"
          >
            <animate attributeName="r" values={`${p.r};${p.r * 1.18};${p.r}`} dur={`${1.6 + (i % 5) * 0.4}s`} repeatCount="indefinite" />
          </circle>
        </g>
      ))}
    </svg>
  );
}
