// HARNESS [Admin Demo 11/9] BỘ LỌC BÁO CÁO LÔ (RoomRevenueScreen): ca tiền / ngân hàng / TID / HKD.
// THAO TÁC THẬT (selectOption/fill) + ĐO SỐ tổng sau từng thao tác (R200 vá phản biện — không chỉ ảnh tĩnh).
// Fixture: MB ca1 ≤09:40, ca2 ≤16:40; MBV ca1 ≤11:50 (mirror mốc chính chủ).
//   Kỳ vọng (mock trả nguyên 6 lô): mặc định 84.635.000 · Ca 1 = 64.635.000 (5+20+9,635+30) · Ca 2 = 20.000.000
//   (12+8) · MB = 75.000.000 · TID 53550081 = 47.000.000 · HKD "THANH" = 9.635.000.
import { build, preview } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoomRevenueReport, RoomRevenueRow, RoomTidDto, RefundReconcileReport } from '../src/lib/chat-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-loc-baocao-lo');
const ROOM = 'room-demo';

const TIDS: RoomTidDto[] = [
  { tidId: 1, tid: '53550081', hkdName: 'HKD DEMO 19', bankName: 'MB', linkedAt: '', linkedBy: null },
  { tidId: 2, tid: '53550090', hkdName: 'HKD DEMO 43', bankName: 'MB', linkedAt: '', linkedBy: null },
  { tidId: 3, tid: '20280808', hkdName: 'HKD DEMO 6-1', bankName: 'MBV', linkedAt: '', linkedBy: null }
];
const HOM_NAY = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
const HOM_QUA = (() => { const d = new Date(Date.now() - 86400000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
// Giờ VN = ISO Z + 7h: T01:00Z=08:00 · T02:00Z=09:00 · T03:00Z=10:00 · T04:00Z=11:00 · T01:30Z=08:30.
const ROWS: RoomRevenueRow[] = [
  { loId: 501, tidId: 3, date: HOM_NAY, effDateIso: HOM_NAY + 'T03:00:00.000Z', bankReportedLoNumber: null, billLoNumber: '3', investorNickname: 'NĐT Demo', borrowed: false, tidOwnerName: null, gross: 9635000, fee: 101168, net: 9533832 },   // MBV 10:00 → ca1
  { loId: 502, tidId: 2, date: HOM_NAY, effDateIso: HOM_NAY + 'T02:00:00.000Z', bankReportedLoNumber: null, billLoNumber: '20', investorNickname: 'NĐT Demo', borrowed: false, tidOwnerName: null, gross: 20000000, fee: 210000, net: 19790000 }, // MB 09:00 → ca1
  { loId: 503, tidId: 1, date: HOM_QUA, effDateIso: HOM_QUA + 'T01:30:00.000Z', bankReportedLoNumber: null, billLoNumber: '30', investorNickname: 'NĐT Demo', borrowed: false, tidOwnerName: null, gross: 30000000, fee: 420000, net: 29580000 }, // MB 08:30 → ca1
  { loId: 504, tidId: 1, date: HOM_NAY, effDateIso: HOM_NAY + 'T01:00:00.000Z', bankReportedLoNumber: null, billLoNumber: '5', investorNickname: 'NĐT Demo', borrowed: false, tidOwnerName: null, gross: 5000000, fee: 70000, net: 4930000 },     // MB 08:00 → ca1
  { loId: 505, tidId: 2, date: HOM_QUA, effDateIso: HOM_QUA + 'T04:00:00.000Z', bankReportedLoNumber: null, billLoNumber: '8', investorNickname: 'NĐT Demo', borrowed: false, tidOwnerName: null, gross: 8000000, fee: 84000, net: 7916000 },     // MB 11:00 → ca2
  { loId: 506, tidId: 1, date: HOM_NAY, effDateIso: HOM_NAY + 'T04:00:00.000Z', bankReportedLoNumber: null, billLoNumber: '12', investorNickname: 'NĐT Demo', borrowed: false, tidOwnerName: null, gross: 12000000, fee: 168000, net: 11832000 }  // MB 11:00 → ca2
];
const REPORT: RoomRevenueReport = {
  from: '2026-08-24', to: '2026-08-31', tids: TIDS, totalGross: 84635000, totalFee: 1053168, totalNet: 83581832,
  loCount: 6, daily: [{ date: HOM_QUA, gross: 38000000, net: 37496000 }, { date: HOM_NAY, gross: 46635000, net: 46053832 }], rows: ROWS
};
const REFUND: RefundReconcileReport = { from: '2026-08-24', to: '2026-08-31', days: [], totalCanHoan: 0, totalDaHoan: 0, totalDaUng: 0, totalThuaThieu: 0, unmatchedDaHoan: 0, bills: [] };

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error' });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), preview: { port: 0 } });
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:4173';
  let browser: Browser | undefined;
  let fail = 0;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const loiMan: string[] = [];
    page.on('pageerror', (e) => { console.log('PAGEERROR:', e.message); loiMan.push(e.message); });
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
    await page.routeWebSocket(/^ws/, () => { /* mở lửng */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (/\/revenue$/.test(p)) return json(route, 200, { ok: true, data: REPORT });
      if (/refund-reconcile$/.test(p)) return json(route, 200, { ok: true, data: REFUND });
      if (/\/me\/friends$/.test(p)) return json(route, 200, { friends: [], incomingRequests: [], outgoingRequests: [] });
      const listLike = /categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, 200, route.request().method() === 'GET' && listLike ? [] : {});
    });
    await page.goto(`${baseUrl}/app/chat/${ROOM}/revenue`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(800);

    const docTong = async (): Promise<string> => page.evaluate(() => {
      const labs = [...document.querySelectorAll('div')].filter((e) => (e.textContent || '').trim().startsWith('Tổng trước phí') && e.children.length === 0);
      const lab = labs[0];
      const val = lab?.parentElement?.querySelectorAll('div')[1];
      return (val?.textContent || '').trim();
    });
    const kiem = async (ten: string, kyVong: string, anh: string): Promise<void> => {
      await page.waitForTimeout(250);
      const thay = await docTong();
      const ok = thay.replace(/[^\d]/g, '') === kyVong.replace(/[^\d]/g, '');
      console.log(`[${ten}] tổng thấy="${thay}" · kỳ vọng="${kyVong}" → ${ok ? 'ĐÚNG' : '❌ SAI'}`);
      if (!ok) fail++;
      await page.screenshot({ path: path.join(OUT, anh) });
    };

    const barCo = await page.locator('label:has-text("Ca tiền") select').count();
    console.log('[FILTER BAR] hiện =', barCo > 0);
    if (barCo === 0) { fail++; await page.screenshot({ path: path.join(OUT, 'khong-thay-bar.png') }); return; }
    await kiem('MẶC ĐỊNH (không lọc)', '84.635.000', '0-mac-dinh.png');

    await page.locator('label:has-text("Ca tiền") select').selectOption('1');
    await kiem('CA 1', '64.635.000', '1-ca1.png');
    await page.locator('label:has-text("Ca tiền") select').selectOption('2');
    await kiem('CA 2', '20.000.000', '2-ca2.png');
    await page.locator('label:has-text("Ca tiền") select').selectOption('3');
    await kiem('CA 3 (không có lô)', '0', '3-ca3.png');
    await page.locator('label:has-text("Ca tiền") select').selectOption('');

    await page.locator('label:has-text("Ngân hàng") select').selectOption('MB');
    await kiem('BANK MB', '75.000.000', '4-bank-mb.png');
    await page.locator('label:has-text("TID") select').selectOption('53550081');
    await kiem('TID 53550081 (trong MB)', '47.000.000', '5-tid.png');
    await page.locator('button:has-text("Bỏ lọc")').click();
    await page.locator('label:has-text("Tên HKD") input').fill('THANH');
    await kiem('HKD chứa "THANH"', '9.635.000', '6-hkd.png');
    // Kết hợp: HKD THANH + Ca 2 → MBV 10:00 là ca1 → 0đ (giao của lọc).
    await page.locator('label:has-text("Ca tiền") select').selectOption('2');
    await kiem('HKD THANH + CA 2 (giao)', '0', '7-giao.png');

    if (loiMan.length > 0) { console.log('❌ lỗi JS màn:', loiMan.length); fail++; }
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
  console.log(fail === 0 ? '════ TẤT CẢ ĐO ĐÚNG ✓ ════' : `════ ${fail} PHÉP ĐO SAI ❌ ════`);
  process.exitCode = fail === 0 ? 0 : 1;
  console.log('Ảnh →', OUT);
}
void main();
