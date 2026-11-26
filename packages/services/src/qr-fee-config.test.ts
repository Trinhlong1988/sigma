// Test RESOLVER resolveQrFeeForTid (@sigma/services/qr-fee-config) — giá QR THỰC TẾ theo MÃ (qr_fee_rates) ĐÈ giá
// ĐỐI TÁC (qr_partner_fee). Db GIẢ chỉ cần $queryRawUnsafe trả canned rows theo BẢNG được hỏi (KHÔNG cần Postgres).
// ASSERT: MÃ đè ĐỐI TÁC · thiếu MÃ → rơi ĐỐI TÁC · cuối tuần lấy phi_mua_cuoi_tuan · không có cả 2 → NO_QR_FEE.
// Mốc: 2026-09-04 = Thứ 6 (ngày thường), 2026-09-05 = Thứ 7 (cuối tuần) — giờ VN (UTC+7).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import { resolveQrFeeForTid } from './qr-fee-config.js';

// Dòng thô đúng shape SELECT của resolver (snake_case, kèm effective_from).
interface RawQrRow {
  phi_mua_thuong: number;
  phi_mua_cuoi_tuan: number;
  phi_ban: number;
  effective_from: string;
}

/** Db GIẢ: $queryRawUnsafe soi câu SQL → trả rows của qr_fee_rates (MÃ) hoặc qr_partner_fee (ĐỐI TÁC). */
function fakeDb(opts: { merchant?: RawQrRow[]; partner?: RawQrRow[] }): Pick<Db, '$queryRawUnsafe'> {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    $queryRawUnsafe: (async (sql: string) => {
      if (sql.includes('qr_fee_rates')) return (opts.merchant ?? []) as unknown;
      if (sql.includes('qr_partner_fee')) return (opts.partner ?? []) as unknown;
      return [] as unknown;
    }) as Db['$queryRawUnsafe']
  } as Pick<Db, '$queryRawUnsafe'>;
}

const EFF = '2026-09-01T00:00:00.000Z';
const FRIDAY = new Date('2026-09-04T05:00:00.000Z'); // +7h = 12:00 04/09 HCM = Thứ 6
const SATURDAY = new Date('2026-09-05T05:00:00.000Z'); // +7h = 12:00 05/09 HCM = Thứ 7

const MERCHANT: RawQrRow = { phi_mua_thuong: 800, phi_mua_cuoi_tuan: 850, phi_ban: 1000, effective_from: EFF };
const PARTNER: RawQrRow = { phi_mua_thuong: 900, phi_mua_cuoi_tuan: 950, phi_ban: 1100, effective_from: EFF };

describe('resolveQrFeeForTid', () => {
  it('MÃ (merchant) ĐÈ giá ĐỐI TÁC (partner) khi mã có cấu hình riêng', async () => {
    const db = fakeDb({ merchant: [MERCHANT], partner: [PARTNER] });
    const r = await resolveQrFeeForTid(db, { tidId: 1, partnerId: 7 }, FRIDAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe('MERCHANT');
    expect(r.phiMuaMilli).toBe(800); // ngày thường
    expect(r.phiBanMilli).toBe(1000);
    expect(r.isWeekend).toBe(false);
  });

  it('rơi về giá ĐỐI TÁC khi KHÔNG có dòng mã (merchant rỗng)', async () => {
    const db = fakeDb({ merchant: [], partner: [PARTNER] });
    const r = await resolveQrFeeForTid(db, { tidId: 1, partnerId: 7 }, FRIDAY);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe('PARTNER');
    expect(r.phiMuaMilli).toBe(900);
    expect(r.phiBanMilli).toBe(1100);
    expect(r.isWeekend).toBe(false);
  });

  it('MÃ có kỳ TƯƠNG LAI (chưa hiệu lực tại ngày GD) → RƠI về giá ĐỐI TÁC, KHÔNG chặn oan (song song POS)', async () => {
    const futureMerchant: RawQrRow = { ...MERCHANT, effective_from: '2026-10-01T00:00:00.000Z' };
    const db = fakeDb({ merchant: [futureMerchant], partner: [PARTNER] });
    const r = await resolveQrFeeForTid(db, { tidId: 1, partnerId: 7 }, FRIDAY); // GD 04/09 < kỳ mã 01/10
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source).toBe('PARTNER');
    expect(r.phiMuaMilli).toBe(900);
    expect(r.phiBanMilli).toBe(1100);
  });

  it('MÃ kỳ tương lai + KHÔNG có giá đối tác → NO_QR_FEE (fail-closed)', async () => {
    const futureMerchant: RawQrRow = { ...MERCHANT, effective_from: '2026-10-01T00:00:00.000Z' };
    const db = fakeDb({ merchant: [futureMerchant], partner: [] });
    const r = await resolveQrFeeForTid(db, { tidId: 1, partnerId: 7 }, FRIDAY);
    expect(r.ok).toBe(false);
  });

  it('CUỐI TUẦN lấy phi_mua_cuoi_tuan (phí bán KHÔNG đổi)', async () => {
    const dbM = fakeDb({ merchant: [MERCHANT] });
    const rm = await resolveQrFeeForTid(dbM, { tidId: 1, partnerId: 7 }, SATURDAY);
    expect(rm.ok).toBe(true);
    if (!rm.ok) return;
    expect(rm.isWeekend).toBe(true);
    expect(rm.phiMuaMilli).toBe(850); // giá mua cuối tuần
    expect(rm.phiBanMilli).toBe(1000); // bán không đổi cuối tuần

    const dbP = fakeDb({ merchant: [], partner: [PARTNER] });
    const rp = await resolveQrFeeForTid(dbP, { tidId: 1, partnerId: 7 }, SATURDAY);
    expect(rp.ok).toBe(true);
    if (!rp.ok) return;
    expect(rp.source).toBe('PARTNER');
    expect(rp.phiMuaMilli).toBe(950); // giá mua cuối tuần đối tác
    expect(rp.phiBanMilli).toBe(1100);
  });

  it('NO_QR_FEE khi không có cả mã lẫn đối tác', async () => {
    const db = fakeDb({ merchant: [], partner: [] });
    const r = await resolveQrFeeForTid(db, { tidId: 1, partnerId: null }, FRIDAY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NO_QR_FEE');
    expect(typeof r.message).toBe('string');
  });

  it('NO_QR_FEE khi partnerId null và mã cũng rỗng (không âm thầm dùng giá khác)', async () => {
    const db = fakeDb({ merchant: [], partner: [PARTNER] });
    const r = await resolveQrFeeForTid(db, { tidId: 1, partnerId: null }, FRIDAY);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('NO_QR_FEE');
  });
});
