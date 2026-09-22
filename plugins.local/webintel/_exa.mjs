// @ts-check
// plugins.local/webintel/_exa.mjs: the ONLY file that knows Exa's API shape.
// Swapping Exa for another search/contents vendor means rewriting this file and
// its contract fixtures; nothing else changes.
//
// Cost-safe request shapes (free tier: $10/month):
//   /search   numResults ≤ 10 (results past 10 are billed extra), no contents,
//             type 'auto' (never the pricier deep variants)
//   /contents plain text only, capped, batched (never summary/highlights)
// Docs: exa.ai/docs/reference/search, /get-contents, /rate-limits (checked 2026-09-22).

import { CODES, WebError } from './_errors.mjs';
import { withRetry } from './_retry.mjs';

const BASE = 'https://api.exa.ai';
const SEARCH_TIMEOUT_MS = 15_000;
const CONTENTS_TIMEOUT_MS = 20_000;
export const MAX_RESULTS = 10;
export const MAX_BATCH = 25;

/** @param {any} ctx */
function headers(ctx) {
  return { 'x-api-key': ctx.env.EXA_API_KEY, 'content-type': 'application/json', accept: 'application/json' };
}

/** @param {unknown} v */
const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** @param {any} json */
function costOf(json) {
  const total = Number(json?.costDollars?.total);
  return Number.isFinite(total) && total >= 0 ? total : null;
}

/**
 * @param {any} json
 * @param {string} retrievedAt
 * @returns {{ hits: Array<{url: string, title: string|null, publishedAt: string|null, snippet: string|null, source: {provider: 'exa', requestId: string|null, retrievedAt: string}}>, costUsd: number|null, requestId: string|null }}
 */
export function normalizeExaSearch(json, retrievedAt) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.results)) {
    throw new WebError(CODES.MALFORMED, 'exa', 'search response has no results[]');
  }
  const requestId = str(json.requestId);
  const hits = json.results
    .filter((r) => r && typeof r.url === 'string' && /^https?:\/\//i.test(r.url))
    .map((r) => ({
      url: r.url,
      title: str(r.title),
      publishedAt: str(r.publishedDate),
      snippet: null,
      source: /** @type {const} */ ({ provider: 'exa', requestId, retrievedAt }),
    }));
  return { hits, costUsd: costOf(json), requestId };
}

/**
 * @param {any} ctx  plugin ctx (ctx.fetchJson guarded, ctx.env.EXA_API_KEY)
 * @param {{ query: string, numResults?: number, includeDomains?: string[], excludeDomains?: string[], startPublishedDate?: string|null }} q
 * @param {{ sleep?: (ms: number) => Promise<void>, now?: () => number, onRetry?: (code: string) => void }} [deps]
 */
export async function exaSearch(ctx, q, deps = {}) {
  const body = {
    query: q.query,
    type: 'auto',
    numResults: Math.max(1, Math.min(MAX_RESULTS, q.numResults ?? MAX_RESULTS)),
    contents: { text: false },
  };
  // Send include OR exclude, not both: when a search is pinned to domains, the
  // exclude list is applied client-side (see _capabilities.mjs).
  if (q.includeDomains?.length) Object.assign(body, { includeDomains: q.includeDomains });
  else if (q.excludeDomains?.length) Object.assign(body, { excludeDomains: q.excludeDomains });
  if (q.startPublishedDate) Object.assign(body, { startPublishedDate: q.startPublishedDate });

  const json = await withRetry(
    () => ctx.fetchJson(`${BASE}/search`, { method: 'POST', headers: headers(ctx), body: JSON.stringify(body), timeoutMs: SEARCH_TIMEOUT_MS }),
    { provider: 'exa', sleep: deps.sleep, onRetry: deps.onRetry },
  );
  return normalizeExaSearch(json, new Date((deps.now || Date.now)()).toISOString());
}

/** Exa per-URL crawl error tag → our code. @param {any} status */
function statusError(status) {
  const tag = String(status?.error?.tag || '');
  const http = Number(status?.error?.httpStatusCode) || null;
  let code = CODES.UPSTREAM_5XX;
  if (http === 403 || http === 404 || http === 410 || /NOT_FOUND|NOT_AVAILABLE|FORBIDDEN|UNSUPPORTED/i.test(tag)) code = CODES.NOT_FOUND;
  else if (/TIMEOUT/i.test(tag)) code = CODES.TIMEOUT;
  return new WebError(code, 'exa', tag || 'crawl error', { httpStatus: http });
}

/**
 * Map a /contents response back onto the requested URLs (partial success is
 * normal: some URLs crawl, some don't).
 * @param {any} json
 * @param {string[]} urls  exactly what was requested
 * @returns {{ docs: Map<string, {title: string|null, text: string, finalUrl: string}>, errors: Map<string, WebError>, costUsd: number|null, requestId: string|null }}
 */
export function normalizeExaContents(json, urls) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.results)) {
    throw new WebError(CODES.MALFORMED, 'exa', 'contents response has no results[]');
  }
  const statuses = Array.isArray(json.statuses) ? json.statuses : [];
  const docs = new Map();
  const errors = new Map();
  for (const u of urls) {
    const status = statuses.find((s) => s?.id === u);
    if (status && status.status === 'error') { errors.set(u, statusError(status)); continue; }
    const r = json.results.find((x) => x && (x.id === u || x.url === u));
    if (!r) { errors.set(u, new WebError(CODES.MALFORMED, 'exa', 'no result for requested URL')); continue; }
    if (typeof r.text !== 'string') { errors.set(u, new WebError(CODES.MALFORMED, 'exa', 'result has no text')); continue; }
    docs.set(u, { title: str(r.title), text: r.text, finalUrl: typeof r.url === 'string' ? r.url : u });
  }
  return { docs, errors, costUsd: costOf(json), requestId: str(json.requestId) };
}

/**
 * @param {any} ctx
 * @param {string[]} urls  ≤ MAX_BATCH canonical URLs
 * @param {{ maxCharacters: number }} opts
 * @param {{ sleep?: (ms: number) => Promise<void>, onRetry?: (code: string) => void }} [deps]
 */
export async function exaContents(ctx, urls, { maxCharacters }, deps = {}) {
  if (urls.length > MAX_BATCH) throw new WebError(CODES.BAD_REQUEST, 'exa', `batch of ${urls.length} exceeds ${MAX_BATCH}`);
  const body = { urls, text: { maxCharacters } };
  const json = await withRetry(
    () => ctx.fetchJson(`${BASE}/contents`, { method: 'POST', headers: headers(ctx), body: JSON.stringify(body), timeoutMs: CONTENTS_TIMEOUT_MS }),
    { provider: 'exa', sleep: deps.sleep, onRetry: deps.onRetry },
  );
  return normalizeExaContents(json, urls);
}
