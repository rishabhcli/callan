import React, { useMemo } from 'react';

const NODES = [
  { id: 'scraper',  label: 'Research', x:  80, y: 110, gloss: 'presence' },
  { id: 'memory',   label: 'Memory',   x: 360, y: 110, gloss: 'long-term' },
  { id: 'caller',   label: 'Caller',   x: 640, y:  40, gloss: 'voice' },
  { id: 'analyst',  label: 'Analyst',  x: 640, y: 180, gloss: 'needs' },
  { id: 'mailer',   label: 'Mailer',   x: 880, y:  40, gloss: 'invoice' },
  { id: 'builder',  label: 'Builder',  x: 880, y: 180, gloss: 'live build' }
];

const EDGES = [
  { id: 'scraper-memory', from: 'scraper', to: 'memory' },
  { id: 'memory-caller',  from: 'memory',  to: 'caller'  },
  { id: 'caller-memory',  from: 'caller',  to: 'memory', curve: 0.18 },
  { id: 'memory-analyst', from: 'memory',  to: 'analyst' },
  { id: 'analyst-memory', from: 'analyst', to: 'memory', curve: -0.18 },
  { id: 'memory-mailer',  from: 'memory',  to: 'mailer'  },
  { id: 'mailer-memory',  from: 'mailer',  to: 'memory', curve: 0.18 },
  { id: 'memory-builder', from: 'memory',  to: 'builder' },
  { id: 'builder-memory', from: 'builder', to: 'memory', curve: -0.18 }
];

const NODE_W = 108;
const NODE_H = 64;

function nodeRect(node) {
  return {
    x: node.x,
    y: node.y,
    cx: node.x + NODE_W / 2,
    cy: node.y + NODE_H / 2,
    right: node.x + NODE_W,
    bottom: node.y + NODE_H
  };
}

function endpointFor(from, to) {
  const f = nodeRect(from);
  const t = nodeRect(to);
  const dx = t.cx - f.cx;
  const dy = t.cy - f.cy;
  const horizontal = Math.abs(dx) > Math.abs(dy);
  if (horizontal) {
    return dx > 0
      ? { x1: f.right, y1: f.cy, x2: t.x, y2: t.cy }
      : { x1: f.x, y1: f.cy, x2: t.right, y2: t.cy };
  }
  return dy > 0
    ? { x1: f.cx, y1: f.bottom, x2: t.cx, y2: t.y }
    : { x1: f.cx, y1: f.y, x2: t.cx, y2: t.bottom };
}

function edgePath(edge, byId) {
  const from = byId[edge.from];
  const to = byId[edge.to];
  const { x1, y1, x2, y2 } = endpointFor(from, to);
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (edge.curve) {
    const nx = -dy;
    const ny = dx;
    const len = Math.hypot(nx, ny) || 1;
    const off = edge.curve * Math.hypot(dx, dy);
    const cx = mx + (nx / len) * off;
    const cy = my + (ny / len) * off;
    return { d: `M ${x1} ${y1} Q ${cx} ${cy} ${x2} ${y2}`, x1, y1, x2, y2, cx, cy };
  }
  return { d: `M ${x1} ${y1} L ${x2} ${y2}`, x1, y1, x2, y2, cx: mx, cy: my };
}

export default function NodeGraph({ states, counters, pulses, focusedNodeId, onSelect, compact = false }) {
  const byId = useMemo(() => Object.fromEntries(NODES.map((n) => [n.id, n])), []);
  const paths = useMemo(() => Object.fromEntries(EDGES.map((e) => [e.id, edgePath(e, byId)])), [byId]);

  if (compact) {
    return (
      <div className="node-strip" role="toolbar" aria-label="agent pipeline">
        {NODES.map((n) => {
          const state = states[n.id] || 'idle';
          const isFocus = focusedNodeId === n.id;
          const count = counters[n.id] || 0;
          return (
            <button
              key={n.id}
              type="button"
              className={`node-chip node-chip-${state} ${isFocus ? 'node-chip-focus' : ''}`}
              onClick={() => onSelect?.(n.id)}
              title={`${n.label} · ${n.gloss} · ${state}`}
            >
              <span className="node-chip-state" />
              <span>{n.label}</span>
              <span className="node-chip-count">{count > 0 ? count : '·'}</span>
            </button>
          );
        })}
      </div>
    );
  }

  return (
    <svg className="graph-svg" viewBox="0 0 1024 280" preserveAspectRatio="xMidYMid meet">
      <defs>
        <pattern id="dotgrid" width="32" height="32" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1.2" fill="var(--ink-300)" opacity="0.18" />
        </pattern>
        <marker id="arrow" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="var(--ink-400)" />
        </marker>
        <marker id="arrow-active" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
          <path d="M0,0 L6,3 L0,6 z" fill="var(--accent)" />
        </marker>
      </defs>

      <rect width="1024" height="280" fill="url(#dotgrid)" />

      {EDGES.map((e) => {
        const p = paths[e.id];
        const fromState = states[e.from];
        const toState = states[e.to];
        const active = fromState === 'running' || toState === 'running';
        const pulse = pulses[e.id];
        return (
          <g key={e.id} className={`edge ${active ? 'edge-active' : ''}`}>
            <path d={p.d} fill="none" stroke={active ? 'var(--accent)' : 'var(--ink-400)'} strokeWidth="1" markerEnd={active ? 'url(#arrow-active)' : 'url(#arrow)'} />
            {pulse && (
              <circle r="3" fill="var(--accent)" key={pulse}>
                <animateMotion dur="0.7s" repeatCount="1" fill="freeze" path={p.d} />
                <animate attributeName="opacity" values="1;1;0" dur="0.7s" repeatCount="1" fill="freeze" />
              </circle>
            )}
          </g>
        );
      })}

      {NODES.map((n) => {
        const state = states[n.id] || 'idle';
        const isFocus = focusedNodeId === n.id;
        const count = counters[n.id] || 0;
        return (
          <g
            key={n.id}
            className={`node node-${state} ${isFocus ? 'node-focus' : ''}`}
            transform={`translate(${n.x},${n.y})`}
            onClick={() => onSelect(n.id)}
            role="button"
            tabIndex={0}
          >
            <rect className="node-box" width={NODE_W} height={NODE_H} rx="1" />
            <g className="node-led" transform="translate(10,12)">
              <circle r="3.2" />
            </g>
            <text className="node-label" x="22" y="16">{n.label.toUpperCase()}</text>
            <text className="node-gloss" x="22" y="32">{n.gloss}</text>
            <text className="node-counter" x={NODE_W - 10} y={NODE_H - 10} textAnchor="end">
              {String(count).padStart(3, '0')}
            </text>
            <text className="node-state" x="10" y={NODE_H - 10}>
              {state}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export { NODES, EDGES };
