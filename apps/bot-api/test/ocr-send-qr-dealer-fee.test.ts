// [Đợt 2 — phí bán QR THEO ĐẠI LÝ (Admin Demo 5/9)] resolveQrDealerSellFee (lớp đè) + reviewQr đổi đại lý → phiBan/hoàn
// khác nhau. KHÔNG hard-code giá: mặc định = qr_partner_fee.phi_ban (DB), override = qr_dealer_sell_fee (DB).
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { reviewQr } from '../src/ocr-send-service.js';
import { resolveQrDealerSellFee } from '@sigma/services';
import { makePartner, makeTid, makeCustomer, makeChatRoom, makeCustomerChatGroup } from './fixtures.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const EPOCH = new Date('2020-01-01T00:00:00Z');

async function makeQrTid(hkdName: string, partnerId: number): Promise<{ id: number; tid: string }> {
  const db = getBotDb();
  const t = await makeTid({ partnerId, hkdName, status: 'ACTIVE' });
  await db.$executeRawUnsafe(`UPDATE tids SET kind = 'QR' WHERE id = $1`, t.id);
  return { id: t.id, tid: t.tid };
}
async function seedQrPartnerFee(partnerId: number, phiMua: number, phiBan: number): Promise<void> {
  await getBotDb().$executeRawUnsafe(
    `INSERT INTO qr_partner_fee (partner_id, phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, effective_from) VALUES ($1,$2,$3,$4,$5)`,
    partnerId, phiMua, phiMua, phiBan, EPOCH);
}
async function seedDealerSellFee(customerId: number, phiBan: number, effectiveFrom: Date): Promise<void> {
  await getBotDb().$executeRawUnsafe(
    `INSERT INTO qr_dealer_sell_fee (customer_id, phi_ban, effective_from) VALUES ($1,$2,$3)`, customerId, phiBan, effectiveFrom);
}

describe('resolveQrDealerSellFee — lớp đè giá bán QR theo đại lý', () => {
  it('chưa cấu hình → null; đã set → value; pick kỳ effectiveFrom ≤ at mới nhất', async () => {
    const db = getBotDb();
    const cust = await makeCustomer();
    expect(await resolveQrDealerSellFee(db, cust.id, new Date('2026-09-10T00:00:00Z'))).toBeNull();
    await seedDealerSellFee(cust.id, 1200, new Date('2026-09-01T00:00:00Z'));
    await seedDealerSellFee(cust.id, 1300, new Date('2026-09-05T00:00:00Z'));
    expect(await resolveQrDealerSellFee(db, cust.id, new Date('2026-09-03T00:00:00Z'))).toBe(1200); // trước kỳ 05 → kỳ 01
    expect(await resolveQrDealerSellFee(db, cust.id, new Date('2026-09-10T00:00:00Z'))).toBe(1300); // sau kỳ 05 → kỳ 05
    expect(await resolveQrDealerSellFee(db, cust.id, new Date('2026-08-20T00:00:00Z'))).toBeNull(); // trước mọi kỳ → null (fallback mã)
  });
});

describe('reviewQr — phí bán theo đại lý (đè giá mặc định mã)', () => {
  it('(a) đại lý CHƯA set → phiBan = mặc định mã (1050); (b) đại lý ĐÃ set → 1200; (c) 2 đại lý → phiBan/hoàn khác', async () => {
    const db = getBotDb();
    const partner = await makePartner();
    const name = uniq('HKD DEALERFEE ');
    await makeQrTid(name, partner.id);
    await seedQrPartnerFee(partner.id, 850, 1050); // GIÁ MẶC ĐỊNH mã: mua 850, BÁN 1050 (DB, không hard-code).

    // ĐL A: chưa set override → dùng mặc định mã.
    const custA = await makeCustomer();
    const roomA = await makeChatRoom({ type: 'GROUP', name: 'ĐL A' });
    await makeCustomerChatGroup({ customerId: custA.id, roomId: roomA.id });
    // ĐL B: set override 1.2%.
    const custB = await makeCustomer();
    const roomB = await makeChatRoom({ type: 'GROUP', name: 'ĐL B' });
    await makeCustomerChatGroup({ customerId: custB.id, roomId: roomB.id });
    await seedDealerSellFee(custB.id, 1200, EPOCH);

    const dealers = [{ roomId: roomA.id, name: 'ĐL A' }, { roomId: roomB.id, name: 'ĐL B' }];
    const qr = { hkdName: name, amount: 10_000_000, ref: uniq('R'), date: '10/09/2026', time: '09:00' };

    // (a) chọn ĐL A → phiBan mặc định mã 1050, source DEFAULT.
    const rA = (await reviewQr(db, [qr], new Date(), dealers, null, roomA.id))[0];
    expect(rA.sellFeeMilli).toBe(1050);
    expect(rA.sellFeeSource).toBe('DEFAULT');
    expect(rA.partnerFeeMilli).toBe(850); // giá mua giữ theo mã
    expect(rA.refundAmount).toBe(10_000_000 - Math.round(10_000_000 * 1050 / 100000)); // 9.895.000

    // (b)+(c) chọn ĐL B → phiBan override 1200, source DEALER, hoàn KHÁC ĐL A.
    const rB = (await reviewQr(db, [qr], new Date(), dealers, null, roomB.id))[0];
    expect(rB.sellFeeMilli).toBe(1200);
    expect(rB.sellFeeSource).toBe('DEALER');
    expect(rB.partnerFeeMilli).toBe(850);
    expect(rB.refundAmount).toBe(10_000_000 - Math.round(10_000_000 * 1200 / 100000)); // 9.880.000
    expect(rB.refundAmount).not.toBe(rA.refundAmount); // 2 đại lý khác giá bán → hoàn khác nhau
    expect(rB.blocked).toBe(false);
  });
});
