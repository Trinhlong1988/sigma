// HARNESS R200 (Admin Demo 17/9) — "sao không hiện trường điền số tiền hủy của 1 lô ở màn review ocr?" +
// "làm phải đồng nhất thủ công và tự động".
//
// KIỂM CHỨNG BẰNG ĐIỀU KHIỂN THẬT (không ảnh tĩnh, không suy luận):
//   1. Bill KHÔNG có hủy (OCR đọc voidAmount=0) → ô "Tiền hủy" VẪN hiện (trước đây khối hủy bị ẩn hoàn toàn).
//   2. GÕ số vào ô hủy → "Ghi nhận doanh số" đổi LIVE = tổng quẹt − hủy; ô "Sau phí" cũng đổi theo.
//   3. Bấm Gửi → payload /v1/ocr-send/send mang voidAmount/voidCount ĐÚNG số vừa gõ (không phải số OCR gốc).
//   4. Làm Y HỆT ở tab TỰ ĐỘNG → 2 tab ra cùng kết quả (đồng nhất).
//   5. Bill CÓ hủy sẵn (OCR đọc 11.000 — ca thật ABB lô 75) → ô nhập khởi tạo đúng số OCR.
import { build, preview } from 'vite';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-o-nhap-tien-huy');
const BILL_IMG = 'C:/Users/ADMINI~1/AppData/Local/Temp/claude/C--Users-Administrator/deced379-aec3-4e56-a36a-8b4722d79f70/scratchpad/bill-lo75.jpg';

const TONG_QUET = 109_613_000; // ca thật ABB lô 75 (Nguyễn Duy Linh M2)
const HUY_THAT = 11_000;

function review(voidAmount: number, voidCount: number) {
  return [{
    bill: {
      tid: '67512805', agencyName: 'HKD DEMO 30', batchNumber: '75', type: 'SETTLEMENT',
      totalAmount: TONG_QUET, dateTime: '16/09/2026 19:12:03', voidCount, voidAmount
    },
    dealerRoomId: 'r-dealer', dealerRoomName: 'ĐL - Nguyễn Duy Linh',
    investorRoomId: 'r-investor', investorRoomName: 'Trung Cẩm Phả',
    sellFee: { resolved: true, milli: 2200, amount: 2_411_486 },
    installFee: { resolved: true, milli: 920, amount: 1_008_439 },
    alreadySent: false, warnings: [], dealerSummary: '', investorSummary: '',
    hkdName: 'HKD DEMO 30', bankName: 'ABB',
    availableCardTypes: [{ id: 21, name: 'ABB-JCB', bankId: 21, isPrimary: true }]
  }];
}

const sendPayloads: { voidAmount: unknown; voidCount: unknown; amount: unknown }[] = [];

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

/** Đọc số trong ô/khối theo testid (bỏ mọi ký tự không phải chữ số). */
async function so(page: Page, testid: string, attr: 'value' | 'text' = 'text'): Promise<number> {
  const el = page.locator(`[data-testid="${testid}"]`).first();
  const raw = attr === 'value' ? await el.inputValue().catch(() => '') : await el.innerText().catch(() => '');
  return Number(String(raw).replace(/[^\d]/g, '')) || 0;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  let voidCuaOcr = 0; // đổi giữa các ca để mock trả bill có/không có hủy
  console.log('[harness] build...');
  await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error' });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), preview: { port: 0 } });
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:4173';
  const billBytes = await readFile(BILL_IMG);

  let browser: Browser | undefined;
  const ket: string[] = [];
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
    // addInitScript dạng CHUỖI: truyền hàm TS thì esbuild chèn helper __name vào ⇒ trang báo "__name is not defined".
    await page.addInitScript(`
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Tôi Test' }));
      window.WebSocket = function () { return { readyState: 0, addEventListener: function () {}, removeEventListener: function () {}, send: function () {}, close: function () {} }; };
    `);
    await page.routeWebSocket(/^ws/, () => { /* để mở lửng */ });

    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const m = route.request().method();
      if (/\/v1\/ocr-send\/(ocr|ocr-file)$/.test(p) && m === 'POST') return json(route, 200, { ok: true, token: 'tok', review: review(voidCuaOcr, voidCuaOcr > 0 ? 1 : 0), cached: false });
      if (p.endsWith('/v1/ocr-send/fee') && m === 'POST') {
        // Phí tính trên SỐ GỬI LÊN (tienGhi) — để kiểm ô "Sau phí" đổi theo ô hủy.
        let base = TONG_QUET;
        try { base = Number(JSON.parse(route.request().postData() ?? '{}').amount) || TONG_QUET; } catch { /* */ }
        return json(route, 200, { ok: true, sell: { resolved: true, milli: 2200, amount: Math.round(base * 0.022) }, install: { resolved: true, milli: 920, amount: Math.round(base * 0.0092) } });
      }
      if (p.endsWith('/v1/ocr-send/send') && m === 'POST') {
        // voidAmount/voidCount nằm TRONG payload.bill (OcrBill), không ở cấp gốc.
        try { const b = JSON.parse(route.request().postData() ?? '{}'); sendPayloads.push({ voidAmount: b.bill?.voidAmount, voidCount: b.bill?.voidCount, amount: b.bill?.totalAmount }); } catch { /* */ }
        return json(route, 200, { ok: true, duplicate: false, dealerMessageId: 'm1', revenue: { ok: true, loId: 75 } });
      }
      if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: billBytes });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, 200, m === 'GET' && listLike ? [] : {});
    });

    // ================= CA 1 · TAB THỦ CÔNG · bill OCR KHÔNG đọc ra hủy =================
    voidCuaOcr = 0;
    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);
    await page.setInputFiles('input[type=file]', BILL_IMG);
    await page.waitForTimeout(1500);

    const oHienKhiKhongHuy = await page.locator('[data-testid="o-tien-huy"]').isVisible().catch(() => false);
    ket.push(`[THỦ CÔNG] bill OCR không đọc ra hủy → ô "Tiền hủy" hiện = ${oHienKhiKhongHuy}`);
    await page.screenshot({ path: path.join(OUT, '1-thucong-o-huy-rong.png'), fullPage: true });

    const ghiTruoc = await so(page, 'tien-ghi-nhan');
    // GÕ THẬT vào ô hủy (không fill trực tiếp state — gõ như người dùng)
    await page.locator('[data-testid="o-tien-huy"]').first().click();
    await page.keyboard.type('11000', { delay: 40 });
    await page.waitForTimeout(1200);
    const huyDoc = await so(page, 'o-tien-huy', 'value');
    const ghiSau = await so(page, 'tien-ghi-nhan');
    ket.push(`[THỦ CÔNG] gõ 11.000 → ô hủy đọc lại ${huyDoc.toLocaleString('vi-VN')} · ghi nhận ${ghiTruoc.toLocaleString('vi-VN')} → ${ghiSau.toLocaleString('vi-VN')} (kỳ vọng ${(TONG_QUET - HUY_THAT).toLocaleString('vi-VN')})`);
    await page.locator('[data-testid="o-so-gd-huy"]').fill('1');
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, '2-thucong-da-nhap-huy.png'), fullPage: true });
    await page.locator('[data-testid="khoi-huy-gd"]').screenshot({ path: path.join(OUT, '2b-khoi-huy-zoom.png') }).catch(() => {});

    await page.getByRole('button', { name: /Gửi vào nhóm đại lý/ }).first().click().catch((e) => console.log('click Gửi lỗi:', e.message));
    await page.waitForTimeout(1800);
    ket.push(`[THỦ CÔNG] payload /send = ${JSON.stringify(sendPayloads[sendPayloads.length - 1] ?? null)}`);

    // ================= CA 2 · TAB TỰ ĐỘNG · làm y hệt =================
    const truocAuto = sendPayloads.length;
    await page.evaluate('sessionStorage.clear()').catch(() => {}); // bỏ thẻ thủ công cũ, tránh 2 thẻ cùng lúc
    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await page.getByText('Tự động', { exact: false }).first().click().catch(() => {});
    await page.waitForTimeout(500);
    const billDir = path.join(OUT, '_billfolder');
    await mkdir(billDir, { recursive: true });
    await writeFile(path.join(billDir, 'bill_auto_1.jpg'), billBytes);
    await page.setInputFiles('input[webkitdirectory]', billDir).catch((e) => console.log('setInputFiles folder lỗi:', e.message));
    await page.waitForTimeout(3500);

    const soThe = await page.locator('[data-testid="o-tien-huy"]').count();
    ket.push(`[TỰ ĐỘNG] số thẻ review đang mở = ${soThe} (phải 1 để thao tác không nhập nhằng)`);
    const oHienAuto = await page.locator('[data-testid="o-tien-huy"]').first().isVisible().catch(() => false);
    ket.push(`[TỰ ĐỘNG] ô "Tiền hủy" hiện = ${oHienAuto}`);
    await page.locator('[data-testid="o-tien-huy"]').first().click();
    await page.keyboard.type('11000', { delay: 40 });
    await page.waitForTimeout(1200);
    const ghiAuto = await so(page, 'tien-ghi-nhan');
    ket.push(`[TỰ ĐỘNG] gõ 11.000 → ghi nhận ${ghiAuto.toLocaleString('vi-VN')} (kỳ vọng ${(TONG_QUET - HUY_THAT).toLocaleString('vi-VN')})`);
    await page.screenshot({ path: path.join(OUT, '3-tudong-da-nhap-huy.png'), fullPage: true });
    // CHỨNG MINH SỐ KHÔNG BỊ CẮT ở cột hẹp: so bề rộng nội dung thật (scrollWidth) với bề rộng ô (clientWidth).
    const catChu = await page.evaluate(`(() => {
      const ids = ['o-so-tien','o-tien-huy','o-so-gd-huy','tien-ghi-nhan'];
      const r = ids.map((id) => { const e = document.querySelector('[data-testid="'+id+'"]'); return e ? id+': '+e.scrollWidth+'/'+e.clientWidth+(e.scrollWidth > e.clientWidth + 1 ? ' CẮT' : ' ok') : id+': (không thấy)'; });
      // ô NGÀY (không có testid): tìm input placeholder dd/mm/yyyy — cắt năm là ghi sai ngày doanh số.
      const d = document.querySelector('input[placeholder="dd/mm/yyyy"]');
      if (d) r.push('o-ngay: '+d.scrollWidth+'/'+d.clientWidth+(d.scrollWidth > d.clientWidth + 1 ? ' CẮT' : ' ok')+' · value='+d.value);
      // BẢNG PHÍ ở cột hẹp: các số từng ĐÈ CHỒNG nhau. Đo mọi ô số trong bảng — không ô nào được tràn khỏi ô của nó.
      const cells = Array.from(document.querySelectorAll('.tabular-nums'));
      const tran = cells.filter((c) => c.scrollWidth > c.clientWidth + 1).length;
      r.push('ô số tràn (toàn thẻ) = ' + tran + '/' + cells.length + (tran ? ' → ' + cells.filter((c) => c.scrollWidth > c.clientWidth + 1).map((c) => '"' + (c.textContent || '').trim().slice(0, 18) + '" ' + c.scrollWidth + '/' + c.clientWidth).join(' | ') : ''));
      return r.join(' · ');
    })()`);
    ket.push(`[TỰ ĐỘNG] đo cắt chữ (scrollWidth/clientWidth) → ${catChu}`);
    await page.locator('[data-testid="khoi-huy-gd"]').first().screenshot({ path: path.join(OUT, '3b-tudong-khoi-huy-zoom.png') }).catch(() => {});
    await page.getByRole('button', { name: /Gửi vào nhóm đại lý/ }).first().click().catch((e) => console.log('click Gửi auto lỗi:', e.message));
    await page.waitForTimeout(1800);
    const pAuto = sendPayloads[sendPayloads.length - 1] ?? null;
    ket.push(`[TỰ ĐỘNG] payload /send = ${JSON.stringify(pAuto)} (có payload mới = ${sendPayloads.length > truocAuto})`);

    // ================= CA 3 · OCR ĐỌC SẴN 11.000 → ô khởi tạo đúng =================
    voidCuaOcr = HUY_THAT;
    await page.evaluate('sessionStorage.clear()').catch(() => {});
    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await page.setInputFiles('input[type=file]', BILL_IMG);
    await page.waitForTimeout(1800);
    const initHuy = await so(page, 'o-tien-huy', 'value');
    const initGhi = await so(page, 'tien-ghi-nhan');
    ket.push(`[OCR CÓ HỦY] ô khởi tạo = ${initHuy.toLocaleString('vi-VN')} · ghi nhận = ${initGhi.toLocaleString('vi-VN')}`);
    await page.screenshot({ path: path.join(OUT, '4-ocr-doc-san-huy.png'), fullPage: true });

    console.log('\n================ KẾT QUẢ ================');
    for (const d of ket) console.log(d);
    console.log('Ảnh ->', OUT);
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
