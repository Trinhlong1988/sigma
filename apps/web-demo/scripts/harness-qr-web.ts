// HARNESS R200 (Admin Demo 5/9) — render 2 màn web QR THẬT (app + mock API) để LEAD tự nhìn ảnh TRƯỚC ship:
//   SCEN=QR  → OcrSendScreen tab Tự động: QrBillReviewCard (đổi đại lý → phí bán/hoàn tính lại + nhãn "giá đại lý"/"giá mã").
//   SCEN=AGG → AlphaAggregateScreen: 2 bảng NĐT/Đại lý (cột POS·QR·Tổng·Hoàn) + 5 thẻ tổng (hoàn ĐL/NĐT tách).
// Chạy: SCEN=QR node --import tsx scripts/harness-qr-web.ts  /  SCEN=AGG ...
import { createServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-qr-web');
const BILL_IMG = path.join(ROOT, 'screenshots', 'harness-bug1', '_folder', 'bill_1.jpg');
const SCEN = process.env.SCEN ?? 'QR';

const DEALERS = [
  { roomId: 'r-nguyen-sg', name: 'Đại lý Nguyễn SG' },
  { roomId: 'r-trung-cp', name: 'Đại lý Trung Cẩm Phả' }
];

// QR item 10tr (ví dụ Admin Demo): mặc định giá MÃ 1.05% → đại lý hoàn 9.895.000, NĐT về trọn 10tr.
function qrItemDefault(): unknown {
  return {
    qr: { hkdName: 'HKD DEMO 35 Ha Noi', amount: 10_000_000, ref: '6247VNIB024EN8TK', dateTime: '09:15 10/09/2026', fromCard: 'VIB Cash Back ••5721' },
    tidId: 5, tidCode: 'QR-nguyen-tri-bao-x1', hkdNameMatched: 'HKD DEMO 35 Ha Noi',
    partnerId: 1, receiveAccountId: 1, industryId: 1,
    sellFeeMilli: 1050, sellFeeAmount: 105_000, partnerFeeMilli: 850,
    refundAmount: 9_895_000, investorReceiveAmount: 10_000_000,
    feeSource: 'PARTNER', sellFeeSource: 'DEFAULT', isWeekend: false,
    dealerRoomId: 'r-nguyen-sg', dealerRoomName: 'Đại lý Nguyễn SG',
    alreadySent: false, warnings: [], blocked: false
  };
}
// Sau khi chọn "Trung Cẩm Phả" (có giá bán ĐÈ 1.10%) → phí bán 110.000, hoàn 9.890.000, nhãn "giá đại lý".
function qrItemForDealer(dealerId: string): unknown {
  const base = qrItemDefault() as Record<string, unknown>;
  if (dealerId === 'r-trung-cp') {
    return { ...base, sellFeeMilli: 1100, sellFeeAmount: 110_000, refundAmount: 9_890_000, sellFeeSource: 'DEALER', dealerRoomId: 'r-trung-cp', dealerRoomName: 'Đại lý Trung Cẩm Phả' };
  }
  return { ...base, dealerRoomId: dealerId };
}

function aggregateReport(sel?: { investorId?: string; dealerId?: string }): unknown {
  const base = {
    from: '2026-09-01', to: '2026-09-30',
    byInvestor: [
      { investorId: 1, name: 'Anh Quốc', doanhSoPos: 0, doanhSoQr: 10_000_000, tong: 10_000_000, hoan: 9_915_000, laiNdtPos: 0, laiNdtQr: 85_000, laiNdt: 85_000 },
      { investorId: 2, name: 'NĐT Minh', doanhSoPos: 500_000_000, doanhSoQr: 0, tong: 500_000_000, hoan: 0, laiNdtPos: 500_000, laiNdtQr: 0, laiNdt: 500_000 }
    ],
    byDealer: [
      { dealerId: 'r-nguyen-sg', name: 'Đại lý Nguyễn SG', doanhSoPos: 0, doanhSoQr: 10_000_000, tong: 10_000_000, hoan: 9_895_000 },
      { dealerId: 'r-trung-cp', name: 'Đại lý Trung Cẩm Phả', doanhSoPos: 500_000_000, doanhSoQr: 0, tong: 500_000_000, hoan: 2_000_000 }
    ],
    totals: {
      doanhSoPos: 500_000_000, doanhSoQr: 10_000_000, tongDoanhSo: 510_000_000, tongHoanDaiLy: 11_895_000, tongHoanNDT: 9_915_000,
      laiCongTyPos: 700_000, laiCongTyQr: 20_000, laiCongTy: 720_000, laiNdtPos: 500_000, laiNdtQr: 85_000, laiNdt: 585_000
    },
    detail: undefined as unknown
  };
  if (sel?.investorId === '1') {
    base.detail = {
      entityKind: 'investor', entityId: '1', name: 'Anh Quốc',
      rows: [{ txnDateIso: '2026-09-10T02:15:00.000Z', hkdName: 'HKD DEMO 35 Ha Noi', kind: 'QR', amount: 10_000_000, giaMua: 85_000, ndtTraAlpha: 9_915_000, laiNdt: 85_000, phiBan: null, daiLyHoan: null }],
      refunds: [], totals: { amountPos: 0, amountQr: 10_000_000, amount: 10_000_000, laiNdt: 85_000, hoan: 9_915_000 }
    };
  } else if (sel?.dealerId === 'r-nguyen-sg') {
    base.detail = {
      entityKind: 'dealer', entityId: 'r-nguyen-sg', name: 'Đại lý Nguyễn SG',
      rows: [{ txnDateIso: '2026-09-10T02:15:00.000Z', hkdName: 'HKD DEMO 35 Ha Noi', kind: 'QR', amount: 10_000_000, giaMua: null, ndtTraAlpha: null, laiNdt: null, phiBan: 105_000, daiLyHoan: 9_895_000 }],
      refunds: [], totals: { amountPos: 0, amountQr: 10_000_000, amount: 10_000_000, laiNdt: 0, hoan: 9_895_000 }
    };
  }
  return base;
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
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 950 } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { if (/map/.test(e.message)) console.log('PAGEERROR-STACK:', e.stack); else console.log('PAGEERROR:', e.message); });
    page.on('console', (m) => { if (m.type() === 'error' && !/chat-realtime|AppShell|real-time|hết hạn/.test(m.text())) console.log('CONSOLE-ERR:', m.text()); });
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguoi Dung Demo' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* */ });

    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (p.endsWith('/v1/ocr-send/ocr') && method === 'POST') return json(route, 200, { ok: true, token: 'tok-qr', kind: 'QR', qrReview: [qrItemDefault()], cached: false });
      // jsonCall bọc {ok, data: <body>} → mock trả BODY trực tiếp (không bọc lại), khớp cách client đọc r.data.dealers / r.data.item.
      if (p.endsWith('/v1/ocr-send/classify-options')) return json(route, 200, { dealers: DEALERS, investors: [{ id: 1, name: 'Anh Quốc' }] });
      if (p.endsWith('/v1/ocr-send/qr-review-dealer') && method === 'POST') {
        const dealerId = String(JSON.parse(route.request().postData() || '{}').dealerId ?? '');
        return json(route, 200, { item: qrItemForDealer(dealerId) });
      }
      if (p.endsWith('/v1/ocr-send/send-qr') && method === 'POST') return json(route, 200, { ok: true, transactionId: 1, revenue: { ok: true }, refund: { ok: true } });
      if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: billBytes });
      if (p.endsWith('/v1/alpha-aggregate/report')) {
        const u = new URL(route.request().url());
        return json(route, 200, aggregateReport({ investorId: u.searchParams.get('investorId') ?? undefined, dealerId: u.searchParams.get('dealerId') ?? undefined }));
      }
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, 200, method === 'GET' && listLike ? [] : {});
    });

    if (SCEN === 'AGG') {
      await page.goto(`${baseUrl}/app/alpha-aggregate`, { waitUntil: 'networkidle' });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(OUT, 'agg-1-investor.png'), fullPage: true });
      console.log('  shot agg-1-investor.png (tab NĐT + thẻ Lãi)');
      // Tab Đại lý
      await page.getByRole('button', { name: 'Theo Đại lý' }).click().catch((e) => console.log('  tab err', e.message));
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(OUT, 'agg-2-dealer.png'), fullPage: true });
      console.log('  shot agg-2-dealer.png');
      // Về tab NĐT + chọn Anh Quốc → chi tiết
      await page.getByRole('button', { name: 'Theo Nhà đầu tư' }).click().catch(() => {});
      await page.waitForTimeout(500);
      await page.locator('select').first().selectOption({ label: 'Anh Quốc' }).catch((e) => console.log('  sel err', e.message));
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(OUT, 'agg-3-detail-investor.png'), fullPage: true });
      console.log('  shot agg-3-detail-investor.png (chi tiết NĐT Anh Quốc)');
      return;
    }

    // SCEN QR — TAB "Quét QR" RIÊNG (Admin Demo 5/9). Click tab QR → chụp màn entry (upload + folder) → quét folder →
    // card QR render → đổi đại lý (recalc phí bán/hoàn). Target INPUT/SELECT trong tab QR (data-testid) + :visible để
    // KHÔNG dính card trùng ở tab 'auto' đang mounted-hidden.
    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: 'Quét QR', exact: true }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, 'qr-0-tab-entry.png'), fullPage: true });
    console.log('  shot qr-0-tab-entry.png (tab Quét QR hiện: mô tả + upload + quét folder)');
    const billDir = path.join(OUT, '_folder');
    await mkdir(billDir, { recursive: true });
    await writeFile(path.join(billDir, 'bill_1.jpg'), billBytes);
    await page.setInputFiles('[data-testid="qr-folder-input"]', billDir);
    await page.waitForTimeout(3500);
    await page.screenshot({ path: path.join(OUT, 'qr-1-default.png'), fullPage: true });
    console.log('  shot qr-1-default.png (card QR trong tab riêng, giá mã 1.05%)');
    // Đổi dropdown sang "Trung Cẩm Phả" (có giá đè 1.10%) → recalc. Chỉ select TRONG panel QR (visible).
    const sel = page.locator('[data-testid="qr-tab-panel"] select:visible').first();
    await sel.selectOption({ label: 'Đại lý Trung Cẩm Phả' }).catch((e) => console.log('  select err', e.message));
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, 'qr-2-dealer-override.png'), fullPage: true });
    console.log('  shot qr-2-dealer-override.png (giá đại lý 1.10%)');
  } catch (e) {
    console.error('[harness-qr-web] LỖI:', (e as Error).message);
  } finally {
    await browser?.close();
    await server.close();
  }
}
void main();
