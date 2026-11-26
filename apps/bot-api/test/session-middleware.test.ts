// B39 (27/7) — regression cho requireSession (session-middleware.ts), middleware THAY requireRcAuth để loại
// bỏ lượt gọi mạng rcGetMe trên MỖI request (Rocket.Chat áp rate-limit thấp cho token tài khoản thường, ~4 lượt
// gọi liên tiếp là 401 — xem BUGS_FIXED.md B39). KHÔNG mock rc-client (middleware này KHÔNG gọi RC nữa — đó
// chính là điểm khác biệt cốt lõi cần test).
//
// BÀI HỌC ĐƯA VÀO TEST (2 lần sửa sai liên tiếp ngay sau khi ship lần đầu, Admin Demo báo lỗi thật trên máy thật
// cả 2 lần): mọi test tạo WebSession qua `createWebSession()` bình thường LUÔN có agentId set đúng ngay từ đầu
// — KHÔNG BAO GIỜ tự lộ ra lớp bug "WebSession có agentId=NULL nhưng rcUserId vẫn hợp lệ" (đúng hình dạng phiên
// CŨ/mọi phiên tạo trước khi cột agentId được điền, hoặc client dual-write agentId thất bại). PHẢI test tường
// minh case agentId=NULL riêng — đây là quy tắc mới: mọi middleware xác thực đổi/thay thế PHẢI có test cho
// TỪNG tổ hợp (agentId có/không) × (rcUserId có/không), KHÔNG chỉ test "happy path" 1 tài khoản mới tạo.
import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { makeAgent } from './fixtures.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { requireSession } from '../src/session-middleware.js';

function buildTestApp() {
  const app = express();
  app.use(cookieParser());
  app.get('/protected', requireSession, (req, res) => {
    res.json({ agent: req.agent });
  });
  return app;
}

function authedRequest(app: express.Express, sessionId: string) {
  return request(app)
    .get('/protected')
    .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${sessionId}`)
    .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
}

describe('session-middleware — requireSession', () => {
  it('thiếu cookie → 401 SESSION_INVALID', async () => {
    const app = buildTestApp();
    const res = await request(app).get('/protected').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('SESSION_INVALID');
  });

  it('thiếu header CSRF dù có cookie hợp lệ → 403 CSRF_BLOCKED', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await db.agent.update({ where: { id: agent.id }, data: { rcUserId: 'rc-csrf-1', rcUsername: 'csrf1' } });
    const ws = await createWebSession(db, { rcUserId: 'rc-csrf-1', rcAuthToken: 'dummy-tok', agentId: agent.id });
    const app = buildTestApp();
    const res = await request(app).get('/protected').set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${ws.id}`);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('CSRF_BLOCKED');
  });

  it('cookie trỏ session không tồn tại → 401 SESSION_INVALID', async () => {
    const app = buildTestApp();
    const res = await authedRequest(app, 'khong-ton-tai');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('SESSION_INVALID');
  });

  it('agentId set ĐÚNG + Agent tồn tại → 200 (happy path bình thường)', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await db.agent.update({ where: { id: agent.id }, data: { rcUserId: 'rc-happy-1', rcUsername: 'happy1' } });
    const ws = await createWebSession(db, { rcUserId: 'rc-happy-1', rcAuthToken: 'dummy-tok', agentId: agent.id });
    const app = buildTestApp();
    const res = await authedRequest(app, ws.id);
    expect(res.status).toBe(200);
    expect(res.body.agent.id).toBe(agent.id);
  });

  // === B39 regression: đúng triệu chứng Admin Demo báo thật lần 1 ("phiên đã hết hạn" dù đã đăng nhập) ===
  it('agentId=NULL nhưng rcUserId hợp lệ khớp đúng 1 Agent (kiểu phiên CŨ) → VẪN 200, KHÔNG 401 oan', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await db.agent.update({ where: { id: agent.id }, data: { rcUserId: 'rc-null-agentid-1', rcUsername: 'nullagentid1' } });
    // Mô phỏng ĐÚNG hình dạng phiên cũ Admin Demo gặp phải: KHÔNG truyền agentId lúc tạo session.
    const ws = await createWebSession(db, { rcUserId: 'rc-null-agentid-1', rcAuthToken: 'dummy-tok' });
    const dbCheck = await db.webSession.findUnique({ where: { id: ws.id } });
    expect(dbCheck?.agentId).toBeNull(); // xác nhận đúng tiền đề test trước khi assert hành vi middleware

    const app = buildTestApp();
    const res = await authedRequest(app, ws.id);
    expect(res.status).toBe(200);
    expect(res.body.agent.id).toBe(agent.id);
  });

  // === B39 regression: đúng triệu chứng Admin Demo báo thật lần 2 ("chưa liên kết đại lý" sau lần sửa 1) ===
  it('agentId trỏ SAI/CŨ (agent khác) nhưng rcUserId khớp đúng Agent thật → ưu tiên rcUserId, vào ĐÚNG Agent', async () => {
    const db = getBotDb();
    const staleAgent = await makeAgent();
    const correctAgent = await makeAgent();
    await db.agent.update({ where: { id: correctAgent.id }, data: { rcUserId: 'rc-stale-priority-1', rcUsername: 'stalepri1' } });
    const ws = await createWebSession(db, { rcUserId: 'rc-stale-priority-1', rcAuthToken: 'dummy-tok', agentId: staleAgent.id });

    const app = buildTestApp();
    const res = await authedRequest(app, ws.id);
    expect(res.status).toBe(200);
    // PHẢI vào đúng Agent theo rcUserId (nguồn xác thực chính), KHÔNG phải theo agentId lệch trên WebSession.
    expect(res.body.agent.id).toBe(correctAgent.id);
  });

  it('rcUserId hợp lệ nhưng KHÔNG Agent nào link (đúng kiểu Agent chưa được tạo, xem B39 case tài khoản Long) → 401 AGENT_NOT_LINKED', async () => {
    const db = getBotDb();
    const ws = await createWebSession(db, { rcUserId: 'rc-orphan-no-agent-1', rcAuthToken: 'dummy-tok' });
    const app = buildTestApp();
    const res = await authedRequest(app, ws.id);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AGENT_NOT_LINKED');
  });

  it('Agent bị xóa mềm (deletedAt) → coi như KHÔNG link, 401 AGENT_NOT_LINKED', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    await db.agent.update({ where: { id: agent.id }, data: { rcUserId: 'rc-deleted-1', deletedAt: new Date() } });
    const ws = await createWebSession(db, { rcUserId: 'rc-deleted-1', rcAuthToken: 'dummy-tok', agentId: agent.id });
    const app = buildTestApp();
    const res = await authedRequest(app, ws.id);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AGENT_NOT_LINKED');
  });
});
