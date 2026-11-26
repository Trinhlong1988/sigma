// UNIT TEST (Admin Demo 3/9) — HÀM THUẦN cho (1) đọc-2-lần-đồng-thuận + (2) snap TID hợp lệ gần nhất. Không DB.
// Chống tái diễn "loạn" = OCR đọc chập chờn 1 chữ số (0↔6): consensusWarning cắm cờ khi lệch; nearestValidTids gợi ý
// TID hợp lệ gần nhất (edit-distance ≤2) để người chọn đúng máy. R198: check chạy thật, không suy từ log.
import { describe, it, expect } from 'vitest';
import { consensusWarning, editDistance, nearestValidTids } from '../src/ocr-send-service.js';

describe('consensusWarning — cờ đỏ khi đọc 2 lần lệch', () => {
  it('ok=false → có cờ', () => { expect(consensusWarning({ ok: false, first: 'a', second: 'b' })).toMatch(/2 LẦN LỆCH/); });
  it('ok=true → null', () => { expect(consensusWarning({ ok: true })).toBeNull(); });
  it('singleRead → null', () => { expect(consensusWarning({ ok: true, singleRead: true })).toBeNull(); });
  it('null → null', () => { expect(consensusWarning(null)).toBeNull(); });
});

describe('editDistance', () => {
  it('0↔6: 59930002 vs 59930062 = 1', () => { expect(editDistance('59930002', '59930062')).toBe(1); });
  it('giống hệt = 0', () => { expect(editDistance('59930002', '59930002')).toBe(0); });
  it('lệch độ dài xa → 99 (không phải nhầm số)', () => { expect(editDistance('12', '1234567')).toBe(99); });
});

describe('nearestValidTids — snap TID hợp lệ gần nhất', () => {
  const rows = [
    { tid: '59930002', hkdName: 'HKD DEMO 5' },
    { tid: '59930001', hkdName: 'HKD DEMO 48' },
    { tid: '53590002', hkdName: 'HKD DEMO 5 2' }
  ];
  it('OCR 59930062 → gợi ý 59930002 (gần nhất, d=1) ĐẦU', () => {
    const s = nearestValidTids('59930062', rows);
    expect(s[0]?.tid).toBe('59930002');
    expect(s[0]?.hkdName).toBe('HKD DEMO 5');
  });
  it('OCR khớp CHÍNH XÁC 1 TID → KHÔNG tự gợi ý nó (d=0 loại, chỉ 1..2)', () => {
    const s = nearestValidTids('59930002', rows);
    expect(s.find((x) => x.tid === '59930002')).toBeUndefined();
  });
  it('OCR rỗng → rỗng', () => { expect(nearestValidTids('', rows)).toEqual([]); });
  it('OCR quá xa mọi TID → rỗng', () => { expect(nearestValidTids('11111111', rows)).toEqual([]); });
  it('sắp theo khoảng cách tăng dần', () => {
    const s = nearestValidTids('59930062', rows); // d(59930002)=1, d(59930001)=2
    const ds = s.map((x) => x.tid);
    expect(ds.indexOf('59930002')).toBeLessThan(ds.indexOf('59930001') === -1 ? 99 : ds.indexOf('59930001'));
  });
});
