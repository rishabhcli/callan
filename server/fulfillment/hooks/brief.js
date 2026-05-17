const REQUIRED_FIELDS = [
  'businessName',
  'phone',
  'locationOrServiceArea',
  'services',
  'cta',
  'customerNeed',
  'styleDirection',
  'prohibitedClaims'
];

const UNSUPPORTED_PATTERNS = [
  { code: 'unsupported_booking_claim', pattern: /\b(book|booking|appointment|schedule|reservation)s?\b/i, label: 'booking or scheduling' },
  { code: 'unsupported_payment_claim', pattern: /\b(pay|payment|checkout|deposit|invoice|financing|subscription)s?\b/i, label: 'payment or checkout' }
];

const HALLUCINATION_GUARDS = [
  'Do not claim online booking, booking integrations, online payments, checkout, deposits, financing, guarantees, licenses, insurance, awards, reviews, staff names, pricing, same-day service, emergency availability, or years in business unless explicitly confirmed.',
  'Do not invent testimonials, badges, certifications, affiliations, legal/compliance claims, before-and-after results, or customer counts.',
  'If a fact is missing, omit it rather than filling the gap.'
];

export function buildWebsiteBrief({ lead, profileDoc, postMortemDoc, latestPayment } = {}) {
  const profile = parseDocContent(profileDoc) || parseJson(lead?.research_json) || {};
  const postMortem = parseDocContent(postMortemDoc) || {};
  const niche = firstText(lead?.niche, profile?.niche, 'local services');
  const city = firstText(lead?.city, profile?.city, null);
  const address = firstText(lead?.address, profile?.address, null);
  const serviceArea = firstText(profile?.serviceArea, profile?.service_area, city, address, null);
  const phone = firstText(lead?.phone, profile?.phone, null);
  const businessName = firstText(lead?.business_name, profile?.businessName, profile?.business_name, null);
  const services = pickServices({ lead, profile, niche });
  const needs = uniqueItems([
    ...listItems(profile?.needs, 5, []),
    ...listItems(postMortem?.customerQuestions, 3, []),
    firstText(profile?.onlinePresenceSummary, profile?.whatTheyDo, null)
  ], 6);
  const customerNeed = needs.length
    ? needs.join('; ')
    : 'local customers need quick proof, a clear service menu, and an obvious way to contact the business';
  const style = pickStyle(niche);
  const cta = phone ? `Call ${phone} for service or a quote` : 'Call for service or a quote';
  const confirmedCapabilities = {
    booking: Boolean(profile?.bookingUrl || profile?.booking_url || profile?.supportsBooking),
    payments: Boolean(profile?.paymentUrl || profile?.payment_url || profile?.supportsOnlinePayments)
  };

  return {
    businessName,
    phone,
    locationOrServiceArea: serviceArea || city || address,
    services,
    cta,
    customerNeed,
    styleDirection: `${style.tone}; ${style.palette}; ${style.layout}`,
    prohibitedClaims: HALLUCINATION_GUARDS,
    confirmedCapabilities,
    sourceFacts: {
      niche,
      city,
      address,
      hours: firstText(profile?.hours, null),
      existingWebsite: firstText(profile?.websiteUrl, lead?.website, null),
      sourceUrl: firstText(profile?.sourceUrl, lead?.source_url, null),
      invoiceStatus: latestPayment?.status || null,
      customerPersona: firstText(profile?.customerPersona, postMortem?.customerCares, null),
      researchSummary: firstText(profile?.onlinePresenceSummary, profile?.summary, profile?.whatTheyDo, null),
      postCallSummary: firstText(postMortem?.reason, null)
    },
    sourceQuality: {
      profileFound: Boolean(profile && Object.keys(profile).length),
      postMortemFound: Boolean(postMortem && Object.keys(postMortem).length),
      leadId: lead?.id || null
    }
  };
}

export function validateWebsiteBrief(brief = {}) {
  const errors = [];
  const blockers = [];

  for (const field of REQUIRED_FIELDS) {
    const value = brief[field];
    const missing = Array.isArray(value) ? value.length === 0 : !firstText(value, null);
    if (missing) {
      const error = {
        code: `missing_${snake(field)}`,
        field,
        message: `${field} is required before submitting a website build.`
      };
      errors.push(error);
      if (['businessName', 'phone', 'services'].includes(field)) blockers.push(error);
    }
  }

  const unsupported = unsupportedClaims(brief);
  for (const claim of unsupported) {
    const error = {
      code: claim.code,
      field: 'claims',
      message: `The brief implies unsupported ${claim.label}.`
    };
    errors.push(error);
    blockers.push(error);
  }

  return {
    ok: blockers.length === 0 && errors.length === 0,
    blocked: blockers.length > 0,
    errors,
    blockers,
    requiredFields: REQUIRED_FIELDS,
    checkedAt: Date.now()
  };
}

export function createLovableBuildPrompt(brief) {
  const services = (brief.services || []).slice(0, 6).join(', ');
  const facts = brief.sourceFacts || {};
  const prompt = [
    `Build a one-page website for ${brief.businessName}.`,
    `Location/service area: ${brief.locationOrServiceArea}.`,
    `Phone/contact: ${brief.phone}.`,
    `Services to feature: ${services}.`,
    `Primary CTA: ${brief.cta}.`,
    `Customer need: ${brief.customerNeed}.`,
    `Style: ${brief.styleDirection}.`,
    facts.hours ? `Confirmed hours: ${facts.hours}.` : null,
    facts.address ? `Confirmed address: ${facts.address}.` : null,
    facts.researchSummary ? `Context: ${facts.researchSummary}.` : null,
    'Required structure: hero with business name and tap-to-call CTA, services section, trust/why-us section using only confirmed facts, and a contact section.',
    `Guardrails: ${brief.prohibitedClaims.join(' ')}`
  ].filter(Boolean).join('\n');

  return compactText(prompt, 2400);
}

export function renderMockGeneratedSite({ brief, revisionPrompt = null, flawed = false } = {}) {
  const name = flawed ? 'Generated Local Site' : brief.businessName;
  const phone = flawed ? '' : brief.phone;
  const services = flawed ? [] : (brief.services || []).slice(0, 6);
  const cta = flawed ? 'Learn more' : brief.cta;
  const serviceMarkup = services.map((service) => `<article><h2>${escapeHtml(service)}</h2><p>${escapeHtml(service)} for customers in ${escapeHtml(brief.locationOrServiceArea)}.</p></article>`).join('\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(name)}</title>
  <style>
    body { margin: 0; font-family: Inter, system-ui, sans-serif; color: #17201b; background: #f8faf7; }
    main { width: min(1040px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0; }
    header, section, footer { padding: 28px 0; }
    h1 { font-size: clamp(34px, 8vw, 76px); line-height: 0.98; margin: 0 0 16px; }
    h2 { font-size: 22px; margin: 0 0 8px; }
    p { font-size: 17px; line-height: 1.55; max-width: 62ch; }
    a.cta { display: inline-flex; padding: 12px 16px; background: #165a3a; color: white; text-decoration: none; }
    .services { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
    article { border: 1px solid #d6ded8; padding: 16px; background: white; }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>${escapeHtml(name)}</h1>
      <p>${escapeHtml(brief.customerNeed || '')}</p>
      ${phone ? `<a class="cta" href="tel:${escapeHtml(phone)}">${escapeHtml(cta)}</a>` : `<a class="cta" href="#contact">${escapeHtml(cta)}</a>`}
    </header>
    <section aria-label="Services">
      <h2>Services</h2>
      <div class="services">${serviceMarkup}</div>
    </section>
    <section aria-label="Service area">
      <h2>${escapeHtml(brief.locationOrServiceArea || 'Service area')}</h2>
      <p>Clear service information, practical contact details, and a simple quote path.</p>
    </section>
    <footer id="contact">
      <h2>Contact ${escapeHtml(name)}</h2>
      <p>${phone ? `Call ${escapeHtml(phone)} to get started.` : 'Contact details pending.'}</p>
      ${revisionPrompt ? `<p data-revision="true">${escapeHtml(revisionPrompt.slice(0, 180))}</p>` : ''}
    </footer>
  </main>
</body>
</html>`;
}

function unsupportedClaims(brief) {
  const allowed = brief.confirmedCapabilities || {};
  const text = [
    brief.cta,
    brief.customerNeed,
    brief.styleDirection,
    ...(brief.services || []),
    brief.sourceFacts?.researchSummary
  ].filter(Boolean).join(' ');

  const out = [];
  for (const item of UNSUPPORTED_PATTERNS) {
    if (item.code.includes('booking') && allowed.booking) continue;
    if (item.code.includes('payment') && allowed.payments) continue;
    if (item.pattern.test(text)) out.push(item);
  }
  return out;
}

function pickServices({ lead, profile, niche }) {
  const explicit = [
    ...listItems(profile?.services, 8, []),
    ...listItems(profile?.serviceList, 8, []),
    ...listItems(profile?.offerings, 8, [])
  ];
  if (explicit.length) return uniqueItems(explicit, 6);

  const whatTheyDo = firstText(profile?.whatTheyDo, profile?.summary, profile?.description, null);
  const needs = listItems(profile?.needs, 4, []);
  if (whatTheyDo) return uniqueItems([whatTheyDo, ...needs], 6);

  if (firstText(niche, null)) {
    return uniqueItems([
      `${niche} services`,
      'consultations or estimates',
      'contact and location details'
    ], 6);
  }

  return [];
}

function pickStyle(niche) {
  const n = String(niche || '');
  if (/(barber|salon|spa|nail|tattoo|hair)/i.test(n)) return { tone: 'warm and stylish', palette: 'warm neutrals with one bold accent', layout: 'photo-led hero, service cards, visible call CTA' };
  if (/(law|legal|accountant|tax|cpa|bookkeep|paralegal|finance)/i.test(n)) return { tone: 'professional and trustworthy', palette: 'white, charcoal, and one restrained accent', layout: 'credibility-first hero, service proof, calm contact section' };
  if (/(kids|party|toy|playground|daycare|ice cream|cafe|bakery)/i.test(n)) return { tone: 'playful and friendly', palette: 'bright accents on clean white', layout: 'bright hero, visual menu, family-friendly contact flow' };
  if (/(plumb|hvac|electric|roof|contractor|landscap|auto|repair|mechanic)/i.test(n)) return { tone: 'dependable and direct', palette: 'white, deep green, and safety yellow accents', layout: 'service-area hero, urgent contact CTA, trust proof' };
  return { tone: 'clean and professional', palette: 'neutral base with one brand accent', layout: 'clear hero, short service sections, sticky mobile call CTA' };
}

function parseDocContent(doc) {
  const c = doc?.content;
  if (!c) return null;
  if (typeof c === 'object') return c;
  return parseJson(c) || { summary: String(c) };
}

function parseJson(value) {
  if (!value || typeof value !== 'string') return value && typeof value === 'object' ? value : null;
  try { return JSON.parse(value); } catch { return null; }
}

function listItems(value, limit, fallback = []) {
  let items = [];
  if (Array.isArray(value)) items = value;
  else if (typeof value === 'string') items = value.split(/\n|;|\u2022|,/);
  else if (value && typeof value === 'object') items = Object.values(value);

  const cleaned = items
    .map((item) => {
      if (!item) return null;
      if (typeof item === 'object') return firstText(item.text, item.name, item.title, item.note, item.excerpt, safeStringify(item));
      return compactText(item, 180);
    })
    .filter(Boolean);

  const result = uniqueItems(cleaned, limit);
  return result.length ? result : fallback.slice(0, limit);
}

function uniqueItems(items, limit) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const text = compactText(item, 220);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

function firstText(...values) {
  for (const value of values) {
    const text = compactText(value, 260);
    if (text) return text;
  }
  return null;
}

function compactText(value, max = 240) {
  if (value === null || value === undefined) return null;
  const raw = Array.isArray(value) ? value.join('; ') : typeof value === 'object' ? safeStringify(value) : String(value);
  const text = raw.replace(/\s+/g, ' ').trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max - 1).trim()}...` : text;
}

function safeStringify(v) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

function snake(value) {
  return String(value || '').replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`).replace(/^_/, '');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
