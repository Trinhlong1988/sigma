// HARNESS TÁI HIỆN BUG "đăng xuất bị KẸT" (Admin Demo 11/9): bấm Đăng xuất → app phải VỀ MÀN LOGIN + dọn sạch
// storage TRONG ≤3s, KỂ CẢ khi server logout TREO (mock không bao giờ trả lời). Đo:
//   1. Ca A (server trả lời bình thường): thời gian bấm→về /login, storage sạch, đăng nhập LẠI được ngay.
//   2. Ca B (server TREO — mọi request /v1/** sau lúc bấm Đăng xuất KHÔNG BAO GIỜ trả lời): app vẫn phải về
//      /login ≤3s (logout client-first, server call best-effort) + liệt kê request còn PENDING làm bằng chứng.
//   3. Đếm request /v1/** PHÁT SINH SAU khi đã về /login (leak interval/WS của phiên cũ còn chạy).
// Chạy: node --import tsx scripts/harness-logout.ts   (mẫu: harness-card-notice.ts)
import { createServer } from 'vite';
import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-logout');

const ME = { id: 22, code: 'DL22', name: 'Nguyen Van A', rcUserId: 'u-me', rcUsername: 'nguoidungdemo' };

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

interface KetQuaCa {
  ten: string;
  msVeLogin: number | null; // thời gian bấm Đăng xuất (confirm) → login form hiển thị; null = KHÔNG về được (KẸT)
  storageSach: boolean;
  storageConLai: string[];
  pendingLucDo: string[]; // request /v1/** còn treo tại mốc +3s
  requestSauLogin: string[]; // request /v1/** PHÁT SINH sau khi đã về login (leak phiên cũ)
  consoleErrors: string[];
}

/** Dựng context đã "đăng nhập giả" (localStorage session + sessionStorage auth-me) + mock /v1/**. `hangRef`
 * bật true → MỌI request /v1/** từ đó về sau treo vĩnh viễn (mô phỏng server chết đúng lúc bấm Đăng xuất). */
async function dungTrang(
  browser: Browser,
  baseUrl: string,
  hangRef: { hang: boolean },
  pending: Map<string, string>,
  consoleErrors: string[]
): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const page = await ctx.newPage();
  page.on('console', (m) => {
    if (m.type() === 'error' && !/chat-realtime|real-time|AppShell|hết hạn|WebSocket/i.test(m.text())) consoleErrors.push(m.text());
    if (process.env.DEBUG_LOGOUT && /\[nav\]/.test(m.text())) console.log('  [trang]', m.text());
  });
  page.on('pageerror', (e) => {
    consoleErrors.push(`PAGEERROR: ${e.message}`);
    if (process.env.DEBUG_LOGOUT) console.log('  [pageerror]', e.stack || e.message);
  });
  if (process.env.DEBUG_LOGOUT) page.on('framenavigated', (f) => console.log('  [framenavigated]', f.url()));
  await page.addInitScript({
    content: [
      "window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Nguyen Van A' }));",
      `window.sessionStorage.setItem('sigma_auth_me_v1', JSON.stringify(${JSON.stringify(ME)}));`,
      // FakeWS như harness-card-notice.ts — chat-realtime/call-signaling mở WS thật sẽ treo vô hại.
      'function FakeWS(){ this.readyState = 0; }',
      'FakeWS.prototype.addEventListener = function(){};',
      'FakeWS.prototype.removeEventListener = function(){};',
      'FakeWS.prototype.send = function(){};',
      'FakeWS.prototype.close = function(){};',
      'window.WebSocket = FakeWS;',
      // DEBUG: soi mọi pushState/replaceState (react-router navigate đi qua đây) kèm stack rút gọn.
      "(function(){ var p = history.pushState.bind(history), r = history.replaceState.bind(history);",
      "history.pushState = function(s,t,u){ console.log('[nav] pushState → ' + u + ' | ' + new Error('x').stack.split(String.fromCharCode(10)).slice(2,5).join(' <= ')); return p(s,t,u); };",
      "history.replaceState = function(s,t,u){ console.log('[nav] replaceState → ' + u + ' | ' + new Error('x').stack.split(String.fromCharCode(10)).slice(2,5).join(' <= ')); return r(s,t,u); }; })();",
      // DEBUG: soi mọi lần đọc session (RequireAuth/RootRedirect) — biết guard có chạy lại sau pop-back không.
      "(function(){ var g = Storage.prototype.getItem; Storage.prototype.getItem = function(k){ var v = g.call(this, k); if (k === 'sigma_session') console.log('[nav] getSession → ' + (v ? 'CÓ' : 'null') + ' | ' + new Error('x').stack.split(String.fromCharCode(10)).slice(2,4).join(' <= ')); return v; }; })();",
      // DEBUG: log MỌI popstate (đăng ký TRƯỚC cả react-router lẫn back-intercept) — biết pop có bắn event không.
      "window.addEventListener('popstate', function(e){ console.log('[nav] popstate state=' + JSON.stringify(e.state) + ' url=' + location.pathname); });"
    ].join(String.fromCharCode(10))
  });
  await page.routeWebSocket(/^ws/, () => { /* nuốt */ });
  // Theo dõi request /v1/** pending: thêm lúc bắn, xóa lúc xong/fail → còn lại = đang treo.
  let seq = 0;
  page.on('request', (r) => { const u = r.url(); if (u.includes('/v1/')) pending.set(`${u}#${seq++}`, u); });
  const done = (r: { url(): string }): void => {
    const u = r.url();
    if (!u.includes('/v1/')) return;
    for (const [k, v] of pending) { if (v === u) { pending.delete(k); break; } }
  };
  page.on('requestfinished', done);
  page.on('requestfailed', done);
  await page.route('**/v1/**', async (route) => {
    if (hangRef.hang) return; // server TREO: không fulfill, không continue — request pending vĩnh viễn.
    const p = new URL(route.request().url()).pathname;
    const method = route.request().method();
    if (p.endsWith('/v1/auth/web-logout')) return json(route, 200, { ok: true });
    if (p.endsWith('/v1/me/friends')) return json(route, 200, { friends: [], incomingRequests: [], outgoingRequests: [] });
    if (p.endsWith('/v1/auth/web-login')) return json(route, 200, { ok: true });
    if (p.endsWith('/v1/auth/me')) return json(route, 200, { agent: ME });
    const listLike = /friends|categories|rooms|contacts|birthday|notifications|feed|comments|reactions|members|tids|list/i.test(p);
    return json(route, 200, method === 'GET' && listLike ? [] : {});
  });
  return { ctx, page };
}

/** Trạng thái storage sau đăng xuất: session + auth-me PHẢI biến mất (sigma_device_token được PHÉP ở lại
 * — vé thiết bị, cố ý sống lâu hơn phiên, xem session.ts). Trả danh sách key sigma_* còn lại để đối chiếu. */
async function soiStorage(page: Page): Promise<{ sach: boolean; conLai: string[] }> {
  return page.evaluate(() => {
    const conLai: string[] = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith('sigma')) conLai.push(`local:${k}`); }
    for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); if (k?.startsWith('sigma')) conLai.push(`session:${k}`); }
    const sach = !localStorage.getItem('sigma_session') && !sessionStorage.getItem('sigma_auth_me_v1');
    return { sach, conLai };
  });
}

async function chayCa(browser: Browser, baseUrl: string, ten: string, serverTreo: boolean, thuDangNhapLai: boolean): Promise<KetQuaCa> {
  const hangRef = { hang: false };
  const pending = new Map<string, string>();
  const consoleErrors: string[] = [];
  const { ctx, page } = await dungTrang(browser, baseUrl, hangRef, pending, consoleErrors);
  const kq: KetQuaCa = { ten, msVeLogin: null, storageSach: false, storageConLai: [], pendingLucDo: [], requestSauLogin: [], consoleErrors };
  try {
    await page.goto(`${baseUrl}/app/chat`, { waitUntil: 'networkidle' }).catch(() => { /* networkidle có thể không tới nếu WS retry — bỏ qua */ });
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${ten}-01-truoc.png`) });

    // Sidebar desktop (lg:flex) → nút "Đăng xuất" cuối sidebar → ConfirmDialog → nút confirm class btn-danger.
    await page.getByRole('button', { name: 'Đăng xuất' }).first().click();
    await page.locator('button.btn-danger', { hasText: 'Đăng xuất' }).waitFor({ state: 'visible', timeout: 5000 });
    await page.screenshot({ path: path.join(OUT, `${ten}-02-dialog.png`) });

    if (serverTreo) hangRef.hang = true; // từ ĐÚNG lúc bấm confirm, server chết hẳn.
    const t0 = Date.now();
    await page.locator('button.btn-danger', { hasText: 'Đăng xuất' }).click();

    // Poll 50ms: về /login + form đăng nhập hiển thị thì chốt thời gian. Trần đo 10s (>3s = FAIL nhưng vẫn đo).
    let veLoginLuc: number | null = null;
    while (Date.now() - t0 < 10_000) {
      const url = page.url();
      if (url.includes('/login')) {
        const formThay = await page.getByRole('button', { name: /Đăng nhập/ }).first().isVisible().catch(() => false);
        if (formThay) { veLoginLuc = Date.now() - t0; break; }
      }
      await page.waitForTimeout(50);
    }
    kq.msVeLogin = veLoginLuc;

    if (process.env.DEBUG_LOGOUT && veLoginLuc === null) {
      // Đang KẸT — probe: React còn sống không? (bấm "Cài đặt" sidebar xem URL có đổi) + soi history.
      const hs = await page.evaluate(() => ({ len: history.length, state: JSON.stringify(history.state), url: location.pathname }));
      console.log('  [probe] history khi kẹt:', JSON.stringify(hs));
      await page.getByRole('button', { name: 'Cài đặt' }).first().click().catch((e) => console.log('  [probe] click Cài đặt lỗi:', String(e).slice(0, 120)));
      await page.waitForTimeout(700);
      console.log('  [probe] URL sau khi bấm "Cài đặt":', page.url());
    }

    // Mốc +3s kể từ bấm: chụp ảnh + soi storage + request treo (đúng đề bài "đo trạng thái sau 3s").
    const conCho = 3000 - (Date.now() - t0);
    if (conCho > 0) await page.waitForTimeout(conCho);
    const pendingSnapshot = [...new Set(pending.values())];
    const truocDem = new Set(pending.keys());
    await page.screenshot({ path: path.join(OUT, `${ten}-03-sau-3s.png`) });
    const st = await soiStorage(page);
    kq.storageSach = st.sach;
    kq.storageConLai = st.conLai;
    kq.pendingLucDo = pendingSnapshot;

    // Leak sau login: đếm request /v1/** MỚI trong 3s tiếp theo (interval/WS phiên cũ còn sống?).
    if (veLoginLuc !== null) {
      const demTruoc = pending.size + truocDem.size; // mọi key từng thấy đã ghi vào pending rồi xóa — theo dõi qua listener mới:
      const moi: string[] = [];
      const ghiMoi = (r: { url(): string }): void => { const u = r.url(); if (u.includes('/v1/')) moi.push(new URL(u).pathname); };
      page.on('request', ghiMoi);
      await page.waitForTimeout(3000);
      page.off('request', ghiMoi);
      kq.requestSauLogin = moi;
      void demTruoc;
    }

    // Ca A: chứng minh KHÔNG cần kill app — đăng nhập lại NGAY trên cùng trang phải vào lại /app/chat.
    if (thuDangNhapLai && veLoginLuc !== null && !serverTreo) {
      await page.getByPlaceholder('ban@vidu.com hoặc 09xxxxxxxx').fill('user11@example.com');
      await page.locator('input[type="password"]').first().fill('matkhau123');
      await page.locator('button[type="submit"]', { hasText: 'Đăng nhập' }).click(); // nút submit, KHÔNG phải tab "Đăng nhập" ở đầu form.
      await page.waitForURL('**/app/chat**', { timeout: 8000 }).catch(async (e) => {
        await page.screenshot({ path: path.join(OUT, `${ten}-04-dang-nhap-lai-FAIL.png`) });
        throw e;
      });
      await page.screenshot({ path: path.join(OUT, `${ten}-04-dang-nhap-lai.png`) });
      console.log(`  ✅ [${ten}] Đăng nhập LẠI ngay sau đăng xuất: OK (về /app/chat, không cần kill app)`);
    }
  } finally {
    await ctx.close();
  }
  return kq;
}

function inKetQua(kq: KetQuaCa): boolean {
  let pass = true;
  console.log(`\n── Ca "${kq.ten}" ──`);
  if (kq.msVeLogin === null) { console.log('  ❌ KẸT: KHÔNG về màn đăng nhập trong 10s (đúng bug Admin Demo báo)'); pass = false; }
  else if (kq.msVeLogin > 3000) { console.log(`  ❌ Về login quá chậm: ${kq.msVeLogin}ms (> 3000ms)`); pass = false; }
  else console.log(`  ✅ Bấm Đăng xuất → login form hiển thị: ${kq.msVeLogin}ms`);
  if (!kq.storageSach) { console.log(`  ❌ Storage CHƯA sạch sau 3s`); pass = false; }
  else console.log('  ✅ localStorage sigma_session + sessionStorage sigma_auth_me_v1 đã xóa');
  const conLaiLa = kq.storageConLai.filter((k) => k !== 'local:sigma_device_token');
  if (conLaiLa.length) console.log(`  ℹ Key sigma_* còn lại (ngoài device_token hợp lệ): ${conLaiLa.join(', ')}`);
  if (kq.pendingLucDo.length) console.log(`  ℹ Request /v1/** còn TREO tại mốc +3s (chấp nhận nếu là web-logout best-effort): ${kq.pendingLucDo.map((u) => new URL(u).pathname).join(', ')}`);
  else console.log('  ✅ Không request /v1/** nào còn treo tại mốc +3s');
  if (kq.requestSauLogin.length) console.log(`  ⚠ Request /v1/** PHÁT SINH SAU khi đã về login (nghi leak phiên cũ): ${[...new Set(kq.requestSauLogin)].join(', ')} (${kq.requestSauLogin.length} lượt/3s)`);
  else console.log('  ✅ 0 request /v1/** phát sinh sau khi về login (không leak interval/WS phiên cũ)');
  if (kq.consoleErrors.length) console.log(`  ⚠ Console/page error: ${kq.consoleErrors.slice(0, 5).join(' | ')}`);
  return pass;
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });
  const server = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), logLevel: 'error', server: { port: 0 } });
  await server.listen();
  const baseUrl = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '') || 'http://localhost:5173';
  let browser: Browser | undefined;
  let pass = true;
  try {
    browser = await chromium.launch();
    const caA = await chayCa(browser, baseUrl, 'A-server-ok', false, true);
    const caB = await chayCa(browser, baseUrl, 'B-server-treo', true, false);
    const passA = inKetQua(caA);
    const passB = inKetQua(caB); // in RIÊNG từng ca — không && trực tiếp kẻo short-circuit nuốt báo cáo ca B.
    pass = passA && passB && pass;
  } finally {
    await browser?.close();
    await server.close();
  }
  console.log(pass ? '\n═══ HARNESS LOGOUT: PASS (số liệu ở trên — LEAD tự nghiệm thu, harness không tự tick xanh) ═══' : '\n═══ HARNESS LOGOUT: FAIL ═══');
  process.exitCode = pass ? 0 : 1;
}

main().catch((err) => { console.error(err); process.exitCode = 1; });
