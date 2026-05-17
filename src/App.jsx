import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NodeGraph from './components/NodeGraph.jsx';
import DiscoverForm from './components/DiscoverForm.jsx';
import BrowserResearchConsole from './components/BrowserResearchConsole.jsx';
import LeadList from './components/LeadList.jsx';
import Inspector from './components/Inspector.jsx';
import BrowserUseConsole from './components/BrowserUseConsole.jsx';
import { useSSE } from './useSSE.js';
import { api } from './api.js';

const NODE_TO_TAB = {
  scraper: 'Memory',
  memory: 'Memory',
  caller: 'Caller',
  analyst: 'Analyst',
  mailer: 'Mailer',
  builder: 'Builder',
  browserUse: 'Builder'
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
  { key: 'gemini', label: 'GD', name: 'Google DeepMind', capability: 'reasoning', title: 'Google DeepMind / Gemini' },
  { key: 'supermemory', label: 'SUP', name: 'Supermemory', capability: 'lead memory', title: 'Supermemory' },
  { key: 'moss', label: 'MOS', name: 'Moss', capability: 'call index', title: 'Moss' },
  { key: 'agentphone', label: 'PHO', name: 'AgentPhone', capability: 'calls', liveKey: 'calls', title: 'AgentPhone' },
  { key: 'browserUse', label: 'BRO', name: 'Browser Use', capability: 'build session', liveKey: 'builds', title: 'Browser Use' },
  { key: 'lovable', label: 'LOV', name: 'Lovable', capability: 'site build', liveKey: 'builds', title: 'Lovable build-with-URL' },
  { key: 'agentmail', label: 'AML', name: 'AgentMail', capability: 'mail thread', liveKey: 'emails', title: 'AgentMail' },
  { key: 'stripe', label: 'STR', name: 'Stripe', capability: 'invoice paid', liveKey: 'payments', title: 'Stripe invoices' }
];

const EMPTY_BUILDER_INFO = {
  leadId: null,
  buildId: null,
  runId: null,
  status: 'not_started',
  liveUrl: null,
  projectUrl: null,
  finalSiteUrl: null,
  target: 'lovable',
  submissionUrl: null,
  providerProjectId: null,
  providerDeploymentId: null,
  brief: null,
  error: null,
  sessionId: null,
  model: null,
  stepCount: null,
  lastStepSummary: null,
  screenshotUrl: null,
  recordingUrls: [],
  maxCostUsd: null,
  totalInputTokens: null,
  totalOutputTokens: null,
  proxyUsedMb: null,
  llmCostUsd: null,
  proxyCostUsd: null,
  browserCostUsd: null,
  totalCostUsd: null,
  agentmailEmail: null,
  integrationsUsed: [],
  evidenceCount: null,
  outputSchema: null,
  progressLog: [],
  timeline: []
};

function builderStatusForEvent(type) {
  if (
    type === 'builder.start' ||
    type === 'builder.submission_created' ||
    type === 'builder.live_url' ||
    type === 'builder.provider_action' ||
    type === 'builder.hook' ||
    type === 'builder.qa' ||
    type === 'builder.revision' ||
    type === 'builder.progress' ||
    type === 'builder.project_url'
  ) return 'running';
  if (type === 'builder.done') return 'completed';
  if (type === 'builder.blocked_auth') return 'blocked_auth';
  if (type === 'builder.error') return 'failed';
  return null;
}

function builderLabelForEvent(type) {
  switch (type) {
    case 'builder.start': return 'Build requested';
    case 'builder.submission_created': return 'Target submission created';
    case 'builder.live_url': return 'Live preview ready';
    case 'builder.provider_action': return 'Provider action';
    case 'builder.hook': return 'Build hook';
    case 'builder.qa': return 'Build QA';
    case 'builder.revision': return 'Revision planned';
    case 'builder.progress': return 'Progress update';
    case 'builder.project_url': return 'Final site URL found';
    case 'builder.blocked_auth': return 'Lovable auth needed';
    case 'builder.done': return 'Build completed';
    case 'builder.error': return 'Build failed';
    default: return type;
  }
}

function builderEventItem(evt) {
  const ts = evt.ts || Date.now();
  const summary = evt.summary || evt.note || evt.error || evt.projectUrl || evt.liveUrl || '';
  return {
    id: `${evt.type}:${ts}:${evt.buildId || evt.runId || summary}`,
    ts,
    type: evt.type,
    label: builderLabelForEvent(evt.type),
    status: builderStatusForEvent(evt.type),
    summary,
    liveUrl: evt.liveUrl || null,
    projectUrl: evt.projectUrl || null,
    target: evt.target || null,
    submissionUrl: evt.submissionUrl || null,
    promptPreview: evt.promptPreview || null,
    providerAction: evt.providerAction || null,
    providerProjectId: evt.providerProjectId || null,
    providerDeploymentId: evt.providerDeploymentId || null,
    buildId: evt.buildId || null,
    runId: evt.runId || null,
    sessionId: evt.sessionId || null,
    model: evt.model || null,
    stepCount: evt.stepCount ?? null,
    lastStepSummary: evt.lastStepSummary || null,
    screenshotUrl: evt.screenshotUrl || null,
    recordingUrls: evt.recordingUrls || [],
    maxCostUsd: evt.maxCostUsd || null,
    totalInputTokens: evt.totalInputTokens ?? null,
    totalOutputTokens: evt.totalOutputTokens ?? null,
    proxyUsedMb: evt.proxyUsedMb || null,
    llmCostUsd: evt.llmCostUsd || null,
    proxyCostUsd: evt.proxyCostUsd || null,
    browserCostUsd: evt.browserCostUsd || null,
    totalCostUsd: evt.totalCostUsd || null,
    agentmailEmail: evt.agentmailEmail || null,
    integrationsUsed: evt.integrationsUsed || [],
    evidenceCount: evt.evidenceCount ?? null,
    outputSchema: evt.outputSchema || null,
    brief: evt.brief || null,
    lovableUrl: evt.lovableUrl || null,
    error: evt.error || null,
    mock: !!evt.mock
  };
}

function appendBuilderItem(list, item, limit = 24) {
  const existing = list || [];
  if (existing.some((row) => row.id === item.id)) return existing;
  return [...existing, item].slice(-limit);
}

function mergeBuilderEvent(prev, evt) {
  const item = builderEventItem(evt);
  const leadId = evt.leadId || prev.leadId;
  const base = evt.type === 'builder.start' || (leadId && prev.leadId !== leadId)
    ? { ...EMPTY_BUILDER_INFO, leadId }
    : { ...prev, leadId };
  const timeline = appendBuilderItem(base.timeline, item, 40);
  const shouldLog = ['builder.live_url', 'builder.hook', 'builder.qa', 'builder.revision', 'builder.progress', 'builder.project_url', 'builder.blocked_auth', 'builder.done', 'builder.error'].includes(evt.type);
  const progressLog = shouldLog ? appendBuilderItem(base.progressLog, item, 18) : base.progressLog;

  return {
    ...base,
    buildId: evt.buildId || base.buildId,
    runId: evt.runId || base.runId,
    status: builderStatusForEvent(evt.type) || base.status,
    liveUrl: evt.liveUrl || base.liveUrl,
    projectUrl: evt.projectUrl || base.projectUrl,
    finalSiteUrl: evt.projectUrl || base.finalSiteUrl,
    target: evt.target || base.target,
    submissionUrl: evt.submissionUrl || base.submissionUrl,
    providerProjectId: evt.providerProjectId || base.providerProjectId,
    providerDeploymentId: evt.providerDeploymentId || base.providerDeploymentId,
    brief: evt.brief || base.brief,
    error: evt.error || (evt.type === 'builder.start' ? null : base.error),
    sessionId: evt.sessionId || base.sessionId,
    model: evt.model || base.model,
    stepCount: evt.stepCount ?? base.stepCount,
    lastStepSummary: evt.lastStepSummary || base.lastStepSummary,
    screenshotUrl: evt.screenshotUrl || base.screenshotUrl,
    recordingUrls: evt.recordingUrls?.length ? evt.recordingUrls : base.recordingUrls,
    maxCostUsd: evt.maxCostUsd || base.maxCostUsd,
    totalInputTokens: evt.totalInputTokens ?? base.totalInputTokens,
    totalOutputTokens: evt.totalOutputTokens ?? base.totalOutputTokens,
    proxyUsedMb: evt.proxyUsedMb || base.proxyUsedMb,
    llmCostUsd: evt.llmCostUsd || base.llmCostUsd,
    proxyCostUsd: evt.proxyCostUsd || base.proxyCostUsd,
    browserCostUsd: evt.browserCostUsd || base.browserCostUsd,
    totalCostUsd: evt.totalCostUsd || base.totalCostUsd,
    agentmailEmail: evt.agentmailEmail || base.agentmailEmail,
    integrationsUsed: evt.integrationsUsed?.length ? evt.integrationsUsed : base.integrationsUsed,
    evidenceCount: evt.evidenceCount ?? base.evidenceCount,
    outputSchema: evt.outputSchema || base.outputSchema,
    progressLog,
    timeline
  };
}

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
  const [builderInfo, setBuilderInfo] = useState(EMPTY_BUILDER_INFO);
  const [builderAction, setBuilderAction] = useState({ leadId: null, running: false, error: null });

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
      // Auto-focus the first lead surfaced by browser research so the
      // Memory tab fills up with the discovered businesses immediately.
      if (evt.worker === 'browser_research' && evt.leadId && !focusedRef.current) {
        setFocusedLeadId(evt.leadId);
        setActiveTab('Memory');
      }
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
    if (t.startsWith('growth.')) {
      bumpActivity('analyst');
      triggerEdge('analyst-memory');
      refreshLeadDetail(evt.leadId || focusedRef.current);
      refreshHealth();
      if (evt.leadId === focusedRef.current && (t === 'growth.plan_generated' || t === 'growth.followup_sent')) setActiveTab('Growth');
    }
    if (t === 'mailer.payment_link' || t === 'mailer.invoice_link' || t === 'mailer.invoice_blocked' || t === 'mailer.email_sent' || t === 'mailer.inbound_message' || t === 'mailer.done') {
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
    if (t === 'builder.start') {
      setBuilderInfo((prev) => mergeBuilderEvent(prev, evt));
      if (evt.leadId === focusedRef.current) setActiveTab('Builder');
      refreshLeadDetail(evt.leadId || focusedRef.current);
    }
    if (t === 'builder.live_url') {
      setBuilderInfo((prev) => mergeBuilderEvent(prev, evt));
      triggerEdge('builder-memory');
      if (evt.leadId === focusedRef.current) setActiveTab('Builder');
    }
    if (t === 'builder.submission_created' || t === 'builder.provider_action' || t === 'builder.hook' || t === 'builder.qa' || t === 'builder.revision' || t === 'builder.progress') {
      setBuilderInfo((prev) => mergeBuilderEvent(prev, evt));
      triggerEdge('builder-memory');
      if (evt.leadId === focusedRef.current) refreshLeadDetail(evt.leadId);
    }
    if (t === 'builder.project_url') {
      setBuilderInfo((prev) => mergeBuilderEvent(prev, evt));
      triggerEdge('builder-memory');
    }
    if (t === 'builder.blocked_auth' || t === 'builder.done' || t === 'builder.error') {
      setBuilderInfo((prev) => mergeBuilderEvent(prev, evt));
      if (t === 'builder.blocked_auth') setNodeStates((p) => ({ ...p, builder: 'blocked_auth' }));
      refreshLeadDetail(evt.leadId || focusedRef.current);
    }
    if (t === 'browserUse.session.stopped') {
      setBuilderInfo((prev) => mergeBuilderEvent(prev, evt));
      setNodeStates((p) => ({ ...p, builder: 'idle' }));
      refreshLeadDetail(evt.leadId || focusedRef.current);
      refreshHealth();
    }
    if (t === 'stripe.webhook' || t === 'stripe.paid') {
      bumpActivity('mailer');
      triggerEdge('mailer-memory');
      refreshLeadDetail(evt.leadId || focusedRef.current);
      refreshHealth();
    }
    if (t === 'agentmail.webhook') {
      bumpActivity('mailer');
      triggerEdge('mailer-memory');
      refreshLeadDetail(evt.leadId || focusedRef.current);
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

  const queueCounts = useMemo(() => {
    const fallback = leads.reduce((acc, lead) => {
      const outreachStatus = lead.outreach_status || 'not_queued';
      const status = lead.status || 'discovered';
      if (outreachStatus === 'queued' || outreachStatus === 'retry') acc.queued += 1;
      if (outreachStatus === 'calling') acc.calling += 1;
      if (outreachStatus === 'blocked') acc.blocked += 1;
      if (status === 'awaiting_payment') acc.awaitingPayment += 1;
      if (status === 'paid') acc.paid += 1;
      if (status === 'shipped') acc.shipped += 1;
      return acc;
    }, { queued: 0, calling: 0, blocked: 0, awaitingPayment: 0, paid: 0, shipped: 0, repliesWaiting: 0 });
    const q = outreach?.readiness?.outreach || health?.readiness?.outreach || health?.quotas || {};
    return {
      queued: q.queued ?? fallback.queued,
      calling: q.calling ?? fallback.calling,
      blocked: q.blocked ?? fallback.blocked,
      awaitingPayment: q.awaitingPayment ?? fallback.awaitingPayment,
      paid: q.paid ?? fallback.paid,
      shipped: q.shipped ?? fallback.shipped,
      repliesWaiting: q.repliesWaiting ?? fallback.repliesWaiting
    };
  }, [health, leads, outreach]);

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

  const pauseAutonomy = useCallback(async () => {
    const data = await api.pauseOutreach('operator_pause');
    setOutreach(data);
    refreshHealth();
  }, [refreshHealth]);

  const emergencyStop = useCallback(async () => {
    const data = await api.emergencyStop('operator_emergency_stop');
    setOutreach(data);
    refreshHealth();
  }, [refreshHealth]);

  const handleLeadChanged = useCallback((id) => {
    refreshLeads();
    refreshHealth();
    refreshLeadDetail(id || focusedRef.current);
  }, [refreshHealth, refreshLeadDetail, refreshLeads]);

  const retryBuild = useCallback(async ({ target } = {}) => {
    if (!focusedLeadId) return;
    setBuilderAction({ leadId: focusedLeadId, running: true, error: null });
    setBuilderInfo((prev) => mergeBuilderEvent(prev, { type: 'builder.start', leadId: focusedLeadId, target, ts: Date.now() }));
    setActiveTab('Builder');
    try {
      await api.build(focusedLeadId, { target });
      handleLeadChanged(focusedLeadId);
      setBuilderAction({ leadId: focusedLeadId, running: false, error: null });
    } catch (e) {
      setBuilderAction({ leadId: focusedLeadId, running: false, error: e.message });
    }
  }, [focusedLeadId, handleLeadChanged]);

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

      <SponsorStrip health={health} />

      <AutonomyStrip
        health={health}
        outreach={outreach}
        onStart={startAutonomy}
        onStop={stopAutonomy}
        onPause={pauseAutonomy}
        onEmergencyStop={emergencyStop}
      />

      <ProductionReadinessPanel
        health={health}
        onPause={pauseAutonomy}
        onEmergencyStop={emergencyStop}
      />

      <main className="layout">
        <section className="left-pane">
          <div className="panel panel-browser-workbench">
            <BrowserResearchConsole />
            <BrowserUseConsole onLeadChanged={handleLeadChanged} />
          </div>
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
                  {typeof e.mock === 'boolean' ? <span className={`event-mode event-mode-${e.mock ? 'mock' : 'live'}`}>{e.mock ? 'mock' : 'live'}</span> : null}
                  {e.providerType ? <span className="event-extra">· {e.providerType}</span> : null}
                  {e.businessName ? <span className="event-extra">· {e.businessName}</span> : null}
                  {e.reason ? <span className="event-extra">· {e.reasonText || e.reason}</span> : null}
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
              queueCounts={queueCounts}
              focusedLeadId={focusedLeadId}
              onFocus={handleLeadFocus}
              onChanged={handleLeadChanged}
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
              builderAction={builderAction}
              health={health}
              onRetryBuild={retryBuild}
              outreach={outreach}
              onStartAutonomy={startAutonomy}
              onStopAutonomy={stopAutonomy}
              onLeadChanged={handleLeadChanged}
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

function SponsorStrip({ health }) {
  const readiness = health?.readiness || {};
  const providerReadiness = health?.providerReadiness || readiness.providers || {};
  const blockers = health?.liveBlockers || readiness.blockers || [];
  const mode = readiness.mode || health?.mode || 'init';
  const ready = !!health && blockers.length === 0 && readiness.ready !== false;

  return (
    <section className="sponsor-strip">
      <div className="sponsor-summary">
        <span className="hd">sponsor proof</span>
        <span className={`sponsor-mode sponsor-mode-${mode}`}>{mode}</span>
        <span className={`sponsor-ready ${!health ? 'sponsor-ready-loading' : ready ? 'sponsor-ready-ok' : 'sponsor-ready-blocked'}`}>
          {!health ? 'checking' : ready ? 'ready' : `${blockers.length} blocker${blockers.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="sponsor-grid">
        {PROVIDER_BADGES.map((provider) => {
          const proof = sponsorProofFor(provider, health, providerReadiness[provider.key]);
          return (
            <div key={provider.key} className={`sponsor-card sponsor-card-${proof.tone}`} title={proof.title}>
              <span className="sponsor-code mono">{provider.label}</span>
              <span className="sponsor-name">{provider.name}</span>
              <span className="sponsor-cap mono">{provider.capability}</span>
              <span className={`sponsor-status sponsor-status-${proof.tone}`}>{proof.label}</span>
            </div>
          );
        })}
      </div>
      {blockers.length ? (
        <div className="sponsor-blockers">
          {blockers.slice(0, 4).map((blocker) => (
            <span key={blocker} className="sponsor-blocker mono">{blocker}</span>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function sponsorProofFor(provider, health, readiness) {
  if (!health) {
    return {
      tone: 'dry',
      label: 'checking',
      title: `${provider.name} status is loading`
    };
  }
  const configured = readiness?.configured ?? health?.providers?.[provider.key] ?? false;
  const smoke = readiness?.smoke;
  const mode = health?.mode || health?.readiness?.mode || 'mock';
  const liveEnabled = provider.liveKey ? !!health?.live?.[provider.liveKey] : mode !== 'mock';
  const smokeText = smoke?.status ? `smoke ${smoke.status}` : null;

  if (!configured) {
    return {
      tone: readiness?.required ? 'missing' : 'dry',
      label: readiness?.required ? 'missing' : 'optional',
      title: readiness?.lastError || `${provider.name} is not configured`
    };
  }
  if (mode === 'mock') {
    return {
      tone: 'mock',
      label: smokeText || 'mock safe',
      title: `${provider.name} configured; app is running in mock mode`
    };
  }
  if (liveEnabled || smoke?.live) {
    return {
      tone: 'live',
      label: smokeText || 'live enabled',
      title: `${provider.name} is configured for live sponsor operation`
    };
  }
  return {
    tone: 'dry',
    label: smokeText || 'configured',
    title: `${provider.name} configured without live side effects`
  };
}

function ProductionReadinessPanel({ health, onPause, onEmergencyStop }) {
  const readiness = health?.readiness || {};
  const providers = readiness.providers || {};
  const webhooks = readiness.webhooks || {};
  const sideEffects = readiness.sideEffects || {};
  const compliance = readiness.compliance || {};
  const productionBlockers = readiness.productionBlockers || health?.productionBlockers || [];
  const currentBlockers = readiness.blockers || health?.liveBlockers || [];
  const providerRows = Object.entries(providers);
  const configuredProviders = providerRows.filter(([, row]) => row.configured).length;
  const requiredProviders = providerRows.filter(([, row]) => row.required).length;
  const webhookRows = Object.entries(webhooks);
  const configuredWebhooks = webhookRows.filter(([, row]) => row.configured).length;
  const complianceOk = (compliance.gates || []).every((gate) => gate.ok);
  const smokeOk = providerRows.filter(([, row]) => row.smokeStatus === 'ok').length;
  const sideEffectRows = Object.entries(sideEffects);
  const mode = readiness.mode || health?.mode || 'init';
  const checklist = [
    ['modes', (readiness.validModes || []).includes('production_live'), mode],
    ['providers', requiredProviders === 0 ? configuredProviders > 0 : configuredProviders >= requiredProviders, `${configuredProviders}/${requiredProviders || providerRows.length}`],
    ['webhooks', webhookRows.length > 0 && configuredWebhooks === webhookRows.length, `${configuredWebhooks}/${webhookRows.length}`],
    ['smoke', smokeOk > 0 && productionBlockers.every((b) => !/smoke has not passed/.test(b)), `${smokeOk}/${providerRows.length}`],
    ['compliance', complianceOk, `${(compliance.gates || []).filter((g) => g.ok).length}/${(compliance.gates || []).length}`],
    ['side effects', currentBlockers.length === 0, `${sideEffectRows.filter(([, row]) => row.allowed).length}/${sideEffectRows.length}`]
  ];

  return (
    <section className="production-panel">
      <div className="production-checklist">
        <div className="production-head">
          <span className="hd">production readiness</span>
          <span className={`production-live-state ${readiness.canGoLive ? 'production-live-ok' : 'production-live-blocked'}`}>
            {readiness.canGoLive ? 'production live ready' : 'cannot go live'}
          </span>
        </div>
        <div className="check-grid">
          {checklist.map(([name, ok, detail]) => (
            <div key={name} className={`check-item ${ok ? 'check-ok' : 'check-blocked'}`}>
              <span className="check-mark">{ok ? 'OK' : 'NO'}</span>
              <span className="check-name">{name}</span>
              <span className="check-detail mono">{detail}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="cannot-panel">
        <div className="cannot-head">
          <span className="hd">cannot go live because</span>
          <span className="cannot-count mono">{productionBlockers.length}</span>
        </div>
        <div className="cannot-list">
          {(productionBlockers.length ? productionBlockers : ['no production blockers']).slice(0, 7).map((blocker) => (
            <span key={blocker} className={`cannot-item mono ${productionBlockers.length ? '' : 'cannot-clear'}`}>{blocker}</span>
          ))}
        </div>
      </div>
      <div className="emergency-controls">
        <span className="hd">emergency</span>
        <button className="btn btn-mini" onClick={onPause}>pause</button>
        <button className="btn btn-mini btn-danger" onClick={onEmergencyStop}>stop</button>
      </div>
    </section>
  );
}

function AutonomyStrip({ health, outreach, onStart, onStop, onPause, onEmergencyStop }) {
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
        <span className="auto-stat mono">calling {q.calling ?? 0}</span>
        <span className="auto-stat mono">blocked {q.blocked ?? 0}</span>
        <span className="auto-stat mono">awaiting pay {q.awaitingPayment ?? 0}</span>
        <span className="auto-stat mono">paid {q.paid ?? 0}</span>
        <span className="auto-stat mono">shipped {q.shipped ?? 0}</span>
        <span className="auto-stat mono">calls today {q.todaysCalls ?? 0}</span>
        <span className="auto-stat mono">opt-outs {q.optOuts ?? 0}</span>
        <span className="auto-stat mono">mail replies {q.repliesWaiting ?? 0}</span>
      </div>
      <div className="auto-side">
        {active ? <span className="auto-active mono">active: {active.businessName}</span> : null}
        {blockers.length ? (
          <span className="auto-blockers" title={blockers.join('\n')}>
            {blockers.slice(0, 3).map((blocker) => (
              <span key={blocker} className="auto-blocker mono">{blocker}</span>
            ))}
          </span>
        ) : <span className="auto-ready mono">ready</span>}
        <button className="btn btn-mini" onClick={outreach?.running ? onPause : onStart}>
          {outreach?.running ? 'pause' : 'start'}
        </button>
        <button className="btn btn-mini btn-danger" onClick={onEmergencyStop}>stop</button>
      </div>
    </section>
  );
}
