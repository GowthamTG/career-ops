// @ts-check
// plugins.local/webintel/_policy.mjs: what may be sent to a third-party API.
//
// Every target URL passes through vetTargetUrl() BEFORE it reaches Exa or
// Firecrawl. It keeps internal/private URLs from leaking to a vendor, strips
// credential-looking query params, and refuses hosts that are login-walled or
// disallow automated access (CLAUDE.local.md "Job sources"): fetching those
// wastes free credits and breaks house rules.

import { resolveAndValidate } from '../../plugins/_net.mjs';
import { normalizeUrl } from '../../url-key.mjs';
import { CODES, WebError } from './_errors.mjs';

/** Never sent to Exa/Firecrawl: robots/ToS/login walls, and social sites. */
export const DENY_HOSTS = Object.freeze([
  'linkedin.com', 'indeed.com', 'indeed.co.in', 'naukri.com', 'glassdoor.com', 'glassdoor.co.in',
  'foundit.in', 'monster.com', 'monsterindia.com', 'wellfound.com', 'angel.co', 'levels.fyi',
  'ziprecruiter.com', 'simplyhired.com', 'jooble.org', 'talent.com', 'internshala.com', 'shine.com',
  'workatastartup.com', 'builtin.com', 'x.com', 'twitter.com', 'facebook.com', 'instagram.com',
  'cutshort.io', 'hirist.tech', 'hirist.com', 'instahyre.com',
  'clanx.ai', 'builtinbengaluru.in',
]);

/**
 * Social post permalinks that may appear as SEARCH RESULTS in social mode
 * (index.mjs → _social.mjs). They stay on DENY_HOSTS: vetTargetUrl() still
 * refuses to fetch them, so a post is only ever read from the search index's
 * own text, never requested from linkedin.com or x.com by us.
 * Paths are prefixes; a bare host means the whole host.
 */
export const SOCIAL_SEARCH_HOSTS = Object.freeze([
  'linkedin.com/posts', 'linkedin.com/feed/update', 'x.com', 'twitter.com',
]);

/** Is this URL a social post permalink we may accept as a search hit? @param {string} url */
export function isSocialHit(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const host = u.hostname.toLowerCase();
  return SOCIAL_SEARCH_HOSTS.some((entry) => {
    const [domain, ...rest] = entry.split('/');
    const prefix = rest.length ? `/${rest.join('/')}` : '';
    return hostMatches(host, domain) && (!prefix || u.pathname.startsWith(`${prefix}/`) || u.pathname === prefix);
  });
}

/**
 * Job aggregators and scraper sites seen in real discovery results (2026-09-22).
 * They re-list other companies' postings, often stale or truncated, so paid
 * discovery excludes them; the employer's own posting is what we want.
 */
export const AGGREGATOR_HOSTS = Object.freeze([
  'emploive.com', 'confidential.careers', 'digitalxnode.com', 'unojobs.com', 'jobspring.pro',
  'simplify.jobs', 'wfh.team', 'zya.me', 'fast-page.org', 'angelandgenie.com', 'weekday.works',
  'jooble.org', 'adzuna.in', 'adzuna.com', 'careerjet.co.in', 'careerjet.com', 'jobrapido.com',
  'whatjobs.com', 'jobleads.com', 'bebee.com', 'tallo.com', 'himalayas.app', 'remoterocketship.com',
  // seen in the first full --web run (2026-09-22)
  'jobboard.co.in', 'joblaze.com', 'thejobcompany.co.in', 'jobs.generalcatalyst.com', 'getro.com',
]);

/**
 * Boards the free scanners already cover completely (scan.mjs + scan-ats-full.mjs).
 * Paid discovery there is pure waste, so discovery searches exclude them.
 */
export const FREE_ATS_HOSTS = Object.freeze([
  'boards.greenhouse.io', 'job-boards.greenhouse.io', 'greenhouse.io', 'jobs.lever.co', 'jobs.ashbyhq.com',
]);

const SECRET_PARAM_RE = /^(token|access_token|auth|authorization|key|api_key|apikey|sig|signature|session|sessionid|password|pwd|code|otp)$/i;

/** @param {string} host @param {string} domain */
export function hostMatches(host, domain) {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  return h === d || h.endsWith(`.${d}`);
}

/** @param {string} host @param {readonly string[]} list */
export function hostInList(host, list) {
  return list.some((d) => hostMatches(host, d));
}

/**
 * Canonical form used for cache keys and for what we send: normalizeUrl()
 * (tracking params dropped, https, no fragment) minus credential-like params.
 * Returns '' when the input isn't an http(s) URL.
 * @param {string} raw
 */
export function canonicalUrl(raw) {
  const norm = normalizeUrl(raw);
  if (!norm) return '';
  const u = new URL(norm);
  for (const k of [...u.searchParams.keys()]) {
    if (SECRET_PARAM_RE.test(k)) u.searchParams.delete(k);
  }
  u.username = '';
  u.password = '';
  return u.toString();
}

/**
 * @param {string} raw
 * @param {{ denyHosts?: readonly string[], resolve?: (host: string) => Promise<unknown> }} [opts]
 *   `resolve` is injectable for tests; it must throw for private/loopback/metadata hosts.
 * @returns {Promise<string>} the canonical URL that is safe to send
 * @throws {WebError} BLOCKED_URL
 */
export async function vetTargetUrl(raw, { denyHosts = DENY_HOSTS, resolve = resolveAndValidate } = {}) {
  const url = canonicalUrl(raw);
  if (!url) throw new WebError(CODES.BLOCKED_URL, 'policy', 'not an http(s) URL');
  const { hostname } = new URL(url);
  if (!hostname.includes('.')) throw new WebError(CODES.BLOCKED_URL, 'policy', `bare hostname ${hostname}`);
  if (hostInList(hostname, denyHosts)) throw new WebError(CODES.BLOCKED_URL, 'policy', `${hostname} is on the deny list (login wall / robots / ToS)`);
  try {
    await resolve(hostname);
  } catch (err) {
    throw new WebError(CODES.BLOCKED_URL, 'policy', `${hostname} failed the SSRF check: ${String(/** @type {any} */ (err)?.message || err).slice(0, 120)}`);
  }
  return url;
}
