#!/usr/bin/env node
/**
 * naukri-auto-apply.mjs — Playwright automation for Naukri's native
 * "Quick apply" flow.
 *
 * Naukri's "Quick apply" is not a single click: every job routes through a
 * per-job chatbot asking 1-8 screening questions (skill-years, relocation,
 * notice period, current company, tech-stack checkboxes...). This script
 * answers those questions from config/naukri-answers.yml and
 * config/profile.yml ONLY — never from an LLM, never by guessing. Any
 * question it can't map to a real, sourced fact makes it abandon that one
 * application and log it for manual review. No fabricated answers ever get
 * submitted.
 *
 * Auth: by default, uses the ISOLATED session set up by `node naukri-login.mjs`
 * — a separate Chrome profile that never touches your real Chrome, so it
 * can't log you out of anything or lock your everyday browser. Run
 * naukri-login.mjs once (real browser window, log in normally — use
 * Naukri's email/password login if "Sign in with Google" gets blocked as
 * an automated browser) before running this script.
 *
 * Advanced/not recommended: --real-chrome-profile launches your actual
 * Chrome profile instead. This has caused real problems in practice
 * (profile lock left stuck after a bad run, logged-out sessions) — only use
 * it if you've deliberately accepted that risk. Chrome must be fully quit
 * first; the script auto-clears a stale lock from a crashed prior run and
 * always releases the lock on exit (including Ctrl+C), but the safest
 * option is still the isolated session above.
 *
 * Scope: only applies to titles that look like software/senior-software,
 * frontend, backend, or full-stack roles (see TITLE_ALLOW/TITLE_DENY below).
 * Only "Quick apply" (native Naukri) listings are attempted — a job whose
 * only path is "On company site" (external ATS) is skipped, since that would
 * need a separate, per-company form-fill this script doesn't attempt.
 *
 * Usage:
 *   node naukri-auto-apply.mjs --dry-run --headed --limit 3  # verify it first
 *   node naukri-auto-apply.mjs --recommended --limit 25      # crawl recommended-jobs feed
 *   node naukri-auto-apply.mjs --search "software engineer" --location bangalore --limit 25
 *
 *   # Sweep everything at once — every keyword × every location, one shared
 *   # limit budget, comma-separated:
 *   node naukri-auto-apply.mjs --headed --limit 25 --pages 10 \
 *     --search "software engineer,senior software engineer,frontend developer,backend developer,full stack developer,react developer,node developer" \
 *     --location "bangalore,chennai,remote"
 *
 *   # Same, but keep running forever, sweeping again every hour so new
 *   # postings get picked up automatically. Ctrl+C to stop.
 *   node naukri-auto-apply.mjs --headed --limit 25 --pages 10 --loop --loop-minutes 60 \
 *     --search "software engineer,senior software engineer,frontend developer,backend developer,full stack developer,react developer,node developer" \
 *     --location "bangalore,chennai,remote"
 *
 * Flags:
 *   --dry-run                classify + log what WOULD happen, click nothing
 *   --headed                  show the browser instead of headless (recommended for the first run)
 *   --limit N                 stop after N applications total, across every keyword/location combo (default 25)
 *   --scrolls N                recommended-feed scroll passes to load more cards (default 6)
 *   --search "kw1,kw2,..."      comma-separated keywords to sweep instead of the recommended feed
 *   --location "loc1,loc2,..."  comma-separated locations to sweep for each keyword (default: bangalore)
 *   --experience N             experience filter for --search, in years (default 4)
 *   --pages N                   pages of --search results to page through, per keyword/location (default 3)
 *   --urls "url1,url2,..."      classify + process these specific job URLs directly, skipping search/recommended entirely (spot-checks / re-runs)
 *   --recommended              also crawl the recommended-jobs feed (default if no --search given)
 *   --loop                     keep sweeping forever instead of exiting after one pass (Ctrl+C to stop)
 *   --loop-minutes N            minutes to sleep between sweeps in --loop mode (default 60)
 *   --real-chrome-profile          use your real Chrome profile instead of the isolated session (see warning above)
 *   --chrome-profile "Name"        Chrome profile DIRECTORY name for --real-chrome-profile (default: Default)
 *
 * Every outcome (applied / skipped + reason / on-company-site / out-of-scope)
 * is appended to data/naukri-applied.tsv for audit and later tracker sync.
 */

import { chromium } from 'playwright';
import { readFileSync, existsSync, mkdirSync, appendFileSync, readlinkSync, unlinkSync } from 'fs';
import * as yaml from 'js-yaml';
import { join } from 'path';
import { homedir, platform } from 'os';

const ROOT = process.cwd();
const ISOLATED_SESSION_STATE = join(ROOT, 'data', '.naukri-session', 'state.json');
const LOG_PATH = join(ROOT, 'data', 'naukri-applied.tsv');
const PROFILE_PATH = join(ROOT, 'config', 'profile.yml');
const ANSWERS_PATH = join(ROOT, 'config', 'naukri-answers.yml');

function defaultChromeUserDataDir() {
  const home = homedir();
  switch (platform()) {
    case 'darwin': return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
    case 'win32': return join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
    default: return join(home, '.config', 'google-chrome'); // linux
  }
}

// ── Scope filter ─────────────────────────────────────────────────────
// "software jobs and senior software jobs, front-end and back-end" — the
// user's own scope. Title-only filter, not a fit evaluation.
const TITLE_ALLOW = /(software|sde\b|full[\s-]?stack|frontend|front[\s-]?end|backend|back[\s-]?end|developer|programmer)/i;
// \bsales\b (not bare "sales") so a Salesforce-platform title/skill
// ("Software Engineer-Salesforce", skill "Salesforce") doesn't false-match —
// confirmed live: bare "sales" matched inside "Salesforce" and wrongly
// excluded a real software-engineer posting.
const TITLE_DENY = /(research scientist|research expert|subject matter expert|domain expert|\bsales\b|marketing|\bhr\b|recruiter|talent acquisition|business analyst|\bqa\b|quality assurance|data scientist|data analyst|designer|product manager|program manager|project manager|delivery manager|scrum master|business development)/i;

// ── Args ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, def) => { const i = args.indexOf(f); return i !== -1 && args[i + 1] ? args[i + 1] : def; };

const DRY_RUN = has('--dry-run');
const HEADED = has('--headed');
const LIMIT = parseInt(val('--limit', '25'), 10);
const SCROLLS = parseInt(val('--scrolls', '6'), 10);
const splitList = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : []);
const SEARCH_KEYWORDS = splitList(val('--search', null));
const SEARCH_LOCATIONS = splitList(val('--location', 'bangalore'));
const SEARCH_EXPERIENCE = val('--experience', '4');
const SEARCH_PAGES = parseInt(val('--pages', '3'), 10);
const URLS = splitList(val('--urls', null));
const USE_RECOMMENDED = has('--recommended') || (SEARCH_KEYWORDS.length === 0 && URLS.length === 0);
const LOOP = has('--loop');
const LOOP_MINUTES = parseInt(val('--loop-minutes', '60'), 10);
const CHROME_PROFILE = val('--chrome-profile', 'Default');
const ISOLATED_SESSION = !has('--real-chrome-profile'); // default: isolated session (safe)

// ── Config ───────────────────────────────────────────────────────────

function loadYaml(path) {
  if (!existsSync(path)) return null;
  return yaml.load(readFileSync(path, 'utf8')) || {};
}

const profile = loadYaml(PROFILE_PATH);
const answers = loadYaml(ANSWERS_PATH);

if (!answers && !DRY_RUN) {
  console.error(`Missing ${ANSWERS_PATH}.`);
  console.error(`Copy config/naukri-answers.example.yml to config/naukri-answers.yml and fill in your real numbers first.`);
  process.exit(1);
}
if (ISOLATED_SESSION && !existsSync(ISOLATED_SESSION_STATE)) {
  console.error(`No saved isolated session found at ${ISOLATED_SESSION_STATE}.`);
  console.error(`Run: node naukri-login.mjs`);
  process.exit(1);
}

const REVIEW_PATH = join(ROOT, 'data', 'naukri-skipped-for-review.tsv');

mkdirSync(join(ROOT, 'data'), { recursive: true });
if (!existsSync(LOG_PATH)) {
  appendFileSync(LOG_PATH, 'timestamp\turl\ttitle\tstatus\tdetail\n');
}
if (!existsSync(REVIEW_PATH)) {
  // valuation/backers are NOT available from Naukri — the script leaves
  // them blank on purpose. Fill them in by hand, or ask Claude to research
  // a batch of companies from this file and fill the columns in.
  appendFileSync(REVIEW_PATH, 'timestamp\tcompany\trole\turl\treason\tdisclosed_comp_lpa\tvaluation\tbackers\n');
}

function logRow(url, title, status, detail) {
  const clean = (s) => (s || '').toString().replace(/\t/g, ' ').replace(/\n/g, ' ').slice(0, 300);
  appendFileSync(LOG_PATH, [new Date().toISOString(), url, clean(title), status, clean(detail)].join('\t') + '\n');
}

// One row per skipped job, for manual review — company/role/url/reason are
// captured now (already on the card); valuation/backers stay blank here.
function logSkipForReview(company, role, url, reason, compRange) {
  const clean = (s) => (s || '').toString().replace(/\t/g, ' ').replace(/\n/g, ' ').slice(0, 300);
  const comp = compRange ? `${compRange[0]}-${compRange[1]}` : '';
  appendFileSync(REVIEW_PATH, [new Date().toISOString(), clean(company), clean(role), url, clean(reason), comp, '', ''].join('\t') + '\n');
}

function alreadyProcessed(url) {
  if (!existsSync(LOG_PATH)) return false;
  const key = url.split('?')[0];
  return readFileSync(LOG_PATH, 'utf8').split('\n').some((r) => r.startsWith('') && r.includes(key));
}

// ── Answer engine ────────────────────────────────────────────────────
// Every function here either returns a concrete answer sourced from
// config/naukri-answers.yml or config/profile.yml, or returns
// { type: 'skip' }. It never invents a value.

const noticeDays = profile?.cover_letter?.notice_period_days ?? null;

function isNoticeQuestion(q) { return /notice period/i.test(q); }
function isCurrentCompanyQuestion(q) { return /current (company|organisation|organization|employer)/i.test(q); }
function isCurrentCtcQuestion(q) { return /current\s+(ctc|salary)/i.test(q); }
function isExpectedCtcQuestion(q) { return /expected\s+(ctc|salary)/i.test(q); }
function isOfferQuestion(q) { return /holding any (other )?offers?/i.test(q) || /other offers?\b/i.test(q); }
function isRelocationQuestion(q) {
  return /relocat/i.test(q) || /currently living/i.test(q) || /work from office/i.test(q) || /willing to (move|work)/i.test(q) || /based in/i.test(q);
}
function isYearsExperienceQuestion(q) {
  return /years?\s+of\s+(professional\s+)?experience/i.test(q) || /experience\s+do you have/i.test(q);
}

function findSkillYears(q) {
  const text = q.toLowerCase();
  const keys = Object.keys(answers.skill_years || {}).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    if (text.includes(k.toLowerCase())) return { skill: k, years: answers.skill_years[k] };
  }
  return null;
}

// Parse a chatbot option label into a numeric range + unit.
// unit is 'years' unless the label itself says otherwise (days/months).
function parseBucket(label) {
  const s = (label || '').trim().toLowerCase();
  if (!s) return null;
  if (/no experience|not applicable|^n\/a$/.test(s)) return { min: 0, max: 0, unit: 'years' };
  if (/immediate/.test(s)) return { min: 0, max: 0, unit: 'days' };
  if (/basic knowledge/.test(s)) return { min: 0, max: 0.5, unit: 'years' };
  let m;
  if ((m = s.match(/^(\d+)\s*day/))) return { min: Number(m[1]), max: Number(m[1]), unit: 'days' };
  if ((m = s.match(/^(\d+)\s*month/))) return { min: Number(m[1]), max: Number(m[1]), unit: 'months' };
  if ((m = s.match(/^<\s*(\d+)/))) return { min: 0, max: Number(m[1]) - 0.01, unit: 'years' };
  if ((m = s.match(/^>\s*(\d+)/))) return { min: Number(m[1]) + 0.01, max: Infinity, unit: 'years' };
  if ((m = s.match(/^(\d+)\s*\+/))) return { min: Number(m[1]), max: Infinity, unit: 'years' };
  if ((m = s.match(/^(\d+)\s*-\s*(\d+)/))) return { min: Number(m[1]), max: Number(m[2]), unit: 'years' };
  if ((m = s.match(/^(\d+)$/))) return { min: Number(m[1]), max: Number(m[1]), unit: 'years' };
  return null;
}

function convert(value, fromUnit, toUnit) {
  if (fromUnit === toUnit) return value;
  const toDays = { days: 1, months: 30, years: 365 };
  return (value * toDays[fromUnit]) / toDays[toUnit];
}

// options: [{value, label}]. targetValue/targetUnit describe the honest fact.
function pickBucket(options, targetValue, targetUnit) {
  const parsed = options
    .map((o) => ({ ...o, range: parseBucket(o.label || o.value) }))
    .filter((o) => o.range);
  if (parsed.length === 0) return null;
  const norm = parsed.map((o) => ({
    ...o,
    min: convert(o.range.min, o.range.unit, targetUnit),
    max: o.range.max === Infinity ? Infinity : convert(o.range.max, o.range.unit, targetUnit),
  }));
  let hit = norm.find((o) => targetValue >= o.min && targetValue <= o.max);
  if (hit) return hit;
  let best = null, bestDist = Infinity;
  for (const o of norm) {
    const dist = targetValue < o.min ? o.min - targetValue : (o.max !== Infinity ? targetValue - o.max : 0);
    if (dist < bestDist) { bestDist = dist; best = o; }
  }
  return best;
}

/**
 * Returns one of:
 *   { type: 'select', value }   — click the option whose `value` this is
 *   { type: 'text', value }     — type this string into the free-text box
 *   { type: 'checkbox', values } — check every option whose value is in this list
 *   { type: 'skip', reason }    — no honest answer available; abandon the application
 */
function answerQuestion(q, widget) {
  if (isNoticeQuestion(q)) {
    if (noticeDays == null) return { type: 'skip', reason: 'no notice_period_days in profile.yml' };
    if (widget.type === 'options') {
      const best = pickBucket(widget.options, noticeDays, 'days');
      if (best) return { type: 'select', value: best.value };
      return { type: 'skip', reason: 'could not match notice-period options' };
    }
    return { type: 'text', value: String(noticeDays) };
  }

  if (isCurrentCompanyQuestion(q)) {
    if (!answers.current_company) return { type: 'skip', reason: 'no current_company configured' };
    return { type: 'text', value: answers.current_company };
  }

  if (isCurrentCtcQuestion(q)) {
    if (answers.current_ctc == null) return { type: 'skip', reason: 'no current_ctc configured (left null on purpose)' };
    if (widget.type === 'options') {
      const best = pickBucket(widget.options, answers.current_ctc, 'years'); // unitless bucket, treated as raw number
      if (best) return { type: 'select', value: best.value };
    }
    return { type: 'text', value: String(answers.current_ctc) };
  }

  if (isExpectedCtcQuestion(q)) {
    if (answers.expected_ctc == null) return { type: 'skip', reason: 'no expected_ctc configured (left null on purpose)' };
    if (widget.type === 'options') {
      const best = pickBucket(widget.options, answers.expected_ctc, 'years');
      if (best) return { type: 'select', value: best.value };
    }
    return { type: 'text', value: String(answers.expected_ctc) };
  }

  if (isOfferQuestion(q)) {
    if (widget.type !== 'options') return { type: 'skip', reason: 'unexpected widget for offers question' };
    if (answers.holding_offers == null) return { type: 'skip', reason: 'holding_offers not configured' };
    const wantYes = String(answers.holding_offers).toLowerCase() === 'yes';
    const opt = widget.options.find((o) => /^yes/i.test(o.value) === wantYes && (wantYes ? /^yes/i.test(o.value) : /^no/i.test(o.value)));
    return opt ? { type: 'select', value: opt.value } : { type: 'skip', reason: 'no matching yes/no option' };
  }

  if (isRelocationQuestion(q)) {
    if (widget.type !== 'options') return { type: 'skip', reason: 'unexpected widget for relocation question' };
    const reloc = answers.relocation || {};
    const text = q.toLowerCase();
    const namedCity = [...(reloc.already_located_in || []), ...(reloc.open_to_in_india || [])]
      .find((c) => text.includes(c.toLowerCase()));
    const yesOpt = widget.options.find((o) => /^yes/i.test(o.value));
    const noOpt = widget.options.find((o) => /^no/i.test(o.value));
    if (namedCity) return yesOpt ? { type: 'select', value: yesOpt.value } : { type: 'skip', reason: 'no Yes option found' };
    // No specific city named — check for "abroad"/"international" wording, else generic default.
    if (/abroad|international|outside india|overseas/.test(text)) {
      if (reloc.open_to_abroad && yesOpt) return { type: 'select', value: yesOpt.value };
      if (!reloc.open_to_abroad && noOpt) return { type: 'select', value: noOpt.value };
    }
    if (reloc.default_answer === 'yes' && yesOpt) return { type: 'select', value: yesOpt.value };
    if (reloc.default_answer === 'no' && noOpt) return { type: 'select', value: noOpt.value };
    return { type: 'skip', reason: `relocation question names a city outside configured policy: "${q}"` };
  }

  if (isYearsExperienceQuestion(q)) {
    const hit = findSkillYears(q);
    let years;
    if (hit) years = hit.years;
    else if (answers.unknown_skill_default === 'zero') years = 0;
    else return { type: 'skip', reason: `no skill_years entry matched: "${q}"` };

    if (widget.type === 'options') {
      const best = pickBucket(widget.options, years, 'years');
      if (best) return { type: 'select', value: best.value };
      return { type: 'skip', reason: 'could not parse experience bucket options' };
    }
    return { type: 'text', value: String(years) };
  }

  if (widget.type === 'checkbox') {
    const matched = widget.options.filter((o) => {
      const label = (o.label || o.value || '').toLowerCase();
      return Object.keys(answers.skill_years || {}).some((k) => answers.skill_years[k] > 0 && label.includes(k.toLowerCase()));
    });
    if (matched.length === 0) return { type: 'skip', reason: 'no configured skill matched checkbox options' };
    return { type: 'checkbox', values: matched.map((o) => o.value) };
  }

  return { type: 'skip', reason: `unrecognized question pattern: "${q}"` };
}

// ── DOM interaction (selectors verified live against production Naukri) ──

async function getLatestQuestion(page) {
  return page.evaluate(() => {
    const spans = document.querySelectorAll('.chatbot_MessageContainer .botItem .botMsg span');
    return spans.length ? spans[spans.length - 1].textContent.trim() : null;
  });
}

async function detectWidget(page) {
  return page.evaluate(() => {
    const checkboxes = Array.from(document.querySelectorAll('.chatbot_Drawer input[type=checkbox]'));
    if (checkboxes.length > 0) {
      return {
        type: 'checkbox',
        options: checkboxes.map((c) => ({
          value: c.value || c.id,
          label: (document.querySelector(`label[for="${CSS.escape(c.id)}"]`) || {}).textContent?.trim() || c.value,
        })),
      };
    }
    const radios = Array.from(document.querySelectorAll('.chatbot_Drawer input[type=radio]'));
    if (radios.length > 0) {
      return {
        type: 'options',
        options: radios.map((r) => ({
          value: r.value || r.id,
          label: (document.querySelector(`label[for="${CSS.escape(r.id)}"]`) || {}).textContent?.trim() || r.value,
        })),
      };
    }
    const textBox = document.querySelector('.chatbot_SendMessageContainer:not(.d-none) [contenteditable="true"]');
    if (textBox) return { type: 'text' };
    return { type: 'unknown' };
  });
}

async function clickOptionByValue(page, value, kind) {
  // kind: 'radio' | 'checkbox'
  await page.evaluate(({ value, kind }) => {
    const inputs = Array.from(document.querySelectorAll(`.chatbot_Drawer input[type=${kind}]`));
    const target = inputs.find((i) => (i.value || i.id) === value);
    if (target) {
      const label = document.querySelector(`label[for="${CSS.escape(target.id)}"]`);
      (label || target).click();
    }
  }, { value, kind });
}

async function submitWidget(page) {
  const send = page.locator('.sendMsg');
  if (await send.count() > 0) {
    await send.click({ timeout: 5000 }).catch(() => {});
  }
}

async function isFinished(page) {
  return page.getByRole('button', { name: 'Applied', exact: false }).count().then((n) => n > 0)
    .catch(() => false);
}

/**
 * Drives one job's chatbot to completion or abandons it at the first
 * unanswerable question. Returns { status: 'applied'|'skipped'|'no-quick-apply', detail }.
 */
async function processJobPage(page, title) {
  // Check for an already-"Applied" state FIRST — a job applied to in an
  // earlier run (or manually) renders its button as "Applied", not "Quick
  // apply", so the exact-name match below correctly finds nothing. Without
  // this check that correct "nothing found" got mislabeled as "no-quick-apply
  // / likely On company site", which is wrong and confusing for a job that
  // plainly has (had) a working Quick apply button.
  const alreadyApplied = await page.getByRole('button', { name: 'Applied', exact: false })
    .first().waitFor({ state: 'visible', timeout: 3000 }).then(() => true).catch(() => false);
  if (alreadyApplied) {
    return { status: 'already-applied', detail: 'this job\'s button already reads "Applied" (from an earlier run or manual apply)' };
  }

  const quickApplyBtn = page.getByRole('button', { name: 'Quick apply', exact: true });
  // .count() checks the DOM at this exact instant and does NOT wait — but
  // the button takes a moment to mount behind a loading skeleton on this
  // React page, so a bare count() check races the page and reports
  // "not found" almost every time even when the button appears a second
  // later. waitFor() actually polls for it to show up.
  const appeared = await quickApplyBtn.first()
    .waitFor({ state: 'visible', timeout: 10000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    return { status: 'no-quick-apply', detail: 'no native Quick apply button appeared within 10s (likely On company site)' };
  }
  if (DRY_RUN) return { status: 'dry-run', detail: 'would click Quick apply' };

  await quickApplyBtn.first().click();
  await page.waitForTimeout(1500);

  const MAX_QUESTIONS = 15; // safety cap against an infinite loop
  const answeredLog = [];
  for (let i = 0; i < MAX_QUESTIONS; i++) {
    if (await isFinished(page)) {
      return { status: 'applied', detail: answeredLog.join(' | ') };
    }
    const q = await getLatestQuestion(page);
    if (!q) {
      // No visible chat question and not marked Applied — check once more
      // after a short wait in case the UI is still transitioning.
      await page.waitForTimeout(1500);
      if (await isFinished(page)) return { status: 'applied', detail: answeredLog.join(' | ') };
      return { status: 'skipped', detail: `no question found and not marked Applied (i=${i})` };
    }

    const widget = await detectWidget(page);
    if (widget.type === 'unknown') {
      return { status: 'skipped', detail: `unrecognized widget for question: "${q}"` };
    }

    const answer = answerQuestion(q, widget);
    if (answer.type === 'skip') {
      return { status: 'skipped', detail: `Q: "${q}" — ${answer.reason}` };
    }

    if (answer.type === 'select') {
      await clickOptionByValue(page, answer.value, 'radio');
      await submitWidget(page);
    } else if (answer.type === 'checkbox') {
      for (const v of answer.values) await clickOptionByValue(page, v, 'checkbox');
      await submitWidget(page);
    } else if (answer.type === 'text') {
      const box = page.locator('.chatbot_SendMessageContainer:not(.d-none) [contenteditable="true"]');
      await box.click();
      await box.type(answer.value, { delay: 20 });
      await page.keyboard.press('Enter');
    }

    answeredLog.push(`Q:${q.slice(0, 60)} A:${JSON.stringify(answer)}`.slice(0, 150));
    await page.waitForTimeout(1200 + Math.random() * 800);
  }

  return { status: 'skipped', detail: 'exceeded MAX_QUESTIONS safety cap' };
}

// ── Card collection (both the recommended feed and search results use the
//    same click-driven card component — no real <a href>, so cards must be
//    clicked and the resulting popup captured) ──────────────────────────

// ── Pre-open card filters ────────────────────────────────────────────
// Each card's innerText contains BOTH the company column (name, rating,
// industry tags, employee count) and the role column (title, location,
// salary, skills, experience) — one blob, checked before the card is ever
// clicked. Cheap, and keeps the run from wasting an attempt on something
// out of scope.

const filters = answers?.filters || {};

// Parses "₹25L - ₹40L/year", "50-75 Lakhs", "1-5 Cr", "₹90L/year", etc.
// into a [minLPA, maxLPA] range. Returns null for "Not Disclosed" or
// anything unparseable — treated as "unknown", never as a reason to skip.
function parseCompRangeLPA(text) {
  const s = text.replace(/,/g, '');
  let m;
  if ((m = s.match(/₹?\s*(\d+(?:\.\d+)?)\s*L\s*-\s*₹?\s*(\d+(?:\.\d+)?)\s*L/i))) {
    return [Number(m[1]), Number(m[2])];
  }
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*(?:Lakhs?|LPA)/i))) {
    return [Number(m[1]), Number(m[2])];
  }
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*Cr/i))) {
    return [Number(m[1]) * 100, Number(m[2]) * 100];
  }
  if ((m = s.match(/₹?\s*(\d+(?:\.\d+)?)\s*L\b/i))) {
    return [Number(m[1]), Number(m[1])];
  }
  return null;
}

function compensationTooLow(cardText) {
  if (filters.min_compensation_lpa == null) return false;
  const range = parseCompRangeLPA(cardText);
  if (!range) return false; // undisclosed — never a reason to skip
  const [, max] = range;
  return max < filters.min_compensation_lpa;
}

// IMPORTANT: pass only the company/industry-tag text that appears BEFORE the
// job title (e.g. "Walmart / 3.4 / Retail / Analytics / KPO / Research /
// 100001+ employees"), never the skills list or job description. A job's
// required-skills line can legitimately contain a deny-list word ("Consulting"
// as a skill, not an industry) — checking the whole block false-flagged a
// real Walmart Staff Software Engineer posting as a consulting shop.
function isExcludedIndustry(cardText) {
  const list = filters.exclude_industries || [];
  return list.some((term) => cardText.toLowerCase().includes(term.toLowerCase()));
}

function locationNotAllowed(cardText) {
  const text = cardText.toLowerCase();
  if (/\bremote\b/.test(text)) return false; // remote always allowed, any location
  const allowed = (filters.allowed_indian_cities || []).map((c) => c.toLowerCase());
  if (allowed.some((c) => text.includes(c))) return false;
  const excluded = (filters.other_indian_cities_excluded || []).map((c) => c.toLowerCase());
  if (excluded.some((c) => text.includes(c))) return true;
  return false; // unrecognized location -> treated as international, allowed
}

// The card's first non-empty line is the COMPANY name, not the job title —
// the role title is the first non-empty line after the "Quick apply" /
// "X ago" badge line. Falls back to the first line if that pattern isn't
// found (e.g. an "On company site" card with no Quick apply badge).
function extractCardTitle(cardText) {
  const lines = cardText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const badgeIdx = lines.findIndex((l) => /quick apply|on company site/i.test(l));
  if (badgeIdx !== -1 && lines[badgeIdx + 1]) return lines[badgeIdx + 1];
  return lines.find((l) => l.length > 3) || '';
}

// Detail pages (used by --urls, and the full-page text a job opens into) are
// laid out DIFFERENTLY from cards — title comes near the top, "Quick apply"
// appears twice further down (once as a card-style badge, once as the real
// button), so extractCardTitle's "line after Quick apply" heuristic grabs
// the WRONG thing (a page section heading like "Expertise", or nav text like
// "Home"). Every detail page seen this session instead has a reliable
// Title / Location / Salary-or-"Not Disclosed" / skills / "N-M Yrs" block —
// anchor on the experience line and count backwards.
function extractDetailPageTitle(bodyText) {
  const lines = bodyText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const expIdx = lines.findIndex((l) => /^\d+[\-+]\d*\s*yrs?$/i.test(l));
  if (expIdx >= 4 && lines[expIdx - 4]) return lines[expIdx - 4];
  // Fall back to the card-shaped heuristic in case a detail page ever
  // renders more like a card than expected.
  return extractCardTitle(bodyText);
}

// Classifies and (if it passes) processes ONE specific job URL directly —
// used by --urls to spot-check the pipeline against hand-picked jobs, and
// reusable for re-checking anything from data/naukri-skipped-for-review.tsv
// after a manual look. Reuses the exact same filter functions as the card
// path: Naukri's job detail pages follow the same
// company/industry/role/location/salary/skills/experience text layout as
// the cards do, just as a full page instead of a card.
async function processDirectUrl(page, url, seenUrls) {
  await page.goto(url);
  await page.waitForTimeout(2000);
  const cardText = await page.locator('body').innerText().catch(() => '');
  if (!cardText) {
    console.log(`[error] ${url} — couldn't read page text`);
    return { attempted: 0, applied: 0 };
  }

  // Scope filter checks to a window anchored on the TITLE line itself, not a
  // fixed line-count lookback from "N-M Yrs". Every Naukri detail page's
  // fixed header carries a persistent nav link reading "Get recruiter's
  // attention" (a Naukri upsell, unrelated to this job) — a fixed-size
  // lookback overshot into that navbar text on companies whose own
  // company-info block is short (e.g. no rating/industry-tags/employee-count
  // line), false-triggering TITLE_DENY's "recruiter" term. The title always
  // sits exactly 4 lines before the experience line (Title/Location/Salary/
  // Skills/"N-M Yrs" — the same offset extractDetailPageTitle uses), so
  // anchoring there is robust regardless of how long the company-info
  // preamble is.
  const allLines = cardText.split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  const expIdx = allLines.findIndex((l) => /^\d+[\-+]\d*\s*yrs?$/i.test(l));
  const titleIdx = expIdx >= 4 ? expIdx - 4 : -1;
  // Company/industry-tag text only (BEFORE the title) — feeds isExcludedIndustry
  // exclusively, so a deny-list word appearing in the skills line or job
  // description never counts as an industry match.
  const industryWindowStart = titleIdx !== -1 ? Math.max(0, titleIdx - 6) : 0;
  const industryBlock = titleIdx !== -1 ? allLines.slice(industryWindowStart, titleIdx).join('\n') : '';
  // Title through experience line — title/location/salary/skills/exp, used
  // for TITLE_ALLOW/DENY, compensation, and location checks.
  const windowStart = titleIdx !== -1 ? titleIdx : (expIdx !== -1 ? Math.max(0, expIdx - 14) : 0);
  const windowLines = expIdx !== -1 ? allLines.slice(windowStart, expIdx + 1) : allLines;
  const infoBlock = windowLines.join('\n');

  const titleLine = extractDetailPageTitle(cardText);
  const postedByMatch = infoBlock.match(/posted by (.+)/i);
  const company = postedByMatch ? postedByMatch[1].trim() : (allLines[industryWindowStart] || windowLines[0] || '');
  const key = url.split('?')[0];

  if (seenUrls.has(key) || alreadyProcessed(url)) {
    console.log(`[skip-dup] ${titleLine.slice(0, 60)} — already processed in an earlier run`);
    return { attempted: 0, applied: 0 };
  }
  seenUrls.add(key);

  if (TITLE_DENY.test(infoBlock) || !TITLE_ALLOW.test(infoBlock)) {
    console.log(`[out-of-scope] ${titleLine.slice(0, 60)} — title doesn't match the software/senior-software/frontend/backend scope`);
    return { attempted: 0, applied: 0 };
  }

  let skipStatus = null, skipReason = null, skipCompRange = null;
  if (isExcludedIndustry(industryBlock)) {
    const range = parseCompRangeLPA(infoBlock);
    const clearsFloor = range && filters.min_compensation_lpa != null && range[1] >= filters.min_compensation_lpa;
    if (!clearsFloor) {
      skipStatus = 'filtered-industry';
      skipCompRange = range;
      skipReason = range
        ? `services/staffing/consulting company, disclosed range ${range.join('-')}L doesn't clear the ${filters.min_compensation_lpa}L floor`
        : 'services/staffing/consulting company, pay not disclosed (no proof to override the exclusion)';
    } else {
      console.log(`[industry-override] ${titleLine.slice(0, 60)} — services/staffing/consulting company, but disclosed ${range.join('-')}L clears the floor`);
    }
  }
  if (!skipStatus && compensationTooLow(infoBlock)) {
    const range = parseCompRangeLPA(infoBlock);
    skipStatus = 'filtered-compensation';
    skipCompRange = range;
    skipReason = `disclosed range ${range?.join('-')}L is below the ${filters.min_compensation_lpa}L floor`;
  }
  if (!skipStatus && locationNotAllowed(infoBlock)) {
    skipStatus = 'filtered-location';
    skipReason = 'not Bangalore/Chennai/Remote/international';
  }

  if (skipStatus) {
    logRow(url, titleLine, skipStatus, skipReason);
    logSkipForReview(company, titleLine, url, skipReason, skipCompRange);
    console.log(`[${skipStatus}] ${titleLine.slice(0, 60)} — ${skipReason}`);
    return { attempted: 0, applied: 0 };
  }

  const result = await processJobPage(page, titleLine).catch((e) => ({ status: 'error', detail: e.message }));
  logRow(url, titleLine, result.status, result.detail);
  if (['skipped', 'no-quick-apply', 'error'].includes(result.status)) {
    logSkipForReview(company, titleLine, url, result.detail, parseCompRangeLPA(infoBlock));
  }
  console.log(`[${result.status}] ${titleLine.slice(0, 60)} — ${(result.detail || '').slice(0, 100)}`);
  return { attempted: 1, applied: result.status === 'applied' ? 1 : 0 };
}

async function collectAndProcessCards(page, context, seenUrls, remainingBudget) {
  const cards = page.locator('div.cursor-pointer.rounded-3xl');
  const count = await cards.count();
  let attempted = 0; // jobs actually opened this pass — what --limit caps
  let applied = 0;   // successful real applies this pass (dry-run: always 0)

  // remainingBudget is the GLOBAL cap minus whatever earlier pages/scroll
  // passes already used — without this, each call got its own fresh LIMIT
  // internally, so e.g. --limit 3 across several search pages could overshoot
  // to 5+ total attempts (page 1 uses 3, page 2 starts a fresh 3 before the
  // running total is rechecked).
  for (let i = 0; i < count && attempted < remainingBudget; i++) {
    const card = cards.nth(i);
    const cardText = await card.innerText().catch(() => '');
    if (!cardText) continue;

    const titleLine = extractCardTitle(cardText);

    // Dedup by card identity BEFORE filtering/opening anything. Without
    // this, every scroll pass re-scans the same early cards (the infinite
    // feed doesn't remove already-seen ones from the DOM), so a rejected
    // card gets re-logged every pass and the run never makes it deep enough
    // to reach fresh, possibly-passing cards within its scroll budget —
    // this is what caused a run to end at "0 attempted" despite passing
    // jobs existing further down the feed.
    const cardKey = `${titleLine}::${cardText.split('\n')[0] || ''}`;
    if (seenUrls.has(cardKey)) continue;
    seenUrls.add(cardKey);

    if (TITLE_DENY.test(cardText) || !TITLE_ALLOW.test(cardText)) continue;
    if (!/quick apply/i.test(cardText)) continue; // skip "On company site" up front

    const company = cardText.split('\n')[0] || '';

    // Pre-filter checks run on the card text BEFORE opening the popup, so a
    // job we're about to reject anyway doesn't cost a click+popup — EXCEPT
    // when it fails, in which case we open it just long enough to grab its
    // real URL for the skipped-for-review log (cards have no <a href>, this
    // is the only way to get a URL), then close it without running the
    // chatbot flow.
    let skipReason = null, skipStatus = null, skipCompRange = null;

    // Company/industry-tag text only (everything BEFORE the "Quick apply"/
    // "posted X ago" badge line) — feeds isExcludedIndustry exclusively, so
    // a deny-list word appearing later in the skills line (e.g. a card
    // listing "Consulting" as a required SKILL, not an industry) never
    // counts as an industry match. Same root cause as the --urls path's
    // Walmart false positive, fixed the same way.
    const cardBadgeIdx = cardText.split('\n').map((l) => l.trim()).findIndex((l) => /quick apply|on company site/i.test(l));
    const industryCardBlock = cardBadgeIdx !== -1
      ? cardText.split('\n').slice(0, cardBadgeIdx).join('\n')
      : cardText;

    if (isExcludedIndustry(industryCardBlock)) {
      // Service/staffing/consulting companies are excluded UNLESS they
      // disclose pay clearing the floor — undisclosed pay does NOT earn
      // the override (otherwise every generic "Not Disclosed" staffing
      // repost would sail through on the exclusion's own loophole).
      const range = parseCompRangeLPA(cardText);
      const clearsFloor = range && filters.min_compensation_lpa != null && range[1] >= filters.min_compensation_lpa;
      if (!clearsFloor) {
        skipStatus = 'filtered-industry';
        skipCompRange = range;
        skipReason = range
          ? `services/staffing/consulting company, disclosed range ${range.join('-')}L doesn't clear the ${filters.min_compensation_lpa}L floor`
          : 'services/staffing/consulting company, pay not disclosed (no proof to override the exclusion)';
      } else {
        console.log(`[industry-override] ${titleLine.slice(0, 60)} — services/staffing/consulting company, but disclosed ${range.join('-')}L clears the floor`);
      }
    }
    if (!skipStatus && compensationTooLow(cardText)) {
      const range = parseCompRangeLPA(cardText);
      skipStatus = 'filtered-compensation';
      skipCompRange = range;
      skipReason = `disclosed range ${range?.join('-')}L is below the ${filters.min_compensation_lpa}L floor`;
    }
    if (!skipStatus && locationNotAllowed(cardText)) {
      skipStatus = 'filtered-location';
      skipReason = 'not Bangalore/Chennai/Remote/international';
    }

    let popup;
    try {
      [popup] = await Promise.all([
        context.waitForEvent('page', { timeout: 8000 }),
        card.click(),
      ]);
    } catch {
      if (skipStatus) {
        logRow('(popup failed to open)', titleLine, skipStatus, skipReason);
        console.log(`[${skipStatus}] ${titleLine.slice(0, 60)} — ${skipReason}`);
      }
      continue; // card didn't open a new tab — skip it
    }
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await popup.waitForTimeout(1500);

    const url = popup.url();

    if (skipStatus) {
      logRow(url, titleLine, skipStatus, skipReason);
      logSkipForReview(company, titleLine, url, skipReason, skipCompRange);
      console.log(`[${skipStatus}] ${titleLine.slice(0, 60)} — ${skipReason}`);
      await popup.close();
      continue;
    }

    if (seenUrls.has(url.split('?')[0]) || alreadyProcessed(url)) {
      await popup.close();
      continue;
    }
    seenUrls.add(url.split('?')[0]);

    const result = await processJobPage(popup, titleLine).catch((e) => ({ status: 'error', detail: e.message }));
    logRow(url, titleLine, result.status, result.detail);
    if (result.status === 'skipped' || result.status === 'no-quick-apply' || result.status === 'error') {
      logSkipForReview(company, titleLine, url, result.detail, parseCompRangeLPA(cardText));
    }
    console.log(`[${result.status}] ${titleLine.slice(0, 60)} — ${(result.detail || '').slice(0, 100)}`);
    attempted++;
    if (result.status === 'applied') applied++;

    await popup.close();
    await page.waitForTimeout(1000 + Math.random() * 1500); // be gentle
  }
  return { attempted, applied };
}

// ── Main ─────────────────────────────────────────────────────────────

// ── Stale-lock recovery (the actual root cause of the earlier lockout:
//    a killed run leaves SingletonLock pointing at a dead PID, and Chrome
//    politely defers to that dead process forever instead of noticing) ──

function clearStaleLockIfDead(userDataDir) {
  const lockPath = join(userDataDir, 'SingletonLock');
  if (!existsSync(lockPath)) return;
  let target;
  try {
    target = readlinkSync(lockPath);
  } catch {
    return; // not a symlink / unreadable — leave it alone
  }
  const m = target.match(/-(\d+)$/);
  if (!m) return;
  const pid = Number(m[1]);
  let alive = true;
  try {
    process.kill(pid, 0); // signal 0: existence check only, doesn't actually kill
  } catch (e) {
    alive = e.code !== 'ESRCH';
  }
  if (alive) return; // a real Chrome instance owns this lock — don't touch it
  console.log(`Clearing a stale Chrome lock left by a previous run (PID ${pid} is no longer running)...`);
  for (const f of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { unlinkSync(join(userDataDir, f)); } catch {}
  }
}

// Tracked at module scope so the signal handlers below can always reach
// whatever browser/context is currently open and close it, even if main()
// is interrupted mid-run (Ctrl+C, kill, an uncaught error). This is what
// guarantees the profile lock is released instead of getting stuck again.
let activeBrowser = null;
let activeContext = null;
let shuttingDown = false;

async function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (activeContext) await activeContext.close(); } catch {}
  try { if (activeBrowser) await activeBrowser.close(); } catch {}
  process.exit(exitCode);
}

process.on('SIGINT', () => { console.log('\nInterrupted — closing the browser cleanly...'); shutdown(130); });
process.on('SIGTERM', () => shutdown(143));

async function main() {
  let context, browser = null;

  if (ISOLATED_SESSION) {
    browser = await chromium.launch({
      headless: !HEADED,
      channel: 'chrome',
      args: ['--disable-blink-features=AutomationControlled'],
    });
    activeBrowser = browser;
    context = await browser.newContext({ storageState: ISOLATED_SESSION_STATE });
  } else {
    const userDataDir = defaultChromeUserDataDir();
    if (!existsSync(userDataDir)) {
      console.error(`Chrome profile directory not found: ${userDataDir}`);
      console.error(`Pass --isolated-session to use the separate naukri-login.mjs profile instead.`);
      process.exit(1);
    }
    clearStaleLockIfDead(userDataDir);
    try {
      context = await chromium.launchPersistentContext(userDataDir, {
        channel: 'chrome',
        headless: !HEADED,
        args: [`--profile-directory=${CHROME_PROFILE}`],
      });
    } catch (e) {
      console.error(`Couldn't launch Chrome with profile "${CHROME_PROFILE}".`);
      console.error(`Most likely cause: Chrome is still running — fully quit Chrome (Cmd+Q / Chrome menu > Quit) and try again.`);
      console.error(`Original error: ${e.message}`);
      process.exit(1);
    }
  }
  activeContext = context;

  // seenUrls lives here, OUTSIDE any single sweep, so it accumulates for the
  // whole life of the process — in --loop mode this means later sweeps don't
  // re-log cards an earlier sweep already looked at.
  const seenUrls = new Set();

  async function runOneSweep(page) {
    let totalAttempted = 0;
    let totalApplied = 0;

    if (URLS.length > 0) {
      for (const url of URLS) {
        if (totalAttempted >= LIMIT) break;
        const r = await processDirectUrl(page, url, seenUrls);
        totalAttempted += r.attempted;
        totalApplied += r.applied;
        await page.waitForTimeout(1000 + Math.random() * 1500);
      }
      return { totalAttempted, totalApplied };
    }

    if (USE_RECOMMENDED) {
      await page.goto('https://www.naukri.com/mnjuser/recommendedjobs');
      await page.waitForTimeout(2000);
      let stagnantPasses = 0;
      for (let s = 0; s < SCROLLS && totalAttempted < LIMIT; s++) {
        const cardsBefore = await page.locator('div.cursor-pointer.rounded-3xl').count();
        const r = await collectAndProcessCards(page, context, seenUrls, LIMIT - totalAttempted);
        totalAttempted += r.attempted;
        totalApplied += r.applied;

        // The job list lives inside a nested scrollable container
        // (#scrollableDiv), not the window — a plain mouse-wheel event
        // often misses it and scrolls nothing, silently reloading the same
        // ~20 cards every pass no matter how many scroll passes are
        // configured. Scroll that container directly, with mouse-wheel as
        // a fallback for when the id changes.
        await page.evaluate(() => {
          const el = document.getElementById('scrollableDiv');
          if (el) el.scrollBy(0, 4000);
        }).catch(() => {});
        await page.mouse.wheel(0, 4000);
        await page.waitForTimeout(1800);

        const cardsAfter = await page.locator('div.cursor-pointer.rounded-3xl').count();
        if (cardsAfter <= cardsBefore) {
          stagnantPasses++;
          if (stagnantPasses >= 3) {
            console.log(`No new cards loaded after ${stagnantPasses} scroll passes — feed exhausted, stopping early.`);
            break;
          }
        } else {
          stagnantPasses = 0;
        }
      }
    }

    // Sweep every (location × keyword) combination, paging through each,
    // sharing one global LIMIT budget across all of them — stops the moment
    // the budget is used up, however many combinations that takes.
    outer:
    for (const location of SEARCH_LOCATIONS) {
      for (const keyword of SEARCH_KEYWORDS) {
        if (totalAttempted >= LIMIT) break outer;
        const kw = encodeURIComponent(keyword);
        const loc = encodeURIComponent(location);
        const slug = keyword.toLowerCase().replace(/\s+/g, '-');
        // Naukri treats "remote" as a location slug the same way it treats
        // a city (e.g. naukri.com/software-engineer-jobs-in-remote) — this
        // is the standard pattern, but hasn't been directly DOM-verified
        // the way the city URLs were; worth a glance in --headed the first
        // time it runs for you.
        for (let p = 1; p <= SEARCH_PAGES && totalAttempted < LIMIT; p++) {
          const pageParam = p > 1 ? `&pageNo=${p}` : '';
          const url = `https://www.naukri.com/${slug}-jobs-in-${location.toLowerCase()}?k=${kw}&l=${loc}&experience=${SEARCH_EXPERIENCE}${pageParam}`;
          await page.goto(url);
          await page.waitForTimeout(2000);
          const r = await collectAndProcessCards(page, context, seenUrls, LIMIT - totalAttempted);
          totalAttempted += r.attempted;
          totalApplied += r.applied;
        }
      }
    }

    return { totalAttempted, totalApplied };
  }

  try {
    const page = context.pages().find((p) => p.url() !== 'about:blank') || context.pages()[0] || await context.newPage();

    do {
      const { totalAttempted, totalApplied } = await runOneSweep(page);
      console.log(`\n[${new Date().toISOString()}] Sweep done. ${totalAttempted} job(s) attempted, ${totalApplied} application(s) actually submitted this sweep (see ${LOG_PATH} for full detail).`);
      if (LOOP) {
        console.log(`Sleeping ${LOOP_MINUTES} minute(s) before the next sweep — Ctrl+C to stop.`);
        await new Promise((resolve) => setTimeout(resolve, LOOP_MINUTES * 60 * 1000));
      }
    } while (LOOP);
  } finally {
    // Always releases the profile lock, success or failure — this is the
    // guarantee that was missing before.
    try { await context.close(); } catch {}
    try { if (browser) await browser.close(); } catch {}
    activeContext = null;
    activeBrowser = null;
  }
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
