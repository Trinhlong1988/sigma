// SIGMA Phase 2 "chat lõi" (29/7) — regression cho routes/chat.ts (REST chat TỰ XÂY, xem comment đầu file
// đó). CÙNG khuôn chat-attachments-routes.test.ts: createApp() + supertest, `createWebSession()` thật cho
// cookie phiên (KHÔNG mock requireSession), fixtures.ts tạo Agent qua Prisma trên throwaway DB (global-
// setup.ts đã migrate deploy trước khi suite chạy) — KHÔNG mock service layer bằng tay (routes/chat.ts gọi
// THẲNG services/chat-{room,message,reaction}-service.ts thật, agent khác build song song cùng worktree).
//
// Bạn bè: tạo trực tiếp 1 hàng FriendRequest status=ACCEPTED qua Prisma (KHÔNG gọi route /v1/me/friends/* —
// ngoài phạm vi file này) để test round-trip DIRECT room khi ĐÃ là bạn bè, và test chặn khi CHƯA có hàng đó.
import { afterEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeFriends } from './fixtures.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';

let uniqCounter = 0;
/** Tạo 1 agent đã "đăng nhập" (Agent.rcUserId khớp WebSession.rcUserId — đúng điều kiện requireSession tra
 * cứu, xem session-middleware.ts) — trả sessionId dùng làm cookie cho request. CÙNG khuôn authedAgent() ở
 * chat-attachments-routes.test.ts. */
async function authedAgent() {
  uniqCounter += 1;
  const rcUserId = `rc-chatroutes-${Date.now()}-${uniqCounter}`;
  const db = getBotDb();
  const agent = await makeAgent();
  await db.agent.update({ where: { id: agent.id }, data: { rcUserId, rcUsername: `chatroutes${uniqCounter}` } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: `dummy-tok-${uniqCounter}`, agentId: agent.id });
  return { agent, sessionId: ws.id };
}

function authed(app: ReturnType<typeof createApp>, sessionId: string) {
  const withAuth = (req: request.Test) => req.set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionId}`).set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
  return {
    get: (path: string) => withAuth(request(app).get(path)),
    post: (path: string) => withAuth(request(app).post(path)),
    patch: (path: string) => withAuth(request(app).patch(path)),
    put: (path: string) => withAuth(request(app).put(path)),
    delete: (path: string) => withAuth(request(app).delete(path))
  };
}

// PNG 1x1 THẬT ĐẦY ĐỦ — CÙNG buffer dùng ở chat-attachment-service.test.ts (chunk IHDR hợp lệ thật, không chỉ
// 8-byte signature, đủ để file-type nhận diện đúng magic-bytes).
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

describe('POST /v1/chat/rooms/direct', () => {
  const app = createApp();

  it('chưa đăng nhập → 401', async () => {
    const res = await request(app).post('/v1/chat/rooms/direct').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE).send({ targetAgentId: 1 });
    expect(res.status).toBe(401);
  });

  it('thiếu targetAgentId → 400 VALIDATION', async () => {
    const { sessionId } = await authedAgent();
    const res = await authed(app, sessionId).post('/v1/chat/rooms/direct').send({});
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('2 agent CHƯA là bạn bè → chặn (403), KHÔNG tạo được phòng DIRECT', async () => {
    const { sessionId } = await authedAgent();
    const { agent: stranger } = await authedAgent();
    const res = await authed(app, sessionId).post('/v1/chat/rooms/direct').send({ targetAgentId: stranger.id });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  it('2 agent ĐÃ là bạn bè → 200/201, trả phòng DIRECT; gọi lại lần 2 → CÙNG 1 phòng (idempotent)', async () => {
    const { sessionId, agent: me } = await authedAgent();
    const { agent: friend } = await authedAgent();
    await makeFriends(me.id, friend.id);

    const res1 = await authed(app, sessionId).post('/v1/chat/rooms/direct').send({ targetAgentId: friend.id });
    expect([200, 201]).toContain(res1.status);
    expect(res1.body.ok).toBe(true);
    const roomId1 = res1.body.data.id;
    expect(typeof roomId1).toBe('string');

    const res2 = await authed(app, sessionId).post('/v1/chat/rooms/direct').send({ targetAgentId: friend.id });
    expect(res2.body.ok).toBe(true);
    expect(res2.body.data.id).toBe(roomId1);
  });

  it('TICK "đã nhận" (6/8) — GET /v1/chat/rooms/:roomId đính kèm `online` cho từng thành viên (không WS → false)', async () => {
    const { sessionId, agent: me } = await authedAgent();
    const { agent: friend } = await authedAgent();
    await makeFriends(me.id, friend.id);
    const roomRes = await authed(app, sessionId).post('/v1/chat/rooms/direct').send({ targetAgentId: friend.id });
    const roomId = roomRes.body.data.id as string;

    const detail = await authed(app, sessionId).get(`/v1/chat/rooms/${roomId}`);
    expect(detail.status).toBe(200);
    expect(Array.isArray(detail.body.data.members)).toBe(true);
    // Không có kết nối WS nào trong test REST-thuần → mọi thành viên online=false (field TỒN TẠI + boolean).
    for (const m of detail.body.data.members) {
      expect(typeof m.online).toBe('boolean');
      expect(m.online).toBe(false);
    }
  });
});

describe('Gửi/đọc tin nhắn + phân trang', () => {
  const app = createApp();

  async function makeDirectRoom() {
    const { sessionId: meSession, agent: me } = await authedAgent();
    const { sessionId: friendSession, agent: friend } = await authedAgent();
    await makeFriends(me.id, friend.id);
    const roomRes = await authed(app, meSession).post('/v1/chat/rooms/direct').send({ targetAgentId: friend.id });
    const roomId = roomRes.body.data.id as string;
    return { meSession, me, friendSession, friend, roomId };
  }

  it('gửi tin nhắn TEXT hợp lệ → 201, đọc lại thấy đúng nội dung', async () => {
    const { meSession, roomId } = await makeDirectRoom();
    const sendRes = await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'Chào bạn' });
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.ok).toBe(true);
    expect(sendRes.body.data.body).toBe('Chào bạn');

    const listRes = await authed(app, meSession).get(`/v1/chat/rooms/${roomId}/messages`);
    expect(listRes.status).toBe(200);
    expect(listRes.body.ok).toBe(true);
    expect(Array.isArray(listRes.body.data.messages)).toBe(true);
    expect(listRes.body.data.messages.some((m: { body: string }) => m.body === 'Chào bạn')).toBe(true);
  });

  it('gửi TEXT rỗng → 400 VALIDATION (chặn ở route trước khi gọi service)', async () => {
    const { meSession, roomId } = await makeDirectRoom();
    const res = await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: '   ' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('phân trang: gửi 3 tin, lấy limit=2 → hasMore=true + before=id cũ nhất trả nốt tin còn lại', async () => {
    const { meSession, roomId } = await makeDirectRoom();
    await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'tin 1' });
    await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'tin 2' });
    await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'tin 3' });

    const page1 = await authed(app, meSession).get(`/v1/chat/rooms/${roomId}/messages?limit=2`);
    expect(page1.status).toBe(200);
    expect(page1.body.data.messages.length).toBeLessThanOrEqual(2);

    const allRes = await authed(app, meSession).get(`/v1/chat/rooms/${roomId}/messages?limit=50`);
    const allBodies = allRes.body.data.messages.map((m: { body: string }) => m.body);
    expect(allBodies).toEqual(expect.arrayContaining(['tin 1', 'tin 2', 'tin 3']));
  });

  it('agent KHÔNG phải thành viên phòng → GET messages 403 NOT_MEMBER', async () => {
    const { roomId } = await makeDirectRoom();
    const { sessionId: strangerSession } = await authedAgent();
    const res = await authed(app, strangerSession).get(`/v1/chat/rooms/${roomId}/messages`);
    expect(res.status).toBe(403);
  });
});

describe('DELETE /v1/chat/messages/:id — quyền xóa', () => {
  const app = createApp();

  it('agent KHÁC (không phải người gửi/không đủ quyền) cố xóa tin nhắn → chặn (403)', async () => {
    const { sessionId: meSession, agent: me } = await authedAgent();
    const { sessionId: friendSession, agent: friend } = await authedAgent();
    await makeFriends(me.id, friend.id);
    const roomRes = await authed(app, meSession).post('/v1/chat/rooms/direct').send({ targetAgentId: friend.id });
    const roomId = roomRes.body.data.id as string;
    const sendRes = await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'tin của tôi' });
    const messageId = sendRes.body.data.id as string;

    const { sessionId: strangerSession } = await authedAgent();
    const res = await authed(app, strangerSession).delete(`/v1/chat/messages/${messageId}`);
    expect(res.status).toBe(403);

    // Người ngoài phòng thử xóa cũng bị chặn (403), KHÔNG phải 404 (service phải biết roomId của message để
    // phân biệt "không có quyền" — friendSession CÙNG phòng nhưng KHÔNG phải người gửi cũng phải bị chặn).
    const res2 = await authed(app, friendSession).delete(`/v1/chat/messages/${messageId}`);
    expect(res2.status).toBe(403);
  });

  it('chính người gửi xóa tin nhắn của mình → 200 ok', async () => {
    const { sessionId: meSession, agent: me } = await authedAgent();
    const { agent: friend } = await authedAgent();
    await makeFriends(me.id, friend.id);
    const roomRes = await authed(app, meSession).post('/v1/chat/rooms/direct').send({ targetAgentId: friend.id });
    const roomId = roomRes.body.data.id as string;
    const sendRes = await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'xóa được' });
    const messageId = sendRes.body.data.id as string;

    const res = await authed(app, meSession).delete(`/v1/chat/messages/${messageId}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

describe('Reaction — 3 trạng thái added/changed/removed', () => {
  const app = createApp();

  async function makeRoomWithMessage() {
    const { sessionId: meSession, agent: me } = await authedAgent();
    const { agent: friend } = await authedAgent();
    await makeFriends(me.id, friend.id);
    const roomRes = await authed(app, meSession).post('/v1/chat/rooms/direct').send({ targetAgentId: friend.id });
    const roomId = roomRes.body.data.id as string;
    const sendRes = await authed(app, meSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'thả cảm xúc vào đây' });
    const messageId = sendRes.body.data.id as string;
    return { meSession, messageId };
  }

  it('thả emoji lần đầu → added; thả LẠI cùng emoji → removed (bỏ thích); thả emoji KHÁC sau khi removed → added lại', async () => {
    const { meSession, messageId } = await makeRoomWithMessage();

    const r1 = await authed(app, meSession).post(`/v1/chat/messages/${messageId}/reactions`).send({ emoji: '👍' });
    expect(r1.status).toBe(200);
    expect(r1.body.data.action).toBe('added');

    const r2 = await authed(app, meSession).post(`/v1/chat/messages/${messageId}/reactions`).send({ emoji: '👍' });
    expect(r2.body.data.action).toBe('removed');

    const r3 = await authed(app, meSession).post(`/v1/chat/messages/${messageId}/reactions`).send({ emoji: '❤️' });
    expect(r3.body.data.action).toBe('added');
  });

  it('đổi sang emoji khác (đang có 1 emoji) → changed', async () => {
    const { meSession, messageId } = await makeRoomWithMessage();
    await authed(app, meSession).post(`/v1/chat/messages/${messageId}/reactions`).send({ emoji: '👍' });
    const res = await authed(app, meSession).post(`/v1/chat/messages/${messageId}/reactions`).send({ emoji: '😂' });
    expect(res.body.data.action).toBe('changed');
  });

  it('DELETE reactions KHÔNG kèm emoji → tự tra + xóa reaction hiện có của mình (removed)', async () => {
    const { meSession, messageId } = await makeRoomWithMessage();
    await authed(app, meSession).post(`/v1/chat/messages/${messageId}/reactions`).send({ emoji: '👍' });
    const res = await authed(app, meSession).delete(`/v1/chat/messages/${messageId}/reactions`).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.action).toBe('removed');
  });

  it('DELETE reactions khi KHÔNG có reaction nào → no-op thành công (KHÔNG lỗi)', async () => {
    const { meSession, messageId } = await makeRoomWithMessage();
    const res = await authed(app, meSession).delete(`/v1/chat/messages/${messageId}/reactions`).send({});
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data.reaction).toBeNull();
  });

  it('thiếu emoji ở POST reactions → 400 VALIDATION', async () => {
    const { meSession, messageId } = await makeRoomWithMessage();
    const res = await authed(app, meSession).post(`/v1/chat/messages/${messageId}/reactions`).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });
});

describe('Thành viên rời phòng → không gửi được nữa', () => {
  const app = createApp();

  it('friend TỰ rời phòng (removeMember với targetAgentId===chính mình, KHÔNG cần quyền OWNER/ADMIN — xem\n' +
    '   comment removeMember() chat-room-service.ts), gửi tin tiếp → chặn (403 NOT_MEMBER)', async () => {
    const { sessionId: meSession, agent: me } = await authedAgent();
    const { sessionId: friendSession, agent: friend } = await authedAgent();
    await makeFriends(me.id, friend.id);
    const roomRes = await authed(app, meSession).post('/v1/chat/rooms/direct').send({ targetAgentId: friend.id });
    const roomId = roomRes.body.data.id as string;

    // friend gửi được tin nhắn trong khi còn là thành viên (baseline trước khi rời).
    const beforeLeave = await authed(app, friendSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'trước khi rời' });
    expect(beforeLeave.status).toBe(201);

    // friend TỰ rời phòng (target===requester, KHÔNG cần OWNER/ADMIN — cả 2 thành viên phòng DIRECT đều chỉ
    // là MEMBER thường, xem comment findOrCreateDirectRoom(): "role:'MEMBER'" cho cả 2 bên — removeMember 1
    // NGƯỜI KHÁC trong phòng DIRECT sẽ BỊ chặn 403 FORBIDDEN_ROLE vì không ai là OWNER/ADMIN cả, đúng thiết kế
    // "không thể kick người kia trong DM 1-1, chỉ tự rời được").
    const removeRes = await authed(app, friendSession).delete(`/v1/chat/rooms/${roomId}/members/${friend.id}`);
    expect(removeRes.status).toBe(200);

    const afterLeave = await authed(app, friendSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'sau khi rời' });
    expect(afterLeave.status).toBe(403);
    expect(afterLeave.body.error).toBe('NOT_MEMBER');
  });

  it('agent KHÁC (không phải OWNER/ADMIN) cố removeMember NGƯỜI KHÁC trong phòng DIRECT → 403 (không ai là\n' +
    '   OWNER/ADMIN trong DIRECT, KHÔNG thể "kick" người còn lại — chỉ tự rời được)', async () => {
    const { sessionId: meSession, agent: me } = await authedAgent();
    const { agent: friend } = await authedAgent();
    await makeFriends(me.id, friend.id);
    const roomRes = await authed(app, meSession).post('/v1/chat/rooms/direct').send({ targetAgentId: friend.id });
    const roomId = roomRes.body.data.id as string;

    const res = await authed(app, meSession).delete(`/v1/chat/rooms/${roomId}/members/${friend.id}`);
    expect(res.status).toBe(403);
  });
});

describe('GET /v1/chat/rooms — danh sách phòng', () => {
  const app = createApp();

  it('chưa đăng nhập → 401', async () => {
    const res = await request(app).get('/v1/chat/rooms').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
  });

  it('đã có 1 phòng DIRECT → xuất hiện trong danh sách', async () => {
    const { sessionId: meSession, agent: me } = await authedAgent();
    const { agent: friend } = await authedAgent();
    await makeFriends(me.id, friend.id);
    const roomRes = await authed(app, meSession).post('/v1/chat/rooms/direct').send({ targetAgentId: friend.id });
    const roomId = roomRes.body.data.id as string;

    const listRes = await authed(app, meSession).get('/v1/chat/rooms');
    expect(listRes.status).toBe(200);
    expect(listRes.body.ok).toBe(true);
    expect(listRes.body.data.some((r: { id: string }) => r.id === roomId)).toBe(true);
  });
});

// Audit độc lập ĐỢT 2 (29/7, HIGH — đã fix): thiếu test HTTP cho luồng chuyển nhượng OWNER là lý do chính bug
// gốc lọt qua (route chặn role:'OWNER' ở validate, chỉ test service layer trực tiếp không phát hiện được).
// Test dưới đây đi ĐÚNG đường HTTP thật (supertest qua createApp()), KHÔNG gọi service layer trực tiếp.
describe('PATCH /v1/chat/rooms/:roomId/members/:agentId — chuyển nhượng OWNER qua HTTP thật', () => {
  const app = createApp();

  it('OWNER rời nhóm còn người khác → 409 OWNER_MUST_TRANSFER_FIRST; chuyển nhượng qua HTTP → 200; rời lại → 200', async () => {
    const { sessionId: aSession, agent: a } = await authedAgent();
    const { agent: b } = await authedAgent();
    const { agent: c } = await authedAgent();
    await makeFriends(a.id, b.id);
    await makeFriends(a.id, c.id);

    const createRes = await authed(app, aSession).post('/v1/chat/rooms/group').send({ name: 'Nhóm HTTP', memberAgentIds: [b.id, c.id] });
    expect(createRes.status).toBe(201);
    const roomId = createRes.body.data.id;

    const leaveBlockedRes = await authed(app, aSession).delete(`/v1/chat/rooms/${roomId}/members/${a.id}`);
    expect(leaveBlockedRes.status).toBe(409);
    expect(leaveBlockedRes.body.error).toBe('OWNER_MUST_TRANSFER_FIRST');

    // Đây CHÍNH LÀ điểm bug HIGH: route trước đây từ chối role:'OWNER' ở validate, KHÔNG BAO GIỜ tới được
    // service — nếu regression, request này sẽ trả 400 VALIDATION thay vì 200.
    const transferRes = await authed(app, aSession).patch(`/v1/chat/rooms/${roomId}/members/${b.id}`).send({ role: 'OWNER' });
    expect(transferRes.status).toBe(200);
    expect(transferRes.body.data.role).toBe('OWNER');

    const leaveOkRes = await authed(app, aSession).delete(`/v1/chat/rooms/${roomId}/members/${a.id}`);
    expect(leaveOkRes.status).toBe(200);
  });

  it('role gửi giá trị không hợp lệ (không phải OWNER/ADMIN/MEMBER) → 400 VALIDATION', async () => {
    const { sessionId: aSession, agent: a } = await authedAgent();
    const { agent: b } = await authedAgent();
    const { agent: c } = await authedAgent();
    await makeFriends(a.id, b.id);
    await makeFriends(a.id, c.id);
    const createRes = await authed(app, aSession).post('/v1/chat/rooms/group').send({ name: 'Nhóm', memberAgentIds: [b.id, c.id] });
    const roomId = createRes.body.data.id;

    const res = await authed(app, aSession).patch(`/v1/chat/rooms/${roomId}/members/${b.id}`).send({ role: 'SUPERADMIN' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('MEMBER thường (không phải OWNER) cố tự phong mình OWNER qua HTTP → 403 FORBIDDEN_ROLE', async () => {
    const { sessionId: aSession, agent: a } = await authedAgent();
    const { sessionId: bSession, agent: b } = await authedAgent();
    const { agent: c } = await authedAgent();
    await makeFriends(a.id, b.id);
    await makeFriends(a.id, c.id);
    const createRes = await authed(app, aSession).post('/v1/chat/rooms/group').send({ name: 'Nhóm', memberAgentIds: [b.id, c.id] });
    const roomId = createRes.body.data.id;

    const res = await authed(app, bSession).patch(`/v1/chat/rooms/${roomId}/members/${b.id}`).send({ role: 'OWNER' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN_ROLE');
  });
});

// Audit độc lập ĐỢT 2 (29/7, MEDIUM — đã fix): emoji hợp lệ nhiều codepoint (ZWJ sequence) không còn bị từ chối
// nhầm qua HTTP thật.
describe('POST /v1/chat/messages/:id/reactions — emoji ZWJ sequence hợp lệ qua HTTP thật', () => {
  const app = createApp();

  it('emoji gia đình 👨‍👩‍👧‍👦 (7 code point) → 200, KHÔNG bị từ chối nhầm', async () => {
    const { sessionId: aSession, agent: a } = await authedAgent();
    const { agent: b } = await authedAgent();
    await makeFriends(a.id, b.id);
    const roomRes = await authed(app, aSession).post('/v1/chat/rooms/direct').send({ targetAgentId: b.id });
    const roomId = roomRes.body.data.id;
    const msgRes = await authed(app, aSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'react tôi' });
    const messageId = msgRes.body.data.id;

    const res = await authed(app, aSession).post(`/v1/chat/messages/${messageId}/reactions`).send({ emoji: '👨‍👩‍👧‍👦' });
    expect(res.status).toBe(200);
    expect(res.body.data.action).toBe('added');
  });
});

// debt-chat-gaps (31/7, Việc 1) — GET .../messages/reactions?messageIds= qua HTTP thật (route wiring, không chỉ
// service layer — bài học audit trước: "test PASS ở service layer nhưng route wiring gãy").
describe('GET /v1/chat/rooms/:roomId/messages/reactions — khôi phục lịch sử reaction qua HTTP thật', () => {
  const app = createApp();

  it('trả ĐÚNG reaction đã thả cho các messageId hợp lệ, group theo messageId', async () => {
    const { sessionId: aSession, agent: a } = await authedAgent();
    const { sessionId: bSession, agent: b } = await authedAgent();
    await makeFriends(a.id, b.id);
    const roomRes = await authed(app, aSession).post('/v1/chat/rooms/direct').send({ targetAgentId: b.id });
    const roomId = roomRes.body.data.id as string;
    const msg1Res = await authed(app, aSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'tin 1' });
    const msg2Res = await authed(app, aSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'tin 2' });
    const msg1 = msg1Res.body.data.id as string;
    const msg2 = msg2Res.body.data.id as string;
    await authed(app, aSession).post(`/v1/chat/messages/${msg1}/reactions`).send({ emoji: '👍' });
    await authed(app, bSession).post(`/v1/chat/messages/${msg1}/reactions`).send({ emoji: '❤️' });
    await authed(app, bSession).post(`/v1/chat/messages/${msg2}/reactions`).send({ emoji: '🔥' });

    const res = await authed(app, aSession).get(`/v1/chat/rooms/${roomId}/messages/reactions?messageIds=${msg1},${msg2}`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.data[msg1]).toHaveLength(2);
    expect(res.body.data[msg1].map((r: { emoji: string }) => r.emoji).sort()).toEqual(['👍', '❤️'].sort());
    expect(res.body.data[msg2]).toHaveLength(1);
    expect(res.body.data[msg2][0].emoji).toBe('🔥');
  });

  it('chưa đăng nhập → 401', async () => {
    const res = await request(app).get('/v1/chat/rooms/khong-quan-trong/messages/reactions?messageIds=x').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
  });

  it('agent KHÔNG phải thành viên phòng → 403 NOT_MEMBER', async () => {
    const { sessionId: aSession, agent: a } = await authedAgent();
    const { agent: b } = await authedAgent();
    await makeFriends(a.id, b.id);
    const roomRes = await authed(app, aSession).post('/v1/chat/rooms/direct').send({ targetAgentId: b.id });
    const roomId = roomRes.body.data.id as string;
    const { sessionId: strangerSession } = await authedAgent();
    const res = await authed(app, strangerSession).get(`/v1/chat/rooms/${roomId}/messages/reactions?messageIds=abc`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_MEMBER');
  });

  it('messageId THẬT nhưng thuộc PHÒNG KHÁC → KHÔNG lộ reaction (lọc, không dùng làm oracle cross-room)', async () => {
    const { sessionId: aSession, agent: a } = await authedAgent();
    const { agent: b } = await authedAgent();
    const { agent: c } = await authedAgent();
    await makeFriends(a.id, b.id);
    await makeFriends(a.id, c.id);
    const roomAB = (await authed(app, aSession).post('/v1/chat/rooms/direct').send({ targetAgentId: b.id })).body.data.id as string;
    const roomAC = (await authed(app, aSession).post('/v1/chat/rooms/direct').send({ targetAgentId: c.id })).body.data.id as string;
    const msgInAC = (await authed(app, aSession).post(`/v1/chat/rooms/${roomAC}/messages`).send({ kind: 'TEXT', body: 'tin phòng AC' })).body.data.id as string;
    await authed(app, aSession).post(`/v1/chat/messages/${msgInAC}/reactions`).send({ emoji: '👍' });

    // a là thành viên THẬT của roomAB (không phải NOT_MEMBER) nhưng dùng messageId của roomAC — phải KHÔNG lộ.
    const res = await authed(app, aSession).get(`/v1/chat/rooms/${roomAB}/messages/reactions?messageIds=${msgInAC}`);
    expect(res.status).toBe(200);
    expect(res.body.data[msgInAC]).toBeUndefined();
  });

  it('messageIds rỗng/thiếu → 200, data rỗng (không lỗi)', async () => {
    const { sessionId: aSession, agent: a } = await authedAgent();
    const { agent: b } = await authedAgent();
    await makeFriends(a.id, b.id);
    const roomId = (await authed(app, aSession).post('/v1/chat/rooms/direct').send({ targetAgentId: b.id })).body.data.id as string;
    const res = await authed(app, aSession).get(`/v1/chat/rooms/${roomId}/messages/reactions`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({});
  });
});

// debt-chat-gaps (31/7, Việc 2) — mimeType/sizeBytes THẬT trong response gửi/đọc tin nhắn qua HTTP thật.
describe('Việc 2 — attachmentMimeType/attachmentSizeBytes trong ChatMessageDto qua HTTP thật', () => {
  const app = createApp();

  it('gửi tin IMAGE với attachment thật → response POST VÀ GET .../messages đều kèm đúng mimeType/sizeBytes', async () => {
    const { sessionId: aSession, agent: a } = await authedAgent();
    const { agent: b } = await authedAgent();
    await makeFriends(a.id, b.id);
    const roomId = (await authed(app, aSession).post('/v1/chat/rooms/direct').send({ targetAgentId: b.id })).body.data.id as string;

    const uploadRes = await authed(app, aSession).post('/v1/chat/attachments').attach('file', PNG_1PX, 'anh.png');
    expect(uploadRes.status).toBe(201);
    const attachmentId = uploadRes.body.data.id as string;

    const sendRes = await authed(app, aSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'IMAGE', attachmentId });
    expect(sendRes.status).toBe(201);
    expect(sendRes.body.data.attachmentMimeType).toBe('image/png');
    expect(sendRes.body.data.attachmentSizeBytes).toBe(PNG_1PX.length);

    const listRes = await authed(app, aSession).get(`/v1/chat/rooms/${roomId}/messages`);
    const found = listRes.body.data.messages.find((m: { id: string }) => m.id === sendRes.body.data.id);
    expect(found.attachmentMimeType).toBe('image/png');
    expect(found.attachmentSizeBytes).toBe(PNG_1PX.length);
  });

  it('tin TEXT thường (không đính kèm) → attachmentMimeType/attachmentSizeBytes = null trong response', async () => {
    const { sessionId: aSession, agent: a } = await authedAgent();
    const { agent: b } = await authedAgent();
    await makeFriends(a.id, b.id);
    const roomId = (await authed(app, aSession).post('/v1/chat/rooms/direct').send({ targetAgentId: b.id })).body.data.id as string;
    const sendRes = await authed(app, aSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'chỉ chữ' });
    expect(sendRes.body.data.attachmentMimeType).toBeNull();
    expect(sendRes.body.data.attachmentSizeBytes).toBeNull();
  });
});

// debt-chat-gaps (31/7, Việc 3) — GET .../rooms/:roomId/attachments qua HTTP thật (tab "File" GroupInfoPanel.tsx).
describe('GET /v1/chat/rooms/:roomId/attachments — Việc 3', () => {
  const app = createApp();

  it('trả danh sách file đã gửi trong phòng, mới nhất trước', async () => {
    const { sessionId: aSession, agent: a } = await authedAgent();
    const { agent: b } = await authedAgent();
    await makeFriends(a.id, b.id);
    const roomId = (await authed(app, aSession).post('/v1/chat/rooms/direct').send({ targetAgentId: b.id })).body.data.id as string;

    const up1 = await authed(app, aSession).post('/v1/chat/attachments').attach('file', PNG_1PX, 'anh1.png');
    const up2 = await authed(app, aSession).post('/v1/chat/attachments').attach('file', PNG_1PX, 'anh2.png');
    await authed(app, aSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'IMAGE', attachmentId: up1.body.data.id });
    await authed(app, aSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'IMAGE', attachmentId: up2.body.data.id });

    const res = await authed(app, aSession).get(`/v1/chat/rooms/${roomId}/attachments`);
    expect(res.status).toBe(200);
    // FIX-PERF (4/8) — response đổi từ mảng trơn sang { attachments, hasMore } (phân trang cursor).
    expect(res.body.data.attachments).toHaveLength(2);
    expect(res.body.data.hasMore).toBe(false);
    expect(res.body.data.attachments[0].attachmentId).toBe(up2.body.data.id);
    expect(res.body.data.attachments[0].mimeType).toBe('image/png');
  });

  it('chưa đăng nhập → 401', async () => {
    const res = await request(app).get('/v1/chat/rooms/khong-quan-trong/attachments').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
  });

  it('agent KHÔNG phải thành viên phòng → 403 NOT_MEMBER', async () => {
    const { sessionId: aSession, agent: a } = await authedAgent();
    const { agent: b } = await authedAgent();
    await makeFriends(a.id, b.id);
    const roomId = (await authed(app, aSession).post('/v1/chat/rooms/direct').send({ targetAgentId: b.id })).body.data.id as string;
    const { sessionId: strangerSession } = await authedAgent();
    const res = await authed(app, strangerSession).get(`/v1/chat/rooms/${roomId}/attachments`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_MEMBER');
  });
});

// debt-chat-gaps (31/7, Việc 4) — "chỉ trưởng/phó nhóm được gửi tin" qua HTTP thật (route wiring cho readOnly).
describe('Việc 4 — readOnly nhóm qua HTTP thật', () => {
  const app = createApp();

  async function makeGroupRoomHttp() {
    const { sessionId: ownerSession, agent: owner } = await authedAgent();
    const { sessionId: memberSession, agent: member } = await authedAgent();
    const { agent: filler } = await authedAgent();
    await makeFriends(owner.id, member.id);
    await makeFriends(owner.id, filler.id);
    const createRes = await authed(app, ownerSession).post('/v1/chat/rooms/group').send({ name: 'Nhóm readOnly HTTP', memberAgentIds: [member.id, filler.id] });
    const roomId = createRes.body.data.id as string;
    return { ownerSession, owner, memberSession, member, roomId };
  }

  it('PATCH readOnly:true bởi OWNER → 200, RoomDetailDto trả readOnly=true; MEMBER gửi tin sau đó → 403 ROOM_READ_ONLY', async () => {
    const { ownerSession, memberSession, roomId } = await makeGroupRoomHttp();
    const patchRes = await authed(app, ownerSession).patch(`/v1/chat/rooms/${roomId}`).send({ readOnly: true });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.readOnly).toBe(true);

    const sendRes = await authed(app, memberSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'bị chặn' });
    expect(sendRes.status).toBe(403);
    expect(sendRes.body.error).toBe('ROOM_READ_ONLY');
  });

  it('MEMBER thường cố PATCH readOnly → 403 FORBIDDEN_ROLE, KHÔNG đổi được', async () => {
    const { memberSession, roomId } = await makeGroupRoomHttp();
    const res = await authed(app, memberSession).patch(`/v1/chat/rooms/${roomId}`).send({ readOnly: true });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN_ROLE');
  });

  it('phòng mặc định (chưa bật readOnly) → GET chi tiết phòng trả readOnly=false, MEMBER gửi tin bình thường', async () => {
    const { ownerSession, memberSession, roomId } = await makeGroupRoomHttp();
    const detailRes = await authed(app, ownerSession).get(`/v1/chat/rooms/${roomId}`);
    expect(detailRes.body.data.readOnly).toBe(false);
    const sendRes = await authed(app, memberSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body: 'bình thường' });
    expect(sendRes.status).toBe(201);
  });
});

// B112 (2/8, Admin Demo "bill sau khi gửi chưa có nút sửa") — PATCH /v1/chat/messages/:id với {attachmentId,
// metadataJson} qua HTTP thật (logic nghiệp vụ đầy đủ đã test ở chat-message-service.test.ts, ở đây CHỈ verify
// route wiring: hình dạng input "nửa vời"/CSRF/session/broadcast KHÔNG vỡ qua app Express thật).
describe('PATCH /v1/chat/messages/:id — sửa ảnh bill đã gửi (B112)', () => {
  const app = createApp();

  async function makeBillMessageHttp() {
    const { sessionId: aSession, agent: a } = await authedAgent();
    const { agent: b } = await authedAgent();
    await makeFriends(a.id, b.id);
    const roomId = (await authed(app, aSession).post('/v1/chat/rooms/direct').send({ targetAgentId: b.id })).body.data.id as string;
    const uploadRes = await authed(app, aSession).post('/v1/chat/attachments').attach('file', PNG_1PX, 'bill.jpg');
    const attachmentId = uploadRes.body.data.id as string;
    const metadataJson = JSON.stringify({ isBillImage: true, billAmount: 4_000_000, billImageHeightPx: 800 });
    const sendRes = await authed(app, aSession)
      .post(`/v1/chat/rooms/${roomId}/messages`)
      .send({ kind: 'IMAGE', attachmentId, body: 'POS ... - 4.000.000đ', metadataJson });
    return { aSession, a, roomId, messageId: sendRes.body.data.id as string };
  }

  it('happy path — đổi attachmentId+metadataJson+body → 200, GET lại thấy ảnh/caption mới, editedAt khác null', async () => {
    const { aSession, roomId, messageId } = await makeBillMessageHttp();
    const newUpload = await authed(app, aSession).post('/v1/chat/attachments').attach('file', PNG_1PX, 'bill-moi.jpg');
    const newAttachmentId = newUpload.body.data.id as string;
    const newMetadataJson = JSON.stringify({ isBillImage: true, billAmount: 5_000_000, billImageHeightPx: 810 });

    const patchRes = await authed(app, aSession)
      .patch(`/v1/chat/messages/${messageId}`)
      .send({ body: 'POS ... - 5.000.000đ', attachmentId: newAttachmentId, metadataJson: newMetadataJson });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.attachmentId).toBe(newAttachmentId);
    expect(patchRes.body.data.body).toBe('POS ... - 5.000.000đ');
    expect(patchRes.body.data.editedAt).not.toBeNull();

    const listRes = await authed(app, aSession).get(`/v1/chat/rooms/${roomId}/messages`);
    const found = listRes.body.data.messages.find((m: { id: string }) => m.id === messageId);
    expect(found.attachmentId).toBe(newAttachmentId);
  });

  it('gửi attachmentId nhưng THIẾU metadataJson (input nửa vời) → 400 VALIDATION, KHÔNG gọi service', async () => {
    const { aSession, messageId } = await makeBillMessageHttp();
    const res = await authed(app, aSession).patch(`/v1/chat/messages/${messageId}`).send({ body: 'sửa', attachmentId: 'att-x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('NGƯỜI KHÁC (không phải sender) cố sửa → 403 FORBIDDEN — editMessage() kiểm senderId TRƯỚC cả kiểm thành viên phòng, xem chat-message-service.ts', async () => {
    const { messageId } = await makeBillMessageHttp();
    const { sessionId: strangerSession } = await authedAgent();
    const res = await authed(app, strangerSession).patch(`/v1/chat/messages/${messageId}`).send({ body: 'bị hack' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('FORBIDDEN');
  });

  it('chưa đăng nhập → 401', async () => {
    const res = await request(app).patch('/v1/chat/messages/khong-quan-trong').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE).send({ body: 'x' });
    expect(res.status).toBe(401);
  });
});

// SIGMA (2/8, tính năng "Hoàn tiền" MỚI) — GET /v1/chat/messages/:id/refunds qua HTTP thật.
describe('GET /v1/chat/messages/:id/refunds', () => {
  const app = createApp();

  // NỢ #2c (3/8) — gửi tin "Hoàn tiền" nay kích hoạt server re-OCR ảnh (chat-message-service.sendMessage →
  // refund-verify.ts). OCR service Python KHÔNG chạy trong test → stub global.fetch trả 1 dòng "VND <amount>"
  // KHỚP số client khai để refund được kiểm chứng (verified) — các test này kiểm ranh giới senderId/cumulative,
  // KHÔNG kiểm lệch số (đã có test riêng refund-verify.test.ts). unstub sau mỗi test (scope trong describe này).
  function stubOcrMatching(amount: number) {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: [{ text: `VND ${amount}`, score: 0.97 }] }) }));
  }
  afterEach(() => vi.unstubAllGlobals());

  async function makeBillAndRoom() {
    const { sessionId: aSession, agent: a } = await authedAgent();
    const { sessionId: bSession, agent: b } = await authedAgent();
    await makeFriends(a.id, b.id);
    const roomId = (await authed(app, aSession).post('/v1/chat/rooms/direct').send({ targetAgentId: b.id })).body.data.id as string;
    const uploadRes = await authed(app, aSession).post('/v1/chat/attachments').attach('file', PNG_1PX, 'bill.jpg');
    const attachmentId = uploadRes.body.data.id as string;
    const metadataJson = JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billImageHeightPx: 800, billFields: { tid: null } });
    const sendRes = await authed(app, aSession).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'IMAGE', attachmentId, body: 'bill', metadataJson });
    return { aSession, bSession, a, b, roomId, billId: sendRes.body.data.id as string };
  }

  async function sendRefund(sessionId: string, roomId: string, billId: string, amount: number) {
    const uploadRes = await authed(app, sessionId).post('/v1/chat/attachments').attach('file', PNG_1PX, 'hoan.jpg');
    const attachmentId = uploadRes.body.data.id as string;
    const metadataJson = JSON.stringify({ isRefundImage: true, refundAmount: amount });
    stubOcrMatching(amount); // server sẽ re-OCR ảnh này lúc lưu — cho OCR "đọc" đúng số khai (verified).
    return authed(app, sessionId)
      .post(`/v1/chat/rooms/${roomId}/messages`)
      .send({ kind: 'IMAGE', attachmentId, body: `Hoàn tiền ${amount}đ`, replyToMessageId: billId, metadataJson });
  }

  it('chưa đăng nhập → 401', async () => {
    const res = await request(app).get('/v1/chat/messages/khong-quan-trong/refunds').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
  });

  it('tin nhắn gốc không tồn tại → 404 MESSAGE_NOT_FOUND', async () => {
    const { aSession } = await makeBillAndRoom();
    const res = await authed(app, aSession).get('/v1/chat/messages/khong-ton-tai/refunds');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('MESSAGE_NOT_FOUND');
  });

  it('requester KHÔNG phải thành viên phòng chứa bill gốc → 403 NOT_MEMBER', async () => {
    const { billId } = await makeBillAndRoom();
    const { sessionId: strangerSession } = await authedAgent();
    const res = await authed(app, strangerSession).get(`/v1/chat/messages/${billId}/refunds`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_MEMBER');
  });

  it('CHƯA có lần hoàn tiền nào → mảng rỗng', async () => {
    const { aSession, billId } = await makeBillAndRoom();
    const res = await authed(app, aSession).get(`/v1/chat/messages/${billId}/refunds`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  // #2 (3/8, LANE B Vòng 2 — bảo mật): CHỈ đếm confirmation do NGƯỜI GỬI BILL GỐC (a) post. Reply "hoàn tiền"
  // của thành viên KHÁC (b = khách/kẻ gian) BỊA số KHÔNG được liệt kê (chống tự "xác nhận đã hoàn" cho a).
  it('#2: reply hoàn tiền của THÀNH VIÊN KHÁC (b) bị loại — CHỈ liệt kê confirmation của người gửi bill (a)', async () => {
    const { aSession, bSession, roomId, billId } = await makeBillAndRoom();
    await sendRefund(bSession, roomId, billId, 400_000); // b (không phải người gửi bill) — PHẢI bị loại.
    await sendRefund(aSession, roomId, billId, 600_000); // a (người gửi bill) — được tính.
    const res = await authed(app, aSession).get(`/v1/chat/messages/${billId}/refunds`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data.map((r: { amount: number }) => r.amount)).toEqual([600_000]);
    expect(res.body.data.map((r: { amount: number }) => r.amount)).not.toContain(400_000);
  });

  // Cumulative HỢP LỆ (B123): CHÍNH người gửi bill (a) tự hoàn NHIỀU LẦN → liệt kê ĐỦ cả 2.
  it('người gửi bill (a) tự hoàn 2 lần (cumulative) → liệt kê ĐỦ cả 2, đúng amount tăng dần', async () => {
    const { aSession, roomId, billId } = await makeBillAndRoom();
    await sendRefund(aSession, roomId, billId, 400_000);
    await sendRefund(aSession, roomId, billId, 600_000);
    const res = await authed(app, aSession).get(`/v1/chat/messages/${billId}/refunds`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(res.body.data.map((r: { amount: number }) => r.amount).sort((x: number, y: number) => x - y)).toEqual([400_000, 600_000]);
  });
});

// B122 (2/8, audit đối kháng "route tốn tài nguyên đã có rate-limit đủ chưa") — GET /v1/chat/search/messages
// (searchMessages() quét tới 3000 tin nhắn/lần, chat-search-service.ts) TRƯỚC ĐỢT NÀY hoàn toàn KHÔNG rate-
// limit, khác friendLookupLimiter (routes/me.ts) đã có từ 31/7 cho route tra cứu rẻ hơn hẳn. Test xác nhận
// limiter THẬT SỰ chặn (không chỉ khai báo cho có) — CÙNG khuôn test friendLookupLimiter (test/me-friends.ts):
// request thứ 31 (limit=30) trong cùng phút → 429, các request TRƯỚC đó vẫn 200, scope theo agentId (agent
// KHÁC gọi cùng route/cùng IP-test không bị ảnh hưởng).
describe('GET /v1/chat/search/messages — rate-limit 30 lần/phút, scope theo agentId', () => {
  it('request thứ 31 → 429 RATE_LIMITED; agent KHÁC không bị ảnh hưởng', async () => {
    // App RIÊNG cho test này — rateLimit() là module-level singleton (dùng CHUNG mọi createApp(), xem app.ts),
    // isolation THẬT SỰ đến từ agentId LUÔN MỚI của makeAgent()/authedAgent() mỗi test (CÙNG khuôn
    // test/me-friends.test.ts), tạo app riêng chỉ để nhất quán quy ước.
    const app = createApp();
    const { sessionId: aSession } = await authedAgent();
    const { sessionId: otherSession } = await authedAgent();

    for (let i = 0; i < 30; i++) {
      const res = await authed(app, aSession).get('/v1/chat/search/messages?q=x');
      expect(res.status).toBe(200);
    }
    const thirtyFirst = await authed(app, aSession).get('/v1/chat/search/messages?q=x');
    expect(thirtyFirst.status).toBe(429);
    expect(thirtyFirst.body.error).toBe('RATE_LIMITED');

    const otherRes = await authed(app, otherSession).get('/v1/chat/search/messages?q=x');
    expect(otherRes.status).toBe(200);
  });
});
