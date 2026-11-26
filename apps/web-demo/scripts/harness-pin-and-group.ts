// HARNESS (5/8) — render THẬT ConversationScreen + PinBoardPanel + GroupInfoPanel trong Chromium để chứng minh
// "nhóm chat đầy đủ như Zalo": (1) banner tin ghim + PinBoardPanel liệt kê NHIỀU tin ghim (nội dung+người+giờ);
// (2) GroupInfoPanel hiện avatar nhóm + số "x/max thành viên" + toggle Duyệt thành viên + ô Giới hạn + danh
// sách yêu cầu vào nhóm (Duyệt/Từ chối) + quản lý vai trò (Đặt Phó/Trưởng nhóm). Mock toàn bộ /v1 qua page.route
// + seed session localStorage + mock WebSocket (KHÔNG chạm bot-api thật). CHỤP ẢNH từng bước.
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type Route } from 'playwright';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'screenshots', 'harness-pin-and-group');

const ROOM_ID = 'room-group-1';
const MY_ID = 10;

// Danh bạ bạn bè (buildAgentNameResolver → /v1/me/friends) — gồm cả thành viên nhóm lẫn người xin vào để tên
// hiển thị đẹp thay vì "Đại lý #id".
const FRIENDS = [
  { requestId: 1, agentId: 10, agentCode: 'A010', agentName: 'Tôi (Trưởng nhóm)', acceptedAt: '2026-08-01T00:00:00.000Z', online: null, dateOfBirth: null, gender: null, rcUsername: 'me10', nickname: null, blockedByMe: false, blockedThem: false, category: null },
  { requestId: 2, agentId: 20, agentCode: 'B020', agentName: 'Trần Thị Bình', acceptedAt: '2026-08-01T00:00:00.000Z', online: null, dateOfBirth: null, gender: null, rcUsername: 'binh20', nickname: null, blockedByMe: false, blockedThem: false, category: null },
  { requestId: 3, agentId: 30, agentCode: 'C030', agentName: 'Lê Văn Cường', acceptedAt: '2026-08-01T00:00:00.000Z', online: null, dateOfBirth: null, gender: null, rcUsername: 'cuong30', nickname: null, blockedByMe: false, blockedThem: false, category: null },
  { requestId: 4, agentId: 40, agentCode: 'D040', agentName: 'Phạm Văn Dũng', acceptedAt: '2026-08-01T00:00:00.000Z', online: null, dateOfBirth: null, gender: null, rcUsername: 'dung40', nickname: null, blockedByMe: false, blockedThem: false, category: null },
  { requestId: 5, agentId: 50, agentCode: 'E050', agentName: 'Vũ Thị Em', acceptedAt: '2026-08-01T00:00:00.000Z', online: null, dateOfBirth: null, gender: null, rcUsername: 'em50', nickname: null, blockedByMe: false, blockedThem: false, category: null }
];

function member(agentId: number, role: string) {
  return { id: agentId, roomId: ROOM_ID, agentId, role, joinedAt: '2026-07-01T00:00:00.000Z', leftAt: null, lastReadMessageId: null, mutedUntil: null };
}
function embeddedMember(agentId: number, role: string) {
  return { agentId, role, joinedAt: '2026-07-01T00:00:00.000Z', leftAt: null, lastReadMessageId: null, mutedUntil: null };
}
const MEMBERS = [member(10, 'OWNER'), member(20, 'ADMIN'), member(30, 'MEMBER')];

const ROOM_DETAIL = {
  id: ROOM_ID, type: 'GROUP', name: 'Nhóm Đại Lý Miền Bắc', avatarColor: '#7c3aed', avatarUrl: null,
  directPairKey: null, pinnedMessageId: 'msg-1', lastMessageAt: '2026-08-05T03:00:00.000Z',
  readOnly: false, requireApproval: true, maxMembers: 20, createdBy: 10,
  createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-08-05T03:00:00.000Z',
  members: [embeddedMember(10, 'OWNER'), embeddedMember(20, 'ADMIN'), embeddedMember(30, 'MEMBER')]
};

const ROOM_SUMMARY = {
  id: ROOM_ID, type: 'GROUP', name: 'Nhóm Đại Lý Miền Bắc', otherAgentId: null, avatarColor: '#7c3aed',
  avatarUrl: null, pinnedMessageId: 'msg-1', lastMessageAt: '2026-08-05T03:00:00.000Z',
  lastMessage: { id: 'msg-3', kind: 'TEXT', body: 'Cảm ơn cả nhà', senderId: 20, createdAt: '2026-08-05T03:00:00.000Z' },
  unreadCount: 0, myRole: 'OWNER'
};

function chatMsg(id: string, senderId: number, body: string, kind = 'TEXT', metadataJson: string | null = null, attachmentId: string | null = null) {
  return { id, roomId: ROOM_ID, senderId, kind, body, attachmentId, metadataJson, replyToMessageId: null, forwardedFromMessageId: null, editedAt: null, deletedAt: null, createdAt: '2026-08-05T02:5' + id.slice(-1) + ':00.000Z', attachmentMimeType: null, attachmentSizeBytes: null };
}
const MESSAGES = [
  chatMsg('msg-1', 20, 'Lịch giao hàng tuần này: thứ 3 và thứ 6, mọi người chú ý nhé!'),
  chatMsg('msg-2', 10, 'Số hotline hỗ trợ mới: 1900-xxxx'),
  chatMsg('msg-3', 20, 'Cảm ơn cả nhà')
];

// "Bảng tin" — NHIỀU tin ghim, đủ loại (TEXT + IMAGE bill + FILE), người ghim khác nhau.
function pinMsg(id: string, kind: string, body: string | null, metadataJson: string | null = null) {
  return { id, kind, body, senderId: 20, attachmentId: kind === 'TEXT' ? null : 'att-' + id, metadataJson, createdAt: '2026-08-05T02:50:00.000Z' };
}
const PINS = [
  { id: 1, roomId: ROOM_ID, messageId: 'msg-1', pinnedByAgentId: 10, pinnedAt: '2026-08-05T03:10:00.000Z', message: pinMsg('msg-1', 'TEXT', 'Lịch giao hàng tuần này: thứ 3 và thứ 6, mọi người chú ý nhé!') },
  { id: 2, roomId: ROOM_ID, messageId: 'msg-9', pinnedByAgentId: 20, pinnedAt: '2026-08-05T03:05:00.000Z', message: pinMsg('msg-9', 'IMAGE', 'POS 12.000.000', JSON.stringify({ isBillImage: true })) },
  { id: 3, roomId: ROOM_ID, messageId: 'msg-8', pinnedByAgentId: 10, pinnedAt: '2026-08-05T03:00:00.000Z', message: pinMsg('msg-8', 'FILE', 'Bang_gia_thang_8.xlsx') }
];

const JOIN_REQUESTS = [
  { id: 1, roomId: ROOM_ID, agentId: 40, status: 'PENDING', requestedAt: '2026-08-05T02:00:00.000Z', decidedBy: null, decidedAt: null },
  { id: 2, roomId: ROOM_ID, agentId: 50, status: 'PENDING', requestedAt: '2026-08-05T02:30:00.000Z', decidedBy: null, decidedAt: null }
];

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
  const results: Record<string, boolean> = {};
  try {
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 860, height: 940 } });
    const page = await ctx.newPage();

    await page.addInitScript(() => {
      window.localStorage.setItem('sigma_session', JSON.stringify({ userId: 'u-me', agentName: 'Tôi (Trưởng nhóm)' }));
      class FakeWS { readyState = 0; addEventListener(): void {} removeEventListener(): void {} send(): void {} close(): void {} }
      // @ts-expect-error thay WebSocket toàn cục cho harness.
      window.WebSocket = FakeWS;
    });
    await page.routeWebSocket(/^ws/, () => { /* giữ mở, không đóng — real-time im lặng */ });

    await page.route('**/v1/**', async (route) => {
      const req = route.request();
      const url = new URL(req.url());
      const p = url.pathname;
      const method = req.method();

      if (p.endsWith('/v1/auth/me')) return json(route, 200, { agent: { id: MY_ID, code: 'A010', name: 'Tôi (Trưởng nhóm)', rcUserId: 'u-me', rcUsername: 'me10' } });
      if (p.endsWith('/v1/me/friends')) return json(route, 200, { friends: FRIENDS, incomingRequests: [], outgoingRequests: [] });
      if (p.endsWith('/v1/me/categories')) return json(route, 200, []);
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}/pins`) && method === 'GET') return json(route, 200, { ok: true, data: PINS });
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}/join-requests`) && method === 'GET') return json(route, 200, { ok: true, data: JOIN_REQUESTS });
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}/members`) && method === 'GET') return json(route, 200, { ok: true, data: MEMBERS });
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}/messages/reactions`)) return json(route, 200, { ok: true, data: {} });
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}/messages`) && method === 'GET') return json(route, 200, { ok: true, data: { messages: MESSAGES, hasMore: false } });
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}/avatar`)) return json(route, 404, { ok: false, error: 'NOT_FOUND', message: 'Nhóm chưa có ảnh đại diện.' });
      if (p.endsWith(`/v1/chat/rooms/${ROOM_ID}`) && method === 'GET') return json(route, 200, { ok: true, data: ROOM_DETAIL });
      if (p.endsWith('/v1/chat/rooms') && method === 'GET') return json(route, 200, { ok: true, data: [ROOM_SUMMARY] });
      console.log(`[harness] UNMOCKED /v1: ${method} ${p}`);
      return json(route, 200, { ok: true, data: [] });
    });

    const errors: string[] = [];
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

    // ── B1: mở hội thoại nhóm → banner tin ghim ──
    await page.goto(`${baseUrl}/app/chat/${ROOM_ID}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('[data-testid="pinned-banner-jump"]', { timeout: 15000 });
    await page.waitForTimeout(500);
    results.pinnedBanner = await page.getByTestId('pinned-banner-jump').isVisible();
    results.pinnedBannerCount = await page.getByTestId('open-pin-board').textContent().then((t) => (t ?? '').includes('(3)'));
    await page.screenshot({ path: path.join(OUT, '1-conversation-pinned-banner.png') });
    console.log(`[harness] banner ghim hiển thị: ${results.pinnedBanner} | "Xem tất cả (3)": ${results.pinnedBannerCount}`);

    // ── B2: mở PinBoardPanel → list 3 tin ghim ──
    await page.getByTestId('open-pin-board').click();
    await page.waitForTimeout(400);
    const pinItems = await page.locator('[data-testid^="pin-jump-"]').count();
    const unpinBtns = await page.locator('[data-testid^="pin-remove-"]').count();
    results.pinBoardCount3 = pinItems === 3;
    results.pinBoardUnpin3 = unpinBtns === 3; // OWNER thấy nút bỏ ghim mỗi tin.
    await page.screenshot({ path: path.join(OUT, '2-pinboard-list.png') });
    console.log(`[harness] PinBoardPanel: ${pinItems} tin ghim, ${unpinBtns} nút bỏ ghim (OWNER)`);
    // đóng pin board (nút X có aria-label rõ ràng, tránh phụ thuộc click backdrop dễ lệch)
    await page.getByLabel('Đóng bảng tin').click();
    await page.waitForTimeout(400);

    // ── B3: mở GroupInfoPanel → avatar + số thành viên + duyệt + limit + yêu cầu vào nhóm + vai trò ──
    await page.getByRole('button', { name: 'Thông tin hội thoại' }).click();
    await page.waitForTimeout(500);
    results.avatarChangeBtn = await page.getByTestId('change-group-avatar').isVisible();
    results.approvalToggle = await page.getByTestId('toggle-require-approval').isVisible();
    results.maxMembersInput = await page.getByTestId('max-members-input').isVisible();
    results.maxMembersValue = await page.getByTestId('max-members-input').inputValue().then((v) => v === '20');
    results.joinReq40 = await page.getByTestId('approve-join-40').isVisible();
    results.joinReq50 = await page.getByTestId('reject-join-50').isVisible();
    results.roleControls = await page.getByTestId('role-owner-20').isVisible(); // OWNER thấy "Đặt Trưởng nhóm" cho người khác
    await page.screenshot({ path: path.join(OUT, '3-groupinfo-full.png'), fullPage: true });
    console.log(`[harness] GroupInfo: avatarBtn=${results.avatarChangeBtn} approval=${results.approvalToggle} limit=${results.maxMembersInput}(=${results.maxMembersValue}) join40=${results.joinReq40} join50=${results.joinReq50} role=${results.roleControls}`);

    console.log(`[harness] Console errors: ${errors.length ? JSON.stringify(errors.slice(0, 5)) : '(none)'}`);
    const ok = Object.values(results).every(Boolean);
    console.log(`[harness] KẾT QUẢ TỔNG: ${ok ? 'PASS' : 'FAIL'} — ${JSON.stringify(results)}`);
    if (!ok) process.exitCode = 1;
    await ctx.close();
  } finally {
    await browser?.close();
    await server.close();
  }
}

main().catch((e) => { console.error('[harness] LỖI:', e); process.exitCode = 1; });
