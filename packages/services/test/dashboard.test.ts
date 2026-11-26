// Test LÕI THUẦN dashboard core (@sigma/services, CHỈ ĐỌC). ASSERT: FORBIDDEN đúng quyền (getStats=DASHBOARD_VIEW,
// getMonthlyProfit=CASHENTRY_VIEW), và cấu trúc dữ liệu (12 tháng, lợi nhuận = doanh thu − chi).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { getStats, getMonthlyProfit } from '../src/index.js';

function makeFakeDb(over: Partial<Record<string, unknown>> = {}) {
  // FIX-PERF B132: getStats nay dùng groupBy (tid theo bank / pos theo status) + $queryRawUnsafe (12 tháng) thay
  // findMany + tally JS. Fake mặc định trả rỗng → tidsByBank/posByStatus [] + monthly 12 ô = 0.
  const counter = { count: async () => 0, findMany: async () => [] as unknown[], groupBy: async () => [] as unknown[] };
  const fake = {
    tid: { ...counter },
    customer: { ...counter },
    posDevice: { ...counter },
    dossier: { count: async () => 0 },
    user: { count: async () => 3 },
    bank: { count: async () => 0, findMany: async () => [] },
    partner: { count: async () => 0 },
    cashCategory: { findMany: async () => [{ id: 1 }] },
    transaction: { aggregate: async () => ({ _sum: { revenueAmount: 1000n } }) },
    cashEntry: { aggregate: async ({ where }: { where: { kind: string } }) => ({ _sum: { amount: where.kind === 'THU' ? 500n : 200n } }) },
    // [GÓI TZ 11/9] computeMonthProfit sum revenue qua raw — stub đúng shape (SUM → [{s}], khác → []).
    $queryRawUnsafe: async (sql: string) => (sql.includes('SUM(revenue_amount)') ? [{ s: 1000n }] : []) as unknown[],
    ...over
  };
  return { db: fake as unknown as Db };
}

function authUser(permissions: string[]): AuthUser {
  return { id: 1, username: 'admin', fullName: 'Admin', status: 'ACTIVE', forceChangePassword: false, roles: ['ADMIN'], permissions };
}

describe('getStats', () => {
  it('thiếu quyền DASHBOARD_VIEW → FORBIDDEN nguyên văn', async () => {
    const r = await getStats({ db: makeFakeDb().db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('có quyền → counts + monthly 12 tháng', async () => {
    const r = await getStats({ db: makeFakeDb().db, user: authUser(['DASHBOARD_VIEW']) });
    expect(r.ok).toBe(true);
    expect(r.data!.counts.users).toBe(3);
    expect(r.data!.monthly).toHaveLength(12);
  });

  it('FIX-PERF B132: tidsByBank/posByStatus dựng từ groupBy (KHÔNG tally full-bảng) + monthly từ $queryRawUnsafe', async () => {
    const db = makeFakeDb({
      // groupBy TID theo bankId: bank#1 = 3 TID, bank#2 = 1 TID.
      tid: { count: async () => 4, groupBy: async () => [{ bankId: 1, _count: { _all: 3 } }, { bankId: 2, _count: { _all: 1 } }] },
      bank: { count: async () => 0, findMany: async () => [{ id: 1, code: 'VPB', name: 'VPBank' }, { id: 2, code: 'ACB', name: 'ACB' }] },
      // groupBy POS theo status: DEPLOYED 5, IN_STOCK 2.
      posDevice: { count: async () => 7, groupBy: async () => [{ status: 'DEPLOYED', _count: { _all: 5 } }, { status: 'IN_STOCK', _count: { _all: 2 } }] },
      // $queryRawUnsafe (1 hàng 12 cột m0..m11): dồn hết vào tháng hiện tại (m11) để assert map đúng ô.
      $queryRawUnsafe: async () => [{ m0: 0, m1: 0, m2: 0, m3: 0, m4: 0, m5: 0, m6: 0, m7: 0, m8: 0, m9: 0, m10: 0, m11: 9 }]
    }).db;
    const r = await getStats({ db, user: authUser(['DASHBOARD_VIEW']) });
    expect(r.ok).toBe(true);
    // Sắp giảm dần theo count; nhãn = code ngân hàng.
    expect(r.data!.tidsByBank).toEqual([{ label: 'VPB', count: 3 }, { label: 'ACB', count: 1 }]);
    expect(r.data!.posByStatus).toEqual([{ label: 'Đã triển khai', count: 5 }, { label: 'Trong kho', count: 2 }]);
    // Ô cuối (tháng hiện tại) = 9 cho cả tids lẫn customers (cùng $queryRawUnsafe fake).
    expect(r.data!.monthly[11]!.tids).toBe(9);
    expect(r.data!.monthly[11]!.customers).toBe(9);
    expect(r.data!.monthly[0]!.tids).toBe(0);
  });
});

describe('getMonthlyProfit', () => {
  it('thiếu quyền CASHENTRY_VIEW → FORBIDDEN', async () => {
    const r = await getMonthlyProfit({ db: makeFakeDb().db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('có quyền → profit = (revenueAmount + THU) − CHI', async () => {
    const r = await getMonthlyProfit({ db: makeFakeDb().db, user: authUser(['CASHENTRY_VIEW']) });
    expect(r.ok).toBe(true);
    // revenueAccrual = 1000 + 500 = 1500; expense = 200; profit = 1300
    expect(r.data!.current.revenueAccrual).toBe(1500);
    expect(r.data!.current.expense).toBe(200);
    expect(r.data!.current.profit).toBe(1300);
  });
});
