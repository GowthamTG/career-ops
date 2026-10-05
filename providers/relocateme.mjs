// @ts-check
/** @typedef {import('./_types.js').Provider} Provider */

// Relocate.me provider — tech jobs that come with relocation / visa support
// (Europe-heavy, plus Asia and the Americas). Public, server-rendered listing
// pages, no auth:
//   https://relocate.me/international-jobs?page=N
// Each card carries the company in a <p> just before
//   <div class="job__title"><a href="/{country}/{city}/{company}/{slug}-{id}">
//     <b>Title</b> in City </a>
// so the parser anchors on that title block and walks back for the company.
//
import { BROWSER_LIKE_USER_AGENT } from './_http.mjs';

// Wire in via a `job_boards:` entry with `provider: relocateme`; optional
// `max_pages` (default 8, hard cap 40).

const BASE = 'https://relocate.me';
const TRUSTED_HOST = 'relocate.me';
const DEFAULT_MAX_PAGES = 8;
const HARD_CAP = 40;

/** @param {string} s */
function clean(s) {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Parse one listing page into normalized jobs. Exported for unit tests.
 * @param {string} html
 * @returns {{ title: string, url: string, company: string, location: string }[]}
 */
export function parseRelocatePage(html) {
  const out = [];
  const marker = 'class="job__title"';
  let idx = html.indexOf(marker);
  while (idx !== -1) {
    const next = html.indexOf(marker, idx + marker.length);
    const block = html.slice(idx, next === -1 ? idx + 4000 : Math.min(next, idx + 4000));
    const href = /<a[^>]+href="(\/[^"]+)"/.exec(block);
    const title = /<b>([\s\S]*?)<\/b>/.exec(block);
    if (href && title) {
      const rest = block.slice(block.indexOf('</b>') + 4, block.indexOf('</a>'));
      const location = clean(rest).replace(/^in\s+/i, '');
      // company: last <p>…</p> in the 2500 chars before the title block
      const before = html.slice(Math.max(0, idx - 2500), idx);
      const ps = [...before.matchAll(/<p>([^<]{1,80})<\/p>/g)];
      const company = ps.length ? clean(ps[ps.length - 1][1]) : '';
      let url = '';
      try {
        const u = new URL(href[1], BASE);
        if (u.protocol === 'https:' && u.hostname === TRUSTED_HOST) url = u.href;
      } catch {
        url = '';
      }
      const t = clean(title[1]);
      // real postings look like /{country}/{city}/{company}/{slug}-{id}; skip sponsored ad cards
      const realShape = url && /^\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+\/[a-z0-9-]+-\d+$/i.test(new URL(url).pathname);
      const isAd = url.includes('/the-global-move/'); // paid newsletter promo posing as a job card
      if (realShape && !isAd && t) out.push({ title: t, url, company, location });
    }
    idx = next;
  }
  return out;
}

/** @type {Provider} */
export default {
  id: 'relocateme',

  async fetch(entry, ctx) {
    const requested = Number(entry?.max_pages);
    const maxPages = Number.isFinite(requested) && requested > 0 ? Math.min(requested, HARD_CAP) : DEFAULT_MAX_PAGES;
    /** @type {Map<string, any>} */
    const seen = new Map();
    for (let page = 1; page <= maxPages; page++) {
      const url = `${BASE}/international-jobs${page > 1 ? `?page=${page}` : ''}`;
      const html = await ctx.fetchText(url, { redirect: 'error', headers: { 'User-Agent': BROWSER_LIKE_USER_AGENT } });
      const jobs = parseRelocatePage(html);
      let added = 0;
      for (const j of jobs) {
        if (!seen.has(j.url)) {
          seen.set(j.url, j);
          added++;
        }
      }
      if (jobs.length === 0 || added === 0) break;
    }
    return [...seen.values()];
  },
};
