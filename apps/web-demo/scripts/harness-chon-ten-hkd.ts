// HARNESS R200 (Admin Demo 18/9) — "không ra tên hkd hoặc không ra số tid thì TID và TÊN HKD đều được gợi ý
// dropdown … đồng bộ tự động và thủ công, kiểm chứng phản biện, cấm báo cáo láo".
//
// Mô phỏng ĐÚNG ca kẹt: OCR mù CẢ TID lẫn tên HKD → server trả tidSuggestions = fallback toàn bộ máy
// (fix cùng ngày). Kiểm bằng ĐIỀU KHIỂN THẬT:
//   1. THỦ CÔNG: dropdown "Chọn tên HKD" hiện · chọn 1 TÊN → ô TID tự điền đúng → /reroute được gọi với TID đó
//      → server trả phòng/thẻ → nút Gửi MỞ KHOÁ (trước fix: kẹt câm vĩnh viễn).
//   2. Dropdown TID cũ vẫn hoạt động (chọn TID → cùng kết quả).
//   3. TỰ ĐỘNG: làm y hệt — 2 tab dùng chung BillReviewCard nhưng PHẢI chứng minh bằng thao tác, không suy luận.
import { build, preview } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-chon-ten-hkd');
const BILL_IMG = 'C:/Users/ADMINI~1/AppData/Local/Temp/claude/C--Users-Administrator/deced379-aec3-4e56-a36a-8b4722d79f70/scratchpad/bill-lo75.jpg';

// Server fallback: TOÀN BỘ danh sách máy (rút gọn 5 máy cho harness)
const SUGGESTIONS = [
  { tid: 'DEMO-TID-07', hkdName: 'HKD DEMO 45' },
  { tid: '53550080', hkdName: 'HKD DEMO 18' },
  { tid: 'DEMO-TID-08', hkdName: 'HKD DEMO 49' },
  { tid: '59930004', hkdName: 'HKD DEMO 50' },
  { tid: '67512805', hkdName: 'HKD DEMO 30' }
];

// Bill MÙ cả TID lẫn HKD — đúng ca Admin Demo gặp
const REVIEW_MU = [{
  bill: { tid: null, agencyName: null, batchNumber: '75', type: 'SETTLEMENT', totalAmount: 109_613_000, dateTime: '16/09/2026 19:12:03', voidCount: 0, voidAmount: 0 },
  dealerRoomId: null, dealerRoomName: null, investorRoomId: null, investorRoomName: null,
  sellFee: null, installFee: null, alreadySent: false,
  warnings: ['⚠ OCR không đọc được TID — OCR không đọc được TID và không có tên HKD'],
  dealerSummary: null, investorSummary: null, hkdName: null, bankName: null,
  availableCardTypes: [], tidSuggestions: SUGGESTIONS
}];

const rerouteCalls: string[] = [];

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  console.log('[harness] build...');
  await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error' });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), preview: { port: 0 } });
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:4173';
  const billBytes = await readFile(BILL_IMG);

  let browser: Browser | undefined;
  const ket: string[] = [];
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
    await page.addInitScript(`
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Tôi Test' }));
      window.WebSocket = function () { return { readyState: 0, addEventListener: function () {}, removeEventListener: function () {}, send: function () {}, close: function () {} }; };
    `);
    await page.routeWebSocket(/^ws/, () => { /* mở lửng */ });

    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const m = route.request().method();
      if (/\/v1\/ocr-send\/(ocr|ocr-file)$/.test(p) && m === 'POST') return json(route, 200, { ok: true, token: 'tok', review: REVIEW_MU, cached: false });
      if (p.endsWith('/v1/ocr-send/reroute') && m === 'POST') {
        const tid = String(JSON.parse(route.request().postData() ?? '{}').tid ?? '');
        rerouteCalls.push(tid);
        const sg = SUGGESTIONS.find((x) => x.tid === tid);
        return json(route, 200, { ok: true, tid, hkdName: sg?.hkdName ?? null, bankName: 'MB',
          dealerRoomId: 'r-dealer', dealerRoomName: `ĐL - ${sg?.hkdName ?? '?'}`, investorRoomId: null, investorRoomName: null,
          availableCardTypes: [{ id: 15, name: 'MB', bankId: 15, isPrimary: true }], defaultCardTypeId: 15 });
      }
      if (p.endsWith('/v1/ocr-send/fee') && m === 'POST') return json(route, 200, { ok: true, sell: { resolved: true, milli: 2200, amount: 2_411_486 }, install: { resolved: true, milli: 920, amount: 1_008_439 } });
      if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: billBytes });
      if (p.endsWith('/v1/ocr-send/scan') && m === 'POST') return json(route, 200, { ok: true, count: 1, newCount: 1, files: [{ path: 'C:/bills/b1.jpg', name: 'b1.jpg', mtime: 1, size: 1, alreadyOcr: false }] });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, 200, m === 'GET' && listLike ? [] : {});
    });

    // ============ CA 1 · THỦ CÔNG · chọn TÊN HKD ============
    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.setInputFiles('input[type=file]', BILL_IMG);
    await page.waitForTimeout(1500);

    const coDropdownTen = await page.locator('[data-testid="chon-ten-hkd"]').first().isVisible().catch(() => false);
    // option trong <select> Playwright coi là hidden → đếm select theo title (attach vào DOM là đủ)
    const coDropdownTid = (await page.locator('select[title*="Gợi ý TID"]').count()) > 0;
    ket.push(`[THỦ CÔNG] bill mù TID+HKD → dropdown TÊN hiện=${coDropdownTen} · dropdown TID hiện=${coDropdownTid}`);
    const guiTruoc = await page.getByRole('button', { name: /Gửi vào nhóm đại lý/ }).first().isDisabled().catch(() => true);
    ket.push(`[THỦ CÔNG] nút Gửi TRƯỚC khi chọn: khoá=${guiTruoc}`);
    await page.screenshot({ path: path.join(OUT, '1-mu-ca-hai.png'), fullPage: true });

    // CHỌN TÊN "HKD DEMO 49" trong dropdown TÊN
    await page.locator('[data-testid="chon-ten-hkd"]').first().selectOption('DEMO-TID-08');
    await page.waitForTimeout(1500);
    const oTid = await page.locator('[data-testid="o-tid"]').first().inputValue().catch(() => '?');
    ket.push(`[THỦ CÔNG] chọn tên "HKD DEMO 49" → ô TID = ${oTid} (kỳ vọng DEMO-TID-08) · reroute đã gọi với: [${rerouteCalls.join(',')}]`);
    const heroHkd = await page.locator('div:has(> span:text-is("HKD")) >> div').first().innerText().catch(() => '?');
    const guiSau = await page.getByRole('button', { name: /Gửi vào nhóm đại lý/ }).first().isDisabled().catch(() => true);
    ket.push(`[THỦ CÔNG] hero HKD sau chọn: "${heroHkd.split('\\n')[0]}" · nút Gửi khoá=${guiSau} (kỳ vọng false = MỞ)`);
    // Bill có cảnh báo ⚠ → PHẢI tick xác nhận (thiết kế 6/9 chống gửi vội) rồi nút Gửi mới mở
    await page.getByText('XÁC NHẬN gửi dù có cảnh báo', { exact: false }).locator('xpath=preceding-sibling::input[@type="checkbox"] | self::label//input[@type="checkbox"]').first().check().catch(async () => { await page.locator('input[type="checkbox"][class*="accent-danger"]').first().check().catch((e) => console.log('tick lỗi:', e.message)); });
    await page.waitForTimeout(600);
    const guiSauTick = await page.getByRole('button', { name: /Gửi vào nhóm đại lý/ }).first().isDisabled().catch(() => true);
    ket.push(`[THỦ CÔNG] sau TICK xác nhận cảnh báo: nút Gửi khoá=${guiSauTick} (kỳ vọng false = MỞ)`);
    await page.screenshot({ path: path.join(OUT, '2-da-chon-ten.png'), fullPage: true });

    // ============ CA 2 · TỰ ĐỘNG · làm y hệt ============
    await page.evaluate('sessionStorage.clear()').catch(() => {});
    rerouteCalls.length = 0;
    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.getByText('Tự động', { exact: false }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    const billDir = path.join(OUT, '_billfolder');
    await mkdir(billDir, { recursive: true });
    await writeFile(path.join(billDir, 'b1.jpg'), billBytes);
    await page.setInputFiles('input[webkitdirectory]', billDir).catch((e) => console.log('folder lỗi:', e.message));
    await page.waitForTimeout(3000);

    const coTenAuto = await page.locator('[data-testid="chon-ten-hkd"]').first().isVisible().catch(() => false);
    ket.push(`[TỰ ĐỘNG] dropdown TÊN hiện=${coTenAuto}`);
    await page.locator('[data-testid="chon-ten-hkd"]').first().selectOption('53550080');
    await page.waitForTimeout(1500);
    const oTidAuto = await page.locator('[data-testid="o-tid"]').first().inputValue().catch(() => '?');
    await page.locator('input[type="checkbox"][class*="accent-danger"]').first().check().catch(() => {});
    await page.waitForTimeout(600);
    const guiAuto = await page.getByRole('button', { name: /Gửi vào nhóm đại lý/ }).first().isDisabled().catch(() => true);
    ket.push(`[TỰ ĐỘNG] chọn "HKD DEMO 18" → ô TID = ${oTidAuto} (kỳ vọng 53550080) · reroute: [${rerouteCalls.join(',')}] · nút Gửi khoá=${guiAuto}`);
    await page.screenshot({ path: path.join(OUT, '3-tudong-da-chon.png'), fullPage: true });

    // ============ CA 3 · bill route THÀNH CÔNG nhưng tên mờ — dropdown ĐỐI CHIẾU vẫn hiện ============
    await page.evaluate('sessionStorage.clear()').catch(() => {});
    const REVIEW_OK = [{ ...REVIEW_MU[0],
      bill: { ...REVIEW_MU[0].bill, tid: '67512805', agencyName: null },
      dealerRoomId: 'r-dealer', dealerRoomName: 'ĐL - Nguyễn Duy Linh', hkdName: 'HKD DEMO 30', bankName: 'ABB',
      sellFee: { resolved: true, milli: 2200, amount: 2_411_486 }, installFee: { resolved: true, milli: 920, amount: 1_008_439 },
      warnings: [], availableCardTypes: [{ id: 21, name: 'ABB-JCB', bankId: 21, isPrimary: true }],
      tidSuggestions: SUGGESTIONS }];
    await page.route('**/v1/ocr-send/ocr', (route) => json(route, 200, { ok: true, token: 'tok', review: REVIEW_OK, cached: false }));
    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.setInputFiles('input[type=file]', BILL_IMG);
    await page.waitForTimeout(1500);
    const ddOk = await page.locator('[data-testid="chon-ten-hkd"]').first().isVisible().catch(() => false);
    const giaTri = await page.locator('[data-testid="chon-ten-hkd"]').first().inputValue().catch(() => '?');
    ket.push(`[ĐỐI CHIẾU] bill TID hợp lệ + tên mờ → dropdown hiện=${ddOk} · đang chọn=${giaTri} (kỳ vọng 67512805 = máy hiện tại)`);
    await page.locator('[data-testid="chon-ten-hkd"]').first().selectOption('DEMO-TID-07');
    await page.waitForTimeout(1200);
    const tidDoi = await page.locator('[data-testid="o-tid"]').first().inputValue().catch(() => '?');
    ket.push(`[ĐỐI CHIẾU] đổi sang "HKD DEMO 45" → ô TID = ${tidDoi} (kỳ vọng DEMO-TID-07) · reroute: [${rerouteCalls.join(',')}]`);
    await page.screenshot({ path: path.join(OUT, '4-doi-chieu-ten-mo.png'), fullPage: true });

    console.log('\n================ KẾT QUẢ ================');
    for (const d of ket) console.log(d);
    console.log('Ảnh ->', OUT);
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
