// [Admin Demo 2/9 "phương án chống tái diễn TRIỆT ĐỂ"] TEST HÀNH VI lưới đối soát lô SERVER (trên bill_key DB `los`).
// REGRESSION: KHACH HANG 62 3 (TID DEMO-TID-07) 30/8 có bill_key nat|...|93/95/96/97/98/99 → PHẢI báo thiếu 94.
import { describe, it, expect } from 'vitest';
import { parseLotFromBillKey, detectLotGapsFromRows } from '../src/lot-reconcile-service.js';

describe('parseLotFromBillKey — rút số lô từ mọi dạng bill_key', () => {
  it('nat|tid|lô|hđ → lô', () => expect(parseLotFromBillKey('nat|DEMO-TID-07|94|')).toBe(94));
  it('VL|tid|lô|ngày|amt → lô', () => expect(parseLotFromBillKey('VL|53550077|165|2026-08-29|amt:99000000')).toBe(165));
  it('V|tid|lô|tiền|iso → lô', () => expect(parseLotFromBillKey('V|20280807|58|10000|2026-08-30T16:21:00')).toBe(58));
  it('093 → 93 (bỏ số 0 đầu)', () => expect(parseLotFromBillKey('nat|x|093|')).toBe(93));
  it('amt:/rỗng/?/img → null (không phải lô đánh số)', () => {
    expect(parseLotFromBillKey('VL|t|amt:30000000@10:00|2026-08-30')).toBeNull();
    expect(parseLotFromBillKey('img|t|abchash')).toBeNull();
    expect(parseLotFromBillKey('VL|t|?|2026-08-30')).toBeNull();
    expect(parseLotFromBillKey(null)).toBeNull();
  });
});

describe('detectLotGapsFromRows — lưới đối soát lô server', () => {
  const rowsFor = (tid: string, hkd: string, day: string, lots: (number | null)[]) =>
    lots.map((lot) => ({ tid, hkdName: hkd, day, lot }));

  it('REGRESSION lô 94: KHACH HANG 62 3 30/8 [93,95,96,97,98,99] → thiếu 94', () => {
    const gaps = detectLotGapsFromRows(rowsFor('DEMO-TID-07', 'HKD DEMO 45', '2026-08-30', [93, 95, 96, 97, 98, 99]));
    expect(gaps).toHaveLength(1);
    expect(gaps[0].tid).toBe('DEMO-TID-07');
    expect(gaps[0].missing).toEqual([94]);
    expect(gaps[0].day).toBe('2026-08-30');
    expect(gaps[0].seenCount).toBe(6);
    expect(gaps[0].sparse).toBe(false); // dày (6/7) → CHẮC sót → đỏ
  });

  it('dãy THƯA (2 lô cách 33: DEMO HX 3 61+94) → cờ sparse=true (amber, không liệt kê 32 số như chắc-sót)', () => {
    const g = detectLotGapsFromRows(rowsFor('53550078', 'HKD DEMO 22', '2026-08-30', [61, 94]));
    expect(g).toHaveLength(1);
    expect(g[0].sparse).toBe(true);
    expect(g[0].seenCount).toBe(2);
  });

  it('dãy liền → không báo', () => {
    expect(detectLotGapsFromRows(rowsFor('t', 'H', '2026-08-30', [10, 11, 12]))).toEqual([]);
  });

  it('TÁCH THEO NGÀY: cùng TID, lô 5 (ngày A) + lô 9 (ngày B) → KHÔNG coi là dãy chung (không báo giả)', () => {
    const rows = [
      ...rowsFor('t', 'H', '2026-08-30', [5]),
      ...rowsFor('t', 'H', '2026-08-31', [9])
    ];
    expect(detectLotGapsFromRows(rows)).toEqual([]); // mỗi ngày <2 lô → không xét
  });

  it('cùng ngày 2 TID: 1 khuyết 1 liền → chỉ báo TID khuyết', () => {
    const rows = [
      ...rowsFor('A', 'HA', '2026-08-30', [1, 2, 3]),
      ...rowsFor('B', 'HB', '2026-08-30', [20, 22])
    ];
    const g = detectLotGapsFromRows(rows);
    expect(g).toHaveLength(1);
    expect(g[0].tid).toBe('B');
    expect(g[0].missing).toEqual([21]);
  });

  it('biên quá rộng, KHÔNG có dãy thật (2 lô cách 499) → bỏ (khác ca/reset, cụm chính <3)', () => {
    expect(detectLotGapsFromRows(rowsFor('t', 'H', '2026-08-30', [1, 500]))).toEqual([]);
  });

  // [Admin Demo 7/9] REGRESSION bug "misread che sót": 1 lô OCR đọc SAI (lệch xa) KHÔNG được làm bỏ-qua cả ngày.
  it('KHACH HANG 62 3 31/8 [100,101,103,104,182]: 182=đọc sai → VẪN báo thiếu 102 + nghi-sai 182 (code cũ bỏ cả ngày)', () => {
    const g = detectLotGapsFromRows(rowsFor('DEMO-TID-07', 'HKD DEMO 45', '2026-08-31', [100, 101, 103, 104, 182]));
    expect(g).toHaveLength(1);
    expect(g[0].missing).toEqual([102]);
    expect(g[0].suspectMisread).toEqual([182]);
  });

  it('KHACH HANG 61 2 4/9 [130..136,138..140,142,144,1010,1057]: sót 137/141/143 + nghi-sai 1010/1057', () => {
    const g = detectLotGapsFromRows(rowsFor('DEMO-TID-08', 'HKD DEMO 49', '2026-09-04',
      [130, 131, 132, 133, 134, 135, 136, 138, 139, 140, 142, 144, 1010, 1057]));
    expect(g).toHaveLength(1);
    expect(g[0].missing).toEqual([137, 141, 143]);
    expect(g[0].suspectMisread).toEqual([1010, 1057]);
  });

  it('KHACH HANG 62 1 4/9 [35,36,37,39,40,41,42] → thiếu 38, không nghi-sai', () => {
    const g = detectLotGapsFromRows(rowsFor('53550071', 'HKD DEMO 43', '2026-09-04', [35, 36, 37, 39, 40, 41, 42]));
    expect(g).toHaveLength(1);
    expect(g[0].missing).toEqual([38]);
    expect(g[0].suspectMisread).toEqual([]);
  });

  it('timeBackward: cùng ngày lô↑ nhưng GIỜ↓ (lô 69 @08:00 sau lô 68 @10:00) → cờ sai giờ', () => {
    const rows = [
      { tid: 't', hkdName: 'H', day: '2026-09-04', lot: 67, time: '07:00' },
      { tid: 't', hkdName: 'H', day: '2026-09-04', lot: 68, time: '10:00' },
      { tid: 't', hkdName: 'H', day: '2026-09-04', lot: 69, time: '08:00' }
    ];
    const g = detectLotGapsFromRows(rows);
    expect(g).toHaveLength(1);
    expect(g[0].timeBackward).toHaveLength(1);
    expect(g[0].timeBackward[0]).toMatchObject({ lot: 69, prevLot: 68 });
  });

  it('lô null (bill_key không có số lô) bị loại, không phá dãy', () => {
    const rows = rowsFor('t', 'H', '2026-08-30', [10, null, 11, 12]);
    expect(detectLotGapsFromRows(rows)).toEqual([]);
  });

  it('sắp xếp: ngày mới nhất trước', () => {
    const rows = [
      ...rowsFor('t', 'H', '2026-08-29', [1, 3]),
      ...rowsFor('t', 'H', '2026-08-31', [5, 7])
    ];
    const g = detectLotGapsFromRows(rows);
    expect(g.map((x) => x.day)).toEqual(['2026-08-31', '2026-08-29']);
  });
});
