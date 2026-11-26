// HARNESS R200 (Admin Demo 22/9 "báo cáo QR chưa lọc được theo đại lý") — lọc phải ăn theo TÊN HIỂN THỊ
// (manualDealer ?? dealerName ?? maChuName): 3 GD 3 nguồn tên khác nhau, chọn từng đại lý → bảng còn đúng 1 dòng.
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const base = { stt: 1, dateIso: '2026-09-22T01:00:00Z', hkdName: 'HKD DEMOMAY', payerName: 'X', sauPhiBan: 1, sauPhiMua: 1, loiNhuanAlpha: 1, reconcileStatus: 'MATCHED', nguon: 'BVB', manualDs: true, sourceTidId: 1, feeType: 'cho', coPhiNhanh: false };
const ROWS = [
  { ...base, billId: 'B1', amount: 1_000_000, manualDealer: 'Nhà Gán Tay', dealerName: null, maChuName: null },
  { ...base, billId: 'B2', amount: 2_000_000, manualDealer: null, dealerName: 'Nhà DealerName', maChuName: null },
  { ...base, billId: 'B3', amount: 3_000_000, manualDealer: null, dealerName: null, maChuName: 'Nhà Chủ Mã' }
];
const REPORT = { rows: ROWS, totals: { amount: 6_000_000, loiNhuanAlpha: 0, count: 3, countUnreconciled: 0, sauPhiBan: 0, sauPhiMua: 0 }, byDay: [], limitWarnings: [] };
const json = (route: Route, body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function main(): Promise<void> {
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || '';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 }, timezoneId: 'Asia/Ho_Chi_Minh' })).newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u', agentName: 'T' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u', rcUsername: 'nguoidungdemo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/v1/digistore/baoco-report')) return json(route, REPORT);
      if (p.endsWith('/v1/digistore/dealer-names')) return json(route, { ok: true, dealers: [] });
      if (p.endsWith('/v1/digistore/creds')) return json(route, { ok: true, list: [] });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });
    await page.goto(`${baseUrl}/app/baoco-report`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    const sel = page.locator('select').filter({ has: page.locator('option', { hasText: 'Tất cả đại lý' }) }).first();
    const opts = await sel.locator('option').allTextContents();
    console.log('DROPDOWN options:', JSON.stringify(opts), opts.length === 4 ? '✓ đủ 3 tên + Tất cả' : '✗ THIẾU tên');
    let ok = true;
    for (const [ten, mong] of [['Nhà Gán Tay', '1.000.000'], ['Nhà DealerName', '2.000.000'], ['Nhà Chủ Mã', '3.000.000']] as [string, string][]) {
      await sel.selectOption({ label: ten });
      await page.waitForTimeout(400);
      const n = await page.locator('[data-testid="baoco-tick-row"]').count();
      const coTien = await page.getByText(mong).first().isVisible().catch(() => false);
      const dat = n === 1 && coTien;
      ok = ok && dat;
      console.log(`lọc "${ten}": ${n} dòng, tiền ${mong} hiện=${coTien} ${dat ? '✓' : '✗'}`);
    }
    console.log(ok ? '✓✓ LỌC THEO ĐẠI LÝ ĂN CẢ 3 NGUỒN TÊN' : '✗✗ LỌC VẪN HỎNG');
  } finally {
    await browser?.close();
    await server.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
