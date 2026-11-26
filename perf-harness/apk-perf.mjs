import fs from 'node:fs';
const OUT = '<REPO>\\perf-harness';
const sid = fs.readFileSync(OUT + '\\sid384.txt', 'utf8').trim().split('=')[1];
const ROOM = 'perftestroomZZZ01';
const DIRECT = 'cmsgkos5e00073wglzczkm8va';
const results = {};
const log = (k, v) => { results[k] = v; console.error('[' + k + ']', JSON.stringify(v)); };

// discover ws url
const list = await (await fetch('http://localhost:9222/json')).json();
const pg = list.find(p => p.type === 'page') || list[0];
const wsUrl = pg.webSocketDebuggerUrl;
console.error('connecting', wsUrl, 'current', pg.url);

const ws = new WebSocket(wsUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map(); const evWaiters = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); }
  else if (d.method) { for (const w of evWaiters) w(d); }
};
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');

// evaluate helper (async, returns JSON)
async function ev(fnBody, argJson = null) {
  const expr = `(async () => { const __arg = ${JSON.stringify(argJson)}; ${fnBody} })()`;
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('EVAL EX: ' + JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
}
async function nav(url) {
  await send('Page.navigate', { url });
  await new Promise(r => setTimeout(r, 200));
}

// set cookie for API domain + localStorage session
await send('Network.setCookie', { name: 'sigma_ws', value: sid, domain: 'sigma-api.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'None', expires: Math.floor(Date.now() / 1000) + 10800 });
// set localStorage on current origin (https://localhost)
await ev(`localStorage.setItem('sigma_session', JSON.stringify({userId:'384',agentName:'Hoài An'})); return 'set';`);

// cold nav to chat
const cs = Date.now();
await nav('https://localhost/app/chat');
// wait for chat list content
let tReady = -1;
for (let i = 0; i < 120; i++) {
  const len = await ev(`return (document.body.innerText||'').length;`).catch(() => 0);
  if (len > 120) { tReady = Date.now() - cs; break; }
  await new Promise(r => setTimeout(r, 100));
}
log('apk_chatlist_ready', { ms: tReady, bodyLen: await ev(`return (document.body.innerText||'').length;`) });

// install perf collector
await ev(`if(window.__perf){try{window.__perf.obs.disconnect()}catch(e){}} const st={longtasks:[]}; try{const o=new PerformanceObserver(l=>{for(const e of l.getEntries())st.longtasks.push({start:Math.round(e.startTime),dur:Math.round(e.duration)})}); o.observe({entryTypes:['longtask']}); st.obs=o;}catch(e){st.err=String(e)} window.__perf=st; return 'perf';`);
const resetPerf = () => ev(`if(window.__perf)window.__perf.longtasks=[]; return 1;`);
const getLong = () => ev(`return window.__perf?window.__perf.longtasks:[];`);

// ---- Tab navigation ----
async function navTab(txt, expect, label) {
  await resetPerf();
  const t0 = Date.now();
  const clicked = await ev(`const bs=[...document.querySelectorAll('button')]; const b=bs.find(x=>((x.querySelector('span')?.textContent)||x.textContent||'').trim().startsWith(__arg)); if(b){b.click();return true} return false;`, txt);
  if (!clicked) { log('apk_nav_' + label, { error: 'btn not found' }); return; }
  let ok = false;
  for (let i = 0; i < 80; i++) { const u = await ev(`return location.pathname;`); if (u.includes(expect)) { ok = true; break; } await new Promise(r => setTimeout(r, 30)); }
  await new Promise(r => setTimeout(r, 450));
  const longs = await getLong();
  const clen = await ev(`return ((document.querySelector('main')||document.body).innerText||'').trim().length;`);
  log('apk_nav_' + label, { ms: Date.now() - t0, urlOk: ok, contentLen: clen, longtasks: longs.length, longtaskMaxMs: longs.reduce((m, t) => Math.max(m, t.dur), 0) });
}
await navTab('Danh bạ', '/app/contacts', 'contacts');
await navTab('Nhật ký', '/app/diary', 'diary');
await navTab('Lịch', '/app/calendar', 'calendar');
await navTab('Cài đặt', '/app/settings', 'settings');
await navTab('Trò chuyện', '/app/chat', 'chat_back');

// ---- Open busy test room (400 msgs) ----
async function openRoom(roomId, label) {
  const t0 = Date.now();
  await nav('https://localhost/app/chat/' + roomId);
  await ev(`if(window.__perf){try{window.__perf.obs.disconnect()}catch(e){}} const st={longtasks:[]}; try{const o=new PerformanceObserver(l=>{for(const e of l.getEntries())st.longtasks.push({start:Math.round(e.startTime),dur:Math.round(e.duration)})}); o.observe({entryTypes:['longtask']}); st.obs=o;}catch(e){} window.__perf=st; return 1;`);
  let tMsg = -1;
  for (let i = 0; i < 200; i++) {
    const cnt = await ev(`const cands=[...document.querySelectorAll('div')].filter(d=>{const s=getComputedStyle(d);return (s.overflowY==='auto')&&d.scrollHeight>d.clientHeight+20}); let b=null; for(const c of cands) if(!b||c.children.length>b.children.length) b=c; return b?b.children.length:0;`);
    if (cnt > 2) { tMsg = Date.now() - t0; break; }
    await new Promise(r => setTimeout(r, 50));
  }
  await new Promise(r => setTimeout(r, 1200));
  const longs = await getLong();
  log('apk_openRoom_' + label, { tToFirstMsgMs: tMsg, longtasks: longs.length, longtaskMaxMs: longs.reduce((m, t) => Math.max(m, t.dur), 0), longtaskSumMs: longs.reduce((s, t) => s + t.dur, 0) });
}
await openRoom(ROOM, 'test400');

// tag scroll container
const scSel = await ev(`const cands=[...document.querySelectorAll('div')].filter(d=>{const s=getComputedStyle(d);return (s.overflowY==='auto')&&d.scrollHeight>d.clientHeight+20}); let b=null; for(const c of cands) if(!b||c.children.length>b.children.length) b=c; if(!b)return null; b.setAttribute('data-ps','1'); return '[data-ps=\\'1\\']';`);
log('apk_scrollSel', { scSel, children: await ev(`return document.querySelector('[data-ps]')?.children.length||0;`) });

// load all older
let prev = 0;
for (let i = 0; i < 16; i++) {
  await ev(`const el=document.querySelector('[data-ps]'); if(el)el.scrollTop=0; return 1;`);
  await new Promise(r => setTimeout(r, 1000));
  const n = await ev(`return document.querySelector('[data-ps]')?.children.length||0;`);
  if (n === prev) break; prev = n;
}
const domInfo = await ev(`const el=document.querySelector('[data-ps]'); return {children:el.children.length,scrollHeight:el.scrollHeight,clientHeight:el.clientHeight,totalDomNodes:document.querySelectorAll('*').length};`);
log('apk_afterLoadAll', domInfo);

// scroll jank
async function scrollJank(label, dur = 3000) {
  await resetPerf();
  const res = await ev(`const el=document.querySelector('[data-ps]'); if(!el)return {error:'no el'}; const start=performance.now(); let frames=0,lastTs=start; const gaps=[]; const maxTop=el.scrollHeight-el.clientHeight; return await new Promise(resolve=>{function step(ts){frames++;const gap=ts-lastTs;if(frames>1)gaps.push(gap);lastTs=ts;const e=ts-start;el.scrollTop=((Math.sin(e/350)+1)/2)*maxTop;if(e<${dur})requestAnimationFrame(step);else fin(ts)} function fin(ts){const total=ts-start;gaps.sort((a,b)=>a-b);resolve({frames,totalMs:Math.round(total),fps:+(frames/(total/1000)).toFixed(1),p95GapMs:+(gaps[Math.floor(gaps.length*0.95)]||0).toFixed(1),maxGapMs:+(gaps[gaps.length-1]||0).toFixed(1),jankFrames:gaps.filter(g=>g>24).length})} requestAnimationFrame(step)});`);
  const longs = await getLong();
  res.longtasks = longs.length; res.longtaskMaxMs = longs.reduce((m, t) => Math.max(m, t.dur), 0); res.longtaskSumMs = longs.reduce((s, t) => s + t.dur, 0);
  log('apk_scroll_' + label, res);
}
await scrollJank('full400');

// typing latency
async function typing() {
  const focused = await ev(`const t=[...document.querySelectorAll('textarea,[contenteditable=\\'true\\']')].pop(); if(!t)return false; t.focus(); return true;`);
  if (!focused) { log('apk_typing', { error: 'no composer' }); return; }
  await resetPerf();
  const sample = await ev(`const el=document.activeElement; const lat=[]; const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')?.set; const text='Kiem tra do tre nhap 0123456789 tren APK'; for(const ch of text){const t0=performance.now(); if(el.tagName==='TEXTAREA'){setter.call(el,el.value+ch);el.dispatchEvent(new Event('input',{bubbles:true}))} await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); lat.push(performance.now()-t0)} lat.sort((a,b)=>a-b); return {count:lat.length,medianMs:+lat[Math.floor(lat.length/2)].toFixed(1),p95Ms:+lat[Math.floor(lat.length*0.95)].toFixed(1),maxMs:+lat[lat.length-1].toFixed(1)};`);
  const longs = await getLong();
  sample.longtasks = longs.length; sample.longtaskMaxMs = longs.reduce((m, t) => Math.max(m, t.dur), 0);
  log('apk_typing_full', sample);
}
await typing();

fs.writeFileSync(OUT + '\\apk-results.json', JSON.stringify(results, null, 2));
console.log('DONE');
ws.close();
