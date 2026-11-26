// REPRO BUG 1 (Admin Demo): auto tab "Bỏ qua bill này" → nhảy về BẢNG ĐỐI SOÁT thay vì bill kế.
// Mock trả review KHÁC NHAU theo TÊN FILE (bill_1/2/3) để biết đang hiện bill nào. Biến thể alreadySent.
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-bug1');
const BILL_IMG = 'C:/Users/ADMINI~1/AppData/Local/Temp/claude/C--Users-Administrator/856721ce-5805-477f-a72d-115f7114c8d0/scratchpad/bao_5_full.jpg';

// SCENARIO chọn qua env: ALLNEW (mặc định) | ALLSENT | MIXED (bill1 sent, 2/3 new)
const SCEN = process.env.SCEN ?? 'ALLNEW';
function reviewFor(fileName: string): unknown[] {
  const n = /bill_(\d)/.exec(fileName)?.[1] ?? '?';
  const sent = SCEN === 'ALLSENT' ? true : SCEN === 'MIXED' ? n === '1' : false;
  return [{
    bill: { tid: `5355000${n}`, agencyName: `HKD BILL ${n}`, batchNumber: `10${n}`, type: 'SETTLEMENT', totalAmount: 10000000 + Number(n) * 1000000, dateTime: '29/08/2026 20:29:45' },
    dealerRoomId: 'r-dealer', dealerRoomName: 'ĐL Test',
    investorRoomId: 'r-investor', investorRoomName: 'NĐT Test',
    sellFee: { resolved: true, milli: 1050, amount: 100000 }, installFee: { resolved: true, milli: 880, amount: 90000 },
    alreadySent: sent, warnings: [], dealerSummary: '', investorSummary: '',
    hkdName: `HKD BILL ${n}`, bankName: 'MB',
    availableCardTypes: [{ id: 15, name: 'MB', bankId: 15, isPrimary: true }]
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
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 850 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message, '\nSTACK:', (e.stack || '').split('\n').slice(0, 4).join(' | ')));
    page.on('console', (m) => { if (m.type() === 'error' && !/chat-realtime|AppShell|real-time|hết hạn/.test(m.text())) console.log('CONSOLE-ERR:', m.text()); });
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Tôi Test' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* */ });
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (p.endsWith('/v1/ocr-send/ocr') && method === 'POST') {
        const body = route.request().postData() ?? '';
        const fn = /filename="([^"]+)"/.exec(body)?.[1] ?? 'bill_?.jpg';
        return json(route, 200, { ok: true, token: `tok-${fn}`, review: reviewFor(fn), cached: false, kind: 'POS' });
      }
      if (p.endsWith('/v1/ocr-send/fee') && method === 'POST') {
        if (process.env.FEE === 'UNRESOLVED') return json(route, 200, { ok: true, sell: { resolved: false, note: 'TID chưa cấu hình giá bán thực tế (NO_ACTUAL_SELL_FEE)' }, install: { resolved: false, note: 'chưa có phí cài' } });
        return json(route, 200, { ok: true, sell: { resolved: true, milli: 1050, amount: 100000 }, install: { resolved: true, milli: 880, amount: 90000 } });
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
    for (const nm of ['bill_1.jpg', 'bill_2.jpg', 'bill_3.jpg']) await writeFile(path.join(billDir, nm), billBytes);
    await page.setInputFiles('input[webkitdirectory]', billDir);
    await page.waitForTimeout(3500);

    const readState = async (tag: string): Promise<void> => {
      const billCounter = await page.locator('span.tabular-nums').filter({ hasText: /Bill \d+\// }).first().innerText().catch(() => '(none)');
      const tid = await page.locator('input').first().inputValue().catch(() => '(no input)');
      const amt = await page.locator('input[inputmode="numeric"]').first().inputValue().catch(() => '(no amt)');
      const doneView = await page.getByText(/BẢNG ĐỐI SOÁT|Đã xử lý hết/).first().isVisible().catch(() => false);
      const skipVisible = await page.getByRole('button', { name: /Bỏ qua bill này/ }).isVisible().catch(() => false);
      const hkd = await page.locator('div[title]').filter({ hasText: /HKD BILL/ }).first().innerText().catch(() => '(no hkd)');
      console.log(`[${tag}] counter="${billCounter}" tid=${tid} amt=${amt} hkd=${hkd} doneView=${doneView} skipBtn=${skipVisible}`);
      await page.screenshot({ path: path.join(OUT, `${SCEN}-${tag}.png`), fullPage: true });
    };

    await readState('1-after-load');
    // PROBE: cái gì THỰC SỰ nằm trên cùng ở tâm nút "Bỏ qua bill này" (real mouse click sẽ trúng cái này)?
    const probe = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const skip = btns.find((b) => /Bỏ qua bill này/.test(b.textContent || ''));
      if (!skip) return { found: false };
      const r = skip.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const top = document.elementFromPoint(cx, cy) as HTMLElement | null;
      const topBtn = top?.closest('button');
      return { found: true, skipRect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) }, topText: (top?.textContent || '').slice(0, 40), topIsSkip: topBtn === skip };
    });
    console.log('[PROBE center of Bỏ qua]', JSON.stringify(probe));

    if (process.env.FEE === 'UNRESOLVED') {
      // CA A: TID không resolve phí → nút Gửi disabled + PHẢI hiện lý do; rescan PHẢI bấm được.
      const gui = page.getByRole('button', { name: /Gửi vào nhóm đại lý|Chưa gửi được/ });
      const sendBtn = page.locator('button', { hasText: /Gửi vào nhóm đại lý/ }).first();
      const sendDisabled = await sendBtn.isDisabled().catch(() => null);
      const reason = await page.getByText(/Chưa gửi được:/).first().innerText().catch(() => '(no reason)');
      const rescan = page.getByRole('button', { name: /Quét lại ảnh này/ }).first();
      const rescanDisabled = await rescan.isDisabled().catch(() => null);
      const opus = page.getByRole('button', { name: /Đọc lại \(Opus\)/ }).first();
      const opusDisabled = await opus.isDisabled().catch(() => null);
      void gui;
      console.log(`[CA-A] Gửi disabled=${sendDisabled} · reason="${reason}" · rescanDisabled=${rescanDisabled} · opusDisabled=${opusDisabled}`);
      await page.screenshot({ path: path.join(OUT, 'CAA-fee-unresolved.png'), fullPage: true });
      return;
    }

    // BUG 1: REAL mouse click (không force, không dispatch) — chứng minh nút KHÔNG còn bị log panel đè.
    await page.getByRole('button', { name: /Bỏ qua bill này/ }).click({ timeout: 5000 }).catch((e) => console.log('REAL click skip err:', e.message.split('\n')[0]));
    await page.waitForTimeout(2500);
    await readState('2-after-skip1');
    await page.getByRole('button', { name: /Bỏ qua bill này/ }).click({ timeout: 5000 }).catch((e) => console.log('REAL click skip2 err:', e.message.split('\n')[0]));
    await page.waitForTimeout(2500);
    await readState('3-after-skip2');

    // dump log panel
    const logText = await page.locator('body').innerText().catch(() => '');
    const logLines = logText.split('\n').filter((l) => /Bill \d|ĐỐI SOÁT|đọc xong|ĐÃ GỬI|xử lý hết/.test(l)).slice(0, 30);
    console.log('=== LOG LINES ===\n' + logLines.join('\n'));
  } finally {
    await browser?.close();
    await server.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
