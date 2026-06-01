import { createHash, randomBytes } from 'node:crypto';
import {
  accountManagerPlans,
  accountTasks,
  builds,
  buildRevisions,
  contactEvents,
  growthPlans,
  leads,
  payments,
  portalActions,
  subscriptions
} from '../db.js';
import { env } from '../env.js';
import { emit } from '../sse.js';
import { addDoc, containerTagFor, listKinds } from '../memory.js';
import { log } from '../logger.js';
import { ACCOUNT_MANAGER_SECTION_KEYS, collectAccountTasks, emptyAccountManagerPlan } from './schema.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const RENEWAL_CLOSEOUT_PACKET_TYPE = 'renewal_customer_confirmation_closeout_packet';

const SECTION_FOR_KIND = Object.freeze({
  promised_edit: 'promisedEdits',
  stale_business_fact: 'staleFactsToRecheck',
  launch_followup: 'launchFollowup',
  review_capture: 'reviewCapture',
  google_business_profile_hygiene: 'googleBusinessProfileHygiene',
  seasonal_hours: 'seasonalHours',
  service_menu_changes: 'serviceMenuChanges',
  analytics_contact_flow_check: 'analyticsContactFlowCheck',
  hosting_subscription_status: 'hostingSubscriptionStatus',
  renewal_closeout_health_check: 'renewalCloseoutHealthChecks'
});

export async function generateAccountManagerPlanForLead({ leadId, force = false, source = 'account_manager', now = Date.now() } = {}) {
  const lead = leads.get(leadId);
  if (!lead) throw new Error(`lead not found: ${leadId}`);
  const context = await collectAccountManagerContext(lead, { now });
  const idempotencyKey = `account_manager_plan:${leadId}:${stableHash(context.fingerprint)}`;
  const existing = accountManagerPlans.getByIdempotency(idempotencyKey);
  if (existing && !force) {
    const tasks = persistAccountTasks({ lead, planRow: existing, plan: existing.plan, source });
    emit('account_manager.plan_reused', {
      worker: 'account_manager',
      leadId,
      accountPlanId: existing.id,
      taskCount: tasks.length,
      source
    });
    return readAccountManagerState(leadId);
  }

  const plan = buildAccountManagerPlan({ lead, context, now });
  const row = accountManagerPlans.upsert({
    id: `amp_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`,
    lead_id: leadId,
    status: 'ready',
    plan,
    evidence: plan.evidence,
    risk: plan.risk,
    idempotency_key: idempotencyKey
  });
  const taskRows = persistAccountTasks({ lead, planRow: row, plan, source });
  await writeAccountManagerMemory({ lead, plan, planRow: row, taskRows });

  emit('account_manager.plan_generated', {
    worker: 'account_manager',
    leadId,
    accountPlanId: row.id,
    taskCount: taskRows.length,
    dueCount: taskRows.filter((task) => task.due_at <= now).length,
    source
  });
  return readAccountManagerState(leadId);
}

export async function readAccountManagerState(leadId) {
  const row = accountManagerPlans.getLatest(leadId);
  return {
    row,
    plan: row?.plan || null,
    tasks: accountTasks.listByLead(leadId, { includeHistory: true }),
    operatorBoard: {
      escalations: accountTasks.listOperatorBoardEscalations({ leadId, limit: 100 }),
      workItems: accountTasks.listOperatorBoardWorkItems({ leadId, limit: 100 }),
      lifecycleReceipts: accountTasks.listOperatorBoardWorkItemReceipts({ leadId, limit: 100 }),
      retentionFeedbackReceipts: accountTasks.listOperatorBoardRetentionFeedbackReceipts({ leadId, limit: 100 })
    },
    summary: accountTaskSummary(leadId)
  };
}

export async function collectAccountManagerContext(lead, { now = Date.now() } = {}) {
  const leadId = lead.id;
  const contactRows = contactEvents.listByLead(leadId, { limit: 80 });
  const buildRows = builds.listByLead(leadId);
  const paymentRows = payments.listByLead(leadId);
  const subscriptionRows = subscriptions.forLead(leadId);
  const renewalCloseoutPackets = portalActions.listByLead?.(leadId, {
    limit: 50,
    type: RENEWAL_CLOSEOUT_PACKET_TYPE
  }) || [];
  const revisionRows = buildRows.flatMap((build) => buildRevisions.listByBuild(build.id, { limit: 20 }));
  const growthRow = growthPlans.getLatest(leadId);
  const growthPlan = safeJson(growthRow?.plan_json) || null;
  const researchProfile = safeJson(lead.research_json) || {};
  let memoryKinds = null;
  try {
    memoryKinds = await listKinds(lead.container_tag || containerTagFor(leadId));
  } catch (err) {
    memoryKinds = null;
  }

  const latestBuild = buildRows[0] || null;
  const deliveredAt = deliveryTimestamp({ lead, buildRows, paymentRows, now });
  const evidence = collectEvidence({
    lead,
    profile: researchProfile,
    contacts: contactRows,
    builds: buildRows,
    payments: paymentRows,
    subscriptions: subscriptionRows,
    renewalCloseoutPackets,
    revisions: revisionRows,
    growthPlan,
    memoryKinds,
    deliveredAt
  });
  const optOut = accountOptOutStatus(lead, contactRows);
  const unsupported = unsupportedHandoffStatus(lead, contactRows, growthPlan);
  return {
    lead,
    profile: researchProfile,
    contacts: contactRows,
    builds: buildRows,
    payments: paymentRows,
    subscriptions: subscriptionRows,
    renewalCloseoutPackets,
    revisions: revisionRows,
    latestBuild,
    deliveredAt,
    growthPlan,
    memoryKinds,
    evidence,
    optOut,
    unsupported,
    fingerprint: {
      lead: [lead.updated_at, lead.status, lead.website, lead.risk_status, lead.subscription_id],
      latestBuild: latestBuild ? [
        latestBuild.id,
        latestBuild.status,
        latestBuild.launch_status,
        latestBuild.finished_at,
        latestBuild.customer_approved_at,
        latestBuild.launched_at,
        latestBuild.updated_at,
        latestBuild.project_url
      ] : null,
      latestContact: contactRows[0] ? [contactRows[0].id, contactRows[0].created_at, contactRows[0].type] : null,
      latestPayment: paymentRows[0] ? [paymentRows[0].id, paymentRows[0].status, paymentRows[0].paid_at] : null,
      latestSubscription: subscriptionRows[0] ? [subscriptionRows[0].id, subscriptionRows[0].status, subscriptionRows[0].updated_at] : null,
      latestRenewalCloseout: renewalCloseoutPackets[0] ? [
        renewalCloseoutPackets[0].id,
        renewalCloseoutPackets[0].status,
        renewalCloseoutPackets[0].body?.nextReviewAt || null,
        renewalCloseoutPackets[0].body?.subscriptionId || null,
        renewalCloseoutPackets[0].created_at
      ] : null,
      nowBucket: Math.floor(now / DAY_MS)
    }
  };
}

export function buildAccountManagerPlan({ lead, context, now = Date.now() } = {}) {
  const plan = emptyAccountManagerPlan({
    leadId: lead.id,
    generatedAt: new Date(now).toISOString(),
    frequencyCapHours: env.accountManager.frequencyCapHours
  });
  plan.evidence = context.evidence.length ? context.evidence : fallbackEvidence(lead);
  plan.risk.optOut = context.optOut.blocked;
  plan.risk.unsupportedHandoff = context.unsupported.blocked;
  plan.risk.notes = [
    context.optOut.blocked ? `Opt-out gate active: ${context.optOut.reason}.` : null,
    context.unsupported.blocked ? `Operator handoff gate active: ${context.unsupported.reason}.` : null
  ].filter(Boolean);
  if (context.unsupported.blocked) plan.unsupportedFlags.push(context.unsupported.reason);

  const add = (kind, item) => addPlanItem(plan, normalizePlanItem({ lead, kind, item, now, evidence: plan.evidence }));

  for (const promised of promisedEditItems({ lead, context, now })) add('promised_edit', promised);
  for (const stale of staleFactItems({ lead, context, now })) add('stale_business_fact', stale);
  if (context.deliveredAt) {
    add('launch_followup', launchFollowupItem({ lead, context, now }));
    add('review_capture', reviewCaptureItem({ lead, context, now }));
    add('google_business_profile_hygiene', gbpHygieneItem({ lead, context, now }));
    add('analytics_contact_flow_check', analyticsItem({ lead, context, now }));
    add('hosting_subscription_status', hostingItem({ lead, context, now }));
  }
  for (const renewalCloseout of renewalCloseoutHealthCheckItems({ lead, context, now })) {
    add('renewal_closeout_health_check', renewalCloseout);
  }
  add('seasonal_hours', seasonalHoursItem({ lead, context, now }));
  add('service_menu_changes', serviceMenuItem({ lead, context, now }));

  plan.tasks = collectAccountTasks(plan);
  return plan;
}

function persistAccountTasks({ lead, planRow, plan, source }) {
  const rows = [];
  for (const task of collectAccountTasks(plan)) {
    const result = accountTasks.insertOrUpdate({
      id: taskIdFor(lead.id, task.idempotencyKey || task.id),
      lead_id: lead.id,
      account_plan_id: planRow?.id || null,
      kind: task.kind,
      title: task.title,
      summary: task.why,
      due_at: Date.parse(task.dueAt),
      priority: task.priority,
      channel: task.channel,
      status: 'pending',
      evidence_ids: task.evidenceIds,
      owner: task.owner,
      idempotency_key: task.idempotencyKey,
      preview: null,
      risk: task.risk || null,
      policy: { source, dryRunDefault: env.accountManager.dryRun }
    });
    rows.push(result.row);
  }
  return rows;
}

function addPlanItem(plan, item) {
  const section = SECTION_FOR_KIND[item.kind];
  if (!section || !ACCOUNT_MANAGER_SECTION_KEYS.includes(section)) return;
  plan[section].push(item);
}

function promisedEditItems({ context, now }) {
  const items = [];
  for (const event of context.contacts.filter((row) => row.type === 'customer_edit_request').slice(0, 5)) {
    const evidenceId = `edit-${safeCode(event.id)}`;
    items.push({
      id: `promised-edit-${safeCode(event.id)}`,
      title: 'Follow through on requested website edit',
      why: `Customer asked for: ${cleanText(event.body, 180)}`,
      action: 'Confirm the edit is either shipped, scheduled, or waiting on a specific missing asset.',
      dueAtMs: Math.max(now, event.created_at + 4 * HOUR_MS),
      priority: 'high',
      channel: 'agentmail',
      owner: 'account_manager',
      evidenceIds: [evidenceId],
      messageIntent: 'promise_follow_through',
      risk: { customerPromise: true }
    });
  }
  for (const revision of context.revisions.filter((row) => !['completed', 'done'].includes(row.status)).slice(0, 5)) {
    const evidenceId = `revision-${safeCode(revision.id)}`;
    items.push({
      id: `promised-revision-${safeCode(revision.id)}`,
      title: 'Close open revision loop',
      why: `A revision row is still ${revision.status}.`,
      action: 'Review the revision result and send a tight status note before the customer has to ask again.',
      dueAtMs: Math.max(now, (revision.created_at || now) + 6 * HOUR_MS),
      priority: 'high',
      channel: 'agentmail',
      owner: 'builder',
      evidenceIds: [evidenceId],
      messageIntent: 'revision_status'
    });
  }
  return items;
}

function staleFactItems({ lead, context, now }) {
  const items = [];
  const profile = context.profile || {};
  const hoursText = String(profile.hours || profile.openingHours || '').trim();
  const phoneText = String(profile.phone || lead.phone || '').trim();
  const staleHours = !hoursText || /unknown|not found|missing|closed\?/i.test(hoursText);
  const stalePhone = !phoneText || /unknown|not found|missing/i.test(phoneText);
  if (staleHours || stalePhone) {
    items.push({
      id: 'stale-business-facts',
      title: 'Re-check stale phone and hours before the next customer-facing note',
      why: [
        stalePhone ? 'Phone evidence is missing or uncertain.' : null,
        staleHours ? 'Hours evidence is missing or uncertain.' : null
      ].filter(Boolean).join(' '),
      action: 'Ask only for the missing facts, citing the last remembered source instead of re-asking everything.',
      dueAtMs: now,
      priority: 'urgent',
      channel: 'agentmail',
      owner: 'account_manager',
      evidenceIds: bestEvidence(context.evidence, ['profile-phone', 'profile-hours', 'lead-profile']),
      messageIntent: 'stale_fact_check',
      risk: { staleHours, stalePhone }
    });
  }
  return items;
}

function launchFollowupItem({ lead, context }) {
  const deliveredAt = context.deliveredAt;
  return {
    id: 'launch-followup-24h',
    title: '24-hour post-launch check-in',
    why: `The site appears delivered for ${lead.business_name}; a careful account manager should check forms, links, phone taps, and first impressions after one day.`,
    action: 'Send a concise check-in that cites the launch and asks if anything feels off after the first day.',
    dueAtMs: deliveredAt + DAY_MS,
    priority: 'high',
    channel: 'agentmail',
    owner: 'account_manager',
    evidenceIds: bestEvidence(context.evidence, ['delivery-status', 'build']),
    messageIntent: 'launch_24h_check'
  };
}

function reviewCaptureItem({ lead, context }) {
  return {
    id: 'review-request-after-delivery',
    title: 'Ask for a lightweight review after delivery',
    why: `${lead.business_name} has a delivered site; this is the right moment to capture a fresh testimonial or public review without pressure.`,
    action: 'Ask whether they would be comfortable leaving a review or sending a one-sentence testimonial.',
    dueAtMs: context.deliveredAt + 2 * DAY_MS,
    priority: 'medium',
    channel: 'agentmail',
    owner: 'account_manager',
    evidenceIds: bestEvidence(context.evidence, ['delivery-status', 'review', 'growth']),
    messageIntent: 'review_capture'
  };
}

function gbpHygieneItem({ lead, context }) {
  return {
    id: 'google-business-profile-hygiene',
    title: 'Google Business Profile hygiene check',
    why: 'The delivered site should match the business profile so customers see the same phone, hours, services, photos, and website URL everywhere.',
    action: 'Check category, phone, website URL, hours, service area, photos, and review link against the delivered site.',
    dueAtMs: context.deliveredAt + 3 * DAY_MS,
    priority: 'medium',
    channel: 'agentmail',
    owner: 'account_manager',
    evidenceIds: bestEvidence(context.evidence, ['lead-profile', 'delivery-status', 'growth']),
    messageIntent: 'gbp_hygiene'
  };
}

function seasonalHoursItem({ lead, context, now }) {
  const hoursUnknown = /unknown|not found|missing/i.test(String(context.profile?.hours || ''));
  return {
    id: 'seasonal-hours-reminder',
    title: 'Seasonal hours reminder',
    why: hoursUnknown
      ? 'Hours were not reliable in the remembered business profile.'
      : 'Seasonal or holiday hours drift is a common small-business website/profile mismatch.',
    action: 'Ask whether hours change for the upcoming season or holiday window, and offer to update the site/profile copy.',
    dueAtMs: hoursUnknown ? now + 2 * HOUR_MS : nextSeasonalReminder(now),
    priority: hoursUnknown ? 'high' : 'low',
    channel: 'agentmail',
    owner: 'account_manager',
    evidenceIds: bestEvidence(context.evidence, ['profile-hours', 'lead-profile']),
    messageIntent: 'seasonal_hours'
  };
}

function serviceMenuItem({ lead, context, now }) {
  const isMenuBusiness = /restaurant|bar|cafe|salon|barber|spa|menu|food/i.test(`${lead.niche || ''} ${context.profile?.whatTheyDo || ''}`);
  return {
    id: isMenuBusiness ? 'menu-service-change-check' : 'service-change-check',
    title: isMenuBusiness ? 'Check menu or service changes' : 'Check service changes',
    why: isMenuBusiness
      ? 'Menu/service businesses change offers often; stale website copy creates avoidable customer confusion.'
      : 'Local service businesses often add, remove, or seasonally emphasize services after launch.',
    action: 'Ask whether any services, menu items, pricing language, or priority offers changed since launch.',
    dueAtMs: now + 14 * DAY_MS,
    priority: 'low',
    channel: 'agentmail',
    owner: 'account_manager',
    evidenceIds: bestEvidence(context.evidence, ['lead-profile', 'growth']),
    messageIntent: 'service_menu_changes'
  };
}

function analyticsItem({ context }) {
  return {
    id: 'analytics-contact-flow-check',
    title: 'Analytics and contact-flow check',
    why: 'A delivered site is not done until phone taps, forms, booking links, and source traffic are known to work.',
    action: 'Check phone tap links, contact form routing, quote/booking CTA, analytics events, and any broken launch links.',
    dueAtMs: context.deliveredAt + 3 * DAY_MS,
    priority: 'high',
    channel: 'operator',
    owner: 'account_manager',
    evidenceIds: bestEvidence(context.evidence, ['delivery-status', 'build', 'growth']),
    messageIntent: 'analytics_contact_flow'
  };
}

function hostingItem({ lead, context }) {
  const active = context.subscriptions.some((row) => ['active', 'trialing', 'past_due'].includes(row.status)) || Boolean(lead.subscription_id);
  return {
    id: 'hosting-subscription-status',
    title: active ? 'Confirm hosting/subscription is healthy' : 'Explain hosting and edit-care status',
    why: active
      ? 'A subscription is linked, so uptime, SSL, domain, and monthly edit allowance should be checked.'
      : 'No active hosting/edit-care subscription is linked after launch.',
    action: active
      ? 'Verify the subscription status, domain/SSL, uptime check, and monthly edit allowance.'
      : 'Send a transparent note about what is covered now and what the optional hosting/edit-care plan includes.',
    dueAtMs: context.deliveredAt + DAY_MS,
    priority: active ? 'medium' : 'low',
    channel: active ? 'operator' : 'agentmail',
    owner: 'account_manager',
    evidenceIds: bestEvidence(context.evidence, ['hosting-status', 'payment-status', 'delivery-status']),
    messageIntent: 'hosting_status',
    risk: { subscriptionActive: active }
  };
}

function renewalCloseoutHealthCheckItems({ context, now }) {
  return (context.renewalCloseoutPackets || [])
    .filter((row) => row.status === 'visible_to_customer' && row.body?.closeoutPacketVisible !== false)
    .slice(0, 5)
    .map((packet) => {
      const body = packet.body || {};
      const nextReviewAt = Number.isFinite(Number(body.nextReviewAt))
        ? Number(body.nextReviewAt)
        : (packet.created_at || now) + 30 * DAY_MS;
      const subscriptionText = body.subscriptionId ? ` for subscription ${body.subscriptionId}` : '';
      const reviewDate = new Date(nextReviewAt).toISOString();
      return {
        id: `renewal-closeout-health-check-${safeCode(packet.id)}`,
        title: 'Renewal closeout health check',
        why: `Customer-visible renewal closeout packet ${packet.id}${subscriptionText} scheduled a next health review for ${reviewDate}.`,
        action: 'Review the closeout evidence, subscription status, portal confirmation, and support notes before any future renewal billing or customer-message step.',
        dueAtMs: nextReviewAt,
        priority: nextReviewAt <= now + 2 * DAY_MS ? 'high' : 'medium',
        channel: 'operator',
        owner: 'account_manager',
        evidenceIds: [`renewal-closeout-${safeCode(packet.id)}`],
        messageIntent: 'renewal_closeout_health_check',
        risk: {
          customerVisibleCloseout: true,
          noAutomaticCustomerContact: true,
          closeoutPacketId: packet.id,
          subscriptionId: body.subscriptionId || null,
          nextReviewAt
        }
      };
    });
}

function normalizePlanItem({ lead, kind, item, now, evidence }) {
  const dueAtMs = Number.isFinite(item.dueAtMs) ? Math.max(item.dueAtMs, now - 30 * DAY_MS) : now;
  const evidenceIds = unique((item.evidenceIds || []).filter(Boolean));
  if (!evidenceIds.length && evidence[0]?.id) evidenceIds.push(evidence[0].id);
  const id = safeCode(item.id || kind);
  return {
    id,
    kind,
    title: cleanText(item.title, 120) || titleFromKind(kind),
    why: cleanText(item.why, 500) || 'Account-manager task generated from remembered delivery evidence.',
    action: cleanText(item.action, 500) || 'Review and handle before sending a customer-facing update.',
    dueAt: new Date(dueAtMs).toISOString(),
    priority: ['urgent', 'high', 'medium', 'low'].includes(item.priority) ? item.priority : 'medium',
    channel: ['agentmail', 'portal', 'operator', 'phone'].includes(item.channel) ? item.channel : 'agentmail',
    owner: cleanText(item.owner, 80) || 'account_manager',
    evidenceIds,
    idempotencyKey: `account_task:${lead.id}:${id}`,
    messageIntent: item.messageIntent || kind,
    risk: item.risk || {}
  };
}

function collectEvidence({ lead, profile, contacts, builds: buildRows, payments: paymentRows, subscriptions: subscriptionRows, renewalCloseoutPackets, revisions, growthPlan, memoryKinds, deliveredAt }) {
  const out = [];
  addEvidence(out, {
    id: 'lead-profile',
    source: 'lead record',
    summary: `${lead.business_name} is a ${lead.niche || 'local business'} in ${lead.city || 'the local area'}; phone ${lead.phone || 'unknown'}; status ${lead.status || 'unknown'}.`,
    url: lead.source_url || lead.website || null,
    confidence: 0.78,
    createdAt: lead.updated_at
  });
  addEvidence(out, {
    id: 'profile-phone',
    source: 'business profile',
    summary: `Last remembered phone: ${profile.phone || lead.phone || 'not found'}.`,
    url: profile.sourceUrl || lead.source_url || null,
    confidence: profile.phone || lead.phone ? 0.72 : 0.4
  });
  addEvidence(out, {
    id: 'profile-hours',
    source: 'business profile',
    summary: `Last remembered hours: ${profile.hours || profile.openingHours || 'unknown; not found in source'}.`,
    url: profile.sourceUrl || lead.source_url || null,
    confidence: profile.hours || profile.openingHours ? 0.65 : 0.35
  });
  if (deliveredAt) addEvidence(out, {
    id: 'delivery-status',
    source: 'delivery state',
    summary: `Site delivery is recorded${lead.website ? ` at ${lead.website}` : ''}.`,
    url: lead.website || null,
    confidence: 0.82,
    createdAt: deliveredAt
  });
  for (const build of buildRows.slice(0, 3)) {
    addEvidence(out, {
      id: `build-${safeCode(build.id)}`,
      source: 'builder',
      summary: `Build ${build.id} is ${build.status}${build.project_url ? ` with project URL ${build.project_url}` : ''}.`,
      url: build.project_url || build.live_url || null,
      confidence: build.status === 'completed' ? 0.84 : 0.65,
      createdAt: build.updated_at || build.finished_at || build.started_at
    });
  }
  for (const payment of paymentRows.slice(0, 2)) {
    addEvidence(out, {
      id: `payment-${safeCode(payment.id)}`,
      source: 'payment',
      summary: `Payment row ${payment.id} is ${payment.status}${payment.customer_email ? ` for ${maskEmail(payment.customer_email)}` : ''}.`,
      url: payment.hosted_invoice_url || payment.payment_link_url || null,
      confidence: payment.status === 'paid' ? 0.86 : 0.7,
      createdAt: payment.paid_at || payment.created_at
    });
  }
  const activeSub = subscriptionRows.find((row) => ['active', 'trialing', 'past_due'].includes(row.status));
  addEvidence(out, {
    id: 'hosting-status',
    source: 'hosting subscription',
    summary: activeSub
      ? `Hosting/edit-care subscription is ${activeSub.status}.`
      : 'No active hosting/edit-care subscription is linked.',
    url: null,
    confidence: activeSub ? 0.86 : 0.7,
    createdAt: activeSub?.updated_at || null
  });
  for (const packet of (renewalCloseoutPackets || []).slice(0, 5)) {
    const body = packet.body || {};
    const nextReviewAt = Number.isFinite(Number(body.nextReviewAt))
      ? new Date(Number(body.nextReviewAt)).toISOString()
      : 'not scheduled';
    addEvidence(out, {
      id: `renewal-closeout-${safeCode(packet.id)}`,
      source: 'customer portal renewal closeout',
      summary: `Renewal closeout packet ${packet.id} is ${packet.status}; next health review is ${nextReviewAt}. ${body.summary || ''}`,
      url: null,
      confidence: packet.status === 'visible_to_customer' ? 0.88 : 0.68,
      createdAt: packet.created_at
    });
  }
  for (const event of contacts.slice(0, 8)) {
    const prefix = event.type === 'customer_edit_request' ? 'edit' : 'contact';
    addEvidence(out, {
      id: `${prefix}-${safeCode(event.id)}`,
      source: event.channel === 'agentmail' ? 'AgentMail thread' : event.channel || 'contact event',
      summary: `${event.direction} ${event.type}: ${event.subject || cleanText(event.body, 180) || 'message recorded'}`,
      url: null,
      confidence: event.direction === 'inbound' ? 0.82 : 0.66,
      createdAt: event.created_at
    });
  }
  for (const revision of revisions.slice(0, 4)) {
    addEvidence(out, {
      id: `revision-${safeCode(revision.id)}`,
      source: 'build revision',
      summary: `Revision ${revision.id} is ${revision.status}.`,
      url: null,
      confidence: 0.76,
      createdAt: revision.created_at
    });
  }
  if (growthPlan?.reviewCapturePlan?.length) addEvidence(out, {
    id: 'growth-review-capture',
    source: 'growth plan',
    summary: growthPlan.reviewCapturePlan[0].why || growthPlan.reviewCapturePlan[0].title,
    url: null,
    confidence: 0.74
  });
  for (const doc of [...(memoryKinds?.build_brief || []), ...(memoryKinds?.mail_thread || [])].slice(0, 4)) {
    const parsed = parseDoc(doc);
    addEvidence(out, {
      id: `memory-${out.length + 1}`,
      source: `memory:${doc.kind || doc.metadata?.kind || 'doc'}`,
      summary: cleanText(parsed?.note || parsed?.body || parsed?.subject || doc.summary || doc.content || 'remembered customer fact', 220),
      url: null,
      confidence: 0.7,
      createdAt: doc.updatedAt || doc.updated_at || null
    });
  }
  return out.slice(0, 40);
}

function addEvidence(out, entry) {
  const id = safeCode(entry.id);
  if (!id || out.some((row) => row.id === id)) return;
  const summary = cleanText(entry.summary, 260);
  if (!summary) return;
  out.push({
    id,
    source: cleanText(entry.source, 80) || 'evidence',
    summary,
    url: cleanText(entry.url, 500) || null,
    confidence: clamp01(entry.confidence ?? 0.7),
    createdAt: entry.createdAt ? new Date(entry.createdAt).toISOString() : null
  });
}

async function writeAccountManagerMemory({ lead, plan, planRow, taskRows }) {
  try {
    await addDoc(lead.container_tag || containerTagFor(lead.id), 'account_manager_plan', {
      plan,
      tasks: taskRows.map((task) => ({
        id: task.id,
        kind: task.kind,
        title: task.title,
        dueAt: task.due_at,
        priority: task.priority,
        channel: task.channel,
        status: task.status
      })),
      storedAt: new Date().toISOString()
    }, {
      accountManagerPlanId: planRow.id,
      businessName: lead.business_name,
      taskCount: taskRows.length,
      sourceId: planRow.id,
      schemaVersion: plan.schemaVersion
    });
    emit('account_manager.memory_stored', { worker: 'account_manager', leadId: lead.id, accountPlanId: planRow.id, kind: 'account_manager_plan' });
  } catch (err) {
    log.warn('account_manager.memory.add_failed', { leadId: lead.id, error: err?.message || String(err) });
    emit('account_manager.memory_skipped', { worker: 'account_manager', leadId: lead.id, accountPlanId: planRow.id, reason: err?.message || String(err) });
  }
}

function accountTaskSummary(leadId) {
  const tasks = accountTasks.listByLead(leadId);
  return {
    total: tasks.length,
    pending: tasks.filter((task) => ['pending', 'approved'].includes(task.status)).length,
    overdue: tasks.filter((task) => ['pending', 'approved'].includes(task.status) && task.due_at <= Date.now()).length,
    sent: tasks.filter((task) => task.status === 'sent').length,
    completed: tasks.filter((task) => task.status === 'completed').length
  };
}

function deliveryTimestamp({ lead, buildRows, paymentRows, now }) {
  const approved = buildRows.find((row) => (
    row.launched_at ||
    row.customer_approved_at ||
    ['launched', 'customer_approved'].includes(row.launch_status)
  ));
  if (approved) return approved.launched_at || approved.customer_approved_at || approved.finished_at || approved.updated_at || now;
  if (['shipped', 'launch_approved'].includes(lead.status)) {
    return lead.updated_at || buildRows[0]?.finished_at || paymentRows[0]?.paid_at || now;
  }
  return null;
}

function accountOptOutStatus(lead, contacts) {
  const state = `${lead.risk_status || ''} ${lead.consent_status || ''} ${lead.next_action || ''} ${lead.outreach_status || ''}`;
  if (/opt.?out|unsubscribe|do_not_email|do_not_call/i.test(state)) return { blocked: true, reason: 'lead_opted_out' };
  const opted = contacts.some((event) => /opt.?out|unsubscribe|do not email|stop emailing|remove me/i.test(`${event.type || ''} ${event.subject || ''} ${event.body || ''} ${event.metadata_json || ''}`));
  return opted ? { blocked: true, reason: 'thread_opted_out' } : { blocked: false, reason: 'clear' };
}

function unsupportedHandoffStatus(lead, contacts, growthPlan) {
  const state = `${lead.risk_status || ''} ${lead.next_action || ''}`;
  if (/handoff|operator_review|unsupported/i.test(state)) return { blocked: true, reason: 'operator_handoff' };
  if (growthPlan?.risk?.handoffRequired || growthPlan?.unsupportedFlags?.length) return { blocked: true, reason: 'growth_handoff' };
  const unsupported = contacts.some((event) => /unsupported|legal|contract|guarantee|tax|security|refund/i.test(`${event.body || ''} ${event.metadata_json || ''}`));
  return unsupported ? { blocked: true, reason: 'unsupported_customer_thread' } : { blocked: false, reason: 'clear' };
}

function nextSeasonalReminder(now) {
  const d = new Date(now);
  const year = d.getUTCFullYear();
  const dates = [
    Date.UTC(year, 0, 2, 17),
    Date.UTC(year, 2, 1, 17),
    Date.UTC(year, 4, 20, 17),
    Date.UTC(year, 7, 15, 17),
    Date.UTC(year, 10, 1, 17),
    Date.UTC(year + 1, 0, 2, 17)
  ];
  return dates.find((ts) => ts > now) || now + 30 * DAY_MS;
}

function bestEvidence(evidence, preferredTerms) {
  const ids = Array.isArray(evidence) ? evidence.map((item) => item.id) : [];
  const terms = preferredTerms.map((term) => String(term).toLowerCase());
  const preferred = ids.filter((id) => terms.some((term) => id.includes(term)));
  return (preferred.length ? preferred : ids).slice(0, 4);
}

function fallbackEvidence(lead) {
  return [{
    id: 'lead-profile',
    source: 'lead record',
    summary: `${lead.business_name || 'The business'} has an account-manager lead record.`,
    url: lead.website || lead.source_url || null,
    confidence: 0.5
  }];
}

function titleFromKind(kind) {
  return String(kind || 'task').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

function taskIdFor(leadId, key) {
  return `acct_${safeCode(leadId).slice(0, 36)}_${stableHash(key).slice(0, 16)}`;
}

function stableHash(value) {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 24);
}

function stableStringify(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function parseDoc(doc) {
  if (!doc) return null;
  const raw = doc.content ?? doc.content_text ?? doc.body ?? doc.summary ?? '';
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return { _raw: String(raw), body: String(raw) }; }
}

function safeJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function safeCode(value) {
  return cleanText(value, 160)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 90) || 'item';
}

function cleanText(value, max = 500) {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.7;
  return Math.max(0, Math.min(1, n));
}

function maskEmail(email) {
  if (!email || typeof email !== 'string' || !email.includes('@')) return '';
  const [local, domain] = email.split('@');
  const tld = domain.split('.').pop() || '';
  return `${local[0] || '*'}***@***.${tld}`;
}
