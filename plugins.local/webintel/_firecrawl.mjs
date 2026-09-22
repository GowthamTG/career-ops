// @ts-check
// plugins.local/webintel/_firecrawl.mjs: the ONLY file that knows Firecrawl's API.
//
// Free tier: 1,000 credits/month, 10 scrapes/min, 2 concurrent. Scrape = 1
// credit, and a target page answering 403/404 STILL costs 1 (a scrape that
// returns nothing at all is free). So the request shape is pinned to the
// cheapest form: markdown only (JSON/question/highlights formats cost +4 each),
// main content only, basic proxy. Crawl, extract, agent, and monitor are never
// called from code.
// Docs: docs.firecrawl.dev/api-reference/endpoint/scrape, /rate-limits (checked 2026-09-22).

import { CODES, WebError, classifyHttpError } from './_errors.mjs';
import { withRetry } from './_retry.mjs';

const BASE = 'https://api.firecrawl.dev';
const SCRAPE_TIMEOUT_MS = 45_000;

/** @param {any} ctx */
function headers(ctx) {
  return { authorization: `Bearer ${ctx.env.FIRECRAWL_API_KEY}`, 'content-type': 'application/json', accept: 'application/json' };
}

/**
 * @param {any} json
 * @param {string} url  what was requested
 * @returns {{ doc: {title: string|null, text: string, finalUrl: string}|null, error: WebError|null, credits: number, statusCode: number|null }}
 */
export function normalizeFirecrawlScrape(json, url) {
  if (!json || typeof json !== 'object' || json.success !== true || !json.data || typeof json.data !== 'object') {
    return { doc: null, error: new WebError(CODES.MALFORMED, 'firecrawl', 'scrape response missing success/data'), credits: 1, statusCode: null };
  }
  const meta = json.data.metadata && typeof json.data.metadata === 'object' ? json.data.metadata : {};
  const used = Number(meta.creditsUsed);
  const credits = Number.isFinite(used) && used >= 0 ? used : 1;
  const statusCode = Number.isFinite(Number(meta.statusCode)) ? Number(meta.statusCode) : null;
  if (statusCode !== null && statusCode >= 400) {
    return { doc: null, error: new WebError(CODES.NOT_FOUND, 'firecrawl', `target answered HTTP ${statusCode}`, { httpStatus: statusCode }), credits, statusCode };
  }
  if (typeof json.data.markdown !== 'string') {
    return { doc: null, error: new WebError(CODES.MALFORMED, 'firecrawl', 'no markdown in response'), credits, statusCode };
  }
  const finalUrl = typeof meta.url === 'string' ? meta.url : typeof meta.sourceURL === 'string' ? meta.sourceURL : url;
  const title = typeof meta.title === 'string' && meta.title.trim() ? meta.title.trim() : null;
  return { doc: { title, text: json.data.markdown, finalUrl }, error: null, credits, statusCode };
}

/**
 * @param {any} ctx  plugin ctx (ctx.env.FIRECRAWL_API_KEY)
 * @param {string} url  canonical, policy-vetted URL
 * @param {{ sleep?: (ms: number) => Promise<void>, onRetry?: (code: string) => void }} [deps]
 */
export async function firecrawlScrape(ctx, url, deps = {}) {
  const body = { url, formats: ['markdown'], onlyMainContent: true, proxy: 'basic', blockAds: true, timeout: SCRAPE_TIMEOUT_MS };
  let json;
  try {
    json = await withRetry(
      () => ctx.fetchJson(`${BASE}/v2/scrape`, { method: 'POST', headers: headers(ctx), body: JSON.stringify(body), timeoutMs: SCRAPE_TIMEOUT_MS + 10_000 }),
      { provider: 'firecrawl', sleep: deps.sleep, onRetry: deps.onRetry },
    );
  } catch (raw) {
    const err = classifyHttpError(raw, 'firecrawl');
    // Firecrawl answers 403 for sites it refuses to scrape; only a message about
    // the key itself means our credentials are bad.
    if (err.code === CODES.AUTH && err.httpStatus === 403 && !/api key|unauthori[sz]ed|invalid token/i.test(err.detail)) {
      return { doc: null, error: new WebError(CODES.NOT_FOUND, 'firecrawl', 'site not supported by Firecrawl', { httpStatus: 403 }), credits: 0, statusCode: null };
    }
    throw err;
  }
  return normalizeFirecrawlScrape(json, url);
}

/**
 * Remaining free credits (free endpoint; also sees chat/MCP usage).
 * @param {any} json
 */
export function normalizeFirecrawlCredits(json) {
  const d = json?.data && typeof json.data === 'object' ? json.data : json;
  const remaining = Number(d?.remainingCredits ?? d?.remaining_credits);
  if (!Number.isFinite(remaining)) throw new WebError(CODES.MALFORMED, 'firecrawl', 'credit-usage response has no remainingCredits');
  const plan = Number(d?.planCredits ?? d?.plan_credits);
  return {
    remaining,
    planCredits: Number.isFinite(plan) ? plan : null,
    periodStart: typeof d?.billingPeriodStart === 'string' ? d.billingPeriodStart : null,
    periodEnd: typeof d?.billingPeriodEnd === 'string' ? d.billingPeriodEnd : null,
  };
}

/** @param {any} ctx */
export async function firecrawlCredits(ctx) {
  const json = await ctx.fetchJson(`${BASE}/v2/team/credit-usage`, { method: 'GET', headers: headers(ctx), timeoutMs: 10_000 });
  return normalizeFirecrawlCredits(json);
}
