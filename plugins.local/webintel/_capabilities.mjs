// @ts-check
// plugins.local/webintel/_capabilities.mjs: the two operations callers use.
//
//   searchWeb(query, opts)  → SearchHit[]              (Exa only)
//   fetchPages(urls, opts)  → Map<url, {doc, error}>   (cache → free ATS API → Exa /contents → Firecrawl)
//
// Callers never see vendor JSON (only _exa.mjs / _firecrawl.mjs do). Every paid
// call is budget-checked BEFORE it's made (_budget.mjs); results are cached
// (_cache.mjs); dead URLs are negative-cached so a charged 403/404 is paid at
// most once a week. Nothing here reports whether a posting is LIVE: page text
// may come from a provider cache, and liveness stays a browser-only check.
//
// Types (vendor-free):
//   SearchHit   { url, title|null, publishedAt|null, snippet|null, source:{provider:'exa', requestId, retrievedAt} }
//   WebDocument { url, finalUrl, title|null, text, contentType:'text/plain', chars, truncated,
//                 source:{provider:'ats-api'|'exa'|'firecrawl'|'cache', via?, retrievedAt, cacheAgeHours|null, requestId|null} }

import path from 'path';
import { CODES, NEGATIVE_CACHEABLE, WebError, classifyHttpError } from './_errors.mjs';
import { createBudget, ESTIMATE } from './_budget.mjs';
import { createCache, TTL } from './_cache.mjs';
import { vetTargetUrl, hostInList, isSocialHit } from './_policy.mjs';
import { exaSearch, exaContents, MAX_BATCH, MAX_RESULTS } from './_exa.mjs';
import { firecrawlScrape, firecrawlCredits } from './_firecrawl.mjs';

export const DEFAULT_MAX_CHARS = 20_000;   // same cap as fetch-jd.mjs
const FIRECRAWL_SPACING_MS = 6_500;        // 10 scrapes/min on the free plan
const BREAKER_THRESHOLD = 3;               // consecutive failures → provider off for the rest of the run
const THIN_CHARS = 400;

/** Markdown/HTML → readable plain text. Web text is untrusted data; we keep words only. @param {string} s */
export function toPlainText(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')          // images
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')        // links → their text
    .replace(/<[^>]+>/g, ' ')                       // stray tags
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** A JS shell or error page, not a job description. @param {string} text */
export function isThin(text) {
  const t = String(text || '');
  if (t.length < THIN_CHARS) return true;
  return t.length < 2000 && /(enable|turn on|requires?) javascript|javascript is (disabled|required)|you need to enable/i.test(t);
}

/**
 * @param {{ ctx: any, dataDir: string, settings?: object, caller?: string,
 *           deps?: { now?: () => number, sleep?: (ms: number) => Promise<void>, resolve?: (h: string) => Promise<unknown>,
 *                    atsFetch?: (url: string, cap: number) => Promise<{title?: string|null, text: string}|null>,
 *                    exaSearch?: typeof exaSearch, exaContents?: typeof exaContents,
 *                    firecrawlScrape?: typeof firecrawlScrape, firecrawlCredits?: typeof firecrawlCredits } }} opts
 */
export function createWebIntel({ ctx, dataDir, settings = {}, caller = 'cli', deps = {} }) {
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const api = {
    exaSearch: deps.exaSearch || exaSearch,
    exaContents: deps.exaContents || exaContents,
    firecrawlScrape: deps.firecrawlScrape || firecrawlScrape,
    firecrawlCredits: deps.firecrawlCredits || firecrawlCredits,
  };
  const atsFetch = deps.atsFetch || defaultAtsFetch;
  const budget = createBudget({ dataDir, settings, now, caller });
  const cache = createCache({ dir: path.join(dataDir, '.webintel-cache'), now });
  const has = { exa: Boolean(ctx?.env?.EXA_API_KEY), firecrawl: Boolean(ctx?.env?.FIRECRAWL_API_KEY) };

  const failures = { exa: 0, firecrawl: 0 };
  const tripped = { exa: false, firecrawl: false };
  const stats = {
    exa: { calls: 0, usd: 0 }, firecrawl: { calls: 0, credits: 0 },
    cacheHit: 0, cacheMiss: 0, neg: 0, free: 0, thinToFirecrawl: 0, retries: 0, unresolved: 0,
    /** @type {Record<string, number>} */ errors: {},
  };
  const runCount = { searches: 0, socialSearches: 0, pages: 0 };
  /** @type {Map<string, Promise<any>>} */
  const inflight = new Map();
  const warned = new Set();
  let lastFirecrawlAt = 0;
  let balanceChecked = false;
  const onRetry = () => { stats.retries++; };

  /** @param {string} msg */
  function warnOnce(msg) {
    if (warned.has(msg)) return;
    warned.add(msg);
    console.warn(`⚠️  webintel: ${msg}`);
  }

  /** @param {'exa'|'firecrawl'} provider */
  function available(provider) {
    if (!has[provider]) return new WebError(CODES.DISABLED, provider, `${provider === 'exa' ? 'EXA_API_KEY' : 'FIRECRAWL_API_KEY'} not set`);
    if (tripped[provider]) return new WebError(CODES.DISABLED, provider, 'paused for this run after repeated failures');
    return null;
  }

  /** @param {'exa'|'firecrawl'} provider @param {WebError} err @param {string} op @param {string} [url] */
  function onFailure(provider, err, op, url) {
    stats.errors[err.code] = (stats.errors[err.code] || 0) + 1;
    if (err.code === CODES.BUDGET_EXHAUSTED) { warnOnce(err.message); return; }
    if (err.code === CODES.QUOTA_402) {
      const until = budget.latch(provider);
      warnOnce(`${provider} free credits exhausted; paused until ${new Date(until).toISOString().slice(0, 10)} (no paid fallback)`);
      tripped[provider] = true;
    }
    if (err.code === CODES.AUTH) { warnOnce(`${provider} rejected the API key; check .env`); tripped[provider] = true; }
    budget.record({ provider, op, units: 0, outcome: err.code, requestId: err.requestId, url });
    if (++failures[provider] >= BREAKER_THRESHOLD && !tripped[provider]) {
      tripped[provider] = true;
      warnOnce(`${provider} failed ${BREAKER_THRESHOLD} times in a row; skipping it for the rest of this run`);
    }
  }

  /** @param {'exa'|'firecrawl'} provider */
  const onSuccess = (provider) => { failures[provider] = 0; };

  // ── searchWeb ─────────────────────────────────────────────────────────────

  /**
   * @param {string} query
   * @param {{ numResults?: number, includeDomains?: string[], excludeDomains?: string[],
   *           publishedWithinDays?: number|null, cacheTtlMs?: number, cacheOnly?: boolean,
   *           social?: boolean, textMaxChars?: number }} [opts]
   *   cacheOnly = answer from cache or throw DISABLED; never spend (dry runs)
   *   social = social-post search: every include domain must be a social permalink
   *            prefix, hits that are not social permalinks are dropped, and the
   *            separate max_social_searches_per_run cap applies
   *   textMaxChars = also return each hit's text from the index (capped)
   */
  async function searchWeb(query, opts = {}) {
    const social = Boolean(opts.social);
    const q = {
      query: String(query || '').trim(),
      numResults: Math.min(MAX_RESULTS, opts.numResults ?? MAX_RESULTS),
      includeDomains: opts.includeDomains || [],
      excludeDomains: opts.excludeDomains || [],
      publishedWithinDays: opts.publishedWithinDays ?? null,
      ...(opts.textMaxChars ? { textMaxChars: opts.textMaxChars } : {}),
      ...(social ? { social: true } : {}),
    };
    if (social && (!q.includeDomains.length || !q.includeDomains.every((d) => isSocialHit(`https://${d}/x`)))) {
      throw new WebError(CODES.BAD_REQUEST, 'exa', 'social search must be pinned to social post domains (SOCIAL_SEARCH_HOSTS)');
    }
    if (!q.query) throw new WebError(CODES.BAD_REQUEST, 'exa', 'empty query');
    const key = JSON.stringify(q);
    const hit = cache.get('search', key, opts.cacheTtlMs ?? TTL.search);
    if (hit) { stats.cacheHit++; return hit.value; }
    if (opts.cacheOnly) throw new WebError(CODES.DISABLED, 'cache', 'not cached (cache-only / dry run)');
    if (inflight.has(key)) return inflight.get(key);

    const p = (async () => {
      stats.cacheMiss++;
      const off = available('exa');
      if (off) throw off;
      if (runCount.searches >= budget.settings.max_searches_per_run) {
        throw new WebError(CODES.BUDGET_EXHAUSTED, 'exa', `per-run search cap (${budget.settings.max_searches_per_run}) reached; the rest wait for the next run`);
      }
      if (social && runCount.socialSearches >= budget.settings.max_social_searches_per_run) {
        throw new WebError(CODES.BUDGET_EXHAUSTED, 'exa', `per-run social search cap (${budget.settings.max_social_searches_per_run}) reached; the rest wait for the next run`);
      }
      const estimate = ESTIMATE.exaSearchUsd + (q.textMaxChars ? ESTIMATE.exaPageUsd * q.numResults : 0);
      budget.check('exa', { usd: estimate });
      runCount.searches++;
      if (social) runCount.socialSearches++;
      const startPublishedDate = q.publishedWithinDays ? new Date(now() - q.publishedWithinDays * 86_400_000).toISOString() : null;
      let res;
      try {
        const { social: _s, ...req } = q;
        res = await api.exaSearch(ctx, { ...req, startPublishedDate }, { sleep, now, onRetry });
      } catch (raw) {
        const err = classifyHttpError(raw, 'exa');
        onFailure('exa', err, 'search');
        throw err;
      }
      onSuccess('exa');
      const cost = res.costUsd ?? estimate;
      stats.exa.calls++; stats.exa.usd += cost;
      budget.record({ provider: 'exa', op: social ? 'search-social' : 'search', units: 1, costUsd: cost, requestId: res.requestId });
      // When the search was pinned to includeDomains, apply the exclude list here.
      // Social mode keeps only post permalinks (never a profile, company or jobs page).
      const hits = res.hits
        .filter((h) => !(q.includeDomains.length && q.excludeDomains.length && hostInList(new URL(h.url).hostname, q.excludeDomains)))
        .filter((h) => !social || isSocialHit(h.url));
      cache.put('search', key, hits);
      return hits;
    })();
    inflight.set(key, p);
    try { return await p; } finally { inflight.delete(key); }
  }

  // ── fetchPages ────────────────────────────────────────────────────────────

  /**
   * @param {{ url: string, finalUrl?: string, title?: string|null, text: string }} raw
   * @param {string} provider
   * @param {{ requestId?: string|null, maxChars: number, via?: string }} o
   */
  function toDoc(raw, provider, o) {
    const plain = toPlainText(raw.text);
    const truncated = plain.length > o.maxChars;
    const text = truncated ? plain.slice(0, o.maxChars) : plain;
    return {
      url: raw.url, finalUrl: raw.finalUrl || raw.url, title: raw.title ?? null, text,
      contentType: 'text/plain', chars: text.length, truncated,
      source: { provider, retrievedAt: new Date(now()).toISOString(), cacheAgeHours: null, requestId: o.requestId ?? null },
    };
  }

  /**
   * @param {string[]} urls
   * @param {{ maxChars?: number, limit?: number, cacheOnly?: boolean }} [opts]
   *   limit = max pages that may reach a PAID provider this call; cacheOnly = never touch the network (dry runs)
   * @returns {Promise<Map<string, { doc: any, error: WebError|null }>>}
   */
  async function fetchPages(urls, opts = {}) {
    const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    /** @type {Map<string, { doc: any, error: WebError|null }>} */
    const out = new Map();
    /** @type {Array<{ input: string, url: string, lastErr: WebError|null }>} */
    let work = [];
    const seen = new Map(); // canonical url → first input, so duplicates cost once

    for (const input of [...new Set(urls)]) {
      let url;
      try {
        url = await vetTargetUrl(input, deps.resolve ? { resolve: deps.resolve } : {});
      } catch (err) {
        out.set(input, { doc: null, error: /** @type {WebError} */ (err) });
        continue;
      }
      if (seen.has(url)) { seen.get(url).dupes.push(input); continue; }
      const neg = cache.get('neg', url, TTL.neg);
      if (neg) {
        stats.neg++;
        out.set(input, { doc: null, error: new WebError(neg.value.code, 'cache', `known-bad URL (${neg.value.reason})`) });
        continue;
      }
      const c = cache.get('content', url, TTL.content);
      if (c) {
        stats.cacheHit++;
        out.set(input, { doc: { ...c.value, source: { ...c.value.source, via: c.value.source.provider, provider: 'cache', cacheAgeHours: Math.round(c.ageMs / 3_600_000) } }, error: null });
        continue;
      }
      stats.cacheMiss++;
      const item = { input, url, lastErr: null, dupes: [] };
      seen.set(url, item);
      work.push(item);
    }

    if (opts.cacheOnly) {
      for (const item of work) out.set(item.input, { doc: null, error: new WebError(CODES.DISABLED, 'cache', 'not cached (cache-only / dry run)') });
      work = [];
    }

    /** @param {{ input: string, url: string }} item @param {any} doc */
    const succeed = (item, doc) => {
      cache.put('content', item.url, doc);
      out.set(item.input, { doc, error: null });
    };

    // 1. Free: the ATS's own public API (Greenhouse/Lever/Ashby/Workday).
    const afterAts = [];
    for (const item of work) {
      let r = null;
      try { r = await atsFetch(item.url, maxChars); } catch { r = null; }
      if (r?.text && !isThin(r.text)) {
        stats.free++;
        succeed(item, toDoc({ url: item.url, title: r.title ?? null, text: r.text }, 'ats-api', { maxChars }));
      } else afterAts.push(item);
    }
    work = afterAts;

    // Per-run page cap: anything past it waits for the next run (costs nothing).
    const pageCap = Math.max(0, Math.min(opts.limit ?? Infinity, budget.settings.max_pages_per_run - runCount.pages));
    for (const item of work.slice(pageCap)) {
      out.set(item.input, { doc: null, error: new WebError(CODES.BUDGET_EXHAUSTED, 'budget', 'per-run page cap reached; retry next run') });
    }
    work = work.slice(0, pageCap);
    runCount.pages += work.length;

    // 2. Exa /contents, batched (one call for up to 25 URLs, ~$0.001/page).
    /** @type {typeof work} */
    const toFirecrawl = [];
    let exaOff = available('exa');
    for (let i = 0; i < work.length; i += MAX_BATCH) {
      const chunk = work.slice(i, i + MAX_BATCH);
      if (exaOff) { for (const it of chunk) { it.lastErr = exaOff; toFirecrawl.push(it); } continue; }
      try {
        budget.check('exa', { usd: ESTIMATE.exaPageUsd * chunk.length });
      } catch (err) {
        exaOff = /** @type {WebError} */ (err);
        onFailure('exa', exaOff, 'contents');
        for (const it of chunk) { it.lastErr = exaOff; toFirecrawl.push(it); }
        continue;
      }
      let res;
      try {
        res = await api.exaContents(ctx, chunk.map((it) => it.url), { maxCharacters: maxChars }, { sleep, onRetry });
      } catch (raw) {
        const err = classifyHttpError(raw, 'exa');
        onFailure('exa', err, 'contents');
        if (tripped.exa) exaOff = err;
        for (const it of chunk) { it.lastErr = err; toFirecrawl.push(it); }
        continue;
      }
      onSuccess('exa');
      const cost = res.costUsd ?? ESTIMATE.exaPageUsd * chunk.length;
      stats.exa.calls++; stats.exa.usd += cost;
      budget.record({ provider: 'exa', op: 'contents', units: chunk.length, costUsd: cost, requestId: res.requestId });
      for (const it of chunk) {
        const d = res.docs.get(it.url);
        if (d && !isThin(toPlainText(d.text))) {
          succeed(it, toDoc({ url: it.url, finalUrl: d.finalUrl, title: d.title, text: d.text }, 'exa', { maxChars, requestId: res.requestId }));
          continue;
        }
        it.lastErr = d ? new WebError(CODES.THIN_CONTENT, 'exa', 'page text too short (JS shell?)') : (res.errors.get(it.url) || new WebError(CODES.MALFORMED, 'exa', 'missing'));
        if (d) stats.thinToFirecrawl++;
        toFirecrawl.push(it);
      }
    }

    // 3. Firecrawl scrape, serially and spaced (JS rendering; 1 credit each, even for 403/404).
    for (const it of toFirecrawl) {
      const e = it.lastErr;
      // Exa already saw a hard 404/410: that page is gone; don't pay Firecrawl to confirm it.
      const deadAlready = e?.code === CODES.NOT_FOUND && (e.httpStatus === 404 || e.httpStatus === 410);
      const fcOff = deadAlready ? e : available('firecrawl');
      if (fcOff) { finish(it, e || fcOff, deadAlready); continue; }
      try {
        if (!balanceChecked) {
          balanceChecked = true;
          const bal = await budget.firecrawlBalance(() => api.firecrawlCredits(ctx));
          budget.checkFirecrawlFloor(bal);
        }
        budget.check('firecrawl', { credits: ESTIMATE.firecrawlScrapeCredits });
      } catch (err) {
        const w = /** @type {WebError} */ (err);
        onFailure('firecrawl', w, 'scrape');
        tripped.firecrawl = true; // no more Firecrawl this run once the budget says stop
        finish(it, e || w, false);
        continue;
      }
      const wait = lastFirecrawlAt + FIRECRAWL_SPACING_MS - now();
      if (lastFirecrawlAt && wait > 0) await sleep(wait);
      lastFirecrawlAt = now();
      let r;
      try {
        r = await api.firecrawlScrape(ctx, it.url, { sleep, onRetry });
      } catch (raw) {
        const err = classifyHttpError(raw, 'firecrawl');
        onFailure('firecrawl', err, 'scrape', it.url);
        finish(it, err, false);
        continue;
      }
      stats.firecrawl.calls++; stats.firecrawl.credits += r.credits;
      budget.record({ provider: 'firecrawl', op: 'scrape', units: 1, credits: r.credits, outcome: r.error ? r.error.code : 'ok', url: it.url });
      if (r.doc && !isThin(toPlainText(r.doc.text))) {
        onSuccess('firecrawl');
        succeed(it, toDoc({ url: it.url, finalUrl: r.doc.finalUrl, title: r.doc.title, text: r.doc.text }, 'firecrawl', { maxChars }));
      } else {
        if (r.error?.code === CODES.MALFORMED) failures.firecrawl++;
        finish(it, r.error || new WebError(CODES.THIN_CONTENT, 'firecrawl', 'page text too short (JS shell?)'), true);
      }
    }

    // Duplicate inputs share their canonical twin's outcome.
    for (const item of seen.values()) {
      const r = out.get(item.input);
      for (const d of item.dupes) if (r) out.set(d, r);
    }
    return out;

    /**
     * Record a URL no provider could read. Negative-cache it only when the
     * verdict is definitive (Firecrawl, the last resort, actually ran, or Exa saw
     * a hard 404/410), never when a provider was merely skipped for budget.
     * @param {{ input: string, url: string }} item @param {WebError} err @param {boolean} definitive
     */
    function finish(item, err, definitive) {
      stats.unresolved++;
      if (definitive && NEGATIVE_CACHEABLE.has(err.code)) cache.put('neg', item.url, { code: err.code, reason: err.message.slice(0, 160) });
      out.set(item.input, { doc: null, error: err });
    }
  }

  /** @param {string} url @param {{ maxChars?: number }} [opts] */
  async function fetchPage(url, opts = {}) {
    return (await fetchPages([url], opts)).get(url) || { doc: null, error: new WebError(CODES.BLOCKED_URL, 'policy', 'no result') };
  }

  function summary() {
    const errs = Object.entries(stats.errors).map(([k, v]) => `${k}×${v}`).join(', ') || 'none';
    return `webintel[${caller}]: exa ${stats.exa.calls} call(s) $${stats.exa.usd.toFixed(3)} | firecrawl ${stats.firecrawl.credits} credit(s)`
      + ` | free ATS ${stats.free} | cache ${stats.cacheHit} hit / ${stats.cacheMiss} miss / ${stats.neg} known-bad`
      + ` | thin→firecrawl ${stats.thinToFirecrawl} | unresolved ${stats.unresolved} | retries ${stats.retries} | errors: ${errs}`;
  }

  /** Firecrawl's server-side balance (free call; includes chat/MCP usage). @param {{ force?: boolean }} [o] */
  async function balance(o = {}) {
    if (!has.firecrawl) return null;
    return budget.firecrawlBalance(() => api.firecrawlCredits(ctx), o);
  }

  return { searchWeb, fetchPages, fetchPage, balance, summary, stats, budget, cache, has };
}

/** @param {string} url @param {number} cap */
async function defaultAtsFetch(url, cap) {
  const { fetchJdViaKnownApi } = await import('../../browser-extract.mjs');
  const r = await fetchJdViaKnownApi(url, cap, 15_000);
  return r ? { title: r.title ?? null, text: r.text } : null;
}
