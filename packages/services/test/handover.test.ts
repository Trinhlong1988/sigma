// Test LÕI THUẦN handover core (@sigma/services). ASSERT error code + message tiếng Việt + builtin KHÓA moneyKind/xóa.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { listHandoverTypes, listHandoverTypesLite, createHandoverType, updateHandoverType, deleteHandoverTypes, type ServiceCtx } from '../src/index.js';

const VIEW = 'CONFIG_HANDOVER_VIEW';
const MANAGE = 'CONFIG_HANDOVER_MANAGE';
function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

function makeFake(seed: Record<string, unknown>[]) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = rows.reduce((m, r) => Math.max(m, r['id'] as number), 0) + 1;
  const audits: Record<string, unknown>[] = [];
  const fake = {
    handoverType: {
      findMany: async () => rows.filter((r) => r['deletedAt'] == null).map((r) => ({ ...r })),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => { const not = where['NOT'] as { id?: number } | undefined; return rows.find((r) => r['name'] === where['name'] && (!not || r['id'] !== not.id)) ?? null; },
      findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r['id'] === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: nextId++, deletedAt: null, updatedBy: null, createdAt: new Date(), updatedAt: new Date(), ...data }; rows.push(row); return { ...row }; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = rows.find((x) => x['id'] === where.id)!; Object.assign(r, data); return { ...r }; }
    },
    user: { findMany: async () => [{ id: 42, fullName: 'Người Kiểm Thử', username: 'tester' }] },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'HandoverType', version: 1 }) },
    // ATOMIC (audit 20/8) — deleteHandoverTypes bọc vòng xóa trong $transaction; fake chạy thẳng callback với chính nó.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(fake)
  };
  return { db: fake as unknown as Db, rows, audits };
}

const builtin = (over: Record<string, unknown> = {}) => ({ id: 1, name: 'Bán', moneyKind: 'SALE', isBuiltin: true, sortOrder: 0, deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'), ...over });

describe('handover core', () => {
  it('list thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeFake([builtin()]);
    const r = await listHandoverTypes({ db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('lite chấp nhận POS_VIEW (không cần quyền cấu hình)', async () => {
    const { db } = makeFake([builtin()]);
    const r = await listHandoverTypesLite({ db, user: authUser(['POS_VIEW']) });
    expect(r.ok).toBe(true);
    expect(r.data![0]!.moneyKind).toBe('SALE');
  });

  it('tạo moneyKind sai → VALIDATION nguyên văn', async () => {
    const { db } = makeFake([]);
    const r = await createHandoverType({ db, user: authUser([MANAGE]) }, { name: 'X', moneyKind: 'GIFT' });
    expect(r.error).toBe('VALIDATION');
    // 9/8 — thêm mô hình tiền "Đối ứng" (COUNTERPART) → message liệt kê thêm.
    expect(r.message).toBe('Mô hình tiền phải là Bán / Cho thuê / Mượn / Cọc / Đối ứng.');
  });

  it('tạo hợp lệ (KHÔNG builtin) → ok + audit', async () => {
    const { db, rows, audits } = makeFake([]);
    const r = await createHandoverType({ db, user: authUser([MANAGE]) }, { name: 'Thuê tháng', moneyKind: 'rent' });
    expect(r.ok).toBe(true);
    expect(rows[0]!['moneyKind']).toBe('RENT');
    expect(rows[0]!['isBuiltin']).toBe(false);
    expect(audits.some((a) => a['action'] === 'HANDOVER_TYPE_CREATED')).toBe(true);
  });

  it('builtin — ĐỔI được moneyKind (Admin Demo 9/8 MỞ khoá sửa mô hình tiền cả builtin)', async () => {
    const { db, rows } = makeFake([builtin()]);
    const r = await updateHandoverType({ db, user: authUser([MANAGE]) }, 1, { moneyKind: 'RENT' });
    expect(r.ok).toBe(true);
    expect(rows[0]!['moneyKind']).toBe('RENT');
  });

  it('builtin — đổi name vẫn được', async () => {
    const { db, rows } = makeFake([builtin()]);
    const r = await updateHandoverType({ db, user: authUser([MANAGE]) }, 1, { name: 'Bán đứt' });
    expect(r.ok).toBe(true);
    expect(rows[0]!['name']).toBe('Bán đứt');
  });

  it('xóa builtin (chỉ builtin) → BUILTIN_LOCKED', async () => {
    const { db, rows } = makeFake([builtin()]);
    const r = await deleteHandoverTypes({ db, user: authUser([MANAGE]) }, [1]);
    expect(r.error).toBe('BUILTIN_LOCKED');
    expect(rows[0]!['deletedAt']).toBeNull();
  });

  it('xóa loại thường → soft-delete + audit', async () => {
    const { db, rows, audits } = makeFake([builtin({ id: 2, name: 'Thuê', moneyKind: 'RENT', isBuiltin: false })]);
    const r = await deleteHandoverTypes({ db, user: authUser([MANAGE]) }, [2]);
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(1);
    expect(rows[0]!['deletedAt']).toBeInstanceOf(Date);
    expect(audits.some((a) => a['action'] === 'HANDOVER_TYPE_DELETED')).toBe(true);
  });
});
