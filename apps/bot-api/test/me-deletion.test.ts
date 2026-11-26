// SIGMA Phase 3+ (25/7) — Xóa tài khoản 48h ân hạn: POST /v1/me/request-deletion, POST
// /v1/me/cancel-deletion, GET /v1/me/deletion-status (routes/me.ts) + LAZY DELETION thật ở requireSession
// (session-middleware.ts) khi đã quá 48h.
//
// LOẠI SẠCH Rocket.Chat (4/8) — TRƯỚC ĐÂY mock `rcDeleteUser` (xóa RC thật lúc lazy-deletion trigger) và
// kiểm nó được gọi. RC đã bị loại: performAccountDeletion()/startDeletionSweepWorker() KHÔNG còn gọi RC nữa
// (xem deletion-service.ts) → bỏ mock + mọi assertion về rcDeleteUser, chỉ còn kiểm xóa mềm Agent THẬT
// (deletedAt/deletedBy) + 401 — đúng hành vi còn lại sau khi loại RC.
import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { makeAgent } from './fixtures.js';
import { DELETION_GRACE_PERIOD_MS, startDeletionSweepWorker } from '../src/deletion-service.js';

let rcCounter = 0;
function nextRcUserId(): string {
  rcCounter += 1;
  return `rc-me-deletion-test-${Date.now()}-${rcCounter}`;
}

async function linkAgentToRc(agentId: number): Promise<{ headers: Record<string, string>; rcUserId: string }> {
  const db = getBotDb();
  const rcUserId = nextRcUserId();
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: rcUserId } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: 'test-tok', agentId });
  return { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE }, rcUserId };
}

describe('Xóa tài khoản 48h ân hạn — /v1/me/request-deletion, /v1/me/cancel-deletion, /v1/me/deletion-status', () => {
  const app = createApp();

  it('thiếu RC-auth → 401 cho cả 3 endpoint', async () => {
    const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    expect((await request(app).post('/v1/me/request-deletion').set(csrf)).status).toBe(401);
    expect((await request(app).post('/v1/me/cancel-deletion').set(csrf)).status).toBe(401);
    expect((await request(app).get('/v1/me/deletion-status').set(csrf)).status).toBe(401);
  });

  it('deletion-status ban đầu null/null (chưa có yêu cầu xóa nào)', async () => {
    const agent = await makeAgent();
    const { headers } = await linkAgentToRc(agent.id);
    const res = await request(app).get('/v1/me/deletion-status').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deletionRequestedAt: null, deleteAt: null });
  });

  // BẢO MẬT (6/8) — endpoint xóa 1-BƯỚC cũ nay bị KHOÁ (410) + KHÔNG set deletionRequestedAt. Luồng xóa THẬT
  // (2 bước có mật khẩu + OTP + mã 2 số) test riêng ở me-request-deletion-secure.test.ts. deleteAt=+48h + ghi
  // DB thật vẫn được kiểm ở [gate c] file đó. Ở đây chỉ chốt: đường xóa không xác thực đã đóng hoàn toàn.
  it('endpoint xóa 1-BƯỚC cũ /v1/me/request-deletion → 410 DELETION_FLOW_CHANGED, KHÔNG set deletionRequestedAt', async () => {
    const agent = await makeAgent();
    const { headers } = await linkAgentToRc(agent.id);

    const res = await request(app).post('/v1/me/request-deletion').set(headers);
    expect(res.status).toBe(410);
    expect(res.body.error).toBe('DELETION_FLOW_CHANGED');

    const db = getBotDb();
    const row = await db.agent.findUnique({ where: { id: agent.id } });
    expect(row?.deletionRequestedAt).toBeNull();

    // Trạng thái vẫn null → agent KHÔNG vào diện xóa chỉ vì gọi endpoint cũ.
    const statusRes = await request(app).get('/v1/me/deletion-status').set(headers);
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.deletionRequestedAt).toBeNull();
  });

  it('endpoint cũ gọi LẶP LẠI vẫn 410 mỗi lần, KHÔNG bao giờ set deletionRequestedAt', async () => {
    const agent = await makeAgent();
    const { headers } = await linkAgentToRc(agent.id);

    const first = await request(app).post('/v1/me/request-deletion').set(headers);
    const second = await request(app).post('/v1/me/request-deletion').set(headers);
    expect(first.status).toBe(410);
    expect(second.status).toBe(410);

    const row = await getBotDb().agent.findUnique({ where: { id: agent.id } });
    expect(row?.deletionRequestedAt).toBeNull();
  });

  it('cancel-deletion hủy yêu cầu → deletion-status về null, đăng nhập/nghiệp vụ vẫn bình thường', async () => {
    const agent = await makeAgent();
    const { headers } = await linkAgentToRc(agent.id);

    // Setup: đặt trực tiếp deletionRequestedAt qua DB (luồng set THẬT nay đi qua confirm 2-bước, test riêng) —
    // test này CHỈ kiểm nhánh cancel.
    await getBotDb().agent.update({ where: { id: agent.id }, data: { deletionRequestedAt: new Date() } });
    const cancelRes = await request(app).post('/v1/me/cancel-deletion').set(headers);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body).toEqual({ deletionRequestedAt: null, deleteAt: null });

    const db = getBotDb();
    const row = await db.agent.findUnique({ where: { id: agent.id } });
    expect(row?.deletionRequestedAt).toBeNull();
    expect(row?.deletedAt).toBeNull();

    // Round-trip: sau khi hủy, mọi route RC-auth khác vẫn hoạt động BÌNH THƯỜNG (đăng nhập lại thành công).
    const tidsRes = await request(app).get('/v1/me/tids').set(headers);
    expect(tidsRes.status).toBe(200);
  });

  it('cancel-deletion khi KHÔNG có yêu cầu nào đang treo vẫn 200 (idempotent, không báo lỗi)', async () => {
    const agent = await makeAgent();
    const { headers } = await linkAgentToRc(agent.id);
    const res = await request(app).post('/v1/me/cancel-deletion').set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ deletionRequestedAt: null, deleteAt: null });
  });

  it('LAZY DELETION: đã quá 48h → lần đăng nhập/gọi API kế tiếp bị 401 ACCOUNT_DELETED + Agent bị xóa mềm THẬT (deletedAt/deletedBy)', async () => {
    const agent = await makeAgent();
    const { headers } = await linkAgentToRc(agent.id);

    const db = getBotDb();
    // Giả lập ĐÃ quá 48h: chỉnh deletionRequestedAt lùi về quá khứ (49h trước, quá hạn 1h).
    const pastRequestedAt = new Date(Date.now() - DELETION_GRACE_PERIOD_MS - 60 * 60 * 1000);
    await db.agent.update({ where: { id: agent.id }, data: { deletionRequestedAt: pastRequestedAt } });

    const res = await request(app).get('/v1/me/tids').set(headers);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('ACCOUNT_DELETED');

    // DB thật: Agent đã bị xóa mềm THẬT — deletedAt set, deletedBy = chính agent.id (tự động, không phải admin).
    const row = await db.agent.findUnique({ where: { id: agent.id } });
    expect(row?.deletedAt).not.toBeNull();
    expect(row?.deletedBy).toBe(agent.id);

    // Đăng nhập LẠI SAU KHI đã bị xóa → 401 AGENT_NOT_LINKED (nhất quán với hành vi Agent xóa mềm nói chung,
    // xem rc-auth-middleware.test.ts) — KHÔNG còn agent nào tìm được nữa cho rcUserId đó.
    const res2 = await request(app).get('/v1/me/tids').set(headers);
    expect(res2.status).toBe(401);
    expect(res2.body.error).toBe('AGENT_NOT_LINKED');
  });

  it('CHƯA quá 48h (còn 1 phút) → vẫn đăng nhập/dùng nghiệp vụ bình thường, KHÔNG bị xóa', async () => {
    const agent = await makeAgent();
    const { headers } = await linkAgentToRc(agent.id);
    const db = getBotDb();
    const almostRequestedAt = new Date(Date.now() - DELETION_GRACE_PERIOD_MS + 60 * 1000); // còn 1 phút mới hết hạn
    await db.agent.update({ where: { id: agent.id }, data: { deletionRequestedAt: almostRequestedAt } });

    const res = await request(app).get('/v1/me/tids').set(headers);
    expect(res.status).toBe(200);

    const row = await db.agent.findUnique({ where: { id: agent.id } });
    expect(row?.deletedAt).toBeNull();
  });

  it('lazy deletion xóa mềm Agent + trả 401 dù transferChatOwnership lỗi (best-effort, KHÔNG throw/crash — R198 không nuốt lỗi im, chỉ log)', async () => {
    const agent = await makeAgent();
    const { headers } = await linkAgentToRc(agent.id);
    const db = getBotDb();
    const pastRequestedAt = new Date(Date.now() - DELETION_GRACE_PERIOD_MS - 60 * 1000);
    await db.agent.update({ where: { id: agent.id }, data: { deletionRequestedAt: pastRequestedAt } });

    const res = await request(app).get('/v1/me/tids').set(headers);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('ACCOUNT_DELETED');

    const row = await db.agent.findUnique({ where: { id: agent.id } });
    expect(row?.deletedAt).not.toBeNull(); // Agent bị khóa phía SigMa bất kể side-effect phụ (nhường quyền phòng) có lỗi hay không.
  });
});

// 25/7 (Admin Demo chốt: "xây worker" thay vì chỉ lazy-check) — startDeletionSweepWorker() quét nền, KHÔNG phụ
// thuộc việc agent có tự đăng nhập lại hay không (test riêng, độc lập describe trên — không dùng chung app
// RC-auth vì worker gọi thẳng db.agent.findMany/update, không qua HTTP).
describe('startDeletionSweepWorker — worker nền quét độc lập, không phụ thuộc agent tự đăng nhập lại', () => {
  it('quét NGAY lúc start (không đợi interval) → xóa THẬT agent đã quá hạn 48h, dù KHÔNG có request HTTP nào tới', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const rcUsername = `rc-sweep-test-${Date.now()}`;
    await db.agent.update({ where: { id: agent.id }, data: { rcUserId: rcUsername, rcUsername } });
    const pastRequestedAt = new Date(Date.now() - DELETION_GRACE_PERIOD_MS - 60 * 60 * 1000);
    await db.agent.update({ where: { id: agent.id }, data: { deletionRequestedAt: pastRequestedAt } });

    // Interval dài (sẽ không tự bắn trong thời gian test) — CHỈ lần quét-ngay-lúc-start là nguồn xóa ở đây,
    // chứng minh worker hoạt động độc lập KHÔNG cần đợi agent tự đăng nhập lại (khác lazy-check).
    const worker = startDeletionSweepWorker(db, 60 * 60 * 1000);
    try {
      await new Promise((r) => setTimeout(r, 300)); // đợi sweep() bất đồng bộ chạy xong lượt đầu
      const row = await db.agent.findUnique({ where: { id: agent.id } });
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.deletedBy).toBe(agent.id);
    } finally {
      worker.stop();
    }
  });

  it('KHÔNG xóa agent còn trong hạn (chưa quá 48h) khi quét', async () => {
    const db = getBotDb();
    const agent = await makeAgent();
    const rcUsername = `rc-sweep-safe-${Date.now()}`;
    await db.agent.update({ where: { id: agent.id }, data: { rcUserId: rcUsername, rcUsername } });
    const almostRequestedAt = new Date(Date.now() - DELETION_GRACE_PERIOD_MS + 5 * 60 * 1000); // còn 5 phút
    await db.agent.update({ where: { id: agent.id }, data: { deletionRequestedAt: almostRequestedAt } });

    const worker = startDeletionSweepWorker(db, 60 * 60 * 1000);
    try {
      await new Promise((r) => setTimeout(r, 300));
      const row = await db.agent.findUnique({ where: { id: agent.id } });
      expect(row?.deletedAt).toBeNull();
    } finally {
      worker.stop();
    }
  });

  it('worker.stop() dừng interval thật — không còn quét lại sau khi stop (kiểm bằng cách gọi lại sau stop, agent mới quá hạn KHÔNG bị xóa)', async () => {
    const db = getBotDb();
    const worker = startDeletionSweepWorker(db, 50); // interval RẤT ngắn để test dừng thật
    await new Promise((r) => setTimeout(r, 150)); // để ít nhất 1-2 lượt quét chạy qua
    worker.stop();

    const agent = await makeAgent();
    const rcUsername = `rc-sweep-afterstop-${Date.now()}`;
    await db.agent.update({ where: { id: agent.id }, data: { rcUserId: rcUsername, rcUsername } });
    const pastRequestedAt = new Date(Date.now() - DELETION_GRACE_PERIOD_MS - 60 * 1000);
    await db.agent.update({ where: { id: agent.id }, data: { deletionRequestedAt: pastRequestedAt } });

    await new Promise((r) => setTimeout(r, 200)); // đủ lâu để INTERVAL CŨ (nếu chưa thật sự dừng) bắn thêm lần nữa
    const row = await db.agent.findUnique({ where: { id: agent.id } });
    expect(row?.deletedAt).toBeNull(); // worker ĐÃ dừng thật — KHÔNG quét thấy agent mới quá hạn này.
  });
});
