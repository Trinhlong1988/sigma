// REGRESSION BOLA (20/8) — chứng minh bề mặt Bearer-token TĨNH (SIGMA_API_KEY dùng-chung, KHÔNG mang danh
// tính đại lý) đã bị GỠ HOÀN TOÀN. Trước đây bất kỳ ai giữ khóa đều có thể reconcile/cancel/tạo Lô cho MỌI đại
// lý và đọc QR (kèm nhãn TK) của MỌI :agentCode chỉ bằng cách đổi tham số URL (broken object-level authorization).
//
// Test cố tình CẤU HÌNH khóa Bearer hợp lệ (như thể server production vẫn còn env cũ) rồi gửi kèm ĐÚNG khóa đó
// tới TỪNG route cũ — PHẢI nhận 404 NOT_FOUND (route KHÔNG còn tồn tại), KHÔNG phải 200/401. 404 (không phải 401)
// khẳng định: khóa Bearer nay VÔ NGHĨA, không còn cửa nào để nó mở. Bề mặt LIVE thay thế là /v1/me/* (RC-auth,
// agentId suy từ phiên + kiểm sở hữu lo.agentId === req.agent.id) — 2 assert cuối chứng minh twin còn sống.
import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';

const OLD_BEARER = 'Bearer test-secret-key-123';

describe('BOLA fix — route Bearer-token tĩnh /v1/agents/:agentCode/* + /v1/lo/:loId/* ĐÃ GỠ (404 dù kèm khóa hợp lệ)', () => {
  const app = createApp();

  beforeAll(() => {
    // Giả lập production vẫn còn cấu hình khóa cũ — chứng minh dù khóa "đúng", route vẫn không tồn tại.
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('GET /v1/agents/:agentCode/tids → 404 (không còn dò TID của mọi đại lý qua URL)', async () => {
    const res = await request(app).get('/v1/agents/A001/tids').set('Authorization', OLD_BEARER);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('POST /v1/agents/:agentCode/quote → 404', async () => {
    const res = await request(app).post('/v1/agents/A001/quote').set('Authorization', OLD_BEARER).send({ rows: [{ tidId: 1, amountBeforeFee: 1000 }] });
    expect(res.status).toBe(404);
  });

  it('GET /v1/agents/:agentCode/qr → 404 (không còn đọc QR nhận tiền + nhãn TK của mọi đại lý qua URL)', async () => {
    const res = await request(app).get('/v1/agents/A001/qr').set('Authorization', OLD_BEARER);
    expect(res.status).toBe(404);
  });

  it('POST /v1/agents/:agentCode/lo → 404 (không còn tạo Lô cho đại lý bất kỳ)', async () => {
    const res = await request(app).post('/v1/agents/A001/lo').set('Authorization', OLD_BEARER).send({ rows: [{ tidId: 1, amountBeforeFee: 1000 }] });
    expect(res.status).toBe(404);
  });

  it('GET /v1/agents/:agentCode/lo/next-number → 404', async () => {
    const res = await request(app).get('/v1/agents/A001/lo/next-number').set('Authorization', OLD_BEARER);
    expect(res.status).toBe(404);
  });

  it('POST /v1/lo/:loId/reconcile → 404 (không còn đối soát Lô của đại lý bất kỳ theo id nguyên)', async () => {
    const res = await request(app).post('/v1/lo/1/reconcile').set('Authorization', OLD_BEARER).send({ summaryOcr: { amount: 1000 }, individualBills: [] });
    expect(res.status).toBe(404);
  });

  it('POST /v1/lo/:loId/cancel → 404', async () => {
    const res = await request(app).post('/v1/lo/1/cancel').set('Authorization', OLD_BEARER).send({ reason: 'x' });
    expect(res.status).toBe(404);
  });

  // Twin LIVE (RC-auth) còn nguyên: KHÔNG 404 — thiếu phiên đăng nhập nên 401 (route tồn tại, chỉ chặn auth).
  it('twin LIVE GET /v1/me/tids còn tồn tại (401 khi thiếu phiên, KHÔNG 404)', async () => {
    const res = await request(app).get('/v1/me/tids').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });

  it('twin LIVE POST /v1/me/lo/:loId/reconcile còn tồn tại (401 khi thiếu phiên, KHÔNG 404)', async () => {
    const res = await request(app)
      .post('/v1/me/lo/1/reconcile')
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ summaryOcr: { amount: 1000 }, individualBills: [] });
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(401);
  });
});
