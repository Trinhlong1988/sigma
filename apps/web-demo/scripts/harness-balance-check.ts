// HARNESS R200 (Admin Demo 12/9) — khối "Số dư cuối ngày · đối chiếu tìm tiền" trong tab Báo cáo tra soát:
// tổng số dư từng TK SigMa vs Σ phải hoàn NĐT (tiền về + lãi) + lãi công ty; ô THỪA/THIẾU màu theo chiều lệch.
// Data mock = SỐ THẬT buildBalanceCheck 12/9 (phaiHoanNdt 3.766.778.027 · laiCongTy 7.635.045) + số dư giả định
// 3 TK để soi cả 3 trạng thái. Chạy: node --import tsx scripts/harness-balance-check.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BalanceCheckData } from '../src/lib/ocr-send-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'balance-check');

const BAL: BalanceCheckData = {
  day: '2026-09-12',
  accounts: [
    { account: 'DEMO-ACCT', bank: 'MB', holder: 'KHACH HANG 01', balance: 2_508_312_450, asOf: '2026-09-12T21:14:00', stale: false },
    { account: 'DEMO-ACCT', bank: 'MBV', holder: 'KHACH HANG 22', balance: 1_204_556_000, asOf: '2026-09-12T20:02:00', stale: false },
    { account: 'DEMO-ACCT', bank: 'ABB', holder: 'KHACH HANG 01', balance: 41_210_622, asOf: '2026-09-11T18:40:00', stale: true }
  ],
  tongSoDu: 3_754_079_072, coSoDu: true,
  investors: [
    { investorId: 15, name: 'NĐT 2', tamUng: 2_400_000_000, tienVe: 2_214_195_620, laiNdt: 2_214_198, phaiHoan: 188_018_578 },
    { investorId: 16, name: 'Trung CP', tamUng: 1_600_000_000, tienVe: 1_548_819_388, laiNdt: 1_548_821, phaiHoan: 52_729_433 }
  ],
  investorsQr: [
    { investorId: 17, name: 'Anh Quốc', gross: 224_985_000, phiMuaGiu: 2_024_865, traAlpha: 222_960_135, soBill: 6 }
  ],
  tongNdtQrTraVe: 222_960_135,
  tongPhaiHoanNdt: 240_748_011, laiCongTy: 7_635_045, phaiCo: 248_383_056,
  lech: 3_754_079_072 - 248_383_056 // mock: tổng số dư giữ 3,754 tỷ → THỪA (chỉ soi bố cục cột)
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
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1150 }, timezoneId: 'Asia/Ho_Chi_Minh' });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    page.on('pageerror', (e) => console.log('PAGE-ERROR:', e.message));
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/v1/statement-recon/balance-check')) return json(route, BAL);
      if (p.endsWith('/v1/statement-recon/cached')) return json(route, { txns: [
        { rowIndex: 1, dateTime: '2026-09-12T09:20:00', ref: 'FT100001', debit: 20_550_000, credit: 0, desc: 'hoan', cpName: 'NGUYEN VAN A', cpAccount: '999888777', cpBank: 'MB', descName: null, direction: 'OUT', kind: 'DEALER_REFUND', matchedName: 'ĐL- Bảo SG', matchedCustomerId: 211, matchedInvestorId: null, matchType: 'account', edited: false, note: null, effectiveDate: '2026-09-12', srcAccount: 'DEMO-ACCT', srcBank: 'MB', srcHolder: 'KHACH HANG 01' },
        { rowIndex: 2, dateTime: '2026-09-12T10:00:00', ref: 'FT100002', debit: 0, credit: 400_000_000, desc: 'ung', cpName: 'KHACH HANG 02', cpAccount: '50704397', cpBank: 'ACB', descName: null, direction: 'IN', kind: 'INVESTOR_ADVANCE', matchedName: 'NĐT 2', matchedCustomerId: null, matchedInvestorId: 15, matchType: 'account', edited: false, note: null, effectiveDate: '2026-09-12', srcAccount: 'DEMO-ACCT', srcBank: 'MB', srcHolder: 'KHACH HANG 01' }
      ] });
      if (p.endsWith('/v1/ocr-send/classify-options')) return json(route, { dealers: [], investors: [] });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });

    await page.goto(`${baseUrl}/app/statement-recon`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Báo cáo tra soát' }).click();
    await page.waitForTimeout(1200);
    // mở chi tiết NĐT
    await page.getByText(/chi tiết 2 NĐT/).click();
    await page.waitForTimeout(300);
    const sec = page.locator('[data-testid="balance-check"]');
    await sec.scrollIntoViewIfNeeded();
    await sec.screenshot({ path: path.join(OUT, 'balance-check-thieu.png') });
    // Khẳng định SỐ hiển thị
    const tong = await page.locator('[data-testid="tong-so-du"]').textContent();
    const phaiCo = await page.locator('[data-testid="phai-co"]').textContent();
    const lech = await page.locator('[data-testid="o-lech"]').textContent();
    console.log(JSON.stringify({ tong, phaiCo, lechCoThieu: lech?.includes('THIẾU'), lechSo: lech?.includes('20.334.000') }));
  } finally {
    await browser?.close();
    await server.close();
  }
}
void main();
