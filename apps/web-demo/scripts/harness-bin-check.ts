// HARNESS R200 (12/9) — màn Tra BIN: card đẹp (NAPAS + Visa chưa-có-thư-viện với form bổ sung) + bảng thư viện.
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'bin-check');
const LIB = [
  { bin: '970422', bankName: 'MB Bank', cardBrand: 'NAPAS (thẻ nội địa VN)', cardType: 'Thẻ nội địa', note: null, source: 'NAPAS_CONG_KHAI' },
  { bin: '970441', bankName: 'VIB', cardBrand: 'NAPAS (thẻ nội địa VN)', cardType: 'Thẻ nội địa', note: null, source: 'NAPAS_CONG_KHAI' },
  { bin: '42380112', bankName: 'VIB', cardBrand: 'Visa', cardType: 'Tín dụng', note: 'SigMa nhập 12/9', source: 'SIGMA_NHAP' }
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
      const u = new URL(route.request().url());
      if (u.pathname.endsWith('/v1/bin-check/list')) return json(route, { ok: true, data: LIB });
      if (u.pathname.endsWith('/v1/bin-check')) {
        const b = (u.searchParams.get('bin') ?? '').replace(/\D/g, '');
        if (b.startsWith('970422')) return json(route, { ok: true, data: { bin: '970422', brand: 'NAPAS (thẻ nội địa VN)', bankName: 'MB Bank', cardType: 'Thẻ nội địa', note: null, source: 'LIBRARY' } });
        if (b.startsWith('530416')) return json(route, { ok: true, data: { bin: '530416', brand: 'Mastercard', bankName: 'MB Bank', cardType: 'Tín dụng', note: 'Hạng: WORLD ELITE', source: 'LIBRARY' } });
        return json(route, { ok: true, data: { bin: b.slice(0, 6), brand: 'Visa', bankName: null, cardType: null, note: null, source: 'RULE' } });
      }
      const listLike = /categories|rooms|contacts|notifications|list/i.test(u.pathname);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });
    await page.goto(`${baseUrl}/app/bin-check`, { waitUntil: 'networkidle' });
    await page.fill('[data-testid="bin-input"]', '970422');
    await page.getByText('Tra', { exact: true }).click();
    await page.waitForSelector('[data-testid="bin-card"]');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'bin-napas-mb.png'), fullPage: true });
    await page.fill('[data-testid="bin-input"]', '530416');
    await page.getByText('Tra', { exact: true }).click();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'bin-mb-master.png'), fullPage: true });
    const form = await page.locator('text=chưa có trong thư viện').count();
    console.log(JSON.stringify({ formHienKhiThieu: form }));
    await ctx.close();
  } finally { await browser?.close(); await server.close(); }
}
void main();
