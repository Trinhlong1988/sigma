// SIGMA Phase 1 (24/7) — test cho GET /v1/me/kpi (routes/kpi.ts, kế hoạch mục D.6 "Báo cáo/KPI").
// Mock rc-client.rcGetMe (KHÔNG gọi Rocket.Chat thật) — CÙNG khuôn me.test.ts/auth-routes.test.ts.
//
// BUG THẬT phát hiện lúc build endpoint này (24/7, xem app.ts): agentsRouter.use(requireBearerAuth) là
// middleware TOÀN CỤC (không giới hạn path — mounted qua app.use(agentsRouter) không prefix), nên áp cho MỌI
// request đi qua, kể cả /v1/me/kpi không hề khớp route nào của agentsRouter — chặn 401 UNAUTHORIZED (Bearer)
// TRƯỚC KHI request chạm tới kpiRouter/requireRcAuth. Fix = mount kpiRouter TRƯỚC agentsRouter trong app.ts.
// Test đầu tiên dưới đây CHỐT CỨNG bằng chứng: thiếu header RC-auth PHẢI trả đúng RC_TOKEN_INVALID (không
// phải UNAUTHORIZED của agentsRouter) — nếu ai đó lỡ đổi lại thứ tự mount trong app.ts, test này FAIL ngay
// (đúng nguyên tắc "check phải chạy, không chỉ không có finding" — R198).
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApp } from '../src/app.js';
import { getBotDb } from '../src/db.js';
import { createWebSession, WEB_SESSION_COOKIE_NAME } from '../src/web-session-service.js';
import { CSRF_HEADER_NAME, CSRF_HEADER_VALUE } from '../src/web-session-middleware.js';
import { makeAgent, makeBank, makeCardType, makeFeeSellQuote, makeFeeType, makePartner, makeQuoteReadyTid, makeTid, makeTidSellFee, makeTidVisibleToAgentViaGroup } from './fixtures.js';

let rcCounter = 0;
function nextRcUserId(): string {
  rcCounter += 1;
  return `rc-kpi-test-${Date.now()}-${rcCounter}`;
}

// B39 (27/7) — /v1/me/kpi đổi sang requireSession (KHÔNG còn gọi rcGetMe, xem BUGS_FIXED.md B39).
async function linkAgentToRc(agentId: number): Promise<{ headers: Record<string, string> }> {
  const db = getBotDb();
  const rcUserId = nextRcUserId();
  await db.agent.update({ where: { id: agentId }, data: { rcUserId, rcUsername: rcUserId } });
  const ws = await createWebSession(db, { rcUserId, rcAuthToken: 'test-tok', agentId });
  return { headers: { Cookie: `${WEB_SESSION_COOKIE_NAME}=${ws.id}`, [CSRF_HEADER_NAME]: CSRF_HEADER_VALUE } };
}

/** Bucket ngày LOCAL — PHẢI khớp CHÍNH XÁC thuật toán localDateKey trong routes/kpi.ts (không export hàm nội
 * bộ ra để test import — lặp lại công thức 3 dòng ở đây, dùng để tính TRƯỚC kỳ vọng thay vì hard-code chuỗi
 * ngày, tránh test bị lệch múi giờ tùy máy chạy). */
function dayKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Tạo 1 Lô + LoRow THẬT với amountBeforeFee/createdAt/status tùy chỉnh (đi thẳng DB, KHÔNG qua createLo() vì
 * createLo() luôn dùng createdAt=now() — test biên ngày/khoảng cần kiểm soát createdAt chính xác). */
async function makeLoWithAmount(opts: {
  agentId: number;
  tidId: number;
  cardTypeId: number;
  feeTypeId: number;
  amountBeforeFee: bigint;
  createdAt: Date;
  status?: string;
  feeApplied?: bigint; // mặc định 0 (net = gross); truyền >0 để test doanh số sau phí
}) {
  const db = getBotDb();
  const fee = opts.feeApplied ?? 0n;
  const lo = await db.lo.create({
    data: {
      agentId: opts.agentId,
      status: opts.status ?? 'PENDING',
      expectedTotalAmount: opts.amountBeforeFee - fee,
      createdAt: opts.createdAt,
      cancelledAt: opts.status === 'CANCELLED' ? opts.createdAt : null,
      cancelReason: opts.status === 'CANCELLED' ? 'test hủy' : null
    }
  });
  await db.loRow.create({
    data: {
      loId: lo.id,
      tidId: opts.tidId,
      cardTypeId: opts.cardTypeId,
      feeTypeId: opts.feeTypeId,
      amountBeforeFee: opts.amountBeforeFee,
      feeApplied: fee,
      amountAfterFee: opts.amountBeforeFee - fee
    }
  });
  return lo;
}

describe('GET /v1/me/kpi — báo cáo KPI đại lý hiện tại (RC-auth)', () => {
  const app = createApp();

  beforeEach(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('thiếu cookie phiên (đã có header CSRF) → 401 SESSION_INVALID (KHÔNG phải UNAUTHORIZED của agentsRouter — regression bug router-order)', async () => {
    const res = await request(app).get('/v1/me/kpi').set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('SESSION_INVALID');
  });

  it('phiên hợp lệ nhưng KHÔNG Agent nào link rcUserId đó → 401 AGENT_NOT_LINKED', async () => {
    const db = getBotDb();
    const ws = await createWebSession(db, { rcUserId: 'rc-kpi-unlinked', rcAuthToken: 'test-tok' });
    const res = await request(app)
      .get('/v1/me/kpi')
      .set('Cookie', `${WEB_SESSION_COOKIE_NAME}=${ws.id}`)
      .set(CSRF_HEADER_NAME, CSRF_HEADER_VALUE);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('AGENT_NOT_LINKED');
  });

  it('from >= to → 400 VALIDATION', async () => {
    const { agent } = await makeQuoteReadyTid();
    const { headers } = await linkAgentToRc(agent.id);
    const res = await request(app).get('/v1/me/kpi').set(headers).query({ from: '2026-07-10T00:00:00.000Z', to: '2026-07-01T00:00:00.000Z' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('from/to không parse được ISO → 400 VALIDATION', async () => {
    const { agent } = await makeQuoteReadyTid();
    const { headers } = await linkAgentToRc(agent.id);
    const res = await request(app).get('/v1/me/kpi').set(headers).query({ from: 'khong-phai-ngay-thang' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('VALIDATION');
  });

  it('tổng doanh số/số lượng ĐÚNG bằng tổng amountBeforeFee của các Lô — loại trừ Lô CANCELLED, Lô ngoài khoảng, Lô đại lý KHÁC; TRẢ gross+net+fee (Admin Demo 22/8)', async () => {
    const { agent, tid, cardType, feeType } = await makeQuoteReadyTid();
    const { agent: otherAgent, tid: otherTid, cardType: otherCardType, feeType: otherFeeType } = await makeQuoteReadyTid();

    // Dùng constructor Date(y, m, d, h) — LUÔN diễn giải theo giờ LOCAL của máy chạy test (bất kể múi giờ),
    // KHÔNG dùng chuỗi ISO 'Z' (UTC cứng) — máy chạy test múi +7 khiến 08:00Z và 20:00Z LỆCH NGÀY LOCAL (đã
    // phát hiện lúc build: assert sai count=2 thành count=1 vì 20:00Z = 03:00 hôm sau giờ VN). Local
    // constructor đảm bảo day1/day1Later CÙNG 1 ngày local thật sự, đúng ý đồ test "gộp 2 Lô cùng ngày".
    const from = new Date(2026, 6, 1, 0, 0, 0); // 2026-07-01 00:00 local
    const to = new Date(2026, 7, 1, 0, 0, 0); // 2026-08-01 00:00 local
    const day1 = new Date(2026, 6, 10, 8, 0, 0);
    const day1Later = new Date(2026, 6, 10, 20, 0, 0);
    const day2 = new Date(2026, 6, 15, 12, 0, 0);
    const outOfRange = new Date(2026, 5, 1, 12, 0, 0); // 2026-06-01, trước from

    const base = { agentId: agent.id, tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id };
    await makeLoWithAmount({ ...base, amountBeforeFee: 1_000_000n, createdAt: day1, status: 'PENDING' });
    await makeLoWithAmount({ ...base, amountBeforeFee: 2_000_000n, createdAt: day1Later, status: 'CONFIRMED' });
    await makeLoWithAmount({ ...base, amountBeforeFee: 3_000_000n, createdAt: day2, status: 'MISMATCH' });
    // Lô đã hủy — PHẢI loại trừ khỏi tổng dù nằm trong khoảng thời gian.
    await makeLoWithAmount({ ...base, amountBeforeFee: 9_999_999n, createdAt: day1, status: 'CANCELLED' });
    // Lô ngoài khoảng [from,to) — PHẢI loại trừ.
    await makeLoWithAmount({ ...base, amountBeforeFee: 500_000n, createdAt: outOfRange, status: 'PENDING' });
    // Lô của đại lý KHÁC — TUYỆT ĐỐI không được lẫn vào tổng của agent đang gọi.
    await makeLoWithAmount({
      agentId: otherAgent.id,
      tidId: otherTid.id,
      cardTypeId: otherCardType.id,
      feeTypeId: otherFeeType.id,
      amountBeforeFee: 7_000_000n,
      createdAt: day1,
      status: 'PENDING'
    });

    const { headers } = await linkAgentToRc(agent.id);
    const res = await request(app).get('/v1/me/kpi').set(headers).query({ from: from.toISOString(), to: to.toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.agentId).toBe(agent.id);
    expect(res.body.totalLoCount).toBe(3); // day1 + day1Later + day2, KHÔNG tính CANCELLED/ngoài khoảng/đại lý khác
    expect(res.body.totalRevenue).toBe(6_000_000); // gross: 1tr + 2tr + 3tr
    // Admin Demo 22/8 — báo cáo giờ TRẢ THÊM net (thực nhận sau phí) + fee. Helper set feeApplied=0, amountAfterFee=gross
    // → net = gross = 6tr, fee = 0. (Test riêng bên dưới phủ trường hợp fee>0.)
    expect(res.body.totalRevenueNet).toBe(6_000_000);
    expect(res.body.totalFee).toBe(0);

    // Response CHỈ có đúng bộ field đã định nghĩa. SIGMA (2/8) — `refund` tích hợp CÙNG response (describe cuối file).
    const bodyKeys = Object.keys(res.body);
    expect(bodyKeys).toEqual(['agentId', 'from', 'to', 'totalLoCount', 'totalRevenue', 'totalRevenueNet', 'totalFee', 'daily', 'refund']);
    for (const d of res.body.daily) {
      expect(Object.keys(d)).toEqual(['date', 'count', 'amount', 'amountNet']);
    }

    const daily = res.body.daily as { date: string; count: number; amount: number; amountNet: number }[];
    const d1 = daily.find((x) => x.date === dayKey(day1));
    const d2 = daily.find((x) => x.date === dayKey(day2));
    expect(d1).toEqual({ date: dayKey(day1), count: 2, amount: 3_000_000, amountNet: 3_000_000 }); // day1 (1tr) + day1Later (2tr) CÙNG ngày local
    expect(d2).toEqual({ date: dayKey(day2), count: 1, amount: 3_000_000, amountNet: 3_000_000 });
    expect(daily.length).toBe(dayKey(day1) === dayKey(day2) ? 1 : 2);
  });

  it('fee>0 → totalRevenueNet = gross − fee, totalFee = Σ phí, daily.amountNet đúng (Admin Demo 22/8 "doanh số sau phí")', async () => {
    const { agent, tid, cardType, feeType } = await makeQuoteReadyTid();
    const from = new Date(2026, 6, 1, 0, 0, 0);
    const to = new Date(2026, 7, 1, 0, 0, 0);
    const day = new Date(2026, 6, 12, 9, 0, 0);
    const base = { agentId: agent.id, tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, createdAt: day };
    // Quẹt 10tr phí 105k (net 9.895.000) + quẹt 5tr phí 75k (net 4.925.000) CÙNG ngày.
    await makeLoWithAmount({ ...base, amountBeforeFee: 10_000_000n, feeApplied: 105_000n, status: 'PENDING' });
    await makeLoWithAmount({ ...base, amountBeforeFee: 5_000_000n, feeApplied: 75_000n, status: 'CONFIRMED' });
    const { headers } = await linkAgentToRc(agent.id);
    const res = await request(app).get('/v1/me/kpi').set(headers).query({ from: from.toISOString(), to: to.toISOString() });
    expect(res.status).toBe(200);
    expect(res.body.totalRevenue).toBe(15_000_000); // gross
    expect(res.body.totalRevenueNet).toBe(14_820_000); // net = 9.895tr + 4.925tr
    expect(res.body.totalFee).toBe(180_000); // 105k + 75k
    const d = (res.body.daily as { date: string; amount: number; amountNet: number }[]).find((x) => x.date === dayKey(day));
    expect(d).toEqual({ date: dayKey(day), count: 2, amount: 15_000_000, amountNet: 14_820_000 });
  });

  it('không truyền from/to → mặc định 30 ngày gần nhất (Lô hôm nay lọt vào tổng)', async () => {
    const { agent, tid, cardType, feeType } = await makeQuoteReadyTid();
    await makeLoWithAmount({
      agentId: agent.id,
      tidId: tid.id,
      cardTypeId: cardType.id,
      feeTypeId: feeType.id,
      amountBeforeFee: 1_234_000n,
      createdAt: new Date(),
      status: 'PENDING'
    });
    const { headers } = await linkAgentToRc(agent.id);
    const res = await request(app).get('/v1/me/kpi').set(headers);
    expect(res.status).toBe(200);
    expect(res.body.totalLoCount).toBeGreaterThanOrEqual(1);
    expect(res.body.totalRevenue).toBeGreaterThanOrEqual(1_234_000);
  });

  it('đại lý chưa có Lô nào trong khoảng → 200 với totalLoCount=0/totalRevenue=0/daily=[] (KHÔNG lỗi)', async () => {
    const { agent } = await makeQuoteReadyTid();
    const { headers } = await linkAgentToRc(agent.id);
    const res = await request(app)
      .get('/v1/me/kpi')
      .set(headers)
      .query({ from: '2020-01-01T00:00:00.000Z', to: '2020-01-02T00:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(res.body.totalLoCount).toBe(0);
    expect(res.body.totalRevenue).toBe(0);
    expect(res.body.daily).toEqual([]);
  });

  // ── SIGMA (2/8, tính năng "Hoàn tiền" MỚI, mục 6 brief — "tích hợp luôn trong phần doanh số") — field
  // `refund` MỚI trong CÙNG response, nguồn dữ liệu ChatMessage (bill/hoàn tiền quét trong khung chat, KHÁC
  // hẳn Lo/LoRow ở trên) — seed thẳng qua Prisma (KHÔNG qua chat-message-service.ts, đủ cho mục đích test tổng
  // hợp báo cáo, không cần round-trip qua toàn bộ luồng gửi tin thật).
  describe('field refund (2/8, tính năng Hoàn tiền)', () => {
    it('2 bill trong kỳ: 1 ĐÃ hoàn đủ (matched), 1 CHƯA hoàn — tổng hợp + bucket ngày ĐÚNG, KHÔNG lộ field Lo cũ', async () => {
      // Dựng tay KHÔNG dùng makeQuoteReadyTid() thẳng — buildRefundKpiReport() gọi previewSellFeeForTid() bên
      // trong, hàm đó KHÔNG nhận cardTypeId/feeTypeId (CÙNG lý do describe('GET /v1/me/fee-preview') ở trên đã
      // ghi rõ, B111) → quoteRow() tự mặc định "FeeType đầu tiên id asc TOÀN BẢNG", KHÔNG lọc theo test này —
      // seed FeeSellQuote cho FeeType TỰ TẠO qua makeQuoteReadyTid() dễ KHÔNG được chọn khi chạy sau nhiều test
      // khác trong CÙNG file đã tạo FeeType riêng (test "tổng doanh số..." phía trên tạo 2 FeeType). Fix: TỰ
      // hỏi DB FeeType nào sẽ được mặc định rồi seed khớp ĐÚNG FeeType đó (CÙNG kỹ thuật B111).
      const db = getBotDb();
      const bank = await makeBank();
      const partner = await makePartner();
      const cardType = await makeCardType(bank.id);
      const agent = await makeAgent();
      const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
      // NGỮ NGHĨA MỚI (20/8): buildRefundKpiReport→previewSellFeeForTid xác định "TID của agent" qua chuỗi nhóm
      // chat (customerId), KHÔNG qua tids.agentId — nối chuỗi để previewSellFeeForTid resolve ĐÚNG phí 2% cho
      // TID này (nếu không, sẽ fallback 0% → totalRequiredAmount sai). Độc lập với chatRoomTid (room coverage) dưới.
      await makeTidVisibleToAgentViaGroup(agent.id, tid.id);
      let feeType = await db.feeType.findFirst({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
      if (!feeType) feeType = await makeFeeType();
      await makeFeeSellQuote({
        partnerId: partner.id,
        cardTypeId: cardType.id,
        feeTypeId: feeType.id,
        phiBanMilli: 2000, // niêm yết 2% (tham khảo)
        effectiveFrom: new Date('2020-01-01T00:00:00.000Z')
      });
      // Admin Demo 20/8: previewSellFeeForTid chỉ áp GIÁ BÁN THỰC TẾ (override) → cần override 2% để required=amount−2%
      // (không mượn niêm yết). Nếu chỉ niêm yết, previewSellFeeForTid trả noActualFee:true (phí 0%) → required sai.
      await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 2000 });
      const room = await db.chatRoom.create({ data: { type: 'GROUP', name: 'phong-test-kpi-refund' } });
      // SIGMA (3/8, Admin Demo chốt "phòng chính thức với SigMa" — xem comment roomLinkCoverageChecker()
      // refund-report-service.ts) — PHẢI gắn ÍT NHẤT 1 TID active vào phòng, KHÔNG THÌ buildRefundKpiReport()
      // sẽ loại TOÀN BỘ bill trong phòng này khỏi báo cáo (đúng hành vi MỚI, test riêng cho nhánh loại trừ ở
      // dưới cùng file).
      // createdAt CỐ Ý đặt XA TRONG QUÁ KHỨ (2020) — mặc định `now()` sẽ RƠI SAU `day` (2026-07-10, TRƯỚC "hôm
      // nay" thật của môi trường chạy test) → coveredByPeriod() sẽ loại NHẦM bill (bug thật tự phát hiện lúc
      // viết test này, xem roomLinkCoverageChecker() yêu cầu `date >= l.createdAt`).
      await db.chatRoomTid.create({ data: { roomId: room.id, tidId: tid.id, createdBy: agent.id, createdAt: new Date('2020-01-01T00:00:00.000Z') } });
      const day = new Date(2026, 6, 10, 9, 0, 0); // 2026-07-10 09:00 local

      const billMatched = await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agent.id,
          kind: 'IMAGE',
          metadataJson: JSON.stringify({
            isBillImage: true,
            billAmount: 1_000_000,
            billImageHeightPx: 800,
            billFields: { tid: { value: tid.tid, uncertain: false } }
          }),
          createdAt: day
        }
      });
      // required = 1.000.000 - 2% = 980.000 → hoàn ĐÚNG 980.000 → matched.
      await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agent.id,
          kind: 'IMAGE',
          replyToMessageId: billMatched.id,
          metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 980_000 }),
          createdAt: new Date(day.getTime() + 60_000)
        }
      });

      // Bill thứ 2 CÙNG NGÀY, KHÔNG có lần hoàn tiền nào.
      await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agent.id,
          kind: 'IMAGE',
          metadataJson: JSON.stringify({
            isBillImage: true,
            billAmount: 2_000_000,
            billImageHeightPx: 800,
            billFields: { tid: { value: tid.tid, uncertain: false } }
          }),
          createdAt: new Date(day.getTime() + 120_000)
        }
      });
      // required bill2 = 2.000.000 - 2% = 1.960.000.

      const { headers } = await linkAgentToRc(agent.id);
      const from = new Date(2026, 6, 1, 0, 0, 0);
      const to = new Date(2026, 7, 1, 0, 0, 0);
      const res = await request(app).get('/v1/me/kpi').set(headers).query({ from: from.toISOString(), to: to.toISOString() });

      expect(res.status).toBe(200);
      expect(res.body.refund.totalBillCount).toBe(2);
      expect(res.body.refund.totalRefundedCount).toBe(1);
      expect(res.body.refund.totalPartialCount).toBe(0);
      expect(res.body.refund.totalUnrefundedCount).toBe(1);
      expect(res.body.refund.totalRequiredAmount).toBe(980_000 + 1_960_000);
      expect(res.body.refund.totalRefundedAmount).toBe(980_000);
      expect(res.body.refund.daily).toHaveLength(1);
      expect(res.body.refund.daily[0]).toEqual({
        date: dayKey(day),
        billCount: 2,
        refundedCount: 1,
        overCount: 0,
        partialCount: 0,
        unrefundedCount: 1,
        requiredAmount: 980_000 + 1_960_000,
        refundedAmount: 980_000
      });
    });

    it('hoàn THIẾU (lệch >3.000đ theo chiều thiếu) → partialCount=1, refundedCount=0', async () => {
      const { agent, tid } = await makeQuoteReadyTid({ phiBanMilli: 0 }); // phí 0% cho dễ tính — required=amount
      const db = getBotDb();
      const room = await db.chatRoom.create({ data: { type: 'GROUP', name: 'phong-test-kpi-refund-thieu' } });
      await db.chatRoomTid.create({ data: { roomId: room.id, tidId: tid.id, createdBy: agent.id, createdAt: new Date('2020-01-01T00:00:00.000Z') } }); // "phòng chính thức với SigMa" — xem comment test trên (createdAt XA QUÁ KHỨ, tránh bug "link sau bill" đã tự phát hiện).
      const day = new Date(2026, 6, 11, 9, 0, 0);
      const bill = await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agent.id,
          kind: 'IMAGE',
          metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billImageHeightPx: 800, billFields: { tid: { value: tid.tid, uncertain: false } } }),
          createdAt: day
        }
      });
      await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agent.id,
          kind: 'IMAGE',
          replyToMessageId: bill.id,
          metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 500_000 }),
          createdAt: new Date(day.getTime() + 60_000)
        }
      });
      const { headers } = await linkAgentToRc(agent.id);
      const from = new Date(2026, 6, 1, 0, 0, 0);
      const to = new Date(2026, 7, 1, 0, 0, 0);
      const res = await request(app).get('/v1/me/kpi').set(headers).query({ from: from.toISOString(), to: to.toISOString() });
      expect(res.body.refund.totalPartialCount).toBe(1);
      expect(res.body.refund.totalRefundedCount).toBe(0);
      expect(res.body.refund.totalUnrefundedCount).toBe(0);
    });

    // H1 (3/8, LANE B Vòng 2) — bill hoàn THỪA (>3.000đ theo chiều dương) PHẢI đếm RIÊNG vào totalOverCount,
    // KHÔNG gộp vào totalRefundedCount ("Hoàn đủ"). Trước fix: over bị cộng chung vào totalRefundedCount, che
    // giấu rủi ro tài chính thật (đã hoàn NHIỀU HƠN mức phải hoàn). Tái hiện: 1 bill 1.000.000đ phí 0% →
    // required=1.000.000, hoàn 1.100.000 (thừa 100.000 >3.000 tolerance) → over.
    it('H1: hoàn THỪA (lệch >3.000đ theo chiều dương) → totalOverCount=1, totalRefundedCount=0 (KHÔNG gộp over vào "đã hoàn đủ")', async () => {
      const { agent, tid } = await makeQuoteReadyTid({ phiBanMilli: 0 }); // phí 0% → required = billAmount.
      const db = getBotDb();
      const room = await db.chatRoom.create({ data: { type: 'GROUP', name: 'phong-test-kpi-refund-thua' } });
      await db.chatRoomTid.create({ data: { roomId: room.id, tidId: tid.id, createdBy: agent.id, createdAt: new Date('2020-01-01T00:00:00.000Z') } });
      const day = new Date(2026, 6, 12, 9, 0, 0);
      const bill = await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agent.id,
          kind: 'IMAGE',
          metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billImageHeightPx: 800, billFields: { tid: { value: tid.tid, uncertain: false } } }),
          createdAt: day
        }
      });
      await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agent.id,
          kind: 'IMAGE',
          replyToMessageId: bill.id,
          metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 1_100_000 }), // thừa 100.000đ.
          createdAt: new Date(day.getTime() + 60_000)
        }
      });
      const { headers } = await linkAgentToRc(agent.id);
      const from = new Date(2026, 6, 1, 0, 0, 0);
      const to = new Date(2026, 7, 1, 0, 0, 0);
      const res = await request(app).get('/v1/me/kpi').set(headers).query({ from: from.toISOString(), to: to.toISOString() });
      expect(res.status).toBe(200);
      expect(res.body.refund.totalOverCount).toBe(1);
      expect(res.body.refund.totalRefundedCount).toBe(0); // over KHÔNG được tính là "đã hoàn đủ".
      expect(res.body.refund.totalPartialCount).toBe(0);
      expect(res.body.refund.totalUnrefundedCount).toBe(0);
      expect(res.body.refund.daily[0].overCount).toBe(1);
      expect(res.body.refund.daily[0].refundedCount).toBe(0);
    });

    // #2 (3/8, LANE B Vòng 2 — bảo mật) — tin "hoàn tiền" do THÀNH VIÊN KHÁC (khách/kẻ gian) trả lời bill
    // gốc, BỊA số "đã hoàn đủ", KHÔNG được tính vào trạng thái hoàn của đại lý (chống tự "xác nhận đã hoàn"
    // cho chính mình). CHỈ confirmation do CHÍNH người gửi bill gốc (senderId===agentId) mới được đếm.
    it('#2: refund reply do THÀNH VIÊN KHÁC (không phải người gửi bill) bịa số → KHÔNG tính, bill vẫn "chưa hoàn"', async () => {
      const { agent, tid } = await makeQuoteReadyTid({ phiBanMilli: 0 });
      const db = getBotDb();
      const impostor = await makeAgent(); // thành viên khác, KHÔNG phải người gửi bill.
      const room = await db.chatRoom.create({ data: { type: 'GROUP', name: 'phong-test-kpi-refund-bia' } });
      await db.chatRoomTid.create({ data: { roomId: room.id, tidId: tid.id, createdBy: agent.id, createdAt: new Date('2020-01-01T00:00:00.000Z') } });
      const day = new Date(2026, 6, 13, 9, 0, 0);
      const bill = await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agent.id,
          kind: 'IMAGE',
          metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billImageHeightPx: 800, billFields: { tid: { value: tid.tid, uncertain: false } } }),
          createdAt: day
        }
      });
      // Kẻ gian (impostor) post ảnh "hoàn tiền" ĐỦ 1.000.000 — nếu tính, bill sẽ thành "hoàn đủ" SAI.
      await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: impostor.id,
          kind: 'IMAGE',
          replyToMessageId: bill.id,
          metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 1_000_000 }),
          createdAt: new Date(day.getTime() + 60_000)
        }
      });
      const { headers } = await linkAgentToRc(agent.id);
      const from = new Date(2026, 6, 1, 0, 0, 0);
      const to = new Date(2026, 7, 1, 0, 0, 0);
      const res = await request(app).get('/v1/me/kpi').set(headers).query({ from: from.toISOString(), to: to.toISOString() });
      expect(res.status).toBe(200);
      expect(res.body.refund.totalRefundedCount).toBe(0); // KHÔNG thành "hoàn đủ" nhờ số bịa của kẻ khác.
      expect(res.body.refund.totalUnrefundedCount).toBe(1);
      expect(res.body.refund.totalRefundedAmount).toBe(0);
    });

    // ── 2a (4/8, Admin Demo chốt) — KHỬ TRÙNG KPI hoàn tiền theo `transferCode`. Đại lý bỏ qua cảnh báo "đã hoàn
    // trước đó" (refund-dedup.ts) và gửi 2 ảnh hoàn tiền CÙNG 1 mã chuyển tiền (napas/FT — CÙNG 1 giao dịch bị
    // ghi 2 lần) cho CÙNG 1 bill → KPI trước đây cộng ĐÔI → đẩy bill thành "Hoàn thừa" GIẢ (rủi ro tài chính
    // báo động ảo). Sau fix: mỗi mã CK chỉ tính 1 lần cho 1 bill. GIỮ hành vi cũ cho khoản KHÔNG có mã CK.
    describe('2a — khử trùng hoàn tiền theo transferCode', () => {
      /** Seed 1 bill (phí 0% → required = billAmount) trong 1 phòng "chính thức" (đã gắn TID active từ quá
       * khứ). Trả về { agent, headers, billId, day, from, to } để mỗi test tự gắn các reply hoàn tiền. */
      async function seedBillPhi0(billAmount: number, dayLocal: Date) {
        const { agent, tid } = await makeQuoteReadyTid({ phiBanMilli: 0 });
        const db = getBotDb();
        const room = await db.chatRoom.create({ data: { type: 'GROUP', name: `phong-2a-${Date.now()}-${Math.random()}` } });
        await db.chatRoomTid.create({ data: { roomId: room.id, tidId: tid.id, createdBy: agent.id, createdAt: new Date('2020-01-01T00:00:00.000Z') } });
        const bill = await db.chatMessage.create({
          data: {
            roomId: room.id,
            senderId: agent.id,
            kind: 'IMAGE',
            metadataJson: JSON.stringify({ isBillImage: true, billAmount, billImageHeightPx: 800, billFields: { tid: { value: tid.tid, uncertain: false } } }),
            createdAt: dayLocal
          }
        });
        const { headers } = await linkAgentToRc(agent.id);
        return { agent, roomId: room.id, billId: bill.id, headers, day: dayLocal, from: new Date(2026, 6, 1, 0, 0, 0), to: new Date(2026, 7, 1, 0, 0, 0) };
      }
      async function addRefundReply(roomId: string, agentId: number, billId: string, refundAmount: number, transferCode: string | null, at: Date) {
        const db = getBotDb();
        const meta: Record<string, unknown> = { isRefundImage: true, refundAmount };
        if (transferCode !== null) meta.refundDedup = { transferCode, recipientAccount: '0123456789', dateTime: '2026-07-10 09:00', amount: refundAmount };
        await db.chatMessage.create({
          data: { roomId, senderId: agentId, kind: 'IMAGE', replyToMessageId: billId, metadataJson: JSON.stringify(meta), createdAt: at }
        });
      }

      it('CÙNG mã CK gửi 2 lần cho 1 bill → chỉ cộng 1 lần (matched, KHÔNG thành "Hoàn thừa" do cộng đôi)', async () => {
        // Bill 1.000.000đ phí 0% → required=1.000.000. Hoàn ĐỦ 1.000.000 nhưng đại lý lỡ gửi 2 lần CÙNG mã "FT-24H-777".
        // Trước fix: confirmed = 2.000.000 → over → totalOverCount=1. Sau fix: khử trùng → confirmed=1.000.000 → matched.
        const s = await seedBillPhi0(1_000_000, new Date(2026, 6, 14, 9, 0, 0));
        await addRefundReply(s.roomId, s.agent.id, s.billId, 1_000_000, 'FT-24H-777', new Date(s.day.getTime() + 60_000));
        await addRefundReply(s.roomId, s.agent.id, s.billId, 1_000_000, 'ft24h777', new Date(s.day.getTime() + 120_000)); // CÙNG mã (chuẩn hoá bỏ dấu/hoa-thường) → trùng.
        const res = await request(app).get('/v1/me/kpi').set(s.headers).query({ from: s.from.toISOString(), to: s.to.toISOString() });
        expect(res.status).toBe(200);
        expect(res.body.refund.totalRefundedCount).toBe(1); // matched — hoàn đủ ĐÚNG 1 lần.
        expect(res.body.refund.totalOverCount).toBe(0); // KHÔNG bị cộng đôi thành "Hoàn thừa".
        expect(res.body.refund.totalRefundedAmount).toBe(1_000_000); // KHÔNG phải 2.000.000.
      });

      it('mã CK KHÁC nhau (2 giao dịch chuyển khoản THẬT khác nhau) → CỘNG ĐỦ cả hai (hoàn nhiều lần hợp lệ, KHÔNG khử nhầm)', async () => {
        // Bill 1.000.000đ, hoàn làm 2 lần 500.000 + 500.000, MỖI lần mã CK khác → cumulative hợp lệ → confirmed=1.000.000 → matched.
        const s = await seedBillPhi0(1_000_000, new Date(2026, 6, 15, 9, 0, 0));
        await addRefundReply(s.roomId, s.agent.id, s.billId, 500_000, 'FT-AAA-111', new Date(s.day.getTime() + 60_000));
        await addRefundReply(s.roomId, s.agent.id, s.billId, 500_000, 'FT-BBB-222', new Date(s.day.getTime() + 120_000));
        const res = await request(app).get('/v1/me/kpi').set(s.headers).query({ from: s.from.toISOString(), to: s.to.toISOString() });
        expect(res.status).toBe(200);
        expect(res.body.refund.totalRefundedAmount).toBe(1_000_000); // cả 2 lần đều tính.
        expect(res.body.refund.totalRefundedCount).toBe(1); // matched.
        expect(res.body.refund.totalPartialCount).toBe(0);
      });

      it('khoản KHÔNG có mã CK (OCR không đọc được) → GIỮ hành vi cũ: cộng đủ, KHÔNG khử trùng', async () => {
        // 2 reply KHÔNG có refundDedup → không đủ dữ liệu khẳng định trùng → cộng đủ (500k+500k=1.000.000) → matched.
        const s = await seedBillPhi0(1_000_000, new Date(2026, 6, 16, 9, 0, 0));
        await addRefundReply(s.roomId, s.agent.id, s.billId, 500_000, null, new Date(s.day.getTime() + 60_000));
        await addRefundReply(s.roomId, s.agent.id, s.billId, 500_000, null, new Date(s.day.getTime() + 120_000));
        const res = await request(app).get('/v1/me/kpi').set(s.headers).query({ from: s.from.toISOString(), to: s.to.toISOString() });
        expect(res.status).toBe(200);
        expect(res.body.refund.totalRefundedAmount).toBe(1_000_000); // KHÔNG bị khử — giữ nguyên tổng cũ.
        expect(res.body.refund.totalRefundedCount).toBe(1);
      });
    });

    it('đại lý chưa gửi bill nào trong khoảng → refund rỗng (KHÔNG lỗi)', async () => {
      const { agent } = await makeQuoteReadyTid();
      const { headers } = await linkAgentToRc(agent.id);
      const res = await request(app)
        .get('/v1/me/kpi')
        .set(headers)
        .query({ from: '2020-01-01T00:00:00.000Z', to: '2020-01-02T00:00:00.000Z' });
      expect(res.status).toBe(200);
      expect(res.body.refund).toEqual({
        totalBillCount: 0,
        totalRefundedCount: 0,
        totalOverCount: 0,
        totalPartialCount: 0,
        totalUnrefundedCount: 0,
        totalRequiredAmount: 0,
        totalRefundedAmount: 0,
        daily: []
      });
    });

    // SIGMA (3/8, Admin Demo nhấn mạnh trực tiếp — "1 đại lý CHỈ xem chat/doanh số CỦA CHÍNH MÌNH, TUYỆT ĐỐI
    // KHÔNG xem được dữ liệu đại lý khác") — CHỨNG MINH BẰNG TEST CỤ THỂ: seed 2 đại lý A/B khác nhau, MỖI
    // người có bill+hoàn tiền RIÊNG (CÙNG khoảng thời gian, CÙNG phòng chat — cố tình seed sát nhau nhất có
    // thể để loại trừ khả năng "vô tình đúng" chỉ vì lọc theo from/to hay theo phòng). Gọi API là đại lý A →
    // response TUYỆT ĐỐI KHÔNG được chứa bất kỳ số liệu nào của đại lý B (totalBillCount/totalRequiredAmount/
    // totalRefundedAmount CHỈ tính đúng phần của A, KHÔNG cộng dồn nhầm cả B).
    it('CÁCH LY đại lý: gọi API là đại lý A → response CHỈ chứa bill/hoàn tiền của A, KHÔNG lộ bất kỳ số liệu nào của đại lý B (dù B có bill trong CÙNG phòng, CÙNG ngày)', async () => {
      const db = getBotDb();
      const room = await db.chatRoom.create({ data: { type: 'GROUP', name: 'phong-test-kpi-cach-ly-dai-ly' } });
      const day = new Date(2026, 6, 20, 9, 0, 0);

      // Đại lý A — bill 1.000.000đ, phí 0% (fixture tối giản, KHÔNG cần TID/FeeSellQuote — previewSellFeeForTid
      // tự fallback 0% khi KHÔNG tìm thấy TID khớp agentId, ĐÚNG hành vi thật khi bill không gắn TID nào).
      const agentA = await makeAgent();
      // SIGMA (3/8) — phòng "chính thức với SigMa" (xem comment test trên) — gắn 1 TID bất kỳ (không quan
      // trọng CỦA AI, roomLinkCoverageChecker() chỉ cần phòng có TID active, không đối chiếu chủ sở hữu) TRƯỚC
      // MỐC THỜI GIAN sớm nhất trong test này.
      const linkTid = await makeTid({ agentId: agentA.id });
      await db.chatRoomTid.create({ data: { roomId: room.id, tidId: linkTid.id, createdBy: agentA.id, createdAt: new Date(day.getTime() - 3_600_000) } });
      const billA = await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agentA.id,
          kind: 'IMAGE',
          metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billImageHeightPx: 800, billFields: { tid: null } }),
          createdAt: day
        }
      });
      await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agentA.id,
          kind: 'IMAGE',
          replyToMessageId: billA.id,
          metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 1_000_000 }),
          createdAt: new Date(day.getTime() + 60_000)
        }
      });

      // Đại lý B — bill RIÊNG, số tiền RẤT LỚN + KHÁC HẲN (99.000.000đ) để bất kỳ rò rỉ cộng dồn nhầm nào cũng
      // lộ rõ ngay qua assert số — CÙNG phòng, CÙNG ngày với A (cố tình, loại trừ khả năng "cách ly nhờ khác
      // phòng/khác ngày" thay vì cách ly ĐÚNG theo agentId).
      const agentB = await makeAgent();
      const billB = await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agentB.id,
          kind: 'IMAGE',
          metadataJson: JSON.stringify({ isBillImage: true, billAmount: 99_000_000, billImageHeightPx: 800, billFields: { tid: null } }),
          createdAt: new Date(day.getTime() + 30_000)
        }
      });
      await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agentB.id,
          kind: 'IMAGE',
          replyToMessageId: billB.id,
          metadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 99_000_000 }),
          createdAt: new Date(day.getTime() + 90_000)
        }
      });

      const from = new Date(2026, 6, 1, 0, 0, 0);
      const to = new Date(2026, 7, 1, 0, 0, 0);

      // Gọi là đại lý A.
      const { headers: headersA } = await linkAgentToRc(agentA.id);
      const resA = await request(app).get('/v1/me/kpi').set(headersA).query({ from: from.toISOString(), to: to.toISOString() });
      expect(resA.status).toBe(200);
      expect(resA.body.agentId).toBe(agentA.id);
      // CHỈ 1 bill (của A) — KHÔNG cộng dồn 2 (nếu lộ, totalBillCount sẽ ra 2 thay vì 1).
      expect(resA.body.refund.totalBillCount).toBe(1);
      expect(resA.body.refund.totalRequiredAmount).toBe(1_000_000);
      expect(resA.body.refund.totalRefundedAmount).toBe(1_000_000);
      // Số tiền RẤT LỚN của B (99tr) TUYỆT ĐỐI không xuất hiện trong tổng của A.
      expect(resA.body.refund.totalRequiredAmount).not.toBe(99_000_000);
      expect(resA.body.refund.totalRequiredAmount).not.toBe(100_000_000);
      const bodyStrA = JSON.stringify(resA.body);
      expect(bodyStrA).not.toContain('99000000'); // chuỗi số tiền của B KHÔNG xuất hiện Ở BẤT KỲ ĐÂU trong response.

      // Đối chiếu ngược lại — gọi là đại lý B PHẢI CHỈ thấy CỦA B, KHÔNG thấy 1.000.000đ của A.
      const { headers: headersB } = await linkAgentToRc(agentB.id);
      const resB = await request(app).get('/v1/me/kpi').set(headersB).query({ from: from.toISOString(), to: to.toISOString() });
      expect(resB.status).toBe(200);
      expect(resB.body.refund.totalBillCount).toBe(1);
      expect(resB.body.refund.totalRequiredAmount).toBe(99_000_000);
      const bodyStrB = JSON.stringify(resB.body);
      expect(bodyStrB).not.toContain('"totalRequiredAmount":1000000'); // KHÔNG lẫn số của A.
    });

    // SIGMA (3/8, Admin Demo chốt sau khi hỏi kỹ) — "phòng nào tính CHÍNH THỨC với SigMa" — CHỨNG MINH bill
    // gửi trong phòng CHƯA TỪNG có TID nào gắn ("chat riêng tư"/nhóm không liên quan nghiệp vụ SigMa) KHÔNG
    // được gộp vào báo cáo Doanh số/Hoàn tiền, dù vẫn là bill hợp lệ (isBillImage:true) của CHÍNH đại lý đang
    // gọi trong đúng khoảng thời gian.
    it('bill gửi trong phòng CHƯA TỪNG gắn TID nào ("không chính thức với SigMa") → KHÔNG tính vào báo cáo', async () => {
      const db = getBotDb();
      const agent = await makeAgent();
      const unlinkedRoom = await db.chatRoom.create({ data: { type: 'GROUP', name: 'phong-khong-lien-ket-tid' } }); // KHÔNG gắn TID nào.
      const day = new Date(2026, 6, 25, 9, 0, 0);
      await db.chatMessage.create({
        data: {
          roomId: unlinkedRoom.id,
          senderId: agent.id,
          kind: 'IMAGE',
          metadataJson: JSON.stringify({ isBillImage: true, billAmount: 5_000_000, billImageHeightPx: 800, billFields: { tid: null } }),
          createdAt: day
        }
      });
      const { headers } = await linkAgentToRc(agent.id);
      const from = new Date(2026, 6, 1, 0, 0, 0);
      const to = new Date(2026, 7, 1, 0, 0, 0);
      const res = await request(app).get('/v1/me/kpi').set(headers).query({ from: from.toISOString(), to: to.toISOString() });
      expect(res.status).toBe(200);
      expect(res.body.refund.totalBillCount).toBe(0);
      expect(res.body.refund.totalRequiredAmount).toBe(0);
    });

    it('bill gửi TRƯỚC khi TID được gắn vào phòng (ngoài giai đoạn gắn) → KHÔNG tính; bill gửi SAU khi gắn → CÓ tính (đúng biên giai đoạn)', async () => {
      const db = getBotDb();
      const agent = await makeAgent();
      const tid = await makeTid({ agentId: agent.id });
      const room = await db.chatRoom.create({ data: { type: 'GROUP', name: 'phong-test-bien-giai-doan-gan' } });
      const linkedAt = new Date(2026, 6, 26, 10, 0, 0);
      await db.chatRoomTid.create({ data: { roomId: room.id, tidId: tid.id, createdBy: agent.id, createdAt: linkedAt } });

      const billBeforeLink = await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agent.id,
          kind: 'IMAGE',
          metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1_111_000, billImageHeightPx: 800, billFields: { tid: null } }),
          createdAt: new Date(linkedAt.getTime() - 60_000) // TRƯỚC khi gắn 1 phút.
        }
      });
      void billBeforeLink;
      await db.chatMessage.create({
        data: {
          roomId: room.id,
          senderId: agent.id,
          kind: 'IMAGE',
          metadataJson: JSON.stringify({ isBillImage: true, billAmount: 2_222_000, billImageHeightPx: 800, billFields: { tid: null } }),
          createdAt: new Date(linkedAt.getTime() + 60_000) // SAU khi gắn 1 phút.
        }
      });

      const { headers } = await linkAgentToRc(agent.id);
      const from = new Date(2026, 6, 1, 0, 0, 0);
      const to = new Date(2026, 7, 1, 0, 0, 0);
      const res = await request(app).get('/v1/me/kpi').set(headers).query({ from: from.toISOString(), to: to.toISOString() });
      expect(res.status).toBe(200);
      // CHỈ bill SAU khi gắn được tính — bill TRƯỚC khi gắn bị loại (KHÔNG phải 2, KHÔNG phải tổng 3.333.000).
      expect(res.body.refund.totalBillCount).toBe(1);
      expect(res.body.refund.totalRequiredAmount).toBe(2_222_000);
    });
  });
});
