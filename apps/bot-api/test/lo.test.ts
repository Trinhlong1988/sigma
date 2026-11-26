// SIGMA (22/7) — createLo (tạo lô) + reconcileLo (đối soát Rule A-G + tam giác + trùng số lô) + cancelLo +
// getRecentLoNumbers (lo-service.ts). Test THẬT trên throwaway Postgres (global-setup.ts).
//
// BOLA fix (20/8): route Bearer cũ (POST /v1/agents/:agentCode/lo, POST /v1/lo/:loId/reconcile|cancel, GET
// /v1/agents/:agentCode/lo/next-number) ĐÃ GỠ — khóa tĩnh dùng-chung cho phép thao tác Lô của MỌI đại lý qua
// URL, KHÔNG kiểm sở hữu. Test này nay gọi THẲNG hàm service (business logic Rule A-G sống ở đây) — bề mặt LIVE
// có kiểm sở hữu là /v1/me/lo/:loId/reconcile (routes/me.ts), đã có test HTTP + ownership ở me-lo.test.ts.
import { beforeAll, describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { cancelLo, createLo, getRecentLoNumbers, reconcileLo, type ReconcileBody } from '../src/lo-service.js';
import { quoteRows, type QuoteRowInput } from '../src/fee-quote.js';
import { makeAgent, makeAgentGroupCustomer, makeBank, makeBankFraudRule, makeCardType, makeFeeSellQuote, makeFeeType, makePartner, makeQuoteReadyTid, makeTid, makeTidSellFee } from './fixtures.js';

async function createLoOk(agentId: number, rows: QuoteRowInput[]) {
  const r = await createLo(getBotDb(), agentId, rows);
  if (!r.ok) throw new Error(`createLo bất ngờ thất bại: ${r.error} — ${r.message}`);
  return r.data;
}
async function reconcileOk(loId: number, body: ReconcileBody) {
  const r = await reconcileLo(getBotDb(), loId, body);
  if (!r.ok) throw new Error(`reconcile bất ngờ thất bại: ${r.error} — ${r.message}`);
  return r.data;
}

describe('createLo — tạo lô, KHỚP CHÍNH XÁC quoteRows (không tính lại lệch)', () => {
  beforeAll(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('1 dòng → amountAfterFee khớp HỆT quoteRows cho CÙNG input (regression chống lệch công thức)', async () => {
    const { agent, tid, cardType, feeType } = await makeQuoteReadyTid({ phiBanMilli: 2000 }); // 2%
    const amountBeforeFee = 5_000_000;
    const rows = [{ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee }];

    const q = await quoteRows(getBotDb(), agent.id, rows);
    expect(q.ok).toBe(true);
    if (!q.ok) return;

    const lo = await createLoOk(agent.id, rows);
    expect(lo.status).toBe('PENDING');
    expect(lo.rows).toHaveLength(1);
    expect(lo.rows[0].amountAfterFee).toBe(String(q.data[0].amountAfterFee));
    expect(lo.expectedTotalAmount).toBe(String(q.data[0].amountAfterFee));
  });

  it('nhiều dòng → expectedTotalAmount = TỔNG amountAfterFee từng dòng (khớp quoteRows độc lập từng dòng)', async () => {
    const { agent, tid, cardType, feeType } = await makeQuoteReadyTid({ phiBanMilli: 1000 }); // 1%
    const rows = [
      { tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee: 2_000_000 },
      { tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee: 3_000_000 }
    ];
    const q = await quoteRows(getBotDb(), agent.id, rows);
    expect(q.ok).toBe(true);
    if (!q.ok) return;
    const expectedSum = q.data.reduce((s, r) => s + r.amountAfterFee, 0);

    const lo = await createLoOk(agent.id, rows);
    expect(lo.expectedTotalAmount).toBe(String(expectedSum));
    expect(lo.rows).toHaveLength(2);
  });

  it('dòng lỗi (tid không tồn tại) → NOT_FOUND, KHÔNG tạo Lo (ABORT toàn phiếu, khớp quy ước quote)', async () => {
    const { agent } = await makeQuoteReadyTid();
    const r = await createLo(getBotDb(), agent.id, [{ tidId: 999_999_999, amountBeforeFee: 1_000_000 }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NOT_FOUND');
  });

  // (d) Admin Demo 20/8: TID khớp đại lý + CHỈ có niêm yết (CHƯA override giá bán thực tế) → createLo BỊ CHẶN với
  // NO_ACTUAL_SELL_FEE (Lô thật KHÔNG được tạo cho tới khi set giá bán thực tế) — KHÔNG mượn % niêm yết.
  it('TID chỉ có niêm yết (chưa override giá bán thực tế) → createLo NO_ACTUAL_SELL_FEE (KHÔNG tạo Lô)', async () => {
    const bank = await makeBank();
    const partner = await makePartner();
    const cardType = await makeCardType(bank.id);
    const feeType = await makeFeeType();
    const agent = await makeAgent();
    const { customer } = await makeAgentGroupCustomer(agent.id);
    const tid = await makeTid({ agentId: agent.id, customerId: customer.id, partnerId: partner.id, bankId: bank.id });
    // CHỈ niêm yết, CỐ Ý KHÔNG override giá bán thực tế.
    await makeFeeSellQuote({ partnerId: partner.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 2000, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') });

    const r = await createLo(getBotDb(), agent.id, [{ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee: 5_000_000 }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NO_ACTUAL_SELL_FEE');
  });
});

describe('reconcileLo — Rule A-E + tam giác đối soát + trùng số lô', () => {
  beforeAll(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  async function createPendingLo(amountBeforeFee: number, phiBanMilli = 0) {
    const setup = await makeQuoteReadyTid({ phiBanMilli });
    const lo = await createLoOk(setup.agent.id, [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee }]);
    return { ...setup, lo };
  }

  it('khớp TUYỆT ĐỐI (summary = tổng bill lẻ = expectedTotal, không rule nào vi phạm) → CONFIRMED + eligible', async () => {
    const { lo } = await createPendingLo(10_000_001, 0); // phí 0% → amountAfterFee = 10.000.001 (KHÔNG tròn)
    const expected = Number(lo.expectedTotalAmount);

    const data = await reconcileOk(lo.id, {
      summaryOcr: { amount: expected, receiptNumber: 101, bankReportedLoNumber: 501 },
      individualBills: [{ amount: expected, receiptNumber: 100, cardLast4: '1234', swipeAt: new Date().toISOString() }]
    });
    expect(data.status).toBe('CONFIRMED');
    expect(data.eligibleForTransactionCreation).toBe(true);
    expect(data.triangulation.blame).toBe('NONE');
    expect(data.violations).toEqual([]);
  });

  // BOT-5 (audit 21/8) — reconcileLo trước đây chỉ kiểm Number.isFinite → nhận số ÂM/thập phân. Kẻ gian gửi
  // individualBills[].amount âm để ép tam giác đối soát khớp giả (tổng bill lẻ = expected một cách gian lận).
  // Nay dùng CHUNG isValidAmount (số nguyên ≥ 0) với createLo → REJECT thẳng ở tầng validate (KHÔNG chạy Rule/persist).
  it('individualBills có amount ÂM → VALIDATION (từ chối, KHÔNG đối soát/persist bill)', async () => {
    const { lo } = await createPendingLo(6_000_000, 0);
    const expected = Number(lo.expectedTotalAmount);
    const r = await reconcileLo(getBotDb(), lo.id, {
      summaryOcr: { amount: expected },
      // 1 bill dương + 1 bill ÂM cùng tổng = expected: nếu lọt sẽ khớp tam giác gian lận.
      individualBills: [
        { amount: expected + 1_000_000, cardLast4: '1234', swipeAt: new Date().toISOString() },
        { amount: -1_000_000, cardLast4: '4321', swipeAt: new Date().toISOString() }
      ]
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('VALIDATION');
    // KHÔNG được persist bill nào (validate chặn TRƯỚC createMany) + lô GIỮ nguyên PENDING.
    const billCount = await getBotDb().loBill.count({ where: { loId: lo.id } });
    expect(billCount).toBe(0);
    const after = await getBotDb().lo.findUnique({ where: { id: lo.id }, select: { status: true } });
    expect(after?.status).toBe('PENDING');
  });

  it('individualBills có amount THẬP PHÂN → VALIDATION (khớp isValidAmount số nguyên như createLo)', async () => {
    const { lo } = await createPendingLo(5_000_000, 0);
    const expected = Number(lo.expectedTotalAmount);
    const r = await reconcileLo(getBotDb(), lo.id, {
      summaryOcr: { amount: expected },
      individualBills: [{ amount: expected - 0.5, cardLast4: '1212', swipeAt: new Date().toISOString() }]
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('VALIDATION');
  });

  it('summaryOcr.amount ÂM → VALIDATION', async () => {
    const { lo } = await createPendingLo(4_000_000, 0);
    const expected = Number(lo.expectedTotalAmount);
    const r = await reconcileLo(getBotDb(), lo.id, {
      summaryOcr: { amount: -expected },
      individualBills: [{ amount: expected, cardLast4: '3434', swipeAt: new Date().toISOString() }]
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('VALIDATION');
  });

  it('summary lệch 1 VND so với expected (tổng bill lẻ vẫn khớp) → MISMATCH, lý do rõ ràng (SUMMARY)', async () => {
    const { lo } = await createPendingLo(8_000_002, 0);
    const expected = Number(lo.expectedTotalAmount);

    const data = await reconcileOk(lo.id, {
      summaryOcr: { amount: expected - 1, bankReportedLoNumber: 601 }, // LỆCH 1 đồng
      individualBills: [{ amount: expected, cardLast4: '4321', swipeAt: new Date().toISOString() }]
    });
    expect(data.status).toBe('MISMATCH');
    expect(data.eligibleForTransactionCreation).toBe(false);
    expect(data.triangulation.blame).toBe('SUMMARY');
    expect(data.triangulation.message).toMatch(/LỆCH/);
  });

  it('rule-A vi phạm trên 1 bill lẻ → MISMATCH DÙ tổng khớp (không để tổng sạch che vi phạm rule)', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    await makeBankFraudRule({ bankId: setup.bank.id, maxAmountPerSwipe: 5_000_000 });
    const amountBeforeFee = 5_000_003; // amountAfterFee = 5.000.003 (phí 0%) → CHẠM/VƯỢT max 5.000.000
    const lo = await createLoOk(setup.agent.id, [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee }]);
    const expected = Number(lo.expectedTotalAmount);
    expect(expected).toBeGreaterThanOrEqual(5_000_000);

    const data = await reconcileOk(lo.id, {
      summaryOcr: { amount: expected }, // tổng KHỚP hoàn toàn
      individualBills: [{ amount: expected, cardLast4: '9999', swipeAt: new Date().toISOString() }] // tổng bill lẻ CŨNG khớp
    });
    expect(data.triangulation.blame).toBe('NONE'); // tổng KHÔNG lệch...
    expect(data.status).toBe('MISMATCH'); // ...nhưng vẫn MISMATCH vì Rule A vi phạm
    expect(data.violations.some((v) => v.rule === 'A_MAX_AMOUNT')).toBe(true);
  });

  it('trùng bankReportedLoNumber CÙNG TID (2 lô khác nhau, cùng đại lý) → flagged (cảnh báo, KHÔNG chặn CONFIRMED)', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    // Lô 1 (TID X): reconcile với số lô 777.
    const lo1 = await createLoOk(setup.agent.id, [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 1_000_003 }]);
    await reconcileOk(lo1.id, {
      summaryOcr: { amount: Number(lo1.expectedTotalAmount), bankReportedLoNumber: 777 },
      individualBills: [{ amount: Number(lo1.expectedTotalAmount), cardLast4: '1111', swipeAt: new Date().toISOString() }]
    });

    // Lô 2 (CÙNG TID X): reconcile với CÙNG số lô 777 → phải bị flag trùng.
    const lo2 = await createLoOk(setup.agent.id, [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 2_000_005 }]);
    const data = await reconcileOk(lo2.id, {
      summaryOcr: { amount: Number(lo2.expectedTotalAmount), bankReportedLoNumber: 777 },
      individualBills: [{ amount: Number(lo2.expectedTotalAmount), cardLast4: '2222', swipeAt: new Date().toISOString() }]
    });
    expect(data.loNumberReuse.violated).toBe(true);
    expect(data.loNumberReuse.message).toMatch(/ĐÃ từng/);
  });

  it('trùng bankReportedLoNumber CÙNG đại lý NHƯNG KHÁC TID → KHÔNG flagged (mỗi TID có bộ đếm kết toán độc lập ở NH)', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    // NGỮ NGHĨA MỚI (20/8): createLo→quoteRow xác định "TID thuộc đại lý" qua chuỗi nhóm chat (customerId). Gắn
    // tid2 vào CHÍNH khách của setup để tid2 nằm trong "tầm nhìn" của setup.agent — nếu không, createLo cho tid2
    // sẽ bị TID_NOT_IN_AGENT_SCOPE.
    const tid2 = await makeTid({ agentId: setup.agent.id, customerId: setup.customer.id, partnerId: setup.partner.id, bankId: setup.bank.id });
    await makeTidSellFee({ tidId: tid2.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, phiBanMilli: 0 });

    // Lô 1 (TID 1): reconcile với số lô 888.
    const lo1 = await createLoOk(setup.agent.id, [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 1_000_007 }]);
    await reconcileOk(lo1.id, {
      summaryOcr: { amount: Number(lo1.expectedTotalAmount), bankReportedLoNumber: 888 },
      individualBills: [{ amount: Number(lo1.expectedTotalAmount), cardLast4: '3131', swipeAt: new Date().toISOString() }]
    });

    // Lô 2 (TID 2 — KHÁC TID, CÙNG đại lý): reconcile với CÙNG số lô 888 → KHÔNG được flag.
    const lo2 = await createLoOk(setup.agent.id, [{ tidId: tid2.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 2_000_009 }]);
    const data = await reconcileOk(lo2.id, {
      summaryOcr: { amount: Number(lo2.expectedTotalAmount), bankReportedLoNumber: 888 },
      individualBills: [{ amount: Number(lo2.expectedTotalAmount), cardLast4: '4242', swipeAt: new Date().toISOString() }]
    });
    expect(data.loNumberReuse.violated).toBe(false);
    expect(data.loNumberReuse.message).toMatch(/chưa từng/);
  });

  it('AuditLog THẬT được ghi cho vi phạm rule-A (query trực tiếp DB, không chỉ tin kết quả trả về)', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    await makeBankFraudRule({ bankId: setup.bank.id, maxAmountPerSwipe: 1_000_000 });
    const lo = await createLoOk(setup.agent.id, [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 1_500_000 }]);
    const expected = Number(lo.expectedTotalAmount);

    await reconcileOk(lo.id, { summaryOcr: { amount: expected }, individualBills: [{ amount: expected, cardLast4: '5555', swipeAt: new Date().toISOString() }] });

    const db = getBotDb();
    const rows = await db.auditLog.findMany({ where: { targetType: 'Lo', targetId: String(lo.id), action: 'SIGMA_LO_RULE_VIOLATION' } });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].afterJson).toMatch(/A_MAX_AMOUNT/);
  });

  it('AuditLog THẬT được ghi khi CONFIRMED (SIGMA_LO_CONFIRMED)', async () => {
    const { lo } = await createPendingLo(3_000_001, 0);
    const expected = Number(lo.expectedTotalAmount);
    await reconcileOk(lo.id, { summaryOcr: { amount: expected }, individualBills: [{ amount: expected, cardLast4: '6666', swipeAt: new Date().toISOString() }] });

    const db = getBotDb();
    const rows = await db.auditLog.findMany({ where: { targetType: 'Lo', targetId: String(lo.id), action: 'SIGMA_LO_CONFIRMED' } });
    expect(rows.length).toBe(1);
  });

  it('loId không tồn tại → NOT_FOUND', async () => {
    const r = await reconcileLo(getBotDb(), 999_999_999, { summaryOcr: { amount: 1000 }, individualBills: [] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NOT_FOUND');
  });

  it('Rule F: tổng tiền quẹt/ngày CÙNG TID vượt maxDailyTotalPerTid → violation + MISMATCH', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    await makeBankFraudRule({ bankId: setup.bank.id, maxDailyTotalPerTid: 10_000_000 });
    const lo = await createLoOk(setup.agent.id, [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 1_000_000 }]);
    const swipeAt = new Date().toISOString();

    const data = await reconcileOk(lo.id, {
      summaryOcr: { amount: 12_000_000 },
      individualBills: [
        { amount: 6_000_000, cardLast4: '1111', swipeAt }, // 2 thẻ KHÁC nhau, CÙNG TID → cô lập khỏi Rule B/D/E (theo thẻ)
        { amount: 6_000_000, cardLast4: '2222', swipeAt }
      ]
    });
    expect(data.violations.some((v) => v.rule === 'F_DAILY_TOTAL_PER_TID' && v.tidId === setup.tid.id)).toBe(true);
    expect(data.status).toBe('MISMATCH');
  });

  it('Rule F: maxDailyTotalPerTid = null (không cấu hình) → không vi phạm dù tổng lớn', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const lo = await createLoOk(setup.agent.id, [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 1_000_000 }]);
    const swipeAt = new Date().toISOString();

    const data = await reconcileOk(lo.id, {
      summaryOcr: { amount: 50_000_000 },
      individualBills: [
        { amount: 25_000_000, cardLast4: '3333', swipeAt },
        { amount: 25_000_000, cardLast4: '4444', swipeAt }
      ]
    });
    expect(data.violations.some((v) => v.rule === 'F_DAILY_TOTAL_PER_TID')).toBe(false);
  });

  it('cardLast4 gửi SỐ THẺ ĐẦY ĐỦ (không phải ≤4 số) → VALIDATION (PCI-DSS, từ chối không âm thầm cắt)', async () => {
    const { lo } = await createPendingLo(1_000_000, 0);
    const expected = Number(lo.expectedTotalAmount);
    const r = await reconcileLo(getBotDb(), lo.id, {
      summaryOcr: { amount: expected },
      individualBills: [{ amount: expected, cardLast4: '4111111111111234', swipeAt: new Date().toISOString() }]
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('VALIDATION');
  });
});

describe('reconcileLo — Rule G: CẢNH BÁO thứ tự/nhảy cóc/trùng số hóa đơn + số lô (KHÔNG chặn)', () => {
  beforeAll(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  async function newPendingLo(setup: Awaited<ReturnType<typeof makeQuoteReadyTid>>, amountBeforeFee: number, tidId?: number) {
    return createLoOk(setup.agent.id, [{ tidId: tidId ?? setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee }]);
  }

  it('thứ tự ĐÚNG (giờ tăng → số tăng liên tục), tổng khớp → CONFIRMED + KHÔNG cảnh báo thứ tự', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const lo = await newPendingLo(setup, 5_000_000);
    const data = await reconcileOk(lo.id, {
      summaryOcr: { amount: 5_000_000, bankReportedLoNumber: 10 },
      individualBills: [
        { amount: 2_000_000, receiptNumber: 100, cardLast4: '1111', swipeAt: '2026-08-12T09:00:00' },
        { amount: 3_000_000, receiptNumber: 101, cardLast4: '2222', swipeAt: '2026-08-12T10:00:00' }
      ]
    });
    expect(data.status).toBe('CONFIRMED');
    expect(data.sequenceWarnings).toEqual([]);
  });

  it('NHẢY CÓC số hóa đơn (100 → 102) cùng ngày → RECEIPT_GAP "gửi thiếu bill", VẪN CONFIRMED (không chặn)', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const lo = await newPendingLo(setup, 5_000_000);
    const data = await reconcileOk(lo.id, {
      summaryOcr: { amount: 5_000_000 },
      individualBills: [
        { amount: 2_000_000, receiptNumber: 100, cardLast4: '1111', swipeAt: '2026-08-12T09:00:00' },
        { amount: 3_000_000, receiptNumber: 102, cardLast4: '2222', swipeAt: '2026-08-12T10:00:00' }
      ]
    });
    expect(data.status).toBe('CONFIRMED'); // cảnh báo KHÔNG chặn CONFIRMED
    const kinds = data.sequenceWarnings.map((w) => w.kind);
    expect(kinds).toContain('RECEIPT_GAP');
    expect(data.sequenceWarnings.find((w) => w.kind === 'RECEIPT_GAP')!.message).toMatch(/THIẾU bill/);
  });

  it('NGHỊCH thứ tự giờ-số cùng ngày (giờ muộn số nhỏ) → RECEIPT_INVERSION "kiểm tra lại"', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const lo = await newPendingLo(setup, 5_000_000);
    const data = await reconcileOk(lo.id, {
      summaryOcr: { amount: 5_000_000 },
      individualBills: [
        { amount: 2_000_000, receiptNumber: 105, cardLast4: '1111', swipeAt: '2026-08-12T09:00:00' },
        { amount: 3_000_000, receiptNumber: 101, cardLast4: '2222', swipeAt: '2026-08-12T10:00:00' }
      ]
    });
    const w = data.sequenceWarnings.find((x) => x.kind === 'RECEIPT_INVERSION');
    expect(w).toBeTruthy();
    expect(w!.message).toMatch(/Kiểm tra lại/);
  });

  it('RESET đầu ngày (500 tối nay → 1 sáng mai) → RECEIPT_RESET "kiểm tra lại" (KHÔNG im lặng bỏ qua)', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const lo = await newPendingLo(setup, 5_000_000);
    const data = await reconcileOk(lo.id, {
      summaryOcr: { amount: 5_000_000 },
      individualBills: [
        { amount: 2_000_000, receiptNumber: 500, cardLast4: '1111', swipeAt: '2026-08-12T23:00:00' },
        { amount: 3_000_000, receiptNumber: 1, cardLast4: '2222', swipeAt: '2026-08-13T08:00:00' }
      ]
    });
    const kinds = data.sequenceWarnings.map((x) => x.kind);
    expect(kinds).toContain('RECEIPT_RESET');
    expect(kinds).not.toContain('RECEIPT_INVERSION'); // reset ≠ nghịch thứ tự cùng ngày
  });

  it('NHẢY CÓC số lô CÙNG TID qua 2 lô (10 → 13) → LO_NUMBER_GAP "gửi thiếu"', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const lo1 = await newPendingLo(setup, 1_000_000);
    await reconcileOk(lo1.id, {
      summaryOcr: { amount: 1_000_000, bankReportedLoNumber: 10 },
      individualBills: [{ amount: 1_000_000, receiptNumber: 200, cardLast4: '1111', swipeAt: '2026-08-11T09:00:00' }]
    });
    const lo2 = await newPendingLo(setup, 2_000_000);
    const data = await reconcileOk(lo2.id, {
      summaryOcr: { amount: 2_000_000, bankReportedLoNumber: 13 }, // nhảy từ 10 → 13, thiếu 11,12
      individualBills: [{ amount: 2_000_000, receiptNumber: 300, cardLast4: '2222', swipeAt: '2026-08-12T09:00:00' }]
    });
    const w = data.sequenceWarnings.find((x) => x.kind === 'LO_NUMBER_GAP');
    expect(w).toBeTruthy();
    expect(w!.message).toMatch(/THIẾU lô/);
  });

  it('TRÙNG TOÀN BỘ OCR bill (gửi lại y hệt ở lô sau cùng TID) → DUPLICATE_BILL "đã gửi trước đó"', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const bill = { amount: 1_000_000, receiptNumber: 777, cardLast4: '1234', swipeAt: '2026-08-12T09:00:00' };
    const lo1 = await newPendingLo(setup, 1_000_000);
    await reconcileOk(lo1.id, { summaryOcr: { amount: 1_000_000, bankReportedLoNumber: 20 }, individualBills: [bill] });
    // Lô 2 cùng TID — gửi LẠI y hệt bill trên.
    const lo2 = await newPendingLo(setup, 1_000_000);
    const data = await reconcileOk(lo2.id, { summaryOcr: { amount: 1_000_000, bankReportedLoNumber: 21 }, individualBills: [bill] });
    const w = data.sequenceWarnings.find((x) => x.kind === 'DUPLICATE_BILL');
    expect(w).toBeTruthy();
    expect(w!.message).toMatch(/ĐÃ được gửi trước đó/);
  });

  it('MBV — BỎ QUA cảnh báo số lô (dù nhảy cóc), nhưng số hóa đơn vẫn được kiểm', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const db = getBotDb();
    await db.bank.update({ where: { id: setup.bank.id }, data: { code: 'MBV' } }); // biến ngân hàng lô thành MBV
    const lo1 = await newPendingLo(setup, 1_000_000);
    await reconcileOk(lo1.id, {
      summaryOcr: { amount: 1_000_000, bankReportedLoNumber: 10 },
      individualBills: [{ amount: 1_000_000, receiptNumber: 400, cardLast4: '1111', swipeAt: '2026-08-11T09:00:00' }]
    });
    const lo2 = await newPendingLo(setup, 2_000_000);
    const data = await reconcileOk(lo2.id, {
      summaryOcr: { amount: 2_000_000, bankReportedLoNumber: 13 }, // nhảy cóc — nhưng MBV → KHÔNG cảnh báo số lô
      individualBills: [{ amount: 2_000_000, receiptNumber: 500, cardLast4: '2222', swipeAt: '2026-08-12T09:00:00' }]
    });
    const kinds = data.sequenceWarnings.map((x) => x.kind);
    expect(kinds).not.toContain('LO_NUMBER_GAP');
    expect(kinds).not.toContain('LO_NUMBER_BACKWARD');
  });

  it('AuditLog THẬT ghi SIGMA_LO_SEQUENCE_WARNING cho cảnh báo (query DB trực tiếp)', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const lo = await newPendingLo(setup, 5_000_000);
    await reconcileOk(lo.id, {
      summaryOcr: { amount: 5_000_000 },
      individualBills: [
        { amount: 2_000_000, receiptNumber: 100, cardLast4: '1111', swipeAt: '2026-08-12T09:00:00' },
        { amount: 3_000_000, receiptNumber: 102, cardLast4: '2222', swipeAt: '2026-08-12T10:00:00' }
      ]
    });
    const db = getBotDb();
    const rows = await db.auditLog.findMany({ where: { targetType: 'Lo', targetId: String(lo.id), action: 'SIGMA_LO_SEQUENCE_WARNING' } });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.some((r) => /RECEIPT_GAP/.test(r.afterJson ?? ''))).toBe(true);
  });
});

describe('cancelLo — hủy đơn giản + guard CONFIRMED/CANCELLED', () => {
  beforeAll(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('PENDING → CANCELLED thành công, có cancelReason', async () => {
    const setup = await makeQuoteReadyTid();
    const lo = await createLoOk(setup.agent.id, [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 1_000_000 }]);

    const r = await cancelLo(getBotDb(), lo.id, 'Đại lý hủy kết toán');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.status).toBe('CANCELLED');
  });

  it('hủy 2 LẦN → lần 2 bị từ chối (ALREADY_CANCELLED, không hủy đè)', async () => {
    const setup = await makeQuoteReadyTid();
    const lo = await createLoOk(setup.agent.id, [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 1_000_000 }]);
    await cancelLo(getBotDb(), lo.id, 'lần 1');

    const r = await cancelLo(getBotDb(), lo.id, 'lần 2');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('ALREADY_CANCELLED');
  });

  it('lô ĐÃ CONFIRMED → từ chối hủy qua endpoint đơn giản (ALREADY_CONFIRMED)', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const lo = await createLoOk(setup.agent.id, [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 2_000_003 }]);
    const expected = Number(lo.expectedTotalAmount);
    const reconciled = await reconcileOk(lo.id, { summaryOcr: { amount: expected }, individualBills: [{ amount: expected, cardLast4: '7777', swipeAt: new Date().toISOString() }] });
    expect(reconciled.status).toBe('CONFIRMED');

    const r = await cancelLo(getBotDb(), lo.id, 'thử hủy lô đã confirmed');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('ALREADY_CONFIRMED');
  });

  it('thiếu reason → VALIDATION', async () => {
    const setup = await makeQuoteReadyTid();
    const lo = await createLoOk(setup.agent.id, [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 1_000_000 }]);
    const r = await cancelLo(getBotDb(), lo.id, '');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('VALIDATION');
  });
});

describe('getRecentLoNumbers — sanity hint, KHÔNG sinh số', () => {
  beforeAll(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('chưa có lô nào có số → mảng rỗng', async () => {
    const setup = await makeQuoteReadyTid();
    const recent = await getRecentLoNumbers(getBotDb(), setup.agent.id, 5);
    expect(recent).toEqual([]);
  });

  it('có lô đã reconcile với số lô → trả về đúng số đó (KHÔNG tự sinh số mới)', async () => {
    const setup = await makeQuoteReadyTid({ phiBanMilli: 0 });
    const lo = await createLoOk(setup.agent.id, [{ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: setup.feeType.id, amountBeforeFee: 1_000_000 }]);
    await reconcileOk(lo.id, {
      summaryOcr: { amount: Number(lo.expectedTotalAmount), bankReportedLoNumber: 42 },
      individualBills: [{ amount: Number(lo.expectedTotalAmount), cardLast4: '8888', swipeAt: new Date().toISOString() }]
    });

    const recent = await getRecentLoNumbers(getBotDb(), setup.agent.id, 5);
    expect(recent).toHaveLength(1);
    expect(recent[0].bankReportedLoNumber).toBe(42);
  });
});
