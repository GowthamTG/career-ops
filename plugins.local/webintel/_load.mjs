// @ts-check
// plugins.local/webintel/_load.mjs: how scripts (webintel.mjs, the gate,
// resolve-leads) get a webintel instance. Goes through the plugin engine, so the
// same opt-in toggle (config/plugins.yml), scoped keys (.env), egress allowlist
// and log redaction apply as for the scan-time provider hook.
//
// Returns null when the plugin is disabled or EXA_API_KEY is missing: callers
// then behave exactly as they did before this plugin existed.

import path from 'path';
import { fileURLToPath } from 'url';
import { loadDotenvOnce, loadPlugins } from '../../plugins/_engine.mjs';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { createWebIntel } from './_capabilities.mjs';
import { DEFAULT_SETTINGS } from './_budget.mjs';

export const CODE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * @param {{ caller: string, quiet?: boolean, settings?: object }} opts
 *   settings = per-caller overrides on top of config/plugins.yml; they can only TIGHTEN a cap
 */
export async function loadWebIntel({ caller, quiet = false, settings = {} }) {
  await loadDotenvOnce();
  const [loaded] = await loadPlugins('provider', { root: CODE_ROOT, pluginId: 'webintel' });
  if (!loaded) {
    if (!quiet) console.warn('⚠️  webintel: plugin inactive (enable it in config/plugins.yml and set EXA_API_KEY in .env; see `node plugins.mjs list`).');
    return null;
  }
  return createWebIntel({
    ctx: loaded.ctx,
    settings: tightenOnly(loaded.ctx.settings, settings),
    dataDir: path.join(getCareerOpsRoot(), 'data'),
    caller,
  });
}

/**
 * Merge caller overrides so a CLI flag can lower a cap but never raise it above
 * config/plugins.yml (or the built-in default when the config doesn't set it).
 * @param {Record<string, any>} base
 * @param {Record<string, any>} overrides
 */
export function tightenOnly(base, overrides) {
  const out = { ...base };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue;
    const current = typeof base?.[k] === 'number' ? base[k] : DEFAULT_SETTINGS[k];
    out[k] = typeof current === 'number' ? Math.min(current, v) : v;
  }
  return out;
}
