import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-learning-loop-'));
process.env.DATA_DIR = dataDir;
process.env.RUN_MODE = 'mock';
process.env.SUPERMEMORY_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.MOSS_FORCE_MOCK = 'true';
process.env.CALLER_MOCK_TURN_DELAY_MS = '1';

const { db, durableJobs, leads, memoryWriteQueue } = await import('../server/db.js');
const {
  adaptiveArmDecision,
  assignAdaptiveArm,
  assignArm,
  recordOutcome,
  rollup
} = await import('../server/experiments.js');
const { priorCallLearningFromMemory, priorCallLearningPrompt } = await import('../server/pitchLearning.js');
const { addDoc, containerTagFor } = await import('../server/memory.js');
const { runCaller } = await import('../server/workers/caller.js');
const { memoryDurabilityReadiness } = await import('../server/readiness.js');
const {
  MEMORY_RETRY_JOB_TYPE,
  startMemoryRetryScheduler,
  stopMemoryRetryScheduler
} = await import('../server/memoryRetry.js');

const experimentKey = 'pitch_learning_check';
const arms = ['control', 'short_warm', 'data_driven'];
const successes = {
  control: { won: 1, converted: 0 },
  short_warm: { won: 2, converted: 1 },
  data_driven: { won: 4, converted: 3 }
};

for (const arm of arms) {
  for (let i = 0; i < 5; i += 1) {
    const bucketKey = `${arm}-${i}`;
    const assignment = assignArm({ experimentKey, bucketKey, arms: [arm] });
    recordOutcome({
      assignment,
      outcome: 'connected',
      idempotencyKey: `call:${bucketKey}:connected`
    });
    recordOutcome({
      assignment,
      outcome: i < successes[arm].won ? 'won' : 'lost',
      idempotencyKey: `call:${bucketKey}:analysis`
    });
    if (i < successes[arm].converted) {
      recordOutcome({
        assignment,
        outcome: 'converted',
        valueCents: 50_000,
        idempotencyKey: `payment:${bucketKey}`
      });
    }
  }
}

const decision = adaptiveArmDecision({
  experimentKey,
  bucketKey: 'next-qualified-lead',
  arms,
  minSamplesPerArm: 5,
  explorationRate: 0
});
assert.equal(decision.policy, 'exploit');
assert.equal(decision.arm, 'data_driven');

const stickyFirst = assignAdaptiveArm({
  experimentKey,
  bucketKey: 'sticky-lead',
  arms,
  minSamplesPerArm: 5,
  explorationRate: 0
});
const stickySecond = assignAdaptiveArm({
  experimentKey,
  bucketKey: 'sticky-lead',
  arms,
  minSamplesPerArm: 5,
  explorationRate: 1
});
assert.equal(stickyFirst.id, stickySecond.id);
assert.equal(stickyFirst.arm, 'data_driven');

const duplicateAssignment = assignArm({
  experimentKey,
  bucketKey: 'idempotent-outcome-lead',
  arms: ['control']
});
const firstOutcome = recordOutcome({
  assignment: duplicateAssignment,
  outcome: 'converted',
  valueCents: 50_000,
  idempotencyKey: 'payment:one'
});
const duplicateOutcome = recordOutcome({
  assignment: duplicateAssignment,
  outcome: 'converted',
  valueCents: 50_000,
  idempotencyKey: 'payment:one'
});
assert.equal(firstOutcome.inserted, true);
assert.equal(duplicateOutcome.inserted, false);
const duplicateRows = db.prepare(`
  SELECT COUNT(*) AS n, COALESCE(SUM(value_cents), 0) AS revenue
  FROM experiment_outcomes
  WHERE assignment_id = ? AND outcome = 'converted'
`).get(duplicateAssignment.id);
assert.equal(duplicateRows.n, 1);
assert.equal(duplicateRows.revenue, 50_000);

const learning = priorCallLearningFromMemory({
  content: JSON.stringify({
    callId: 'call_prior_1',
    outcome: 'lost',
    failureReason: 'Customer objected to price or budget.',
    whatWorked: ['The evidence-based opener earned permission to continue.'],
    whatToTryNext: ['Explain the fixed scope before repeating the price.'],
    customerQuestions: ['Can I reply to the invoice email with changes?'],
    nextBestAction: { code: 'retry_call', label: 'Retry call', reason: 'Use the revised price framing.' }
  })
});
assert.equal(learning.sourceCallId, 'call_prior_1');
assert.match(priorCallLearningPrompt(learning), /Explain the fixed scope/);
assert.match(priorCallLearningPrompt(learning), /recording disclosure/);

const callerLeadId = 'learning_loop_caller';
const callerTag = containerTagFor(callerLeadId);
const callerProfile = {
  businessName: 'Learning Loop Plumbing',
  city: 'Oakland',
  niche: 'plumbing repair',
  phone: '+14155550177',
  address: '77 Broadway, Oakland, CA',
  hasWebsite: false,
  onlinePresenceStrength: 'weak',
  onlinePresenceSummary: 'No owned site explains emergency services or makes the next customer action obvious.',
  whatTheyDo: 'Emergency plumbing and leak repair.',
  needs: ['clear service scope', 'tap-to-call action'],
  signals: ['reviews mention fast emergency response']
};
leads.insert({
  id: callerLeadId,
  container_tag: callerTag,
  business_name: callerProfile.businessName,
  phone: callerProfile.phone,
  address: callerProfile.address,
  niche: callerProfile.niche,
  city: callerProfile.city,
  website: null,
  research_status: 'complete',
  outreach_status: 'queued',
  risk_status: 'callable',
  consent_status: 'operator_demo',
  phone_classification: 'business',
  research_json: JSON.stringify(callerProfile)
});
await addDoc(callerTag, 'call_analysis', {
  callId: 'call_prior_1',
  outcome: 'lost',
  failureReason: 'Customer objected to price or budget.',
  whatWorked: ['The evidence-based opener earned permission to continue.'],
  whatToTryNext: ['Explain the fixed scope before repeating the price.'],
  customerQuestions: ['Can I reply to the invoice email with changes?'],
  nextBestAction: { code: 'retry_call', label: 'Retry call', reason: 'Use the revised price framing.' }
}, {
  sourceId: 'call_prior_1',
  sourceEvent: 'learning_loop.prior_analysis'
});
const firstCallerRun = await runCaller({ leadId: callerLeadId, toPhone: callerProfile.phone });
const secondCallerRun = await runCaller({ leadId: callerLeadId, toPhone: callerProfile.phone });
const pitchRevisions = db.prepare(`
  SELECT custom_id, source_id, content_text
  FROM memory_documents
  WHERE lead_id = ? AND kind = 'pitch'
  ORDER BY updated_at ASC
`).all(callerLeadId);
assert.equal(pitchRevisions.length, 2);
assert.equal(new Set(pitchRevisions.map((row) => row.source_id)).size, 2);
for (const revision of pitchRevisions) {
  const content = JSON.parse(revision.content_text);
  assert.equal(content.priorCallLearning?.sourceCallId, 'call_prior_1');
  assert.match(content.priorCallLearning?.whatToTryNext?.[0] || '', /fixed scope/);
}

assert.equal(memoryDurabilityReadiness().ok, true);
memoryWriteQueue.upsert({
  custom_id: 'growth_plan:learning_loop_caller:readiness_probe',
  lead_id: callerLeadId,
  container_tag: callerTag,
  kind: 'growth_plan',
  source_id: 'readiness_probe',
  content_text: '{}',
  status: 'failed',
  attempt_count: 1,
  next_attempt_at: Date.now()
});
const blockedMemory = memoryDurabilityReadiness();
assert.equal(blockedMemory.ok, false);
assert(blockedMemory.pendingWrites > 0);
memoryWriteQueue.mark('growth_plan:learning_loop_caller:readiness_probe', { status: 'succeeded' });
assert.equal(memoryDurabilityReadiness().ok, true);

const scheduler = startMemoryRetryScheduler({ enabled: true, intervalMs: 10_000 });
assert.equal(scheduler.running, true);
assert(scheduler.firstJobId);
assert.equal(durableJobs.get(scheduler.firstJobId)?.type, MEMORY_RETRY_JOB_TYPE);
stopMemoryRetryScheduler();

const learnedRollup = rollup(experimentKey);
const persistedAssignmentId = stickyFirst.id;
db.close();

const verificationCode = `
  const { db } = await import('./server/db.js');
  const assignment = db.prepare('SELECT id, arm FROM experiment_assignments WHERE id = ?').get(${JSON.stringify(persistedAssignmentId)});
  const outcomes = db.prepare('SELECT COUNT(*) AS n FROM experiment_outcomes WHERE experiment_key = ?').get(${JSON.stringify(experimentKey)});
  console.log(JSON.stringify({ assignment, outcomes: outcomes.n }));
  db.close();
`;
const restartOutput = execFileSync(process.execPath, ['--input-type=module', '--eval', verificationCode], {
  cwd: process.cwd(),
  encoding: 'utf8',
  env: { ...process.env, DATA_DIR: dataDir, RUN_MODE: 'mock', SUPERMEMORY_API_KEY: '' }
}).trim();
const restartProof = JSON.parse(restartOutput.split('\n').at(-1));
assert.equal(restartProof.assignment.id, persistedAssignmentId);
assert.equal(restartProof.assignment.arm, 'data_driven');
assert(restartProof.outcomes > 0);

console.log(JSON.stringify({
  ok: true,
  dataDir,
  decision,
  stickyAssignment: { id: stickyFirst.id, arm: stickyFirst.arm },
  idempotentOutcome: { inserted: firstOutcome.inserted, duplicateInserted: duplicateOutcome.inserted },
  priorCallLearning: learning,
  callerLearningProof: {
    callIds: [firstCallerRun.callId, secondCallerRun.callId],
    pitchRevisions: pitchRevisions.map((row) => ({ customId: row.custom_id, sourceId: row.source_id })),
    productionGateBlockedPendingWrite: blockedMemory.ok === false
  },
  memoryRetryJobId: scheduler.firstJobId,
  rollup: learnedRollup,
  restartProof
}, null, 2));
