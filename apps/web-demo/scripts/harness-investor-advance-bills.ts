// HARNESS R200 (17/9) — BẢNG BILL CK TẠM ỨNG NĐT trên màn Doanh số NĐT (Admin Demo: "DANH SÁCH BILL CK CỦA NĐT OCR
// RA ĐÂU? SAO THIẾU?"). Mock = SỐ THẬT nhà Trung Cẩm Phả 14-16/9 (đúng các bill đã OCR trong nhóm), CÓ CHỦ Ý cắm
// 1 bill "chưa ghi" để nhìn CẢ 2 trạng thái: banner LỆCH đỏ + dòng đỏ, và trạng thái khớp xanh (ảnh thứ 2).
// Chạy: node --import tsx scripts/harness-investor-advance-bills.ts
import { build, preview } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-investor-advance-bills');

const REPORT = { from: '2026-09-14', to: '2026-09-16', investors: [
  { investorId: 16, code: 'INV02', investorName: 'Trung Cẩm Phả', doanhThu: 0, soBill: 0, laiNDT: 0, tienVe: 0, daHoan: { doanhThu: 0, soBill: 0, laiNDT: 0 }, chuaHoan: { doanhThu: 0, soBill: 0, laiNDT: 0 } }
] };
const SETTLE = { from: '2026-09-14', to: '2026-09-16', rows: [
  { investorId: 16, code: 'INV02', investorName: 'Trung Cẩm Phả', doanhThu: 0, laiNDT: 0, tamUng: 6_900_000_000, tienVe: 0, phaiTra: 6_900_000_000, daHoan: 11_935_000, conPhaiTra: 6_888_065_000 }
] };

type Bill = { messageId: string; roomId: string; roomName: string; createdAtIso: string; billDate: string; amount: number;
  kind: 'ADVANCE' | 'REPAYMENT'; ref: string | null; senderName: string; receiverName: string; imageHash: string;
  attachmentId: string | null; recorded: boolean; advanceId: number | null; matchedBy: 'HASH' | 'REF' | 'TIEN_NGAY' | null;
  amountRecorded: number | null; lechTien: number };

const b = (i: number, ngay: string, amount: number, ref: string | null, recorded: boolean, kind: Bill['kind'] = 'ADVANCE'): Bill => ({
  messageId: `m${i}`, roomId: 'r1', roomName: 'Trung Cẩm Phả', createdAtIso: `${ngay}T02:11:00Z`, billDate: ngay,
  amount, kind, ref, senderName: 'KHACH HANG 21', receiverName: 'KHACH HANG 01', imageHash: `h${i}`,
  attachmentId: `att${i}`, recorded, advanceId: recorded ? 200 + i : null, matchedBy: recorded ? (ref ? 'REF' : 'HASH') : null,
  amountRecorded: recorded ? amount : null, lechTien: 0
});

// 14/9 (11 bill thật) + 15/9 + 16/9 rút gọn; bill #10 để CHƯA GHI (đúng ca 200tr bị lưới nuốt).
const BILLS: Bill[] = [
  b(1, '2026-09-14', 400_000_000, '6257VNIB02UWECD7', true),
  b(2, '2026-09-14', 300_000_000, '6257VNIB02UW379D', true),
  b(3, '2026-09-14', 300_000_000, '6257VNIB02UWPLPG', true),
  b(4, '2026-09-14', 400_000_000, null, true),
  b(5, '2026-09-14', 200_000_000, '6257VNIB02UECE8Q', true),
  b(6, '2026-09-14', 200_000_000, '6257VNIB02UEZR5F', true),
  b(7, '2026-09-14', 200_000_000, '6257VNIB02UEUGA8', true),
  b(8, '2026-09-14', 300_000_000, '6257VNIB02UEE9GQ', true),
  b(9, '2026-09-14', 200_000_000, '6257VNIB02UGFWU5', true),
  b(10, '2026-09-14', 200_000_000, null, false),
  b(11, '2026-09-14', 11_935_000, null, true, 'REPAYMENT'),
  b(12, '2026-09-15', 300_000_000, '6258VNIB02UK8QVT', true),
  b(13, '2026-09-15', 400_000_000, '6258VNIB02UKEMWC', true),
  b(14, '2026-09-16', 300_000_000, '6259VNIB02USB9TF', true),
  b(15, '2026-09-16', 200_000_000, 'FT26259869327038', true),
  { ...b(16, '2026-09-16', 300_000_000, '6259VNIB02USW2FB', true), amountRecorded: 200_000_000, lechTien: -100_000_000 }
];
const tong = (f: (x: Bill) => boolean): number => BILLS.filter(f).reduce((s, x) => s + x.amount, 0);
const BILL_REPORT = {
  investorId: 16, from: '2026-09-14', to: '2026-09-16', bills: BILLS,
  tongBillUng: tong((x) => x.kind === 'ADVANCE'),
  tongBillHoan: tong((x) => x.kind === 'REPAYMENT'),
  tongDaGhiUng: tong((x) => x.kind === 'ADVANCE' && x.recorded),
  tongDaGhiHoan: tong((x) => x.kind === 'REPAYMENT' && x.recorded),
  soBillChuaGhi: BILLS.filter((x) => !x.recorded).length,
  tienChuaGhi: tong((x) => !x.recorded),
  soBillLechTien: BILLS.filter((x) => x.recorded && x.lechTien !== 0).length,
  tienLechGhi: BILLS.filter((x) => x.recorded).reduce((s2, x) => s2 + x.lechTien, 0)
};

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error' });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), preview: { port: 0 } });
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:4173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'SigMa' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* mở lửng */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (/\/me\/investor-advance-bills$/.test(p)) return json(route, BILL_REPORT);
      if (/\/me\/investor-advances$/.test(p)) return json(route, { from: '2026-09-14', to: '2026-09-16', investorId: 16, advances: [] });
      if (/\/me\/investor-settlement$/.test(p)) return json(route, SETTLE);
      if (/\/me\/investor-report$/.test(p)) return json(route, REPORT);
      if (/\/me\/investor-report\/filter-options$/.test(p)) return json(route, { tids: [], banks: [] });
      const listLike = /friends|categories|rooms|contacts|notifications|feed|members|list/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });
    // Ảnh bill (ĐĂNG KÝ SAU route tổng — Playwright ưu tiên route đăng ký SAU CÙNG, đăng ký trước sẽ bị nuốt): endpoint chat-attachments trả PNG thật (1x1 phóng lên) — khẳng định CỘT ẢNH tải được qua
    // proxyFetch→objectURL (gate CSRF chặn <img src> thẳng), không phải ô trống.
    const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    await page.route('**/v1/chat/attachments/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PNG }));
    await page.goto(`${baseUrl}/app/investor-revenue`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    // CHIP cảnh báo phải hiện NGAY trên thẻ, CHƯA cần mở chi tiết (đúng mục đích: tiền rơi không được nằm khuất).
    const chipChuaGhi = await page.getByTestId('chip-bill-chua-ghi').first().isVisible().catch(() => false);
    const chipLechTien = await page.getByTestId('chip-bill-lech-tien').first().isVisible().catch(() => false);
    console.log('[chip trên thẻ NĐT] chưa-ghi =', chipChuaGhi, '· lệch-tiền =', chipLechTien);
    await page.screenshot({ path: path.join(OUT, 'the-ndt-chip-canh-bao.png') });

    // Bảng nằm TRONG phần chi tiết của thẻ NĐT → phải bấm "Xem chi tiết theo Lô" mới hiện (đúng thao tác user).
    await page.getByText(/Xem chi tiết theo Lô/).first().click();
    await page.waitForTimeout(1500);

    const coBang = await page.getByTestId('bang-bill-ck-ndt').first().isVisible().catch(() => false);
    const coCanhBao = await page.getByTestId('canh-bao-lech-bill-ndt').first().isVisible().catch(() => false);
    const soDong = await page.locator('[data-testid="bang-bill-ck-ndt"] tbody tr').count().catch(() => 0);
    const chuaGhi = await page.getByText('✕ CHƯA GHI').count().catch(() => 0);
    const lechTienDong = await page.getByText('≠ LỆCH TIỀN').count().catch(() => 0);
    const bannerLechTien = await page.getByTestId('canh-bao-lech-tien-ndt').first().isVisible().catch(() => false);
    console.log('[lệch tiền] dòng =', lechTienDong, '· banner =', bannerLechTien);
    console.log('[bảng bill CK NĐT] hiện =', coBang, '· banner LỆCH =', coCanhBao, '· số dòng =', soDong, '· dòng CHƯA GHI =', chuaGhi);

    // Cuộn tới ĐÚNG dòng lệch tiền rồi chụp khung nhìn — LEAD phải NHÌN THẤY dòng hổ phách, không tin số suông (R200).
    const badgeLech = page.getByText('≠ LỆCH TIỀN').first();
    if (await badgeLech.isVisible().catch(() => false)) {
      await badgeLech.scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, 'dong-lech-tien.png') });
    }
    await page.screenshot({ path: path.join(OUT, 'bang-bill-ck-ndt.png'), fullPage: true });
    const el = page.getByTestId('bang-bill-ck-ndt').first();
    if (await el.isVisible().catch(() => false)) await el.screenshot({ path: path.join(OUT, 'bang-bill-ck-ndt-crop.png') });
    console.log('[harness] Chụp ->', OUT);
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
