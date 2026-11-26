// HARNESS R200 (Admin Demo 22/9) — VAI VIEWER DL65 (Khach Demo F): menu có "Báo cáo QR", màn XEM được bảng,
// action-bar khi tick CHỈ còn "Bỏ chọn" (không nút đối soát/hoàn/YC NĐT/tải ảnh).
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'qr-viewer-dl65');
const ROWS = [{ stt: 1, dateIso: '2026-09-21T01:21:00Z', hkdName: 'HKD DEMOMAY', amount: 6_009_000, payerName: 'NGUYEN VAN A', billId: 'B1', sauPhiBan: 5_936_892, sauPhiMua: 5_957_924, loiNhuanAlpha: null, dealerName: 'Đại lý C', reconcileStatus: 'MATCHED', nguon: 'SMARTPAY', manualDs: true, manualDealer: null, maChuName: 'Đại lý C', sourceTidId: 1, feeType: 'cho', coPhiNhanh: false }];
const REPORT = { rows: ROWS, totals: { amount: 6_009_000, loiNhuanAlpha: 0, count: 1, countUnreconciled: 0, sauPhiBan: 0, sauPhiMua: 0 }, byDay: [{ day: '2026-09-21', doanhSo: 6_009_000, count: 1, countUnreconciled: 0, loiNhuan: 0 }], limitWarnings: [] };
const json = (route: Route, body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 950 }, timezoneId: 'Asia/Ho_Chi_Minh' });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-tn3s', agentName: 'Khach Demo F' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 405, code: 'DL65', name: 'Khach Demo F', rcUserId: 'u-tn3s', rcUsername: 'khachdemod' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/v1/digistore/baoco-report')) return json(route, REPORT);
      if (p.endsWith('/v1/digistore/dealer-names')) return json(route, { ok: true, dealers: ['Đại lý C'] });
      if (p.endsWith('/v1/digistore/creds')) return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'FORBIDDEN' }) }); // server thật chặn viewer
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });
    await page.goto(`${baseUrl}/app/baoco-report`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const menuQr = await page.getByText('Báo cáo QR', { exact: true }).count();
    console.log('MENU "Báo cáo QR" hiện với DL65:', menuQr > 0 ? '✓' : '✗');
    const bangCo = await page.locator('[data-testid="baoco-tick-row"]').count();
    console.log('BẢNG hiện số dòng:', bangCo, bangCo > 0 ? '✓ xem được' : '✗ KHÔNG xem được');
    await page.locator('[data-testid="baoco-tick-row"]').first().click();
    await page.waitForTimeout(300);
    const bar = page.locator('[data-testid="baoco-action-bar"]');
    const nutDoiSoat = await bar.getByRole('button', { name: 'Xác nhận đã đối soát' }).count();
    const nutNdt = await bar.locator('[data-testid="btn-yc-ndt-hoan"]').count();
    const nutBoChon = await bar.getByRole('button', { name: 'Bỏ chọn' }).count();
    console.log(`ACTION BAR viewer: đối soát=${nutDoiSoat} (mong 0) · YC NĐT=${nutNdt} (mong 0) · Bỏ chọn=${nutBoChon} (mong 1)`);
    console.log(nutDoiSoat === 0 && nutNdt === 0 && nutBoChon === 1 ? '✓ VIEWER đúng: chỉ xem, không nút ghi' : '✗ SAI quyền');
    await page.screenshot({ path: path.join(OUT, 'viewer-dl65.png'), fullPage: false });
    console.log('Ảnh →', OUT);
  } finally {
    await browser?.close();
    await server.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
