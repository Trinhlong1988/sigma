// "TOÀN BỘ BUTTON LÀM SẠCH TRONG TỪNG MÀN" — cổng đo bất biến (Admin Demo 13/11).
//
// Bất biến: trong vùng nội dung, MỌI nút đang hiện đều phải
//   1. KHÔNG ảnh nền gradient (background-image = none)
//   2. KHÔNG quầng sáng / bóng to — chỉ được phép bóng nổi nhẹ "0px 2px 0px" hoặc không bóng
//   3. bo góc ≤ 3,4px
//   4. không bị cắt cụt chữ
// Đếm số phép kiểm ĐỘNG. Chạy được trên BẢN WEB (mặc định) hoặc BẢN EXE (CDP_EXE).
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const CDP = process.env.CDP_EXE || '';
const DB = process.env.DB_THU || 'sigma_thu';
const URL_ = process.env.URL_THU || 'http://127.0.0.1:57914/';
const RA = resolve(import.meta.dirname, '../screenshots/nut-sach');
mkdirSync(RA, { recursive: true });
const MENU = ['Doanh Số', 'Trang chủ', 'Quản Lý Nhân Sự', 'Quản Lý Máy POS', 'Quản Lý TID',
  'Quản Lý Doanh Thu & Công Nợ', 'Quản Lý Hồ Sơ HKD', 'Quản Lý Tài Chính', 'Bill Giải Trình',
  'Quản Lý Ngân Hàng - Đối Tác', 'Quản lý dữ liệu yêu cầu duyệt hủy', 'Duyệt xuất kho',
  'Quản Lý Cấu Hình Hệ Thống'];

let soKiem = 0;
const loi = [];
const chot = (ok, ten) => { soKiem++; if (!ok) { loi.push(ten); if (loi.length <= 25) console.log('  >>> ĐỎ — ' + ten); } };

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB;
const db = CDP ? null : new pg.Client({ connectionString: u.toString() });
const NHAN = 'kiem-nut-sach';
const tho = randomUUID();
if (db) {
  await db.connect();
  await db.query(`INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
    VALUES ($1,(SELECT id FROM users WHERE deleted_at IS NULL AND status='ACTIVE' ORDER BY (username='adminroot') DESC, id LIMIT 1),
            now(),now()+interval '25 minutes',now(),$2)`, [createHash('sha256').update(tho).digest('hex'), NHAN]);
}
const b = CDP ? await chromium.connectOverCDP(CDP) : await chromium.launch();
let ctx; let p;
if (CDP) { ctx = b.contexts()[0]; p = ctx.pages()[0]; }
else {
  ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
  p = await ctx.newPage();
}
const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') loiTrang.push('console.error: ' + m.text().slice(0, 70)); });
if (!CDP) await p.goto(URL_, { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);

let tongNut = 0;
let soMan = 0;
for (const ten of MENU) {
  const nm = p.locator("[data-kiem='nut-menu']");
  if (await nm.count()) {
    const v = await p.locator('aside').first().isVisible().catch(() => false);
    if (!v) { await nm.first().click(); await p.waitForTimeout(700); }
  }
  let muc = p.locator('aside button', { hasText: ten }).first();
  if (!(await muc.count())) { await p.waitForTimeout(1200); muc = p.locator('aside button', { hasText: ten }).first(); }
  if (!(await muc.count())) { chot(false, `KHÔNG VÀO ĐƯỢC màn "${ten}"`); continue; }
  await muc.click();
  await p.waitForTimeout(2200);
  await p.waitForFunction(() => {
    const el = document.querySelector('main') || document.body;
    return (el.getAnimations ? el.getAnimations({ subtree: true }) : []).filter((a) => a.playState === 'running').length === 0;
  }, { timeout: 8000 }).catch(() => undefined);
  await p.mouse.move(1500, 930);
  await p.waitForTimeout(350);
  soMan++;

  const d = await p.evaluate(() => {
    const hien = (e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2 && getComputedStyle(e).display !== 'none'; };
    return [...document.querySelectorAll('main button')].filter(hien).map((e) => {
      const c = getComputedStyle(e);
      // Nút icon kèm chú thích nổi: con đặt `position:absolute` làm scrollWidth phình theo chữ ĐANG ẨN.
      const coChuThichNoi = [...e.children].some((x) => getComputedStyle(x).position === 'absolute');
      return { nhan: (e.textContent || '').trim().slice(0, 24) || '(icon)',
               anh: c.backgroundImage, bong: c.boxShadow, bo: c.borderTopLeftRadius,
               boQuaTran: coChuThichNoi,
               tran: !coChuThichNoi && e.scrollWidth > e.clientWidth + 1 };
    });
  });
  tongNut += d.length;
  console.log('\n== ' + ten + ' — ' + d.length + ' nút trong trang');
  for (const n of d) {
    chot(n.anh === 'none', `${ten} · "${n.nhan}": CÒN ảnh nền gradient (${n.anh.slice(0, 40)})`);
    chot(n.bong === 'none' || /0px 2px 0px|0px 1px 0px/.test(n.bong), `${ten} · "${n.nhan}": bóng lạ "${n.bong.slice(0, 44)}"`);
    chot(parseFloat(n.bo) <= 3.4, `${ten} · "${n.nhan}": bo góc ${n.bo} > 3.4px`);
    if (!n.boQuaTran) chot(!n.tran, `${ten} · "${n.nhan}": CHỮ BỊ CẮT CỤT`);
  }
  await p.screenshot({ path: resolve(RA, ten.replace(/[^A-Za-zÀ-ỹ0-9]+/g, '-').toLowerCase() + '.png'), timeout: 15000 })
    .catch((e) => chot(false, `${ten} · KHÔNG chụp được ảnh (${e.message.slice(0, 40)})`));
}
chot(loiTrang.length === 0, 'LỖI RUNTIME: ' + loiTrang.slice(0, 3).join(' || '));
console.log('\n[nut-sach] đi ' + soMan + ' màn · đo ' + tongNut + ' nút (đếm động)');
console.log('[nut-sach] SỐ PHÉP KIỂM ĐÃ CHẠY (đếm động) = ' + soKiem);
console.log('[nut-sach] ảnh: ' + RA);
if (loi.length) {
  // Gom theo LOẠI lỗi + theo MÀN để biết ổ nằm ở đâu, thay vì đọc 188 dòng rời rạc.
  const loai = {};
  const man = {};
  for (const x of loi) {
    const k = /CÒN ảnh nền/.test(x) ? 'còn gradient' : /bóng lạ/.test(x) ? 'bóng lạ'
      : /bo góc/.test(x) ? 'bo góc to' : /CẮT CỤT/.test(x) ? 'cắt cụt chữ' : 'khác';
    loai[k] = (loai[k] || 0) + 1;
    const m = x.split(' · ')[0];
    man[m] = (man[m] || 0) + 1;
  }
  console.log('');
  console.log('  THEO LOẠI : ' + Object.entries(loai).map(([k, v]) => k + '=' + v).join(' · '));
  console.log('  THEO MÀN  : ' + Object.entries(man).sort((x, y) => y[1] - x[1]).map(([k, v]) => k + '=' + v).join(' · '));
  console.log('[nut-sach] KẾT LUẬN: ' + loi.length + ' phép kiểm ĐỎ'); process.exitCode = 1;
}
else console.log('[nut-sach] KẾT LUẬN: không phép kiểm nào đỏ');
if (soKiem < 50) { console.log('[nut-sach] NGHI NGỜ: chạy quá ít phép kiểm'); process.exitCode = 3; }
await b.close();
if (db) {
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  const sot = (await db.query('SELECT count(*)::int n FROM login_sessions WHERE device_info=$1', [NHAN])).rows[0].n;
  if (sot) { console.log('[nut-sach] CÒN SÓT ' + sot + ' phiên kiểm thử'); process.exitCode = 3; }
  await db.end();
}
