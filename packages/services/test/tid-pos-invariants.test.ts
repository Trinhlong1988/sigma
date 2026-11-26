// ─────────────────────────────────────────────────────────────────────────────
// REGRESSION HARNESS TEST — chạy TỪNG mutation tài sản THẬT (qua service function + $transaction) rồi KHẲNG ĐỊNH
// bất biến TID↔POS còn nguyên (assertTidPosInvariants === []). Đây là lớp chống lớp-bug consistency đã lọt:
// orphan serial / delivered-not-ACTIVE / on-device-not-delivered / terminal-tid-giữ-máy / warehouse lệch.
//
// KHÁC các test đơn lẻ (mock từng lời gọi): ở đây dùng 1 Db GIẢ CÓ TRẠNG THÁI (in-memory store nhất quán) — create/
// update thật sự đổi bảng, findMany đọc lại → sau mutation, checker quét ĐÚNG trạng thái tồn kết quả. Giống cách
// export-request-service.test.ts dùng row MUTABLE + $transaction=fn(db), nhưng nâng lên store đầy đủ nhiều-hàng.
// (Suite @sigma/services KHÔNG chạy Postgres — vitest.config.ts đã khai; đây là Engineering Validation, không Production.)
// ─────────────────────────────────────────────────────────────────────────────
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import {
  createTidUnified, assignTid, replaceTid, markTidDelivered, recallTid,
  deployPos, recallPos, retirePos, changeCustomerPos,
  sellTid, sellPos, approveExportRequest,
  type ServiceCtx
} from '../src/index.js';
import { assertTidPosInvariants } from './tid-pos-invariants.harness.js';

// ── Db GIẢ CÓ TRẠNG THÁI (generic Prisma-shaped in-memory) ──────────────────────
type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** So khớp 1 hàng với where — hỗ trợ scalar (==, null lỏng), in/notIn, not, gte/gt/lte/lt, OR/AND; bỏ qua undefined. */
function matchWhere(row: Row, where: Where): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v === undefined) continue;
    if (k === 'OR') {
      const arr = v as Where[];
      if (Array.isArray(arr) && !arr.some((w) => matchWhere(row, w))) return false;
      continue;
    }
    if (k === 'AND') {
      const arr = v as Where[];
      if (Array.isArray(arr) && !arr.every((w) => matchWhere(row, w))) return false;
      continue;
    }
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const op = v as Record<string, unknown>;
      if ('in' in op) { if (!(op.in as unknown[]).includes(row[k])) return false; continue; }
      if ('notIn' in op) { if ((op.notIn as unknown[]).includes(row[k])) return false; continue; }
      if ('not' in op) { const nv = op.not; if (nv === null ? row[k] == null : row[k] === nv) return false; continue; }
      const asNum = (x: unknown) => (x instanceof Date ? x.getTime() : (x as number));
      if ('gte' in op && !(asNum(row[k]) >= asNum(op.gte))) return false;
      if ('gt' in op && !(asNum(row[k]) > asNum(op.gt))) return false;
      if ('lte' in op && !(asNum(row[k]) <= asNum(op.lte))) return false;
      if ('lt' in op && !(asNum(row[k]) < asNum(op.lt))) return false;
      if ('gte' in op || 'gt' in op || 'lte' in op || 'lt' in op) continue;
      // operator không nhận diện (contains/mode…) — bỏ qua (không dùng trong mutation path).
      continue;
    }
    // scalar: null so lỏng (khớp cả undefined = cột chưa set trong fake, Prisma default null).
    if (v === null ? row[k] != null : row[k] !== v) return false;
  }
  return true;
}

/** Bỏ key undefined (Prisma: undefined = "không đổi", KHÔNG ghi null đè). */
function strip(data: Row): Row {
  const out: Row = {};
  for (const [k, v] of Object.entries(data)) if (v !== undefined) out[k] = v;
  return out;
}
/** Áp data update — hỗ trợ toán tử { increment } (codeCounter/changeToken). */
function applyUpdate(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(strip(data))) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date) && 'increment' in (v as Row)) {
      row[k] = ((row[k] as number) ?? 0) + ((v as Row).increment as number);
    } else row[k] = v;
  }
}

function makeMemDb(seed: Record<string, Row[]> = {}) {
  const tables = new Map<string, Row[]>();
  for (const [name, rows] of Object.entries(seed)) tables.set(name, rows.map((r) => ({ ...r })));
  const tbl = (name: string): Row[] => { if (!tables.has(name)) tables.set(name, []); return tables.get(name)!; };
  const nextId = (name: string): number => { let m = 0; for (const r of tbl(name)) if (typeof r.id === 'number' && r.id > m) m = r.id; return m + 1; };

  const model = (name: string) => ({
    findUnique: async ({ where }: { where: Where }) => { const r = tbl(name).find((x) => matchWhere(x, where)); return r ? { ...r } : null; },
    findFirst: async ({ where = {} }: { where?: Where } = {}) => { const r = tbl(name).find((x) => matchWhere(x, where)); return r ? { ...r } : null; },
    findMany: async ({ where = {} }: { where?: Where } = {}) => tbl(name).filter((x) => matchWhere(x, where)).map((x) => ({ ...x })),
    count: async ({ where = {} }: { where?: Where } = {}) => tbl(name).filter((x) => matchWhere(x, where)).length,
    create: async ({ data }: { data: Row }) => { const row = strip(data); if (row.id === undefined) row.id = nextId(name); tbl(name).push(row); return { ...row }; },
    update: async ({ where, data }: { where: Where; data: Row }) => { const r = tbl(name).find((x) => matchWhere(x, where)); if (!r) throw new Error(`[memdb] ${name}.update: no row for ${JSON.stringify(where)}`); applyUpdate(r, data); return { ...r }; },
    updateMany: async ({ where = {}, data }: { where?: Where; data: Row }) => { let count = 0; for (const r of tbl(name)) if (matchWhere(r, where)) { applyUpdate(r, data); count++; } return { count }; },
    deleteMany: async ({ where = {} }: { where?: Where } = {}) => { const keep = tbl(name).filter((x) => !matchWhere(x, where)); const count = tbl(name).length - keep.length; tables.set(name, keep); return { count }; },
    upsert: async ({ where, create, update }: { where: Where; create: Row; update: Row }) => { const r = tbl(name).find((x) => matchWhere(x, where)); if (r) { applyUpdate(r, update); return { ...r }; } const row = strip(create); if (row.id === undefined) row.id = nextId(name); tbl(name).push(row); return { ...row }; },
    aggregate: async ({ _sum }: { _sum?: Record<string, boolean> } = {}) => { const out: Row = {}; if (_sum) { const s: Row = {}; for (const f of Object.keys(_sum)) s[f] = 0n; out._sum = s; } return out; },
    groupBy: async () => [] as Row[]
  });

  // $queryRaw tagged-template: FOR UPDATE = no-op []; SELECT delivered_at FROM tids = trả mốc giao (deliverTidWithinTx).
  const queryRaw = async (strings: TemplateStringsArray, ...vals: unknown[]): Promise<Row[]> => {
    const sql = strings.join('?');
    if (sql.includes('delivered_at') && sql.includes('FROM tids')) {
      const id = vals[0];
      const r = tbl('tid').find((x) => x.id === id);
      return r ? [{ delivered_at: (r.deliveredAt as Date | null) ?? null }] : [];
    }
    return [];
  };

  let proxy: Db;
  const special: Record<string, unknown> = {
    $transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(proxy),
    $queryRaw: queryRaw
  };
  proxy = new Proxy({}, {
    get(_t, prop: string) {
      if (prop in special) return special[prop];
      return model(prop);
    }
  }) as unknown as Db;
  return { db: proxy, tables };
}

// ── Seed reference catalogs + factories ─────────────────────────────────────────
function baseSeed(): Record<string, Row[]> {
  return {
    customer: [
      { id: 7, deletedAt: null, nickname: 'KH7', fullName: 'Khách 7', agentId: null },
      { id: 8, deletedAt: null, nickname: 'KH8', fullName: 'Khách 8', agentId: null }
    ],
    agent: [{ id: 5, deletedAt: null, name: 'Đại lý 5' }],
    bank: [{ id: 1, deletedAt: null, code: 'B1', name: 'Bank 1', status: 'ACTIVE' }],
    industry: [{ id: 3, deletedAt: null, active: true, code: 'AU', name: 'Ăn uống' }],
    partner: [{ id: 2, deletedAt: null, code: 'P1', name: 'Đối tác 1' }],
    warehouse: [{ id: 1, deletedAt: null, code: 'K1', name: 'Kho 1', address: '123 Đường Kho', managerUserId: null, status: 'ACTIVE' }],
    user: [{ id: 42, address: 'Địa chỉ 42', fullName: 'Tester', username: 'tester' }],
    cashCategory: [
      { id: 60, sourceKind: 'SALE_POS', deletedAt: null },
      { id: 61, sourceKind: 'SALE_TID', deletedAt: null },
      { id: 62, sourceKind: 'SALE_COLLECT', deletedAt: null },
      { id: 63, sourceKind: 'RENT', deletedAt: null },
      { id: 64, sourceKind: 'DEPOSIT_REFUND', deletedAt: null }
    ]
  };
}

const now = new Date('2026-08-01T00:00:00.000Z');

function tidRow(over: Row): Row {
  return {
    id: 0, tid: 'T?', mid: null, bank: null, bankId: 1, partnerId: 2, hkdName: 'HKD',
    status: 'UNASSIGNED', posSerial: null, customerId: null, agentId: null,
    openedAt: now, deliveredAt: null, closedAt: null, createdAt: now, updatedAt: now,
    dossierId: null, industryId: 3, receiveAccountId: null, investFeeMilli: null, issuedAt: null,
    configStatusId: null, dossierSourceId: null, customerDeviceSerial: null, note: null,
    defaultFeeTypeId: null, deletedAt: null, createdBy: 42, ...over
  };
}
function devRow(over: Row): Row {
  return {
    id: 0, serial: 'S?', model: null, bank: null, bankId: 1, status: 'IN_STOCK',
    currentAgentId: null, currentCustomerId: null, currentTid: null,
    warehouseLoc: null, warehouseId: 1, recallPending: false, note: null,
    createdAt: now, updatedAt: now, posModelId: null, supplierId: null, importPrice: null,
    importedAt: null, deletedAt: null, ...over
  };
}

function authUser(): AuthUser {
  return {
    id: 42, username: 'tester', fullName: 'Tester', status: 'ACTIVE', forceChangePassword: false, roles: ['R'],
    permissions: [
      'TID_VIEW', 'CONFIG_TID_VIEW', 'TID_MANAGE', 'CONFIG_TID_MANAGE',
      'POS_VIEW', 'POS_MANAGE', 'DEVICE_SALE_MANAGE', 'DEVICE_SALE_VIEW',
      'EXPORT_REQUEST_VIEW', 'EXPORT_REQUEST_CREATE', 'EXPORT_REQUEST_APPROVE', 'EXPORT_REQUEST_APPROVE_ELEVATED'
    ]
  };
}
const ctxOf = (db: Db): ServiceCtx => ({ db, user: authUser() });

// ── Mỗi entry point: seed → chạy THẬT → khẳng định invariants sạch ──────────────
describe('TID↔POS invariants — createTidUnified', () => {
  it('config-only (chưa gán/giao) → invariants sạch', async () => {
    const { db } = makeMemDb(baseSeed());
    const r = await createTidUnified(ctxOf(db), { tid: 'CFG1', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 1 });
    expect(r.ok).toBe(true);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });

  it('assign (máy + khách) → tid ACTIVE ôm máy DEPLOYED, sạch', async () => {
    const seed = baseSeed();
    seed.posDevice = [devRow({ id: 100, serial: 'S1', status: 'IN_STOCK', bankId: 1, warehouseId: 1 })];
    const { db } = makeMemDb(seed);
    const r = await createTidUnified(ctxOf(db), { tid: 'ASG1', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 1, assign: { posSerial: 'S1', customerId: 7 } });
    expect(r.ok).toBe(true);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });

  it('deliver-only (chưa gán máy) → tid ACTIVE + đã giao, sạch', async () => {
    const { db } = makeMemDb(baseSeed());
    const r = await createTidUnified(ctxOf(db), { tid: 'DLV1', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 1, deliver: { customerId: 7 } });
    expect(r.ok).toBe(true);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });

  it('assign + deliver (cùng khách) → sạch', async () => {
    const seed = baseSeed();
    seed.posDevice = [devRow({ id: 100, serial: 'S1', status: 'IN_STOCK', bankId: 1, warehouseId: 1 })];
    const { db } = makeMemDb(seed);
    const r = await createTidUnified(ctxOf(db), { tid: 'AD1', industryId: 3, hkdName: 'HKD', partnerId: 2, bankId: 1, assign: { posSerial: 'S1', customerId: 7 }, deliver: { customerId: 7 } });
    expect(r.ok).toBe(true);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });
});

describe('TID↔POS invariants — assignTid', () => {
  it('gán UNASSIGNED lên máy IN_STOCK → ACTIVE + DEPLOYED, sạch', async () => {
    const seed = baseSeed();
    seed.tid = [tidRow({ id: 1, tid: 'T1', status: 'UNASSIGNED', bankId: 1 })];
    seed.posDevice = [devRow({ id: 100, serial: 'S1', status: 'IN_STOCK', bankId: 1, warehouseId: 1 })];
    const { db } = makeMemDb(seed);
    const r = await assignTid(ctxOf(db), 'T1', { posSerial: 'S1', customerId: 7 });
    expect(r.ok).toBe(true);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });
});

describe('TID↔POS invariants — replaceTid', () => {
  it('thay TID trên máy → cũ DEAD nhả máy, mới ACTIVE ôm máy, sạch (chống orphan serial TID-1)', async () => {
    const seed = baseSeed();
    seed.tid = [
      tidRow({ id: 1, tid: 'OLD', status: 'ACTIVE', posSerial: 'S1', bankId: 1, customerId: 7, agentId: 5, deliveredAt: now }),
      tidRow({ id: 2, tid: 'NEW', status: 'UNASSIGNED', posSerial: null, bankId: 1 })
    ];
    seed.posDevice = [devRow({ id: 100, serial: 'S1', status: 'DEPLOYED', bankId: 1, currentTid: 'OLD', currentCustomerId: 7, currentAgentId: 5, warehouseId: null })];
    const { db, tables } = makeMemDb(seed);
    const r = await replaceTid(ctxOf(db), 'OLD', { newTid: 'NEW' });
    expect(r.ok).toBe(true);
    // Khẳng định thêm: TID cũ DEAD nhả posSerial (đúng bản vá TID-1) — không chỉ dựa checker.
    const old = tables.get('tid')!.find((t) => t.tid === 'OLD')!;
    expect(old.status).toBe('DEAD');
    expect(old.posSerial).toBe(null);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });
});

describe('TID↔POS invariants — markTidDelivered', () => {
  it('giao TID chưa-gán (UNASSIGNED) → ACTIVE + đã giao, sạch', async () => {
    const seed = baseSeed();
    seed.tid = [tidRow({ id: 1, tid: 'T1', status: 'UNASSIGNED', posSerial: null, customerId: null, deliveredAt: null })];
    const { db } = makeMemDb(seed);
    const r = await markTidDelivered(ctxOf(db), 'T1', { customerId: 7 });
    expect(r.ok).toBe(true);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });
});

describe('TID↔POS invariants — recallTid (TID-level recall)', () => {
  it('thu hồi TID ACTIVE trên máy → RECALLED nhả máy, sạch', async () => {
    const seed = baseSeed();
    seed.tid = [tidRow({ id: 1, tid: 'T1', status: 'ACTIVE', posSerial: 'S1', bankId: 1, customerId: 7, agentId: 5, deliveredAt: now })];
    seed.posDevice = [devRow({ id: 100, serial: 'S1', status: 'DEPLOYED', bankId: 1, currentTid: 'T1', currentCustomerId: 7, currentAgentId: 5, warehouseId: null })];
    const { db } = makeMemDb(seed);
    const r = await recallTid(ctxOf(db), 'T1');
    expect(r.ok).toBe(true);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });
});

describe('TID↔POS invariants — recallPos (unbind reset máy về kho)', () => {
  it('thu hồi máy → tid reset UNASSIGNED (sạch khách/giao), máy IN_STOCK về kho, sạch', async () => {
    const seed = baseSeed();
    seed.tid = [tidRow({ id: 1, tid: 'T1', status: 'ACTIVE', posSerial: 'S1', bankId: 1, customerId: 7, agentId: 5, deliveredAt: now })];
    seed.posDevice = [devRow({ id: 100, serial: 'S1', status: 'DEPLOYED', bankId: 1, currentTid: 'T1', currentCustomerId: 7, currentAgentId: 5, warehouseId: null })];
    const { db, tables } = makeMemDb(seed);
    const r = await recallPos(ctxOf(db), 'S1', { toWarehouseId: 1 });
    expect(r.ok).toBe(true);
    const t = tables.get('tid')!.find((x) => x.tid === 'T1')!;
    expect(t.status).toBe('UNASSIGNED');
    expect(t.customerId).toBe(null);
    expect(t.deliveredAt).toBe(null);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });
});

describe('TID↔POS invariants — retirePos (unbind retire)', () => {
  it('thanh lý máy đang giao → TID RECALLED nhả máy, máy RETIRED ngoài kho, sạch', async () => {
    const seed = baseSeed();
    seed.tid = [tidRow({ id: 1, tid: 'T1', status: 'ACTIVE', posSerial: 'S1', bankId: 1, customerId: 7, agentId: 5, deliveredAt: now })];
    seed.posDevice = [devRow({ id: 100, serial: 'S1', status: 'DEPLOYED', bankId: 1, currentTid: 'T1', currentCustomerId: 7, currentAgentId: 5, warehouseId: null })];
    const { db } = makeMemDb(seed);
    const r = await retirePos(ctxOf(db), 'S1', {});
    expect(r.ok).toBe(true);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });
});

describe('TID↔POS invariants — deployPos (giao máy trắng, không TID)', () => {
  it('giao máy IN_STOCK cho khách → DEPLOYED ngoài kho, sạch', async () => {
    const seed = baseSeed();
    seed.posDevice = [devRow({ id: 100, serial: 'S1', status: 'IN_STOCK', bankId: 1, warehouseId: 1 })];
    const { db } = makeMemDb(seed);
    const r = await deployPos(ctxOf(db), 'S1', { customerId: 7 });
    expect(r.ok).toBe(true);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });
});

describe('TID↔POS invariants — changeCustomerPos', () => {
  it('đổi khách giữ máy → TID theo khách mới, device.currentCustomerId đổi, sạch', async () => {
    const seed = baseSeed();
    seed.tid = [tidRow({ id: 1, tid: 'T1', status: 'ACTIVE', posSerial: 'S1', bankId: 1, customerId: 7, agentId: 5, deliveredAt: now })];
    seed.posDevice = [devRow({ id: 100, serial: 'S1', status: 'DEPLOYED', bankId: 1, currentTid: 'T1', currentCustomerId: 7, currentAgentId: 5, warehouseId: null })];
    const { db, tables } = makeMemDb(seed);
    const r = await changeCustomerPos(ctxOf(db), 'S1', { customerId: 8 });
    expect(r.ok).toBe(true);
    const t = tables.get('tid')!.find((x) => x.tid === 'T1')!;
    expect(t.customerId).toBe(8);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });
});

describe('TID↔POS invariants — sellTid (bán TID lẻ)', () => {
  it('bán TID lẻ (chưa trên máy) → SOLD nhả máy/đại lý, sạch', async () => {
    const seed = baseSeed();
    seed.tid = [tidRow({ id: 1, tid: 'T1', status: 'UNASSIGNED', posSerial: null, bankId: 1, customerId: null, deliveredAt: null })];
    const { db } = makeMemDb(seed);
    const r = await sellTid(ctxOf(db), 'T1', { customerId: 7, salePrice: 1_000_000 });
    expect(r.ok).toBe(true);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });
});

describe('TID↔POS invariants — approveExportRequest', () => {
  const seedER = (over: Row): Row => ({
    id: 10, code: 'YCXK01', status: 'PENDING', requesterUserId: 2, kind: 'POS', handoverKind: 'RENT', withTid: false,
    quantity: 1, unitPrice: 0n, amount: 0n, depositAmount: 0n, paidAmount: 0n, bankId: null, partnerId: null,
    customerId: 7, fundId: null, method: 'CASH', priceMode: 'LISTED', feeTypeId: null, note: null,
    requestedAt: now, decidedBy: null, decidedAt: null, decisionNote: null, ...over
  });

  // (Đã FIX production 21/8) — assignTidLineTx nay clear warehouseId khi deploy (mirror assignTid + nhánh SALE/RENT
  // non-withTid). Trước đây SÓT → máy ở khách vẫn "trong kho" (vi phạm I5 warehouseId⟺IN_STOCK + I8). Nay sạch.
  it('POS + TID line (RENT) → máy DEPLOYED clear kho + mang TID đã giao, sạch', async () => {
    const seed = baseSeed();
    seed.exportRequest = [seedER({ kind: 'POS', handoverKind: 'RENT', withTid: true, bankId: 1 })];
    seed.tid = [tidRow({ id: 1, tid: 'T1', status: 'UNASSIGNED', posSerial: null, bankId: 1 })];
    seed.posDevice = [devRow({ id: 100, serial: 'S1', status: 'IN_STOCK', bankId: 1, warehouseId: 1 })];
    const { db, tables } = makeMemDb(seed);
    const r = await approveExportRequest(ctxOf(db), 10, [{ seq: 1, posSerial: 'S1', tid: 'T1' }]);
    expect(r.ok).toBe(true);
    const dev = tables.get('posDevice')!.find((d) => d.serial === 'S1')!;
    expect(dev.status).toBe('DEPLOYED');
    expect(dev.currentTid).toBe('T1');
    expect(dev.warehouseId).toBe(null); // FIX: máy giao khách đã rời kho
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });

  it('TID lẻ RENT → TID ACTIVE đã giao (không trên máy), sạch', async () => {
    const seed = baseSeed();
    seed.exportRequest = [seedER({ kind: 'TID', handoverKind: 'RENT', withTid: false })];
    seed.tid = [tidRow({ id: 1, tid: 'T1', status: 'UNASSIGNED', posSerial: null, bankId: 1, partnerId: 2 })];
    const { db } = makeMemDb(seed);
    const r = await approveExportRequest(ctxOf(db), 10, [{ seq: 1, tid: 'T1' }]);
    expect(r.ok).toBe(true);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });

  it('TID lẻ SALE → TID SOLD nhả máy/đại lý, sạch', async () => {
    const seed = baseSeed();
    seed.exportRequest = [seedER({ kind: 'TID', handoverKind: 'SALE', withTid: false, unitPrice: 1_000_000n, amount: 1_000_000n })];
    seed.tid = [tidRow({ id: 1, tid: 'T1', status: 'UNASSIGNED', posSerial: null, bankId: 1, partnerId: 2 })];
    const { db } = makeMemDb(seed);
    const r = await approveExportRequest(ctxOf(db), 10, [{ seq: 1, tid: 'T1' }]);
    expect(r.ok).toBe(true);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });
});

describe('TID↔POS invariants — sellPos (bán máy kèm TID)', () => {
  // Quyết định Admin Demo 21/8: I8 MIỄN SOLD — máy đã bán GIỮ currentCustomerId=người-mua (ngoài kho). TID kèm máy
  // → SOLD nhả posSerial/agentId (không orphan serial). Post-state sạch dưới I8 đã tinh chỉnh.
  it('bán máy POS đang giao (kèm TID) → máy SOLD giữ người mua (ngoài kho) + TID SOLD nhả máy, sạch', async () => {
    const seed = baseSeed();
    seed.tid = [tidRow({ id: 1, tid: 'T1', status: 'ACTIVE', posSerial: 'S1', bankId: 1, customerId: 7, agentId: 5, deliveredAt: now })];
    seed.posDevice = [devRow({ id: 100, serial: 'S1', status: 'DEPLOYED', bankId: 1, currentTid: 'T1', currentCustomerId: 7, currentAgentId: 5, warehouseId: null })];
    const { db, tables } = makeMemDb(seed);
    const r = await sellPos(ctxOf(db), 'S1', { customerId: 8, salePrice: 1_000_000 });
    expect(r.ok).toBe(true);
    const dead = tables.get('tid')!.find((t) => t.tid === 'T1')!;
    expect(dead.status).toBe('SOLD');
    expect(dead.posSerial).toBe(null);
    expect(dead.agentId).toBe(null);
    const dev = tables.get('posDevice')!.find((d) => d.serial === 'S1')!;
    expect(dev.status).toBe('SOLD');
    expect(dev.currentCustomerId).toBe(8); // giữ người mua
    expect(dev.warehouseId).toBe(null);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });
});

// ── NEGATIVE self-test: checker PHẢI bắt state cố tình hỏng (chứng minh không pass rỗng) ──
describe('assertTidPosInvariants — NEGATIVE self-test (không vacuously pass)', () => {
  it('TID DEAD còn ôm posSerial + agentId + không có máy → báo I1/I2/I6', async () => {
    const seed = baseSeed();
    seed.tid = [tidRow({ id: 1, tid: 'BAD', status: 'DEAD', posSerial: 'S1', agentId: 5, customerId: 7, deliveredAt: now })];
    // KHÔNG seed posDevice serial S1.
    const { db } = makeMemDb(seed);
    const v = await assertTidPosInvariants(db);
    expect(v.length).toBeGreaterThan(0);
    expect(v.some((s) => s.startsWith('[I1]'))).toBe(true);
    expect(v.some((s) => s.startsWith('[I2]'))).toBe(true);
    expect(v.some((s) => s.startsWith('[I6]'))).toBe(true);
  });

  it('TID UNASSIGNED còn customerId (recall chưa reset khách) → báo I3', async () => {
    const seed = baseSeed();
    // Không posSerial/deliveredAt để cô lập I3 (tránh I1/I6/I4 cùng nổ).
    seed.tid = [tidRow({ id: 1, tid: 'U1', status: 'UNASSIGNED', posSerial: null, customerId: 7, deliveredAt: null })];
    const { db } = makeMemDb(seed);
    const v = await assertTidPosInvariants(db);
    expect(v.some((s) => s.startsWith('[I3]'))).toBe(true);
  });

  it('TID non-terminal đã giao (deliveredAt≠null) nhưng status≠ACTIVE → báo I4', async () => {
    const seed = baseSeed();
    // UNASSIGNED + deliveredAt: delivered⟹ACTIVE bị vi phạm → I4 (I3 cũng nổ do deliveredAt — cả hai đều hợp lệ).
    seed.tid = [tidRow({ id: 1, tid: 'D1', status: 'UNASSIGNED', posSerial: null, customerId: null, deliveredAt: now })];
    const { db } = makeMemDb(seed);
    const v = await assertTidPosInvariants(db);
    expect(v.some((s) => s.startsWith('[I4]'))).toBe(true);
  });

  it('device IN_STOCK nhưng warehouseId null → báo I5', async () => {
    const seed = baseSeed();
    seed.posDevice = [devRow({ id: 100, serial: 'S1', status: 'IN_STOCK', warehouseId: null })];
    const { db } = makeMemDb(seed);
    const v = await assertTidPosInvariants(db);
    expect(v.some((s) => s.startsWith('[I5]'))).toBe(true);
  });

  it('device có currentCustomerId nhưng IN_STOCK (∉{DEPLOYED,SOLD}) → báo I8 (SOLD được miễn, IN_STOCK thì không)', async () => {
    const seed = baseSeed();
    seed.posDevice = [devRow({ id: 100, serial: 'S1', status: 'IN_STOCK', warehouseId: 1, currentCustomerId: 7 })];
    const { db } = makeMemDb(seed);
    const v = await assertTidPosInvariants(db);
    expect(v.some((s) => s.startsWith('[I8]'))).toBe(true);
  });

  it('máy DEPLOYED mang currentTid nhưng TID trỏ máy khác → báo I7', async () => {
    const seed = baseSeed();
    seed.tid = [tidRow({ id: 1, tid: 'T1', status: 'ACTIVE', posSerial: 'S2', bankId: 1, customerId: 7, deliveredAt: now })];
    seed.posDevice = [
      devRow({ id: 100, serial: 'S1', status: 'DEPLOYED', currentTid: 'T1', currentCustomerId: 7, warehouseId: null }),
      devRow({ id: 101, serial: 'S2', status: 'DEPLOYED', currentTid: 'T1', currentCustomerId: 7, warehouseId: null })
    ];
    const { db } = makeMemDb(seed);
    const v = await assertTidPosInvariants(db);
    expect(v.some((s) => s.startsWith('[I7]'))).toBe(true);
  });

  it('state nhất quán thủ công → checker rỗng (đối chứng dương)', async () => {
    const seed = baseSeed();
    seed.tid = [tidRow({ id: 1, tid: 'T1', status: 'ACTIVE', posSerial: 'S1', bankId: 1, customerId: 7, deliveredAt: now })];
    seed.posDevice = [devRow({ id: 100, serial: 'S1', status: 'DEPLOYED', currentTid: 'T1', currentCustomerId: 7, warehouseId: null })];
    const { db } = makeMemDb(seed);
    expect(await assertTidPosInvariants(db)).toEqual([]);
  });
});
