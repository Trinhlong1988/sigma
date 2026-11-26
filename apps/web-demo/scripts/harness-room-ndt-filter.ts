// HARNESS R200 (12/9) — màn Doanh số phòng NĐT: bar lọc ở vùng ghim + tổng NĐT THEO LỌC (Σ per-bill server).
// 2 ảnh: (1) chưa lọc; (2) lọc ca 1 + tự mở chi tiết + tổng theo lọc + dòng "trọn kỳ".
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoomRevenueReport } from '../src/lib/chat-client';
import type { InvestorReportDetail } from '../src/lib/investor-report-client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'room-ndt-filter');

const TIDS: never[] = []; const _TIDS_CU = [
  { tidId: 1, tid: 'DEMO-TID-07', hkdName: 'HKD DEMO 45', bankName: 'MB', linkedAt: '2026-09-01T00:00:00Z', linkedBy: null },
  { tidId: 2, tid: '95000011', hkdName: 'HKD DEMO 61', bankName: 'MBV', linkedAt: '2026-09-01T00:00:00Z', linkedBy: null }
];
const REPORT: RoomRevenueReport = {
  from: '2026-09-11', to: '2026-09-11', tids: TIDS,
  totalGross: 0, totalFee: 0, totalNet: 0, loCount: 0,
  daily: [],
  rows: [],
  investor: { investorId: 15, investorName: 'Thông Thái Nguyên', from: '2026-09-11', to: '2026-09-11', doanhThu: 52_000_000, tienVe: 51_272_000, laiNDT: 51_272, soBill: 3 }
};
const DETAIL: InvestorReportDetail = {
  investorId: 15, investorName: 'Thông Thái Nguyên', from: '2026-09-11', to: '2026-09-11',
  bills: [
    { tid: '67512202', bankName: 'AB Bank', hkdName: 'HKD DEMO 27', soLo: '55', billLoNumber: '55', txnDateIso: '2026-09-11T03:03:00Z', amount: 123_046_000, phiMilli: 102, sauPhi: 121_790_930, effMilli: 100, lai: 121_791, agentName: 'Duy' },
    { tid: '67512804', bankName: 'AB Bank', hkdName: 'HKD DEMO 15', soLo: '61', billLoNumber: '61', txnDateIso: '2026-09-11T06:47:00Z', amount: 52_047_000, phiMilli: 96, sauPhi: 51_547_348, effMilli: 100, lai: 51_547, agentName: 'Dung' }
  ],
  tidSummary: [], totals: { truoc: 52_000_000, sau: 51_272_000, lai: 51_272, tienVe: 51_272_000, daNhan: 0, thuaThieu: 0 }
};
const json = (route: Route, body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 950 }, timezoneId: 'Asia/Ho_Chi_Minh' });
    const page = await ctx.newPage();
    await page.addInitScript({ content: [
      "window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Thong' }));",
      "window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 9, code: 'DL09', name: 'Thong', rcUserId: 'u-me', rcUsername: 'thong' }));",
      'function FakeWS(){ this.readyState = 0; } FakeWS.prototype.addEventListener=function(){}; FakeWS.prototype.removeEventListener=function(){}; FakeWS.prototype.send=function(){}; FakeWS.prototype.close=function(){}; window.WebSocket=FakeWS;'
    ].join(String.fromCharCode(10)) });
    await page.routeWebSocket(/^ws/, () => {});
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (/\/revenue$/.test(p)) return json(route, { ok: true, data: REPORT });
      if (p.endsWith('/v1/me/investor-report/detail')) return json(route, { data: DETAIL });
      if (p.endsWith('/v1/chat/rooms')) return json(route, { ok: true, data: [{ id: 'room-ndt', name: 'Thông Thái Nguyên', type: 'GROUP', memberCount: 3, unreadCount: 0, lastMessage: null, lastMessageAt: null, members: [] }] });
      if (/refund-reconcile$/.test(p)) return json(route, { ok: true, data: { from: '2026-09-11', to: '2026-09-11', days: [{ date: '2026-09-11', canHoan: 294_849_721, daHoan: 240_251_000, daUng: 12_000_000, thuaThieu: -54_598_721, status: 'partial' }], totalCanHoan: 294_849_721, totalDaHoan: 240_251_000, totalThuaThieu: -54_598_721, unmatchedDaHoan: 0, totalDaUng: 12_000_000, bills: [] } });
      if (/lot-gaps/.test(p)) return json(route, { ok: true, data: { days: 7, gaps: [] } });
      const listLike = /categories|rooms|contacts|notifications|list|members/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });
    await page.goto(`${baseUrl}/app/chat/room-ndt/revenue`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, 'ndt-room-truoc-loc.png'), fullPage: false });
    const coBar = await page.locator('text=Ca tiền').count();
    // chọn Ca 1 (bar đầu tiên)
    await page.locator('select').nth(2).selectOption('67512202');
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(OUT, 'ndt-room-0tid-loc-tid.png'), fullPage: true });
    // [Admin Demo 12/9] Ô thừa/thiếu tách hàng riêng + 3 ô không tràn 2 hàng — chụp cả mobile 390.
    const oTT = await page.locator('[data-testid="o-thua-thieu"]').count();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(400);
    await page.locator('[data-testid=' + String.fromCharCode(34) + 'o-thua-thieu' + String.fromCharCode(34) + ']').scrollIntoViewIfNeeded(); await page.waitForTimeout(250); const box = page.locator('div.space-y-2', { has: page.locator('[data-testid=' + String.fromCharCode(34) + 'o-thua-thieu' + String.fromCharCode(34) + ']') }).first(); await box.screenshot({ path: path.join(OUT, 'refund-boxes-390.png') });
    await page.setViewportSize({ width: 1200, height: 950 });
    await page.waitForTimeout(300);
    const theoLoc = await page.locator('text=theo lọc').count();
    const tronKy = await page.locator('text=trọn kỳ').count();
    console.log(JSON.stringify({ coBar, theoLoc, tronKy, oThuaThieu: oTT }));
    await ctx.close();
  } finally { await browser?.close(); await server.close(); }
}
void main();
