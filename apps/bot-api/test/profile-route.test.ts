// LOẠI SẠCH Rocket.Chat (4/8) — test endpoint NỘI BỘ `GET /v1/profile/by-username/:username` thay thế lời
// gọi RC `users.info` cũ (xem routes/profile.ts + apps/web-demo/src/lib/rc-realtime.ts getRcUserInfoByUsername).
// Đọc thẳng bảng Agent, KHÔNG chạm Rocket.Chat. Dùng WebSession thật (throwaway DB) làm phiên hợp lệ cho
// requireSession — CÙNG khuôn me-deletion.test.ts.
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { makeAgent } from './fixtures.js';

const app = createApp();

// Phiên ĐỘC LẬP RC: chỉ agentId (rcUserId/rcAuthToken null) — session-middleware ưu tiên rcUserId nếu có nên
// KHÔNG set rcUserId ở đây (caller agent do makeAgent tạo không có rcUserId, sẽ tra theo agentId).
async function authHeadersFor(agentId: number): Promise<Record<string, string>> {
  const db = getBotDb();
  const ws = await createWebSession(db, { agentId });
  return { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
}

describe('GET /v1/profile/by-username/:username — hồ sơ công khai nội bộ (không Rocket.Chat)', () => {
  it('thiếu phiên → 401 (requireSession), KHÔNG lộ dữ liệu', async () => {
    const res = await request(app).get('/v1/profile/by-username/khong-quan-trong').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
  });

  it('username đã link Agent (chưa có avatar) → 200 {name, username}, avatarUrl undefined', async () => {
    const rcUsername = `prof_target_${Date.now()}`;
    const target = await makeAgent(undefined, { rcUsername, name: 'Nguyễn Văn Mục Tiêu' });
    const caller = await makeAgent();
    const headers = await authHeadersFor(caller.id);

    const res = await request(app).get(`/v1/profile/by-username/${encodeURIComponent(rcUsername)}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Nguyễn Văn Mục Tiêu');
    expect(res.body.username).toBe(rcUsername);
    expect(res.body.avatarUrl).toBeUndefined();
    // KHÔNG rò cột nhạy cảm nào khác (email/phone/id) — chỉ đúng 3 field public.
    expect(Object.keys(res.body).sort()).toEqual(['name', 'username']);
    void target;
  });

  it('Agent CÓ avatar (avatarUpdatedAt set) → avatarUrl trỏ /v1/agents/:id/avatar', async () => {
    const db = getBotDb();
    const rcUsername = `prof_avatar_${Date.now()}`;
    const target = await makeAgent(undefined, { rcUsername, name: 'Có Ảnh' });
    await db.agent.update({ where: { id: target.id }, data: { avatarUpdatedAt: new Date() } });
    const caller = await makeAgent();
    const headers = await authHeadersFor(caller.id);

    const res = await request(app).get(`/v1/profile/by-username/${encodeURIComponent(rcUsername)}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.avatarUrl).toBe(`/v1/agents/${target.id}/avatar`);
  });

  it('username chưa link Agent nào → 404 NOT_FOUND (không bịa dữ liệu)', async () => {
    const caller = await makeAgent();
    const headers = await authHeadersFor(caller.id);
    const res = await request(app).get('/v1/profile/by-username/khong-ton-tai-abc-xyz').set(headers);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('Agent đã xóa mềm (deletedAt) → 404, KHÔNG trả hồ sơ tài khoản đã xóa', async () => {
    const db = getBotDb();
    const rcUsername = `prof_deleted_${Date.now()}`;
    const target = await makeAgent(undefined, { rcUsername, name: 'Đã Xóa' });
    await db.agent.update({ where: { id: target.id }, data: { deletedAt: new Date(), deletedBy: target.id } });
    const caller = await makeAgent();
    const headers = await authHeadersFor(caller.id);

    const res = await request(app).get(`/v1/profile/by-username/${encodeURIComponent(rcUsername)}`).set(headers);
    expect(res.status).toBe(404);
  });
});
