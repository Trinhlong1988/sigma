// KIỂM: gõ dở 1 bill → thu nhỏ → đi màn khác → quay lại thì PHẢI CÒN NGUYÊN (Admin Demo 16/11).
// Có ĐỐI CHỨNG: bấm "Xóa" thì bản nháp phải mất hẳn.
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/pos-tid-16-11');
mkdirSync(RA, { recursive: true });
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/sigma_thu';
const db = new pg.Client({ connectionString: u.toString() }); await db.connect();
const NHAN = 'kiem-giu-ban-nhap'; const tho = randomUUID();
await db.query(`INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
  VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]);
let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1920, height: 1040 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
await p.goto('http://127.0.0.1:57914/', { waitUntil: 'networkidle' }); await p.waitForTimeout(2500);
  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
async function vaoMan(ten) {
  const nm = p.locator("[data-kiem='nut-menu']");
  if (await nm.count()) { const v = await p.locator('aside').first().isVisible().catch(() => false); if (!v) { await nm.first().click(); await p.waitForTimeout(700); } }
  await p.locator('aside button', { hasText: ten }).first().click(); await p.waitForTimeout(2500);
}
async function chon(goi, chu) {
  const o = p.locator(`input[placeholder*="${goi}"]`).first();
  await o.focus(); await o.fill(chu); await p.waitForTimeout(800);
  const muc = o.locator('xpath=ancestor::div[contains(@class,"relative")][2]').locator('ul li').filter({ hasText: chu }).first();
  if (await muc.count() === 0) return false;
  await muc.click({ force: true }); await p.waitForTimeout(2000); return true;
}
const SO_LO = '777';
const SO_HD = '123456';
const GHI_CHU = 'bill đang gõ dở — kiểm giữ bản nháp';

await vaoMan('Doanh Số');
await p.locator('button', { hasText: 'Thêm bill mới' }).first().click(); await p.waitForTimeout(2500);
// Thứ tự ô: SỐ LÔ phải đứng TRƯỚC số hoá đơn (Admin Demo 16/11).
const thuTu = await p.evaluate(() => [...document.querySelectorAll('input[placeholder="vd 84"], input[placeholder="vd 000123"]')].map((x) => x.placeholder));
console.log('      thứ tự 2 ô: ' + JSON.stringify(thuTu));
chot(thuTu[0] === 'vd 84' && thuTu[1] === 'vd 000123', 'ô SỐ LÔ đứng TRƯỚC ô SỐ HÓA ĐƠN');

chot(await chon('ngân hàng', 'MB'), 'chọn ngân hàng MB');
await p.locator('input[placeholder="vd 84"]').first().fill(SO_LO);
await p.locator('input[placeholder="vd 000123"]').first().fill(SO_HD);
await p.locator('textarea, input[placeholder*="khách gửi"]').first().fill(GHI_CHU).catch(() => {});
await p.waitForTimeout(900);
// Người hoàn phải chọn được DÙ chưa nhập tiền hoàn (Admin Demo 16/11).
// [B206 19/11] Ô này đổi tên từ "— Kế toán / Admin —" sang "— Người được hoàn tiền —": danh sách nay lọc
// theo Ô TÍCH quyền hoàn tiền của từng nhân sự, không còn theo vai trò kế toán/admin.
const oNguoiHoan = p.locator('input[placeholder*="được hoàn tiền"]').first();
chot(await oNguoiHoan.isEnabled(), 'ô "Người hoàn" CHỌN ĐƯỢC dù tiền hoàn = 0');

// Thu nhỏ → sang màn khác → quay lại.
await p.locator('[data-nut="thunho"]').first().click(); await p.waitForTimeout(1500);
await p.screenshot({ path: resolve(RA, '10b-sau-khi-thu-nho.png') });
const conPhu = await p.locator('div.fixed.inset-0').count();
console.log('      lớp phủ còn lại sau khi thu nhỏ: ' + conPhu);
chot(conPhu === 0, 'bấm thu nhỏ thì lớp phủ hộp thoại BIẾN MẤT (bấm được menu)');
await vaoMan('Quản Lý Máy POS'); await p.waitForTimeout(1500);
await vaoMan('Doanh Số'); await p.waitForTimeout(2500);
await p.screenshot({ path: resolve(RA, '11-quay-lai-sau-doi-man.png') });
// Quay lại thì thanh "Đang nhập bill" phải CÒN (đúng trạng thái thu nhỏ lúc rời đi) — bấm "Mở lại" để soi ô.
const thanhNho = p.locator('text=Đang nhập bill').first();
chot(await thanhNho.count() > 0, 'quay lại vẫn thấy thanh "Đang nhập bill" (giữ đúng trạng thái thu nhỏ)');
const moLai = p.locator('button', { hasText: 'Mở lại' }).first();
if (await moLai.count()) { await moLai.click(); await p.waitForTimeout(2000); }
await p.screenshot({ path: resolve(RA, '12-mo-lai-ban-nhap.png') });
const con = await p.evaluate(() => {
  const lo = document.querySelector('input[placeholder="vd 84"]');
  const hd = document.querySelector('input[placeholder="vd 000123"]');
  const thanh = [...document.querySelectorAll('*')].some((e) => e.children.length === 0 && /Đang nhập bill|Mở lại|Thêm bill/.test(e.textContent || ''));
  return { lo: lo ? lo.value : null, hd: hd ? hd.value : null, thayForm: !!lo, thanh };
});
console.log('      sau khi quay lại: ' + JSON.stringify(con));
chot(con.lo === SO_LO && con.hd === SO_HD, 'quay lại VẪN CÒN số lô + số hoá đơn đang gõ dở');

// ĐỐI CHỨNG: bấm Xóa ⇒ bản nháp mất hẳn, quay lại không còn gì.
const nutXoa = p.locator('button', { hasText: /^Xóa$/ }).first();
if (await nutXoa.count()) { await nutXoa.click(); await p.waitForTimeout(1500); }
// Form đã sạch ⇒ đóng hộp thoại (còn mở thì lớp phủ chặn bấm menu).
await p.keyboard.press('Escape'); await p.waitForTimeout(1200);
await vaoMan('Quản Lý Máy POS'); await p.waitForTimeout(1200);
await vaoMan('Doanh Số'); await p.waitForTimeout(2500);
const sauXoa = await p.evaluate(() => {
  const lo = document.querySelector('input[placeholder="vd 84"]');
  return lo ? lo.value : 'khong-con-form';
});
console.log('      sau khi Xóa rồi quay lại: ' + JSON.stringify(sauXoa));
chot(sauXoa === '' || sauXoa === 'khong-con-form', 'ĐỐI CHỨNG: bấm Xóa ⇒ quay lại KHÔNG còn bản nháp');

console.log("\n[giu-ban-nhap] SO PHEP KIEM (dem dong) = " + so);
console.log(loi.length ? '[giu-ban-nhap] ' + loi.length + ' ĐỎ' : '[giu-ban-nhap] KHÔNG phép kiểm nào đỏ');
await b.close();
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]); await db.end();
if (loi.length) process.exitCode = 1;
