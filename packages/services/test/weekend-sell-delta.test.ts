// Test resolveWeekendSellDeltaMilli — HIGH-3 (phản biện 4/9): hàm chạy TRONG đường ghi doanh số cốt lõi
// (resolveFeeForTxn) → PHẢI fail-SAFE về 0 khi bảng weekend_sell_adjust lỗi/chưa tạo (KHÔNG ném = KHÔNG giết GD).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import { resolveWeekendSellDeltaMilli } from '../src/transaction.js';

function fakeDb(impl: (sql: string, ...args: unknown[]) => Promise<unknown>): Pick<Db, '$queryRawUnsafe'> {
  return { $queryRawUnsafe: impl as Db['$queryRawUnsafe'] } as Pick<Db, '$queryRawUnsafe'>;
}

describe('resolveWeekendSellDeltaMilli', () => {
  it('có kỳ hiệu lực → trả delta_milli', async () => {
    const db = fakeDb(async () => [{ delta_milli: 20 }]);
    expect(await resolveWeekendSellDeltaMilli(db, 15, new Date('2026-09-05T05:00:00Z'))).toBe(20);
  });

  it('không có kỳ nào → 0', async () => {
    const db = fakeDb(async () => []);
    expect(await resolveWeekendSellDeltaMilli(db, 15, new Date())).toBe(0);
  });

  it('delta ≤ 0 (dữ liệu lạ) → 0 (không cộng âm)', async () => {
    const db = fakeDb(async () => [{ delta_milli: -5 }]);
    expect(await resolveWeekendSellDeltaMilli(db, 15, new Date())).toBe(0);
  });

  it('HIGH-3: bảng lỗi/chưa tạo (query ném) → 0, KHÔNG ném (không giết đường ghi doanh số)', async () => {
    const db = fakeDb(async () => {
      throw new Error('relation "weekend_sell_adjust" does not exist');
    });
    await expect(resolveWeekendSellDeltaMilli(db, 15, new Date())).resolves.toBe(0);
  });
});
