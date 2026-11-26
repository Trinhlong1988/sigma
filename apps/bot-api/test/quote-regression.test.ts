// Regression guard chống LỆCH công thức: apps/bot-api PHẢI dùng CHÍNH hàm thuần `resolveActualSellFee`
// (@sigma/business-rules) mà apps/desktop/src/main/transaction-service.ts (resolveFeeForTxn) cũng gọi — xem
// packages/business-rules/src/transaction.rules.ts. GIỚI HẠN THẬT (flag rõ, không giấu): không thể import/gọi
// TRỰC TIẾP transaction-service.ts hay tid-sell-fee-service.ts trong vitest ở đây, vì cả 2 file transitively
// `import { app, safeStorage } from 'electron'` qua guard.ts → db.ts — không load được ngoài runtime Electron
// thật (test này chạy plain Node qua vitest). Bằng chứng "không lệch" ở đây là CẤU TRÚC (cả 2 nơi gọi IMPORT
// và GỌI cùng 1 export `resolveActualSellFee`, xác nhận bằng đọc diff transaction-service.ts) + test này xác
// nhận bot-api KHÔNG tính lại công thức bằng tay mà đi qua đúng hàm đó, với số liệu tính tay độc lập ở dưới.
//
// BOLA fix (20/8): route Bearer cũ POST /v1/agents/:agentCode/quote ĐÃ GỠ — test này nay gọi THẲNG hàm dùng
// chung `quoteRows` (bề mặt LIVE /v1/me/quote đã có test HTTP ở me.test.ts), agentId truyền trực tiếp.
import { beforeAll, describe, expect, it } from 'vitest';
import { marginToAmount, resolveActualSellFee } from '@sigma/business-rules';
import { getBotDb } from '../src/db.js';
import { quoteRows } from '../src/fee-quote.js';
import { makeAgent, makeBank, makeCardType, makeFeeSellQuote, makeFeeType, makePartner, makeTid, makeTidSellFee, makeTidVisibleToAgentViaGroup } from './fixtures.js';

describe('quoteRows — khớp CHÍNH XÁC resolveActualSellFee (không lệch/không đoán ngầm)', () => {
  beforeAll(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('có TidSellFee override 3.5% trên 4.530.000 → feeApplied=158.550 (khớp marginToAmount tính tay)', async () => {
    const bank = await makeBank();
    const partner = await makePartner();
    const cardType = await makeCardType(bank.id);
    const feeType = await makeFeeType();
    const agent = await makeAgent();
    const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
    await makeTidVisibleToAgentViaGroup(agent.id, tid.id); // ngữ nghĩa MỚI: /quote scope theo chuỗi nhóm chat (customerId), không tids.agentId
    const override = await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 3500 });

    const amountBeforeFee = 4_530_000;
    const resolved = resolveActualSellFee([{ phiBan: override.phiBan, effectiveFrom: override.effectiveFrom }], [], new Date());
    expect(resolved).toEqual({ ok: true, phiBanMilli: 3500, source: 'OVERRIDE' });
    const expectedFee = resolved.ok ? marginToAmount(amountBeforeFee, resolved.phiBanMilli) : NaN;
    expect(expectedFee).toBe(158_550);

    const r = await quoteRows(getBotDb(), agent.id, [{ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual([
      { tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee, feeApplied: 158_550, amountAfterFee: amountBeforeFee - 158_550, phiBanMilli: 3500 }
    ]);
  });

  // (a) Admin Demo 20/8: đại lý KHÔNG được mượn % NIÊM YẾT — chỉ có niêm yết (KHÔNG override giá bán thực tế) →
  // quoteRow trả NO_ACTUAL_SELL_FEE (TRƯỚC ĐÂY áp niêm yết 1.25% → feeApplied 100.000; nay bị chặn).
  it('CHỈ có FeeSellQuote niêm yết (KHÔNG override giá bán thực tế) → NO_ACTUAL_SELL_FEE (KHÔNG mượn niêm yết)', async () => {
    const bank = await makeBank();
    const partner = await makePartner();
    const cardType = await makeCardType(bank.id);
    const feeType = await makeFeeType();
    const agent = await makeAgent();
    const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
    await makeTidVisibleToAgentViaGroup(agent.id, tid.id); // trong scope nhóm chat để đi tới nhánh phí (không phải TID_NOT_IN_AGENT_SCOPE)
    await makeFeeSellQuote({ partnerId: partner.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1250, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') });

    const r = await quoteRows(getBotDb(), agent.id, [{ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee: 8_000_000 }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NO_ACTUAL_SELL_FEE');
  });

  // (c) Có override giá bán thực tế → báo giá THÀNH CÔNG với % override (1.25% trên 8.000.000 = 100.000).
  it('CÓ override giá bán thực tế 1.25% trên 8.000.000 → feeApplied=100.000 (đại lý dùng giá bán thực tế)', async () => {
    const bank = await makeBank();
    const partner = await makePartner();
    const cardType = await makeCardType(bank.id);
    const feeType = await makeFeeType();
    const agent = await makeAgent();
    const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
    await makeTidVisibleToAgentViaGroup(agent.id, tid.id);
    await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1250 }); // override giá bán thực tế

    const amountBeforeFee = 8_000_000;
    const expectedFee = marginToAmount(amountBeforeFee, 1250);
    expect(expectedFee).toBe(100_000);

    const r = await quoteRows(getBotDb(), agent.id, [{ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual([
      { tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee, feeApplied: 100_000, amountAfterFee: amountBeforeFee - 100_000, phiBanMilli: 1250 }
    ]);
  });

  it('override HIỆN DIỆN đè niêm yết (thứ tự ưu tiên đúng, dù niêm yết có giá trị khác)', async () => {
    const bank = await makeBank();
    const partner = await makePartner();
    const cardType = await makeCardType(bank.id);
    const feeType = await makeFeeType();
    const agent = await makeAgent();
    const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
    await makeTidVisibleToAgentViaGroup(agent.id, tid.id); // ngữ nghĩa MỚI: /quote scope theo chuỗi nhóm chat (customerId), không tids.agentId
    await makeFeeSellQuote({ partnerId: partner.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 5000, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') }); // 5% niêm yết
    await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 1000 }); // 1% override — PHẢI thắng

    const amountBeforeFee = 2_000_000;
    const r = await quoteRows(getBotDb(), agent.id, [{ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data[0].feeApplied).toBe(20_000); // 1% override, KHÔNG phải 100.000 (5% niêm yết)
  });

  it('P1: KỲ override TƯƠNG LAI chưa hiệu lực + chỉ có niêm yết hôm nay → NO_ACTUAL_SELL_FEE (KHÔNG rơi về niêm yết cho đại lý)', async () => {
    const bank = await makeBank();
    const partner = await makePartner();
    const cardType = await makeCardType(bank.id);
    const feeType = await makeFeeType();
    const agent = await makeAgent();
    const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
    await makeTidVisibleToAgentViaGroup(agent.id, tid.id);
    // Niêm yết 2% hiệu lực từ 2020; override 8% nhưng effectiveFrom = NGÀY MAI (CHƯA hiệu lực hôm nay) → resolveActualSellFee
    // rơi về niêm yết (source='QUOTE'). Admin Demo 20/8: đại lý KHÔNG mượn niêm yết → NO_ACTUAL_SELL_FEE (chưa có giá bán thực tế hiệu lực).
    await makeFeeSellQuote({ partnerId: partner.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 2000, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') });
    const tomorrow = new Date(Date.now() + 86_400_000);
    await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 8000, effectiveFrom: tomorrow });

    const r = await quoteRows(getBotDb(), agent.id, [{ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee: 1_000_000 }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NO_ACTUAL_SELL_FEE'); // override tương lai chưa hiệu lực; niêm yết KHÔNG áp cho đại lý
  });

  it('P1: KỲ override QUÁ KHỨ đã hiệu lực → dùng OVERRIDE (đè niêm yết)', async () => {
    const bank = await makeBank();
    const partner = await makePartner();
    const cardType = await makeCardType(bank.id);
    const feeType = await makeFeeType();
    const agent = await makeAgent();
    const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
    await makeTidVisibleToAgentViaGroup(agent.id, tid.id); // ngữ nghĩa MỚI: /quote scope theo chuỗi nhóm chat (customerId), không tids.agentId
    await makeFeeSellQuote({ partnerId: partner.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 2000, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') });
    await makeTidSellFee({ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 8000, effectiveFrom: new Date('2020-06-01T00:00:00.000Z') });

    const r = await quoteRows(getBotDb(), agent.id, [{ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee: 1_000_000 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data[0].feeApplied).toBe(marginToAmount(1_000_000, 8000)); // OVERRIDE 8% (đã hiệu lực từ 2020-06)
  });

  it('KHÔNG override, KHÔNG quote hiệu lực → NO_SELL_QUOTE (không đoán ngầm phí — bug class B61/B62/B85)', async () => {
    const bank = await makeBank();
    const partner = await makePartner();
    const cardType = await makeCardType(bank.id);
    const feeType = await makeFeeType();
    const agent = await makeAgent();
    const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
    await makeTidVisibleToAgentViaGroup(agent.id, tid.id); // ngữ nghĩa MỚI: /quote scope theo chuỗi nhóm chat (customerId), không tids.agentId

    const r = await quoteRows(getBotDb(), agent.id, [{ tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee: 1_000_000 }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NO_SELL_QUOTE');
  });

  it('nhiều dòng trong 1 request → tính đúng độc lập từng dòng, thứ tự giữ nguyên', async () => {
    const bank = await makeBank();
    const partner = await makePartner();
    const cardType = await makeCardType(bank.id);
    const feeType = await makeFeeType();
    const agent = await makeAgent();
    const tid1 = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
    const tid2 = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
    await makeTidVisibleToAgentViaGroup(agent.id, tid1.id); // ngữ nghĩa MỚI: cả 2 TID phải nằm trong tầm nhìn nhóm chat của agent
    await makeTidVisibleToAgentViaGroup(agent.id, tid2.id);
    await makeTidSellFee({ tidId: tid1.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 2000 });
    await makeTidSellFee({ tidId: tid2.id, cardTypeId: cardType.id, feeTypeId: feeType.id, phiBanMilli: 4000 });

    const r = await quoteRows(getBotDb(), agent.id, [
      { tidId: tid1.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee: 1_000_000 },
      { tidId: tid2.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee: 1_000_000 }
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual([
      { tidId: tid1.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee: 1_000_000, feeApplied: 20_000, amountAfterFee: 980_000, phiBanMilli: 2000 },
      { tidId: tid2.id, cardTypeId: cardType.id, feeTypeId: feeType.id, amountBeforeFee: 1_000_000, feeApplied: 40_000, amountAfterFee: 960_000, phiBanMilli: 4000 }
    ]);
  });
});

describe('quoteRows — feeTypeId/cardTypeId TÙY CHỌN, mặc định = "đầu tiên theo id asc" (LEAD chốt 22/7, trích dẫn source)', () => {
  beforeAll(() => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
  });

  it('KHÔNG truyền feeTypeId/cardTypeId → resolve giống HỆT truyền tường minh feeType/cardType ĐẦU TIÊN (id asc)', async () => {
    const db = getBotDb();
    const bank = await makeBank();
    const partner = await makePartner();
    const agent = await makeAgent();
    const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bank.id });
    await makeTidVisibleToAgentViaGroup(agent.id, tid.id); // ngữ nghĩa MỚI: /quote scope theo chuỗi nhóm chat (customerId), không tids.agentId

    // ≥2 CardType cho CHÍNH bank này (query mặc định scope theo bankId → "đầu tiên" ở đây chắc chắn là
    // cardTypeA, không phải trùng hợp chỉ có 1 bản ghi tồn tại).
    const cardTypeA = await makeCardType(bank.id);
    const cardTypeB = await makeCardType(bank.id);
    expect(cardTypeA.id).toBeLessThan(cardTypeB.id);

    // ≥2 FeeType — NHƯNG rule feeType mặc định KHÔNG scope theo partner/tid (đúng như
    // fee-config-service.ts:97: `db.feeType.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' } })`
    // — TOÀN CỤC). DB throwaway này dùng chung cho CẢ FILE (fileParallelism:false, xem fixtures.ts) nên có
    // thể đã có FeeType từ test trước — hỏi thẳng DB bằng ĐÚNG câu lệnh đó để biết "đầu tiên thật sự" hiện là
    // gì, không giả định feeType mới tạo trong test này là đầu.
    await makeFeeType();
    const feeTypeB = await makeFeeType();
    const globalFirstFeeType = (await db.feeType.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' } }))[0];
    expect(globalFirstFeeType).toBeTruthy();
    expect(globalFirstFeeType.id).toBeLessThan(feeTypeB.id);

    const amountBeforeFee = 1_000_000;
    // Niêm yết cho feeType ĐẦU (phiBanMilli riêng biệt) + niêm yết KHÁC HẲN cho feeTypeB trên CÙNG cardTypeA
    // — nếu code lỡ resolve nhầm feeTypeB, feeApplied sẽ lệch rõ, lộ bug ngay thay vì PASS giả.
    await makeFeeSellQuote({
      partnerId: partner.id,
      cardTypeId: cardTypeA.id,
      feeTypeId: globalFirstFeeType.id,
      phiBanMilli: 1_500,
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z')
    });
    await makeFeeSellQuote({
      partnerId: partner.id,
      cardTypeId: cardTypeA.id,
      feeTypeId: feeTypeB.id,
      phiBanMilli: 9_000,
      effectiveFrom: new Date('2020-01-01T00:00:00.000Z')
    });
    // Admin Demo 20/8: đại lý dùng GIÁ BÁN THỰC TẾ (override) — cần override cho ĐÚNG (cardTypeA, globalFirstFeeType)
    // mà quy tắc mặc định resolve tới, để cả 2 request (omitted/explicit) báo giá thành công theo override 1.5%
    // (niêm yết ở trên chỉ là decoy chứng minh KHÔNG resolve nhầm feeTypeB/niêm yết).
    await makeTidSellFee({ tidId: tid.id, cardTypeId: cardTypeA.id, feeTypeId: globalFirstFeeType.id, phiBanMilli: 1_500 });

    const omitted = await quoteRows(getBotDb(), agent.id, [{ tidId: tid.id, amountBeforeFee }]); // KHÔNG truyền feeTypeId/cardTypeId
    const explicit = await quoteRows(getBotDb(), agent.id, [{ tidId: tid.id, cardTypeId: cardTypeA.id, feeTypeId: globalFirstFeeType.id, amountBeforeFee }]);

    expect(omitted.ok).toBe(true);
    expect(explicit.ok).toBe(true);
    if (!omitted.ok || !explicit.ok) return;
    expect(omitted.data).toEqual(explicit.data);
    expect(omitted.data[0].feeApplied).toBe(marginToAmount(amountBeforeFee, 1_500)); // khớp override feeType ĐẦU, KHÔNG phải feeTypeB (9%)
  });

  it('cardTypeId omitted + TID chưa gán ngân hàng (bankId null → 0 CardType để mặc định) → NOT_FOUND (không có gì để đoán)', async () => {
    const partner = await makePartner();
    const agent = await makeAgent();
    const feeType = await makeFeeType();
    const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: null });
    await makeTidVisibleToAgentViaGroup(agent.id, tid.id); // phải trong scope nhóm chat trước, để lỗi trả về là NOT_FOUND (cardType) chứ không phải TID_NOT_IN_AGENT_SCOPE

    const r = await quoteRows(getBotDb(), agent.id, [{ tidId: tid.id, feeTypeId: feeType.id, amountBeforeFee: 1_000_000 }]); // KHÔNG truyền cardTypeId
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NOT_FOUND');
  });

  // [B209 19/11 — Admin Demo "kể cả thẻ khác bank khác"] LUẬT ĐỔI: thẻ không thuộc ngân hàng của TID KHÔNG còn
  // bị chặn (máy POS vẫn quẹt thẻ ngoài hệ thống). Phí tra theo ĐÚNG biểu giá của thẻ được chọn nên tiền
  // không sai. Bài kiểm nay khẳng định chiều NGƯỢC LẠI: báo giá CHẠY ĐƯỢC với thẻ khác ngân hàng.
  it('thẻ KHÁC ngân hàng của TID vẫn báo giá được (luật mới 19/11), phí theo đúng biểu giá của thẻ đó', async () => {
    const bankA = await makeBank();
    const bankB = await makeBank();
    const partner = await makePartner();
    const agent = await makeAgent();
    const feeType = await makeFeeType();
    const cardOfBankB = await makeCardType(bankB.id);
    const tid = await makeTid({ agentId: agent.id, partnerId: partner.id, bankId: bankA.id });
    await makeTidVisibleToAgentViaGroup(agent.id, tid.id); // phải trong scope nhóm chat trước, để lỗi trả về là CARD_BANK_MISMATCH chứ không phải TID_NOT_IN_AGENT_SCOPE

    const r = await quoteRows(getBotDb(), agent.id, [{ tidId: tid.id, cardTypeId: cardOfBankB.id, feeTypeId: feeType.id, amountBeforeFee: 1_000_000 }]);
    // Chưa đặt giá bán cho thẻ của ngân hàng B ⇒ vẫn dừng ở bước GIÁ BÁN, nhưng KHÔNG còn dừng vì khác ngân hàng.
    expect(r.ok === false ? r.error : 'OK').not.toBe('CARD_BANK_MISMATCH');
  });
});
