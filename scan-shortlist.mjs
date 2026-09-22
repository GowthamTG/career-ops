#!/usr/bin/env node
/**
 * scan-shortlist.mjs: the one command. scan -> gate -> resolve leads -> digest.
 *
 *   node scan-shortlist.mjs [--deep] [--web] [--dry-run] [--skip-scan] [--include-touched]
 *
 *   (default)          scan.mjs -> gate -> resolve-leads -> gate -> digest
 *   --deep             also run scan-ats-full.mjs --since 7 (Greenhouse/Lever/Ashby, ~1.5 h)
 *   --web              opt-in free-tier web help (plugins.local/webintel): the gate reads non-ATS
 *                      JDs via Exa/Firecrawl and resolve-leads searches for board-less companies'
 *                      postings. Budget-capped per run and per month; see `node webintel.mjs usage`
 *   --skip-scan        skip the network scan; re-gate, resolve and digest what is in pipeline.md
 *   --dry-run          no network and no writes to pipeline.md: only builds the digest
 *   --include-touched  keep companies already in the tracker (default: hidden)
 *   --max-age-days N   drop rows posted more than N days ago (default 45; 0 = no limit)
 *
 * Zero LLM calls. Each step runs `nice`d and sequentially so the machine stays
 * responsive. Writes data/shortlist-YYYY-MM-DD.md, a short list of roles worth a
 * look, and never applies to or submits anything.
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { normalizeCompany } from './tracker-utils.mjs';
import { getCareerOpsRoot } from './path-resolver.mjs';
import { isMainModule } from './lib/is-main-module.mjs';
import { parseLeadRow, leadHostOf } from './resolve-leads.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url)); // codebase root (scripts, providers)
const DATA_ROOT = getCareerOpsRoot(); // user-layer root (data/, reports/)
const PIPELINE = join(DATA_ROOT, 'data/pipeline.md');
const TRACKER = join(DATA_ROOT, 'data/applications.md');
const BLACKLIST = join(DATA_ROOT, 'data/blacklist.md');

// ── Fit rules (pure, unit-tested) ────────────────────────────────────────────

const TITLE_INCLUDE = /(back[\s-]?end|api engineer|front[\s-]?end|full[\s-]?stack|react|\bui\b|\bweb\b|product engineer|design engineer|founding engineer|member of technical staff|software (engineer|developer)|\bsde\b|application engineer|analytics engineer|data platform|forward deployed|agent)/i;
const TITLE_EXCLUDE = /(silicon|logic design|machine design|civil|mechanical|electrical|structural|physical design|analog|\brf\b|chip|distributed systems|low[- ]latency|high[- ]performance|storage engine|compiler|database internals|(?<!technical )staff|principal|\blead\b|manager|director|\bhead\b|architect|intern\b|internship|junior|\bjr\b|trainee|fresher|associate software|native|android|\bios\b|react native|flutter|swift|kotlin|devops|\bsre\b|\bqa\b|quality|test|automation|data engineer|data scientist|machine learning|\bml\b|security|embedded|firmware|network|kernel|\bsap\b|salesforce|servicenow|mainframe|\bphp\b|ruby|scala|\.net|dotnet|java(?!script)|c\+\+|golang|\bgo\b developer|blockchain|solidity|new grad|graduate|research|\bic\b|mixed-signal|\bgtm\b|sales|mobile|systems software|infrastructure|\binfra\b|platform diagnostics|audit|logging|gen ?ai engineer|rtl|verification|hardware)/i;
const BACKEND_ONLY = /(back[\s-]?end)/i;
const FRONT_OR_FULL = /(front[\s-]?end|full[\s-]?stack|react|\bui\b|\bweb\b)/i;

// Business models the user never applies to (modes/_custom.md), as a safety net
// on top of data/blacklist.md.
const IT_SERVICES = /\b(tcs|tata consultancy|infosys|wipro|cognizant|accenture\w*|capco|zartis|jobgether|placementsio|brafton|globant|endava|luxoft|softserve|capgemini|hcl(tech)?|tech mahindra|ltimindtree|mindtree|mphasis|coforge|wissen|hexaware|birlasoft|zensar|persistent systems|cyient|quest global|genpact|deloitte|kpmg|ernst|pwc|proxify|toptal|turing|globallogic|virtusa|epam|thoughtworks|nagarro|softtek|cgi|dxc|ntt data|unisys|sonata|lean ?techniques)\b/i;
const AGENCY = /\b(randstad|michael page|hays|adecco|manpower|kelly services|robert half|talent500|naukri|instahyre|teamlease|quess|xpheno|ciel|weekday(?:works)?)\b/i;

// The scanner labels many postings with an acquired brand, so a company you
// already applied to (or blacklisted) hides behind another name.
const COMPANY_ALIASES = {
  neon: 'databricks', yammer: 'microsoft', 'citus data': 'microsoft', github: 'microsoft', linkedin: 'microsoft',
  instana: 'ibm', 'red hat': 'ibm', 'nimble storage': 'hpe', 'hpe simplivity': 'hpe', 'hewlett packard enterprise': 'hpe',
  airkit: 'salesforce', tableau: 'salesforce', slack: 'salesforce', mulesoft: 'salesforce', 'frame io': 'adobe',
  'cape analytics': 'moodys', 'weights biases': 'coreweave', 'weights and biases': 'coreweave',
};

/** Company key with acquired-brand aliases folded into the parent. */
export function companyKey(name) {
  const key = normalizeCompany(name);
  return COMPANY_ALIASES[key] ?? key;
}

// A title that names a region-only role ("(Brazil and Argentina Only)", "[REMOTE - Canada]").
const TITLE_REGION_ONLY = /((brazil|argentina|mexico|latam|latin america|canada|usa?|united states|uk|europe|emea|germany|france|spain|poland|portugal|australia)\b[^,)\]]{0,20}\bonly\b|remote\s*[-–:\[(]\s*(canada|usa?|united states|uk|europe|latam|brazil|argentina|mexico|germany|france|spain)\b|\((?:usa?|uk|canada)\)\s*$)/i;

/** @param {string} title */
export function titleRegionRestricted(title) {
  return TITLE_REGION_ONLY.test(String(title ?? ''));
}

// A title that names the work (frontend, full-stack, product...) is a strong fit.
// A bare "Software Engineer" / "SDE" says nothing without the JD (it is often
// systems, infra or embedded), so those go to their own low-priority bucket.
const TITLE_STRONG = /(back[\s-]?end|api engineer|front[\s-]?end|full[\s-]?stack|react|\bui\b|\bweb\b|product engineer|design engineer|founding engineer|member of technical staff|analytics engineer|forward deployed|agent)/i;

/** @param {string} title */
export function isStrongTitle(title) {
  return TITLE_STRONG.test(String(title ?? ''));
}

// Hosts that cannot be applied through without an account (standing rule).
const LOGIN_WALL_HOSTS = /(^|\.)(builtin\.com|workatastartup\.com|myworkdayjobs\.com|darwinbox\.in)$/i;

/** @param {string} url */
export function isLoginWalled(url) {
  try {
    return LOGIN_WALL_HOSTS.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Does the title look like a frontend/full-stack/product role for this candidate? */
export function titleFits(title) {
  const t = String(title ?? '');
  if (!TITLE_INCLUDE.test(t) || TITLE_EXCLUDE.test(t)) return false;
  return true;
}

/** @returns {'india'|'remote'|'abroad'|'unknown'} from the gate's own reason text. */
export function regionOf(location, gateReason) {
  const r = String(gateReason ?? '');
  if (/approved city/i.test(r)) return 'india';
  if (/work from home|remote/i.test(r) || /\b(remote|work from home)\b/i.test(location)) return 'remote';
  if (/abroad/i.test(r)) return 'abroad';
  return 'unknown';
}

/**
 * Parse a pending pipeline line into the fields the digest needs.
 * @param {string} line
 */
export function parseDigestRow(line) {
  const row = parseLeadRow(line);
  if (!row) return null;
  const gate = /\| gate: (PASS|FAIL) — (.*?)(?= \| (?:via|posted|rank|triage)\b|$)/.exec(row.rest);
  const posted = /\| posted: (\d{4}-\d{2}-\d{2})/.exec(row.rest);
  const via = /\| via: (\S+)/.exec(row.rest);
  return {
    url: row.url,
    company: row.company,
    title: row.title,
    location: row.location,
    gate: gate?.[1] ?? null,
    reason: gate?.[2] ?? '',
    posted: posted?.[1] ?? '',
    via: via?.[1] ?? '',
    needsBrowser: /\| needs-browser-check\b/.test(row.rest),
    leadHost: leadHostOf(row.url),
  };
}

/** Whole days between an ISO date (YYYY-MM-DD) and `now`. */
export function ageDays(iso, now = Date.now()) {
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isNaN(ms) ? 0 : Math.floor((now - ms) / 86400000);
}

/**
 * Bucket a parsed row, or null to drop it.
 * A = employer board or resolved lead, India/remote. B = unresolved lead
 * (verify in the browser). C = abroad. D = agency / client unnamed.
 */
export function classify(r, ctx) {
  if (!r || r.gate !== 'PASS') return null;
  if (!titleFits(r.title)) return null;
  if (isLoginWalled(r.url)) return null;
  const key = companyKey(r.company);
  if (titleRegionRestricted(r.title)) return null;
  if (r.posted && ctx.maxAgeDays && ageDays(r.posted, ctx.now) > ctx.maxAgeDays) return null;
  if (IT_SERVICES.test(r.company) || ctx.blacklist.has(key)) return null;
  if (!ctx.includeTouched && ctx.touched.has(key)) return null;
  if (r.company === '?' || AGENCY.test(r.company)) return 'D';
  const region = regionOf(r.location, r.reason);
  // Abroad roles are only worth listing when the JD offers sponsorship/relocation;
  // "silent" abroad roles number in the thousands and are counted, not listed.
  if (region === 'abroad') {
    if (!isStrongTitle(r.title)) return 'X';
    if (/offered/i.test(r.reason)) return 'C';
    // Sponsorship not mentioned: many such employers cannot sponsor, but the candidate
    // would relocate anywhere, so list them (JD read only) with a caveat instead of hiding.
    return /JD body unavailable/i.test(r.reason) ? 'X' : 'F';
  }
  if (region === 'unknown') return null;
  if (!isStrongTitle(r.title)) return 'E';
  // A means the JD was actually read and passed. No JD read = unverified = section B.
  if (r.leadHost || r.needsBrowser || /JD body unavailable/i.test(r.reason)) return 'B';
  return 'A';
}

// ── Inputs ───────────────────────────────────────────────────────────────────

function loadTouched() {
  const set = new Set();
  if (!existsSync(TRACKER)) return set;
  for (const line of readFileSync(TRACKER, 'utf-8').split('\n')) {
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map((c) => c.trim());
    // | # | Date | Company | Role | ...  -> cells[3]
    if (/^\d+$/.test(cells[1] ?? '') && cells[3]) set.add(companyKey(cells[3]));
  }
  return set;
}

function loadBlacklist() {
  const set = new Set();
  if (!existsSync(BLACKLIST)) return set;
  for (const line of readFileSync(BLACKLIST, 'utf-8').split('\n')) {
    if (line.trim().startsWith('|')) {
      // Table row: | Company | Since | Scope | Reason |  (same format scan.mjs parses)
      const company = line.split('|').map((c) => c.trim())[1] ?? '';
      if (company && !/^[-: ]+$/.test(company) && company.toLowerCase() !== 'company') set.add(companyKey(company));
      continue;
    }
    const m = /^\s*[-*]\s+([^—–\n]+?)(?:\s+[—–-]\s+|$)/.exec(line);
    if (m) set.add(companyKey(m[1]));
  }
  return set;
}

// ── Digest ───────────────────────────────────────────────────────────────────

const SECTION_CAP = { A: 60, B: 50, C: 40, D: 30, E: 30, F: 60 };
const TITLES = {
  A: 'A. India or remote, on the employer\'s own board (best leads)',
  B: 'B. India or remote leads from job portals: verify in the browser first',
  C: 'C. Abroad, on-site or hybrid (visa sponsorship stated or silent)',
  D: 'D. Recruitment agencies / client unnamed (kept separate, not counted toward a batch)',
  F: 'F. Abroad, JD read, visa sponsorship NOT mentioned (could be a no: ask before investing time)',
  E: 'E. Generic titles ("Software Engineer", "SDE"): unclear without the JD, low priority',
};

/** @param {string} s */
const esc = (s) => String(s ?? '').replace(/\|/g, '/');

export function buildDigest(lines, ctx, date) {
  const buckets = { A: [], B: [], C: [], D: [], E: [], F: [] };
  const seen = new Set();
  let considered = 0;
  let hiddenAbroad = 0;
  for (const line of lines) {
    const r = parseDigestRow(line);
    if (!r || seen.has(r.url)) continue;
    considered++;
    const b = classify(r, ctx);
    if (!b) continue;
    if (b === 'X') {
      hiddenAbroad++;
      continue;
    }
    seen.add(r.url);
    buckets[b].push(r);
  }
  const byPosted = (a, b) => (b.posted || '').localeCompare(a.posted || '');
  let out = `# Shortlist ${date}\n\n`;
  out += `Zero-LLM digest of ${considered} pending pipeline rows. Only roles that passed the gate, fit frontend/full-stack/product titles, and are not already in your tracker or blacklist. `;
  out += `Nothing here is verified live: open the link in the browser before filling anything. Section C lists abroad roles that offer visa sponsorship or relocation; section F lists abroad roles whose JD does not mention sponsorship (${hiddenAbroad} more are hidden because the JD could not be read or the title is generic).\n\n`;
  out += `| Section | Roles |\n|---|---|\n`;
  for (const k of ['A', 'B', 'C', 'F', 'D', 'E']) out += `| ${k} | ${buckets[k].length} |\n`;
  out += '\n';
  for (const k of ['A', 'B', 'C', 'F', 'D', 'E']) {
    const rows = buckets[k].sort(byPosted);
    out += `## ${TITLES[k]}\n\n`;
    if (!rows.length) {
      out += '_None this run._\n\n';
      continue;
    }
    out += '| Company | Role | Location | Posted | JD read | Link |\n|---|---|---|---|---|---|\n';
    for (const r of rows.slice(0, SECTION_CAP[k])) {
      const jd = /JD body unavailable/i.test(r.reason) ? 'no' : 'yes';
      out += `| ${esc(r.company)} | ${esc(r.title)} | ${esc(r.location)} | ${r.posted || '-'} | ${jd} | ${r.url} |\n`;
    }
    if (rows.length > SECTION_CAP[k]) out += `\n_${rows.length - SECTION_CAP[k]} more not shown (cap ${SECTION_CAP[k]})._\n`;
    out += '\n';
  }
  return { markdown: out, counts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.length])), considered, hiddenAbroad };
}

// ── Runner ───────────────────────────────────────────────────────────────────

function step(label, cmd, args) {
  console.log(`\n▶ ${label}`);
  const res = spawnSync('nice', ['-n', '10', cmd, ...args], { cwd: ROOT, stdio: 'inherit' });
  if (res.status !== 0) console.log(`  (step exited ${res.status}; continuing)`);
}

// The gate validates at most 1000 rows per run, so loop until nothing is left un-gated.
function ungatedCount() {
  return readFileSync(PIPELINE, 'utf-8').split('\n').filter((l) => l.startsWith('- [ ]') && !l.includes(' | gate:')).length;
}

function gateAll(label, web = false) {
  for (let i = 0; i < 20; i++) {
    const left = ungatedCount();
    if (left === 0) return;
    // --web only on the first pass: each pass is a new process with its own
    // per-run page cap, so passing it every time would multiply the spend.
    const webArgs = web && i === 0 ? ['--web'] : [];
    step(`${label} (${left} rows left)`, 'node', ['basic-validate-pipeline.mjs', '--limit', '1000', ...webArgs]);
  }
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function selfTest() {
  let pass = 0;
  let fail = 0;
  const check = (n, ok) => (ok ? pass++ : (fail++, console.log(`  ❌ ${n}`)));
  check('fits: Senior Frontend Engineer', titleFits('Senior Frontend Engineer'));
  check('fits: Full Stack Developer (React)', titleFits('Full Stack Developer (React)'));
  check('fits: Member of Technical Staff', titleFits('Member of Technical Staff'));
  check('rejects: Staff Software Engineer', !titleFits('Staff Software Engineer'));
  check('rejects: React Native Developer', !titleFits('React Native Developer'));
  check('rejects: Java Full Stack', !titleFits('Java Full Stack Developer'));
  check('keeps: JavaScript full stack', titleFits('JavaScript Full Stack Engineer'));
  check('keeps: Backend Engineer (backend is in scope now)', titleFits('Senior Backend Engineer'));
  check('keeps: SDE 2 Backend', titleFits('SDE 2 - Backend'));
  check('rejects: Java backend', !titleFits('Backend Engineer (Java)'));
  check('rejects: distributed systems backend', !titleFits('Backend Engineer, Distributed Systems'));
  check('keeps: backend-leaning full stack', titleFits('Backend Leaning Full Stack Engineer'));
  check('backend is a strong title', isStrongTitle('Backend Engineer'));
  const line = '- [ ] https://boards.greenhouse.io/x/jobs/1 | Acme | Senior Frontend Engineer | Bengaluru, India | posted: 2026-09-18 | gate: PASS — title ok; on-site in an approved city; JD body unavailable — experience unchecked';
  const r = parseDigestRow(line);
  check('parse: gate + posted', r && r.gate === 'PASS' && r.posted === '2026-09-18');
  const ctx = { blacklist: new Set(), touched: new Set(), includeTouched: false };
  check('A row with an unread JD is demoted to B', classify(r, ctx) === 'B');
  const readRow = parseDigestRow('- [ ] https://boards.greenhouse.io/x/jobs/2 | Acme | Senior Frontend Engineer | Bengaluru, India | posted: 2026-09-18 | gate: PASS — title ok; on-site in an approved city; 3+ years stated, within range');
  check('classify A when the JD was read', classify(readRow, ctx) === 'A');
  check('classify drops touched company', classify(r, { ...ctx, touched: new Set([normalizeCompany('Acme')]) }) === null);
  check('include-touched keeps it', classify(readRow, { ...ctx, touched: new Set([normalizeCompany('Acme')]), includeTouched: true }) === 'A');
  check('classify drops blacklisted', classify(r, { ...ctx, blacklist: new Set([normalizeCompany('Acme')]) }) === null);
  const lead = parseDigestRow('- [ ] https://www.instahyre.com/job-1-x/ | Foo | Frontend Developer | Bangalore | gate: PASS — ok; on-site in an approved city | needs-browser-check');
  check('classify B for unresolved lead', classify(lead, ctx) === 'B');
  const abroad = parseDigestRow('- [ ] https://jobs.ashbyhq.com/y/1 | Bar | Full Stack Engineer | Berlin, Germany | gate: PASS — on-site abroad, sponsorship stated-or-silent');
  check('abroad, JD read, sponsorship silent goes to F', classify(abroad, ctx) === 'F');
  const abroadUnread = parseDigestRow('- [ ] https://jobs.ashbyhq.com/y/5 | Bar | Full Stack Engineer | Berlin, Germany | gate: PASS — on-site abroad, sponsorship stated-or-silent; JD body unavailable — experience unchecked');
  check('abroad with an unread JD stays hidden', classify(abroadUnread, ctx) === 'X');
  const abroadOffered = parseDigestRow('- [ ] https://jobs.ashbyhq.com/y/2 | Bar | Full Stack Engineer | Berlin, Germany | gate: PASS — on-site abroad, visa sponsorship or relocation offered');
  check('classify C for abroad with sponsorship offered', classify(abroadOffered, ctx) === 'C');
  const abroadGeneric = parseDigestRow('- [ ] https://jobs.ashbyhq.com/y/3 | Bar | Software Engineer | Berlin, Germany | gate: PASS — on-site abroad, visa sponsorship or relocation offered');
  check('abroad generic title is hidden even with sponsorship', classify(abroadGeneric, ctx) === 'X');
  check('silicon/civil/machine design excluded', !titleFits('Civil Design Engineer') && !titleFits('Senior Silicon Logical Design Engineer') && !titleFits('Machine Design Engineer - Contract'));
  check('UI design engineer kept', titleFits('Design Engineer (UI, Frontend)'));
  check('gtm excluded (word boundary works)', !titleFits('GTM Forward Deployed Engineer'));
  check('infra excluded (word boundary works)', !titleFits('Software Engineer, Infra'));
  check('new grad excluded', !titleFits('Software Engineer, New Grad (2027)'));
  check('research engineer excluded', !titleFits('Research Engineer, Evals - Member of Technical Staff'));
  const agency = parseDigestRow('- [ ] https://x.test/1 | ? | Frontend Engineer | Bangalore | gate: PASS — on-site in an approved city');
  check('classify D for unnamed employer', classify(agency, ctx) === 'D');
  const svc = parseDigestRow('- [ ] https://x.test/2 | Infosys | Frontend Engineer | Bangalore | gate: PASS — on-site in an approved city');
  check('IT services dropped', classify(svc, ctx) === null);
  check('Accenture Federal (no space) dropped', classify(parseDigestRow('- [ ] https://x.test/af | accenturefederalservices | Full Stack Developer | Washington, DC | gate: PASS — on-site abroad, sponsorship stated-or-silent'), ctx) === null);
  check('agencies dropped (Capco, Zartis, Jobgether)', ['capco','zartis','jobgether'].every(c => classify(parseDigestRow(`- [ ] https://x.test/${c} | ${c} | Full Stack Developer | Berlin | gate: PASS — on-site abroad, sponsorship stated-or-silent`), ctx) === null));
  const fail_ = parseDigestRow('- [ ] https://x.test/3 | Z | Frontend Engineer | Bangalore | gate: FAIL — nope');
  check('gate FAIL dropped', classify(fail_, ctx) === null);
  check('strong title: frontend', isStrongTitle('Senior Frontend Engineer'));
  check('generic title is not strong', !isStrongTitle('Software Engineer II'));
  const gen = parseDigestRow('- [ ] https://x.test/9 | Q | Software Engineer | Bengaluru, India | gate: PASS — on-site in an approved city');
  check('classify E for generic title', classify(gen, ctx) === 'E');
  const bi = parseDigestRow('- [ ] https://builtin.com/job/x/1 | Q | Frontend Engineer | Bengaluru, India | gate: PASS — on-site in an approved city');
  check('login-walled host dropped', classify(bi, ctx) === null);
  check('mobile excluded', !titleFits('Software Engineer - Mobile App Development'));
  check('alias: Neon folds into Databricks', companyKey('Neon') === companyKey('Databricks'));
  check('alias: touched Databricks hides Neon row', classify(parseDigestRow('- [ ] https://x.test/n | Neon | Full Stack Developer | Bengaluru, India | gate: PASS — on-site in an approved city'), { ...ctx, touched: new Set([companyKey('Databricks')]) }) === null);
  check('region-only title dropped', classify(parseDigestRow('- [ ] https://x.test/r | Nich | Analytics Engineer (Brazil and Argentina Only) | Remote | gate: PASS — remote'), ctx) === null);
  check('region-only: [REMOTE - Canada]', titleRegionRestricted('Software Engineer, Agents [REMOTE - Canada]'));
  check('region-only: plain title is fine', !titleRegionRestricted('Senior Frontend Engineer'));
  const old = parseDigestRow('- [ ] https://x.test/o | Old | Frontend Engineer | Bengaluru, India | posted: 2026-02-01 | gate: PASS — on-site in an approved city');
  check('stale row dropped by max age', classify(old, { ...ctx, maxAgeDays: 45, now: Date.parse('2026-09-20T00:00:00Z') }) === null);
  check('age filter off when 0', classify(old, { ...ctx, maxAgeDays: 0, now: Date.parse('2026-09-20T00:00:00Z') }) === 'A');
  const readLine = '- [ ] https://boards.greenhouse.io/x/jobs/2 | Acme | Senior Frontend Engineer | Bengaluru, India | posted: 2026-09-18 | gate: PASS — title ok; on-site in an approved city; 3+ years stated, within range';
  const d = buildDigest([readLine, readLine], ctx, '2026-09-20');
  check('digest dedups by URL', d.counts.A === 1);
  console.log(`  scan-shortlist self-test: ${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  const dry = args.includes('--dry-run');
  const web = args.includes('--web');
  const started = Date.now();

  if (!dry && !args.includes('--skip-scan')) {
    step('Fast scan (tracked companies + job boards)', 'node', ['scan.mjs']);
    if (args.includes('--deep')) {
      step('Deep ATS scan (Greenhouse/Lever/Ashby, last 7 days): this takes a long time', 'node', ['scan-ats-full.mjs', '--since', '7', '--ats', 'greenhouse,lever,ashby']);
    }
  }
  if (!dry) {
    gateAll('Gate (title, location, years, comp)', web);
    step('Resolve portal leads to employer postings', 'node', ['resolve-leads.mjs', ...(web ? ['--web'] : [])]);
    gateAll('Re-gate rewritten rows', web);
  }

  const lines = readFileSync(PIPELINE, 'utf-8').split('\n');
  const ai = args.indexOf('--max-age-days');
  const maxAgeDays = ai >= 0 ? Math.max(0, Number(args[ai + 1]) || 0) : 45;
  const ctx = { blacklist: loadBlacklist(), touched: loadTouched(), includeTouched: args.includes('--include-touched'), maxAgeDays, now: Date.now() };
  const date = today();
  const { markdown, counts, considered } = buildDigest(lines, ctx, date);
  const outPath = join(DATA_ROOT, `data/shortlist-${date}.md`);
  writeFileSync(outPath, markdown);
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n✅ Digest: ${outPath}`);
  console.log(`   ${considered} rows considered -> A ${counts.A} | B ${counts.B} | C ${counts.C} | F ${counts.F} | D ${counts.D} | E ${counts.E}  (${mins} min)`);
  const boards = join(DATA_ROOT, 'data/webintel-board-candidates.tsv');
  if (existsSync(boards)) {
    const n = readFileSync(boards, 'utf-8').split('\n').filter(Boolean).length - 1;
    if (n > 0) console.log(`   ${n} board candidate(s) in data/webintel-board-candidates.tsv: add with \`node discover-ats.mjs --write <Company>\` to scan them free from then on.`);
  }
  if (web && !dry) step('Free-tier web budget (Exa/Firecrawl)', 'node', ['webintel.mjs', 'usage']);
}

if (isMainModule(import.meta.url)) {
  main().catch((e) => {
    console.error(`scan-shortlist failed: ${e.stack || e.message}`);
    process.exit(1);
  });
}
