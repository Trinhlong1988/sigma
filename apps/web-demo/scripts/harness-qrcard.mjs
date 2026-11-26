// HARNESS TẠM (KHÔNG commit) — chụp card QR gửi group (PosBillCard qua posBillMeta) ở 390px + 1200px, xác minh
// title động / Số GD / ẩn Sửa / Phải hoàn nổi. Chạy: node apps/web-demo/scripts/harness-qrcard.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const WEB_DEMO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(WEB_DEMO_DIR, 'screenshots', 'harness-qrcard');
const PORT = 5293;
const BASE = `http://localhost:${PORT}`;
const HARNESS = `${BASE}/qrcard-harness.html`;

const BILL_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="560" viewBox="0 0 300 560">
  <rect width="300" height="560" fill="#ffffff"/>
  <rect x="0" y="0" width="300" height="60" fill="#c8102e"/>
  <text x="20" y="38" fill="#ffffff" font-family="Arial" font-size="20" font-weight="bold">MB · QR</text>
  <text x="20" y="150" fill="#111" font-family="Arial" font-size="24" font-weight="bold">49.583.000 VND</text>
  <text x="20" y="200" fill="#666" font-family="Arial" font-size="14">HKD Tra My Nguyen</text>
  <text x="20" y="230" fill="#666" font-family="Arial" font-size="14">05/09/2026 16:29:53</text>
  <text x="20" y="300" fill="#999" font-family="Arial" font-size="12">So GD: 6248VNIB024XSW4W</text>
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
      { name: 'mobile-390', width: 390, height: 1600 },
      { name: 'desktop-1200', width: 1200, height: 1600 }
    ]) {
      const ctx = await browser.newContext({ viewport: { width: dev.width, height: dev.height }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await page.route('**/att/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', body: BILL_SVG }));
      const ok = await gotoUntilReady(page, HARNESS, 'text=Hoàn tiền đại lý (QR)');
      if (!ok) { console.log(`[${dev.name}] KHÔNG render được harness`); await ctx.close(); process.exitCode = 1; continue; }
      await page.waitForTimeout(800);
      const titleQr = await page.getByText('Hoàn tiền đại lý (QR)').first().isVisible().catch(() => false);
      const titleInv = await page.getByText('Bill QR (NĐT)').first().isVisible().catch(() => false);
      const titlePos = await page.getByText('Bill POS').first().isVisible().catch(() => false);
      const soGd = await page.getByText('6248VNIB024XSW4W').first().isVisible().catch(() => false);
      const phaiHoan = await page.getByText(/49\.042\.588/).first().isVisible().catch(() => false);
      const suaCount = await page.getByText('Sửa', { exact: true }).count();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      console.log(`[${dev.name}] QRtitle=${titleQr} · NĐTtitle=${titleInv} · POStitle=${titlePos} · SốGD=${soGd} · PhảiHoàn=${phaiHoan} · nút-Sửa(chỉ POS=1)=${suaCount} · overflowX=${overflow}px`);
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
