#!/usr/bin/env node
/**
 * social-ingest.mjs: the ASSISTED path for LinkedIn / X hiring posts (zero LLM).
 *
 * The scan-time social mode (plugins.local/webintel, `mode: social`) reads
 * LinkedIn posts from a search index and never touches linkedin.com. X has no
 * free index at all (Exa dropped tweets; the X API is paid). For both, the user
 * can ask the agent to read a search page in their own logged-in Chrome. This
 * script turns what the agent copied from that page into pipeline rows, with
 * the same parser, dedup and blacklist as the scanner.
 *
 *   node social-ingest.mjs --print-urls [--network linkedin|x]
 *       2-3 search URLs built from portals.yml `mode: social` entries
 *   node social-ingest.mjs --network linkedin|x --file posts.txt [--dry-run]
 *       parse → dedup → append to data/pipeline.md + scan-history
 *   node social-ingest.mjs --self-test
 *
 * --file format: one block per post, blocks separated by a line `=== POST ===`.
 * Header lines (all optional except URL) come first, then a blank line, then
 * the post text as shown on the page:
 *
 *   === POST ===
 *   URL: https://www.linkedin.com/feed/update/urn:li:activity:7502...
 *   Author: Jane Doe
 *   Headline: Talent Acquisition at Acme
 *   Date: 2026-09-21
 *
 *   We're hiring! Senior Frontend Engineer ...
 *
 * A block without a post URL is skipped (the URL is the dedup key and the only
 * way back to the post). Nothing here fetches anything, clicks anything,
 * contacts a poster, or submits an application. The browser rules for the
 * assisted read live in modes/_custom.md ("Assisted social read").
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import * as yaml from 'js-yaml';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';
import { normalizeCompany } from './tracker-utils.mjs';
import { parsePost } from './plugins.local/webintel/_postparse.mjs';
import { isSocialPostUrl, writePost } from './plugins.local/webintel/_postcache.mjs';

const DATA_ROOT = getCareerOpsRoot();
const SOURCE = 'social-assisted';

// ── Pure helpers (self-tested) ───────────────────────────────────────────────

/**
 * Split the --file text into post blocks.
 * @param {string} text
 * @returns {Array<{ url: string, author: string, headline: string, date: string, body: string }>}
 */
export function parsePostFile(text) {
  const blocks = String(text ?? '').replace(/\r\n?/g, '\n').split(/^=== POST ===\s*$/m).map((b) => b.trim()).filter(Boolean);
  return blocks.map((b) => {
    const lines = b.split('\n');
    const head = {};
    let i = 0;
    for (; i < lines.length; i++) {
      const m = lines[i].match(/^(URL|Author|Headline|Date):\s*(.*)$/i);
      if (!m) break;
      head[m[1].toLowerCase()] = m[2].trim();
    }
    const body = lines.slice(i).join('\n').trim();
    return { url: head.url || '', author: head.author || '', headline: head.headline || '', date: head.date || '', body };
  });
}

/** LinkedIn content search / X live search for a query. @param {'linkedin'|'x'} network @param {string} q */
export function searchUrl(network, q) {
  const k = encodeURIComponent(q);
  if (network === 'x') return `https://x.com/search?q=${k}&src=typed_query&f=live`;
  return `https://www.linkedin.com/search/results/content/?keywords=${k}&datePosted=%22past-week%22&sortBy=%22date_posted%22`;
}

/**
 * Short, human-style search phrases from portals.yml `mode: social` entries
 * (`assisted_query` when set, otherwise `query`), at most 3.
 * @param {any} portals parsed portals.yml
 */
export function assistedQueries(portals) {
  const entries = [...(portals?.job_boards ?? []), ...(portals?.tracked_companies ?? [])]
    .filter((e) => e && String(e.mode || '').toLowerCase() === 'social');
  const qs = entries.map((e) => String(e.assisted_query || e.query || '').trim()).filter(Boolean);
  return [...new Set(qs)].slice(0, 3);
}

/**
 * Posts → jobs, dropping what the scanner would drop.
 * @param {ReturnType<typeof parsePostFile>} posts
 * @param {'linkedin'|'x'} network
 * @param {{ seenUrl: (u: string) => boolean, seenRole: (company: string, title: string) => boolean, blacklisted: (company: string) => boolean }} filters
 */
export function postsToJobs(posts, network, filters) {
  const stats = { posts: posts.length, noUrl: 0, added: 0, duplicate: 0, blacklisted: 0 };
  const jobs = [];
  for (const p of posts) {
    if (!/^https:\/\//i.test(p.url) || !isSocialPostUrl(p.url)) { stats.noUrl++; continue; }
    const firstLine = p.body.split('\n').find((l) => l.trim()) || '';
    const parsed = parsePost({ url: p.url, title: firstLine, text: p.body, author: p.author, headline: p.headline, publishedAt: p.date || null, network });
    stats[parsed.kind] = (stats[parsed.kind] || 0) + 1;
    for (const j of parsed.jobs) {
      if (filters.blacklisted(j.company)) { stats.blacklisted++; continue; }
      if (filters.seenUrl(j.url) || filters.seenRole(j.company, j.title)) { stats.duplicate++; continue; }
      jobs.push({ ...j, source: SOURCE, _author: parsed.author });
      stats.added++;
    }
  }
  return { jobs, stats };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function arg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function loadPortals() {
  const p = join(DATA_ROOT, 'portals.yml');
  return existsSync(p) ? yaml.load(readFileSync(p, 'utf-8')) : {};
}

async function ingest({ network, file, dryRun }) {
  const scan = await import('./scan.mjs');
  const snap = scan.loadDedupSnapshot();
  const blacklist = scan.loadBlacklist();
  const posts = parsePostFile(readFileSync(file, 'utf-8'));
  const { jobs, stats } = postsToJobs(posts, network, {
    seenUrl: (u) => snap.seen.has(scan.normalizeUrlForDedup(u)),
    seenRole: (c, t) => snap.seenCompanyRoles.has(scan.companyRoleDedupKey(c, t)),
    blacklisted: (c) => blacklist.has(normalizeCompany(c)),
  });
  console.log(`Posts: ${Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const j of jobs) console.log(`  + ${j.company} | ${j.title} | ${j.location || '(no location)'} | ${j.url}`);
  if (dryRun || !jobs.length) {
    if (dryRun) console.log('--dry-run: nothing written.');
    return stats;
  }
  const dataDir = join(DATA_ROOT, 'data');
  for (const j of jobs) {
    if (isSocialPostUrl(j.url)) writePost(dataDir, j.url, { text: j.description, network, source: SOURCE, author: j._author });
  }
  const offers = jobs.map(({ _author, ...j }) => j);
  await scan.appendToPipeline(offers);
  await scan.appendToScanHistory(offers, localToday());
  console.log(`Appended ${offers.length} row(s) to data/pipeline.md. Next: node basic-validate-pipeline.mjs, then node resolve-leads.mjs.`);
  return stats;
}

function selfTest() {
  let pass = 0;
  let fail = 0;
  const check = (name, ok) => { if (ok) pass++; else { fail++; console.log(`  ❌ ${name}`); } };
  const file = `=== POST ===
URL: https://www.linkedin.com/feed/update/urn:li:activity:1
Author: A Recruiter
Headline: Talent Acquisition at Acme Analytics

We're hiring! Senior Frontend Engineer
Location: Bengaluru (Hybrid)
Experience: 4-7 years
Apply: https://jobs.ashbyhq.com/acme/1b2c3d4e-0000-4000-8000-000000000001

=== POST ===
Author: No Url

We're hiring a React Developer at Foo

=== POST ===
URL: https://x.com/someone/status/2
Author: Seeker

#OpenToWork I'm looking for frontend roles in Bangalore
`;
  const posts = parsePostFile(file);
  check('three blocks', posts.length === 3);
  check('headers parsed', posts[0].headline === 'Talent Acquisition at Acme Analytics' && posts[0].url.endsWith(':1'));
  const none = { seenUrl: () => false, seenRole: () => false, blacklisted: () => false };
  const r = postsToJobs(posts, 'linkedin', none);
  check('one job from the hiring post', r.jobs.length === 1);
  check('vacancy link wins over permalink', r.jobs[0]?.url.startsWith('https://jobs.ashbyhq.com/acme/'));
  check('employer from headline', r.jobs[0]?.company === 'Acme Analytics');
  check('location read', /Bengaluru/.test(r.jobs[0]?.location || ''));
  check('block without URL skipped', r.stats.noUrl === 1);
  check('seeker dropped', r.stats.seeker === 1);
  check('blacklist applied', postsToJobs(posts, 'linkedin', { ...none, blacklisted: () => true }).jobs.length === 0);
  check('dedup applied', postsToJobs(posts, 'linkedin', { ...none, seenRole: () => true }).stats.duplicate === 1);
  check('linkedin search url', searchUrl('linkedin', 'hiring react').includes('keywords=hiring%20react'));
  check('x search url is live', searchUrl('x', 'hiring react').endsWith('&f=live'));
  check('assisted queries prefer assisted_query', assistedQueries({ job_boards: [{ mode: 'social', query: 'long q', assisted_query: 'short q' }, { mode: 'other', query: 'no' }] })[0] === 'short q');
  console.log(`  social-ingest self-test: ${pass} passed, ${fail} failed`);
  return fail ? 1 : 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  if (args.includes('--help') || args.includes('-h') || !args.length) {
    console.log(readFileSync(fileURLToPath(import.meta.url), 'utf-8').split('*/')[0].replace(/^#!.*\n\/\*\*?/, '').replace(/^ \* ?/gm, ''));
    return 0;
  }
  const network = /** @type {'linkedin'|'x'} */ ((arg(args, '--network') || 'linkedin').toLowerCase());
  if (!['linkedin', 'x'].includes(network)) {
    console.error('--network must be linkedin or x');
    return 1;
  }
  if (args.includes('--print-urls')) {
    const qs = assistedQueries(loadPortals());
    if (!qs.length) {
      console.error('No `mode: social` entries in portals.yml to build queries from.');
      return 1;
    }
    for (const q of qs) console.log(searchUrl(network, q));
    return 0;
  }
  const file = arg(args, '--file');
  if (!file || !existsSync(file)) {
    console.error('--file <posts.txt> is required (see --help for the format).');
    return 1;
  }
  await ingest({ network, file, dryRun: args.includes('--dry-run') });
  return 0;
}

if (isMainModule(import.meta.url)) {
  main().then((code) => process.exit(code ?? 0), (err) => {
    console.error(err?.stack || err);
    process.exit(1);
  });
}

