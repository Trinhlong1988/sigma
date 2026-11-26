// HARNESS AGENT 3/5 (11/9) — KIỂM CHỨNG UI BẰNG ẢNH các màn OCR/doanh số. CHỈ NỘP ẢNH + SỐ ĐO (JSON console),
// KHÔNG kết luận xanh — LEAD nhìn ảnh quyết (R200). Mock API đúng SHAPE thật (type từ src/lib), KHÔNG gọi API live.
// 6 màn:
//   1. OcrSendScreen card POS: warning "ℹ Đã áp BẢN SỬA gần nhất…" + Gửi bị chặn khi có cảnh báo phải tick.
//   2. Card bill ĐÓNG LÔ 95: banner đỏ + tick + đo màu/tương phản.
//   3. ImageZoomCompare (phóng to): khối 470px cột phải không đè ảnh, ngày trọn, dropdown Thẻ, dòng Đại lý + NĐT.
//   4. MyRevenueScreen (/app/revenue): NĐT ghim trên, đại lý giảm dần, 4/5 ô, số vi-VN trọn, 2 mép thẳng — 390 + 1150.
//   5. InvestorRevenueScreen (/app/investor-revenue): dropdown "Ca tiền" cùng hàng filter — 390 + 1150.
//   6. TransferReviewCard: cảnh báo "⚠ NGHI TRÙNG" CK cùng tiền/ngày + modal sửa bill (tiêu đề Lô · TID · HKD)
//      + modal sửa bill CK từ RoomRevenueScreen.
// Chạy: node --import tsx scripts/harness-agent3-ui.ts   (cwd = apps/web-demo)
import { createServer } from 'vite';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ReviewItem, TransferReview } from '../src/lib/ocr-send-api';
import type { RoomRevenueReport, RoomRevenueRow, RoomTidDto, RefundReconcileReport } from '../src/lib/chat-client';
import type { MyInvestorReport, InvestorFilterOptions, MyInvestorSettlement } from '../src/lib/investor-report-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'agent3');
const ANH_POS = path.join(ROOT, 'screenshots', 'harness-bug1', '_folder', 'bill_1.jpg');
const ANH_CK = path.resolve(ROOT, '../../apps/zalo-watcher/golden-transfer/mbbank-huy-daklak.jpg');

// ── FIXTURES (shape thật từ src/lib — typecheck gãy là mock lệch) ────────────────────────────────────────
const WARN_BAN_SUA = 'ℹ Đã áp BẢN SỬA gần nhất — OCR gốc: TID DEMO-TID-07 · lô 94 · 21.000.000đ · 30/08 14:12.';
const WARN_BLOCK = 'Ngày trên bill (09/09/2026) LÙI so với bill trước trong folder — kiểm lại thứ tự/ngày.';
const NGHI_TRUNG = '⚠ NGHI TRÙNG: phòng này ĐÃ có bill CK cùng SỐ TIỀN 122.859.000đ cùng NGÀY 09/09/2026 (tin msg-ck-cu) nhưng mã GD/ảnh KHÁC — có thể CÙNG 1 giao dịch chụp 2 ảnh hoặc OCR đọc lệch mã. KIỂM kỹ trước khi gửi (chống hoàn x2).';

function posItem(overrides: Partial<ReviewItem> = {}, bill: Partial<ReviewItem['bill']> = {}): ReviewItem {
  return {
    bill: { tid: '53590002', agencyName: 'HKD DEMO 5 2', batchNumber: '72', type: 'SALE', totalAmount: 19_998_000, dateTime: '10/09/2026 14:58', settlementCode: null, ...bill },
    dealerRoomId: 'r-nguyen-sg', dealerRoomName: 'ĐL- Nguyễn SG', investorRoomId: 'r-thong', investorRoomName: 'Thông Thái Nguyên',
    sellFee: { resolved: true, milli: 1400, amount: 279_972 }, installFee: { resolved: true, milli: 100, amount: 19_998 },
    alreadySent: false, sentMessageId: null, warnings: [], dealerSummary: null, investorSummary: null,
    availableCardTypes: [{ id: 20, name: 'Visa', bankId: 19, isPrimary: true }, { id: 21, name: 'Ngoài MB-Visa-Master', bankId: 19, isPrimary: false }],
    currentCardTypeId: 20, currentSplits: null, hkdName: 'HKD DEMO 5 2', bankName: 'MB', tidSuggestions: [],
    ...overrides
  };
}

const CK_NGHI_TRUNG: TransferReview = {
  senderName: 'KHACH HANG 01', senderIsAlpha: true, senderAccount: '0900000603',
  receiverName: 'DLY HUY DAKLAK', receiverAccount: '0900000600',
  content: 'MBCT KHACH HANG 01 chuyen tien D2H CRSC5/397151',
  amount: 122_859_000, bank: 'VPBank', senderBank: 'MB', date: '09/09/2026', time: '17:42',
  matchedRoomId: 'r-huy', matchedRoomName: 'ĐL- Huy DakLak', needsManualPick: false,
  warnings: [NGHI_TRUNG], direction: 'SIGMA_TO_DEALER', entityType: 'DEALER', entityId: null,
  alreadySent: false, sentMessageId: null
};

// Màn 4 — KPI nhóm (khuôn harness-doanh-so-nhom): 2 NĐT + 3 đại lý xáo thứ tự doanh số để chứng minh sort.
const ROOMS4 = [
  { id: 'r-thong', name: 'Thông Thái Nguyên' }, { id: 'r-trung', name: 'Trung CP' },
  { id: 'r-huy', name: 'ĐL- Huy DakLak' }, { id: 'r-nguyen', name: 'ĐL- Mr Nguyễn SG' }, { id: 'r-qr-bao', name: 'QR Bảo SG' }
];
const KPI4 = [
  { roomId: 'r-thong', grossHomNay: 1_248_500_000, netHomNay: 1_236_015_000, grossHomQua: 986_000_000, soLoHomNay: 42, laNdt: true, canHoan: null, daHoan: null, thuaThieu: null, daUng: null, hoanUng: null, ndtDaTamUng: 500_000_000, ndtDaHoanLai: 100_000_000, ndtLoiNhuan: 1_248_500 },
  { roomId: 'r-trung', grossHomNay: 0, netHomNay: 0, grossHomQua: 152_000_000, soLoHomNay: 0, laNdt: true, canHoan: null, daHoan: null, thuaThieu: null, daUng: null, hoanUng: null, ndtDaTamUng: 0, ndtDaHoanLai: 0, ndtLoiNhuan: 0 },
  { roomId: 'r-huy', grossHomNay: 84_635_000, netHomNay: 83_581_832, grossHomQua: 96_120_000, soLoHomNay: 6, laNdt: false, canHoan: 83_581_832, daHoan: 50_000_000, thuaThieu: -13_581_832, daUng: 20_000_000, hoanUng: 5_000_000, ndtDaTamUng: null, ndtDaHoanLai: null, ndtLoiNhuan: null },
  { roomId: 'r-nguyen', grossHomNay: 212_889_000, netHomNay: 209_907_000, grossHomQua: 180_400_000, soLoHomNay: 11, laNdt: false, canHoan: 209_907_000, daHoan: 209_905_000, thuaThieu: -2_000, daUng: 0, hoanUng: 0, ndtDaTamUng: null, ndtDaHoanLai: null, ndtLoiNhuan: null },
  { roomId: 'r-qr-bao', grossHomNay: 10_500_000, netHomNay: 10_389_750, grossHomQua: 0, soLoHomNay: 1, laNdt: false, canHoan: 10_389_750, daHoan: 0, thuaThieu: -10_389_750, daUng: 0, hoanUng: 0, ndtDaTamUng: null, ndtDaHoanLai: null, ndtLoiNhuan: null }
];

// Màn 5 — báo cáo NĐT (shape investor-report-client).
const INV_REPORT: MyInvestorReport = {
  from: '2026-09-11', to: '2026-09-11',
  investors: [
    { investorId: 15, code: 'NDT15', investorName: 'Thông Thái Nguyên', doanhThu: 1_248_500_000, soBill: 42, laiNDT: 1_248_500, tienVe: 1_236_015_000, daHoan: { doanhThu: 900_000_000, soBill: 30, laiNDT: 900_000 }, chuaHoan: { doanhThu: 348_500_000, soBill: 12, laiNDT: 348_500 } },
    { investorId: 16, code: 'NDT16', investorName: 'Trung CP', doanhThu: 152_000_000, soBill: 9, laiNDT: 152_000, tienVe: 150_480_000, daHoan: { doanhThu: 152_000_000, soBill: 9, laiNDT: 152_000 }, chuaHoan: { doanhThu: 0, soBill: 0, laiNDT: 0 } }
  ]
};
const INV_OPTS: InvestorFilterOptions = {
  tids: [{ id: 1, tid: '53550081', hkdName: 'HKD DEMO 19', bankId: 1, bankName: 'MB' }, { id: 2, tid: '20280808', hkdName: 'HKD DEMO 6-1', bankId: 2, bankName: 'MBV' }],
  banks: [{ id: 1, name: 'MB' }, { id: 2, name: 'MBV' }]
};
const INV_SETTLE: MyInvestorSettlement = { from: '2026-09-11', to: '2026-09-11', rows: [] };

// Màn 6b — RoomRevenueScreen (khuôn harness-room-revenue, rút gọn 2 lô + 1 bill hoàn).
const HOM_NAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const TIDS6: RoomTidDto[] = [
  { tidId: 1, tid: '53550081', hkdName: 'HKD DEMO 19', bankName: 'MB', linkedAt: '', linkedBy: null }
];
const ROWS6: RoomRevenueRow[] = [
  { loId: 504, tidId: 1, date: HOM_NAY, effDateIso: HOM_NAY + 'T01:00:00.000Z', bankReportedLoNumber: null, billLoNumber: '5', investorNickname: 'NĐT Demo', borrowed: false, tidOwnerName: null, gross: 5_000_000, fee: 70_000, net: 4_930_000 }
];
const REPORT6: RoomRevenueReport = { from: HOM_NAY, to: HOM_NAY, tids: TIDS6, totalGross: 5_000_000, totalFee: 70_000, totalNet: 4_930_000, loCount: 1, daily: [{ date: HOM_NAY, gross: 5_000_000, net: 4_930_000 }], rows: ROWS6 };
const RECON6: RefundReconcileReport = {
  from: HOM_NAY, to: HOM_NAY,
  days: [{ date: HOM_NAY, canHoan: 4_930_000, daHoan: 122_859_000, thuaThieu: 117_929_000, status: 'over' }],
  totalCanHoan: 4_930_000, totalDaHoan: 122_859_000, totalDaUng: 0, totalThuaThieu: 117_929_000, unmatchedDaHoan: 0,
  bills: [{ messageId: 'msg-ck-1', billDate: HOM_NAY, billTime: '17:42', amount: 122_859_000, kind: 'REFUND', senderName: 'KHACH HANG 01', receiverName: 'DLY HUY DAKLAK', bank: 'VPBank', senderBank: 'MB' }]
};

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────
async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}
function report(man: string, checks: Record<string, unknown>): void {
  console.log(`\n[ĐO ${man}] ${JSON.stringify(checks, null, 2)}`);
}
/** Tương phản WCAG từ 2 màu rgb() computed. */
function contrastRatio(fg: string, bg: string): number {
  const lum = (c: string): number => {
    const m = c.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0'];
    const [r, g, b] = m.slice(0, 3).map((v) => {
      const s = Number(v) / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const l1 = lum(fg); const l2 = lum(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

type Muc = 'POS_BAN_SUA' | 'POS_95' | 'CK_NGHI_TRUNG';
let muc: Muc = 'POS_BAN_SUA';

async function newPage(ctx: BrowserContext): Promise<Page> {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 250)));
  page.on('console', (m) => { if (m.type() === 'error' && !/birthday|chat-realtime|AppShell|hết hạn|Failed to load resource/.test(m.text())) console.log('CONSOLE-ERR:', m.text().slice(0, 250)); });
  return page;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const anhPos = await readFile(ANH_POS);
  const anhCk = await readFile(ANH_CK).catch(() => anhPos);
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();

    const initScript = {
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
    };

    /** Mock chung mọi endpoint /v1/** — trả theo `muc` đang test. */
    const mockRoutes = async (page: Page): Promise<void> => {
      await page.routeWebSocket(/^ws/, () => { /* */ });
      await page.route('**/v1/**', async (route) => {
        const p = new URL(route.request().url()).pathname;
        const method = route.request().method();
        // OCR màn 1/2/6a
        if ((p.endsWith('/v1/ocr-send/ocr') || p.endsWith('/v1/ocr-send/ocr-file')) && method === 'POST') {
          if (muc === 'POS_BAN_SUA') return json(route, { ok: true, token: 'tok-1', kind: 'POS', review: [posItem({ warnings: [WARN_BAN_SUA, WARN_BLOCK] })], cached: false });
          if (muc === 'POS_95') return json(route, { ok: true, token: 'tok-2', kind: 'POS', review: [posItem({ warnings: [] }, { settlementCode: '95', batchNumber: '95' })], cached: false });
          return json(route, { ok: true, token: 'tok-3', kind: 'TRANSFER', transferReview: [CK_NGHI_TRUNG], review: [], cached: false });
        }
        if (p.endsWith('/v1/ocr-send/fee') && method === 'POST') return json(route, { sell: { resolved: true, milli: 1400, amount: 279_972 }, install: { resolved: true, milli: 100, amount: 19_998 } });
        if (p.endsWith('/v1/ocr-send/classify-options')) return json(route, { dealers: [{ roomId: 'r-huy', name: 'ĐL- Huy DakLak' }, { roomId: 'r-nguyen-sg', name: 'ĐL- Nguyễn SG' }], investors: [{ id: 15, name: 'NĐT 2' }] });
        if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: muc === 'CK_NGHI_TRUNG' ? anhCk : anhPos });
        // Màn 4
        if (p.endsWith('/v1/chat/rooms-revenue-kpi')) return json(route, { ok: true, data: KPI4 });
        if (p.endsWith('/v1/chat/rooms')) return json(route, { ok: true, data: ROOMS4.map((r) => ({ id: r.id, name: r.name, type: 'GROUP', memberCount: 3, unreadCount: 0, lastMessage: null, lastMessageAt: null, members: [] })) });
        // Màn 5
        if (p.endsWith('/v1/me/investor-report')) return json(route, INV_REPORT);
        if (p.endsWith('/v1/me/investor-report/filter-options')) return json(route, INV_OPTS);
        if (p.endsWith('/v1/me/investor-settlement')) return json(route, INV_SETTLE);
        // Màn 6b — RoomRevenueScreen
        if (/\/revenue$/.test(p)) return json(route, { ok: true, data: REPORT6 });
        if (/refund-reconcile$/.test(p)) return json(route, { ok: true, data: RECON6 });
        if (/\/lo\/\d+\/edit-source$/.test(p)) return json(route, { ok: true, data: { messageId: 'msg-pos-1', current: { amount: 5_000_000, lo: '5', tid: '53550081', dateTime: `${HOM_NAY} 08:00`, hkdName: 'HKD DEMO 19', bank: 'MB' } } });
        if (p.endsWith('/v1/ocr-send/prepare-edit') && method === 'POST') {
          const body = route.request().postDataJSON() as { messageId?: string };
          if (body?.messageId === 'msg-ck-1') return json(route, { ok: true, token: 'tok-edit-ck', kind: 'CK', transferReview: [CK_NGHI_TRUNG], review: [] });
          return json(route, { ok: true, token: 'tok-edit-pos', kind: 'POS', review: [posItem({ sentMessageId: 'msg-pos-1', alreadySent: true }, { tid: '53550081', agencyName: 'HKD DEMO 19', batchNumber: '5', totalAmount: 5_000_000 })] });
        }
        if (p.endsWith('/v1/ocr-send/lot-gaps') || /lot-gaps/.test(p)) return json(route, { ok: true, data: { days: 7, gaps: [] } });
        if (/\/me\/friends$/.test(p)) return json(route, { friends: [], incomingRequests: [], outgoingRequests: [] });
        const listLike = /categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
        return json(route, method === 'GET' && listLike ? [] : {});
      });
    };

    const thuMuc = path.join(OUT, '_folder');
    await mkdir(thuMuc, { recursive: true });
    await writeFile(path.join(thuMuc, 'bill.jpg'), anhPos);

    // ════ MÀN 1 — POS card: warning ℹ BẢN SỬA + Gửi bị chặn (viewport desktop 1400×1000) ════
    {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
      const page = await newPage(ctx);
      await page.addInitScript(initScript);
      await mockRoutes(page);
      muc = 'POS_BAN_SUA';
      await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
      await page.setInputFiles('input[type=file]', ANH_POS);
      await page.waitForTimeout(2500);
      const card = page.locator('img[alt="bill"]').first();
      const coCard = (await card.count()) > 0;
      let checks: Record<string, unknown> = { cardHien: coCard };
      if (coCard) {
        const warnEl = page.getByText(WARN_BAN_SUA.slice(0, 40)).first();
        const coWarn = await warnEl.isVisible().catch(() => false);
        const warnBox = coWarn ? await warnEl.boundingBox() : null;
        const warnDo = coWarn ? await warnEl.evaluate((e) => {
          const el = e as HTMLElement;
          return { textDayDu: (el.textContent ?? '').length, scrollW: el.scrollWidth, clientW: el.clientWidth, tranNgang: el.scrollWidth > el.clientWidth + 1 };
        }) : null;
        const fullText = coWarn ? ((await warnEl.textContent()) ?? '').includes('OCR gốc') : false;
        const nutGui = page.getByRole('button', { name: /Tick xác nhận gửi dù có cảnh báo|Gửi vào nhóm đại lý/ }).first();
        const guiDisabled = await nutGui.isDisabled().catch(() => null);
        const guiText = ((await nutGui.textContent().catch(() => '')) ?? '').trim();
        checks = {
          ...checks,
          warningBanSuaHien: coWarn,
          warningBox: warnBox ? { x: Math.round(warnBox.x), y: Math.round(warnBox.y), w: Math.round(warnBox.width), h: Math.round(warnBox.height) } : null,
          warningKhongTranNgang: warnDo ? !warnDo.tranNgang : null,
          warningDo: warnDo,
          warningCoDuChu_OCRgoc: fullText,
          nutGuiDisabled_khiCoCanhBaoPhaiTick: guiDisabled,
          nutGuiText: guiText
        };
        await page.screenshot({ path: path.join(OUT, '1-pos-ban-sua-desktop.png'), fullPage: false });
        await warnEl.scrollIntoViewIfNeeded().catch(() => { /* */ });
        await page.screenshot({ path: path.join(OUT, '1b-pos-ban-sua-warning.png') });
      } else {
        await page.screenshot({ path: path.join(OUT, '1-pos-ban-sua-KHONG-CARD.png'), fullPage: true });
      }
      report('MÀN 1 — POS BẢN SỬA + chặn Gửi', checks);
      await ctx.close();
    }

    // ════ MÀN 2 — Card bill ĐÓNG LÔ 95: banner + tick + màu/tương phản ════
    {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
      const page = await newPage(ctx);
      await page.addInitScript(initScript);
      await mockRoutes(page);
      muc = 'POS_95';
      await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
      await page.setInputFiles('input[type=file]', ANH_POS);
      await page.waitForTimeout(2500);
      const banner = page.getByText(/BILL ĐÓNG LÔ 95/).first();
      const coBanner = await banner.isVisible().catch(() => false);
      let checks: Record<string, unknown> = { banner95Hien: coBanner };
      if (coBanner) {
        await banner.scrollIntoViewIfNeeded();
        const mau = await banner.evaluate((e) => {
          const el = e as HTMLElement;
          const cs = getComputedStyle(el);
          // Nền thật = leo lên cha tới khi gặp nền không trong suốt (banner dùng bg-danger/10 đè trên card trắng).
          let bg = 'rgb(255,255,255)';
          let cur: HTMLElement | null = el;
          while (cur) {
            const b = getComputedStyle(cur).backgroundColor;
            if (b && !/rgba\(0, 0, 0, 0\)|transparent/.test(b)) { bg = b; break; }
            cur = cur.parentElement;
          }
          return { color: cs.color, bgGanNhat: bg, fontSize: cs.fontSize, fontWeight: cs.fontWeight };
        });
        const tick = page.locator('input[type=checkbox]').filter({ has: page.locator(':scope') });
        const tickRow = page.getByText(/Tôi đã kiểm tra rủi ro đóng lô 95/).first();
        const coTick = await tickRow.isVisible().catch(() => false);
        const nutGui = page.getByRole('button', { name: /Tick xác nhận rủi ro đóng lô 95|Gửi vào nhóm đại lý/ }).first();
        const disabledTruocTick = await nutGui.isDisabled().catch(() => null);
        const guiTextTruoc = ((await nutGui.textContent().catch(() => '')) ?? '').trim();
        await page.screenshot({ path: path.join(OUT, '2-lo95-desktop.png') });
        // tick → nút mở
        if (coTick) {
          await tickRow.locator('input[type=checkbox]').first().click().catch(async () => { await tickRow.click(); });
          await page.waitForTimeout(400);
        }
        const disabledSauTick = await page.getByRole('button', { name: /Gửi vào nhóm đại lý|Tick xác nhận/ }).first().isDisabled().catch(() => null);
        await page.screenshot({ path: path.join(OUT, '2b-lo95-sau-tick.png') });
        void tick;
        checks = {
          ...checks,
          mauBanner: mau,
          tuongPhan_WCAG: Math.round(contrastRatio(mau.color, mau.bgGanNhat) * 100) / 100,
          oTickHien: coTick,
          nutGuiDisabled_truocTick: disabledTruocTick, nutGuiText_truocTick: guiTextTruoc,
          nutGuiDisabled_sauTick: disabledSauTick
        };
      } else {
        await page.screenshot({ path: path.join(OUT, '2-lo95-KHONG-BANNER.png'), fullPage: true });
      }
      report('MÀN 2 — ĐÓNG LÔ 95', checks);
      await ctx.close();

      // ════ MÀN 3 — ImageZoomCompare (dùng lại card 95? không — mở card BẢN SỬA sạch) ════
      const ctx3 = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
      const page3 = await newPage(ctx3);
      await page3.addInitScript(initScript);
      await mockRoutes(page3);
      muc = 'POS_BAN_SUA';
      await page3.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
      await page3.setInputFiles('input[type=file]', ANH_POS);
      await page3.waitForTimeout(2500);
      await page3.locator('img[alt="bill"]').first().click();
      await page3.waitForTimeout(700);
      const khoi = page3.locator('[data-testid="khoi-doi-chieu"]');
      const coKhoi = (await khoi.count()) > 0;
      let checks3: Record<string, unknown> = { khoiHien: coKhoi };
      if (coKhoi) {
        const boxKhoi = await khoi.first().boundingBox();
        const boxAnh = await page3.locator('.fixed.inset-0 img[alt="bill"]').first().boundingBox().catch(() => null);
        const khongDe = !!boxKhoi && !!boxAnh && boxAnh.x + boxAnh.width <= boxKhoi.x + 2;
        // Ngày trọn: ô input Ngày trong khối (hang[0])
        const oNgay = khoi.first().locator('input').nth(1); // input 0 = TID (phu), 1 = Ngày, 2 = Giờ, 3 = Số lô
        const doNgay = await oNgay.evaluate((e) => {
          const el = e as HTMLInputElement;
          return { value: el.value, scrollW: el.scrollWidth, clientW: el.clientWidth, tran: el.scrollWidth > el.clientWidth + 1 };
        }).catch(() => null);
        // Dropdown Thẻ trọn tên: đo bề rộng chữ option đang chọn vs bề rộng select
        const oThe = khoi.first().locator('select').first();
        const doThe = await oThe.evaluate((e) => {
          const el = e as HTMLSelectElement;
          const label = el.selectedOptions[0]?.textContent ?? '';
          const span = document.createElement('span');
          const cs = getComputedStyle(el);
          span.style.font = cs.font; span.style.position = 'absolute'; span.style.visibility = 'hidden'; span.style.whiteSpace = 'nowrap';
          span.textContent = label;
          document.body.appendChild(span);
          const wText = span.getBoundingClientRect().width;
          span.remove();
          return { label, wText: Math.round(wText), wSelect: el.clientWidth, tronTen: wText <= el.clientWidth - 18 };
        }).catch(() => null);
        const txtKhoi = ((await khoi.first().innerText()) + ' | ' + (await khoi.first().locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join(' | ')))).replace(/\s+/g, ' ');
        checks3 = {
          ...checks3,
          khoiRong_px: boxKhoi ? Math.round(boxKhoi.width) : null,
          khoiBox: boxKhoi ? { x: Math.round(boxKhoi.x), w: Math.round(boxKhoi.width) } : null,
          anhBox: boxAnh ? { x: Math.round(boxAnh.x), w: Math.round(boxAnh.width), phai: Math.round(boxAnh.x + boxAnh.width) } : null,
          khoiKhongDeAnh: khongDe,
          ngay: doNgay,
          dropdownThe: doThe,
          coDongDaiLy: txtKhoi.includes('ĐẠI LÝ') || txtKhoi.includes('Đại lý'),
          coDongNdt: txtKhoi.includes('NĐT'),
          giaTriDaiLy: txtKhoi.includes('ĐL- Nguyễn SG'),
          giaTriNdt: txtKhoi.includes('Thông Thái Nguyên')
        };
        await page3.screenshot({ path: path.join(OUT, '3-zoom-doi-chieu-desktop.png') });
      } else {
        await page3.screenshot({ path: path.join(OUT, '3-zoom-KHONG-KHOI.png') });
      }
      report('MÀN 3 — Khối đối chiếu phóng to', checks3);
      await ctx3.close();
    }

    // ════ MÀN 4 — MyRevenueScreen: desktop 1150 + mobile 390 ════
    for (const vp of [{ w: 1150, h: 800, ten: 'desktop-1150' }, { w: 390, h: 844, ten: 'mobile-390' }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      const page = await newPage(ctx);
      await page.addInitScript(initScript);
      await mockRoutes(page);
      await page.goto(`${baseUrl}/app/revenue`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1500);
      const hang = page.locator('ul > li > button');
      const soHang = await hang.count();
      const tenThuTu = soHang > 0 ? await hang.evaluateAll((els) => els.map((e) => (e.querySelector('[data-testid="cot-ten"] span')?.textContent ?? '').trim())) : [];
      const laNdtDau = tenThuTu.slice(0, 2).join('|') === 'Thông Thái Nguyên|Trung CP';
      const dlGiamDan = tenThuTu.slice(2).join('|') === 'ĐL- Mr Nguyễn SG|ĐL- Huy DakLak|QR Bảo SG';
      let oNdt = 0; let oDl = 0; let soTron: { text: string; tran: boolean } | null = null;
      let mepPhaiThang: boolean | null = null; let mepPhaiSo: number[] = [];
      let tranNgangTrang: { scrollW: number; vw: number; tran: boolean } | null = null;
      if (soHang === 5) {
        oNdt = await hang.nth(0).locator('div[title]').count();
        oDl = await hang.nth(2).locator('div[title]').count();
        soTron = await hang.nth(0).locator('div[title]').first().evaluate((e) => {
          const el = e.querySelectorAll('div')[1] as HTMLElement;
          const cs = el ? getComputedStyle(el) : null;
          return {
            text: (el?.textContent ?? '').trim(), tran: el ? el.scrollWidth > el.clientWidth + 1 : true,
            scrollW: el?.scrollWidth ?? -1, clientW: el?.clientWidth ?? -1,
            fontSize: cs?.fontSize ?? '', oRong: Math.round((e as HTMLElement).getBoundingClientRect().width)
          } as { text: string; tran: boolean };
        });
        const mepNdt = await hang.nth(0).locator('div[title]').last().evaluate((e) => Math.round(e.getBoundingClientRect().right));
        const mepDl1 = await hang.nth(2).locator('div[title]').last().evaluate((e) => Math.round(e.getBoundingClientRect().right));
        const mepDl2 = await hang.nth(3).locator('div[title]').last().evaluate((e) => Math.round(e.getBoundingClientRect().right));
        mepPhaiSo = [mepNdt, mepDl1, mepDl2];
        mepPhaiThang = Math.max(...mepPhaiSo) - Math.min(...mepPhaiSo) <= 2;
      }
      tranNgangTrang = await page.evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement;
        return { scrollW: el.scrollWidth, vw: window.innerWidth, tran: el.scrollWidth > window.innerWidth + 1 };
      });
      await page.screenshot({ path: path.join(OUT, `4-doanh-so-nhom-${vp.ten}.png`), fullPage: true });
      report(`MÀN 4 — Doanh số nhóm ${vp.ten}`, {
        soHang, thuTu: tenThuTu, ndtGhimTren: laNdtDau, daiLyGiamDan: dlGiamDan,
        soO_NDT: oNdt, soO_DaiLy: oDl,
        soTyNdtTron: soTron, mepPhai_px: mepPhaiSo, mepPhaiThang,
        trangTranNgang: tranNgangTrang
      });
      await ctx.close();
    }

    // ════ MÀN 5 — InvestorRevenueScreen: dropdown Ca tiền cùng hàng filter (1150 + 390) ════
    for (const vp of [{ w: 1150, h: 800, ten: 'desktop-1150' }, { w: 390, h: 844, ten: 'mobile-390' }]) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
      const page = await newPage(ctx);
      await page.addInitScript(initScript);
      await mockRoutes(page);
      await page.goto(`${baseUrl}/app/investor-revenue`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1500);
      const labelCa = page.locator('label', { hasText: 'Ca tiền' }).first();
      const coCa = await labelCa.isVisible().catch(() => false);
      let checks5: Record<string, unknown> = { dropdownCaTienHien: coCa };
      if (coCa) {
        const selCa = labelCa.locator('select');
        const options = await selCa.locator('option').allTextContents();
        const boxCa = await selCa.boundingBox();
        const boxBank = await page.locator('label', { hasText: 'Ngân hàng' }).first().locator('select').boundingBox();
        const boxTid = await page.locator('label', { hasText: /^TID/ }).first().locator('select').boundingBox().catch(() => null);
        const cungHangBank = !!boxCa && !!boxBank && Math.abs(boxCa.y - boxBank.y) <= 4;
        const cungHangTid = !!boxCa && !!boxTid && Math.abs(boxCa.y - boxTid.y) <= 4;
        const tranNgang = await page.evaluate(() => {
          const el = document.scrollingElement ?? document.documentElement;
          return { scrollW: el.scrollWidth, vw: window.innerWidth, tran: el.scrollWidth > window.innerWidth + 1 };
        });
        const caTrongMan = !!boxCa && boxCa.x >= 0 && boxCa.x + boxCa.width <= vp.w;
        checks5 = {
          ...checks5,
          options,
          duDoption: options.join('|') === 'Tất cả|Ca 1|Ca 2|Ca 3',
          boxCa: boxCa ? { x: Math.round(boxCa.x), y: Math.round(boxCa.y), w: Math.round(boxCa.width) } : null,
          boxNganHang: boxBank ? { x: Math.round(boxBank.x), y: Math.round(boxBank.y) } : null,
          boxTid: boxTid ? { x: Math.round(boxTid.x), y: Math.round(boxTid.y) } : null,
          cungHangVoiNganHang: cungHangBank, cungHangVoiTid: cungHangTid,
          caTronTrongMan: caTrongMan,
          trangTranNgang: tranNgang
        };
      }
      await page.screenshot({ path: path.join(OUT, `5-investor-revenue-${vp.ten}.png`), fullPage: false });
      report(`MÀN 5 — Ca tiền NĐT ${vp.ten}`, checks5);
      await ctx.close();
    }

    // ════ MÀN 6a — TransferReviewCard: cảnh báo ⚠ NGHI TRÙNG (OcrSendScreen thủ công) ════
    {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
      const page = await newPage(ctx);
      await page.addInitScript(initScript);
      await mockRoutes(page);
      muc = 'CK_NGHI_TRUNG';
      await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
      await page.setInputFiles('input[type=file]', ANH_CK).catch(async () => { await page.setInputFiles('input[type=file]', ANH_POS); });
      await page.waitForTimeout(2500);
      const warnNt = page.getByText(/NGHI TRÙNG/).first();
      const coNt = await warnNt.isVisible().catch(() => false);
      let checks6a: Record<string, unknown> = { canhBaoNghiTrungHien: coNt };
      if (coNt) {
        await warnNt.scrollIntoViewIfNeeded();
        const doNt = await warnNt.evaluate((e) => {
          const el = e as HTMLElement;
          const cs = getComputedStyle(el);
          return { fontSize: cs.fontSize, color: cs.color, textLen: (el.textContent ?? '').length, scrollW: el.scrollWidth, clientW: el.clientWidth, tranNgang: el.scrollWidth > el.clientWidth + 1 };
        });
        const duChu = ((await warnNt.textContent()) ?? '').includes('chống hoàn x2');
        checks6a = { ...checks6a, doNghiTrung: doNt, coDuChu_chongHoanX2: duChu };
      }
      await page.screenshot({ path: path.join(OUT, '6a-ck-nghi-trung-desktop.png'), fullPage: true });
      report('MÀN 6a — CK NGHI TRÙNG (tab thủ công)', checks6a);
      await ctx.close();
    }

    // ════ MÀN 6b — RoomRevenueScreen: modal SỬA bill (tiêu đề Lô · TID · HKD) + SỬA bill CK (TransferReviewCard) ════
    {
      const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
      const page = await newPage(ctx);
      await page.addInitScript(initScript);
      await mockRoutes(page);
      muc = 'CK_NGHI_TRUNG'; // ảnh trả về cho card CK trong modal
      await page.goto(`${baseUrl}/app/chat/room-demo/revenue`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1200);
      // (i) Nút Sửa trên lô POS → mật khẩu → BillReviewCard, tiêu đề "Sửa bill · Lô 5 · TID … · HKD …"
      const nutSuaLo = page.locator('[data-testid="lot-row"] button:has-text("Sửa")').first();
      const coNutSuaLo = await nutSuaLo.isVisible().catch(() => false);
      let checks6b: Record<string, unknown> = { nutSuaLoHien: coNutSuaLo };
      if (coNutSuaLo) {
        await nutSuaLo.click();
        await page.waitForTimeout(500);
        await page.locator('input[type=password]').first().fill('1111');
        await page.keyboard.press('Enter');
        await page.waitForTimeout(1500);
        const tieuDe = page.getByText(/Sửa bill ·/).first();
        const coTieuDe = await tieuDe.isVisible().catch(() => false);
        const doTieuDe = coTieuDe ? await tieuDe.evaluate((e) => {
          const cs = getComputedStyle(e as HTMLElement);
          return { text: ((e.textContent ?? '').replace(/\s+/g, ' ').trim()).slice(0, 120), fontSize: cs.fontSize, fontWeight: cs.fontWeight };
        }) : null;
        const tieuDeDuLoTidHkd = !!doTieuDe && /Lô 5/.test(doTieuDe.text) && /53550081/.test(doTieuDe.text) && /KHACH HANG 60 3/.test(doTieuDe.text);
        await page.screenshot({ path: path.join(OUT, '6b-sua-bill-pos-modal.png') });
        checks6b = { ...checks6b, modalSuaPosMo: coTieuDe, tieuDePos: doTieuDe, tieuDeDu_Lo_TID_HKD: tieuDeDuLoTidHkd };
        // Đóng modal POS bằng cách NẠP LẠI trang (mock giữ nguyên) — chắc chắn sạch trước bước CK.
        await page.goto(`${baseUrl}/app/chat/room-demo/revenue`, { waitUntil: 'networkidle' });
        await page.waitForTimeout(1200);
      }
      // (ii) Nút Sửa trên bill hoàn CK → form → mật khẩu → Lưu → ckReview modal (TransferReviewCard + NGHI TRÙNG)
      const suaCk = page.locator('button:has-text("Sửa")').filter({ hasNot: page.locator('[data-testid="lot-row"]') });
      // nút Sửa của bảng "Từng bill hoàn/ứng" — tìm trong hàng có KHACH HANG 01
      const hangCk = page.locator('div.group.grid', { hasText: 'KHACH HANG 01' }).first();
      const nutSuaCk = hangCk.locator('button:has-text("Sửa")').first();
      const coNutSuaCk = await nutSuaCk.isVisible().catch(() => false);
      checks6b = { ...checks6b, nutSuaCkHien: coNutSuaCk };
      void suaCk;
      if (coNutSuaCk) {
        await nutSuaCk.click();
        await page.waitForTimeout(500);
        await page.locator('input[type=password]').first().fill('1111');
        await page.getByRole('button', { name: 'Lưu', exact: true }).click();
        await page.waitForTimeout(1500);
        const tieuDeCk = page.getByText(/Sửa bill CK ·/).first();
        const coTieuDeCk = await tieuDeCk.isVisible().catch(() => false);
        const doTieuDeCk = coTieuDeCk ? await tieuDeCk.evaluate((e) => {
          const cs = getComputedStyle(e as HTMLElement);
          return { text: ((e.textContent ?? '').replace(/\s+/g, ' ').trim()).slice(0, 120), fontSize: cs.fontSize, fontWeight: cs.fontWeight };
        }) : null;
        const ntTrongModal = await page.getByText(/NGHI TRÙNG/).first().isVisible().catch(() => false);
        await page.screenshot({ path: path.join(OUT, '6b-sua-bill-ck-modal.png'), fullPage: true });
        checks6b = { ...checks6b, modalSuaCkMo: coTieuDeCk, tieuDeCk: doTieuDeCk, nghiTrungTrongModalCk: ntTrongModal };
      }
      report('MÀN 6b — Modal sửa bill POS/CK (RoomRevenueScreen)', checks6b);
      await ctx.close();
    }

    console.log('\n[harness] Ảnh ->', OUT);
  } finally {
    await browser?.close();
    await server.close();
  }
}

void main();
