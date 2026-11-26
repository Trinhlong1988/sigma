import { describe, it, expect } from 'vitest';
import {
  computeRevenue,
  isWeekendHCM,
  marginToAmount,
  pickEffectiveRate,
  resolveActualSellFee,
  resolveQrFee
} from './transaction.rules.js';

describe('marginToAmount (1 khoản chênh milli% → VND)', () => {
  it('1% (1000 milli) trên 10.000.000 = 100.000', () => {
    expect(marginToAmount(10_000_000, 1000)).toBe(100_000);
  });
  it('2.5% (2500) trên 4.000.000 = 100.000', () => {
    expect(marginToAmount(4_000_000, 2500)).toBe(100_000);
  });
  it('chênh 0 → 0', () => {
    expect(marginToAmount(5_000_000, 0)).toBe(0);
  });
  it('làm tròn về đồng', () => {
    expect(marginToAmount(1_000_001, 1000)).toBe(10_000); // 10000.01 → 10000
  });
  it('amount âm/không hợp lệ → 0', () => {
    expect(marginToAmount(-100, 3000)).toBe(0);
    expect(marginToAmount(NaN, 3000)).toBe(0);
  });
  it('chênh âm (lỗ) → khoản âm', () => {
    expect(marginToAmount(10_000_000, -2000)).toBe(-200_000);
  });
  // Money-3 (audit 20/8): số cực lớn amount×marginMilli > 2⁵³ → float sai đồng lẻ; BigInt path phải CHÍNH XÁC.
  it('overflow 2⁵³: 900 tỷ × 100% (100000 milli) = 900 tỷ CHÍNH XÁC (float thường lệch)', () => {
    // 900_000_000_000 × 100000 = 9e16 > 2⁵³(≈9.007e15) → float mất chính xác. Kết quả đúng = amount×100%/100% = 900 tỷ.
    expect(marginToAmount(900_000_000_000, 100_000)).toBe(900_000_000_000);
  });
  it('overflow: 123_456_789_012 × 0.1% (100 milli) = 123_456_789 (làm tròn nửa-lên)', () => {
    // 123_456_789_012 × 100 / 100000 = 123_456_789.012 → 123_456_789
    expect(marginToAmount(123_456_789_012, 100)).toBe(123_456_789);
  });
  it('overflow âm: -900 tỷ × 100% = -900 tỷ', () => {
    expect(marginToAmount(-900_000_000_000, 100_000)).toBe(0); // amount<0 → 0 (guard trước BigInt)
  });
});

describe('computeRevenue (bóc 2 khoản: đối tác + bán, cộng gộp)', () => {
  it('CL_NCC 1% + CL_KH 1.5% trên 10.000.000 → 100.000 + 150.000 = 250.000', () => {
    expect(computeRevenue(10_000_000, 1000, 1500)).toEqual({
      revenuePartner: 100_000,
      revenueSell: 150_000,
      revenueAmount: 250_000,
    });
  });
  it('chỉ có chênh bán (đối tác 0) → chỉ khoản bán', () => {
    expect(computeRevenue(4_000_000, 0, 2500)).toEqual({
      revenuePartner: 0,
      revenueSell: 100_000,
      revenueAmount: 100_000,
    });
  });
  it('cả 2 khoản 0 → doanh thu 0', () => {
    expect(computeRevenue(5_000_000, 0, 0)).toEqual({
      revenuePartner: 0,
      revenueSell: 0,
      revenueAmount: 0,
    });
  });
  it('amount không hợp lệ → tất cả 0', () => {
    expect(computeRevenue(NaN, 3000, 2000)).toEqual({
      revenuePartner: 0,
      revenueSell: 0,
      revenueAmount: 0,
    });
  });
  it('một khoản âm (đối tác lỗ) vẫn cộng gộp đúng dấu', () => {
    expect(computeRevenue(10_000_000, -1000, 2000)).toEqual({
      revenuePartner: -100_000,
      revenueSell: 200_000,
      revenueAmount: 100_000,
    });
  });
});

describe('pickEffectiveRate (P1.1 — chọn kỳ giá hiệu lực tại txnDate)', () => {
  const K1 = { id: 1, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') };
  const K2 = { id: 2, effectiveFrom: new Date('2026-07-01T00:00:00.000Z') };

  it('nhiều kỳ → chọn kỳ MỚI NHẤT có effectiveFrom ≤ at', () => {
    // at sau K2 → K2
    expect(pickEffectiveRate([K1, K2], new Date('2026-07-10T00:00:00.000Z'))?.id).toBe(2);
    // at giữa K1 và K2 → K1
    expect(pickEffectiveRate([K1, K2], new Date('2026-06-15T00:00:00.000Z'))?.id).toBe(1);
  });

  it('biên: at = đúng effectiveFrom của kỳ → chính kỳ đó (≤, không loại)', () => {
    expect(pickEffectiveRate([K1, K2], new Date('2026-07-01T00:00:00.000Z'))?.id).toBe(2);
    expect(pickEffectiveRate([K1, K2], new Date('2026-01-01T00:00:00.000Z'))?.id).toBe(1);
  });

  it('at TRƯỚC mọi kỳ → null (không lấy đại kỳ tương lai — I-P3)', () => {
    expect(pickEffectiveRate([K1, K2], new Date('2025-12-31T23:59:59.000Z'))).toBeNull();
  });

  it('1 kỳ duy nhất (mốc sàn) phủ mọi ngày ≥ mốc', () => {
    const floor = [{ id: 9, effectiveFrom: new Date('1970-01-01T00:00:00.000Z') }];
    expect(pickEffectiveRate(floor, new Date('2026-03-01T00:00:00.000Z'))?.id).toBe(9);
    expect(pickEffectiveRate(floor, new Date('2020-05-05T00:00:00.000Z'))?.id).toBe(9);
  });

  it('danh sách rỗng → null; hỗ trợ effectiveFrom dạng ISO string', () => {
    expect(pickEffectiveRate([], new Date())).toBeNull();
    const str = [{ id: 3, effectiveFrom: '2026-01-01T00:00:00.000Z' }];
    expect(pickEffectiveRate(str, new Date('2026-06-15T00:00:00.000Z'))?.id).toBe(3);
  });
});

// SIGMA Tier 1 — resolveActualSellFee trích xuất từ resolveFeeForTxn (transaction-service.ts). Regression
// guard: đảm bảo apps/bot-api VÀ apps/desktop dùng chung công thức "override đè niêm yết" không lệch.
describe('resolveActualSellFee (override TidSellFee đè niêm yết FeeSellQuote)', () => {
  it('có KỲ override hiệu lực tại at → dùng override, KHÔNG xét quotes (kể cả quotes rỗng/không hiệu lực)', () => {
    const r = resolveActualSellFee(
      [{ phiBan: 12345, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') }],
      [],
      new Date('2026-07-01T00:00:00.000Z')
    );
    expect(r).toEqual({ ok: true, phiBanMilli: 12345, source: 'OVERRIDE' });
  });

  // P1 — ĐỔI HÀNH VI: override chọn theo KỲ. GD TRƯỚC ngày effectiveFrom của override → NIÊM YẾT; GD TỪ ngày đó → OVERRIDE.
  it('P1: KỲ override tương lai KHÔNG che niêm yết cho GD trước ngày hiệu lực (dùng QUOTE)', () => {
    const overrides = [{ phiBan: 9999, effectiveFrom: new Date('2026-07-01T00:00:00.000Z') }];
    const quotes = [{ phiBan: 2000, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') }];
    // at = 2026-06-15 (TRƯỚC override 01/07) → niêm yết 2000
    expect(resolveActualSellFee(overrides, quotes, new Date('2026-06-15T00:00:00.000Z'))).toEqual({
      ok: true,
      phiBanMilli: 2000,
      source: 'QUOTE'
    });
    // at = 2026-07-01 (ĐÚNG mốc override, ≤ → chính kỳ) → override 9999
    expect(resolveActualSellFee(overrides, quotes, new Date('2026-07-01T00:00:00.000Z'))).toEqual({
      ok: true,
      phiBanMilli: 9999,
      source: 'OVERRIDE'
    });
  });

  it('P1: nhiều KỲ override → chọn KỲ override mới nhất ≤ at', () => {
    const overrides = [
      { phiBan: 1000, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') },
      { phiBan: 3000, effectiveFrom: new Date('2026-06-01T00:00:00.000Z') }
    ];
    expect(resolveActualSellFee(overrides, [], new Date('2026-06-10T00:00:00.000Z')).ok && resolveActualSellFee(overrides, [], new Date('2026-06-10T00:00:00.000Z'))).toMatchObject({ phiBanMilli: 3000, source: 'OVERRIDE' });
    expect(resolveActualSellFee(overrides, [{ phiBan: 500, effectiveFrom: new Date('2020-01-01T00:00:00.000Z') }], new Date('2026-03-10T00:00:00.000Z'))).toEqual({ ok: true, phiBanMilli: 1000, source: 'OVERRIDE' });
  });

  it('P1: overrides rỗng → rơi về quotes (tương thích: không override = mảng rỗng)', () => {
    const quotes = [{ phiBan: 2000, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') }];
    expect(resolveActualSellFee([], quotes, new Date('2026-07-10T00:00:00.000Z'))).toEqual({ ok: true, phiBanMilli: 2000, source: 'QUOTE' });
  });

  it('không override → chọn kỳ FeeSellQuote hiệu lực tại `at` (mới nhất ≤ at)', () => {
    const quotes = [
      { phiBan: 1000, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') },
      { phiBan: 2000, effectiveFrom: new Date('2026-07-01T00:00:00.000Z') }
    ];
    expect(resolveActualSellFee([], quotes, new Date('2026-07-10T00:00:00.000Z'))).toEqual({
      ok: true,
      phiBanMilli: 2000,
      source: 'QUOTE'
    });
    expect(resolveActualSellFee([], quotes, new Date('2026-03-01T00:00:00.000Z'))).toEqual({
      ok: true,
      phiBanMilli: 1000,
      source: 'QUOTE'
    });
  });

  it('không override + không có kỳ quote nào hiệu lực tại `at` → NO_SELL_QUOTE', () => {
    const quotes = [{ phiBan: 1000, effectiveFrom: new Date('2026-07-01T00:00:00.000Z') }];
    expect(resolveActualSellFee([], quotes, new Date('2026-01-01T00:00:00.000Z'))).toEqual({
      ok: false,
      error: 'NO_SELL_QUOTE'
    });
    expect(resolveActualSellFee([], [], new Date())).toEqual({ ok: false, error: 'NO_SELL_QUOTE' });
  });

  it('overrides rỗng + quotes rỗng → NO_SELL_QUOTE (không throw)', () => {
    expect(() => resolveActualSellFee([], [], new Date())).not.toThrow();
  });
});

// ── [Admin Demo 4/9] GIÁ CUỐI TUẦN ───────────────────────────────────────────────
const FRI = new Date('2026-09-04T05:00:00.000Z'); // T6 (ngày thường) giờ VN
const SAT = new Date('2026-09-05T05:00:00.000Z'); // T7 (cuối tuần)
const SUN = new Date('2026-09-06T05:00:00.000Z'); // CN (cuối tuần)
const MON = new Date('2026-09-07T05:00:00.000Z'); // T2 (ngày thường)

describe('isWeekendHCM (T7/CN giờ VN theo ngày bill)', () => {
  it('T6/T2 = ngày thường', () => {
    expect(isWeekendHCM(FRI)).toBe(false);
    expect(isWeekendHCM(MON)).toBe(false);
  });
  it('T7/CN = cuối tuần', () => {
    expect(isWeekendHCM(SAT)).toBe(true);
    expect(isWeekendHCM(SUN)).toBe(true);
  });
  it('ranh giới giờ VN: 23h T6 VN (16:00Z) = thường; 00:30 T7 VN (17:30Z hôm trước) = cuối tuần', () => {
    expect(isWeekendHCM(new Date('2026-09-04T16:00:00.000Z'))).toBe(false); // 23:00 T6 VN
    expect(isWeekendHCM(new Date('2026-09-04T17:30:00.000Z'))).toBe(true); // 00:30 T7 VN
  });
  it('chuỗi ISO + ngày lỗi', () => {
    expect(isWeekendHCM('2026-09-05T05:00:00.000Z')).toBe(true);
    expect(isWeekendHCM('bad-date')).toBe(false);
  });
});

describe('resolveActualSellFee — GIẢM phí bán cuối tuần (POS MB/MBV −0.02%)', () => {
  const quotes = [{ phiBan: 1400, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') }]; // 1.4% niêm yết
  // [ĐỔI HỢP ĐỒNG 12/9 — KM T9 áp mọi ngày] resolveActualSellFee KHÔNG tự xét lịch nữa: delta do CALLER
  // (resolveWeekendSellDeltaMilli) pre-gate (cuối tuần / cửa sổ khuyến mại). Delta > 0 = trừ, bất kể thứ.
  it('[hợp đồng 12/9] delta đã pre-gate → trừ cả NGÀY THƯỜNG (caller quyết lịch)', () => {
    expect(resolveActualSellFee([], quotes, FRI, { deltaMilli: 20 })).toEqual({
      ok: true,
      phiBanMilli: 1380,
      source: 'QUOTE',
      weekendDeltaApplied: 20
    });
  });
  it('[hợp đồng 12/9] không truyền delta → ngày thường giữ nguyên giá', () => {
    expect(resolveActualSellFee([], quotes, FRI)).toEqual({
      ok: true,
      phiBanMilli: 1400,
      source: 'QUOTE'
    });
  });
  it('cuối tuần + delta 20 → 1400 − 20 = 1380, có cờ weekendDeltaApplied', () => {
    expect(resolveActualSellFee([], quotes, SAT, { deltaMilli: 20 })).toEqual({
      ok: true,
      phiBanMilli: 1380,
      source: 'QUOTE',
      weekendDeltaApplied: 20
    });
  });
  it('cuối tuần KHÔNG có delta (thẻ khác MB/MBV) → giữ nguyên', () => {
    expect(resolveActualSellFee([], quotes, SAT)).toEqual({ ok: true, phiBanMilli: 1400, source: 'QUOTE' });
    expect(resolveActualSellFee([], quotes, SAT, { deltaMilli: 0 })).toEqual({
      ok: true,
      phiBanMilli: 1400,
      source: 'QUOTE'
    });
  });
  it('override cuối tuần cũng bị trừ (rule blanket theo thẻ)', () => {
    const ov = [{ phiBan: 1250, effectiveFrom: new Date('2026-02-01T00:00:00.000Z') }];
    expect(resolveActualSellFee(ov, quotes, SUN, { deltaMilli: 20 })).toEqual({
      ok: true,
      phiBanMilli: 1230,
      source: 'OVERRIDE',
      weekendDeltaApplied: 20
    });
  });
  it('không âm: delta ≥ phí → 0', () => {
    const q2 = [{ phiBan: 10, effectiveFrom: new Date('2026-01-01T00:00:00.000Z') }];
    expect(resolveActualSellFee([], q2, SAT, { deltaMilli: 20 }).ok && resolveActualSellFee([], q2, SAT, { deltaMilli: 20 })).toMatchObject({
      phiBanMilli: 0
    });
  });
});

describe('resolveQrFee — phí QR per HKD, giá mua đổi theo thứ', () => {
  const rows = [
    { phiMuaThuong: 850, phiMuaCuoiTuan: 900, phiBan: 1050, effectiveFrom: new Date('2026-08-01T00:00:00.000Z') }
  ];
  it('ngày thường: mua 0.85% (850), bán 1.05% (1050)', () => {
    expect(resolveQrFee(rows, FRI)).toEqual({ ok: true, phiMuaMilli: 850, phiBanMilli: 1050, isWeekend: false });
  });
  it('cuối tuần: mua TĂNG 0.9% (900), bán GIỮ 1.05% (1050)', () => {
    expect(resolveQrFee(rows, SAT)).toEqual({ ok: true, phiMuaMilli: 900, phiBanMilli: 1050, isWeekend: true });
    expect(resolveQrFee(rows, SUN)).toEqual({ ok: true, phiMuaMilli: 900, phiBanMilli: 1050, isWeekend: true });
  });
  it('chọn kỳ hiệu lực tại `at`; trước kỳ đầu → NO_QR_FEE', () => {
    expect(resolveQrFee(rows, new Date('2026-07-01T00:00:00.000Z'))).toEqual({ ok: false, error: 'NO_QR_FEE' });
    expect(resolveQrFee([], SAT)).toEqual({ ok: false, error: 'NO_QR_FEE' });
  });
});
