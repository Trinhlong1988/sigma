// REPRO FIX 5/9 (Admin Demo) — "dropdown chọn lại TID vẫn câm mù gửi" + "cảnh báo bên phải ảnh bill" (tab TỰ ĐỘNG).
// Kịch bản: OCR đọc NHẦM TID (59930002 không có trong hệ thống) → bill UNROUTED (dealerRoomId=null, availableCardTypes=[])
//   + tidSuggestions [59930062, 59930063]. Trước fix: chọn TID gợi ý chỉ đổi text → routing/thẻ vẫn rỗng → nút Gửi
//   xám VĨNH VIỄN. Sau fix: chọn TID đúng → client gọi /reroute → routing + thẻ + phòng NĐT populate → /fee resolve →
//   nút Gửi bật XANH + lý-do-chặn biến mất.
// Đồng thời chụp CHANGE 2: card AUTO (stacked) hiển thị KHỐI CẢNH BÁO (folder + "TID không có trong hệ thống") BÊN PHẢI
//   ảnh bill (chỗ trống dưới nhãn 🔍 phóng to), thông số nằm full-width phía dưới.
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-reroute');
const BILL_IMG = path.join(ROOT, 'screenshots', 'harness-bug1', '_folder', 'bill_1.jpg');

const SCEN = process.env.SCEN ?? 'POS'; // POS = reroute + CHANGE2 POS; CK = CHANGE2 cho bill chuyển khoản.
const MISREAD_TID = '59930002';   // OCR đọc nhầm → không có trong hệ thống
const GOOD_TID = '59930062';      // TID đúng (chọn ở dropdown)

function transferReviewCk(): unknown[] {
  return [{
    senderName: 'CONG TY SIGMA', senderIsAlpha: true, receiverName: 'DAI LY THAI BINH', content: 'hoan tien dai ly',
    amount: 5_000_000, bank: 'MB', senderBank: 'VCB', date: '03/09/2026',
    matchedRoomId: 'r-dealer', matchedRoomName: 'ĐL Thái Bình', needsManualPick: false, warnings: [],
    direction: 'SIGMA_TO_DEALER', entityType: 'DEALER', entityId: null, alreadySent: true, sentMessageId: null,
    senderAccount: '0111', receiverAccount: '0222'
  }];
}

function reviewUnrouted(): unknown[] {
  // SCEN=INFER (Admin Demo 5/9): OCR KHÔNG đọc được TID → SUY từ tên HKD → bill.tid = TID HỢP LỆ (GOOD_TID) NHƯNG review
  // trả availableCardTypes RỖNG → selector loại thẻ ẩn → kẹt. Sau fix: auto-reroute (cards rỗng) → nạp thẻ → selector hiện.
  const infer = SCEN === 'INFER';
  return [{
    bill: { tid: infer ? GOOD_TID : MISREAD_TID, agencyName: 'HKD DEMO 5', batchNumber: '77', type: 'SETTLEMENT', totalAmount: 50_000_000, dateTime: '03/09/2026 10:00:00' },
    dealerRoomId: null, dealerRoomName: null, investorRoomId: null, investorRoomName: null,
    sellFee: null, installFee: null, alreadySent: false, sentMessageId: null,
    tidSuggestions: infer ? [] : [{ tid: GOOD_TID, hkdName: 'HKD DEMO 5 2' }, { tid: '59930063', hkdName: 'HKD DEMO 5 3' }],
    warnings: infer ? [`⚠ OCR không đọc được TID — đã SUY từ tên HKD "HKD DEMO 5 2" → TID ${GOOD_TID}. XÁC NHẬN đúng máy trước khi gửi.`]
      : [`⚠ TID "${MISREAD_TID}" OCR đọc KHÔNG có trong hệ thống (nghi nhầm số) — CHỌN/NHẬP TID tay.`],
    dealerSummary: null, investorSummary: null, availableCardTypes: [], hkdName: 'HKD DEMO 5', bankName: null
  }];
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
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/chat-realtime|AppShell|real-time|hết hạn/.test(m.text())) console.log('CONSOLE-ERR:', m.text()); });
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Tôi Test' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* */ });

    let rerouteHits = 0; let feeHits = 0;
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (p.endsWith('/v1/ocr-send/ocr') && method === 'POST') {
        if (SCEN === 'CK') return json(route, 200, { ok: true, token: 'tok-1', review: [], kind: 'TRANSFER', transferReview: transferReviewCk(), cached: false });
        return json(route, 200, { ok: true, token: 'tok-1', review: reviewUnrouted(), cached: false, kind: 'POS' });
      }
      if (p.endsWith('/v1/ocr-send/reroute') && method === 'POST') {
        rerouteHits++;
        const tid = String(JSON.parse(route.request().postData() || '{}').tid ?? '');
        if (tid === GOOD_TID) return json(route, 200, {
          ok: true, dealerRoomId: 'r-dealer', dealerRoomName: 'ĐL Thái Bình', investorRoomId: 'r-inv', investorRoomName: 'NĐT Test',
          availableCardTypes: [{ id: 15, name: 'MB', bankId: 15, isPrimary: false }, { id: 16, name: 'Ngoài MB-Visa-Master', bankId: 15, isPrimary: true }, { id: 17, name: 'Ngoài MB-Napas', bankId: 15, isPrimary: false }], primaryCardTypeId: 16,
          hkdName: 'HKD DEMO 5 2', bankName: 'MB', warnings: []
        });
        // TID khác → vẫn unrouted
        return json(route, 200, { ok: true, dealerRoomId: null, dealerRoomName: null, investorRoomId: null, investorRoomName: null, availableCardTypes: [], primaryCardTypeId: null, hkdName: null, bankName: null, warnings: [`TID ${tid} không có trong hệ thống.`] });
      }
      if (p.endsWith('/v1/ocr-send/fee') && method === 'POST') {
        feeHits++;
        const tid = String(JSON.parse(route.request().postData() || '{}').tid ?? '');
        if (tid === GOOD_TID) return json(route, 200, { ok: true, sell: { resolved: true, milli: 1400, amount: 700000 }, install: { resolved: true, milli: 880, amount: 440000 } });
        return json(route, 200, { ok: true, sell: { resolved: false, note: 'TID chưa cấu hình giá bán thực tế' }, install: { resolved: false, note: 'chưa có phí cài' } });
      }
      if (p.endsWith('/v1/ocr-send/send') && method === 'POST') return json(route, 200, { ok: true, duplicate: false, dealerMessageId: 'm1', investorMessageId: 'm2', revenue: { ok: true, loId: 999 } });
      if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: billBytes });
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, 200, method === 'GET' && listLike ? [] : {});
    });

    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.getByText('Tự động', { exact: false }).click();
    await page.waitForTimeout(300);
    const billDir = path.join(OUT, '_folder');
    await mkdir(billDir, { recursive: true });
    await writeFile(path.join(billDir, 'bill_1.jpg'), billBytes);
    await page.setInputFiles('input[webkitdirectory]', billDir);
    await page.waitForTimeout(3500);

    if (SCEN === 'INFER') {
      // Sau fix: bill có TID suy-ra (cards rỗng) → auto-reroute nạp thẻ → selector "Loại thẻ" HIỆN + Gửi hết kẹt "chưa chọn loại thẻ".
      await page.waitForTimeout(1500); // chờ debounce reroute 400ms + fee
      const st = await page.evaluate(() => {
        const hasCardSelect = Array.from(document.querySelectorAll('span')).some((s) => /^Loại thẻ$/.test(s.textContent || ''));
        const reason = (Array.from(document.querySelectorAll('*')).map((e) => e.textContent || '').find((t) => /Chưa gửi được:/.test(t)) || '').slice(0, 90);
        const cardOpts = Array.from(document.querySelectorAll('select option')).map((o) => o.textContent || '').filter((t) => /mặc định|MB|Visa|Napas|Ngoài/.test(t));
        return { hasCardSelect, reason, cardOpts };
      });
      console.log(`[INFER] selector "Loại thẻ" hiện=${st.hasCardSelect} · options=${JSON.stringify(st.cardOpts)} · reason="${st.reason}"`);
      await page.screenshot({ path: path.join(OUT, 'infer-cardselect.png'), fullPage: true });
      console.log(st.hasCardSelect ? '✅ INFER PASS — selector loại thẻ hiện sau auto-reroute (hết kẹt).' : '❌ INFER FAIL — vẫn không có selector.');
      return;
    }
    if (SCEN === 'CK') {
      // CHANGE 2 cho CK: cảnh báo "ĐÃ GỬI trước" nằm BÊN PHẢI ảnh bill CK (stacked).
      const ckGeo = await page.evaluate(() => {
        const img = document.querySelector('img[alt="bill chuyển khoản"]') as HTMLElement | null;
        const cands = Array.from(document.querySelectorAll('div')).filter((d) => /ĐÃ GỬI vào nhóm rồi/.test(d.textContent || ''));
        const leaf = cands.find((d) => !cands.some((o) => o !== d && d.contains(o)));
        if (!img || !leaf) return { found: false };
        const ri = img.getBoundingClientRect(); const rw = leaf.getBoundingClientRect();
        return { found: true, imgRight: Math.round(ri.right), warnLeft: Math.round(rw.left), warnBeside: rw.left >= ri.right - 8 };
      });
      console.log(`[CK] CHANGE2 geo=${JSON.stringify(ckGeo)}`);
      await page.screenshot({ path: path.join(OUT, '3-ck-beside.png'), fullPage: true });
      console.log(ckGeo.found && (ckGeo as { warnBeside?: boolean }).warnBeside ? '✅ CK PASS — cảnh báo "đã gửi" bên phải ảnh CK.' : '❌ CK FAIL — xem screenshot.');
      return;
    }

    const sendBtn = page.locator('button', { hasText: /Gửi vào nhóm đại lý|Gửi nhóm đại lý/ }).first();
    const reasonLoc = page.getByText(/Chưa gửi được:/).first();

    // ── BEFORE: chưa chọn TID → Gửi disabled + lý do chặn hiện (+ ảnh screenshot CHANGE 2: cảnh báo bên phải ảnh) ──
    const beforeDisabled = await sendBtn.isDisabled().catch(() => null);
    const beforeReason = await reasonLoc.innerText().catch(() => '(no reason)');
    // Đo hình học CHANGE 2: khối cảnh báo "TID ... KHÔNG có trong hệ thống" có nằm BÊN PHẢI ảnh bill không?
    const geo = await page.evaluate(() => {
      const img = document.querySelector('img[alt="bill"]') as HTMLElement | null;
      const cands = Array.from(document.querySelectorAll('div')).filter((d) => /KHÔNG có trong hệ thống/.test(d.textContent || ''));
      const leaf = cands.find((d) => !cands.some((o) => o !== d && d.contains(o))); // div trong cùng chứa cụm
      if (!img || !leaf) return { found: false };
      const ri = img.getBoundingClientRect(); const rw = leaf.getBoundingClientRect();
      return { found: true, imgRight: Math.round(ri.right), warnLeft: Math.round(rw.left), warnBeside: rw.left >= ri.right - 8, warnTop: Math.round(rw.top), imgTop: Math.round(ri.top) };
    });
    console.log(`[BEFORE] Gửi disabled=${beforeDisabled} · reason="${beforeReason.slice(0, 80)}" · CHANGE2 geo=${JSON.stringify(geo)}`);
    await page.screenshot({ path: path.join(OUT, '1-before-pick.png'), fullPage: true });

    // ── PICK corrected TID từ dropdown "Gợi ý TID theo HKD" ──
    const dd = page.locator('select').filter({ hasText: /Gợi ý TID theo HKD/ }).first();
    await dd.selectOption(GOOD_TID).catch(async () => {
      // fallback: chọn theo label
      await dd.selectOption({ label: `HKD DEMO 5 2 · TID ${GOOD_TID}` });
    });
    // chờ reroute (debounce 400ms) + fee (debounce 350ms) + render
    await page.waitForTimeout(1800);

    // ── AFTER: Gửi enabled + lý do biến mất + phòng đại lý hiện ──
    const afterDisabled = await sendBtn.isDisabled().catch(() => null);
    const afterReasonVisible = await reasonLoc.isVisible().catch(() => false);
    const tidVal = await page.locator('input').filter({ hasNot: page.locator('[type="date"]') }).first().inputValue().catch(() => '(no)');
    const dealerShown = await page.getByText('ĐL Thái Bình').first().isVisible().catch(() => false);
    const feeResolvedShown = await page.getByText(/700\.000|1\.400%/).first().isVisible().catch(() => false);
    console.log(`[AFTER]  Gửi disabled=${afterDisabled} · reasonVisible=${afterReasonVisible} · tid=${tidVal} · dealerShown=${dealerShown} · feeShown=${feeResolvedShown} · rerouteHits=${rerouteHits} feeHits=${feeHits}`);
    await page.screenshot({ path: path.join(OUT, '2-after-pick.png'), fullPage: true });

    // VERDICT
    const pass = beforeDisabled === true && afterDisabled === false && !afterReasonVisible && geo.found && (geo as { warnBeside?: boolean }).warnBeside === true;
    console.log(pass ? '✅ PASS — reroute mở khoá Gửi + cảnh báo nằm bên phải ảnh (CHANGE 2 POS).' : '❌ FAIL — xem log + screenshots.');
  } finally {
    await browser?.close();
    await server.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
