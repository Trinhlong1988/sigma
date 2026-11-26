// SIGMA Phase 1+ bước 4 (24/7) — GET /v1/me/lo (danh sách), GET /v1/me/lo/:loId (chi tiết),
// POST /v1/me/lo/:loId/reconcile (RC-auth). Mock rc-client.rcGetMe (CÙNG khuôn me.test.ts). Điểm khác biệt
// SO VỚI route Bearer cũ (/v1/lo/:loId/reconcile trong lo.ts) mà test này PHẢI phủ: ranh giới ownership
// (đại lý A không xem/đối soát được Lô của đại lý B) — route Bearer cũ KHÔNG có kiểm tra này.
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { makeBankFraudRule, makeQuoteReadyTid } from './fixtures.js';

let rcCounter = 0;
function nextRcUserId(): string {
  rcCounter += 1;
  return `rc-me-lo-test-${Date.now()}-${rcCounter}`;
}

// B39 (27/7) — /v1/me/lo/* đổi sang requireSession (KHÔNG còn gọi rcGetMe, xem BUGS_FIXED.md B39).
async function linkAgentToRc(agentId: number): Promise<{ headers: Record<string, string> }> {
  const db = getBotDb();
  const rcUserId = nextRcUserId();
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: rcUserId } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: 'test-tok', agentId });
  return { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } };
}

describe('GET /v1/me/lo — danh sách Lô của đại lý đang đăng nhập', () => {
  const app = createApp();
  beforeEach(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('thiếu header RC-auth → 401', async () => {
    const res = await request(app).get('/v1/me/lo').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
  });

  it('trả ĐÚNG Lô của đại lý gọi, KHÔNG lẫn Lô đại lý khác, mới nhất trước, kèm rowCount', async () => {
    const setupA = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const setupB = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const { headers: headersA } = await linkAgentToRc(setupA.agent.id);
    const { headers: headersB } = await linkAgentToRc(setupB.agent.id);

    const rowsB = { rows: [{ tidId: setupB.tid.id, cardTypeId: setupB.cardType.id, feeTypeId: setupB.feeType.id, amountBeforeFee: 1_000_000 }] };
    await request(app).post('/v1/me/lo').set(headersB).send(rowsB); // Lô đại lý B — KHÔNG được lọt vào response của A

    const rows1 = { rows: [{ tidId: setupA.tid.id, cardTypeId: setupA.cardType.id, feeTypeId: setupA.feeType.id, amountBeforeFee: 1_000_001 }] };
    const loRes1 = await request(app).post('/v1/me/lo').set(headersA).send(rows1);
    const rows2 = { rows: [{ tidId: setupA.tid.id, cardTypeId: setupA.cardType.id, feeTypeId: setupA.feeType.id, amountBeforeFee: 2_000_002 }] };
    const loRes2 = await request(app).post('/v1/me/lo').set(headersA).send(rows2);

    const res = await request(app).get('/v1/me/lo').set(headersA);
    expect(res.status).toBe(200);
    const ids = (res.body.items as { id: number }[]).map((i) => i.id);
    expect(ids).toEqual([loRes2.body.id, loRes1.body.id]); // mới nhất trước
    expect(res.body.items[0].rowCount).toBe(1);
    expect(res.body.items.every((i: { id: number }) => i.id !== undefined)).toBe(true);
  });

  it('lọc theo ?status= chỉ trả đúng nhóm trạng thái', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const { headers } = await linkAgentToRc(setup.agent.id);
    const rows = { rows: [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 1_000_000 }] };
    await request(app).post('/v1/me/lo').set(headers).send(rows); // tạo 1 Lô PENDING, chưa reconcile

    const resPending = await request(app).get('/v1/me/lo?status=PENDING').set(headers);
    expect(resPending.status).toBe(200);
    expect(resPending.body.items.length).toBeGreaterThanOrEqual(1);

    const resConfirmed = await request(app).get('/v1/me/lo?status=CONFIRMED').set(headers);
    expect(resConfirmed.status).toBe(200);
    expect(resConfirmed.body.items).toEqual([]);
  });

  it('status không hợp lệ → 400 VALIDATION', async () => {
    const setup = await makeQuoteReadyTid();
    const { headers } = await linkAgentToRc(setup.agent.id);
    const res = await request(app).get('/v1/me/lo?status=KHONG_HOP_LE').set(headers);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  // Regression AUDIT 24/7 (LOW, đã fix): ?status= lặp lại tham số (Express parse thành ARRAY, không phải
  // string) trước đây bị `typeof statusRaw === 'string'` bỏ qua ÂM THẦM → filter không áp dụng, trả MỌI
  // trạng thái thay vì 400. Giờ PHẢI 400.
  it('status lặp lại tham số (?status=A&status=B, Express parse thành mảng) → 400 VALIDATION, KHÔNG bỏ qua âm thầm', async () => {
    const setup = await makeQuoteReadyTid();
    const { headers } = await linkAgentToRc(setup.agent.id);
    const res = await request(app).get('/v1/me/lo?status=PENDING&status=CONFIRMED').set(headers);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('response có total/hasMore đúng số thật (không chỉ items/limit/offset)', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const { headers } = await linkAgentToRc(setup.agent.id);
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post('/v1/me/lo')
        .set(headers)
        .send({ rows: [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 1_000_000 + i }] });
    }
    const res = await request(app).get('/v1/me/lo?limit=2').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.total).toBe(3);
    expect(res.body.hasMore).toBe(true);

    const res2 = await request(app).get('/v1/me/lo?limit=2&offset=2').set(headers);
    expect(res2.body.items).toHaveLength(1);
    expect(res2.body.total).toBe(3);
    expect(res2.body.hasMore).toBe(false);
  });
});

describe('GET /v1/me/lo/:loId — chi tiết, ranh giới ownership', () => {
  const app = createApp();
  beforeEach(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('xem chi tiết Lô CỦA CHÍNH MÌNH → 200, đủ rows', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 1000 });
    const { headers } = await linkAgentToRc(setup.agent.id);
    const rows = { rows: [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 5_000_000 }] };
    const loRes = await request(app).post('/v1/me/lo').set(headers).send(rows);

    const res = await request(app).get(`/v1/me/lo/${loRes.body.id}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(loRes.body.id);
    expect(res.body.status).toBe('PENDING');
    expect(res.body.rows).toHaveLength(1);
    expect(res.body.bills).toEqual([]);
    expect(res.body.violations).toEqual([]);
  });

  it('đại lý A gọi loId của đại lý B → 404 NOT_FOUND (KHÔNG rò rỉ tồn tại của Lô đại lý khác)', async () => {
    const setupA = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const setupB = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const { headers: headersA } = await linkAgentToRc(setupA.agent.id);
    const { headers: headersB } = await linkAgentToRc(setupB.agent.id);

    const rowsB = { rows: [{ tidId: setupB.tid.id, cardTypeId: setupB.cardType.id, feeTypeId: setupB.feeType.id, amountBeforeFee: 1_000_000 }] };
    const loResB = await request(app).post('/v1/me/lo').set(headersB).send(rowsB);

    const res = await request(app).get(`/v1/me/lo/${loResB.body.id}`).set(headersA);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');
  });

  it('loId không tồn tại → 404', async () => {
    const setup = await makeQuoteReadyTid();
    const { headers } = await linkAgentToRc(setup.agent.id);
    const res = await request(app).get('/v1/me/lo/999999999').set(headers);
    expect(res.status).toBe(404);
  });

  // Regression AUDIT 24/7: thiếu header RC-auth cho ĐÚNG route detail (list đã có test này, detail/reconcile
  // trước đây CHƯA — nếu asyncHandler(requireRcAuth) lỡ bị gỡ khỏi RIÊNG route này, không test nào bắt được).
  it('thiếu header RC-auth → 401', async () => {
    const res = await request(app).get('/v1/me/lo/1').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
  });

  it('loId KHÔNG phải số nguyên (vd chữ) → 400 VALIDATION', async () => {
    const setup = await makeQuoteReadyTid();
    const { headers } = await linkAgentToRc(setup.agent.id);
    const res = await request(app).get('/v1/me/lo/abc').set(headers);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  // Regression AUDIT 24/7 (MEDIUM, đã fix): MISMATCH thuần do lệch tam giác đối soát (KHÔNG rule A-F nào vi
  // phạm) trước đây trả violations:[] KHÔNG giải thích gì — giờ PHẢI có triangulation.blame !== 'NONE'.
  it('MISMATCH do lệch tam giác đối soát (KHÔNG rule A-F nào vi phạm) → violations rỗng NHƯNG triangulation giải thích rõ lý do', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const { headers } = await linkAgentToRc(setup.agent.id);
    const rows = { rows: [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 8_000_002 }] };
    const loRes = await request(app).post('/v1/me/lo').set(headers).send(rows);
    const expected = Number(loRes.body.expectedTotalAmount);

    await request(app)
      .post(`/v1/me/lo/${loRes.body.id}/reconcile`)
      .set(headers)
      .send({
        summaryOcr: { amount: expected - 1 }, // LỆCH 1 đồng, không rule A-F nào cấu hình nên không vi phạm rule
        individualBills: [{ amount: expected, cardLast4: '4321', swipeAt: new Date().toISOString() }]
      });

    const detail = await request(app).get(`/v1/me/lo/${loRes.body.id}`).set(headers);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('MISMATCH');
    expect(detail.body.violations).toEqual([]);
    expect(detail.body.triangulation).not.toBeNull();
    expect(detail.body.triangulation.blame).toBe('SUMMARY');
    expect(detail.body.triangulation.message).toMatch(/LỆCH/);
  });

  // Regression AUDIT 24/7 (LOW, đã fix): afterJson lưu kèm `agentId` (xem reconcileLo() auditRows) — response
  // trước đây trả thẳng, rò rỉ field KHÔNG thuộc shape RuleViolationEntry thật.
  it('violations[] KHÔNG rò rỉ field agentId thừa (chỉ đúng shape RuleViolationEntry: rule/message/...)', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    await makeBankFraudRule({ bankId: setup.bank.id, maxAmountPerSwipe: 1_000_000 });
    const { headers } = await linkAgentToRc(setup.agent.id);
    const rows = { rows: [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 1_500_000 }] };
    const loRes = await request(app).post('/v1/me/lo').set(headers).send(rows);
    const expected = Number(loRes.body.expectedTotalAmount);

    await request(app)
      .post(`/v1/me/lo/${loRes.body.id}/reconcile`)
      .set(headers)
      .send({ summaryOcr: { amount: expected }, individualBills: [{ amount: expected, cardLast4: '4444', swipeAt: new Date().toISOString() }] });

    const detail = await request(app).get(`/v1/me/lo/${loRes.body.id}`).set(headers);
    expect(detail.body.violations.length).toBeGreaterThanOrEqual(1);
    // Rule A_MAX_AMOUNT ghi kèm billIndex/cardLast4/message/rule (KHÔNG agentId — đã bóc ra ở route).
    expect(Object.keys(detail.body.violations[0]).sort()).toEqual(['billIndex', 'cardLast4', 'message', 'rule'].sort());
    expect(detail.body.violations[0]).not.toHaveProperty('agentId');
  });
});

describe('POST /v1/me/lo/:loId/reconcile — RC-auth, ranh giới ownership + Rule A-F thật', () => {
  const app = createApp();
  beforeEach(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('thiếu header RC-auth → 401', async () => {
    const res = await request(app)
      .post('/v1/me/lo/1/reconcile')
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
      .send({ summaryOcr: { amount: 1000 }, individualBills: [] });
    expect(res.status).toBe(401);
  });

  it('loId KHÔNG phải số nguyên → 400 VALIDATION', async () => {
    const setup = await makeQuoteReadyTid();
    const { headers } = await linkAgentToRc(setup.agent.id);
    const res = await request(app)
      .post('/v1/me/lo/abc/reconcile')
      .set(headers)
      .send({ summaryOcr: { amount: 1000 }, individualBills: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('đối soát lại Lô ĐÃ CONFIRMED → 400 LO_NOT_RECONCILABLE (mapping lỗi từ reconcileLo() qua route mới)', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const { headers } = await linkAgentToRc(setup.agent.id);
    const rows = { rows: [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 3_000_001 }] };
    const loRes = await request(app).post('/v1/me/lo').set(headers).send(rows);
    const expected = Number(loRes.body.expectedTotalAmount);

    const first = await request(app)
      .post(`/v1/me/lo/${loRes.body.id}/reconcile`)
      .set(headers)
      .send({ summaryOcr: { amount: expected }, individualBills: [{ amount: expected, cardLast4: '6666', swipeAt: new Date().toISOString() }] });
    expect(first.body.status).toBe('CONFIRMED');

    const second = await request(app)
      .post(`/v1/me/lo/${loRes.body.id}/reconcile`)
      .set(headers)
      .send({ summaryOcr: { amount: expected }, individualBills: [{ amount: expected, cardLast4: '6666', swipeAt: new Date().toISOString() }] });
    expect(second.status).toBe(400);
    expect(second.body.error).toBe('LO_NOT_RECONCILABLE');
  });

  it('đại lý A KHÔNG đối soát được Lô của đại lý B → 404, Lô B KHÔNG bị đổi trạng thái', async () => {
    const setupA = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const setupB = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const { headers: headersA } = await linkAgentToRc(setupA.agent.id);
    const { headers: headersB } = await linkAgentToRc(setupB.agent.id);

    const rowsB = { rows: [{ tidId: setupB.tid.id, cardTypeId: setupB.cardType.id, feeTypeId: setupB.feeType.id, amountBeforeFee: 1_000_003 }] };
    const loResB = await request(app).post('/v1/me/lo').set(headersB).send(rowsB);
    const expected = Number(loResB.body.expectedTotalAmount);

    const res = await request(app)
      .post(`/v1/me/lo/${loResB.body.id}/reconcile`)
      .set(headersA)
      .send({ summaryOcr: { amount: expected }, individualBills: [{ amount: expected, cardLast4: '1234', swipeAt: new Date().toISOString() }] });
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('NOT_FOUND');

    const db = getBotDb();
    const loAfter = await db.lo.findUnique({ where: { id: loResB.body.id } });
    expect(loAfter!.status).toBe('PENDING'); // vẫn nguyên, KHÔNG bị đổi bởi request của agent A
  });

  it('đối soát Lô CỦA CHÍNH MÌNH, vi phạm Rule A (vượt hạn mức/lệnh) + Rule C (số tròn) → MISMATCH, violations khớp 2 rule', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    await makeBankFraudRule({ bankId: setup.bank.id, maxAmountPerSwipe: 3_000_000, disallowRoundAmounts: true });
    const { headers } = await linkAgentToRc(setup.agent.id);
    const amountBeforeFee = 5_000_000; // phí 0% → amountAfterFee = 5.000.000: VƯỢT max 3tr (Rule A) VÀ là số tròn (Rule C)
    const rows = { rows: [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee }] };
    const loRes = await request(app).post('/v1/me/lo').set(headers).send(rows);
    const expected = Number(loRes.body.expectedTotalAmount);
    expect(expected).toBe(5_000_000);

    const res = await request(app)
      .post(`/v1/me/lo/${loRes.body.id}/reconcile`)
      .set(headers)
      .send({
        summaryOcr: { amount: expected, bankReportedLoNumber: 12 },
        individualBills: [{ amount: expected, cardLast4: '9012', swipeAt: new Date().toISOString() }]
      });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('MISMATCH');
    const rules = (res.body.violations as { rule: string }[]).map((v) => v.rule).sort();
    expect(rules).toEqual(['A_MAX_AMOUNT', 'C_ROUND_AMOUNT']);
  });

  it('khớp tuyệt đối, không vi phạm rule nào → CONFIRMED, sau đó GET chi tiết trả violations rỗng + bills đã lưu', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const { headers } = await linkAgentToRc(setup.agent.id);
    const rows = { rows: [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 4_000_001 }] };
    const loRes = await request(app).post('/v1/me/lo').set(headers).send(rows);
    const expected = Number(loRes.body.expectedTotalAmount);

    const reconcileRes = await request(app)
      .post(`/v1/me/lo/${loRes.body.id}/reconcile`)
      .set(headers)
      .send({ summaryOcr: { amount: expected }, individualBills: [{ amount: expected, cardLast4: '5678', swipeAt: new Date().toISOString() }] });
    expect(reconcileRes.body.status).toBe('CONFIRMED');

    const detail = await request(app).get(`/v1/me/lo/${loRes.body.id}`).set(headers);
    expect(detail.status).toBe(200);
    expect(detail.body.status).toBe('CONFIRMED');
    expect(detail.body.violations).toEqual([]);
    expect(detail.body.bills).toHaveLength(1);
    expect(detail.body.bills[0].cardLast4).toBe('5678');
  });

  it('GET chi tiết SAU KHI reconcile có vi phạm → violations trả về đúng rule đã ghi AuditLog', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    await makeBankFraudRule({ bankId: setup.bank.id, maxAmountPerSwipe: 1_000_000 });
    const { headers } = await linkAgentToRc(setup.agent.id);
    const rows = { rows: [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 1_500_000 }] };
    const loRes = await request(app).post('/v1/me/lo').set(headers).send(rows);
    const expected = Number(loRes.body.expectedTotalAmount);

    await request(app)
      .post(`/v1/me/lo/${loRes.body.id}/reconcile`)
      .set(headers)
      .send({ summaryOcr: { amount: expected }, individualBills: [{ amount: expected, cardLast4: '4444', swipeAt: new Date().toISOString() }] });

    const detail = await request(app).get(`/v1/me/lo/${loRes.body.id}`).set(headers);
    expect(detail.status).toBe(200);
    expect(detail.body.violations.length).toBeGreaterThanOrEqual(1);
    expect(detail.body.violations.some((v: { rule?: string }) => v.rule === 'A_MAX_AMOUNT')).toBe(true);
  });
});
