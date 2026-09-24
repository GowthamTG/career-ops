// @ts-check
// plugins.local/webintel/index.mjs: scan-time provider hook.
//
// Fires only on an explicit portals.yml entry (the engine forces detect → null):
//
//   job_boards:
//     - name: Web discovery: Full-stack India
//       provider: webintel
//       query: "senior full stack engineer React TypeScript job Bangalore or remote India"
//       include_domains: []          # optional; empty = whole web minus exclusions
//       exclude_domains: []          # optional; added to the built-in exclusions
//       published_within_days: 30    # optional freshness filter
//       min_interval_hours: 72       # cost throttle: inside it, cached hits are returned for $0
//
// `mode: social` entries search social post permalinks instead (see _social.mjs),
// and ONLY when CAREER_OPS_SOCIAL_SCAN=1: social scans run on explicit request.
//
// Returns Job[]; scan.mjs applies title/location filters, the blacklist,
// scan-history dedup and the canonical pipeline write. Every hit is a LEAD: it
// still needs the browser liveness check before anything is filled.

import path from 'path';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'fs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { createWebIntel } from './_capabilities.mjs';
import { AGGREGATOR_HOSTS, DENY_HOSTS, FREE_ATS_HOSTS, hostInList } from './_policy.mjs';
import { boardOf, hitToJob } from './_jobs.mjs';
import { runSocialEntry } from './_social.mjs';

let socialSkipNoted = false;

const BOARD_CANDIDATES_HEADER = 'date\tvendor\tslug\tcompany\tsample_url\n';

/** @param {any} entry */
function asList(v) {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : [];
}

/**
 * Append "this company's board exists" suggestions, once per vendor+slug.
 * Suggestion only: the user runs `node discover-ats.mjs --write <Company>`.
 * @param {string} dataDir
 * @param {Array<{ url: string, company: string }>} jobs
 */
export function recordBoardCandidates(dataDir, jobs) {
  const file = path.join(dataDir, 'webintel-board-candidates.tsv');
  const existing = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const known = new Set(existing.split('\n').slice(1).map((l) => l.split('\t').slice(1, 3).join('/').toLowerCase()));
  let portals = '';
  try { portals = readFileSync(path.join(getCareerOpsRoot(), 'portals.yml'), 'utf8').toLowerCase(); } catch { /* optional */ }
  const rows = [];
  for (const j of jobs) {
    const b = boardOf(j.url);
    if (!b) continue;
    const k = `${b.vendor}/${b.slug}`.toLowerCase();
    if (known.has(k) || portals.includes(b.slug.toLowerCase())) continue;
    known.add(k);
    rows.push([new Date().toISOString().slice(0, 10), b.vendor, b.slug, j.company, j.url].join('\t'));
  }
  if (!rows.length) return 0;
  mkdirSync(dataDir, { recursive: true });
  if (!existing) appendFileSync(file, BOARD_CANDIDATES_HEADER);
  appendFileSync(file, `${rows.join('\n')}\n`);
  return rows.length;
}

export default {
  provider: {
    id: 'webintel',
    /**
     * @param {any} entry  portals.yml job_boards entry
     * @param {any} ctx    plugin ctx from the engine
     */
    async fetch(entry, ctx) {
      const query = typeof entry?.query === 'string' ? entry.query.trim() : '';
      if (!query) throw new Error(`webintel entry "${entry?.name}" needs a \`query:\``);
      const dataDir = path.join(getCareerOpsRoot(), 'data');
      const wi = createWebIntel({ ctx, dataDir, settings: ctx.settings, caller: 'scan' });
      // `node scan.mjs --dry-run` runs in this same process and must write nothing;
      // the plugin ctx carries no dry-run flag for provider hooks, so read scan's own flag.
      const dryRun = process.argv.includes('--dry-run');
      if (String(entry.mode || '').toLowerCase() === 'social') {
        // On request only: a plain scan never searches social posts. The user asks
        // for it (`scan-shortlist.mjs --social` / `--social-only`, which set this).
        if (process.env.CAREER_OPS_SOCIAL_SCAN !== '1') {
          if (!socialSkipNoted) {
            socialSkipNoted = true;
            console.log('   social: skipped (on request only; run `node scan-shortlist.mjs --social` or `--social-only`)');
          }
          return [];
        }
        try {
          const { jobs } = await runSocialEntry(entry, wi, { dataDir, dryRun, log: (s) => console.log(s) });
          if (!dryRun) recordBoardCandidates(dataDir, jobs);
          if (wi.stats.exa.calls) console.log(`   ${wi.summary()}`);
          return jobs;
        } catch (err) {
          console.warn(`⚠️  webintel social "${entry.name}": ${/** @type {any} */ (err).message}`);
          return [];
        }
      }
      const includeDomains = asList(entry.include_domains);
      const excludeDomains = [...new Set([...FREE_ATS_HOSTS, ...DENY_HOSTS, ...AGGREGATOR_HOSTS, ...asList(entry.exclude_domains)])];
      const hours = Number(entry.min_interval_hours);
      const days = Number(entry.published_within_days);
      let hits = [];
      try {
        hits = await wi.searchWeb(query, {
          numResults: 10,
          includeDomains,
          excludeDomains,
          publishedWithinDays: Number.isFinite(days) && days > 0 ? days : null,
          cacheTtlMs: (Number.isFinite(hours) && hours > 0 ? hours : 72) * 3_600_000,
        });
      } catch (err) {
        // Budget/quota/outage: skip quietly, the next scan retries. Never a paid fallback.
        console.warn(`⚠️  webintel "${entry.name}": ${/** @type {any} */ (err).message}`);
        return [];
      }
      const jobs = hits
        .filter((h) => {
          const host = new URL(h.url).hostname;
          return !hostInList(host, DENY_HOSTS) && !hostInList(host, FREE_ATS_HOSTS) && !hostInList(host, AGGREGATOR_HOSTS);
        })
        .map(hitToJob)
        .filter(Boolean);
      if (!dryRun) recordBoardCandidates(dataDir, /** @type {any[]} */ (jobs));
      if (wi.stats.exa.calls) console.log(`   ${wi.summary()}`);
      return jobs;
    },
  },
};
