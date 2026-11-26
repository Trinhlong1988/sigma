// REGRESSION (audit 21/8, FE-2) — bug WIPE override giá bán thực tế: anyCustom TRƯỚC ĐÂY suy từ MODE
// (mode==='custom') nên "chuyển thẻ sang Tùy chỉnh rồi để TRỐNG" → anyCustom=true → gate gửi sellFees TOÀN null
// → server xoá mọi override đang có. Fix: anySellFeeCustom suy theo GIÁ TRỊ đã resolve (phiBan hữu hạn ≠ null).
import { describe, it, expect } from 'vitest';
import { anySellFeeCustom, buildSellFeeEntriesNen } from './sell-fee-entries';

describe('anySellFeeCustom — anyCustom suy theo GIÁ TRỊ (chống wipe override)', () => {
  it('toàn Niêm yết (mọi phiBan=null) → false (KHÔNG gửi gì)', () => {
    expect(anySellFeeCustom([
      { cardTypeId: 1, phiBan: null },
      { cardTypeId: 2, phiBan: null }
    ])).toBe(false);
  });

  it('custom nhưng ĐỂ TRỐNG (phiBan=null cho tất cả) → false — CHÍNH LÀ ca bug wipe, KHÔNG được gửi sellFees toàn null', () => {
    // buildSellFeeEntries map mode='custom' + ô trống → phiBan:null (giống hệt niêm yết) → phải ra false.
    expect(anySellFeeCustom([
      { cardTypeId: 1, phiBan: null },
      { cardTypeId: 2, phiBan: null }
    ])).toBe(false);
  });

  it('có ≥1 thẻ nhập số custom hữu hạn → true (gửi sellFees)', () => {
    expect(anySellFeeCustom([
      { cardTypeId: 1, phiBan: null },
      { cardTypeId: 2, phiBan: 1.5 }
    ])).toBe(true);
  });

  it('phiBan=0 (0% hợp lệ) vẫn tính là custom → true (0 hữu hạn, khác null)', () => {
    expect(anySellFeeCustom([{ cardTypeId: 1, phiBan: 0 }])).toBe(true);
  });

  it('phiBan=NaN (nhập không phải số) → KHÔNG tính là custom hợp lệ (false) — validate sẽ chặn riêng, gate không gửi null-ẩn', () => {
    expect(anySellFeeCustom([{ cardTypeId: 1, phiBan: NaN }])).toBe(false);
  });

  it('rỗng → false', () => {
    expect(anySellFeeCustom([])).toBe(false);
  });
});

// [Admin Demo 15/11] luật nền giá: ô trống ⇒ giá ĐÃ SET ⇒ nếu không có thì NIÊM YẾT.
describe('buildSellFeeEntriesNen — không nhập thì lấy niêm yết', () => {
  const rows = [
    { cardTypeId: 1, phiBanThucTe: null, phiBanNiemYet: 1.25 },   // chưa set gì → niêm yết
    { cardTypeId: 2, phiBanThucTe: 1.4, phiBanNiemYet: 1.25 },    // đã set 1.4 → GIỮ 1.4
    { cardTypeId: 3, phiBanThucTe: null, phiBanNiemYet: null }    // không có gì → LOẠI
  ];
  it('ô trống hết → lấy niêm yết, giữ giá đã set, loại thẻ không có biểu phí', () => {
    const ra = buildSellFeeEntriesNen(rows, [
      { cardTypeId: 1, phiBan: null }, { cardTypeId: 2, phiBan: null }, { cardTypeId: 3, phiBan: null }
    ]);
    expect(ra).toEqual([{ cardTypeId: 1, phiBan: 1.25 }, { cardTypeId: 2, phiBan: 1.4 }]);
  });
  it('người dùng nhập số → số đó THẮNG cả giá đã set lẫn niêm yết', () => {
    const ra = buildSellFeeEntriesNen(rows, [
      { cardTypeId: 1, phiBan: 1.9 }, { cardTypeId: 2, phiBan: 1.8 }, { cardTypeId: 3, phiBan: null }
    ]);
    expect(ra).toEqual([{ cardTypeId: 1, phiBan: 1.9 }, { cardTypeId: 2, phiBan: 1.8 }]);
  });
  it('KHÔNG bao giờ trả về phiBan null (payload toàn null từng làm WIPE giá bán)', () => {
    const ra = buildSellFeeEntriesNen(rows, []);
    expect(ra.every((x) => x.phiBan != null)).toBe(true);
  });
  it('bảng rỗng → danh sách rỗng (không gửi gì, không bịa)', () => {
    expect(buildSellFeeEntriesNen([], [])).toEqual([]);
  });
});
