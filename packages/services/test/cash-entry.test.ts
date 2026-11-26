// Test LÕI THUẦN cash-entry core (@sigma/services) — Db GIẢ in-memory. ASSERT: validate tiền VND + danh mục, tx tạo
// phiếu (mã PT/PC + audit), Thu công nợ NET-OF-SETTLEMENT (DEBT_OVERPAY + settled toggle = PnL), hủy SOURCE_LOCKED +
// POSTED→CANCELLED gỡ settlement. §14 mật khẩu (hủy) ở ADAPTER — lõi KHÔNG kiểm. Message tiếng Việt nguyên văn.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { listCashEntries, createCashEntry, createDebtReceipt, cancelCashEntry, type ServiceCtx } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 9, username: 'tester', fullName: 'KT', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
function ctxOf(fake: Record<string, unknown>, perms: string[]): ServiceCtx {
  return { db: fake as unknown as Db, user: authUser(perms) };
}
const VIEW = 'CASHENTRY_VIEW', CREATE = 'CASHENTRY_CREATE', CANCEL = 'CASHENTRY_CANCEL';

function base() {
  const audits: Record<string, unknown>[] = [];
  const counters = new Map<string, number>();
  const fake: Record<string, unknown> = {
    user: { findMany: async () => [], findUnique: async ({ where }: { where: { id: number } }) => ({ id: where.id, deletedAt: null }) },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({}) },
    codeCounter: { upsert: async ({ where }: { where: { prefix: string } }) => { const n = (counters.get(where.prefix) ?? 0) + 1; counters.set(where.prefix, n); return { prefix: where.prefix, lastValue: n }; } }
  };
  return { fake, audits };
}

describe('createCashEntry — validate + tx', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const { fake } = base();
    fake.cashEntry = { findMany: async () => [] };
    const r = await listCashEntries(ctxOf(fake, []));
    expect(r.error).toBe('FORBIDDEN');
  });

  it('thiếu quỹ → VALIDATION', async () => {
    const { fake } = base();
    const r = await createCashEntry(ctxOf(fake, [CREATE]), { kind: 'THU', categoryId: 1, fundId: null as unknown as number, amount: 100, method: 'CASH', entryDate: '2026-01-01' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Vui lòng chọn quỹ.');
  });

  it('số tiền âm → VALIDATION số nguyên dương', async () => {
    const { fake } = base();
    fake.fund = { findUnique: async () => ({ id: 1, deletedAt: null }) };
    const r = await createCashEntry(ctxOf(fake, [CREATE]), { kind: 'THU', categoryId: 1, fundId: 1, amount: -5, method: 'CASH', entryDate: '2026-01-01' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Số tiền phải là số nguyên dương (VND).');
  });

  it('danh mục công nợ → DEBT_RECEIPT_DEFERRED', async () => {
    const { fake } = base();
    fake.fund = { findUnique: async () => ({ id: 1, deletedAt: null }) };
    fake.cashCategory = { findUnique: async () => ({ id: 1, kind: 'THU', active: true, deletedAt: null, sourceKind: 'DEBT_CUSTOMER' }) };
    const r = await createCashEntry(ctxOf(fake, [CREATE]), { kind: 'THU', categoryId: 1, fundId: 1, amount: 100, method: 'CASH', entryDate: '2026-01-01' });
    expect(r.error).toBe('DEBT_RECEIPT_DEFERRED');
  });

  it('phiếu CHI thiếu người chi → PAYER_REQUIRED', async () => {
    const { fake } = base();
    fake.fund = { findUnique: async () => ({ id: 1, deletedAt: null }) };
    fake.cashCategory = { findUnique: async () => ({ id: 1, kind: 'CHI', active: true, deletedAt: null, sourceKind: 'SALARY' }) };
    const r = await createCashEntry(ctxOf(fake, [CREATE]), { kind: 'CHI', categoryId: 1, fundId: 1, amount: 100, method: 'CASH', entryDate: '2026-01-01' });
    expect(r.error).toBe('PAYER_REQUIRED');
  });

  it('hợp lệ → ok + mã PT + audit CASH_ENTRY_CREATED (trong tx)', async () => {
    const { fake, audits } = base();
    const entries: Record<string, unknown>[] = [];
    fake.fund = { findUnique: async () => ({ id: 1, deletedAt: null }) };
    fake.cashCategory = { findUnique: async () => ({ id: 1, kind: 'THU', active: true, deletedAt: null, sourceKind: 'MANUAL' }) };
    fake.cashEntry = { create: async ({ data }: { data: Record<string, unknown> }) => { const e = { id: 1, ...data }; entries.push(e); return e; } };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(fake);
    const r = await createCashEntry(ctxOf(fake, [CREATE]), { kind: 'THU', categoryId: 1, fundId: 1, amount: 100, method: 'CASH', entryDate: '2026-01-01' });
    expect(r.ok).toBe(true);
    expect(entries[0]!.code).toBe('PT01');
    expect(entries[0]!.status).toBe('POSTED');
    expect(audits.some((a) => a['action'] === 'CASH_ENTRY_CREATED')).toBe(true);
  });
});

// Fake settlement store hỗ trợ groupBy (net-of-settlement) cho Thu công nợ.
function debtFake(txn: { id: number; revenuePartner: number; revenueSell: number; customerId: number; tidId: number; status?: string; settled?: boolean; writtenOffAt?: Date | null }) {
  const { fake, audits } = base();
  const settlements: { transactionId: number; side: string; amount: number }[] = [];
  const txnRow = { deletedAt: null, status: 'POSTED', settled: false, writtenOffAt: null, ...txn };
  const txns = new Map<number, Record<string, unknown>>([[txn.id, txnRow]]);
  fake.fund = { findUnique: async () => ({ id: 1, deletedAt: null }) };
  fake.customer = { findUnique: async () => ({ id: txn.customerId, deletedAt: null }) };
  fake.partner = { findUnique: async () => ({ id: 1, deletedAt: null }) };
  fake.cashCategory = { findUnique: async () => ({ id: 1, kind: 'THU', active: true, deletedAt: null, sourceKind: 'DEBT_CUSTOMER' }) };
  fake.cashEntry = { create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 77, ...data }) };
  fake.transaction = {
    findMany: async ({ where }: { where: { id: { in: number[] } } }) => where.id.in.map((id) => txns.get(id)).filter(Boolean).map((t) => ({ ...t })),
    findUnique: async ({ where }: { where: { id: number } }) => { const t = txns.get(where.id); return t ? { ...t } : null; },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { Object.assign(txns.get(where.id)!, data); return {}; }
  };
  fake.tid = { findMany: async () => [] };
  fake.cashDebtSettlement = {
    create: async ({ data }: { data: { transactionId: number; side: string; amount: number } }) => { settlements.push({ ...data }); return { ...data }; },
    deleteMany: async ({ where }: { where: { cashEntryId?: number } }) => { const n = settlements.length; settlements.length = 0; return { count: n }; },
    findMany: async () => settlements.map((s) => ({ transactionId: s.transactionId })),
    groupBy: async ({ by, where }: { by: string[]; where: { transactionId?: { in: number[] } | number } }) => {
      const ids = where.transactionId && typeof where.transactionId === 'object' ? where.transactionId.in : where.transactionId != null ? [where.transactionId as number] : null;
      const filtered = settlements.filter((s) => !ids || ids.includes(s.transactionId));
      const groups = new Map<string, { key: Record<string, unknown>; sum: number }>();
      for (const s of filtered) {
        const key: Record<string, unknown> = {};
        for (const b of by) key[b] = (s as Record<string, unknown>)[b];
        const k = JSON.stringify(key);
        const g = groups.get(k) ?? { key, sum: 0 };
        g.sum += s.amount;
        groups.set(k, g);
      }
      return [...groups.values()].map((g) => ({ ...g.key, _sum: { amount: g.sum } }));
    }
  };
  fake.deviceSaleSettlement = { deleteMany: async () => ({ count: 0 }) };
  fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRawUnsafe: async () => [] });
  return { fake, audits, settlements, txns };
}

describe('createDebtReceipt — NET-OF-SETTLEMENT (PnL)', () => {
  it('thu vượt công nợ còn lại → DEBT_OVERPAY (rollback)', async () => {
    const { fake } = debtFake({ id: 1, revenuePartner: 0, revenueSell: 100, customerId: 5, tidId: 1 });
    const r = await createDebtReceipt(ctxOf(fake, [CREATE]), { categoryId: 1, fundId: 1, method: 'CASH', entryDate: '2026-01-01', customerId: 5, lines: [{ transactionId: 1, side: 'SELL', amount: 150 }] });
    expect(r.error).toBe('DEBT_OVERPAY');
    expect(r.message).toContain('còn 100 đ');
  });

  it('thu đúng phần còn lại → ok + GD settled=true', async () => {
    const { fake, txns } = debtFake({ id: 1, revenuePartner: 0, revenueSell: 100, customerId: 5, tidId: 1 });
    const r = await createDebtReceipt(ctxOf(fake, [CREATE]), { categoryId: 1, fundId: 1, method: 'CASH', entryDate: '2026-01-01', customerId: 5, lines: [{ transactionId: 1, side: 'SELL', amount: 100 }] });
    expect(r.ok).toBe(true);
    expect(txns.get(1)!.settled).toBe(true);
  });

  it('danh mục DEBT_CUSTOMER nhưng khoản PARTNER → DEBT_SIDE_CATEGORY_MISMATCH', async () => {
    const { fake } = debtFake({ id: 1, revenuePartner: 100, revenueSell: 0, customerId: 5, tidId: 1 });
    const r = await createDebtReceipt(ctxOf(fake, [CREATE]), { categoryId: 1, fundId: 1, method: 'CASH', entryDate: '2026-01-01', customerId: 5, lines: [{ transactionId: 1, side: 'PARTNER', amount: 50 }] });
    expect(r.error).toBe('DEBT_SIDE_CATEGORY_MISMATCH');
  });
});

describe('cancelCashEntry — hủy nguyên tử + gỡ settlement', () => {
  it('phiếu hệ thống (sourceType≠null/SALE_COLLECT) → SOURCE_LOCKED', async () => {
    const { fake } = base();
    fake.cashEntry = { findUnique: async () => ({ id: 1, deletedAt: null, sourceType: 'DEVICE_DEPOSIT', code: 'PT01', kind: 'THU', amount: 100, status: 'POSTED' }) };
    const r = await cancelCashEntry(ctxOf(fake, [CANCEL]), 1, 'nhầm');
    expect(r.error).toBe('SOURCE_LOCKED');
  });

  it('thiếu lý do → VALIDATION', async () => {
    const { fake } = base();
    fake.cashEntry = { findUnique: async () => ({ id: 1, deletedAt: null, sourceType: null, status: 'POSTED' }) };
    const r = await cancelCashEntry(ctxOf(fake, [CANCEL]), 1, '   ');
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Vui lòng nhập lý do hủy phiếu.');
  });

  it('phiếu thủ công POSTED → CANCELLED + audit', async () => {
    const { fake, audits } = base();
    const row = { id: 1, deletedAt: null, sourceType: null, code: 'PT01', kind: 'THU', amount: 100, status: 'POSTED' };
    fake.cashEntry = { findUnique: async () => ({ ...row }), updateMany: async () => ({ count: 1 }) };
    fake.cashDebtSettlement = { findMany: async () => [] };
    fake.deviceSaleSettlement = { deleteMany: async () => ({ count: 0 }) };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(fake);
    const r = await cancelCashEntry(ctxOf(fake, [CANCEL]), 1, 'nhập nhầm số tiền');
    expect(r.ok).toBe(true);
    expect(audits.some((a) => a['action'] === 'CASH_ENTRY_CANCELLED')).toBe(true);
  });
});
