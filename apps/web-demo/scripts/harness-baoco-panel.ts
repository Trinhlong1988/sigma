// HARNESS R200 (13/9) — panel "Check sao kê" bản CA (bảng kết chuyển theo ca từng máy + báo có + gợi ý lệch).
// Mock = SỐ THẬT kéo MB TK Thông 11-13/9 (rút gọn). Chạy: node --import tsx scripts/harness-baoco-panel.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { InvestorBaocoData } from '../src/lib/ocr-send-api';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'baoco-panel');

const DATA: InvestorBaocoData = {
  investorId: 15, from: '2026-09-11', to: '2026-09-13',
  nhomCa: [
    { bo: 'HKD DEMO 46', soMay: 1, tid: 'DEMO-TID-07', hkdName: 'HKD DEMO 45', ngay: '2026-09-11', ca: 1, soLo: 1, tienVe: 66_900_272, doanhSo: 67576032, thucVe: 66900281, chenh: 9, matched: true },
    { bo: 'HKD DEMO 46', soMay: 1, tid: '53550071', hkdName: 'HKD DEMO 43', ngay: '2026-09-11', ca: 2, soLo: 7, tienVe: 218_507_742, doanhSo: 220714891, thucVe: 0, chenh: -218507742, matched: false },
    { bo: 'HKD DEMO 23', soMay: 1, tid: '53550077', hkdName: 'HKD DEMO 20', ngay: '2026-09-11', ca: 2, soLo: 4, tienVe: 258_333_739, doanhSo: 260943171, thucVe: 258333748, chenh: 9, matched: true },
    { bo: 'HKD DEMO 23', soMay: 1, tid: '53550076', hkdName: 'HKD DEMO 21', ngay: '2026-09-11', ca: 2, soLo: 5, tienVe: 60_269_815, doanhSo: 60878601, thucVe: 60269824, chenh: 9, matched: true },
    { bo: 'HKD DEMO 46', soMay: 1, tid: '53550071', hkdName: 'HKD DEMO 43', ngay: '2026-09-11', ca: 3, soLo: 1, tienVe: 29_648_557, doanhSo: 29948037, thucVe: 29648566, chenh: 9, matched: true },
    { bo: 'HKD DEMO 46', soMay: 1, tid: 'DEMO-TID-07', hkdName: 'HKD DEMO 45', ngay: '2026-09-12', ca: 2, soLo: 2, tienVe: 12_345_739, doanhSo: 12470443, thucVe: 12345748, chenh: 9, matched: true },
    { bo: 'HKD DEMO 46', soMay: 1, tid: '53550071', hkdName: 'HKD DEMO 43', ngay: '2026-09-12', ca: 2, soLo: 8, tienVe: 467_979_671, doanhSo: 472706738, thucVe: 467979680, chenh: 9, matched: true },
    { bo: 'HKD DEMO 23', soMay: 1, tid: '53550077', hkdName: 'HKD DEMO 20', ngay: '2026-09-12', ca: 2, soLo: 1, tienVe: 185_390_716, doanhSo: 187_263_349, thucVe: 0, chenh: -185_390_716, matched: false },
    { bo: 'HKD DEMO 46', soMay: 1, tid: 'DEMO-TID-07', hkdName: 'HKD DEMO 45', ngay: '2026-09-13', ca: 1, soLo: 1, tienVe: 15_803_338, doanhSo: 15962968, thucVe: 15803347, chenh: 9, matched: true }
  ],
  baoco: [
    { dateTime: '2026-09-11T12:10:00', amount: 66_900_285, desc: 'CUSTOMER KET CHUYEN SO DU TOI TAI KHOAN 8788 688686', matchedLo: '1 lô', matchedTid: 'DEMO-TID-07' },
    { dateTime: '2026-09-11T18:10:00', amount: 318_603_629, desc: 'CUSTOMER KET CHUYEN SO DU TOI TAI KHOAN 8788 688686', matchedLo: '9 lô (Σ 318.603.554đ)', matchedTid: '53550077, 53550076' },
    { dateTime: '2026-09-11T18:10:00', amount: 225_623_754, desc: 'CUSTOMER KET CHUYEN SO DU TOI TAI KHOAN 8788 688686', matchedLo: null, matchedTid: null, goiY: 'gần khớp HKD DEMO 43 ca2 + HKD DEMO 45 ca2 (Σ 225.620.628đ, lệch +3.126đ — nghi thiếu/sai bill trong hệ)' },
    { dateTime: '2026-09-12T18:10:00', amount: 476_543_701, desc: 'CUSTOMER KET CHUYEN SO DU TOI TAI KHOAN 8788 688686', matchedLo: '10 lô', matchedTid: '53550071, DEMO-TID-07' },
    { dateTime: '2026-09-13T08:10:00', amount: 38_457_661, desc: 'CUSTOMER KET CHUYEN SO DU TOI TAI KHOAN 8788 688686', matchedLo: null, matchedTid: null, goiY: 'gần khớp HKD DEMO 20 ca3 + HKD DEMO 21 ca3 (Σ 32.532.853đ, lệch +5.924.808đ — nghi thiếu/sai bill trong hệ)' }
  ],
  los: [
    { loId: 1, billKey: 'nat|DEMO-TID-07|169||2026-09-12', tid: 'DEMO-TID-07', hkdName: 'HKD DEMO 45', billDate: '2026-09-12T09:46:00', amount: 9_385_332, tienVe: 9_385_332, matched: true },
    { loId: 2, billKey: 'nat|53550077|179||2026-09-12', tid: '53550077', hkdName: 'HKD DEMO 20', billDate: '2026-09-12T10:41:45', amount: 185_390_716, tienVe: 185_390_716, matched: false }
  ],
  tongBaoco: 1_703_192_976, tongTienVeKyVong: 1_588_475_133, tongDaKhop: 929_631_704, soLoChuaVe: 28, soBaocoThua: 5
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
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 1250 }, timezoneId: 'Asia/Ho_Chi_Minh' });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/v1/investor-baoco/check')) return json(route, DATA);
      if (p.endsWith('/v1/me/investor-report')) return json(route, { from: '2026-09-11', to: '2026-09-13', investors: [{ investorId: 15, code: 'NDT15', investorName: 'Thông Thái Nguyên', doanhThu: 1_600_000_000, soBill: 42, laiNDT: 1_588_475, tienVe: 1_588_475_133, daHoan: { doanhThu: 0, soBill: 0, laiNDT: 0 }, chuaHoan: { doanhThu: 0, soBill: 0, laiNDT: 0 }, qr: null }] });
      if (p.endsWith('/v1/me/investor-settlement')) return json(route, { from: '2026-09-11', to: '2026-09-13', rows: [] });
      if (p.endsWith('/v1/me/investor-advances')) return json(route, { advances: [] });
      if (p.endsWith('/v1/me/investor-report/filter-options')) return json(route, { tids: [], banks: [] });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });

    await page.goto(`${baseUrl}/app/investor-revenue`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.getByTestId('btn-check-saoke').first().click();
    await page.getByRole('button', { name: '📂 Đã lưu' }).click();
    await page.getByRole('button', { name: /Xem sao kê đã lưu/ }).click();
    await page.waitForTimeout(800);
    const panel = page.getByTestId('panel-check-saoke');
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: path.join(OUT, 'panel-ca.png') });
    console.log('shot panel-ca.png');
  } finally {
    await browser?.close();
    await server.close();
  }
}
void main();
