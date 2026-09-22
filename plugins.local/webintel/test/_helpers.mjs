// Shared test helpers: temp data dirs, fixtures, a fake plugin ctx. No network.
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const fixture = (name) => JSON.parse(readFileSync(path.join(HERE, 'fixtures', name), 'utf8'));
export const tempDir = () => mkdtempSync(path.join(tmpdir(), 'webintel-test-'));

/** A clock tests can move. */
export function clock(start = Date.parse('2026-09-22T10:00:00Z')) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

/**
 * Fake engine ctx. `routes` maps an endpoint suffix ('/search', '/contents',
 * '/v2/scrape', '/v2/team/credit-usage') to (body) => json, or throws an
 * error with .status to simulate an HTTP failure.
 */
export function fakeCtx(routes, env = { EXA_API_KEY: 'exa-test-key', FIRECRAWL_API_KEY: 'fc-test-key' }) {
  const calls = [];
  return {
    env,
    settings: {},
    calls,
    async fetchJson(url, opts = {}) {
      const u = new URL(url);
      const body = opts.body ? JSON.parse(opts.body) : null;
      calls.push({ path: u.pathname, body, headers: opts.headers });
      const handler = routes[u.pathname];
      if (!handler) throw Object.assign(new Error(`HTTP 404: no route ${u.pathname}`), { status: 404 });
      return handler(body);
    },
  };
}

export const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

/** Deps that keep capabilities offline and instant. */
export function offlineDeps(extra = {}) {
  return {
    resolve: async () => ['93.184.216.34'],
    atsFetch: async () => null,
    sleep: async () => {},
    ...extra,
  };
}
