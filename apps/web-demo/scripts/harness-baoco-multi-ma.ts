// HARNESS R200 (Admin Demo 24/9 "tích chọn nhiều mã HKD ví dụ Trà My + Cường/DEMOMAY để lọc và kéo báo có riêng").
// Kiểm THẬT: mở panel → tích 2 mã → (1) báo cáo gọi lại với tidIds=2 mã · (2) bấm "Tải lại giao dịch mới nhất"
// gửi ĐÚNG 2 mã đó lên server (kéo báo có riêng) · (3) nhãn nút hiện "2 mã đã chọn".
import { preview } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MA = [
  { tidId: 185, tid: 'QR-HKDTRAMYNGUYEN-g2itsjci8z', hkdName: 'HKD TRÀ MY NGUYỄN' },
  { tidId: 192, tid: 'QR-HKDDOVANCUONG03-mu2obdnv1nn2', hkdName: 'HO KINH DOANH DEMO CUONG 03' },
  { tidId: 187, tid: 'QR-HKDDEMOMAY-mtwr7znklro', hkdName: 'HKD DEMOMAY' }
];
const json = (route: Route, body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function main(): Promise<void> {
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', preview: { port: 0 } });
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || '';
  let browser: Browser | undefined;
  const tidIdsGui: string[] = [];
  let refreshBody: unknown = null;
  try {
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1700, height: 950 }, timezoneId: 'Asia/Ho_Chi_Minh' })).newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u', agentName: 'Nguoi Dung Demo' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u', rcUsername: 'nguoidungdemo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const u = new URL(route.request().url());
      const p = u.pathname;
      if (p.endsWith('/v1/digistore/baoco-report')) {
        tidIdsGui.push(u.searchParams.get('tidIds') ?? '(không có)');
        return json(route, { rows: [], totals: { amount: 0, count: 0, countUnreconciled: 0, loiNhuanAlpha: 0, sauPhiBan: 0, sauPhiMua: 0 }, byDay: [], limitWarnings: [] });
      }
      if (p.endsWith('/v1/digistore/creds')) return json(route, { ok: true, items: MA }); // listQrMa đọc .items
      if (p.endsWith('/v1/qr-daily-limit')) return json(route, { ok: true, ma: MA, limits: {} });
      if (p.endsWith('/v1/digistore/refresh')) { refreshBody = route.request().postDataJSON(); return json(route, { ok: true, fetched: 3, matched: 3, unreconciled: 0, errors: [] }); }
      if (p.endsWith('/v1/digistore/dealer-names')) return json(route, { ok: true, dealers: [] });
      const listLike = /friends|rooms|categories|contacts|notifications|feed|members|tids|list/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });
    await page.goto(`${baseUrl}/app/baoco-report`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    // mở panel chọn mã
    await page.locator('[data-testid="baoco-filter-ma"]').click();
    const soMuc = await page.locator('[data-testid="baoco-ma-item"]').count();
    console.log(`[1] Panel mở · số mã hiện = ${soMuc} (mong ${MA.length})`);
    await page.locator('[data-testid="baoco-ma-tick-185"]').check();
    await page.waitForTimeout(600);
    await page.locator('[data-testid="baoco-ma-tick-192"]').check();
    await page.waitForTimeout(1200);
    const nhan = (await page.locator('[data-testid="baoco-filter-ma"]').innerText()).trim();
    console.log(`[2] Nhãn nút = "${nhan.split('\n')[0]}" (mong "2 mã đã chọn")`);
    console.log(`[3] tidIds gửi lên báo cáo (lần cuối) = ${tidIdsGui[tidIdsGui.length - 1]} (mong "185,192")`);
    // kéo báo có riêng
    await page.getByRole('button', { name: /Tải lại giao dịch mới nhất/ }).click();
    await page.waitForTimeout(1500);
    console.log(`[4] Body gửi khi bấm "Tải lại giao dịch": ${JSON.stringify(refreshBody)} (mong {"tidIds":[185,192]})`);
    const ok2 = tidIdsGui[tidIdsGui.length - 1] === '185,192' && JSON.stringify(refreshBody) === JSON.stringify({ tidIds: [185, 192] }) && nhan.includes('2 mã');
    console.log(ok2 ? '✓ TÍCH CHỌN NHIỀU MÃ: lọc đúng + kéo báo có riêng đúng mã' : '✗ SAI');
    await page.screenshot({ path: path.join(ROOT, 'qa-screenshots', 'baoco-multi-ma.png') });
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
