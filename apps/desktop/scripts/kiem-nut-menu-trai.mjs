// ĐO NÚT MENU BÊN TRÁI — phải cùng brand với nút chức năng "Làm mới" (Admin Demo 13/11).
// Oracle chép tay từ quyết định của Admin Demo, KHÔNG đọc từ CSS.
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/nut-menu-trai');
mkdirSync(RA, { recursive: true });
const DB = process.env.DB_THU || 'sigma_thu';
const URL_ = process.env.URL_THU || 'http://127.0.0.1:57914/';
const CHON = { nen: 'rgb(232, 243, 252)', vien: 'rgb(180, 214, 242)', chu: 'rgb(43, 108, 163)' };
const CDP = process.env.CDP_EXE || '';  // có giá trị ⇒ đo trên BẢN EXE đang chạy
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB;
const db = CDP ? null : new pg.Client({ connectionString: u.toString() });
const NHAN = 'kiem-nut-menu-trai';
const tho = randomUUID();
if (db) {
  await db.connect();
  await db.query(`INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
    VALUES ($1,(SELECT id FROM users WHERE deleted_at IS NULL AND status='ACTIVE' ORDER BY (username='adminroot') DESC, id LIMIT 1),
            now(),now()+interval '20 minutes',now(),$2)`, [createHash('sha256').update(tho).digest('hex'), NHAN]);
}
let soKiem = 0; const loi = [];
const chot = (ok, ten) => { soKiem++; if (!ok) { loi.push(ten); console.log('  >>> ĐỎ — ' + ten); } };
const b = CDP ? await chromium.connectOverCDP(CDP) : await chromium.launch();
let ctx;
let p;
if (CDP) {
  ctx = b.contexts()[0];
  p = ctx.pages()[0];
} else {
  ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
  await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
  p = await ctx.newPage();
}
const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') loiTrang.push('console.error: ' + m.text().slice(0, 80)); });
if (!CDP) await p.goto(URL_, { waitUntil: 'networkidle' });   // EXE: KHÔNG tải lại — tải lại là đăng xuất
await p.waitForTimeout(2500);
const nm = p.locator("[data-kiem='nut-menu']");
if (await nm.count()) { const v = await p.locator('aside').first().isVisible().catch(() => false); if (!v) { await nm.first().click(); await p.waitForTimeout(700); } }
// đi qua vài mục để trạng thái "đang chọn" chạy thật
for (const ten of ['Quản Lý Nhân Sự', 'Quản Lý TID', 'Doanh Số']) {
  const m = p.locator('aside button', { hasText: ten }).first();
  if (!(await m.count())) { chot(false, 'KHÔNG THẤY mục menu "' + ten + '"'); continue; }
  await m.click();
  await p.waitForTimeout(1800);
  const nmm = p.locator("[data-kiem='nut-menu']");
  if (await nmm.count()) { const v = await p.locator('aside').first().isVisible().catch(() => false); if (!v) { await nmm.first().click(); await p.waitForTimeout(700); } }
  // Dời chuột khỏi menu rồi mới đo — nếu không sẽ đo trúng màu DI CHUỘT QUA, không phải màu ĐANG CHỌN.
  await p.mouse.move(1500, 900);
  await p.waitForTimeout(400);
  const d = await p.evaluate(() => {
    const ds = [...document.querySelectorAll('aside [data-nut-menu]')];
    const doc = (e) => { const c = getComputedStyle(e);
      return { nhan: (e.textContent || '').trim().slice(0, 26), chon: e.getAttribute('data-chon') === '1',
               nen: c.backgroundColor, vien: c.borderTopColor, chu: c.color, bo: c.borderTopLeftRadius,
               bong: c.boxShadow, bien: c.transform, tran: e.scrollWidth > e.clientWidth + 1 }; };
    const dx = document.querySelector("[data-nut='dangxuat']");
    const nutCn = document.querySelector("main [data-nut='lammoi']");
    return { menu: ds.map(doc),
             dangxuat: dx ? { nen: getComputedStyle(dx).backgroundColor, chu: getComputedStyle(dx).color,
                              bo: getComputedStyle(dx).borderTopLeftRadius, anh: getComputedStyle(dx).backgroundImage,
                              bong: getComputedStyle(dx).boxShadow } : null,
             lammoi: nutCn ? { nen: getComputedStyle(nutCn).backgroundColor,
             vien: getComputedStyle(nutCn).borderTopColor, chu: getComputedStyle(nutCn).color,
             bo: getComputedStyle(nutCn).borderTopLeftRadius } : null };
  });
  const dangChon = d.menu.filter((x) => x.chon);
  console.log(`\n== đang ở "${ten}" — ${d.menu.length} mục menu, ${dangChon.length} mục đang chọn`);
  chot(dangChon.length === 1, `${ten}: có ${dangChon.length} mục đang chọn (phải đúng 1)`);
  for (const x of d.menu) {
    chot(x.bo === '3.4px', `${ten} · "${x.nhan}": bo góc ${x.bo} ≠ 3.4px`);
    chot(x.bien === 'none', `${ten} · "${x.nhan}": còn phóng to/nhấc lên (transform ${x.bien})`);
    chot(!x.tran, `${ten} · "${x.nhan}": CHỮ BỊ CẮT CỤT`);
    if (x.chon) {
      chot(x.nen === CHON.nen, `${ten} · "${x.nhan}" ĐANG CHỌN: nền ${x.nen} ≠ ${CHON.nen}`);
      chot(x.vien === CHON.vien, `${ten} · "${x.nhan}" ĐANG CHỌN: viền ${x.vien} ≠ ${CHON.vien}`);
      chot(x.chu === CHON.chu, `${ten} · "${x.nhan}" ĐANG CHỌN: chữ ${x.chu} ≠ ${CHON.chu}`);
      chot(/0px 2px 0px/.test(x.bong), `${ten} · "${x.nhan}" ĐANG CHỌN: bóng "${x.bong}" không phải kiểu nổi nhẹ 0 2px 0`);
    } else {
      chot(x.bong === 'none', `${ten} · "${x.nhan}" KHÔNG chọn: vẫn còn bóng "${x.bong}"`);
    }
  }
  if (d.dangxuat) {
    // Nút Đăng xuất: ĐỎ ĐẶC chữ trắng, PHẲNG (không gradient), bo 3,4px, nổi nhẹ 0 2px 0.
    chot(d.dangxuat.nen === 'rgb(217, 45, 45)', `Đăng xuất: nền ${d.dangxuat.nen} ≠ rgb(217, 45, 45)`);
    chot(d.dangxuat.chu === 'rgb(255, 255, 255)', `Đăng xuất: chữ ${d.dangxuat.chu} ≠ trắng`);
    chot(d.dangxuat.bo === '3.4px', `Đăng xuất: bo góc ${d.dangxuat.bo} ≠ 3.4px`);
    chot(d.dangxuat.anh === 'none', `Đăng xuất: CÒN GRADIENT/bóng kính (${d.dangxuat.anh.slice(0, 50)})`);
    chot(/0px 2px 0px/.test(d.dangxuat.bong), `Đăng xuất: bóng "${d.dangxuat.bong.slice(0, 50)}" không phải kiểu nổi nhẹ`);
  } else chot(false, 'KHÔNG THẤY nút Đăng xuất để đo');
  if (d.lammoi) {
    chot(d.lammoi.nen === CHON.nen, `nút "Làm mới" nền ${d.lammoi.nen} ≠ ${CHON.nen} — mốc so sánh đã lệch`);
    chot(d.lammoi.bo === '3.4px', `nút "Làm mới" bo góc ${d.lammoi.bo} ≠ 3.4px`);
    console.log('   (đối chiếu) nút "Làm mới": nền ' + d.lammoi.nen + ' · viền ' + d.lammoi.vien + ' · chữ ' + d.lammoi.chu);
  }
  await p.screenshot({ path: resolve(RA, ten.replace(/[^A-Za-zÀ-ỹ0-9]+/g, '-').toLowerCase() + '.png'), timeout: 15000 });
}
chot(loiTrang.length === 0, 'LỖI RUNTIME: ' + loiTrang.slice(0, 3).join(' || '));
console.log('\n[nut-menu] SỐ PHÉP KIỂM ĐÃ CHẠY (đếm động) = ' + soKiem);
console.log('[nut-menu] ảnh: ' + RA);
console.log(loi.length ? '[nut-menu] KẾT LUẬN: ' + loi.length + ' phép kiểm ĐỎ' : '[nut-menu] KẾT LUẬN: không phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
if (soKiem < 20) { console.log('[nut-menu] NGHI NGỜ: chạy quá ít phép kiểm'); process.exitCode = 3; }
await b.close();
if (db) {
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  const sot = (await db.query('SELECT count(*)::int n FROM login_sessions WHERE device_info=$1', [NHAN])).rows[0].n;
  if (sot) { console.log('[nut-menu] CÒN SÓT ' + sot + ' phiên kiểm thử'); process.exitCode = 3; }
  await db.end();
}
