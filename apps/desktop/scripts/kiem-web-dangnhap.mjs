// CỔNG KIỂM MÀN ĐĂNG NHẬP BẢN WEB (Admin Demo 7/11: "mở màn đăng nhập lên kiểm chứng đúng brand mới").
// Đo SỐ + chụp ẢNH để LEAD tự nhìn (R200). Không tự báo xanh bằng lời.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const URL = process.env.QLWEB_URL || 'http://127.0.0.1:57913/';
const RA = resolve(import.meta.dirname, '../screenshots/web-dangnhap');
mkdirSync(RA, { recursive: true });

let datHet = true;
const chot = (ok, ten) => {
  if (!ok) {
    datHet = false;
    console.log('  >>> PHÉP KIỂM ĐỎ — ' + ten);
  }
};

const browser = await chromium.launch();
const page = await browser.newPage();
const loi = [];
page.on('pageerror', (e) => loi.push(String(e)));
// Ở màn ĐĂNG NHẬP, bản web CỐ Ý hỏi `/v1/auth/me` để xem còn phiên không. Chưa đăng nhập thì máy chủ
// trả 401 và Chromium ghi 1 dòng "Failed to load resource" — đó là hành vi ĐÚNG, không phải lỗi.
// Chỉ bỏ qua đúng trường hợp này, và CHỈ KHI mọi lượt 401 quan sát được đều thuộc /v1/auth/* (R198:
// không nuốt lỗi lạ). Vẫn in ra để không ai tưởng là đã giấu.
const bon401 = [];
page.on('response', (r) => {
  if (r.status() === 401) bon401.push(r.url());
});
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  const la401ThamDo = /status of 401/.test(t) && bon401.length > 0 && bon401.every((u) => u.includes('/v1/auth/'));
  if (la401ThamDo) {
    console.log('     (bỏ qua) 401 thăm dò phiên ở màn đăng nhập:', bon401.join(', '));
    return;
  }
  loi.push('console:' + t);
});

try {
  for (const w of [1920, 1440, 1150]) {
    await page.setViewportSize({ width: w, height: 900 });
    await page.goto(URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: resolve(RA, 'dangnhap-' + w + '.png'), fullPage: false });
    console.log('  ảnh dangnhap-' + w + '.png');

    const d = await page.evaluate(() => {
      const nut = [...document.querySelectorAll('button')].find((b) => /Đăng nhập/i.test(b.textContent || ''));
      const oTen = document.querySelector('input:not([type=password])');
      const oMk = document.querySelector('input[type=password]');
      const cs = (el) => (el ? getComputedStyle(el) : null);
      const hop = (el) => (el ? el.getBoundingClientRect() : null);
      const cn = cs(nut);
      const rn = hop(nut);
      const rt = hop(oTen);
      const rm = hop(oMk);
      const chu = document.body.innerText;
      return {
        coNutDangNhap: !!nut,
        nut: rn ? { rong: Math.round(rn.width), cao: Math.round(rn.height), bo: cn.borderRadius, nen: cn.backgroundColor, mauChu: cn.color } : null,
        oTen: rt ? { rong: Math.round(rt.width), cao: Math.round(rt.height) } : null,
        oMatKhau: rm ? { rong: Math.round(rm.width), cao: Math.round(rm.height) } : null,
        nutCuaSo: document.querySelectorAll('[aria-label="Thu nhỏ"], [aria-label="Phóng to"], [aria-label="Đóng"]').length,
        coGhiNhoMay: /Ghi nhớ đăng nhập/i.test(chu),
        coBadgeNguon: /Máy chủ|Dữ liệu/i.test(chu),
        chuTrenMan: chu.replace(/\s+/g, ' ').trim().slice(0, 200),
        phong: getComputedStyle(document.body).fontFamily,
        nenTrang: getComputedStyle(document.body).backgroundColor,
        cuonDoc: document.documentElement.scrollHeight - document.documentElement.clientHeight,
        tranNgang: document.documentElement.scrollWidth - document.documentElement.clientWidth
      };
    });
    console.log('  [màn đăng nhập @' + w + 'px]', JSON.stringify(d, null, 0));

    chot(d.coNutDangNhap, 'có nút Đăng nhập @' + w);
    chot(!!d.oTen && !!d.oMatKhau, 'có ô tên đăng nhập + mật khẩu @' + w);
    // BRAND CHỐT: nút chữ nhật bo ~3,4px (không phải viên thuốc), ô nhập cao ≥ 36px
    const bo = Number(String(d.nut?.bo ?? '0').replace('px', ''));
    console.log('     bo góc nút =', bo + 'px', '· cao nút =', d.nut?.cao + 'px', '· ô nhập cao =', d.oTen?.cao + 'px');
    chot(bo > 0 && bo <= 6, 'nút bo góc chữ nhật ~3,4px (đo ' + bo + 'px) @' + w);
    chot((d.oTen?.cao ?? 0) >= 36, 'ô nhập cao ≥36px (CSS brand đã nạp đủ) @' + w);
    chot((d.nut?.rong ?? 0) >= 200, 'nút Đăng nhập rộng ≥200px @' + w);
    // bản WEB: không có nút cửa sổ kiểu desktop, không có "Ghi nhớ đăng nhập" (safeStorage là của Electron)
    chot(d.nutCuaSo === 0, 'bản web KHÔNG có nút cửa sổ desktop @' + w);
    chot(d.coGhiNhoMay === false, 'bản web KHÔNG có ô "Ghi nhớ đăng nhập" @' + w);
    chot(d.coBadgeNguon, 'có badge nguồn máy chủ/DB @' + w);
    chot(d.cuonDoc <= 0 && d.tranNgang <= 0, 'trang không cuộn dọc / không tràn ngang @' + w);
  }
} catch (e) {
  console.error('[web-dangnhap] LỖI:', e.message);
  datHet = false;
} finally {
  if (loi.length) {
    datHet = false;
    console.log('[web-dangnhap] *** CÓ ' + loi.length + ' LỖI RUNTIME → KHÔNG ĐẠT ***');
    loi.slice(0, 10).forEach((x) => console.log('   ', x));
  } else console.log('[web-dangnhap] không có lỗi runtime');
  console.log('[web-dangnhap] KẾT LUẬN:', datHet ? 'không phép kiểm nào đỏ' : '*** CÒN PHÉP KIỂM ĐỎ ***');
  console.log('[web-dangnhap] ảnh ở:', RA);
  await browser.close();
  process.exitCode = datHet ? 0 : 1;
}
