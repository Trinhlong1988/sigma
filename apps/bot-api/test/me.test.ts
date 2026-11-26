// SIGMA Phase 3 (24/7) — 4 endpoint /v1/me/* (RC-auth mới, KHÔNG :agentCode URL). Mock rc-client.rcGetMe
// (KHÔNG gọi Rocket.Chat thật, CÙNG khuôn rc-auth-middleware.test.ts/auth-routes.test.ts) — agentId luôn lấy
// từ Agent đã link rcUserId, KHÔNG phải từ URL. Test đối chiếu TRỰC TIẾP với route Bearer cũ tương ứng
// (/v1/agents/:agentCode/quote, /tids, /lo, /qr) để chứng minh /v1/me/* trả CÙNG kết quả — KHÔNG lệch công
// thức/logic (đúng yêu cầu "TÁI DÙNG, không viết lại business logic").
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { makeAgent, makeBank, makeCardType, makeFeeSellQuote, makeFeeType, makePartner, makeQuoteReadyTid, makeTid, makeTidSellFee, makeTidVisibleToAgentViaGroup } from './fixtures.js';
import { getRoomRevenueReport } from '../src/services/chat-room-tid-service.js';

let rcCounter = 0;
function nextRcUserId(): string {
  rcCounter += 1;
  return `rc-me-test-${Date.now()}-${rcCounter}`;
}

// B39 (27/7) — /v1/me/* đổi sang requireSession (KHÔNG còn gọi rcGetMe, xem BUGS_FIXED.md B39). Helper giờ
// tạo WebSession thật (cookie + CSRF header) thay vì mock header x-rc-auth-token/x-rc-user-id cũ. Giữ NGUYÊN
// shape trả về `{ headers }` — mọi call site `.set(headers)` hiện có KHÔNG cần sửa gì thêm.
async function linkAgentToRc(agentId: number): Promise<{ headers: Record<string, string> }> {
  const db = getBotDb();
  const rcUserId = nextRcUserId();
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: rcUserId } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: 'test-tok', agentId });
  return { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } };
}

describe('/v1/me/* — RC-auth mới, agentId suy ra từ token (KHÔNG :agentCode URL)', () => {
  const app = createApp();

  beforeEach(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('thiếu cookie phiên (đã có header CSRF) → 401 SESSION_INVALID cho cả 4 endpoint', async () => {
    const csrf = { [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE };
    const rTids = await request(app).get('/v1/me/tids').set(csrf);
    expect(rTids.status).toBe(401);
    expect(rTids.body.error).toBe('SESSION_INVALID');

    const rQuote = await request(app).post('/v1/me/quote').set(csrf).send({ rows: [] });
    expect(rQuote.status).toBe(401);

    const rLo = await request(app).post('/v1/me/lo').set(csrf).send({ rows: [] });
    expect(rLo.status).toBe(401);

    const rQr = await request(app).get('/v1/me/qr').set(csrf);
    expect(rQr.status).toBe(401);
  });

  it('phiên hợp lệ nhưng KHÔNG Agent nào link rcUserId đó → 401 AGENT_NOT_LINKED', async () => {
    const db = getBotDb();
    const ws = await createWebSession(db, { rcUserId: 'rc-unlinked-me', rcAuthToken: 'test-tok' });
    const res = await request(app)
      .get('/v1/me/tids')
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${ws.id}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AGENT_NOT_LINKED');
  });

  it('GET /v1/me/tids trả ĐÚNG TID của agent link — KHÔNG lẫn TID đại lý khác, kèm hkdName/bankName mới (mục A0)', async () => {
    // makeQuoteReadyTid nay TỰ dựng chuỗi nhóm chat (chatRoomMember→customerChatGroup→customer) cho agent+tid —
    // đúng NGỮ NGHĨA MỚI /tids (hiển thị TID của KHÁCH mà agent là thành viên nhóm, KHÔNG lọc tids.agentId).
    const { bank, agent, tid } = await makeQuoteReadyTid();
    const db = getBotDb();
    await db.tid.update({ where: { id: tid.id }, data: { hkdName: 'HKD Test A0' } });
    const otherAgent = await makeAgent();
    // TID đại lý khác: KHÔNG gắn vào nhóm chat nào của `agent` → KHÔNG được lọt vào response của agent.
    await makeTid({ agentId: otherAgent.id });

    const { headers } = await linkAgentToRc(agent.id);
    const res = await request(app).get('/v1/me/tids').set(headers);
    expect(res.status).toBe(200);
    const ids = (res.body as { id: number }[]).map((r) => r.id);
    expect(ids).toEqual([tid.id]);
    expect(res.body[0].hkdName).toBe('HKD Test A0');
    expect(res.body[0].bankName).toBe(bank.name);
  });

  it('POST /v1/me/quote khớp CHÍNH XÁC POST /v1/agents/:agentCode/quote (route Bearer cũ) cho CÙNG input', async () => {
    const { agent, tid, cardType, feeType } = await makeQuoteReadyTid({ phiBanMilli: 1500 }); // 1.5%
    const { headers } = await linkAgentToRc(agent.id);
    const rows = [{ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee: 4_000_000 }];

    const meRes = await request(app).post('/v1/me/quote').set(headers).send({ rows });
    expect(meRes.status).toBe(200);

    // Số thật theo A0: feeApplied = "giá bán", amountAfterFee = "số tiền phải hoàn khách".
    expect(meRes.body[0].feeApplied).toBe(60_000); // 4_000_000 × 1.5%
    expect(meRes.body[0].amountAfterFee).toBe(3_940_000);
  });

  it('POST /v1/me/quote với tidId KHÔNG thuộc agent đang gọi → 400 TID_NOT_IN_AGENT_SCOPE (ranh giới bảo mật giữ nguyên)', async () => {
    const { agent: agentA } = await makeQuoteReadyTid();
    const { tid: tidB } = await makeQuoteReadyTid(); // thuộc agent B khác
    const { headers } = await linkAgentToRc(agentA.id);

    const res = await request(app).post('/v1/me/quote').set(headers).send({ rows: [{ tidId: tidB.id, amountBeforeFee: 1_000_000 }] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('TID_NOT_IN_AGENT_SCOPE');
  });

  it('rows rỗng/thiếu → 400 VALIDATION (giống route Bearer cũ)', async () => {
    const agent = await makeAgent();
    const { headers } = await linkAgentToRc(agent.id);
    const res = await request(app).post('/v1/me/quote').set(headers).send({ rows: [] });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('POST /v1/me/lo tạo Lô THẬT, expectedTotalAmount khớp HỆT /v1/me/quote cho CÙNG input (chống lệch công thức)', async () => {
    const { agent, tid, cardType, feeType } = await makeQuoteReadyTid({ phiBanMilli: 2000 }); // 2%
    const { headers } = await linkAgentToRc(agent.id);
    const rows = [{ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee: 5_000_000 }];

    const quoteRes = await request(app).post('/v1/me/quote').set(headers).send({ rows });
    expect(quoteRes.status).toBe(200);

    const loRes = await request(app).post('/v1/me/lo').set(headers).send({ rows });
    expect(loRes.status).toBe(201);
    expect(loRes.body.status).toBe('PENDING');
    expect(loRes.body.agentId).toBe(agent.id);
    expect(loRes.body.rows[0].amountAfterFee).toBe(String(quoteRes.body[0].amountAfterFee));
    expect(loRes.body.expectedTotalAmount).toBe(String(quoteRes.body[0].amountAfterFee));

    // Xác nhận Lô THẬT nằm trong DB (khớp yêu cầu "Lô tạo thật", không phải mock).
    const db = getBotDb();
    const loRow = await db.lo.findUnique({ where: { id: loRes.body.id } });
    expect(loRow).not.toBeNull();
    expect(loRow!.agentId).toBe(agent.id);
  });

  // B107-tiếp (2/8, Admin Demo yêu cầu trực tiếp "% phí bán nếu đang rỗng thì để = 0%") — GET /v1/me/fee-preview,
  // xem trước "Hoàn tiền sau phí" cho bảng OCR bill, KHÁC /v1/me/quote (route đó BÁO LỖI khi thiếu cấu hình,
  // đúng cho luồng tạo Lô thật) — route NÀY KHÔNG BAO GIỜ lỗi vì thiếu cấu hình.
  describe('GET /v1/me/fee-preview', () => {
    it('TID khớp đúng + có phí bán cấu hình → resolved:true, tính ĐÚNG khớp /v1/me/quote cùng input', async () => {
      // Dựng tay KHÔNG qua makeQuoteReadyTid() — route fee-preview KHÔNG nhận cardTypeId/feeTypeId (chỉ
      // tid+amount, đúng luồng OCR chỉ đọc được TID) nên quoteRow() bên trong TỰ mặc định "FeeType đầu tiên
      // id asc TOÀN BẢNG" (fee-quote.ts dòng ~101) — GLOBAL, không lọc theo test này. Nếu tự tạo FeeType mới
      // qua makeQuoteReadyTid(), id của nó gần như chắc chắn KHÔNG PHẢI id nhỏ nhất khi chạy full suite (nhiều
      // file test khác đã tạo FeeType trước đó trong CÙNG 1 DB, fileParallelism:false không truncate giữa các
      // file) → quoteRow mặc định sang FeeType KHÁC, FeeSellQuote seed cho FeeType của riêng test này không
      // được tìm thấy → resolved:false SAI, test flaky theo thứ tự chạy suite (bug thật gặp phải 2/8, xem
      // BUGS_FIXED.md B111). Fix: TỰ hỏi DB FeeType nào sẽ được mặc định (CÙNG query quoteRow dùng) rồi seed
      // FeeSellQuote khớp ĐÚNG FeeType đó — partnerId/cardTypeId của bank/partner MỚI tạo vẫn đảm bảo quote
      // này là quote DUY NHẤT khớp cặp (partnerId, cardTypeId, feeTypeId) bất kể feeTypeId là gì.
      const db = getBotDb();
      const bank = await makeBank();
      const partner = await makePartner();
      const cardType = await makeCardType(bank.id);
      const agent = await makeAgent();
      const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
      // NGỮ NGHĨA MỚI (20/8): previewSellFeeForTid nay xác định "TID của agent" qua chuỗi nhóm chat (KHÔNG lọc
      // tids.agentId) — nối chuỗi + gán tid.customerId để TID này thuộc "tầm nhìn" của agent, resolved mới true.
      await makeTidVisibleToAgentViaGroup(agent.id, tid.id);
      let feeType = await db.feeType.findFirst({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
      if (!feeType) feeType = await makeFeeType(); // chỉ khi CHƯA file test nào khác tạo FeeType nào trước đó
      await makeFeeSellQuote({
        partnerId: partner.id,
        cardTypeId: cardType.id,
        feeTypeId: feeType.id,
        phiBanMilli: 1500, // 1.5% niêm yết (tham khảo — KHÔNG áp cho đại lý)
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z')
      });
      // Admin Demo 20/8: đại lý chỉ dùng GIÁ BÁN THỰC TẾ (override) → resolved:true CHỈ khi có override. Seed override
      // 1.5% cho ĐÚNG (cardType, feeType mặc định previewSellFeeForTid dùng) để resolve = OVERRIDE, KHÔNG mượn niêm yết.
      await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1500 });
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).get(`/v1/me/fee-preview?tid=${encodeURIComponent(tid.tid)}&amount=4000000`).set(headers);
      expect(res.status).toBe(200);
      // cardTypeId (Admin Demo 21/8): bank test chỉ 1 loại thẻ → mặc định = chính thẻ đó.
      expect(res.body).toEqual({ feeApplied: 60_000, amountAfterFee: 3_940_000, resolved: true, phiBanMilli: 1500, cardTypeId: cardType.id });
    });

    // (b) Admin Demo 20/8: TID KHỚP đúng đại lý nhưng CHỈ có niêm yết (CHƯA override giá bán thực tế) → KHÔNG mượn
    // niêm yết: resolved:false + cờ noActualFee:true để UI hiện "chưa cấu hình giá bán" (khác resolved:false do
    // TID không khớp — case đó KHÔNG có noActualFee).
    it('TID khớp đại lý nhưng CHỈ có niêm yết (chưa có override giá bán thực tế) → resolved:false, noActualFee:true', async () => {
      const db = getBotDb();
      const bank = await makeBank();
      const partner = await makePartner();
      const cardType = await makeCardType(bank.id);
      const agent = await makeAgent();
      const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
      await makeTidVisibleToAgentViaGroup(agent.id, tid.id); // TID trong tầm nhìn của agent (khớp scope nhóm chat)
      let feeType = await db.feeType.findFirst({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
      if (!feeType) feeType = await makeFeeType();
      // CHỈ niêm yết, CỐ Ý KHÔNG seed override → previewSellFeeForTid phải trả noActualFee:true (không mượn niêm yết).
      await makeFeeSellQuote({ partnerId: partner.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1500, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') });
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).get(`/v1/me/fee-preview?tid=${encodeURIComponent(tid.tid)}&amount=4000000`).set(headers);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ feeApplied: 0, amountAfterFee: 4_000_000, resolved: false, noActualFee: true, cardTypeId: cardType.id });
    });

    it('TID KHÔNG khớp bất kỳ TID nào của agent → resolved:false, phí mặc định 0% (KHÔNG lỗi)', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).get(`/v1/me/fee-preview?tid=KHONG_TON_TAI_999&amount=5000000`).set(headers);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ feeApplied: 0, amountAfterFee: 5_000_000, resolved: false });
    });

    it('TID thuộc agent KHÁC → resolved:false (an ninh dữ liệu — KHÔNG lộ phí bán của agent khác qua chuỗi TID đoán được)', async () => {
      const { tid: otherTid } = await makeQuoteReadyTid({ phiBanMilli: 3000 });
      const me = await makeAgent();
      const { headers } = await linkAgentToRc(me.id);
      const res = await request(app).get(`/v1/me/fee-preview?tid=${encodeURIComponent(otherTid.tid)}&amount=1000000`).set(headers);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ feeApplied: 0, amountAfterFee: 1_000_000, resolved: false });
    });

    it('TID khớp nhưng CHƯA có phí bán niêm yết/override nào → resolved:false, KHÔNG báo NO_SELL_QUOTE như /v1/me/quote', async () => {
      // Dựng tay KHÔNG qua makeQuoteReadyTid() (fixture đó LUÔN seed 1 FeeSellQuote) — cần TID có đủ
      // bank/partner/cardType/feeType nhưng CỐ Ý KHÔNG có FeeSellQuote nào để test đúng nhánh NO_SELL_QUOTE.
      const bank = await makeBank();
      const partner = await makePartner();
      await makeCardType(bank.id);
      await makeFeeType();
      const agent = await makeAgent();
      const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
      // Nối chuỗi nhóm chat để TID KHỚP "tầm nhìn" của agent (ngữ nghĩa MỚI) → đi ĐÚNG nhánh "khớp TID nhưng
      // CHƯA có phí bán" (NO_SELL_QUOTE nội bộ → fallback resolved:false), thay vì nhánh "không tìm thấy TID".
      await makeTidVisibleToAgentViaGroup(agent.id, tid.id);
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).get(`/v1/me/fee-preview?tid=${encodeURIComponent(tid.tid)}&amount=2000000`).set(headers);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ feeApplied: 0, amountAfterFee: 2_000_000, resolved: false });
    });

    it('amount không hợp lệ (âm/không phải số) → 400 VALIDATION', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).get(`/v1/me/fee-preview?tid=ABC&amount=-5`).set(headers);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION');
    });

    it('tid rỗng/thiếu → resolved:false (KHÔNG lỗi, đúng nguyên tắc "rỗng thì 0%")', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).get(`/v1/me/fee-preview?amount=3000000`).set(headers);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ feeApplied: 0, amountAfterFee: 3_000_000, resolved: false });
    });
  });

  // ── Chọn LOẠI THẺ + giá bán trên bill (Admin Demo 21/8 "bill không tự nhận diện thẻ nào giá nào") ─────────────
  // Bank nhiều thẻ giá khác nhau: mặc định = Visa-Master (KHÔNG phải "thẻ đầu id"); client chọn thẻ → giá theo thẻ;
  // tid-card-options trả đủ thẻ+giá+mặc-định+nhận-diện.
  describe('GET /v1/me/fee-preview?cardTypeId + GET /v1/me/tid-card-options (chọn thẻ)', () => {
    async function setupMultiCardTid() {
      const db = getBotDb();
      const bank = await makeBank();
      const partner = await makePartner();
      // Tạo 3 thẻ THEO TÊN nghiệp vụ (classify): MB=ONUS (id nhỏ nhất), Visa-Master=INTERNATIONAL, Napas=NAPAS.
      const cardMB = await db.cardType.create({ data: { bankId: bank.id, name: 'MB', code: `CTMB${bank.id}` } });
      const cardVM = await db.cardType.create({ data: { bankId: bank.id, name: 'Ngoài MB-Visa-Master', code: `CTVM${bank.id}` } });
      const cardNP = await db.cardType.create({ data: { bankId: bank.id, name: 'Ngoài MB-Napas', code: `CTNP${bank.id}` } });
      const agent = await makeAgent();
      const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
      await makeTidVisibleToAgentViaGroup(agent.id, tid.id);
      let feeType = await db.feeType.findFirst({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
      if (!feeType) feeType = await makeFeeType();
      // Giá bán thực tế mỗi thẻ (loại phí mặc định = feeType đầu id): MB 1.05% · Visa-Master 1.40% · Napas 1.50%.
      await makeTidSellFee({ tidId: tid.id, cardTypeId: cardMB.id, feeTypeId: feeType.id, phiBanMilli: 1050 });
      await makeTidSellFee({ tidId: tid.id, cardTypeId: cardVM.id, feeTypeId: feeType.id, phiBanMilli: 1400 });
      await makeTidSellFee({ tidId: tid.id, cardTypeId: cardNP.id, feeTypeId: feeType.id, phiBanMilli: 1500 });
      const { headers } = await linkAgentToRc(agent.id);
      return { tid, cardMB, cardVM, cardNP, bank, headers };
    }

    it('fee-preview KHÔNG truyền cardTypeId → mặc định Visa-Master (1.40%) — KHÔNG phải "thẻ đầu id" (MB)', async () => {
      const { tid, cardVM, headers } = await setupMultiCardTid();
      const res = await request(app).get(`/v1/me/fee-preview?tid=${encodeURIComponent(tid.tid)}&amount=10000000`).set(headers);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ feeApplied: 140_000, amountAfterFee: 9_860_000, resolved: true, phiBanMilli: 1400, cardTypeId: cardVM.id });
    });

    it('fee-preview CÓ cardTypeId=MB → giá thẻ MB (1.05%)', async () => {
      const { tid, cardMB, headers } = await setupMultiCardTid();
      const res = await request(app).get(`/v1/me/fee-preview?tid=${encodeURIComponent(tid.tid)}&amount=10000000&cardTypeId=${cardMB.id}`).set(headers);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ feeApplied: 105_000, amountAfterFee: 9_895_000, resolved: true, phiBanMilli: 1050, cardTypeId: cardMB.id });
    });

    it('tid-card-options → đủ 3 thẻ + giá + defaultCardTypeId=Visa-Master; scheme=INTERNATIONAL → detected=Visa-Master', async () => {
      const { tid, cardMB, cardVM, cardNP, bank, headers } = await setupMultiCardTid();
      const res = await request(app).get(`/v1/me/tid-card-options?tid=${encodeURIComponent(tid.tid)}&scheme=INTERNATIONAL`).set(headers);
      expect(res.status).toBe(200);
      expect(res.body.bankId).toBe(bank.id);
      expect(res.body.defaultCardTypeId).toBe(cardVM.id);
      expect(res.body.detectedCardTypeId).toBe(cardVM.id);
      expect(res.body.cards).toEqual([
        { cardTypeId: cardMB.id, code: expect.any(String), name: 'MB', klass: 'ONUS', phiBanMilli: 1050 },
        { cardTypeId: cardVM.id, code: expect.any(String), name: 'Ngoài MB-Visa-Master', klass: 'INTERNATIONAL', phiBanMilli: 1400 },
        { cardTypeId: cardNP.id, code: expect.any(String), name: 'Ngoài MB-Napas', klass: 'NAPAS', phiBanMilli: 1500 }
      ]);
    });

    it('tid-card-options scheme=DOMESTIC + BIN ngân hàng khác (không on-us) → detected=Napas', async () => {
      const { tid, cardNP, headers } = await setupMultiCardTid();
      const res = await request(app).get(`/v1/me/tid-card-options?tid=${encodeURIComponent(tid.tid)}&scheme=DOMESTIC&bin=970416`).set(headers);
      expect(res.status).toBe(200);
      expect(res.body.detectedCardTypeId).toBe(cardNP.id);
    });

    it('tid-card-options TID ngoài scope đại lý → rỗng (không lỗi)', async () => {
      const { tid } = await setupMultiCardTid();
      const otherAgent = await makeAgent();
      const { headers } = await linkAgentToRc(otherAgent.id);
      const res = await request(app).get(`/v1/me/tid-card-options?tid=${encodeURIComponent(tid.tid)}`).set(headers);
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ bankId: null, bankCode: null, defaultCardTypeId: null, detectedCardTypeId: null, cards: [] });
    });
  });

  // ── NỐI BILL → DOANH SỐ (Admin Demo 21/8) — POST /v1/me/lo/from-bill ────────────────────────────────────────
  describe('POST /v1/me/lo/from-bill', () => {
    it('bill TID khớp khách + có giá bán → 201 tạo Lô + doanh số PHÒNG tăng đúng (e2e)', async () => {
      const db = getBotDb();
      const bank = await makeBank();
      const partner = await makePartner();
      const cardType = await makeCardType(bank.id);
      const agent = await makeAgent();
      const tid = await makeTid({ partnerId: partner.id, bankId: bank.id });
      const wired = await makeTidVisibleToAgentViaGroup(agent.id, tid.id);
      let feeType = await db.feeType.findFirst({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
      if (!feeType) feeType = await makeFeeType();
      await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1050 });
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).post('/v1/me/lo/from-bill').set(headers).send({ tid: tid.tid, amountBeforeFee: 10_000_000, cardTypeId: cardType.id });
      expect(res.status).toBe(201);
      expect(res.body.rows).toHaveLength(1);
      expect(res.body.rows[0].tidId).toBe(tid.id);
      // E2E: doanh số phòng của khách phải thấy đúng Lô vừa tạo (feeApplied 105k, net 9.895tr).
      const report = await getRoomRevenueReport(db, agent.id, wired.room.id, { from: new Date(2020, 0, 1), to: new Date(2030, 0, 1) });
      expect(report.totalGross).toBe(10_000_000);
      expect(report.totalFee).toBe(105_000);
      expect(report.loCount).toBe(1);
    });

    it('TID CHỈ có niêm yết, CHƯA có giá bán thực tế → 409 NO_ACTUAL_SELL_FEE (KHÔNG tạo Lô — đại lý không mượn niêm yết)', async () => {
      const db = getBotDb();
      const bank = await makeBank();
      const partner = await makePartner();
      const cardType = await makeCardType(bank.id);
      const agent = await makeAgent();
      const tid = await makeTid({ partnerId: partner.id, bankId: bank.id });
      await makeTidVisibleToAgentViaGroup(agent.id, tid.id);
      let feeType = await db.feeType.findFirst({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
      if (!feeType) feeType = await makeFeeType();
      // CÓ niêm yết nhưng KHÔNG override → resolveActualSellFee source=QUOTE → quoteRow chặn NO_ACTUAL_SELL_FEE.
      await makeFeeSellQuote({ partnerId: partner.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1500, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') });
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).post('/v1/me/lo/from-bill').set(headers).send({ tid: tid.tid, amountBeforeFee: 5_000_000, cardTypeId: cardType.id });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('NO_ACTUAL_SELL_FEE');
    });

    it('TID không thuộc khách của đại lý → 400 TID_NOT_IN_AGENT_SCOPE', async () => {
      const bank = await makeBank();
      const partner = await makePartner();
      const foreignTid = await makeTid({ partnerId: partner.id, bankId: bank.id });
      const agent = await makeAgent();
      const ownTid = await makeTid({});
      await makeTidVisibleToAgentViaGroup(agent.id, ownTid.id); // agent có nhóm/khách nhưng KHÔNG chứa foreignTid
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).post('/v1/me/lo/from-bill').set(headers).send({ tid: foreignTid.tid, amountBeforeFee: 1_000_000 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('TID_NOT_IN_AGENT_SCOPE');
    });

    it('bill chưa đọc được TID (rỗng) → 400 NOT_FOUND, KHÔNG tạo Lô', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).post('/v1/me/lo/from-bill').set(headers).send({ tid: '', amountBeforeFee: 1_000_000 });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('NOT_FOUND');
    });

    // Helper: TID khớp khách + có giá bán, trả {tid, cardType, agent, room, headers}.
    async function setupBillReady() {
      const db = getBotDb();
      const bank = await makeBank();
      const partner = await makePartner();
      const cardType = await makeCardType(bank.id);
      const agent = await makeAgent();
      const tid = await makeTid({ partnerId: partner.id, bankId: bank.id });
      const wired = await makeTidVisibleToAgentViaGroup(agent.id, tid.id);
      let feeType = await db.feeType.findFirst({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
      if (!feeType) feeType = await makeFeeType();
      await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1050 });
      const { headers } = await linkAgentToRc(agent.id);
      return { db, tid, cardType, agent, room: wired.room, headers };
    }

    it('gửi CÙNG bill 2 lần (cùng số lô) → CHỈ 1 Lô, doanh số KHÔNG nhân đôi (dedup billKey)', async () => {
      const { db, tid, cardType, agent, room, headers } = await setupBillReady();
      const bill = { tid: tid.tid, amountBeforeFee: 10_000_000, cardTypeId: cardType.id, batchNumber: 'B001', invoiceNumber: 'INV1', dateTime: '21/08/2026 10:30:00' };
      const r1 = await request(app).post('/v1/me/lo/from-bill').set(headers).send(bill);
      const r2 = await request(app).post('/v1/me/lo/from-bill').set(headers).send(bill);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(r2.body.id).toBe(r1.body.id); // CÙNG Lô — không tạo trùng
      const report = await getRoomRevenueReport(db, agent.id, room.id, { from: new Date(2020, 0, 1), to: new Date(2030, 0, 1) });
      expect(report.loCount).toBe(1);
      expect(report.totalGross).toBe(10_000_000);
    });

    // [Audit 3/9 #5 + cập nhật 4/9] GỬI LẠI bill cùng lô với số NHỎ HƠN (auto re-send, KHÔNG allowShrink) → CHẶN thu
    // nhỏ, GIỮ tổng lớn (chống SALE thành phần đè SETTLEMENT / OCR đọc lệch nhỏ). Sửa-giảm cố ý đi qua editBillParams
    // (allowShrink=true), KHÔNG qua from-bill. Vẫn "KHÔNG cộng dồn" (1 Lô, không thành 16tr).
    it('GỬI LẠI bill cùng số lô, số tiền NHỎ HƠN (from-bill, không allowShrink) → CHẶN thu nhỏ, GIỮ tổng lớn, KHÔNG cộng dồn', async () => {
      const { db, tid, cardType, agent, room, headers } = await setupBillReady();
      const base = { tid: tid.tid, cardTypeId: cardType.id, batchNumber: 'B002', invoiceNumber: 'INV2', dateTime: '21/08/2026 11:00:00' };
      const r1 = await request(app).post('/v1/me/lo/from-bill').set(headers).send({ ...base, amountBeforeFee: 10_000_000 });
      const r2 = await request(app).post('/v1/me/lo/from-bill').set(headers).send({ ...base, amountBeforeFee: 6_000_000 });
      expect(r2.body.id).toBe(r1.body.id); // cùng Lô (UPSERT), KHÔNG tạo Lô thứ 2
      const report = await getRoomRevenueReport(db, agent.id, room.id, { from: new Date(2020, 0, 1), to: new Date(2030, 0, 1) });
      expect(report.loCount).toBe(1);
      expect(report.totalGross).toBe(10_000_000); // GIỮ tổng lớn (shrink guard) — KHÔNG hạ xuống 6tr, KHÔNG cộng dồn 16tr
      expect(report.totalFee).toBe(105_000); // 10tr × 1.05%
    });

    // KHÓA DEDUP TẦNG 2 — HASH ẢNH (Admin Demo 21/8 "cùng 1 giao dịch bị tách 2", verify cặp Lô 22/23 billKey=null):
    // bill KHÔNG đọc được số lô/số HĐ (vd bill MB) nhưng CÙNG file ảnh (billImageHash) → gộp CÙNG Lô, KHÔNG tách.
    it('bill thiếu số lô/HĐ NHƯNG cùng billImageHash (gửi lại cùng ảnh) → CHỈ 1 Lô (dedup hash ảnh, tầng 2)', async () => {
      const { db, tid, cardType, agent, room, headers } = await setupBillReady();
      const bill = { tid: tid.tid, amountBeforeFee: 3_000_000, cardTypeId: cardType.id, billImageHash: 'abc123deadbeefsamehash' };
      const r1 = await request(app).post('/v1/me/lo/from-bill').set(headers).send(bill);
      const r2 = await request(app).post('/v1/me/lo/from-bill').set(headers).send(bill);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(r2.body.id).toBe(r1.body.id); // CÙNG Lô — hash ảnh khớp
      const report = await getRoomRevenueReport(db, agent.id, room.id, { from: new Date(2020, 0, 1), to: new Date(2030, 0, 1) });
      expect(report.loCount).toBe(1);
      expect(report.totalGross).toBe(3_000_000); // KHÔNG nhân đôi
    });

    // TẦNG 3 — không khóa nào khớp (thiếu số lô/HĐ, ảnh khác/không hash) NHƯNG cùng đại lý+TID+SỐ TIỀN trong ngày →
    // KHÔNG tự ghi lần 2, trả DUP_SUSPECT (409) để đại lý xác nhận. Đây chính là lớp chặn case Lô 22/23.
    it('bill thiếu mọi khóa + cùng tid+tiền trong ngày (lần 2) → 409 DUP_SUSPECT, KHÔNG tạo Lô trùng', async () => {
      const { db, tid, cardType, agent, room, headers } = await setupBillReady();
      const bill = { tid: tid.tid, amountBeforeFee: 3_000_000, cardTypeId: cardType.id };
      const r1 = await request(app).post('/v1/me/lo/from-bill').set(headers).send(bill);
      const r2 = await request(app).post('/v1/me/lo/from-bill').set(headers).send(bill);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(409);
      expect(r2.body.error).toBe('DUP_SUSPECT');
      expect(r2.body.existingLoId).toBe(r1.body.id); // trỏ đúng Lô nghi trùng cho client cảnh báo
      const report = await getRoomRevenueReport(db, agent.id, room.id, { from: new Date(2020, 0, 1), to: new Date(2030, 0, 1) });
      expect(report.loCount).toBe(1); // vẫn chỉ 1 Lô — không đếm trùng
    });

    // TẦNG 3 override — đại lý xác nhận "đúng giao dịch KHÁC" → gọi lại allowDuplicate=true → GHI Lô thứ 2 thật.
    it('DUP_SUSPECT + allowDuplicate=true (đại lý xác nhận giao dịch khác) → tạo Lô thứ 2, doanh số = 2', async () => {
      const { db, tid, cardType, agent, room, headers } = await setupBillReady();
      const bill = { tid: tid.tid, amountBeforeFee: 3_000_000, cardTypeId: cardType.id };
      const r1 = await request(app).post('/v1/me/lo/from-bill').set(headers).send(bill);
      const r2 = await request(app).post('/v1/me/lo/from-bill').set(headers).send({ ...bill, allowDuplicate: true });
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      expect(r2.body.id).not.toBe(r1.body.id); // Lô KHÁC
      const report = await getRoomRevenueReport(db, agent.id, room.id, { from: new Date(2020, 0, 1), to: new Date(2030, 0, 1) });
      expect(report.loCount).toBe(2);
      expect(report.totalGross).toBe(6_000_000);
    });

    // Không nghi trùng khi SỐ TIỀN khác nhau (2 giao dịch thật khác tiền cùng ngày) → 2 Lô bình thường, KHÔNG chặn.
    it('2 bill cùng tid nhưng SỐ TIỀN khác (giao dịch thật khác nhau) → 2 Lô, KHÔNG DUP_SUSPECT', async () => {
      const { db, tid, cardType, agent, room, headers } = await setupBillReady();
      const r1 = await request(app).post('/v1/me/lo/from-bill').set(headers).send({ tid: tid.tid, amountBeforeFee: 3_000_000, cardTypeId: cardType.id });
      const r2 = await request(app).post('/v1/me/lo/from-bill').set(headers).send({ tid: tid.tid, amountBeforeFee: 7_000_000, cardTypeId: cardType.id });
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      const report = await getRoomRevenueReport(db, agent.id, room.id, { from: new Date(2020, 0, 1), to: new Date(2030, 0, 1) });
      expect(report.loCount).toBe(2);
      expect(report.totalGross).toBe(10_000_000);
    });

    // BRIDGE bill→doanh số SigMa (Admin Demo 24/8) — bill ghi doanh số + TID có ĐỦ biểu phí (FeeRate + giá
    // bán thực) → TỰ tạo 1 Transaction (SigMa đọc bảng transactions) + link los.transactionId. Gửi lại
    // cùng bill (dedup UPSERT) → KHÔNG tạo GD thứ 2.
    it('bill có đủ biểu phí → tự tạo 1 GD (transactions) + link los.transactionId; gửi lại KHÔNG tạo GD trùng', async () => {
      const db = getBotDb();
      const bank = await makeBank();
      const partner = await makePartner();
      const cardType = await makeCardType(bank.id);
      const agent = await makeAgent();
      const tid = await makeTid({ partnerId: partner.id, bankId: bank.id });
      const wired = await makeTidVisibleToAgentViaGroup(agent.id, tid.id);
      let feeType = await db.feeType.findFirst({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
      if (!feeType) feeType = await makeFeeType();
      await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1050 });
      // FeeRate (phí mua/cài máy) cho (đối tác × loại thẻ) — resolveFeeForTxn cần để tính margin. effectiveFrom quá
      // khứ để hiệu lực tại now.
      await db.feeRate.create({ data: { partnerId: partner.id, cardTypeId: cardType.id, phiMua: 800, phiCaiMay: 500, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') } });
      const { headers } = await linkAgentToRc(agent.id);

      const r1 = await request(app).post('/v1/me/lo/from-bill').set(headers).send({ tid: tid.tid, amountBeforeFee: 10_000_000, cardTypeId: cardType.id, billImageHash: 'bridgehash1' });
      expect(r1.status).toBe(201);
      // Lô đã link 1 GD.
      const lo = await db.lo.findUnique({ where: { id: r1.body.id }, select: { transactionId: true } });
      expect(lo?.transactionId).not.toBeNull();
      // Đúng 1 GD cho TID này, số tiền = gross, có mã GD, createdBy null (GD tự động).
      const txns = await db.transaction.findMany({ where: { tidId: tid.id, deletedAt: null } });
      expect(txns.length).toBe(1);
      expect(Number(txns[0].amount)).toBe(10_000_000);
      expect(txns[0].customerId).toBe(wired.customer.id);
      expect(txns[0].createdBy).toBeNull();
      expect(txns[0].code).toMatch(/^GD\d{5}$/);
      expect(txns[0].id).toBe(lo?.transactionId);

      // Gửi LẠI cùng bill (cùng hash → dedup UPSERT cùng Lô) → KHÔNG tạo GD thứ 2.
      const r2 = await request(app).post('/v1/me/lo/from-bill').set(headers).send({ tid: tid.tid, amountBeforeFee: 10_000_000, cardTypeId: cardType.id, billImageHash: 'bridgehash1' });
      expect(r2.body.id).toBe(r1.body.id);
      expect((await db.transaction.findMany({ where: { tidId: tid.id, deletedAt: null } })).length).toBe(1);
    });

    // Best-effort: TID THIẾU FeeRate → bill VẪN ghi doanh số (Lô) nhưng KHÔNG tạo GD (không chặn luồng bill).
    it('bill thiếu biểu phí (không FeeRate) → VẪN ghi Lô, KHÔNG tạo GD (best-effort), los.transactionId null', async () => {
      const { db, tid, cardType, headers } = await setupBillReady(); // setupBillReady KHÔNG tạo FeeRate
      const r = await request(app).post('/v1/me/lo/from-bill').set(headers).send({ tid: tid.tid, amountBeforeFee: 4_000_000, cardTypeId: cardType.id, billImageHash: 'nofee1' });
      expect(r.status).toBe(201); // Lô tạo bình thường
      const lo = await db.lo.findUnique({ where: { id: r.body.id }, select: { transactionId: true } });
      expect(lo?.transactionId).toBeNull(); // chưa tạo được GD
      expect((await db.transaction.findMany({ where: { tidId: tid.id, deletedAt: null } })).length).toBe(0);
    });

    // Fix audit #1 (25/8) — SỬA số tiền bill sau khi đã tạo GD → GD (bất biến) GIỮ số CŨ + GẮN CẢNH BÁO note +
    // audit (Admin Demo chốt "admin tự xử"). Trước fix: los đổi số mà transactions giữ số cũ, LỆCH ÂM THẦM.
    // [Admin Demo 17/9 ĐẢO CHÍNH SÁCH — "khi sửa lại bill doanh số NĐT không thay đổi à?" → duyệt "gật làm đi"]
    // TRƯỚC: GD là "chứng từ bất biến", sửa bill chỉ đổi lô + ghi cảnh báo ⇒ doanh số NĐT (đọc bảng GIAO DỊCH)
    // đứng im, lệch CÂM (rà ra 23 lô, ca lớn nhất 8.000.000đ). NAY: GD ĐỒNG BỘ theo bill, vẫn giữ dấu vết ở note
    // + audit, và KHÔNG đẻ GD thứ 2.
    it('sửa số tiền bill sau khi đã bridge GD → GD ĐỒNG BỘ số mới + note dấu vết + audit, KHÔNG tạo GD thứ 2', async () => {
      const db = getBotDb();
      const bank = await makeBank();
      const partner = await makePartner();
      const cardType = await makeCardType(bank.id);
      const agent = await makeAgent();
      const tid = await makeTid({ partnerId: partner.id, bankId: bank.id });
      await makeTidVisibleToAgentViaGroup(agent.id, tid.id);
      let feeType = await db.feeType.findFirst({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
      if (!feeType) feeType = await makeFeeType();
      await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1050 });
      await db.feeRate.create({ data: { partnerId: partner.id, cardTypeId: cardType.id, phiMua: 800, phiCaiMay: 500, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') } });
      const { headers } = await linkAgentToRc(agent.id);
      const bill = { tid: tid.tid, cardTypeId: cardType.id, batchNumber: 'B-EDIT', invoiceNumber: 'I-EDIT' };
      const r1 = await request(app).post('/v1/me/lo/from-bill').set(headers).send({ ...bill, amountBeforeFee: 10_000_000 });
      expect(r1.status).toBe(201);
      const txnId = (await db.lo.findUnique({ where: { id: r1.body.id }, select: { transactionId: true } }))?.transactionId;
      expect(txnId).not.toBeNull();

      // SỬA số tiền THÀNH 15tr (cùng billKey nat|tid|B-EDIT|I-EDIT → UPSERT cùng Lô). Dùng TĂNG (không phải giảm) vì
      // from-bill KHÔNG allowShrink → giảm bị shrink-guard chặn TRƯỚC khi tới logic divergence; tăng qua guard, chạm
      // đúng nhánh "GD đã bridge lệch số" (divergence áp cho MỌI thay đổi số/máy sau bridge, không riêng giảm).
      const r2 = await request(app).post('/v1/me/lo/from-bill').set(headers).send({ ...bill, amountBeforeFee: 15_000_000 });
      expect(r2.body.id).toBe(r1.body.id);
      const txn = await db.transaction.findUnique({ where: { id: txnId! } });
      expect(Number(txn!.amount)).toBe(15_000_000); // GD ĐỒNG BỘ theo bill đã sửa (doanh số NĐT đổi theo)
      expect(txn!.note ?? '').toContain('ĐÃ ĐỒNG BỘ');
      // Doanh thu tính lại theo số mới (không giữ doanh thu của số cũ).
      expect(Number(txn!.revenueAmount)).toBeGreaterThan(0);
      expect(await db.auditLog.count({ where: { action: 'SIGMA_BILL_EDIT_TXN_SYNCED', targetId: String(txnId) } })).toBe(1);
      expect((await db.transaction.findMany({ where: { tidId: tid.id, deletedAt: null } })).length).toBe(1); // không tạo GD thứ 2
    });

    // Fix audit #2 (25/8) — UNIQUE 1-phần (agent_id, bill_key) chặn 2 Lô cùng billKey (chống race đếm đôi). Test
    // trực tiếp DB guard (race concurrency không unit-test tất định được): chèn 2 Lô cùng key → cái 2 bị P2002.
    it('DB chặn 2 Lô cùng (agentId, billKey) non-null (P2002); billKey null vẫn cho nhiều Lô', async () => {
      const db = getBotDb();
      const agent = await makeAgent();
      const key = `nat|agent${agent.id}|b|i`; // agent.id unique mỗi test → billKey không đụng test khác
      await db.lo.create({ data: { agentId: agent.id, status: 'PENDING', expectedTotalAmount: 0n, billKey: key } });
      await expect(db.lo.create({ data: { agentId: agent.id, status: 'PENDING', expectedTotalAmount: 0n, billKey: key } })).rejects.toMatchObject({ code: 'P2002' });
      // billKey NULL KHÔNG bị chặn (bill không đủ định danh → nhiều Lô null hợp lệ).
      await db.lo.create({ data: { agentId: agent.id, status: 'PENDING', expectedTotalAmount: 0n, billKey: null } });
      await db.lo.create({ data: { agentId: agent.id, status: 'PENDING', expectedTotalAmount: 0n, billKey: null } });
    });
  });

  it('GET /v1/me/qr — đại lý CHƯA cấu hình QR → 501 QR_NOT_CONFIGURED_YET', async () => {
    const agent = await makeAgent();
    const { headers } = await linkAgentToRc(agent.id);
    const res = await request(app).get('/v1/me/qr').set(headers);
    expect(res.status).toBe(501);
    expect(res.body).toEqual({ error: 'QR_NOT_CONFIGURED_YET' });
  });

  it('GET /v1/me/qr — đại lý ĐÃ cấu hình QR → 200, khớp HỆT route Bearer cũ cùng agent', async () => {
    const agent = await makeAgent();
    const db = getBotDb();
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await db.agent.update({
      where: { id: agent.id },
      data: { qrImage: png, qrImageMime: 'image/png', bankAccountLabel: 'ACB - 999 - TEST ME', qrUpdatedAt: new Date('2026-07-24T00:00:00.000Z') }
    });
    const { headers } = await linkAgentToRc(agent.id);

    const meRes = await request(app).get('/v1/me/qr').set(headers);
    expect(meRes.status).toBe(200);
    expect(meRes.body.bankAccountLabel).toBe('ACB - 999 - TEST ME');
    expect(Buffer.from(meRes.body.imageBase64, 'base64').equals(png)).toBe(true);
  });

  // ── POST /v1/me/push-token (26/7, push notification FCM) ──────────────────────────────────────────────
  describe('POST /v1/me/push-token', () => {
    it('KHÔNG đăng nhập → 401 (đúng requireSession chung)', async () => {
      const res = await request(app)
        .post('/v1/me/push-token')
        .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
        .send({ token: 'fcm-tok', platform: 'android' });
      expect(res.status).toBe(401);
    });

    it('thiếu token → 400 VALIDATION', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).post('/v1/me/push-token').set(headers).send({ platform: 'android' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION');
    });

    it('platform khác "android" (vd "ios") → 400 VALIDATION — ngoài phạm vi đợt này', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).post('/v1/me/push-token').set(headers).send({ token: 'fcm-tok', platform: 'ios' });
      expect(res.status).toBe(400);
    });

    it('đăng ký token MỚI → tạo hàng PushToken đúng agentId', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const token = `fcm-new-${Date.now()}`;
      const res = await request(app).post('/v1/me/push-token').set(headers).send({ token, platform: 'android' });
      expect(res.status).toBe(200);
      const db = getBotDb();
      const row = await db.pushToken.findUnique({ where: { token } });
      expect(row).not.toBeNull();
      expect(row!.agentId).toBe(agent.id);
      expect(row!.platform).toBe('android');
    });

    it('đăng ký LẠI token đã tồn tại (gỡ-cài-lại/đổi tài khoản CÙNG máy) → UPSERT ghi đè agentId, KHÔNG lỗi trùng khóa', async () => {
      const agentOld = await makeAgent();
      const agentNew = await makeAgent();
      const token = `fcm-reuse-${Date.now()}`;
      const db = getBotDb();
      await db.pushToken.create({ data: { agentId: agentOld.id, token, platform: 'android' } });

      const { headers } = await linkAgentToRc(agentNew.id);
      const res = await request(app).post('/v1/me/push-token').set(headers).send({ token, platform: 'android' });
      expect(res.status).toBe(200);

      const row = await db.pushToken.findUnique({ where: { token } });
      expect(row!.agentId).toBe(agentNew.id); // ghi đè sang chủ mới, KHÔNG còn thuộc agentOld
      const count = await db.pushToken.count({ where: { token } });
      expect(count).toBe(1); // KHÔNG tạo hàng trùng — vẫn đúng 1 hàng cho 1 token vật lý
    });
  });

  // ── POST /v1/me/lo/ocr-preview (31/7, B71 phần 2 — audit độc lập yêu cầu bổ sung test HTTP THẬT qua
  // supertest, KHÔNG chỉ test hàm thuần ocr-bridge.test.ts) — real WebSession (linkAgentToRc) + real Express
  // app (createApp()), CÙNG khuôn mọi describe khác trong file này. `global.fetch` mock cho 2 case cần chạm
  // callOcrService (SERVICE_UNREACHABLE/thành công) — KHÔNG gọi OCR service Python thật.
  describe('POST /v1/me/lo/ocr-preview', () => {
    // PNG 1x1 THẬT ĐẦY ĐỦ (CÙNG buffer test/chat-attachments-routes.test.ts/test/ocr-bridge.test.ts dùng) —
    // cần chunk IHDR hợp lệ thật để `file-type` (sniff mime trong ocr-bridge.ts) nhận diện đúng image/png.
    const REAL_PNG_BUFFER = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('KHÔNG đăng nhập (thiếu cookie phiên) → 401', async () => {
      const res = await request(app)
        .post('/v1/me/lo/ocr-preview')
        .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
        .attach('image', REAL_PNG_BUFFER, 'bill.png');
      expect(res.status).toBe(401);
    });

    it('thiếu file trong multipart body → 400 NO_FILE', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).post('/v1/me/lo/ocr-preview').set(headers).field('khong-phai-file', 'abc');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('NO_FILE');
    });

    it('file vượt 10MB (MAX_OCR_IMAGE_SIZE_BYTES) → 413 FILE_TOO_LARGE', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const oversized = Buffer.alloc(11 * 1024 * 1024, 0); // 11MB — vượt 10MB đúng 1MB.
      const res = await request(app).post('/v1/me/lo/ocr-preview').set(headers).attach('image', oversized, 'qua-lon.png');
      expect(res.status).toBe(413);
      expect(res.body.error).toBe('FILE_TOO_LARGE');
    });

    it('file KHÔNG PHẢI ảnh thật (magic-bytes sai, vd .txt đổi tên .jpg) → 400 MIME_NOT_ALLOWED (audit fix)', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const plainTextAsJpg = Buffer.from('khong phai anh that, chi la .txt doi ten', 'utf8');
      const res = await request(app).post('/v1/me/lo/ocr-preview').set(headers).attach('image', plainTextAsJpg, 'gia-mao.jpg');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('MIME_NOT_ALLOWED');
    });

    it('OCR service KHÔNG gọi được (mạng refused) → 502 SERVICE_UNREACHABLE', async () => {
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).post('/v1/me/lo/ocr-preview').set(headers).attach('image', REAL_PNG_BUFFER, 'bill.png');
      expect(res.status).toBe(502);
      expect(res.body.error).toBe('SERVICE_UNREACHABLE');
    });

    it('thành công — OCR service trả dòng "VND ..." → 200, body preview đúng field (found/rawText/parsedAmount/needsManualReview/reasons) + 6 trường mới null vì fakeLines không có (tidMatched:false)', async () => {
      const fakeLines = [
        { text: 'Thanh toan', score: 0.97 },
        { text: 'VND 52700.000', score: 0.9592 },
        { text: 'VND 0', score: 0.92 }
      ];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: fakeLines }) })
      );
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).post('/v1/me/lo/ocr-preview').set(headers).attach('image', REAL_PNG_BUFFER, 'bill.png');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        found: true,
        rawText: '52700.000',
        parsedAmount: 52700000,
        needsManualReview: true,
        reasons: [
          'Định dạng phân nhóm nghìn không đúng chuẩn (mỗi nhóm sau dấu phân cách phải đúng 3 chữ số): "52700.000" — nghi ngờ OCR làm rớt/thêm dấu phân cách, đổi sai giá trị số tiền.'
        ],
        tid: null,
        hkdName: null,
        dateTime: null,
        batchNumber: null,
        invoiceNumber: null,
        bankName: null,
        tidMatched: false,
        settlementRisk: null,
        // Nhận diện loại thẻ (Admin Demo 21/8) — fakeLines không có scheme/BIN nào → cả 2 null.
        detectedCardScheme: null,
        detectedBin6: null,
        // HASH ẢNH bill (sha256 REAL_PNG_BUFFER) — client dùng làm khóa dedup tầng 2 (chống Lô trùng khi gửi lại
        // cùng ảnh). Deterministic theo đúng buffer test → assert giá trị cứng (đúng feedback_mock_shape_accuracy).
        billImageHash: '431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460'
      });
    });

    // ── Đối chiếu TID OCR đọc được với dữ liệu Tid ĐÃ CẤU HÌNH của đại lý đang đăng nhập (Admin Demo 1/8) — dùng
    // fixture bill thật REAL_BILL_COMMA_BUG_OCR_LINES-tương tự (dòng "TID:50550759/SEO:001283 MID:") nguyên
    // văn từ ocr-bridge.test.ts, KHÔNG bịa lines mới. listAgentTidsWithCardTypeOptions() chạy trên throwaway
    // Postgres THẬT (global-setup.ts) — verify CHÍNH luồng route thật gọi DB, không chỉ hàm thuần.
    describe('đối chiếu TID với dữ liệu đã cấu hình (tidMatched)', () => {
      const billLinesWithTid = [
        { text: 'MB', score: 0.99 },
        { text: 'TÊN DAI LÝ:', score: 0.9 },
        { text: 'HKD DEMOMAY 1 (OCR, không đáng tin)', score: 0.9 },
        { text: 'TID:50550759/SEO:001283 MID:', score: 0.9 },
        { text: '055-C-458485', score: 0.9 },
        { text: 'VND 140,000.000', score: 0.95 }
      ];

      it('TID đọc từ OCR KHỚP TID đã cấu hình của đại lý → tidMatched:true, hkdName/bankName lấy TỪ DB (không phải text OCR)', async () => {
        const bank = await makeBank();
        const agent = await makeAgent();
        const configuredTid = await makeTid({ tid: '50550759', agentId: agent.id, bankId: bank.id, status: 'ACTIVE', hkdName: 'HKD DEMOMAY 1 THAT (DB)' });
        // NGỮ NGHĨA MỚI (20/8): matchBillTidWithAgentTids() so với listAgentTidsWithCardTypeOptions(agent) — hàm
        // đó nay lấy TID qua chuỗi nhóm chat, KHÔNG qua tids.agentId. Nối chuỗi để TID '50550759' thuộc "tầm nhìn"
        // của agent thì tidMatched mới đúng true.
        await makeTidVisibleToAgentViaGroup(agent.id, configuredTid.id);
        const { headers } = await linkAgentToRc(agent.id);
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: billLinesWithTid }) })
        );

        const res = await request(app).post('/v1/me/lo/ocr-preview').set(headers).attach('image', REAL_PNG_BUFFER, 'bill.png');
        expect(res.status).toBe(200);
        expect(res.body.tid).toEqual({ value: '50550759', uncertain: false });
        expect(res.body.tidMatched).toBe(true);
        // hkdName lấy TỪ DB ("HKD DEMOMAY 1 THAT (DB)"), KHÔNG PHẢI text OCR đọc được ("HKD DEMOMAY 1 (OCR,...)").
        expect(res.body.hkdName).toEqual({ value: 'HKD DEMOMAY 1 THAT (DB)', uncertain: false });
        expect(res.body.bankName).toEqual({ value: bank.name, uncertain: false });
      });

      it('TID đọc từ OCR KHÔNG khớp TID nào của đại lý (chưa cấu hình/thuộc đại lý khác) → tidMatched:false, hkdName/bankName FALLBACK về text OCR đọc trực tiếp, VẪN 200 (không chặn luồng)', async () => {
        const agent = await makeAgent();
        // Cố tình KHÔNG tạo Tid nào khớp "50550759" cho đại lý này — TID đã cấu hình khác hẳn.
        await makeTid({ tid: '99999999', agentId: agent.id, status: 'ACTIVE' });
        const { headers } = await linkAgentToRc(agent.id);
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: billLinesWithTid }) })
        );

        const res = await request(app).post('/v1/me/lo/ocr-preview').set(headers).attach('image', REAL_PNG_BUFFER, 'bill.png');
        expect(res.status).toBe(200);
        expect(res.body.tid).toEqual({ value: '50550759', uncertain: false });
        expect(res.body.tidMatched).toBe(false);
        // Fallback: hkdName GIỮ NGUYÊN text OCR đọc trực tiếp (KHÔNG có dữ liệu DB đáng tin hơn để thay).
        expect(res.body.hkdName).toEqual({ value: 'HKD DEMOMAY 1 (OCR, không đáng tin)', uncertain: false });
      });

      it('TID khớp NHƯNG TID đó thuộc đại lý KHÁC (không phải đại lý đang đăng nhập) → tidMatched:false (KHÔNG dò dữ liệu đại lý khác)', async () => {
        // TID SỐ RIÊNG cho test này (KHÔNG dùng lại "50550759" của 2 test trên trong CÙNG file — DB throwaway
        // của file này KHÔNG truncate giữa các it(), tid unique toàn bảng, dùng lại sẽ vỡ unique constraint;
        // xem setup-each-file.ts chỉ resetBotDb() ở afterAll, không reset dữ liệu giữa từng test).
        const otherAgentTidLines = [
          { text: 'MB', score: 0.99 },
          { text: 'TID:50550760/SEO:001284 MID:', score: 0.9 },
          { text: 'VND 140,000.000', score: 0.95 }
        ];
        const otherAgent = await makeAgent();
        await makeTid({ tid: '50550760', agentId: otherAgent.id, status: 'ACTIVE', hkdName: 'HKD CUA DAI LY KHAC' });
        const agent = await makeAgent(); // đại lý đang gọi — KHÔNG có TID "50550760" nào của CHÍNH mình
        const { headers } = await linkAgentToRc(agent.id);
        vi.stubGlobal(
          'fetch',
          vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: otherAgentTidLines }) })
        );

        const res = await request(app).post('/v1/me/lo/ocr-preview').set(headers).attach('image', REAL_PNG_BUFFER, 'bill.png');
        expect(res.status).toBe(200);
        expect(res.body.tid).toEqual({ value: '50550760', uncertain: false });
        expect(res.body.tidMatched).toBe(false);
        expect(res.body.hkdName).not.toEqual({ value: 'HKD CUA DAI LY KHAC', uncertain: false });
      });
    });

    // B122 (2/8, audit đối kháng "route tốn tài nguyên đã có rate-limit đủ chưa") — route NÀY gọi OCR
    // microservice GPU (ocr-bridge.ts → RTX 5060 Ti, xem B104 BUGS_FIXED.md) mỗi request, đắt hơn HẲN mọi route
    // /v1/me/* khác — TRƯỚC ĐỢT NÀY hoàn toàn KHÔNG rate-limit. Test xác nhận limiter THẬT SỰ chặn (không chỉ
    // khai báo cho có) — CÙNG khuôn test friendLookupLimiter (test/me-friends.test.ts): request thứ 16
    // (limit=15) trong cùng phút → 429, scope theo agentId (agent KHÁC không bị ảnh hưởng).
    it('rate-limit 15 lần/phút, scope theo agentId — request thứ 16 → 429 RATE_LIMITED', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: [{ text: 'VND 0', score: 0.9 }] }) })
      );
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const other = await makeAgent();
      const { headers: otherHeaders } = await linkAgentToRc(other.id);

      for (let i = 0; i < 15; i++) {
        const res = await request(app).post('/v1/me/lo/ocr-preview').set(headers).attach('image', REAL_PNG_BUFFER, 'bill.png');
        expect(res.status).toBe(200);
      }
      const sixteenth = await request(app).post('/v1/me/lo/ocr-preview').set(headers).attach('image', REAL_PNG_BUFFER, 'bill.png');
      expect(sixteenth.status).toBe(429);
      expect(sixteenth.body.error).toBe('RATE_LIMITED');

      // Agent KHÁC gọi CÙNG route ngay sau đó — vẫn 200 (scope theo agentId, KHÔNG theo IP).
      const otherRes = await request(app).post('/v1/me/lo/ocr-preview').set(otherHeaders).attach('image', REAL_PNG_BUFFER, 'bill.png');
      expect(otherRes.status).toBe(200);
    });
  });

  // ── POST /v1/me/refund/ocr-preview (2/8, tính năng "Hoàn tiền" MỚI) — CÙNG khuôn HTTP thật describe trên
  // (WebSession thật + Express thật, mock CHỈ global.fetch chạm callOcrService).
  describe('POST /v1/me/refund/ocr-preview', () => {
    const REAL_PNG_BUFFER2 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('KHÔNG đăng nhập → 401', async () => {
      const res = await request(app)
        .post('/v1/me/refund/ocr-preview')
        .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE)
        .attach('image', REAL_PNG_BUFFER2, 'hoan.png');
      expect(res.status).toBe(401);
    });

    it('thành công — OCR đọc đủ trường, KHÔNG truyền originalTid → recipientMatch.status="no_tid", KHÔNG chặn luồng (vẫn 200)', async () => {
      const fakeLines = [
        { text: 'BIDV', score: 0.99 },
        { text: 'Người nhận', score: 0.9 },
        { text: 'KHACH HANG 44', score: 0.9 },
        { text: 'Số tài khoản nhận', score: 0.9 },
        { text: '8791797777', score: 0.9 },
        { text: 'VND 102.707.000', score: 0.95 }
      ];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: fakeLines }) }));
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).post('/v1/me/refund/ocr-preview').set(headers).attach('image', REAL_PNG_BUFFER2, 'hoan.png');
      expect(res.status).toBe(200);
      expect(res.body.parsedAmount).toBe(102_707_000);
      expect(res.body.recipientName).toEqual({ value: 'KHACH HANG 44', uncertain: false });
      expect(res.body.recipientMatch.status).toBe('no_tid');
    });

    it('CÓ originalTid + TID đã cấu hình ReceiveAccount khớp → recipientMatch.status="matched" qua route THẬT (không chỉ hàm thuần)', async () => {
      const bank = await makeBank();
      const partnerAgent = await makeAgent();
      const tid = await makeTid({ tid: `RTID${Date.now()}`, agentId: partnerAgent.id });
      const db = getBotDb();
      const source = await db.receiveAccountSource.create({ data: { name: `Nguon${Date.now()}` } });
      const account = await db.receiveAccount.create({ data: { sourceId: source.id, bankId: bank.id, accountName: 'KHACH HANG 44', accountNumber: '8791797777' } });
      await db.tid.update({ where: { id: tid.id }, data: { receiveAccountId: account.id } });

      const fakeLines = [
        { text: 'Người nhận', score: 0.9 },
        { text: 'KHACH HANG 44', score: 0.9 },
        { text: 'Số tài khoản nhận', score: 0.9 },
        { text: '8791797777', score: 0.9 },
        { text: 'VND 102.707.000', score: 0.95 }
      ];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: fakeLines }) }));
      const { headers } = await linkAgentToRc(partnerAgent.id);
      const res = await request(app)
        .post(`/v1/me/refund/ocr-preview?originalTid=${encodeURIComponent(tid.tid)}`)
        .set(headers)
        .attach('image', REAL_PNG_BUFFER2, 'hoan.png');
      expect(res.status).toBe(200);
      expect(res.body.recipientMatch.status).toBe('matched');
    });

    it('CÓ originalTid NHƯNG TID chưa cấu hình ReceiveAccount → recipientMatch.status="not_configured"', async () => {
      const agent2 = await makeAgent();
      const tid = await makeTid({ tid: `RTID2${Date.now()}`, agentId: agent2.id });
      const fakeLines = [
        { text: 'Người nhận', score: 0.9 },
        { text: 'AI DO', score: 0.9 },
        { text: 'VND 100.000', score: 0.95 }
      ];
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: fakeLines }) }));
      const { headers } = await linkAgentToRc(agent2.id);
      const res = await request(app)
        .post(`/v1/me/refund/ocr-preview?originalTid=${encodeURIComponent(tid.tid)}`)
        .set(headers)
        .attach('image', REAL_PNG_BUFFER2, 'hoan.png');
      expect(res.status).toBe(200);
      expect(res.body.recipientMatch.status).toBe('not_configured');
    });
  });

  // ── GET /v1/me/refund/aggregate (2/8) — trạng thái cộng dồn nhiều lần hoàn tiền cho 1 bill gốc.
  describe('GET /v1/me/refund/aggregate', () => {
    it('thiếu originalMessageId → 400 VALIDATION', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).get('/v1/me/refund/aggregate?requiredAmount=1000').set(headers);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('VALIDATION');
    });

    it('requiredAmount không hợp lệ (chữ) → 400 VALIDATION', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).get('/v1/me/refund/aggregate?originalMessageId=abc&requiredAmount=khong-phai-so').set(headers);
      expect(res.status).toBe(400);
    });

    it('originalMessageId không tồn tại → 404 MESSAGE_NOT_FOUND', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).get('/v1/me/refund/aggregate?originalMessageId=khong-ton-tai&requiredAmount=1000').set(headers);
      expect(res.status).toBe(404);
      expect(res.body.error).toBe('MESSAGE_NOT_FOUND');
    });
  });

  // #5 (3/8, LANE B Vòng 2) — route chống hoàn TRÙNG. Wiring end-to-end (auth + đối chiếu DB) — logic thuần đã
  // test kỹ ở refund-dedup.test.ts, đây kiểm ROUTE nối đúng (cách ly agentId, trả cảnh báo "cách đây X").
  describe('GET /v1/me/refund/dedup-check (#5 chống hoàn trùng)', () => {
    it('thiếu cookie phiên → 401 SESSION_INVALID', async () => {
      const res = await request(app).get('/v1/me/refund/dedup-check?transferCode=ABC').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
      expect(res.status).toBe(401);
    });

    it('trùng mã chuyển tiền với 1 lần hoàn cũ của CHÍNH đại lý → status duplicate + "cách đây"', async () => {
      const db = getBotDb();
      const agent = await makeAgent();
      const room = await db.chatRoom.create({ data: { type: 'GROUP', name: 'phong-dedup-route' } });
      await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agent.id,
          kind: 'IMAGE',
          metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 102_707_000, refundDedup: { transferCode: '6214BIDVE2DY1464', recipientAccount: '8791797777', dateTime: '02/08/2026 15:52:57' } }),
          createdAt: new Date(Date.now() - 3 * 3_600_000) // 3 giờ trước.
        }
      });
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).get('/v1/me/refund/dedup-check').set(headers).query({ transferCode: '6214bidve2dy1464', amount: '102707000', recipientAccount: '8791797777', dateTime: '02/08/2026 15:52:57' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('duplicate');
      expect(res.body.message).toContain('giờ');
    });

    it('mã chuyển tiền chưa từng xuất hiện → status ok', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).get('/v1/me/refund/dedup-check').set(headers).query({ transferCode: 'MACHUATUNGCO000001', amount: '1000000' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('THIẾU mã chuyển tiền → insufficient_data (kiểm tay)', async () => {
      const agent = await makeAgent();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app).get('/v1/me/refund/dedup-check').set(headers).query({ amount: '1000000' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('insufficient_data');
    });
  });
});
