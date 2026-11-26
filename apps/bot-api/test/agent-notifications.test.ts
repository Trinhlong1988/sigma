// SIGMA B113 (2/8, Admin Demo báo trực tiếp kèm ảnh chụp thật: "tài khoản khác cũng phải có thông báo bạn bè
// cập nhật avatar") — regression cho notification-service.ts + 2 route mới (GET /v1/me/notifications, POST
// /v1/me/notifications/mark-read) + nhánh gọi notifyFriendsOfMediaUpdate() SAU khi POST /v1/me/avatar|cover
// lưu ảnh thành công (routes/me.ts). CÙNG khuôn agent-media-routes.test.ts (createApp()+supertest, WebSession
// thật) + me-friends.test.ts (makeFriends() fixture cho quan hệ ACCEPTED).
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeFriends } from './fixtures.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { markAllNotificationsRead, notifyFriendsOfMediaUpdate } from '../src/notification-service.js';

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

let uniqCounter = 0;
async function authedAgent(name?: string) {
  uniqCounter += 1;
  const rcUserId = `rc-agentnotif-${Date.now()}-${uniqCounter}`;
  const db = getBotDb();
  const agent = await makeAgent(undefined, { name });
  await db.agent.update({ where: { id: agent.id }, data: { rcUserId, rcUsername: `agentnotif${uniqCounter}` } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: `dummy-tok-${uniqCounter}`, agentId: agent.id });
  return { agent, sessionId: ws.id };
}

function authed(app: ReturnType<typeof createApp>, sessionId: string) {
  return {
    get: (path: string) => request(app).get(path).set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionId}`).set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE),
    post: (path: string) => request(app).post(path).set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionId}`).set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
  };
}

describe('B113 — thông báo bạn bè khi đổi avatar/ảnh bìa', () => {
  const app = createApp();

  it('A đổi avatar → B (bạn bè ACCEPTED) nhận 1 thông báo AVATAR_UPDATED; người KHÔNG phải bạn bè KHÔNG nhận', async () => {
    const { agent: a, sessionId: sA } = await authedAgent('Nguyễn Văn A');
    const { agent: b } = await authedAgent('Trần Thị B');
    const { agent: stranger } = await authedAgent('Người lạ C');
    await makeFriends(a.id, b.id);

    const res = await authed(app, sA).post('/v1/me/avatar').attach('file', PNG_1PX, 'avatar.png');
    expect(res.status).toBe(200);

    const db = getBotDb();
    const bNotifs = await db.agentNotification.findMany({ where: { recipientAgentId: b.id } });
    expect(bNotifs).toHaveLength(1);
    expect(bNotifs[0].type).toBe('AVATAR_UPDATED');
    expect(bNotifs[0].actorAgentId).toBe(a.id);
    expect(bNotifs[0].readAt).toBeNull();

    const strangerNotifs = await db.agentNotification.findMany({ where: { recipientAgentId: stranger.id } });
    expect(strangerNotifs).toHaveLength(0);
  });

  it('A đổi ảnh bìa → B nhận thông báo COVER_UPDATED (khác loại AVATAR_UPDATED)', async () => {
    const { agent: a, sessionId: sA } = await authedAgent();
    const { agent: b } = await authedAgent();
    await makeFriends(a.id, b.id);

    const res = await authed(app, sA).post('/v1/me/cover').attach('file', PNG_1PX, 'cover.png');
    expect(res.status).toBe(200);

    const db = getBotDb();
    const bNotifs = await db.agentNotification.findMany({ where: { recipientAgentId: b.id } });
    expect(bNotifs).toHaveLength(1);
    expect(bNotifs[0].type).toBe('COVER_UPDATED');
  });

  it('lời mời kết bạn còn PENDING (chưa ACCEPTED) → người được mời KHÔNG nhận thông báo khi đổi avatar', async () => {
    const { agent: a, sessionId: sA } = await authedAgent();
    const { agent: b } = await authedAgent();
    const db = getBotDb();
    await db.friendRequest.create({ data: { fromAgentId: a.id, toAgentId: b.id, status: 'PENDING' } });

    const res = await authed(app, sA).post('/v1/me/avatar').attach('file', PNG_1PX, 'avatar.png');
    expect(res.status).toBe(200);

    const bNotifs = await db.agentNotification.findMany({ where: { recipientAgentId: b.id } });
    expect(bNotifs).toHaveLength(0);
  });

  it('A có 0 bạn bè → đổi avatar vẫn 200 OK, KHÔNG tạo thông báo nào (no-op an toàn)', async () => {
    const { sessionId } = await authedAgent();
    const res = await authed(app, sessionId).post('/v1/me/avatar').attach('file', PNG_1PX, 'avatar.png');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('upload lỗi (MIME sai) → KHÔNG gọi notifyFriendsOfMediaUpdate, KHÔNG tạo thông báo', async () => {
    const { agent: a, sessionId: sA } = await authedAgent();
    const { agent: b } = await authedAgent();
    await makeFriends(a.id, b.id);

    const res = await authed(app, sA).post('/v1/me/avatar').attach('file', Buffer.from('khong phai anh'), 'fake.png');
    expect(res.status).toBe(400);

    const db = getBotDb();
    const bNotifs = await db.agentNotification.findMany({ where: { recipientAgentId: b.id } });
    expect(bNotifs).toHaveLength(0);
  });
});

describe('GET /v1/me/notifications', () => {
  const app = createApp();

  it('chưa đăng nhập → 401', async () => {
    const res = await request(app).get('/v1/me/notifications').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
  });

  it('đếm unreadCount đúng + hiện tên actor thật, mới nhất trước', async () => {
    const { agent: a, sessionId: sA } = await authedAgent();
    const { agent: actor1 } = await authedAgent('Đại lý Một');
    const { agent: actor2 } = await authedAgent('Đại lý Hai');
    const db = getBotDb();

    await db.agentNotification.create({ data: { recipientAgentId: a.id, actorAgentId: actor1.id, type: 'AVATAR_UPDATED' } });
    await new Promise((r) => setTimeout(r, 5)); // tách createdAt để orderBy desc xác định thứ tự deterministic
    await db.agentNotification.create({ data: { recipientAgentId: a.id, actorAgentId: actor2.id, type: 'COVER_UPDATED' } });

    const res = await authed(app, sA).get('/v1/me/notifications');
    expect(res.status).toBe(200);
    expect(res.body.unreadCount).toBe(2);
    expect(res.body.notifications).toHaveLength(2);
    // mới nhất (actor2, COVER_UPDATED) đứng đầu.
    expect(res.body.notifications[0].actorAgentName).toBe('Đại lý Hai');
    expect(res.body.notifications[0].type).toBe('COVER_UPDATED');
    expect(res.body.notifications[1].actorAgentName).toBe('Đại lý Một');
  });

  it('thông báo của NGƯỜI KHÁC không lẫn vào danh sách của mình', async () => {
    const { agent: a, sessionId: sA } = await authedAgent();
    const { agent: other } = await authedAgent();
    const { agent: actor } = await authedAgent();
    const db = getBotDb();
    await db.agentNotification.create({ data: { recipientAgentId: other.id, actorAgentId: actor.id, type: 'AVATAR_UPDATED' } });

    const res = await authed(app, sA).get('/v1/me/notifications');
    expect(res.status).toBe(200);
    expect(res.body.notifications).toHaveLength(0);
    expect(res.body.unreadCount).toBe(0);
  });
});

describe('POST /v1/me/notifications/mark-read', () => {
  const app = createApp();

  it('chưa đăng nhập → 401', async () => {
    const res = await request(app).post('/v1/me/notifications/mark-read').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
  });

  it('đánh dấu TOÀN BỘ thông báo chưa đọc thành đã đọc → GET sau đó unreadCount về 0, readAt đã set', async () => {
    const { agent: a, sessionId: sA } = await authedAgent();
    const { agent: actor } = await authedAgent();
    const db = getBotDb();
    await db.agentNotification.create({ data: { recipientAgentId: a.id, actorAgentId: actor.id, type: 'AVATAR_UPDATED' } });
    await db.agentNotification.create({ data: { recipientAgentId: a.id, actorAgentId: actor.id, type: 'COVER_UPDATED' } });

    const markRes = await authed(app, sA).post('/v1/me/notifications/mark-read');
    expect(markRes.status).toBe(200);
    expect(markRes.body).toEqual({ ok: true, updatedCount: 2 });

    const getRes = await authed(app, sA).get('/v1/me/notifications');
    expect(getRes.body.unreadCount).toBe(0);
    expect(getRes.body.notifications.every((n: { readAt: string | null }) => n.readAt !== null)).toBe(true);
  });

  it('gọi mark-read khi KHÔNG có thông báo nào chưa đọc → updatedCount 0, KHÔNG lỗi', async () => {
    const { sessionId } = await authedAgent();
    const res = await authed(app, sessionId).post('/v1/me/notifications/mark-read');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, updatedCount: 0 });
  });

  it('mark-read của A KHÔNG đụng thông báo chưa đọc của B (cách ly theo recipientAgentId)', async () => {
    const { agent: a, sessionId: sA } = await authedAgent();
    const { agent: b } = await authedAgent();
    const { agent: actor } = await authedAgent();
    const db = getBotDb();
    await db.agentNotification.create({ data: { recipientAgentId: a.id, actorAgentId: actor.id, type: 'AVATAR_UPDATED' } });
    await db.agentNotification.create({ data: { recipientAgentId: b.id, actorAgentId: actor.id, type: 'AVATAR_UPDATED' } });

    await authed(app, sA).post('/v1/me/notifications/mark-read');

    const bNotif = await db.agentNotification.findFirst({ where: { recipientAgentId: b.id } });
    expect(bNotif!.readAt).toBeNull();
  });
});

describe('notifyFriendsOfMediaUpdate() — hàm thuần service layer', () => {
  it('actorAgentId không tồn tại (agent đã bị xoá thật) → KHÔNG throw (best-effort, R198 log lỗi rõ ràng thay vì crash luồng upload)', async () => {
    const db = getBotDb();
    await expect(notifyFriendsOfMediaUpdate(db, 999999999, 'avatar')).resolves.toBeUndefined();
  });

  it('markAllNotificationsRead trên agentId không có thông báo nào → updatedCount 0', async () => {
    const db = getBotDb();
    const { agent } = await authedAgent();
    const r = await markAllNotificationsRead(db, agent.id);
    expect(r.updatedCount).toBe(0);
  });
});
