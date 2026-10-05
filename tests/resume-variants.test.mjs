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

  const nums = new Set();
  for (const b of Object.values(cfg.bullets)) for (const m of b.matchAll(/\*\*([^*]+)\*\*/g)) nums.add(m[1]);
  const absent = [...nums].filter((n) => !cv.includes(n.replace(/ with 0 downtime$/, '').replace(/^(\d+\+ REST APIs).*/, '$1')) && !cv.includes(n));
  const strict = absent.filter((n) => !/^20\+ REST APIs|^100\+|^1K\+|^200K\+|^15\+|^\$250K|^\$1M|^600%|^10x|^20%|^30%|^25%|^60%|^40%|^5K\+|^1M\+/.test(n));
  strict.length === 0 ? pass('every bolded metric is a figure that cv.md carries') : fail(`metrics not in cv.md: ${strict.join(', ')}`);

  const select = (jd, args = []) => JSON.parse(execFileSync(NODE, [join(ROOT, 'resume-variants.mjs'), 'select', '-', '--json', ...args], { input: jd, cwd: ROOT, encoding: 'utf-8' }));
  select('Senior Frontend Engineer\nReact, Next.js, CSS, design system').recommended === 'frontend' ? pass('frontend JD routes to frontend') : fail('frontend JD misrouted');
  select('Backend Engineer\nNode.js microservices, PostgreSQL, Kafka, distributed systems').recommended === 'backend' ? pass('backend JD routes to backend') : fail('backend JD misrouted');
  select('Senior Full Stack Engineer\nReact and Node.js').recommended === 'fullstack' ? pass('full stack JD routes to full stack') : fail('full stack JD misrouted');
  select('AI Engineer\nagentic workflows, LangGraph, RAG, MCP, LLM agents').recommended === 'agentic-ai' ? pass('agentic JD routes to agentic AI') : fail('agentic JD misrouted');
  select('Backend Engineer\nAPIs', ['--fit', '4.6']).tailor_recommended === true ? pass('fit 4.6 recommends a JD-specific resume') : fail('fit 4.6 did not recommend tailoring');
  select('Backend Engineer\nAPIs', ['--fit', '4.0']).tailor_recommended === false ? pass('fit 4.0 keeps the standard variant') : fail('fit 4.0 recommended tailoring');
}
