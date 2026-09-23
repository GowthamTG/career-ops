// The --web steps in the user's scripts (gate, resolve-leads), with a fake
// webintel client: no network, no keys, no writes to data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillJdFromWeb, evaluateEntry } from '../../../basic-validate-pipeline.mjs';
import { webCandidates, pickMatch } from '../../../resolve-leads.mjs';

const JD = 'Senior Frontend Engineer. React, TypeScript. 4+ years of experience. Remote within India. '.repeat(10);

function fakeWeb({ pages = {}, hits = [] } = {}) {
  const calls = [];
  return {
    calls,
    async fetchPages(urls, opts) {
      calls.push({ op: 'fetchPages', urls, opts });
      return new Map(urls.map((u) => [u, pages[u] ? { doc: { text: pages[u] }, error: null } : { doc: null, error: { code: 'NOT_FOUND' } }]));
    },
    async searchWeb(query, opts) {
      calls.push({ op: 'searchWeb', query, opts });
      return hits;
    },
  };
}

test('gate --web: one batched fetch for rows without an ATS JD; rows with a JD are left alone', async () => {
  const a = { url: 'https://careers.acme.example/jobs/1', title: 'Senior Frontend Engineer' };
  const b = { url: 'https://boards.greenhouse.io/x/jobs/2', title: 'Senior Frontend Engineer' };
  const c = { url: 'https://careers.gone.example/jobs/3', title: 'Senior Frontend Engineer' };
  const jdByRow = new Map([[a, ''], [b, 'already have it'], [c, '']]);
  const web = fakeWeb({ pages: { [a.url]: JD } });
  const filled = await fillJdFromWeb(jdByRow, web, { limit: 25, dryRun: false });
  assert.equal(filled, 1);
  assert.equal(web.calls.length, 1);
  assert.deepEqual(web.calls[0].urls, [a.url, c.url]);
  assert.equal(web.calls[0].opts.cacheOnly, false);
  assert.equal(jdByRow.get(a), JD);
  assert.equal(jdByRow.get(b), 'already have it');
  assert.equal(jdByRow.get(c), '');
});

test('gate --web --dry-run: cache-only fetch, never spends', async () => {
  const e = { url: 'https://careers.acme.example/jobs/1', title: 'x' };
  const web = fakeWeb();
  await fillJdFromWeb(new Map([[e, '']]), web, { limit: 25, dryRun: true });
  assert.equal(web.calls[0].opts.cacheOnly, true);
});

test('gate --web: fetched text feeds the normal gate (a DQ in the web JD fails the row)', () => {
  const entry = { url: 'https://careers.acme.example/jobs/1', company: 'Acme', title: 'Senior Frontend Engineer', location: 'Remote', compCell: '' };
  const profile = { location: { country: 'India', city: 'Bangalore' }, target_roles: {} };
  const r = evaluateEntry(entry, { positiveKeywords: ['frontend'], negativeKeywords: [], profile, jdText: 'Requirements: 11+ years of experience building web apps. '.repeat(5) });
  assert.equal(r.verdict, 'FAIL');
});

test('resolve-leads --web: one search per company, same-company hits only, then pickMatch', async () => {
  const web = fakeWeb({
    hits: [
      { url: 'https://careers.harness.io/jobs/1', title: 'Senior Frontend Engineer at Harness' },
      { url: 'https://other.example/jobs/2', title: 'Senior Frontend Engineer at Other Co' },
      { url: 'https://aggregator.example/jobs/3', title: 'Senior Frontend Engineer at Harness' },
    ],
  });
  const jobs = await webCandidates(web, 'Harness', 'Senior Frontend Developer', false);
  assert.equal(web.calls.length, 1);
  assert.equal(web.calls[0].opts.cacheOnly, false);
  assert.ok(web.calls[0].opts.excludeDomains.includes('instahyre.com'));
  assert.deepEqual(jobs.map((j) => j.url), ['https://careers.harness.io/jobs/1']);
  const m = pickMatch({ title: 'Senior Frontend Developer', location: 'Bangalore' }, jobs);
  assert.equal(m?.job.url, 'https://careers.harness.io/jobs/1');
});

test('resolve-leads --web --dry-run: search is cache-only', async () => {
  const web = fakeWeb();
  await webCandidates(web, 'Harness', 'Frontend Engineer', true);
  assert.equal(web.calls[0].opts.cacheOnly, true);
});
