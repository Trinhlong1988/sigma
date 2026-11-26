// HARNESS R200 (Admin Demo 9/9): "log tải file sao kê lên bị dồn nhiều, cho gọn kiểu log cuộn khi có file mới" +
// "log hiện danh sách sao kê, TK ở tra soát, STK đó theo CHU KỲ NGÀY sao kê".
// Nạp 5 bản sao kê của 2 tài khoản (nhiều kỳ ngày) → khung log phải: GỌN (cuộn trong khung, không đẩy dài trang),
// GOM THEO STK, mỗi TK liệt kê từng bản theo KỲ NGÀY, và TỰ CUỘN xuống bản mới nhất.
// Chạy: node --import tsx scripts/harness-statement-file-log.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-statement-file-log');

/** 5 bản sao kê: TK DEMO-ACCT (MB) 3 kỳ · TK 42227 (ACB) 2 kỳ. */
const BAN = [
  { file: 'MB_28438888_0109.xlsx', acct: 'DEMO-ACCT', bank: 'MB', holder: 'KHACH HANG 01', ngay: '2026-09-01', n: 12 },
  { file: 'MB_28438888_0509.xlsx', acct: 'DEMO-ACCT', bank: 'MB', holder: 'KHACH HANG 01', ngay: '2026-09-05', n: 31 },
  { file: 'MB_28438888_0809.xlsx', acct: 'DEMO-ACCT', bank: 'MB', holder: 'KHACH HANG 01', ngay: '2026-09-08', n: 24 },
  { file: 'ACB_42227_0709.xlsx', acct: '42227', bank: 'ACB', holder: 'NGUYEN VAN A', ngay: '2026-09-07', n: 18 },
  { file: 'ACB_42227_0809.xlsx', acct: '42227', bank: 'ACB', holder: 'NGUYEN VAN A', ngay: '2026-09-08', n: 44 }
];

function txns(b: (typeof BAN)[number]): unknown[] {
  return Array.from({ length: b.n }, (_, i) => ({
    rowIndex: i + 1, dateTime: `${b.ngay}T${String(8 + (i % 9)).padStart(2, '0')}:${String(10 + (i % 45)).padStart(2, '0')}:00`,
    ref: `${b.bank}-${b.acct}-${b.ngay}-${i}`, debit: 1_000_000 + i * 1000, credit: 0,
    desc: 'CHUYEN KHOAN', cpName: 'NGUYEN VAN A', cpAccount: '999888777', cpBank: 'BIDV', descName: 'NGUYEN VAN A',
    direction: 'OUT', kind: 'DEALER_REFUND', matchedName: 'ĐL- Bảo SG', matchedCustomerId: 211, matchedInvestorId: null,
    matchType: 'account', edited: false, note: null, effectiveDate: b.ngay,
    srcAccount: b.acct, srcBank: b.bank, srcHolder: b.holder
  }));
}

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 950 } })).newPage();
    page.on('pageerror', (e) => console.log('PAGE-ERROR:', e.message));
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguoi Dung Demo', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* */ });
    let luot = 0;
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p.endsWith('/v1/statement-recon/cached')) return json(route, { txns: [] });
      if (p.endsWith('/v1/statement-recon/upload')) {
        const b = BAN[Math.min(luot++, BAN.length - 1)];
        return json(route, { ok: true, data: { accountHolder: b.holder, accountNumber: b.acct, accountBank: b.bank, txns: txns(b), byDay: [], byDealer: [], totals: { hoanDaiLy: 0, hoanLaiDaiLy: 0, hoanUngNDT: 0, tamUngNDT: 0, unmatchedOut: 0, unmatchedIn: 0 }, warnings: [] } });
      }
      if (p.endsWith('/v1/ocr-send/classify-options')) return json(route, { dealers: [{ roomId: 'r1', name: 'ĐL- Bảo SG' }], investors: [] });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });

    await page.goto(`${baseUrl}/app/statement-recon`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);

    // Nạp lần lượt 5 file (mỗi lần 1 file để thấy log dài dần + tự cuộn).
    const dir = path.join(OUT, '_files');
    await mkdir(dir, { recursive: true });
    for (const b of BAN) {
      const fp = path.join(dir, b.file);
      await writeFile(fp, Buffer.from('PK-fake-xlsx'));
      await page.setInputFiles('input[accept=".xlsx,.xls"]', fp);
      await page.waitForTimeout(600);
    }
    await page.waitForTimeout(800);

    // [9/9] Bấm nút → PHẢI hiện HỘP THOẠI trong app (trước dùng prompt của trình duyệt → Electron im lặng).
    const coNutTuDong = await page.locator('button:has-text("Lấy sao kê tự động")').count();
    await page.locator('button:has-text("Lấy sao kê tự động")').first().click();
    await page.waitForTimeout(400);
    const hop = page.locator('[data-testid="hop-lay-tu-dong"]');
    const coHop = await hop.count();
    const soTkMacDinh = coHop ? await hop.locator('input').inputValue() : '(không có hộp thoại)';
    await page.screenshot({ path: path.join(OUT, '3-hop-lay-tu-dong.png'), fullPage: false });
    console.log(`  nút "Lấy sao kê tự động": ${coNutTuDong} · bấm ra hộp thoại: ${coHop} · số TK mặc định: ${soTkMacDinh}`);
    await page.keyboard.press('Escape').catch(() => undefined);
    await page.locator('button:has-text("Hủy")').first().click().catch(() => undefined);
    await page.waitForTimeout(300);
    const khung = page.locator('[data-testid="stmt-files"]').first();
    await khung.waitFor({ timeout: 10000 });
    await page.screenshot({ path: path.join(OUT, '1-log-sao-ke-gon.png'), fullPage: false });
    console.log('  shot 1-log-sao-ke-gon.png');

    // ĐO SỐ: khung có cuộn thật (scrollHeight > clientHeight), đã cuộn xuống đáy, và gom đúng 2 tài khoản.
    const box = khung.locator('div.overflow-y-auto').first();
    const so = await box.evaluate((el) => ({ sh: el.scrollHeight, ch: el.clientHeight, top: Math.round(el.scrollTop) }));
    const txt = (await khung.innerText()).replace(/\s+/g, ' ');
    // GỌN = khung có TRẦN chiều cao (không đẩy dài trang); CUỘN chỉ khi nội dung vượt trần; luôn ở ĐÁY (bản mới nhất).
    const tran = await box.evaluate((el) => parseInt(getComputedStyle(el).maxHeight, 10) || 0);
    const goiGon = tran > 0 && tran <= 220 && so.ch <= tran + 1;
    const oDay = so.sh <= so.ch + 4 || so.top + so.ch >= so.sh - 6;
    const low = txt.toLowerCase();
    const can = ['file đã nạp (5)', 'DEMO-ACCT', '42227', 'mb', 'acb', '01/09', '05/09', '08/09', '07/09', '3 sao kê', '2 sao kê'];
    const thieu = can.filter((k) => !low.includes(k));
    console.log(`  khung log: trần ${tran}px · cao ${so.ch}px · nội dung ${so.sh}px · gọn trong trần: ${goiGon} · ở đáy (bản mới nhất): ${oDay}`);
    console.log('  nội dung:', txt.slice(0, 220));
    console.log(thieu.length ? `  ❌ THIẾU: ${thieu.join(' | ')}` : '  ✅ Gom theo STK + đủ kỳ ngày từng bản sao kê');

    // [Admin Demo 9/9] KHOÁ TÍNH NĂNG: tài khoản KHÔNG phải chủ SigMa mở thẳng URL → phải thấy chặn, không thấy dữ liệu.
    const p2 = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
    await p2.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-dl', agentName: 'Đại lý thường' }));
      window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 99, code: 'DL99', name: 'Đại lý thường', rcUserId: 'u-dl', rcUsername: 'dl99' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await p2.routeWebSocket(/^ws/, () => { /* */ });
    await p2.route('**/v1/**', async (route) => {
      const pth = new URL(route.request().url()).pathname;
      if (pth.endsWith('/v1/statement-recon/cached')) return json(route, { txns: [] });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(pth);
      return json(route, route.request().method() === 'GET' && listLike ? [] : {});
    });
    await p2.goto(`${baseUrl}/app/statement-recon`, { waitUntil: 'networkidle' });
    await p2.waitForTimeout(800);
    const bịChan = await p2.locator('[data-testid="stmt-forbidden"]').count();
    const thayNut = await p2.locator('button:has-text("Lấy sao kê tự động")').count();
    await p2.screenshot({ path: path.join(OUT, '2-nguoi-thuong-bi-chan.png'), fullPage: false });
    console.log(`  [khoá] đại lý thường: thấy chặn=${bịChan} · thấy nút lấy sao kê=${thayNut} (mong đợi 1 và 0)`);

    if (thieu.length || !goiGon || !oDay || bịChan !== 1 || thayNut !== 0 || coHop !== 1 || soTkMacDinh !== 'DEMO-ACCT') process.exitCode = 1;
  } finally {
    await browser?.close();
    await server.close();
  }
}

void main();
