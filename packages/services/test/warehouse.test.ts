// Test LÕI THUẦN warehouse core (@sigma/services). ASSERT error code + message tiếng Việt + R27b chặn xóa kho còn máy.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { listWarehouses, createWarehouse, updateWarehouse, deleteWarehouses, listWarehouseManagerCandidates, type ServiceCtx } from '../src/index.js';

const VIEW = 'CONFIG_WAREHOUSE_VIEW';
const MANAGE = 'CONFIG_WAREHOUSE_MANAGE';
function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

function makeFake(seed: Record<string, unknown>[], posDeviceCount = 0) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = rows.reduce((m, r) => Math.max(m, r['id'] as number), 0) + 1;
  const audits: Record<string, unknown>[] = [];
  const fake = {
    warehouse: {
      findMany: async () => rows.filter((r) => r['deletedAt'] == null).map((r) => ({ ...r })),
      findFirst: async ({ where }: { where: Record<string, unknown> }) => { const not = where['NOT'] as { id?: number } | undefined; return rows.find((r) => r['code'] === where['code'] && (!not || r['id'] !== not.id)) ?? null; },
      findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r['id'] === where.id) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: nextId++, deletedAt: null, updatedBy: null, createdAt: new Date(), updatedAt: new Date(), ...data }; rows.push(row); return { ...row }; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = rows.find((x) => x['id'] === where.id)!; Object.assign(r, data); return { ...r }; }
    },
    user: { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 7 ? { id: 7, deletedAt: null, status: 'ACTIVE', fullName: 'QL Kho', username: 'qlkho', phone: '090', address: 'HN' } : null), findMany: async () => [{ id: 42, fullName: 'Người Kiểm Thử', username: 'tester' }] },
    posDevice: { count: async () => posDeviceCount },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Warehouse', version: 1 }) }
  };
  return { db: fake as unknown as Db, rows, audits };
}

describe('warehouse core', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeFake([]);
    const r = await listWarehouses({ db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('tạo status không hợp lệ → VALIDATION nguyên văn', async () => {
    const { db } = makeFake([]);
    const r = await createWarehouse({ db, user: authUser([MANAGE]) }, { code: 'K1', name: 'Kho 1', status: 'WEIRD' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Trạng thái kho không hợp lệ.');
  });

  it('tạo hợp lệ (mã upper) → ok + audit', async () => {
    const { db, rows, audits } = makeFake([]);
    const r = await createWarehouse({ db, user: authUser([MANAGE]) }, { code: 'k1', name: 'Kho 1' });
    expect(r.ok).toBe(true);
    expect(rows[0]!['code']).toBe('K1');
    expect(audits.some((a) => a['action'] === 'WAREHOUSE_CREATED')).toBe(true);
  });

  it('trùng mã → DUPLICATE', async () => {
    const { db } = makeFake([{ id: 1, code: 'K1', name: 'A', status: 'ACTIVE', deletedAt: null, address: null, phone: null, managerUserId: null, note: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }]);
    const r = await createWarehouse({ db, user: authUser([MANAGE]) }, { code: 'k1', name: 'B' });
    expect(r.error).toBe('DUPLICATE');
  });

  it('gán manager không tồn tại → NOT_FOUND', async () => {
    const { db } = makeFake([]);
    const r = await createWarehouse({ db, user: authUser([MANAGE]) }, { code: 'K1', name: 'Kho', managerUserId: 999 });
    expect(r.error).toBe('NOT_FOUND');
    expect(r.message).toBe('User quản lý kho đã chọn không tồn tại hoặc không hoạt động.');
  });

  it('R27b — xóa kho còn máy IN_STOCK → IN_USE (chặn)', async () => {
    const { db, rows } = makeFake([{ id: 1, code: 'K1', name: 'A', status: 'ACTIVE', deletedAt: null, address: null, phone: null, managerUserId: null, note: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }], 3);
    const r = await deleteWarehouses({ db, user: authUser([MANAGE]) }, [1]);
    expect(r.error).toBe('IN_USE');
    expect(r.message).toContain('K1 (3 máy)');
    expect(rows[0]!['deletedAt']).toBeNull();
  });

  it('xóa kho rỗng → soft-delete', async () => {
    const { db, rows } = makeFake([{ id: 1, code: 'K1', name: 'A', status: 'ACTIVE', deletedAt: null, address: null, phone: null, managerUserId: null, note: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }], 0);
    const r = await deleteWarehouses({ db, user: authUser([MANAGE]) }, [1]);
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(1);
    expect(rows[0]!['deletedAt']).toBeInstanceOf(Date);
  });

  it('managerCandidates chỉ user ACTIVE còn sống', async () => {
    const { db } = makeFake([]);
    const r = await listWarehouseManagerCandidates({ db, user: authUser([VIEW]) });
    expect(r.ok).toBe(true);
  });

  it('update stale → STALE_WRITE', async () => {
    const { db } = makeFake([{ id: 1, code: 'K1', name: 'A', status: 'ACTIVE', deletedAt: null, address: null, phone: null, managerUserId: null, note: null, createdBy: 42, updatedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') }]);
    const r = await updateWarehouse({ db, user: authUser([MANAGE]) }, 1, { name: 'B', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' });
    expect(r.error).toBe('STALE_WRITE');
  });
});
