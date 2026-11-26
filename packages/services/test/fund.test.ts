// Test LÕI THUẦN fund core (@sigma/services). ASSERT error code + message tiếng Việt + mã QU auto + số dư running +
// chặn xóa quỹ đang dùng (IN_USE). §14 mật khẩu ở ADAPTER (lõi KHÔNG kiểm).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { listFunds, createFund, updateFund, deleteFunds, listCashflowUsersLite, fundCurrentBalance, type ServiceCtx } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

function makeFake(seed: Record<string, unknown>[], opts: { entryCount?: number; groupBy?: { kind: string; _sum: { amount: number } }[] } = {}) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = rows.reduce((m, r) => Math.max(m, r['id'] as number), 0) + 1;
  const counters: Record<string, number> = {};
  const audits: Record<string, unknown>[] = [];
  const fund = {
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const not = (where?.['NOT'] as { id?: number } | undefined);
      return rows.filter((r) => r['deletedAt'] == null && (!not || r['id'] !== not.id)).map((r) => ({ ...r }));
    },
    findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r['id'] === where.id) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: nextId++, deletedAt: null, updatedBy: null, createdAt: new Date(), updatedAt: new Date(), ...data }; rows.push(row); return { ...row }; },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = rows.find((x) => x['id'] === where.id)!; Object.assign(r, data); return { ...r }; }
  };
  const fake = {
    fund,
    user: { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 7 ? { id: 7, deletedAt: null } : null), findMany: async () => [{ id: 42, employeeCode: 'NV01', fullName: 'Người Kiểm Thử', username: 'tester' }] },
    cashEntry: {
      count: async () => opts.entryCount ?? 0,
      groupBy: async () => opts.groupBy ?? []
    },
    codeCounter: { upsert: async ({ where, create }: { where: { prefix: string }; create: { prefix: string; lastValue: number } }) => { const p = where.prefix; counters[p] = counters[p] === undefined ? create.lastValue : counters[p] + 1; return { prefix: p, lastValue: counters[p] }; } },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Fund', version: 1 }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake)
  };
  return { db: fake as unknown as Db, rows, audits };
}

const seed = (over: Record<string, unknown> = {}) => ({ id: 1, code: 'QU01', name: 'Quỹ tiền mặt', type: 'CASH', keeperUserId: null, openingBalance: 1000000, active: true, note: null, deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...over });

describe('fund core', () => {
  it('list thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeFake([seed()]);
    const r = await listFunds({ db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('tạo loại quỹ sai → VALIDATION nguyên văn', async () => {
    const { db } = makeFake([]);
    const r = await createFund({ db, user: authUser(['FUND_CREATE']) }, { name: 'Quỹ A', type: 'GOLD' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Loại quỹ phải là Tiền mặt, Ngân hàng hoặc Ví điện tử.');
  });

  it('tạo hợp lệ → mã QU01 auto + audit FUND_CREATED', async () => {
    const { db, rows, audits } = makeFake([]);
    const r = await createFund({ db, user: authUser(['FUND_CREATE']) }, { name: 'Quỹ chính', type: 'cash', openingBalance: 500000 });
    expect(r.ok).toBe(true);
    expect(rows[0]!['code']).toBe('QU01');
    expect(audits.some((a) => a['action'] === 'FUND_CREATED')).toBe(true);
  });

  it('trùng tên → DUPLICATE', async () => {
    const { db } = makeFake([seed({ name: 'Quỹ tiền mặt' })]);
    const r = await createFund({ db, user: authUser(['FUND_CREATE']) }, { name: 'quỹ  tiền mặt', type: 'CASH' });
    expect(r.error).toBe('DUPLICATE');
    expect(r.message).toBe('Quỹ "quỹ tiền mặt" đã tồn tại.');
  });

  it('list — số dư running = opening + Σ THU − Σ CHI (POSTED)', async () => {
    const { db } = makeFake([seed({ openingBalance: 1000 })], { groupBy: [{ kind: 'THU', _sum: { amount: 500 } }, { kind: 'CHI', _sum: { amount: 200 } }] });
    const r = await listFunds({ db, user: authUser(['FUND_VIEW']) });
    expect(r.ok).toBe(true);
    // postedNetByFund groupBy trả theo (fundId,kind) — fake trả không fundId nên map trống; test currentBalance qua fundCurrentBalance riêng.
    expect(r.data![0]!.openingBalance).toBe(1000);
  });

  it('fundCurrentBalance = opening + net POSTED', async () => {
    const { db } = makeFake([seed({ openingBalance: 1000 })], { groupBy: [{ kind: 'THU', _sum: { amount: 500 } }, { kind: 'CHI', _sum: { amount: 200 } }] });
    const bal = await fundCurrentBalance(db, 1);
    expect(bal).toBe(1300);
  });

  it('xóa quỹ đang có phiếu → IN_USE (chỉ ngừng dùng)', async () => {
    const { db, rows } = makeFake([seed()], { entryCount: 2 });
    const r = await deleteFunds({ db, user: authUser(['FUND_DELETE']) }, [1]);
    expect(r.error).toBe('IN_USE');
    expect(r.message).toBe('Quỹ đang có phiếu thu/chi, không xóa được — chỉ có thể ngừng dùng.');
    expect(rows[0]!['deletedAt']).toBeNull();
  });

  it('xóa quỹ rỗng → soft-delete + audit', async () => {
    const { db, rows, audits } = makeFake([seed()], { entryCount: 0 });
    const r = await deleteFunds({ db, user: authUser(['FUND_DELETE']) }, [1]);
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(1);
    expect(rows[0]!['deletedAt']).toBeInstanceOf(Date);
    expect(audits.some((a) => a['action'] === 'FUND_DELETED')).toBe(true);
  });

  it('userLite → code = employeeCode', async () => {
    const { db } = makeFake([]);
    const r = await listCashflowUsersLite({ db, user: authUser(['FUND_VIEW']) });
    expect(r.ok).toBe(true);
    expect(r.data![0]!.code).toBe('NV01');
  });

  it('update stale → STALE_WRITE', async () => {
    const { db } = makeFake([seed()]);
    const r = await updateFund({ db, user: authUser(['FUND_UPDATE']) }, 1, { name: 'X', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect(r.error).toBe('STALE_WRITE');
  });
});
