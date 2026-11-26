// HARNESS R200 (Admin Demo 10/9 — "bill này ko OCR ra ở QR là sao? tự check trong báo có trùng khớp là được chứ?"):
// ẢNH THẬT = email VIB "Thông báo giao dịch VIB One Card" Admin Demo gửi (10.500.000đ · 12:59 10/09/2026 ·
// KHACH HANG 15). Ảnh này KHÔNG in tên HKD, KHÔNG in Số giao dịch → luồng phải: nhận ảnh → nói rõ là THÔNG BÁO
// GIAO DỊCH THẺ → tra BÁO-CÓ theo tiền + giờ + tên chủ thẻ → khớp DUY NHẤT thì tự điền HKD + Số GD → CHỜ TICK xác
// nhận mới cho gửi. Số liệu mock = số THẬT lấy từ DB (bảng digistore_baoco) và từ OCR thật (xem _verify-card-notice).
// Chạy: node --import tsx scripts/harness-card-notice.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-card-notice');
/** ẢNH THẬT Admin Demo gửi (email VIB). Không có ảnh → dùng ảnh bill cũ (harness vẫn chạy được, chỉ khác hình). */
const ANH_THAT = '<REPO>\\Desktop\\9.9\\1789044182527_5800321779367504108_5800321779367504108_ddb9bc459bb7de0abe9456a5fce25739.jpg';
const ANH_DU_PHONG = path.join(ROOT, 'screenshots', 'harness-bug1', '_folder', 'bill_1.jpg');
const DEALERS = [{ roomId: 'r-nguyen-sg', name: 'ĐL- Nguyễn SG' }, { roomId: 'r-bao-sg', name: 'ĐL- Bảo SG' }];
const AT_BAOCO = Date.UTC(2026, 8, 10, 13 - 7, 0, 14); // 13:00:14 giờ HCM 10/9 (dòng báo-có THẬT)
const TIEN = 10_500_000;
const SO_GD = '6253VNIB02UBWFJP';

/** Kết quả OCR THẬT của ảnh (đã chạy qua dịch vụ OCR 10/9): không tên HKD, không số GD, có tên chủ thẻ. */
function itemThongBaoThe(): unknown {
  return {
    qr: { hkdName: null, amount: TIEN, ref: null, dateTime: '10/09/2026 12:59', fromCard: 'VIB ••••9742', payerName: 'KHACH HANG 15', noticeMerchant: 'VIB QR PUSH' },
    noticeOnly: true,
    tidId: null, tidCode: null, hkdNameMatched: null,
    partnerId: null, receiveAccountId: null, industryId: null,
    sellFeeMilli: null, sellFeeAmount: null, partnerFeeMilli: null,
    refundAmount: null, investorReceiveAmount: null,
    feeSource: null, sellFeeSource: null, isWeekend: false,
    dealerRoomId: null, dealerRoomName: null,
    alreadySent: false, blocked: true,
    warnings: [
      'ℹ Ảnh là THÔNG BÁO GIAO DỊCH THẺ (ngân hàng gửi chủ thẻ) — không in tên HKD/Số giao dịch. Bấm "Tra báo có" để khớp mã QR + Số giao dịch theo số tiền + giờ + tên chủ thẻ, rồi XÁC NHẬN trước khi gửi.',
      '⚠ Chưa có Số giao dịch — lấy từ báo-có khớp (bấm "Tra báo có"). CHƯA có thì KHÔNG gửi được (chống ghi doanh số x2).'
    ]
  };
}

/** Sau khi nhận HKD + Số GD từ báo-có: server khớp mã QR → có phí + số hoàn (giá 1.05% / mua 0.85% như mã TRÀ MY). */
function itemDaKhop(): unknown {
  return {
    ...(itemThongBaoThe() as Record<string, unknown>),
    qr: { hkdName: 'HKD TRÀ MY NGUYỄN', amount: TIEN, ref: SO_GD, dateTime: '10/09/2026 12:59', fromCard: 'VIB ••••9742', payerName: 'KHACH HANG 15', noticeMerchant: 'VIB QR PUSH' },
    tidId: 185, tidCode: '99MPC0017370400000', hkdNameMatched: 'HKD TRÀ MY NGUYỄN',
    sellFeeMilli: 1050, sellFeeAmount: 110_250, partnerFeeMilli: 850,
    refundAmount: 10_389_750, investorReceiveAmount: 10_410_750,
    feeSource: 'PARTNER', sellFeeSource: 'DEFAULT', blocked: false, warnings: []
  };
}

/** Dòng báo-có THẬT trong DB (digistore_baoco) — khớp duy nhất theo tiền + giờ + tên người quẹt. */
function suggestBody(): unknown {
  return {
    ok: true, exact: false, weak: false, refreshed: false,
    candidates: [
      { billId: '6187F84D-543A-429B-B', qrCode: '99MPC0017370400000', hkdName: 'HKD TRÀ MY NGUYỄN', payerName: 'KHACH HANG 15', amount: TIEN, atMs: AT_BAOCO, externalRefNo: SO_GD, sourceTidId: 185, reconcileStatus: 'UNRECONCILED' }
    ]
  };
}

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const anh = await readFile(ANH_THAT).catch(() => readFile(ANH_DU_PHONG));
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  let daTra = false;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error' && !/chat-realtime|AppShell|real-time|hết hạn/.test(m.text())) console.log('CONSOLE-ERR:', m.text()); });
    await page.addInitScript({
      content: [
        "window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguyen Van A' }));",
        "window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguyen Van A', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));",
        'function FakeWS(){ this.readyState = 0; }',
        'FakeWS.prototype.addEventListener = function(){};',
        'FakeWS.prototype.removeEventListener = function(){};',
        'FakeWS.prototype.send = function(){};',
        'FakeWS.prototype.close = function(){};',
        'window.WebSocket = FakeWS;'
      ].join(String.fromCharCode(10))
    });
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (p.endsWith('/v1/ocr-send/ocr') && method === 'POST') return json(route, 200, { ok: true, token: 'tok-note', kind: 'QR', qrReview: [itemThongBaoThe()], cached: false });
      if (p.endsWith('/v1/ocr-send/qr-review-dealer') && method === 'POST') return json(route, 200, { ok: true, item: daTra ? itemDaKhop() : itemThongBaoThe() });
      if (p.endsWith('/v1/ocr-send/classify-options')) return json(route, 200, { dealers: DEALERS, investors: [{ id: 1, name: 'Anh Quốc' }] });
      if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: anh });
      if (p.endsWith('/v1/digistore/suggest-hkd') && method === 'POST') {
        // KHẲNG ĐỊNH: client PHẢI gửi kèm tên chủ thẻ để server thu hẹp ứng viên theo người quẹt.
        const body = route.request().postDataJSON() as { payerName?: string | null; amount?: number };
        if (body?.payerName !== 'KHACH HANG 15') { console.log(`  ❌ suggest-hkd THIẾU tên chủ thẻ (nhận: ${String(body?.payerName)})`); process.exitCode = 1; }
        daTra = true;
        return json(route, 200, suggestBody());
      }
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, 200, method === 'GET' && listLike ? [] : {});
    });

    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Quét QR', exact: true }).click();
    await page.waitForTimeout(400);
    const thuMuc = path.join(OUT, '_folder');
    await mkdir(thuMuc, { recursive: true });
    await writeFile(path.join(thuMuc, 'thong-bao-the.jpg'), anh);
    await page.setInputFiles('[data-testid="qr-folder-input"]', thuMuc);
    await page.waitForTimeout(3500);

    // 1. Thẻ phải TỰ tra báo-có (thiếu HKD) → tự điền + băng chờ XÁC NHẬN.
    const bangTuDien = page.locator('[data-testid="qr-tudien"]:visible').first();
    await bangTuDien.waitFor({ timeout: 12000 });
    await page.screenshot({ path: path.join(OUT, '1-thong-bao-the-tu-dien.png'), fullPage: true });

    const panel = page.locator('[data-testid="qr-tab-panel"]').first();
    const docThe = async (): Promise<string> => {
      const vals = await panel.locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join(' | '));
      return ((await panel.innerText()) + ' | ' + vals).replace(/\s+/g, ' ');
    };
    const txt1 = await docThe();
    const can1 = ['THÔNG BÁO GIAO DỊCH THẺ', 'HKD TRÀ MY NGUYỄN', SO_GD, 'KHACH HANG 15', '10.500.000'];
    const thieu1 = can1.filter((k) => !txt1.includes(k));
    console.log(thieu1.length ? `  ❌ THIẾU trên thẻ: ${thieu1.join(' | ')}` : '  ✅ Thẻ nói rõ "THÔNG BÁO GIAO DỊCH THẺ" + đã nhận HKD/Số GD/người quẹt/số tiền từ báo-có');
    if (thieu1.length) process.exitCode = 1;

    // 2. CHƯA tick xác nhận ⇒ nút Gửi phải KHOÁ (money-gate).
    const nutGui = panel.locator('button:has-text("Xác nhận thông tin TỰ ĐIỀN")').first();
    const khoaDung = (await nutGui.count()) > 0 && (await nutGui.isDisabled());
    console.log(khoaDung ? '  ✅ Chưa xác nhận → nút Gửi KHOÁ' : '  ❌ Nút Gửi KHÔNG khoá khi chưa xác nhận');
    if (!khoaDung) process.exitCode = 1;

    // 3. Tick xác nhận → băng chuyển xanh, mở đường gửi.
    await page.locator('[data-testid="qr-tudien-ack"]:visible').first().click();
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, '2-da-xac-nhan.png'), fullPage: true });
    const txt2 = await docThe();
    const xanh = txt2.includes('Đã xác nhận thông tin tự điền');
    console.log(xanh ? '  ✅ Sau tick: băng chuyển "Đã xác nhận thông tin tự điền"' : '  ❌ Tick xong băng không đổi trạng thái');
    if (!xanh) process.exitCode = 1;
    console.log('[harness] Ảnh ->', OUT);
  } finally {
    await browser?.close();
    await server.close();
  }
}

void main();
