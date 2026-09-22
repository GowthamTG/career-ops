// @ts-check
// plugins.local/webintel/_cache.mjs: file cache under data/.webintel-cache/.
//
// One JSON file per entry, keyed by sha256 of the canonical URL or query, split
// by kind so TTLs and gc stay per-kind:
//   content  (30d)  page text; JD text is stable, and this is never used for liveness
//   search   (per entry min_interval_hours, default 72h)
//   neg      (7d)   dead/blocked/thin URLs, so a charged 403/404 is never paid twice

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import path from 'path';

export const TTL = Object.freeze({
  content: 30 * 24 * 3600 * 1000,
  search: 72 * 3600 * 1000,
  neg: 7 * 24 * 3600 * 1000,
});

/** @param {{ dir: string, now?: () => number }} opts */
export function createCache({ dir, now = () => Date.now() }) {
  /** @param {string} kind @param {string} key */
  const fileFor = (kind, key) => path.join(dir, kind, `${createHash('sha256').update(key).digest('hex')}.json`);

  /**
   * @param {string} kind
   * @param {string} key
   * @param {number} ttlMs
   * @returns {{ value: any, ageMs: number } | null}
   */
  function get(kind, key, ttlMs) {
    const f = fileFor(kind, key);
    if (!existsSync(f)) return null;
    try {
      const entry = JSON.parse(readFileSync(f, 'utf8'));
      const ageMs = now() - entry.at;
      if (entry.key !== key || !(ageMs >= 0) || ageMs > ttlMs) return null;
      return { value: entry.value, ageMs };
    } catch {
      return null;
    }
  }

  /** @param {string} kind @param {string} key @param {any} value */
  function put(kind, key, value) {
    const f = fileFor(kind, key);
    mkdirSync(path.dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ key, at: now(), value }));
    renameSync(tmp, f);
  }

  /** Delete entries older than their kind's TTL. @param {Record<string, number>} [ttls] */
  function gc(ttls = TTL) {
    let removed = 0;
    for (const [kind, ttl] of Object.entries(ttls)) {
      const d = path.join(dir, kind);
      if (!existsSync(d)) continue;
      for (const name of readdirSync(d)) {
        const f = path.join(d, name);
        try {
          const at = JSON.parse(readFileSync(f, 'utf8')).at;
          if (!(now() - at <= ttl)) { rmSync(f); removed++; }
        } catch {
          // Unreadable or half-written: drop it only if it's old by mtime.
          if (now() - statSync(f).mtimeMs > ttl) { rmSync(f, { force: true }); removed++; }
        }
      }
    }
    return removed;
  }

  return { get, put, gc, dir };
}
