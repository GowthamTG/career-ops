// @ts-check
// plugins.local/webintel/_budget.mjs: keeps every call inside the FREE tier.
//
// The user will never pay for Exa or Firecrawl. So spending is checked BEFORE
// each network call, never reconciled afterwards:
//   - a local append-only ledger (data/webintel-usage.tsv) totals this month's
//     script spend against hard caps (config/plugins.yml → webintel settings);
//   - a 402 from a provider latches it off (data/.webintel-state.json) so later
//     calls short-circuit for free instead of hammering an empty account;
//   - for Firecrawl, the server's own remaining balance (a free endpoint) is
//     checked too, because chat/MCP usage draws from the same pool and never
//     shows up in the local ledger.
// Exa has no balance endpoint we know of, so its guard is the local cap (well
// under the $10 free credit) plus the 402 latch.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';
import { CODES, WebError } from './_errors.mjs';

export const DEFAULT_SETTINGS = Object.freeze({
  exa_monthly_usd: 4,               // of the $10/month free credit; the rest is left for chat MCP use
  firecrawl_monthly_credits: 250,   // of 1,000/month free
  firecrawl_min_remaining: 200,     // stop scripts when the server says fewer credits than this remain
  max_pages_per_run: 25,
  max_searches_per_run: 15,
});

/** Conservative per-unit estimates, used for the pre-call check only (actual Exa cost comes back in costDollars). */
export const ESTIMATE = Object.freeze({
  exaSearchUsd: 0.007,   // $7 / 1k searches, ≤10 results, no contents
  exaPageUsd: 0.001,     // $1 / 1k pages of text
  firecrawlScrapeCredits: 1,
});

const LEDGER_HEADER = ['ts', 'run_id', 'caller', 'provider', 'op', 'units', 'cost_usd', 'credits', 'cache', 'outcome', 'request_id', 'url_hash'];
const BALANCE_TTL_MS = 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** @param {string} s */
export function shortHash(s) {
  return createHash('sha256').update(String(s)).digest('hex').slice(0, 12);
}

/** @param {unknown} v */
function tsvCell(v) {
  return String(v ?? '').replace(/[\t\r\n]+/g, ' ');
}

/** Local calendar month key, e.g. "2026-09". @param {number} ms */
export function monthKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * @param {string} text
 * @returns {Array<Record<string,string>>}
 */
export function parseLedger(text) {
  const lines = String(text || '').split('\n').filter(Boolean);
  if (!lines.length) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map((line) => {
    const cells = line.split('\t');
    /** @type {Record<string,string>} */
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] ?? ''; });
    return row;
  });
}

/**
 * @param {{ dataDir: string, settings?: object, now?: () => number, runId?: string, caller?: string }} opts
 */
export function createBudget({ dataDir, settings = {}, now = () => Date.now(), runId = shortHash(String(Date.now()) + Math.random()), caller = 'cli' }) {
  const cfg = { ...DEFAULT_SETTINGS, ...pickNumbers(settings) };
  const ledgerPath = path.join(dataDir, 'webintel-usage.tsv');
  const statePath = path.join(dataDir, '.webintel-state.json');

  function readState() {
    try {
      return existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : {};
    } catch {
      return {};
    }
  }
  /** @param {object} state */
  function writeState(state) {
    mkdirSync(dataDir, { recursive: true });
    const tmp = `${statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, statePath);
  }

  function readLedger() {
    try {
      return existsSync(ledgerPath) ? parseLedger(readFileSync(ledgerPath, 'utf8')) : [];
    } catch {
      return [];
    }
  }

  /** Month-to-date script spend for one provider. @param {'exa'|'firecrawl'} provider */
  function spent(provider) {
    const month = monthKey(now());
    let usd = 0;
    let credits = 0;
    for (const r of readLedger()) {
      if (r.provider !== provider) continue;
      const t = Date.parse(r.ts);
      if (!Number.isFinite(t) || monthKey(t) !== month) continue;
      usd += Number(r.cost_usd) || 0;
      credits += Number(r.credits) || 0;
    }
    return { usd, credits };
  }

  /** @param {'exa'|'firecrawl'} provider */
  function latchedUntil(provider) {
    const until = readState()?.latch?.[provider];
    return typeof until === 'number' && until > now() ? until : null;
  }

  /**
   * Throws unless `provider` may spend this much more this month.
   * @param {'exa'|'firecrawl'} provider
   * @param {{ usd?: number, credits?: number }} est
   */
  function check(provider, est) {
    const until = latchedUntil(provider);
    if (until) throw new WebError(CODES.QUOTA_402, provider, `free credits exhausted, paused until ${new Date(until).toISOString().slice(0, 10)}`);
    const s = spent(provider);
    if (provider === 'exa' && s.usd + (est.usd || 0) > cfg.exa_monthly_usd) {
      throw new WebError(CODES.BUDGET_EXHAUSTED, provider, `monthly script cap reached ($${s.usd.toFixed(3)} of $${cfg.exa_monthly_usd})`);
    }
    if (provider === 'firecrawl' && s.credits + (est.credits || 0) > cfg.firecrawl_monthly_credits) {
      throw new WebError(CODES.BUDGET_EXHAUSTED, provider, `monthly script cap reached (${s.credits} of ${cfg.firecrawl_monthly_credits} credits)`);
    }
  }

  /**
   * Pause a provider after a 402. Firecrawl pauses until its billing period ends
   * when we know it; otherwise 24h (a 402 costs nothing, so a daily re-probe is fine).
   * @param {'exa'|'firecrawl'} provider
   */
  function latch(provider) {
    const state = readState();
    const periodEnd = provider === 'firecrawl' ? Date.parse(state?.firecrawlBalance?.periodEnd || '') : NaN;
    const until = Number.isFinite(periodEnd) && periodEnd > now() ? periodEnd : now() + DAY_MS;
    state.latch = { ...(state.latch || {}), [provider]: until };
    writeState(state);
    return until;
  }

  /**
   * Server-side floor for Firecrawl. `fetchBalance` returns
   * { remaining, planCredits, periodStart, periodEnd } (free endpoint); cached 1h.
   * A failed probe does not block: the local cap still applies.
   * @param {() => Promise<{ remaining: number, planCredits?: number, periodStart?: string|null, periodEnd?: string|null }>} fetchBalance
   * @param {{ force?: boolean }} [opts]
   */
  async function firecrawlBalance(fetchBalance, { force = false } = {}) {
    const state = readState();
    const cached = state.firecrawlBalance;
    if (!force && cached && now() - cached.checkedAt < BALANCE_TTL_MS) return cached;
    try {
      const b = await fetchBalance();
      const fresh = { ...b, checkedAt: now() };
      writeState({ ...readState(), firecrawlBalance: fresh });
      return fresh;
    } catch {
      return cached || null;
    }
  }

  /** @param {Awaited<ReturnType<typeof firecrawlBalance>>} balance */
  function checkFirecrawlFloor(balance) {
    if (balance && typeof balance.remaining === 'number' && balance.remaining < cfg.firecrawl_min_remaining) {
      throw new WebError(CODES.BUDGET_EXHAUSTED, 'firecrawl', `only ${balance.remaining} free credits left (floor ${cfg.firecrawl_min_remaining}), leaving them for chat use`);
    }
  }

  /**
   * @param {{ provider: string, op: string, units?: number, costUsd?: number, credits?: number,
   *           cache?: string, outcome?: string, requestId?: string|null, url?: string }} row
   */
  function record(row) {
    mkdirSync(dataDir, { recursive: true });
    if (!existsSync(ledgerPath)) appendFileSync(ledgerPath, `${LEDGER_HEADER.join('\t')}\n`);
    const cells = [
      new Date(now()).toISOString(), runId, caller, row.provider, row.op, row.units ?? 1,
      (row.costUsd ?? 0).toFixed(5), row.credits ?? 0, row.cache ?? 'miss', row.outcome ?? 'ok',
      row.requestId ?? '', row.url ? shortHash(row.url) : '',
    ];
    appendFileSync(ledgerPath, `${cells.map(tsvCell).join('\t')}\n`);
  }

  return {
    settings: cfg, runId, ledgerPath, statePath,
    spent, check, latch, latchedUntil, firecrawlBalance, checkFirecrawlFloor, record, readLedger,
  };
}

/** Keep only numeric overrides so a stray string in plugins.yml can't disable a cap. @param {object} s */
function pickNumbers(s) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [k, v] of Object.entries(s || {})) {
    if (k in DEFAULT_SETTINGS && typeof v === 'number' && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  return out;
}
