// HARNESS R200 (Admin Demo 16/9 "cuộn ngang mất thông tin + brand thanh đối soát") — màn Báo cáo QR THẬT (vite +
// route mock) ở ĐÚNG bề rộng cửa sổ user (ảnh user 1875px): bảng phải HẾT cuộn ngang (đủ 14 cột trong khung),
// thanh action gradient brand SigMa. Data = đúng ca user (HKD dài "HO KINH DOANH DEMO CUONG 03", 8 GD 16/9).
// Chạy: node --import tsx scripts/harness-baoco-qr.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'baoco-qr');
const row = (stt: number, iso: string, amount: number, payer: string, nguon: string, sauPhiBan: number | null, dealer: string | null): Record<string, unknown> => ({
  stt, dateIso: iso, hkdName: stt === 8 ? 'HKD DEMOMAY' : 'HO KINH DOANH DEMO CUONG 03', amount, payerName: payer,
  billId: 'B' + stt, sauPhiBan, sauPhiMua: sauPhiBan != null ? Math.round(sauPhiBan * 1.0015) : null,
  loiNhuanAlpha: null, dealerName: dealer, reconcileStatus: stt <= 3 ? 'MATCHED' : 'UNRECONCILED',
  nguon: stt === 8 ? 'SMARTPAY' : 'BVB', manualDs: null, manualDealer: null, maChuName: dealer, sourceTidId: 1, feeType: 'cho', coPhiNhanh: stt === 8 // [16/9 tối] bill SmartPay có giá nhanh → dropdown Chờ/Nhanh
});
const ROWS = [
  row(1, '2026-09-16T05:10:54Z', 20898000, 'KHACH HANG 04', 'BVB', 20689020, null),
  row(2, '2026-09-16T05:08:31Z', 47276000, 'KHACH HANG 04', 'BVB', 46803240, null),
  row(3, '2026-09-16T05:00:15Z', 48826000, 'KHACH HANG 04', 'BVB', 48337740, null),
  row(4, '2026-09-16T04:23:00Z', 28473000, 'KHACH HANG 39', 'BVB', 28188270, 'Bình SG'),
  row(5, '2026-09-16T02:43:00Z', 14110000, 'KHACH HANG 11', 'BVB', 13968900, 'NĐT 2'),
  row(6, '2026-09-16T02:42:00Z', 45890000, 'KHACH HANG 11', 'BVB', 45431100, 'NĐT 2'),
  row(7, '2026-09-16T02:11:00Z', 29996000, 'KHACH HANG 17', 'BVB', 29696040, 'Bình SG'),
  row(8, '2026-09-16T01:28:00Z', 9980000, 'KHACH HANG 29', 'SMARTPAY', 9885190, 'NĐT 2')
];
const REPORT = {
  rows: ROWS,
  totals: { amount: ROWS.reduce((s, r) => s + (r['amount'] as number), 0), loiNhuanAlpha: 0, count: 8, countUnreconciled: 8 },
  byDay: [{ day: '2026-09-16', doanhSo: 245449000, count: 8, countUnreconciled: 8, loiNhuan: 0 }],
  limitWarnings: []
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
    const ctx = await browser.newContext({ viewport: { width: 1875, height: 1020 }, timezoneId: 'Asia/Ho_Chi_Minh' });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    page.on('pageerror', (e) => console.log('PAGE-ERROR:', e.message));
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/v1/digistore/baoco-report')) return json(route, REPORT);
      if (p.endsWith('/v1/digistore/dealer-names')) return json(route, { ok: true, dealers: ['Trường Thiện SG', 'Nguyễn', 'Bảo SG', 'NAM HÀ', 'A BÌnh', 'NĐT 2', 'Bình SG'] });
      // [16/9 — VietQR] mock đối soát + TK đại lý + ảnh QR (PNG THẬT tải từ img.vietqr.io lưu qa-screenshots).
      if (p.endsWith('/v1/digistore/baoco-recon')) {
        // đợt xác nhận: server thật set ds=true → mock đổi REPORT rows tick sang MATCHED-manualDs để reload thấy vàng
        for (const r of REPORT.rows as Array<Record<string, unknown>>) if (['B1', 'B2', 'B3'].includes(String(r['billId']))) { r['manualDs'] = true; r['manualDealer'] = 'Trường Thiện SG'; }
        return json(route, { message: 'Đã xác nhận 3 GD.' });
      }
      if (p.endsWith('/v1/digistore/dealer-refund-account')) return json(route, { ok: true,
        account: { bankCode: 'OCB', accountNo: '0900000602', accountName: 'KHACH HANG 24', dealer: 'Trường Thiện SG', isDefault: true },
        accounts: [
          { bankCode: 'OCB', accountNo: '0900000602', accountName: 'KHACH HANG 24', dealer: 'Trường Thiện SG', isDefault: true },
          { bankCode: 'TPB', accountNo: '02518354903', accountName: 'KHACH HANG 18', dealer: 'Trường Thiện SG', isDefault: false }
        ] });
      if (p.endsWith('/v1/digistore/refund-done')) {
        for (const r of REPORT.rows as Array<Record<string, unknown>>) if (['B1', 'B2', 'B3'].includes(String(r['billId']))) r['refundDone'] = true;
        return json(route, { message: 'Đã ghi HOÀN 3 GD.' });
      }
      if (p.includes('/v1/digistore/vietqr-png')) {
        const png = await readFile(path.join(ROOT, 'qa-screenshots', 'vietqr-sample.png'));
        return route.fulfill({ status: 200, contentType: 'image/png', body: png });
      }
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });
    await page.goto(`${baseUrl}/app/baoco-report`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    // đo cuộn ngang THẬT của khung bảng
    const scroll = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="baoco-tick-row"]')?.closest('.overflow-x-auto');
      return el ? { sw: el.scrollWidth, cw: el.clientWidth } : null;
    });
    console.log('KHUNG BẢNG scrollWidth/clientWidth:', JSON.stringify(scroll), scroll && scroll.sw <= scroll.cw ? '→ HẾT cuộn ngang ✓' : '→ VẪN CUỘN NGANG ✗');
    // tick 3 dòng đầu cho thanh action hiện
    const ticks = page.locator('[data-testid="baoco-tick-row"]');
    for (let i = 0; i < 3; i++) await ticks.nth(i).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'baoco-qr-1875.png'), fullPage: false });
    const bar = page.locator('[data-testid="baoco-action-bar"]');
    if (await bar.count()) await bar.screenshot({ path: path.join(OUT, 'action-bar.png') });

    // [16/9 tối] dropdown phí Chờ/Nhanh: chỉ bill SmartPay (coPhiNhanh) có; đổi Nhanh → bắn POST baoco-fee-type
    const feeSel = page.locator('[data-testid="baoco-fee-type"]');
    console.log('DROPDOWN PHÍ Chờ/Nhanh:', await feeSel.count(), '(mong 1 — chỉ bill SmartPay)');
    let feePost = false;
    await page.route('**/v1/digistore/baoco-fee-type', async (route) => { feePost = true; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: 'Đã chuyển phí TIỀN NHANH.' }) }); });
    await feeSel.first().selectOption('nhanh');
    await page.waitForTimeout(500);
    console.log('ĐỔI SANG NHANH → POST baoco-fee-type:', feePost ? '✓ đã bắn' : '✗ KHÔNG bắn');
    // ── [16/9 — VietQR] ĐIỀU KHIỂN THẬT: Xác nhận đã đối soát → modal QR hoàn → Xác nhận ĐÃ HOÀN → trạng thái ──
    // chọn đại lý cho đợt ở action bar (rows mock chưa gán) — như người dùng thật
    await page.locator('[data-testid="baoco-action-bar"] select').first().selectOption('Trường Thiện SG');
    await page.getByRole('button', { name: 'Xác nhận đã đối soát' }).click();
    const modal = page.locator('[data-testid="refund-qr-modal"]');
    await modal.waitFor({ timeout: 8000 });
    await page.locator('[data-testid="refund-qr-img"]').first().waitFor({ timeout: 8000 });
    const tienTron = await modal.locator('.text-2xl').first().textContent();
    console.log('MODAL: tiền làm tròn hiển thị =', JSON.stringify(tienTron?.trim()));
    // [16/9 tối — nhiều TK] chips: 2 TK, bấm chip TPB → tên chủ TK đổi theo
    const chips = modal.locator('[data-testid="refund-acc-chip"]');
    console.log('SỐ CHIP TK:', await chips.count(), '(mong 2)');
    await chips.nth(1).click();
    await page.waitForTimeout(500);
    const tenSauDoi = await modal.locator('.font-bold.text-slate-800').first().textContent();
    console.log('SAU BẤM CHIP 2 — chủ TK:', JSON.stringify(tenSauDoi?.trim()), '(mong KHACH HANG 18)');
    await chips.nth(0).click();
    await page.waitForTimeout(400);
    await modal.screenshot({ path: path.join(OUT, 'refund-qr-modal.png') });
    // Xác nhận ĐÃ HOÀN → ConfirmModal BRAND (16/9 thay window.confirm hệ thống) → chụp + bấm nút xác nhận
    await page.locator('[data-testid="refund-confirm"]').first().click();
    await page.locator('[data-testid="confirm-modal"]').waitFor({ timeout: 5000 });
    await page.locator('[data-testid="confirm-modal"] > div').screenshot({ path: path.join(OUT, 'confirm-modal-brand.png') });
    await page.locator('[data-testid="confirm-modal-ok"]').click();
    await page.waitForTimeout(800);
    await modal.screenshot({ path: path.join(OUT, 'refund-qr-done.png') });
    // Đóng modal → bảng reload: 3 dòng phải XANH "Hoàn tất" + dropdown KHOÁ + nút ✏
    await modal.locator('button:has-text("Đóng")').click();
    await page.waitForTimeout(600);
    const xanh = await page.locator('text=✓ Hoàn tất').count();
    const choHoan = await page.locator('text=⏳ Chờ hoàn').count();
    const khoa = await page.locator('[data-testid="baoco-row-dealer"]:disabled').count();
    const butSua = await page.locator('[data-testid="baoco-dealer-edit"]').count();
    console.log(`SAU HOÀN: xanh HoànTất=${xanh} (mong 3) · Chờ hoàn=${choHoan} · dropdown khoá=${khoa} · nút ✏=${butSua}`);
    await page.screenshot({ path: path.join(OUT, 'baoco-sau-hoan.png'), fullPage: false });
    // ── [16/9] ẢNH BÁO CÁO kèm khối VietQR (1 đại lý + có TK) ──
    const ticks2 = page.locator('[data-testid="baoco-tick-row"]');
    for (let i = 0; i < 3; i++) await ticks2.nth(i).click();
    await page.getByRole('button', { name: 'Tạo báo cáo ảnh' }).click();
    const rpt = page.locator('[data-testid="baoco-rpt-modal"] img');
    await rpt.waitFor({ timeout: 10000 });
    await page.waitForTimeout(600);
    await rpt.screenshot({ path: path.join(OUT, 'bao-cao-anh-vietqr.png') });
    console.log('ảnh báo cáo + VietQR đã chụp');
    console.log('ảnh:', OUT);
  } finally {
    await browser?.close();
    await server.close();
  }
}
void main();
