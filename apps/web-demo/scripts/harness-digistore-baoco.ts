// HARNESS R200 (Admin Demo 5/9) — render THẬT (app + mock API) 2 mảng "Báo có" Digistore để LEAD tự nhìn ảnh TRƯỚC ship:
//   (a) QrBillReviewCard tab "Quét QR": bấm "Check báo có" → chụp thẻ QR sau MỖI trạng thái (MATCHED / NOT_FOUND /
//       DUPLICATE / AMBIGUOUS / CANNOT_CHECK) — nhất là AMBIGUOUS liệt kê hết ứng viên bên phải ảnh.
//   (b) BaoCoReportScreen: bảng báo cáo báo-có (có dòng CHƯA đối soát tô nổi) + lọc trạng thái "Chưa đối soát".
// Chạy: node --import tsx scripts/harness-digistore-baoco.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-digistore-baoco');
const BILL_IMG = path.join(ROOT, 'screenshots', 'harness-bug1', '_folder', 'bill_1.jpg');

const DEALERS = [
  { roomId: 'r-nguyen-sg', name: 'Đại lý Nguyễn SG' },
  { roomId: 'r-trung-cp', name: 'Đại lý Trung Cẩm Phả' }
];

function qrItemDefault(): unknown {
  return {
    qr: { hkdName: 'HKD DEMO 35 Ha Noi', amount: 10_000_000, ref: '6247VNIB024EN8TK', dateTime: '09:15 10/09/2026', fromCard: 'VIB Cash Back ••5721' },
    tidId: 5, tidCode: 'QR-nguyen-tri-bao-x1', hkdNameMatched: 'HKD DEMO 35 Ha Noi',
    partnerId: 1, receiveAccountId: 1, industryId: 1,
    sellFeeMilli: 1050, sellFeeAmount: 105_000, partnerFeeMilli: 850,
    refundAmount: 9_895_000, investorReceiveAmount: 10_000_000,
    feeSource: 'PARTNER', sellFeeSource: 'DEFAULT', isWeekend: false,
    dealerRoomId: 'r-nguyen-sg', dealerRoomName: 'Đại lý Nguyễn SG',
    alreadySent: false, warnings: [], blocked: false
  };
}

// 5 trạng thái check báo có — chọn theo biến (đổi trước mỗi lần click "Check báo có").
const AT = Date.UTC(2026, 8, 10, 2, 15) - 7 * 3600_000; // 09:15 10/9 HCM → epoch ms
function baoCoBody(status: string): unknown {
  switch (status) {
    case 'MATCHED': return { status: 'MATCHED', match: { billId: 'BC-77012', hkdName: 'HKD DEMO 35 Ha Noi', amount: 10_000_000, payerName: 'KHACH HANG 34', atMs: AT, status: 'CREDITED' } };
    case 'NOT_FOUND': return { status: 'NOT_FOUND' };
    case 'DUPLICATE': return { status: 'DUPLICATE', match: { billId: 'BC-77012', hkdName: 'HKD DEMO 35 Ha Noi', amount: 10_000_000, payerName: 'KHACH HANG 34', atMs: AT, status: 'RECONCILED' } };
    case 'AMBIGUOUS': return {
      status: 'AMBIGUOUS',
      candidates: [
        { billId: 'BC-77012', amount: 10_000_000, payerName: 'KHACH HANG 34', atMs: AT, status: 'CREDITED' },
        { billId: 'BC-77019', amount: 10_000_000, payerName: 'KHACH HANG 53', atMs: AT + 60_000, status: 'CREDITED' },
        { billId: 'BC-77025', amount: 10_000_000, payerName: 'KHACH HANG 19', atMs: AT + 120_000, status: 'CREDITED' }
      ]
    };
    default: return { status: 'CANNOT_CHECK', message: 'Chưa kết nối được cổng báo-có Digistore (BVBank) — thử lại sau.' };
  }
}
let currentStatus = 'MATCHED';

// Báo cáo báo-có — 4 dòng: 2 đã đối soát + 2 CHƯA đối soát (báo-có chưa có bill OCR khớp).
function baoCoReport(filter: string | null): unknown {
  const all = [
    { stt: 1, dateIso: '2026-09-10T02:15:00.000Z', hkdName: 'HKD DEMO 35 Ha Noi', amount: 10_000_000, payerName: 'KHACH HANG 34', billId: 'BC-77012', sauPhiBan: 9_895_000, sauPhiMua: 9_915_000, loiNhuanAlpha: 20_000, dealerName: 'Đại lý Nguyễn SG', reconcileStatus: 'MATCHED' },
    { stt: 2, dateIso: '2026-09-10T03:40:00.000Z', hkdName: 'HKD DEMO 42 Sai Gon', amount: 5_000_000, payerName: 'KHACH HANG 43', billId: 'BC-77031', sauPhiBan: 4_947_500, sauPhiMua: 4_957_500, loiNhuanAlpha: 10_000, dealerName: 'Đại lý Trung Cẩm Phả', reconcileStatus: 'MATCHED' },
    { stt: 3, dateIso: '2026-09-10T05:05:00.000Z', hkdName: 'HKD DEMO 35 Ha Noi', amount: 3_200_000, payerName: 'KHACH HANG 55', billId: 'BC-77044', sauPhiBan: null, sauPhiMua: null, loiNhuanAlpha: null, dealerName: null, reconcileStatus: 'UNRECONCILED' },
    { stt: 4, dateIso: '2026-09-10T06:30:00.000Z', hkdName: 'HKD LE THI Hue', amount: 7_800_000, payerName: 'KHACH HANG 59', billId: 'BC-77058', sauPhiBan: null, sauPhiMua: null, loiNhuanAlpha: null, dealerName: null, reconcileStatus: 'UNRECONCILED' }
  ];
  const rows = filter === 'reconciled' ? all.filter((r) => r.reconcileStatus === 'MATCHED')
    : filter === 'unreconciled' ? all.filter((r) => r.reconcileStatus === 'UNRECONCILED')
    : all;
  const totals = rows.reduce((a, r) => { a.amount += r.amount; a.loiNhuanAlpha += r.loiNhuanAlpha ?? 0; a.count += 1; if (r.reconcileStatus === 'UNRECONCILED') a.countUnreconciled += 1; return a; }, { amount: 0, loiNhuanAlpha: 0, count: 0, countUnreconciled: 0 });
  // KPI theo NGÀY (gộp từ rows hiển thị theo ngày HCM). Ở đây tất cả cùng 10/9 → 1 dòng; thêm 1 ngày trước cho có 2 dòng.
  const byDayMap = new Map<string, { day: string; doanhSo: number; count: number; countUnreconciled: number; loiNhuan: number }>();
  for (const r of rows) {
    const d = new Date(new Date(r.dateIso).getTime() + 7 * 3600_000);
    const day = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    const cur = byDayMap.get(day) ?? { day, doanhSo: 0, count: 0, countUnreconciled: 0, loiNhuan: 0 };
    cur.doanhSo += r.amount; cur.count += 1; cur.loiNhuan += r.loiNhuanAlpha ?? 0;
    if (r.reconcileStatus === 'UNRECONCILED') cur.countUnreconciled += 1;
    byDayMap.set(day, cur);
  }
  const byDay = Array.from(byDayMap.values()).sort((a, b) => a.day.localeCompare(b.day));
  return { rows, totals, byDay, from: '2026-09-10', to: '2026-09-11' };
}

// TẢI LẠI giao dịch mới nhất — 2 kịch bản: 'ok' (không lỗi) / 'errors' (có cổng lỗi: sai user/pass, chưa cấu hình, mạng).
let refreshScenario: 'ok' | 'errors' = 'ok';
function refreshBody(): unknown {
  if (refreshScenario === 'errors') {
    return {
      fetched: 12, matched: 9, unreconciled: 3,
      errors: [
        { tid: 'HKD DEMO 35 Ha Noi', code: 'AUTH', reason: 'Sai user/mật khẩu cổng Digistore' },
        { tid: 'HKD LE THI Hue', code: 'NOT_CONFIGURED', reason: 'Chưa cấu hình cổng báo-có cho HKD này' },
        { tid: 'HKD DEMO 42 Sai Gon', code: 'NETWORK', reason: 'Không kết nối được cổng ngân hàng (mạng)' }
      ]
    };
  }
  return { fetched: 15, matched: 13, unreconciled: 2, errors: [] };
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  const billBytes = await readFile(BILL_IMG);
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/chat-realtime|AppShell|real-time|hết hạn/.test(m.text())) console.log('CONSOLE-ERR:', m.text()); });
    // BAOCO_NONOWNER=1 → dùng code KHÔNG-chủ (DL99) để chụp trạng thái CHẶN "chỉ chủ SigMa".
    const injectCode = process.env.BAOCO_NONOWNER ? 'DL99' : 'DL22';
    await page.addInitScript((ownerCode: string) => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      // Owner-gate (Báo cáo Báo-có + Tổng gộp SigMa) đọc getCachedAuthenticatedAgent() → hydrate từ sessionStorage
      // key 'sigma_auth_me_v1'. Đặt code DL22 (Nguoi Dung Demo = chủ SigMa) để màn KHÔNG bị chặn "chỉ chủ SigMa".
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: ownerCode, name: 'Nguoi Dung Demo', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    }, injectCode);
    await page.routeWebSocket(/^ws/, () => { /* */ });

    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (p.endsWith('/v1/ocr-send/ocr') && method === 'POST') return json(route, 200, { ok: true, token: 'tok-qr', kind: 'QR', qrReview: [qrItemDefault()], cached: false });
      if (p.endsWith('/v1/ocr-send/classify-options')) return json(route, 200, { dealers: DEALERS, investors: [{ id: 1, name: 'Anh Quốc' }] });
      if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: billBytes });
      // BÁO CÓ — client bọc {ok, data}: mock trả BODY trực tiếp.
      if (p.endsWith('/v1/digistore/check-baoco') && method === 'POST') return json(route, 200, baoCoBody(currentStatus));
      if (p.endsWith('/v1/digistore/refresh') && method === 'POST') return json(route, 200, refreshBody());
      if (p.endsWith('/v1/digistore/baoco-report')) {
        const u = new URL(route.request().url());
        return json(route, 200, baoCoReport(u.searchParams.get('filter')));
      }
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, 200, method === 'GET' && listLike ? [] : {});
    });

    // ── (e) NON-OWNER: vào thẳng màn Báo cáo Báo-có → PHẢI thấy chặn "chỉ chủ SigMa" (owner-gate client). ──
    if (process.env.BAOCO_NONOWNER) {
      await page.goto(`${baseUrl}/app/baoco-report`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(OUT, 'report-0-nonowner-blocked.png'), fullPage: true });
      console.log('  shot report-0-nonowner-blocked.png (chặn "chỉ chủ SigMa" + menu Báo cáo Báo-có/Tổng gộp ẨN)');
      return;
    }

    // ── (a) THẺ QR + Check báo có 5 trạng thái ──
    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Quét QR', exact: true }).click();
    await page.waitForTimeout(400);
    const billDir = path.join(OUT, '_folder');
    await mkdir(billDir, { recursive: true });
    await writeFile(path.join(billDir, 'bill_1.jpg'), billBytes);
    await page.setInputFiles('[data-testid="qr-folder-input"]', billDir);
    await page.waitForTimeout(3500);
    const checkBtn = page.locator('[data-testid="qr-tab-panel"] [data-testid="qr-check-baoco"]:visible').first();
    for (const st of ['MATCHED', 'NOT_FOUND', 'DUPLICATE', 'AMBIGUOUS', 'CANNOT_CHECK']) {
      currentStatus = st;
      await checkBtn.click();
      await page.locator('[data-testid="qr-tab-panel"] [data-testid="qr-baoco-result"]:visible').first().waitFor({ timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(OUT, `qr-check-${st.toLowerCase()}.png`), fullPage: true });
      console.log(`  shot qr-check-${st.toLowerCase()}.png`);
    }

    // ── (b) MÀN BÁO CÁO BÁO-CÓ ──
    await page.goto(`${baseUrl}/app/baoco-report`, { waitUntil: 'networkidle' });
    await page.locator('[data-testid="baoco-kpi-byday"]').waitFor({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'report-1-all.png'), fullPage: true });
    console.log('  shot report-1-all.png (KPI theo ngày + 4 thẻ tổng + nút "Tải lại giao dịch mới nhất" + dòng chưa đối soát tô nổi)');

    await page.locator('[data-testid="baoco-filter-status"]').selectOption('unreconciled').catch((e) => console.log('  filter err', e.message));
    await page.waitForTimeout(1000);
    await page.screenshot({ path: path.join(OUT, 'report-2-unreconciled.png'), fullPage: true });
    console.log('  shot report-2-unreconciled.png (chỉ dòng CHƯA đối soát)');

    // Về "Tất cả" trước khi test nút tải lại.
    await page.locator('[data-testid="baoco-filter-status"]').selectOption('all').catch(() => {});
    await page.waitForTimeout(800);

    // ── (c) TẢI LẠI GIAO DỊCH MỚI NHẤT — kịch bản THÀNH CÔNG (không lỗi) ──
    refreshScenario = 'ok';
    await page.getByRole('button', { name: 'Tải lại giao dịch mới nhất' }).click();
    await page.locator('[data-testid="baoco-refresh-banner"]').waitFor({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'report-3-refresh-ok.png'), fullPage: true });
    console.log('  shot report-3-refresh-ok.png (banner XANH: kéo 15 · khớp 13 · còn 2 chưa đối soát)');

    // ── (d) TẢI LẠI — kịch bản CÓ CỔNG LỖI (liệt kê mã lỗi + lý do) ──
    refreshScenario = 'errors';
    await page.getByRole('button', { name: 'Tải lại giao dịch mới nhất' }).click();
    await page.locator('[data-testid="baoco-refresh-banner"]').waitFor({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, 'report-4-refresh-errors.png'), fullPage: true });
    console.log('  shot report-4-refresh-errors.png (banner VÀNG: 3 cổng lỗi — AUTH/NOT_CONFIGURED/NETWORK + lý do)');
  } catch (e) {
    console.error('[harness-digistore-baoco] LỖI:', (e as Error).message);
  } finally {
    await browser?.close();
    await server.close();
  }
}
void main();
