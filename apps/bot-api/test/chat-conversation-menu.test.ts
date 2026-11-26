// SIGMA "MENU HỘI THOẠI" (nhấn giữ 1 dòng danh sách chat, kiểu Zalo — 7/8, Admin Demo) — regression cho 6
// hành động cấp-hội-thoại PER-AGENT (mute / pin-conversation / mark-unread / hide / remove / report) + ảnh hưởng
// của mute lên push, + listRoomsForAgent (lọc hidden/removed, sort ghim lên đầu, cờ muted/pinned).
//
// CÙNG khuôn chat-routes.test.ts: createApp() + supertest, createWebSession() thật (KHÔNG mock requireSession),
// fixtures.ts trên throwaway DB (global-setup.ts migrate deploy — GỒM migration tay 20260807120000_chat_
// conversation_menu). Test tự chạy qua glob include `test/**/*.test.ts` (vitest.config.ts) — KHÔNG cần wire tay.
//
// Mock hub (broadcastToAgent/broadcastToRoom) + push (sendPushToAgent) CÙNG cơ chế chat-notify-e2e.test.ts —
// để assert "muted KHÔNG push nhưng VẪN broadcastToAgent chat-notify" mà không cần dựng WS thật.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeFriends } from './fixtures.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';

vi.mock('../src/chat-realtime-hub.js', async () => {
  const actual = await vi.importActual<typeof import('../src/chat-realtime-hub.js')>('../src/chat-realtime-hub.js');
  return { ...actual, broadcastToAgent: vi.fn(), broadcastToRoom: vi.fn() };
});
vi.mock('../src/push-notification-service.js', async () => {
  const actual = await vi.importActual<typeof import('../src/push-notification-service.js')>('../src/push-notification-service.js');
  return { ...actual, sendPushToAgent: vi.fn().mockResolvedValue(undefined) };
});
import { broadcastToAgent } from '../src/chat-realtime-hub.js';
import { sendPushToAgent } from '../src/push-notification-service.js';

let uniqCounter = 0;
async function authedAgent() {
  uniqCounter += 1;
  const rcUserId = `rc-convmenu-${Date.now()}-${uniqCounter}`;
  const db = getBotDb();
  const agent = await makeAgent();
  await db.agent.update({ where: { id: agent.id }, data: { rcUserId, rcUsername: `convmenu${uniqCounter}` } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: `dummy-tok-${uniqCounter}`, agentId: agent.id });
  return { agent, sessionId: ws.id };
}

function authed(app: ReturnType<typeof createApp>, sessionId: string) {
  const withAuth = (req: request.Test) => req.set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionId}`).set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
  return {
    get: (path: string) => withAuth(request(app).get(path)),
    post: (path: string) => withAuth(request(app).post(path))
  };
}

const app = createApp();

async function makeDirectRoom() {
  const { sessionId: meSession, agent: me } = await authedAgent();
  const { sessionId: friendSession, agent: friend } = await authedAgent();
  await makeFriends(me.id, friend.id);
  const roomRes = await authed(app, meSession).post('/v1/chat/rooms/direct').send({ targetAgentId: friend.id });
  const roomId = roomRes.body.data.id as string;
  return { meSession, me, friendSession, friend, roomId };
}

function roomInList(listBody: { data: Array<{ id: string }> }, roomId: string): boolean {
  return listBody.data.some((r) => r.id === roomId);
}

beforeEach(() => {
  vi.mocked(broadcastToAgent).mockClear();
  vi.mocked(sendPushToAgent).mockClear();
});
afterEach(() => {
  delete process.env.SIGMA_ADMIN_REPORT_ROOM_ID;
});

describe('POST /v1/chat/rooms/:roomId/mute', () => {
  it('muted:true → mutedUntil > now + cờ muted=true trong danh sách; muted:false → mutedUntil null + muted=false', async () => {
    const { meSession, me, roomId } = await makeDirectRoom();
    const db = getBotDb();

    const on = await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/mute`).send({ muted: true });
    expect(on.status).toBe(200);
    expect(on.body.ok).toBe(true);
    let member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId, agentId: me.id } } });
    expect(member?.mutedUntil).not.toBeNull();
    expect(member!.mutedUntil!.getTime()).toBeGreaterThan(Date.now());

    let list = await authed(app, meSession).get('/v1/chat/rooms');
    expect(list.body.data.find((r: { id: string }) => r.id === roomId).muted).toBe(true);

    const off = await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/mute`).send({ muted: false });
    expect(off.status).toBe(200);
    member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId, agentId: me.id } } });
    expect(member?.mutedUntil).toBeNull();
    list = await authed(app, meSession).get('/v1/chat/rooms');
    expect(list.body.data.find((r: { id: string }) => r.id === roomId).muted).toBe(false);
  });

  it('thiếu/sai muted (không boolean) → 400 VALIDATION', async () => {
    const { meSession, roomId } = await makeDirectRoom();
    const res = await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/mute`).send({ muted: 'yes' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('agent KHÔNG phải thành viên → 403 NOT_MEMBER', async () => {
    const { roomId } = await makeDirectRoom();
    const { sessionId: strangerSession } = await authedAgent();
    const res = await authed(app, strangerSession).post(`/v1/chat/rooms/${roomId}/mute`).send({ muted: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_MEMBER');
  });
});

describe('POST /v1/chat/rooms/:roomId/pin-conversation — ghim hội thoại lên đầu', () => {
  it('pinned:true đổi pinnedAt + danh sách đưa phòng ghim LÊN ĐẦU dù lastMessageAt cũ hơn', async () => {
    const { sessionId: meSession, agent: me } = await authedAgent();
    const { agent: f1 } = await authedAgent();
    const { agent: f2 } = await authedAgent();
    await makeFriends(me.id, f1.id);
    await makeFriends(me.id, f2.id);
    const room1 = (await authed(app, meSession).post('/v1/chat/rooms/direct').send({ targetAgentId: f1.id })).body.data.id as string;
    const room2 = (await authed(app, meSession).post('/v1/chat/rooms/direct').send({ targetAgentId: f2.id })).body.data.id as string;
    // room2 có tin trước, room1 có tin SAU → không ghim thì room1 đứng đầu (lastMessageAt mới hơn).
    await authed(app, meSession).post(`/v1/chat/rooms/${room2}/messages`).send({ kind: 'TEXT', body: 'phòng 2' });
    await authed(app, meSession).post(`/v1/chat/rooms/${room1}/messages`).send({ kind: 'TEXT', body: 'phòng 1' });

    const before = await authed(app, meSession).get('/v1/chat/rooms');
    expect(before.body.data[0].id).toBe(room1); // chưa ghim: room1 (mới nhất) đầu.

    const db = getBotDb();
    const pin = await authed(app, meSession).post(`/v1/chat/rooms/${room2}/pin-conversation`).send({ pinned: true });
    expect(pin.status).toBe(200);
    const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room2, agentId: me.id } } });
    expect(member?.pinnedAt).not.toBeNull();

    const after = await authed(app, meSession).get('/v1/chat/rooms');
    expect(after.body.data[0].id).toBe(room2); // ghim room2 → lên đầu.
    expect(after.body.data.find((r: { id: string }) => r.id === room2).pinned).toBe(true);
    expect(after.body.data.find((r: { id: string }) => r.id === room1).pinned).toBe(false);

    const unpin = await authed(app, meSession).post(`/v1/chat/rooms/${room2}/pin-conversation`).send({ pinned: false });
    expect(unpin.status).toBe(200);
    const back = await authed(app, meSession).get('/v1/chat/rooms');
    expect(back.body.data[0].id).toBe(room1); // bỏ ghim → về sort theo lastMessageAt (room1 đầu).
  });

  it('thiếu pinned boolean → 400 VALIDATION', async () => {
    const { meSession, roomId } = await makeDirectRoom();
    const res = await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/pin-conversation`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });
});

describe('POST /v1/chat/rooms/:roomId/mark-unread', () => {
  it('sau khi đã đọc hết → mark-unread làm unreadCount >= 1 + broadcast room-unread-self', async () => {
    const { meSession, me, friendSession, roomId } = await makeDirectRoom();
    // 2 tin từ FRIEND (tin của người khác mới tính unread của me — tin mình gửi không tính).
    await authed(app, friendSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'tin A' });
    const m2 = await authed(app, friendSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'tin B' });
    // me đọc tới tin mới nhất → unread 0.
    await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/read`).send({ messageId: m2.body.data.id });
    let list = await authed(app, meSession).get('/v1/chat/rooms');
    expect(list.body.data.find((r: { id: string }) => r.id === roomId).unreadCount).toBe(0);

    vi.mocked(broadcastToAgent).mockClear();
    const res = await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/mark-unread`).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(vi.mocked(broadcastToAgent)).toHaveBeenCalledWith(me.id, expect.objectContaining({ msg: 'room-unread-self', roomId }));

    list = await authed(app, meSession).get('/v1/chat/rooms');
    expect(list.body.data.find((r: { id: string }) => r.id === roomId).unreadCount).toBeGreaterThanOrEqual(1);
  });

  it('agent KHÔNG phải thành viên → 403 NOT_MEMBER', async () => {
    const { roomId } = await makeDirectRoom();
    const { sessionId: strangerSession } = await authedAgent();
    const res = await authed(app, strangerSession).post(`/v1/chat/rooms/${roomId}/mark-unread`).send({});
    expect(res.status).toBe(403);
  });
});

describe('POST /v1/chat/rooms/:roomId/hide + /remove — loại phòng khỏi danh sách', () => {
  it('hide:true loại phòng khỏi list; hide:false hiện lại', async () => {
    const { meSession, roomId } = await makeDirectRoom();
    expect(roomInList((await authed(app, meSession).get('/v1/chat/rooms')).body, roomId)).toBe(true);

    await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/hide`).send({ hidden: true });
    expect(roomInList((await authed(app, meSession).get('/v1/chat/rooms')).body, roomId)).toBe(false);

    await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/hide`).send({ hidden: false });
    expect(roomInList((await authed(app, meSession).get('/v1/chat/rooms')).body, roomId)).toBe(true);
  });

  it('hide KHÔNG tự hiện lại khi có tin mới (khác remove)', async () => {
    const { meSession, friendSession, roomId } = await makeDirectRoom();
    await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/hide`).send({ hidden: true });
    await authed(app, friendSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'tin mới' });
    // Vẫn ẩn (hiddenAt KHÔNG bị clear bởi tin mới).
    expect(roomInList((await authed(app, meSession).get('/v1/chat/rooms')).body, roomId)).toBe(false);
  });

  it('remove loại phòng khỏi list; friend gửi tin mới → TỰ hiện lại (removedAt clear)', async () => {
    const { meSession, friendSession, roomId } = await makeDirectRoom();
    await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/remove`).send({});
    expect(roomInList((await authed(app, meSession).get('/v1/chat/rooms')).body, roomId)).toBe(false);

    await authed(app, friendSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'kéo phòng lên lại' });
    expect(roomInList((await authed(app, meSession).get('/v1/chat/rooms')).body, roomId)).toBe(true);
  });
});

describe('POST /v1/chat/rooms/:roomId/report — báo xấu', () => {
  it('lưu chat_reports + ẩn phòng phía người báo; env admin trống → chỉ lưu (KHÔNG lỗi)', async () => {
    const { meSession, me, roomId } = await makeDirectRoom();
    const db = getBotDb();
    const res = await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/report`).send({ reason: 'spam lừa đảo' });
    expect(res.status).toBe(201);
    expect(typeof res.body.data.id).toBe('string');

    const report = await db.chatReport.findFirst({ where: { roomId, reporterAgentId: me.id } });
    expect(report).not.toBeNull();
    expect(report?.reason).toBe('spam lừa đảo');

    // Báo xấu → phòng bị ẩn khỏi danh sách người báo.
    expect(roomInList((await authed(app, meSession).get('/v1/chat/rooms')).body, roomId)).toBe(false);
  });

  it('reason bỏ trống → vẫn lưu record (reason null)', async () => {
    const { meSession, me, roomId } = await makeDirectRoom();
    const db = getBotDb();
    const res = await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/report`).send({});
    expect(res.status).toBe(201);
    const report = await db.chatReport.findFirst({ where: { roomId, reporterAgentId: me.id } });
    expect(report?.reason).toBeNull();
  });

  it('env SIGMA_ADMIN_REPORT_ROOM_ID set → tạo tin hệ thống vào phòng admin + broadcast', async () => {
    // Phòng admin THẬT = 1 group room (tạo qua nhóm 3 người để hợp lệ).
    const { sessionId: adminSession, agent: admin } = await authedAgent();
    const { agent: x } = await authedAgent();
    const { agent: y } = await authedAgent();
    await makeFriends(admin.id, x.id);
    await makeFriends(admin.id, y.id);
    const adminRoomId = (await authed(app, adminSession).post('/v1/chat/rooms/group').send({ name: 'Admin báo xấu', memberAgentIds: [x.id, y.id] })).body.data.id as string;
    process.env.SIGMA_ADMIN_REPORT_ROOM_ID = adminRoomId;

    const { meSession, me, roomId } = await makeDirectRoom();
    const res = await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/report`).send({ reason: 'nội dung xấu' });
    expect(res.status).toBe(201);

    const db = getBotDb();
    const notice = await db.chatMessage.findFirst({ where: { roomId: adminRoomId, senderId: null }, orderBy: { createdAt: 'desc' } });
    expect(notice).not.toBeNull();
    expect(notice?.body).toContain(`agent ${me.id}`);
    expect(notice?.body).toContain(roomId);
    expect(notice?.body).toContain('nội dung xấu');
  });
});

describe('Mute ảnh hưởng push — muted KHÔNG nhận FCM nhưng VẪN broadcastToAgent chat-notify', () => {
  it('friend mute phòng → me gửi tin: sendPushToAgent KHÔNG gọi, broadcastToAgent VẪN gọi chat-notify', async () => {
    const { meSession, friendSession, friend, roomId } = await makeDirectRoom();
    await authed(app, friendSession).post(`/v1/chat/rooms/${roomId}/mute`).send({ muted: true });

    vi.mocked(sendPushToAgent).mockClear();
    vi.mocked(broadcastToAgent).mockClear();
    await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'tin cho friend đang mute' });

    // friend là người nhận DUY NHẤT (phòng DIRECT) và đang mute → KHÔNG push.
    expect(vi.mocked(sendPushToAgent)).not.toHaveBeenCalled();
    // Nhưng VẪN nhận banner trong-app (badge/số chưa đọc cập nhật).
    expect(vi.mocked(broadcastToAgent)).toHaveBeenCalledWith(friend.id, expect.objectContaining({ msg: 'chat-notify', roomId }));
  });

  it('friend KHÔNG mute → me gửi tin: sendPushToAgent CÓ gọi cho friend (control)', async () => {
    const { meSession, friendSession, friend, roomId } = await makeDirectRoom();
    // đảm bảo không mute (mặc định đã không mute — gọi explicit cho rõ ý định).
    await authed(app, friendSession).post(`/v1/chat/rooms/${roomId}/mute`).send({ muted: false });

    vi.mocked(sendPushToAgent).mockClear();
    await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'tin thường' });

    expect(vi.mocked(sendPushToAgent)).toHaveBeenCalledWith(expect.anything(), friend.id, expect.objectContaining({ data: expect.objectContaining({ kind: 'chat_message' }) }));
  });
});
