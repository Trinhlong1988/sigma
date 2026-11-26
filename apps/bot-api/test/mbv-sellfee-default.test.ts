// [Admin Demo 6/9] GATE chống tái diễn "bill MBV lỗi NO_ACTUAL_SELL_FEE vì thiếu giá bán". Self-heal điền mặc định
// Visa 1.25% (1250‰) + Napas 1.5% (1500‰) cho máy MBV THIẾU giá — KHÔNG đè giá đã set tay. Idempotent.
import { beforeEach, describe, expect, it } from 'vitest';

import { getBotDb } from '../src/db.js';
import { ensureMbvDefaultSellFee, MBV_VISA_MILLI, MBV_NAPAS_MILLI } from '../src/mbv-sellfee-default.js';

let n = 0;
async function makeMbvBankWithCards() {
  const db = getBotDb();
  n += 1;
  const bank = await db.bank.create({ data: { name: `MBV${n}`, code: `MBV` } }).catch(async () => {
    // code MBV @unique — nếu đã có (test khác) thì dùng lại.
    return db.bank.findFirstOrThrow({ where: { code: 'MBV' } });
  });
  const visa = await db.cardType.findFirst({ where: { bankId: bank.id, name: { contains: 'Visa' } } })
    ?? await db.cardType.create({ data: { bankId: bank.id, name: 'Visa', code: `V${n}${Date.now()}`.slice(0, 20) } });
  const napas = await db.cardType.findFirst({ where: { bankId: bank.id, name: { contains: 'Napas' } } })
    ?? await db.cardType.create({ data: { bankId: bank.id, name: 'Napas', code: `N${n}${Date.now()}`.slice(0, 20) } });
  // Đảm bảo feeType id=1 tồn tại (self-heal dùng DEFAULT_FEE_TYPE_ID=1).
  const ft = await db.feeType.findFirst({ where: { id: 1 } });
  if (!ft) await db.feeType.create({ data: { name: 'PhiMacDinh' } });
  return { bank, visa, napas };
}

describe('ensureMbvDefaultSellFee — chống NO_ACTUAL_SELL_FEE máy MBV', () => {
  beforeEach(() => { /* throwaway DB */ });

  it('máy MBV THIẾU giá → điền Visa 1.25% + Napas 1.5%; chạy lại KHÔNG điền thêm (idempotent)', async () => {
    const db = getBotDb();
    const { bank, visa, napas } = await makeMbvBankWithCards();
    const tid = await db.tid.create({ data: { tid: `mbv-heal-${Date.now()}`, bankId: bank.id } });

    const r1 = await ensureMbvDefaultSellFee(db);
    expect(r1.filled).toBeGreaterThanOrEqual(2); // ít nhất Visa+Napas của máy này (DB chung có thể có máy MBV khác)

    const visaFee = await db.tidSellFee.findFirst({ where: { tidId: tid.id, cardTypeId: visa.id, deletedAt: null } });
    const napasFee = await db.tidSellFee.findFirst({ where: { tidId: tid.id, cardTypeId: napas.id, deletedAt: null } });
    expect(visaFee?.phiBan).toBe(MBV_VISA_MILLI); // 1250 = 1.25%
    expect(napasFee?.phiBan).toBe(MBV_NAPAS_MILLI); // 1500 = 1.5%

    // Idempotent: máy này không còn thiếu → lần 2 không điền cho tid này.
    const before = await db.tidSellFee.count({ where: { tidId: tid.id, deletedAt: null } });
    await ensureMbvDefaultSellFee(db);
    const after = await db.tidSellFee.count({ where: { tidId: tid.id, deletedAt: null } });
    expect(after).toBe(before);
  });

  it('KHÔNG đè giá đã set tay (máy có Visa 1.4% tự set → giữ nguyên, chỉ điền Napas nếu thiếu)', async () => {
    const db = getBotDb();
    const { bank, visa, napas } = await makeMbvBankWithCards();
    const tid = await db.tid.create({ data: { tid: `mbv-manual-${Date.now()}`, bankId: bank.id } });
    // Set tay Visa 1.4% (1400‰) feeType 1.
    await db.tidSellFee.create({ data: { tidId: tid.id, cardTypeId: visa.id, feeTypeId: 1, phiBan: 1400, effectiveFrom: new Date('2026-01-01') } });

    await ensureMbvDefaultSellFee(db);

    const visaFee = await db.tidSellFee.findFirst({ where: { tidId: tid.id, cardTypeId: visa.id, deletedAt: null }, orderBy: { id: 'desc' } });
    expect(visaFee?.phiBan).toBe(1400); // GIỮ giá tay, KHÔNG đè về 1250
    const napasFee = await db.tidSellFee.findFirst({ where: { tidId: tid.id, cardTypeId: napas.id, deletedAt: null } });
    expect(napasFee?.phiBan).toBe(MBV_NAPAS_MILLI); // Napas thiếu → điền 1.5%
  });
});
