import { env } from './env.js';
import { portalTokens } from './db.js';

export const CUSTOMER_LINK_PURPOSES = Object.freeze({
  portal: 'build_share',
  previewAsset: 'preview_asset',
  hostingAccept: 'hosting_accept',
  unsubscribe: 'unsubscribe'
});

function publicBaseUrl() {
  return String(env.publicUrl || 'http://localhost:8787').replace(/\/+$/, '');
}

function ensureToken(leadId, purpose, metadata = {}) {
  if (!leadId) throw new Error('customer link requires leadId');
  return portalTokens.ensureActive({
    lead_id: leadId,
    purpose,
    metadata: { source: 'customer_link', ...metadata }
  });
}

export function customerPortalLink(leadId) {
  const result = ensureToken(leadId, CUSTOMER_LINK_PURPOSES.portal);
  return {
    tokenId: result.row?.id || null,
    url: `${publicBaseUrl()}/share/build/${encodeURIComponent(result.token)}`
  };
}

export function previewAssetLink({ leadId, buildId }) {
  if (!buildId) throw new Error('preview asset link requires buildId');
  let result = ensureToken(leadId, CUSTOMER_LINK_PURPOSES.previewAsset, { buildId });
  if (result.row?.metadata?.buildId !== buildId) {
    result = portalTokens.rotate({
      lead_id: leadId,
      purpose: CUSTOMER_LINK_PURPOSES.previewAsset,
      metadata: { source: 'customer_link', buildId },
      reason: 'preview_build_changed'
    });
  }
  return {
    tokenId: result.row?.id || null,
    url: `${publicBaseUrl()}/api/preview-build/${encodeURIComponent(result.token)}/${encodeURIComponent(buildId)}/screenshot.png`
  };
}

export function hostingAcceptLink(leadId) {
  const result = ensureToken(leadId, CUSTOMER_LINK_PURPOSES.hostingAccept);
  return {
    tokenId: result.row?.id || null,
    url: `${publicBaseUrl()}/api/hosting/accept/${encodeURIComponent(result.token)}`
  };
}

export function unsubscribeLink(leadId, topic = 'all') {
  const result = ensureToken(leadId, CUSTOMER_LINK_PURPOSES.unsubscribe, { topic });
  return {
    tokenId: result.row?.id || null,
    url: `${publicBaseUrl()}/unsubscribe/${encodeURIComponent(result.token)}?topic=${encodeURIComponent(topic)}`
  };
}

export function resolveCustomerLinkToken(token, expectedPurpose) {
  const result = portalTokens.resolve(String(token || '').trim());
  if (!result?.ok || !result.lead || !result.row) return result || { ok: false, reason: 'not_found' };
  if (result.row.purpose !== expectedPurpose) {
    return { ok: false, reason: 'purpose_mismatch', row: result.row, lead: null };
  }
  return result;
}

export function redactCustomerLink(value) {
  const text = String(value || '');
  if (!text) return text;
  return text
    .replace(/(\/share\/build\/)[^/?#\s]+/gi, '$1:token')
    .replace(/(\/api\/preview-build\/)[^/?#\s]+/gi, '$1:token')
    .replace(/(\/api\/hosting\/accept\/)[^/?#\s]+/gi, '$1:token')
    .replace(/(\/unsubscribe\/)[^/?#\s]+/gi, '$1:token');
}
