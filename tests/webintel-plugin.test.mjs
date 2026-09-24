// Runs the user-layer webintel plugin's own node:test suite
// (plugins.local/webintel/test/*.test.mjs) from test-all.mjs, which only
// discovers tests/**. Skipped when the plugin is not installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'fs';
import { spawnSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'plugins.local', 'webintel', 'test');

test('webintel plugin suite', { skip: !existsSync(DIR) && 'plugins.local/webintel not installed' }, () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.test.mjs')).map((f) => path.join(DIR, f));
  const env = { ...process.env };
  delete env.CAREER_OPS_ROOT; // the suite points it at temp dirs itself
  const r = spawnSync(process.execPath, ['--test', ...files], { cwd: ROOT, encoding: 'utf8', env });
  assert.equal(r.status, 0, `${r.stdout.slice(-3000)}\n${r.stderr.slice(-2000)}`);
});
