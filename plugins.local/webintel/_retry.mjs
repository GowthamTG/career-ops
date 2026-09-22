// @ts-check
// plugins.local/webintel/_retry.mjs: small, bounded retry. Single-user CLI, so
// no circuit-breaker service: 429 retries twice (2s, 8s + jitter), timeouts and
// 5xx retry once after 3s, and everything else (402, 401, 4xx, malformed)
// fails immediately. A 402 in particular must never be retried: it only means
// the free credit is gone.
//
// Note: the plugin engine's guarded fetch throws on non-2xx and does not expose
// response headers, so Retry-After can't be honored here; the fixed backoff
// sits inside both providers' published limits (Exa 10 QPS, Firecrawl 10/min).

import { CODES, classifyHttpError } from './_errors.mjs';

/** @param {number} ms */
const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ provider: string, sleep?: (ms: number) => Promise<void>, random?: () => number, onRetry?: (code: string) => void }} opts
 * @returns {Promise<T>}
 */
export async function withRetry(fn, { provider, sleep = realSleep, random = Math.random, onRetry = () => {} }) {
  let rateLimited = 0;
  let transient = 0;
  for (;;) {
    try {
      return await fn();
    } catch (raw) {
      const err = classifyHttpError(raw, provider);
      if (err.code === CODES.RATE_LIMITED && rateLimited < 2) {
        onRetry(err.code);
        await sleep(2000 * 4 ** rateLimited + Math.floor(random() * 500));
        rateLimited++;
        continue;
      }
      if ((err.code === CODES.TIMEOUT || err.code === CODES.UPSTREAM_5XX) && transient < 1) {
        onRetry(err.code);
        await sleep(3000);
        transient++;
        continue;
      }
      throw err;
    }
  }
}
