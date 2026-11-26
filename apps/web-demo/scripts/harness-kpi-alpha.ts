// HARNESS R200 (11/9) — CHỤP ẢNH màn KPI SigMa toàn cục (AlphaKpiView) với DATA THẬT lấy từ buildAlphaKpi
// prod 11/9 (POS 40,4 tỷ / QR 1,74 tỷ 7 ngày). Mock đúng shape AlphaKpiData (typecheck gãy = mock lệch).
// 2 viewport: desktop 1400 + mobile 390. Chạy: node --import tsx scripts/harness-kpi-alpha.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AlphaKpiData } from '../src/lib/kpi-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'kpi-alpha');

// DATA THẬT (rút từ buildAlphaKpi prod 7 ngày 11/9 — số đúng từng đồng 2 ngày cuối, các ngày trước gộp đại diện).
const DATA: AlphaKpiData = {
  from: '2026-09-04T17:00:00.000Z', to: '2026-09-11T17:00:00.000Z',
  totals: { count: 838, doanhSo: 42_166_000_000, loiNhuan: 133_500_000, phaiHoanNdt: 38_119_000_000 },
  gop: { laiCongTy: 7_576_579, laiNdtPos: 3_737_334, loiNhuanGop: 3_839_245 },
  byProduct: [
    { kind: 'POS', count: 779, doanhSo: 40_428_000_000, loiNhuan: 116_100_000 },
    { kind: 'QR', count: 59, doanhSo: 1_738_000_000, loiNhuan: 17_400_000 }
  ],
  byDay: [
    { day: '2026-09-08', count: 130, doanhSo: 6_500_000_000, loiNhuan: 18_000_000, phaiHoanNdt: 5_857_000_000, kinds: { POS: { count: 122, doanhSo: 6_200_000_000, loiNhuan: 16_000_000 }, QR: { count: 8, doanhSo: 300_000_000, loiNhuan: 2_000_000 } } },
    { day: '2026-09-09', count: 140, doanhSo: 7_100_000_000, loiNhuan: 20_000_000, phaiHoanNdt: 6_398_000_000, kinds: { POS: { count: 132, doanhSo: 6_800_000_000, loiNhuan: 18_000_000 }, QR: { count: 8, doanhSo: 300_000_000, loiNhuan: 2_000_000 } } },
    { day: '2026-09-10', count: 138, doanhSo: 6_285_475_000, loiNhuan: 18_601_073, phaiHoanNdt: 5_664_000_000, kinds: { POS: { count: 131, doanhSo: 6_030_636_000, loiNhuan: 16_052_680 }, QR: { count: 7, doanhSo: 254_839_000, loiNhuan: 2_548_393 } } },
    { day: '2026-09-11', count: 69, doanhSo: 2_846_624_000, loiNhuan: 10_346_025, phaiHoanNdt: 2_565_000_000, kinds: { POS: { count: 54, doanhSo: 2_435_819_000, loiNhuan: 6_237_970 }, QR: { count: 15, doanhSo: 410_805_000, loiNhuan: 4_108_055 } } }
  ]
};

const json = (route: Route, body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const initScript = {
      content: [
        "window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Ke Toan Demo' }));",
        // code CHỦ SIGMA thật (SIGMA_OWNER_CODES) để isAlphaOwnerCode bật nhánh AlphaKpiView
        "window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 1, code: 'DL62', name: 'Ke Toan Demo', rcUserId: 'u-me', rcUsername: 'tuyet' }));",
        'function FakeWS(){ this.readyState = 0; }',
        'FakeWS.prototype.addEventListener = function(){};',
        'FakeWS.prototype.removeEventListener = function(){};',
        'FakeWS.prototype.send = function(){};',
        'FakeWS.prototype.close = function(){};',
        'window.WebSocket = FakeWS;'
      ].join(String.fromCharCode(10))
    };
    for (const [tag, vp] of [['desktop-1400', { width: 1400, height: 1000 }], ['mobile-390', { width: 390, height: 844 }]] as const) {
      const ctx = await browser.newContext({ viewport: vp });
      const page = await ctx.newPage();
      await page.addInitScript(initScript);
      await page.routeWebSocket(/^ws/, () => { /* */ });
      await page.route('**/v1/**', async (route) => {
        const p = new URL(route.request().url()).pathname;
        if (p.endsWith('/v1/kpi/alpha')) return json(route, { ok: true, ...DATA });
        const listLike = /categories|rooms|contacts|birthday|notifications|feed|members|list/i.test(p);
        return json(route, route.request().method() === 'GET' && listLike ? [] : {});
      });
      await page.goto(`${baseUrl}/app/kpi`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(700);
      const shot = path.join(OUT, `kpi-alpha-${tag}.png`);
      await page.screenshot({ path: shot, fullPage: true });
      // ĐO: headline có đúng tổng + có badge QR
      const tong = await page.locator('text=Tổng doanh số').count();
      const qr = await page.locator('text=Mã QR').count();
      const scrollX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      console.log(JSON.stringify({ tag, shot, thayTongDoanhSo: tong, thayMaQR: qr, tranNgang: scrollX }));
      await ctx.close();
    }
  } finally {
    await browser?.close();
    await server.close();
  }
}
void main();
