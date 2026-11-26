import { _electron as electron } from 'playwright';
import fs from 'node:fs';
const EXE = '<REPO>\\apps\\sigma-pc\\dist\\win-unpacked\\SigMa.exe';
const CWD = '<REPO>\\apps\\sigma-pc\\dist\\win-unpacked';
const OUT = '<REPO>\\perf-harness';
const sid = fs.readFileSync(OUT + '\\sid384.txt', 'utf8').trim().split('=')[1];
const ROOM = 'perftestroomZZZ01';
const results = {};
const log = (k, v) => { results[k] = v; console.error('[' + k + ']', JSON.stringify(v)); };

const app = await electron.launch({ executablePath: EXE, args: [], cwd: CWD });
await app.evaluate(async ({ session }, s) => { await session.defaultSession.cookies.set({ url: 'https://sigma-api.example.com', name: 'sigma_ws', value: s, secure: true, httpOnly: true, sameSite: 'no_restriction' }); }, sid);
let page = null;
for (let i = 0; i < 120; i++) { for (const w of app.windows()) { try { if (w.url().startsWith('http://127.0.0.1')) { page = w; break; } } catch {} } if (page) break; await new Promise(r => setTimeout(r, 100)); }
const base = new URL(page.url()).origin;
await page.evaluate(() => localStorage.setItem('sigma_session', JSON.stringify({ userId: '384', agentName: 'Hoài An' })));

async function installPerf() {
  await page.evaluate(() => {
    if (window.__perf) { try { window.__perf.obs.disconnect(); } catch {} }
    const state = { longtasks: [] };
    const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) state.longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) }); });
    try { obs.observe({ entryTypes: ['longtask'] }); } catch {}
    state.obs = obs; window.__perf = state;
  });
}
const resetPerf = () => page.evaluate(() => { if (window.__perf) window.__perf.longtasks = []; });
const getLong = () => page.evaluate(() => (window.__perf ? window.__perf.longtasks : []));

// open room
const t0 = Date.now();
await page.goto(base + '/app/chat/' + ROOM, { waitUntil: 'domcontentloaded' });
await installPerf();
await page.waitForTimeout(2500);

function findScrollSel() {
  return page.evaluate(() => {
    const cands = [...document.querySelectorAll('div')].filter(d => { const s = getComputedStyle(d); return (s.overflowY === 'auto' || s.overflow === 'auto') && d.scrollHeight > d.clientHeight + 20; });
    let best = null; for (const c of cands) { if (!best || c.children.length > best.children.length) best = c; }
    if (!best) return null; best.setAttribute('data-perf-scroll', '1'); return '[data-perf-scroll="1"]';
  });
}
let scSel = await findScrollSel();
log('afterOpen', { tMs: Date.now() - t0, children: await page.evaluate((s) => document.querySelector(s)?.children.length || 0, scSel) });

// Load ALL older by scrolling to top repeatedly
let prev = 0;
for (let i = 0; i < 14; i++) {
  await page.evaluate((s) => { const el = document.querySelector(s); if (el) el.scrollTop = 0; }, scSel);
  await page.waitForTimeout(900);
  const n = await page.evaluate((s) => document.querySelector(s)?.children.length || 0, scSel);
  if (n === prev) break; prev = n;
}
scSel = await findScrollSel();
const domInfo = await page.evaluate((s) => { const el = document.querySelector(s); return { children: el.children.length, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, totalDomNodes: document.querySelectorAll('*').length }; }, scSel);
log('afterLoadAll', domInfo);

// Scroll jank on full list
async function scrollJank(label, dur = 3000) {
  await resetPerf();
  const res = await page.evaluate(async ({ sel, dur }) => {
    const el = document.querySelector(sel); if (!el) return { error: 'no el' };
    const start = performance.now(); let frames = 0, lastTs = start; const gaps = [];
    const maxTop = el.scrollHeight - el.clientHeight;
    return await new Promise((resolve) => {
      function step(ts) { frames++; const gap = ts - lastTs; if (frames > 1) gaps.push(gap); lastTs = ts; const e = ts - start; el.scrollTop = ((Math.sin(e / 350) + 1) / 2) * maxTop; if (e < dur) requestAnimationFrame(step); else fin(ts); }
      function fin(ts) { const total = ts - start; gaps.sort((a, b) => a - b); resolve({ frames, totalMs: Math.round(total), fps: +(frames / (total / 1000)).toFixed(1), p95GapMs: +(gaps[Math.floor(gaps.length * 0.95)] || 0).toFixed(1), maxGapMs: +(gaps[gaps.length - 1] || 0).toFixed(1), jankFrames: gaps.filter(g => g > 24).length }); }
      requestAnimationFrame(step);
    });
  }, { sel: scSel, dur });
  const longs = await getLong();
  res.longtasks = longs.length; res.longtaskMaxMs = longs.reduce((m, t) => Math.max(m, t.dur), 0); res.longtaskSumMs = longs.reduce((s, t) => s + t.dur, 0);
  log('scroll_' + label, res);
}
await scrollJank('full400');
await page.screenshot({ path: OUT + '\\exe-stress-room.png' });

// Typing latency with full list mounted (measures re-render of all bubbles per keystroke)
async function typing() {
  const composer = page.locator('textarea, [contenteditable="true"]').last();
  try { await composer.click({ timeout: 3000 }); } catch (e) { log('typing_full', { error: e.message }); return; }
  await resetPerf();
  const sample = await page.evaluate(async () => {
    const el = document.activeElement; const lat = [];
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
    const text = 'Kiểm tra độ trễ nhập với danh sách 400 tin nhắn 0123456789';
    for (const ch of text) { const t0 = performance.now(); if (el.tagName === 'TEXTAREA') { setter.call(el, el.value + ch); el.dispatchEvent(new Event('input', { bubbles: true })); } await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))); lat.push(performance.now() - t0); }
    lat.sort((a, b) => a - b);
    return { count: lat.length, medianMs: +lat[Math.floor(lat.length / 2)].toFixed(1), p95Ms: +lat[Math.floor(lat.length * 0.95)].toFixed(1), maxMs: +lat[lat.length - 1].toFixed(1) };
  });
  const longs = await getLong();
  sample.longtasks = longs.length; sample.longtaskMaxMs = longs.reduce((m, t) => Math.max(m, t.dur), 0);
  log('typing_full', sample);
}
await typing();

fs.writeFileSync(OUT + '\\exe-stress-results.json', JSON.stringify(results, null, 2));
console.log('DONE');
await app.close();
