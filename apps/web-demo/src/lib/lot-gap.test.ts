// [Admin Demo 2/9 "pos thiếu 1 lô bị nhảy cóc cũng không cảnh báo — rất nghiêm trọng"] TEST HÀNH VI bộ dò lô nhảy.
// REGRESSION SỰ CỐ THẬT: KHACH HANG 62 3 (TID DEMO-TID-07) ngày 30/8 có lô 93,95,96,97,98,99 — KHUYẾT 94, hệ không báo.
import { describe, it, expect } from 'vitest';
import { detectLotGaps, collectLotsByTid, parseLotNumber, detectLotDateBackward, parseBillDateMs } from './lot-gap.js';

// [Admin Demo 4/9 "số lô to hơn mà ngày lùi mà không có gate?"] REGRESSION THẬT: Xuân Đoàn 3 (59930002) lô 67=04/09 08:41,
// lô 68 đọc SAI = 01/09 09:17, lô 69=04/09 09:24 → lô 68 > 67 nhưng ngày lùi = bất khả thi → phải cờ đỏ.
describe('detectLotDateBackward — GATE lô↑ ⟹ ngày↑', () => {
  const E = (lot: number, dt: string) => ({ lot, dateMs: parseBillDateMs(dt)!, dateStr: dt });
  it('lô 68 ngày lùi (01/09) giữa lô 67,69 (04/09) → BẮT vi phạm', () => {
    const m = new Map([['59930002', { hkdName: 'HKD DEMO 50', entries: [E(67, '04/09/2026 08:41'), E(68, '01/09/2026 09:17'), E(69, '04/09/2026 09:24')] }]]);
    const r = detectLotDateBackward(m);
    expect(r).toHaveLength(1);
    expect(r[0].lot).toBe(68);
    expect(r[0].prevLot).toBe(67);
  });
  it('dãy đúng thứ tự ngày → KHÔNG vi phạm', () => {
    const m = new Map([['T1', { entries: [E(10, '04/09/2026 08:00'), E(11, '04/09/2026 08:30'), E(12, '05/09/2026 09:00')] }]]);
    expect(detectLotDateBackward(m)).toHaveLength(0);
  });
  it('parseBillDateMs: ngày to hơn = ms to hơn', () => {
    expect(parseBillDateMs('04/09/2026 09:17')! > parseBillDateMs('01/09/2026 09:17')!).toBe(true);
    expect(parseBillDateMs(null)).toBeNull();
    expect(parseBillDateMs('rác')).toBeNull();
  });
});

describe('parseLotNumber', () => {
  it('093 → 93; rỗng/?/amt → null; chữ → null', () => {
    expect(parseLotNumber('093')).toBe(93);
    expect(parseLotNumber('94')).toBe(94);
    expect(parseLotNumber('')).toBeNull();
    expect(parseLotNumber('?')).toBeNull();
    expect(parseLotNumber('amt:30000000')).toBeNull();
    expect(parseLotNumber('12A')).toBeNull();
    expect(parseLotNumber(null)).toBeNull();
  });
});

describe('detectLotGaps — dò LÔ NHẢY SỐ (chống sót bill câm)', () => {
  it('REGRESSION 30/8: KHACH HANG 62 3 lô [93,95,96,97,98,99] → BÁO thiếu 94', () => {
    const m = new Map([['DEMO-TID-07', { lots: [93, 95, 96, 97, 98, 99], hkdName: 'HKD DEMO 45' }]]);
    const gaps = detectLotGaps(m);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].tid).toBe('DEMO-TID-07');
    expect(gaps[0].missing).toEqual([94]);
    expect(gaps[0].hkdName).toBe('HKD DEMO 45');
  });

  it('dãy liên tục → KHÔNG báo (không nhiễu)', () => {
    expect(detectLotGaps(new Map([['t', { lots: [10, 11, 12, 13] }]]))).toEqual([]);
  });

  it('nhiều lô khuyết → liệt kê ĐỦ (93,96 → thiếu 94,95)', () => {
    const g = detectLotGaps(new Map([['t', { lots: [93, 96] }]]));
    expect(g[0].missing).toEqual([94, 95]);
  });

  it('lô trùng lặp (đọc 2 lần) → không tính thiếu; vẫn bắt khuyết thật', () => {
    const g = detectLotGaps(new Map([['t', { lots: [5, 5, 6, 8] }]]));
    expect(g[0].missing).toEqual([7]);
  });

  it('biên độ quá rộng (>maxSpan) → BỎ (tránh dương-tính-giả khác ngày/reset máy)', () => {
    expect(detectLotGaps(new Map([['t', { lots: [1, 500] }]]))).toEqual([]);
  });

  it('<2 lô → không xét', () => {
    expect(detectLotGaps(new Map([['t', { lots: [42] }]]))).toEqual([]);
  });

  it('nhiều TID độc lập: 1 TID khuyết, 1 TID liền → chỉ báo TID khuyết', () => {
    const g = detectLotGaps(new Map([
      ['A', { lots: [1, 2, 3] }],
      ['B', { lots: [20, 22] }]
    ]));
    expect(g).toHaveLength(1);
    expect(g[0].tid).toBe('B');
    expect(g[0].missing).toEqual([21]);
  });
});

describe('collectLotsByTid — gom (tid→lô) từ bill đã đọc, bỏ bill thiếu tid/lô', () => {
  it('gom đúng + bỏ bill không tid / không lô', () => {
    const m = collectLotsByTid([
      { tid: 'DEMO-TID-07', batchNumber: '93', hkdName: 'TD3' },
      { tid: 'DEMO-TID-07', batchNumber: '95' },
      { tid: '', batchNumber: '10' },              // bỏ (không tid)
      { tid: 'DEMO-TID-07', batchNumber: '?' },       // bỏ (không lô)
      { tid: '53550071', batchNumber: '29' }
    ]);
    expect(m.get('DEMO-TID-07')?.lots.sort((a, b) => a - b)).toEqual([93, 95]);
    expect(m.get('DEMO-TID-07')?.hkdName).toBe('TD3');
    expect(m.get('53550071')?.lots).toEqual([29]);
  });

  it('end-to-end: gom → dò ra thiếu 94 (kịch bản thật)', () => {
    const bills = [93, 95, 96, 97, 98, 99].map((n) => ({ tid: 'DEMO-TID-07', batchNumber: String(n), hkdName: 'HKD DEMO 45' }));
    const gaps = detectLotGaps(collectLotsByTid(bills));
    expect(gaps[0].missing).toEqual([94]);
  });
});
