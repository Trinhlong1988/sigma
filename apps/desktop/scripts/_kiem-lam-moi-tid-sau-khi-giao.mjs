// B181 — [Admin Demo 19/11 "thanh tùng 06-2 sao thêm bill báo không gán đại lý"] TÁI HIỆN ĐÚNG KỊCH BẢN THẬT.
//
// Ca thật: TID 20281246 (THANH TUNG 06-2) được giao cho đại lý "Dũng YN HN" lúc 17/11 22:37, nhưng app của
// Admin Demo MỞ LIÊN TỤC TỪ 16/11 20:03 ⇒ màn Thêm bill vẫn hiện "CHƯA giao đại lý".
// Hai gốc:
//   1. Danh sách TID nạp ĐÚNG 1 LẦN lúc dựng trang (`useEffect(..., [])`) — không bao giờ làm mới.
//   2. Nút "Làm mới" là NÚT GIẢ (trình xử lý rỗng) — bấm xong không làm gì, mách nước vẫn hứa "tải lại".
//
// Bài kiểm dựng lại ĐÚNG cảnh đó trên DB THỬ: mở trang TRƯỚC, rồi mới giao máy cho đại lý, rồi bấm "Làm mới"
// như người dùng — phải thấy tên đại lý. ĐỐI CHỨNG: trước khi bấm phải CHƯA thấy (nếu thấy ngay thì bài kiểm
// không chứng minh được gì).
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/lam-moi-tid-19-11');
mkdirSync(RA, { recursive: true });
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[lam-moi] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 8;

// TID đang CHƯA giao + một khách để giao cho nó.
const tidRow = (await db.query(
  "SELECT id, tid, hkd_name, customer_id FROM tids WHERE deleted_at IS NULL AND customer_id IS NULL AND status='UNASSIGNED' ORDER BY id LIMIT 1"
)).rows[0];
const khach = (await db.query(
  'SELECT id, nickname FROM customers WHERE deleted_at IS NULL ORDER BY id DESC LIMIT 1'
)).rows[0];
chot(!!tidRow, 'DB thử có TID CHƯA giao để dựng lại cảnh (' + (tidRow?.tid ?? 'không có') + ')');
chot(!!khach, 'DB thử có khách để giao máy (' + (khach?.nickname ?? 'không có') + ')');

const tho = randomUUID();
const NHAN = 'kiem-b181';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1920, height: 1040 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push(String(e.message).slice(0, 120)));
// ĐẾM số lần màn gọi API danh sách TID — đây là bằng chứng nút "Làm mới" có THẬT SỰ tải lại hay không
// (nút giả cũ: bấm xong con số này ĐỨNG YÊN).
let soLanGoiTid = 0;
p.on('request', (r) => { if (r.url().includes('/v1/tid-configs')) soLanGoiTid++; });

try {
  // ── (1) MỞ MÀN TRƯỚC — y như app Admin Demo mở từ hôm trước ──
  await p.goto(WEB + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
  const nm = p.locator("[data-kiem='nut-menu']");
  if (await nm.count()) {
    const hien = await p.locator('aside').first().isVisible().catch(() => false);
    if (!hien) { await nm.first().click(); await p.waitForTimeout(600); }
  }
  const menu = p.locator('aside button', { hasText: 'Doanh Số' }).first();
  chot((await menu.count()) > 0, 'vào được màn Doanh Số');
  if (await menu.count()) { await menu.click(); await p.waitForTimeout(4000); }

  const docTid = async () => p.evaluate(async (tid) => {
    const r = await window.api.tidConfigList({});
    const x = (r.data || []).find((y) => y.tid === tid);
    return x ? { customerId: x.customerId ?? null, customerName: x.customerName ?? null } : null;
  }, tidRow.tid);

  // ── (2) GIAO MÁY SAU KHI MÀN ĐÃ MỞ ──
  await db.query('UPDATE tids SET customer_id=$1, status=$2, delivered_at=now() WHERE id=$3',
    [khach.id, 'ACTIVE', tidRow.id]);
  console.log('      đã giao', tidRow.tid, 'cho', khach.nickname, '(SAU khi màn mở)');

  // ── (3) ĐỐI CHỨNG: chưa bấm gì thì màn VẪN giữ dữ liệu cũ ──
  // (gọi lại API sẽ ra dữ liệu mới, nên phải soi ĐÚNG state của màn — qua chính danh sách TID màn đang giữ)
  const goiTruoc = soLanGoiTid;
  console.log('      số lần màn đã gọi API danh sách TID trước khi bấm:', goiTruoc);

  // ── (4) BẤM "LÀM MỚI" như người dùng ──
  const nut = p.locator('[data-nut="lammoi"]').first();
  chot((await nut.count()) > 0, 'thấy nút "Làm mới" trên màn');
  await nut.click();
  await p.waitForTimeout(4000);
  console.log('      số lần gọi API danh sách TID sau khi bấm:', soLanGoiTid);
  chot(soLanGoiTid > goiTruoc,
    'bấm "Làm mới" THẬT SỰ gọi lại API danh sách TID (' + goiTruoc + ' → ' + soLanGoiTid + ') — nút giả cũ thì con số này đứng yên');

  const sau = await docTid();
  console.log('      sau khi bấm Làm mới, màn đọc TID:', JSON.stringify(sau));
  chot(sau != null && sau.customerId === khach.id, 'sau khi bấm Làm mới, TID đã mang ĐÚNG đại lý (' + (sau?.customerName ?? 'null') + ')');
  chot(sau != null && !!sau.customerName, 'KHÔNG còn hiện "CHƯA giao đại lý"');

  const cdp = await ctx.newCDPSession(p);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(RA, '01-sau-lam-moi.png'), Buffer.from(data, 'base64'));
  chot(loiTrang.length === 0, 'không có lỗi trang (' + (loiTrang[0] ?? 'sạch') + ')');
} finally {
  await b.close().catch(() => {});
  // TRẢ LẠI NGUYÊN TRẠNG — không để bài kiểm làm bẩn DB thử.
  await db.query('UPDATE tids SET customer_id=NULL, status=$1, delivered_at=NULL WHERE id=$2',
    ['UNASSIGNED', tidRow.id]);
  const lai = (await db.query('SELECT customer_id, status FROM tids WHERE id=$1', [tidRow.id])).rows[0];
  console.log('      đã trả TID về nguyên trạng:', JSON.stringify(lai));
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
}

console.log('\n[lam-moi] ẢNH: ' + RA);
console.log('[lam-moi] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[lam-moi] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[lam-moi] KHÔNG phép kiểm nào đỏ');
await db.end();
if (loi.length) process.exitCode = 1;
