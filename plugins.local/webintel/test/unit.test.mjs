// Unit tests: URL policy, budget/ledger/latch, cache, retry, job mapping. Offline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { vetTargetUrl, canonicalUrl, hostMatches } from '../_policy.mjs';
import { createBudget, parseLedger } from '../_budget.mjs';
import { createCache } from '../_cache.mjs';
import { withRetry } from '../_retry.mjs';
import { CODES, WebError, classifyHttpError } from '../_errors.mjs';
import { companyFromUrl, cleanTitle, hitToJob, boardOf, splitTitleCompany } from '../_jobs.mjs';
import { isThin, toPlainText } from '../_capabilities.mjs';
import { tightenOnly } from '../_load.mjs';
import { clock, tempDir, httpError } from './_helpers.mjs';

const okResolve = async () => ['93.184.216.34'];

test('policy: strips credentials/tracking and keeps functional params', () => {
  const u = canonicalUrl('http://user:pw@Jobs.Example.com/p/1/?utm_source=x&token=abc&gh_jid=7#frag');
  assert.equal(u, 'https://jobs.example.com/p/1?gh_jid=7');
});

test('policy: deny list, bad scheme, bare host and SSRF are BLOCKED_URL', async () => {
  for (const bad of ['https://www.linkedin.com/jobs/view/1', 'ftp://x.example/a', 'https://intranet/a', 'not a url']) {
    await assert.rejects(vetTargetUrl(bad, { resolve: okResolve }), (e) => e.code === CODES.BLOCKED_URL, bad);
  }
  const ssrf = async () => { throw new Error('resolves to a blocked address (10.0.0.5)'); };
  await assert.rejects(vetTargetUrl('https://evil.example/x', { resolve: ssrf }), (e) => e.code === CODES.BLOCKED_URL);
  assert.equal(await vetTargetUrl('https://careers.acme.io/jobs/1', { resolve: okResolve }), 'https://careers.acme.io/jobs/1');
  assert.ok(hostMatches('in.linkedin.com', 'linkedin.com'));
  assert.ok(!hostMatches('notlinkedin.com', 'linkedin.com'));
});

test('budget: cap blocks before spending; ledger totals by month', () => {
  const dir = tempDir();
  const now = clock();
  const b = createBudget({ dataDir: dir, settings: { exa_monthly_usd: 0.01, firecrawl_monthly_credits: 2 }, now });
  b.check('exa', { usd: 0.007 });
  b.record({ provider: 'exa', op: 'search', costUsd: 0.007 });
  assert.throws(() => b.check('exa', { usd: 0.007 }), (e) => e.code === CODES.BUDGET_EXHAUSTED);
  b.record({ provider: 'firecrawl', op: 'scrape', credits: 2 });
  assert.throws(() => b.check('firecrawl', { credits: 1 }), (e) => e.code === CODES.BUDGET_EXHAUSTED);
  // Next month: spend resets.
  now.advance(31 * 24 * 3600 * 1000);
  b.check('exa', { usd: 0.007 });
  const rows = parseLedger(readFileSync(b.ledgerPath, 'utf8'));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].provider, 'exa');
});

test('budget: settings cannot disable a cap with a non-number', () => {
  const b = createBudget({ dataDir: tempDir(), settings: { exa_monthly_usd: 'lots', firecrawl_monthly_credits: -5 } });
  assert.equal(b.settings.exa_monthly_usd, 4);
  assert.equal(b.settings.firecrawl_monthly_credits, 250);
});

test('budget: 402 latch short-circuits until it expires; firecrawl latch uses period end', async () => {
  const dir = tempDir();
  const now = clock();
  const b = createBudget({ dataDir: dir, now });
  b.latch('exa');
  assert.throws(() => b.check('exa', {}), (e) => e.code === CODES.QUOTA_402);
  now.advance(25 * 3600 * 1000);
  b.check('exa', {});
  await b.firecrawlBalance(async () => ({ remaining: 150, periodEnd: '2026-10-03T05:54:25.041Z' }));
  const until = b.latch('firecrawl');
  assert.equal(new Date(until).toISOString(), '2026-10-03T05:54:25.041Z');
});

test('budget: firecrawl floor uses the server balance, cached for an hour, probe failure is non-blocking', async () => {
  const now = clock();
  const b = createBudget({ dataDir: tempDir(), now, settings: { firecrawl_min_remaining: 200 } });
  let probes = 0;
  const low = async () => { probes++; return { remaining: 120 }; };
  const bal = await b.firecrawlBalance(low);
  assert.throws(() => b.checkFirecrawlFloor(bal), (e) => e.code === CODES.BUDGET_EXHAUSTED);
  await b.firecrawlBalance(low);
  assert.equal(probes, 1, 'second probe inside the hour is served from state');
  const fresh = createBudget({ dataDir: tempDir(), now });
  const none = await fresh.firecrawlBalance(async () => { throw new Error('offline'); });
  assert.equal(none, null);
  fresh.checkFirecrawlFloor(none); // does not throw
});

test('cache: TTL, key collision safety, gc', () => {
  const now = clock();
  const dir = tempDir();
  const c = createCache({ dir, now });
  c.put('content', 'https://a.example/1', { text: 'x' });
  assert.deepEqual(c.get('content', 'https://a.example/1', 1000)?.value, { text: 'x' });
  now.advance(2000);
  assert.equal(c.get('content', 'https://a.example/1', 1000), null);
  assert.equal(c.gc({ content: 1000 }), 1);
  assert.ok(!existsSync(path.join(dir, 'content', 'x')));
});

test('retry: 429 twice then ok; 5xx once; 402 and 401 never', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  let n = 0;
  assert.equal(await withRetry(async () => { if (n++ < 2) throw httpError(429); return 'ok'; }, { provider: 'exa', sleep, random: () => 0 }), 'ok');
  assert.deepEqual(sleeps, [2000, 8000]);

  n = 0;
  await assert.rejects(withRetry(async () => { n++; throw httpError(503); }, { provider: 'exa', sleep }), (e) => e.code === CODES.UPSTREAM_5XX);
  assert.equal(n, 2);

  for (const s of [402, 401]) {
    n = 0;
    await assert.rejects(withRetry(async () => { n++; throw httpError(s); }, { provider: 'exa', sleep }));
    assert.equal(n, 1, `HTTP ${s} must not retry`);
  }
});

test('errors: classification', () => {
  assert.equal(classifyHttpError(httpError(402), 'exa').code, CODES.QUOTA_402);
  assert.equal(classifyHttpError(Object.assign(new Error('x'), { name: 'AbortError' }), 'exa').code, CODES.TIMEOUT);
  assert.equal(classifyHttpError(new Error('ECONNRESET'), 'exa').code, CODES.UPSTREAM_5XX);
  assert.equal(new WebError(CODES.RATE_LIMITED, 'exa').retryable, true);
  assert.equal(new WebError(CODES.QUOTA_402, 'exa').retryable, false);
});

test('jobs: company and title derivation', () => {
  assert.equal(companyFromUrl('https://apply.workable.com/acme-labs/j/ABC/'), 'Acme Labs');
  assert.equal(companyFromUrl('https://careers.examplecorp.co.in/jobs/42'), 'Examplecorp');
  assert.equal(companyFromUrl('https://zeta.keka.com/careers/jobdetails/1'), 'Zeta');
  assert.deepEqual(boardOf('https://jobs.smartrecruiters.com/Freshworks/7430'), { vendor: 'smartrecruiters', slug: 'Freshworks' });
  assert.equal(boardOf('https://careers.acme.io/x'), null);
  assert.equal(cleanTitle('Senior Frontend Engineer - Acme Labs', 'Acme Labs'), 'Senior Frontend Engineer');
  assert.equal(cleanTitle('Job Application for Backend Engineer at Zeta', 'Zeta'), 'Backend Engineer');
  assert.equal(cleanTitle('Full Stack Engineer (React/Node) | ExampleCorp Careers', 'Examplecorp'), 'Full Stack Engineer (React/Node)');
  assert.equal(hitToJob({ url: 'https://a.example/x', title: '' }), null);
});

test('text: plain-text conversion and thin detection', () => {
  assert.equal(toPlainText('Hi [Apply](https://x) ![l](y) <b>there</b>'), 'Hi Apply there');
  assert.ok(isThin('You need to enable JavaScript to run this app.'));
  assert.ok(!isThin('x'.repeat(500)));
});

test('load: caller overrides can only tighten caps', () => {
  assert.equal(tightenOnly({ max_searches_per_run: 10 }, { max_searches_per_run: 500 }).max_searches_per_run, 10);
  assert.equal(tightenOnly({}, { max_searches_per_run: 5 }).max_searches_per_run, 5);
  assert.equal(tightenOnly({}, { max_searches_per_run: 99 }).max_searches_per_run, 15);
});

test('jobs: employer from real-world titles and Workday hosts (2026-09-22 discovery sample)', () => {
  const j = (url, title) => { const r = hitToJob({ url, title }); return r && `${r.company} | ${r.title}`; };
  assert.equal(j('https://emploive.com/x', 'Senior Backend Engineer (Node.Js) at Josys | Emploive'), 'Josys | Senior Backend Engineer (Node.Js)');
  assert.equal(j('https://simplify.jobs/p/1', 'Senior Software Engineer @ Clickhouse | Simplify Jobs'), 'Clickhouse | Senior Software Engineer');
  assert.equal(j('https://jobs.smartrecruiters.com/Swiggy/1', 'Software Dev Engineer II at SWIGGY'), 'Swiggy | Software Dev Engineer II');
  assert.equal(j('https://jobspring.pro/x', 'Senior Software Engineer - AI/ML at ClickHouse — Canada | JobSpring'), 'ClickHouse | Senior Software Engineer - AI/ML');
  assert.equal(j('https://fractal.wd1.myworkdayjobs.com/x', 'Full Stack Senior Engineer (React+Python)'), 'Fractal | Full Stack Senior Engineer (React+Python)');
  assert.equal(j('https://confidential.careers/x', 'Senior Backend Engineer - Remote at…'), 'Confidential | Senior Backend Engineer - Remote');
  assert.equal(splitTitleCompany('Senior Frontend Engineer'), null);
});
