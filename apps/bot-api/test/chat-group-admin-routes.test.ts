// SIGMA "nhóm chat đầy đủ như Zalo" (5/8) — regression HTTP cho routes/chat.ts (5 tính năng quản trị nhóm
// mới). CÙNG khuôn chat-routes.test.ts: createApp() + supertest, createWebSession() thật cho cookie phiên,
// fixtures.ts tạo Agent qua Prisma trên throwaway DB.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeFriends } from './fixtures.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';

let uniqCounter = 0;
async function authedAgent() {
  uniqCounter += 1;
  const rcUserId = `rc-groupadmin-${Date.now()}-${uniqCounter}`;
  const db = getBotDb();
  const agent = await makeAgent();
  await db.agent.update({ where: { id: agent.id }, data: { rcUserId, rcUsername: `groupadmin${uniqCounter}` } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: `dummy-tok-${uniqCounter}`, agentId: agent.id });
  return { agent, sessionId: ws.id };
}

function authed(app: ReturnType<typeof createApp>, sessionId: string) {
  const withAuth = (req: request.Test) => req.set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionId}`).set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
  return {
    get: (p: string) => withAuth(request(app).get(p)),
    post: (p: string) => withAuth(request(app).post(p)),
    patch: (p: string) => withAuth(request(app).patch(p)),
    put: (p: string) => withAuth(request(app).put(p)),
    delete: (p: string) => withAuth(request(app).delete(p))
  };
}

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const PLAIN_TEXT_AS_JPG = Buffer.from('khong phai anh that, chi la text doi duoi', 'utf8');

const app = createApp();

/** Tạo nhóm qua API: owner (đăng nhập) + 2 thành viên (đã kết bạn). Trả owner session + room + 2 member. */
async function makeGroupViaApi() {
  const { agent: owner, sessionId } = await authedAgent();
  const { agent: m1, sessionId: m1Session } = await authedAgent();
  const { agent: m2, sessionId: m2Session } = await authedAgent();
  await makeFriends(owner.id, m1.id);
  await makeFriends(owner.id, m2.id);
  const res = await authed(app, sessionId).post('/v1/chat/rooms/group').send({ name: 'Nhóm HTTP', memberAgentIds: [m1.id, m2.id] });
  expect(res.status).toBe(201);
  return { owner, sessionId, m1, m1Session, m2, m2Session, roomId: res.body.data.id as string };
}

async function sendText(sessionId: string, roomId: string, body: string): Promise<string> {
  const res = await authed(app, sessionId).post(`/v1/chat/rooms/${roomId}/messages`).send({ kind: 'TEXT', body });
  expect(res.status).toBe(201);
  return res.body.data.id as string;
}

describe('GHIM NHIỀU / Bảng tin — routes', () => {
  it('POST/GET/DELETE /pins vòng đời đầy đủ', async () => {
    const { sessionId, roomId } = await makeGroupViaApi();
    const a = await sendText(sessionId, roomId, 'A');
    const b = await sendText(sessionId, roomId, 'B');

    const p1 = await authed(app, sessionId).post(`/v1/chat/rooms/${roomId}/pins`).send({ messageId: a });
    expect(p1.status).toBe(201);
    await authed(app, sessionId).post(`/v1/chat/rooms/${roomId}/pins`).send({ messageId: b });

    const list = await authed(app, sessionId).get(`/v1/chat/rooms/${roomId}/pins`);
    expect(list.status).toBe(200);
    expect(list.body.data.map((p: { messageId: string }) => p.messageId)).toEqual([b, a]); // mới nhất trước

    const del = await authed(app, sessionId).delete(`/v1/chat/rooms/${roomId}/pins/${b}`);
    expect(del.status).toBe(200);
    const after = await authed(app, sessionId).get(`/v1/chat/rooms/${roomId}/pins`);
    expect(after.body.data.map((p: { messageId: string }) => p.messageId)).toEqual([a]);
  });

  it('MEMBER thường POST /pins → 403; nhưng GET /pins → 200 (ai cũng xem được)', async () => {
    const { sessionId, m1Session, roomId } = await makeGroupViaApi();
    const a = await sendText(sessionId, roomId, 'A');
    const forbidden = await authed(app, m1Session).post(`/v1/chat/rooms/${roomId}/pins`).send({ messageId: a });
    expect(forbidden.status).toBe(403);
    const view = await authed(app, m1Session).get(`/v1/chat/rooms/${roomId}/pins`);
    expect(view.status).toBe(200);
  });

  it('người ngoài phòng GET /pins → 403', async () => {
    const { roomId } = await makeGroupViaApi();
    const { sessionId: strangerSession } = await authedAgent();
    const res = await authed(app, strangerSession).get(`/v1/chat/rooms/${roomId}/pins`);
    expect(res.status).toBe(403);
  });
});

describe('DUYỆT thành viên — routes', () => {
  it('bật requireApproval → POST /join = 202 PENDING → OWNER approve → thành viên', async () => {
    const { sessionId, roomId } = await makeGroupViaApi();
    await authed(app, sessionId).patch(`/v1/chat/rooms/${roomId}`).send({ requireApproval: true });
    const { agent: newcomer, sessionId: newSession } = await authedAgent();

    const join = await authed(app, newSession).post(`/v1/chat/rooms/${roomId}/join`);
    expect(join.status).toBe(202);
    expect(join.body.data.status).toBe('PENDING');

    const pending = await authed(app, sessionId).get(`/v1/chat/rooms/${roomId}/join-requests`);
    expect(pending.body.data.map((r: { agentId: number }) => r.agentId)).toContain(newcomer.id);

    const approve = await authed(app, sessionId).post(`/v1/chat/rooms/${roomId}/join-requests/${newcomer.id}/approve`);
    expect(approve.status).toBe(200);

    // newcomer giờ là thành viên — GET rooms detail thấy được (không còn 403).
    const detail = await authed(app, newSession).get(`/v1/chat/rooms/${roomId}`);
    expect(detail.status).toBe(200);
  });

  it('requireApproval=false (mặc định) → POST /join = 201 JOINED ngay', async () => {
    const { roomId } = await makeGroupViaApi();
    const { sessionId: newSession } = await authedAgent();
    const join = await authed(app, newSession).post(`/v1/chat/rooms/${roomId}/join`);
    expect(join.status).toBe(201);
    expect(join.body.data.status).toBe('JOINED');
  });

  it('MEMBER thường GET /join-requests → 403; reject xoá khỏi hàng chờ', async () => {
    const { sessionId, m1Session, roomId } = await makeGroupViaApi();
    await authed(app, sessionId).patch(`/v1/chat/rooms/${roomId}`).send({ requireApproval: true });
    const { agent: newcomer, sessionId: newSession } = await authedAgent();
    await authed(app, newSession).post(`/v1/chat/rooms/${roomId}/join`);

    const forbidden = await authed(app, m1Session).get(`/v1/chat/rooms/${roomId}/join-requests`);
    expect(forbidden.status).toBe(403);

    const reject = await authed(app, sessionId).post(`/v1/chat/rooms/${roomId}/join-requests/${newcomer.id}/reject`);
    expect(reject.status).toBe(200);
    const pending = await authed(app, sessionId).get(`/v1/chat/rooms/${roomId}/join-requests`);
    expect(pending.body.data.length).toBe(0);
  });

  it('approve khi không có yêu cầu chờ → 404', async () => {
    const { sessionId, roomId } = await makeGroupViaApi();
    const { agent: stranger } = await authedAgent();
    const res = await authed(app, sessionId).post(`/v1/chat/rooms/${roomId}/join-requests/${stranger.id}/approve`);
    expect(res.status).toBe(404);
  });
});

describe('GIỚI HẠN số thành viên — routes', () => {
  it('PATCH maxMembers=3 → POST /join của người thứ 4 → 409 ROOM_FULL', async () => {
    const { sessionId, roomId } = await makeGroupViaApi(); // 3 người
    const patch = await authed(app, sessionId).patch(`/v1/chat/rooms/${roomId}`).send({ maxMembers: 3 });
    expect(patch.status).toBe(200);
    expect(patch.body.data.maxMembers).toBe(3);

    const { sessionId: newSession } = await authedAgent();
    const join = await authed(app, newSession).post(`/v1/chat/rooms/${roomId}/join`);
    expect(join.status).toBe(409);
    expect(join.body.error).toBe('ROOM_FULL');
  });

  it('PATCH maxMembers nhỏ hơn số hiện tại → 400 VALIDATION', async () => {
    const { sessionId, roomId } = await makeGroupViaApi();
    const res = await authed(app, sessionId).patch(`/v1/chat/rooms/${roomId}`).send({ maxMembers: 2 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });
});

describe('AVATAR nhóm — routes', () => {
  it('OWNER upload PNG → 200; GET /avatar trả đúng ảnh; MEMBER upload → 403', async () => {
    const { sessionId, m1Session, roomId } = await makeGroupViaApi();

    const up = await authed(app, sessionId).post(`/v1/chat/rooms/${roomId}/avatar`).attach('file', PNG_1PX, 'g.png');
    expect(up.status).toBe(200);
    expect(up.body.data.avatarUrl).toBe(`/v1/chat/rooms/${roomId}/avatar`);

    const get = await authed(app, sessionId).get(`/v1/chat/rooms/${roomId}/avatar`);
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toContain('image/png');
    expect(Buffer.compare(get.body, PNG_1PX)).toBe(0);

    const memberUp = await authed(app, m1Session).post(`/v1/chat/rooms/${roomId}/avatar`).attach('file', PNG_1PX, 'g.png');
    expect(memberUp.status).toBe(403);
  });

  it('upload file giả mạo (text đổi đuôi) → 400 MIME_NOT_ALLOWED; chưa có ảnh → GET 200 PNG fallback (màu theo roomId, 8/8)', async () => {
    const { sessionId, roomId } = await makeGroupViaApi();
    const bad = await authed(app, sessionId).post(`/v1/chat/rooms/${roomId}/avatar`).attach('file', PLAIN_TEXT_AS_JPG, 'x.jpg');
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('MIME_NOT_ALLOWED');

    // Nhóm chưa đặt ảnh → KHÔNG còn 404, trả PNG fallback để Android/EXE hiển thị avatar đồng nhất với web.
    const get = await authed(app, sessionId).get(`/v1/chat/rooms/${roomId}/avatar`);
    expect(get.status).toBe(200);
    expect(get.headers['content-type']).toBe('image/png');
    expect(Buffer.from(get.body).subarray(0, 4).toString('latin1')).toBe('\x89PNG');
  });
});

describe('THĂNG/GIÁNG/CHUYỂN OWNER — routes (đã có sẵn, xác nhận)', () => {
  it('PATCH members/:id role ADMIN rồi OWNER (chuyển quyền) → requester tự hạ ADMIN', async () => {
    const { owner, sessionId, m1, roomId } = await makeGroupViaApi();
    const toAdmin = await authed(app, sessionId).patch(`/v1/chat/rooms/${roomId}/members/${m1.id}`).send({ role: 'ADMIN' });
    expect(toAdmin.status).toBe(200);

    const transfer = await authed(app, sessionId).patch(`/v1/chat/rooms/${roomId}/members/${m1.id}`).send({ role: 'OWNER' });
    expect(transfer.status).toBe(200);

    const db = getBotDb();
    const members = await db.chatRoomMember.findMany({ where: { roomId, leftAt: null } });
    const byId = new Map(members.map((mm) => [mm.agentId, mm.role]));
    expect(byId.get(m1.id)).toBe('OWNER');
    expect(byId.get(owner.id)).toBe('ADMIN');
  });
});
