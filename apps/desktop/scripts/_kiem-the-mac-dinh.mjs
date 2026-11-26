// KIỂM THẺ MẶC ĐỊNH đi TRỌN LUỒNG NGƯỜI DÙNG trên bản web THẬT (DB thử sigma_thu):
//   đánh dấu thẻ mặc định ở Cấu hình ngân hàng  →  mở Thêm bill  →  thẻ đó phải được CHỌN SẴN.
// Có ĐỐI CHỨNG: bỏ cờ thì ô loại thẻ phải TRỐNG trở lại.
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
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
const NHAN = 'kiem-the-mac-dinh';
const tho = randomUUID();
await db.query(`INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
  VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]);

let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push(e.message));
await p.goto('http://127.0.0.1:57914/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);

  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
async function vaoMan(ten) {
  const nm = p.locator("[data-kiem='nut-menu']");
  if (await nm.count()) {
    const v = await p.locator('aside').first().isVisible().catch(() => false);
    if (!v) { await nm.first().click(); await p.waitForTimeout(700); }
  }
  await p.locator('aside button', { hasText: ten }).first().click();
  await p.waitForTimeout(3000);
}

// ── 1) Đánh dấu thẻ mặc định qua ĐÚNG màn hình (không ghi thẳng DB) ──
await vaoMan('Quản Lý Ngân Hàng');
const tabThe = p.locator('button', { hasText: /^Loại thẻ$/ }).first();
chot(await tabThe.count() > 0, 'có tab "Loại thẻ"');
await tabThe.click(); await p.waitForTimeout(2000);
const nutSua = p.locator('[title="Sửa"], [aria-label="Sửa"]').first();
chot(await nutSua.count() > 0, 'có nút Sửa loại thẻ');
await nutSua.click(); await p.waitForTimeout(1200);
const oMacDinh = p.locator("[data-kiem='the-mac-dinh']");
chot(await oMacDinh.count() > 0, 'form loại thẻ CÓ ô tích "thẻ mặc định"');
const tenThe = await p.locator('input').nth(1).inputValue().catch(() => '');
const nhTheChon = await p.locator("[data-kiem='chon-ngan-hang']").inputValue().catch(() => '');
await oMacDinh.check();
await p.screenshot({ path: resolve(RA, '06-form-the-mac-dinh.png') });
await p.locator("[data-kiem='luu-loai-the']").click();
await p.waitForTimeout(2500);
const soMacDinh = await db.query('SELECT id, code, bank_id FROM card_types WHERE is_default = true');
chot(soMacDinh.rowCount === 1, 'DB: đúng 1 thẻ mang cờ mặc định (đang có ' + soMacDinh.rowCount + ')');
console.log('      thẻ mặc định = ' + JSON.stringify(soMacDinh.rows) + ' · tên trên form: ' + tenThe + ' · NH: ' + nhTheChon);
await p.screenshot({ path: resolve(RA, '07-danh-sach-loai-the.png') });
const coHuyHieu = await p.locator('text=Mặc định').count();
chot(coHuyHieu > 0, 'danh sách loại thẻ hiện huy hiệu "Mặc định"');

// ── 2) Màn Thêm bill: chọn ngân hàng + TID của CHÍNH ngân hàng đó → ô loại thẻ phải TỰ ĐIỀN ──
const bankIdMacDinh = soMacDinh.rows[0]?.bank_id;
const tenNH = (await db.query('SELECT code, name FROM banks WHERE id = $1', [bankIdMacDinh])).rows[0];
await vaoMan('Doanh Số');
await p.waitForTimeout(1500);
const nutThem = p.locator('button', { hasText: 'Thêm bill mới' }).first();
chot(await nutThem.count() > 0, 'có nút "Thêm bill mới"');
await nutThem.click(); await p.waitForTimeout(2500);

async function doOLoaiThe() {
  // [24/11] Loại thẻ nay là SearchSelect (có logo), KHÔNG còn <select> — đọc giá trị CHỌN qua data-gia-tri của
  // wrapper data-kiem="o-loai-the" (kiểm HÀNH VI: thẻ nào đang được chọn), không bám cách làm (<select>).
  return await p.evaluate(() => {
    const box = document.querySelector('[data-kiem="o-loai-the"]');
    if (!box) return null;
    const value = box.getAttribute('data-gia-tri') ?? '';
    const inp = box.querySelector('input');
    const chu = (inp && inp.value ? inp.value : (box.textContent || '')).trim();
    return { value, chu };
  });
}
// Chọn ngân hàng rồi TID — ô SearchSelect (input + danh sách <li>), bấm đúng như người dùng.
async function chonSearchSelect(goiNhan, chu) {
  const o = p.locator(`input[placeholder*="${goiNhan}"]`).first();
  // focus thay vì click: tiêu đề nhóm `sticky` của hộp thoại che điểm giữa ô ⇒ click thật bị chặn.
  await o.focus();
  await o.fill(chu);
  await p.waitForTimeout(800);
  // Danh sách gợi ý nằm NGAY trong khối .relative bọc chính ô này — không bắt nhầm <ul> của màn khác.
  const hop = o.locator('xpath=ancestor::div[contains(@class,"relative")][2]');
  const muc = hop.locator('ul li').filter({ hasText: chu }).first();
  if (await muc.count() === 0) return false;
  await muc.click({ force: true });
  await p.waitForTimeout(2500);
  return true;
}
// [19/11] Ô chọn hiện MÃ VIẾT TẮT ngân hàng (B174 — Admin Demo "tên bank viết tắt"), KHÔNG phải tên đầy đủ.
// Gõ tên đầy đủ sẽ không khớp dòng nào. Cổng này đỏ âm thầm từ 16/11 vì chưa được nối vào cổng ship.
const nhanNH = tenNH.code ?? tenNH.name;
const okNH = await chonSearchSelect('ngân hàng', nhanNH);
chot(okNH, 'chọn được ngân hàng "' + nhanNH + '" ở màn Thêm bill');
const tidDau = (await db.query(
  "SELECT t.tid FROM tids t WHERE t.bank_id = $1 AND t.deleted_at IS NULL AND t.status = 'ACTIVE' ORDER BY t.id LIMIT 1", [bankIdMacDinh])).rows[0];
chot(!!tidDau, 'DB thử CÓ ít nhất 1 TID đang hoạt động của ngân hàng này');
const okTid = tidDau ? await chonSearchSelect('Gõ tên HKD', tidDau.tid) : false;
chot(okTid, 'chọn được TID ' + (tidDau?.tid ?? '—'));
const sauKhiChon = await doOLoaiThe();
console.log('      ô Loại thẻ sau khi chọn TID: ' + JSON.stringify(sauKhiChon));
chot(!!sauKhiChon && sauKhiChon.value !== '', 'ô Loại thẻ được CHỌN SẴN (không còn rỗng)');
chot(!!sauKhiChon && sauKhiChon.value === String(soMacDinh.rows[0]?.id), 'chọn ĐÚNG thẻ đang mang cờ mặc định (' + (soMacDinh.rows[0]?.code ?? '') + ')');
await p.screenshot({ path: resolve(RA, '08-them-bill-the-mac-dinh.png') });

// ── 3) ĐỐI CHỨNG: bỏ cờ ⇒ ô loại thẻ phải TRỐNG lại ──
await db.query('UPDATE card_types SET is_default = false');
// [19/11] App GIỮ BẢN NHÁP bill (localStorage 'alpha.bill-nhap-do') nên tải lại trang là hộp thoại Thêm Bill
// TỰ MỞ LẠI, lớp phủ của nó chặn mọi cú bấm sang màn khác ⇒ bài kiểm treo 30s rồi chết. Xoá bản nháp trước.
await p.evaluate(() => window.localStorage.removeItem('alpha.bill-nhap-do'));
await p.reload({ waitUntil: 'networkidle' });
await p.waitForTimeout(2500);
await vaoMan('Doanh Số');
await p.locator('button', { hasText: 'Thêm bill mới' }).first().click();
await p.waitForTimeout(2500);
await chonSearchSelect('ngân hàng', nhanNH);
if (tidDau) await chonSearchSelect('Gõ tên HKD', tidDau.tid);
const doiChung = await doOLoaiThe();
console.log('      ĐỐI CHỨNG ô Loại thẻ: ' + JSON.stringify(doiChung));
chot(!!doiChung && doiChung.value === '', 'ĐỐI CHỨNG: bỏ cờ ⇒ ô Loại thẻ TRỐNG lại (phép kiểm có thật)');

chot(loiTrang.length === 0, 'không lỗi runtime: ' + loiTrang.slice(0, 2).join(' | '));
console.log('\n[the-mac-dinh] SỐ PHÉP KIỂM (đếm động) = ' + so);
console.log(loi.length ? '[the-mac-dinh] ' + loi.length + ' ĐỎ' : '[the-mac-dinh] KHÔNG phép kiểm nào đỏ');
await b.close();
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
await db.end();
if (loi.length) process.exitCode = 1;
