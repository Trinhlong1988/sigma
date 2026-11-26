// HARNESS R200 (Admin Demo 17/9 "đóng lô 95 MB ko chặn gửi" + "MBV cũng thế, xác nhận gửi được"):
// ĐIỀU KHIỂN THẬT trên màn Quét bill gửi — bill đóng lô 95 của MB/MBV phải GỬI ĐƯỢC NGAY (nút Gửi bật, không có ô
// tick bắt buộc), bill 95 của ngân hàng KHÁC vẫn phải CHẶN tới khi tick. Đây là đổi HÀNH VI gate tiền nên ảnh tĩnh
// không đủ: harness đọc trạng thái disabled THẬT của nút Gửi.
// Chạy: node --import tsx scripts/harness-95-mb-khong-chan.ts
import { preview } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReviewItem } from '../src/lib/ocr-send-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', '95-mb-khong-chan');
const ANH_POS = path.join(ROOT, 'screenshots', 'harness-bug1', '_folder', 'bill_1.jpg');

function posItem(bankName: string, huy = false): ReviewItem {
  return {
    // huy=true → ĐÚNG SỐ THẬT bill ABB lô 75 TID 67512202: thanh toán 109.613.000, hủy 1 GD 11.000 → ghi 109.602.000.
    bill: huy
      ? { tid: '67512202', agencyName: 'HKD DEMO 27', batchNumber: '75', type: 'SETTLEMENT', totalAmount: 109_613_000, dateTime: '16/09/2026 11:51', settlementCode: null, voidCount: 1, voidAmount: 11_000 }
      : { tid: '20281024', agencyName: 'HKD DEMO 32', batchNumber: '84', type: 'SALE', totalAmount: 18_643_000, dateTime: '16/09/2026 19:35', settlementCode: '95' },
    dealerRoomId: 'r-nguyen-sg', dealerRoomName: 'ĐL- Nguyễn SG', investorRoomId: 'r-thong', investorRoomName: 'Thông Thái Nguyên',
    sellFee: { resolved: true, milli: 1400, amount: 261_002 }, installFee: { resolved: true, milli: 1100, amount: 205_073 },
    alreadySent: false, sentMessageId: null, warnings: [], dealerSummary: null, investorSummary: null,
    availableCardTypes: [{ id: 20, name: 'Visa', bankId: 14, isPrimary: true }],
    currentCardTypeId: 20, currentSplits: null, hkdName: 'HKD DEMO 32', bankName, tidSuggestions: []
  };
}

const json = (route: Route, body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', preview: { port: 0 } });
  const base = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  let bankHienTai = 'MBV';
  let caHuy = false;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1050 }, timezoneId: 'Asia/Ho_Chi_Minh' });
    const page = await ctx.newPage();
    // [Admin Demo 25/9] TRUYỀN CHUỖI, KHÔNG truyền HÀM: tsx/esbuild bọc mọi hàm bằng `__name(...)` khi biên dịch file
    // harness; hàm đó được serialize nguyên si sang trình duyệt → `__name is not defined` → TRANG CHẾT, harness vẫn
    // thoát 0 và in "dấu SOS=false" (xanh giả kiểu R198). Chuỗi thuần không bị transform nên chạy đúng.
    await page.addInitScript(`
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));
      window.sessionStorage.removeItem('ocrSend.parent');
      window.WebSocket = function () { this.readyState = 0; this.addEventListener = function () {}; this.removeEventListener = function () {}; this.send = function () {}; this.close = function () {}; };
    `);
    page.on('pageerror', (e) => console.log('PAGE-ERROR:', e.message, '|', String(e.stack ?? '').replace(/\s+/g, ' ').slice(0, 220)));
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      // [Admin Demo 25/9] Client nay gọi ĐƯỜNG CHẠY NỀN (ship 0.6.196 chống "mất mạng" khi OCR lâu):
      //   POST /ocr-send/ocr-async → {jobId} ; GET /ocr-send/ocr-job/:id → {status:'DONE', ketQua:{...}}.
      // Harness cũ chỉ mock đường ĐỒNG BỘ → client nhận sai shape → thẻ review KHÔNG dựng, harness vẫn thoát 0.
      const ketQuaOcr = (): unknown => ({ ok: true, token: 'tok-95', kind: 'POS', review: [posItem(bankHienTai, caHuy)], cached: false });
      if (p.includes('/ocr-send/ocr-job/')) return json(route, { ok: true, status: 'DONE', ketQua: ketQuaOcr() });
      if (p.includes('/ocr-send/ocr-async')) return json(route, { ok: true, jobId: 'job-95' });
      if (p.endsWith('/v1/ocr-send/ocr') || p.includes('/ocr-send/ocr')) return json(route, ketQuaOcr());
      if (p.includes('/ocr-send/image') || p.includes('/ocr/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: await readFile(ANH_POS) });
      // Thiếu 2 mock này → mảng undefined → `.find` nổ → THẺ REVIEW SẬP (error boundary), ảnh chụp ra trang lỗi.
      if (p.includes('/ocr-send/classify-options')) return json(route, { ok: true, dealers: [{ roomId: 'r-nguyen-sg', name: 'ĐL- Nguyễn SG' }], investors: [{ id: 1, name: 'Thông Thái Nguyên' }] });
      // jsonCall coi TOÀN BỘ body là `data` → mock phải trả các trường ở MỨC GỐC, bọc trong {data:…} là undefined.
      if (p.includes('/ocr-send/reroute')) return json(route, { dealerRoomId: 'r-nguyen-sg', dealerRoomName: 'ĐL- Nguyễn SG', investorRoomId: null, investorRoomName: null, availableCardTypes: [{ id: 20, name: 'Visa', bankId: 14, isPrimary: true }], primaryCardTypeId: 20, hkdName: 'HKD DEMO 32', bankName: bankHienTai });
      if (p.includes('/ocr-send/folder-report')) return json(route, { ok: true, items: [], tong: 0 });
      if (p.includes('/ocr-send/fee')) return json(route, { ok: true, sell: { resolved: true, milli: 1400, amount: 261_002 }, install: { resolved: true, milli: 1100, amount: 205_073 } });
      const listLike = /friends|categories|rooms|contacts|notifications|feed|members|list/i.test(p);
      const rong = route.request().method() === 'GET' && listLike ? [] : {};
      return json(route, p.startsWith('/v1/chat/') ? { ok: true, data: rong } : rong);
    });

    /** Mở màn Quét bill gửi (tab Thủ công) → nạp 1 ảnh → đọc trạng thái nút Gửi + ô tick. */
    async function thuNganHang(bank: string, tag: string): Promise<void> {
      bankHienTai = bank;
      await page.goto(`${base}/app/ocr-send?mode=manual`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(900);
      await page.setInputFiles('input[type="file"]', ANH_POS).catch(() => undefined);
      await page.waitForTimeout(1800);
      const coDau95 = await page.getByTestId('canh-bao-95').first().isVisible().catch(() => false);
      const coTick = await page.getByTestId('ack-95').count().catch(() => 0);
      const nutGui = page.getByRole('button', { name: /^Gửi|Gửi vào nhóm/ }).first();
      const hienNut = await nutGui.isVisible().catch(() => false);
      const bibat = hienNut ? await nutGui.isDisabled().catch(() => true) : null;
      const chuDuoiNut = await page.getByText(/Tick xác nhận rủi ro đóng lô 95/).count().catch(() => 0);
      console.log(`[${bank}] dấu SOS=${coDau95} · ô tick bắt buộc=${coTick} · nút Gửi bị khoá=${bibat} · dòng "Tick xác nhận…"=${chuDuoiNut}`);
      // Cuộn tới khối cảnh báo 95 + nút Gửi rồi chụp — LEAD phải NHÌN THẤY (R200), không tin số suông.
      await page.getByTestId('canh-bao-95').first().scrollIntoViewIfNeeded().catch(() => undefined);
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `${tag}.png`), fullPage: false });
    }

    // [Admin Demo 17/9] BILL CÓ GIAO DỊCH HỦY: review phải HIỆN 3 số (tổng quẹt · hủy · ghi nhận).
    caHuy = true;
    await thuNganHang('ABBANK', '0-bill-co-huy');
    const coKhoiHuy = await page.getByTestId('khoi-huy-gd').first().isVisible().catch(() => false);
    const tienHuy = await page.getByTestId('tien-huy').first().textContent().catch(() => null);
    const tienGhi = await page.getByTestId('tien-ghi-nhan').first().textContent().catch(() => null);
    console.log('[BILL HỦY] khối hủy hiện =', coKhoiHuy, '· tiền hủy =', JSON.stringify(tienHuy?.trim()), '· ghi nhận =', JSON.stringify(tienGhi?.trim()), '(mong 109.602.000đ)');
    caHuy = false;

    await thuNganHang('MBV', '1-mbv-khong-chan');
    await thuNganHang('MB', '2-mb-khong-chan');
    await thuNganHang('ABBANK', '3-bank-khac-van-chan');
    console.log('[harness] Ảnh →', OUT);
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
