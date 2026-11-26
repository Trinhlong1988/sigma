// HARNESS (Admin Demo 31/8 "2 tab phải đồng nhất") — verify bill CHUYỂN KHOẢN ở CẢ 2 TAB: (1) manual review có ẢNH
// bill + nút Gửi; (2) auto review có ẢNH; (3) nút "Dừng OCR" hiện lúc OCR (delay) + bấm → KHÔNG treo trắng.
// Mock /v1/ocr-send/* — KHÔNG chạm bot-api. Chạy: npx tsx scripts/harness-transfer-review.ts
import { build, preview } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-transfer-review');
const BILL_IMG = path.resolve(ROOT, '../../apps/zalo-watcher/golden-transfer/mbbank-huy-daklak.jpg');

const TRANSFER = [{
  senderName: 'KHACH HANG 01', senderIsAlpha: true, senderAccount: null,
  receiverName: 'DLY HUY DAKLAK', receiverAccount: '0900000600',
  content: 'MBCT KHACH HANG 01 chuyen tien D2H CRSC5/397151',
  amount: 122859000, bank: 'VPBank', date: null,
  matchedRoomId: 'r-huy', matchedRoomName: 'ĐL- Huy DakLak',
  needsManualPick: false, warnings: [], direction: 'SIGMA_TO_DEALER', entityType: 'DEALER', entityId: null
}];
const OCR_RESP = { ok: true, token: 'tok-t', kind: 'TRANSFER', transferReview: TRANSFER, review: [], cached: false };
// Bill CK CHƯA phân loại được → needsManualPick → DROPDOWN bắt buộc.
const TRANSFER_PICK = [{ ...TRANSFER[0], matchedRoomId: null, matchedRoomName: null, needsManualPick: true, direction: 'UNKNOWN', entityType: null, warnings: ['Chưa khớp được đối tác — chọn tay.'] }];
const OCR_RESP_PICK = { ok: true, token: 'tok-t', kind: 'TRANSFER', transferReview: TRANSFER_PICK, review: [], cached: false };
const CLASSIFY_OPTIONS = { dealers: [{ roomId: 'r-huy', name: 'ĐL- Huy DakLak' }, { roomId: 'r-binh', name: 'ĐL Anh Bình Sài Gòn' }], investors: [{ id: 15, name: 'NĐT 2' }, { id: 16, name: 'Trung CP' }] };

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error' });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), preview: { port: 0 } });
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:4173';
  const billBytes = await readFile(BILL_IMG);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 1150 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    let delayOcr = false;
    let pickCase = false;
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Tôi Test' }));
      // WEB mode (không inject SigMaPC) → auto dùng webkitdirectory (harness setInputFiles) thay vì readFolderImages.
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* mở lửng */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if ((p.endsWith('/v1/ocr-send/ocr') || p.endsWith('/v1/ocr-send/ocr-file')) && method === 'POST') {
        if (delayOcr) await new Promise((r) => setTimeout(r, 4000)); // giả OCR lâu → test nút Dừng
        return json(route, 200, pickCase ? OCR_RESP_PICK : OCR_RESP);
      }
      if (p.endsWith('/v1/ocr-send/classify-options') && method === 'POST') return json(route, 200, CLASSIFY_OPTIONS);
      if (p.endsWith('/v1/ocr-send/classify-alias') && method === 'POST') return json(route, 200, { ok: true });
      if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: billBytes });
      if (p.endsWith('/v1/ocr-send/send-transfer') && method === 'POST') return json(route, 200, { ok: true, dealerMessageId: 'm1' });
      if (p.endsWith('/v1/ocr-send/scan') && method === 'POST') return json(route, 200, { ok: true, count: 1, newCount: 1, files: [{ path: 'C:/bills/ck.jpg', name: 'ck.jpg', mtime: 1, size: 1, alreadyOcr: false }] });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, 200, method === 'GET' && listLike ? [] : {});
    });

    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    // (1) MANUAL: upload bill CK → TransferReviewCard có ẢNH + nút Gửi
    await page.setInputFiles('input[type=file]', BILL_IMG);
    await page.waitForTimeout(1500);
    const mHasImg = await page.locator('img[alt="bill chuyển khoản"]').isVisible().catch(() => false);
    const mHasSend = await page.getByRole('button', { name: /Gửi nhóm đại lý/ }).isVisible().catch(() => false);
    const mHasTitle = await page.getByText(/Hoàn tiền đại lý/).isVisible().catch(() => false);
    console.log(`[MANUAL transfer] title=${mHasTitle} · ẢNH bill=${mHasImg} · nút Gửi=${mHasSend}`);
    await page.screenshot({ path: path.join(OUT, '1-manual-transfer-review.png'), fullPage: true });

    // (2) MANUAL Dừng: bật delay, upload → nút "Dừng OCR" hiện → bấm → không treo trắng
    delayOcr = true;
    await page.setInputFiles('input[type=file]', BILL_IMG);
    await page.waitForTimeout(600);
    const stopBtn = page.getByRole('button', { name: /Dừng OCR/ });
    const stopVisible = await stopBtn.isVisible().catch(() => false);
    console.log(`[MANUAL] đang OCR → nút "Dừng OCR" hiện=${stopVisible}`);
    await page.screenshot({ path: path.join(OUT, '2-manual-ocr-stop-button.png') });
    await stopBtn.click().catch(() => {});
    await page.waitForTimeout(700);
    const framAfterStop = await page.getByText(/Chọn hoặc chụp ảnh|Đã DỪNG OCR/).isVisible().catch(() => false);
    console.log(`[MANUAL] sau bấm Dừng → về khung/thông báo (không trắng)=${framAfterStop}`);
    await page.screenshot({ path: path.join(OUT, '3-manual-after-stop.png') });
    delayOcr = false;

    // (3) AUTO: RELOAD sạch (reset 'stopped' từ test Dừng manual ở trên) → tab tự động → scan → TransferReviewCard có ẢNH
    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.getByText('Tự động', { exact: false }).click().catch(() => {});
    await page.waitForTimeout(400);
    const fsp = await import('node:fs/promises');
    const billDir = path.join(OUT, '_ckfolder');
    await fsp.mkdir(billDir, { recursive: true });
    await fsp.writeFile(path.join(billDir, 'ck.jpg'), billBytes);
    await page.setInputFiles('input[webkitdirectory]', billDir).catch((e) => console.log('[auto] folder lỗi:', e.message));
    await page.waitForTimeout(2500);
    const aHasImg = await page.locator('img[alt="bill chuyển khoản"]').isVisible().catch(() => false);
    const aHasTitle = await page.getByText(/Hoàn tiền đại lý/).isVisible().catch(() => false);
    console.log(`[AUTO transfer] title=${aHasTitle} · ẢNH bill=${aHasImg}`);
    await page.screenshot({ path: path.join(OUT, '4-auto-transfer-review.png'), fullPage: true });

    // (4) DROPDOWN phân-loại-tay (needsManualPick) — CẢ 2 TAB. MANUAL trước. KHÔNG goto (reload preview lỗi chunk) —
    //     click tab Thủ công + upload lại trên page hiện tại.
    pickCase = true;
    await page.getByText('Thủ công', { exact: false }).click().catch(() => {});
    await page.waitForTimeout(300);
    await page.setInputFiles('input[type=file]', BILL_IMG);
    await page.waitForTimeout(1800);
    const mPickFlag = await page.getByText(/Chưa phân loại được/).isVisible().catch(() => false);
    const mSendDisabled = await page.getByRole('button', { name: /Gửi nhóm đại lý/ }).isDisabled().catch(() => true);
    console.log(`[MANUAL dropdown] cờ "Chưa phân loại"=${mPickFlag} · nút Gửi disabled=${mSendDisabled}`);
    await page.screenshot({ path: path.join(OUT, '5-manual-dropdown-blocked.png'), fullPage: true });
    // chọn loại + đại lý → xác nhận (chờ options load giữa 2 select)
    await page.selectOption('select >> nth=0', 'SIGMA_TO_DEALER').catch((e) => console.log('sel0', e.message));
    await page.waitForTimeout(700);
    await page.selectOption('select >> nth=1', 'r-huy').catch((e) => console.log('sel1', e.message));
    await page.waitForTimeout(300);
    const kindVal = await page.locator('select').nth(0).inputValue().catch(() => '');
    const entVal = await page.locator('select').nth(1).inputValue().catch(() => '');
    console.log(`[MANUAL dropdown] đã chọn loại=${kindVal} entity=${entVal}`);
    await page.getByRole('button', { name: /Xác nhận phân loại/ }).click().catch((e) => console.log('confirm', e.message));
    await page.waitForTimeout(700);
    const mClassified = await page.getByText(/Sửa phân loại/).isVisible().catch(() => false);
    const mSendEnabled = !(await page.getByRole('button', { name: /Gửi nhóm đại lý/ }).isDisabled().catch(() => true));
    console.log(`[MANUAL dropdown] sau xác nhận → có "Sửa phân loại"=${mClassified} · Gửi enabled=${mSendEnabled}`);
    await page.screenshot({ path: path.join(OUT, '6-manual-classified.png'), fullPage: true });
    // SỬA phân loại → mở lại dropdown
    await page.getByRole('button', { name: /Sửa phân loại/ }).click().catch(() => {});
    await page.waitForTimeout(300);
    const mReopen = await page.getByText(/Chưa phân loại được/).isVisible().catch(() => false);
    console.log(`[MANUAL dropdown] bấm "Sửa phân loại" → mở lại dropdown=${mReopen}`);
    await page.screenshot({ path: path.join(OUT, '7-manual-edit-reopen.png'), fullPage: true });

    // (5) AUTO tab dropdown — click tab (không goto)
    await page.getByText('Tự động', { exact: false }).click().catch(() => {});
    await page.waitForTimeout(500);
    await page.setInputFiles('input[webkitdirectory]', billDir).catch(() => {});
    await page.waitForTimeout(2800);
    const aPickFlag = await page.getByText(/Chưa phân loại được/).isVisible().catch(() => false);
    console.log(`[AUTO dropdown] cờ "Chưa phân loại"=${aPickFlag}`);
    await page.screenshot({ path: path.join(OUT, '8-auto-dropdown-blocked.png'), fullPage: true });

    console.log('[harness] xong ->', OUT);
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
