// REGRESSION — Money-F1 (trần %phí đầu tư NĐT) + Money-F2 (validate userId gán NĐT). Db GIẢ in-memory.
// Bug gốc (tái hiện trên DB thật): createInvestor/updateInvestor KHÔNG kẹp %phí → nhập 2 000 000% lưu thẳng
// (investFeeMilli=2 000 000 000) bơm lãi; updateInvestor set userId tùy ý → cướp user đã gắn NĐT khác / user không
// tồn tại / user xóa mềm. Sau vá: cả hai trả VALIDATION, KHÔNG chạm DB.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { createInvestor, updateInvestor, type ServiceCtx } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 9, username: 'actor', fullName: 'Actor', status: 'ACTIVE', forceChangePassword: false, roles: ['ADMIN'], permissions };
}
const CREATE = 'INVESTOR_CREATE', UPDATE = 'INVESTOR_UPDATE';

interface Inv { id: number; code: string; fullName: string; nickname: string; status: string; phone: string | null; email: string | null; address: string | null; investFeeMilli: number; userId: number | null; note: string | null; createdBy: number | null; createdAt: Date; updatedAt: Date; deletedAt: Date | null }
interface Usr { id: number; deletedAt: Date | null }

function makeDb(invs: Inv[], users: Usr[]) {
  const store = invs.map((r) => ({ ...r }));
  const created: Record<string, unknown>[] = [];
  let nextId = 1000;
  const db = {
    investor: {
      findFirst: async ({ where }: { where: Record<string, any> }) => {
        // nextInvestorCode: where.code.startsWith → mã kế tiếp; không có bản ghi INV → null (INV01).
        if (where.code) return null;
        // validateInvestorUserId dup: where.userId + deletedAt:null (+ NOT.id).
        const notId = (where.NOT as { id?: number } | undefined)?.id;
        const r = store.find((x) => x.userId === where.userId && x.deletedAt === null && (notId === undefined || x.id !== notId));
        return r ? { id: r.id } : null;
      },
      findUnique: async ({ where }: { where: { id: number } }) => { const r = store.find((x) => x.id === where.id); return r ? { ...r } : null; },
      create: async ({ data }: { data: Record<string, unknown> }) => { const r = { id: nextId++, ...data }; created.push(r); return r; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = store.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; }
    },
    user: { findUnique: async ({ where }: { where: { id: number } }) => { const u = users.find((x) => x.id === where.id); return u ? { id: u.id, deletedAt: u.deletedAt } : null; } },
    auditLog: { create: async () => ({}) },
    changeToken: { upsert: async () => ({}) },
    // ATOMIC (audit 20/8) — create/updateInvestor bọc mutation+audit trong $transaction; fake chạy thẳng với chính nó.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db)
  };
  return { db: db as unknown as Db, store, created };
}

function invRow(over: Partial<Inv> = {}): Inv {
  const now = new Date('2026-08-11T00:00:00.000Z');
  return { id: 1, code: 'INV01', fullName: 'A', nickname: 'a', status: 'ACTIVE', phone: null, email: null, address: null, investFeeMilli: 100, userId: null, note: null, createdBy: 9, createdAt: now, updatedAt: now, deletedAt: null, ...over };
}

describe('Money-F1 — trần %phí đầu tư (create/update investor)', () => {
  it('createInvestor 2 000 000% → VALIDATION, KHÔNG tạo bản ghi', async () => {
    const { db, created } = makeDb([], []);
    const r = await createInvestor({ db, user: authUser([CREATE]) }, { fullName: 'X', nickname: 'x', investFeePct: 2000000 });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('VALIDATION');
    expect(created.length).toBe(0);
  });
  it('createInvestor đúng trần 100% → OK (biên trên 100000 milli)', async () => {
    const { db, created } = makeDb([], []);
    const r = await createInvestor({ db, user: authUser([CREATE]) }, { fullName: 'X', nickname: 'x', investFeePct: 100 });
    expect(r.ok).toBe(true);
    expect((created[0] as any).investFeeMilli).toBe(100000);
  });
  it('createInvestor 100.001% (>trần) → VALIDATION', async () => {
    const { db } = makeDb([], []);
    const r = await createInvestor({ db, user: authUser([CREATE]) }, { fullName: 'X', nickname: 'x', investFeePct: 100.001 });
    expect(r.error).toBe('VALIDATION');
  });
  it('updateInvestor 99999% → VALIDATION, giữ nguyên investFeeMilli cũ', async () => {
    const { db, store } = makeDb([invRow({ investFeeMilli: 100 })], []);
    const r = await updateInvestor({ db, user: authUser([UPDATE]) }, 1, { investFeePct: 99999 });
    expect(r.error).toBe('VALIDATION');
    expect(store[0]!.investFeeMilli).toBe(100);
  });
});

describe('Money-F2 — validate userId gán NĐT (updateInvestor)', () => {
  it('gán userId đã thuộc NĐT khác → VALIDATION (1 user = 1 NĐT)', async () => {
    // NĐT #1 chưa gắn; NĐT #2 đã gắn user 5. Cập nhật #1.userId=5 phải bị chặn.
    const { db, store } = makeDb([invRow({ id: 1, userId: null }), invRow({ id: 2, code: 'INV02', userId: 5 })], [{ id: 5, deletedAt: null }]);
    const r = await updateInvestor({ db, user: authUser([UPDATE]) }, 1, { userId: 5 });
    expect(r.error).toBe('VALIDATION');
    expect(store[0]!.userId).toBe(null);
  });
  it('gán userId không tồn tại → VALIDATION', async () => {
    const { db } = makeDb([invRow({ id: 1 })], [{ id: 5, deletedAt: null }]);
    const r = await updateInvestor({ db, user: authUser([UPDATE]) }, 1, { userId: 999 });
    expect(r.error).toBe('VALIDATION');
  });
  it('gán userId đã xóa mềm → VALIDATION', async () => {
    const { db } = makeDb([invRow({ id: 1 })], [{ id: 5, deletedAt: new Date() }]);
    const r = await updateInvestor({ db, user: authUser([UPDATE]) }, 1, { userId: 5 });
    expect(r.error).toBe('VALIDATION');
  });
  it('gán userId hợp lệ (còn sống, chưa gắn ai) → OK', async () => {
    const { db, store } = makeDb([invRow({ id: 1 })], [{ id: 7, deletedAt: null }]);
    const r = await updateInvestor({ db, user: authUser([UPDATE]) }, 1, { userId: 7 });
    expect(r.ok).toBe(true);
    expect(store[0]!.userId).toBe(7);
  });
  it('gỡ gán userId=null → OK (không kiểm)', async () => {
    const { db, store } = makeDb([invRow({ id: 1, userId: 7 })], [{ id: 7, deletedAt: null }]);
    const r = await updateInvestor({ db, user: authUser([UPDATE]) }, 1, { userId: null });
    expect(r.ok).toBe(true);
    expect(store[0]!.userId).toBe(null);
  });
});
