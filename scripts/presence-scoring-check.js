import assert from 'node:assert/strict';
import { scoreOnlinePresence } from '../server/presenceScorer.js';

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

console.log('[PASS] presence scoring classifies weak, mixed, and strong leads with call/no-call reasoning.');
