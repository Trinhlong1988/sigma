#!/usr/bin/env node
// SIGMA — TỰ CUỘN ZALO tải media cũ (Admin Demo 25/8 "thêm cơ chế tự cuộn chuột"). Điều khiển Zalo PC qua CDP
// (cần Zalo mở kèm --remote-debugging-port=9222 — do watchdog SigMa_ZaloKeepAlive đảm bảo). Mở 1 hội thoại
// theo TỪ KHOÁ tên (gõ vào #contact-search-input) rồi cuộn khung tin nhắn lên nhiều lần → Zalo tải ảnh lịch sử →
// zalo-watcher nhặt vào ingest. Dùng: node src/scroll-zalo.mjs "<từ khoá tên nhóm>" [số_lần_cuộn]
//        node src/scroll-zalo.mjs --list           (liệt kê tên hội thoại đang thấy)
const PORT = process.env.ZALO_CDP_PORT || 9222;
const arg = process.argv[2];
const SCROLLS = Number(process.argv[3]) || 25;

async function cdp() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pg = list.find((t) => t.type === 'page' && t.title === 'Zalo');
  if (!pg) throw new Error('Không thấy page Zalo (Zalo đã mở kèm --remote-debugging-port=' + PORT + ' chưa?)');
  const ws = new WebSocket(pg.webSocketDebuggerUrl);
  let id = 0; const pending = {};
  ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending[m.id]) { pending[m.id](m); delete pending[m.id]; } };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const send = (method, params) => new Promise((res) => { const i = ++id; pending[i] = res; ws.send(JSON.stringify({ id: i, method, params })); });
  await send('Runtime.enable', {});
  const ev = async (expr) => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return r.result?.result?.value; };
  return { ws, ev };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { ws, ev } = await cdp();

if (arg === '--list') {
  const names = await ev(`JSON.stringify([...document.querySelectorAll('[class*=conv]')].map(e=>(e.innerText||'').replace(/\\n+/g,' ').trim()).filter(t=>t.length>1).slice(0,60))`);
  console.log(names);
  ws.close();
  process.exit(0);
}

if (!arg) { console.error('Thiếu từ khoá tên nhóm. Dùng: node src/scroll-zalo.mjs "<tên>" [số cuộn]'); ws.close(); process.exit(1); }

// 1) gõ từ khoá vào ô tìm kiếm
await ev(`(()=>{const i=document.querySelector('#contact-search-input');if(!i)return false;i.focus();const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;set.call(i,${JSON.stringify(arg)});i.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
await sleep(1500);
// 2) click hội thoại đầu tiên khớp
const opened = await ev(`(()=>{const items=[...document.querySelectorAll('[class*=conv]')].filter(e=>(e.innerText||'').toLowerCase().includes(${JSON.stringify(arg.toLowerCase())}));const el=items.find(e=>e.offsetHeight>20);if(!el)return null;el.click();return (el.innerText||'').replace(/\\n+/g,' ').trim().slice(0,40);})()`);
console.log('Mở hội thoại:', opened ?? '(KHÔNG khớp — thử --list xem tên)');
if (!opened) { ws.close(); process.exit(2); }
await sleep(2500);
// 3) khung cuộn tin nhắn = phần tử cuộn được, KHÔNG chứa ô search (loại danh sách hội thoại), diện tích lớn nhất.
//    Cuộn LÊN từng bước nhỏ + phát WheelEvent/scroll để Zalo lazy-load lịch sử + tải ảnh vào tầm nhìn (chờ đủ lâu).
const pickJs = `(()=>{const cs=[...document.querySelectorAll('*')].filter(e=>e.scrollHeight>e.clientHeight+100&&e.clientHeight>250&&!e.querySelector('#contact-search-input'));const c=cs.sort((a,b)=>(b.clientHeight*b.scrollWidth)-(a.clientHeight*a.scrollWidth))[0];if(!c)return null;window.__zc=c;return {sh:c.scrollHeight,ch:c.clientHeight,top:c.scrollTop};})()`;
let last = await ev(pickJs);
console.log('khung cuộn:', JSON.stringify(last));
for (let k = 0; k < SCROLLS; k++) {
  await ev(`(()=>{const c=window.__zc;if(!c)return;c.scrollBy(0,-Math.max(300,c.clientHeight*0.8));c.dispatchEvent(new Event('scroll',{bubbles:true}));c.dispatchEvent(new WheelEvent('wheel',{deltaY:-500,bubbles:true}));return c.scrollTop;})()`);
  await sleep(1600); // lazy-load + tải ảnh cần thời gian
  if (k % 5 === 4) { const s = await ev(`(window.__zc?window.__zc.scrollTop:-1)`); console.log(`  cuộn ${k + 1}/${SCROLLS} scrollTop=${s}`); }
}
console.log(`Đã cuộn ${SCROLLS} lần. Zalo đang tải ảnh (nếu có) — watcher nhặt trong ~20s.`);
ws.close();
