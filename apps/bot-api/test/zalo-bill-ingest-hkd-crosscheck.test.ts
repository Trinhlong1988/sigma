// [H1 audit 2/9] TEST HÀNH VI (không DB) cho cross-check tên HKD OCR vs đăng ký trên path AUTO-INGEST (recordVisionLots
// + recordVisionSaleBills). Lỗ hổng: TID↔ROOM guard chỉ chặn bill LẠC phòng; OCR đọc nhầm số TID sang MÁY ANH EM
// cùng đại lý (cùng phòng) vẫn lọt → ghi doanh số SAI máy → SAI NĐT/phí. Cross-check tên HKD bịt lỗ này.
// R198: test GỌI HÀM THẬT (buildHkdCrossCheck + hkdCrossMismatch), KHÔNG grep nguồn.
import { describe, it, expect } from 'vitest';
import { buildHkdCrossCheck, hkdCrossMismatch } from '../src/zalo-bill-ingest.js';

// Phòng "Đại lý Hoàng Doanh" có 3 MÁY cùng đại lý: HD1/HD2/HD3 (TID khác nhau, tên HKD khác nhau).
const roomTids = [
  { tid: '53550079', hkdName: 'HKD DEMO 17' },
  { tid: '53550076', hkdName: 'HKD DEMO 18' },
  { tid: '53550081', hkdName: 'HKD DEMO 19' }
];

describe('buildHkdCrossCheck + hkdCrossMismatch — chống ghi nhầm MÁY cùng phòng (H1)', () => {
  it('KHỚP: OCR đọc đúng tên máy của TID → KHÔNG lệch (ghi bình thường)', () => {
    const cc = buildHkdCrossCheck(roomTids, [{ tid: '53550081', agencyName: 'HKD DEMO 19' }]);
    expect(hkdCrossMismatch(cc, '53550081')).toBe(false);
  });

  it('LỖ HỔNG H1: OCR nhầm TID sang MÁY ANH EM (81→79) nhưng ẢNH là tên máy 3 → LỆCH → chặn auto-ghi', () => {
    // Bill thật của HD3 (81) bị OCR đọc nhầm số TID thành 79 (HD1) — cùng phòng nên TID↔ROOM guard cho qua.
    // Nhưng tên HKD trên ảnh vẫn "KHACH HANG 60 3" ≠ tên đăng ký của 79 ("KHACH HANG 60 1") → cross-check BẮT.
    const cc = buildHkdCrossCheck(roomTids, [{ tid: '53550079', agencyName: 'HKD DEMO 19' }]);
    expect(hkdCrossMismatch(cc, '53550079')).toBe(true);
  });

  it('biến thể gạch/khoảng/dấu vẫn coi KHỚP (không chặn oan): "KHACH HANG 60-1" == "KHACH HANG 60 1"', () => {
    const cc = buildHkdCrossCheck(roomTids, [{ tid: '53550079', agencyName: 'hkd hoang doanh-1' }]);
    expect(hkdCrossMismatch(cc, '53550079')).toBe(false);
  });

  it('THIẾU tên OCR (cache cũ / không đọc được) → KHÔNG chặn (backward-compat, không ghi thiếu)', () => {
    const cc = buildHkdCrossCheck(roomTids, [{ tid: '53550079', agencyName: null }]);
    expect(hkdCrossMismatch(cc, '53550079')).toBe(false);
    const cc2 = buildHkdCrossCheck(roomTids, [{ tid: '53550079' }]); // không có field agencyName
    expect(hkdCrossMismatch(cc2, '53550079')).toBe(false);
  });

  it('TID không có tên đăng ký (hkdName null) → KHÔNG chặn (không đủ căn cứ)', () => {
    const cc = buildHkdCrossCheck([{ tid: '53550079', hkdName: null }], [{ tid: '53550079', agencyName: 'HKD LẠ' }]);
    expect(hkdCrossMismatch(cc, '53550079')).toBe(false);
  });

  it('normalizeTid: hậu tố -N gộp về gốc để map khớp (TID "53550079-1" ~ "53550079")', () => {
    const cc = buildHkdCrossCheck(roomTids, [{ tid: '53550079-1', agencyName: 'HKD DEMO 19' }]);
    expect(hkdCrossMismatch(cc, '53550079')).toBe(true); // vẫn bắt lệch dù bill ghi hậu tố -1
  });

  it('nhiều bill cùng TID: 1 khớp + 1 lệch → coi là KHỚP (có tên đúng trong tập → không chặn cả lô)', () => {
    // ocrByTid gom TẬP tên; chỉ chặn khi KHÔNG tên nào khớp (tránh chặn oan khi Sonnet có 1 lượt đọc đúng).
    const cc = buildHkdCrossCheck(roomTids, [
      { tid: '53550079', agencyName: 'HKD DEMO 17' },
      { tid: '53550079', agencyName: 'HKD DEMO 19' }
    ]);
    expect(hkdCrossMismatch(cc, '53550079')).toBe(false);
  });
});
