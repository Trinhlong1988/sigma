// LÁI GIAO DIỆN THẬT: thêm loại thẻ cho TẤT CẢ ngân hàng (Admin Demo 13/11 "thêm phần chọn all").
// Chạy trên BẢN SAO. Tự tạo phiên tạm → mở form → chọn "TẤT CẢ" → bấm → ĐỌC LẠI SỔ đối chiếu → dọn.
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/the-tat-ca');
mkdirSync(RA, { recursive: true });
const TEN_THE = process.env.TEN_THE || 'KiemThu-TatCa';
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/sigma_thu';
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
let soKiem = 0; const loi = [];
const chot = (ok, ten) => { soKiem++; if (!ok) { loi.push(ten); console.log('  >>> ĐỎ — ' + ten); } };
const NHAN = 'kiem-the-tat-ca';
const tho = randomUUID();
await db.query(`INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
  VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '15 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]);
const soBank = (await db.query('SELECT count(*)::int n FROM banks WHERE deleted_at IS NULL')).rows[0].n;
await db.query('DELETE FROM card_types WHERE name=$1', [TEN_THE]); // dọn tàn dư lần trước
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push('pageerror: ' + e.message));
try {
  await p.goto('http://127.0.0.1:57914/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2200);
  const nm = p.locator("[data-kiem='nut-menu']");
  if (await nm.count()) { const v = await p.locator('aside').first().isVisible().catch(() => false); if (!v) { await nm.first().click(); await p.waitForTimeout(700); } }
  await p.locator('aside button', { hasText: 'Quản Lý Ngân Hàng - Đối Tác' }).first().click();
  await p.waitForTimeout(2200);
  await p.locator('[data-tab-bar] button', { hasText: 'Loại thẻ' }).first().click();
  await p.waitForTimeout(1600);
  await p.locator("button[data-nut='them']").first().click();
  await p.waitForTimeout(1200);

  const sel = p.locator("[data-kiem='chon-ngan-hang']");
  chot(await sel.count() > 0, 'form có ô chọn ngân hàng');
  const muc = await sel.locator('option').allTextContents();
  const mucTatCa = muc.find((x) => /TẤT CẢ ngân hàng/.test(x));
  chot(!!mucTatCa, 'ô chọn có mục “TẤT CẢ ngân hàng”');
  chot(!!mucTatCa && mucTatCa.includes('(' + soBank + ')'), `mục TẤT CẢ ghi đúng số ngân hàng (${soBank}) — thấy "${mucTatCa}"`);
  await sel.selectOption('__tat_ca__');
  await p.waitForTimeout(400);
  const nhanNut = (await p.locator("[data-kiem='luu-loai-the']").innerText()).trim();
  chot(/Thêm cho \d+ ngân hàng/.test(nhanNut), `nút đổi nhãn theo lựa chọn — thấy "${nhanNut}"`);
  chot(nhanNut.includes(String(soBank)), `nhãn nút ghi đúng ${soBank} ngân hàng`);

  await p.locator('input').nth(1).fill(TEN_THE);   // Tên loại thẻ
  await p.locator('input').nth(2).fill(TEN_THE);   // Mã loại thẻ
  await p.screenshot({ path: resolve(RA, 'form-chon-tat-ca.png') });
  await p.locator("[data-kiem='luu-loai-the']").click();
  await p.waitForTimeout(5000);
  await p.screenshot({ path: resolve(RA, 'sau-khi-them.png') });

  // ĐỌC LẠI SỔ — nguồn sự thật, không tin lời toast
  const r = await db.query('SELECT bank_id FROM card_types WHERE name=$1 AND deleted_at IS NULL', [TEN_THE]);
  chot(r.rowCount === soBank, `sổ phải có ${soBank} dòng loại thẻ "${TEN_THE}" — thực tế ${r.rowCount}`);
  const thieu = (await db.query(
    `SELECT b.name FROM banks b WHERE b.deleted_at IS NULL
       AND NOT EXISTS (SELECT 1 FROM card_types c WHERE c.bank_id=b.id AND c.name=$1 AND c.deleted_at IS NULL)`, [TEN_THE])).rows;
  chot(thieu.length === 0, 'ngân hàng còn THIẾU: ' + thieu.map((x) => x.name).join(', '));

  // Bấm LẠI lần 2 — phải "bỏ qua" hết, KHÔNG nhân đôi
  await p.locator("button[data-nut='them']").first().click();
  await p.waitForTimeout(1000);
  await p.locator("[data-kiem='chon-ngan-hang']").selectOption('__tat_ca__');
  await p.locator('input').nth(1).fill(TEN_THE);
  await p.locator('input').nth(2).fill(TEN_THE);
  await p.locator("[data-kiem='luu-loai-the']").click();
  await p.waitForTimeout(5000);
  const r2 = await db.query('SELECT count(*)::int n FROM card_types WHERE name=$1 AND deleted_at IS NULL', [TEN_THE]);
  chot(r2.rows[0].n === soBank, `làm lại lần 2 KHÔNG được nhân đôi — vẫn phải ${soBank}, thực tế ${r2.rows[0].n}`);
  await p.screenshot({ path: resolve(RA, 'lan-2-khong-nhan-doi.png') });
  chot(loiTrang.length === 0, 'LỖI RUNTIME: ' + loiTrang.slice(0, 3).join(' || '));
} finally {
  await b.close();
  await db.query('DELETE FROM card_types WHERE name=$1', [TEN_THE]);
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  const sot = (await db.query('SELECT count(*)::int n FROM card_types WHERE name=$1', [TEN_THE])).rows[0].n;
  if (sot) { console.log('CÒN SÓT ' + sot + ' loại thẻ kiểm thử — phải dọn tay!'); process.exitCode = 3; }
  await db.end();
}
console.log('\n[the-tat-ca] SỐ PHÉP KIỂM ĐÃ CHẠY (đếm động) = ' + soKiem);
console.log('[the-tat-ca] ảnh: ' + RA);
console.log(loi.length ? '[the-tat-ca] KẾT LUẬN: ' + loi.length + ' phép kiểm ĐỎ' : '[the-tat-ca] KẾT LUẬN: không phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
if (soKiem < 6) { console.log('[the-tat-ca] NGHI NGỜ: chạy quá ít phép kiểm'); process.exitCode = 3; }
