// SIGMA (5/8, Admin Demo "màn Bảo mật chưa show thiết bị đang đăng nhập realtime") — GET /v1/me/sessions +
// POST /v1/me/sessions/:id/revoke (routes/me.ts) + broadcast realtime sessions-updated (chat-realtime-hub.ts).
// Chạy trên throwaway Postgres (global-setup.ts), cùng khuôn me-deletion.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { registerAgentConnection, resetChatRealtimeHubForTest, type ChatRealtimeConnection } from '../src/chat-realtime-hub.js';
import { makeAgent } from './fixtures.js';

function authHeaders(sessionId: string): Record<string, string> {
  return { Cookie: `${WEB_SESSION_COOKIE_NAME}=${sessionId}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
}

describe('Thiết bị đang đăng nhập — GET /v1/me/sessions, POST /v1/me/sessions/:id/revoke', () => {
  const app = createApp();

  afterEach(() => {
    resetChatRealtimeHubForTest();
  });

  it('thiếu auth → 401 cho cả 2 endpoint', async () => {
    const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    expect((await request(app).get('/v1/me/sessions').set(csrf)).status).toBe(401);
    expect((await request(app).post('/v1/me/sessions/bat-ky/revoke').set(csrf)).status).toBe(401);
  });

  it('GET trả MỌI phiên còn hạn, đánh dấu ĐÚNG 1 phiên hiện tại (khớp cookie)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const s1 = await createWebSession(db, { rcAuthToken: 'tok-1', agentId: agent.id });
    const s2 = await createWebSession(db, { rcAuthToken: 'tok-2', agentId: agent.id });

    // Đăng nhập/gọi bằng s1 → s1 là phiên "hiện tại".
    const res = await request(app).get('/v1/me/sessions').set(authHeaders(s1.id));
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ id: string; current: boolean; deviceLabel: string; createdAt: string; lastUsedAt: string }>;
    expect(items).toHaveLength(2);
    expect(items.filter((x) => x.current)).toHaveLength(1);
    expect(items.find((x) => x.current)!.id).toBe(s1.id);
    expect(items.find((x) => x.id === s2.id)!.current).toBe(false);
    // Có nhãn + mốc thời gian ISO hợp lệ (không rò rỉ token).
    expect(items[0].deviceLabel).toBe('Thiết bị web/app');
    expect(Number.isNaN(Date.parse(items[0].createdAt))).toBe(false);
    // 'kind' = loại thiết bị (pc/mobile) suy từ platform/User-Agent — field cố ý (me.ts parseDeviceKind), KHÔNG rò token.
    expect(Object.keys(items[0]).sort()).toEqual(['createdAt', 'current', 'deviceLabel', 'id', 'kind', 'lastUsedAt']);
  });

  it('GET suy nhãn thiết bị từ User-Agent đã lưu (kiểu Zalo) — UA rỗng → "Thiết bị web/app"', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const iphoneUa = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
    const s1 = await createWebSession(db, { rcAuthToken: 'tok-1', agentId: agent.id, userAgent: iphoneUa });
    await createWebSession(db, { rcAuthToken: 'tok-2', agentId: agent.id }); // không có UA → nhãn chung

    const res = await request(app).get('/v1/me/sessions').set(authHeaders(s1.id));
    expect(res.status).toBe(200);
    const items = res.body.items as Array<{ id: string; deviceLabel: string }>;
    expect(items.find((x) => x.id === s1.id)!.deviceLabel).toBe('Safari · iPhone');
    expect(items.filter((x) => x.deviceLabel === 'Thiết bị web/app')).toHaveLength(1);
  });

  it('revoke 1 thiết bị KHÁC → 200, danh sách còn lại đúng 1 (phiên hiện tại)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const s1 = await createWebSession(db, { rcAuthToken: 'tok-1', agentId: agent.id });
    const s2 = await createWebSession(db, { rcAuthToken: 'tok-2', agentId: agent.id });

    const revoke = await request(app).post(`/v1/me/sessions/${s2.id}/revoke`).set(authHeaders(s1.id));
    expect(revoke.status).toBe(200);
    expect(revoke.body).toEqual({ ok: true });

    const after = await request(app).get('/v1/me/sessions').set(authHeaders(s1.id));
    const items = after.body.items as Array<{ id: string; current: boolean }>;
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(s1.id);
    expect(items[0].current).toBe(true);

    // s2 thật sự bị xóa khỏi DB.
    expect(await db.webSession.findUnique({ where: { id: s2.id } })).toBeNull();
  });

  it('KHÔNG cho revoke phiên HIỆN TẠI → 400 CANNOT_REVOKE_CURRENT, phiên vẫn còn', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const s1 = await createWebSession(db, { rcAuthToken: 'tok-1', agentId: agent.id });

    const res = await request(app).post(`/v1/me/sessions/${s1.id}/revoke`).set(authHeaders(s1.id));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('CANNOT_REVOKE_CURRENT');
    expect(await db.webSession.findUnique({ where: { id: s1.id } })).not.toBeNull();
  });

  it('KHÔNG cho revoke phiên của agent KHÁC → 404, phiên đó CÒN NGUYÊN', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    const sA = await createWebSession(db, { rcAuthToken: 'tok-a', agentId: a.id });
    const sB = await createWebSession(db, { rcAuthToken: 'tok-b', agentId: b.id });

    const res = await request(app).post(`/v1/me/sessions/${sB.id}/revoke`).set(authHeaders(sA.id));
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('SESSION_NOT_FOUND');
    expect(await db.webSession.findUnique({ where: { id: sB.id } })).not.toBeNull();
  });

  it('revoke phát broadcast realtime {msg:"sessions-updated"} tới MỌI kết nối WS của agent', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const s1 = await createWebSession(db, { rcAuthToken: 'tok-1', agentId: agent.id });
    const s2 = await createWebSession(db, { rcAuthToken: 'tok-2', agentId: agent.id });

    // Giả lập 1 kết nối WS đang mở của agent (vd thiết bị khác đang mở app) — capture ws.send.
    const sent: string[] = [];
    const fakeConn = {
      ws: { readyState: 1, send: (t: string) => sent.push(t) },
      agentId: agent.id,
      sessionId: s2.id
    } as unknown as ChatRealtimeConnection;
    registerAgentConnection(agent.id, fakeConn);

    const res = await request(app).post(`/v1/me/sessions/${s2.id}/revoke`).set(authHeaders(s1.id));
    expect(res.status).toBe(200);

    expect(sent).toHaveLength(1);
    expect(JSON.parse(sent[0])).toEqual({ msg: 'sessions-updated' });
  });

  it('revoke THẤT BẠI (404 agent khác) KHÔNG phát broadcast', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    const sA = await createWebSession(db, { rcAuthToken: 'tok-a', agentId: a.id });
    const sB = await createWebSession(db, { rcAuthToken: 'tok-b', agentId: b.id });

    const sent: string[] = [];
    const fakeConn = {
      ws: { readyState: 1, send: (t: string) => sent.push(t) },
      agentId: a.id,
      sessionId: sA.id
    } as unknown as ChatRealtimeConnection;
    registerAgentConnection(a.id, fakeConn);

    const res = await request(app).post(`/v1/me/sessions/${sB.id}/revoke`).set(authHeaders(sA.id));
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0); // KHÔNG broadcast khi revoke không thành công.
  });
});
