// Test LÕI THUẦN pos-supply core (@sigma/services) — Db GIẢ in-memory + ServiceCtx = { db, user }. ASSERT giá trị cụ
// thể: error code + nguyên văn message tiếng Việt + audit + soft-delete. §14 mật khẩu ở ADAPTER (lõi KHÔNG kiểm).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  listSuppliers, createSupplier, updateSupplier, deleteSuppliers,
  createPosModel,
  listIntakeStatuses, createIntakeStatus,
  createPosIntake, listPosIntakes,
  type ServiceCtx
} from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
const VIEW = 'CONFIG_POS_SUPPLY_VIEW';
const MANAGE = 'CONFIG_POS_SUPPLY_MANAGE';

interface Row { id: number; deletedAt: Date | null; [k: string]: unknown }
function makeTable(seed: Row[]) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  return {
    rows,
    findMany: async (args?: { where?: Record<string, unknown> }) => {
      const w = args?.where ?? {};
      return rows.filter((r) => (!('deletedAt' in w) || r.deletedAt === (w['deletedAt'] ?? null))).map((r) => ({ ...r })).sort((a, b) => a.id - b.id);
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) => {
      const not = where['NOT'] as { id?: number } | undefined;
      return rows.find((r) => (where['code'] === undefined || r.code === where['code']) && (where['name'] === undefined || r.name === where['name']) && (!not || r.id !== not.id)) ?? null;
    },
    findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r.id === where.id) ?? null,
    create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: nextId++, deletedAt: null, updatedBy: null, createdAt: new Date(), updatedAt: new Date(), ...data } as Row; rows.push(row); return { ...row }; },
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = rows.find((x) => x.id === where.id)!; Object.assign(r, data); return { ...r }; },
    count: async () => 0
  };
}

function baseFake() {
  const audits: Record<string, unknown>[] = [];
  const fake: Record<string, unknown> = {
    user: { findMany: async () => [{ id: 42, fullName: 'Người Kiểm Thử', username: 'tester' }] },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) }
  };
  return { fake, audits };
}

describe('supplier core', () => {
  it('thiếu quyền VIEW → FORBIDDEN nguyên văn', async () => {
    const { fake } = baseFake();
    fake.supplier = makeTable([]);
    const r = await listSuppliers({ db: fake as unknown as Db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('tạo thiếu tên → VALIDATION', async () => {
    const { fake } = baseFake();
    fake.supplier = makeTable([]);
    const r = await createSupplier({ db: fake as unknown as Db, user: authUser([MANAGE]) }, { name: '  ', code: 'NCC1' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Tên nhà cung cấp bắt buộc.');
  });

  it('trùng mã → DUPLICATE', async () => {
    const { fake } = baseFake();
    fake.supplier = makeTable([{ id: 1, code: 'NCC1', name: 'A', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }]);
    const r = await createSupplier({ db: fake as unknown as Db, user: authUser([MANAGE]) }, { name: 'B', code: 'ncc1' });
    expect(r.error).toBe('DUPLICATE');
    expect(r.message).toBe('Mã nhà cung cấp "NCC1" đã tồn tại.');
  });

  it('tạo hợp lệ → ok + audit SUPPLIER_CREATED', async () => {
    const { fake, audits } = baseFake();
    const t = makeTable([]);
    fake.supplier = t;
    const r = await createSupplier({ db: fake as unknown as Db, user: authUser([MANAGE]) }, { name: 'Cty A', code: 'ncc1' });
    expect(r.ok).toBe(true);
    expect(t.rows[0]!.code).toBe('NCC1');
    expect(audits.some((a) => a['action'] === 'SUPPLIER_CREATED')).toBe(true);
  });

  it('xóa (lõi giả định đã xác thực) → soft-delete + audit', async () => {
    const { fake, audits } = baseFake();
    const t = makeTable([{ id: 1, code: 'NCC1', name: 'A', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }]);
    fake.supplier = t;
    const r = await deleteSuppliers({ db: fake as unknown as Db, user: authUser([MANAGE]) }, [1]);
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(1);
    expect(t.rows[0]!.deletedAt).toBeInstanceOf(Date);
    expect(audits.some((a) => a['action'] === 'SUPPLIER_DELETED')).toBe(true);
  });

  it('update code trùng bản trash → DUPLICATE_TRASH', async () => {
    const { fake } = baseFake();
    fake.supplier = makeTable([
      { id: 1, code: 'AAA', name: 'A', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() },
      { id: 2, code: 'BBB', name: 'B', deletedAt: new Date(), createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }
    ]);
    const r = await updateSupplier({ db: fake as unknown as Db, user: authUser([MANAGE]) }, 1, { code: 'bbb' });
    expect(r.error).toBe('DUPLICATE_TRASH');
  });
});

describe('posModel + intakeStatus core', () => {
  it('posModel tạo thiếu mã → VALIDATION nguyên văn', async () => {
    const { fake } = baseFake();
    fake.posModel = makeTable([]);
    const r = await createPosModel({ db: fake as unknown as Db, user: authUser([MANAGE]) }, { code: '', name: 'X' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Mã máy POS bắt buộc.');
  });

  it('intakeStatus list thiếu quyền → FORBIDDEN; tạo trùng tên → DUPLICATE', async () => {
    const { fake } = baseFake();
    fake.posIntakeStatus = makeTable([{ id: 1, name: 'Đã nhận', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }]);
    const forb = await listIntakeStatuses({ db: fake as unknown as Db, user: authUser([]) });
    expect(forb.error).toBe('FORBIDDEN');
    const dup = await createIntakeStatus({ db: fake as unknown as Db, user: authUser([MANAGE]) }, { name: 'Đã nhận' });
    expect(dup.error).toBe('DUPLICATE');
    expect(dup.message).toBe('Trạng thái nhập máy "Đã nhận" đã tồn tại.');
  });
});

describe('posIntake core', () => {
  it('thiếu chủng loại → VALIDATION (trước transaction)', async () => {
    const { fake } = baseFake();
    fake.posIntake = makeTable([]);
    const r = await createPosIntake({ db: fake as unknown as Db, user: authUser([MANAGE]) }, { posModelId: 0, serial: 'S1', intakeStatusId: 1, supplierId: 1, importPrice: 100, importedAt: '2026-01-01' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Vui lòng chọn chủng loại máy POS.');
  });

  it('giá âm → VALIDATION giá nhập', async () => {
    const { fake } = baseFake();
    fake.posIntake = makeTable([]);
    const r = await createPosIntake({ db: fake as unknown as Db, user: authUser([MANAGE]) }, { posModelId: 1, serial: 'S1', intakeStatusId: 1, supplierId: 1, importPrice: -5, importedAt: '2026-01-01' });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Giá nhập phải là số nguyên ≥ 0 (VND).');
  });

  it('tạo máy MỚI hợp lệ → phiếu nhập + PosDevice IN_STOCK + AssetEvent STOCK_IN + audit', async () => {
    const { fake, audits } = baseFake();
    const intake = makeTable([]);
    const events: Record<string, unknown>[] = [];
    const devices: Record<string, unknown>[] = [];
    fake.posIntake = intake;
    fake.posModel = { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 1 ? { id: 1, deletedAt: null, code: 'M1', name: 'Model 1' } : null), findMany: async () => [{ id: 1, code: 'M1', name: 'Model 1' }] };
    fake.posIntakeStatus = { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 1 ? { id: 1, deletedAt: null, name: 'Đã nhận' } : null), findMany: async () => [{ id: 1, name: 'Đã nhận' }] };
    fake.supplier = { findUnique: async ({ where }: { where: { id: number } }) => (where.id === 1 ? { id: 1, deletedAt: null, code: 'NCC1', name: 'A' } : null), findMany: async () => [{ id: 1, code: 'NCC1', name: 'A' }] };
    fake.posDevice = {
      findUnique: async () => devices.find(() => false) ?? null,
      create: async ({ data }: { data: Record<string, unknown> }) => { devices.push({ ...data }); return { ...data }; },
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      findMany: async () => []
    };
    fake.bank = { findMany: async () => [] };
    fake.assetEvent = { create: async ({ data }: { data: Record<string, unknown> }) => { events.push({ ...data }); return { ...data }; } };
    fake.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] });
    const r = await createPosIntake({ db: fake as unknown as Db, user: authUser([MANAGE]) }, { posModelId: 1, serial: 'SER1', intakeStatusId: 1, supplierId: 1, importPrice: 1000000, importedAt: '2026-01-01' });
    expect(r.ok).toBe(true);
    expect(intake.rows[0]!.serial).toBe('SER1');
    expect(devices[0]!.status).toBe('IN_STOCK');
    expect(events[0]!.eventType).toBe('STOCK_IN');
    expect(audits.some((a) => a['action'] === 'POS_INTAKE_CREATED')).toBe(true);
  });

  it('list posIntake trả DTO có tên chủng loại/NCC/trạng thái', async () => {
    const { fake } = baseFake();
    fake.posIntake = { findMany: async () => [{ id: 1, posModelId: 1, serial: 'SER1', intakeStatusId: 1, supplierId: 1, importPrice: 1000, importedAt: new Date('2026-01-01'), note: null, deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() }] };
    fake.posModel = { findMany: async () => [{ id: 1, code: 'M1', name: 'Model 1' }] };
    fake.supplier = { findMany: async () => [{ id: 1, code: 'NCC1', name: 'A' }] };
    fake.posIntakeStatus = { findMany: async () => [{ id: 1, name: 'Đã nhận' }] };
    fake.posDevice = { findMany: async () => [{ serial: 'SER1', bankId: null }] };
    fake.bank = { findMany: async () => [] };
    const r = await listPosIntakes({ db: fake as unknown as Db, user: authUser([VIEW]) });
    expect(r.ok).toBe(true);
    expect(r.data![0]!.posModelName).toBe('Model 1');
    expect(r.data![0]!.supplierName).toBe('A');
    expect(r.data![0]!.intakeStatusName).toBe('Đã nhận');
  });
});
