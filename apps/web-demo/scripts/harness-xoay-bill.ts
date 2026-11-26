// HARNESS R200 (Admin Demo 10/9): "màn review bill lúc OCR cần nút xoay 90° trái/phải để xử lý bill chụp ngang".
// Mở ĐÚNG thẻ review OCR (qua Báo cáo lô → Sửa, cùng đường như harness-edit-card-fee) với 1 ảnh NẰM NGANG,
// bấm "xoay phải" rồi chụp — LEAD tự nhìn ảnh xem bill có dựng đứng lên không.
// Chạy: node --import tsx scripts/harness-xoay-bill.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-xoay-bill');
/** Ảnh NẰM NGANG dùng làm "bill chụp ngang" (một ảnh chụp màn hình cũ — rộng hơn cao). */
const ANH_NGANG = path.join(ROOT, 'screenshots', 'harness-statement-file-log', '1-log-sao-ke-gon.png');
const ROOM = 'room-demo';

const TIDS = [{ tidId: 1, tid: '67512202', hkdName: 'HKD DEMO 27', bankName: 'ABB', linkedAt: '', linkedBy: null }];
const ROWS = [{ loId: 504, tidId: 1, date: '2026-09-10', effDateIso: '2026-09-10T03:00:00.000Z', bankReportedLoNumber: null, billLoNumber: '12', investorNickname: null, gross: 10000000, fee: 140000, net: 9860000 }];
const REPORT = { from: '2026-09-01', to: '2026-09-11', tids: TIDS, totalGross: 10000000, totalFee: 140000, totalNet: 9860000, loCount: 1, daily: [], rows: ROWS };

function reviewItem(): unknown {
  return {
    bill: { tid: '67512202', agencyName: 'HKD DEMO 27', batchNumber: '12', type: 'SALE', totalAmount: 10000000, dateTime: '10/09/2026 10:00', settlementCode: null },
    dealerRoomId: 'r-abb', dealerRoomName: 'ĐL- Duy Linh', investorRoomId: null, investorRoomName: null,
    sellFee: { resolved: true, milli: 1400, amount: 140000, source: 'RATE' },
    installFee: { resolved: true, milli: 100, amount: 10000, source: 'RATE' },
    alreadySent: true, sentMessageId: 'msg-cu', warnings: [], dealerSummary: null, investorSummary: null,
    availableCardTypes: [{ id: 20, name: 'Visa', bankId: 19, isPrimary: true }],
    currentCardTypeId: 20, currentSplits: null,
    hkdName: 'HKD DEMO 27', bankName: 'ABB', tidSuggestions: []
  };
}

async function json(route: Route, body: unknown): Promise<void> {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const anh = await readFile(ANH_NGANG);
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1400, height: 1000 } })).newPage();
    page.on('pageerror', (e) => console.log('PAGE-ERROR:', e.message));
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
      if (/\/revenue$/.test(p)) return json(route, { ok: true, data: REPORT });
      if (/\/lo\/\d+\/edit-source$/.test(p)) return json(route, { ok: true, data: { messageId: 'msg-cu', current: { amount: 10000000, lo: '12', tid: '67512202', dateTime: '10/09/2026 10:00', hkdName: 'HKD DEMO 27', bank: 'ABB' } } });
      if (p.endsWith('/v1/ocr-send/prepare-edit')) return json(route, { ok: true, token: 'tok', review: [reviewItem()], kind: 'POS', editMessageId: 'msg-cu' });
      if (p.endsWith('/v1/ocr-send/fee')) return json(route, { sell: { resolved: true, milli: 1400, amount: 140000, source: 'RATE' }, install: { resolved: true, milli: 100, amount: 10000, source: 'RATE' } });
      if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/png', body: anh });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, method === 'GET' && listLike ? [] : {});
    });

    await page.goto(`${baseUrl}/app/chat/${ROOM}/revenue`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1200);
    await page.locator('button:has-text("Sửa")').first().click();
    await page.waitForTimeout(400);
    await page.locator('input[type="password"]').fill('1111');
    await page.locator('button:has-text("Mở sửa")').click();
    await page.waitForTimeout(1800);

    const anhBill = page.locator('img[alt="bill"]').first();
    const truoc = await anhBill.evaluate((el) => getComputedStyle(el).transform);
    await page.screenshot({ path: path.join(OUT, '1-bill-nam-ngang.png'), fullPage: false });

    const nutPhai = page.locator('[data-testid="xoay-phai"]').first();
    const nutTrai = page.locator('[data-testid="xoay-trai"]').first();
    const coNut = (await nutPhai.count()) + (await nutTrai.count());
    await nutPhai.click();
    await page.waitForTimeout(500);
    const sau = await anhBill.evaluate((el) => getComputedStyle(el).transform);
    const conThayThe = await page.locator('text=Loại thẻ').count(); // bấm xoay KHÔNG được mở màn phóng to
    const moPhongTo = await page.locator('text=Lăn chuột phóng to').count();
    await page.screenshot({ path: path.join(OUT, '2-sau-khi-xoay-phai.png'), fullPage: false });

    console.log(`  nút xoay: ${coNut} (mong đợi 2)`);
    console.log(`  transform TRƯỚC: ${truoc}`);
    console.log(`  transform SAU  : ${sau}`);
    console.log(`  vẫn ở thẻ review (không nhảy phóng to): thẻ=${conThayThe > 0} · lightbox=${moPhongTo}`);
    const dungXoay = sau !== truoc && sau !== 'none';
    console.log(dungXoay && coNut === 2 && moPhongTo === 0 ? '  ✅ Có nút xoay trái/phải · ảnh xoay thật · không mở nhầm phóng to' : '  ❌ Chưa đạt');
    if (!dungXoay || coNut !== 2 || moPhongTo !== 0) process.exitCode = 1;
  } finally {
    await browser?.close();
    await server.close();
  }
}

void main();
