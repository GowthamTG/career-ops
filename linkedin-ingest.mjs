#!/usr/bin/env node
/**
 * linkedin-ingest.mjs: the ASSISTED path for LinkedIn Jobs (zero LLM).
 *
 * linkedin.com's robots.txt disallows scripted fetching, so nothing here calls
 * LinkedIn. The agent reads a search or Top-picks page in the user's own
 * logged-in Chrome with scripts/linkedin-collect.js (the way a person scrolls
 * it) and saves the lines it prints. This script turns those lines into
 * pipeline rows with the scanner's own dedup and blacklist.
 *
 *   node linkedin-ingest.mjs --file cards.txt [--dry-run]
 *
 * --file format, one card per line: id|title|company|location|EA|DONE
 *   EA   = Easy Apply badge (kept as a note, never a score input)
 *   DONE = "Applied" badge: skipped
 * Rows land in data/pipeline.md as linkedin.com/jobs/view/{id}. Next:
 *   node basic-validate-pipeline.mjs   (gate)
 *   node resolve-leads.mjs             (swap in the employer's own posting)
 * Never clicks, applies, or contacts anyone.
 */
import { readFileSync } from 'fs';
import { isMainModule } from './lib/is-main-module.mjs';
import { localToday } from './lib/local-today.mjs';

const SOURCE = 'linkedin-assisted';
const normalizeCompany = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** @param {string} text */
export function parseCards(text) {
  const out = [];
  for (const line of text.split('\n')) {
    const [id, title, company, location, ea, done] = line.split('|').map((s) => s?.trim());
    if (!/^\d{6,}$/.test(id || '') || !title || !company) continue;
    out.push({ id, title, company, location: location || '', easyApply: ea === 'EA', applied: done === 'DONE' });
  }
  return out;
}

/**
 * @param {ReturnType<typeof parseCards>} cards
 * @param {{ seenUrl: (u: string) => boolean, seenRole: (c: string, t: string) => boolean, blacklisted: (c: string) => boolean }} f
 */
export function cardsToJobs(cards, f) {
  const stats = { cards: cards.length, applied: 0, duplicate: 0, blacklisted: 0, added: 0 };
  const jobs = [];
  const batch = new Set();
  for (const c of cards) {
    const url = `https://www.linkedin.com/jobs/view/${c.id}`;
    if (c.applied) { stats.applied++; continue; }
    if (f.blacklisted(c.company)) { stats.blacklisted++; continue; }
    const key = `${normalizeCompany(c.company)}|${c.title.toLowerCase()}`;
    if (batch.has(key) || f.seenUrl(url) || f.seenRole(c.company, c.title)) { stats.duplicate++; continue; }
    batch.add(key);
    jobs.push({ title: c.title, company: c.company, location: c.location, url, source: SOURCE, ...(c.easyApply ? { note: 'linkedin-easy-apply' } : {}) });
    stats.added++;
  }
  return { jobs, stats };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) return selfTest();
  const file = args[args.indexOf('--file') + 1];
  if (!file || args.indexOf('--file') < 0) { console.error('usage: node linkedin-ingest.mjs --file cards.txt [--dry-run]'); process.exit(2); }
  const scan = await import('./scan.mjs');
  const snap = scan.loadDedupSnapshot();
  const blacklist = scan.loadBlacklist();
  const { jobs, stats } = cardsToJobs(parseCards(readFileSync(file, 'utf-8')), {
    seenUrl: (u) => snap.seen.has(scan.normalizeUrlForDedup(u)),
    seenRole: (c, t) => snap.seenCompanyRoles.has(scan.companyRoleDedupKey(c, t)),
    blacklisted: (c) => blacklist.has(normalizeCompany(c)),
  });
  console.log(`Cards: ${Object.entries(stats).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  for (const j of jobs) console.log(`  + ${j.company} | ${j.title} | ${j.location || '(no location)'} | ${j.url}`);
  if (args.includes('--dry-run') || !jobs.length) { if (args.includes('--dry-run')) console.log('--dry-run: nothing written.'); return; }
  const today = localToday();
  await scan.appendToPipeline(jobs);
  await scan.appendToScanHistory(jobs, today);
  console.log(`Appended ${jobs.length} row(s) to data/pipeline.md. Next: node basic-validate-pipeline.mjs, then node resolve-leads.mjs.`);
}

function selfTest() {
  let fail = 0;
  const check = (n, ok) => { if (!ok) { fail++; console.log(`  ❌ ${n}`); } };
  const cards = parseCards('4429598586|Senior Engineer|Acme|Bengaluru (Hybrid)|EA|\nbad line\n4429598587|Dev|Foo|Remote||DONE\n4429598588|Dev|IBM|Pune||\n4429598586|Senior Engineer|Acme|Bengaluru (Hybrid)||');
  check('parses 4 valid cards', cards.length === 4);
  const { jobs, stats } = cardsToJobs(cards, { seenUrl: () => false, seenRole: () => false, blacklisted: (c) => normalizeCompany(c) === 'ibm' });
  check('adds one, skips applied/blacklisted/dup', jobs.length === 1 && stats.applied === 1 && stats.blacklisted === 1 && stats.duplicate === 1);
  check('url and Easy Apply note', jobs[0].url.endsWith('/4429598586') && jobs[0].note === 'linkedin-easy-apply');
  console.log(fail ? `${fail} failed` : 'linkedin-ingest self-test: all passed');
  process.exit(fail ? 1 : 0);
}

if (isMainModule(import.meta.url)) main();
