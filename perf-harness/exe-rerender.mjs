import { _electron as electron } from 'playwright';
import fs from 'node:fs';
const EXE = '<REPO>\\apps\\sigma-pc\\dist\\win-unpacked\\SigMa.exe';
const CWD = '<REPO>\\apps\\sigma-pc\\dist\\win-unpacked';
const OUT = '<REPO>\\perf-harness';
const sid = fs.readFileSync(OUT + '\\sid384.txt', 'utf8').trim().split('=')[1];
const ROOM = 'perftestroomZZZ01';
const log = (k, v) => console.error('[' + k + ']', JSON.stringify(v));
const app = await electron.launch({ executablePath: EXE, args: [], cwd: CWD });
await app.evaluate(async ({ session }, s) => { await session.defaultSession.cookies.set({ url: 'https://sigma-api.example.com', name: 'sigma_ws', value: s, secure: true, httpOnly: true, sameSite: 'no_restriction' }); }, sid);
let page = null;
for (let i = 0; i < 120; i++) { for (const w of app.windows()) { try { if (w.url().startsWith('http://127.0.0.1')) { page = w; break; } } catch {} } if (page) break; await new Promise(r => setTimeout(r, 100)); }
const base = new URL(page.url()).origin;
await page.evaluate(() => localStorage.setItem('sigma_session', JSON.stringify({ userId: '384', agentName: 'Hoài An' })));
await page.goto(base + '/app/chat/' + ROOM, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);
const sel = await page.evaluate(() => { const cands = [...document.querySelectorAll('div')].filter(d => { const s = getComputedStyle(d); return (s.overflowY === 'auto') && d.scrollHeight > d.clientHeight + 20; }); let b = null; for (const c of cands) if (!b || c.children.length > b.children.length) b = c; if (!b) return null; b.setAttribute('data-ps', '1'); return '[data-ps="1"]'; });
let prev = 0;
for (let i = 0; i < 14; i++) { await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.scrollTop = 0; }, sel); await page.waitForTimeout(850); const n = await page.evaluate((s) => document.querySelector(s)?.children.length || 0, sel); if (n === prev) break; prev = n; }
const n = await page.evaluate((s) => document.querySelector(s)?.children.length || 0, sel);
log('mounted', { bubbles: n });

// Measure parent re-render cost: install longtask observer, then dispatch contextmenu on a middle bubble.
const res = await page.evaluate(async ({ s }) => {
  const el = document.querySelector(s);
  // scroll to middle so a bubble is visible
  el.scrollTop = el.scrollHeight / 2;
  await new Promise(r => setTimeout(r, 300));
  const longs = [];
  const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push(Math.round(e.duration)); });
  obs.observe({ entryTypes: ['longtask'] });
  // find a visible bubble (a child near middle) and dispatch contextmenu
  const kids = [...el.children];
  const mid = kids[Math.floor(kids.length / 2)];
  const target = mid.querySelector('*') || mid;
  const rect = target.getBoundingClientRect();
  const t0 = performance.now();
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + 5, clientY: rect.y + 5, button: 2 }));
  // wait for menu to appear + commit
  await new Promise(r => setTimeout(r, 500));
  const t1 = performance.now();
  obs.disconnect();
  const menuOpen = !!document.querySelector('[role="menu"], [class*="context"]');
  return { dispatchToSettleMs: Math.round(t1 - t0), longtasks: longs.length, longtaskMaxMs: longs.reduce((m, x) => Math.max(m, x), 0), longtaskSumMs: longs.reduce((a, b) => a + b, 0), menuOpen };
}, { s: sel });
log('contextmenu_rerender_400', res);

// Also measure: enter select mode (parent state change re-rendering all bubbles) via first bubble long-press sim
const res2 = await page.evaluate(async ({ s }) => {
  const el = document.querySelector(s);
  const longs = []; const obs = new PerformanceObserver((l) => { for (const e of l.getEntries()) longs.push(Math.round(e.duration)); }); obs.observe({ entryTypes: ['longtask'] });
  // toggle via React: find any checkbox/select trigger not reliable; instead measure a forced reflow re-render by changing scrollTop rapidly is not parent state.
  // Measure cost of a genuine setState: click header to open info panel (showInfo) which re-renders screen.
  const t0 = performance.now();
  const hdrBtn = [...document.querySelectorAll('button')].find(b => /thông tin|info|thành viên/i.test(b.getAttribute('aria-label') || b.title || b.textContent || ''));
  if (hdrBtn) hdrBtn.click();
  await new Promise(r => setTimeout(r, 500));
  obs.disconnect();
  return { hadHeaderBtn: !!hdrBtn, settleMs: Math.round(performance.now() - t0), longtasks: longs.length, longtaskMaxMs: longs.reduce((m, x) => Math.max(m, x), 0) };
}, { s: sel });
log('infopanel_rerender_400', res2);
console.log('DONE');
await app.close();
