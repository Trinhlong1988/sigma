// HARNESS R200 (Admin Demo 8/9) — render THẬT thẻ bill QR khi OCR KHÔNG đọc được TÊN HKD (app ngân hàng cắt cụt):
// phải hiện khối "Tìm mã QR từ báo có" → bấm → danh sách gợi ý (khớp số tiền + ngày + giờ) → chọn 1 dòng → thẻ
// khớp lại mã QR + phí + tự điền tên người quẹt. LEAD tự nhìn ảnh trước khi ship.
// Chạy: node --import tsx scripts/harness-qr-hkd-suggest.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-qr-hkd-suggest');
const BILL_IMG = path.join(ROOT, 'screenshots', 'harness-bug1', '_folder', 'bill_1.jpg');
const DEALERS = [{ roomId: 'r-nguyen-sg', name: 'ĐL- Nguyễn SG' }, { roomId: 'r-bao-sg', name: 'ĐL- Bảo SG' }];
const AT = Date.UTC(2026, 8, 8, 1, 58); // 08:58 08/9 giờ HCM

/** Bill QR: OCR ra ĐỦ tiền/ngày/giờ/số GD nhưng TÊN HKD rỗng (app cắt chữ) → chưa khớp mã (tidId null, chưa có phí). */
function qrItemNoHkd(): unknown {
  return {
    qr: { hkdName: null, amount: 29_998_000, ref: '6251VNIB024PKM8D', dateTime: '08/09/2026 08:58', fromCard: 'VIB Rewards ••0708' },
    tidId: null, tidCode: null, hkdNameMatched: null,
    partnerId: null, receiveAccountId: null, industryId: null,
    sellFeeMilli: null, sellFeeAmount: null, partnerFeeMilli: null,
    refundAmount: null, investorReceiveAmount: null,
    feeSource: null, sellFeeSource: null, isWeekend: false,
    dealerRoomId: null, dealerRoomName: null,
    alreadySent: false, warnings: ['OCR không đọc được tên HKD (bill bị cắt chữ)'], blocked: false
  };
}

/** Sau khi CHỌN gợi ý: server khớp được mã QR → có phí + số hoàn. */
function qrItemMatched(): unknown {
  return {
    ...(qrItemNoHkd() as Record<string, unknown>),
    qr: { hkdName: 'HKD TRÀ MY NGUYỄN', amount: 29_998_000, ref: '6251VNIB024PKM8D', dateTime: '08/09/2026 08:58', fromCard: 'VIB Rewards ••0708' },
    tidId: 185, tidCode: '99MPC0017370400000', hkdNameMatched: 'HKD TRÀ MY NGUYỄN',
    sellFeeMilli: 1050, sellFeeAmount: 314_979, partnerFeeMilli: 850,
    refundAmount: 29_683_021, investorReceiveAmount: 29_998_000,
    feeSource: 'PARTNER', sellFeeSource: 'DEFAULT', warnings: []
  };
}

function suggestBody(): unknown {
  return {
    ok: true, exact: true, weak: false, refreshed: false,
    candidates: [
      { billId: '0C7FFC7A-FF0C-4254-9', qrCode: '99MPC0017370400000', hkdName: 'HKD TRÀ MY NGUYỄN', payerName: 'KHACH HANG 54', amount: 29_998_000, atMs: AT, externalRefNo: '6251VNIB024PKM8D', sourceTidId: 185, reconcileStatus: 'UNRECONCILED' }
    ]
  };
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
  let picked = false;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/chat-realtime|AppShell|real-time|hết hạn/.test(m.text())) console.log('CONSOLE-ERR:', m.text()); });
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
      const method = route.request().method();
      if (p.endsWith('/v1/ocr-send/ocr') && method === 'POST') return json(route, 200, { ok: true, token: 'tok-qr', kind: 'QR', qrReview: [qrItemNoHkd()], cached: false });
      if (p.endsWith('/v1/ocr-send/qr-review-dealer') && method === 'POST') return json(route, 200, { ok: true, item: picked ? qrItemMatched() : qrItemNoHkd() });
      if (p.endsWith('/v1/ocr-send/classify-options')) return json(route, 200, { dealers: DEALERS, investors: [{ id: 1, name: 'Anh Quốc' }] });
      if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: billBytes });
      if (p.endsWith('/v1/digistore/suggest-hkd') && method === 'POST') { picked = true; return json(route, 200, suggestBody()); }
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, 200, method === 'GET' && listLike ? [] : {});
    });

    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Quét QR', exact: true }).click();
    await page.waitForTimeout(400);
    const billDir = path.join(OUT, '_folder');
    await mkdir(billDir, { recursive: true });
    await writeFile(path.join(billDir, 'bill_1.jpg'), billBytes);
    await page.setInputFiles('[data-testid="qr-folder-input"]', billDir);
    await page.waitForTimeout(3500);

    // Thẻ TỰ tra báo-có khi thiếu tên HKD → TỰ ĐIỀN + băng "cần XÁC NHẬN" (không tự gửi).
    const bangTuDien = page.locator('[data-testid="qr-tudien"]:visible').first();
    await bangTuDien.waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(OUT, '1-tu-dien-cho-xac-nhan.png'), fullPage: true });
    console.log('  shot 1-tu-dien-cho-xac-nhan.png (đã tự điền HKD + người quẹt, chờ xác nhận)');

    // Chưa xác nhận → nút Gửi phải KHOÁ và nói rõ lý do.
    const nutGui = page.locator('[data-testid="qr-tab-panel"] button:has-text("Xác nhận thông tin TỰ ĐIỀN")').first();
    const khoaDung = await nutGui.count() > 0 && await nutGui.isDisabled();
    console.log(khoaDung ? '  ✅ Nút Gửi KHOÁ đúng: "Xác nhận thông tin TỰ ĐIỀN ở trên"' : '  ❌ Nút Gửi KHÔNG khoá khi chưa xác nhận');
    if (!khoaDung) process.exitCode = 1;

    await page.locator('[data-testid="qr-tudien-ack"]:visible').first().click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, '2-da-xac-nhan.png'), fullPage: true });
    console.log('  shot 2-da-xac-nhan.png (đã xác nhận → băng chuyển xanh)');

    // Khẳng định bằng SỐ (không chỉ ảnh): thẻ phải hiện HKD khớp + người quẹt + số tiền + số hoàn.
    const panel = page.locator('[data-testid="qr-tab-panel"]').first();
    // innerText KHÔNG chứa giá trị các ô nhập → gộp thêm value của mọi input (tên người quẹt được tự điền vào input).
    const vals = await panel.locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join(' | '));
    const txt = ((await panel.innerText()) + ' | ' + vals).replace(/\s+/g, ' ');
    const need = ['HKD TRÀ MY NGUYỄN', 'KHACH HANG 54', '29.998.000', '29.683.021'];
    const miss = need.filter((k) => !txt.includes(k));
    console.log(miss.length ? `  ❌ THIẾU trên thẻ: ${miss.join(' | ')}` : '  ✅ Thẻ có đủ: HKD khớp · người quẹt · số tiền · số hoàn');
    if (miss.length) process.exitCode = 1;
  } finally {
    await browser?.close();
    await server.close();
  }
}

void main();
