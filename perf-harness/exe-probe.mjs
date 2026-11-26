import { _electron as electron } from 'playwright';
import fs from 'node:fs';

const EXE = '<REPO>\\apps\\sigma-pc\\dist\\win-unpacked\\SigMa.exe';
const CWD = '<REPO>\\apps\\sigma-pc\\dist\\win-unpacked';
const OUT = '<REPO>\\perf-harness';
const sid = fs.readFileSync(OUT + '\\sid384.txt', 'utf8').trim().split('=')[1];

const t0 = Date.now();
const app = await electron.launch({ executablePath: EXE, args: [], cwd: CWD });
const tLaunch = Date.now() - t0;

// Set cookie on API domain in default session (httpOnly)
await app.evaluate(async ({ session }, s) => {
  await session.defaultSession.cookies.set({
    url: 'https://sigma-api.example.com', name: 'sigma_ws', value: s,
    secure: true, httpOnly: true, sameSite: 'no_restriction'
  });
}, sid);

// Wait for the main app window (not splash). Poll windows; main window title 'SigMa' and has body.
const tWaitStart = Date.now();
let page = null;
for (let i = 0; i < 120; i++) {
  const wins = app.windows();
  for (const w of wins) {
    try {
      const u = w.url();
      if (u.startsWith('http://127.0.0.1')) { page = w; break; }
    } catch {}
  }
  if (page) break;
  await new Promise(r => setTimeout(r, 100));
}
const tMainWin = Date.now() - t0;
if (!page) { console.log(JSON.stringify({ error: 'no main window', tLaunch })); await app.close(); process.exit(1); }

const rendererUrl = page.url();

// Set localStorage session then reload via goto (avoid reload timeout)
await page.evaluate((s) => {
  localStorage.setItem('sigma_session', JSON.stringify({ userId: '384', agentName: 'Hoài An' }));
}, sid);

// Measure: time until app shell (post-login) visible. Reload to apply session.
const tReload0 = Date.now();
await page.goto(rendererUrl, { waitUntil: 'domcontentloaded' });
const tDom = Date.now() - tReload0;

// Wait for network idle-ish and capture first meaningful paint markers
await page.waitForTimeout(3500);

const nav = await page.evaluate(() => {
  const n = performance.getEntriesByType('navigation')[0] || {};
  const paints = performance.getEntriesByType('paint').map(p => ({ name: p.name, t: Math.round(p.startTime) }));
  return {
    domContentLoaded: Math.round(n.domContentLoadedEventEnd || 0),
    loadEvent: Math.round(n.loadEventEnd || 0),
    responseEnd: Math.round(n.responseEnd || 0),
    paints,
    bodyText: (document.body.innerText || '').slice(0, 300),
    href: location.href,
    resourceCount: performance.getEntriesByType('resource').length
  };
});

await page.screenshot({ path: OUT + '\\exe-01-after-session.png' });

console.log(JSON.stringify({ tLaunch, tMainWin, rendererUrl, tDom, nav }, null, 2));

// keep app open? close for this probe
await app.close();
