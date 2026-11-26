// CỔNG KIỂM "TAB DOANH SỐ RA FULL MÀN" (Admin Demo 7/11).
// Điều khiển THẬT: bấm tab, bấm nút 3 gạch, đo toạ độ + kiểm trang có cuộn ngoài hay không.
// Chụp ảnh cho LEAD tự nhìn (R200). Agent/script KHÔNG tự báo xanh bằng lời.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const GOC = resolve(import.meta.dirname, '..');
const RA = resolve(GOC, 'screenshots/doanhso-fullman');
mkdirSync(RA, { recursive: true });

let datHet = true;
const chot = (ok, ten) => {
  if (!ok) {
    datHet = false;
    console.log('  >>> PHÉP KIỂM ĐỎ — ' + ten);
  }
};

const server = await createServer({
  root: resolve(GOC, 'src/renderer'),
  plugins: [react(), tailwindcss()],
  server: { port: 0 },
  logLevel: 'error'
});
await server.listen();
const cong = server.config.server.port ?? server.httpServer.address().port;
const base = `http://localhost:${cong}/_man-dashboard.html`;
console.log('[doanhso-full] ' + base);

const browser = await chromium.launch();
const page = await browser.newPage();
const loi = [];
page.on('pageerror', (e) => loi.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') loi.push('console:' + m.text());
});

const doKhung = () =>
  page.evaluate(() => {
    const aside = document.querySelector('aside');
    const khung = document.querySelector('[data-kiem="khung-bang"]');
    const el = document.documentElement;
    const mucMenu = [...document.querySelectorAll('aside nav button')].map((b) => (b.textContent || '').trim());
    return {
      coMenuTrai: !!aside,
      rongMenuTrai: aside ? Math.round(aside.getBoundingClientRect().width) : 0,
      mucDauTien: mucMenu[0] ?? null,
      soMuc: mucMenu.length,
      coBang: !!khung,
      khungTrai: khung ? Math.round(khung.getBoundingClientRect().left) : null,
      khungRong: khung ? Math.round(khung.getBoundingClientRect().width) : null,
      khungDay: khung ? Math.round(khung.getBoundingClientRect().bottom) : null,
      caoCuaSo: window.innerHeight,
      rongCuaSo: window.innerWidth,
      cuonDocNgoai: el.scrollHeight - el.clientHeight,
      tranNgangNgoai: el.scrollWidth - el.clientWidth,
      cuonDocMain: (() => {
        const m = document.querySelector('main');
        return m ? m.scrollHeight - m.clientHeight : null;
      })(),
      coNutMenu: !!document.querySelector('[data-kiem="nut-menu"]'),
      // Nút 3 gạch phải nằm CÙNG HÀNG với tiêu đề màn (Admin Demo 7/11), không phải nút nổi đè nội dung.
      lechTamNutVsTieuDe: (() => {
        const n = document.querySelector('[data-kiem="nut-menu"]');
        const h = [...document.querySelectorAll('h2')].find((x) => (x.textContent || '').trim() === 'DOANH SỐ');
        if (!n || !h) return null;
        const a = n.getBoundingClientRect();
        const b = h.getBoundingClientRect();
        return Math.round(Math.abs(a.top + a.height / 2 - (b.top + b.height / 2)));
      })(),
      nutNoiDeLen: (() => {
        const n = document.querySelector('[data-kiem="nut-menu"]');
        return n ? getComputedStyle(n).position === 'fixed' : null;
      })(),
      conChuAlpha: /\bAlpha\s*\//.test(document.body.innerText)
    };
  });

try {
  for (const [w, h] of [[1920, 1080], [1440, 900]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(base, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);

    // ── 1. VÀO APP là vào thẳng DOANH SỐ, FULL MÀN (Doanh Số đứng đầu menu nên là tab mặc định) ──
    const banDau = await doKhung();
    console.log(`  [khởi động @${w}] `, JSON.stringify(banDau));
    await page.screenshot({ path: resolve(RA, `1-khoi-dong-${w}.png`) });
    chot(banDau.coMenuTrai === false, `vào app là FULL MÀN, menu trái ẩn @${w}`);
    chot(banDau.coBang === true, `màn Doanh Số có bảng @${w}`);
    chot((banDau.khungTrai ?? 999) <= 56, `bảng sát mép trái (đang ${banDau.khungTrai}px — đệm của trang) @${w}`);
    chot((banDau.khungRong ?? 0) >= w - 110, `bảng chiếm gần trọn bề ngang (đang ${banDau.khungRong}/${w}px) @${w}`);
    chot(banDau.cuonDocNgoai <= 0 && banDau.tranNgangNgoai <= 0, `TRANG NGOÀI không cuộn dọc/tràn ngang @${w}`);
    chot((banDau.cuonDocMain ?? 0) <= 0, `KHÔNG có thanh cuộn thứ hai ở vùng nội dung (dư ${banDau.cuonDocMain}px) @${w}`);
    chot((banDau.khungDay ?? 0) <= h, `đáy bảng nằm TRONG màn (đáy ${banDau.khungDay}px / màn ${h}px) @${w}`);
    chot(banDau.coNutMenu === true, `có nút 3 gạch @${w}`);
    console.log('     nút 3 gạch: lệch tâm so với tiêu đề =', banDau.lechTamNutVsTieuDe, 'px · là nút nổi?', banDau.nutNoiDeLen, '· còn chữ "SigMa /"?', banDau.conChuAlpha);
    chot(banDau.lechTamNutVsTieuDe != null && banDau.lechTamNutVsTieuDe <= 6, `nút 3 gạch CÙNG HÀNG với tiêu đề DOANH SỐ (lệch ${banDau.lechTamNutVsTieuDe}px) @${w}`);
    chot(banDau.nutNoiDeLen === false, `nút 3 gạch KHÔNG phải nút nổi đè nội dung @${w}`);
    chot(banDau.conChuAlpha === false, `đã bỏ chữ "SigMa /" trên thanh trên @${w}`);

    // ── 2. Bấm 3 gạch → menu hiện lại, và "Doanh Số" phải là mục ĐẦU TIÊN ──
    await page.locator('[data-kiem="nut-menu"]').click();
    await page.waitForTimeout(900);
    const hienLai = await doKhung();
    console.log(`  [bấm 3 gạch → hiện menu @${w}]`, JSON.stringify(hienLai));
    await page.screenshot({ path: resolve(RA, `2-hien-menu-${w}.png`) });
    chot(hienLai.coMenuTrai === true && hienLai.rongMenuTrai > 150, `bấm 3 gạch thì HIỆN lại menu @${w}`);
    chot(hienLai.mucDauTien === 'Doanh Số', `"Doanh Số" là mục ĐẦU menu (đang là "${hienLai.mucDauTien}") @${w}`);
    chot(hienLai.cuonDocNgoai <= 0 && hienLai.tranNgangNgoai <= 0, `hiện menu rồi TRANG NGOÀI vẫn không cuộn @${w}`);

    // ── 3. Bấm 3 gạch lần nữa → ẩn lại (nút ẩn/hiện được CẢ HAI chiều) ──
    await page.locator('[data-kiem="nut-menu"]').click();
    await page.waitForTimeout(900);
    const anLai = await doKhung();
    console.log(`  [bấm 3 gạch lần 2 @${w}]`, JSON.stringify({ coMenuTrai: anLai.coMenuTrai, khungTrai: anLai.khungTrai }));
    chot(anLai.coMenuTrai === false, `bấm 3 gạch lần nữa thì ẨN lại menu @${w}`);

    // ── 4. Sang tab KHÁC thì menu phải ở lại, rồi quay lại Doanh Số là full màn tiếp ──
    await page.locator('[data-kiem="nut-menu"]').click();
    await page.waitForTimeout(700);
    const sangTabKhac = await page.evaluate(() => {
      const b = [...document.querySelectorAll('aside nav button')].find((x) => (x.textContent || '').trim() === 'Trang chủ');
      if (!b) return false;
      b.click();
      return true;
    });
    await page.waitForTimeout(1100);
    const oTabKhac = await doKhung();
    console.log(`  [sang tab Trang chủ @${w}]`, JSON.stringify({ chuyenDuoc: sangTabKhac, coMenuTrai: oTabKhac.coMenuTrai }));
    chot(sangTabKhac && oTabKhac.coMenuTrai === true, `sang màn khác thì menu Ở LẠI @${w}`);
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('aside nav button')].find((x) => (x.textContent || '').trim() === 'Doanh Số');
      if (b) b.click();
    });
    await page.waitForTimeout(1200);
    const veDoanhSo = await doKhung();
    console.log(`  [quay lại Doanh Số @${w}]`, JSON.stringify({ coMenuTrai: veDoanhSo.coMenuTrai, khungRong: veDoanhSo.khungRong, cuonDocNgoai: veDoanhSo.cuonDocNgoai }));
    await page.screenshot({ path: resolve(RA, `3-quay-lai-doanhso-${w}.png`) });
    chot(veDoanhSo.coMenuTrai === false, `quay lại tab Doanh Số thì tự FULL MÀN @${w}`);
    chot(veDoanhSo.cuonDocNgoai <= 0, `quay lại Doanh Số vẫn không cuộn trang ngoài @${w}`);
  }
} catch (e) {
  console.error('[doanhso-full] LỖI:', e.message);
  datHet = false;
} finally {
  if (loi.length) {
    datHet = false;
    console.log('[doanhso-full] *** CÓ ' + loi.length + ' LỖI RUNTIME → KHÔNG ĐẠT ***');
    loi.slice(0, 10).forEach((x) => console.log('   ', x));
  } else console.log('[doanhso-full] không có lỗi runtime');
  console.log('[doanhso-full] KẾT LUẬN:', datHet ? 'không phép kiểm nào đỏ' : '*** CÒN PHÉP KIỂM ĐỎ ***');
  console.log('[doanhso-full] ảnh ở:', RA);
  await browser.close();
  if (process.argv.includes('--serve')) console.log('[doanhso-full] GIỮ SỐNG để Admin Demo bấm thử:', base);
  else await server.close();
  process.exitCode = datHet ? 0 : 1;
}
