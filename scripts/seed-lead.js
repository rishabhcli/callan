// One-shot fixture for end-to-end UI testing.
// Inserts a synthetic lead into the local SQLite + writes a profile doc
// into Supermemory, bypassing the Gemini-backed scraper. The downstream
// workers (caller/analyst/mailer/builder) still go through Gemini Pro;
// this only sidesteps the scraper's Flash usage.

import { leads } from '../server/db.js';
import { addDoc, containerTagFor } from '../server/memory.js';
import { emit } from '../server/sse.js';
import { queueLeadForOutreach } from '../server/outreach.js';

const requestedLeadId = `lead_seed${Date.now().toString(36)}`;
const requestedContainerTag = containerTagFor(requestedLeadId);

const profile = {
  businessName: "Tony's North Beach Barbershop",
  phone: '+14155550199',
  address: '1247 Grant Ave, San Francisco, CA',
  city: 'San Francisco',
  niche: 'barbershop',
  hasWebsite: false,
  websiteUrl: null,
  onlinePresenceStrength: 'weak',
  onlinePresenceSummary: 'Only directory-style presence and light social proof; no owned page that explains services, pricing, hours, and booking.',
  ownerHypothesis: 'Tony Caruso, second-generation barber',
  customerPersona: 'Busy neighborhood owner who values regulars, walk-ins, and direct phone calls more than software.',
  hours: 'Tue–Sat 9am–7pm',
  whatTheyDo: "Old-school men's haircuts and hot-towel shaves in North Beach since 1972.",
  needs: ['owned website', 'tap-to-call booking path', 'hours and services page', 'local credibility proof'],
  signals: ['cash-only', 'walk-ins-welcome', 'family-owned', 'instagram-active'],
  bestContactEmail: null,
  yelpUrl: null,
  sourceUrl: null
};

const insertResult = leads.insert({
  id: requestedLeadId,
  container_tag: requestedContainerTag,
  business_name: profile.businessName,
  phone: profile.phone,
  address: profile.address,
  niche: profile.niche,
  city: profile.city,
  website: null,
  status: 'discovered',
  research_status: 'complete',
  outreach_status: 'not_queued',
  risk_status: 'pending',
  consent_status: 'operator_seeded',
  phone_classification: 'business',
  next_action: 'classify_outreach',
  source_url: profile.sourceUrl || profile.yelpUrl || null
});

const lead = insertResult.lead;
const leadId = lead.id;
const containerTag = lead.container_tag;

await addDoc(containerTag, 'profile', profile, {
  businessName: profile.businessName,
  niche: profile.niche,
  city: profile.city
});

const outreach = queueLeadForOutreach({ leadId, profile });

if (insertResult.duplicate) {
  emit('lead.duplicate', {
    worker: 'scraper',
    leadId,
    attemptedLeadId: insertResult.attemptedId,
    duplicateReasons: insertResult.duplicateReasons,
    businessName: profile.businessName,
    phone: profile.phone,
    niche: profile.niche,
    city: profile.city,
    seeded: true
  });
}

emit('lead.created', {
  worker: 'scraper',
  leadId,
  containerTag,
  duplicate: insertResult.duplicate,
  duplicateReasons: insertResult.duplicateReasons,
  attemptedLeadId: insertResult.attemptedId,
  businessName: profile.businessName,
  phone: profile.phone,
  niche: profile.niche,
  city: profile.city,
  onlinePresenceStrength: profile.onlinePresenceStrength,
  outreachStatus: outreach?.queued ? 'queued' : 'blocked',
  seeded: true
});

console.log(JSON.stringify({ leadId, containerTag, profile }, null, 2));
