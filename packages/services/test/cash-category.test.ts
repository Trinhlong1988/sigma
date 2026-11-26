// Test LÕI THUẦN cash-category core (@sigma/services) — Db GIẢ in-memory + ServiceCtx. ASSERT giá trị cụ thể:
// bất biến affectsPnl (I#12), khóa danh mục hệ thống, chống trùng tên trong loại, guard IN_USE, audit.
// §14 xác nhận MẬT KHẨU đã CHUYỂN RA ADAPTER (route) — lõi KHÔNG còn kiểm password (khuôn customer.ts).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { hashPassword } from '@sigma/business-rules';
import {
  listCashCategories,
  createCashCategory,
  updateCashCategory,
  deleteCashCategories,
  type ServiceCtx
} from '../src/index.js';

interface FakeCat {
  id: number; kind: string; name: string; unit: string | null; periodType: string | null; sourceKind: string;
  affectsPnl: boolean; isSystem: boolean; active: boolean;
  createdBy: number | null; createdAt: Date; updatedBy: number | null; updatedAt: Date; deletedAt: Date | null; deletedBy: number | null;
}

const PASSWORD = 'matkhau-dung-123';
const PW_HASH = hashPassword(PASSWORD);

function makeFakeDb(seed: FakeCat[], opts: { entryRefs?: Record<number, number> } = {}) {
  const cats = seed.map((c) => ({ ...c }));
  const audits: Record<string, unknown>[] = [];
  let nextId = cats.reduce((m, c) => Math.max(m, c.id), 0) + 1;

  const cashCategory = {
    findMany: async (args?: { where?: Record<string, unknown> }) => {
      const where = args?.where ?? {};
      let rows = cats.slice();
      if ('deletedAt' in where) rows = rows.filter((c) => c.deletedAt === (where['deletedAt'] ?? null));
      if (where['kind'] !== undefined) rows = rows.filter((c) => c.kind === where['kind']);
      if (where['sourceKind'] !== undefined) rows = rows.filter((c) => c.sourceKind === where['sourceKind']);
      if (where['active'] !== undefined) rows = rows.filter((c) => c.active === where['active']);
      const not = where['NOT'] as { id?: number } | undefined;
      if (not?.id !== undefined) rows = rows.filter((c) => c.id !== not.id);
      return rows.map((c) => ({ ...c })).sort((a, b) => a.id - b.id);
    },
    findUnique: async ({ where }: { where: { id: number } }) => {
      const c = cats.find((x) => x.id === where.id);
      return c ? { ...c } : null;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const now = new Date();
      const row: FakeCat = {
        id: nextId++, kind: data['kind'] as string, name: data['name'] as string, unit: (data['unit'] as string | null) ?? null,
        periodType: (data['periodType'] as string | null) ?? 'NONE', sourceKind: (data['sourceKind'] as string) ?? 'MANUAL',
        affectsPnl: (data['affectsPnl'] as boolean) ?? true, isSystem: (data['isSystem'] as boolean) ?? false, active: (data['active'] as boolean) ?? true,
        createdBy: (data['createdBy'] as number | null) ?? null, createdAt: now, updatedBy: null, updatedAt: now, deletedAt: null, deletedBy: null
      };
      cats.push(row);
      return { ...row };
    },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
      const c = cats.find((x) => x.id === where.id);
      if (!c) throw new Error('cat not found');
      Object.assign(c, data);
      return { ...c };
    }
  };

  const fake = {
    cashCategory,
    cashEntry: { count: async ({ where }: { where: { categoryId: number } }) => opts.entryRefs?.[where.categoryId] ?? 0 },
    user: {
      findMany: async () => [{ id: 42, fullName: 'Người Kiểm Thử', username: 'tester' }],
      findUnique: async ({ where }: { where: { id: number } }) => (where.id === 42 ? { passwordHash: PW_HASH } : null)
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'CashCategory', version: 1 }) }
  };
  return { db: fake as unknown as Db, cats, audits };
}

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

function seed(over: Partial<FakeCat> = {}): FakeCat {
  const now = new Date('2026-01-01T00:00:00.000Z');
  return { id: 1, kind: 'THU', name: 'Doanh thu bán hàng', unit: null, periodType: 'NONE', sourceKind: 'MANUAL', affectsPnl: true, isSystem: false, active: true, createdBy: 42, createdAt: now, updatedBy: null, updatedAt: now, deletedAt: null, deletedBy: null, ...over };
}

describe('listCashCategories', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeFakeDb([seed()]);
    const r = await listCashCategories({ db, user: authUser([]) }, {});
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });
  it('có quyền → data + trail', async () => {
    const { db } = makeFakeDb([seed()]);
    const r = await listCashCategories({ db, user: authUser(['CASHCAT_VIEW']) }, {});
    expect(r.ok).toBe(true);
    expect(r.data![0]!.name).toBe('Doanh thu bán hàng');
    expect(r.data![0]!.createdByName).toBe('Người Kiểm Thử');
  });
});

describe('createCashCategory', () => {
  it('kind sai → VALIDATION nguyên văn', async () => {
    const { db } = makeFakeDb([]);
    const r = await createCashCategory({ db, user: authUser(['CASHCAT_CREATE']) }, { kind: 'XXX', name: 'A' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Loại danh mục phải là THU hoặc CHI.');
  });

  it('affectsPnl=true trên nguồn nội bộ → PNL_FLAG_FORBIDDEN', async () => {
    const { db } = makeFakeDb([]);
    const r = await createCashCategory({ db, user: authUser(['CASHCAT_CREATE']) }, { kind: 'THU', name: 'Thu nợ KH', sourceKind: 'DEBT_CUSTOMER', affectsPnl: true });
    expect(r.error).toBe('PNL_FLAG_FORBIDDEN');
    expect(r.message).toBe('Danh mục loại này (công nợ/cọc/tạm ứng/chuyển quỹ) không được tính vào lợi nhuận.');
  });

  it('trùng tên trong cùng loại → DUPLICATE', async () => {
    const { db } = makeFakeDb([seed({ name: 'Doanh thu bán hàng', kind: 'THU' })]);
    const r = await createCashCategory({ db, user: authUser(['CASHCAT_CREATE']) }, { kind: 'THU', name: 'doanh thu bán hàng' });
    expect(r.error).toBe('DUPLICATE');
    expect(r.message).toBe('Danh mục "doanh thu bán hàng" đã tồn tại trong nhóm thu.');
  });

  it('hợp lệ → tạo + createdBy + audit CREATED', async () => {
    const { db, cats, audits } = makeFakeDb([]);
    const r = await createCashCategory({ db, user: authUser(['CASHCAT_CREATE']) }, { kind: 'CHI', name: 'Tiền điện' });
    expect(r.ok).toBe(true);
    expect(cats[0]!.kind).toBe('CHI');
    expect(cats[0]!.createdBy).toBe(42);
    expect(audits.some((a) => a['action'] === 'CASH_CATEGORY_CREATED')).toBe(true);
  });
});

describe('updateCashCategory', () => {
  it('danh mục hệ thống đổi nguồn → SYSTEM_LOCKED', async () => {
    const { db } = makeFakeDb([seed({ isSystem: true, sourceKind: 'BAD_DEBT', kind: 'CHI', affectsPnl: true })]);
    const r = await updateCashCategory({ db, user: authUser(['CASHCAT_UPDATE']) }, 1, { sourceKind: 'MANUAL', expectedUpdatedAt: null });
    expect(r.error).toBe('SYSTEM_LOCKED');
    expect(r.message).toBe('Không đổi được nguồn của danh mục hệ thống.');
  });

  it('hợp lệ → đổi tên + audit UPDATED', async () => {
    const s = seed();
    const { db, cats, audits } = makeFakeDb([s]);
    const r = await updateCashCategory({ db, user: authUser(['CASHCAT_UPDATE']) }, 1, { name: 'Doanh thu dịch vụ', expectedUpdatedAt: s.updatedAt.toISOString() });
    expect(r.ok).toBe(true);
    expect(cats[0]!.name).toBe('Doanh thu dịch vụ');
    expect(audits.some((a) => a['action'] === 'CASH_CATEGORY_UPDATED')).toBe(true);
  });
});

describe('deleteCashCategories', () => {
  it('danh mục hệ thống → SYSTEM_LOCKED (không xóa)', async () => {
    const { db, cats } = makeFakeDb([seed({ isSystem: true })]);
    const r = await deleteCashCategories({ db, user: authUser(['CASHCAT_DELETE']) }, [1]);
    expect(r.error).toBe('SYSTEM_LOCKED');
    expect(r.message).toBe('Danh mục hệ thống không thể xóa.');
    expect(cats[0]!.deletedAt).toBeNull();
  });

  it('đang dùng ở phiếu → IN_USE (không xóa)', async () => {
    const { db, cats } = makeFakeDb([seed()], { entryRefs: { 1: 3 } });
    const r = await deleteCashCategories({ db, user: authUser(['CASHCAT_DELETE']) }, [1]);
    expect(r.error).toBe('IN_USE');
    expect(cats[0]!.deletedAt).toBeNull();
  });

  it('lõi giả định đã xác thực (adapter kiểm mật khẩu), không ràng buộc → soft-delete + audit DELETED', async () => {
    const { db, cats, audits } = makeFakeDb([seed()]);
    const r = await deleteCashCategories({ db, user: authUser(['CASHCAT_DELETE']) }, [1]);
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(1);
    expect(cats[0]!.deletedAt).toBeInstanceOf(Date);
    expect(cats[0]!.deletedBy).toBe(42);
    expect(audits.some((a) => a['action'] === 'CASH_CATEGORY_DELETED')).toBe(true);
  });
});
