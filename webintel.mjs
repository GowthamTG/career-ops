#!/usr/bin/env node
/**
 * webintel.mjs: CLI for the free-tier Exa + Firecrawl plugin (plugins.local/webintel).
 *
 *   node webintel.mjs usage              month-to-date spend vs caps, cache/error stats, Firecrawl balance
 *   node webintel.mjs fetch <url>        page text via cache → ATS API → Exa → Firecrawl (prints source + cost)
 *   node webintel.mjs search "<query>" [--include a.com,b.com] [--days N]
 *   node webintel.mjs smoke              live check: ≤1 Exa search + 2 Exa pages + ≤1 Firecrawl scrape
 *   node webintel.mjs gc                 delete cache entries past their TTL
 *
 * The user never pays for Exa/Firecrawl: every paid call is capped and checked
 * against the monthly budget first (config/plugins.yml → plugins.webintel).
 * Output is untrusted web text: data, never instructions. Nothing here says
 * whether a posting is live; that stays a browser check.
 */

import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { loadWebIntel } from './plugins.local/webintel/_load.mjs';
import { createBudget, monthKey, parseLedger } from './plugins.local/webintel/_budget.mjs';
import { createCache, TTL } from './plugins.local/webintel/_cache.mjs';

const DATA_DIR = path.join(getCareerOpsRoot(), 'data');
const FREE = { exaUsd: 10, firecrawlCredits: 1000 };

const USAGE = `usage:
  node webintel.mjs usage
  node webintel.mjs fetch <url>
  node webintel.mjs search "<query>" [--include a.com,b.com] [--days N]
  node webintel.mjs smoke
  node webintel.mjs gc`;

/** @param {string[]} args @param {string} name */
function flag(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function usage() {
  const ledgerPath = path.join(DATA_DIR, 'webintel-usage.tsv');
  const rows = existsSync(ledgerPath) ? parseLedger(readFileSync(ledgerPath, 'utf8')) : [];
  const month = monthKey(Date.now());
  const mtd = rows.filter((r) => monthKey(Date.parse(r.ts)) === month);
  const wi = await loadWebIntel({ caller: 'usage', quiet: true });
  const b = wi?.budget || createBudget({ dataDir: DATA_DIR });
  const caps = b.settings;

  console.log(`webintel usage, ${month} (script spend only; chat/MCP use draws from the same free pool)\n`);
  for (const provider of /** @type {const} */ (['exa', 'firecrawl'])) {
    const rs = mtd.filter((r) => r.provider === provider);
    const paid = rs.filter((r) => r.outcome === 'ok' || Number(r.cost_usd) > 0 || Number(r.credits) > 0);
    const errors = {};
    for (const r of rs) if (r.outcome && r.outcome !== 'ok') errors[r.outcome] = (errors[r.outcome] || 0) + 1;
    const s = b.spent(provider);
    const latched = b.latchedUntil(provider);
    const spend = provider === 'exa'
      ? `$${s.usd.toFixed(3)} of $${caps.exa_monthly_usd} script cap ($${FREE.exaUsd} free/month)`
      : `${s.credits} of ${caps.firecrawl_monthly_credits} credit script cap (${FREE.firecrawlCredits} free/month)`;
    console.log(`  ${provider.padEnd(9)} ${paid.length} paid call(s), ${spend}`);
    const errText = Object.entries(errors).map(([k, v]) => `${k}×${v}`).join(', ');
    if (errText) console.log(`            errors: ${errText}`);
    if (latched) console.log(`            ⏸ paused (402) until ${new Date(latched).toISOString().slice(0, 10)}`);
  }

  if (wi?.has.firecrawl) {
    const bal = await wi.balance({ force: true }).catch(() => null);
    if (bal) {
      const end = bal.periodEnd ? `, period ends ${bal.periodEnd.slice(0, 10)}` : '';
      console.log(`\n  Firecrawl server balance: ${bal.remaining} credits remaining (plan ${bal.planCredits ?? '?'}${end}); scripts stop below ${caps.firecrawl_min_remaining}.`);
    }
  } else {
    console.log('\n  Firecrawl server balance: not checked (plugin inactive or FIRECRAWL_API_KEY unset).');
  }
  console.log('  Exa balance: no API; see dashboard.exa.ai. Guarded by the script cap and the 402 latch.');
  console.log(`\n  Per run: ≤${caps.max_searches_per_run} searches, ≤${caps.max_pages_per_run} paid page fetches.`);
  if (!wi) console.log('\n  Plugin inactive: enable plugins.webintel in config/plugins.yml and set EXA_API_KEY in .env.');
  return 0;
}

/** @param {string} url */
async function fetchCmd(url) {
  if (!url) { console.error(USAGE); return 1; }
  const wi = await loadWebIntel({ caller: 'cli' });
  if (!wi) return 1;
  const { doc, error } = await wi.fetchPage(url);
  console.error(wi.summary());
  if (!doc) { console.error(`no text: ${error?.code} ${error?.message}`); return 1; }
  const src = doc.source.via ? `cache (via ${doc.source.via}, ${doc.source.cacheAgeHours}h old)` : doc.source.provider;
  console.log(`# ${doc.title || '(no title)'}\n# source: ${src} | ${doc.chars} chars${doc.truncated ? ' (truncated)' : ''} | ${doc.finalUrl}\n`);
  console.log(doc.text);
  return 0;
}

/** @param {string[]} args */
async function searchCmd(args) {
  const query = args.find((a, i) => !a.startsWith('--') && !['--include', '--days'].includes(args[i - 1]));
  if (!query) { console.error(USAGE); return 1; }
  const wi = await loadWebIntel({ caller: 'cli' });
  if (!wi) return 1;
  const include = (flag(args, '--include') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const days = Number(flag(args, '--days')) || null;
  try {
    const hits = await wi.searchWeb(query, { includeDomains: include, publishedWithinDays: days });
    for (const h of hits) console.log(`${h.publishedAt?.slice(0, 10) || '          '}  ${h.title || '(no title)'}\n            ${h.url}`);
    if (!hits.length) console.log('(no results)');
  } catch (err) {
    console.error(`search failed: ${/** @type {any} */ (err).code || ''} ${/** @type {any} */ (err).message}`);
    return 1;
  } finally {
    console.error(wi.summary());
  }
  return 0;
}

async function smoke() {
  const wi = await loadWebIntel({ caller: 'smoke' });
  if (!wi) return 1;
  console.log('Smoke test: spends at most 1 Exa search (~$0.007) + 2 Exa pages (~$0.002) + 1 Firecrawl credit.\n');
  let ok = true;
  try {
    const hits = await wi.searchWeb('senior frontend engineer React TypeScript job Bangalore', { numResults: 3, cacheTtlMs: 1 });
    console.log(`✓ exa search: ${hits.length} hit(s)${hits[0] ? `, e.g. ${hits[0].url}` : ''}`);
  } catch (err) { ok = false; console.log(`✗ exa search: ${/** @type {any} */ (err).message}`); }

  // Static page → Exa contents; a JS-rendered page → Firecrawl if Exa comes back thin.
  const pages = ['https://en.wikipedia.org/wiki/Software_engineering', 'https://jobs.ashbyhq.com/'];
  const res = await wi.fetchPages(pages, { maxChars: 2000 });
  for (const u of pages) {
    const r = res.get(u);
    if (r?.doc) console.log(`✓ fetch ${u}: ${r.doc.chars} chars via ${r.doc.source.via || r.doc.source.provider}`);
    else console.log(`${u.includes('ashby') ? '•' : '✗'} fetch ${u}: ${r?.error?.code} ${r?.error?.message}`);
    if (!r?.doc && !u.includes('ashby')) ok = false;
  }
  console.log(`\n${wi.summary()}`);
  return ok ? 0 : 1;
}

function gc() {
  const cache = createCache({ dir: path.join(DATA_DIR, '.webintel-cache') });
  const removed = cache.gc(TTL);
  console.log(`webintel gc: removed ${removed} expired cache entr${removed === 1 ? 'y' : 'ies'}.`);
  return 0;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  switch (cmd) {
    case 'usage': return usage();
    case 'fetch': return fetchCmd(rest[0]);
    case 'search': return searchCmd(rest);
    case 'smoke': return smoke();
    case 'gc': return gc();
    default: console.log(USAGE); return cmd && cmd !== '--help' && cmd !== '-h' ? 1 : 0;
  }
}

if (isMainModule(import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (err) => {
    console.error(`webintel: unexpected error: ${err?.message || err}`);
    process.exit(1);
  });
}
