// HARNESS (Admin Demo 5/8) — render THẬT ChatListScreen trong Chromium, chứng minh: (1) 2 nút "Phân loại" +
// "Tạo nhóm chat" nổi bật cạnh nhau; (2) bấm "Tạo nhóm chat" → modal mở; (3) chọn 2 bạn (mock) + nhập tên →
// bấm "Tạo nhóm" gọi POST /v1/chat/rooms/group ĐÚNG payload {name, memberAgentIds:[bạn1,bạn2]}. Mock mạng qua
// page.route + inject session localStorage để qua RequireAuth. KHÔNG chạm bot-api thật.
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-create-group');

const MOCK_FRIENDS = [
  {
    requestId: 1, agentId: 101, agentCode: 'A101', agentName: 'Nguyễn Văn An', acceptedAt: '2026-08-01T00:00:00.000Z',
    online: null, dateOfBirth: null, gender: null, rcUsername: 'an101', nickname: null, blockedByMe: false, blockedThem: false, category: null
  },
  {
    requestId: 2, agentId: 202, agentCode: 'B202', agentName: 'Trần Thị Bình', acceptedAt: '2026-08-01T00:00:00.000Z',
    online: null, dateOfBirth: null, gender: null, rcUsername: 'binh202', nickname: null, blockedByMe: false, blockedThem: false, category: null
  },
  {
    requestId: 3, agentId: 303, agentCode: 'C303', agentName: 'Lê Văn Cường', acceptedAt: '2026-08-01T00:00:00.000Z',
    online: null, dateOfBirth: null, gender: null, rcUsername: 'cuong303', nickname: null, blockedByMe: false, blockedThem: false, category: null
  }
];

let capturedGroupBody: unknown = null;

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

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 } });
    const page = await ctx.newPage();

    // Qua RequireAuth (App.tsx) — session cục bộ chỉ cần userId + agentName.
    // + Chặn WebSocket real-time: WS tới bot-api (localhost:8788, KHÔNG chạy) đóng với mã "phiên hết hạn" →
    //   chat-realtime.ts gọi handleSessionExpired() → xóa phiên → đá về /login. page.route KHÔNG chặn WS, nên
    //   thay window.WebSocket bằng bản giả "connecting mãi" (không bao giờ open/close/error) — real-time không
    //   dùng trong luồng này, KHÔNG ảnh hưởng nút/modal.
    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Tôi Test' }));
      class FakeWS {
        readyState = 0;
        addEventListener(): void {}
        removeEventListener(): void {}
        send(): void {}
        close(): void {}
      }
      // @ts-expect-error — thay thế WebSocket toàn cục cho harness.
      window.WebSocket = FakeWS;
    });

    // bot-api THẬT đang chạy trên 8788 → WS `ws://localhost:8788/v1/chat-realtime` kết nối được nhưng bị từ
    // chối (đóng mã 4401 vì cookie phiên không hợp lệ) → chat-realtime.ts gọi handleSessionExpired() → đá về
    // /login. Chặn WS ở tầng Playwright (routeWebSocket): mock giữ kết nối MỞ, KHÔNG nối tới server thật, không
    // bao giờ đóng → không kích hoạt hết phiên. (addInitScript thay window.WebSocket KHÔNG đủ vì app vẫn tạo WS.)
    await page.routeWebSocket(/^ws/, () => {
      /* mock server: không connectToServer, giữ mở, không đóng — real-time im lặng, không dùng trong luồng này */
    });

    // Mock TẤT CẢ request /v1/** tới bot-api (localhost:8788). agentApiFetch trả body THÔ là data; chatFetch
    // bọc {ok,data}. Xem shape từng nhóm ở dưới.
    await page.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const p = url.pathname;
      const method = req.method();

      if (p.endsWith('/v1/me/friends')) {
        // agentApiFetch → body THÔ = FriendListResult.
        return json(route, 200, { friends: MOCK_FRIENDS, incomingRequests: [], outgoingRequests: [] });
      }
      if (p.endsWith('/v1/me/categories')) {
        return json(route, 200, []); // agentApiFetch → mảng thô.
      }
      if (p.endsWith('/v1/chat/rooms/group') && method === 'POST') {
        capturedGroupBody = JSON.parse(req.postData() || 'null');
        // chatFetch → {ok,data}. Trả DTO phòng GROUP mới.
        return json(route, 201, { ok: true, data: { id: 'room-new-group-777', type: 'GROUP', name: 'Nhóm mới tạo', members: [], isGroup: true } });
      }
      if (p.endsWith('/v1/chat/rooms')) {
        return json(route, 200, { ok: true, data: [] }); // chatFetch → danh sách phòng rỗng.
      }
      console.log(`[harness] UNMOCKED /v1: ${method} ${p} → fallback`);
      // Fallback an toàn — chatFetch shape (đa số endpoint còn lại là chat).
      return json(route, 200, { ok: true, data: [] });
    });

    // Bắt MỌI request tới bot-api không đi qua /v1 (vd RC trực tiếp) + response 401 để tìm nguồn hết phiên.
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes(':8788') && !u.includes('/v1/')) console.log(`[harness] req 8788 non-v1: ${r.method()} ${u}`);
    });
    page.on('response', (r) => {
      if (r.status() === 401 || r.status() >= 500) console.log(`[harness] resp ${r.status()}: ${r.url()}`);
    });

    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) console.log(`[harness] nav → ${f.url()}`); });

    // ── B1: danh sách chat + 2 nút ──
    await page.goto(`${baseUrl}/app/chat`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="open-create-group"]', { timeout: 15000 });
    await page.waitForTimeout(600);
    console.log(`[harness] URL sau khi load + chờ: ${page.url()}`);
    const btnManage = page.getByRole('button', { name: 'Phân loại' });
    const btnGroup = page.getByTestId('open-create-group');
    const seesManage = await btnManage.isVisible();
    const seesGroup = await btnGroup.isVisible();
    console.log(`[harness] Thấy nút "Phân loại": ${seesManage} | "Tạo nhóm chat": ${seesGroup}`);
    await page.screenshot({ path: path.join(OUT, '1-chatlist-2-buttons.png') });

    // ── B2: mở modal ──
    await btnGroup.click();
    await page.waitForTimeout(300);
    const modalTitle = page.getByRole('heading', { name: 'Tạo nhóm chat mới' });
    const modalOpen = await modalTitle.isVisible();
    console.log(`[harness] Modal "Tạo nhóm chat mới" mở: ${modalOpen}`);
    await page.screenshot({ path: path.join(OUT, '2-modal-open.png') });

    // ── B3: chọn 2 bạn + nhập tên ──
    await page.getByTestId('friend-pick-101').click();
    await page.getByTestId('friend-pick-202').click();
    const nameInput = page.getByTestId('group-name-input');
    await nameInput.fill('Nhóm Kiểm Thử ABC');
    await page.waitForTimeout(200);
    await page.screenshot({ path: path.join(OUT, '3-selected-2-friends.png') });

    // ── B4: bấm Tạo nhóm → verify payload ──
    await page.getByTestId('group-create-submit').click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(OUT, '4-after-submit.png') });

    console.log(`[harness] POST payload đã bắt: ${JSON.stringify(capturedGroupBody)}`);
    console.log(`[harness] Console errors: ${errors.length ? JSON.stringify(errors) : '(none)'}`);

    // Kết luận (assertion cứng — thoát code != 0 nếu sai).
    const ok =
      seesManage && seesGroup && modalOpen &&
      !!capturedGroupBody &&
      (capturedGroupBody as { name?: string }).name === 'Nhóm Kiểm Thử ABC' &&
      JSON.stringify((capturedGroupBody as { memberAgentIds?: number[] }).memberAgentIds) === JSON.stringify([101, 202]);
    console.log(`[harness] KẾT QUẢ: ${ok ? 'PASS' : 'FAIL'}`);
    if (!ok) process.exitCode = 1;

    await ctx.close();
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((e) => { console.error('[harness] LỖI:', e); process.exitCode = 1; });
