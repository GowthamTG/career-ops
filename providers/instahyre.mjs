// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Instahyre provider (job_boards: list). Reads the public, no-auth JSON API
// behind instahyre.com's own job search (https://www.instahyre.com/api/v1/job_search),
// the same endpoint the site's search page calls. India-focused board of
// employer-attributed listings, free for candidates.
//
// The API filters server-side on `skills` and `job_functions` (verified
// 2026-09-20: skills=React narrows 13,296 -> 1,641; job_functions=1 is
// Full-Stack Development). It does NOT filter on location (a `location`
// param is ignored), so this provider filters locations itself.
//
// Wire in via a `job_boards:` entry with `provider: instahyre`:
//
//   - name: Instahyre
//     provider: instahyre
//     skills: ["React", "TypeScript"]        # one query per skill
//     job_functions: [1]                     # 1 = Full-Stack Development
//     locations: ["Bangalore", "Bengaluru", "Chennai", "Hyderabad", "Work From Home"]
//     max_pages: 4                           # 35 jobs per page, per query
//
// Listings link to instahyre.com's own posting page (the API exposes no
// upstream employer link). Applying on Instahyre needs a login, so this
// provider only discovers; the user completes any application themselves.

import { fetchJsonWithRetry, sleep } from './_http.mjs';

const API_BASE = 'https://www.instahyre.com/api/v1/job_search';
const TRUSTED_HOST = 'www.instahyre.com';
const PAGE_SIZE = 35;
const DEFAULT_MAX_PAGES = 4;
const INTER_PAGE_DELAY_MS = 200;
const DEFAULT_LOCATIONS = ['Bangalore', 'Bengaluru', 'Chennai', 'Hyderabad', 'Work From Home'];

/** @param {unknown} v */
function stringList(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
}

/** @param {unknown} v */
function intList(v) {
  if (!Array.isArray(v)) return [];
  return v.filter((x) => Number.isInteger(x) && x > 0);
}

// Only https links hosted on instahyre.com are kept as the job URL.
/** @param {unknown} value */
function cleanUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'https:' && parsed.hostname === TRUSTED_HOST ? parsed.href : '';
  } catch {
    return '';
  }
}

/**
 * Build the list of API query strings for an entry: one per skill, one per
 * job function, or a single unfiltered query when neither is configured.
 * @param {any} entry
 * @returns {string[]}
 */
export function buildQueries(entry) {
  const skills = stringList(entry?.skills);
  const functions = intList(entry?.job_functions);
  const queries = [
    ...skills.map((s) => `skills=${encodeURIComponent(s)}`),
    ...functions.map((f) => `job_functions=${f}`),
  ];
  return queries.length ? queries : [''];
}

/**
 * Parse one API page into normalized jobs. Malformed items are skipped, never
 * thrown. Exported for unit tests.
 * @param {any} json
 * @param {string[]} locations  Case-insensitive substrings; empty = keep all.
 * @returns {import('./_types.js').Job[]}
 */
export function parseInstahyrePage(json, locations) {
  if (json == null || typeof json !== 'object') return [];
  if (!Array.isArray(json.objects)) {
    if (json.meta || Object.keys(json).length === 0) return [];
    throw new Error(`instahyre: unexpected response shape, keys: ${Object.keys(json).join(', ')}`);
  }
  const wanted = locations.map((l) => l.toLowerCase());
  /** @type {import('./_types.js').Job[]} */
  const jobs = [];
  for (const item of json.objects) {
    if (!item || typeof item !== 'object') continue;
    const title = typeof item.title === 'string' ? item.title.trim() : '';
    const url = cleanUrl(item.public_url);
    if (!title || !url) continue;
    const location = typeof item.locations === 'string' ? item.locations.trim() : '';
    if (wanted.length && location) {
      const lower = location.toLowerCase();
      if (!wanted.some((w) => lower.includes(w))) continue;
    }
    const company =
      item.employer && typeof item.employer.company_name === 'string'
        ? item.employer.company_name.trim()
        : '';
    jobs.push({ title, url, company, location });
  }
  return jobs;
}

/** @type {Provider} */
export default {
  id: 'instahyre',

  // Explicit-only: a branded board with no per-entry URL, so it never claims
  // an entry the user did not point at it.
  detect(entry) {
    return entry?.provider === 'instahyre' ? { url: API_BASE } : null;
  },

  async fetch(entry, ctx) {
    const maxPages = Math.max(
      1,
      Math.min(Number(ctx?.maxPages) || Number(entry?.max_pages) || DEFAULT_MAX_PAGES, 20),
    );
    const locations = stringList(entry?.locations).length
      ? stringList(entry.locations)
      : DEFAULT_LOCATIONS;
    /** @type {Map<string, import('./_types.js').Job>} */
    const byUrl = new Map();

    for (const query of buildQueries(entry)) {
      for (let page = 0; page < maxPages; page++) {
        if (page > 0) await sleep(INTER_PAGE_DELAY_MS, ctx);
        const url = `${API_BASE}?limit=${PAGE_SIZE}&offset=${page * PAGE_SIZE}${query ? `&${query}` : ''}`;
        let json;
        try {
          // redirect:'error' keeps the request pinned to instahyre.com.
          json = await fetchJsonWithRetry(ctx, url, { redirect: 'error' });
        } catch (err) {
          // Keep what we have from earlier pages; fail loud only if nothing at all.
          if (byUrl.size === 0 && page === 0) throw err;
          break;
        }
        const objects = Array.isArray(json?.objects) ? json.objects : [];
        for (const job of parseInstahyrePage(json, locations)) {
          if (!byUrl.has(job.url)) byUrl.set(job.url, job);
        }
        if (objects.length < PAGE_SIZE) break; // last page
      }
    }
    return [...byUrl.values()];
  },
};
