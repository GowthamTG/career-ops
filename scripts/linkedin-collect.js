// Run in the page context of a logged-in LinkedIn jobs search tab (Chrome MCP javascript_tool).
// Reads the visible result list the way a person scrolls it. No LinkedIn API calls, no clicks, no applying.
// LinkedIn only hydrates cards that PAINT: scripted scrollBy leaves ~7 of 25 cards empty. Take a screenshot to
// force a paint, then scroll the list with real mouse-wheel ticks (computer scroll x3-4 at the list) BEFORE running this.
// Reuse the filter below to drop misfit titles in-page so little text comes back.
// Returns one line per card: id|title|company|location|EA?|DONE?
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const seen = new Map();
  const read = () => {
    for (const c of document.querySelectorAll('li[data-occludable-job-id]')) {
      const a = c.querySelector('a.job-card-container__link');
      const t = (a?.getAttribute('aria-label') || a?.innerText || '').split('\n')[0].replace(' with verification', '').trim();
      if (!t) continue;
      seen.set(c.dataset.occludableJobId, [
        c.dataset.occludableJobId, t.slice(0, 80),
        (c.querySelector('.artdeco-entity-lockup__subtitle')?.innerText || '').trim().slice(0, 40),
        (c.querySelector('.artdeco-entity-lockup__caption')?.innerText || '').trim().slice(0, 50),
        /Easy Apply/.test(c.innerText) ? 'EA' : '', /Applied/.test(c.innerText) ? 'DONE' : '',
      ].join('|'));
    }
  };
  const list = document.querySelector('.jobs-search-results-list') || document.scrollingElement;
  for (let i = 0; i < 14; i++) { read(); list.scrollBy(0, 700); await sleep(450); }
  read();
  return [...seen.values()].join('\n');
})()
