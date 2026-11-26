// HARNESS màn Doanh số NĐT — verify section "Đối soát tạm ứng" (Admin Demo 31/8: NĐT tự xem tạm ứng của mình).
import { build, preview } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-investor-settlement');

// NĐT Thông (verify Agent B): tạm ứng 15.690.000.063, chưa doanh số → tiền về 0, lãi 0 → phải trả 15.690.000.063 (SigMa nợ NĐT).
const REPORT = { from: '2026-08-31', to: '2026-08-31', investors: [
  { investorId: 15, code: 'INV01', investorName: 'NĐT 2', doanhThu: 0, soBill: 0, laiNDT: 0, tienVe: 0, daHoan: { doanhThu: 0, soBill: 0, laiNDT: 0 }, chuaHoan: { doanhThu: 0, soBill: 0, laiNDT: 0 } }
] };
const SETTLE = { from: '2026-08-31', to: '2026-08-31', rows: [
  { investorId: 15, code: 'INV01', investorName: 'NĐT 2', doanhThu: 0, laiNDT: 0, tamUng: 15690000063, tienVe: 0, phaiTra: 15690000063 }
] };

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error' });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), preview: { port: 0 } });
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:4173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'NĐT Thông' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* mở lửng */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (/\/me\/investor-settlement$/.test(p)) return json(route, SETTLE);
      if (/\/me\/investor-report$/.test(p)) return json(route, REPORT);
      if (/\/me\/investor-report\/filter-options$/.test(p)) return json(route, { tids: [], banks: [] });
      const listLike = /friends|categories|rooms|contacts|notifications|feed|members|list/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });
    await page.goto(`${baseUrl}/app/investor-revenue`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);

    const hasSection = await page.getByText(/Đối soát tạm ứng/).first().isVisible().catch(() => false);
    const hasTamUng = await page.getByText(/15.690.000.063/).first().isVisible().catch(() => false);
    const hasPhaiTra = await page.getByText(/SigMa phải trả NĐT/).first().isVisible().catch(() => false);
    console.log('[đối soát tạm ứng] section hiện =', hasSection, '· tạm ứng 15.690.000.063 =', hasTamUng, '· "SigMa phải trả NĐT" =', hasPhaiTra);
    await page.screenshot({ path: path.join(OUT, 'investor-settlement.png'), fullPage: true });
    console.log('[harness] Chụp ->', OUT);
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
