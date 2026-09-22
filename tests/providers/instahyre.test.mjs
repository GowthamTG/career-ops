// tests/providers/instahyre.test.mjs: provider-contract tests for the Instahyre
// board provider (providers/instahyre.mjs). Pure unit tests, no network.
import { pass, fail, ROOT } from '../helpers.mjs';
import { join } from 'path';
import { pathToFileURL } from 'url';

console.log('\nProvider — instahyre');

try {
  const mod = await import(pathToFileURL(join(ROOT, 'providers/instahyre.mjs')).href);
  const instahyre = mod.default;
  const { parseInstahyrePage, buildQueries } = mod;

  if (instahyre.id === 'instahyre') pass('instahyre.id is "instahyre"');
  else fail(`instahyre.id is ${JSON.stringify(instahyre.id)}`);

  const hit = instahyre.detect({ name: 'Instahyre', provider: 'instahyre' });
  if (hit && hit.url.startsWith('https://www.instahyre.com/')) pass('detect() claims provider:instahyre');
  else fail(`detect() returned ${JSON.stringify(hit)}`);
  if (instahyre.detect({ name: 'X', careers_url: 'https://www.instahyre.com/' }) === null) pass('detect() never claims by URL');
  else fail('detect() must be explicit-only');

  const qs = buildQueries({ skills: ['React', 'C++'], job_functions: [1] });
  if (qs.join('|') === 'skills=React|skills=C%2B%2B|job_functions=1') pass('buildQueries encodes skills and job functions');
  else fail(`buildQueries returned ${JSON.stringify(qs)}`);
  if (buildQueries({}).length === 1 && buildQueries({})[0] === '') pass('buildQueries falls back to one unfiltered query');
  else fail('buildQueries fallback wrong');

  const page = {
    meta: { total_count: 3 },
    objects: [
      { title: 'React Developer', locations: 'Bangalore,Gurgaon', public_url: 'https://www.instahyre.com/job-1-react-developer-at-acme-bangalore/', employer: { company_name: 'Acme' } },
      { title: 'Java Dev', locations: 'Pune', public_url: 'https://www.instahyre.com/job-2-java-dev-at-foo-pune/', employer: { company_name: 'Foo' } },
      { title: 'Evil', locations: 'Bangalore', public_url: 'https://evil.example.com/job-3', employer: { company_name: 'Evil' } },
      null,
      { title: '', locations: 'Bangalore', public_url: 'https://www.instahyre.com/job-4/' },
    ],
  };
  const jobs = parseInstahyrePage(page, ['Bangalore', 'Chennai']);
  if (jobs.length === 1 && jobs[0].company === 'Acme' && jobs[0].title === 'React Developer') pass('parse keeps only in-location, trusted-host, well-formed items');
  else fail(`parse returned ${JSON.stringify(jobs)}`);
  if (parseInstahyrePage(page, []).length === 2) pass('empty locations list keeps all valid items');
  else fail('empty locations should keep all trusted items');

  if (parseInstahyrePage(null, []).length === 0 && parseInstahyrePage({}, []).length === 0 && parseInstahyrePage({ meta: {} , objects: [] }, []).length === 0) pass('empty/contentless bodies return []');
  else fail('empty bodies should return []');
  try { parseInstahyrePage({ foo: 1 }, []); fail('unrecognised shape should throw'); }
  catch (e) { if (/unexpected response shape/.test(e.message)) pass('unrecognised shape throws a descriptive error'); else fail(`wrong error: ${e.message}`); }

  // fetch(): pinned URL, redirect:'error', dedup, stops on short page
  const calls = [];
  const ctx = {
    maxPages: 3,
    sleep: async () => {},
    fetchJson: async (url, opts) => { calls.push({ url, opts }); return { meta: {}, objects: page.objects.slice(0, 1) }; },
  };
  const out = await instahyre.fetch({ name: 'Instahyre', provider: 'instahyre', skills: ['React'] }, ctx);
  if (calls.length === 1 && calls[0].url.startsWith('https://www.instahyre.com/api/v1/job_search?') && calls[0].opts.redirect === 'error') pass('fetch pins the host, sends redirect:error, stops on a short page');
  else fail(`fetch calls: ${JSON.stringify(calls)}`);
  if (out.length === 1) pass('fetch returns normalized jobs');
  else fail(`fetch returned ${out.length}`);
} catch (e) {
  fail(`instahyre test crashed: ${e.stack || e.message}`);
}
