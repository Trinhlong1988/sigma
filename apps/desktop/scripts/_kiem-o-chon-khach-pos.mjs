// [Admin Demo 16/11] "Khách hàng nhận máy (triển khai) ở Quản Lý POS — danh sách khách phải ĐÚNG BRAND
// như danh sách khách bên TID."
//
// Kiểm bằng CÁCH NGƯỜI DÙNG LÀM THẬT (R200 + feedback_reproduce_full_flow): mở bản web, vào màn Máy POS,
// bấm đúng thao tác "Triển khai (giao khách)" của 1 máy ĐANG TRONG KHO, rồi:
//   • CHỤP ảnh để LEAD tự nhìn;
//   • ĐO bằng số: danh sách xổ ra có phải BẢNG 2 cột MÃ KHÁCH | TÊN KHÁCH, có sọc brand, và có NỔI RA NGOÀI
//     khung hộp thoại hay không (đây là lỗi 0.2.143: list absolute bị khung overflow của Modal cắt cụt);
//   • ĐỐI CHỨNG: gõ từ khoá có bỏ dấu/khác hoa-thường phải lọc đúng; gõ chuỗi vô nghĩa phải ra "không khớp".
// Mặc định chạy trên BẢN THỬ 57915 → API 8795 → DB sigma_thu (KHÔNG đụng sổ thật).
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/o-chon-khach-pos-16-11');
mkdirSync(RA, { recursive: true });
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };

const NHAN = 'kiem-o-chon-khach-pos';
const tho = randomUUID();
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);

// Máy ĐANG TRONG KHO để có thao tác "Triển khai (giao khách)" — đọc từ DB, KHÔNG đoán serial.
const may = (await db.query("SELECT serial FROM pos_devices WHERE status='IN_STOCK' AND deleted_at IS NULL ORDER BY id DESC LIMIT 1")).rows[0];
chot(!!may, 'DB thử có máy POS đang TRONG KHO để mở hộp "Triển khai"');
const soKhach = Number((await db.query('SELECT count(*)::int n FROM customers WHERE deleted_at IS NULL')).rows[0].n);
console.log('      máy thử:', may?.serial, '· số khách trong sổ thử:', soKhach);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push('pageerror: ' + e.message));
p.on('console', (m) => { if (m.type() === 'error') loiTrang.push('console: ' + m.text().slice(0, 200)); });
// [24/11 chẩn đoán] Bắt ĐÚNG URL của mọi phản hồi lỗi (4xx/5xx) để biết endpoint/asset nào hỏng — "404" trần
// trụi không chỉ ra chỗ nào. Giúp phân biệt lỗi do code mới hay sẵn có.
p.on('response', (r) => { const s = r.status(); if (s >= 400) loiTrang.push(`HTTP ${s}: ${r.url().slice(0, 160)}`); });

await p.goto(WEB + '/', { waitUntil: 'networkidle' });
await p.waitForTimeout(2500);

  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
// vào màn Quản Lý Máy POS
const nutMenu = p.locator("[data-kiem='nut-menu']");
if (await nutMenu.count()) {
  const hien = await p.locator('aside').first().isVisible().catch(() => false);
  if (!hien) { await nutMenu.first().click(); await p.waitForTimeout(700); }
}
await p.locator('aside button', { hasText: 'Quản Lý Máy POS' }).first().click();
await p.waitForTimeout(3500);
await p.screenshot({ path: resolve(RA, '01-man-pos.png') });

// Tìm đúng DÒNG của máy đó rồi bấm thao tác "Triển khai (giao khách)".
const dong = p.locator('table tbody tr', { hasText: may.serial }).first();
chot(await dong.count() > 0, 'thấy dòng của máy ' + may.serial + ' trên bảng');
await dong.scrollIntoViewIfNeeded();
// Ô thao tác là 1 <select> hoặc danh sách nút — thử cả 2 đường, đường nào cũng KHÔNG im lặng.
let moDuoc = false;
const sel = dong.locator('select');
if (await sel.count()) {
  await sel.first().selectOption({ label: 'Triển khai (giao khách)' }).catch(() => {});
  moDuoc = true;
} else {
  const nut = dong.locator('button', { hasText: 'Triển khai' });
  if (await nut.count()) { await nut.first().click(); moDuoc = true; }
}
await p.waitForTimeout(1200);
const hopThoai = p.locator('[role="dialog"], .fixed').filter({ hasText: 'Khách hàng nhận máy' }).first();
chot(moDuoc && (await hopThoai.count()) > 0, 'mở được hộp thoại "Triển khai (giao khách)" có ô "Khách hàng nhận máy"');
await p.screenshot({ path: resolve(RA, '02-hop-trien-khai.png') });

// Ô chọn khách PHẢI là component dùng chung (dấu nhận dạng data-kiem="o-chon-khach" của CustomerPicker).
const o = p.locator("[data-kiem='o-chon-khach']").first();
chot(await o.count() > 0, 'ô chọn khách là CustomerPicker dùng chung với màn TID (không còn <select> thuần)');
const conSelect = await p.locator('[role="dialog"] select, .fixed select').evaluateAll(
  (els) => els.filter((e) => [...e.options].some((o2) => /Chọn khách/i.test(o2.textContent ?? ''))).length
).catch(() => 0);
chot(conSelect === 0, 'KHÔNG còn <select> "— Chọn khách hàng —" nào sót trong hộp thoại (đếm ' + conSelect + ')');

// Bung danh sách ra.
await o.click();
await p.waitForTimeout(800);
await p.screenshot({ path: resolve(RA, '03-danh-sach-bung.png') });

const dl = await p.evaluate(() => {
  const inp = document.querySelector("[data-kiem='o-chon-khach']");
  // Bảng gợi ý nằm NGOÀI hộp thoại (portal) — tìm bảng có đúng 2 tiêu đề MÃ KHÁCH / TÊN KHÁCH.
  const bang = [...document.querySelectorAll('table')].find((tb) => {
    const th = [...tb.querySelectorAll('thead th')].map((x) => (x.textContent ?? '').trim().toUpperCase());
    return th.length === 2 && th[0].includes('MÃ KHÁCH') && th[1].includes('TÊN KHÁCH');
  });
  if (!bang) return { thay: false };
  const rb = bang.getBoundingClientRect();
  const modal = [...document.querySelectorAll('div')].find((d) => /Khách hàng nhận máy/.test(d.textContent ?? '') && getComputedStyle(d).overflowY === 'auto');
  const rm = modal ? modal.getBoundingClientRect() : null;
  // `position: fixed` nằm ở Ổ NGOÀI do HopNoi dựng, không phải thẻ div sát bảng ⇒ phải LEO chuỗi tổ tiên.
  let viTri = 'static';
  for (let e = bang.parentElement; e && e !== document.body; e = e.parentElement) {
    const v = getComputedStyle(e).position;
    if (v === 'fixed' || v === 'absolute') { viTri = v; break; }
  }
  // Bảng có bị NẰM TRONG khung cuộn của hộp thoại không — đây mới là gốc lỗi "bị cắt cụt" (0.2.143).
  const trongModal = modal ? modal.contains(bang) : null;
  // Dòng "Không có khách nào khớp" là 1 <tr> có td colSpan=2 — KHÔNG phải dòng khách, phải trừ ra.
  const tr = [...bang.querySelectorAll('tbody tr')].filter((r) => r.querySelector('td') && !r.querySelector('td[colspan]'));
  return {
    thay: true,
    soDong: tr.length,
    trongModal,
    th: [...bang.querySelectorAll('thead th')].map((x) => (x.textContent ?? '').trim()),
    nen2Dong: tr.slice(0, 2).map((r) => getComputedStyle(r).backgroundColor),
    viTri,
    bang: { top: Math.round(rb.top), bottom: Math.round(rb.bottom), left: Math.round(rb.left), width: Math.round(rb.width) },
    modal: rm ? { top: Math.round(rm.top), bottom: Math.round(rm.bottom) } : null,
    oDay: inp ? Math.round(inp.getBoundingClientRect().bottom) : null,
    caoKhungNhin: window.innerHeight
  };
});
console.log('      ĐO:', JSON.stringify(dl));
chot(dl.thay, 'danh sách xổ ra là BẢNG có đúng 2 tiêu đề MÃ KHÁCH | TÊN KHÁCH');
chot(dl.soDong > 0, 'bảng có dòng khách (' + dl.soDong + ' dòng)');
chot(dl.nen2Dong && dl.nen2Dong[0] !== dl.nen2Dong[1], 'dòng SO LE 2 màu (' + JSON.stringify(dl.nen2Dong) + ')');
chot(dl.viTri === 'fixed', 'bảng vẽ bằng toạ độ `fixed` — đang là `' + dl.viTri + '`');
chot(dl.trongModal === false, 'bảng nằm NGOÀI khung cuộn của hộp thoại (portal) ⇒ không thể bị cắt cụt — trongModal=' + dl.trongModal);
chot(dl.bang.bottom <= dl.caoKhungNhin, 'bảng KHÔNG tràn đáy khung nhìn (bottom ' + dl.bang?.bottom + ' ≤ ' + dl.caoKhungNhin + ')');
if (dl.modal) {
  chot(dl.bang.bottom > dl.modal.bottom || dl.bang.top >= dl.oDay,
    'bảng hiện NGAY DƯỚI ô, không bị khung hộp thoại cắt (bảng top ' + dl.bang.top + ' ≥ đáy ô ' + dl.oDay + ')');
}

// Gõ tìm: bỏ dấu + khác hoa thường.
const tenMot = (await db.query("SELECT COALESCE(NULLIF(nickname,''), full_name) AS ten FROM customers WHERE deleted_at IS NULL AND COALESCE(NULLIF(nickname,''), full_name) <> '' ORDER BY id LIMIT 1")).rows[0]?.ten ?? '';
const goKhongDau = tenMot.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(' ')[0];
await o.fill(goKhongDau);
await p.waitForTimeout(700);
const locDuoc = await p.evaluate(() => {
  const bang = [...document.querySelectorAll('table')].find((tb) => {
    const th = [...tb.querySelectorAll('thead th')].map((x) => (x.textContent ?? '').trim().toUpperCase());
    return th.length === 2 && th[0].includes('MÃ KHÁCH');
  });
  const tr = bang ? [...bang.querySelectorAll('tbody tr')].filter((r) => r.querySelector('td') && !r.querySelector('td[colspan]')) : [];
  return { n: tr.length, dongDau: tr[0] ? tr[0].innerText.replace(/\s+/g, ' ').trim() : null };
});
console.log('      gõ "' + goKhongDau + '" (bỏ dấu, chữ thường) →', JSON.stringify(locDuoc));
chot(locDuoc.n > 0 && locDuoc.n < soKhach, 'gõ không dấu/chữ thường LỌC đúng (' + locDuoc.n + '/' + soKhach + ' khách)');
await p.screenshot({ path: resolve(RA, '04-go-tim.png') });

// ĐỐI CHỨNG: chuỗi vô nghĩa ⇒ phải báo không khớp, KHÔNG được trả cả danh sách.
await o.fill('zzxq-khong-ton-tai-123');
await p.waitForTimeout(600);
const rong = await p.evaluate(() => (document.body.innerText.includes('Không có khách nào khớp') ? 'co-thong-bao' : 'khong-co'));
const demRong = await p.evaluate(() => {
  const bang = [...document.querySelectorAll('table')].find((tb) => {
    const th = [...tb.querySelectorAll('thead th')].map((x) => (x.textContent ?? '').trim().toUpperCase());
    return th.length === 2 && th[0].includes('MÃ KHÁCH');
  });
  return bang ? [...bang.querySelectorAll('tbody tr')].filter((r) => r.querySelector('td') && !r.querySelector('td[colspan]')).length : -1;
});
chot(rong === 'co-thong-bao' && demRong === 0, 'ĐỐI CHỨNG: từ khoá vô nghĩa ⇒ 0 dòng + báo "Không có khách nào khớp" (' + rong + ', dòng=' + demRong + ')');
await p.screenshot({ path: resolve(RA, '05-doi-chung-khong-khop.png') });

// Chọn 1 khách thật rồi xem ô có hiện "MÃ · TÊN" không (không được để trống như lỗi datalist cũ).
await o.fill('');
await p.waitForTimeout(600);
// BẤM ĐÚNG bảng gợi ý (bảng có tiêu đề MÃ KHÁCH) — trước đây `table tbody tr td` bắt phải bảng danh sách
// máy POS phía sau hộp thoại nên không chọn được ai, rồi tôi tưởng app lỗi. Chọn bằng chuột THẬT, không set state.
const bangGoiY = p.locator('table').filter({ has: p.locator('thead th', { hasText: 'MÃ KHÁCH' }) }).first();
chot(await bangGoiY.count() > 0, 'bảng gợi ý còn mở để chọn khách');
const oDauTien = bangGoiY.locator('tbody tr td').first();
const maSeChon = (await oDauTien.innerText()).trim();
await oDauTien.click({ timeout: 5000 });
await p.waitForTimeout(700);
const giaTriO = await o.inputValue().catch(() => '');
console.log('      sau khi chọn, ô hiện:', JSON.stringify(giaTriO));
chot(giaTriO.trim().length > 0 && giaTriO.includes(maSeChon), 'chọn xong ô HIỆN "mã · tên" của ĐÚNG khách vừa bấm (' + giaTriO + ' ⊇ ' + maSeChon + ')');
await p.screenshot({ path: resolve(RA, '06-da-chon.png') });

// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// Ô CHỌN KHÁCH THỨ HAI trên CÙNG màn POS: hộp "Bán máy" (nhãn "Khách mua"). Cùng màn thì phải cùng kiểu —
// liệt kê TỪNG ô chứ không sửa 1 chỗ rồi báo "đã áp cả màn" (feedback_cross_cutting_ui_completion_gate).
await p.keyboard.press('Escape');
await p.waitForTimeout(800);
const dong2 = p.locator('table tbody tr', { hasText: may.serial }).first();
await dong2.locator("[title='Bán máy (kèm TID nếu có)'], [aria-label='Bán máy (kèm TID nếu có)']").first().click({ timeout: 8000 }).catch(() => {});
await p.waitForTimeout(1200);
const hopBan = p.locator('.fixed', { hasText: 'Khách mua' }).first();
chot(await hopBan.count() > 0, 'mở được hộp "Bán máy" có ô "Khách mua"');
const oBan = p.locator("[data-kiem='o-chon-khach']").first();
chot(await oBan.count() > 0, 'ô "Khách mua" CŨNG là CustomerPicker brand (không còn <select>)');
await oBan.click();
await p.waitForTimeout(800);
const dlBan = await p.evaluate(() => {
  const bang = [...document.querySelectorAll('table')].find((tb) => {
    const th = [...tb.querySelectorAll('thead th')].map((x) => (x.textContent ?? '').trim().toUpperCase());
    return th.length === 2 && th[0].includes('MÃ KHÁCH');
  });
  if (!bang) return { thay: false };
  const tr = [...bang.querySelectorAll('tbody tr')].filter((r) => r.querySelector('td') && !r.querySelector('td[colspan]'));
  return { thay: true, soDong: tr.length, th: [...bang.querySelectorAll('thead th')].map((x) => (x.textContent ?? '').trim()) };
});
console.log('      ĐO hộp Bán máy:', JSON.stringify(dlBan));
chot(dlBan.thay && dlBan.soDong > 0, 'hộp "Bán máy": danh sách cũng là BẢNG 2 cột có dòng khách (' + dlBan.soDong + ')');
await p.screenshot({ path: resolve(RA, '07-ban-may-chon-khach.png') });

chot(loiTrang.length === 0, 'không có lỗi trang/console (' + (loiTrang[0] ?? 'sạch') + ')');

console.log('\n[o-chon-khach-pos] ẢNH ở: ' + RA);
console.log('[o-chon-khach-pos] SO PHEP KIEM (dem dong) = ' + so);
if (so < 20) { loi.push('THIEU PHEP KIEM: chay ' + so + '/20 — co nhanh bi bo qua im lang (R198)'); console.log('  ĐỎ  đủ 20 phép kiểm phải CHẠY'); }
console.log(loi.length ? '[o-chon-khach-pos] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[o-chon-khach-pos] KHÔNG phép kiểm nào đỏ');

await b.close();
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
await db.end();
if (loi.length) process.exitCode = 1;
