// @ts-check
// plugins.local/webintel/_jobs.mjs: SearchHit → scanner Job, plus "board
// candidates": a hit on a board career-ops already has a free provider for
// (Workable, SmartRecruiters, Recruitee, …) means that company's whole board
// can be added to portals.yml once and scanned for free forever after. That
// compounding is the main reason paid discovery is worth a few cents at all.

/** Known board hosts → { vendor, slug(url) }. Vendors listed have a free provider in providers/. */
const BOARD_PATTERNS = [
  { vendor: 'workable', re: /^apply\.workable\.com$/i, slug: (/** @type {URL} */ u) => u.pathname.split('/')[1] },
  { vendor: 'smartrecruiters', re: /^(jobs|careers)\.smartrecruiters\.com$/i, slug: (u) => u.pathname.split('/')[1] },
  { vendor: 'recruitee', re: /^([a-z0-9-]+)\.recruitee\.com$/i, slug: (u) => u.hostname.split('.')[0] },
  { vendor: 'breezy', re: /^([a-z0-9-]+)\.breezy\.hr$/i, slug: (u) => u.hostname.split('.')[0] },
  { vendor: 'bamboohr', re: /^([a-z0-9-]+)\.bamboohr\.com$/i, slug: (u) => u.hostname.split('.')[0] },
  { vendor: 'teamtailor', re: /^([a-z0-9-]+)\.teamtailor\.com$/i, slug: (u) => u.hostname.split('.')[0] },
  { vendor: 'personio', re: /^([a-z0-9-]+)\.jobs\.personio\.(de|com)$/i, slug: (u) => u.hostname.split('.')[0] },
  { vendor: 'pinpoint', re: /^([a-z0-9-]+)\.pinpointhq\.com$/i, slug: (u) => u.hostname.split('.')[0] },
  { vendor: 'jobvite', re: /^jobs\.jobvite\.com$/i, slug: (u) => u.pathname.split('/')[1] },
  { vendor: 'rippling', re: /^ats\.rippling\.com$/i, slug: (u) => u.pathname.split('/')[1] },
];

/** Hosts with a company slug but no free provider yet (still useful to name the company). */
const SLUG_HOSTS = [
  /^([a-z0-9-]+)\.keka\.com$/i, /^([a-z0-9-]+)\.zohorecruit\.(com|in)$/i, /^([a-z0-9-]+)\.freshteam\.com$/i,
  /^([a-z0-9-]+)\.applytojob\.com$/i, /^([a-z0-9-]+)\.kula\.ai$/i,
];

const TWO_PART_TLDS = new Set(['co.in', 'co.uk', 'com.au', 'co.jp', 'com.br', 'com.sg', 'org.in', 'net.in', 'ac.in']);

/** "acme-labs" → "Acme Labs" @param {string} slug */
export function humanize(slug) {
  return decodeURIComponent(String(slug || ''))
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** @param {string} url @returns {{ vendor: string, slug: string } | null} */
export function boardOf(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  for (const p of BOARD_PATTERNS) {
    if (p.re.test(u.hostname)) {
      const slug = p.slug(u);
      return slug ? { vendor: p.vendor, slug } : null;
    }
  }
  return null;
}

/** Best-effort employer name from the URL; '?' (tracker convention) when unknown. @param {string} url */
export function companyFromUrl(url) {
  let u;
  try { u = new URL(url); } catch { return '?'; }
  const b = boardOf(url);
  if (b) return humanize(b.slug);
  for (const re of SLUG_HOSTS) {
    const m = u.hostname.match(re);
    if (m) return humanize(m[1]);
  }
  const labels = u.hostname.toLowerCase().replace(/^www\./, '').split('.');
  const lastTwo = labels.slice(-2).join('.');
  const core = TWO_PART_TLDS.has(lastTwo) ? labels[labels.length - 3] : labels[labels.length - 2];
  return core ? humanize(core) : '?';
}

/**
 * Clean a page title into a role title: drop "Job Application for", trailing
 * " | Site" / " - Company" segments and " at Company".
 * @param {string|null} title
 * @param {string} company
 */
export function cleanTitle(title, company) {
  let t = String(title || '').replace(/^job application for\s+/i, '').trim();
  t = t.split(/\s+[|•·]\s+/)[0].trim();
  if (company && company !== '?') {
    const c = company.toLowerCase();
    const parts = t.split(/\s+[-–—]\s+/);
    if (parts.length > 1) t = parts.filter((p) => p.toLowerCase() !== c && !p.toLowerCase().includes('careers')).join(' - ') || parts[0];
    t = t.replace(new RegExp(`\\s+at\\s+${company.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'i'), '');
  }
  return t.trim();
}

/**
 * @param {{ url: string, title: string|null }} hit
 * @returns {{ title: string, url: string, company: string, location: string } | null}
 */
export function hitToJob(hit) {
  const company = companyFromUrl(hit.url);
  const title = cleanTitle(hit.title, company);
  if (!title) return null;
  // Location is left empty on purpose: scan.mjs passes empty locations, and the
  // gate reads the real location/remote scope from the JD text later.
  return { title, url: hit.url, company, location: '' };
}
