// HARNESS R200 (Admin Demo 5/9) — build harness-qr.html (vite, cấu hình renderer) → preview → Playwright chụp
// FeeConfigPage 2 tab mới + form Thêm mã QR để LEAD tự nhìn ảnh trước ship. Chạy: node scripts/harness-qr-shot.mjs
import { build, preview } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { chromium } from 'playwright';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const RROOT = resolve(here, '..', 'src', 'renderer');
const OUT = resolve(here, '..', 'screenshots', 'harness-qr');
mkdirSync(OUT, { recursive: true });

const cfg = {
  root: RROOT,
  configFile: false,
  resolve: { alias: { '@renderer': resolve(RROOT, 'src') } },
  plugins: [react(), tailwindcss()],
  build: { outDir: resolve(here, '..', 'out', 'harness-qr'), rollupOptions: { input: resolve(RROOT, 'harness-qr.html') }, emptyOutDir: true },
  logLevel: 'error'
};

const shot = async (page, name) => { await page.screenshot({ path: resolve(OUT, name), fullPage: true }); console.log('  shot', name); };

(async () => {
  console.log('[harness-qr] build...');
  await build(cfg);
  const server = await preview({ ...cfg, preview: { port: 0 } });
  const base = server.resolvedUrls.local[0].replace(/\/$/, '');
  const url = `${base}/harness-qr.html`;
  console.log('[harness-qr] preview', url);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('console:' + m.text()); });
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    // [Admin Demo 12/9] Tab Chương trình khuyến mại — bảng + form.
    await page.getByText('Chương trình khuyến mại', { exact: true }).click();
    await page.waitForTimeout(400);
    await shot(page, 'promo-tab.png');
    await page.getByText('Thêm chương trình', { exact: true }).click();
    await page.waitForTimeout(300);
    await shot(page, 'promo-form.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
    await page.waitForTimeout(800);
    await shot(page, '1-fee-default.png');

    // Tab: Giảm phí bán cuối tuần (CLICK nút tab, không phải dòng mô tả)
    await page.getByRole('button', { name: 'Giảm phí bán cuối tuần' }).click().catch((e) => console.log('  click weekend tab err', e.message));
    await page.waitForTimeout(600);
    await shot(page, '2-weekend-tab.png');
    const addBtn = page.getByRole('button', { name: /Thêm mức|Thêm giảm|Thêm$|Thêm / }).first();
    if (await addBtn.count()) { await addBtn.click().catch(() => {}); await page.waitForTimeout(500); await shot(page, '2b-weekend-add-modal.png'); await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(200); }

    // Tab: Giá QR theo đối tác
    await page.getByRole('button', { name: 'Giá QR theo đối tác' }).click().catch((e) => console.log('  click qr tab err', e.message));
    await page.waitForTimeout(600);
    await shot(page, '3-qrpartner-tab.png');
    const addBtn2 = page.getByRole('button', { name: /Thêm giá|Đặt giá|Thêm$|Thêm / }).first();
    if (await addBtn2.count()) { await addBtn2.click().catch(() => {}); await page.waitForTimeout(500); await shot(page, '3b-qrpartner-add-modal.png'); await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(200); }

    // Tab: Giá bán QR theo đại lý (Admin Demo 5/9 "phí bán tùy khách") — lớp đè giá bán mặc định của mã
    await page.getByRole('button', { name: 'Giá bán QR theo đại lý' }).click().catch((e) => console.log('  click qrdealer tab err', e.message));
    await page.waitForTimeout(600);
    await shot(page, '6-qrdealer-tab.png');
    const addBtn3 = page.getByRole('button', { name: /Đặt giá bán/ }).first();
    if (await addBtn3.count()) { await addBtn3.click().catch(() => {}); await page.waitForTimeout(500); await shot(page, '6b-qrdealer-add-modal.png'); await page.keyboard.press('Escape').catch(() => {}); await page.waitForTimeout(200); }

    // TidPage → Thêm mã QR
    await page.getByRole('button', { name: 'TidPage' }).click().catch(() => {});
    await page.waitForTimeout(700);
    await shot(page, '4-tidpage.png');
    await page.getByText('Thêm mã QR', { exact: false }).first().click().catch(() => {});
    await page.waitForTimeout(600);
    await shot(page, '5-qr-create-form.png');
  } catch (e) {
    console.error('[harness-qr] LỖI:', e.message);
  } finally {
    if (errs.length) { console.log('[harness-qr] PAGE ERRORS:'); errs.slice(0, 15).forEach((e) => console.log('   ', e)); }
    else console.log('[harness-qr] không có page error');
    await browser.close();
    await server.httpServer.close();
  }
})();
