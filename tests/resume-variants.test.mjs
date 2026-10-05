// tests/resume-variants.test.mjs — the four resume variants stay inside the
// source-of-truth boundary and the JD router picks the obvious variant.
import { readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';
import { pass, fail, ROOT, NODE } from './helpers.mjs';

console.log('\nresume variants (frontend / backend / full stack / agentic AI)');

const cfgPath = join(ROOT, 'config', 'resume-variants.json');
let cfg;
try { cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch { cfg = null; }
if (!cfg) {
  pass('config/resume-variants.json is a user-layer file and is absent here; skipped');
} else {
  const cv = readFileSync(join(ROOT, 'cv.md'), 'utf-8');
  const ids = Object.keys(cfg.variants);
  ids.length === 4 ? pass('four variants defined') : fail(`expected 4 variants, found ${ids.length}`);

  const missingIds = ids.flatMap((id) => Object.values(cfg.variants[id].experience).flat().filter((b) => !cfg.bullets[b]));
  missingIds.length === 0 ? pass('every variant bullet id exists in the pool') : fail(`unknown bullet ids: ${missingIds.join(', ')}`);

  const text = JSON.stringify(cfg);
  /—/.test(text) ? fail('em dash found in config/resume-variants.json') : pass('no em dashes in variant text');

  // Every bullet's plain text (bold and links stripped) must appear verbatim in cv.md,
  // so no number or claim exists in a resume that the source of truth lacks.
  const plain = (t) => t.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\*\*/g, '');
  const cvPlain = cv.replace(/\*\*/g, '');
  const usedIds = new Set(ids.flatMap((id) => Object.values(cfg.variants[id].experience).flat()));
  const absent = [...usedIds].filter((b) => !cvPlain.includes(plain(cfg.bullets[b])));
  absent.length === 0 ? pass('every used bullet appears verbatim in cv.md') : fail(`bullets not in cv.md: ${absent.join(', ')}`);

  const parens = [...usedIds].filter((b) => /\([^)]*\)/.test(plain(cfg.bullets[b])));
  parens.length === 0 ? pass('no bracketed asides inside bullets') : fail(`bullets with parentheses: ${parens.join(', ')}`);

  const labelled = [...usedIds].filter((b) => !/^\*\*[^:*]+: [^*]+\*\*/.test(cfg.bullets[b]));
  labelled.length === 0 ? pass('every bullet follows **Label: bold result** then a by-clause') : fail(`bullets without a bold label and result: ${labelled.join(', ')}`);

  // ATS safety: the only non-ASCII character allowed in the config is the en dash in role dates
  // (it must match cv.md for the title check; the builder renders it as a plain hyphen).
  const odd = [...new Set([...text].filter((ch) => ch.charCodeAt(0) > 127 && ch !== '\u2013'))];
  odd.length === 0 ? pass('resume text is plain ASCII (no multiplication signs, smart quotes or em dashes)') : fail(`non-ASCII characters in config: ${odd.join(' ')}`);

  const projBullets = Object.values(cfg.projects_pool).flatMap((p) => p.bullets || []);
  const projLabelled = projBullets.filter((b) => !/^\*\*[^:*]+: [^*]+\*\*/.test(b));
  projLabelled.length === 0 ? pass('every project bullet follows the bold label and result pattern') : fail(`project bullets without a bold label and result: ${projLabelled.length}`);
  projBullets.some((b) => /\([^)]*\)/.test(b.replace(/\*\*/g, ''))) ? fail('project bullet has a bracketed aside') : pass('no bracketed asides in project bullets');

  const select = (jd, args = []) => JSON.parse(execFileSync(NODE, [join(ROOT, 'resume-variants.mjs'), 'select', '-', '--json', ...args], { input: jd, cwd: ROOT, encoding: 'utf-8' }));
  select('Senior Frontend Engineer\nReact, Next.js, CSS, design system').recommended === 'frontend' ? pass('frontend JD routes to frontend') : fail('frontend JD misrouted');
  select('Backend Engineer\nNode.js microservices, PostgreSQL, Kafka, distributed systems').recommended === 'backend' ? pass('backend JD routes to backend') : fail('backend JD misrouted');
  select('Senior Full Stack Engineer\nReact and Node.js').recommended === 'fullstack' ? pass('full stack JD routes to full stack') : fail('full stack JD misrouted');
  select('AI Engineer\nagentic workflows, LangGraph, RAG, MCP, LLM agents').recommended === 'agentic-ai' ? pass('agentic JD routes to agentic AI') : fail('agentic JD misrouted');
  select('Backend Engineer\nAPIs', ['--fit', '4.6']).tailor_recommended === true ? pass('fit 4.6 recommends a JD-specific resume') : fail('fit 4.6 did not recommend tailoring');
  select('Backend Engineer\nAPIs', ['--fit', '4.0']).tailor_recommended === false ? pass('fit 4.0 keeps the standard variant') : fail('fit 4.0 recommended tailoring');
}
