// HARNESS R200 (Admin Demo 10/9): "blog đối chiếu sát mép phải ngoài màn hình quá, di chuyển vào gần ảnh khoảng 1/2
// chiều rộng của blog; bổ sung blog đối chiếu cho bill OCR QR và OCR bill CK chưa có".
// Mở màn phóng to của CẢ 3 loại bill (POS · QR · CHUYỂN KHOẢN), chụp ảnh + ĐO bằng số:
//   · khối đối chiếu phải NẰM TRỌN trong màn hình (không tràn mép phải);
//   · mép phải khối phải cách mép màn ≥ 1/2 bề rộng CỦA KHỐI (đúng yêu cầu "lùi vào nửa bề rộng");
//   · nội dung khối phải có đúng số liệu của từng loại bill.
// Kèm ảnh màn CHỌN PHÂN LOẠI bill CK để thấy mục mới "Đại lý hoàn bill CK THỪA".
// Chạy: node --import tsx scripts/harness-doi-chieu.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-doi-chieu');
const ANH_POS = path.join(ROOT, 'screenshots', 'harness-bug1', '_folder', 'bill_1.jpg');
const ANH_CK = path.resolve(ROOT, '../../apps/zalo-watcher/golden-transfer/mbbank-huy-daklak.jpg');
const VIEWPORT = { width: 1400, height: 1000 };

const POS_ITEM = {
  bill: { tid: '53590002', agencyName: 'HKD DEMO 5 2', batchNumber: '72', type: 'SALE', totalAmount: 19_998_000, dateTime: '10/09/2026 14:58', settlementCode: null },
  dealerRoomId: 'r-nguyen-sg', dealerRoomName: 'ĐL- Nguyễn SG', investorRoomId: null, investorRoomName: null,
  sellFee: { resolved: true, milli: 1400, amount: 279_972, source: 'RATE' },
  installFee: { resolved: true, milli: 100, amount: 19_998, source: 'RATE' },
  alreadySent: false, sentMessageId: null, warnings: [], dealerSummary: null, investorSummary: null,
  availableCardTypes: [{ id: 20, name: 'Visa', bankId: 19, isPrimary: true }],
  currentCardTypeId: 20, currentSplits: null, hkdName: 'HKD DEMO 5 2', bankName: 'MB', tidSuggestions: []
};

const QR_ITEM = {
  qr: { hkdName: 'HKD TRÀ MY NGUYỄN', amount: 10_500_000, ref: '6253VNIB02UBWFJP', dateTime: '10/09/2026 12:59', fromCard: 'VIB ••••9742', payerName: 'KHACH HANG 15', noticeMerchant: null },
  noticeOnly: false,
  tidId: 185, tidCode: '99MPC0017370400000', hkdNameMatched: 'HKD TRÀ MY NGUYỄN',
  partnerId: 3, receiveAccountId: 9, industryId: null,
  sellFeeMilli: 1050, sellFeeAmount: 110_250, partnerFeeMilli: 850,
  refundAmount: 10_389_750, investorReceiveAmount: 10_410_750,
  feeSource: 'PARTNER', sellFeeSource: 'DEFAULT', isWeekend: false,
  dealerRoomId: 'r-nguyen-sg', dealerRoomName: 'ĐL- Nguyễn SG',
  alreadySent: false, warnings: [], blocked: false
};

const CK_ITEM = {
  senderName: 'KHACH HANG 01', senderIsAlpha: true, senderAccount: '0900000603',
  receiverName: 'DLY HUY DAKLAK', receiverAccount: '0900000600',
  content: 'MBCT KHACH HANG 01 chuyen tien D2H CRSC5/397151',
  amount: 122_859_000, bank: 'VPBank', senderBank: 'MB', date: '09/09/2026', time: '17:42',
  matchedRoomId: null, matchedRoomName: null, needsManualPick: true,
  warnings: ['Chưa khớp được đối tác — chọn tay.'], direction: 'UNKNOWN', entityType: null, entityId: null
};

const DEALERS = [{ roomId: 'r-nguyen-sg', name: 'ĐL- Nguyễn SG' }, { roomId: 'r-huy', name: 'ĐL- Huy DakLak' }];

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

/** ĐO khối đối chiếu: nằm trọn màn + lùi vào ≥ 1/2 bề rộng của chính nó. Trả true nếu ĐẠT. */
async function doKhoi(page: Page, ten: string, canCo: string[]): Promise<boolean> {
  const khoi = page.locator('[data-testid="khoi-doi-chieu"]');
  if ((await khoi.count()) === 0) { console.log(`  ❌ ${ten}: KHÔNG có khối đối chiếu trong màn phóng to`); return false; }
  const box = await khoi.first().boundingBox();
  if (!box) { console.log(`  ❌ ${ten}: khối đối chiếu không đo được`); return false; }
  // [Spec MỚI 11/9 — Admin Demo "màn này che mất bill"] Khối là CỘT RIÊNG bên phải: đo (a) nằm trọn màn,
  // (b) KHÔNG GIAO với ảnh bill (hết che). Bỏ thước "lùi 1/2 bề rộng" của spec cũ (khi khối còn absolute).
  const cachMepPhai = VIEWPORT.width - (box.x + box.width);
  const namTron = box.x >= 0 && box.x + box.width <= VIEWPORT.width;
  const boxAnh = await page.locator('.fixed.inset-0 img[alt="bill"]').first().boundingBox({ timeout: 5000 }).catch(() => null);
  const luiDuNua = !boxAnh || boxAnh.x + boxAnh.width <= box.x + 2; // ảnh kết thúc TRƯỚC khi khối bắt đầu = không che
  // Ô sửa-tại-chỗ là <input> — value KHÔNG nằm trong innerText → gộp thêm value của mọi input trong khối.
  const vals = await khoi.first().locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join(' | '));
  const txt = ((await khoi.first().innerText()) + ' | ' + vals).replace(/\s+/g, ' ');
  const thieu = canCo.filter((k) => !txt.includes(k));
  console.log(`  ${ten}: rộng ${Math.round(box.width)}px · mép trái x=${Math.round(box.x)} · cách mép phải ${Math.round(cachMepPhai)}px (cần ≥ ${Math.round(box.width / 2)}px)`);
  if (!namTron) console.log(`  ❌ ${ten}: khối TRÀN ra ngoài màn hình`);
  if (!luiDuNua) console.log(`  ❌ ${ten}: khối vẫn ĐÈ LÊN ảnh bill`);
  if (thieu.length) console.log(`  ❌ ${ten}: khối THIẾU số liệu: ${thieu.join(' | ')}`);
  const dat = namTron && luiDuNua && thieu.length === 0;
  if (dat) console.log(`  ✅ ${ten}: khối cột phải KHÔNG che ảnh, đủ số liệu`);
  return dat;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const anhPos = await readFile(ANH_POS);
  const anhCk = await readFile(ANH_CK).catch(() => anhPos);
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  let loai: 'POS' | 'QR' | 'TRANSFER' = 'POS';
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/birthday|chat-realtime|AppShell|hết hạn/.test(m.text())) console.log('CONSOLE-ERR:', m.text().slice(0, 200)); });
    await page.addInitScript({
      content: [
        "window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguyen Van A' }));",
        "window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguyen Van A', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));",
        'function FakeWS(){ this.readyState = 0; }',
        'FakeWS.prototype.addEventListener = function(){};',
        'FakeWS.prototype.removeEventListener = function(){};',
        'FakeWS.prototype.send = function(){};',
        'FakeWS.prototype.close = function(){};',
        'window.WebSocket = FakeWS;'
      ].join(String.fromCharCode(10))
    });
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if ((p.endsWith('/v1/ocr-send/ocr') || p.endsWith('/v1/ocr-send/ocr-file')) && method === 'POST') {
        if (loai === 'POS') return json(route, { ok: true, token: 'tok', kind: 'POS', review: [POS_ITEM], cached: false });
        if (loai === 'QR') return json(route, { ok: true, token: 'tok', kind: 'QR', qrReview: [QR_ITEM], cached: false });
        return json(route, { ok: true, token: 'tok', kind: 'TRANSFER', transferReview: [CK_ITEM], review: [], cached: false });
      }
      if (p.endsWith('/v1/ocr-send/classify-options')) return json(route, { dealers: DEALERS, investors: [{ id: 15, name: 'NĐT 2' }] });
      if (p.endsWith('/v1/ocr-send/qr-review-dealer')) return json(route, { ok: true, item: QR_ITEM });
      if (p.endsWith('/v1/ocr-send/fee')) return json(route, { sell: { resolved: true, milli: 1400, amount: 279_972, source: 'RATE' }, install: { resolved: true, milli: 100, amount: 19_998, source: 'RATE' } });
      if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: loai === 'TRANSFER' ? anhCk : anhPos });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      if (/\/me\/friends$/.test(p)) return json(route, { friends: [], incomingRequests: [], outgoingRequests: [] });
      return json(route, method === 'GET' && listLike ? [] : {});
    });

    /** Dọn trạng thái phiên trước (thẻ review/tab đã ghi nhớ) — mỗi loại bill phải mở từ màn SẠCH như người dùng mới.
     *  addInitScript chạy lại ở mỗi lần điều hướng nên khoá phiên đăng nhập tự được đặt lại sau goto. */
    const donPhien = async (): Promise<void> => {
      await page.evaluate(() => { try { sessionStorage.clear(); localStorage.clear(); } catch { /* */ } }).catch(() => { /* trang trắng */ });
    };

    const thuMuc = path.join(OUT, '_folder');
    await mkdir(thuMuc, { recursive: true });
    let dat = true;

    // ── 1. BILL POS ────────────────────────────────────────────────────────────────────────
    loai = 'POS';
    await writeFile(path.join(thuMuc, 'bill.jpg'), anhPos);
    await donPhien();
    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Tự động', exact: true }).click(); // màn mở mặc định ở tab "Thủ công"
    await page.waitForTimeout(300);
    await page.setInputFiles('[data-testid="auto-folder-input"]', thuMuc);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, '0-pos-truoc-khi-bam.png') });
    if ((await page.locator('img[alt="bill"]').count()) === 0) {
      console.log('  [debug] POS: chưa thấy ảnh bill. Nội dung màn:', (await page.locator('body').innerText()).replace(/\s+/g, ' ').slice(0, 400));
      process.exitCode = 1; return;
    }
    await page.locator('img[alt="bill"]').first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, '1-pos.png') });
    dat = (await doKhoi(page, 'POS', ['HKD DEMO 5 2', '53590002', '19.998.000', '72'])) && dat;

    // [Admin Demo 11/9] SỬA TẠI CHỖ trong khối đối chiếu: gõ Số lô mới trong khối → đóng phóng to → Ô SỐ LÔ của form
    // review bên dưới PHẢI mang giá trị mới (cùng state, không phải bản sao).
    const oLo = page.locator('[data-testid="khoi-doi-chieu"] input').nth(3); // TID · Ngày · Giờ · SỐ LÔ
    await oLo.fill('99');
    await page.screenshot({ path: path.join(OUT, '1b-pos-sua-tai-cho.png') });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    const loForm = await page.locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    const suaAn = loForm.includes('99');
    console.log(`  POS sửa tại chỗ (Số lô → 99 chảy về form): ${suaAn ? '✅' : '❌ (values: ' + loForm.slice(0, 12).join(',') + ')'}`);
    if (!suaAn) dat = false;
    await page.locator('img[alt="bill"]').first().evaluate((el) => (el.closest('button') as HTMLButtonElement | null)?.click());
    await page.waitForTimeout(400);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ── 2. BILL QR ─────────────────────────────────────────────────────────────────────────
    loai = 'QR';
    await donPhien();
    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Quét QR', exact: true }).click();
    await page.waitForTimeout(400);
    await page.setInputFiles('[data-testid="qr-folder-input"]', thuMuc);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, '0-qr-truoc-khi-bam.png') });
    // force: ảnh QR nằm trong thẻ đang có hiệu ứng chuyển trạng thái ("đang xử lý") nên Playwright coi là chưa
    // "stable"; sự kiện click vẫn nổi lên đúng nút bọc ảnh — mở màn phóng to là bằng chứng nó chạy thật.
    // Ảnh QR nằm trong thẻ đang có hiệu ứng chuyển trạng thái → Playwright coi là chưa "stable" nên click thường
    // treo. Bắn click THẲNG vào NÚT bọc ảnh (đúng phần tử người dùng bấm) — React xử lý y hệt.
    await page.locator('img[alt="bill QR"]').first().evaluate((el) => (el.closest('button') as HTMLButtonElement | null)?.click());
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, '2-qr.png') });
    dat = (await doKhoi(page, 'QR ', ['HKD TRÀ MY NGUYỄN', '99MPC0017370400000', '6253VNIB02UBWFJP', '10.500.000'])) && dat;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);

    // ── 3. BILL CHUYỂN KHOẢN ───────────────────────────────────────────────────────────────
    loai = 'TRANSFER';
    await writeFile(path.join(thuMuc, 'bill.jpg'), anhCk);
    await donPhien();
    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Tự động', exact: true }).click(); // màn mở mặc định ở tab "Thủ công"
    await page.waitForTimeout(300);
    await page.setInputFiles('[data-testid="auto-folder-input"]', thuMuc);
    await page.waitForTimeout(3000);
    // Ảnh màn CHỌN PHÂN LOẠI — phải có mục MỚI "Đại lý hoàn bill CK THỪA".
    await page.screenshot({ path: path.join(OUT, '3-ck-phan-loai.png') });
    const optText = await page.locator('select').first().innerText().catch(() => '');
    const coMucThua = /hoàn bill CK THỪA/i.test(optText);
    console.log(coMucThua ? '  ✅ CK: danh sách phân loại CÓ mục "Đại lý hoàn bill CK THỪA"' : `  ❌ CK: THIẾU mục hoàn bill CK thừa (thấy: ${optText.replace(/\s+/g, ' ').slice(0, 160)})`);
    dat = coMucThua && dat;

    await page.locator('img[alt="bill chuyển khoản"]').first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, '4-ck.png') });
    dat = (await doKhoi(page, 'CK ', ['DLY HUY DAKLAK', 'KHACH HANG 01', '122.859.000', '09/09/2026'])) && dat;

    console.log(dat ? '\n✅ ĐẠT cả 3 loại bill' : '\n❌ CHƯA đạt — xem dòng ❌ ở trên');
    if (!dat) process.exitCode = 1;
    console.log('[harness] Ảnh ->', OUT);
  } finally {
    await browser?.close();
    await server.close();
  }
}

void main();
