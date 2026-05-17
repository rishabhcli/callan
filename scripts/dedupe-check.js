import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'callan-dedupe-'));
process.env.DATA_DIR = dataDir;

try {
  const { leads } = await import('../server/db.js');
  const { containerTagFor } = await import('../server/memory.js');

  const profileA = {
    businessName: 'Castro Tailor Shop',
    onlinePresenceStrength: 'weak',
    onlinePresenceSummary: 'Yelp listing only; no owned website found.',
    callRecommendation: { shouldCall: true, notWorthCalling: false, whyCall: 'No owned website found.', whyNotCall: null }
  };
  const firstId = 'dedupe_a';
  const first = leads.insert({
    id: firstId,
    container_tag: containerTagFor(firstId),
    business_name: 'Castro Tailor Shop',
    phone: '(415) 555-0199',
    address: '401 Castro St, San Francisco, CA',
    niche: 'tailor',
    city: 'San Francisco',
    website: null,
    source_url: 'https://www.yelp.com/biz/castro-tailor-shop-san-francisco',
    research_status: 'researched',
    online_presence_strength: 'weak',
    callable_reason: profileA.callRecommendation.whyCall,
    research_json: JSON.stringify(profileA)
  });

  assert.equal(first.inserted, true);
  assert.equal(first.duplicate, false);

  const profileB = {
    businessName: 'Castro Tailor Shop',
    onlinePresenceStrength: 'mixed',
    onlinePresenceSummary: 'A thin website was later found, but the offer remains unclear.',
    callRecommendation: { shouldCall: true, notWorthCalling: false, whyCall: 'Thin website and unclear services.', whyNotCall: null }
  };
  const secondId = 'dedupe_b';
  const duplicate = leads.upsertResearch({
    id: secondId,
    container_tag: containerTagFor(secondId),
    business_name: 'Castro Tailor Shop',
    phone: '+1 415 555 0199',
    address: '401 Castro Street, San Francisco, CA',
    niche: 'tailor',
    city: 'San Francisco',
    website: 'https://castrotailor.example.com',
    source_url: 'https://www.yelp.com/biz/castro-tailor-shop-san-francisco?utm_source=test',
    research_status: 'researched',
    online_presence_strength: 'mixed',
    callable_reason: profileB.callRecommendation.whyCall,
    research_json: JSON.stringify(profileB)
  }, { actor: 'dedupe-check', profile: profileB, runId: 'dedupe_check' });

  assert.equal(duplicate.inserted, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.lead.id, firstId);
  assert.equal(duplicate.lead.online_presence_strength, 'mixed');
  assert.equal(duplicate.lead.website, 'https://castrotailor.example.com');
  assert.ok(duplicate.lead.duplicate_count >= 1);
  assert.match(duplicate.lead.last_duplicate_reason, /phone|source_url|name_city/);

  const history = leads.history(firstId);
  assert.ok(history.some((entry) => entry.action === 'duplicate_merged'));
  assert.ok(history.some((entry) => entry.action === 'research_merged'));

  console.log('[PASS] dedupe merges by normalized phone/source/name+city and records visible lead history.');
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
