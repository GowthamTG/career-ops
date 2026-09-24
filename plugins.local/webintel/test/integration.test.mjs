// Integration tests: the fetchPages chain, searchWeb caching, budget stops, the
// provider hook, and the engine API this plugin depends on. Mocked ctx.fetch, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'fs';
import path from 'path';
import { createWebIntel } from '../_capabilities.mjs';
import { parseLedger } from '../_budget.mjs';
import { CODES } from '../_errors.mjs';
import * as engine from '../../../plugins/_engine.mjs';
import { clock, fakeCtx, fixture, httpError, offlineDeps, tempDir } from './_helpers.mjs';

const JD = 'We are hiring a senior engineer. '.repeat(30);

function contentsFor(map) {
  // map: url → text | {error: tag, http}
  return (body) => ({
    requestId: 'r',
    results: body.urls.filter((u) => typeof map[u] === 'string').map((u) => ({ id: u, url: u, title: 't', text: map[u] })),
    statuses: body.urls.map((u) => (typeof map[u] === 'string'
      ? { id: u, status: 'success' }
      : { id: u, status: 'error', error: { tag: map[u].error, httpStatusCode: map[u].http } })),
    costDollars: { total: 0.001 * body.urls.length },
  });
}

test('fetchPages: free ATS API short-circuits; no paid call', async () => {
  const ctx = fakeCtx({});
  const wi = createWebIntel({ ctx, dataDir: tempDir(), deps: offlineDeps({ atsFetch: async () => ({ title: 'T', text: JD }) }) });
  const r = await wi.fetchPage('https://boards.greenhouse.io/acme/jobs/1');
  assert.equal(r.doc.source.provider, 'ats-api');
  assert.equal(ctx.calls.length, 0);
});

test('fetchPages: Exa batch, thin page falls to Firecrawl, Exa 404 is NOT paid again on Firecrawl', async () => {
  const good = 'https://careers.good.example/jobs/1';
  const spa = 'https://spa.example/jobs/2';
  const gone = 'https://gone.example/jobs/3';
  const ctx = fakeCtx({
    '/contents': contentsFor({ [good]: JD, [spa]: 'You need to enable JavaScript to run this app.', [gone]: { error: 'CRAWL_NOT_FOUND', http: 404 } }),
    '/v2/team/credit-usage': () => fixture('firecrawl-credits.json'),
    '/v2/scrape': () => fixture('firecrawl-scrape.json'),
  });
  const dataDir = tempDir();
  const wi = createWebIntel({ ctx, dataDir, deps: offlineDeps() });
  const res = await wi.fetchPages([good, spa, gone]);
  assert.equal(res.get(good).doc.source.provider, 'exa');
  assert.equal(res.get(spa).doc.source.provider, 'firecrawl');
  assert.equal(res.get(gone).error.code, CODES.NOT_FOUND);
  const paths = ctx.calls.map((c) => c.path);
  assert.equal(paths.filter((p) => p === '/contents').length, 1, 'one batched Exa call');
  assert.equal(paths.filter((p) => p === '/v2/scrape').length, 1, 'only the thin page hits Firecrawl');

  // Second run: everything from cache (good/spa) or negative cache (gone): zero calls.
  const before = ctx.calls.length;
  const wi2 = createWebIntel({ ctx, dataDir, deps: offlineDeps() });
  const again = await wi2.fetchPages([good, spa, gone]);
  assert.equal(ctx.calls.length, before);
  assert.equal(again.get(good).doc.source.provider, 'cache');
  assert.equal(again.get(good).doc.source.via, 'exa');
  assert.equal(again.get(gone).error.provider, 'cache');

  const ledger = parseLedger(readFileSync(wi.budget.ledgerPath, 'utf8'));
  assert.deepEqual(ledger.map((r) => `${r.provider}:${r.op}`), ['exa:contents', 'firecrawl:scrape']);
});

test('fetchPages: duplicate URLs cost once; blocked hosts never leave the machine', async () => {
  const u = 'https://careers.good.example/jobs/1';
  const ctx = fakeCtx({ '/contents': contentsFor({ [u]: JD }) });
  const wi = createWebIntel({ ctx, dataDir: tempDir(), deps: offlineDeps() });
  const res = await wi.fetchPages([u, `${u}?utm_source=x`, 'https://www.linkedin.com/jobs/view/9']);
  assert.equal(ctx.calls[0].body.urls.length, 1);
  assert.ok(res.get(`${u}?utm_source=x`).doc);
  assert.equal(res.get('https://www.linkedin.com/jobs/view/9').error.code, CODES.BLOCKED_URL);
});

test('fetchPages: Firecrawl floor stops scraping when the shared pool is low; skipped pages are NOT negative-cached', async () => {
  const spa = 'https://spa.example/jobs/2';
  const ctx = fakeCtx({
    '/contents': contentsFor({ [spa]: 'short' }),
    '/v2/team/credit-usage': () => ({ data: { remainingCredits: 50 } }),
    '/v2/scrape': () => fixture('firecrawl-scrape.json'),
  });
  const dataDir = tempDir();
  const wi = createWebIntel({ ctx, dataDir, deps: offlineDeps() });
  const r = await wi.fetchPage(spa);
  assert.equal(r.doc, null);
  assert.ok(!ctx.calls.some((c) => c.path === '/v2/scrape'));
  // A later run with budget must still be allowed to try it.
  const ctx2 = fakeCtx({ '/contents': contentsFor({ [spa]: 'short' }), '/v2/team/credit-usage': () => fixture('firecrawl-credits.json'), '/v2/scrape': () => fixture('firecrawl-scrape.json') });
  const later = createWebIntel({ ctx: ctx2, dataDir, deps: offlineDeps({ now: clock(Date.now() + 2 * 3600e3) }) });
  assert.ok((await later.fetchPage(spa)).doc);
});

test('fetchPages: Exa 402 latches the provider; per-run page cap defers the rest for free', async () => {
  const dataDir = tempDir();
  const ctx = fakeCtx({ '/contents': () => { throw httpError(402); } }, { EXA_API_KEY: 'k' });
  const wi = createWebIntel({ ctx, dataDir, settings: { max_pages_per_run: 2 }, deps: offlineDeps() });
  const urls = ['https://a.example/1', 'https://a.example/2', 'https://a.example/3'];
  const res = await wi.fetchPages(urls);
  assert.equal(res.get(urls[2]).error.code, CODES.BUDGET_EXHAUSTED);
  assert.equal(ctx.calls.length, 1, '402 is never retried');
  const wi2 = createWebIntel({ ctx, dataDir, deps: offlineDeps() });
  await wi2.fetchPages(['https://a.example/9']);
  assert.equal(ctx.calls.length, 1, 'latched: no further calls');
});

test('searchWeb: cached inside the interval, coalesced when concurrent, per-run cap', async () => {
  const ctx = fakeCtx({ '/search': () => fixture('exa-search.json') });
  const dataDir = tempDir();
  const wi = createWebIntel({ ctx, dataDir, settings: { max_searches_per_run: 2 }, deps: offlineDeps() });
  const [a, b] = await Promise.all([wi.searchWeb('react jobs'), wi.searchWeb('react jobs')]);
  assert.equal(ctx.calls.length, 1);
  assert.equal(a.length, 2);
  assert.deepEqual(a, b);
  await wi.searchWeb('react jobs');
  assert.equal(ctx.calls.length, 1, 'cache hit');
  await wi.searchWeb('go jobs');
  await assert.rejects(wi.searchWeb('python jobs'), (e) => e.code === CODES.BUDGET_EXHAUSTED);
  assert.match(wi.summary(), /exa 2 call\(s\) \$0\.014/);
});

test('searchWeb: exclude list applied client-side when pinned to include_domains', async () => {
  const ctx = fakeCtx({ '/search': () => fixture('exa-search.json') });
  const wi = createWebIntel({ ctx, dataDir: tempDir(), deps: offlineDeps() });
  const hits = await wi.searchWeb('q', { includeDomains: ['apply.workable.com', 'examplecorp.co.in'], excludeDomains: ['examplecorp.co.in'] });
  assert.deepEqual(hits.map((h) => new URL(h.url).hostname), ['apply.workable.com']);
});

test('cacheOnly: never touches the network', async () => {
  const ctx = fakeCtx({ '/contents': contentsFor({}) });
  let ats = 0;
  const wi = createWebIntel({ ctx, dataDir: tempDir(), deps: offlineDeps({ atsFetch: async () => { ats++; return null; } }) });
  const r = await wi.fetchPages(['https://a.example/1'], { cacheOnly: true });
  assert.equal(r.get('https://a.example/1').error.code, CODES.DISABLED);
  assert.equal(ctx.calls.length + ats, 0);
});

test('no keys: DISABLED, zero calls', async () => {
  const ctx = fakeCtx({}, {});
  const wi = createWebIntel({ ctx, dataDir: tempDir(), deps: offlineDeps() });
  await assert.rejects(wi.searchWeb('q'), (e) => e.code === CODES.DISABLED);
  const r = await wi.fetchPage('https://a.example/1');
  assert.equal(r.error.code, CODES.DISABLED);
  assert.equal(ctx.calls.length, 0);
});

test('provider hook: maps hits to Jobs, drops free-ATS/denied hosts, never throws', async () => {
  const { default: hooks } = await import('../index.mjs');
  const dataDir = tempDir();
  process.env.CAREER_OPS_ROOT = dataDir; // keep ledger/cache/board candidates out of the real data/
  try {
    const search = fixture('exa-search.json');
    search.results.push({ id: 'g', url: 'https://job-boards.greenhouse.io/acme/jobs/1', title: 'Engineer' });
    const ctx = fakeCtx({ '/search': () => search });
    const jobs = await hooks.provider.fetch({ name: 'Web discovery test', query: 'react jobs india' }, ctx);
    assert.deepEqual(jobs.map((j) => j.company), ['Acme Labs', 'Examplecorp']);
    assert.equal(jobs[0].title, 'Senior Frontend Engineer');
    const board = readFileSync(`${dataDir}/data/webintel-board-candidates.tsv`, 'utf8');
    assert.match(board, /workable\tacme-labs/);

    const broken = fakeCtx({ '/search': () => { throw httpError(500); } });
    assert.deepEqual(await hooks.provider.fetch({ name: 'x', query: 'other query' }, broken), []);
  } finally {
    delete process.env.CAREER_OPS_ROOT;
  }
});

test('engine API pin: the exports this plugin relies on still exist', () => {
  for (const fn of ['loadPlugins', 'loadDotenvOnce', 'buildCtx', 'mergeProviderPlugins', 'validateManifest']) {
    assert.equal(typeof engine[fn], 'function', fn);
  }
  const manifest = JSON.parse(readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  const dir = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
  assert.ok(engine.validateManifest(manifest, dir, 'webintel'), 'manifest passes engine validation');
});

test('engine: loads only when enabled + keyed; ctx is scoped and pinned to the two API hosts', async () => {
  const root = tempDir();
  const src = new URL('..', import.meta.url).pathname;
  cpSync(src, path.join(root, 'plugins.local', 'webintel'), { recursive: true, filter: (f) => !f.includes(`${path.sep}test`) });
  mkdirSync(path.join(root, 'plugins'), { recursive: true });
  mkdirSync(path.join(root, 'config'), { recursive: true });
  // The plugin imports a few core modules relative to the repo root.
  const repo = new URL('../../../', import.meta.url).pathname;
  // providers/ for _postparse.mjs's reuse of telegram-channel.mjs applicationLink().
  for (const f of ['path-resolver.mjs', 'url-key.mjs', 'plugins/_net.mjs', 'providers']) symlinkSync(path.join(repo, f), path.join(root, f));
  const cfg = path.join(root, 'config', 'plugins.yml');
  const saved = { ...process.env };
  try {
    writeFileSync(cfg, 'plugins:\n  webintel:\n    enabled: false\n');
    process.env.EXA_API_KEY = 'exa-test-key';
    assert.equal((await engine.loadPlugins('provider', { root, pluginId: 'webintel' })).length, 0, 'disabled → not loaded');

    writeFileSync(cfg, 'plugins:\n  webintel:\n    enabled: true\n    exa_monthly_usd: 1\n');
    delete process.env.EXA_API_KEY;
    assert.equal((await engine.loadPlugins('provider', { root, pluginId: 'webintel' })).length, 0, 'no key → not loaded');

    process.env.EXA_API_KEY = 'exa-test-key';
    process.env.GEMINI_API_KEY = 'must-not-leak';
    const [p] = await engine.loadPlugins('provider', { root, pluginId: 'webintel' });
    assert.ok(p, 'enabled + keyed → loaded');
    assert.deepEqual(Object.keys(p.ctx.env), ['EXA_API_KEY']);
    assert.equal(p.ctx.settings.exa_monthly_usd, 1);
    await assert.rejects(p.ctx.fetch('https://example.com/'), /not in allowedHosts/);
    await assert.rejects(p.ctx.fetch('http://api.exa.ai/search'), /HTTPS/);
  } finally {
    for (const k of ['EXA_API_KEY', 'GEMINI_API_KEY']) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  }
});
