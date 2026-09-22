#!/usr/bin/env node
/**
 * basic-validate-pipeline.mjs — zero-LLM PASS/FAIL gate for `data/pipeline.md` (#4102)
 *
 * Replaces the full A-F/G narrative evaluation (`oferta`/`auto-pipeline`) as the
 * first filter over the pipeline backlog, per the candidate's house rule in
 * `modes/_custom.md` ("never run the full evaluation, apply to anything that
 * clears basic validation"). No model call anywhere in this file — every gate
 * is a regex or an arithmetic comparison against structured data already in
 * the repo (`portals.yml`'s title_filter, `config/profile.yml`'s location/comp
 * fields, and the Hard DQ / Location Scoring tables transcribed from
 * `modes/_brief.md` as of 2026-09-11 — re-copy the constants below if you edit
 * those tables).
 *
 * Four gates, ANDed together:
 *   1. Archetype/title relevance  — portals.yml positive keywords, minus a
 *      DQ-skill negative list (portals.yml negatives + _brief.md's Hard DQ
 *      skill-exclusion list + extra domain terms this repo's own 2026-09-11
 *      scan surfaced as false positives: multiphysics, chip design,
 *      manufacturing test, flight/spacecraft hardware, robotics hardware).
 *   2. Location                  — config/profile.yml's onsite_cities /
 *      authorized_in / needs_sponsorship, mirroring _brief.md's Location
 *      Scoring table, collapsed to PASS/FAIL (no numeric score).
 *   3. Years-of-experience        — only checked when the JD body is fetchable
 *      (fetch-jd.mjs's known-ATS API path); unknown when it isn't, per the
 *      "don't penalize missing data" convention every other filter here uses.
 *   4. Comp floor (India roles)   — config/profile.yml's compensation.minimum;
 *      only checked when a figure is present (the pipeline row's own comp
 *      cell, or, failing that, the JD body).
 *
 * A gate that cannot be evaluated (no JD body available, no comp figure
 * stated) never fails the entry on its own — silence is absence of signal,
 * not a blocker, same rule the rest of this repo's filters use. Title and
 * location ARE always evaluable (they're in the pipeline row itself), so
 * those two are the only gates that can fail an entry outright.
 *
 * Writes an additive `| gate: PASS — {reason}` or `| gate: FAIL — {reason}`
 * segment to each pending row, exactly like rank-pipeline.mjs's `rank:`
 * segment: idempotent, never reorders or deletes a row, never overwrites an
 * existing `gate:` segment on re-run.
 *
 * Usage:
 *   node basic-validate-pipeline.mjs                  # validate up to --limit pending entries
 *   node basic-validate-pipeline.mjs --limit 200
 *   node basic-validate-pipeline.mjs --dry-run
 *   node basic-validate-pipeline.mjs --no-fetch        # skip JD fetch; title+location only
 *   node basic-validate-pipeline.mjs --web             # also read non-ATS JDs via the free-tier webintel plugin
 *   node basic-validate-pipeline.mjs --self-test
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import * as yaml from 'js-yaml';
import { flagValue, hasFlag, safeIntFlag } from './lib/cli-flags.mjs';
import { sanitizeMarkdownField } from './scan.mjs';
import { withPipelineLock } from './pipeline-lock.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';

const DATA_ROOT = getCareerOpsRoot();
const PIPELINE_PATH = join(DATA_ROOT, 'data', 'pipeline.md');
const PORTALS_PATH = join(DATA_ROOT, 'portals.yml');
const PROFILE_PATH = join(DATA_ROOT, 'config', 'profile.yml');

const GATE_LABEL = '| gate: ';
const DEFAULT_LIMIT = 100;
const LIMIT_CEILING = 1000; // a full backlog sweep at most, never unbounded
const FETCH_TIMEOUT_MS = 15_000;
const JD_TEXT_CAP = 8_000; // only need enough to see requirement/comp lines, not the whole JD
const DEFAULT_WEB_LIMIT = 25;

// ── Hard DQ skill-exclusion terms (modes/_brief.md, transcribed 2026-09-11) ──
// Matched against title first (cheap, no fetch), then against the JD body
// when one is available, for terms too generic to trust on title alone.
const HARD_DQ_TITLE_TERMS = [
  // _brief.md's own list
  'sap', 'abap', 'embedded', 'firmware', 'chiller', 'optics', 'sonic networking',
  'mainframe', 'cobol', 'native ios', 'native android', 'salesforce admin',
  'sharepoint', 'm365', '.net', 'oidc', 'saml', 'pki', 'snowflake', 'databricks',
  'power bi', 'tableau', 'matillion',
  // "Primary language requirement is Java, C++, C#/.NET, or Go with no
  // frontend/web layer" — ATS titles commonly append the primary language
  // after a comma (e.g. "Senior Software Engineer, C++"), which is exactly
  // the signal this catches at the title level, before any JD fetch.
  'c++', 'c#', 'golang',
  // Extra domain terms this repo's own 2026-09-11 scan surfaced as false
  // positives under the current broad "Software Engineer"/"Platform Engineer"
  // positive keywords — hardware/physical-engineering roles that happen to
  // carry a software-sounding title.
  'multiphysics', 'chip design', 'manufacturing test', 'flight software',
  'spacecraft', 'space flight', 'space mission', 'robotics', 'reacting flow',
  'high speed reacting', 'rf engineer', 'hardware engineer', 'asic', 'fpga',
  'mechanical engineer', 'electrical engineer', 'network datapath',
];

// A subset re-checked against the JD body (title alone is too ambiguous —
// e.g. "pure DevOps/SRE" and "pure data-eng/BI" need to see whether an
// application-dev layer is mentioned, which a title never states either way).
const HARD_DQ_BODY_ONLY_TERMS = [
  'pure devops', 'infrastructure-only', 'sre role', 'manual qa',
  'quality assurance engineer', 'business intelligence',
];

const YEARS_EXPERIENCE_RE = /\b(\d{1,2})\+?\s*(?:years?|yrs?)\b[^.\n]{0,40}?(?:experience|exp\.?)/gi;
const OR_EQUIVALENT_RE = /or\s+equivalent/i;
// "Experience: 11+ yrs" / "experience of 5 years" (number AFTER the word) and "1-3 years" ranges.
const EXPERIENCE_FIRST_RE = /\bexperience[:\s]+(?:of\s+)?(\d{1,2})\s*\+?\s*(?:years?|yrs?)\b/gi;
const YEAR_RANGE_RE = /\b(\d{1,2})\s*(?:-|–|—|to)\s*(\d{1,2})\s*(?:years?|yrs?)\b/gi;
// Upper bound at or below this many years = a junior role for this candidate (about 4 yrs).
const JUNIOR_RANGE_MAX = 3;
const NO_SPONSORSHIP_RE = /\b(no\s+(?:visa\s+)?sponsorship|unable\s+to\s+sponsor|not\s+(?:able|eligible)\s+(?:to|for)\s+(?:sponsor|sponsorship)|must\s+have\s+(?:existing|current)\s+work\s+authorization|does\s+not\s+(?:offer|provide)\s+(?:visa\s+)?sponsorship|relocation\s+(?:support|assistance|package)\s+(?:is\s+|are\s+)?not\s+(?:provided|available|offered)|relocate\s+independently|(?:unable|not\s+able)\s+to\s+offer\b[^.]{0,80}(?:visa\s+sponsorship|relocation)|(?:must|need\s+to)\s+(?:currently\s+)?(?:reside|live|be\s+based)\s+in)\b/i;

// Positive sponsorship / relocation language (checked only when no negative match).
const OFFERS_SPONSORSHIP_RE = /\b(visa\s+sponsorship\s+(?:is\s+)?(?:available|provided|offered|supported)|we\s+(?:can\s+|will\s+|do\s+)?sponsor(?:\s+(?:work\s+)?visas?)?|sponsor(?:ship)?\s+(?:for\s+)?(?:work\s+)?visas?|relocation\s+(?:assistance|support|package|bonus|allowance|benefits?)|(?:assist|help)(?:ing)?\s+with\s+(?:your\s+)?(?:visa|relocation)|relocat(?:e|ing)\s+you)\b/i;

// A "Remote" role whose JD confines it to one country/region is not open to a
// candidate in India. Only fires when the JD names no India/worldwide/APAC scope.
const REMOTE_RESTRICTED_RE = /\b((?:within|in|from|across)\s+the\s+(?:united\s+states|u\.?s\.?a?\.?)\b|(?:us|u\.s\.|usa)[-\s]?based|must\s+(?:be\s+)?(?:located|based|reside|residing|live)\s+in|(?:latin\s+america|latam)\b|(?:emea|europe|eu|uk|canada|australia|brazil|mexico)\s+only|only\s+(?:open\s+)?to\s+(?:candidates\s+)?(?:in|from|located)|authori[sz]ed\s+to\s+work\s+in\s+the\s+(?:us|u\.s\.|united\s+states|uk|eu)\b|eligible\s+to\s+work\s+in\s+the\s+(?:us|u\.s\.|united\s+states|uk|eu)\b)/i;
const REMOTE_CANDIDATES_IN_RE = /\bremote\s+for\s+candidates\s+(?:based|located|residing)\s+in\b|\bopen\s+to\s+candidates\s+(?:based|located|residing)\s+in\s+(?:the\s+)?(?:following|these)\b/i;
const REMOTE_TZ_WITHIN_RE = /\btime\s*zones?\s*\(?\s*within\s*[+\u00b1-]/i;
const REMOTE_TZ_RE = /\b(?:within|between|in)\s+(?:the\s+)?(?:cet|cest|est|edt|pst|pdt|cst|et|pt|gmt\s?[+-]\s?\d|utc\s?[+-]\s?\d)\b|\b(?:cet|cest|est|edt|pst|pdt)\b[^.\n]{0,30}time\s*zones?/i;
const REMOTE_ELIGIBLE_RE = /\b(?:eligible|authori[sz]ed|legally\s+(?:entitled|permitted)|right)\s+to\s+work[^.\n]{0,30}\bin\s+(?:the\s+)?(?:us|u\.s\.|usa|united\s+states|uk|united\s+kingdom|eu|european\s+union|germany|france|spain|netherlands|canada|australia|ireland|poland|portugal|italy|switzerland|sweden|denmark|norway|finland|israel|singapore|japan)\b/i;
const REMOTE_OPEN_RE = /\b(india|worldwide|anywhere\s+in\s+the\s+world|work\s+from\s+anywhere|apac|asia[-\s]pacific)\b/i;

/** @param {string} jdText @returns {'restricted'|null} */
export function remoteScopeFromJd(jdText) {
  const text = String(jdText ?? '');
  if (!text) return null;
  const restricted = REMOTE_RESTRICTED_RE.test(text) || REMOTE_TZ_RE.test(text) || REMOTE_ELIGIBLE_RE.test(text) || REMOTE_CANDIDATES_IN_RE.test(text) || REMOTE_TZ_WITHIN_RE.test(text);
  return restricted && !REMOTE_OPEN_RE.test(text) ? 'restricted' : null;
}

/** @param {string} jdText @returns {'no_sponsorship'|'offered'|'silent'|null} */
export function sponsorshipSignalFromJd(jdText) {
  if (!jdText) return null;
  if (NO_SPONSORSHIP_RE.test(jdText)) return 'no_sponsorship';
  return OFFERS_SPONSORSHIP_RE.test(jdText) ? 'offered' : 'silent';
}

// Comp parsing: INR figures in LPA, or a bare annual range with an INR/₹ marker.
const INR_LPA_RE = /(?:₹|inr|rs\.?)\s*([\d,.]+)\s*(?:lpa|lakhs?|lakh)/gi;

const USAGE = `
  basic-validate-pipeline.mjs — zero-LLM PASS/FAIL gate (no model calls)

  node basic-validate-pipeline.mjs [--limit N] [--dry-run] [--no-fetch] [--web [--web-limit N]] [--company <name>]

    --limit N       max entries to validate this run (default ${DEFAULT_LIMIT}, ceiling ${LIMIT_CEILING})
    --dry-run       print verdicts, write nothing
    --no-fetch      skip the JD-body fetch step; title+location gates only
    --web           for rows with no ATS-API JD, read the page via plugins.local/webintel
                    (cache → Exa contents → Firecrawl; free-tier budget-capped, opt-in)
    --web-limit N   max pages sent to a paid provider this run (default ${DEFAULT_WEB_LIMIT})
    --company <n>   only validate rows for this company (case-insensitive substring)
    --self-test     run the in-memory suite (no subprocess, no network)
`;

// ── Config loading ──────────────────────────────────────────────────────────

function loadPortalsConfig() {
  if (!existsSync(PORTALS_PATH)) return { positive: [], negative: [] };
  const doc = yaml.load(readFileSync(PORTALS_PATH, 'utf-8')) ?? {};
  const tf = doc.title_filter ?? {};
  return {
    positive: Array.isArray(tf.positive) ? tf.positive : [],
    negative: Array.isArray(tf.negative) ? tf.negative : [],
  };
}

function loadProfile() {
  if (!existsSync(PROFILE_PATH)) return null;
  return yaml.load(readFileSync(PROFILE_PATH, 'utf-8')) ?? null;
}

// ── Gate 1: archetype/title relevance ───────────────────────────────────────

function normalizeForMatch(text) {
  return String(text ?? '').toLowerCase();
}

/** True when `text` contains `term` as a case-insensitive substring. */
function containsTerm(text, term) {
  return normalizeForMatch(text).includes(normalizeForMatch(term));
}

/**
 * @returns {{ pass: boolean, reason: string }}
 */
export function titleGate(title, positiveKeywords, negativeKeywords) {
  const hitPositive = positiveKeywords.find(kw => containsTerm(title, kw));
  if (!hitPositive) {
    return { pass: false, reason: `title matches no target archetype keyword` };
  }
  const hitNegative = negativeKeywords.find(kw => containsTerm(title, kw));
  if (hitNegative) {
    return { pass: false, reason: `title contains excluded term "${hitNegative}"` };
  }
  const hitHardDq = HARD_DQ_TITLE_TERMS.find(kw => containsTerm(title, kw));
  if (hitHardDq) {
    return { pass: false, reason: `title matches hard-DQ domain term "${hitHardDq}"` };
  }
  return { pass: true, reason: `title matches archetype keyword "${hitPositive}"` };
}

// ── Gate 2: location ─────────────────────────────────────────────────────────

const REMOTE_RE = /\bremote\b/i;
const WORLDWIDE_RE = /\b(worldwide|global|anywhere|remote[- ]first)\b/i;
// Broad enough to catch the common "candidate's own region" spellings without
// a full country list — this only needs to catch the false-fail case (a
// worldwide-or-Asia-inclusive remote role wrongly flagged as scoped), not
// exhaustively enumerate every region name.
const CANDIDATE_REGION_RE = /\b(india|apac|asia[- ]pacific|\bAsia\b)\b/i;

/**
 * A "Remote" location field is frequently scoped to a specific country/region
 * (tax entity, EOR, timezone overlap) rather than open worldwide — e.g.
 * "Remote, Portugal" or a Latam country enumeration. Scan.mjs's location cell
 * lists every place the posting names, comma/·-separated; if it names 2+
 * specific places alongside "remote" and none of them is a worldwide
 * qualifier or the candidate's own region, the scope is unconfirmed rather
 * than provably worldwide, and this must NOT auto-pass (see AGENTS.md's
 * asymmetry: a false PASS costs a wasted/ineligible application, a false
 * FAIL only costs a manual re-check).
 */
function isRemoteScopeConfirmedOpen(text) {
  if (WORLDWIDE_RE.test(text) || CANDIDATE_REGION_RE.test(text)) return true;
  const places = String(text ?? '').split(/[·,]/).map(s => s.trim()).filter(Boolean);
  const nonRemotePlaces = places.filter(p => !/^remote$/i.test(p));
  // Bare "Remote" with NO other place named is genuinely ambiguous — silence,
  // not a stated scope — and stays optimistic-pass per this repo's "don't
  // penalize missing data" convention. ANY named place alongside "remote"
  // (even just one — "Remote, Portugal", "United States, Remote") states a
  // scope, and a stated scope that isn't worldwide/India/APAC is a stated
  // exclusion of India, not an open question. Most single-country "remote"
  // postings mean remote-within-that-country, not remote-from-anywhere.
  return nonRemotePlaces.length === 0;
}

// Bare city names for Indian job boards (Instahyre, Hirist, Cutshort ...) whose
// location field carries no ", India" suffix. Without this list "Pune" looks
// like a foreign city and wrongly passes as "on-site abroad". Approved cities
// (profile onsite_cities) are checked before this list, so they still pass.
const INDIA_CITY_RE = /\b(pune|mumbai|navi mumbai|thane|delhi|new delhi|noida|greater noida|gurgaon|gurugram|faridabad|ghaziabad|kolkata|ahmedabad|surat|vadodara|jaipur|lucknow|chandigarh|mohali|indore|bhopal|nagpur|nashik|kochi|cochin|thiruvananthapuram|trivandrum|coimbatore|madurai|mysuru|mysore|mangalore|mangaluru|hubli|visakhapatnam|vizag|vijayawada|bhubaneswar|patna|ranchi|guwahati|dehradun|goa|panaji|udaipur|kanpur)\b/i;
const WORK_FROM_HOME_RE = /\b(work from home|wfh)\b/i;

/**
 * Mirrors _brief.md's Location Scoring table, collapsed to PASS/FAIL.
 * `location` may list several places separated by " · " or ",  " (scan.mjs's
 * multi-location joins) — the entry passes if ANY listed place qualifies.
 * `sponsorshipSignal` is 'no_sponsorship' | 'silent' | null (from the JD body
 * when fetched; null when unchecked because no JD body was available).
 *
 * @returns {{ pass: boolean, reason: string }}
 */
export function locationGate(location, profile, sponsorshipSignal, jdText = '') {
  const loc = profile?.location ?? {};
  const onsiteCities = (loc.onsite_cities ?? []).map(normalizeForMatch);
  const authorizedIn = (loc.authorized_in ?? []).map(normalizeForMatch);
  const needsSponsorship = loc.needs_sponsorship !== false;

  const text = String(location ?? '');
  if (!text.trim()) return { pass: false, reason: 'no location on the posting' };

  if (WORK_FROM_HOME_RE.test(text) && !REMOTE_RE.test(text)) {
    return { pass: true, reason: 'work from home (remote within India) — open per profile' };
  }

  if (REMOTE_RE.test(text)) {
    if (isRemoteScopeConfirmedOpen(text) && remoteScopeFromJd(jdText) === 'restricted') {
      return { pass: false, reason: 'remote role, but the JD restricts it to one country/region that excludes India' };
    }
    if (isRemoteScopeConfirmedOpen(text)) {
      return { pass: true, reason: 'remote — open worldwide per profile' };
    }
    return { pass: false, reason: `"remote" label appears scoped to a specific country/region list ("${text}") — not confirmed open to India; verify the JD before applying` };
  }

  if (onsiteCities.some(city => containsTerm(text, city))) {
    return { pass: true, reason: 'on-site in an approved city' };
  }

  // Domestic (within an authorized country) but not one of the approved
  // onsite cities — e.g. Pune/Noida for an India-authorized candidate whose
  // onsite approval is scoped to Bangalore/Chennai only. Country-level
  // authorization does NOT widen onsite eligibility; only onsite_cities does.
  // This is always a fail, independent of sponsorship (sponsorship is only
  // relevant once the role is genuinely outside every authorized country).
  if (authorizedIn.some(country => containsTerm(text, country))) {
    return { pass: false, reason: 'on-site in an authorized country but outside the approved onsite cities' };
  }

  if (INDIA_CITY_RE.test(text)) {
    return { pass: false, reason: 'on-site in an Indian city outside the approved onsite cities' };
  }

  // Genuinely abroad — outside every authorized country and outside onsite_cities.
  if (needsSponsorship) {
    if (sponsorshipSignal === 'no_sponsorship') {
      return { pass: false, reason: 'on-site abroad, JD states no visa sponsorship' };
    }
    if (sponsorshipSignal === 'offered') {
      return { pass: true, reason: 'on-site abroad, visa sponsorship or relocation offered' };
    }
    // Silent, or unchecked (no JD body fetched) — per _brief.md this is NOT a
    // blocker; sponsorship-unstated is neutral, not a fail.
    return { pass: true, reason: 'on-site abroad, sponsorship stated-or-silent (unconfirmed if unchecked)' };
  }
  return { pass: true, reason: 'on-site abroad, sponsorship not required for this candidate' };
}

// ── Gate 3: years of experience (JD body required) ──────────────────────────

/**
 * @param {string} jdText - JD body, or ''/null when unavailable.
 * @returns {{ pass: boolean, reason: string }}
 */
export function experienceGate(jdText) {
  if (!jdText) return { pass: true, reason: 'JD body unavailable — not checked' };
  let worstYears = 0;
  let worstHasEquivalent = true;
  let match;
  YEARS_EXPERIENCE_RE.lastIndex = 0;
  while ((match = YEARS_EXPERIENCE_RE.exec(jdText)) !== null) {
    const years = Number(match[1]);
    if (!Number.isFinite(years)) continue;
    const windowText = jdText.slice(Math.max(0, match.index - 20), match.index + match[0].length + 20);
    const hasEquivalent = OR_EQUIVALENT_RE.test(windowText);
    if (years > worstYears || (years === worstYears && !hasEquivalent)) {
      worstYears = years;
      worstHasEquivalent = hasEquivalent;
    }
  }
  EXPERIENCE_FIRST_RE.lastIndex = 0;
  while ((match = EXPERIENCE_FIRST_RE.exec(jdText)) !== null) {
    const years = Number(match[1]);
    if (!Number.isFinite(years)) continue;
    const hasEquivalent = OR_EQUIVALENT_RE.test(jdText.slice(Math.max(0, match.index - 20), match.index + match[0].length + 20));
    if (years > worstYears || (years === worstYears && !hasEquivalent)) {
      worstYears = years;
      worstHasEquivalent = hasEquivalent;
    }
  }
  // A "1-3 years" style range whose top end is <= 3 with nothing higher asked anywhere.
  let rangeMax = 0;
  YEAR_RANGE_RE.lastIndex = 0;
  while ((match = YEAR_RANGE_RE.exec(jdText)) !== null) {
    const hi = Number(match[2]);
    if (Number.isFinite(hi) && hi > rangeMax) rangeMax = hi;
  }
  if (rangeMax > 0 && rangeMax <= JUNIOR_RANGE_MAX && worstYears <= JUNIOR_RANGE_MAX) {
    return { pass: false, reason: `JD asks for at most ${rangeMax} years of experience: too junior for this candidate` };
  }
  if (worstYears >= 8 && !worstHasEquivalent) {
    return { pass: false, reason: `JD states ${worstYears}+ years required with no "or equivalent" flexibility` };
  }
  return { pass: true, reason: worstYears > 0 ? `${worstYears}+ years stated, within range` : 'no disqualifying experience requirement found' };
}

// ── Gate 4: comp floor (India roles only) ────────────────────────────────────

/**
 * @param {string} location
 * @param {string} compCell - the pipeline row's own comp cell, if any.
 * @param {string} jdText - JD body, or '' when unavailable.
 * @param {object} profile - parsed config/profile.yml.
 * @returns {{ pass: boolean, reason: string }}
 */
export function compFloorGate(location, compCell, jdText, profile) {
  const isIndiaRole = containsTerm(location, 'india')
    || (profile?.location?.onsite_cities ?? []).some(c => containsTerm(location, c));
  if (!isIndiaRole) return { pass: true, reason: 'comp floor only applies to India roles' };

  const minimumRaw = profile?.compensation?.minimum ?? '';
  const floorMatch = /([\d,.]+)\s*lpa/i.exec(String(minimumRaw));
  const floorLpa = floorMatch ? Number(floorMatch[1].replace(/,/g, '')) : null;
  if (floorLpa === null) return { pass: true, reason: 'no comp floor configured' };

  const haystacks = [compCell, jdText].filter(Boolean);
  for (const text of haystacks) {
    INR_LPA_RE.lastIndex = 0;
    let match;
    while ((match = INR_LPA_RE.exec(text)) !== null) {
      const figure = Number(match[1].replace(/,/g, ''));
      if (Number.isFinite(figure) && figure < floorLpa) {
        return { pass: false, reason: `stated comp ${figure} LPA is below the ${floorLpa} LPA floor` };
      }
    }
  }
  return { pass: true, reason: 'no below-floor figure found (or none stated)' };
}

// ── Gate 5: hard-DQ terms in the JD body (title alone is too ambiguous) ────
//
// A title like "Senior Analytics Engineer" or "Software Engineer, Backend"
// gives titleGate nothing to exclude on, but the JD body routinely reveals a
// hard DQ the title never states: a pure data-eng/BI stack (Snowflake/dbt/
// Airflow, no app-dev layer), pure DevOps/SRE, or manual QA. Only runs when a
// JD body was fetched; absence of a body is "not checked", not a pass-through
// exemption from HARD_DQ_TITLE_TERMS, which DOES still apply to body text.

/**
 * @param {string} jdText - JD body, or '' when unavailable.
 * @returns {{ pass: boolean, reason: string }}
 */
export function bodyHardDqGate(jdText) {
  if (!jdText) return { pass: true, reason: 'JD body unavailable — not checked' };
  const allTerms = [...HARD_DQ_TITLE_TERMS, ...HARD_DQ_BODY_ONLY_TERMS];
  const hit = allTerms.find(kw => containsTerm(jdText, kw));
  if (hit) return { pass: false, reason: `JD body matches hard-DQ term "${hit}"` };
  return { pass: true, reason: 'no hard-DQ term found in JD body' };
}

// ── Row parsing (mirrors rank-pipeline.mjs's parsePendingEntries) ──────────

export function parsePendingRows(text) {
  const out = [];
  const lines = String(text ?? '').split('\n');
  lines.forEach((raw, index) => {
    if (!raw.startsWith('- [ ] ')) return;
    if (raw.includes(GATE_LABEL)) return;
    const cells = raw.slice(6).split('|').map(c => c.trim());
    out.push({
      index,
      raw,
      url: cells[0] ?? '',
      company: cells[1] ?? '',
      title: cells[2] ?? '',
      location: cells[3] ?? '',
      // The comp cell, when present, sits between location and the first
      // `posted:`/`triage:`/`rank:` labeled cell — scan.mjs writes it as a
      // bare "NNN-NNN CURRENCY" token with no label.
      compCell: cells.slice(4).find(c => c && !/^[a-z_]+:/i.test(c) && /\d/.test(c)) ?? '',
    });
  });
  return out;
}

/**
 * Clamp verdict text into a safe, single-segment annotation. Mirrors
 * rank-pipeline.mjs's formatRankSegment sanitization.
 */
export function formatGateSegment(verdict, reasons) {
  const clean = sanitizeMarkdownField(reasons.join('; ')).trim();
  const capped = clean.length > 200 ? `${clean.slice(0, 199)}…` : clean;
  return `gate: ${verdict} — ${capped}`;
}

export function appendGateAnnotation(rawLine, verdict, reasons) {
  if (typeof rawLine !== 'string' || rawLine.includes(GATE_LABEL)) return rawLine;
  return `${rawLine} | ${formatGateSegment(verdict, reasons)}`;
}

export function applyAnnotations(text, pending) {
  const queue = pending.map(a => ({ ...a, used: false }));
  let written = 0;
  const out = String(text ?? '')
    .split('\n')
    .map(line => {
      if (line.includes(GATE_LABEL)) return line;
      const hit = queue.find(a => !a.used && a.raw === line);
      if (!hit) return line;
      hit.used = true;
      written += 1;
      return `${line} | ${hit.segment}`;
    })
    .join('\n');
  return { text: out, written };
}

export function selectBatch(entries, limit) {
  const n = Number(limit);
  const effective = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), LIMIT_CEILING) : DEFAULT_LIMIT;
  return entries.slice(0, effective);
}

// ── Per-entry evaluation ─────────────────────────────────────────────────────

/**
 * Runs all four gates for one entry. `jdText` is '' when unavailable/skipped.
 * @returns {{ verdict: 'PASS'|'FAIL', reasons: string[] }}
 */
export function evaluateEntry(entry, { positiveKeywords, negativeKeywords, profile, jdText }) {
  const title = titleGate(entry.title, positiveKeywords, negativeKeywords);
  if (!title.pass) return { verdict: 'FAIL', reasons: [title.reason] };

  const sponsorshipSignal = sponsorshipSignalFromJd(jdText);
  const location = locationGate(entry.location, profile, sponsorshipSignal, jdText);
  if (!location.pass) return { verdict: 'FAIL', reasons: [location.reason] };

  const experience = experienceGate(jdText);
  const comp = compFloorGate(entry.location, entry.compCell, jdText, profile);
  const bodyDq = bodyHardDqGate(jdText);
  const failed = [experience, comp, bodyDq].filter(g => !g.pass);
  if (failed.length) return { verdict: 'FAIL', reasons: failed.map(g => g.reason) };

  const notes = [title.reason, location.reason];
  if (!jdText) notes.push('JD body unavailable — experience/comp/sponsorship unverified');
  return { verdict: 'PASS', reasons: notes };
}

// ── JD fetch (zero-LLM: known-ATS API only, same as fetch-jd.mjs) ──────────

async function tryFetchJdText(url) {
  try {
    const { fetchJdViaKnownApi } = await import('./browser-extract.mjs');
    const result = await fetchJdViaKnownApi(url, JD_TEXT_CAP, FETCH_TIMEOUT_MS);
    return result?.text ?? '';
  } catch {
    return '';
  }
}

/**
 * Opt-in (--web): the free-tier webintel plugin, or null when it isn't installed
 * or enabled, in which case the gate behaves exactly as without --web.
 */
async function loadWeb() {
  try {
    const { loadWebIntel } = await import('./plugins.local/webintel/_load.mjs');
    return await loadWebIntel({ caller: 'gate' });
  } catch (err) {
    console.warn(`⚠️  --web: webintel plugin unavailable (${err.message}); continuing with ATS-API JDs only.`);
    return null;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(args) {
  if (hasFlag(args, '--help') || hasFlag(args, '-h')) {
    console.log(USAGE);
    return 0;
  }
  if (!existsSync(PIPELINE_PATH)) {
    console.log('No data/pipeline.md yet — run a scan first. Nothing to validate.');
    return 0;
  }

  const dryRun = hasFlag(args, '--dry-run');
  const noFetch = hasFlag(args, '--no-fetch');
  const limit = safeIntFlag(flagValue(args, '--limit'), DEFAULT_LIMIT);
  const companyFilter = flagValue(args, '--company');
  const useWeb = hasFlag(args, '--web') && !noFetch;
  const webLimit = safeIntFlag(flagValue(args, '--web-limit'), DEFAULT_WEB_LIMIT);

  const { positive, negative } = loadPortalsConfig();
  const profile = loadProfile();
  if (!profile) {
    console.error('config/profile.yml not found — location/comp gates cannot run. See doctor.mjs.');
    return 1;
  }

  let pending = parsePendingRows(readFileSync(PIPELINE_PATH, 'utf-8'));
  if (companyFilter) {
    pending = pending.filter(e => containsTerm(e.company, companyFilter));
  }
  if (!pending.length) {
    console.log('No un-gated pending entries. Nothing to do.');
    return 0;
  }
  const selected = selectBatch(pending, limit);

  const started = Date.now();
  const annotations = [];
  let passCount = 0;
  let failCount = 0;
  let fetchedCount = 0;
  let webCount = 0;

  // Pass 1: free JD fetch (known-ATS API) for rows that clear the title gate —
  // no point fetching a JD for a title we're about to fail anyway.
  const jdByRow = new Map();
  for (const entry of selected) {
    const preTitle = titleGate(entry.title, positive, negative);
    if (preTitle.pass && !noFetch) {
      const jdText = await tryFetchJdText(entry.url);
      if (jdText) fetchedCount += 1;
      jdByRow.set(entry, jdText);
    }
  }

  // Pass 2 (--web): one batched free-tier web fetch for title-passing rows the
  // ATS APIs couldn't read. Page text only; never a liveness signal.
  if (useWeb) {
    const missing = [...jdByRow].filter(([, t]) => !t).map(([e]) => e);
    const web = missing.length ? await loadWeb() : null;
    if (web) {
      // A dry run never spends: it reads only what an earlier run already cached.
      const pages = await web.fetchPages(missing.map((e) => e.url), { limit: webLimit, maxChars: JD_TEXT_CAP, cacheOnly: dryRun });
      for (const e of missing) {
        const doc = pages.get(e.url)?.doc;
        if (doc?.text) { jdByRow.set(e, doc.text); webCount += 1; }
      }
      console.log(`  ${web.summary()}`);
    }
  }

  for (const entry of selected) {
    const jdText = jdByRow.get(entry) || '';
    const { verdict, reasons } = evaluateEntry(entry, {
      positiveKeywords: positive,
      negativeKeywords: negative,
      profile,
      jdText,
    });
    if (verdict === 'PASS') passCount += 1; else failCount += 1;
    annotations.push({ raw: entry.raw, segment: formatGateSegment(verdict, reasons), verdict, entry });
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  if (dryRun) {
    for (const { entry, verdict, segment } of annotations) {
      console.log(`${verdict.padEnd(4)} | ${entry.company} | ${entry.title} | ${segment.replace(/^gate: \S+ — /, '')}`);
    }
    console.log(`\n  [dry-run] ${passCount} PASS / ${failCount} FAIL of ${selected.length} evaluated. Nothing written.`);
    return 0;
  }

  let written = 0;
  if (annotations.length) {
    await withPipelineLock(PIPELINE_PATH, () => {
      const current = readFileSync(PIPELINE_PATH, 'utf-8');
      const result = applyAnnotations(current, annotations);
      written = result.written;
      if (written) writeFileSync(PIPELINE_PATH, result.text);
    });
  }

  console.log(`\n  Validated ${written} entr(ies) of ${pending.length} pending: ${passCount} PASS, ${failCount} FAIL.`);
  console.log(`  JD body fetched for ${fetchedCount} entr(ies) via known-ATS API${useWeb ? ` + ${webCount} via webintel (free tier)` : ''} (zero LLM calls).`);
  if (pending.length > selected.length) {
    console.log(`  ${pending.length - selected.length} pending entr(ies) not validated this run (--limit ${selected.length}). Re-run to continue.`);
  }
  console.log(`  Elapsed: ${elapsed}s. No model calls made.`);
  console.log(`\n  → PASS rows are ready for application prep. Nothing is submitted automatically — each application still needs your review before Submit.`);
  return 0;
}

// ── self-test ────────────────────────────────────────────────────────────────

function selfTest() {
  let pass = 0;
  let fail = 0;
  const check = (name, cond) => {
    if (cond) { pass += 1; } else { fail += 1; console.log(`  FAIL: ${name}`); }
  };

  const POS = ['Software Engineer', 'Platform Engineer', 'Frontend Engineer', 'Full Stack Engineer'];
  const NEG = ['Junior', 'Intern', 'Test Engineer', 'QA Engineer'];

  check('title gate passes a direct archetype hit', titleGate('Senior Software Engineer', POS, NEG).pass);
  check('title gate fails no keyword match', !titleGate('Sales Development Representative', POS, NEG).pass);
  check('title gate fails a negative-list hit', !titleGate('Junior Software Engineer', POS, NEG).pass);
  check('title gate fails a hard-DQ domain term even with a positive hit',
    !titleGate('Senior Multiphysics Engineer, High Speed Reacting Flow', POS, NEG).pass);
  check('title gate fails chip design even though it says Software Engineer',
    !titleGate('Software Engineer, AI for Chip Design', POS, NEG).pass);
  check('title gate fails a bare C++ primary-language title',
    !titleGate('Senior Software Engineer, C++', POS, NEG).pass);

  const profile = {
    location: { onsite_cities: ['Bangalore', 'Bengaluru', 'Chennai'], authorized_in: ['India'], needs_sponsorship: true },
    compensation: { minimum: 'INR 35 LPA' },
  };

  check('location gate passes remote anywhere', locationGate('Remote', profile, null).pass);
  check('location gate passes on-site Bangalore', locationGate('Bengaluru, Karnataka, India', profile, null).pass);
  check('location gate passes on-site Chennai', locationGate('Chennai, Tamil Nadu, India', profile, null).pass);
  check('location gate fails on-site elsewhere in India', !locationGate('Pune, Maharashtra, India', profile, null).pass);
  check('location gate fails a bare Indian city with no country (Pune)', !locationGate('Pune', profile, null).pass);
  check('location gate fails multi-city all outside approved (Gurgaon,Pune)', !locationGate('Gurgaon,Pune', profile, null).pass);
  check('location gate passes multi-city containing an approved city (Bangalore,Gurgaon)', locationGate('Bangalore,Gurgaon', profile, null).pass);
  check('location gate passes Work From Home', locationGate('Work From Home', profile, null).pass);
  check('location gate passes abroad on-site when sponsorship is silent',
    locationGate('Dublin, Ireland', profile, 'silent').pass);
  check('location gate passes abroad on-site when unchecked (no JD body)',
    locationGate('Dublin, Ireland', profile, null).pass);
  check('location gate fails abroad on-site with explicit no-sponsorship',
    !locationGate('Dublin, Ireland', profile, 'no_sponsorship').pass);
  check('remote restricted to the US by the JD fails', !locationGate('Remote', profile, null, 'This is a fully remote role within the United States.').pass);
  check('remote restricted to LATAM by the JD fails', !locationGate('Remote', profile, null, 'Open to applicants located anywhere in the LATAM region').pass);
  check('remote with India in the JD still passes', locationGate('Remote', profile, null, 'Remote within the United States or India').pass);
  check('"globally recognized brands" is not an open scope', !locationGate('Remote', profile, null, 'Remote - Latin America. We build for globally recognized brands.').pass);
  check('timezone-limited remote fails', !locationGate('Remote', profile, null, 'If you are remote you must be within CET to ET timezones.').pass);
  check('eligible-to-work-in-Germany remote fails', !locationGate('Remote', profile, null, 'Eligible to work full-time in Germany and willing to undergo clearance.').pass);
  check('experience-first phrasing counts (11+ yrs)', !experienceGate('Experience: 11+ yrs').pass);
  check('junior range 1-3 years fails', !experienceGate('You have 1\u20133 years of experience building frontend applications.').pass);
  check('3+ years is not junior', experienceGate('3+ years of experience with React').pass);
  check('range with a higher ask is not junior', experienceGate('You will work with a team of 1-3 years engineers. We need 5+ years of experience overall.').pass);
  check('"remote for candidates based in [states]" fails', !locationGate('Remote', profile, null, 'This position is remote for candidates based in the following states: California, Maine.').pass);
  check('"UK Timezone (within +/- 2 hours)" fails', !locationGate('Remote', profile, null, 'Senior Fullstack Engineer - Remote, UK Timezone (within +/- 2 hours)').pass);
  check('remote with no restriction passes', locationGate('Remote', profile, null, 'Work from wherever you are.').pass);
  check('sponsorship offered detected', sponsorshipSignalFromJd('We provide relocation assistance and visa sponsorship is available.') === 'offered');
  check('no-sponsorship still wins', sponsorshipSignalFromJd('We are unable to sponsor. Relocation assistance is not offered.') === 'no_sponsorship');
  check('"relocation support is not provided" is a no', sponsorshipSignalFromJd('Candidates must currently reside in Poland or relocate independently, as relocation support is not provided.') === 'no_sponsorship');
  check('"unable to offer visa sponsorship or relocation" is a no', sponsorshipSignalFromJd('We are currently unable to offer fully remote work, visa sponsorship, or relocation support for this opportunity.') === 'no_sponsorship');
  check('silent JD -> silent', sponsorshipSignalFromJd('Build great software.') === 'silent');
  check('abroad + offered reason', /offered/.test(locationGate('Dublin, Ireland', profile, 'offered').reason));
  check('location gate fails an empty location', !locationGate('', profile, null).pass);
  check('location gate passes a bare Remote with no other place named',
    locationGate('Remote', profile, null).pass);
  check('location gate passes remote worldwide qualifier',
    locationGate('Remote - Worldwide', profile, null).pass);
  check('location gate passes remote scoped to Asia (covers India)',
    locationGate('Remote, Asia, Europe, Middle East', profile, null).pass);
  check('location gate does NOT auto-pass a remote scoped to specific non-Asia countries (#4102 CookUnity finding)',
    !locationGate('Barbados, Mexico, Remote, Dominican Republic, Haiti, Jamaica, South America', profile, null).pass);
  check('location gate does NOT auto-pass US-city-scoped remote (ambiguous, not worldwide)',
    !locationGate('San Francisco, CA · Remote · New York, NY', profile, null).pass);
  check('location gate does NOT auto-pass a single-country-scoped remote',
    !locationGate('Remote, Portugal', profile, null).pass);

  check('experience gate passes when JD unavailable', experienceGate('').pass);
  check('experience gate passes 5+ years', experienceGate('5+ years of experience required').pass);
  check('experience gate fails hard 10+ years with no equivalent flexibility',
    !experienceGate('10+ years of experience required, no exceptions').pass);
  check('experience gate passes 8+ years with or-equivalent flexibility',
    experienceGate('8+ years experience or equivalent required').pass);
  check('experience gate passes an open-ended 6+ years', experienceGate('6+ years of experience preferred').pass);

  check('comp floor gate passes when not an India role',
    compFloorGate('Dublin, Ireland', '', '', profile).pass);
  check('comp floor gate passes when no figure stated',
    compFloorGate('Bangalore, India', '', '', profile).pass);
  check('comp floor gate fails a below-floor figure in the comp cell',
    !compFloorGate('Bangalore, India', '₹20 LPA', '', profile).pass);
  check('comp floor gate passes an above-floor figure',
    compFloorGate('Bangalore, India', '₹40 LPA', '', profile).pass);

  check('body hard-DQ gate passes when JD unavailable', bodyHardDqGate('').pass);
  check('body hard-DQ gate passes a clean frontend JD', bodyHardDqGate('React, TypeScript, and GraphQL experience required').pass);
  check('body hard-DQ gate fails a Snowflake/dbt data-eng JD (#4102 G2 finding)',
    !bodyHardDqGate('6+ years building dbt pipelines on Snowflake and Airflow, no frontend layer').pass);
  check('body hard-DQ gate fails an embedded-firmware JD',
    !bodyHardDqGate('Experience with embedded firmware and real-time OS required').pass);

  const fixture = [
    '## Pending',
    '- [ ] https://x.test/1 | Acme | Senior Software Engineer | Bangalore, India',
    '- [ ] https://x.test/2 | Beta | Senior Multiphysics Engineer | Costa Mesa, CA, USA',
    '- [x] https://x.test/3 | Gamma | Done Role',
    '- [ ] https://x.test/4 | Delta | Already Gated | Remote | gate: PASS — prior run',
  ].join('\n');
  const pending = parsePendingRows(fixture);
  check('skips processed rows', !pending.some(e => e.url.endsWith('/3')));
  check('skips already-gated rows', !pending.some(e => e.url.endsWith('/4')));
  check('finds the two candidates', pending.length === 2);
  check('parses location', pending[0].location === 'Bangalore, India');

  const line = pending[0].raw;
  const once = appendGateAnnotation(line, 'PASS', ['title matches', 'location ok']);
  check('annotation appends', once.includes('| gate: PASS — title matches; location ok'));
  check('annotation preserves the original line', once.startsWith(line));
  check('annotation is idempotent', appendGateAnnotation(once, 'FAIL', ['x']) === once);

  check('limit respected', selectBatch(pending, 1).length === 1);
  check('ceiling cannot be raised', selectBatch(Array(5000).fill({}), 999999).length === LIMIT_CEILING);
  check('default when limit absent', selectBatch(Array(500).fill({}), undefined).length === DEFAULT_LIMIT);

  const dupText = [
    '## Pending',
    '- [ ] https://x.test/9 | Acme | Backend Engineer',
    '- [ ] https://x.test/9 | Acme | Backend Engineer',
  ].join('\n');
  const dupRaw = '- [ ] https://x.test/9 | Acme | Backend Engineer';
  const dupOut = applyAnnotations(dupText, [
    { raw: dupRaw, segment: 'gate: PASS — first' },
    { raw: dupRaw, segment: 'gate: FAIL — second' },
  ]);
  check('both duplicate rows are annotated', dupOut.written === 2);
  check('duplicates take their own verdict, in order',
    dupOut.text.includes('— first') && dupOut.text.includes('— second'));
  check('an already-gated row is skipped by applyAnnotations',
    applyAnnotations(`${dupRaw} | gate: PASS — old`, [{ raw: dupRaw, segment: 'gate: FAIL — new' }]).written === 0);

  console.log(`\n  basic-validate-pipeline self-test: ${pass} passed, ${fail} failed\n`);
  return fail === 0 ? 0 : 1;
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    process.exit(selfTest());
  } else {
    main(args).then(code => process.exit(code)).catch(err => {
      console.error(err?.message ?? err);
      process.exit(1);
    });
  }
}
