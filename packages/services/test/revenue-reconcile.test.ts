// QA cổng đối soát doanh số (Admin Demo 27/8 "QA đâu") — khoá hành vi cờ đỏ/vàng + gate ok. Chống tái diễn: nếu ai
// làm pipeline sót TID (như MBV 26/8) → reconcile PHẢI ra cờ MISSING đỏ + ok=false.
import { describe, it, expect } from 'vitest';
import { reconcileDayRevenue, type DbTidRevenue } from '../src/revenue-reconcile.js';
import type { LotRevenue } from '../src/lot-revenue.js';

function lot(tid: string, amount: number, extra: Partial<LotRevenue> = {}): LotRevenue {
  return { tid, batchNumber: '1', amount, source: 'settlement', dateTime: null, saleCount: 0, hasSettlement: true, needsRecheck: false, ...extra };
}

describe('reconcileDayRevenue — cổng QA đối soát', () => {
  it('TID có bill nhưng DB 0đ → CỜ ĐỎ MISSING + ok=false (bắt đúng lỗi MBV 26/8)', () => {
    const lots = [lot('20280819', 185_800_000)];
    const db: DbTidRevenue[] = []; // DB không có gì cho TID này
    const r = reconcileDayRevenue(lots, db);
    expect(r.flags).toHaveLength(1);
    expect(r.flags[0]).toMatchObject({ tid: '20280819', severity: 'red', kind: 'MISSING' });
    expect(r.ok).toBe(false);
  });

  it('khớp khít → không cờ, ok=true', () => {
    const lots = [lot('20280820', 186_100_000)];
    const db: DbTidRevenue[] = [{ tid: '20280820', amount: 186_100_000, count: 2 }];
    const r = reconcileDayRevenue(lots, db);
    expect(r.flags).toHaveLength(0);
    expect(r.ok).toBe(true);
    expect(r.matchRatio).toBeCloseTo(1, 5);
  });

  it('lệch >15% → CỜ VÀNG GAP (không chặn ok trừ khi đỏ)', () => {
    const lots = [lot('53550077', 562_000_000)];
    const db: DbTidRevenue[] = [{ tid: '53550077', amount: 294_000_000, count: 12 }];
    const r = reconcileDayRevenue(lots, db);
    expect(r.flags[0]).toMatchObject({ kind: 'GAP', severity: 'yellow' });
    expect(r.ok).toBe(true); // vàng không chặn; chỉ đỏ + failedImages chặn
  });

  it('ảnh OCR thất bại > 0 → ok=false (không tin số khi còn ảnh chưa đọc — R198)', () => {
    const lots = [lot('20280820', 100_000_000)];
    const db: DbTidRevenue[] = [{ tid: '20280820', amount: 100_000_000, count: 1 }];
    const r = reconcileDayRevenue(lots, db, { failedImages: 3 });
    expect(r.ok).toBe(false);
    expect(r.failedImages).toBe(3);
  });

  it('đếm recheckLots + lotsWithoutSettlement cho QA', () => {
    const lots = [
      lot('20280822', 107_000_000, { needsRecheck: true }),
      lot('53550077', 97_000_000, { hasSettlement: false, source: 'sales' })
    ];
    const db: DbTidRevenue[] = [
      { tid: '20280822', amount: 107_000_000, count: 5 },
      { tid: '53550077', amount: 97_000_000, count: 6 }
    ];
    const r = reconcileDayRevenue(lots, db);
    expect(r.recheckLots).toBe(1);
    expect(r.lotsWithoutSettlement).toBe(1);
  });

  it('DB có mà bill không đọc ra → CỜ VÀNG DB_EXTRA', () => {
    const lots: LotRevenue[] = [];
    const db: DbTidRevenue[] = [{ tid: 'DEMO-TID-07', amount: 50_000_000, count: 1 }];
    const r = reconcileDayRevenue(lots, db);
    expect(r.flags[0]).toMatchObject({ kind: 'DB_EXTRA', severity: 'yellow' });
  });
});
