#!/usr/bin/env node
/**
 * resolve-leads.mjs: turn aggregator "leads" into employer postings (zero LLM).
 *
 * Indeed-style boards (Instahyre, Hirist, Cutshort ...) expose a title, company
 * and city but no job description, and their listings go stale. For every
 * pending data/pipeline.md row whose URL is on a lead-source host, this script:
 *
 *   1. finds the company's own ATS board (Greenhouse/Ashby/Lever/Workable/
 *      SmartRecruiters ...) with discover-ats.mjs's resolveCompany();
 *   2. lists that board's jobs through the normal provider layer;
 *   3. fuzzy-matches title + location against the lead;
 *   4. match    -> rewrites the row to the employer URL and tags `| via: <host>`
 *                  (the row loses its old gate verdict so the gate re-reads the
 *                  real JD on the next pass);
 *      no match -> tags `| needs-browser-check`. A lead is never auto-trusted.
 *
 * Rows already tagged (`| via:` or `| needs-browser-check`) are skipped, so a
 * re-run is idempotent. A company whose board probe hit a network error is left
 * untagged so the next run retries it.
 *
 *   node resolve-leads.mjs [--dry-run] [--limit N] [--web [--web-limit N]] [--self-test]
 *
 * --web (opt-in): for a company with NO ATS board, one free-tier Exa search
 * (plugins.local/webintel) looks for the employer's own posting. A hit must
 * name the same company and pass the same pickMatch threshold; results are
 * cached 14 days, so a company is searched at most once a fortnight. With
 * --dry-run it reads only cached searches and spends nothing.
 *
 * Never submits or applies anything; only annotates data/pipeline.md.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolveCompany, isDefinitiveAbsence } from './discover-ats.mjs';
import { loadProviders, resolveProvider } from './providers/_registry.mjs';
import { makeHttpCtx } from './providers/_http.mjs';
import { normalizeCompany } from './tracker-utils.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)); // codebase root (scripts, providers)
const DATA_ROOT = getCareerOpsRoot(); // user-layer root (data/, reports/)
const PIPELINE_PATH = join(DATA_ROOT, 'data/pipeline.md');
const CACHE_PATH = join(DATA_ROOT, 'data/.lead-resolver-cache.json');
const CACHE_TTL_MS = 14 * 24 * 3600 * 1000;
const DEFAULT_LIMIT = 80;
const CONCURRENCY = 3;
const MATCH_THRESHOLD = 0.6;
const DEFAULT_WEB_LIMIT = 15;
const WEB_CACHE_MS = CACHE_TTL_MS;

export const LEAD_HOSTS = ['instahyre.com', 'hirist.tech', 'hirist.com', 'cutshort.io'];
// Social "we're hiring" posts (webintel social mode, social-ingest.mjs): the row
// carries the post permalink when the post had no apply link. The post itself is
// never fetched; only the employer's own board is.
export const SOCIAL_LEAD_HOSTS = ['linkedin.com', 'x.com', 'twitter.com'];
const ALL_LEAD_HOSTS = [...LEAD_HOSTS, ...SOCIAL_LEAD_HOSTS];
// Only ATS families whose provider lists a full board and whose JD the repo can fetch.
const BOARD_VENDORS = ['gh', 'ashby', 'lever', 'workable', 'smartrecruiters', 'recruitee', 'breezy', 'bamboohr'];

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** @param {string} url */
export function leadHostOf(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return ALL_LEAD_HOSTS.find((h) => host === h || host.endsWith(`.${h}`)) ?? null;
  } catch {
    return null;
  }
}

const TITLE_STOP = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'at', 'with', 'sr', 'senior', 'jr', 'junior', 'i', 'ii', 'iii', 'iv', 'level']);

/** @param {string} title */
export function titleTokens(title) {
  return String(title ?? '')
    .toLowerCase()
    .replace(/front[\s-]?end/g, 'frontend')
    .replace(/full[\s-]?stack/g, 'fullstack')
    .replace(/back[\s-]?end/g, 'backend')
    .replace(/\breact\.?js\b/g, 'react')
    .replace(/\b(developer|programmer|swe|sde)\b/g, 'engineer')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(' ')
    .filter((t) => t && !TITLE_STOP.has(t));
}

/** Jaccard similarity of two titles' significant tokens, 0..1. */
export function titleSimilarity(a, b) {
  const A = new Set(titleTokens(a));
  const B = new Set(titleTokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  return inter / (A.size + B.size - inter);
}

const SENIOR_RE = /\b(senior|sr\.?|lead|staff|principal|iii|3)\b/i;

/** A senior lead must not resolve to a role that does not say senior (it is often a junior req). */
const ENTRY_RE = /\b(intern|internship|trainee|apprentice|fresher|new grad|graduate)\b/i;

export function seniorityPenalty(leadTitle, jobTitle) {
  // An intern/trainee posting never matches a lead that isn't one (Loop Health, 2026-09-22).
  if (ENTRY_RE.test(String(jobTitle ?? '')) && !ENTRY_RE.test(String(leadTitle ?? ''))) return 1;
  return SENIOR_RE.test(String(leadTitle ?? '')) && !SENIOR_RE.test(String(jobTitle ?? '')) ? 0.3 : 0;
}

const INDIA_HINT_RE = /\b(india|bengaluru|bangalore|hyderabad|chennai|remote|anywhere|worldwide)\b/i;

/**
 * Pick the best board job for a lead, or null.
 * Location must plausibly fit (India hint or the lead's own city) and the title
 * similarity must clear MATCH_THRESHOLD; seniority words are ignored on purpose
 * so "Senior Frontend Developer" matches "Frontend Developer, Bengaluru".
 * @param {{title:string, location:string}} lead
 * @param {{title:string, location?:string, url:string}[]} jobs
 */
export function pickMatch(lead, jobs) {
  const leadCities = String(lead.location ?? '')
    .split(/[,/·]/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== 'work from home');
  let best = null;
  let bestScore = 0;
  for (const job of jobs ?? []) {
    if (!job?.url || !job?.title) continue;
    const loc = String(job.location ?? '');
    const locOk = !loc || INDIA_HINT_RE.test(loc) || leadCities.some((c) => loc.toLowerCase().includes(c));
    if (!locOk) continue;
    const score = titleSimilarity(lead.title, job.title) - seniorityPenalty(lead.title, job.title);
    if (score > bestScore) {
      best = job;
      bestScore = score;
    }
  }
  return best && bestScore >= MATCH_THRESHOLD ? { job: best, score: bestScore } : null;
}

const ROW_RE = /^- \[ \] (https?:\/\/\S+) \| ([^|]*) \| ([^|]*) \| ([^|]*)(.*)$/;

/**
 * Parse a pending pipeline line. Returns null for anything else.
 * @param {string} line
 */
export function parseLeadRow(line) {
  const m = ROW_RE.exec(line);
  if (!m) return null;
  const [, url, company, title, location, tail] = m;
  // The location group swallows the space before the next `|`; restore it so
  // every annotation stays ' | key: value' after a rewrite.
  const rest = tail.startsWith('|') ? ` ${tail}` : tail;
  return { url, company: company.trim(), title: title.trim(), location: location.trim(), rest };
}

/** Already handled: resolved (`| via:`) or flagged (`| needs-browser-check`). */
export function isHandled(line) {
  return / \| via: /.test(line) || / \| needs-browser-check\b/.test(line);
}

/** Drop the old gate verdict (and anything after it) so the gate re-runs. */
function stripGate(rest) {
  return rest.replace(/ \| gate: .*$/, '');
}

/**
 * Build the rewritten line for a match.
 * @param {string} line
 * @param {{url:string}} job
 * @param {string} host
 */
export function rewriteMatched(line, job, host) {
  const row = parseLeadRow(line);
  if (!row) return line;
  const rest = stripGate(row.rest);
  return `- [ ] ${job.url} | ${row.company} | ${row.title} | ${row.location}${rest} | via: ${host}`;
}

/** @param {string} line */
export function tagNeedsBrowser(line) {
  return `${line} | needs-browser-check`;
}

// ── Cache ────────────────────────────────────────────────────────────────────

function loadCache() {
  try {
    return existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, 'utf-8')) : {};
  } catch {
    return {};
  }
}

// ── Web fallback (opt-in, free-tier budget-capped) ───────────────────────────

/**
 * Keep only web hits that belong to the lead's company: the employer name
 * derived from the URL, or the page title, must name it. Without this a
 * same-titled role at another company could be matched.
 * @param {string} company
 * @param {{title: string, url: string, company: string}[]} jobs
 */
export function sameCompanyJobs(company, jobs, companyFromUrl) {
  // The employer must be identified by WHERE the posting lives (its own domain
  // or its own ATS board), never by the page title: aggregators copy the
  // employer's name into their titles (seen live 2026-09-22 on joblaze.com).
  const key = normalizeCompany(company);
  return jobs.filter((j) => normalizeCompany(companyFromUrl(j.url)) === key);
}

async function loadWeb(webLimit) {
  try {
    const { loadWebIntel } = await import('./plugins.local/webintel/_load.mjs');
    return await loadWebIntel({ caller: 'resolve-leads', settings: { max_searches_per_run: webLimit } });
  } catch (err) {
    console.warn(`⚠️  --web: webintel plugin unavailable (${err.message}); leads without a board stay needs-browser-check.`);
    return null;
  }
}

/**
 * One Exa search per board-less company → candidate postings as Job-like rows.
 * Throws a retryable error for transient failures so the caller can retry later.
 */
export async function webCandidates(web, name, leadTitle, dryRun) {
  const [{ hitToJob, companyFromUrl }, { DENY_HOSTS, FREE_ATS_HOSTS, AGGREGATOR_HOSTS }] = await Promise.all([
    import('./plugins.local/webintel/_jobs.mjs'),
    import('./plugins.local/webintel/_policy.mjs'),
  ]);
  const hits = await web.searchWeb(`${name} ${leadTitle} job opening`, {
    numResults: 5,
    // Greenhouse/Lever/Ashby are excluded too: had the company been on one, resolveCompany would have found it.
    excludeDomains: [...new Set([...LEAD_HOSTS, ...DENY_HOSTS, ...FREE_ATS_HOSTS, ...AGGREGATOR_HOSTS])],
    cacheTtlMs: WEB_CACHE_MS,
    cacheOnly: dryRun,
  });
  return sameCompanyJobs(name, hits.map(hitToJob).filter(Boolean), companyFromUrl);
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function pool(items, limit, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    }),
  );
}

async function run({ dryRun, limit, useWeb = false, webLimit = DEFAULT_WEB_LIMIT }) {
  const lines = readFileSync(PIPELINE_PATH, 'utf-8').split('\n');
  const original = [...lines];
  /** @type {Map<string, number[]>} company key -> line indexes */
  const byCompany = new Map();
  for (let i = 0; i < lines.length; i++) {
    const row = parseLeadRow(lines[i]);
    if (!row || isHandled(lines[i]) || !leadHostOf(row.url)) continue;
    if (!row.company || row.company === '?') continue;
    const key = normalizeCompany(row.company);
    if (!byCompany.has(key)) byCompany.set(key, []);
    byCompany.get(key).push(i);
  }
  const companies = [...byCompany.entries()].slice(0, limit);
  console.log(`Lead rows: ${[...byCompany.values()].reduce((n, a) => n + a.length, 0)} across ${byCompany.size} companies (probing ${companies.length}).`);

  const providers = await loadProviders(join(ROOT, 'providers'));
  const ctx = makeHttpCtx();
  const cache = loadCache();
  const now = Date.now();
  const stats = { matched: 0, flagged: 0, retryLater: 0, noBoard: 0, webMatched: 0 };
  const web = useWeb ? await loadWeb(webLimit) : null;

  await pool(companies, CONCURRENCY, async ([key, idxs]) => {
    const name = parseLeadRow(lines[idxs[0]]).company;
    let board = cache[key] && now - cache[key].at < CACHE_TTL_MS ? cache[key] : null;
    if (!board) {
      let res;
      try {
        res = await resolveCompany({ name }, { vendors: BOARD_VENDORS, ctx, includeWorkday: false });
      } catch {
        stats.retryLater += idxs.length;
        return;
      }
      if (res?.resolved) {
        board = { at: now, careers_url: res.resolved.careers_url, vendor: res.resolved.vendor };
      } else {
        // Unresolved: a 404/redirect/empty answer means "no board here"; any other
        // probe error (5xx, timeout, DNS) leaves the question open, so retry later.
        const errs = res?.unresolved?.errors ?? [];
        const open = errs.some((e) => !isDefinitiveAbsence(e) && !e.refusedRedirect && e.httpStatus !== 429);
        if (open) {
          stats.retryLater += idxs.length;
          return;
        }
        board = { at: now, careers_url: null };
      }
      cache[key] = board;
    }

    let jobs = [];
    if (board.careers_url) {
      try {
        const entry = { name, careers_url: board.careers_url };
        const hit = resolveProvider(entry, providers, { skipIds: ['local-parser'] });
        if (hit?.provider) jobs = await hit.provider.fetch(entry, ctx);
      } catch {
        stats.retryLater += idxs.length;
        return;
      }
    }

    let webJobs = [];
    if (!board.careers_url && web) {
      try {
        webJobs = await webCandidates(web, name, parseLeadRow(lines[idxs[0]]).title, dryRun);
      } catch (err) {
        // Budget, quota or outage: leave these rows untagged so a later run retries them.
        if (err.code !== 'DISABLED' || !dryRun) {
          stats.retryLater += idxs.length;
          return;
        }
      }
    }

    for (const idx of idxs) {
      const line = lines[idx];
      const row = parseLeadRow(line);
      const host = leadHostOf(row.url);
      const match = board.careers_url ? pickMatch(row, jobs) : null;
      const webMatch = !match && webJobs.length ? pickMatch(row, webJobs) : null;
      if (match) {
        lines[idx] = rewriteMatched(line, match.job, host);
        stats.matched++;
      } else if (webMatch) {
        lines[idx] = rewriteMatched(line, webMatch.job, `${host}, webintel`);
        stats.matched++;
        stats.webMatched++;
      } else {
        lines[idx] = tagNeedsBrowser(line);
        stats.flagged++;
        if (!board.careers_url) stats.noBoard++;
      }
    }
  });

  console.log(`Matched to employer posting: ${stats.matched}${web ? ` (${stats.webMatched} via web search)` : ''} | needs-browser-check: ${stats.flagged} (no ATS board: ${stats.noBoard}) | retry next run: ${stats.retryLater}`);
  if (web) console.log(web.summary());
  if (dryRun) {
    console.log('--dry-run: nothing written.');
    return stats;
  }
  // Probing took minutes; the scanner or gate may have written meanwhile. Re-read
  // under the pipeline lock and swap only the lines this run changed.
  const changed = new Map();
  for (let i = 0; i < lines.length; i++) if (lines[i] !== original[i]) changed.set(original[i], lines[i]);
  await withPipelineLock(PIPELINE_PATH, () => {
    const current = readFileSync(PIPELINE_PATH, 'utf-8').split('\n');
    writeFileSync(PIPELINE_PATH, current.map((l) => changed.get(l) ?? l).join('\n'));
  });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  return stats;
}

// ── Self-test ────────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0;
  let fail = 0;
  const check = (name, ok) => {
    if (ok) pass++;
    else {
      fail++;
      console.log(`  ❌ ${name}`);
    }
  };
  check('leadHostOf instahyre', leadHostOf('https://www.instahyre.com/job-1-x/') === 'instahyre.com');
  check('leadHostOf cutshort', leadHostOf('https://cutshort.io/job/abc') === 'cutshort.io');
  check('leadHostOf rejects lookalike', leadHostOf('https://instahyre.com.evil.io/x') === null);
  check('leadHostOf rejects greenhouse', leadHostOf('https://boards.greenhouse.io/x/jobs/1') === null);
  check('leadHostOf linkedin post', leadHostOf('https://www.linkedin.com/posts/a_hiring-activity-1-x') === 'linkedin.com');
  check('leadHostOf x post', leadHostOf('https://x.com/acme/status/123') === 'x.com');
  check('similarity ignores seniority', titleSimilarity('Senior Frontend Developer', 'Frontend Developer') === 1);
  check('similarity normalizes front-end', titleSimilarity('Front-End Engineer', 'Frontend Engineer') === 1);
  check('similarity low for unrelated', titleSimilarity('React Developer', 'Data Scientist') < 0.3);
  const jobs = [
    { title: 'Staff Data Engineer', location: 'Bengaluru, India', url: 'https://x/1' },
    { title: 'Frontend Engineer', location: 'Bengaluru, India', url: 'https://x/2' },
    { title: 'Frontend Engineer', location: 'Berlin, Germany', url: 'https://x/3' },
  ];
  const m = pickMatch({ title: 'Senior Frontend Developer', location: 'Bangalore' }, jobs);
  check('pickMatch picks the India frontend job', m && m.job.url === 'https://x/2');
  check('pickMatch returns null below threshold', pickMatch({ title: 'Founding Engineer', location: 'Bangalore' }, jobs) === null);
  check('senior lead does not resolve to a non-senior posting', pickMatch({ title: 'Senior Software Engineer - Frontend', location: 'Bangalore' }, [{ title: 'Frontend Developer', location: 'Bengaluru, India', url: 'https://x/9' }]) === null);
  check('senior lead still matches a senior posting', pickMatch({ title: 'Senior Frontend Developer', location: 'Bangalore' }, [{ title: 'Senior Frontend Engineer', location: 'Bengaluru, India', url: 'https://x/8' }]) !== null);
  check('pickMatch skips wrong-location job', pickMatch({ title: 'Frontend Engineer', location: 'Bangalore' }, [jobs[2]]) === null);
  const line = '- [ ] https://www.instahyre.com/job-9-x/ | Harness | Senior Frontend Developer | Bangalore | posted: 2026-09-01 | gate: PASS — ok';
  const row = parseLeadRow(line);
  check('parseLeadRow reads fields', row && row.company === 'Harness' && row.location === 'Bangalore');
  check('parseLeadRow ignores checked rows', parseLeadRow('- [x] https://a | b | c | d') === null);
  const rw = rewriteMatched(line, { url: 'https://boards.greenhouse.io/harness/jobs/1' }, 'instahyre.com');
  check('rewriteMatched swaps URL, drops gate, adds via', rw.startsWith('- [ ] https://boards.greenhouse.io/harness/jobs/1 | Harness') && !rw.includes('gate:') && rw.endsWith('| via: instahyre.com'));
  check('rewrite keeps space before annotations', !/\S\| /.test(rw));
  check('isHandled sees via', isHandled(rw));
  check('isHandled sees needs-browser-check', isHandled(tagNeedsBrowser(line)));
  check('isHandled false for fresh row', !isHandled(line));
  const cands = [
    { title: 'Senior Frontend Engineer', url: 'https://careers.harness.io/1', company: 'Harness' },
    { title: 'Senior Frontend Engineer', url: 'https://other.example/2', company: 'Other' },
  ];
  const hostCo = (u) => ({ 'careers.harness.io': 'Harness', 'other.example': 'Other', 'joblaze.com': 'Joblaze' })[new URL(u).hostname];
  check('sameCompanyJobs drops other employers', sameCompanyJobs('Harness', cands, hostCo).length === 1);
  check('sameCompanyJobs ignores an aggregator that copies the name into its title',
    sameCompanyJobs('Harness', [{ title: 'Backend Engineer at Harness', url: 'https://joblaze.com/jobs/1', company: 'Harness' }], hostCo).length === 0);
  check('intern posting never matches a regular lead', pickMatch({ title: 'Software Engineer', location: 'Bangalore' }, [{ title: 'Software Engineer Intern', location: 'Bengaluru', url: 'https://x/i' }]) === null);
  const rwWeb = rewriteMatched(line, cands[0], 'instahyre.com, webintel');
  check('web match is tagged via webintel and handled', rwWeb.endsWith('| via: instahyre.com, webintel') && isHandled(rwWeb));
  console.log(`  resolve-leads self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

const args = process.argv.slice(2);
if (isMainModule(import.meta.url)) {
  if (args.includes('--self-test')) selfTest();
  else {
    const li = args.indexOf('--limit');
    const limit = li >= 0 ? Math.max(1, Number(args[li + 1]) || DEFAULT_LIMIT) : DEFAULT_LIMIT;
    const wi = args.indexOf('--web-limit');
    const webLimit = wi >= 0 ? Math.max(1, Number(args[wi + 1]) || DEFAULT_WEB_LIMIT) : DEFAULT_WEB_LIMIT;
    run({ dryRun: args.includes('--dry-run'), limit, useWeb: args.includes('--web'), webLimit }).catch((e) => {
      console.error(`resolve-leads failed: ${e.stack || e.message}`);
      process.exit(1);
    });
  }
}
