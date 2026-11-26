// HARNESS R200 (12/9) — màn Khuyến mại trên SIGMA (đồng nhất tab SigMa): danh sách + form.
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'promo-sigma');
const ROWS = [
  { id: 4, kenh: 'POS', cardTypeId: 15, cardTypeName: 'MB', bankId: null, bankName: null, deltaPct: 0.02, fromDate: '2026-08-31T17:00:00.000Z', toDate: '2026-09-30T17:00:00.000Z', lich: 'RANGE', ngayCuThe: null, enabled: true, note: 'KM T9' },
  { id: 9, kenh: 'QR', cardTypeId: null, cardTypeName: null, bankId: 27, bankName: 'SmartPay', deltaPct: 0.05, fromDate: '2026-08-31T17:00:00.000Z', toDate: '2026-09-30T17:00:00.000Z', lich: 'WEEKEND', ngayCuThe: null, enabled: false, note: null }
];
const json = (route: Route, body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, timezoneId: 'Asia/Ho_Chi_Minh' });
    const page = await ctx.newPage();
    await page.addInitScript({ content: [
      "window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'KeToan' }));",
      "window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 1, code: 'DL62', name: 'KeToan', rcUserId: 'u-me', rcUsername: 'tuyet' }));",
      'function FakeWS(){ this.readyState = 0; } FakeWS.prototype.addEventListener=function(){}; FakeWS.prototype.removeEventListener=function(){}; FakeWS.prototype.send=function(){}; FakeWS.prototype.close=function(){}; window.WebSocket=FakeWS;'
    ].join(String.fromCharCode(10)) });
    await page.routeWebSocket(/^ws/, () => {});
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/v1/promo-programs/refs')) return json(route, { ok: true, data: { cards: [{ id: 15, name: 'MB', bankName: 'MB' }, { id: 13, name: 'Visa', bankName: 'MBV' }], banks: [{ id: 27, name: 'SmartPay' }, { id: 20, name: 'Ban Viet bank' }] } });
      if (p.endsWith('/v1/promo-programs')) return json(route, { ok: true, data: ROWS });
      const listLike = /categories|rooms|contacts|notifications|list/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });
    await page.goto(`${baseUrl}/app/promo-programs`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'promo-list.png'), fullPage: true });
    await page.getByText('Thêm', { exact: true }).click();
    await page.waitForSelector('[data-testid="promo-form"]');
    await page.waitForTimeout(250);
    await page.screenshot({ path: path.join(OUT, 'promo-form.png'), fullPage: true });
    const nCard = await page.locator('[data-testid="promo-card"]').count();
    console.log(JSON.stringify({ nCard }));
    await ctx.close();
  } finally { await browser?.close(); await server.close(); }
}
void main();
