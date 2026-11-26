// Test DATA-SCOPE "Kế toán NĐT" (Admin Demo 24/11, @sigma/services) — Db GIẢ in-memory + ServiceCtx. Kiểm LÕI:
//  • resolveScopeInvestorId: có users.scope_investor_id + NĐT còn sống → trả id; NĐT xóa mềm → null; không khóa → null.
//  • scopeReceiveAccountIds / scopeTidIds / scopeTidStrings: đúng tập thuộc NĐT scope.
//  • investorDailyReport: user có REVENUE_VIEW (xem-tất) NHƯNG bị khóa phạm vi → ÉP về NĐT scope, DÙ truyền
//    investorId của NĐT khác (chống rò — đây là điểm khác R_INVESTOR: scope ĐỘC LẬP permission).
// Lọc thật ở tầng route (bill-manual/catalog) kiểm bằng harness DB thật scripts/test-ketoan-ndt.mts; file này chốt LÕI.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  investorDailyReport, resolveScopeInvestorId, scopeReceiveAccountIds, scopeTidIds, scopeTidStrings, type ServiceCtx
} from '../src/index.js';
import { table, type Rec } from './_fake-db.js';

const REVENUE = 'REVENUE_VIEW';
function authUser(id: number, permissions: string[]): AuthUser {
  return { id, username: 'u' + id, fullName: 'U' + id, status: 'ACTIVE', forceChangePassword: false, roles: ['R_KETOAN_NDT'], permissions };
}
const d = (day: number) => new Date(2026, 10, day); // Tháng 11 (0-based 10)

// NĐT A(1) gắn user 100 qua scope_investor_id; NĐT B(2) không khóa ai. NĐT C(3) đã xóa mềm (test fail-closed).
function seedDb(scopeByUser: Record<number, number | null>) {
  const investors: Rec[] = [
    { id: 1, code: 'INVA', nickname: 'NĐT A', fullName: 'A', status: 'ACTIVE', investFeeMilli: 100, settleFeeMilli: 0, userId: null, deletedAt: null },
    { id: 2, code: 'INVB', nickname: 'NĐT B', fullName: 'B', status: 'ACTIVE', investFeeMilli: 200, settleFeeMilli: 0, userId: null, deletedAt: null },
    { id: 3, code: 'INVC', nickname: 'NĐT C', fullName: 'C', status: 'ACTIVE', investFeeMilli: 100, settleFeeMilli: 0, userId: null, deletedAt: d(1) }
  ];
  const receiveAccounts: Rec[] = [
    { id: 11, investorId: 1, deletedAt: null },
    { id: 12, investorId: 2, deletedAt: null }
  ];
  const tids: Rec[] = [
    { id: 101, tid: 'TID_A_0', receiveAccountId: 11, investFeeMilli: null, bankId: null },
    { id: 102, tid: 'TID_A_1', receiveAccountId: 11, investFeeMilli: null, bankId: null },
    { id: 201, tid: 'TID_B_0', receiveAccountId: 12, investFeeMilli: null, bankId: null }
  ];
  const transactions: Rec[] = [
    { id: 1001, tidId: 101, amount: 100_000_000n, phiCaiMayMilli: 0, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(10) },
    { id: 2001, tidId: 201, amount: 500_000_000n, phiCaiMayMilli: 0, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(11) }
  ];
  const rawStubScope = async (sql: string, ...params: unknown[]) => {
    if (sql.includes('scope_investor_id')) {
      const uid = params[0] as number;
      return [{ scope_investor_id: scopeByUser[uid] ?? null }];
    }
    if (sql.includes('investor_advances')) return [];
    const tidIds = params[0] as number[];
    const start = new Date(params[1] as string).getTime();
    const end = new Date(params[2] as string).getTime();
    return transactions
      .filter((t) => t['status'] === 'POSTED' && t['deletedAt'] == null && tidIds.includes(t['tidId'] as number)
        && (t['txnDate'] as Date).getTime() >= start && (t['txnDate'] as Date).getTime() < end)
      .map((t) => ({ tidId: t['tidId'], amount: t['amount'], settled: t['settled'], phiCaiMayMilli: 0, txnDate: t['txnDate'], txnIso: (t['txnDate'] as Date).toISOString() }));
  };
  return {
    investor: table(investors, true),
    receiveAccount: table(receiveAccounts),
    tid: table(tids),
    transaction: table(transactions),
    investorAdvance: table([]),
    user: { findUnique: async () => null },
    $queryRawUnsafe: rawStubScope
  } as Rec;
}
const ctx = (fake: Rec, id: number, perms: string[]): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(id, perms) });
const KY = { from: '2026-11-01', to: '2026-11-30' };

describe('resolveScopeInvestorId', () => {
  it('user khóa NĐT A (còn sống) → trả 1', async () => {
    expect(await resolveScopeInvestorId(ctx(seedDb({ 100: 1 }), 100, [REVENUE]))).toBe(1);
  });
  it('user KHÔNG khóa phạm vi → null (staff)', async () => {
    expect(await resolveScopeInvestorId(ctx(seedDb({ 100: null }), 100, [REVENUE]))).toBeNull();
  });
  it('user khóa về NĐT đã XÓA MỀM (C=3) → null (fail-closed, không khóa về NĐT chết)', async () => {
    expect(await resolveScopeInvestorId(ctx(seedDb({ 100: 3 }), 100, [REVENUE]))).toBeNull();
  });
});

describe('scope set helpers', () => {
  it('scopeReceiveAccountIds(A) = {11}', async () => {
    const s = await scopeReceiveAccountIds(ctx(seedDb({}), 100, [REVENUE]), 1);
    expect([...s].sort()).toEqual([11]);
  });
  it('scopeTidIds(A) = {101,102}; scopeTidStrings(A) = {TID_A_0,TID_A_1}', async () => {
    const ids = await scopeTidIds(ctx(seedDb({}), 100, [REVENUE]), 1);
    const strs = await scopeTidStrings(ctx(seedDb({}), 100, [REVENUE]), 1);
    expect([...ids].sort((a, b) => a - b)).toEqual([101, 102]);
    expect([...strs].sort()).toEqual(['TID_A_0', 'TID_A_1']);
  });
  it('scopeTidIds(B) = {201} (không lẫn TID của A)', async () => {
    const ids = await scopeTidIds(ctx(seedDb({}), 100, [REVENUE]), 2);
    expect([...ids]).toEqual([201]);
  });
});

describe('investorDailyReport — scope ÉP ghi đè quyền xem-tất', () => {
  it('user REVENUE_VIEW + khóa A, truyền investorId=B → CHỈ ra NĐT A (chống rò)', async () => {
    const r = await investorDailyReport(ctx(seedDb({ 100: 1 }), 100, [REVENUE]), { ...KY, investorId: 2 });
    expect(r.ok).toBe(true);
    expect(r.data?.length).toBe(1);
    expect(r.data?.[0]?.code).toBe('INVA');
    expect(r.data?.[0]?.doanhThu).toBe(100_000_000); // chỉ GD của A, KHÔNG phải 500tr của B
  });
  it('user REVENUE_VIEW KHÔNG khóa → tôn trọng investorId=B (staff bình thường)', async () => {
    const r = await investorDailyReport(ctx(seedDb({ 100: null }), 100, [REVENUE]), { ...KY, investorId: 2 });
    expect(r.ok).toBe(true);
    expect(r.data?.length).toBe(1);
    expect(r.data?.[0]?.code).toBe('INVB');
    expect(r.data?.[0]?.doanhThu).toBe(500_000_000);
  });
});
