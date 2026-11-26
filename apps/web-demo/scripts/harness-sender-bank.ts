// HARNESS (Admin Demo 2/9) — HỌC "NGÂN HÀNG NGƯỜI GỬI" bill CK. Render THẬT:
//  (A) TransferReviewCard trạng thái CHƯA học (ô nhập NH gửi + nút "Lưu ghi nhớ" + cờ vàng).
//  (B) Sau bấm "Lưu ghi nhớ" (mock /v1/ocr-send/sender-bank-alias ok) → hiện "Đã ghi nhớ NH người gửi: MB" + sửa được.
//  (C) TransferReviewCard senderBank ĐÃ có sẵn từ OCR-học (transfer.senderBank='VP') → hiện + cho sửa ngay.
//  (D) Bảng CK trong RoomRevenueScreen: cột "NH gửi" ĐIỀN giá trị (mock 1 bill có senderBank='MB').
// Mock /v1/** — KHÔNG chạm bot-api. Chạy: npx tsx scripts/harness-sender-bank.ts
import { build, preview } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-sender-bank');
const BILL_IMG = path.resolve(ROOT, '../../apps/zalo-watcher/golden-transfer/mbbank-huy-daklak.jpg');

// Bill CK CHƯA học NH gửi (senderBank=null) — có senderAccount để học được.
const TRANSFER_UNLEARNED = [{
  senderName: 'KHACH HANG 01', senderIsAlpha: true, senderAccount: '0900000600',
  receiverName: 'DLY HUY DAKLAK', receiverAccount: '0123456789',
  content: 'MBCT KHACH HANG 01 chuyen tien D2H',
  amount: 122859000, bank: 'VPBank', senderBank: null, date: '02/09/2026 14:22',
  matchedRoomId: 'r-huy', matchedRoomName: 'ĐL- Huy DakLak',
  needsManualPick: false, warnings: [], direction: 'SIGMA_TO_DEALER', entityType: 'DEALER', entityId: null
}];
// Bill CK ĐÃ học (senderBank='VP' đến từ OCR-học lần trước).
const TRANSFER_LEARNED = [{ ...TRANSFER_UNLEARNED[0], senderBank: 'VP' }];
// token KHÁC nhau giữa 2 case → CK_SNAP_KEY khác → KHÔNG lẫn snapshot sessionStorage (chưa-học vs đã-học).
const respOcr = (learned: boolean) => ({ ok: true, token: learned ? 'tok-learned' : 'tok-unlearned', kind: 'TRANSFER', transferReview: learned ? TRANSFER_LEARNED : TRANSFER_UNLEARNED, review: [], cached: false });

// ── Mock cho RoomRevenueScreen (bảng CK) ──
const ROOM_DETAIL = { id: 'r-huy', type: 'GROUP', name: 'ĐL- Huy DakLak', avatarColor: '#0579cc', avatarUrl: null, directPairKey: null, pinnedMessageId: null, lastMessageAt: null, readOnly: false, requireApproval: false, maxMembers: null, createdBy: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' };
const TIDS = [{ tidId: 1, tid: '10012345', hkdName: 'HKD Huy', bankName: 'MB', linkedAt: '2026-09-01T00:00:00Z', linkedBy: 1 }];
const REVENUE = {
  from: '2026-09-01', to: '2026-09-02', tids: TIDS, totalGross: 122859000, totalFee: 1200000, totalNet: 121659000, loCount: 1,
  daily: [{ date: '2026-09-02', gross: 122859000, net: 121659000 }],
  rows: [{ loId: 1, tidId: 1, date: '2026-09-02', effDateIso: '2026-09-02T07:22:00Z', bankReportedLoNumber: 93, billLoNumber: '93', investorNickname: 'NĐT 2', gross: 122859000, fee: 1200000, net: 121659000 }]
};
// RefundReconcileReport — days>0 + bills có senderBank ('MB' đã học) và 1 bill chưa học ('—').
const RECONCILE = {
  from: '2026-09-01', to: '2026-09-02',
  days: [{ date: '2026-09-02', canHoan: 121659000, daHoan: 121659000, thuaThieu: 0, status: 'match' }],
  totalCanHoan: 121659000, totalDaHoan: 121659000, totalThuaThieu: 0, unmatchedDaHoan: 0, totalDaUng: 0,
  bills: [
    { messageId: 'm1', billDate: '2026-09-02', billTime: '14:22', amount: 121659000, kind: 'REFUND', senderName: 'KHACH HANG 01', receiverName: 'DLY HUY DAKLAK', bank: 'VPBank', senderBank: 'MB' },
    { messageId: 'm2', billDate: '2026-09-02', billTime: null, amount: 5000000, kind: 'ADVANCE', senderName: 'KHACH HANG 22', receiverName: 'DLY HUY DAKLAK', bank: 'ACB', senderBank: null }
  ]
};

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error' });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), preview: { port: 0 } });
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:4173';
  const billBytes = await readFile(BILL_IMG);
  let learned = false;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 1150 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Tôi Test' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* mở lửng */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if ((p.endsWith('/v1/ocr-send/ocr') || p.endsWith('/v1/ocr-send/ocr-file')) && method === 'POST') return json(route, 200, respOcr(learned));
      if (p.endsWith('/v1/ocr-send/sender-bank-alias') && method === 'POST') return json(route, 200, { ok: true });
      if (p.endsWith('/v1/ocr-send/classify-options') && method === 'POST') return json(route, 200, { dealers: [{ roomId: 'r-huy', name: 'ĐL- Huy DakLak' }], investors: [{ id: 15, name: 'NĐT 2' }] });
      if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: billBytes });
      if (p.endsWith('/v1/ocr-send/send-transfer') && method === 'POST') return json(route, 200, { ok: true, dealerMessageId: 'm1' });
      // RoomRevenueScreen mocks — chatFetch đòi envelope {ok:true, data}.
      if (/\/v1\/chat\/rooms\/[^/]+\/revenue/.test(p) && method === 'GET') return json(route, 200, { ok: true, data: REVENUE });
      if (/\/v1\/chat\/rooms\/[^/]+\/refund-reconcile/.test(p) && method === 'GET') return json(route, 200, { ok: true, data: RECONCILE });
      if (/\/v1\/chat\/rooms\/[^/]+\/tids/.test(p) && method === 'GET') return json(route, 200, { ok: true, data: TIDS });
      if (/\/v1\/chat\/rooms\/[^/]+$/.test(p) && method === 'GET') return json(route, 200, { ok: true, data: ROOM_DETAIL });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, 200, method === 'GET' && listLike ? [] : {});
    });

    // ── (A) CHƯA học: upload bill CK → ô "NH người gửi" + nút Lưu ghi nhớ + cờ vàng ──
    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.setInputFiles('input[type=file]', BILL_IMG);
    await page.waitForTimeout(1500);
    const hasLabel = await page.getByText('NH người gửi', { exact: false }).first().isVisible().catch(() => false);
    const hasSaveBtn = await page.getByRole('button', { name: /Lưu ghi nhớ/ }).isVisible().catch(() => false);
    const hasWarn = await page.getByText(/OCR không đọc được NH người gửi/).isVisible().catch(() => false);
    console.log(`[A CHƯA học] ô "NH người gửi"=${hasLabel} · nút "Lưu ghi nhớ"=${hasSaveBtn} · cờ vàng=${hasWarn}`);
    await page.screenshot({ path: path.join(OUT, 'A-chua-hoc-input-luu.png'), fullPage: true });

    // ── (B) nhập bank + bấm Lưu ghi nhớ → hiện "Đã ghi nhớ NH người gửi: MB" ──
    const inp = page.locator('input[placeholder*="MB, VP"]').first();
    await inp.fill('mb');
    await page.waitForTimeout(200);
    await page.getByRole('button', { name: /Lưu ghi nhớ/ }).click().catch((e) => console.log('luu', e.message));
    await page.waitForTimeout(700);
    const savedNote = await page.getByText(/Đã ghi nhớ NH người gửi/).isVisible().catch(() => false);
    const savedVal = await page.getByText(/Đã ghi nhớ NH người gửi: MB/).isVisible().catch(() => false);
    console.log(`[B ĐÃ lưu] note "Đã ghi nhớ"=${savedNote} · giá trị=MB=${savedVal}`);
    await page.screenshot({ path: path.join(OUT, 'B-da-luu-hien-bank.png'), fullPage: true });

    // ── (C) senderBank ĐÃ có sẵn từ OCR-học (transfer.senderBank='VP') → hiện ngay + cho sửa ──
    learned = true;
    await page.setInputFiles('input[type=file]', BILL_IMG);
    await page.waitForTimeout(1500);
    const learnedVal = await page.locator('input[placeholder*="MB, VP"]').first().inputValue().catch(() => '');
    const learnedNote = await page.getByText(/Đã ghi nhớ NH người gửi: VP/).isVisible().catch(() => false);
    console.log(`[C OCR-học sẵn] input value=${learnedVal} · note VP=${learnedNote}`);
    await page.screenshot({ path: path.join(OUT, 'C-ocr-hoc-san-VP.png'), fullPage: true });

    // ── (D) Bảng CK trong RoomRevenueScreen — cột "NH gửi" điền 'MB' cho bill đã học ──
    await page.goto(`${baseUrl}/app/chat/r-huy/revenue`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1800);
    const ckTableHead = await page.getByText('NH gửi', { exact: false }).first().isVisible().catch(() => false);
    const mbInTable = await page.getByText('MB', { exact: true }).first().isVisible().catch(() => false);
    console.log(`[D bảng CK] header "NH gửi"=${ckTableHead} · ô 'MB' hiện=${mbInTable}`);
    // Cuộn tới bảng "Từng bill hoàn/ứng" để chụp rõ cột.
    await page.getByText(/Từng bill hoàn\/ứng/).scrollIntoViewIfNeeded().catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'D-bang-ck-nh-gui.png'), fullPage: true });

    console.log('[harness] xong ->', OUT);
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
