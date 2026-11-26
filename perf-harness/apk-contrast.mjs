import fs from 'node:fs';
const OUT = '<REPO>\\perf-harness';
const sid = fs.readFileSync(OUT + '\\sid384.txt', 'utf8').trim().split('=')[1];
const DIRECT = 'cmsgkos5e00073wglzczkm8va'; // 28 msgs
const log = (k, v) => console.error('[' + k + ']', JSON.stringify(v));
const list = await (await fetch('http://localhost:9222/json')).json();
const pg = list.find(p => p.type === 'page') || list[0];
const ws = new WebSocket(pg.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let msgId = 0; const pending = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { const { res, rej } = pending.get(d.id); pending.delete(d.id); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); } };
const send = (method, params = {}) => new Promise((res, rej) => { const id = ++msgId; pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
await send('Runtime.enable'); await send('Page.enable'); await send('Network.enable');
async function ev(body, arg = null) { const expr = `(async () => { const __arg = ${JSON.stringify(arg)}; ${body} })()`; const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error('EX ' + JSON.stringify(r.exceptionDetails).slice(0, 300)); return r.result.value; }
async function nav(url) { await send('Page.navigate', { url }); await new Promise(r => setTimeout(r, 200)); }
await send('Network.setCookie', { name: 'sigma_ws', value: sid, domain: 'sigma-api.example.com', path: '/', secure: true, httpOnly: true, sameSite: 'None', expires: Math.floor(Date.now() / 1000) + 10800 });

const t0 = Date.now();
await nav('https://localhost/app/chat/' + DIRECT);
await ev(`if(window.__perf){try{window.__perf.obs.disconnect()}catch(e){}} const st={longtasks:[]}; try{const o=new PerformanceObserver(l=>{for(const e of l.getEntries())st.longtasks.push({dur:Math.round(e.duration)})}); o.observe({entryTypes:['longtask']}); st.obs=o;}catch(e){} window.__perf=st; return 1;`);
let tMsg = -1;
for (let i = 0; i < 200; i++) { const cnt = await ev(`const c=[...document.querySelectorAll('div')].filter(d=>getComputedStyle(d).overflowY==='auto'&&d.scrollHeight>d.clientHeight+20); let b=null;for(const x of c)if(!b||x.children.length>b.children.length)b=x; return b?b.children.length:0;`); if (cnt > 2) { tMsg = Date.now() - t0; break; } await new Promise(r => setTimeout(r, 50)); }
await new Promise(r => setTimeout(r, 1000));
await ev(`const c=[...document.querySelectorAll('div')].filter(d=>getComputedStyle(d).overflowY==='auto'&&d.scrollHeight>d.clientHeight+20); let b=null;for(const x of c)if(!b||x.children.length>b.children.length)b=x; if(b)b.setAttribute('data-ps','1'); return 1;`);
const info = await ev(`const el=document.querySelector('[data-ps]'); return {children:el?el.children.length:0,scrollHeight:el?el.scrollHeight:0,totalDomNodes:document.querySelectorAll('*').length};`);
log('apk_small_open', { tToFirstMsgMs: tMsg, ...info });
// scroll jank
const resetPerf = () => ev(`if(window.__perf)window.__perf.longtasks=[]; return 1;`);
const getLong = () => ev(`return window.__perf?window.__perf.longtasks:[];`);
await resetPerf();
const res = await ev(`const el=document.querySelector('[data-ps]'); if(!el)return {error:'no el'}; const start=performance.now(); let frames=0,lastTs=start; const gaps=[]; const maxTop=el.scrollHeight-el.clientHeight; return await new Promise(resolve=>{function step(ts){frames++;const gap=ts-lastTs;if(frames>1)gaps.push(gap);lastTs=ts;const e=ts-start;el.scrollTop=((Math.sin(e/350)+1)/2)*maxTop;if(e<3000)requestAnimationFrame(step);else fin(ts)} function fin(ts){const total=ts-start;gaps.sort((a,b)=>a-b);resolve({frames,totalMs:Math.round(total),fps:+(frames/(total/1000)).toFixed(1),p95GapMs:+(gaps[Math.floor(gaps.length*0.95)]||0).toFixed(1),maxGapMs:+(gaps[gaps.length-1]||0).toFixed(1),jankFrames:gaps.filter(g=>g>24).length})} requestAnimationFrame(step)});`);
const longs = await getLong();
res.longtasks = longs.length; res.longtaskSumMs = longs.reduce((s, t) => s + t.dur, 0);
log('apk_small_scroll28', res);
// typing in small room
await ev(`const t=[...document.querySelectorAll('textarea,[contenteditable=\\'true\\']')].pop(); if(t)t.focus(); return !!t;`);
await resetPerf();
const ty = await ev(`const el=document.activeElement; const lat=[]; const setter=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')?.set; for(const ch of 'Kiem tra typing phong nho 012345'){const t0=performance.now(); if(el.tagName==='TEXTAREA'){setter.call(el,el.value+ch);el.dispatchEvent(new Event('input',{bubbles:true}))} await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); lat.push(performance.now()-t0)} lat.sort((a,b)=>a-b); return {count:lat.length,medianMs:+lat[Math.floor(lat.length/2)].toFixed(1),maxMs:+lat[lat.length-1].toFixed(1)};`);
const longs2 = await getLong();
ty.longtasks = longs2.length;
log('apk_small_typing', ty);
console.log('DONE');
ws.close();
