// SIGMA "Phân loại" (mục 21, việc #4, 31/7) — 5 route /v1/me/categories* + /v1/me/chat-rooms/:roomId/
// category (routes/me.ts), business logic chat-category-service.ts. CÙNG khuôn me-friends.test.ts (session
// cookie qua createWebSession + CSRF header, KHÔNG còn Bearer/RC token cũ). CHƯA CHẠY ĐƯỢC cho tới khi LEAD
// `prisma migrate deploy` + `prisma generate` (bảng chat_categories/cột category_id chưa có trong client
// Prisma dùng chung) — xem BUGS_FIXED.md, đây là hệ quả TẤT YẾU đã biết trước.
import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { makeAgent, makeChatRoom, makeChatRoomMember } from './fixtures.js';

let rcCounter = 0;
function nextRcUserId(): string {
  rcCounter += 1;
  return `rc-me-categories-test-${Date.now()}-${rcCounter}`;
}

async function linkAgentToRc(agentId: number): Promise<{ headers: Record<string, string> }> {
  const db = getBotDb();
  const rcUserId = nextRcUserId();
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: rcUserId } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: 'test-tok', agentId });
  return { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } };
}

describe('/v1/me/categories* + /v1/me/chat-rooms/:roomId/category — Phân loại (mục 21)', () => {
  const app = createApp();

  it('thiếu session → 401 cho cả 5 endpoint', async () => {
    const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    expect((await request(app).get('/v1/me/categories').set(csrf)).status).toBe(401);
    expect((await request(app).post('/v1/me/categories').set(csrf).send({ name: 'X', color: '#111111' })).status).toBe(401);
    expect((await request(app).patch('/v1/me/categories/x').set(csrf).send({ name: 'X' })).status).toBe(401);
    expect((await request(app).delete('/v1/me/categories/x').set(csrf)).status).toBe(401);
    expect((await request(app).patch('/v1/me/chat-rooms/r1/category').set(csrf).send({ categoryId: null })).status).toBe(401);
  });

  it('GET /v1/me/categories rỗng cho agent mới, POST tạo mới → 201 kèm roomIds rỗng', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);

    const list0 = await request(app).get('/v1/me/categories').set(headers);
    expect(list0.status).toBe(200);
    expect(list0.body).toEqual([]);

    const created = await request(app).post('/v1/me/categories').set(headers).send({ name: 'Gia đình', color: '#16a34a' });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('Gia đình');
    expect(created.body.color).toBe('#16a34a');
    expect(created.body.roomIds).toEqual([]);

    const list1 = await request(app).get('/v1/me/categories').set(headers);
    expect(list1.status).toBe(200);
    expect(list1.body.length).toBe(1);
    expect(list1.body[0].id).toBe(created.body.id);
  });

  it('POST /v1/me/categories: name rỗng → 400 VALIDATION', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const res = await request(app).post('/v1/me/categories').set(headers).send({ name: '  ', color: '#111111' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('PATCH /v1/me/categories/:categoryId: chủ sở hữu sửa OK; agent khác → 404 NOT_FOUND', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);

    const created = await request(app).post('/v1/me/categories').set(hA).send({ name: 'Công việc', color: '#1657d0' });
    const categoryId = created.body.id as string;

    const okRes = await request(app).patch(`/v1/me/categories/${categoryId}`).set(hA).send({ name: 'Công việc mới' });
    expect(okRes.status).toBe(200);
    expect(okRes.body.name).toBe('Công việc mới');

    const forbiddenRes = await request(app).patch(`/v1/me/categories/${categoryId}`).set(hB).send({ name: 'Hack' });
    expect(forbiddenRes.status).toBe(404);
    expect(forbiddenRes.body.error).toBe('NOT_FOUND');
  });

  it('DELETE /v1/me/categories/:categoryId: agent khác → 404; chủ sở hữu xóa → 200, biến mất khỏi GET list', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);

    const created = await request(app).post('/v1/me/categories').set(hA).send({ name: 'Khách hàng', color: '#f59e0b' });
    const categoryId = created.body.id as string;

    const forbiddenRes = await request(app).delete(`/v1/me/categories/${categoryId}`).set(hB);
    expect(forbiddenRes.status).toBe(404);
    expect(forbiddenRes.body.error).toBe('NOT_FOUND');

    const okRes = await request(app).delete(`/v1/me/categories/${categoryId}`).set(hA);
    expect(okRes.status).toBe(200);

    const list = await request(app).get('/v1/me/categories').set(hA);
    expect(list.body).toEqual([]);
  });

  it('PATCH /v1/me/chat-rooms/:roomId/category: thiếu field categoryId → 400 VALIDATION', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const res = await request(app).patch('/v1/me/chat-rooms/room-x/category').set(headers).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('PATCH /v1/me/chat-rooms/:roomId/category: không phải thành viên phòng → 403 NOT_MEMBER', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const room = await makeChatRoom();
    await makeChatRoomMember(room.id, a.id); // chỉ A là thành viên

    const created = await request(app).post('/v1/me/categories').set(hB).send({ name: 'X', color: '#111111' });
    const res = await request(app).patch(`/v1/me/chat-rooms/${room.id}/category`).set(hB).send({ categoryId: created.body.id });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('NOT_MEMBER');
  });

  it('PATCH /v1/me/chat-rooms/:roomId/category: gán category của người khác → 404 NOT_FOUND (IDOR)', async () => {
    const a = await makeAgent();
    const b = await makeAgent();
    const { headers: hA } = await linkAgentToRc(a.id);
    const { headers: hB } = await linkAgentToRc(b.id);
    const room = await makeChatRoom();
    await makeChatRoomMember(room.id, b.id); // B là thành viên phòng

    const createdByA = await request(app).post('/v1/me/categories').set(hA).send({ name: 'Gia đình', color: '#16a34a' });

    const res = await request(app).patch(`/v1/me/chat-rooms/${room.id}/category`).set(hB).send({ categoryId: createdByA.body.id });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('PATCH /v1/me/chat-rooms/:roomId/category: happy path gán + gỡ (null), GET /v1/me/categories phản ánh đúng roomIds', async () => {
    const a = await makeAgent();
    const { headers } = await linkAgentToRc(a.id);
    const room = await makeChatRoom();
    await makeChatRoomMember(room.id, a.id);

    const created = await request(app).post('/v1/me/categories').set(headers).send({ name: 'Gia đình', color: '#16a34a' });
    const categoryId = created.body.id as string;

    const assignRes = await request(app).patch(`/v1/me/chat-rooms/${room.id}/category`).set(headers).send({ categoryId });
    expect(assignRes.status).toBe(200);
    expect(assignRes.body).toEqual({ roomId: room.id, categoryId });

    const listAfterAssign = await request(app).get('/v1/me/categories').set(headers);
    expect(listAfterAssign.body[0].roomIds).toEqual([room.id]);

    const unassignRes = await request(app).patch(`/v1/me/chat-rooms/${room.id}/category`).set(headers).send({ categoryId: null });
    expect(unassignRes.status).toBe(200);
    expect(unassignRes.body).toEqual({ roomId: room.id, categoryId: null });

    const listAfterUnassign = await request(app).get('/v1/me/categories').set(headers);
    expect(listAfterUnassign.body[0].roomIds).toEqual([]);
  });
});
