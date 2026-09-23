// Contract tests: vendor JSON → internal types. These are the ONLY tests that
// change when a provider is swapped. Fixtures follow the documented shapes
// (exa.ai/docs, docs.firecrawl.dev, checked 2026-09-22); replace them with
// recorded responses after the first live smoke run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExaSearch, normalizeExaContents, exaSearch, exaContents } from '../_exa.mjs';
import { normalizeFirecrawlScrape, normalizeFirecrawlCredits, firecrawlScrape } from '../_firecrawl.mjs';
import { CODES } from '../_errors.mjs';
import { fixture, fakeCtx, httpError } from './_helpers.mjs';

test('exa search: maps results, drops non-http URLs, reads costDollars', () => {
  const r = normalizeExaSearch(fixture('exa-search.json'), '2026-09-22T00:00:00.000Z');
  assert.equal(r.hits.length, 2);
  assert.equal(r.costUsd, 0.007);
  assert.equal(r.requestId, 'req_search_1');
  assert.deepEqual(Object.keys(r.hits[0]).sort(), ['publishedAt', 'snippet', 'source', 'title', 'url']);
  assert.equal(r.hits[1].publishedAt, null);
});

test('exa search: malformed and empty', () => {
  assert.throws(() => normalizeExaSearch({ nope: 1 }, 'x'), (e) => e.code === CODES.MALFORMED);
  assert.deepEqual(normalizeExaSearch({ results: [] }, 'x').hits, []);
});

test('exa search: request is cost-safe (≤10 results, no contents, include XOR exclude)', async () => {
  const ctx = fakeCtx({ '/search': () => fixture('exa-search.json') });
  await exaSearch(ctx, { query: 'q', numResults: 50, includeDomains: ['apply.workable.com'], excludeDomains: ['linkedin.com'] });
  const { body, headers } = ctx.calls[0];
  assert.equal(body.numResults, 10);
  assert.deepEqual(body.contents, { text: false });
  assert.equal(body.type, 'auto');
  assert.deepEqual(body.includeDomains, ['apply.workable.com']);
  assert.equal(body.excludeDomains, undefined);
  assert.equal(headers['x-api-key'], 'exa-test-key');
});

test('exa contents: partial success mapped per requested URL', () => {
  const urls = ['https://careers.good.example/jobs/1', 'https://spa.example/jobs/2', 'https://gone.example/jobs/3', 'https://slow.example/jobs/4'];
  const r = normalizeExaContents(fixture('exa-contents.json'), urls);
  assert.equal(r.docs.size, 2);
  assert.equal(r.errors.get('https://gone.example/jobs/3').code, CODES.NOT_FOUND);
  assert.equal(r.errors.get('https://gone.example/jobs/3').httpStatus, 404);
  assert.equal(r.errors.get('https://slow.example/jobs/4').code, CODES.TIMEOUT);
  assert.equal(r.costUsd, 0.002);
});

test('exa contents: text-only request, batch cap enforced', async () => {
  const ctx = fakeCtx({ '/contents': () => fixture('exa-contents.json') });
  await exaContents(ctx, ['https://careers.good.example/jobs/1'], { maxCharacters: 20000 });
  assert.deepEqual(Object.keys(ctx.calls[0].body).sort(), ['text', 'urls']);
  await assert.rejects(exaContents(ctx, Array.from({ length: 26 }, (_, i) => `https://a.example/${i}`), { maxCharacters: 1 }), (e) => e.code === CODES.BAD_REQUEST);
});

test('firecrawl scrape: success, charged 404, malformed', () => {
  const ok = normalizeFirecrawlScrape(fixture('firecrawl-scrape.json'), 'https://spa.example/jobs/2');
  assert.equal(ok.error, null);
  assert.equal(ok.credits, 1);
  assert.match(ok.doc.text, /Senior Frontend Engineer/);
  const dead = normalizeFirecrawlScrape(fixture('firecrawl-scrape-404.json'), 'https://dead.example/x');
  assert.equal(dead.doc, null);
  assert.equal(dead.error.code, CODES.NOT_FOUND);
  assert.equal(dead.credits, 1, 'a 404 page still costs a credit');
  assert.equal(normalizeFirecrawlScrape({ success: false }, 'u').error.code, CODES.MALFORMED);
});

test('firecrawl scrape: request is the cheapest form; 403 site refusal is NOT_FOUND, 402 throws', async () => {
  const ctx = fakeCtx({ '/v2/scrape': () => fixture('firecrawl-scrape.json') });
  await firecrawlScrape(ctx, 'https://spa.example/jobs/2', { sleep: async () => {} });
  const { body, headers } = ctx.calls[0];
  assert.deepEqual(body.formats, ['markdown']);
  assert.equal(body.onlyMainContent, true);
  assert.equal(body.proxy, 'basic');
  assert.equal(headers.authorization, 'Bearer fc-test-key');

  const refused = fakeCtx({ '/v2/scrape': () => { throw Object.assign(new Error('HTTP 403: This website is not supported'), { status: 403 }); } });
  const r = await firecrawlScrape(refused, 'https://x.example/', { sleep: async () => {} });
  assert.equal(r.error.code, CODES.NOT_FOUND);

  const broke = fakeCtx({ '/v2/scrape': () => { throw httpError(402); } });
  await assert.rejects(firecrawlScrape(broke, 'https://x.example/', { sleep: async () => {} }), (e) => e.code === CODES.QUOTA_402);
});

test('firecrawl credits: reads data envelope or bare object', () => {
  const r = normalizeFirecrawlCredits(fixture('firecrawl-credits.json'));
  assert.equal(r.remaining, 1385);
  assert.equal(r.periodEnd, '2026-10-03T05:54:25.041Z');
  assert.equal(normalizeFirecrawlCredits({ remainingCredits: 5 }).remaining, 5);
  assert.throws(() => normalizeFirecrawlCredits({}), (e) => e.code === CODES.MALFORMED);
});

// ── Recorded real responses (Phase 0 spike, 2026-09-22) ─────────────────────
// Captured from the live APIs with the free-tier keys; no secrets in the bodies.

test('recorded exa /search: real response maps cleanly (path-prefixed includeDomains honored)', () => {
  const r = normalizeExaSearch(fixture('recorded-exa-search.json'), 'x');
  assert.ok(r.hits.length >= 1);
  assert.ok(r.hits.every((h) => h.url.startsWith('https://jobs.smartrecruiters.com/Freshworks/')));
  assert.equal(r.costUsd, 0.007);
  assert.match(r.requestId, /^[0-9a-f]{32}$/);
});

test('recorded exa /contents: success + real 404 status (charged per successful page)', () => {
  const urls = ['https://en.wikipedia.org/wiki/Job_description', 'https://example.com/this-page-does-not-exist-xyz'];
  const r = normalizeExaContents(fixture('recorded-exa-contents.json'), urls);
  assert.equal(r.docs.size, 1);
  assert.ok(r.docs.get(urls[0]).text.length > 100);
  const dead = r.errors.get(urls[1]);
  assert.equal(dead.code, CODES.NOT_FOUND);
  assert.equal(dead.httpStatus, 404);
  assert.equal(r.costUsd, 0.001);
});

test('recorded firecrawl /v2/scrape: real response, basic proxy costs 1 credit even on a cache hit', () => {
  const json = fixture('recorded-firecrawl-scrape.json');
  const r = normalizeFirecrawlScrape(json, 'https://example.com/');
  assert.equal(r.error, null);
  assert.equal(r.credits, 1);
  assert.equal(r.statusCode, 200);
  assert.match(r.doc.text, /Example Domain/);
  assert.equal(json.data.metadata.proxyUsed, 'basic');
});
