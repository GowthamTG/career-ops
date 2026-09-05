#!/usr/bin/env node
/**
 * naukri-login.mjs — one-time interactive login for naukri-auto-apply.mjs.
 *
 * Opens a real, visible Chromium window pointed at Naukri's login page and
 * waits for you to sign in by hand (password, OTP, whatever you normally
 * use). Once you land on your Naukri homepage, the session is saved to
 * data/.naukri-session/ (gitignored, machine-local) and every future
 * naukri-auto-apply.mjs run reuses it headlessly — no password is ever
 * read, typed, or stored by this script.
 *
 * Run again whenever naukri-auto-apply.mjs reports the session expired.
 *
 * Usage: node naukri-login.mjs
 */

import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { getCareerOpsRoot } from './path-resolver.mjs';

const ROOT = getCareerOpsRoot();
const SESSION_DIR = join(ROOT, 'data', '.naukri-session');
const STORAGE_STATE = join(SESSION_DIR, 'state.json');

mkdirSync(SESSION_DIR, { recursive: true });

console.log('Opening Chromium for a one-time interactive Naukri login...');
console.log('Log in normally (password / OTP / whatever you use), then wait —');
console.log('this script detects the login and saves the session automatically.\n');

// channel: 'chrome' (real Chrome, not bundled Chromium) + hiding the
// automation flag matter here: Google's OAuth login actively detects and
// blocks Playwright's default automated-browser fingerprint ("this browser
// or app may not be secure"). This doesn't make the browser undetectable in
// general — it just stops Google's login flow specifically from refusing to
// proceed for a real, human-driven, one-time login.
const browser = await chromium.launch({
  headless: false,
  channel: 'chrome',
  args: ['--disable-blink-features=AutomationControlled'],
});
const context = await browser.newContext({ viewport: null });
const page = await context.newPage();
await page.goto('https://www.naukri.com/nlogin/login');

// Poll for a URL that only appears once logged in (homepage/dashboard),
// rather than asking the user to press Enter in the terminal.
const deadline = Date.now() + 5 * 60 * 1000; // 5 minutes to log in
let loggedIn = false;
while (Date.now() < deadline) {
  const url = page.url();
  if (/naukri\.com\/mnjuser\/(homepage|recommendedjobs)/.test(url)) {
    loggedIn = true;
    break;
  }
  await page.waitForTimeout(2000);
}

if (!loggedIn) {
  console.error('\nTimed out waiting for login (5 min). Run this script again when ready.');
  await browser.close();
  process.exit(1);
}

await context.storageState({ path: STORAGE_STATE });
console.log(`\nLogged in — session saved to ${STORAGE_STATE}`);
console.log('You can now run: node naukri-auto-apply.mjs --dry-run --headed --limit 3');
await browser.close();
