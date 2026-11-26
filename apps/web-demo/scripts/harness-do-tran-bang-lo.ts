// Đo TRÀN/CUỘN NGANG màn Doanh số phòng ở khổ máy Admin Demo (1900px) sau khi thêm cột "Mã YC".
import { preview } from 'vite';
import { chromium, type Route } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOM = 'room-tuyen';
const TIDS = [{ tidId: 1, tid: '53590003', hkdName: 'HKD DEMO 19', bankName: 'Vietcombank' }];
const row = (loId: number, lot: number, iso: string, gross: number, net: number): Record<string, unknown> => ({
  loId, tidId: 1, date: iso.slice(0, 10), effDateIso: iso, bankReportedLoNumber: lot, billLoNumber: String(lot),
  investorNickname: null, gross, fee: gross - net, net, borrowed: false, tidOwnerName: null });
const REPORT = { from: '2026-09-16', to: '2026-09-17', tids: TIDS, totalGross: 120_000_000, totalFee: 1_200_000, totalNet: 118_800_000, loCount: 3,
  daily: [{ date: '2026-09-16', gross: 120_000_000, net: 118_800_000 }],
  rows: [row(101, 205, '2026-09-16T02:10:00Z', 15_536_000, 15_380_640), row(102, 206, '2026-09-16T05:20:00Z', 48_265_000, 47_782_350), row(103, 207, '2026-09-16T08:45:00Z', 56_199_000, 55_637_010)] };
const json = (r: Route, b: unknown): Promise<void> => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(b) });
const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', preview: { port: 0 } });
const base = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || '';
const browser = await chromium.launch();
const KHO = Number(process.env.KHO ?? 1900);
const ctx = await browser.newContext({ viewport: { width: KHO, height: 1050 }, timezoneId: 'Asia/Ho_Chi_Minh' });
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
  window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));
  class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
  // @ts-expect-error ws
  window.WebSocket = FakeWS;
});
await page.routeWebSocket(/^ws/, () => {});
await page.route('**/v1/**', async (r) => {
  const p = new URL(r.request().url()).pathname;
  if (p.endsWith(`/rooms/${ROOM}/revenue`)) return json(r, { ok: true, data: REPORT });
  if (p.endsWith(`/rooms/${ROOM}`)) return json(r, { ok: true, data: { id: ROOM, type: 'GROUP', name: 'ĐL - Tuyên SG', members: [{ agentId: 9, name: 'Tuyên SG', code: 'DL90' }] } });
  if (p.endsWith('/pos-lot/recon')) return json(r, { ok: true, recon: { '101': { ds: true, refundDone: false }, '102': { ds: true, refundDone: true } } });
  if (p.endsWith('/refund-request')) return json(r, { ok: true, yc: { '101': { code: 'YC001', status: 'MOI', amount: 15_380_000 }, '102': { code: 'YC001', status: 'DA_CHUYEN', amount: 15_380_000 } } });
  if (p.includes('refund-reconcile')) return json(r, { ok: true, data: { from: '2026-09-16', to: '2026-09-17', days: [], totalCanHoan: 0, totalDaHoan: 0, totalThuaThieu: 0, unmatchedDaHoan: 0, totalDaUng: 0, bills: [] } });
  const listLike = /friends|categories|rooms|contacts|notifications|feed|members|tids|list|gaps|reconcile/i.test(p);
  const rong = r.request().method() === 'GET' && listLike ? [] : {};
  return json(r, p.startsWith('/v1/chat/') ? { ok: true, data: rong } : rong);
});
await page.goto(`${base}/app/chat/${ROOM}/revenue`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
const doc = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
const scrollers = await page.evaluate(() => [...document.querySelectorAll('*')]
  .filter((e) => e.scrollWidth > e.clientWidth + 2 && e.clientWidth > 300)
  .map((e) => ({ cls: (e.className || '').toString().slice(0, 70), sw: e.scrollWidth, cw: e.clientWidth, thua: e.scrollWidth - e.clientWidth })));
console.log(`[${KHO}px] TRANG: scrollWidth`, doc.sw, 'clientWidth', doc.cw, '→ tràn trang =', doc.sw > doc.cw);
console.log('Khối CUỘN NGANG:', scrollers.length);
for (const s of scrollers.slice(0, 6)) console.log(`   thừa ${s.thua}px | ${s.cw}→${s.sw} | ${s.cls}`);
const chiTiet = await page.evaluate(() => {
  const box = [...document.querySelectorAll('.overflow-x-auto')].find((e) => e.scrollWidth > e.clientWidth + 2);
  if (!box) return null;
  const hang = [...box.querySelectorAll(':scope > div > div')].slice(0, 3);
  return hang.map((h) => ({ w: (h as HTMLElement).getBoundingClientRect().width, cols: getComputedStyle(h).gridTemplateColumns,
    o: [...h.children].map((c) => Math.round((c as HTMLElement).getBoundingClientRect().width)).join('+') }));
});
console.log('CHI TIẾT HÀNG:', JSON.stringify(chiTiet, null, 1)?.slice(0, 900));
const maYc = await page.getByTestId('lot-ma-yc').count();
console.log('chip mã YC hiện:', maYc);
await page.getByTestId('lot-ma-yc').first().scrollIntoViewIfNeeded().catch(() => undefined);
await page.screenshot({ path: path.join(ROOT, 'qa-screenshots', `yc-bang-lo-${KHO}.png`) });
await browser.close(); server.httpServer.close();
