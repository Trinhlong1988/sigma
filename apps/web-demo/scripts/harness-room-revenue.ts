// HARNESS verify màn DOANH SỐ (RoomRevenueScreen) — Admin Demo 31/8:
//  #2 SORT lô: NGÂN HÀNG → TID → SỐ LÔ (cùng TID lần lượt số lô, cùng bank rồi sang bank khác).
//  #3 NĐT detail như đại lý: report.investor + endpoint /detail → nút "Xem chi tiết theo Lô" → ô lô có bank màu + icon.
import { build, preview } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// [10/9] GÁN KIỂU THẬT cho fixture: hôm nay harness "mù" vì REFUND_RECONCILE thiếu trường `totalDaUng`
// (thêm 1/9) → màn ném lỗi render, ChunkErrorBoundary nuốt thành trang "Không tải được nội dung", harness chỉ
// thấy mất nút. Có kiểu → thiếu/lệch trường là GÃY TYPECHECK ngay, không lọt nữa.
import type { RoomRevenueReport, RoomRevenueRow, RoomTidDto, RefundReconcileReport } from '../src/lib/chat-client';
import type { InvestorReportDetail } from '../src/lib/investor-report-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-room-revenue');
const ROOM = 'room-demo';

// 3 TID: 2 của MB (bank trước), 1 của MBV (bank sau). Sort mong đợi: MB tid1(lô 5,12,30) → MB tid2(lô 8,20) → MBV tid3(lô 3).
const TIDS: RoomTidDto[] = [
  { tidId: 1, tid: '53550081', hkdName: 'HKD DEMO 19', bankName: 'MB', linkedAt: '', linkedBy: null },
  { tidId: 2, tid: '53550090', hkdName: 'HKD DEMO 43', bankName: 'MB', linkedAt: '', linkedBy: null },
  { tidId: 3, tid: '20280808', hkdName: 'HKD DEMO 6-1', bankName: 'MBV', linkedAt: '', linkedBy: null }
];
// ROWS cố tình XÁO TRỘN thứ tự để chứng minh sort.
// effDateIso = mốc bill có GIỜ (cột Giờ suy giờ VN) · investorNickname = NĐT per-lô (cột NĐT) — Admin Demo 2/9.
// [10/9] Màn mở mặc định kỳ "HÔM NAY" → dữ liệu mẫu phải nằm trong hôm nay/hôm qua, nếu không panel rỗng.
const HOM_NAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const HOM_QUA = (() => { const d = new Date(Date.now() - 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const ROWS: RoomRevenueRow[] = [
  { loId: 501, tidId: 3, date: HOM_NAY, effDateIso: HOM_NAY + 'T03:00:00.000Z', bankReportedLoNumber: null, billLoNumber: '3', investorNickname: 'NĐT Demo', borrowed: false, tidOwnerName: null, gross: 9635000, fee: 101168, net: 9533832 },
  { loId: 502, tidId: 2, date: HOM_NAY, effDateIso: HOM_NAY + 'T02:00:00.000Z', bankReportedLoNumber: null, billLoNumber: '20', investorNickname: 'NĐT Demo', borrowed: false, tidOwnerName: null, gross: 20000000, fee: 210000, net: 19790000 },
  { loId: 503, tidId: 1, date: HOM_QUA, effDateIso: HOM_QUA + 'T01:30:00.000Z', bankReportedLoNumber: null, billLoNumber: '30', investorNickname: 'NĐT Demo', borrowed: false, tidOwnerName: null, gross: 30000000, fee: 420000, net: 29580000 },
  { loId: 504, tidId: 1, date: HOM_NAY, effDateIso: HOM_NAY + 'T01:00:00.000Z', bankReportedLoNumber: null, billLoNumber: '5', investorNickname: 'NĐT Demo', borrowed: false, tidOwnerName: null, gross: 5000000, fee: 70000, net: 4930000 },
  { loId: 505, tidId: 2, date: HOM_QUA, effDateIso: HOM_QUA + 'T04:00:00.000Z', bankReportedLoNumber: null, billLoNumber: '8', investorNickname: 'NĐT Demo', borrowed: false, tidOwnerName: null, gross: 8000000, fee: 84000, net: 7916000 },
  { loId: 506, tidId: 1, date: HOM_NAY, effDateIso: HOM_NAY + 'T04:00:00.000Z', bankReportedLoNumber: null, billLoNumber: '12', investorNickname: 'NĐT Demo', borrowed: false, tidOwnerName: null, gross: 12000000, fee: 168000, net: 11832000 }
];
const DAILY = [
  { date: HOM_QUA, gross: 38000000, net: 37496000 },
  { date: HOM_NAY, gross: 46635000, net: 46053832 }
];
// report.investor → hiện block NĐT trong nhóm.
const INVESTOR = { investorId: 7, investorName: 'NĐT Demo', from: '2026-08-24', to: '2026-08-31', doanhThu: 84635000, tienVe: 83600000, laiNDT: 84635, soBill: 6 };
const REPORT: RoomRevenueReport = { from: '2026-08-24', to: '2026-08-31', tids: TIDS, totalGross: 84635000, totalFee: 1053168, totalNet: 83581832, loCount: 6, daily: DAILY, rows: ROWS, investor: INVESTOR };
// Đối soát hoàn tiền hướng-1: 3 ngày minh hoạ đủ/thiếu/thừa + 1 CK dư chưa gán.
const REFUND_RECONCILE: RefundReconcileReport = {
  from: '2026-08-24', to: '2026-08-31',
  days: [
    { date: HOM_NAY, canHoan: 212889747, daHoan: 212888000, thuaThieu: -1747, status: 'match' }, // đủ (lệch ≤3.000đ)
    { date: HOM_QUA, canHoan: 50000000, daHoan: 30000000, thuaThieu: -20000000, status: 'partial' }, // thiếu
    { date: '2026-08-28', canHoan: 10000000, daHoan: 12000000, thuaThieu: 2000000, status: 'over' }, // thừa
    { date: '2026-08-27', canHoan: 8000000, daHoan: 0, thuaThieu: -8000000, status: 'none' } // chưa hoàn
  ],
  // Bất biến của server: totalThuaThieu = (đã hoàn + ứng còn treo) − cần hoàn.
  totalCanHoan: 280889747, totalDaHoan: 254900000, totalDaUng: 5000000, totalThuaThieu: -20989747, unmatchedDaHoan: 5000000,
  bills: []
};

// Chi tiết NĐT (bills) — sort mong đợi khi render: MB tid1 → MB tid2 → MBV tid3, theo số lô.
const INV_DETAIL: InvestorReportDetail = {
  investorId: 7, investorName: 'NĐT Demo', from: '2026-08-24', to: '2026-08-31',
  bills: [
    { tid: '20280808', bankName: 'MBV', hkdName: 'HKD DEMO 6-1', soLo: '', billLoNumber: '3', txnDateIso: '2026-08-3003:00:00.000Z', amount: 9635000, phiMilli: 1155, sauPhi: 9523716, effMilli: 100, lai: 9635, agentName: 'ĐL Demo' },
    { tid: '53550090', bankName: 'MB', hkdName: 'HKD DEMO 43', soLo: '', billLoNumber: '20', txnDateIso: '2026-08-3002:00:00.000Z', amount: 20000000, phiMilli: 1155, sauPhi: 19769000, effMilli: 100, lai: 20000, agentName: 'ĐL Demo' },
    { tid: '53550081', bankName: 'MB', hkdName: 'HKD DEMO 19', soLo: '', billLoNumber: '5', txnDateIso: '2026-08-3001:00:00.000Z', amount: 5000000, phiMilli: 1155, sauPhi: 4942250, effMilli: 100, lai: 5000, agentName: 'ĐL Demo' },
    { tid: '53550081', bankName: 'MB', hkdName: 'HKD DEMO 19', soLo: '', billLoNumber: '12', txnDateIso: '2026-08-3004:00:00.000Z', amount: 12000000, phiMilli: 1155, sauPhi: 11861400, effMilli: 100, lai: 12000, agentName: 'ĐL Demo' }
  ],
  tidSummary: [], totals: { truoc: 46635000, sau: 46096366, lai: 46635, tienVe: 46096366, daNhan: 0, thuaThieu: -46096366 }
};

// #1 Picker "Sửa thẻ" — máy MB: thẻ MB on-us (hiện tại 1.05%), Ngoài MB-Visa-Master (1.40%), Ngoài MB-Napas
// (chưa cấu hình giá bán → mờ).
const LO_CARDS = {
  loId: 504, tidId: 1, currentCardTypeId: 15, amountBeforeFee: '5000000',
  options: [
    { cardTypeId: 15, name: 'MB', isCurrent: true, available: true, phiBanMilli: 1050, feeApplied: 52500, amountAfterFee: 4947500 },
    { cardTypeId: 16, name: 'Ngoài MB-Visa-Master', isCurrent: false, available: true, phiBanMilli: 1400, feeApplied: 70000, amountAfterFee: 4930000 },
    { cardTypeId: 17, name: 'Ngoài MB-Napas', isCurrent: false, available: false, reason: 'TID này chưa cấu hình giá bán thực tế cho khách.' }
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
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    // R198 — CHECK PHẢI CHẠY: mọi lỗi render bị ErrorBoundary nuốt vẫn phải làm harness ĐỎ (nếu chỉ dò nút,
    // màn crash thành trang "Không tải được nội dung" mà harness tưởng là "đổi UI").
    const loiMan: string[] = [];
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      const t = m.text().slice(0, 400);
      console.log('CONSOLE-ERR:', t);
      if (/ChunkErrorBoundary|TypeError|ReferenceError/i.test(t)) loiMan.push(t);
    });
    page.on('pageerror', (e) => { console.log('PAGEERROR:', e.message, '|', (e.stack || '').split(String.fromCharCode(10)).slice(0, 4).join(' >> ')); loiMan.push(e.message); });
    // Init-script để Ở DẠNG CHUỖI: nếu viết hàm/`class` ở đây, tsx/esbuild chèn helper __name →
    // trình duyệt ném "__name is not defined" và NUỐT phần còn lại (mất session giả → app trắng).
    await page.addInitScript({
      content: [
        "window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Toi Test' }));",
        "function FakeWS(){ this.readyState = 0; }",
        "FakeWS.prototype.addEventListener = function(){};",
        "FakeWS.prototype.removeEventListener = function(){};",
        "FakeWS.prototype.send = function(){};",
        "FakeWS.prototype.close = function(){};",
        "window.WebSocket = FakeWS;"
      ].join(String.fromCharCode(10))
    });
    const revenueReqs: string[] = []; // [10/9] ghi lại truy vấn doanh số để kiểm kỳ mặc định
    await page.routeWebSocket(/^ws/, () => { /* mở lửng */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (/\/revenue$/.test(p)) { revenueReqs.push(route.request().url()); return json(route, 200, { ok: true, data: REPORT }); }
      if (/investor-report\/detail$/.test(p)) return json(route, 200, { ok: true, data: INV_DETAIL });
      if (/refund-reconcile$/.test(p)) return json(route, 200, { ok: true, data: REFUND_RECONCILE });
      // #1 SỬA THẺ — picker options + áp đổi thẻ.
      if (/\/lo\/\d+\/cards$/.test(p)) return json(route, 200, { ok: true, data: LO_CARDS });
      if (/\/lo\/\d+\/correct-card$/.test(p)) return json(route, 200, { ok: true, data: { loId: 504, oldTransactionId: 100, newTransactionId: 200, cardTypeId: 16, feeApplied: 70000, amountAfterFee: 4930000, phiBanMilli: 1400 } });
      // [10/9] Mock PHẢI ĐÚNG SHAPE: /v1/me/friends trả OBJECT {friends,incomingRequests,outgoingRequests};
      // trả [] như list thường làm app ném "friends is not iterable" → ErrorBoundary nuốt cả màn (harness mù).
      if (/\/me\/friends$/.test(p)) return json(route, 200, { friends: [], incomingRequests: [], outgoingRequests: [] });
      const listLike = /categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, 200, route.request().method() === 'GET' && listLike ? [] : {});
    });
    await page.goto(`${baseUrl}/app/chat/${ROOM}/revenue`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    // [Admin Demo 10/9] MỞ RA PHẢI LÀ "HÔM NAY": chứng minh bằng CHÍNH truy vấn đầu tiên gửi lên (from/to = hôm nay),
    // chắc hơn dò class nút (class đổi là test mù).
    const hn = new Date();
    const ymd = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    // from/to gửi lên là ISO-UTC → đổi về giờ VN rồi mới so ngày (so thẳng chuỗi ISO sẽ lệch 1 ngày).
    const q0 = new URL(revenueReqs[0] ?? 'http://x/?from=&to=');
    const vn = (iso: string): string => (iso ? ymd(new Date(new Date(iso).getTime() + 7 * 3600_000)) : '');
    const f0 = vn(q0.searchParams.get('from') ?? '');
    const t0 = vn(q0.searchParams.get('to') ?? '');
    const laHomNay = f0 === ymd(hn) && (t0 === ymd(hn) || t0 === ymd(new Date(hn.getTime() + 86400000)));
    console.log(`[#5 MẶC ĐỊNH] truy vấn đầu tiên: from=${f0} to=${t0} → là HÔM NAY: ${laHomNay}`);
    if (!laHomNay) process.exitCode = 1;
    await page.screenshot({ path: path.join(OUT, '0-mo-man.png'), fullPage: false });
    const manLoi = await page.locator('text=Không tải được nội dung').count();
    if (manLoi > 0 || loiMan.length > 0) {
      console.log(`  ❌ MÀN CRASH (fallback lỗi=${manLoi}, lỗi JS=${loiMan.length}) — xem CONSOLE-ERR ở trên, KHÔNG chạy tiếp.`);
      process.exitCode = 1;
      return;
    }
    console.log('  [debug] nút kỳ thấy được:', await page.locator('button').evaluateAll((bs) => bs.map((b) => (b.textContent || '').trim()).filter((t) => t && t.length < 14).slice(0, 14)));

    // #4 GHIM SUMMARY (Admin Demo 31/8) — cuộn vùng doanh số xuống hết, CHỨNG MINH khối summary (NĐT + 4 ô Tổng) còn
    // pin ở đỉnh viewport (không trôi mất). Chụp VIEWPORT (không fullPage) để thấy đúng cảnh cuộn.
    const scroller = page.locator('div.overflow-auto').filter({ hasText: 'Tổng trước phí' }).first();
    const beforeTop = await page.getByText(/Tổng trước phí/).first().boundingBox();
    await scroller.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    await page.waitForTimeout(400);
    const scrolled = await scroller.evaluate((el) => el.scrollTop);
    const sBox = await scroller.boundingBox();
    const afterTop = await page.getByText(/Tổng trước phí/).first().boundingBox();
    const offset = afterTop && sBox ? Math.round(afterTop.y - sBox.y) : -1;
    const stillVisible = !!afterTop && !!sBox && afterTop.y >= sBox.y - 4 && afterTop.y < sBox.y + Math.min(sBox.height, 300);
    console.log('[#4 GHIM] scrollTop sau cuộn =', scrolled, '(px) · "Tổng trước phí" cách đỉnh vùng cuộn =', offset, 'px · CÒN PIN =', stillVisible);
    console.log('   (trước cuộn y=', beforeTop ? Math.round(beforeTop.y) : '?', '→ sau cuộn vẫn gần đỉnh = ghim OK)');
    await page.screenshot({ path: path.join(OUT, 'revenue-sticky-scrolled.png') });
    await scroller.evaluate((el) => { el.scrollTop = 0; });
    await page.waitForTimeout(200);

    // #2 SORT — đọc thứ tự lô THEO DOM qua data-testid của RevenueLotTable (dò chuỗi "· Lô N" là layout thẻ CŨ,
    // đổi sang bảng thì dò trượt mà harness vẫn xanh → nay ĐỌC MỐC + KHẲNG ĐỊNH, sai là ĐỎ).
    const seq = await page.locator('[data-testid="lot-row"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-lo') || ''));
    const MONG_DOI = ['5', '12', '30', '8', '20', '3'];
    const dungSort = seq.join(',') === MONG_DOI.join(',');
    console.log('[#2 SORT đại lý] thứ tự số lô hiển thị =', seq.join(' → '));
    console.log('   MONG ĐỢI (MB tid1:5,12,30 → MB tid2:8,20 → MBV tid3:3) =', MONG_DOI.join(' → '), '→', dungSort ? '✅ ĐÚNG' : '❌ SAI');
    if (!dungSort) process.exitCode = 1;

    await page.screenshot({ path: path.join(OUT, 'revenue-dealer-sorted.png'), fullPage: true });

    // #3 NĐT detail — bấm "Xem chi tiết theo Lô" (LÀM TRƯỚC để không vướng modal picker #1).
    const btn = page.getByRole('button', { name: /Xem chi tiết theo Lô/ });
    const hasBtn = await btn.first().isVisible().catch(() => false);
    console.log('[#3 NĐT] nút "Xem chi tiết theo Lô" hiện =', hasBtn);
    if (!hasBtn) process.exitCode = 1;
    if (hasBtn) {
      await btn.first().click();
      await page.waitForTimeout(600);
      const feeCai = await page.getByText(/Phí cài máy/).first().isVisible().catch(() => false);
      const noPhiBan = !(await page.getByText(/Phí bán/).first().isVisible().catch(() => false));
      console.log('   NĐT detail hiện "Phí cài máy" =', feeCai, '· KHÔNG lộ "Phí bán" =', noPhiBan);
    }
    await page.screenshot({ path: path.join(OUT, 'revenue-investor-detail.png'), fullPage: true });

    // ĐỐI SOÁT HOÀN TIỀN (hướng-1) — cuộn tới section, kiểm 4 trạng thái + cảnh báo CK chưa gán + số.
    const recHeader = page.getByText(/Đối soát hoàn tiền/).first();
    const hasRec = await recHeader.isVisible().catch(() => false);
    if (hasRec) { await recHeader.scrollIntoViewIfNeeded().catch(() => {}); await page.waitForTimeout(300); }
    const showsDu = await page.getByText(/Hoàn đủ/).first().isVisible().catch(() => false);
    const showsThieu = await page.getByText(/Hoàn thiếu/).first().isVisible().catch(() => false);
    const showsThua = await page.getByText(/Hoàn thừa/).first().isVisible().catch(() => false);
    const showsChuaHoan = await page.getByText(/Chưa hoàn/).first().isVisible().catch(() => false);
    const showsUnmatched = await page.getByText(/CK chưa gán được ngày/).first().isVisible().catch(() => false);
    console.log('[ĐỐI SOÁT] section=', hasRec, '· đủ=', showsDu, '· thiếu=', showsThieu, '· thừa=', showsThua, '· chưa hoàn=', showsChuaHoan, '· cảnh báo CK chưa gán=', showsUnmatched);
    if (!(showsDu && showsThieu && showsThua && showsChuaHoan && showsUnmatched)) process.exitCode = 1;
    await page.screenshot({ path: path.join(OUT, 'revenue-refund-reconcile.png'), fullPage: true });

    // #1 NÚT SỬA trên từng lô — từ 7/9 màn KHÔNG còn nút "Sửa thẻ" riêng: bấm "Sửa" mở lại giao diện review OCR
    // (sửa tiền/lô/TID/ngày/giờ/THẺ) — phần picker thẻ do harness-edit-card-fee.ts kiểm sâu. Ở đây chỉ khẳng định
    // MỖI lô đều có nút Sửa (mất nút = mất đường sửa bill → phải ĐỎ).
    const soNutSua = await page.locator('[data-testid="lot-row"] button:has-text("Sửa")').count();
    const duNutSua = soNutSua === MONG_DOI.length;
    console.log(`[#1 SỬA] nút "Sửa" trên lô = ${soNutSua}/${MONG_DOI.length} →`, duNutSua ? '✅ đủ' : '❌ thiếu');
    if (!duNutSua) process.exitCode = 1;
    await page.screenshot({ path: path.join(OUT, 'revenue-lot-table.png'), fullPage: true });

    console.log('[harness] Chụp xong ->', OUT);
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
