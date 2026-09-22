// @ts-check
// plugins.local/webintel/_errors.mjs: the one error vocabulary callers see.
// Adapters translate vendor HTTP failures into these codes, so no caller ever
// branches on an Exa or Firecrawl status body.

export const CODES = Object.freeze({
  BUDGET_EXHAUSTED: 'BUDGET_EXHAUSTED', // local monthly cap or server-reported floor reached (no network spent)
  QUOTA_402: 'QUOTA_402',               // provider says credits are gone; latched until the period ends
  RATE_LIMITED: 'RATE_LIMITED',
  AUTH: 'AUTH',                         // 401/403 from the provider API itself: bad or missing key
  BLOCKED_URL: 'BLOCKED_URL',           // refused by our URL policy before leaving the machine
  NOT_FOUND: 'NOT_FOUND',               // target page 404/410/403 or provider could not crawl it
  TIMEOUT: 'TIMEOUT',
  UPSTREAM_5XX: 'UPSTREAM_5XX',
  MALFORMED: 'MALFORMED',               // provider answered 2xx with a shape we don't recognize
  THIN_CONTENT: 'THIN_CONTENT',         // got a page, but it's a JS shell / too short to be a JD
  BAD_REQUEST: 'BAD_REQUEST',
  DISABLED: 'DISABLED',                 // provider has no key, or the per-run breaker tripped
});

/** Codes worth retrying on a later run (never within the same call chain beyond _retry.mjs). */
const RETRYABLE = new Set([CODES.RATE_LIMITED, CODES.TIMEOUT, CODES.UPSTREAM_5XX]);

/** Codes that mean "this URL is dead or useless", safe to negative-cache. */
export const NEGATIVE_CACHEABLE = new Set([CODES.NOT_FOUND, CODES.BLOCKED_URL, CODES.THIN_CONTENT]);

export class WebError extends Error {
  /**
   * @param {string} code  One of CODES.
   * @param {string} provider  'exa' | 'firecrawl' | 'policy' | 'budget' | 'ats-api'
   * @param {string} [message]
   * @param {{ httpStatus?: number|null, requestId?: string|null, detail?: string }} [extra]
   */
  constructor(code, provider, message = code, extra = {}) {
    super(`${provider}: ${message}`);
    this.name = 'WebError';
    this.code = code;
    this.provider = provider;
    this.retryable = RETRYABLE.has(code);
    this.httpStatus = extra.httpStatus ?? null;
    this.requestId = extra.requestId ?? null;
    this.detail = extra.detail ?? '';   // the provider's own error text, for classification only (never logged in full)
  }
}

/**
 * Map a thrown error from ctx.fetch (plugins/_engine.mjs guarded fetch sets
 * err.status on non-2xx; aborts surface as AbortError) to a WebError.
 * @param {any} err
 * @param {string} provider
 * @returns {WebError}
 */
export function classifyHttpError(err, provider) {
  if (err instanceof WebError) return err;
  const status = typeof err?.status === 'number' ? err.status : null;
  const msg = String(err?.message || err).slice(0, 200);
  const e = classify(status, msg, err, provider);
  e.detail = msg;
  return e;
}

/** @param {number|null} status @param {string} msg @param {any} err @param {string} provider */
function classify(status, msg, err, provider) {
  if (err?.name === 'AbortError' || /aborted|timed? ?out/i.test(msg)) return new WebError(CODES.TIMEOUT, provider, 'request timed out');
  if (status === 402) return new WebError(CODES.QUOTA_402, provider, 'out of free credits (HTTP 402)', { httpStatus: 402 });
  if (status === 429) return new WebError(CODES.RATE_LIMITED, provider, 'rate limited (HTTP 429)', { httpStatus: 429 });
  if (status === 401 || status === 403) return new WebError(CODES.AUTH, provider, `API key rejected (HTTP ${status})`, { httpStatus: status });
  if (status === 408) return new WebError(CODES.TIMEOUT, provider, 'provider timeout (HTTP 408)', { httpStatus: 408 });
  if (status === 404 || status === 410) return new WebError(CODES.NOT_FOUND, provider, `HTTP ${status}`, { httpStatus: status });
  if (status !== null && status >= 500) return new WebError(CODES.UPSTREAM_5XX, provider, `HTTP ${status}`, { httpStatus: status });
  if (status !== null && status >= 400) return new WebError(CODES.BAD_REQUEST, provider, `HTTP ${status}: ${msg}`, { httpStatus: status });
  // No status: DNS failure, reset connection, egress-guard refusal. Treat as transient.
  return new WebError(CODES.UPSTREAM_5XX, provider, `network error: ${msg}`);
}
