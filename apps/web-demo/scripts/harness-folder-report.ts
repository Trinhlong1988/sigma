// HARNESS R200 (Admin Demo 8/9) — quét xong folder phải hiện BẢNG BÁO CÁO như báo cáo lô, đủ từng lô lỗi gì,
// có nút Sửa. LEAD tự nhìn ảnh trước khi ship. Chạy: node --import tsx scripts/harness-folder-report.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-folder-report');
const BILL = path.join(ROOT, 'screenshots', 'harness-bug1', '_folder', 'bill_1.jpg');

/** Bảng trả về: 1 lô SAI NGÀY (gate tháng), 1 lô nghi gán nhầm máy, 1 lô chưa gửi, 1 lô sạch. */
function baoCao(): unknown {
  return {
    rows: [
      { idx: 0, fileName: 'bill_1.jpg', hkdName: 'HKD DEMO 50', bankName: 'MB', tid: '59930002', lo: '102', date: '2026-05-08', time: '16:36', truoc: 52101000, fee: 546000, sau: 51555000, trangThai: 'DA_GHI', loi: ['🔴 NGÀY BILL 08/05/2026 cách hôm nay 123 ngày — NGHI OCR đọc nhầm THÁNG/NGÀY (vd 09 ↔ 05).'] },
      { idx: 1, fileName: 'bill_2.jpg', hkdName: 'HKD DEMO 49', bankName: 'MB', tid: 'DEMO-TID-08', lo: '101', date: '2026-09-08', time: '10:12', truoc: 30100000, fee: 316000, sau: 29784000, trangThai: 'DA_GHI', loi: ['🔴 NGHI GÁN NHẦM MÁY: lô 101 nối tiếp dãy lô của "HKD DEMO 50" (lô gần nhất 100).'] },
      { idx: 2, fileName: 'bill_3.jpg', hkdName: '', bankName: '', tid: '53550071', lo: '66', date: '2026-09-08', time: '14:23', truoc: 30100000, fee: 0, sau: 0, trangThai: 'CHUA_GUI', loi: ['🟡 Chưa ghi doanh số (chưa gửi hoặc gửi hụt) — kiểm rồi gửi lại.'] },
      { idx: 3, fileName: 'bill_4.jpg', hkdName: 'HKD DEMO 45', bankName: 'MB', tid: 'DEMO-TID-07', lo: '149', date: '2026-09-08', time: '14:23', truoc: 19774230, fee: 207000, sau: 19567230, trangThai: 'DA_GHI', loi: [] }
    ],
    tong: { soBill: 4, daGhi: 3, chuaGui: 1, docHut: 0, soLoi: 3, tongTruoc: 132075230, tongSau: 100906230 }
  };
}

function reviewItem(): unknown {
  return {
    bill: { tid: '59930002', agencyName: 'HKD DEMO 50', batchNumber: '102', type: 'SETTLEMENT', totalAmount: 52101000, dateTime: '08/05/2026 16:36', settlementCode: null },
    dealerRoomId: 'r-xd', dealerRoomName: 'ĐL- Xuân Đoàn', investorRoomId: null, investorRoomName: null,
    sellFee: { resolved: true, milli: 1420, amount: 546000, source: 'OVERRIDE' }, installFee: null,
    alreadySent: false, warnings: ['🔴 NGÀY BILL 08/05/2026 cách hôm nay 123 ngày — NGHI OCR đọc nhầm THÁNG/NGÀY.'],
    dealerSummary: null, investorSummary: null, availableCardTypes: [{ id: 16, name: 'Ngoài MB-Visa-Master', bankId: 15, isPrimary: true }],
    hkdName: 'HKD DEMO 50', bankName: 'MB', tidSuggestions: []
  };
}

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  const billBytes = await readFile(BILL);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 1000 } })).newPage();
    page.on('pageerror', (e) => console.log('PAGE-ERROR:', e.message));
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (p.endsWith('/v1/ocr-send/ocr') && method === 'POST') return json(route, { ok: true, token: 'tok', kind: 'POS', review: [reviewItem()], cached: false });
      if (p.endsWith('/v1/ocr-send/folder-report')) return json(route, baoCao());
      if (p.endsWith('/v1/ocr-send/classify-options')) return json(route, { dealers: [{ roomId: 'r-xd', name: 'ĐL- Xuân Đoàn' }], investors: [] });
      if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: billBytes });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, method === 'GET' && listLike ? [] : {});
    });

    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    const billDir = path.join(OUT, '_folder');
    await mkdir(billDir, { recursive: true });
    await writeFile(path.join(billDir, 'bill_1.jpg'), billBytes);
    await page.locator('button:has-text("Tự động")').first().click();
    await page.waitForTimeout(400);
    await page.setInputFiles('input[webkitdirectory]', billDir);
    await page.waitForTimeout(3000);
    // Quét hết folder (1 ảnh) → bấm "Bỏ qua bill này" để sang cuối folder → bảng báo cáo hiện.
    const boQua = page.locator('button:has-text("Bỏ qua bill này"):visible').first();
    if (await boQua.count()) { await boQua.click(); await page.waitForTimeout(3500); }

    const bang = page.locator('[data-testid="folder-report"]:visible').first();
    await bang.waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(OUT, '1-bang-bao-cao-folder.png'), fullPage: true });
    console.log('  shot 1-bang-bao-cao-folder.png');

    const txt = (await bang.innerText()).replace(/\s+/g, ' ');
    const can = ['Báo cáo folder', '3 lô CẦN XỬ', 'KHACH HANG 61 3', 'NGHI OCR đọc nhầm THÁNG', 'NGHI GÁN NHẦM MÁY', 'Chưa gửi', 'Sửa bill'];
    const thieu = can.filter((k) => !txt.includes(k));
    console.log(thieu.length ? `  ❌ THIẾU: ${thieu.join(' | ')}` : '  ✅ Bảng có đủ: tiêu đề · số lô cần xử · lỗi từng dòng · trạng thái · nút Sửa');
    if (thieu.length) process.exitCode = 1;
  } finally {
    await browser?.close();
    await server.close();
  }
}

void main();
