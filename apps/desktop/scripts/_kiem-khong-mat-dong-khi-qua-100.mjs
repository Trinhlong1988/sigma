// B180 — [Admin Demo 16/11 "xử lý triệt để đi"] TÁI HIỆN THẬT lỗi mất-dòng-câm trên màn KHÁCH HÀNG.
//
// B179 chỉ lộ ở màn TID vì sổ đã có 114 TID. Các màn khác (Khách hàng 25 · TK nhận 13 · Hồ sơ 0 …) dùng
// ĐÚNG khuôn gọi đó nhưng chưa quá 100 dòng nên chưa ai thấy — bom hẹn giờ. Bài kiểm này KHÔNG suy luận:
// nó BƠM THẬT cho vượt 100 dòng trên DB THỬ rồi mở MÀN THẬT đếm, xong dọn sạch.
//
// CHỈ chạy trên DB THỬ. Fail-closed: thấy đang trỏ sổ thật thì DỪNG, không bơm gì.
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/qua-100-dong-16-11');
mkdirSync(RA, { recursive: true });
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';

if (!/thu|test/i.test(DB_TEN)) {
  console.error('[qua-100] DỪNG: chỉ được chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 7;
const DAU = 'ZKIEM180-';

const truoc = Number((await db.query('SELECT count(*) n FROM customers WHERE deleted_at IS NULL')).rows[0].n);
console.log('      khách đang có:', truoc);
const canThem = Math.max(0, 118 - truoc);
console.log('      sẽ bơm thêm:', canThem, 'khách tạm (xoá sạch ở cuối)');

try {
  for (let i = 0; i < canThem; i++) {
    const ma = DAU + String(i).padStart(3, '0');
    await db.query(
      `INSERT INTO customers (code, full_name, nickname, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'ACTIVE', now(), now()) ON CONFLICT (code) DO NOTHING`,
      [ma, 'Khách kiểm ' + i, 'KIEM' + i]
    );
  }
  const tong = Number((await db.query('SELECT count(*) n FROM customers WHERE deleted_at IS NULL')).rows[0].n);
  console.log('      tổng khách sau khi bơm:', tong);
  chot(tong > 100, 'đã dựng được hơn 100 khách để tái hiện (' + tong + ') — dưới 100 thì bài kiểm vô nghĩa');

  const tho = randomUUID();
  const NHAN = 'kiem-b180';
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
  // Khách hàng nằm trong màn "Doanh Thu - Công Nợ & Tài Chính" (DebtPage) hoặc màn Khách hàng riêng.
  const menu = p.locator('aside button', { hasText: 'Doanh Thu' }).first();
  chot((await menu.count()) > 0, 'thấy mục menu chứa danh sách khách hàng');
  if (await menu.count()) { await menu.click(); await p.waitForTimeout(6000); }

  const cdp = await ctx.newCDPSession(p);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(RA, '01-man-khach-hang.png'), Buffer.from(data, 'base64'));

  // Hỏi THẲNG lớp gọi API trong trang — đây chính là đường màn hình đi.
  const ket = await p.evaluate(async () => {
    // BẪY đã cắn hôm nay: file này là .mjs — CẤM cú pháp TypeScript (`as`), Node không nạp được.
    const r = await window.api.customerList({});
    return { ok: r.ok, soDong: r.data?.length ?? 0, total: r.total ?? null, dayDu: r.dayDu ?? null };
  });
  console.log('      lớp gọi API trong trang trả:', JSON.stringify(ket));
  chot(ket.ok === true, 'gọi được danh sách khách từ trong trang');
  chot(ket.soDong === tong, 'lấy ĐỦ ' + tong + ' khách (' + ket.soDong + ') — hết cảnh cắt ở 100');
  chot(ket.total === tong, 'máy chủ khai đúng tổng (' + ket.total + ')');
  chot(ket.dayDu === true, 'cờ dayDu = true (kéo hết, không chạm trần vòng lặp)');
  chot(loiTrang.length === 0, 'không có lỗi trang (' + (loiTrang[0] ?? 'sạch') + ')');

  await b.close();
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
} finally {
  // DỌN SẠCH — chỉ xoá đúng khách do bài kiểm này tạo.
  const xoa = await db.query('DELETE FROM customers WHERE code LIKE $1', [DAU + '%']);
  const con = Number((await db.query('SELECT count(*) n FROM customers WHERE deleted_at IS NULL')).rows[0].n);
  console.log('      đã dọn', xoa.rowCount, 'khách tạm · còn lại', con, '(ban đầu', truoc + ')');
  if (con !== truoc) {
    console.log('  ĐỎ  dọn KHÔNG sạch: còn ' + con + ' ≠ ban đầu ' + truoc);
    loi.push('don khong sach');
  }
}

console.log('\n[qua-100] ẢNH: ' + RA);
console.log('[qua-100] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[qua-100] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[qua-100] KHÔNG phép kiểm nào đỏ');
await db.end();
if (loi.length) process.exitCode = 1;
