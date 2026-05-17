// Manual smoke test for the memory layer.
// Creates two fake businesses, writes all 4 doc kinds in each,
// then verifies containerTag isolation and per-kind retrieval.
import { addDoc, search, listKinds, containerTagFor } from '../server/memory.js';

const fixtures = [
  {
    leadId: `smoke${Date.now().toString(36)}a`,
    profile: { businessName: "Tony's Barbershop", city: 'San Francisco', niche: 'barbershop', phone: '+14155550101', hasWebsite: false, whatTheyDo: 'Mens haircuts, beard trims.' },
    pitch: { openingLine: 'Quick favor', valueProp: 'Get found on Google in 7 days', close: 'Three hundred to start, send a link?' },
    callLog: { transcript: 'agent: hi tony! ... tony: yeah send the link', durationSec: 92 },
    postMortem: { outcome: 'won', reason: 'Tony was already shopping for a website', whatToTryNext: ['mention reviews earlier'] }
  },
  {
    leadId: `smoke${Date.now().toString(36)}b`,
    profile: { businessName: "Alma's Tax Shop", city: 'Oakland', niche: 'tax preparation', phone: '+15105550102', hasWebsite: false, whatTheyDo: 'Solo tax preparer, walk-ins, paper records.' },
    pitch: { openingLine: 'Tax season teaser', valueProp: 'Online booking + intake form', close: 'Five hundred for the season package' },
    callLog: { transcript: 'agent: ... alma: not interested', durationSec: 32 },
    postMortem: { outcome: 'lost', reason: 'Doesnt use computers', whatToTryNext: ['try in fall when slow'] }
  }
];

async function run() {
  for (const f of fixtures) {
    const tag = containerTagFor(f.leadId);
    console.log(`\n=== ${f.leadId} (${tag}) ===`);
    await addDoc(tag, 'profile', f.profile);
    await addDoc(tag, 'pitch', f.pitch);
    await addDoc(tag, 'call_log', f.callLog);
    await addDoc(tag, 'post_mortem', f.postMortem);
  }

  console.log('\n-- waiting 6s for indexing --');
  await new Promise((r) => setTimeout(r, 6000));

  for (const f of fixtures) {
    const tag = containerTagFor(f.leadId);
    const kinds = await listKinds(tag);
    console.log(`${tag} counts: profile=${kinds.profile.length} pitch=${kinds.pitch.length} call_log=${kinds.call_log.length} post_mortem=${kinds.post_mortem.length}`);
  }

  // Isolation check: searching tag A should NOT return tag B's content.
  const tagA = containerTagFor(fixtures[0].leadId);
  const tagB = containerTagFor(fixtures[1].leadId);
  const aHits = await search(tagA, 'tax preparation');
  const bHits = await search(tagB, 'barbershop');
  console.log(`\nIsolation check:`);
  console.log(`  tagA('${tagA}') searching 'tax preparation' -> ${aHits.length} hits (expect 0 or only-A docs)`);
  console.log(`  tagB('${tagB}') searching 'barbershop' -> ${bHits.length} hits (expect 0 or only-B docs)`);

  const aIds = new Set(aHits.map((h) => h?.documentId || h?.id));
  const bIds = new Set(bHits.map((h) => h?.documentId || h?.id));
  if (aIds.size === 0 && bIds.size === 0) console.log('  PASS: zero cross-tag bleed.');
  else console.log('  CHECK: some hits returned (acceptable if same tag, fail if cross-tag).');

  // Per-kind retrieval
  const won = await search(tagA, 'outcome', { kind: 'post_mortem' });
  console.log(`\n${tagA} post_mortem search -> ${won.length} hit(s).`);
}

run().catch((err) => {
  console.error('SMOKE FAILED:', err);
  process.exit(1);
});
