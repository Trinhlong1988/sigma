// B179 — [Admin Demo 16/11 "sao danh sách tid không có Xuân Đoàn?"] MÀN QUẢN LÝ TID CẮT MẤT TID, KHÔNG BÁO GÌ.
//
// Gốc: `TidPage` gọi `tidList` KHÔNG truyền phân trang ⇒ máy chủ trả `pageSize` mặc định 100; màn lại KHÔNG
// có phân trang và vẫn đếm/thống kê như thể đã đủ ⇒ sổ 114 TID thì 14 TID biến mất (gồm 3 TID HKD DEMO 51).
// Kiểu `ListResult` còn KHÔNG khai `total` nên màn hình không có cách nào biết mình bị cắt.
//
// Kiểm 2 tầng: (1) API — chứng minh mặc định cắt ở 100 và trang đầy đủ trả đúng tổng; (2) MÀN THẬT — đếm dòng
// bảng neo theo tiêu đề cột, khẳng định có mặt từng TID mà sổ có. ĐỐI CHỨNG: so với SỐ ĐẾM ĐỘC LẬP từ DB.
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/danh-sach-tid-du-16-11');
mkdirSync(RA, { recursive: true });
const API = process.env.API_KIEM || 'http://127.0.0.1:8790';
const WEB = process.env.WEB_KIEM || 'http://127.0.0.1:57913';
const DB_TEN = process.env.CHUP_DB || '';

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
if (DB_TEN) u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 9;

// SỐ ĐẾM ĐỘC LẬP từ sổ — không hỏi API, không hỏi màn.
const tongSo = Number((await db.query('SELECT count(*) n FROM tids WHERE deleted_at IS NULL')).rows[0].n);
console.log('      TID còn sống trên sổ:', tongSo);
chot(tongSo > 100, 'sổ có HƠN 100 TID — dưới ngưỡng này thì bài kiểm không phát hiện được việc cắt (' + tongSo + ')');

const tho = randomUUID();
const NHAN = 'kiem-b179';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1' };

// ── TẦNG 1: API ──
const mac = await (await fetch(API + '/v1/tids', { headers: H })).json();
const dsMac = mac.data ?? [];
console.log('      /v1/tids (không truyền phân trang):', dsMac.length, 'dòng · total máy chủ khai:', mac.total);
chot(mac.total === tongSo, 'máy chủ khai ĐÚNG tổng số TID (' + mac.total + ' vs sổ ' + tongSo + ')');
chot(dsMac.length < tongSo, 'ĐỐI CHỨNG GỐC LỖI: gọi không phân trang thì BỊ CẮT (' + dsMac.length + '/' + tongSo + ')');

const het = await (await fetch(API + '/v1/tids?page=1&pageSize=500', { headers: H })).json();
const dsHet = het.data ?? [];
chot(dsHet.length === tongSo, 'gọi có phân trang thì lấy ĐỦ (' + dsHet.length + '/' + tongSo + ')');

// ── TẦNG 2: MÀN THẬT ──
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1920, height: 1040 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push('pageerror: ' + e.message));
await p.goto(WEB + '/', { waitUntil: 'networkidle' });
await p.waitForTimeout(3000);
  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
const nm = p.locator("[data-kiem='nut-menu']");
if (await nm.count()) {
  const hien = await p.locator('aside').first().isVisible().catch(() => false);
  if (!hien) { await nm.first().click(); await p.waitForTimeout(600); }
}
const menu = p.locator('aside button', { hasText: 'Quản Lý TID' }).first();
chot((await menu.count()) > 0, 'thấy mục menu "Quản Lý TID"');
if (await menu.count()) { await menu.click(); await p.waitForTimeout(6000); }

const cdp = await ctx.newCDPSession(p);
const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
writeFileSync(resolve(RA, '01-danh-sach-tid.png'), Buffer.from(data, 'base64'));

// Đọc cột TID NEO THEO TIÊU ĐỀ (cấm selector chung chung — bài học 16/11).
const tren = await p.evaluate(() => {
  for (const tb of document.querySelectorAll('table')) {
    const th = [...tb.querySelectorAll('thead th')].map((x) => (x.textContent ?? '').trim());
    const i = th.indexOf('TID');
    if (i < 0) continue;
    const ra = [];
    for (const tr of tb.querySelectorAll('tbody tr')) {
      const td = tr.querySelectorAll('td');
      if (td.length !== th.length) continue;
      ra.push((td[i].textContent ?? '').trim());
    }
    if (ra.length) return ra;
  }
  return [];
});
console.log('      màn thật hiện:', tren.length, 'dòng TID');
chot(tren.length === tongSo, 'MÀN THẬT hiện ĐỦ ' + tongSo + ' TID (' + tren.length + ')');

// Từng TID của sổ phải có mặt — không chỉ đếm số lượng.
const soTid = (await db.query('SELECT tid FROM tids WHERE deleted_at IS NULL ORDER BY tid')).rows.map((r) => r.tid);
const thieu = soTid.filter((x) => !tren.includes(x));
console.log('      TID có trên sổ mà KHÔNG thấy trên màn:', thieu.length, thieu.slice(0, 8).join(', '));
chot(thieu.length === 0, 'KHÔNG TID nào của sổ bị thiếu trên màn (' + thieu.length + ')');

// Chính 3 TID Admin Demo hỏi.
const xd = soTid.filter((x) => x.startsWith('5993'));
const xdTren = xd.filter((x) => tren.includes(x));
console.log('      TID "KHACH HANG 61" trên sổ:', xd.join(', '), '· thấy trên màn:', xdTren.join(', ') || 'KHÔNG');
chot(xd.length > 0 && xdTren.length === xd.length, 'thấy đủ TID HKD DEMO 51 trên màn (' + xdTren.length + '/' + xd.length + ')');
chot(loiTrang.length === 0, 'không có lỗi trang (' + (loiTrang[0] ?? 'sạch') + ')');

console.log('\n[b179] ẢNH: ' + RA);
console.log('[b179] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[b179] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[b179] KHÔNG phép kiểm nào đỏ');

await b.close();
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
await db.end();
if (loi.length) process.exitCode = 1;
