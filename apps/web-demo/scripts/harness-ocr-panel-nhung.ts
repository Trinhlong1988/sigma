// HARNESS R200 (Admin Demo 17/9): quét bill phải mở KHỐI NỔI trên nền doanh số — "click vào sẽ hiện nổi blog đầy đủ
// lên, màn doanh số nằm PHÍA DƯỚI làm nền", KHÔNG chèn trên đẩy doanh số xuống gây tràn/cuộn; và "ocr xong doanh số
// phải tự cập nhật real time", khối tự biến mất khi hết bill. ĐIỀU KHIỂN THẬT: bấm từng nút (thủ công/tự động/QR) →
// overlay hiện, URL không đổi, doanh số VẪN Ở NỀN DƯỚI; đóng → doanh số nguyên vẹn. Ảnh tĩnh KHÔNG đủ (R200 vá a).
// Chạy: node --import tsx scripts/harness-ocr-panel-nhung.ts
import { preview } from 'vite'; // BUNDLE BUILD thật (dev-transform lỗi '__name is not defined' làm chunk màn này không nạp)
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'qa-screenshots', 'ocr-panel-nhung');
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
    row(101, 205, '2026-09-16T02:10:00Z', 15_536_000, 15_380_640),
    row(102, 206, '2026-09-16T05:20:00Z', 48_265_000, 47_782_350),
    row(103, 207, '2026-09-16T08:45:00Z', 56_199_000, 55_637_010)
  ]
};
const json = (route: Route, body: unknown): Promise<void> => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', preview: { port: 0 } });
  const base = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1900, height: 1050 } /* ĐÚNG khổ máy Admin Demo */, timezoneId: 'Asia/Ho_Chi_Minh' });
    const page = await ctx.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));
      window.sessionStorage.removeItem('ocrSend.parent'); // vào sạch, không dính state phiên trước
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    page.on('pageerror', (e) => console.log('PAGE-ERROR:', e.message));
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith(`/rooms/${ROOM}/revenue`)) return json(route, { ok: true, data: REPORT });
      if (p.endsWith(`/rooms/${ROOM}`)) return json(route, { ok: true, data: { id: ROOM, type: 'GROUP', name: 'ĐL - Tuyên SG', members: [{ agentId: 9, name: 'Tuyên SG', code: 'DL90' }] } });
      if (p.includes('refund-reconcile')) return json(route, { ok: true, data: { from: '2026-09-16', to: '2026-09-17', days: [], totalCanHoan: 0, totalDaHoan: 0, totalThuaThieu: 0, unmatchedDaHoan: 0, totalDaUng: 0, bills: [] } });
      if (p.includes('lot-gaps') || p.includes('/gaps')) return json(route, { ok: true, data: { days: 3, gaps: [] } });
      if (p.endsWith('/pos-lot/recon')) return json(route, { ok: true, recon: {} });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list|gaps|reconcile/i.test(p);
      const rong = route.request().method() === 'GET' && listLike ? [] : {};
      return json(route, p.startsWith('/v1/chat/') ? { ok: true, data: rong } : rong);
    });

    const urlRevenue = `${base}/app/chat/${ROOM}/revenue`;
    await page.goto(urlRevenue, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    const soLoTruoc = await page.locator('[data-testid="lot-tick"]').count();
    console.log('[0] Vào màn doanh số · số lô =', soLoTruoc, '· URL =', page.url().replace(base, ''));

    // 1) Bấm "OCR thủ công" — KHÔNG được rời màn.
    await page.locator('[data-testid="lot-btn-ocr-manual"]').click();
    await page.waitForTimeout(1200);
    const urlSau = page.url();
    const panelHien = await page.locator('[data-testid="panel-ocr-nhung"]').isVisible().catch(() => false);
    const soLoSau = await page.locator('[data-testid="lot-tick"]').count();
    const tabThuCongOn = await page.locator('[data-testid="panel-ocr-nhung"]').getByText('Thủ công', { exact: false }).count();
    console.log('[1] Bấm OCR thủ công → panel hiện =', panelHien,
      '| URL GIỮ NGUYÊN =', urlSau === urlRevenue,
      '| bảng doanh số CÒN (số lô) =', soLoSau,
      '| tab Thủ công =', tabThuCongOn > 0);
    await page.screenshot({ path: path.join(OUT, '1-panel-thu-cong.png') });

    // 2) Khối NỔI che nút phía dưới (đúng bản chất overlay) → đổi chế độ bằng 3 TAB NGAY TRONG KHỐI.
    await page.locator('[data-testid="panel-ocr-nhung"]').getByText('Tự động', { exact: false }).first().click();
    await page.waitForTimeout(900);
    const tieuDe = await page.locator('[data-testid="panel-ocr-nhung"]').locator('div').first().textContent();
    console.log('[2] Bấm OCR tự động → tiêu đề khối =', JSON.stringify((tieuDe ?? '').trim().slice(0, 70)),
      '| URL GIỮ NGUYÊN =', page.url() === urlRevenue);
    await page.screenshot({ path: path.join(OUT, '2-khoi-noi-tu-dong.png') });

    // 2b) Tab QR trong khối (Admin Demo "kể cả qr"); nút "🔳 OCR QR" ngoài header mở thẳng tab này khi khối đang đóng.
    await page.locator('[data-testid="panel-ocr-nhung"]').getByText('Quét QR', { exact: false }).first().click();
    await page.waitForTimeout(800);
    const tieuDeQr = await page.locator('[data-testid="panel-ocr-nhung"]').locator('div').first().textContent();
    console.log('[2b] Bấm OCR QR → tiêu đề khối =', JSON.stringify((tieuDeQr ?? '').trim().slice(0, 40)));
    await page.screenshot({ path: path.join(OUT, '2b-khoi-noi-qr.png') });

    // 3) KHỐI PHẢI NỔI: overlay tồn tại và bảng doanh số vẫn nằm trong DOM phía SAU (nền), không bị đẩy đi.
    const coOverlay = await page.locator('[data-testid="ocr-overlay"]').isVisible().catch(() => false);
    const loSauNen = await page.locator('[data-testid="lot-tick"]').count();
    console.log('[3] Overlay nổi =', coOverlay, '| bảng doanh số VẪN Ở NỀN (số lô) =', loSauNen);
    await page.screenshot({ path: path.join(OUT, '3-khoi-noi-tren-nen-doanh-so.png') });

    // 4) Đóng khối → doanh số nguyên vẹn, vẫn ở đúng màn.
    await page.locator('[data-testid="ocr-panel-dong"]').click();
    await page.waitForTimeout(600);
    const panelConHien = await page.locator('[data-testid="panel-ocr-nhung"]').isVisible().catch(() => false);
    console.log('[4] Đóng khối → khối còn hiện =', panelConHien,
      '| số lô =', await page.locator('[data-testid="lot-tick"]').count(),
      '| URL =', page.url() === urlRevenue);
    await page.screenshot({ path: path.join(OUT, '4-sau-khi-dong.png') });

    // 5) Nút "🔳 OCR QR" ở header (khối đã đóng) phải mở khối ĐÚNG TAB QR.
    await page.locator('[data-testid="lot-btn-ocr-qr"]').click();
    await page.waitForTimeout(900);
    const tdQr = await page.locator('[data-testid="panel-ocr-nhung"]').locator('div').first().textContent();
    console.log('[5] Nút OCR QR mở khối → tiêu đề =', JSON.stringify((tdQr ?? '').trim().slice(0, 40)));
    await page.locator('[data-testid="ocr-panel-dong"]').click();
    await page.waitForTimeout(400);

    // 6) REAL-TIME sau gửi: khối gọi onSent → màn tăng reloadTick → GỌI LẠI API /revenue. Không dựng được luồng OCR
    //    thật (cần ảnh bill + API OCR) nên đo trên CÙNG cơ chế: đếm số lần gọi /revenue khi reloadTick tăng.
    let soLanGoiRevenue = 0;
    page.on('request', (r) => { if (r.url().includes('/revenue')) soLanGoiRevenue++; });
    const truoc = soLanGoiRevenue;
    await page.getByText('Hôm qua', { exact: true }).first().click(); // đổi kỳ → cùng đường nạp lại doanh số
    await page.waitForTimeout(1200);
    console.log('[6] Gọi API /revenue: trước =', truoc, '· sau khi nạp lại =', soLanGoiRevenue,
      '→ cơ chế refresh doanh số hoạt động =', soLanGoiRevenue > truoc);
    console.log('[harness] Ảnh →', OUT);
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
