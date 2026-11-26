// [Admin Demo 11/9] GIÁ BÁN 2 BẬC mã QR: CHỜ (mặc định) / NHANH. Test throwaway Postgres qua CHÍNH resolveQrFeeForTid
// + reviewQr. Mã DEMOMAY mẫu: mua 880 · bán chờ 950 · bán nhanh 1150.
import { describe, expect, it, beforeAll } from 'vitest';
import { ensureAlphaExtraSchema, resolveQrFeeForTid } from '@sigma/services';
import { getBotDb } from '../src/db.js';
import { reviewQr } from '../src/ocr-send-service.js';

const uniq = (p: string): string => `${p}${Date.now()}${Math.floor(Math.random() * 1e6)}`;
async function makeQrWithTiers(phiBan: number, phiBanNhanh: number | null): Promise<{ tidId: number; hkd: string }> {
  const db = getBotDb();
  const hkd = `HKD 2BAC ${uniq('X')}`;
  const bank = await db.bank.create({ data: { name: uniq('BK'), code: uniq('B').slice(0, 18) } });
  const partner = await db.partner.create({ data: { name: uniq('PT'), code: uniq('P').slice(0, 18) } });
  const t = await db.tid.create({ data: { tid: uniq('QR-').slice(0, 24), hkdName: hkd, bankId: bank.id, partnerId: partner.id } });
  await db.$executeRawUnsafe(`UPDATE tids SET kind='QR' WHERE id=$1`, t.id);
  await db.$executeRawUnsafe(
    `INSERT INTO qr_fee_rates (tid_id, phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, phi_ban_nhanh, effective_from, created_by, created_at, updated_by, updated_at)
     VALUES ($1, 880, 880, $2, $3, '2026-01-01T00:00:00+07:00'::timestamptz, 1, now(), 1, now())`, t.id, phiBan, phiBanNhanh);
  return { tidId: t.id, hkd };
}
const qr = (hkd: string, amount: number) => [{ hkdName: hkd, ref: uniq('R').slice(0, 14), amount, date: '11/09/2026', time: '10:00:00' }];

beforeAll(async () => { await ensureAlphaExtraSchema(getBotDb()); });

describe('giá QR 2 bậc — resolveQrFeeForTid', () => {
  it('mã có bậc nhanh → trả cả phiBanMilli (chờ) lẫn phiBanNhanhMilli', async () => {
    const db = getBotDb();
    const { tidId } = await makeQrWithTiers(950, 1150);
    const r = await resolveQrFeeForTid(db, { tidId, partnerId: null }, new Date('2026-09-11T03:00:00Z'));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.phiBanMilli).toBe(950); expect(r.phiBanNhanhMilli).toBe(1150); }
  });
  it('mã KHÔNG có bậc nhanh (null) → phiBanNhanhMilli = null (UI ẩn dropdown)', async () => {
    const db = getBotDb();
    const { tidId } = await makeQrWithTiers(1050, null);
    const r = await resolveQrFeeForTid(db, { tidId, partnerId: null }, new Date('2026-09-11T03:00:00Z'));
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.phiBanMilli).toBe(1050); expect(r.phiBanNhanhMilli).toBeNull(); }
  });
});

describe('giá QR 2 bậc — reviewQr', () => {
  it('CHIỀU ĐÚNG: review trả sellFeeMilli=950 (chờ, mặc định) + sellFeeMilliNhanh=1150 + refund 2 bậc đúng', async () => {
    const db = getBotDb();
    const { tidId, hkd } = await makeQrWithTiers(950, 1150);
    const [it] = await reviewQr(db, qr(hkd, 10_000_000) as never, new Date(), [], null);
    expect((it as { tidId: number | null }).tidId).toBe(tidId);
    expect((it as { sellFeeMilli: number }).sellFeeMilli).toBe(950);
    expect((it as { sellFeeMilliNhanh: number | null }).sellFeeMilliNhanh).toBe(1150);
    expect((it as { refundAmount: number }).refundAmount).toBe(10_000_000 - 95_000);   // chờ: 0,95%
    expect((it as { refundAmountNhanh: number }).refundAmountNhanh).toBe(10_000_000 - 115_000); // nhanh: 1,15%
  });
  it('CHIỀU SAI (không có bậc nhanh): sellFeeMilliNhanh + refundAmountNhanh = null', async () => {
    const db = getBotDb();
    const { hkd } = await makeQrWithTiers(1050, null);
    const [it] = await reviewQr(db, qr(hkd, 5_000_000) as never, new Date(), [], null);
    expect((it as { sellFeeMilliNhanh: number | null }).sellFeeMilliNhanh).toBeNull();
    expect((it as { refundAmountNhanh: number | null }).refundAmountNhanh).toBeNull();
  });
});
