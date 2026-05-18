import React, { Suspense, lazy, useEffect, useMemo } from 'react';
import MemoryConsole from '../components/MemoryConsole.jsx';
import BrowserUseConsole from '../components/BrowserUseConsole.jsx';
import BrowserResearchConsole from '../components/BrowserResearchConsole.jsx';
import Inspector from '../components/Inspector.jsx';
import LiveInboundPanel from '../components/LiveInboundPanel.jsx';

const AgentScene = lazy(() => import('../components/AgentScene.jsx'));

/**
 * Lightweight metadata mirror of the 3D scene node list.
 * Kept here so the heavy AgentScene chunk only loads once the Operations
 * tab is actually opened — the detail panel still needs labels/colors
 * before the canvas is mounted.
 */
const NODE_META = {
  memory:  { id: 'memory',  label: 'Supermemory',  sub: 'long-term memory',          code: 'SM', accent: '#58A8FF', glow: '#A7CBF2', description: 'Knowledge graph linking every business, evidence shard, transcript, and outcome.' },
  caller:  { id: 'caller',  label: 'Agent Phone',  sub: 'Caller logs and sessions', code: 'AP', accent: '#FD9BB7', glow: '#FD9BB7', description: 'Multiple voice agent instances dialing leads, recording transcripts, pitching builds.' },
  scraper: { id: 'scraper', label: 'Browser Use',  sub: 'Browser Scraper',           code: 'SCR', accent: '#D8973C', glow: '#D8973C', description: 'Cloud browser fleet harvesting evidence, scoring needs, and writing growth postmortems.' },
  mailer:  { id: 'mailer',  label: 'Agent Mail',   sub: 'inbox + replies',          code: 'AM', accent: '#D8973C', glow: '#FD9BB7', description: 'AgentMail threads, Stripe payment links, autoreplies, mailbox routing.' },
  builder: { id: 'builder', label: 'Lovable',      sub: 'Lovable build session',    code: 'BU', accent: '#FD9BB7', glow: '#4B73FF', description: 'Browser Use drives the Lovable building session live, with a shareable preview.' }
};

const NODE_TO_INSPECTOR_TAB = {
  caller: 'Caller',
  mailer: 'Mailer',
  builder: 'Builder',
  memory: 'Memory'
};

export default function OperationsView({
  nodeStates,
  counters,
  selectedNodeId,
  onSelectNode,
  focusedLeadId,
  leadDetail,
  liveTranscript,
  liveCallId,
  liveCallActive,
  builderInfo,
  builderAction,
  health,
  onRetryBuild,
  outreach,
  onStartAutonomy,
  onStopAutonomy,
  onLeadChanged,
  inbound,
  onDismissInbound
}) {
  const node = selectedNodeId ? NODE_META[selectedNodeId] : null;

  return (
    <div className="nyna-stage">
      <div className="nyna-stage-watermark">
        <strong>OPERATIONS</strong> · agent floor · real-time
      </div>
      <div className="nyna-stage-headline">
        <span className="nyna-stage-headline-eye">Callan</span>
        <div className="nyna-stage-headline-line">we sell the agency, not the agent.</div>
      </div>

      <div className="nyna-stage-scene">
        <Suspense fallback={<SceneFallback />}>
          <AgentScene
            states={nodeStates}
            counters={counters}
            selectedId={selectedNodeId}
            onSelect={onSelectNode}
          />
        </Suspense>
      </div>

      {inbound && (inbound.active || inbound.callId) ? (
        <LiveInboundPanel inbound={inbound} onClose={onDismissInbound} />
      ) : null}

      {node ? (
        <NodeDetailOverlay
          node={node}
          onClose={() => onSelectNode(null)}
          focusedLeadId={focusedLeadId}
          leadDetail={leadDetail}
          liveTranscript={liveTranscript}
          liveCallId={liveCallId}
          liveCallActive={liveCallActive}
          builderInfo={builderInfo}
          builderAction={builderAction}
          health={health}
          onRetryBuild={onRetryBuild}
          outreach={outreach}
          onStartAutonomy={onStartAutonomy}
          onStopAutonomy={onStopAutonomy}
          onLeadChanged={onLeadChanged}
          counters={counters}
        />
      ) : null}
    </div>
  );
}

function SceneFallback() {
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex',
      alignItems: 'center', justifyContent: 'center',
      fontFamily: 'var(--font-mono)', fontSize: 11,
      color: 'var(--ink-400)', letterSpacing: '0.18em',
      textTransform: 'uppercase'
    }}>
      conjuring the floor…
    </div>
  );
}

function NodeDetailOverlay({
  node,
  onClose,
  focusedLeadId,
  leadDetail,
  liveTranscript,
  liveCallId,
  liveCallActive,
  builderInfo,
  builderAction,
  health,
  onRetryBuild,
  outreach,
  onStartAutonomy,
  onStopAutonomy,
  onLeadChanged,
  counters
}) {
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  const inspectorTab = NODE_TO_INSPECTOR_TAB[node.id];
  const useInspector = focusedLeadId && inspectorTab && inspectorTab !== 'Memory';

  const stats = useMemo(() => statsForNode(node.id, { counters, builderInfo, leadDetail }), [node.id, counters, builderInfo, leadDetail]);

  return (
    <div className="nyna-detail-overlay">
      <div className="nyna-detail-overlay-scrim" onClick={onClose} />
      <div className="nyna-detail-panel">
        <div className="nyna-detail-head">
          <div className="nyna-detail-head-left">
            <div className="nyna-detail-icon" style={{ background: `linear-gradient(135deg, ${node.accent}, ${node.glow})` }}>
              <DetailProviderMark id={node.id} fallback={node.code} />
            </div>
            <div>
              <div className="nyna-detail-subtitle">{node.sub}</div>
              <div className="nyna-detail-title">{node.label}</div>
            </div>
          </div>
          <div className="nyna-detail-stats">
            {stats.map((s) => (
              <div key={s.key}>
                <div className="nyna-detail-stat-key">{s.key}</div>
                <div className={`nyna-detail-stat-val${s.tone ? ` is-${s.tone}` : ''}`}>{s.value}</div>
              </div>
            ))}
            <button className="nyna-detail-close" onClick={onClose}>
              <span>close</span>
              <span style={{ opacity: 0.6 }}>esc</span>
            </button>
          </div>
        </div>

        <div className="nyna-detail-body">
          {node.id === 'memory' ? (
            <MemoryDetail leadId={focusedLeadId} />
          ) : node.id === 'scraper' ? (
            <ScraperDetail
              focusedLeadId={focusedLeadId}
              leadDetail={leadDetail}
              liveTranscript={liveTranscript}
              liveCallId={liveCallId}
              liveCallActive={liveCallActive}
              builderInfo={builderInfo}
              builderAction={builderAction}
              health={health}
              onRetryBuild={onRetryBuild}
              outreach={outreach}
              onStartAutonomy={onStartAutonomy}
              onStopAutonomy={onStopAutonomy}
              onLeadChanged={onLeadChanged}
            />
          ) : node.id === 'builder' ? (
            <BuilderDetail
              focusedLeadId={focusedLeadId}
              leadDetail={leadDetail}
              builderInfo={builderInfo}
              builderAction={builderAction}
              onRetryBuild={onRetryBuild}
              onLeadChanged={onLeadChanged}
              useInspector={!!focusedLeadId}
            />
          ) : useInspector ? (
            <InspectorPanel
              tab={inspectorTab}
              focusedLeadId={focusedLeadId}
              leadDetail={leadDetail}
              liveTranscript={liveTranscript}
              liveCallId={liveCallId}
              liveCallActive={liveCallActive}
              builderInfo={builderInfo}
              builderAction={builderAction}
              health={health}
              onRetryBuild={onRetryBuild}
              outreach={outreach}
              onStartAutonomy={onStartAutonomy}
              onStopAutonomy={onStopAutonomy}
              onLeadChanged={onLeadChanged}
            />
          ) : (
            <FleetDetailEmpty node={node} />
          )}
        </div>
      </div>
    </div>
  );
}

function FleetDetailEmpty({ node }) {
  return (
    <div className="nyna-card" style={{ maxWidth: 720, margin: '0 auto' }}>
      <div className="nyna-card-title">{node.label}</div>
      <div className="nyna-card-body" style={{ marginBottom: 18 }}>
        {node.description} Focus a lead from the live floor on the right to see this worker's
        per-lead detail; otherwise this panel shows fleet-wide rollups when populated.
      </div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-400)', letterSpacing: '0.1em' }}>
        // hint: click any business in the right rail
      </div>
    </div>
  );
}

function MemoryDetail({ leadId }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
      <SuperMemoryEmbed />
      <div className="nyna-card" style={{ padding: 0, overflow: 'hidden' }}>
        <MemoryConsole leadId={leadId} />
      </div>
    </div>
  );
}

function SuperMemoryEmbed() {
  // Supermemory provides a console at app.supermemory.ai with a knowledge graph view
  // per project. Because most embedding flows require auth, we render an in-app
  // graph synopsis as the default and link out for the full interactive view.
  return (
    <div className="nyna-supermem">
      <div className="nyna-supermem-head">
        <div>
          <div className="nyna-supermem-eyebrow">supermemory</div>
          <div className="nyna-supermem-title">knowledge graph synopsis</div>
        </div>
        <a className="nyna-mini-btn" href="https://app.supermemory.ai" target="_blank" rel="noreferrer">
          open full graph ↗
        </a>
      </div>
      <div className="nyna-supermem-viz">
        <SupermemSpiderweb />
        <div className="nyna-supermem-legend">
          <div className="nyna-supermem-legend-row"><span className="nyna-supermem-dot" style={{ background: 'var(--apricot)' }} /> business profile</div>
          <div className="nyna-supermem-legend-row"><span className="nyna-supermem-dot" style={{ background: 'var(--candy)' }} /> evidence</div>
          <div className="nyna-supermem-legend-row"><span className="nyna-supermem-dot" style={{ background: 'var(--pearl)' }} /> transcripts</div>
          <div className="nyna-supermem-legend-row"><span className="nyna-supermem-dot" style={{ background: 'var(--brown-red)', boxShadow: '0 0 0 1px var(--pearl)' }} /> outcomes</div>
        </div>
      </div>
    </div>
  );
}

function SupermemSpiderweb() {
  // Decorative SVG mini-graph hinting at the supermemory knowledge web.
  const nodes = useMemo(() => generateMockGraph(), []);
  return (
    <svg viewBox="-200 -120 400 240" className="nyna-supermem-svg">
      {nodes.edges.map((e, i) => (
        <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
          stroke="rgba(216, 151, 60, 0.3)" strokeWidth="0.6" />
      ))}
      {nodes.points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={p.r}
          fill={p.color}
          stroke="rgba(243, 230, 189, 0.4)"
          strokeWidth="0.4"
        >
          <animate attributeName="r" values={`${p.r};${p.r * 1.18};${p.r}`} dur={`${1.6 + (i % 5) * 0.4}s`} repeatCount="indefinite" />
        </circle>
      ))}
    </svg>
  );
}

function generateMockGraph() {
  const center = { x: 0, y: 0, r: 8, color: '#D8973C' };
  const orbiters = [];
  const COLORS = ['#FD9BB7', '#F3E6BD', '#AD2831', '#D8973C'];
  for (let i = 0; i < 14; i++) {
    const angle = (i / 14) * Math.PI * 2;
    const radius = 60 + (i % 3) * 22;
    orbiters.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.55,
      r: 3 + (i % 3),
      color: COLORS[i % COLORS.length]
    });
  }
  const fringe = [];
  for (let i = 0; i < 22; i++) {
    const angle = Math.random() * Math.PI * 2;
    const radius = 100 + Math.random() * 70;
    fringe.push({
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius * 0.5,
      r: 1.4 + Math.random() * 1.2,
      color: COLORS[Math.floor(Math.random() * COLORS.length)]
    });
  }
  const points = [center, ...orbiters, ...fringe];
  const edges = [];
  orbiters.forEach((o) => edges.push({ x1: center.x, y1: center.y, x2: o.x, y2: o.y }));
  for (let i = 0; i < orbiters.length; i++) {
    const next = orbiters[(i + 1) % orbiters.length];
    edges.push({ x1: orbiters[i].x, y1: orbiters[i].y, x2: next.x, y2: next.y });
  }
  fringe.forEach((f, i) => {
    const anchor = orbiters[i % orbiters.length];
    edges.push({ x1: anchor.x, y1: anchor.y, x2: f.x, y2: f.y });
  });
  return { points, edges };
}

function DetailProviderMark({ id, fallback }) {
  if (id === 'memory') {
    return (
      <svg viewBox="0 0 30 24" aria-hidden="true">
        <path d="M29.3388 9.46767H18.448V0.00146484H14.9293V10.2725C14.9293 11.3634 15.36 12.411 16.1254 13.183L25.018 22.151L27.506 19.6419L20.938 13.0183H29.3408V9.46975L29.3388 9.46767Z" />
        <path d="M1.82839 4.36056L8.39633 10.9842H-0.00646973V14.5328H10.8843V23.999H14.403V13.728C14.403 12.637 13.9723 11.5894 13.2069 10.8175L4.31635 1.85147L1.82839 4.36056Z" />
      </svg>
    );
  }
  if (id === 'mailer') {
    return (
      <svg viewBox="0 0 32 24" aria-hidden="true">
        <rect x="3" y="5" width="26" height="16" rx="3" />
        <path d="M5.5 7.5 16 14.7 26.5 7.5" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M5.5 19 12.2 13.8M26.5 19 19.8 13.8" fill="none" strokeWidth="2.4" strokeLinecap="round" />
      </svg>
    );
  }
  if (id === 'builder') {
    return (
      <svg viewBox="0 0 121 122" aria-hidden="true" className="is-lovable">
        <defs>
          <linearGradient id="lovable-detail-gradient" x1="28" x2="92" y1="18" y2="118" gradientUnits="userSpaceOnUse">
            <stop offset="0.03" stopColor="#FE7B02" />
            <stop offset="0.48" stopColor="#FF66F4" />
            <stop offset="0.95" stopColor="#4B73FF" />
          </linearGradient>
        </defs>
        <path d="M36.069 0c19.92 0 36.068 16.155 36.068 36.084v13.713h12.004c19.92 0 36.069 16.156 36.069 36.084 0 19.928-16.149 36.083-36.069 36.083H0v-85.88C0 16.155 16.148 0 36.069 0Z" fill="url(#lovable-detail-gradient)" />
      </svg>
    );
  }
  if (id === 'caller') {
    return (
      <img
        className="is-agentphone"
        src="https://agentphone.ai/logo.png"
        alt=""
        draggable="false"
        referrerPolicy="no-referrer"
      />
    );
  }
  if (id === 'scraper') {
    return (
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <rect x="4" y="6" width="24" height="17" rx="3" />
        <path d="M4.5 11h23" fill="none" strokeWidth="2" />
        <circle cx="12" cy="18" r="3" fill="none" strokeWidth="2.2" />
        <path d="m14.2 20.2 4.6 4.6M19 18h5" fill="none" strokeWidth="2.2" strokeLinecap="round" />
      </svg>
    );
  }
  return <span>{fallback}</span>;
}

function ScraperDetail({
  focusedLeadId,
  leadDetail,
  liveTranscript,
  liveCallId,
  liveCallActive,
  builderInfo,
  builderAction,
  health,
  onRetryBuild,
  outreach,
  onStartAutonomy,
  onStopAutonomy,
  onLeadChanged
}) {
  return (
    <div className="nyna-scraper-merged">
      <div className="nyna-card" style={{ padding: 0, overflow: 'hidden' }}>
        <BrowserResearchConsole />
      </div>
      {focusedLeadId ? (
        <InspectorPanel
          tab="Analyst"
          focusedLeadId={focusedLeadId}
          leadDetail={leadDetail}
          liveTranscript={liveTranscript}
          liveCallId={liveCallId}
          liveCallActive={liveCallActive}
          builderInfo={builderInfo}
          builderAction={builderAction}
          health={health}
          onRetryBuild={onRetryBuild}
          outreach={outreach}
          onStartAutonomy={onStartAutonomy}
          onStopAutonomy={onStopAutonomy}
          onLeadChanged={onLeadChanged}
        />
      ) : (
        <div className="nyna-card nyna-scraper-analysis-card">
          <div className="nyna-card-title">analysis folded into scraper</div>
          <div className="nyna-card-body">
            Needs assessment, growth planning, call postmortems, and presence scoring now live under the browser research lane. Focus a lead to inspect the analyst output here.
          </div>
        </div>
      )}
    </div>
  );
}

function BuilderDetail({
  focusedLeadId,
  leadDetail,
  builderInfo,
  builderAction,
  onRetryBuild,
  onLeadChanged,
  useInspector
}) {
  if (useInspector) {
    return (
      <InspectorPanel
        tab="Builder"
        focusedLeadId={focusedLeadId}
        leadDetail={leadDetail}
        builderInfo={builderInfo}
        builderAction={builderAction}
        onRetryBuild={onRetryBuild}
        onLeadChanged={onLeadChanged}
      />
    );
  }
  return (
    <div className="nyna-card" style={{ padding: 0, overflow: 'hidden' }}>
      <BrowserUseConsole onLeadChanged={onLeadChanged} />
    </div>
  );
}

function InspectorPanel(props) {
  // Inspector expects activeTab + setActiveTab to manage internal tabbing.
  // We pin it open to the relevant tab; users still get the sub-tabs strip
  // if they want to pivot between Memory/Caller/Analyst/Mailer/Builder.
  const [activeTab, setActiveTab] = React.useState(props.tab || 'Memory');
  React.useEffect(() => { setActiveTab(props.tab || 'Memory'); }, [props.tab]);
  return (
    <Inspector
      {...props}
      activeTab={activeTab}
      setActiveTab={setActiveTab}
    />
  );
}

function statsForNode(id, { counters, builderInfo, leadDetail }) {
  switch (id) {
    case 'memory':
      return [
        { key: 'docs/min', value: counters.memory || 0 },
        { key: 'cluster', value: 'isolated', tone: 'good' }
      ];
    case 'caller':
      return [
        { key: 'live calls', value: counters.caller || 0, tone: counters.caller > 0 ? 'warm' : undefined }
      ];
    case 'scraper':
      return [
        { key: 'browser fleet', value: counters.scraper || 0, tone: counters.scraper > 0 ? 'good' : undefined },
        { key: 'analysis/min', value: counters.analyst || 0, tone: counters.analyst > 0 ? 'warm' : undefined }
      ];
    case 'mailer':
      return [
        { key: 'threads', value: counters.mailer || 0 }
      ];
    case 'builder':
      return [
        { key: 'session', value: builderInfo?.status === 'not_started' ? 'idle' : builderInfo?.status || 'idle', tone: builderInfo?.status === 'running' ? 'warm' : undefined },
        { key: 'cost', value: builderInfo?.totalCostUsd ? `$${builderInfo.totalCostUsd}` : '—' }
      ];
    default:
      return [];
  }
}
