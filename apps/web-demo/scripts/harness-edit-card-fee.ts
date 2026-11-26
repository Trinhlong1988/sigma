// HARNESS R200 (Admin Demo 8/9 "sửa bill nhưng không cho sửa phí à? bấm sửa ở báo cáo lô … không sửa được thẻ Visa/JCB").
// Đi ĐÚNG đường người dùng: Báo cáo lô → nút "Sửa" → nhập mật khẩu → card review mở ra → ĐỔI LOẠI THẺ (Visa → JCB)
// → phí % đổi theo + nút "Cập nhật bill đã gửi" phải HIỆN → bấm → payload lên server phải kèm cardTypeId của JCB.
// Chạy: node --import tsx scripts/harness-edit-card-fee.ts
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-edit-card-fee');
const ROOM = 'room-demo';
const VISA = 20;
const JCB = 21;

const TIDS = [{ tidId: 1, tid: '67512202', hkdName: 'HKD DEMO 27', bankName: 'ABB', linkedAt: '', linkedBy: null }];
const ROWS = [{ loId: 504, tidId: 1, date: '2026-09-08', effDateIso: '2026-09-08T03:00:00.000Z', bankReportedLoNumber: null, billLoNumber: '12', investorNickname: null, gross: 10000000, fee: 140000, net: 9860000 }];
const REPORT = { from: '2026-09-01', to: '2026-09-09', tids: TIDS, totalGross: 10000000, totalFee: 140000, totalNet: 9860000, loCount: 1, daily: [{ date: '2026-09-08', gross: 10000000, net: 9860000 }], rows: ROWS };

/** Bill ĐÃ GỬI, lô đang ghi thẻ Visa (currentCardTypeId) — máy ABB có 2 thẻ: Visa + JCB. */
function reviewItem(): unknown {
  return {
    bill: { tid: '67512202', agencyName: 'HKD DEMO 27', batchNumber: '12', type: 'SALE', totalAmount: 10000000, dateTime: '08/09/2026 10:00', settlementCode: null },
    dealerRoomId: 'r-abb', dealerRoomName: 'ĐL- Duy Linh', investorRoomId: null, investorRoomName: null,
    sellFee: { resolved: true, milli: 1400, amount: 140000, source: 'RATE' },
    installFee: { resolved: true, milli: 100, amount: 10000, source: 'RATE' },
    alreadySent: true, sentMessageId: 'msg-cu', warnings: [], dealerSummary: null, investorSummary: null,
    availableCardTypes: [{ id: VISA, name: 'Visa', bankId: 19, isPrimary: true }, { id: JCB, name: 'JCB', bankId: 19, isPrimary: false }],
    currentCardTypeId: VISA, currentSplits: null,
    hkdName: 'HKD DEMO 27', bankName: 'ABB', tidSuggestions: []
  };
}

/** Phí THEO THẺ: Visa 1,40% · JCB 2,20% → đổi thẻ mà phí không đổi là hỏng. */
function feeFor(cardTypeId: number, amount: number): unknown {
  const milli = cardTypeId === JCB ? 2200 : 1400;
  return {
    sell: { resolved: true, milli, amount: Math.round((amount * milli) / 100000), source: 'RATE' },
    install: { resolved: true, milli: 100, amount: Math.round(amount / 1000), source: 'RATE' }
  };
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
  let updatePayload: { bill?: { cardTypeId?: number } } | undefined;
  try {
    browser = await chromium.launch();
    const page = await (await browser.newContext({ viewport: { width: 1300, height: 1000 } })).newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* mở lửng */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (/\/revenue$/.test(p)) return json(route, { ok: true, data: REPORT });
      // Nút "Sửa" gọi edit-source (lô → tin bill gốc) TRƯỚC rồi mới prepare-edit.
      if (/\/lo\/\d+\/edit-source$/.test(p)) return json(route, { ok: true, data: { messageId: 'msg-cu', current: { amount: 10000000, lo: '12', tid: '67512202', dateTime: '08/09/2026 10:00', hkdName: 'HKD DEMO 27', bank: 'ABB' } } });
      if (p.endsWith('/v1/ocr-send/prepare-edit')) return json(route, { ok: true, token: 'tok', review: [reviewItem()], kind: 'POS', editMessageId: 'msg-cu' });
      if (p.endsWith('/v1/ocr-send/fee')) {
        const body = JSON.parse(route.request().postData() || '{}') as { amount?: number; splits?: { cardTypeId: number }[] };
        return json(route, feeFor(body.splits?.[0]?.cardTypeId ?? VISA, body.amount ?? 0));
      }
      if (p.endsWith('/v1/ocr-send/update-sent')) {
        updatePayload = JSON.parse(route.request().postData() || '{}') as { bill?: { cardTypeId?: number } };
        return json(route, { ok: true, updatedCount: 1, oldAmount: 10000000, newAmount: 10000000, revenueUpdated: true });
      }
      if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
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

    await page.screenshot({ path: path.join(OUT, '1-mo-sua-the-dang-ghi.png'), fullPage: true });
    const select = page.locator('select').filter({ hasText: 'JCB' }).first();
    const theDangChon = await select.count() ? await select.inputValue() : '(không có select thẻ)';
    console.log(`  [1] Card mở ra với thẻ đang ghi = ${theDangChon} (mong đợi ${VISA} = Visa)`);

    await select.selectOption(String(JCB));
    await page.waitForTimeout(1600);
    const nutCapNhat = page.locator('button:has-text("Cập nhật bill đã gửi")');
    const coNut = await nutCapNhat.count();
    const coPhiMoi = (await page.locator('text=/2[,.]2/').count()) > 0;
    await page.screenshot({ path: path.join(OUT, '2-doi-the-sang-jcb.png'), fullPage: true });
    console.log(`  [2] Đổi sang JCB → nút "Cập nhật bill đã gửi": ${coNut} · phí 2,2% hiện: ${coPhiMoi}`);

    if (coNut > 0) {
      await nutCapNhat.first().click();
      await page.waitForTimeout(1400);
    }
    await page.screenshot({ path: path.join(OUT, '3-sau-khi-cap-nhat.png'), fullPage: true });
    console.log('  [3] payload update-sent:', JSON.stringify(updatePayload));

    const loi: string[] = [];
    if (theDangChon !== String(VISA)) loi.push('card KHÔNG mở đúng thẻ đang ghi');
    if (coNut === 0) loi.push('KHÔNG có nút Cập nhật sau khi đổi thẻ');
    if (!coPhiMoi) loi.push('phí KHÔNG đổi theo thẻ');
    const guiLen = updatePayload as { bill?: { cardTypeId?: number } } | undefined;
    if (guiLen?.bill?.cardTypeId !== JCB) loi.push('payload thiếu cardTypeId JCB');
    console.log(loi.length ? `  ❌ ${loi.join(' | ')}` : '  ✅ Đổi được thẻ → phí đổi theo → cập nhật gửi đúng cardTypeId');
    if (loi.length) process.exitCode = 1;
  } finally {
    await browser?.close();
    await server.close();
  }
}

void main();
