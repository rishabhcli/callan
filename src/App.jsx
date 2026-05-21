import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import RightRail from './components/RightRail.jsx';
import LiveInboundPanel from './components/LiveInboundPanel.jsx';
import OperationsView from './views/OperationsView.jsx';
import ScraperView from './views/ScraperView.jsx';
import MemoryView from './views/MemoryView.jsx';
import AgentsView from './views/AgentsView.jsx';
import SettingsView from './views/SettingsView.jsx';
import ShareView from './views/ShareView.jsx';
import { useSSE } from './useSSE.js';
import { api } from './api.js';

const RESEARCH_LANE_LABELS = {
  'reverse-phone': 'Reverse phone lookup',
  'web-search': 'Public web mentions',
  'directories': 'Local directory listings',
  'social': 'Social media presence',
  'maps': 'Maps + reviews'
};

const EMPTY_INBOUND = {
  active: false,
  channel: null,
  sessionId: null,
  callId: null,
  leadId: null,
  fromNumber: null,
  callerName: null,
  email: null,
  threadId: null,
  subject: null,
  startedAt: null,
  transcript: [],
  lanes: [],
  evidence: [],
  facts: null,
  missingFields: [],
  requiredMissingFields: [],
  nextQuestion: null,
  nextAction: null,
  portalUrl: null,
  invoiceUrl: null,
  readyForQuote: false,
  context: null,
  demoMode: false,
  demoTarget: null
};

function reduceInbound(state, evt) {
  const t = evt.type;
  if (t === 'caller.placed' && evt.direction === 'inbound') {
    return {
      ...EMPTY_INBOUND,
      active: true,
      channel: 'voice',
      sessionId: evt.callId,
      callId: evt.callId,
      leadId: evt.leadId,
      fromNumber: evt.fromNumber,
      startedAt: evt.ts || Date.now()
    };
  }
  if (t === 'inbound.intake.updated') {
    const sameCall = evt.callId && state.callId === evt.callId;
    const sameThread = evt.threadId && state.threadId === evt.threadId;
    const sameSession = evt.sessionId && state.sessionId === evt.sessionId;
    const base = sameCall || sameThread || sameSession ? state : {
      ...EMPTY_INBOUND,
      active: evt.channel === 'voice' && evt.stage !== 'terminal',
      startedAt: evt.ts || Date.now(),
      transcript: []
    };
    const transcript = appendInboundPreview(base.transcript, evt);
    return {
      ...base,
      active: evt.channel === 'voice' ? evt.stage !== 'terminal' : false,
      channel: evt.channel,
      sessionId: evt.sessionId || base.sessionId,
      callId: evt.callId || base.callId,
      leadId: evt.leadId || base.leadId,
      threadId: evt.threadId || base.threadId,
      subject: evt.subject || base.subject,
      email: evt.facts?.email || base.email,
      fromNumber: evt.facts?.phone || base.fromNumber,
      callerName: evt.facts?.businessName || base.callerName,
      facts: evt.facts || base.facts,
      missingFields: evt.missingFields || [],
      requiredMissingFields: evt.requiredMissingFields || [],
      nextQuestion: evt.nextQuestion || null,
      nextAction: evt.nextAction || null,
      portalUrl: evt.portalUrl || base.portalUrl,
      invoiceUrl: evt.invoiceUrl || base.invoiceUrl,
      readyForQuote: !!evt.readyForQuote,
      transcript
    };
  }
  if (!state.callId || evt.callId !== state.callId) return state;
  if (t === 'caller.context_loaded') {
    return { ...state, context: { returning: !!evt.returning, context: evt.context || null } };
  }
  if (t === 'caller.transcript') {
    return {
      ...state,
      transcript: [...state.transcript, { role: evt.role, text: evt.text, ts: evt.ts || Date.now() }].slice(-200)
    };
  }
  if (t === 'mailer.email_sent' && (evt.trigger === 'inbound_voice' || evt.trigger === 'demo_mode')) {
    return { ...state, email: evt.toEmail };
  }
  if (t === 'caller.demo_mode.entered') {
    return { ...state, demoMode: true, demoTarget: evt.target || null };
  }
  if (t === 'research.session.started') {
    const existing = state.lanes.find((l) => l.lane === evt.lane);
    const lane = { lane: evt.lane, label: RESEARCH_LANE_LABELS[evt.lane] || evt.label || evt.lane, status: 'running' };
    return {
      ...state,
      lanes: existing
        ? state.lanes.map((l) => (l.lane === evt.lane ? { ...l, status: 'running' } : l))
        : [...state.lanes, lane]
    };
  }
  if (t === 'research.evidence.captured') {
    return {
      ...state,
      evidence: [...state.evidence, {
        lane: evt.lane,
        summary: evt.summary,
        confidence: evt.confidence,
        capturedAt: evt.capturedAt || Date.now()
      }].slice(-40)
    };
  }
  if (t === 'research.session.completed') {
    return {
      ...state,
      lanes: state.lanes.map((l) => (l.lane === evt.lane ? { ...l, status: 'done' } : l))
    };
  }
  if (t === 'caller.done') {
    return { ...state, active: false };
  }
  return state;
}

function appendInboundPreview(transcript = [], evt = {}) {
  const text = String(evt.preview || '').trim();
  if (!text) return transcript;
  const id = evt.messageId || evt.contactEventId || `${evt.sessionId || evt.threadId || evt.callId}:${evt.ts || ''}`;
  const alreadyPresent = transcript.some((turn) => (
    (id && turn.id === id) ||
    (turn.text === text && (evt.ts ? Math.abs((turn.ts || 0) - evt.ts) < 1000 : true))
  ));
  if (alreadyPresent) return transcript;
  return [
    ...transcript,
    {
      id,
      role: evt.channel === 'email' ? 'user' : 'caller',
      text,
      ts: evt.ts || Date.now()
    }
  ].slice(-MAX_TRANSCRIPT);
}

const TABS = [
  { id: 'operations', label: 'Operations', sub: 'agent floor' },
  { id: 'agents',     label: 'Agents',     sub: 'workers' },
  { id: 'scraper',    label: 'Scraper',    sub: 'browser fleet' },
  { id: 'memory',     label: 'Memory',     sub: 'supermemory' },
  { id: 'settings',   label: 'Settings',   sub: 'config' }
];

const WORKER_FROM_TYPE = (t) => t.split('.')[0];
const SUCCESS_TYPES = new Set(['scraper.done', 'caller.done', 'analyst.done', 'mailer.done', 'builder.done']);
const ERROR_TYPES   = new Set(['scraper.error', 'caller.error', 'analyst.error', 'mailer.error', 'builder.error']);

const EDGE_FOR = {
  scraper: 'memory-scraper',
  caller:  'memory-caller',
  analyst: 'memory-analyst',
  mailer:  'memory-mailer',
  builder: 'memory-builder'
};

const MAX_TRANSCRIPT = 200;
const COUNTER_WINDOW_MS = 60000;

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
  if ([
    'builder.start', 'builder.submission_created', 'builder.live_url',
    'builder.provider_action', 'builder.hook', 'builder.qa',
    'builder.revision', 'builder.progress', 'builder.project_url'
  ].includes(type)) return 'running';
  if (type === 'builder.done') return 'completed';
  if (type === 'builder.blocked_auth') return 'blocked_auth';
  if (type === 'builder.error') return 'failed';
  return null;
}

function mergeBuilderEvent(prev, evt) {
  const leadId = evt.leadId || prev.leadId;
  const base = evt.type === 'builder.start' || (leadId && prev.leadId !== leadId)
    ? { ...EMPTY_BUILDER_INFO, leadId }
    : { ...prev, leadId };
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
    outputSchema: evt.outputSchema || base.outputSchema
  };
}

function getShareToken() {
  if (typeof window === 'undefined') return null;
  const path = window.location.pathname || '';
  const match = path.match(/^\/share\/build\/([^/?#]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

export default function App() {
  const shareToken = useMemo(getShareToken, []);
  if (shareToken) return <ShareView token={shareToken} />;
  return <Console />;
}

function Console() {
  const [health, setHealth] = useState(null);
  const [leads, setLeads] = useState([]);
  const [focusedLeadId, setFocusedLeadId] = useState(null);
  const [leadDetail, setLeadDetail] = useState(null);
  const [activeTab, setActiveTab] = useState('operations');
  const [focusedNodeId, setFocusedNodeId] = useState(null);
  const [outreach, setOutreach] = useState(null);
  const [handoffCases, setHandoffCases] = useState([]);

  const [nodeStates, setNodeStates] = useState({
    scraper: 'idle', memory: 'idle', caller: 'idle',
    analyst: 'idle', mailer: 'idle', builder: 'idle'
  });
  const [activity, setActivity] = useState({
    scraper: [], memory: [], caller: [], analyst: [], mailer: [], builder: []
  });

  const [liveTranscript, setLiveTranscript] = useState([]);
  const [liveCallId, setLiveCallId] = useState(null);
  const [liveLeadId, setLiveLeadId] = useState(null);
  const [liveCallActive, setLiveCallActive] = useState(false);
  const [inbound, setInbound] = useState(EMPTY_INBOUND);
  const [scheduledCalls, setScheduledCalls] = useState({ pending: [], recent: [] });
  const [builderInfo, setBuilderInfo] = useState(EMPTY_BUILDER_INFO);
  const [builderAction, setBuilderAction] = useState({ leadId: null, running: false, error: null });

  const focusedRef = useRef(focusedLeadId);
  focusedRef.current = focusedLeadId;

  const bumpActivity = useCallback((worker) => {
    if (!worker) return;
    const now = Date.now();
    setActivity((prev) => {
      const list = (prev[worker] || []).filter((t) => now - t < COUNTER_WINDOW_MS);
      list.push(now);
      return { ...prev, [worker]: list };
    });
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

  const refreshScheduledCalls = useCallback(async () => {
    try {
      const data = await api.scheduledCalls();
      setScheduledCalls({
        pending: data?.pending || [],
        recent: data?.recent || []
      });
    } catch {
      // ignore — non-fatal
    }
  }, []);

  const refreshHandoffCases = useCallback(async () => {
    try {
      const data = await api.listHandoffCases({ status: 'open', limit: 80 });
      setHandoffCases(data?.cases || []);
    } catch {
      // ignore — non-fatal
    }
  }, []);

  const cancelScheduledCall = useCallback(async (id) => {
    try {
      await api.cancelScheduledCall(id);
      refreshScheduledCalls();
    } catch (e) {
      // ignore — non-fatal
    }
  }, [refreshScheduledCalls]);

  const fireScheduledCallNow = useCallback(async (id) => {
    try {
      await api.fireScheduledCallNow(id);
      refreshScheduledCalls();
    } catch (e) {
      // ignore — non-fatal
    }
  }, [refreshScheduledCalls]);

  useEffect(() => {
    refreshHealth();
    refreshLeads();
    refreshScheduledCalls();
    refreshHandoffCases();
    const leadsId = setInterval(refreshLeads, 5000);
    const healthId = setInterval(refreshHealth, 8000);
    const schedId = setInterval(refreshScheduledCalls, 6000);
    const handoffId = setInterval(refreshHandoffCases, 6000);
    return () => {
      clearInterval(leadsId);
      clearInterval(healthId);
      clearInterval(schedId);
      clearInterval(handoffId);
    };
  }, [refreshHealth, refreshLeads, refreshScheduledCalls, refreshHandoffCases]);

  useEffect(() => { refreshLeadDetail(focusedLeadId); }, [focusedLeadId, refreshLeadDetail]);

  const onEvent = useCallback((evt) => {
    const t = evt.type;
    if (t === 'hello') return;

    // Inbound live panel state — listen to a tight set of types
    if (
      t === 'caller.placed' || t === 'caller.context_loaded' || t === 'caller.transcript' || t === 'caller.state' ||
      t === 'caller.done' || t === 'mailer.email_sent' ||
      t === 'caller.demo_mode.entered' ||
      t === 'inbound.intake.updated' ||
      t === 'research.session.started' || t === 'research.evidence.captured' ||
      t === 'research.session.completed'
    ) {
      setInbound((prev) => reduceInbound(prev, evt));
    }

    // Scheduled callback lifecycle → keep the right-rail upcoming list fresh.
    if (
      t === 'scheduledCall.created' || t === 'scheduledCall.replaced' ||
      t === 'scheduledCall.canceled' || t === 'scheduledCall.fired' ||
      t === 'scheduledCall.placed' || t === 'scheduledCall.failed' ||
      t === 'scheduledCall.brought_forward'
    ) {
      refreshScheduledCalls();
    }
    // Pre-fire heads-up — flash the matching upcoming card.
    if (t === 'scheduledCall.warming') {
      setScheduledCalls((prev) => ({
        ...prev,
        warmingIds: [...new Set([...(prev.warmingIds || []), evt.id])]
      }));
    }

    const worker = evt.worker || WORKER_FROM_TYPE(t);
    bumpActivity(worker);
    if (['scraper.start', 'caller.start', 'analyst.start', 'mailer.start', 'builder.start'].includes(t)) {
      setNodeStates((p) => ({ ...p, [worker]: 'running' }));
      setNodeStates((p) => ({ ...p, memory: 'running' }));
      bumpActivity('memory');
      setTimeout(() => setNodeStates((p) => (p.memory === 'running' ? { ...p, memory: 'idle' } : p)), 1200);
    }
    if (SUCCESS_TYPES.has(t)) {
      setNodeStates((p) => ({ ...p, [worker]: 'success' }));
      setTimeout(() => setNodeStates((p) => (p[worker] === 'success' ? { ...p, [worker]: 'idle' } : p)), 2400);
    }
    if (ERROR_TYPES.has(t)) {
      setNodeStates((p) => ({ ...p, [worker]: 'error' }));
    }

    if (t === 'lead.created') {
      bumpActivity('memory');
      refreshLeads();
      refreshHealth();
      if (evt.worker === 'browser_research' && evt.leadId && !focusedRef.current) {
        setFocusedLeadId(evt.leadId);
      }
    }
    if (t === 'scraper.profile' || t === 'pitch.created') {
      bumpActivity('memory');
    }
    if (t === 'caller.placed') {
      setLiveCallId(evt.callId);
      setLiveLeadId(evt.leadId);
      setLiveCallActive(true);
      setLiveTranscript([]);
    }
    if (t === 'caller.transcript') {
      const turn = { role: evt.role, text: evt.text, ts: evt.ts || Date.now() };
      if (evt.leadId === focusedRef.current || liveLeadId === evt.leadId) {
        setLiveTranscript((prev) => [...prev, turn].slice(-MAX_TRANSCRIPT));
      }
    }
    if (t === 'caller.state') {
      refreshLeadDetail(evt.leadId || focusedRef.current);
    }
    if (t === 'caller.done' || t === 'caller.error') {
      setLiveCallActive(false);
      refreshLeadDetail(evt.leadId || focusedRef.current);
    }
    if (t === 'analyst.done') {
      refreshLeadDetail(evt.leadId || focusedRef.current);
    }
    if (t.startsWith('growth.')) {
      bumpActivity('analyst');
      refreshLeadDetail(evt.leadId || focusedRef.current);
      refreshHealth();
    }
    if (t.startsWith('mailer.')) {
      refreshLeadDetail(evt.leadId || focusedRef.current);
    }
    if (t.startsWith('handoff.')) {
      refreshHandoffCases();
      refreshLeads();
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
      refreshLeadDetail(evt.leadId || focusedRef.current);
    }
    if (t.startsWith('builder.')) {
      setBuilderInfo((prev) => mergeBuilderEvent(prev, evt));
      if (t === 'builder.blocked_auth') setNodeStates((p) => ({ ...p, builder: 'blocked_auth' }));
    }
    if (t === 'browserUse.session.stopped') {
      setBuilderInfo((prev) => mergeBuilderEvent(prev, evt));
      setNodeStates((p) => ({ ...p, builder: 'idle' }));
      refreshLeadDetail(evt.leadId || focusedRef.current);
      refreshHealth();
    }
    if (t === 'stripe.webhook' || t === 'stripe.paid') {
      bumpActivity('mailer');
      refreshLeadDetail(evt.leadId || focusedRef.current);
      refreshHealth();
    }
    if (t === 'agentmail.webhook') {
      bumpActivity('mailer');
      refreshLeadDetail(evt.leadId || focusedRef.current);
      refreshHealth();
    }
  }, [bumpActivity, refreshLeads, refreshLeadDetail, refreshHealth, refreshScheduledCalls, refreshHandoffCases, liveLeadId]);

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
  }, []);

  const handleLeadFocus = useCallback((id) => {
    setFocusedLeadId(id);
  }, []);

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
    refreshHandoffCases();
    refreshLeadDetail(id || focusedRef.current);
  }, [refreshHealth, refreshHandoffCases, refreshLeadDetail, refreshLeads]);

  const retryBuild = useCallback(async ({ target } = {}) => {
    if (!focusedLeadId) return;
    setBuilderAction({ leadId: focusedLeadId, running: true, error: null });
    setBuilderInfo((prev) => mergeBuilderEvent(prev, { type: 'builder.start', leadId: focusedLeadId, target, ts: Date.now() }));
    try {
      await api.build(focusedLeadId, { target });
      handleLeadChanged(focusedLeadId);
      setBuilderAction({ leadId: focusedLeadId, running: false, error: null });
    } catch (e) {
      setBuilderAction({ leadId: focusedLeadId, running: false, error: e.message });
    }
  }, [focusedLeadId, handleLeadChanged]);

  const mode = (health?.mode || '').toUpperCase() || 'INIT';
  const running = !!outreach?.running;

  return (
    <div className="nyna-shell">
      <Topbar
        activeTab={activeTab}
        onTabChange={(id) => { setActiveTab(id); setFocusedNodeId(null); }}
        queueCounts={queueCounts}
      />

      <main className="nyna-main">
        <SideNav
          activeTab={activeTab}
          counters={counters}
          queueCounts={queueCounts}
          mode={mode}
          health={health}
          outreach={outreach}
          running={running}
          onStartAutonomy={running ? pauseAutonomy : startAutonomy}
          onEmergencyStop={emergencyStop}
        />

        <div className="nyna-stage-wrap">
          {activeTab === 'operations' ? (
            <OperationsView
              nodeStates={nodeStates}
              counters={counters}
              selectedNodeId={focusedNodeId}
              onSelectNode={handleNodeSelect}
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
              handoffCases={handoffCases}
              onFocusLead={handleLeadFocus}
              inbound={inbound}
              onDismissInbound={() => setInbound(EMPTY_INBOUND)}
            />
          ) : activeTab === 'agents' ? (
            <AgentsView
              nodeStates={nodeStates}
              counters={counters}
              leads={leads}
              outreach={outreach}
              onFocusLead={handleLeadFocus}
            />
          ) : activeTab === 'scraper' ? (
            <ScraperView
              focusedLeadId={focusedLeadId}
              leadDetail={leadDetail}
              onLeadChanged={handleLeadChanged}
            />
          ) : activeTab === 'memory' ? (
            <MemoryView focusedLeadId={focusedLeadId} />
          ) : activeTab === 'settings' ? (
            <SettingsView
              health={health}
              outreach={outreach}
              onStartAutonomy={startAutonomy}
              onStopAutonomy={stopAutonomy}
              onEmergencyStop={emergencyStop}
            />
          ) : null}
        </div>

        <RightRail
          leads={leads}
          focusedLeadId={focusedLeadId}
          onFocus={handleLeadFocus}
          queueCounts={queueCounts}
          sseStatus={sseStatus}
          scheduledCalls={scheduledCalls}
          handoffCases={handoffCases}
          onCancelScheduled={cancelScheduledCall}
          onFireScheduled={fireScheduledCallNow}
        />
      </main>
    </div>
  );
}

function Sparkle({ size = 16, color = '#640D14' }) {
  // The 4-point star from the NYNÄ palette — used as the brand sigil.
  return (
    <svg
      width={size} height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{ position: 'relative', zIndex: 2 }}
    >
      <path
        d="M12 0 L13.6 10.4 L24 12 L13.6 13.6 L12 24 L10.4 13.6 L0 12 L10.4 10.4 Z"
        fill={color}
      />
    </svg>
  );
}

function Topbar({ activeTab, onTabChange, queueCounts }) {
  return (
    <header className="nyna-topbar">
      <div className="nyna-brand">
        <div className="nyna-brand-mark">
          <Sparkle />
        </div>
        <div className="nyna-brand-text">
          <div className="nyna-brand-name">Callan</div>
          <div className="nyna-brand-tag">AI Cold-Calling</div>
        </div>
      </div>

      <nav className="nyna-tabs" role="tablist">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          const badge = badgeFor(tab.id, queueCounts);
          return (
            <button
              key={tab.id}
              className={`nyna-tab ${isActive ? 'nyna-tab-active' : ''}`}
              onClick={() => onTabChange(tab.id)}
              role="tab"
              aria-selected={isActive}
            >
              <span>{tab.label}</span>
              {badge ? <span className="nyna-tab-badge">{badge}</span> : null}
            </button>
          );
        })}
      </nav>
    </header>
  );
}

function badgeFor(tabId, queue = {}) {
  if (tabId === 'operations' && (queue.calling || 0) > 0) return queue.calling;
  if (tabId === 'scraper' && (queue.queued || 0) > 0) return queue.queued;
  return null;
}

function SideNav({ activeTab, counters, queueCounts, mode, health, outreach, running, onStartAutonomy, onEmergencyStop }) {
  const agents = outreach?.agents;
  const agentText = agents ? `${agents.active || 0}/${agents.concurrency || 1}` : '—';
  const providersText = countProviders(health);
  return (
    <aside className="nyna-side">
      <div className="nyna-side-section">
        <div className="nyna-side-title">{activeTab}</div>
        {sectionItemsForTab(activeTab, counters, queueCounts).map((item) => (
          <button key={item.label} className={`nyna-side-item ${item.active ? 'nyna-side-item-active' : ''}`}>
            <span className="nyna-side-item-left">
              <span className={`nyna-side-spark${item.tone ? ` nyna-side-spark-${item.tone}` : ''}`} />
              <span className="nyna-side-item-label">{item.label}</span>
            </span>
            <span className="nyna-side-item-count">{item.count ?? ''}</span>
          </button>
        ))}
      </div>

      <div className="nyna-side-status-panel" aria-label="status">
        <div className="nyna-side-status-head">
          <span>Status</span>
          <strong className={mode === 'MOCK' ? 'is-warm' : 'is-live'}>{mode || '—'}</strong>
        </div>
        <div className="nyna-side-status-grid">
          <div>
            <span>providers</span>
            <strong>{providersText}</strong>
          </div>
          <div>
            <span>callers</span>
            <strong>{agentText}</strong>
          </div>
        </div>
      </div>

      <div className="nyna-side-controls">
        <div className="nyna-side-controls-kicker">AI Cold-Calling</div>
        <div className="nyna-side-controls-row">
          <button className="nyna-side-action nyna-side-action-primary" onClick={onStartAutonomy}>
            {running ? 'pause' : 'start'}
          </button>
          <button className="nyna-side-action nyna-side-action-danger" onClick={onEmergencyStop}>
            stop
          </button>
        </div>
      </div>
    </aside>
  );
}

function countProviders(health) {
  if (!health?.providers) return '—';
  const total = Object.keys(health.providers).length;
  const on = Object.values(health.providers).filter(Boolean).length;
  return `${on}/${total}`;
}

function sectionItemsForTab(tab, counters = {}, queue = {}) {
  if (tab === 'operations') {
    return [
      { label: 'supermemory',  count: counters.memory || 0, tone: counters.memory ? 'live' : null, active: true },
      { label: 'agent phone',  count: counters.caller || 0, tone: counters.caller ? 'live' : null },
      { label: 'browser use',  count: (counters.scraper || 0) + (counters.analyst || 0), tone: (counters.scraper || counters.analyst) ? 'live' : null },
      { label: 'agent mail',   count: counters.mailer || 0 },
      { label: 'lovable',      count: counters.builder || 0, tone: counters.builder ? 'live' : null }
    ];
  }
  if (tab === 'agents') {
    return [
      { label: 'fleet rollup',  active: true },
      { label: 'live workloads' },
      { label: 'instances' }
    ];
  }
  if (tab === 'scraper') {
    return [
      { label: 'cloud windows', active: true },
      { label: 'extraction stream' },
      { label: 'evidence ledger' },
      { label: 'queued', count: queue.queued || 0, tone: queue.queued ? 'warn' : null }
    ];
  }
  if (tab === 'memory') {
    return [
      { label: 'knowledge graph', active: true },
      { label: 'businesses' },
      { label: 'ledger' },
      { label: 'failed writes' }
    ];
  }
  if (tab === 'settings') {
    return [
      { label: 'autonomy', active: true },
      { label: 'providers' },
      { label: 'share defaults' },
      { label: 'branding' }
    ];
  }
  return [];
}
