import { _electron as electron } from 'playwright';
import fs from 'node:fs';

const EXE = '<REPO>\\apps\\sigma-pc\\dist\\win-unpacked\\SigMa.exe';
const CWD = '<REPO>\\apps\\sigma-pc\\dist\\win-unpacked';
const OUT = '<REPO>\\perf-harness';
const sid = fs.readFileSync(OUT + '\\sid384.txt', 'utf8').trim().split('=')[1];
const DIRECT_ROOM = 'cmsgkos5e00073wglzczkm8va';
const GROUP_ROOM = 'cmsgkiyyx00003wglceqjkksw';
const results = {};
const log = (k, v) => { results[k] = v; console.error('[' + k + ']', JSON.stringify(v)); };

const app = await electron.launch({ executablePath: EXE, args: [], cwd: CWD });
await app.evaluate(async ({ session }, s) => {
  await session.defaultSession.cookies.set({ url: 'https://sigma-api.example.com', name: 'sigma_ws', value: s, secure: true, httpOnly: true, sameSite: 'no_restriction' });
}, sid);

// get main window
let page = null;
for (let i = 0; i < 120; i++) {
  for (const w of app.windows()) { try { if (w.url().startsWith('http://127.0.0.1')) { page = w; break; } } catch {} }
  if (page) break; await new Promise(r => setTimeout(r, 100));
}
const base = new URL(page.url()).origin;
await page.evaluate(() => localStorage.setItem('sigma_session', JSON.stringify({ userId: '384', agentName: 'Hoài An' })));
await page.goto(base + '/app/chat', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

// Install a persistent perf collector
async function installPerf() {
  await page.evaluate(() => {
    if (window.__perf) { try { window.__perf.obs.disconnect(); } catch {} }
    const state = { longtasks: [], marks: {} };
    const obs = new PerformanceObserver((list) => { for (const e of list.getEntries()) state.longtasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) }); });
    try { obs.observe({ entryTypes: ['longtask'] }); } catch {}
    state.obs = obs;
    window.__perf = state;
  });
}
async function resetPerf() { await page.evaluate(() => { if (window.__perf) window.__perf.longtasks = []; }); }
async function getLong(sinceMs) { return await page.evaluate((s) => (window.__perf ? window.__perf.longtasks.filter(t => t.start >= s) : []), sinceMs); }

// Measure a scroll test: programmatically scroll a container, count frames via rAF, collect longtasks
async function scrollJank(selector, label, durationMs = 2500) {
  await resetPerf();
  const res = await page.evaluate(async ({ sel, dur }) => {
    const el = document.querySelector(sel);
    if (!el) return { error: 'no element ' + sel };
    const start = performance.now();
    let frames = 0; let lastTs = start; const gaps = [];
    const maxTop = el.scrollHeight - el.clientHeight;
    return await new Promise((resolve) => {
      function step(ts) {
        frames++;
        const gap = ts - lastTs; if (frames > 1) gaps.push(gap); lastTs = ts;
        const elapsed = ts - start;
        // oscillate scroll position
        const p = (Math.sin(elapsed / 300) + 1) / 2; // 0..1
        el.scrollTop = p * maxTop;
        if (elapsed < dur) requestAnimationFrame(step); else finish(ts);
      }
      function finish(ts) {
        const total = ts - start;
        gaps.sort((a, b) => a - b);
        const fps = frames / (total / 1000);
        const p95 = gaps.length ? gaps[Math.floor(gaps.length * 0.95)] : 0;
        const maxGap = gaps.length ? gaps[gaps.length - 1] : 0;
        const jankFrames = gaps.filter(g => g > 24).length; // >~1.5 frame @60hz
        resolve({ frames, totalMs: Math.round(total), fps: +fps.toFixed(1), p95GapMs: +p95.toFixed(1), maxGapMs: +maxGap.toFixed(1), jankFrames, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight });
      }
      requestAnimationFrame(step);
    });
  }, { sel: selector, dur: durationMs });
  const longs = await getLong(0);
  res.longtasks = longs.length; res.longtaskMaxMs = longs.reduce((m, t) => Math.max(m, t.dur), 0); res.longtaskSumMs = longs.reduce((s, t) => s + t.dur, 0);
  log('scroll_' + label, res);
  return res;
}

await installPerf();

// ---- 1. Tab navigation timing (click sidebar) ----
async function navClick(linkText, expectPath, label) {
  await resetPerf();
  const t0 = Date.now();
  // sidebar items are <button> with a <span> label; click via evaluate for robustness
  const clicked = await page.evaluate((txt) => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find(x => (x.querySelector('span')?.textContent || '').trim().startsWith(txt) || x.textContent.trim().startsWith(txt));
    if (b) { b.click(); return true; } return false;
  }, linkText);
  if (!clicked) { log('nav_' + label, { error: 'button not found: ' + linkText }); return; }
  // wait until url path matches
  let ok = false;
  for (let i = 0; i < 80; i++) { if (page.url().includes(expectPath)) { ok = true; break; } await page.waitForTimeout(25); }
  // wait until some content painted (body text length stabilizes) - simple settle
  await page.waitForTimeout(400);
  const dt = Date.now() - t0;
  const longs = await getLong(0);
  const blank = await page.evaluate(() => {
    const main = document.querySelector('main') || document.body;
    return { text: (main.innerText || '').trim().length };
  });
  log('nav_' + label, { ms: dt, urlOk: ok, url: page.url(), contentLen: blank.text, longtasks: longs.length, longtaskMaxMs: longs.reduce((m, t) => Math.max(m, t.dur), 0) });
}

await navClick('Danh bạ', '/app/contacts', 'contacts');
await navClick('Nhật ký', '/app/diary', 'diary');
await navClick('Lịch', '/app/calendar', 'calendar');
await navClick('Cài đặt', '/app/settings', 'settings');
await navClick('Báo cáo', '/app/kpi', 'kpi');
await navClick('Trò chuyện', '/app/chat', 'chat_back');

// ---- 2. Open busy DIRECT room: time to messages ----
async function openRoom(roomId, label) {
  await resetPerf();
  const t0 = Date.now();
  await page.goto(base + '/app/chat/' + roomId, { waitUntil: 'domcontentloaded' });
  await installPerf();
  // wait for at least one chat bubble to appear
  let tMsg = -1;
  for (let i = 0; i < 160; i++) {
    const n = await page.evaluate(() => document.querySelectorAll('[data-message-id], .chat-bubble, [class*="rounded"][class*="px"]').length);
    const hasScroll = await page.evaluate(() => !!document.querySelector('div[class*="overflow-auto"]'));
    // better: count elements inside scroll container
    const cnt = await page.evaluate(() => {
      const sc = [...document.querySelectorAll('div')].find(d => d.className && d.className.includes && d.scrollHeight > d.clientHeight && d.querySelector && d.children.length > 3);
      return sc ? sc.children.length : 0;
    });
    if (cnt > 2) { tMsg = Date.now() - t0; break; }
    await page.waitForTimeout(50);
  }
  await page.waitForTimeout(1200);
  const longs = await getLong(0);
  const info = await page.evaluate(() => {
    // find the message scroll container: overflow-auto with many children
    const cands = [...document.querySelectorAll('div')].filter(d => { const s = getComputedStyle(d); return (s.overflowY === 'auto' || s.overflow === 'auto') && d.scrollHeight > d.clientHeight + 20; });
    let best = null; for (const c of cands) { if (!best || c.children.length > best.children.length) best = c; }
    return { msgCount: best ? best.children.length : 0, scrollHeight: best ? best.scrollHeight : 0, clientHeight: best ? best.clientHeight : 0, imgs: document.querySelectorAll('img').length };
  });
  log('openRoom_' + label, { tToFirstMsgMs: tMsg, msgDomChildren: info.msgCount, scrollHeight: info.scrollHeight, imgs: info.imgs, longtasks: longs.length, longtaskMaxMs: longs.reduce((m, t) => Math.max(m, t.dur), 0), longtaskSumMs: longs.reduce((s, t) => s + t.dur, 0) });
  await page.screenshot({ path: OUT + '\\exe-room-' + label + '.png' });
  return info;
}

const roomInfo = await openRoom(DIRECT_ROOM, 'direct');

// find the message scroll container selector for scroll test
const scSel = await page.evaluate(() => {
  const cands = [...document.querySelectorAll('div')].filter(d => { const s = getComputedStyle(d); return (s.overflowY === 'auto' || s.overflow === 'auto') && d.scrollHeight > d.clientHeight + 20; });
  let best = null; for (const c of cands) { if (!best || c.children.length > best.children.length) best = c; }
  if (!best) return null;
  best.setAttribute('data-perf-scroll', '1');
  return '[data-perf-scroll="1"]';
});
log('scrollContainerFound', { scSel, msgChildren: roomInfo.msgCount });

// ---- 3. Scroll jank on message list ----
if (scSel) {
  // First load older messages by scrolling to top a few times to build a long list
  await page.evaluate((sel) => { const el = document.querySelector(sel); el.scrollTop = 0; }, scSel);
  await page.waitForTimeout(1500);
  await page.evaluate((sel) => { const el = document.querySelector(sel); el.scrollTop = 0; }, scSel);
  await page.waitForTimeout(1500);
  const afterLoad = await page.evaluate((sel) => { const el = document.querySelector(sel); return { children: el.children.length, scrollHeight: el.scrollHeight }; }, scSel);
  log('afterLoadOlder', afterLoad);
  await scrollJank(scSel, 'messages_direct', 3000);
}

// ---- 4. Typing latency in composer ----
async function typingLatency() {
  const composer = page.locator('textarea, [contenteditable="true"], input[type="text"]').last();
  try { await composer.click({ timeout: 3000 }); } catch (e) { log('typing', { error: 'no composer ' + e.message }); return; }
  await resetPerf();
  // measure input event -> paint via requestAnimationFrame after each key
  const sample = await page.evaluate(async () => {
    const el = document.activeElement;
    if (!el) return { error: 'no active el' };
    const lat = [];
    const text = 'Kiểm tra độ trễ nhập liệu SigMa 1234567890';
    for (const ch of text) {
      const t0 = performance.now();
      // simulate typing by setting value + dispatch input (React controlled)
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set || Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') { setter.call(el, el.value + ch); el.dispatchEvent(new Event('input', { bubbles: true })); }
      else { el.textContent += ch; el.dispatchEvent(new Event('input', { bubbles: true })); }
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
      lat.push(performance.now() - t0);
    }
    lat.sort((a, b) => a - b);
    return { count: lat.length, medianMs: +lat[Math.floor(lat.length / 2)].toFixed(1), p95Ms: +lat[Math.floor(lat.length * 0.95)].toFixed(1), maxMs: +lat[lat.length - 1].toFixed(1) };
  });
  const longs = await getLong(0);
  sample.longtasks = longs.length; sample.longtaskMaxMs = longs.reduce((m, t) => Math.max(m, t.dur), 0);
  log('typing_direct', sample);
}
await typingLatency();

// ---- 5. Chat list scroll + open modals ----
await page.goto(base + '/app/chat', { waitUntil: 'domcontentloaded' });
await installPerf();
await page.waitForTimeout(1500);
// open "Tạo nhóm chat" modal
async function modalOpen(btnText, label) {
  await resetPerf();
  const t0 = Date.now();
  try { await page.locator('button', { hasText: new RegExp(btnText, 'i') }).first().click({ timeout: 3000 }); }
  catch (e) { log('modal_' + label, { error: e.message }); return; }
  // wait for a dialog/overlay
  for (let i = 0; i < 60; i++) { const has = await page.evaluate(() => !!document.querySelector('[role="dialog"], .fixed.inset-0, [class*="modal"]')); if (has) break; await page.waitForTimeout(25); }
  await page.waitForTimeout(300);
  const dt = Date.now() - t0;
  const longs = await getLong(0);
  log('modal_' + label, { ms: dt, longtasks: longs.length, longtaskMaxMs: longs.reduce((m, t) => Math.max(m, t.dur), 0) });
  await page.screenshot({ path: OUT + '\\exe-modal-' + label + '.png' });
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(300);
}
await modalOpen('Tạo nhóm', 'creategroup');
await modalOpen('Phân loại', 'classify');

// search latency
async function searchLatency() {
  const box = page.locator('input[placeholder*="Tìm"], input[placeholder*="tìm"], input[type="search"]').first();
  try { await box.click({ timeout: 3000 }); } catch (e) { log('search', { error: e.message }); return; }
  await resetPerf();
  const t0 = Date.now();
  await box.type('Demo', { delay: 40 });
  await page.waitForTimeout(600);
  const longs = await getLong(0);
  log('search_chatlist', { ms: Date.now() - t0, longtasks: longs.length, longtaskMaxMs: longs.reduce((m, t) => Math.max(m, t.dur), 0) });
}
await searchLatency();

fs.writeFileSync(OUT + '\\exe-results.json', JSON.stringify(results, null, 2));
console.log('DONE');
await app.close();
