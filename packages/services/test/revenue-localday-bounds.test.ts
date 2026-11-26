// Item 3 (audit 20/8) — revenueByHandoverType: ngày lọc SAI (vd 2026-02-31) PHẢI trả VALIDATION, KHÔNG cuộn âm
// thầm sang kỳ khác (báo cáo sai kỳ). Ngày hợp lệ + biên +1 tràn tháng (2026-01-31) VẪN hợp lệ (không chặn nhầm).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { revenueByHandoverType, type ServiceCtx } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'T', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

/** Fake DB rỗng đủ cho nhánh HỢP LỆ (không bút toán) — nhánh SAI ngày return TRƯỚC mọi query DB. */
const emptyDb = {
  deviceSale: { findMany: async () => [] },
  cashCategory: { findFirst: async () => null },
  cashEntry: { aggregate: async () => ({ _sum: { amount: 0n }, _count: 0 }) },
  handoverType: { findMany: async () => [] }
} as unknown as Db;

const ctx = (): ServiceCtx => ({ db: emptyDb, user: authUser(['REVENUE_VIEW']) });

describe('revenueByHandoverType — chặn ngày rollover', () => {
  it('from = 2026-02-31 (ngày không tồn tại) → VALIDATION, KHÔNG rollover', async () => {
    const r = await revenueByHandoverType(ctx(), { from: '2026-02-31' });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('VALIDATION');
  });

  it('to = 2026-13-01 (tháng không tồn tại) → VALIDATION', async () => {
    const r = await revenueByHandoverType(ctx(), { to: '2026-13-01' });
    expect(r.error).toBe('VALIDATION');
  });

  it('ngày hợp lệ có biên tràn tháng (from 2026-01-01, to 2026-01-31) → OK (không chặn nhầm)', async () => {
    const r = await revenueByHandoverType(ctx(), { from: '2026-01-01', to: '2026-01-31' });
    expect(r.ok).toBe(true);
  });

  it('không truyền ngày → OK (không lọc)', async () => {
    const r = await revenueByHandoverType(ctx(), {});
    expect(r.ok).toBe(true);
  });
});
