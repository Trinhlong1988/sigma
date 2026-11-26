// HARNESS TẠM (KHÔNG commit) — chụp TransferCkCard ở 390px (mobile) + 1200px (desktop). Chặn ảnh bill bằng
// placeholder SVG (biên lai giả). Chạy: node apps/web-demo/scripts/harness-transfer-ck.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const WEB_DEMO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(WEB_DEMO_DIR, 'screenshots', 'harness-transfer-ck');
const PORT = 5291;
const BASE = `http://localhost:${PORT}`;
const HARNESS = `${BASE}/transfer-ck-harness.html`;

// Placeholder "biên lai chuyển khoản" cao (mô phỏng bill CK thật — dọc, cao hơn rộng) để thấy object-contain.
const BILL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="560" viewBox="0 0 300 560">
  <rect width="300" height="560" fill="#ffffff"/>
  <rect x="0" y="0" width="300" height="64" fill="#1877d6"/>
  <text x="20" y="40" fill="#ffffff" font-family="Arial" font-size="22" font-weight="bold">MB Bank</text>
  <text x="20" y="110" fill="#0a7d33" font-family="Arial" font-size="20" font-weight="bold">Chuyen tien thanh cong</text>
  <text x="20" y="150" fill="#111" font-family="Arial" font-size="26" font-weight="bold">122.859.000 VND</text>
  <line x1="20" y1="180" x2="280" y2="180" stroke="#ddd" stroke-width="2"/>
  <text x="20" y="215" fill="#666" font-family="Arial" font-size="15">Nguoi gui: KHACH HANG 01</text>
  <text x="20" y="245" fill="#666" font-family="Arial" font-size="15">Nguoi nhan: DLY HUY DAKLAK</text>
  <text x="20" y="275" fill="#666" font-family="Arial" font-size="15">STK: 0900000600</text>
  <text x="20" y="305" fill="#666" font-family="Arial" font-size="15">Ngay: 31/08/2026 09:14</text>
  <text x="20" y="335" fill="#666" font-family="Arial" font-size="13">Noi dung: D2H CRSC5/397151</text>
  <line x1="20" y1="360" x2="280" y2="360" stroke="#ddd" stroke-width="2"/>
  <text x="20" y="395" fill="#999" font-family="Arial" font-size="13">Ma GD: FT24313ABC123</text>
  <rect x="20" y="430" width="260" height="90" fill="#f4f6fa" rx="8"/>
  <text x="34" y="470" fill="#888" font-family="Arial" font-size="13">Bien lai dien tu</text>
  <text x="34" y="495" fill="#888" font-family="Arial" font-size="13">Xac thuc GD</text>
</svg>`;

function waitForServer(url, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  return (async () => {
    while (Date.now() < deadline) {
      try { const r = await fetch(url); if (r.ok) return true; } catch { /* chưa lên */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    return false;
  })();
}

async function gotoUntilReady(page, url, sel, tries = 6) {
  for (let i = 0; i < tries; i++) {
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    try { await page.waitForSelector(sel, { timeout: 6000, state: 'visible' }); return true; }
    catch { await page.waitForTimeout(800); }
  }
  return false;
}

const vite = spawn(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vite', '--port', String(PORT), '--strictPort'],
  { cwd: WEB_DEMO_DIR, stdio: 'ignore', shell: process.platform === 'win32' }
);

let browser;
try {
  await mkdir(OUT, { recursive: true });
  const up = await waitForServer(HARNESS);
  if (!up) { console.error('FAIL vite dev server không lên'); process.exitCode = 1; }
  else {
    browser = await chromium.launch();
    for (const dev of [
      { name: 'mobile-390', width: 390, height: 1400 },
      { name: 'desktop-1200', width: 1200, height: 1400 }
    ]) {
      const ctx = await browser.newContext({ viewport: { width: dev.width, height: dev.height }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await page.route('**/att/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: BILL_SVG }));
      const ok = await gotoUntilReady(page, HARNESS, 'text=Bill chuyển khoản');
      if (!ok) { console.log(`[${dev.name}] KHÔNG render được harness`); await ctx.close(); process.exitCode = 1; continue; }
      await page.waitForTimeout(800); // chờ AttachmentImage fetch blob + render
      const cards = await page.getByText('Bill chuyển khoản').count();
      const money = await page.getByText(/122\.859\.000 đ/).isVisible().catch(() => false);
      const kindRefund = await page.getByText('Hoàn tiền đại lý').first().isVisible().catch(() => false);
      const kindOver = await page.getByText('Đại lý hoàn thừa').first().isVisible().catch(() => false);
      const invAdv = await page.getByText('Tạm ứng nhà đầu tư').first().isVisible().catch(() => false);
      // đo tràn ngang: scrollWidth <= clientWidth (không cuộn ngang body)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      console.log(`[${dev.name}] cards=${cards} · money=${money} · Hoàn tiền ĐL=${kindRefund} · Hoàn thừa=${kindOver} · Tạm ứng NĐT=${invAdv} · overflowX=${overflow}px`);
      await page.screenshot({ path: join(OUT, `${dev.name}.png`), fullPage: true });
      await ctx.close();
    }
    console.log('[harness] ảnh ->', OUT);
  }
} finally {
  if (browser) await browser.close();
  vite.kill();
}
console.log(process.exitCode ? '\n❌ có lỗi' : '\n✅ chụp xong');
