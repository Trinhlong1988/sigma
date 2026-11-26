// HARNESS verify (Admin Demo 7/9): PANEL "Nghi sót lô / sai ngày-giờ" ghim đầu RoomRevenueScreen + HOVER nổi-nhẹ (bỏ nháy).
// Dữ liệu = SỐ THẬT lấy từ DB sigma (findLotGaps kỳ 04-05/09): KHACH HANG 62 1 thiếu 38 + sai giờ · KHACH HANG 62 3 thiếu 126 ·
// KHACH HANG 61 2 thiếu 137/141/143 + nghi đọc sai lô 1010/1057. Inject qua mock /v1/** để render không cần session.
import { build, preview } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-lot-gap-panel');
const ROOM = 'room-demo';

const TIDS = [
  { tidId: 1, tid: '53550071', hkdName: 'HKD DEMO 43', bankName: 'MB', linkedAt: '', linkedBy: null },
  { tidId: 2, tid: 'DEMO-TID-07', hkdName: 'HKD DEMO 45', bankName: 'MB', linkedAt: '', linkedBy: null },
  { tidId: 3, tid: 'DEMO-TID-08', hkdName: 'HKD DEMO 49', bankName: 'MB', linkedAt: '', linkedBy: null }
];
// Vài lô đại diện (để bảng lô hiện + test hover). effDateIso có giờ.
const ROWS = [
  { loId: 601, tidId: 1, date: '2026-09-04', effDateIso: '2026-09-04T00:06:00.000Z', bankReportedLoNumber: null, billLoNumber: '42', investorNickname: 'Mr Nguyễn SG', gross: 14000000, fee: 196000, net: 13804000 },
  { loId: 602, tidId: 1, date: '2026-09-04', effDateIso: '2026-09-04T02:52:00.000Z', bankReportedLoNumber: null, billLoNumber: '41', investorNickname: 'Mr Nguyễn SG', gross: 14190512, fee: 198667, net: 13991845 },
  { loId: 603, tidId: 2, date: '2026-09-04', effDateIso: '2026-09-04T05:09:00.000Z', bankReportedLoNumber: null, billLoNumber: '125', investorNickname: 'Mr Nguyễn SG', gross: 29575070, fee: 414051, net: 29161019 },
  { loId: 604, tidId: 2, date: '2026-09-04', effDateIso: '2026-09-04T06:07:00.000Z', bankReportedLoNumber: null, billLoNumber: '127', investorNickname: 'Mr Nguyễn SG', gross: 4912252, fee: 68772, net: 4843480 },
  { loId: 605, tidId: 3, date: '2026-09-04', effDateIso: '2026-09-04T06:17:00.000Z', bankReportedLoNumber: null, billLoNumber: '136', investorNickname: 'Mr Nguyễn SG', gross: 25869682, fee: 362176, net: 25507506 },
  { loId: 606, tidId: 3, date: '2026-09-04', effDateIso: '2026-09-04T06:55:00.000Z', bankReportedLoNumber: null, billLoNumber: '138', investorNickname: 'Mr Nguyễn SG', gross: 149232086, fee: 2089249, net: 147142837 }
];
const DAILY = [{ date: '2026-09-04', gross: 237779602, net: 234450687 }];
const REPORT = { from: '2026-09-01', to: '2026-09-07', tids: TIDS, totalGross: 237779602, totalFee: 3328915, totalNet: 234450687, loCount: 6, daily: DAILY, rows: ROWS };

// SỐ THẬT từ findLotGaps (đã verify trên DB).
const LOT_GAPS = [
  { tid: '53550071', hkdName: 'HKD DEMO 43', day: '2026-09-04', missing: [38], suspectMisread: [], timeBackward: [{ lot: 40, time: '03:15', prevLot: 39, prevTime: '09:06' }], seenCount: 7, sparse: false },
  { tid: 'DEMO-TID-07', hkdName: 'HKD DEMO 45', day: '2026-09-04', missing: [126], suspectMisread: [], timeBackward: [], seenCount: 12, sparse: false },
  { tid: 'DEMO-TID-08', hkdName: 'HKD DEMO 49', day: '2026-09-04', missing: [137, 141, 143], suspectMisread: [1010, 1057], timeBackward: [], seenCount: 14, sparse: false }
];

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error' });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), preview: { port: 0 } });
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:4173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* mở lửng */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (/ocr-send\/lot-gaps/.test(p)) return json(route, 200, { ok: true, data: { days: 7, gaps: LOT_GAPS } });
      // [item 3] resolve lô→tin-bill: trả messageId.
      if (/\/lo\/\d+\/edit-source$/.test(p)) return json(route, 200, { ok: true, data: { messageId: 'msg-demo', current: { amount: 14000000, lo: '42', tid: '53550071', dateTime: '05/09/2026 06:17', hkdName: 'HKD DEMO 43', bank: 'MB' } } });
      // [item 3 — SỬA bằng card review OCR] prepare-edit → {token, review:[item]}; fee; image.
      if (/prepare-edit$/.test(p)) return json(route, 200, { ok: true, token: 'edit-tok', kind: 'POS', editMessageId: 'msg-demo', review: [{ bill: { tid: '53550071', agencyName: 'HKD DEMO 43', batchNumber: '42', type: 'SALE', totalAmount: 14000000, dateTime: '05/09/2026 06:17', settlementCode: null }, dealerRoomId: 'room-demo', dealerRoomName: 'ĐL- Mr Nguyễn SG', investorRoomId: null, investorRoomName: null, sellFee: { resolved: true, milli: 1400, amount: 196000 }, installFee: { resolved: true, milli: 1000, amount: 140000 }, alreadySent: true, sentMessageId: 'msg-demo', warnings: [], dealerSummary: null, investorSummary: null, availableCardTypes: [{ id: 16, name: 'Ngoài MB-Visa-Master', bankId: 15, isPrimary: true }], hkdName: 'HKD DEMO 43', bankName: 'MB' }] });
      if (/ocr-send\/fee$/.test(p)) return json(route, 200, { ok: true, sell: { resolved: true, milli: 1400, amount: 196000 }, install: { resolved: true, milli: 1000, amount: 140000 } });
      if (/ocr-send\/image/.test(p)) { const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64'); return route.fulfill({ status: 200, contentType: 'image/png', body: png }); }
      if (/edit-bill-params$/.test(p)) return json(route, 200, { ok: true, updatedMessageIds: ['msg-demo'], revenueUpdated: true, oldAmount: 14000000, newAmount: 14000000 });
      if (/\/revenue$/.test(p)) return json(route, 200, { ok: true, data: REPORT });
      if (/refund-reconcile$/.test(p)) return json(route, 200, { ok: true, data: { from: '2026-09-01', to: '2026-09-07', days: [{ date: '2026-09-04', canHoan: 100000000, daHoan: 100000000, thuaThieu: 0, status: 'match' }], totalCanHoan: 100000000, totalDaHoan: 100000000, totalThuaThieu: 0, totalDaUng: 0, unmatchedDaHoan: 0, bills: [{ messageId: 'b2', billDate: '2026-09-04', billTime: '09:30', amount: 60000000, kind: 'REFUND', senderName: 'Nguyễn A', senderBank: null, receiverName: 'Bảo', bank: 'MB' }, { messageId: 'b1', billDate: '2026-09-04', billTime: '06:15', amount: 40000000, kind: 'REFUND', senderName: 'Trần B', senderBank: null, receiverName: 'Bảo', bank: 'MB' }] } });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, 200, route.request().method() === 'GET' && listLike ? [] : {});
    });
    await page.goto(`${baseUrl}/app/chat/${ROOM}/revenue`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(900);

    // Panel có hiện? đọc text.
    const panelHdr = page.getByText(/Nghi sót lô \/ sai ngày-giờ/).first();
    const hasPanel = await panelHdr.isVisible().catch(() => false);
    const showThieu38 = await page.getByText(/THIẾU lô: 38/).first().isVisible().catch(() => false);
    const showThieu126 = await page.getByText(/THIẾU lô: 126/).first().isVisible().catch(() => false);
    const showMisread = await page.getByText(/Nghi đọc sai lô: 1010, 1057/).first().isVisible().catch(() => false);
    const showSaiGio = await page.getByText(/Sai giờ: lô 40/).first().isVisible().catch(() => false);
    console.log('[PANEL] hiện=', hasPanel, '· thiếu38=', showThieu38, '· thiếu126=', showThieu126, '· nghi-sai=', showMisread, '· sai-giờ=', showSaiGio);
    await page.screenshot({ path: path.join(OUT, '1-panel-top.png') });
    // [Admin Demo 7/9] Bấm "Từ → Đến" → ô chọn ngày gọn 1 hàng.
    const rangeBtn = page.getByRole('button', { name: /Từ.*Đến/ }).first();
    if (await rangeBtn.isVisible().catch(() => false)) { await rangeBtn.click(); await page.waitForTimeout(400); await page.screenshot({ path: path.join(OUT, '1b-range-row.png') }); }

    // Cuộn container trong tới bảng "Chi tiết theo Lô" (inner overflow-auto — fullPage KHÔNG bắt được).
    const scroller = page.locator('div.overflow-auto').first();
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; }).catch(() => {});
    await page.waitForTimeout(500);
    // Tìm 1 hàng lô (số tiền 13.804.000) rồi HOVER → chụp để mắt thấy chỉ ĐẬM NỀN nhẹ (không nhấc/phóng/đổ-bóng).
    const loCell = page.getByText('13.804.000').first();
    const box = await loCell.boundingBox().catch(() => null);
    console.log('[HOVER] tìm thấy hàng lô 13.804.000 =', !!box);
    if (box) {
      await page.mouse.move(box.x + 40, box.y + box.height / 2);
      await page.waitForTimeout(300);
    }
    await page.screenshot({ path: path.join(OUT, '2-table-hover.png') });

    // [item 3] Bấm "Sửa" → nhập mật khẩu → "Mở sửa" → BillReviewCard (ĐÚNG card review OCR) render.
    const editBtn = page.getByRole('button', { name: /^Sửa$/ }).first();
    const hasEdit = await editBtn.isVisible().catch(() => false);
    console.log('[SỬA] nút Sửa hiện =', hasEdit);
    if (hasEdit) {
      await editBtn.click();
      await page.waitForTimeout(400);
      const pwdBox = page.getByPlaceholder(/mật khẩu/).first();
      const hasPwd = await pwdBox.isVisible().catch(() => false);
      console.log('[SỬA] hiện ô mật khẩu =', hasPwd);
      await page.screenshot({ path: path.join(OUT, '4-edit-password.png') });
      if (hasPwd) {
        await pwdBox.fill('1111');
        await page.getByRole('button', { name: /Mở sửa/ }).click();
        await page.waitForTimeout(900);
        // BillReviewCard render? kiểm có nút "Gửi" + ô TID/tiền của card review
        const hasReviewCard = await page.getByText(/Sửa bill ·.*bấm/).first().isVisible().catch(() => false);
        const hasSendBtn = await page.getByRole('button', { name: /^Gửi/ }).first().isVisible().catch(() => false);
        console.log('[SỬA] BillReviewCard mở =', hasReviewCard, '· có nút Gửi =', hasSendBtn);
        await page.screenshot({ path: path.join(OUT, '5-edit-reviewcard.png'), fullPage: true });
      }
    }
    console.log('[harness] Chụp xong ->', OUT);
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
