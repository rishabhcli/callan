// One-shot fixture for end-to-end UI testing.
// Inserts a synthetic lead into the local SQLite + writes a profile doc
// into Supermemory, bypassing the Gemini-backed scraper. The downstream
// workers (caller/analyst/mailer/builder) still go through Gemini Pro;
// this only sidesteps the scraper's Flash usage.

import { leads } from '../server/db.js';
import { addDoc, containerTagFor } from '../server/memory.js';
import { emit } from '../server/sse.js';

const leadId = `lead_seed${Date.now().toString(36)}`;
const containerTag = containerTagFor(leadId);

const profile = {
  businessName: "Tony's North Beach Barbershop",
  phone: '+14155550199',
  address: '1247 Grant Ave, San Francisco, CA',
  city: 'San Francisco',
  niche: 'barbershop',
  hasWebsite: false,
  websiteUrl: null,
  ownerHypothesis: 'Tony Caruso, second-generation barber',
  hours: 'Tue–Sat 9am–7pm',
  whatTheyDo: "Old-school men's haircuts and hot-towel shaves in North Beach since 1972.",
  signals: ['cash-only', 'walk-ins-welcome', 'family-owned', 'instagram-active'],
  yelpUrl: null,
  sourceUrl: null
};

leads.insert({
  id: leadId,
  container_tag: containerTag,
  business_name: profile.businessName,
  phone: profile.phone,
  address: profile.address,
  niche: profile.niche,
  city: profile.city,
  website: null,
  status: 'discovered'
});

await addDoc(containerTag, 'profile', profile, {
  businessName: profile.businessName,
  niche: profile.niche,
  city: profile.city
});

emit('lead.created', {
  worker: 'scraper',
  leadId,
  containerTag,
  businessName: profile.businessName,
  phone: profile.phone,
  niche: profile.niche,
  city: profile.city,
  seeded: true
});

console.log(JSON.stringify({ leadId, containerTag, profile }, null, 2));
