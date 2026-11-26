// HARNESS ship-gate (Admin Demo 30/8) — render THẬT màn "Quét bill gửi" (OcrSendScreen) trong Chromium để LEAD nhìn
// mắt trước khi ship (R200). Mock API /v1/ocr-send/* bằng data THỰC TẾ (bill #5 nhóm Bảo: TID 53550077, lô 165,
// 19.048.000, phí cài 1.067%, phí bán 2.2%, 2 loại thẻ để demo tách thẻ). Chụp: (1) tab thủ công + review card;
// (2) tab tự động (log bill mới/cũ). KHÔNG chạm bot-api thật (page.route mock hết).
import { build, preview } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-ocr-send');
const BILL_IMG = 'C:/Users/ADMINI~1/AppData/Local/Temp/claude/C--Users-Administrator/856721ce-5805-477f-a72d-115f7114c8d0/scratchpad/bao_5_full.jpg';

const REVIEW = [{
  bill: { tid: '53550081', agencyName: 'HKD DEMO 19', batchNumber: '113', type: 'SETTLEMENT', totalAmount: 114394000, dateTime: '29/08/2026 20:29:45' },
  dealerRoomId: 'r-dealer', dealerRoomName: 'ĐL - Tuyên SG',
  investorRoomId: 'r-investor', investorRoomName: 'Trung Cẩm Phả',
  sellFee: { resolved: true, milli: 1050, amount: 1201137 },
  installFee: { resolved: true, milli: 880, amount: 1006667 },
  alreadySent: false, warnings: [],
  dealerSummary: '', investorSummary: '',
  hkdName: 'HKD DEMO 19', bankName: 'MB',
  availableCardTypes: [{ id: 15, name: 'MB', bankId: 15, isPrimary: true }, { id: 17, name: 'Ngoài MB-Napas', bankId: 15, isPrimary: false }, { id: 16, name: 'Ngoài MB-Visa-Master', bankId: 15, isPrimary: false }]
}];

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  console.log('[harness] build...');
  await build({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error' });
  const server = await preview({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), preview: { port: 0 } });
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:4173';
  console.log(`[harness] preview (built) ở ${baseUrl}`);
  const billBytes = await readFile(BILL_IMG);

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));
    page.on('console', (m) => { if (m.type() === 'error' && !/chat-realtime|AppShell|real-time|hết hạn/.test(m.text())) console.log('CONSOLE-ERR:', m.text()); });
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Tôi Test' }));
      window.localStorage.setItem('ocrSend.lastFolder', '<REPO>\\Downloads');
      // Giả lập SigMa PC (Electron) để hiện nút "Chọn folder…" trong ảnh render.
      // @ts-expect-error inject cho harness
      window.SigMaPC = { platform: 'pc', isElectron: true, pickFolder: () => Promise.resolve('<REPO>\\Downloads\\bill') };
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket
      window.WebSocket = FakeWS;
    });

    // Stub WebSocket real-time (tránh handleSessionExpired đá về /login).
    await page.routeWebSocket(/^ws/, () => { /* để mở lửng, không close */ });

    // Catch-all MỌI /v1/** → KHÔNG cho request nào chạm bot-api thật (mọi 401 = hết hạn = đá login).
    await page.route('**/v1/**', async (route) => {
      const p = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (p.endsWith('/v1/ocr-send/ocr') && method === 'POST') return json(route, 200, { ok: true, token: 'tok-demo', review: REVIEW, cached: false });
      if (p.endsWith('/v1/ocr-send/ocr-file') && method === 'POST') return json(route, 200, { ok: true, token: 'tok-demo', review: REVIEW, cached: false });
      if (p.endsWith('/v1/ocr-send/fee') && method === 'POST') {
        let splits: { cardTypeId: number; amount: number }[] | undefined;
        try { splits = JSON.parse(route.request().postData() ?? '{}').splits; } catch { /* */ }
        if (splits && splits.length > 1) { // tách thẻ → breakdown
          const bd = (milliOf: (id: number) => number) => splits!.map((s) => ({ cardTypeId: s.cardTypeId, cardName: s.cardTypeId === 15 ? 'MB' : s.cardTypeId === 16 ? 'Ngoài MB-Visa-Master' : 'Napas', amount: s.amount, milli: milliOf(s.cardTypeId), fee: Math.round(s.amount * milliOf(s.cardTypeId) / 100000) }));
          const sellBd = bd((id) => (id === 15 ? 1050 : id === 16 ? 1400 : 1400));
          const instBd = bd((id) => (id === 15 ? 880 : id === 16 ? 1155 : 1400));
          return json(route, 200, { ok: true, sell: { resolved: true, amount: sellBd.reduce((a, b) => a + b.fee, 0), breakdown: sellBd }, install: { resolved: true, amount: instBd.reduce((a, b) => a + b.fee, 0), breakdown: instBd } });
        }
        return json(route, 200, { ok: true, sell: { resolved: true, milli: 1050, amount: 1201137 }, install: { resolved: true, milli: 880, amount: 1006667 } });
      }
      if (p.endsWith('/v1/ocr-send/send') && method === 'POST') {
        // CHỤP ẢNH CARD client render (Admin Demo 31/8): lưu dealerImage/investorImage base64 → PNG để LEAD nhìn mẫu.
        try {
          const body = JSON.parse(route.request().postData() ?? '{}');
          for (const [k, f] of [['dealerImage', 'card-dealer.png'], ['investorImage', 'card-investor.png']] as const) {
            const d = body[k];
            if (typeof d === 'string') { const m = /^data:[^;]+;base64,(.+)$/s.exec(d); if (m) await (await import('node:fs/promises')).writeFile(path.join(OUT, f), Buffer.from(m[1], 'base64')); }
          }
          console.log(`[harness] /send: dealerImage=${!!body.dealerImage} investorImage=${!!body.investorImage} (đã lưu card-*.png)`);
        } catch (e) { console.log('[harness] /send parse lỗi:', (e as Error).message); }
        return json(route, 200, { ok: true, duplicate: false, dealerMessageId: 'm1', investorMessageId: 'm2', revenue: { ok: true, loId: 999 } });
      }
      if (p.includes('/v1/ocr-send/image')) return route.fulfill({ status: 200, contentType: 'image/jpeg', body: billBytes });
      if (p.endsWith('/v1/ocr-send/scan') && method === 'POST') return json(route, 200, { ok: true, count: 12, newCount: 3, files: [
        { path: 'C:/bills/b1.jpg', name: 'bill_moi_1.jpg', mtime: 3, size: 1, alreadyOcr: false },
        { path: 'C:/bills/b2.jpg', name: 'bill_moi_2.jpg', mtime: 2, size: 1, alreadyOcr: false },
        { path: 'C:/bills/b3.jpg', name: 'bill_moi_3.jpg', mtime: 1, size: 1, alreadyOcr: false }
      ] });
      // Mặc định (call nền của AppShell/Sidebar): GET danh sách → [] (tránh .map/.filter/iterate crash),
      // còn lại → {} . KHÔNG 401 → không hết hạn. Đủ để AppShell render, focus vào màn OCR.
      const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
      return json(route, 200, method === 'GET' && listLike ? [] : {});
    });

    await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, '1-manual-empty.png') });

    // Upload 1 ảnh → review card hiện (BỐ CỤC 2 CỘT: bill to trái, thông số phải)
    await page.setInputFiles('input[type=file]', BILL_IMG);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT, '2-manual-review.png'), fullPage: true });
    await page.screenshot({ path: path.join(OUT, '2v-viewport.png') }); // ĐÚNG 1 khung nhìn PC (chưa cuộn)

    // === BẤM GỬI (không tách) → render ẢNH CARD đại lý/NĐT client-side → /send lưu card-*.png (Admin Demo 31/8) ===
    await page.getByRole('button', { name: /Gửi vào nhóm đại lý/ }).first().click().catch((e) => console.log('[harness] click Gửi lỗi:', e.message));
    await page.waitForTimeout(1500);
    const sentOk = await page.getByText(/Đã gửi nhóm đại lý/).isVisible().catch(() => false);
    console.log(`[harness] Sau bấm Gửi: báo "Đã gửi" visible=${sentOk}`);
    // Reload lại ảnh khác để về trạng thái review sạch cho các test sau.
    await page.setInputFiles('input[type=file]', BILL_IMG);
    await page.waitForTimeout(1200);

    // === KIỂM CHỨNG NÚT GỬI KHI CUỘN (Admin Demo "lăn chuột vẫn mất nút gửi") ===
    // Cuộn container cuộn thật (AppShell) xuống đáy rồi chụp — footer sticky PHẢI giữ nút "Gửi" trong khung nhìn.
    const gui = page.getByRole('button', { name: /Gửi vào nhóm đại lý|Xác nhận tách tiền trước/ }).last();
    await page.mouse.move(600, 400);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 700); await page.waitForTimeout(120); }
    await page.waitForTimeout(300);
    const guiVisibleAfterScroll = await gui.isVisible().catch(() => false);
    const guiBox = await gui.boundingBox().catch(() => null);
    const vh = 800;
    const guiInView = !!guiBox && guiBox.y >= 0 && guiBox.y + guiBox.height <= vh + 2;
    console.log(`[harness] SAU CUỘN: nút Gửi visible=${guiVisibleAfterScroll} inViewport=${guiInView} box=${JSON.stringify(guiBox)}`);
    await page.screenshot({ path: path.join(OUT, '2s-after-scroll-viewport.png') }); // NÚT GỬI phải còn thấy ở đáy

    // Bật tách thẻ + nhập số tiền + BẤM "Xác nhận tách tiền" → phải hiện "Tách tiền thành công"
    const splitCb = page.locator('input[type=checkbox]').first();
    if (await splitCb.count()) {
      await splitCb.check().catch(() => {});
      await page.waitForTimeout(200);
      await page.getByRole('button', { name: /Thêm thẻ khác/ }).click().catch(() => {});
      await page.waitForTimeout(200);
      await page.locator('select').last().selectOption('16').catch(() => {}); // Ngoài MB-Visa-Master
      await page.locator('input[placeholder="số tiền"]').last().fill('10.000.000').catch(() => {});
      await page.waitForTimeout(400);
      // === CHECK LỌC THẺ (Admin Demo "thêm thẻ khác phải loại thẻ mặc định + thẻ đã chọn ra") ===
      // Thêm thẻ khác THỨ 2 → đọc option của select cuối. availableCardTypes = [15 MB(primary), 17 Napas, 16 Visa].
      // Kỳ vọng: KHÔNG có MB(15, thẻ mặc định) và KHÔNG có 16 (đã chọn ở dòng 1) → chỉ còn 17 Napas.
      await page.getByRole('button', { name: /Thêm thẻ khác/ }).click().catch(() => {});
      await page.waitForTimeout(300);
      const lastSelOpts = await page.locator('select').last().locator('option').allInnerTexts().catch(() => [] as string[]);
      const hasDefault = lastSelOpts.some((t) => /^MB$/.test(t.trim()));
      const hasUsed = lastSelOpts.some((t) => /Visa-Master/.test(t));
      console.log(`[harness] LỌC THẺ (select thẻ khác #2) options=${JSON.stringify(lastSelOpts)} · còn thẻ-mặc-định(MB)=${hasDefault} · còn thẻ-đã-chọn(Visa-Master)=${hasUsed}`);
      // Xoá dòng thừa #2 (nút X = svg.lucide-x, dòng cuối) để tiếp tục ca 2-thẻ như cũ.
      await page.locator('button:has(svg.lucide-x)').last().click().catch(() => {});
      await page.waitForTimeout(300);
      // === CHECK INPUT CHỌN FOLDER WEB tồn tại (auto tab) ===
      const folderInputCount = await page.locator('input[webkitdirectory]').count().catch(() => 0);
      console.log(`[harness] INPUT chọn folder web (webkitdirectory) có trong DOM = ${folderInputCount > 0} (count=${folderInputCount})`);
      await page.screenshot({ path: path.join(OUT, '3-split-card.png'), fullPage: true });
      // BẤM xác nhận tách (exact — tránh khớp nhầm nút footer "Xác nhận tách tiền trước khi gửi")
      await page.getByRole('button', { name: 'Xác nhận tách tiền', exact: true }).click().catch((e) => console.log('[harness] click tách lỗi:', e.message));
      await page.waitForTimeout(400);
      const splitOk = await page.getByText(/Tách tiền thành công/).isVisible().catch(() => false);
      console.log(`[harness] Sau bấm "Xác nhận tách tiền": báo "Tách tiền thành công" visible=${splitOk}`);
      const suaVisible = await page.getByRole('button', { name: 'Sửa', exact: true }).isVisible().catch(() => false);
      console.log(`[harness] Nút "Sửa" (chỉnh lại sau khi tách) visible=${suaVisible}`);
      await page.screenshot({ path: path.join(OUT, '3f-split-confirmed.png'), fullPage: true });
      // Ca TÁCH (cao nhất) — cuộn LÊN ĐẦU rồi kiểm nút Gửi CÓ trong khung nhìn (footer sticky không mất nút).
      for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -700); await page.waitForTimeout(80); }
      await page.waitForTimeout(300);
      const guiSplit = page.getByRole('button', { name: /Gửi vào nhóm đại lý|Xác nhận tách tiền trước/ }).last();
      const gsBox = await guiSplit.boundingBox().catch(() => null);
      const gsInView = !!gsBox && gsBox.y >= 0 && gsBox.y + gsBox.height <= 800 + 2;
      console.log(`[harness] CA TÁCH (cuộn lên đầu): nút Gửi inViewport=${gsInView} box=${JSON.stringify(gsBox)}`);
      await page.screenshot({ path: path.join(OUT, '3v-split-viewport.png') });

      // === KIỂM CHỨNG GIỮ STATE QUA MENU (Admin Demo "qua menu là mất") ===
      // Rời sang menu khác (Danh bạ) rồi QUAY LẠI — state tách "Tách tiền thành công" PHẢI còn (sessionStorage).
      await page.goto(`${baseUrl}/app/contacts`, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(500);
      await page.goto(`${baseUrl}/app/ocr-send`, { waitUntil: 'networkidle' }).catch(() => {});
      await page.waitForTimeout(1000);
      const persistOk = await page.getByText(/Tách tiền thành công/).isVisible().catch(() => false);
      const persistBill = await page.getByText('53550081').isVisible().catch(() => false);
      console.log(`[harness] SAU KHI RỜI MENU→QUAY LẠI: bill còn=${persistBill} · tách-thành-công còn=${persistOk}`);
      await page.screenshot({ path: path.join(OUT, '3p-persist-after-menu.png'), fullPage: true });
    }

    // Zoom ảnh (bấm bill → overlay phóng to toàn màn)
    await page.getByText('phóng to', { exact: false }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, '3b-zoom.png') });
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);

    // Tab tự động → quét → log bill mới/cũ
    await page.getByText('Tự động', { exact: false }).click().catch(() => {});
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(OUT, '4a-auto-empty.png'), fullPage: true });
    // CHỌN FOLDER = webkitdirectory (cần ĐƯỜNG DẪN thư mục): tạo folder tạm + copy 3 ảnh bill vào → setInputFiles
    // dir → onFolderPicked → webFiles → ocrAt(0) → card review AUTO (config ẩn, log bên PHẢI cao bằng card).
    const fsp = await import('node:fs/promises');
    const billDir = path.join(OUT, '_billfolder');
    await fsp.mkdir(billDir, { recursive: true });
    for (const nm of ['bill_1.jpg', 'bill_2.jpg', 'bill_3.jpg']) await fsp.writeFile(path.join(billDir, nm), billBytes);
    await page.setInputFiles('input[webkitdirectory]', billDir).catch((e) => console.log('[harness] setInputFiles folder lỗi:', e.message));
    await page.waitForTimeout(3000);
    const autoCardVisible = await page.getByRole('button', { name: /Gửi vào nhóm đại lý/ }).isVisible().catch(() => false);
    const configHidden = !(await page.getByText('Folder bill tải về').isVisible().catch(() => false));
    const autoGui = page.getByRole('button', { name: /Gửi vào nhóm đại lý|Xác nhận tách tiền trước/ }).last();
    const agBox = await autoGui.boundingBox().catch(() => null);
    const agInView = !!agBox && agBox.y >= 0 && agBox.y + agBox.height <= 800 + 2;
    console.log(`[harness] AUTO có card review=${autoCardVisible} · panel-config-ẩn=${configHidden} · nút Gửi inViewport=${agInView} box=${JSON.stringify(agBox)}`);
    await page.screenshot({ path: path.join(OUT, '4-auto-scan.png') });
    await page.screenshot({ path: path.join(OUT, '4f-auto-full.png'), fullPage: true });

    console.log('[harness] Chụp xong ->', OUT);
  } finally {
    await browser?.close();
    server.httpServer.close();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
