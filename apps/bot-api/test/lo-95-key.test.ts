// [Admin Demo 16/9 khuya — BUG MẤT TIỀN, cấm tái diễn] Máy POS sau khi ĐÓNG LÔ có thể QUAY VÒNG số lô ⇒ cùng ngày
// cùng TID tồn tại 2 lô mang số 84: lô thường + lô "84(95)". Khóa cũ (tid|lô|ngày) coi 2 lô là MỘT ⇒ bill thứ 2
// bị dedup ⇒ MẤT DOANH SỐ (ca thật 16/9 TID 20281024: bill 18.643.000đ mã 95 không được ghi, lô giữ 47.485.000).
import { describe, expect, it } from 'vitest';
import { buildBillKey, loHienThi } from '../src/lo-service.js';

describe('loHienThi — số lô kèm mã đóng lô', () => {
  it('có mã 95 → "84(95)"; không có mã → "84"; không lô → rỗng', () => {
    expect(loHienThi('84', '95')).toBe('84(95)');
    expect(loHienThi(84, '95')).toBe('84(95)');
    expect(loHienThi('84', null)).toBe('84');
    expect(loHienThi('84', '')).toBe('84');
    expect(loHienThi(null, '95')).toBe('');
    expect(loHienThi('84', 'ĐÓNG(95)')).toBe('84(95)'); // chỉ lấy chữ số trong mã
  });
});

describe('buildBillKey — lô đóng 95 PHẢI tách khỏi lô thường', () => {
  const ngay = new Date('2026-09-16T11:00:00+07:00');
  it('cùng TID + cùng số lô + cùng ngày nhưng KHÁC mã đóng lô → KHÓA KHÁC NHAU (không gộp = không mất tiền)', () => {
    const thuong = buildBillKey({ tid: '20281024', batchNumber: '84', invoiceNumber: null, billDate: ngay });
    const dong95 = buildBillKey({ tid: '20281024', batchNumber: '84', invoiceNumber: null, billDate: ngay, settlementCode: '95' });
    expect(thuong).toBe('nat|20281024|84||2026-09-16');
    expect(dong95).toBe('nat|20281024|84(95)||2026-09-16');
    expect(dong95).not.toBe(thuong);
  });
  it('không có mã đóng lô → khóa GIỮ NGUYÊN như cũ (không phá dữ liệu đang chạy)', () => {
    expect(buildBillKey({ tid: 't1', batchNumber: '7', invoiceNumber: null, billDate: ngay })).toBe('nat|t1|7||2026-09-16');
    expect(buildBillKey({ tid: 't1', batchNumber: '7', invoiceNumber: null, billDate: ngay, settlementCode: null })).toBe('nat|t1|7||2026-09-16');
  });
  it('2 bill CÙNG mã 95 cùng lô cùng ngày → vẫn CÙNG khóa (dedup thật vẫn chặn)', () => {
    const a = buildBillKey({ tid: 'x', batchNumber: '9', invoiceNumber: null, billDate: ngay, settlementCode: '95' });
    const b = buildBillKey({ tid: 'x', batchNumber: '9', invoiceNumber: null, billDate: ngay, settlementCode: '95' });
    expect(a).toBe(b);
  });
});
