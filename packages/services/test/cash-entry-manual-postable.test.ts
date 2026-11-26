// REGRESSION — Money-F3 (chỉ MANUAL/SALARY lập phiếu tay được). Db GIẢ in-memory.
// Bug gốc (tái hiện DB thật): createCashEntry chỉ chặn DEBT_* → lập tay được vào SALE_POS/BAD_DEBT… phồng/giảm lợi
// nhuận. Sau vá: các sourceKind nghiệp-vụ trả CATEGORY_NOT_MANUAL; MANUAL/SALARY vẫn lập được. listEntryCategoriesLite
// gắn cờ `postable` (KHÔNG lọc bỏ DEBT — DebtPage đọc cùng endpoint).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { createCashEntry, listEntryCategoriesLite, type ServiceCtx } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 9, username: 'tester', fullName: 'KT', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
const VIEW = 'CASHENTRY_VIEW', CREATE = 'CASHENTRY_CREATE';

function base(cat: { kind: string; sourceKind: string }) {
  const counters = new Map<string, number>();
  const entries: any[] = [];
  const fake: any = {
    fund: { findUnique: async () => ({ id: 1, deletedAt: null }) },
    cashCategory: { findUnique: async () => ({ id: 1, kind: cat.kind, active: true, deletedAt: null, sourceKind: cat.sourceKind }) },
    user: { findUnique: async ({ where }: { where: { id: number } }) => ({ id: where.id, deletedAt: null }) },
    customer: { findUnique: async () => ({ id: 1, deletedAt: null }) },
    partner: { findUnique: async () => ({ id: 1, deletedAt: null }) },
    cashEntry: { create: async ({ data }: { data: any }) => { const e = { id: 1, ...data }; entries.push(e); return e; } },
    auditLog: { create: async () => ({}) },
    changeToken: { upsert: async () => ({}) },
    codeCounter: { upsert: async ({ where }: { where: { prefix: string } }) => { const n = (counters.get(where.prefix) ?? 0) + 1; counters.set(where.prefix, n); return { prefix: where.prefix, lastValue: n }; } },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake)
  };
  return { fake, entries };
}
const ctxOf = (fake: any, perms: string[]): ServiceCtx => ({ db: fake as Db, user: authUser(perms) });

describe('Money-F3 — createCashEntry allowlist danh mục lập tay', () => {
  it('SALE_POS (THU) → CATEGORY_NOT_MANUAL, KHÔNG tạo', async () => {
    const { fake, entries } = base({ kind: 'THU', sourceKind: 'SALE_POS' });
    const r = await createCashEntry(ctxOf(fake, [CREATE]), { kind: 'THU', categoryId: 1, fundId: 1, amount: 1000, method: 'CK', entryDate: '2026-08-11' });
    expect(r.error).toBe('CATEGORY_NOT_MANUAL');
    expect(entries.length).toBe(0);
  });
  it('BAD_DEBT (CHI) → CATEGORY_NOT_MANUAL', async () => {
    const { fake } = base({ kind: 'CHI', sourceKind: 'BAD_DEBT' });
    const r = await createCashEntry(ctxOf(fake, [CREATE]), { kind: 'CHI', categoryId: 1, fundId: 1, amount: 1000, method: 'CK', entryDate: '2026-08-11', payerUserId: 9 });
    expect(r.error).toBe('CATEGORY_NOT_MANUAL');
  });
  it('DEBT_CUSTOMER vẫn trả DEBT_RECEIPT_DEFERRED (không đổi thông điệp cũ)', async () => {
    const { fake } = base({ kind: 'THU', sourceKind: 'DEBT_CUSTOMER' });
    const r = await createCashEntry(ctxOf(fake, [CREATE]), { kind: 'THU', categoryId: 1, fundId: 1, amount: 1000, method: 'CK', entryDate: '2026-08-11' });
    expect(r.error).toBe('DEBT_RECEIPT_DEFERRED');
  });
  it('MANUAL (THU) → OK', async () => {
    const { fake, entries } = base({ kind: 'THU', sourceKind: 'MANUAL' });
    const r = await createCashEntry(ctxOf(fake, [CREATE]), { kind: 'THU', categoryId: 1, fundId: 1, amount: 1000, method: 'CK', entryDate: '2026-08-11' });
    expect(r.ok).toBe(true);
    expect(entries[0].status).toBe('POSTED');
  });
  it('SALARY (CHI, có người chi) → OK', async () => {
    const { fake } = base({ kind: 'CHI', sourceKind: 'SALARY' });
    const r = await createCashEntry(ctxOf(fake, [CREATE]), { kind: 'CHI', categoryId: 1, fundId: 1, amount: 1000, method: 'CK', entryDate: '2026-08-11', payerUserId: 9 });
    expect(r.ok).toBe(true);
  });
});

describe('Money-F3 — listEntryCategoriesLite gắn cờ postable', () => {
  it('postable=true chỉ cho MANUAL/SALARY; DEBT/SALE_POS vẫn có trong list nhưng postable=false', async () => {
    const rows = [
      { id: 1, kind: 'THU', name: 'DT khac', sourceKind: 'MANUAL', affectsPnl: true },
      { id: 2, kind: 'CHI', name: 'Chi luong', sourceKind: 'SALARY', affectsPnl: true },
      { id: 3, kind: 'THU', name: 'Cong no KH', sourceKind: 'DEBT_CUSTOMER', affectsPnl: false },
      { id: 4, kind: 'THU', name: 'Ban POS', sourceKind: 'SALE_POS', affectsPnl: true }
    ];
    const fake: any = { cashCategory: { findMany: async () => rows } };
    const r = await listEntryCategoriesLite(ctxOf(fake, [VIEW]));
    expect(r.ok).toBe(true);
    const byId = new Map(r.data!.map((d) => [d.id, d.postable]));
    expect(byId.get(1)).toBe(true);
    expect(byId.get(2)).toBe(true);
    expect(byId.get(3)).toBe(false); // DEBT vẫn có mặt (DebtPage cần) nhưng không postable
    expect(byId.get(4)).toBe(false);
    expect(r.data!.length).toBe(4); // KHÔNG lọc bỏ khỏi list
  });
});
