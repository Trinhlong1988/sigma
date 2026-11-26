// CỔNG KIỂM TRẢI NGHIỆM ĐĂNG NHẬP — BẢN WEB QUẢN LÝ SIGMA (phần A, Admin Demo duyệt 12/11).
//
// ĐIỀU KHIỂN THẬT bằng Playwright (R200: thay đổi HÀNH VI thì ảnh tĩnh KHÔNG đủ) + đo số + chụp ảnh.
// Script KHÔNG tự kết luận "xanh": nó chỉ in số/ảnh và trả exit code; quyền tick xanh thuộc LEAD.
//
// ⚠️ CHỈ CHẠY TRÊN BẢN SAO: web 127.0.0.1:57914 → API 127.0.0.1:8795 → DB `sigma_thu`.
//    Script TỰ KIỂM /v1/health phải trả db kết thúc bằng `_thu`, không thì DỪNG NGAY (không chạm sổ thật).
// ⚠️ ĐĂNG NHẬP SAI LÀM TĂNG BỘ ĐẾM KHOÁ TÀI KHOẢN ⇒ chỉ gõ sai với tên CHẮC CHẮN KHÔNG TỒN TẠI
//    (`__kiem_thu_ux__`). Máy chủ chỉ đếm/khoá khi tài khoản CÓ THẬT (auth.ts dòng 178), nên tên không tồn
//    tại thì không khoá ai cả. TUYỆT ĐỐI không thử sai mật khẩu của tài khoản thật.
//
// HAI LOẠI PHÉP KIỂM, ghi rõ để không ai nhầm mức độ bằng chứng:
//   [THẬT]  — gọi máy chủ 8795 thật, không can thiệp.
//   [GIẢ-LẬP] — chặn `/v1/auth/login` và trả đúng KHUÔN + NGUYÊN VĂN câu chữ đã copy từ
//               apps/quanly-api/src/routes/auth.ts (423/429/403-HTML) hoặc cắt mạng (abort).
//               Dùng vì: khoá tài khoản thật đòi 5 lần sai trên 1 tài khoản CÓ THẬT (cấm), và 429 đòi
//               bơm >10 lượt/phút vào máy chủ. Phần MÁY CHỦ của các nhánh này KHÔNG được kiểm ở đây.
//
// Dùng: node apps/desktop/scripts/kiem-dang-nhap-ux.mjs
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const URL_WEB = process.env.QLWEB_URL || 'http://127.0.0.1:57914/';
const RA = resolve(import.meta.dirname, '../screenshots/dang-nhap-ux');
mkdirSync(RA, { recursive: true });

const TEN_THU = '__kiem_thu_ux__'; // KHÔNG tồn tại trong DB ⇒ sai mật khẩu không khoá tài khoản nào
const MK_THU = 'mat-khau-sai-co-y-11223344';

let datHet = true;
let soPhep = 0; // R198: ĐẾM ĐỘNG số phép kiểm thực chạy — cấm hard-code
const chot = (ok, ten) => {
  soPhep += 1;
  console.log((ok ? '  ✓ ' : '  ✗ ') + ten);
  if (!ok) {
    datHet = false;
    console.log('    >>> PHÉP KIỂM ĐỎ — ' + ten);
  }
};

// ── 0. CHẶN CỨNG: phải là bản sao ────────────────────────────────────────────────────────────────
let tenDb = '';
try {
  const r = await fetch(new URL('/v1/health', URL_WEB), { headers: { 'X-SigMa-Client': '1' } });
  const j = await r.json();
  tenDb = String(j?.db ?? '');
} catch (e) {
  console.error('[dang-nhap-ux] DỪNG: không gọi được /v1/health qua ' + URL_WEB + ' — ' + e.message);
  process.exit(1);
}
console.log('[dang-nhap-ux] máy chủ đang phục vụ DB =', tenDb);
if (!tenDb.endsWith('_thu')) {
  console.error('[dang-nhap-ux] DỪNG: DB "' + tenDb + '" KHÔNG phải bản sao (*_thu). Cấm chạy trên sổ thật.');
  process.exit(1);
}

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 1000 } });
const page = await ctx.newPage();

// ── Thu lỗi runtime: pageerror + console.error = ĐỎ (mẫu chốt §7.1) ──────────────────────────────
const loi = [];
page.on('pageerror', (e) => loi.push('pageerror: ' + String(e)));
// Các mã HTTP mình CỐ Ý gây ra trên /v1/auth/* (401 thăm dò phiên, 401/423/429 do kiểm) khiến Chromium
// ghi 1 dòng "Failed to load resource". Đó là hành vi ĐÚNG. Chỉ bỏ qua ĐÚNG những dòng đó, và chỉ khi
// mọi phản hồi lỗi quan sát được đều thuộc /v1/auth/ (R198: không nuốt lỗi lạ). Vẫn in ra cho LEAD thấy.
const phanHoiLoi = [];
page.on('response', (r) => {
  if (r.status() >= 400) phanHoiLoi.push(r.status() + ' ' + r.url());
});
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  const laCoY =
    /status of (401|403|423|429)/.test(t) &&
    phanHoiLoi.length > 0 &&
    phanHoiLoi.every((x) => x.includes('/v1/auth/'));
  const laAbortCoY = /Failed to load resource.*net::ERR_FAILED/.test(t) && phanHoiLoi.every((x) => x.includes('/v1/auth/'));
  if (laCoY || laAbortCoY) return;
  loi.push('console.error: ' + t);
});

const dem = (sel) => page.locator(sel);
const docBangLoi = () =>
  page.evaluate(() => {
    const el = document.querySelector('[data-kiem="bang-loi"]');
    if (!el) return null;
    const dn = el.querySelector('[data-kiem="dem-nguoc"]');
    return { ma: el.getAttribute('data-ma-loi'), chu: el.innerText.replace(/\s+/g, ' ').trim(), demNguoc: dn ? dn.innerText.trim() : null };
  });
const docNut = () =>
  page.evaluate(() => {
    const b = document.querySelector('[data-kiem="nut-dangnhap"]');
    if (!b) return null;
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    return {
      chu: b.innerText.replace(/\s+/g, ' ').trim(),
      khoa: b.disabled,
      ariaBusy: b.getAttribute('aria-busy'),
      nen: cs.backgroundColor,
      mauChu: cs.color,
      bo: cs.borderRadius,
      rong: Math.round(r.width),
      cao: Math.round(r.height)
    };
  });

/** Đặt một phản hồi GIẢ-LẬP cho /v1/auth/login (nguyên văn khuôn JSON của máy chủ). */
async function gaLogin(xuLy) {
  await page.route('**/v1/auth/login', xuLy);
}
async function boGaLogin() {
  await page.unroute('**/v1/auth/login');
}

async function moMan(w = 1920) {
  await page.setViewportSize({ width: w, height: 1000 });
  await page.goto(URL_WEB, { waitUntil: 'networkidle' });
  await page.waitForSelector('[data-kiem="o-ten"]', { timeout: 15000 });
  await page.waitForTimeout(400);
}

async function dienVaGui({ ten = TEN_THU, mk = MK_THU, bangEnter = false } = {}) {
  await dem('[data-kiem="o-ten"]').fill(ten);
  await dem('[data-kiem="o-matkhau"]').fill(mk);
  if (bangEnter) {
    await dem('[data-kiem="o-matkhau"]').press('Enter');
  } else {
    await dem('[data-kiem="nut-dangnhap"]').click();
  }
}

try {
  // ════════════════ MỤC 7 — con trỏ vào ô TÊN khi mở màn [THẬT] ════════════════
  console.log('\n── MỤC 7: con trỏ khi mở màn + sau khi sai ──');
  await page.context().clearCookies();
  await page.goto(URL_WEB, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear()); // bắt đầu sạch: không có tên nhớ sẵn
  await moMan(1920);
  const oDauTien = await page.evaluate(() => document.activeElement?.getAttribute('data-kiem') ?? document.activeElement?.tagName);
  console.log('  ô đang có con trỏ khi mở màn =', oDauTien);
  chot(oDauTien === 'o-ten', 'mở màn: con trỏ nằm ở ô TÊN ĐĂNG NHẬP');

  // ════════════════ MỤC 1 — sai tên/mật khẩu [THẬT, gọi 8795] ════════════════
  console.log('\n── MỤC 1a: sai tên đăng nhập / mật khẩu (gọi máy chủ THẬT) ──');
  await dienVaGui();
  await page.waitForSelector('[data-kiem="bang-loi"]', { timeout: 15000 });
  const l1 = await docBangLoi();
  await page.screenshot({ path: resolve(RA, 'muc1-sai-mat-khau.png') });
  console.log('  bảng lỗi:', JSON.stringify(l1));
  chot(l1?.ma === 'INVALID_CREDENTIALS', 'mã lỗi hiện đúng INVALID_CREDENTIALS (đo được bằng data-ma-loi)');
  chot(/không đúng/i.test(l1?.chu ?? ''), 'câu chữ nói rõ "tên đăng nhập hoặc mật khẩu không đúng"');
  chot(/5 lần/.test(l1?.chu ?? '') && /15 phút/.test(l1?.chu ?? ''), 'có cảnh báo trước: sai 5 lần → tạm khoá 15 phút');
  chot(l1?.demNguoc === null, 'sai mật khẩu thường: KHÔNG hiện đồng hồ đếm ngược (không bịa số)');

  // ════════════════ MỤC 7 — sai thì con trỏ về ô MẬT KHẨU [THẬT] ════════════════
  const oSauKhiSai = await page.evaluate(() => document.activeElement?.getAttribute('data-kiem') ?? document.activeElement?.tagName);
  const boiChon = await page.evaluate(() => {
    const el = document.querySelector('[data-kiem="o-matkhau"]');
    return el ? el.selectionEnd - el.selectionStart : -1;
  });
  console.log('  ô đang có con trỏ sau khi sai =', oSauKhiSai, '· số ký tự đang bôi chọn =', boiChon);
  chot(oSauKhiSai === 'o-matkhau', 'đăng nhập sai: con trỏ chuyển về ô MẬT KHẨU');
  chot(boiChon === MK_THU.length, 'mật khẩu cũ được bôi chọn sẵn (' + boiChon + '/' + MK_THU.length + ' ký tự) — gõ là thay');

  // ════════════════ MỤC 6 — giữ tên đăng nhập [THẬT] ════════════════
  console.log('\n── MỤC 6: giữ lại tên đăng nhập sau khi thất bại ──');
  const tenConLai = await dem('[data-kiem="o-ten"]').inputValue();
  console.log('  ô tên sau khi sai =', JSON.stringify(tenConLai));
  chot(tenConLai === TEN_THU, 'tên đăng nhập KHÔNG bị xoá trắng sau khi sai');
  // Nạp lại trang: tên vẫn còn (nhớ ở localStorage) — nhưng MẬT KHẨU tuyệt đối không được lưu.
  await moMan(1920);
  const tenSauKhiNapLai = await dem('[data-kiem="o-ten"]').inputValue();
  const mkSauKhiNapLai = await dem('[data-kiem="o-matkhau"]').inputValue();
  const khoLuuTru = await page.evaluate((mk) => {
    const quet = (s) => {
      const ra = [];
      for (let i = 0; i < s.length; i += 1) {
        const k = s.key(i);
        ra.push([k, s.getItem(k) ?? '']);
      }
      return ra;
    };
    const tatCa = [...quet(localStorage), ...quet(sessionStorage)];
    return {
      so: tatCa.length,
      khoa: tatCa.map(([k]) => k),
      coMatKhau: tatCa.some(([, v]) => v.includes(mk)),
      coChuMatKhau: tatCa.some(([k]) => /pass|mat.?khau|pwd/i.test(k))
    };
  }, MK_THU);
  console.log('  nạp lại trang → ô tên =', JSON.stringify(tenSauKhiNapLai), '· ô mật khẩu =', JSON.stringify(mkSauKhiNapLai));
  console.log('  kho lưu trữ trình duyệt:', JSON.stringify(khoLuuTru));
  chot(tenSauKhiNapLai === TEN_THU, 'nạp lại trang: tên đăng nhập được điền sẵn (đỡ gõ lại)');
  chot(mkSauKhiNapLai === '', 'nạp lại trang: ô mật khẩu TRỐNG');
  chot(khoLuuTru.coMatKhau === false, 'localStorage/sessionStorage KHÔNG chứa mật khẩu (quét nguyên văn)');
  chot(khoLuuTru.coChuMatKhau === false, 'không có khoá lưu trữ nào mang nghĩa mật khẩu');

  // ════════════════ MỤC 3 — nút con mắt hiện/ẩn mật khẩu [THẬT] ════════════════
  console.log('\n── MỤC 3: nút con mắt hiện/ẩn mật khẩu ──');
  await dem('[data-kiem="o-matkhau"]').fill('MatKhau#2026');
  const matTruoc = await page.evaluate(() => {
    const b = document.querySelector('[aria-label="Hiện mật khẩu"], [aria-label="Ẩn mật khẩu"]');
    const i = document.querySelector('[data-kiem="o-matkhau"]');
    const r = b?.getBoundingClientRect();
    const ri = i?.getBoundingClientRect();
    return {
      coNut: !!b,
      nhan: b?.getAttribute('aria-label') ?? null,
      kieuO: i?.getAttribute('type'),
      nutTrongO: !!(r && ri) && r.right <= ri.right + 1 && r.left > ri.left,
      nut: r ? { rong: Math.round(r.width), cao: Math.round(r.height) } : null
    };
  });
  console.log('  trước khi bấm:', JSON.stringify(matTruoc));
  chot(matTruoc.coNut, 'có nút con mắt trong ô mật khẩu');
  chot(matTruoc.kieuO === 'password', 'mặc định mật khẩu bị che (type=password)');
  chot(matTruoc.nutTrongO, 'nút con mắt nằm BÊN TRONG ô mật khẩu, mép phải');
  chot((matTruoc.nut?.cao ?? 0) >= 20 && (matTruoc.nut?.rong ?? 0) >= 20, 'nút con mắt đủ to để bấm (≥20×20px, đo ' + matTruoc.nut?.rong + '×' + matTruoc.nut?.cao + ')');
  await page.click('[aria-label="Hiện mật khẩu"]');
  const kieuSauKhiHien = await page.getAttribute('[data-kiem="o-matkhau"]', 'type');
  const chuThayDuoc = await dem('[data-kiem="o-matkhau"]').inputValue();
  console.log('  sau khi bấm mắt: type =', kieuSauKhiHien, '· giá trị đọc được =', chuThayDuoc);
  await page.screenshot({ path: resolve(RA, 'muc3-hien-mat-khau.png') });
  chot(kieuSauKhiHien === 'text', 'bấm con mắt → mật khẩu HIỆN ra (type=text)');
  await page.click('[aria-label="Ẩn mật khẩu"]');
  const kieuSauKhiAn = await page.getAttribute('[data-kiem="o-matkhau"]', 'type');
  console.log('  bấm lại: type =', kieuSauKhiAn);
  chot(kieuSauKhiAn === 'password', 'bấm lần nữa → mật khẩu ẨN lại (type=password)');
  chot((await dem('[data-kiem="o-matkhau"]').inputValue()) === 'MatKhau#2026', 'bật/tắt con mắt KHÔNG làm mất nội dung đã gõ');

  // ════════════════ MỤC 4 — cảnh báo CapsLock [THẬT về phía xử lý, event dựng tay] ════════════════
  // GHI RÕ GIỚI HẠN: Playwright/CDP KHÔNG đặt được cờ CapsLock của bàn phím thật (bitmask CDP chỉ có
  // Alt/Ctrl/Meta/Shift). Nên ta dựng ĐÚNG sự kiện mà bàn phím thật sinh ra — KeyboardEvent có
  // `modifierCapsLock: true` → `event.getModifierState('CapsLock')` trả true, đúng đường mã app đọc.
  console.log('\n── MỤC 4: cảnh báo CapsLock ──');
  await dem('[data-kiem="o-matkhau"]').click();
  const banDauCoCanhBao = (await dem('[data-kiem="canh-bao-capslock"]').count()) > 0;
  chot(banDauCoCanhBao === false, 'CapsLock tắt: KHÔNG hiện cảnh báo');
  await page.evaluate(() => {
    const el = document.querySelector('[data-kiem="o-matkhau"]');
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', code: 'KeyA', modifierCapsLock: true }));
  });
  await page.waitForTimeout(150);
  const chuCanhBao = (await dem('[data-kiem="canh-bao-capslock"]').count())
    ? (await dem('[data-kiem="canh-bao-capslock"]').innerText()).replace(/\s+/g, ' ').trim()
    : null;
  console.log('  CapsLock BẬT → cảnh báo =', JSON.stringify(chuCanhBao));
  await page.screenshot({ path: resolve(RA, 'muc4-capslock.png') });
  chot(!!chuCanhBao, 'CapsLock bật: HIỆN cảnh báo ngay khi gõ');
  chot(/CapsLock/i.test(chuCanhBao ?? '') && /hoa/i.test(chuCanhBao ?? ''), 'cảnh báo nói rõ CapsLock + chữ hoa/thường');
  await page.evaluate(() => {
    const el = document.querySelector('[data-kiem="o-matkhau"]');
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a', code: 'KeyA', modifierCapsLock: false }));
  });
  await page.waitForTimeout(150);
  chot((await dem('[data-kiem="canh-bao-capslock"]').count()) === 0, 'tắt CapsLock → cảnh báo tự mất');
  // gõ thật một lượt để chắc chắn trình xử lý không nổ với bàn phím thật
  await dem('[data-kiem="o-matkhau"]').press('b');
  chot(loi.length === 0, 'gõ bàn phím THẬT trong ô mật khẩu: không sinh lỗi runtime');

  // ════════════════ MỤC 5 — Enter để đăng nhập + trạng thái đang gửi [THẬT + hoãn phản hồi] ════════
  console.log('\n── MỤC 5a: nhấn Enter ở ô mật khẩu = đăng nhập (gọi máy chủ THẬT) ──');
  await moMan(1920);
  let soLuotGoi = 0;
  page.on('request', (r) => {
    if (r.url().includes('/v1/auth/login')) soLuotGoi += 1;
  });
  await dienVaGui({ bangEnter: true });
  await page.waitForSelector('[data-kiem="bang-loi"]', { timeout: 15000 });
  console.log('  số lượt gọi /v1/auth/login sau khi nhấn Enter =', soLuotGoi);
  chot(soLuotGoi === 1, 'nhấn Enter ở ô mật khẩu gửi ĐÚNG 1 lượt đăng nhập');
  chot((await docBangLoi())?.ma === 'INVALID_CREDENTIALS', 'Enter đi đúng đường đăng nhập (nhận lỗi từ máy chủ)');

  console.log('\n── MỤC 5b: đang gửi thì khoá nút, không cho bấm 2 lần (hoãn phản hồi 1,5s) ──');
  await moMan(1920);
  soLuotGoi = 0;
  await gaLogin(async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'INVALID_CREDENTIALS', message: 'Tên đăng nhập hoặc mật khẩu không đúng.' })
    });
  });
  await dem('[data-kiem="o-ten"]').fill(TEN_THU);
  await dem('[data-kiem="o-matkhau"]').fill(MK_THU);
  await dem('[data-kiem="nut-dangnhap"]').click();
  await page.waitForTimeout(350);
  const nutDangGui = await docNut();
  console.log('  nút lúc ĐANG GỬI:', JSON.stringify(nutDangGui));
  await page.screenshot({ path: resolve(RA, 'muc5-dang-gui.png') });
  chot(nutDangGui?.khoa === true, 'đang gửi: nút Đăng nhập BỊ KHOÁ');
  chot(/Đang đăng nhập/.test(nutDangGui?.chu ?? ''), 'đang gửi: nút hiện trạng thái "Đang đăng nhập…"');
  chot(nutDangGui?.ariaBusy === 'true', 'đang gửi: nút có aria-busy="true" (trình đọc màn hình biết)');
  const coVongXoay = await page.evaluate(() => !!document.querySelector('[data-kiem="nut-dangnhap"] .animate-spin'));
  chot(coVongXoay, 'đang gửi: có vòng xoay báo đang chạy');
  // bấm thêm 3 lần + Enter 2 lần trong lúc đang gửi → vẫn chỉ 1 lượt gọi
  for (let i = 0; i < 3; i += 1) await dem('[data-kiem="nut-dangnhap"]').click({ force: true, timeout: 2000 }).catch(() => {});
  await dem('[data-kiem="o-matkhau"]').press('Enter').catch(() => {});
  await dem('[data-kiem="o-matkhau"]').press('Enter').catch(() => {});
  await page.waitForSelector('[data-kiem="bang-loi"]', { timeout: 15000 });
  console.log('  tổng lượt gọi /v1/auth/login sau 1 lần bấm + 3 lần bấm thêm + 2 Enter =', soLuotGoi);
  chot(soLuotGoi === 1, 'bấm/Enter liên tục lúc đang gửi: CHỈ gửi 1 lượt (không nhân đôi)');
  const nutSauKhiXong = await docNut();
  console.log('  nút sau khi xong:', JSON.stringify(nutSauKhiXong));
  chot(nutSauKhiXong?.khoa === false && nutSauKhiXong?.chu === 'Đăng nhập', 'xong lượt gửi: nút mở lại, chữ về "Đăng nhập"');
  await boGaLogin();

  // ════════════════ MỤC 1+2 — tài khoản bị KHOÁ + đếm ngược [GIẢ-LẬP 423] ════════════════
  // Câu chữ dưới đây COPY NGUYÊN VĂN từ apps/quanly-api/src/routes/auth.ts dòng 181-185.
  console.log('\n── MỤC 2: tài khoản bị khoá → đếm ngược + khoá nút [GIẢ-LẬP 423 theo nguyên văn auth.ts] ──');
  await moMan(1920);
  await gaLogin((route) =>
    route.fulfill({
      status: 423,
      contentType: 'application/json',
      body: JSON.stringify({
        ok: false,
        error: 'STATUS_LOCKED',
        message: 'Tài khoản tạm khóa do sai mật khẩu quá 5 lần. Tự mở sau 15 phút, hoặc liên hệ quản trị mở sớm.'
      })
    })
  );
  await dienVaGui();
  await page.waitForSelector('[data-kiem="dem-nguoc"]', { timeout: 15000 });
  const khoa1 = await docBangLoi();
  const nutKhoa1 = await docNut();
  console.log('  bảng lỗi khoá:', JSON.stringify(khoa1));
  console.log('  nút khi bị khoá:', JSON.stringify(nutKhoa1));
  await page.screenshot({ path: resolve(RA, 'muc2-khoa-dem-nguoc.png') });
  chot(khoa1?.ma === 'STATUS_LOCKED', 'mã lỗi khoá tài khoản = STATUS_LOCKED');
  chot(/Tự mở sau 15 phút/.test(khoa1?.demNguoc ?? ''), 'hiện "Tự mở sau 15 phút" (đọc được: ' + khoa1?.demNguoc + ')');
  chot(nutKhoa1?.khoa === true, 'đang tạm khoá: nút Đăng nhập bị khoá');
  chot(/Tạm khoá — còn/.test(nutKhoa1?.chu ?? ''), 'chữ trên nút nói rõ đang tạm khoá + còn bao lâu (' + nutKhoa1?.chu + ')');
  await page.waitForTimeout(2600);
  const khoa2 = await docBangLoi();
  console.log('  sau 2,6 giây, đồng hồ =', JSON.stringify(khoa2?.demNguoc));
  chot(khoa2?.demNguoc !== khoa1?.demNguoc && /14 phút/.test(khoa2?.demNguoc ?? ''), 'đồng hồ TỰ CHẠY LÙI (15 phút → ' + khoa2?.demNguoc + ')');
  // đổi sang tài khoản khác thì bỏ khoá nút (không chặn oan người muốn đăng nhập tài khoản khác)
  await dem('[data-kiem="o-ten"]').fill('mot_tai_khoan_khac');
  await page.waitForTimeout(150);
  const nutSauDoiTen = await docNut();
  console.log('  đổi sang tên đăng nhập khác → nút:', JSON.stringify(nutSauDoiTen));
  chot(nutSauDoiTen?.khoa === false, 'đổi sang tài khoản KHÁC: nút mở lại (không chặn oan)');

  // ── đếm ngược về 0 thì NÚT MỞ LẠI: dùng gói khoá 1 phút rồi chờ thật ──
  console.log('\n── MỤC 2b: chờ đồng hồ về 0 (gói khoá 1 phút) → nút phải mở lại. Mất ~65 giây… ──');
  await moMan(1920);
  await boGaLogin();
  await gaLogin((route) =>
    route.fulfill({
      status: 423,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'STATUS_LOCKED', message: 'Tài khoản tạm khóa do sai mật khẩu quá 5 lần. Tự mở sau 1 phút, hoặc liên hệ quản trị mở sớm.' })
    })
  );
  await dienVaGui();
  await page.waitForSelector('[data-kiem="dem-nguoc"]', { timeout: 15000 });
  const batDau = await docBangLoi();
  console.log('  mốc bắt đầu:', JSON.stringify(batDau?.demNguoc), '· nút khoá =', (await docNut())?.khoa);
  await page.waitForTimeout(64000);
  const hetKhoa = await docBangLoi();
  const nutHetKhoa = await docNut();
  console.log('  sau 64 giây → đồng hồ:', JSON.stringify(hetKhoa?.demNguoc), '· nút:', JSON.stringify(nutHetKhoa));
  await page.screenshot({ path: resolve(RA, 'muc2-het-khoa.png') });
  chot(/Đã hết thời gian tạm khoá/.test(hetKhoa?.demNguoc ?? ''), 'hết giờ: câu chữ chuyển sang "Đã hết thời gian tạm khoá"');
  chot(!/Tài khoản đang bị khoá/.test(hetKhoa?.chu ?? ''), 'hết giờ: TIÊU ĐỀ không còn nói "đang bị khoá" (hết mâu thuẫn chữ)');
  chot(nutHetKhoa?.khoa === false, 'hết giờ: nút Đăng nhập TỰ MỞ LẠI');
  chot(nutHetKhoa?.chu === 'Đăng nhập', 'hết giờ: chữ trên nút về "Đăng nhập"');
  await boGaLogin();

  // ════════════════ MỤC 1 — 429 gọi quá nhiều lần [GIẢ-LẬP theo nguyên văn auth.ts] ════════════════
  console.log('\n── MỤC 1b: 429 gọi quá nhiều lần [GIẢ-LẬP theo nguyên văn loginRateLimiter] ──');
  await moMan(1920);
  await gaLogin((route) =>
    route.fulfill({
      status: 429,
      contentType: 'application/json',
      body: JSON.stringify({ ok: false, error: 'RATE_LIMITED', message: 'Quá nhiều lần đăng nhập, vui lòng thử lại sau ít phút.' })
    })
  );
  await dienVaGui();
  await page.waitForSelector('[data-kiem="bang-loi"]', { timeout: 15000 });
  const l429 = await docBangLoi();
  const nut429 = await docNut();
  console.log('  bảng lỗi 429:', JSON.stringify(l429), '· nút:', JSON.stringify(nut429));
  await page.screenshot({ path: resolve(RA, 'muc1-429.png') });
  chot(l429?.ma === 'RATE_LIMITED', 'mã lỗi 429 = RATE_LIMITED');
  chot(/quá nhiều lần/i.test(l429?.chu ?? ''), 'câu chữ nói rõ đã thử quá nhiều lần');
  chot(/Thử lại sau khoảng/.test(l429?.demNguoc ?? ''), 'có đồng hồ "thử lại sau khoảng" (' + l429?.demNguoc + ')');
  chot(nut429?.khoa === false, '429: KHÔNG khoá nút (cửa sổ chặn có thể hết sớm hơn — không chặn oan)');
  await boGaLogin();

  // ════════════════ MỤC 1 — mất mạng [THẬT: cắt kết nối] ════════════════
  console.log('\n── MỤC 1c: không nối được máy chủ (cắt thật request) ──');
  await moMan(1920);
  await gaLogin((route) => route.abort());
  await dienVaGui();
  await page.waitForSelector('[data-kiem="bang-loi"]', { timeout: 15000 });
  const lMang = await docBangLoi();
  console.log('  bảng lỗi mạng:', JSON.stringify(lMang));
  await page.screenshot({ path: resolve(RA, 'muc1-mat-mang.png') });
  chot(lMang?.ma === 'NETWORK', 'mã lỗi khi cắt mạng = NETWORK');
  chot(/Không nối được máy chủ/.test(lMang?.chu ?? ''), 'câu chữ nói rõ không nối được máy chủ');
  chot(/127\.0\.0\.1|localhost|:/.test(lMang?.chu ?? ''), 'có nêu ĐỊA CHỈ máy chủ đang gọi để người dùng biết kiểm ở đâu');
  await boGaLogin();

  // ════════════════ MỤC 1 — cổng bảo mật chặn (403 + HTML) ════════════════
  // PHÁT HIỆN KHI ĐO THẬT (12/11): BẢN WEB không sinh mã ACCESS_BLOCKED. Nhánh đó chỉ nằm trong
  // apps/desktop/src/preload/index.ts (bản desktop); apps/desktop/src/web-shim/api.ts KHÔNG có
  // (đã grep cả apps/desktop/src: chỉ 1 chỗ duy nhất ở preload). Trên web, 403 + HTML rơi vào
  // BAD_RESPONSE. Hai lớp shim đều CẤM sửa trong phần việc này ⇒ kiểm theo ĐÚNG hành vi thật của
  // từng bản: web = BAD_RESPONSE (câu chữ vẫn phải nêu khả năng cổng bảo mật), desktop = ACCESS_BLOCKED.
  console.log('\n── MỤC 1d: bị cổng bảo mật chặn (403 + HTML, không phải JSON) ──');
  await moMan(1920);
  await gaLogin((route) => route.fulfill({ status: 403, contentType: 'text/html', body: '<html><body>Cloudflare Access denied</body></html>' }));
  await dienVaGui();
  await page.waitForSelector('[data-kiem="bang-loi"]', { timeout: 15000 });
  const lCong = await docBangLoi();
  console.log('  [BẢN WEB] 403+HTML → bảng lỗi:', JSON.stringify(lCong));
  await page.screenshot({ path: resolve(RA, 'muc1-cong-bao-mat-web.png') });
  chot(lCong?.ma === 'BAD_RESPONSE', 'bản web: 403+HTML ra mã BAD_RESPONSE (đúng web-shim, KHÔNG phải ACCESS_BLOCKED)');
  chot(/HTTP 403/.test(lCong?.chu ?? ''), 'bản web: câu chữ nêu rõ mã HTTP 403 để quản trị lần ra');
  chot(/cổng bảo mật/i.test(lCong?.chu ?? ''), 'bản web: câu chữ VẪN nêu khả năng bị cổng bảo mật chen vào');
  await boGaLogin();

  // Nhánh ACCESS_BLOCKED (bản DESKTOP): thay `window.api.login` bằng đúng KHUÔN phản hồi mà
  // preload/index.ts dòng 143-150 trả về, để kiểm ÁNH XẠ trong Login.tsx — phần duy nhất thuộc việc này.
  console.log('\n── MỤC 1d-2: ánh xạ ACCESS_BLOCKED (khuôn phản hồi của bản desktop) ──');
  await moMan(1920);
  await page.evaluate(() => {
    window.api.login = async () => ({
      ok: false,
      error: 'ACCESS_BLOCKED',
      message: 'Máy chủ đã bật cổng bảo mật nhưng máy này CHƯA được cấp thẻ. Vào Cấu hình máy chủ để nhập thẻ dịch vụ.'
    });
  });
  await dienVaGui();
  await page.waitForSelector('[data-kiem="bang-loi"]', { timeout: 15000 });
  const lCong2 = await docBangLoi();
  console.log('  [KHUÔN DESKTOP] →', JSON.stringify(lCong2));
  await page.screenshot({ path: resolve(RA, 'muc1-cong-bao-mat-desktop.png') });
  chot(lCong2?.ma === 'ACCESS_BLOCKED', 'ánh xạ đúng mã ACCESS_BLOCKED');
  chot(/cổng bảo mật/i.test(lCong2?.chu ?? ''), 'ACCESS_BLOCKED: câu chữ nói rõ bị cổng bảo mật chặn');
  chot(/thẻ dịch vụ/i.test(lCong2?.chu ?? ''), 'ACCESS_BLOCKED: giữ nguyên hướng dẫn "nhập thẻ dịch vụ" của máy chủ');

  // ════════════════ MỤC 1 — tài khoản bị vô hiệu hoá [GIẢ-LẬP 401 STATUS_DISABLED] ════════════════
  console.log('\n── MỤC 1e: tài khoản bị vô hiệu hoá / chưa kích hoạt ──');
  for (const [ma, mo, mong] of [
    ['STATUS_DISABLED', 'Tài khoản đã ngưng sử dụng.', /vô hiệu hoá/i],
    ['STATUS_PENDING', 'Tài khoản chưa được kích hoạt.', /chưa được kích hoạt/i]
  ]) {
    await moMan(1920);
    await gaLogin((route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: ma, message: mo }) }));
    await dienVaGui();
    await page.waitForSelector('[data-kiem="bang-loi"]', { timeout: 15000 });
    const lx = await docBangLoi();
    console.log('  ' + ma + ' →', JSON.stringify(lx));
    chot(lx?.ma === ma, 'mã lỗi hiện đúng ' + ma);
    chot(mong.test(lx?.chu ?? ''), ma + ': câu chữ phân biệt rõ trường hợp này');
    chot(lx?.demNguoc === null, ma + ': không bịa đồng hồ đếm ngược');
    if (ma === 'STATUS_DISABLED') await page.screenshot({ path: resolve(RA, 'muc1-vo-hieu-hoa.png') });
    await boGaLogin();
  }

  // ════════════════ MỤC 1 — khoá TỪ TRƯỚC (có thể do admin): KHÔNG được bịa đồng hồ ════════════════
  console.log('\n── MỤC 1f: khoá từ trước (admin khoá tay) → cấm bịa đồng hồ tự mở ──');
  await moMan(1920);
  await gaLogin((route) =>
    route.fulfill({ status: 423, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'STATUS_LOCKED', message: 'Tài khoản đã bị khóa.' }) })
  );
  await dienVaGui();
  await page.waitForSelector('[data-kiem="bang-loi"]', { timeout: 15000 });
  const lKhoaCu = await docBangLoi();
  const nutKhoaCu = await docNut();
  console.log('  khoá-từ-trước →', JSON.stringify(lKhoaCu), '· nút:', JSON.stringify(nutKhoaCu));
  await page.screenshot({ path: resolve(RA, 'muc1-khoa-tu-truoc.png') });
  chot(lKhoaCu?.ma === 'STATUS_LOCKED', 'khoá-từ-trước: mã STATUS_LOCKED');
  chot(lKhoaCu?.demNguoc === null, 'khoá-từ-trước: KHÔNG hiện đồng hồ (máy chủ không cho biết mốc bắt đầu)');
  chot(/liên hệ quản trị/i.test(lKhoaCu?.chu ?? ''), 'khoá-từ-trước: chỉ đường "liên hệ quản trị"');
  chot(nutKhoaCu?.khoa === false, 'khoá-từ-trước: không khoá nút (admin có thể mở bất cứ lúc nào)');
  await boGaLogin();

  // ════════════════ MỤC 1 — thiếu ô nhập (kiểm ngay trên máy, không gọi máy chủ) ════════════════
  console.log('\n── MỤC 1g: bỏ trống ô nhập ──');
  await moMan(1920);
  soLuotGoi = 0;
  const luotTruoc = soLuotGoi;
  await dem('[data-kiem="o-ten"]').fill('');
  await dem('[data-kiem="o-matkhau"]').fill('');
  await dem('[data-kiem="nut-dangnhap"]').click();
  await page.waitForSelector('[data-kiem="bang-loi"]', { timeout: 5000 });
  const lThieu = await docBangLoi();
  const oDangChon = await page.evaluate(() => document.activeElement?.getAttribute('data-kiem'));
  console.log('  bỏ trống cả 2 ô →', JSON.stringify(lThieu), '· con trỏ ở', oDangChon, '· lượt gọi máy chủ =', soLuotGoi - luotTruoc);
  chot(/thiếu tên đăng nhập/i.test(lThieu?.chu ?? ''), 'bỏ trống: chỉ RÕ còn thiếu ô nào');
  chot(oDangChon === 'o-ten', 'bỏ trống tên: con trỏ nhảy về ô tên');
  chot(soLuotGoi - luotTruoc === 0, 'bỏ trống: KHÔNG gọi máy chủ vô ích');

  // ════════════════ ẢNH + SỐ ĐO Ở 1920 / 1440 / 1150 ════════════════
  console.log('\n── Ảnh + số đo theo bề ngang (1920 / 1440 / 1150) ──');
  for (const w of [1920, 1440, 1150]) {
    await moMan(w);
    await page.screenshot({ path: resolve(RA, 'man-' + w + '.png') });
    // trạng thái sạch
    const d0 = await page.evaluate(() => {
      const r = (s) => {
        const el = document.querySelector(s);
        if (!el) return null;
        const b = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return { rong: Math.round(b.width), cao: Math.round(b.height), bo: cs.borderRadius };
      };
      return {
        oTen: r('[data-kiem="o-ten"]'),
        oMk: r('[data-kiem="o-matkhau"]'),
        nut: r('[data-kiem="nut-dangnhap"]'),
        cuonDoc: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        tranNgang: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        racChu: /NaN|undefined|Infinity/.test(document.body.innerText)
      };
    });
    console.log('  @' + w + 'px sạch:', JSON.stringify(d0));
    chot(d0.cuonDoc <= 0 && d0.tranNgang <= 0, '@' + w + ' trạng thái sạch: không cuộn dọc / không tràn ngang');
    chot(d0.racChu === false, '@' + w + ' không có ô rác NaN/undefined/Infinity');
    chot(d0.oTen?.cao === d0.oMk?.cao, '@' + w + ' ô tên và ô mật khẩu CÙNG chiều cao (' + d0.oTen?.cao + ' vs ' + d0.oMk?.cao + 'px)');
    chot(d0.oTen?.bo === d0.oMk?.bo, '@' + w + ' ô tên và ô mật khẩu CÙNG bo góc (' + d0.oTen?.bo + ' vs ' + d0.oMk?.bo + ')');
    const boNut = Number(String(d0.nut?.bo ?? '0').replace('px', ''));
    chot(boNut > 0 && boNut <= 6, '@' + w + ' nút chính bo góc chữ nhật ~3,4px (đo ' + boNut + 'px)');

    // trạng thái CÓ ĐỦ bảng lỗi + cảnh báo CapsLock + đồng hồ (ảnh "chật nhất")
    await gaLogin((route) =>
      route.fulfill({
        status: 423,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'STATUS_LOCKED', message: 'Tài khoản tạm khóa do sai mật khẩu quá 5 lần. Tự mở sau 15 phút, hoặc liên hệ quản trị mở sớm.' })
      })
    );
    await dienVaGui();
    await page.waitForSelector('[data-kiem="dem-nguoc"]', { timeout: 15000 });
    await page.evaluate(() => {
      const el = document.querySelector('[data-kiem="o-matkhau"]');
      el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', code: 'KeyA', modifierCapsLock: true }));
    });
    await page.waitForTimeout(250);
    await page.screenshot({ path: resolve(RA, 'man-' + w + '-day-canh-bao.png') });
    const d1 = await page.evaluate(() => {
      const the = document.querySelector('[data-kiem="bang-loi"]')?.closest('.rounded-2xl');
      const b = the?.getBoundingClientRect();
      const bl = document.querySelector('[data-kiem="bang-loi"]')?.getBoundingClientRect();
      const cl = document.querySelector('[data-kiem="canh-bao-capslock"]')?.getBoundingClientRect();
      return {
        theRong: b ? Math.round(b.width) : null,
        theCao: b ? Math.round(b.height) : null,
        bangLoiTrongThe: !!(b && bl) && bl.left >= b.left - 1 && bl.right <= b.right + 1,
        capsTrongThe: !!(b && cl) && cl.left >= b.left - 1 && cl.right <= b.right + 1,
        coCapsLock: !!cl,
        cuonDoc: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        tranNgang: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        chuTran: [...document.querySelectorAll('[data-kiem="bang-loi"] *, [data-kiem="canh-bao-capslock"]')].some(
          (el) => el.scrollWidth > el.clientWidth + 1
        )
      };
    });
    console.log('  @' + w + 'px đầy cảnh báo:', JSON.stringify(d1));
    chot(d1.coCapsLock, '@' + w + ' hiện được cả cảnh báo CapsLock cùng lúc với bảng lỗi');
    chot(d1.bangLoiTrongThe && d1.capsTrongThe, '@' + w + ' bảng lỗi + cảnh báo nằm GỌN trong thẻ, không tràn ra ngoài');
    chot(d1.tranNgang <= 0, '@' + w + ' đầy cảnh báo: vẫn không tràn ngang');
    chot(d1.chuTran === false, '@' + w + ' không có chữ nào bị cắt cụt trong bảng lỗi/cảnh báo');
    await boGaLogin();
  }
} catch (e) {
  console.error('\n[dang-nhap-ux] LỖI KHI CHẠY:', e.message);
  console.error(e.stack);
  datHet = false;
} finally {
  console.log('\n[dang-nhap-ux] phản hồi ≥400 quan sát được:', phanHoiLoi.length ? phanHoiLoi.join(' | ') : '(không có)');
  if (loi.length) {
    datHet = false;
    console.log('[dang-nhap-ux] *** CÓ ' + loi.length + ' LỖI RUNTIME → KHÔNG ĐẠT ***');
    loi.slice(0, 15).forEach((x) => console.log('   ', x));
  } else {
    console.log('[dang-nhap-ux] không có lỗi runtime (pageerror/console.error)');
  }
  console.log('[dang-nhap-ux] SỐ PHÉP KIỂM ĐÃ CHẠY (đếm động) =', soPhep);
  console.log('[dang-nhap-ux] KẾT LUẬN MÁY ĐO:', datHet ? 'không phép kiểm nào đỏ' : '*** CÒN PHÉP KIỂM ĐỎ ***');
  console.log('[dang-nhap-ux] ảnh ở:', RA);
  console.log('[dang-nhap-ux] LƯU Ý R200: máy chỉ nộp số + ảnh. LEAD tự chạy lại + tự nhìn ảnh mới được tick xanh.');
  await browser.close();
  process.exitCode = datHet ? 0 : 1;
}
