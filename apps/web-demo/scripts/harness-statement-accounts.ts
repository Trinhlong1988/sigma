// HARNESS R200 (Admin Demo 8/9) — màn "Tra soát sao kê": LEAD tự nhìn ảnh trước khi ship 2 thay đổi HÌNH:
//   (a) Lưới TÀI KHOẢN: icon brand + CHIA Ô (Số tài khoản · Ngân hàng · Tên tài khoản), màu theo CHUẨN chung
//       (MB xanh #1650a3 · MBV ĐỎ #d32f2f · ABBank COBAN #0a3d91) — trước đây màn này tự chế (MBV xanh lá).
//   (b) Nút lọc "Tất cả / Ghi nợ / Báo có" + nút chu kỳ: TO + NỔI 3D (trước quá nhỏ, chìm).
// Chạy: node --import tsx scripts/harness-statement-accounts.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-statement-accounts');

/** 1 giao dịch sao kê tối thiểu (đủ field DTO) — 3 tài khoản 3 ngân hàng để soi màu brand. */
function txn(i: number, over: Record<string, unknown>): unknown {
  return {
    rowIndex: i, dateTime: '2026-09-08T09:20:00', ref: `FT${100000 + i}`, debit: 0, credit: 0,
    desc: 'thanh toan', cpName: 'NGUYEN VAN A', cpAccount: '999888777', cpBank: 'MB', descName: null,
    direction: 'OUT', kind: 'DEALER_REFUND', matchedName: 'ĐL- Bảo SG', matchedCustomerId: 211,
    matchedInvestorId: null, matchType: 'account', edited: false, note: null, effectiveDate: '2026-09-08',
    srcAccount: 'DEMO-ACCT', srcBank: 'MB', srcHolder: 'KHACH HANG 01', ...over
  };
}
const TXNS = [
  txn(1, { debit: 20_550_000, srcAccount: 'DEMO-ACCT', srcBank: 'MB', srcHolder: 'KHACH HANG 01' }),
  txn(2, { debit: 17_831_000, srcAccount: 'DEMO-ACCT', srcBank: 'MBV', srcHolder: 'KHACH HANG 22' }),
  txn(3, { credit: 400_000_000, direction: 'IN', kind: 'INVESTOR_ADVANCE', matchedName: 'Trung CP', srcAccount: 'DEMO-ACCT', srcBank: 'ABB', srcHolder: 'KHACH HANG 01' })
];

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    page.on('pageerror', (e) => console.log('PAGE-ERROR:', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 300)); });
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/v1/statement-recon/cached')) return json(route, { txns: TXNS });
      if (p.endsWith('/v1/ocr-send/classify-options')) return json(route, { dealers: [{ roomId: 'r1', name: 'ĐL- Bảo SG' }], investors: [{ id: 16, name: 'Trung CP' }] });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });

    await page.goto(`${baseUrl}/app/statement-recon`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);
    await page.screenshot({ path: path.join(OUT, '1-tai-khoan-va-nut-loc.png'), fullPage: false });
    console.log('  shot 1-tai-khoan-va-nut-loc.png');

    // Khẳng định bằng SỐ: màu brand đúng chuẩn trên viền trái từng dòng tài khoản.
    const mauVien = await page.locator('[style*="border-left-color"]').evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).style.borderLeftColor));
    console.log('  màu viền các dòng tài khoản:', mauVien.join(' | '));
    const can = { MB: 'rgb(22, 80, 163)', MBV: 'rgb(211, 47, 47)', ABB: 'rgb(10, 61, 145)' };
    const thieu = Object.entries(can).filter(([, hex]) => !mauVien.includes(hex)).map(([k]) => k);
    console.log(thieu.length ? `  ❌ THIẾU màu chuẩn: ${thieu.join(', ')}` : '  ✅ Đủ 3 màu chuẩn: MB xanh · MBV đỏ · ABB coban');
    if (thieu.length) process.exitCode = 1;
  } finally {
    await browser?.close();
    await server.close();
  }
}

void main();
