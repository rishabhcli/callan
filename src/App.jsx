import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NodeGraph from './components/NodeGraph.jsx';
import DiscoverForm from './components/DiscoverForm.jsx';
import LeadList from './components/LeadList.jsx';
import Inspector from './components/Inspector.jsx';
import { useSSE } from './useSSE.js';
import { api } from './api.js';

const NODE_TO_TAB = {
  scraper: 'Memory',
  memory: 'Memory',
  caller: 'Caller',
  analyst: 'Analyst',
  mailer: 'Mailer',
  builder: 'Builder'
};

const WORKER_FROM_TYPE = (t) => t.split('.')[0];
const SUCCESS_TYPES = new Set(['scraper.done', 'caller.done', 'analyst.done', 'mailer.done', 'builder.done']);
const ERROR_TYPES   = new Set(['scraper.error', 'caller.error', 'analyst.error', 'mailer.error', 'builder.error']);

const EDGE_FOR = {
  scraper: { in: 'scraper-memory', out: 'scraper-memory' },
  caller:  { in: 'memory-caller',  out: 'caller-memory' },
  analyst: { in: 'memory-analyst', out: 'analyst-memory' },
  mailer:  { in: 'memory-mailer',  out: 'mailer-memory' },
  builder: { in: 'memory-builder', out: 'builder-memory' }
};

const MAX_TRANSCRIPT = 200;
const COUNTER_WINDOW_MS = 60000;

const PROVIDER_BADGES = [
  { key: 'gemini', label: 'GD', title: 'Google DeepMind / Gemini' },
  { key: 'supermemory', label: 'SUP', title: 'Supermemory' },
  { key: 'moss', label: 'MOS', title: 'Moss' },
  { key: 'agentphone', label: 'PHO', title: 'AgentPhone' },
  { key: 'browserUse', label: 'BRO', title: 'Browser Use' },
  { key: 'agentmail', label: 'AML', title: 'AgentMail' },
  { key: 'stripe', label: 'STR', title: 'Stripe invoices' }
];

export default function App() {
  const [health, setHealth] = useState(null);
  const [leads, setLeads] = useState([]);
  const [focusedLeadId, setFocusedLeadId] = useState(null);
  const [leadDetail, setLeadDetail] = useState(null);
  const [activeTab, setActiveTab] = useState('Memory');
  const [focusedNodeId, setFocusedNodeId] = useState(null);
  const [outreach, setOutreach] = useState(null);

  const [nodeStates, setNodeStates] = useState({
    scraper: 'idle', memory: 'idle', caller: 'idle',
    analyst: 'idle', mailer: 'idle', builder: 'idle'
  });
  const [pulses, setPulses] = useState({});
  const [activity, setActivity] = useState({
    scraper: [], memory: [], caller: [], analyst: [], mailer: [], builder: []
  });
  const [eventLog, setEventLog] = useState([]);

  const [liveTranscript, setLiveTranscript] = useState([]);
  const [liveCallId, setLiveCallId] = useState(null);
  const [liveLeadId, setLiveLeadId] = useState(null);
  const [liveCallActive, setLiveCallActive] = useState(false);
  const [builderInfo, setBuilderInfo] = useState({ leadId: null, liveUrl: null, projectUrl: null, brief: null });

  const focusedRef = useRef(focusedLeadId);
  focusedRef.current = focusedLeadId;
  const pulseSeq = useRef(0);

  const bumpActivity = useCallback((worker) => {
    if (!worker) return;
    const now = Date.now();
    setActivity((prev) => {
      const list = (prev[worker] || []).filter((t) => now - t < COUNTER_WINDOW_MS);
      list.push(now);
      return { ...prev, [worker]: list };
    });
  }, []);

  const triggerEdge = useCallback((edgeId) => {
    if (!edgeId) return;
    const id = ++pulseSeq.current;
    setPulses((prev) => ({ ...prev, [edgeId]: id }));
    setTimeout(() => {
      setPulses((prev) => {
        if (prev[edgeId] !== id) return prev;
        const next = { ...prev };
        delete next[edgeId];
        return next;
      });
    }, 800);
  }, []);

  const refreshLeads = useCallback(async () => {
    try {
      const data = await api.listLeads();
      setLeads(data?.leads || []);
    } catch (e) {
      // ignore — non-fatal
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const [healthData, outreachData] = await Promise.all([
        api.health(),
        api.outreachStatus()
      ]);
      setHealth(healthData);
      setOutreach(outreachData);
    } catch {
      setHealth((h) => h || { ok: false });
    }
  }, []);

  const refreshLeadDetail = useCallback(async (id) => {
    if (!id) { setLeadDetail(null); return; }
    try {
      const detail = await api.getLead(id);
      setLeadDetail(detail);
    } catch (e) {
      setLeadDetail({ error: e.message });
    }
  }, []);

  useEffect(() => {
    refreshHealth();
    refreshLeads();
    const leadsId = setInterval(refreshLeads, 5000);
    const healthId = setInterval(refreshHealth, 8000);
    return () => {
      clearInterval(leadsId);
      clearInterval(healthId);
    };
  }, [refreshHealth, refreshLeads]);

  useEffect(() => { refreshLeadDetail(focusedLeadId); }, [focusedLeadId, refreshLeadDetail]);

  const onEvent = useCallback((evt) => {
    const t = evt.type;
    if (t === 'hello') return;

    setEventLog((prev) => [{ ...evt, _ts: evt.ts || Date.now() }, ...prev].slice(0, 40));

    const worker = evt.worker || WORKER_FROM_TYPE(t);
    bumpActivity(worker);
    if (['scraper.start', 'caller.start', 'analyst.start', 'mailer.start', 'builder.start'].includes(t)) {
      setNodeStates((p) => ({ ...p, [worker]: 'running' }));
      const edge = EDGE_FOR[worker]?.in;
      triggerEdge(edge);
      setNodeStates((p) => ({ ...p, memory: 'running' }));
      bumpActivity('memory');
      setTimeout(() => setNodeStates((p) => (p.memory === 'running' ? { ...p, memory: 'idle' } : p)), 1200);
    }
    if (SUCCESS_TYPES.has(t)) {
      setNodeStates((p) => ({ ...p, [worker]: 'success' }));
      triggerEdge(EDGE_FOR[worker]?.out);
      setTimeout(() => setNodeStates((p) => (p[worker] === 'success' ? { ...p, [worker]: 'idle' } : p)), 2400);
    }
    if (ERROR_TYPES.has(t)) {
      setNodeStates((p) => ({ ...p, [worker]: 'error' }));
    }

    if (t === 'lead.created') {
      bumpActivity('memory');
      triggerEdge('scraper-memory');
      refreshLeads();
      refreshHealth();
    }
    if (t === 'scraper.profile') {
      bumpActivity('memory');
      triggerEdge('scraper-memory');
    }
    if (t === 'pitch.created') {
      bumpActivity('memory');
      triggerEdge('caller-memory');
    }
    if (t === 'caller.placed') {
      setLiveCallId(evt.callId);
      setLiveLeadId(evt.leadId);
      setLiveCallActive(true);
      setLiveTranscript([]);
      if (evt.leadId === focusedRef.current) setActiveTab('Caller');
    }
    if (t === 'caller.transcript') {
      const turn = { role: evt.role, text: evt.text, ts: evt.ts || Date.now() };
      if (evt.leadId === focusedRef.current || liveLeadId === evt.leadId) {
        setLiveTranscript((prev) => [...prev, turn].slice(-MAX_TRANSCRIPT));
      }
      triggerEdge('caller-memory');
    }
    if (t === 'caller.done' || t === 'caller.error') {
      setLiveCallActive(false);
      refreshLeadDetail(evt.leadId || focusedRef.current);
    }
    if (t === 'analyst.done') {
      triggerEdge('analyst-memory');
      refreshLeadDetail(evt.leadId || focusedRef.current);
    }
    if (t === 'mailer.payment_link' || t === 'mailer.invoice_link' || t === 'mailer.email_sent' || t === 'mailer.inbound_message' || t === 'mailer.done') {
      triggerEdge('mailer-memory');
      refreshLeadDetail(evt.leadId || focusedRef.current);
    }
    if (t === 'mailer.auto_reply') {
      triggerEdge('mailer-memory');
      refreshLeadDetail(evt.leadId || focusedRef.current);
      refreshHealth();
    }
    if (t.startsWith('outreach.')) {
      refreshLeads();
      refreshHealth();
      if (evt.leadId === focusedRef.current) refreshLeadDetail(evt.leadId);
    }
    if (t === 'builder.live_url') {
      setBuilderInfo({
        leadId: evt.leadId,
        liveUrl: evt.liveUrl,
        projectUrl: null,
        brief: evt.brief
      });
      triggerEdge('builder-memory');
      if (evt.leadId === focusedRef.current) setActiveTab('Builder');
    }
    if (t === 'builder.project_url') {
      setBuilderInfo((prev) => ({ ...prev, projectUrl: evt.projectUrl }));
      triggerEdge('builder-memory');
    }
    if (t === 'builder.blocked_auth' || t === 'builder.done' || t === 'builder.error') {
      refreshLeadDetail(evt.leadId || focusedRef.current);
    }
    if (t === 'stripe.webhook') {
      bumpActivity('mailer');
      triggerEdge('mailer-memory');
      refreshLeadDetail(focusedRef.current);
      refreshHealth();
    }
  }, [bumpActivity, triggerEdge, refreshLeads, refreshLeadDetail, refreshHealth, liveLeadId]);

  const sseStatus = useSSE(onEvent);

  useEffect(() => {
    const tick = setInterval(() => {
      const now = Date.now();
      setActivity((prev) => {
        const next = {};
        let changed = false;
        for (const [k, list] of Object.entries(prev)) {
          const filtered = list.filter((t) => now - t < COUNTER_WINDOW_MS);
          if (filtered.length !== list.length) changed = true;
          next[k] = filtered;
        }
        return changed ? next : prev;
      });
    }, 5000);
    return () => clearInterval(tick);
  }, []);

  const counters = useMemo(() => {
    const out = {};
    for (const [k, list] of Object.entries(activity)) out[k] = list.length;
    return out;
  }, [activity]);

  const handleNodeSelect = useCallback((nodeId) => {
    setFocusedNodeId(nodeId);
    const tab = NODE_TO_TAB[nodeId];
    if (tab) setActiveTab(tab);
  }, []);

  const handleLeadFocus = useCallback((id) => {
    setFocusedLeadId(id);
    if (!focusedNodeId) setActiveTab('Memory');
  }, [focusedNodeId]);

  const mode = (health?.mode || '').toUpperCase() || 'INIT';
  const providers = health?.providers || {};

  const startAutonomy = useCallback(async () => {
    const data = await api.startOutreach();
    setOutreach(data);
    refreshHealth();
  }, [refreshHealth]);

  const stopAutonomy = useCallback(async () => {
    const data = await api.stopOutreach();
    setOutreach(data);
    refreshHealth();
  }, [refreshHealth]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-name">callmemaybe</span>
          <span className="brand-rule" />
          <span className="brand-tagline mono">operator console · agency control surface</span>
        </div>
        <div className="topbar-meta mono">
          <div className="meta-cell">
            <span className="meta-key">mode</span>
            <span className={`meta-val mode-${mode.toLowerCase()}`}>{mode}</span>
          </div>
          <div className="meta-cell">
            <span className="meta-key">stream</span>
            <span className={`meta-val sse-${sseStatus}`}>
              <span className={`led led-${sseStatus}`} />{sseStatus}
            </span>
          </div>
          <div className="meta-cell providers">
            <span className="meta-key">providers</span>
            <span className="meta-val providers-row">
              {PROVIDER_BADGES.map((p) => (
                <span key={p.key} className={`prov ${providers[p.key] ? 'prov-on' : 'prov-off'}`} title={p.title}>
                  <span className="prov-dot" />{p.label}
                </span>
              ))}
            </span>
          </div>
        </div>
      </header>

      <AutonomyStrip
        health={health}
        outreach={outreach}
        onStart={startAutonomy}
        onStop={stopAutonomy}
      />

      <main className="layout">
        <section className="left-pane">
          <div className="panel panel-graph">
            <div className="panel-head">
              <span className="hd">node graph</span>
              <span className="hd-meta mono">
                {leads.length} leads · click a node to inspect
              </span>
            </div>
            <NodeGraph
              states={nodeStates}
              counters={counters}
              pulses={pulses}
              focusedNodeId={focusedNodeId}
              onSelect={handleNodeSelect}
            />
            <div className="event-log mono">
              {eventLog.slice(0, 6).map((e, i) => (
                <div key={i} className="event-row">
                  <span className="event-ts">{new Date(e._ts).toLocaleTimeString()}</span>
                  <span className="event-type">{e.type}</span>
                  {e.providerType ? <span className="event-extra">· {e.providerType}</span> : null}
                  {e.businessName ? <span className="event-extra">· {e.businessName}</span> : null}
                  {e.outcome ? <span className="event-extra">· {e.outcome}</span> : null}
                  {e.error ? <span className="event-extra event-err">· {e.error}</span> : null}
                </div>
              ))}
            </div>
          </div>
          <div className="panel panel-leads">
            <DiscoverForm />
            <LeadList
              leads={leads}
              focusedLeadId={focusedLeadId}
              onFocus={handleLeadFocus}
            />
          </div>
        </section>
        <section className="right-pane">
          <div className="panel panel-inspector">
            <Inspector
              activeTab={activeTab}
              setActiveTab={setActiveTab}
              focusedLeadId={focusedLeadId}
              leadDetail={leadDetail}
              liveTranscript={liveTranscript}
              liveCallId={liveCallId}
              liveCallActive={liveCallActive}
              builderInfo={builderInfo}
            />
          </div>
        </section>
      </main>

      <footer className="footbar mono">
        <span>we are not selling an agent — we are selling an agency.</span>
        <span className="footbar-sep">·</span>
        <span>operator: <span className="accent">callmemaybe</span></span>
        <span className="footbar-sep">·</span>
        <span>{new Date().toISOString().slice(0, 10)}</span>
      </footer>
    </div>
  );
}

function AutonomyStrip({ health, outreach, onStart, onStop }) {
  const readiness = outreach?.readiness || health?.readiness || {};
  const q = readiness.outreach || {};
  const blockers = readiness.blockers || [];
  const active = outreach?.activeJob;
  const mode = readiness.mode || health?.mode || 'mock';
  return (
    <section className="autonomy-strip">
      <div className="auto-main">
        <span className={`auto-pill ${outreach?.running ? 'auto-on' : 'auto-off'}`}>
          {outreach?.running ? 'autonomy running' : 'autonomy paused'}
        </span>
        <span className="auto-stat mono">mode {mode}</span>
        <span className="auto-stat mono">queue {q.queued ?? 0}</span>
        <span className="auto-stat mono">blocked {q.blocked ?? 0}</span>
        <span className="auto-stat mono">calls today {q.todaysCalls ?? 0}</span>
        <span className="auto-stat mono">opt-outs {q.optOuts ?? 0}</span>
        <span className="auto-stat mono">mail replies {q.repliesWaiting ?? 0}</span>
      </div>
      <div className="auto-side">
        {active ? <span className="auto-active mono">active: {active.businessName}</span> : null}
        {blockers.length ? <span className="auto-blocker mono">{blockers[0]}</span> : <span className="auto-ready mono">ready</span>}
        <button className="btn btn-mini" onClick={outreach?.running ? onStop : onStart}>
          {outreach?.running ? 'pause' : 'start'}
        </button>
      </div>
    </section>
  );
}
