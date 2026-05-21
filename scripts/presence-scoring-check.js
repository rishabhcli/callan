import assert from 'node:assert/strict';
import { scoreOnlinePresence } from '../server/presenceScorer.js';
import { buildLeadIntelligence } from '../server/research/leadIntelligence.js';

const weak = scoreOnlinePresence({
  businessName: 'Mission Curl Room',
  hasWebsite: false,
  sourceUrl: 'https://www.yelp.com/biz/mission-curl-room-san-francisco',
  onlinePresenceSummary: 'Business website: none. Yelp listing has phone and sparse category details.',
  signals: ['yelp-source', 'no-owned-website-found']
});

assert.equal(weak.onlinePresenceStrength, 'weak');
assert.equal(weak.callRecommendation.shouldCall, true);
assert.equal(weak.callRecommendation.notWorthCalling, false);
assert.ok(weak.onlinePresenceEvidence.listings.found);
assert.ok(weak.onlinePresenceReasons.some((reason) => /website/i.test(reason)));

const strong = scoreOnlinePresence({
  businessName: 'Hayes Valley Physical Therapy',
  hasWebsite: true,
  websiteUrl: 'https://hayesvalleypt.example.com',
  sourceUrl: 'https://www.google.com/maps/place/Hayes+Valley+Physical+Therapy',
  onlinePresenceSummary: 'Modern website with services, booking online, reviews, hours, photos, and contact form.',
  signals: ['online booking', 'reviews visible', 'services menu', 'photos gallery']
});

assert.equal(strong.onlinePresenceStrength, 'strong');
assert.equal(strong.callRecommendation.shouldCall, false);
assert.equal(strong.callRecommendation.notWorthCalling, true);
assert.match(strong.notWorthCallingReason, /Not worth calling/i);
assert.ok(strong.onlinePresenceConfidence >= 0.7);

const mixed = scoreOnlinePresence({
  businessName: 'North Beach Shoe Repair',
  hasWebsite: true,
  websiteUrl: 'https://northbeachshoerepair.example.com',
  onlinePresenceSummary: 'Website exists with services and hours, but no booking path and sparse proof.',
  signals: ['services', 'hours', 'sparse']
});

assert.equal(mixed.onlinePresenceStrength, 'mixed');
assert.equal(mixed.callRecommendation.shouldCall, true);

const weakIntel = buildLeadIntelligence({
  profile: {
    businessName: 'Mission Curl Room',
    niche: 'salon',
    city: 'San Francisco',
    phone: '(415) 555-0101',
    hasWebsite: false,
    websiteUrl: null,
    onlinePresenceStrength: weak.onlinePresenceStrength,
    presenceConfidence: weak.presenceConfidence,
    onlinePresenceEvidence: weak.onlinePresenceEvidence,
    onlinePresenceSummary: weak.onlinePresenceSummary
  }
}, { sourceType: 'directory', sourceUrl: 'https://www.yelp.com/biz/mission-curl-room-san-francisco' });

assert.equal(weakIntel.doNotCallBecauseAlreadyStrong.skip, false);
assert.ok(weakIntel.scores.presenceWeakness.score >= 70);
assert.ok(weakIntel.scores.websiteValue.score >= 80);
assert.ok(weakIntel.callOpener.evidenceIds.length);

const strongIntel = buildLeadIntelligence({
  profile: {
    businessName: 'Hayes Valley Physical Therapy',
    niche: 'physical therapy',
    city: 'San Francisco',
    phone: '(415) 555-0222',
    hasWebsite: true,
    websiteUrl: 'https://hayesvalleypt.example.com',
    onlinePresenceStrength: strong.onlinePresenceStrength,
    presenceConfidence: strong.presenceConfidence,
    onlinePresenceEvidence: strong.onlinePresenceEvidence,
    onlinePresenceSummary: strong.onlinePresenceSummary,
    notWorthCallingReason: strong.notWorthCallingReason
  }
}, { sourceType: 'website', sourceUrl: 'https://hayesvalleypt.example.com' });

assert.equal(strongIntel.doNotCallBecauseAlreadyStrong.skip, true);
assert.ok(strongIntel.doNotCallBecauseAlreadyStrong.reason);
assert.ok(strongIntel.scores.presenceWeakness.score < 30);
assert.match(strongIntel.callOpener.text, /not a fit/i);

console.log('[PASS] presence scoring classifies weak, mixed, and strong leads with cited intelligence scores and call/no-call reasoning.');
