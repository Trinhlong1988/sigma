// Test PHÂN QUYỀN + DATA-SCOPE Nhà đầu tư (Phase D, @sigma/services) — Db GIẢ in-memory + ServiceCtx. Kiểm:
//  (a) user REVENUE_VIEW (staff) → xem MỌI NĐT (không scope), lọc theo investorId param bình thường;
//  (b) user INVESTOR_SELF_VIEW gắn NĐT X → CHỈ ra X, DÙ client truyền investorId=Y (ép ghi đè — chống rò NĐT khác);
//  (c) user INVESTOR_SELF_VIEW KHÔNG gắn NĐT → rỗng data:[] (hợp lệ, KHÔNG lỗi);
//  (d) user KHÔNG quyền nào → FORBIDDEN;
//  + resolveOwnInvestorId trực tiếp; + scope áp cả cho tất toán (settlement tái dùng report).
// BigInt: amount seed literal `…n` (bài học mock bigint 1000n, KHÔNG number) — chống mock sai shape.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { investorDailyReport, investorDailySettlement, resolveOwnInvestorId, type ServiceCtx } from '../src/index.js';
// Db GIẢ dùng chung (matchWhere in/not/gte/lt + guard Date · table findMany/findFirst · rawStub $queryRawUnsafe) —
// gom về 1 factory (bài học 27/8: raw-SQL migrate làm fake-Db tự-chế thiếu method → test rơi im). Xem _fake-db.ts.
import { table, rawStub, type Rec } from './_fake-db.js';

const REVENUE = 'REVENUE_VIEW'; // staff xem tất cả
const SELF = 'INVESTOR_SELF_VIEW'; // user NĐT xem của mình
function authUser(id: number, permissions: string[]): AuthUser {
  return { id, username: 'u' + id, fullName: 'User ' + id, status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

const d = (day: number, month = 7) => new Date(2026, month, day); // month 7 = Tháng 8 (0-based)

// NĐT 1 (INV01) gắn user 100; NĐT 2 (INV02) KHÔNG gắn ai. Mỗi NĐT 1 TID uỷ + 1 giao dịch trong kỳ.
function seedDb() {
  const investors: Rec[] = [
    { id: 1, code: 'INV01', nickname: 'NĐT A', fullName: 'Nguyen A', status: 'ACTIVE', investFeeMilli: 100, settleFeeMilli: 0, userId: 100, deletedAt: null },
    { id: 2, code: 'INV02', nickname: 'NĐT B', fullName: 'Tran B', status: 'ACTIVE', investFeeMilli: 200, settleFeeMilli: 0, userId: null, deletedAt: null }
  ];
  const receiveAccounts: Rec[] = [
    { id: 11, investorId: 1, deletedAt: null },
    { id: 12, investorId: 2, deletedAt: null }
  ];
  const tids: Rec[] = [
    { id: 101, receiveAccountId: 11, investFeeMilli: null }, // NĐT A, 0.1%
    { id: 102, receiveAccountId: 12, investFeeMilli: null } // NĐT B, 0.2%
  ];
  // phiCaiMayMilli: 0 → tiền về = gross → lãi = 0.1% × gross (khớp kỳ vọng laiNDT=100k của NĐT A trên 100tr).
  const transactions: Rec[] = [
    { id: 1001, tidId: 101, amount: 100_000_000n, phiCaiMayMilli: 0, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(10) }, // A → lãi 100k
    { id: 1002, tidId: 102, amount: 200_000_000n, phiCaiMayMilli: 0, settled: true, status: 'POSTED', deletedAt: null, txnDate: d(11) } // B → lãi 400k
  ];
  const investorAdvances: Rec[] = [
    { id: 2001, investorId: 1, amount: 30_000_000n, advanceDate: d(10), deletedAt: null },
    { id: 2002, investorId: 2, amount: 90_000_000n, advanceDate: d(11), deletedAt: null }
  ];
  // Tài khoản đăng nhập — resolveOwnInvestorId nhánh (2): tài khoản CON (users.investor_id trỏ NĐT cha). Seed
  // KHÔNG có tài khoản con nào (chỉ chủ NĐT gắn qua investor.userId) → user 100 investorId null; user 555 vắng
  // mặt → findUnique trả null → resolveOwnInvestorId trả null (không gắn NĐT).
  const users: Rec[] = [{ id: 100, investorId: null }];
  return {
    investor: table(investors, true),
    receiveAccount: table(receiveAccounts),
    tid: table(tids),
    transaction: table(transactions),
    investorAdvance: table(investorAdvances),
    user: { findUnique: async (args?: { where?: { id?: number } }) => users.find((u) => u['id'] === args?.where?.id) ?? null },
    $queryRawUnsafe: rawStub(transactions, investorAdvances)
  } as Rec;
}
const ctx = (fake: Rec, id: number, perms: string[]): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(id, perms) });
const KY = { from: '2026-08-01', to: '2026-08-31' };

describe('resolveOwnInvestorId', () => {
  it('user gắn NĐT → trả investorId', async () => {
    const id = await resolveOwnInvestorId(ctx(seedDb(), 100, [SELF]));
    expect(id).toBe(1);
  });
  it('user KHÔNG gắn NĐT → null', async () => {
    const id = await resolveOwnInvestorId(ctx(seedDb(), 555, [SELF]));
    expect(id).toBeNull();
  });
});

describe('investorDailyReport — phân quyền + data-scope (Phase D)', () => {
  it('(a) staff REVENUE_VIEW → xem MỌI NĐT (không scope)', async () => {
    const r = await investorDailyReport(ctx(seedDb(), 999, [REVENUE]), KY);
    expect(r.ok).toBe(true);
    expect(r.data!.map((x) => x.code)).toEqual(['INV01', 'INV02']);
  });

  it('(a2) staff REVENUE_VIEW + investorId=2 → lọc đúng NĐT B (param được tôn trọng)', async () => {
    const r = await investorDailyReport(ctx(seedDb(), 999, [REVENUE]), { ...KY, investorId: 2 });
    expect(r.data!.map((x) => x.code)).toEqual(['INV02']);
  });

  it('(b) user INVESTOR_SELF_VIEW gắn NĐT 1 → CHỈ INV01 DÙ truyền investorId=2 (ép ghi đè, chống rò)', async () => {
    const r = await investorDailyReport(ctx(seedDb(), 100, [SELF]), { ...KY, investorId: 2 });
    expect(r.ok).toBe(true);
    expect(r.data!.map((x) => x.code)).toEqual(['INV01']); // KHÔNG phải INV02
    expect(r.data![0].laiNDT).toBe(100_000); // đúng số của NĐT A (100tr × 0.1%)
  });

  it('(b2) user INVESTOR_SELF_VIEW không truyền investorId → vẫn CHỈ của mình (INV01), không phải mọi NĐT', async () => {
    const r = await investorDailyReport(ctx(seedDb(), 100, [SELF]), KY);
    expect(r.data!.map((x) => x.code)).toEqual(['INV01']);
  });

  it('(c) user INVESTOR_SELF_VIEW KHÔNG gắn NĐT → rỗng data:[] (không lỗi)', async () => {
    const r = await investorDailyReport(ctx(seedDb(), 555, [SELF]), KY);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('(d) user KHÔNG quyền nào → FORBIDDEN', async () => {
    const r = await investorDailyReport(ctx(seedDb(), 100, []), KY);
    expect(r.error).toBe('FORBIDDEN');
  });
});

describe('investorDailySettlement — phân quyền + data-scope (Phase D)', () => {
  it('(b) user INVESTOR_SELF_VIEW gắn NĐT 1 → tất toán CHỈ INV01 DÙ truyền investorId=2', async () => {
    const r = await investorDailySettlement(ctx(seedDb(), 100, [SELF]), { ...KY, investorId: 2 });
    expect(r.ok).toBe(true);
    expect(r.data!.map((x) => x.code)).toEqual(['INV01']);
    expect(r.data![0].tamUng).toBe(30_000_000); // tạm ứng của NĐT A, KHÔNG lẫn 90tr của NĐT B
  });

  it('(c) user INVESTOR_SELF_VIEW KHÔNG gắn NĐT → tất toán rỗng', async () => {
    const r = await investorDailySettlement(ctx(seedDb(), 555, [SELF]), KY);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('(d) user KHÔNG quyền nào → FORBIDDEN', async () => {
    const r = await investorDailySettlement(ctx(seedDb(), 100, []), KY);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('(a) staff REVENUE_VIEW → tất toán MỌI NĐT', async () => {
    const r = await investorDailySettlement(ctx(seedDb(), 999, [REVENUE]), KY);
    expect(r.data!.map((x) => x.code)).toEqual(['INV01', 'INV02']);
  });
});
