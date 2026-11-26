// [Admin Demo 6/9] TÁI HIỆN + CHỐNG TÁI DIỄN bug "4 đại lý (Lộc SG/Mạnh HN/Quỳnh SG/Hoài SG) sót doanh số CÂM".
//
// GỐC: bot GỬI bill = SIGMA_BOT (412, tự thêm vào nhóm khi gửi); bot GHI doanh số = SupportAlpha (413). createLo
// dùng SupportAlpha → quoteRow gate scope theo THÀNH VIÊN nhóm (agentScopeCustomerIds). SupportAlpha CHỈ được thêm
// vào nhóm qua đường zalo-watcher → đại lý dùng menu OCR-send (không watcher) thì SupportAlpha VẮNG nhóm → createLo
// trả TID_NOT_IN_AGENT_SCOPE → bill GỬI được (send không check scope) nhưng DOANH SỐ rơi câm.
//
// Test này: (1) TÁI HIỆN — SupportAlpha chưa ở nhóm → createLo FAIL đúng lỗi scope. (2) FIX — self-heal thêm
// SupportAlpha vào nhóm → createLo THÀNH CÔNG. (3) Idempotent — heal lần 2 KHÔNG hàn lại nhóm đã có.
import { describe, expect, it } from 'vitest';

import { getBotDb } from '../src/db.js';
import { createLoFromBillTid } from '../src/lo-service.js';
import { ensureSupportAlphaAgent, healSupportBotDealerGroupMembership } from '../src/zalo-bill-support.js';
import { agentScopeCustomerIds } from '../src/agent-tid-scope.js';
import { makeQuoteReadyTid, makeFeeSellQuote, makeTidSellFee } from './fixtures.js';

// createLoFromBillTid (đường OCR-send) KHÔNG truyền feeTypeId → quoteRow MẶC ĐỊNH feeType đầu-theo-id TOÀN CỤC.
// Trong DB throwaway dùng chung nhiều test, feeType đầu có thể của test KHÁC → giá bán setup không khớp. Seed thêm
// giá bán (niêm yết + override) cho ĐÚNG feeType mặc định đó, để test không phụ thuộc thứ tự chạy (không phải bug code).
async function seedSellFeeForDefaultFeeType(setup: Awaited<ReturnType<typeof makeQuoteReadyTid>>): Promise<void> {
  const db = getBotDb();
  const defFee = await db.feeType.findFirst({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
  if (!defFee || defFee.id === setup.feeType.id) return; // đã là feeType của setup → makeQuoteReadyTid seed rồi
  await makeFeeSellQuote({ partnerId: setup.partner.id, cardTypeId: setup.cardType.id, feeTypeId: defFee.id, phiBanMilli: 2000, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') });
  await makeTidSellFee({ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: defFee.id, phiBanMilli: 2000 });
}

describe('SupportAlpha scope self-heal — chống sót doanh số câm (bug 4 đại lý 6/9)', () => {
  it('TÁI HIỆN: SupportAlpha VẮNG nhóm đại lý → createLo trả TID_NOT_IN_AGENT_SCOPE (doanh số rơi câm)', async () => {
    const db = getBotDb();
    const setup = await makeQuoteReadyTid({ phiBanMilli: 2000 }); // đại lý là thành viên; SupportAlpha thì KHÔNG
    const bot = await ensureSupportAlphaAgent(db);

    // Khẳng định điều kiện bug: SupportAlpha không thấy customer của TID này.
    const scopeBefore = await agentScopeCustomerIds(db, bot.id);
    expect(scopeBefore).not.toContain(setup.customer.id);

    const res = await createLoFromBillTid(db, bot.id, {
      tidString: setup.tid.tid,
      cardTypeId: setup.cardType.id,
      amountBeforeFee: 1_000_000,
      billKey: `repro|${setup.tid.tid}|1|x`,
      allowDuplicate: true
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe('TID_NOT_IN_AGENT_SCOPE');
  });

  it('FIX: self-heal thêm SupportAlpha vào nhóm → createLo THÀNH CÔNG (doanh số ghi được)', async () => {
    const db = getBotDb();
    const setup = await makeQuoteReadyTid({ phiBanMilli: 2000 });
    await seedSellFeeForDefaultFeeType(setup);
    const bot = await ensureSupportAlphaAgent(db);

    const heal = await healSupportBotDealerGroupMembership(db);
    expect(heal.healedRoomIds).toContain(setup.room.id); // nhóm này ĐANG drift → được hàn
    // Sau heal: SupportAlpha thấy customer.
    const scopeAfter = await agentScopeCustomerIds(db, bot.id);
    expect(scopeAfter).toContain(setup.customer.id);

    const res = await createLoFromBillTid(db, bot.id, {
      tidString: setup.tid.tid,
      cardTypeId: setup.cardType.id,
      amountBeforeFee: 1_000_000,
      billKey: `fixed|${setup.tid.tid}|1|x`,
      allowDuplicate: true
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.id).toBeGreaterThan(0);
  });

  it('IDEMPOTENT: heal lần 2 KHÔNG hàn lại nhóm đã có SupportAlpha', async () => {
    const db = getBotDb();
    const setup = await makeQuoteReadyTid({ phiBanMilli: 2000 });
    await healSupportBotDealerGroupMembership(db); // lần 1 — hàn setup.room
    const second = await healSupportBotDealerGroupMembership(db); // lần 2 — nhóm này KHÔNG còn drift
    expect(second.healedRoomIds).not.toContain(setup.room.id);
  });
});
