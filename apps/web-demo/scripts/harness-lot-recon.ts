// HARNESS R200 (Admin Demo 16/9 tối — đối soát + hoàn per LÔ POS ở màn Doanh số phòng): điều khiển THẬT —
// tick lô → Xác nhận đối soát (ConfirmModal) → Xác nhận hoàn tiền (RefundQrModal + QR) → trạng thái chip đổi;
// kiểm SORT lô mới lên trên + lọc trạng thái + báo cáo ảnh có khối VietQR.
// Chạy: node --import tsx scripts/harness-lot-recon.ts
import { preview } from 'vite'; // dùng BUNDLE BUILD thật (dev-transform lỗi '__name is not defined' làm chunk màn này không nạp — build sạch)
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'lot-recon');
const ROOM = 'room-tuyen';
const TIDS = [{ tidId: 1, tid: '53590003', hkdName: 'HKD DEMO 19', bankName: 'Vietcombank' }];
const row = (loId: number, lot: number, iso: string, gross: number, net: number): Record<string, unknown> => ({
  loId, tidId: 1, date: iso.slice(0, 10), effDateIso: iso, bankReportedLoNumber: lot, billLoNumber: String(lot),
  investorNickname: null, gross, fee: gross - net, net, borrowed: false, tidOwnerName: null
});
const REPORT = {
  from: '2026-09-16', to: '2026-09-17', tids: TIDS,
  totalGross: 120_000_000, totalFee: 1_200_000, totalNet: 118_800_000, loCount: 3,
  daily: [{ date: '2026-09-16', gross: 120_000_000, net: 118_800_000 }],
  rows: [
    row(101, 205, '2026-09-16T02:10:00Z', 15_536_000, 15_380_640), // cũ nhất
    row(102, 206, '2026-09-16T05:20:00Z', 48_265_000, 47_782_350),
    row(103, 207, '2026-09-16T08:45:00Z', 56_199_000, 55_637_010)  // mới nhất → phải LÊN ĐẦU
  ]
};
const noteCalls: string[] = [];
const reconState: Record<string, { ds: boolean; refundDone: boolean; note?: string }> = {};
const ycState: Record<string, { code: string; status: string; amount: number }> = {};
let ycSo = 0;
const json = (route: Route, body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', preview: { port: 0 } });
  const base = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1900, height: 1050 } /* ĐÚNG khổ máy Admin Demo (ảnh user 1900px) */, timezoneId: 'Asia/Ho_Chi_Minh' });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    page.on('pageerror', (e) => console.log('PAGE-ERROR:', e.message, (e.stack ?? '').split(String.fromCharCode(10)).slice(1, 3).join(' | ')));
    page.on('console', (m) => { if (m.type() === 'error') { console.log('CONSOLE-ERR:', m.text().slice(0, 200)); for (const a of m.args()) void a.evaluate((e: unknown) => (e as Error)?.stack ?? null).then((st) => { if (st) console.log('STACK:', String(st).split(String.fromCharCode(10)).slice(0, 4).join(' | ')); }).catch(() => {}); } });
    page.on('requestfailed', (r) => console.log('REQ-FAIL:', r.url().slice(0, 140), r.failure()?.errorText));
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const u = new URL(route.request().url());
      const p = u.pathname;
      if (p.endsWith(`/rooms/${ROOM}/revenue`)) return json(route, { ok: true, data: REPORT }); // chatFetch cần vỏ {ok,data}
      if (p.endsWith(`/rooms/${ROOM}`)) return json(route, { ok: true, data: { id: ROOM, type: 'GROUP', name: 'ĐL - Tuyên SG', members: [{ agentId: 9, name: 'Tuyên SG', code: 'DL90' }] } });
      if (p.includes('refund-reconcile') || p.includes('/reconcile')) return json(route, { ok: true, data: { from: '2026-09-16', to: '2026-09-17', days: [], totalCanHoan: 0, totalDaHoan: 0, totalThuaThieu: 0, unmatchedDaHoan: 0, totalDaUng: 0, bills: [] } });
      if (p.includes('lot-gaps') || p.includes('/gaps')) return json(route, { ok: true, data: { days: 3, gaps: [] } });
      // [17/9] YC gộp lô — mock đủ để chạy luồng: tra YC theo lô · tạo YC · xác nhận đã chuyển.
      if (p.endsWith('/v1/refund-request') && route.request().method() === 'GET') return json(route, { ok: true, yc: ycState });
      if (p.endsWith('/v1/refund-request') && route.request().method() === 'POST') {
        const b = route.request().postDataJSON() as { lotIds: number[]; amount: number };
        ycSo += 1;
        const code = `YC${String(ycSo).padStart(3, '0')}`;
        for (const id of b.lotIds) ycState[String(id)] = { code, status: 'MOI', amount: b.amount };
        return json(route, { ok: true, data: { id: ycSo, code, dealerKey: 'Tuyên SG', dealerLabel: 'Tuyên SG', nguon: 'DL', amount: b.amount, lotIds: b.lotIds, bankCode: 'VIKKI', accountNo: '989246411', accountName: 'KHACH HANG 42', status: 'MOI', paidAtIso: null, paidRef: null, createdAtIso: new Date().toISOString() }, message: `Đã tạo ${code} · ${b.amount.toLocaleString('vi-VN')}đ · ${b.lotIds.length} lô.` });
      }
      if (p.endsWith('/v1/refund-request/paid')) {
        const b = route.request().postDataJSON() as { code: string };
        for (const k of Object.keys(ycState)) if (ycState[k]!.code === b.code) { ycState[k]!.status = 'DA_CHUYEN'; reconState[k] = { ds: true, refundDone: true }; }
        return json(route, { ok: true, message: `${b.code}: đã ghi CHUYỂN TIỀN, đánh dấu hoàn các lô.` });
      }
      if (p.endsWith('/pos-lot/note') && route.request().method() === 'POST') {
        const b = route.request().postDataJSON() as { lotId: number; note: string };
        noteCalls.push(`${b.lotId}:${b.note}`);
        (reconState[String(b.lotId)] ??= { ds: false, refundDone: false }).note = b.note;
        return json(route, { ok: true, message: 'Đã lưu ghi chú.' });
      }
      if (p.endsWith('/pos-lot/recon') && route.request().method() === 'GET') return json(route, { ok: true, recon: reconState });
      if (p.endsWith('/pos-lot/recon') && route.request().method() === 'POST') {
        const b = route.request().postDataJSON() as { lotIds: number[]; ds: boolean };
        for (const id of b.lotIds) reconState[String(id)] = { ds: b.ds, refundDone: false };
        return json(route, { message: `Đã ${b.ds ? 'xác nhận' : 'bỏ'} đối soát ${b.lotIds.length} lô.` });
      }
      if (p.endsWith('/pos-lot/refund-done')) {
        const b = route.request().postDataJSON() as { lotIds: number[] };
        for (const id of b.lotIds) reconState[String(id)] = { ds: true, refundDone: true };
        return json(route, { message: `Đã ghi HOÀN ${b.lotIds.length} lô.` });
      }
      if (p.endsWith('/digistore/dealer-refund-account')) return json(route, { ok: true,
        account: { bankCode: 'VIKKI', accountNo: '989246411', accountName: 'KHACH HANG 42', dealer: 'Tuyên SG', isDefault: true },
        // 4 TK THẬT của Tuyên SG (17/9) — để nhìn danh sách dọc nhiều màu brand + thẻ đang chọn nổi 3D.
        accounts: [
          { bankCode: 'VIKKI', accountNo: '989246411', accountName: 'KHACH HANG 42', dealer: 'Tuyên SG', isDefault: true },
          { bankCode: 'ACB', accountNo: '390528', accountName: 'KHACH HANG 42', dealer: 'Tuyên SG', isDefault: false },
          { bankCode: 'MB', accountNo: '0900000604', accountName: 'KHACH HANG 37', dealer: 'Tuyên SG', isDefault: false },
          { bankCode: 'BIDV', accountNo: '8869347964', accountName: 'KHACH HANG 42', dealer: 'Tuyên SG', isDefault: false }
        ] });
      if (p.includes('/digistore/vietqr-png')) {
        const png = await readFile(path.join(ROOT, 'qa-screenshots', 'vietqr-tuyen-test.png'));
        return route.fulfill({ status: 200, contentType: 'image/png', body: png });
      }
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list|gaps|reconcile/i.test(p);
      const rong = route.request().method() === 'GET' && listLike ? [] : {};
      // 2 kiểu unwrap: chatFetch (/v1/chat/*) cần vỏ {ok,data}; agentApiFetch (/v1/me/* v.v.) đọc body TRẦN.
      return json(route, p.startsWith('/v1/chat/') ? { ok: true, data: rong } : rong);
    });
    await page.goto(`${base}/app/chat/${ROOM}/revenue`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1600);
    // [Admin Demo 17/9] LUỒNG MỚI: tích lô → "Xác nhận đối soát" → KHỐI tự bung, làm tiếp NGAY trong đó.
    const ticks = page.locator('[data-testid="lot-tick"]');
    console.log('[0] số lô =', await ticks.count());
    // [Admin Demo 21/9] CỘT GHI CHÚ: hiện trên bảng ĐL, gõ note → POST /pos-lot/note đúng loId + giá trị
        console.log('[DBG] header Ghi chú =', await page.getByText('Ghi chú', { exact: true }).count(), '· header Mã YC =', await page.getByText('Mã YC', { exact: true }).count());
    console.log('[DBG] body chứa "ghi chú…" placeholder =', await page.locator('input[placeholder="ghi chú…"]').count());
    const oGhiChu = page.locator('[data-testid="o-ghi-chu"]').first();
    console.log('[GHI CHÚ] ô nhập hiện =', await oGhiChu.isVisible().catch(() => false), '· số ô =', await page.locator('[data-testid="o-ghi-chu"]').count());
    await oGhiChu.click();
    await oGhiChu.fill('máy đổi chủ 21/9');
    await oGhiChu.blur();
    await page.waitForTimeout(700);
    console.log('[GHI CHÚ] POST note đã gọi =', JSON.stringify(noteCalls));
    const giaTriSau = await page.locator('[data-testid="o-ghi-chu"]').first().inputValue().catch(() => '?');
    console.log('[GHI CHÚ] giá trị sau reload recon =', JSON.stringify(giaTriSau));
    await page.screenshot({ path: path.join(OUT, 'ghi-chu-da-luu.png') });
    await ticks.nth(0).click(); await ticks.nth(1).click(); await ticks.nth(2).click();
    await page.locator('[data-testid="lot-btn-ds"]').click();
    await page.locator('[data-testid="confirm-modal-ok"]').click();
    await page.waitForTimeout(2500);
    const khoiHien = await page.locator('[data-testid="lot-rpt-modal"]').isVisible().catch(() => false);
    const coTaoAnh = await page.getByTestId('btn-tao-anh').isVisible().catch(() => false);
    const coGop = await page.getByTestId('btn-yeu-cau-gop').isVisible().catch(() => false);
    const coHoan = await page.getByTestId('btn-xac-nhan-hoan').isVisible().catch(() => false);
    const coXuat = await page.getByTestId('btn-xuat-anh').isVisible().catch(() => false);
    console.log('[1] Xác nhận đối soát → KHỐI tự bung =', khoiHien, '| menu: tạo ảnh', coTaoAnh, '· gộp', coGop, '· hoàn+QR', coHoan, '· xuất ảnh', coXuat);
    await page.screenshot({ path: path.join(OUT, 'khoi-1-vua-mo.png') });
    // [Admin Demo 17/9] Danh sách TK dọc + chọn TK khác → thẻ đó phải NỔI 3D và ảnh/QR dựng lại theo TK đó.
    const soTk = await page.getByTestId('tk-item').count();
    await page.getByTestId('tk-item').nth(3).click(); // BIDV · KHACH HANG 42
    await page.waitForTimeout(2000);
    const chonBidv = await page.getByTestId('tk-item').nth(3).getAttribute('aria-pressed');
    console.log('[TK] số thẻ TK =', soTk, '· sau khi bấm thẻ BIDV: aria-pressed =', chonBidv);
    await page.screenshot({ path: path.join(OUT, 'khoi-1b-chon-tk-bidv.png') });
    // Bước 2: yêu cầu gộp
    await page.getByTestId('btn-yeu-cau-gop').click();
    await page.waitForTimeout(1800);
    const chipYc = await page.getByTestId('yc-trong-khoi').textContent().catch(() => null);
    console.log('[2] Yêu cầu gộp →', JSON.stringify(chipYc?.trim()));
    await page.screenshot({ path: path.join(OUT, 'khoi-2-da-gop.png') });
    // Bước 3: xác nhận hoàn tiền + QR
    await page.getByTestId('btn-xac-nhan-hoan').click();
    await page.waitForTimeout(2200);
    // [Admin Demo 17/9] CHỈ ĐƯỢC CÓ 1 mã QR trên màn — QR nằm TRONG ảnh báo cáo; khối QR riêng đã bỏ.
    const soQrRieng = await page.getByTestId('khoi-qr').count();
    const soAnh = await page.locator('[data-testid="lot-rpt-modal"] img[alt="Báo cáo lô POS"]').count();
    const msg = await page.getByTestId('khoi-msg').textContent().catch(() => null);
    console.log('[3] Xác nhận hoàn → khối QR riêng =', soQrRieng, '(phải 0) · ảnh báo cáo =', soAnh, '| msg:', JSON.stringify((msg ?? '').slice(0, 70)));
    await page.screenshot({ path: path.join(OUT, 'khoi-3-hoan-qr.png') });
  } finally {
    await browser?.close();
    await server.close();
  }
}
void main();
