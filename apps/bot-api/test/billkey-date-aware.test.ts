// [Admin Demo 6/9] GATE chống tái diễn bug "lô trùng số KHÁC NGÀY bị gộp nhầm" — số lô ngân hàng RESET mỗi ngày.
// buildBillKey nay KÈM NGÀY (HCM) cho khóa `nat|` (theo lô). Test khẳng định: khác ngày → khóa KHÁC → 2 Lô riêng;
// cùng ngày cùng lô → khóa GIỐNG → 1 Lô (dedup giữ). Không ngày → format cũ 4-đoạn (tương thích ngược).
import { describe, expect, it } from 'vitest';

import { getBotDb } from '../src/db.js';
import { buildBillKey, createLoFromBillTid, hcmDayKey } from '../src/lo-service.js';
import { ensureSupportAlphaAgent, healSupportBotDealerGroupMembership } from '../src/zalo-bill-support.js';
import { makeQuoteReadyTid, makeFeeSellQuote, makeTidSellFee } from './fixtures.js';

async function seedSellFeeForDefaultFeeType(setup: Awaited<ReturnType<typeof makeQuoteReadyTid>>): Promise<void> {
  const db = getBotDb();
  const defFee = await db.feeType.findFirst({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
  if (!defFee || defFee.id === setup.feeType.id) return;
  await makeFeeSellQuote({ partnerId: setup.partner.id, cardTypeId: setup.cardType.id, feeTypeId: defFee.id, phiBanMilli: 2000, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') });
  await makeTidSellFee({ tidId: setup.tid.id, cardTypeId: setup.cardType.id, feeTypeId: defFee.id, phiBanMilli: 2000 });
}

describe('buildBillKey date-aware — lô ngân hàng reset mỗi ngày', () => {
  it('KÈM NGÀY: khác billDate → khóa KHÁC; cùng ngày → khóa GIỐNG; không ngày → format cũ', () => {
    const d1 = new Date('2026-09-01T10:00:00+07:00');
    const d5 = new Date('2026-09-05T10:00:00+07:00');
    const k1 = buildBillKey({ tid: '20281008', batchNumber: '1', invoiceNumber: null, billDate: d1 });
    const k5 = buildBillKey({ tid: '20281008', batchNumber: '1', invoiceNumber: null, billDate: d5 });
    const k5b = buildBillKey({ tid: '20281008', batchNumber: '1', invoiceNumber: null, billDate: new Date('2026-09-05T23:30:00+07:00') });
    const kNone = buildBillKey({ tid: '20281008', batchNumber: '1', invoiceNumber: null });
    expect(k1).toBe('nat|20281008|1||2026-09-01');
    expect(k5).toBe('nat|20281008|1||2026-09-05');
    expect(k1).not.toBe(k5); // khác ngày → KHÁC
    expect(k5b).toBe(k5); // cùng ngày (kể cả tối muộn HCM) → GIỐNG
    expect(kNone).toBe('nat|20281008|1|'); // không ngày → format cũ 4-đoạn
    // Khóa `img|` KHÔNG kèm ngày (đã unique theo ảnh).
    expect(buildBillKey({ tid: 't', imageHash: 'abc', billDate: d1 })).toBe('img|t|abc');
    // hcmDayKey đúng biên đêm: 23:30 ngày 5 giờ HCM = vẫn ngày 5 (không nhảy sang 6 do UTC).
    expect(hcmDayKey(new Date('2026-09-05T23:30:00+07:00'))).toBe('2026-09-05');
  });

  it('END-TO-END: cùng TID+lô KHÁC NGÀY → 2 Lô RIÊNG (không gộp mất doanh số)', async () => {
    const db = getBotDb();
    const setup = await makeQuoteReadyTid({ phiBanMilli: 2000 });
    await seedSellFeeForDefaultFeeType(setup);
    const bot = await ensureSupportAlphaAgent(db);
    await healSupportBotDealerGroupMembership(db);

    const d1 = new Date('2026-09-01T10:00:00+07:00');
    const d5 = new Date('2026-09-05T10:00:00+07:00');
    const mk = (bd: Date) => buildBillKey({ tid: setup.tid.tid, batchNumber: '1', invoiceNumber: null, billDate: bd });

    const r1 = await createLoFromBillTid(db, bot.id, { tidString: setup.tid.tid, cardTypeId: setup.cardType.id, amountBeforeFee: 1_000_000, billKey: mk(d1), txnDate: d1, allowDuplicate: true });
    const r5 = await createLoFromBillTid(db, bot.id, { tidString: setup.tid.tid, cardTypeId: setup.cardType.id, amountBeforeFee: 2_000_000, billKey: mk(d5), txnDate: d5, allowDuplicate: true });
    expect(r1.ok && r5.ok).toBe(true);
    if (r1.ok && r5.ok) expect(r1.data.id).not.toBe(r5.data.id); // 2 Lô RIÊNG
  });

  it('END-TO-END: cùng TID+lô CÙNG NGÀY → 1 Lô (dedup giữ nguyên)', async () => {
    const db = getBotDb();
    const setup = await makeQuoteReadyTid({ phiBanMilli: 2000 });
    await seedSellFeeForDefaultFeeType(setup);
    const bot = await ensureSupportAlphaAgent(db);
    await healSupportBotDealerGroupMembership(db);

    const d5a = new Date('2026-09-05T09:00:00+07:00');
    const d5b = new Date('2026-09-05T20:00:00+07:00'); // cùng ngày HCM
    const mk = (bd: Date) => buildBillKey({ tid: setup.tid.tid, batchNumber: '7', invoiceNumber: null, billDate: bd });

    const r1 = await createLoFromBillTid(db, bot.id, { tidString: setup.tid.tid, cardTypeId: setup.cardType.id, amountBeforeFee: 1_000_000, billKey: mk(d5a), txnDate: d5a, allowDuplicate: true });
    const r2 = await createLoFromBillTid(db, bot.id, { tidString: setup.tid.tid, cardTypeId: setup.cardType.id, amountBeforeFee: 1_000_000, billKey: mk(d5b), txnDate: d5b, allowDuplicate: true });
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) expect(r1.data.id).toBe(r2.data.id); // CÙNG 1 Lô
  });
});
