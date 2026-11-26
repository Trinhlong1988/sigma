// Ranh giới bảo mật: đại lý A KHÔNG được thấy/thao tác TID của đại lý B, dù id TID hợp lệ trên hệ thống.
//
// BOLA fix (20/8): route Bearer cũ (/v1/agents/:agentCode/tids, /quote) ĐÃ GỠ — khóa tĩnh dùng-chung cho phép
// thao tác chéo mọi :agentCode qua URL. Test này nay gọi THẲNG các hàm dùng chung mà bề mặt LIVE /v1/me/* tái
// dùng (listAgentTidsWithCardTypeOptions + quoteRows) với agentId TỪNG đại lý — cùng cách ly A↔B, KHÔNG còn phụ
// thuộc route Bearer đã gỡ (bề mặt LIVE /v1/me/tids + /v1/me/quote đã có test HTTP ở me.test.ts).
import { beforeAll, describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { listAgentTidsWithCardTypeOptions } from '../src/routes/agents.js';
import { quoteRows } from '../src/fee-quote.js';
import { makeAgent, makeAgentGroupCustomer, makeBank, makeCardType, makeFeeSellQuote, makeFeeType, makePartner, makeTid, makeTidSellFee } from './fixtures.js';

describe('Agent-scope isolation — /tids và /quote (hàm dùng chung, agentId từng đại lý)', () => {
  let agentAId: number;
  let agentBId: number;
  let tidA: number;
  let tidB: number;
  let cardTypeId: number;
  let feeTypeId: number;

  beforeAll(async () => {
    process.env.SIGMA_API_KEY = 'test-secret-key-123';
    const bank = await makeBank();
    const partner = await makePartner();
    const cardType = await makeCardType(bank.id);
    const feeType = await makeFeeType();
    cardTypeId = cardType.id;
    feeTypeId = feeType.id;
    await makeFeeSellQuote({ partnerId: partner.id, cardTypeId, feeTypeId, phiBanMilli: 2000, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') });

    const agentA = await makeAgent();
    const agentB = await makeAgent();
    agentAId = agentA.id;
    agentBId = agentB.id;

    // NGỮ NGHĨA MỚI /tids (20/8): "cross-agent" nay nghĩa là "khách mà đại lý này KHÔNG là thành viên nhóm chat".
    // agentA là thành viên nhóm của KHÁCH A, agentB của KHÁCH B — mỗi TID gắn customerId của khách tương ứng
    // (nguồn hiển thị /tids). ĐỒNG THỜI giữ tids.agentId: đường /quote (quoteRow) gate ranh giới bảo mật bằng
    // tid.agentId === agentId đang gọi — 2 đường liên kết song song, cùng cách ly A↔B.
    const groupA = await makeAgentGroupCustomer(agentA.id);
    const groupB = await makeAgentGroupCustomer(agentB.id);
    const tA = await makeTid({ agentId: agentA.id, customerId: groupA.customer.id, partnerId: partner.id, bankId: bank.id, status: 'ACTIVE' });
    const tB = await makeTid({ agentId: agentB.id, customerId: groupB.customer.id, partnerId: partner.id, bankId: bank.id, status: 'ACTIVE' });
    // Admin Demo 20/8: đại lý chỉ dùng GIÁ BÁN THỰC TẾ (override) — niêm yết KHÔNG được mượn. tidA cần override để
    // báo giá thành công. tidB không cần (chỉ dùng cho case "ngoài phạm vi" chặn trước phí).
    await makeTidSellFee({ tidId: tA.id, cardTypeId, feeTypeId, phiBanMilli: 2000 });
    tidA = tA.id;
    tidB = tB.id;
  });

  it('listAgentTidsWithCardTypeOptions của đại lý A CHỈ trả TID của A (khách A là thành viên nhóm), KHÔNG lẫn TID của B', async () => {
    const db = getBotDb();
    const rowsA = await listAgentTidsWithCardTypeOptions(db, agentAId);
    const idsA = rowsA.map((r) => r.id);
    expect(idsA).toContain(tidA);
    expect(idsA).not.toContain(tidB);

    const rowsB = await listAgentTidsWithCardTypeOptions(db, agentBId);
    const idsB = rowsB.map((r) => r.id);
    expect(idsB).toContain(tidB);
    expect(idsB).not.toContain(tidA);
  });

  it('quoteRows của đại lý A với tidId thuộc đại lý B → TID_NOT_IN_AGENT_SCOPE (KHÔNG tính báo giá)', async () => {
    const r = await quoteRows(getBotDb(), agentAId, [{ tidId: tidB, cardTypeId, feeTypeId, amountBeforeFee: 1_000_000 }]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('TID_NOT_IN_AGENT_SCOPE');
  });

  it('quoteRows của đại lý A với tidId của CHÍNH A → tính báo giá bình thường', async () => {
    const r = await quoteRows(getBotDb(), agentAId, [{ tidId: tidA, cardTypeId, feeTypeId, amountBeforeFee: 1_000_000 }]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual([{ tidId: tidA, cardTypeId, feeTypeId, amountBeforeFee: 1_000_000, feeApplied: 20_000, amountAfterFee: 980_000, phiBanMilli: 2000 }]);
  });
});
