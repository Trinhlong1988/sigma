// HARNESS R200 (Admin Demo 10/9): "màn SỬA trong danh sách bill CK và danh sách bill POS vẫn phải có blog đối chiếu
// khi click vào ảnh". Mount THẲNG 2 modal sửa (qua trang thử harness-probe.html), bấm ảnh → phải mở màn phóng to
// KÈM khối đối chiếu; đo lại đúng 2 tiêu chí như harness-doi-chieu (nằm trọn màn + lùi vào ≥ 1/2 bề rộng khối).
// Chạy: node --import tsx scripts/harness-doi-chieu-man-sua.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Page, type Route } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-doi-chieu-man-sua');
const ANH_POS = path.join(ROOT, 'screenshots', 'harness-bug1', '_folder', 'bill_1.jpg');
const ANH_CK = path.resolve(ROOT, '../../apps/zalo-watcher/golden-transfer/mbbank-huy-daklak.jpg');
const VIEWPORT = { width: 1400, height: 1000 };

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function doKhoi(page: Page, ten: string, canCo: string[]): Promise<boolean> {
  const khoi = page.locator('[data-testid="khoi-doi-chieu"]');
  if ((await khoi.count()) === 0) { console.log(`  ❌ ${ten}: bấm ảnh KHÔNG ra khối đối chiếu`); return false; }
  const box = await khoi.first().boundingBox();
  if (!box) { console.log(`  ❌ ${ten}: không đo được khối`); return false; }
  // [Spec MỚI 11/9 — Admin Demo "màn này che mất bill"] Khối là CỘT RIÊNG bên phải: đo (a) nằm trọn màn,
  // (b) KHÔNG GIAO với ảnh bill (hết che). Bỏ thước "lùi 1/2 bề rộng" của spec cũ (khi khối còn absolute).
  const cachMepPhai = VIEWPORT.width - (box.x + box.width);
  const namTron = box.x >= 0 && box.x + box.width <= VIEWPORT.width;
  const boxAnh = await page.locator('.fixed.inset-0 img').first().boundingBox();
  const luiDuNua = !boxAnh || boxAnh.x + boxAnh.width <= box.x + 2; // ảnh kết thúc TRƯỚC khi khối bắt đầu = không che
  // Ô sửa-tại-chỗ là <input> — value KHÔNG nằm trong innerText → gộp thêm value của mọi input trong khối.
  const vals = await khoi.first().locator('input').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value).join(' | '));
  const txt = ((await khoi.first().innerText()) + ' | ' + vals).replace(/\s+/g, ' ');
  const thieu = canCo.filter((k) => !txt.includes(k));
  console.log(`  ${ten}: rộng ${Math.round(box.width)}px · cách mép phải ${Math.round(cachMepPhai)}px (cần ≥ ${Math.round(box.width / 2)}px)`);
  if (!namTron) console.log(`  ❌ ${ten}: khối TRÀN ra ngoài màn`);
  if (thieu.length) console.log(`  ❌ ${ten}: THIẾU số liệu: ${thieu.join(' | ')}`);
  const dat = namTron && luiDuNua && thieu.length === 0;
  if (dat) console.log(`  ✅ ${ten}: có khối đối chiếu cột phải, không che ảnh, đủ số liệu`);
  return dat;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const anhPos = await readFile(ANH_POS);
  const anhCk = await readFile(ANH_CK).catch(() => anhPos);
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  let anh = anhPos;
  try {
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: VIEWPORT })).newPage();
    page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE-ERR:', m.text().slice(0, 300)); });
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message.slice(0, 300)));
    await page.addInitScript({
      content: [
        "window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguyen Van A' }));",
        "window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify({ id: 22, code: 'DL22', name: 'Nguyen Van A', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' }));"
      ].join(String.fromCharCode(10))
    });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      if (/attachment|file|download/i.test(p)) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: anh });
      // Modal đọc "tôi là ai" (fetchAuthenticatedAgent) — trả shape THẬT, thiếu là modal ném lỗi trắng màn.
      if (/\/me\/auth|authenticate|\/me$/i.test(p)) return json(route, { agent: { id: 22, code: 'DL22', name: 'Nguoi Dung Demo' } });
      if (/card-options|cards/i.test(p)) return json(route, { bankId: 1, bankCode: 'MB', defaultCardTypeId: 20, detectedCardTypeId: 20, cards: [{ cardTypeId: 20, code: 'VISA', name: 'Visa', klass: 'INTERNATIONAL', phiBanMilli: 1400 }] });
      return json(route, {});
    });
    // Ảnh bill trong modal tải qua fetchAttachmentObjectUrl. CHẶN CHÍNH XÁC đường tải tệp — CẤM bắt rộng kiểu
    // /attachment/ vì vite phục vụ chính module `src/lib/attachment-blob.ts` qua URL có chữ "attachment": bắt trúng
    // là trả JPEG cho module script → trang trắng (đã dính đúng bẫy này khi viết harness).
    await page.route(/\/(attachments|files)\/|\.(jpg|jpeg|png)(\?|$)/i, (route) => route.fulfill({ status: 200, contentType: 'image/jpeg', body: anh }));

    page.on('requestfailed', (r) => console.log('REQ-FAIL:', r.url().slice(0, 120), r.failure()?.errorText));
    page.on('response', (r) => { if (/files|attachment/i.test(r.url())) console.log('RESP:', r.status(), r.url().slice(0, 120)); });

    let dat = true;
    // ── 1. Màn SỬA bill POS ────────────────────────────────────────────────────────────
    anh = anhPos;
    await page.goto(`${baseUrl}/harness-probe.html?man=pos`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, '1-sua-pos-truoc.png') });
    await page.locator('img[alt="Ảnh bill gốc"]').first().evaluate((el) => (el.closest('button') as HTMLButtonElement | null)?.click());
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, '2-sua-pos-doi-chieu.png') });
    dat = (await doKhoi(page, 'SỬA POS', ['HKD DEMO 5 2', '53590002', '19.998.000', '72'])) && dat;

    // ── 2. Màn SỬA bill hoàn tiền (CK) ─────────────────────────────────────────────────
    anh = anhCk;
    await page.goto(`${baseUrl}/harness-probe.html?man=ck`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, '3-sua-ck-truoc.png') });
    await page.locator('img[alt="Ảnh biên lai hoàn tiền"]').first().evaluate((el) => (el.closest('button') as HTMLButtonElement | null)?.click());
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, '4-sua-ck-doi-chieu.png') });
    dat = (await doKhoi(page, 'SỬA CK ', ['DLY HUY DAKLAK', 'KHACH HANG 01', '122.859.000', '0900000600'])) && dat;

    console.log(dat ? '\n✅ ĐẠT cả 2 màn sửa' : '\n❌ CHƯA đạt');
    if (!dat) process.exitCode = 1;
    console.log('[harness] Ảnh ->', OUT);
  } finally {
    await browser?.close();
    await server.close();
  }
}

void main();
