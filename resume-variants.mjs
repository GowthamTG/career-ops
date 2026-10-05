#!/usr/bin/env node
/**
 * resume-variants.mjs — four role-specific resumes (frontend, backend,
 * full stack, agentic AI) built from config/resume-variants.json, plus a
 * zero-LLM router that picks the best variant for a job description.
 *
 *   node resume-variants.mjs build [all|frontend|backend|fullstack|agentic-ai]
 *   node resume-variants.mjs select <jd.txt|-> [--title "Role title"] [--fit 4.6] [--json]
 *   node resume-variants.mjs list
 *
 * build  : payload -> build-cv-html -> cv-title-check -> verify-cv-facts
 *          (hard gate) -> generate-pdf -> verify-ats. PDFs land in output/ as
 *          "<pdf_prefix><Label>.pdf" from the config (undated, safe to upload).
 * select : scores the JD against each variant's signal lexicon, recommends one,
 *          lists JD terms the chosen resume does not contain, and says whether
 *          a JD-specific resume is worth generating (--fit >= 4.5, or very
 *          strong routing signal). Never submits or uploads anything.
 */

import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { getCareerOpsRoot } from './path-resolver.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const DATA = getCareerOpsRoot();
const CONFIG = join(DATA, 'config', 'resume-variants.json');
const OUT = join(DATA, 'output');
const WORK = join(OUT, 'resume-variants');
const FIT_THRESHOLD = 4.5;

if (!existsSync(CONFIG)) {
  console.error(`❌ ${CONFIG} not found. It is a user-layer file (your bullet pool and variant definitions); create it from your cv.md before running this.`);
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(CONFIG, 'utf-8'));

function die(msg) {
  console.error(`❌ ${msg}`);
  process.exit(1);
}

function run(script, args, { allowFail = false } = {}) {
  const r = spawnSync('node', [join(ROOT, script), ...args], { cwd: ROOT, encoding: 'utf-8' });
  if (r.status !== 0 && !allowFail) {
    die(`${script} failed:\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}

function profile() {
  // Minimal read of the few profile.yml scalars we need (no YAML dependency).
  const y = readFileSync(join(DATA, 'config', 'profile.yml'), 'utf-8');
  const get = (key) => (y.match(new RegExp(`^\\s*${key}:\\s*"([^"]*)"`, 'm')) || [])[1] || '';
  return {
    name: get('full_name'),
    email: get('email'),
    phone: get('phone'),
    location: get('location'),
    linkedin: get('linkedin'),
    github: get('github'),
  };
}

function buildPayload(id) {
  const v = cfg.variants[id];
  if (!v) die(`unknown variant "${id}". Known: ${Object.keys(cfg.variants).join(', ')}`);
  const p = profile();
  const bullet = (bid) => {
    if (!cfg.bullets[bid]) die(`variant ${id}: unknown bullet id "${bid}"`);
    return cfg.bullets[bid];
  };
  const experience = ['lyric', 'devrev', 'intern'].map((key) => ({
    ...cfg.roles[key],
    bullets: v.experience[key].map(bullet),
  }));
  const pick = (pool, ids, what) =>
    ids.map((k) => {
      if (!pool[k]) die(`variant ${id}: unknown ${what} "${k}"`);
      return pool[k];
    });
  return {
    lang: 'en',
    page_format: cfg.page_format,
    candidate: {
      name: p.name,
      title: v.headline,
      phone: p.phone,
      email: p.email,
      ...(p.linkedin ? { linkedin: { url: `https://www.${p.linkedin.replace(/^https?:\/\/(www\.)?/, '')}`, display: p.linkedin.replace(/^https?:\/\/(www\.)?/, '') } } : {}),
      ...(p.github ? { github: { url: `https://${p.github.replace(/^https?:\/\//, '')}`, display: p.github.replace(/^https?:\/\//, '') } } : {}),
      location: p.location,
    },
    summary: v.summary,
    competencies: v.competencies,
    experience,
    projects: v.projects.map((k) => {
      const { bullets, ...rest } = pick(cfg.projects_pool, [k], 'project')[0];
      const keep = v.project_bullets?.[k];
      const chosen = bullets ? (keep ? keep.map((i) => bullets[i]) : bullets) : null;
      return chosen ? { ...rest, description: chosen.join('\u241e') } : rest;
    }),
    education: cfg.education,
    certifications: cfg.certifications,
    awards: pick(cfg.awards_pool, v.awards, 'award'),
    skills: v.skills.map(([category, items]) => ({ category, items })),
  };
}

function build(id) {
  const v = cfg.variants[id];
  mkdirSync(WORK, { recursive: true });
  const jsonPath = join(WORK, `${id}.json`);
  const htmlPath = join(WORK, `${id}.html`);
  const pdfPath = join(OUT, `${cfg.pdf_prefix}${v.label}.pdf`);
  writeFileSync(jsonPath, JSON.stringify(buildPayload(id), null, 2));

  const template = run('cv-templates.mjs', ['resolve', 'cv']).stdout.trim();
  run('build-cv-html.mjs', [jsonPath, htmlPath, template]);
  // project bullets: split the sentinel-joined description into a real <ul>, with bold labels, and set a plain title
  writeFileSync(htmlPath, readFileSync(htmlPath, 'utf-8')
    .replace(/<div class="project-desc">([^<]*?)<\/div>/g, (m, body) => {
      if (!body.includes('\u241e')) return m;
      const li = body.split('\u241e').map((b) => `<li>${b.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')}</li>`).join('');
      return `<ul class="project-bullets">${li}</ul>`;
    })
    .replace('</style>', '  .project-bullets { padding-left: 18px; margin-top: 4px; }\n  .project-bullets li { font-size: 10.5px; line-height: 1.6; color: #333; margin-bottom: 3px; }\n  .project-bullets li strong { font-weight: 600; }\n  </style>')
    .replace(/<title>[^<]*<\/title>/, '<title>Gowtham T G Resume</title>'));
  // contact row on one line: tighter gaps and no wrapping so "Bangalore, India" does not drop to a second line
  writeFileSync(htmlPath, readFileSync(htmlPath, 'utf-8').replace('</style>', '  .contact-row { flex-wrap: nowrap; gap: 4px 7px; font-size: 9.6px; white-space: nowrap; }\n  </style>'));
  // pool links: turn [text](https://url) in bullets into real anchors (builder has no link syntax)
  writeFileSync(htmlPath, readFileSync(htmlPath, 'utf-8').replace(/\[([^\]]+)\]\((https:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>'));
  // One skills category per line: the template's flex-wrap row lets short
  // categories run together in text extraction ("... MCP Cloud: AWS, GCP").
  writeFileSync(htmlPath, readFileSync(htmlPath, 'utf-8').replace(
    /\.skills-grid\s*\{[^}]*\}\s*\.skill-item\s*\{([^}]*)\}/,
    '.skills-grid { display: block; }\n  .skill-item { $1 display: block; margin-bottom: 2px; }'));

  const titles = run('cv-title-check.mjs', [jsonPath, '--summary'], { allowFail: true });
  const structure = run('verify-cv-structure.mjs', [jsonPath], { allowFail: true });

  const facts = run('verify-cv-facts.mjs', [htmlPath], { allowFail: true });
  if (facts.status !== 0) die(`fact gate FAILED for ${id}; PDF not rendered.\n${facts.stdout}\n${facts.stderr}`);

  const pdf = run('generate-pdf.mjs', [htmlPath, pdfPath, `--format=${cfg.page_format}`, '--max-pages=2'], { allowFail: true });
  if (pdf.status !== 0) die(`PDF render failed for ${id}:\n${pdf.stdout}\n${pdf.stderr}`);
  const pages = (readFileSync(pdfPath, 'latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;

  const ats = run('verify-ats.mjs', [htmlPath, '--keywords', v.keywords.join(','), '--json'], { allowFail: true });
  let score = '?', grade = '?', cov = '?', missing = [], issues = [];
  try {
    const j = JSON.parse(ats.stdout);
    score = j.score; grade = j.grade;
    cov = j.keywordCoverage?.percent; missing = j.keywordCoverage?.missing || [];
    issues = (j.issues || []).map((i) => i.message || String(i));
  } catch { /* leave placeholders */ }

  if (id === cfg.default_variant && cfg.default_alias) {
    copyFileSync(pdfPath, join(OUT, `${cfg.default_alias}.pdf`));
  }
  return { id, pdf: pdfPath, pages, score, grade, keywordCoverage: cov, missingKeywords: missing, issues, titleCheck: titles.stdout.trim().split('\n')[0], structure: structure.stdout.trim().split('\n')[0] };
}

function stripTags(html) {
  return html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&');
}

function scoreJd(jd, title) {
  const scores = {};
  const hits = {};
  for (const [id, terms] of Object.entries(cfg.signals)) {
    if (id.startsWith('_')) continue;
    let s = 0;
    hits[id] = [];
    for (const [src, w] of terms) {
      const re = new RegExp(src, 'gi');
      const n = Math.min((jd.match(re) || []).length, 3);
      const t = title && new RegExp(src, 'i').test(title) ? 4 * w : 0;
      if (n || t) {
        s += n * w + t;
        hits[id].push(src);
      }
    }
    scores[id] = s;
  }
  return { scores, hits };
}

function select(file, opts) {
  const jd = file === '-' ? readFileSync(0, 'utf-8') : readFileSync(file, 'utf-8');
  const title = opts.title || (jd.split('\n').find((l) => l.trim()) || '').slice(0, 160);
  const { scores, hits } = scoreJd(jd, title);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  let [best, top] = ranked[0];
  const second = ranked[1];
  if (top === 0) best = cfg.default_variant;
  // Full stack wins when the JD asks for both halves, or says so in the title.
  const fe = scores.frontend, be = scores.backend;
  if (best !== 'agentic-ai' && fe > 0 && be > 0 && Math.min(fe, be) / Math.max(fe, be) >= 0.6) best = 'fullstack';
  if (best !== 'agentic-ai' && /full[- ]?stack/i.test(title)) best = 'fullstack';
  const margin = top === 0 ? 0 : (top - second[1]) / top;

  const v = cfg.variants[best];
  const pdf = join(OUT, `${cfg.pdf_prefix}${v.label}.pdf`);
  const htmlPath = join(WORK, `${best}.html`);
  let missing = [];
  if (existsSync(htmlPath)) {
    const text = stripTags(readFileSync(htmlPath, 'utf-8')).toLowerCase();
    missing = (hits[best] || [])
      .filter((src) => !new RegExp(src, 'i').test(text))
      .map((src) => src.replace(/\\b|\\\(|\)|\[-\s\]\??|\?|\.\{[^}]*\}/g, ' ').split('|')[0].replace(/\s+/g, ' ').trim())
      .slice(0, 12);
  }
  const fit = opts.fit != null ? Number(opts.fit) : null;
  const tailor = fit != null ? fit >= FIT_THRESHOLD : false;
  const result = {
    recommended: best,
    label: v.label,
    resume_pdf: pdf,
    resume_exists: existsSync(pdf),
    scores,
    margin: Number(margin.toFixed(2)),
    title_used: title,
    jd_terms_not_in_resume: missing,
    tailor_recommended: tailor,
    tailor_reason: fit == null
      ? `pass --fit <score> from the evaluation; a JD-specific resume is worth it at ${FIT_THRESHOLD}/5 or higher`
      : tailor ? `fit ${fit}/5 >= ${FIT_THRESHOLD}: generate a JD-specific resume from the ${v.label} variant (pdf mode)` : `fit ${fit}/5 < ${FIT_THRESHOLD}: attach the ${v.label} variant as is`,
    note: top === 0 ? 'No routing signal found in the JD; defaulted to the full stack resume. Read the JD yourself.' : undefined,
  };
  if (opts.json) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`Recommended resume: ${v.label}  (${pdf}${result.resume_exists ? '' : ', NOT BUILT YET: run build all'})`);
    console.log(`Scores: ${ranked.map(([k, s]) => `${k}=${s}`).join('  ')}  margin=${result.margin}`);
    if (missing.length) console.log(`JD terms not found in that resume: ${missing.join(', ')}`);
    console.log(result.tailor_reason);
    if (result.note) console.log(result.note);
  }
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const flag = (n) => { const i = rest.indexOf(n); return i >= 0 ? rest[i + 1] : undefined; };
  if (cmd === 'list') {
    for (const [id, v] of Object.entries(cfg.variants)) console.log(`${id.padEnd(10)} ${v.label.padEnd(11)} ${v.headline}`);
    return;
  }
  if (cmd === 'build') {
    const which = rest[0] && !rest[0].startsWith('--') ? rest[0] : 'all';
    const ids = which === 'all' ? Object.keys(cfg.variants) : [which];
    const results = ids.map(build);
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  if (cmd === 'select') {
    if (!rest[0]) die('usage: node resume-variants.mjs select <jd.txt|-> [--title "..."] [--fit 4.6] [--json]');
    select(rest[0], { title: flag('--title'), fit: flag('--fit'), json: rest.includes('--json') });
    return;
  }
  console.log('usage: node resume-variants.mjs build [all|<variant>] | select <jd.txt|-> [--title T] [--fit N] [--json] | list');
}

main();
