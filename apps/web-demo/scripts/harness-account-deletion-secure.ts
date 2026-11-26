// HARNESS (bảo mật 6/8) — render THẬT AccountSecurityScreen (SOURCE hiện tại, KHÔNG phải bản build cũ trên
// :57903) để chứng minh luồng xóa tài khoản 2 BƯỚC có xác thực:
//   B1: bấm "Xóa tài khoản" → modal "Bước 1/2" hiện ô NHẬP MẬT KHẨU.
//   B2: nhập mật khẩu → (MOCK send-otp {ok:true}, KHÔNG gửi OTP thật) → modal "Bước 2/2" hiện ô OTP + MÃ 2 SỐ.
// Mock mạng qua page.route + inject session localStorage để qua RequireAuth. KHÔNG chạm bot-api thật.
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-account-deletion-secure');

async function json(route: Route, status: number, body: unknown): Promise<void> {
  await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function main(): Promise<void> {
  await mkdir(OUT, { recursive: true });

  const server: ViteDevServer = await createServer({ root: ROOT, configFile: path.join(ROOT, 'vite.config.ts'), server: { port: 0 } });
  await server.listen();
  const addr = server.httpServer?.address();
  const port = typeof addr === 'object' && addr ? addr.port : 5173;
  const baseUrl = `http://localhost:${port}`;
  console.log(`[harness] Vite dev ở ${baseUrl}`);

  let sendOtpCalls = 0;

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
    const page = await ctx.newPage();

    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Tôi Test' }));
      class FakeWS {
        readyState = 0;
        addEventListener(): void {}
        removeEventListener(): void {}
        send(): void {}
        close(): void {}
      }
      // @ts-expect-error — thay WebSocket toàn cục cho harness.
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* giữ mở, không nối server thật */ });

    await page.route('**/v1/**', async (route) => {
      const req = route.request();
      const p = new URL(req.url()).pathname;
      const method = req.method();

      if (p.endsWith('/v1/me/deletion-status')) {
        return json(route, 200, { deletionRequestedAt: null, deleteAt: null });
      }
      if (p.endsWith('/v1/me/sessions')) {
        return json(route, 200, { items: [] });
      }
      if (p.endsWith('/v1/me/request-deletion/send-otp') && method === 'POST') {
        sendOtpCalls += 1;
        console.log(`[harness] MOCK send-otp #${sendOtpCalls} payload=${req.postData()}`);
        return json(route, 200, { ok: true }); // MOCK: coi như mật khẩu đúng + đã gửi OTP (không gửi thật).
      }
      // Các endpoint AppShell/TopBar cần đúng shape (nếu trả {} sẽ crash blank cả shell).
      if (p.endsWith('/v1/me/friends')) {
        return json(route, 200, { friends: [], incomingRequests: [], outgoingRequests: [] });
      }
      if (p.endsWith('/v1/me/categories')) {
        return json(route, 200, []);
      }
      if (p.endsWith('/v1/me/notifications')) {
        return json(route, 200, { items: [], unreadCount: 0 });
      }
      if (p.includes('/v1/chat/')) {
        return json(route, 200, { ok: true, data: [] });
      }
      console.log(`[harness] UNMOCKED /v1: ${method} ${p} → fallback {ok,data:[]}`);
      return json(route, 200, { ok: true, data: [] });
    });

    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log(`[harness] console.error: ${m.text()}`); } });
    page.on('pageerror', (e) => { errors.push(e.message); console.log(`[harness] pageerror: ${e.message}`); });

    // ── Mở màn Bảo mật ──
    await page.goto(`${baseUrl}/app/security`, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    console.log(`[harness] URL=${page.url()}`);
    await page.screenshot({ path: path.join(OUT, 'diag-after-load.png'), fullPage: true });
    console.log(`[harness] BODY TEXT >>>\n${(await page.locator('body').innerText()).slice(0, 800)}\n<<<`);
    const deleteBtn = page.getByRole('button', { name: 'Xóa tài khoản' });
    await deleteBtn.waitFor({ timeout: 15000 });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, '0-security-screen.png') });

    // ── B1: bấm Xóa tài khoản → modal Bước 1/2 (nhập mật khẩu) ──
    await deleteBtn.click();
    await page.getByRole('heading', { name: 'Xóa tài khoản — Bước 1/2' }).waitFor({ timeout: 5000 });
    const pwInput = page.getByPlaceholder('Nhập mật khẩu đăng nhập của bạn');
    const seesPassword = await pwInput.isVisible();
    const sendOtpBtn = page.getByRole('button', { name: 'Gửi mã OTP' });
    const sendDisabledEmpty = await sendOtpBtn.isDisabled(); // nút gửi phải KHÓA khi chưa nhập mật khẩu
    console.log(`[harness] B1 thấy ô mật khẩu: ${seesPassword} | nút "Gửi mã OTP" khóa khi rỗng: ${sendDisabledEmpty}`);
    await page.screenshot({ path: path.join(OUT, '1-step-password.png') });

    // ── B2: nhập mật khẩu → gửi (mock) → modal Bước 2/2 (OTP + mã 2 số) ──
    await pwInput.fill('Secret123!');
    await sendOtpBtn.click();
    await page.getByRole('heading', { name: 'Xóa tài khoản — Bước 2/2' }).waitFor({ timeout: 5000 });
    const otpInput = page.getByPlaceholder('Ví dụ: 123456');
    const confirmNumEl = page.getByTestId('delete-confirm-number');
    const seesOtp = await otpInput.isVisible();
    const seesConfirmNum = await confirmNumEl.isVisible();
    const confirmNumText = (await confirmNumEl.textContent())?.trim() ?? '';
    const confirmInput = page.getByPlaceholder('Gõ lại 2 số ở trên');
    const seesConfirmInput = await confirmInput.isVisible();
    const confirmBtn = page.getByRole('button', { name: 'Xác nhận xóa' });
    const confirmDisabledInitially = await confirmBtn.isDisabled(); // phải KHÓA khi chưa nhập OTP + mã 2 số
    console.log(`[harness] B2 thấy ô OTP: ${seesOtp} | thấy mã 2 số hiển thị: ${seesConfirmNum} ("${confirmNumText}") | ô gõ lại: ${seesConfirmInput} | nút "Xác nhận xóa" khóa ban đầu: ${confirmDisabledInitially}`);
    await page.screenshot({ path: path.join(OUT, '2-step-otp-confirm.png') });

    // Nhập OTP + đúng mã 2 số → nút "Xác nhận xóa" (đỏ) BẬT (KHÔNG bấm — không xóa thật).
    await otpInput.fill('123456');
    await confirmInput.fill(confirmNumText);
    await page.waitForTimeout(200);
    const confirmEnabledAfter = await confirmBtn.isEnabled();
    const confirmClass = (await confirmBtn.getAttribute('class')) ?? '';
    console.log(`[harness] B2 sau khi nhập đủ: nút "Xác nhận xóa" bật=${confirmEnabledAfter} | class chứa btn-danger=${confirmClass.includes('btn-danger')}`);
    await page.screenshot({ path: path.join(OUT, '3-confirm-enabled.png') });

    console.log(`[harness] Console errors: ${errors.length ? JSON.stringify(errors) : '(none)'}`);

    const ok =
      seesPassword && sendDisabledEmpty &&
      sendOtpCalls === 1 &&
      seesOtp && seesConfirmNum && /^\d{2}$/.test(confirmNumText) && seesConfirmInput &&
      confirmDisabledInitially && confirmEnabledAfter && confirmClass.includes('btn-danger');
    console.log(`[harness] KẾT QUẢ: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) process.exitCode = 1;

    await ctx.close();
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((e) => { console.error('[harness] LỖI:', e); process.exitCode = 1; });
