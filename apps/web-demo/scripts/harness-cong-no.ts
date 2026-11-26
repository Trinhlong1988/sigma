// HARNESS R200 (Admin Demo 17/9) — màn "Tiền ĐL đang cầm": sổ theo dõi lô CHƯA hoàn, tách riêng từng đại lý.
// Mock = dạng số thật (2 nhà, lô chưa đối soát + chờ hoàn, có lô đã gộp YC). Kiểm: tổng đầu màn, mở khối xem lô.
// Chạy: node --import tsx scripts/harness-cong-no.ts
import { preview } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'cong-no');
const lo = (loId: number, soLo: string, ngay: string, gio: string, tid: string, hkd: string, bank: string, truoc: number, sau: number, tt: 'chua' | 'choHoan', maYc: string | null): Record<string, unknown> =>
  ({ loId, soLo, ngay, gio, tid, hkdName: hkd, bankName: bank, truocPhi: truoc, phaiHoan: sau, trangThai: tt, maYc, borrowed: false });

const DATA = {
  ok: true,
  dealers: [
    {
      customerId: 1, dealerName: 'Tuyên SG', roomId: 'r1', soLo: 3, soLoChua: 2, soLoChoHoan: 1,
      tongTruocPhi: 120_000_000, tongPhaiHoan: 118_800_000, tongChuaDoiSoat: 71_017_650, tongChoHoan: 47_782_350,
      lots: [
        lo(207, '207', '16/09/2026', '15:45', '53590003', 'HKD DEMO 19', 'Vietcombank', 56_199_000, 55_637_010, 'chua', null),
        lo(206, '206', '16/09/2026', '12:20', '53590003', 'HKD DEMO 19', 'Vietcombank', 48_265_000, 47_782_350, 'choHoan', 'YC001'),
        lo(205, '205', '16/09/2026', '09:10', '53590003', 'HKD DEMO 19', 'Vietcombank', 15_536_000, 15_380_640, 'chua', null)
      ]
    },
    {
      customerId: 2, dealerName: 'Mr Nguyễn SG', roomId: 'r2', soLo: 2, soLoChua: 1, soLoChoHoan: 1,
      tongTruocPhi: 90_000_000, tongPhaiHoan: 88_500_000, tongChuaDoiSoat: 41_578_687, tongChoHoan: 46_921_313,
      lots: [
        lo(164, '164', '17/09/2026', '14:27', '20280817', 'HKD DEMO 6-1', 'MBV', 42_105_000, 41_578_687, 'chua', null),
        lo(166, '166(95)', '17/09/2026', '14:14', 'DEMO-TID-08', 'HKD DEMO 49', 'MB', 47_597_000, 46_921_313, 'choHoan', 'YC002')
      ]
    }
  ],
  tongChuaDoiSoat: 112_596_337,
  tongChoHoan: 94_703_663
};
const json = (r: Route, b: unknown): Promise<void> => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', preview: { port: 0 } });
  const base = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || '';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1050 }, timezoneId: 'Asia/Ho_Chi_Minh' });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error ws
      window.WebSocket = FakeWS;
    });
    page.on('pageerror', (e) => console.log('PAGE-ERROR:', e.message));
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (r) => {
      const p = new URL(r.request().url()).pathname;
      if (p.endsWith('/pos-lot/cong-no')) return json(r, DATA);
      const listLike = /friends|categories|rooms|contacts|notifications|feed|members|list/i.test(p);
      const rong = r.request().method() === 'GET' && listLike ? [] : {};
      return json(r, p.startsWith('/v1/chat/') ? { ok: true, data: rong } : rong);
    });
    await page.goto(`${base}/app/cong-no`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1400);
    const soNha = await page.getByTestId('cong-no-dai-ly').count();
    const tongChua = await page.getByTestId('tong-chua-ds').textContent().catch(() => null);
    const tongCho = await page.getByTestId('tong-cho-hoan').textContent().catch(() => null);
    console.log('[công nợ] số đại lý =', soNha, '·', JSON.stringify(tongChua?.trim()), '·', JSON.stringify(tongCho?.trim()));
    await page.getByTestId('cong-no-dai-ly').first().getByText(/Xem lô/).click();
    await page.waitForTimeout(600);
    const soDong = await page.locator('[data-testid="cong-no-dai-ly"] tbody tr').count();
    console.log('[công nợ] mở nhà đầu → số dòng lô =', soDong);
    await page.screenshot({ path: path.join(OUT, 'man-cong-no.png'), fullPage: true });
    console.log('[harness] Ảnh →', OUT);
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
