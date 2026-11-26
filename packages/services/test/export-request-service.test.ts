// Test LÕI THUẦN export-request-service (@sigma/services) — Db GIẢ in-memory. ASSERT error code + message tiếng Việt +
// validate + phân vai (self/elevated) + audit. §14 mật khẩu người DUYỆT ở ADAPTER (lõi KHÔNG kiểm). Money-approve path
// đầy đủ tái dùng money-tier (bookSaleCashEntries/applyHandover) — ở đây phủ các CỔNG validate/role TRƯỚC $transaction.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { createExportRequest, listExportRequests, approveExportRequest, rejectExportRequest, cancelExportRequest, type ServiceCtx } from '../src/index.js';

function authUser(id: number, permissions: string[], roles: string[] = ['R']): AuthUser {
  return { id, username: `u${id}`, fullName: `User ${id}`, status: 'ACTIVE', forceChangePassword: false, roles, permissions };
}

interface ER { id: number; code: string; status: string; requesterUserId: number; kind: string; handoverKind: string; withTid: boolean; quantity: number; unitPrice: bigint; amount: bigint; depositAmount: bigint; paidAmount: bigint; bankId: number | null; partnerId: number | null; customerId: number; fundId: number | null; method: string; priceMode: string; feeTypeId: number | null; note: string | null; requestedAt: Date; decidedBy: number | null; decidedAt: Date | null; decisionNote: string | null }

const matchWhere = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([k, v]) => row[k] === v);

function makeDb(seed: { ers?: ER[]; customers?: number[] }) {
  const ers = seed.ers ?? [];
  const customers = seed.customers ?? [];
  const audits: Record<string, unknown>[] = [];
  let erId = ers.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  let counter = 0;
  const db = {
    customer: {
      findFirst: async ({ where }: { where: { id: number } }) => (customers.includes(where.id) ? { id: where.id } : null),
      findMany: async () => customers.map((id) => ({ id, nickname: `KH${id}`, fullName: `Khách ${id}` }))
    },
    bank: { findFirst: async () => null, findMany: async () => [] },
    partner: { findFirst: async () => null },
    cardType: { findFirst: async () => null },
    feeType: { findFirst: async () => null, findMany: async () => [] },
    fund: { findFirst: async () => null },
    user: { findMany: async ({ where }: { where: { id: { in: number[] } } }) => where.id.in.map((id) => ({ id, fullName: `U${id}`, username: `u${id}` })) },
    codeCounter: { upsert: async () => ({ prefix: 'YCXK', lastValue: ++counter }) },
    exportRequest: {
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: erId++, ...data } as unknown as ER; ers.push(row); return { ...row }; },
      findUnique: async ({ where }: { where: { id: number } }) => ers.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => ers.filter((r) => !where || matchWhere(r as unknown as Record<string, unknown>, Object.fromEntries(Object.entries(where).filter(([, v]) => v !== undefined)))).map((r) => ({ ...r })),
      groupBy: async () => { const m = new Map<string, number>(); for (const r of ers) m.set(r.status, (m.get(r.status) ?? 0) + 1); return [...m].map(([status, c]) => ({ status, _count: c })); },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { let count = 0; for (const r of ers) if (matchWhere(r as unknown as Record<string, unknown>, where)) { Object.assign(r, data); count++; } return { count }; }
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({}) }
  };
  return { db: db as unknown as Db, ers, audits };
}
const ctx = (db: Db, user: AuthUser): ServiceCtx => ({ db, user });

describe('export-request — TẠO phiếu', () => {
  it('thiếu quyền CREATE → FORBIDDEN', async () => {
    const { db } = makeDb({});
    const r = await createExportRequest(ctx(db, authUser(1, [])), { kind: 'POS', handoverKind: 'SALE', customerId: 1, unitPrice: '1000', quantity: 1 });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('kind sai → VALIDATION', async () => {
    const { db } = makeDb({});
    const r = await createExportRequest(ctx(db, authUser(1, ['EXPORT_REQUEST_CREATE'])), { kind: 'XX', handoverKind: 'SALE', customerId: 1, unitPrice: '1000', quantity: 1 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Loại yêu cầu phải là POS hoặc TID.');
  });

  it('RENT mà nhập tiền thu khi duyệt → VALIDATION', async () => {
    const { db } = makeDb({ customers: [1] });
    const r = await createExportRequest(ctx(db, authUser(1, ['EXPORT_REQUEST_CREATE'])), { kind: 'POS', handoverKind: 'RENT', customerId: 1, unitPrice: '1000', quantity: 1, paidAmount: '500', fundId: 1 });
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toContain('Cho thuê thu tiền qua đơn giá thuê');
  });

  it('khách không tồn tại → NOT_FOUND', async () => {
    const { db } = makeDb({ customers: [] });
    const r = await createExportRequest(ctx(db, authUser(1, ['EXPORT_REQUEST_CREATE'])), { kind: 'POS', handoverKind: 'SALE', customerId: 99, unitPrice: '1000', quantity: 1 });
    expect(r.error).toBe('NOT_FOUND');
  });

  it('POS SALE hợp lệ → tạo phiếu PENDING + audit EXPORT_REQUEST_CREATED', async () => {
    const { db, ers, audits } = makeDb({ customers: [1] });
    const r = await createExportRequest(ctx(db, authUser(1, ['EXPORT_REQUEST_CREATE'])), { kind: 'POS', handoverKind: 'SALE', customerId: 1, unitPrice: '1000000', quantity: 2 });
    expect(r.ok).toBe(true);
    expect(ers[0]!.status).toBe('PENDING');
    expect(ers[0]!.amount).toBe(2000000n); // đơn giá × số lượng
    expect(audits.some((a) => a['action'] === 'EXPORT_REQUEST_CREATED')).toBe(true);
  });
});

const seedER = (over: Partial<ER> = {}): ER => ({ id: 10, code: 'YCXK01', status: 'PENDING', requesterUserId: 2, kind: 'POS', handoverKind: 'SALE', withTid: false, quantity: 1, unitPrice: 1000n, amount: 1000n, depositAmount: 0n, paidAmount: 0n, bankId: null, partnerId: null, customerId: 1, fundId: null, method: 'CASH', priceMode: 'LISTED', feeTypeId: null, note: null, requestedAt: new Date(), decidedBy: null, decidedAt: null, decisionNote: null, ...over });

describe('export-request — DANH SÁCH + KPI', () => {
  it('thiếu quyền VIEW → FORBIDDEN', async () => {
    const { db } = makeDb({ ers: [seedER()] });
    const r = await listExportRequests(ctx(db, authUser(1, [])));
    expect(r.error).toBe('FORBIDDEN');
  });

  it('có quyền → DTO (money serialize chuỗi) + KPI', async () => {
    const { db } = makeDb({ ers: [seedER({ unitPrice: 1500n, amount: 1500n })], customers: [1] });
    const r = await listExportRequests(ctx(db, authUser(9, ['EXPORT_REQUEST_VIEW'])));
    expect(r.ok).toBe(true);
    expect(r.data![0]!.unitPrice).toBe('1500');
    expect(r.kpi!.pending).toBe(1);
    expect(r.kpi!.total).toBe(1);
  });
});

describe('export-request — DUYỆT (cổng phân vai / validate)', () => {
  it('tự duyệt KHÔNG có quyền ELEVATED (chỉ APPROVE thường) → SELF_APPROVAL_FORBIDDEN + audit denied', async () => {
    const { db, audits } = makeDb({ ers: [seedER({ requesterUserId: 5 })] });
    const r = await approveExportRequest(ctx(db, authUser(5, ['EXPORT_REQUEST_APPROVE'])), 10, [{ seq: 1, posSerial: 'S1' }]);
    expect(r.error).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(audits.some((a) => a['action'] === 'EXPORT_REQUEST_APPROVED')).toBe(true);
  });

  it('tự duyệt CÓ quyền EXPORT_REQUEST_APPROVE_ELEVATED (Admin) → QUA cổng phân vai (không SELF_APPROVAL_FORBIDDEN)', async () => {
    // quantity 2 nhưng chỉ truyền 1 dòng → dừng ở validate số-dòng CHỨNG TỎ đã vượt cổng tự-duyệt (elevated cho qua).
    const { db } = makeDb({ ers: [seedER({ requesterUserId: 5, quantity: 2 })] });
    const r = await approveExportRequest(
      ctx(db, authUser(5, ['EXPORT_REQUEST_APPROVE', 'EXPORT_REQUEST_APPROVE_ELEVATED'])),
      10,
      [{ seq: 1, posSerial: 'S1' }]
    );
    expect(r.error).not.toBe('SELF_APPROVAL_FORBIDDEN');
    expect(r.error).toBe('VALIDATION');
  });

  it('số dòng ≠ số lượng → VALIDATION', async () => {
    const { db } = makeDb({ ers: [seedER({ requesterUserId: 2, quantity: 2 })] });
    const r = await approveExportRequest(ctx(db, authUser(9, ['EXPORT_REQUEST_APPROVE'])), 10, [{ seq: 1, posSerial: 'S1' }]);
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toContain('Phải chọn đúng 2 đơn vị');
  });

  it('phiếu đã xử lý → INVALID_STATE', async () => {
    const { db } = makeDb({ ers: [seedER({ status: 'APPROVED' })] });
    const r = await approveExportRequest(ctx(db, authUser(9, ['EXPORT_REQUEST_APPROVE'])), 10, [{ seq: 1, posSerial: 'S1' }]);
    expect(r.error).toBe('INVALID_STATE');
  });
});

describe('export-request — TỪ CHỐI / HỦY', () => {
  it('từ chối thiếu lý do → VALIDATION; có lý do → OK', async () => {
    const { db, ers } = makeDb({ ers: [seedER()] });
    const bad = await rejectExportRequest(ctx(db, authUser(9, ['EXPORT_REQUEST_APPROVE'])), 10, ' ');
    expect(bad.error).toBe('VALIDATION');
    const ok = await rejectExportRequest(ctx(db, authUser(9, ['EXPORT_REQUEST_APPROVE'])), 10, 'không đủ tồn');
    expect(ok.ok).toBe(true);
    expect(ers[0]!.status).toBe('REJECTED');
  });

  it('người khác (không quyền duyệt) hủy phiếu không phải của mình → FORBIDDEN', async () => {
    const { db } = makeDb({ ers: [seedER({ requesterUserId: 2 })] });
    const r = await cancelExportRequest(ctx(db, authUser(3, ['EXPORT_REQUEST_CREATE'])), 10, 'x');
    expect(r.error).toBe('FORBIDDEN');
  });

  it('người tạo tự hủy phiếu PENDING → OK CANCELLED', async () => {
    const { db, ers } = makeDb({ ers: [seedER({ requesterUserId: 3 })] });
    const r = await cancelExportRequest(ctx(db, authUser(3, ['EXPORT_REQUEST_CREATE'])), 10, 'đổi ý');
    expect(r.ok).toBe(true);
    expect(ers[0]!.status).toBe('CANCELLED');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TID-2 / TID-3 (audit 20/8) — DUYỆT xuất kho phải để lại TID ĐÚNG bất biến giao/kích hoạt.
// Dùng RENT đơn giá 0đ (applyHandoverTx RENT amount≤0 → return sớm) để KHÔNG cần model tiền/deviceSale — chỉ soi
// nhánh gán/giao TID trong $transaction. Fake tx = chính db (có $queryRaw). posDevice/tid là object MUTABLE để
// re-read trong tx phản ánh update.
// ─────────────────────────────────────────────────────────────────────────────
interface FakeTid { id: number; tid: string; status: string; posSerial: string | null; bankId: number | null; partnerId: number | null; agentId: number | null; customerId: number | null; deliveredAt: Date | null; deletedAt: Date | null }
interface FakeDev { id: number; serial: string; status: string; currentTid: string | null; bankId: number | null; warehouseId: number | null; currentAgentId: number | null; deletedAt: Date | null }

function makeApproveHarness(opts: { er: ER; tid?: FakeTid; dev?: FakeDev }) {
  const ers = [opts.er];
  const tidRow = opts.tid;
  const devRow = opts.dev;
  const tidUpdates: Record<string, unknown>[] = [];
  const events: Record<string, unknown>[] = [];
  const lines: Record<string, unknown>[] = [];
  const db: Record<string, unknown> = {
    exportRequest: {
      findUnique: async ({ where, select }: { where: { id: number }; select?: Record<string, unknown> }) => {
        const r = ers.find((e) => e.id === where.id);
        if (!r) return null;
        return select ? { status: r.status } : { ...r };
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of ers) if (r.id === where['id'] && (where['status'] === undefined || r.status === where['status'])) { Object.assign(r, data); count++; }
        return { count };
      }
    },
    exportRequestLine: { create: async ({ data }: { data: Record<string, unknown> }) => { lines.push({ ...data }); return { ...data }; } },
    warehouse: { findFirst: async () => ({ address: '123 Đường Kho', managerUserId: null }) },
    user: { findUnique: async () => null },
    posTidBinding: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }), updateMany: async () => ({ count: 0 }) },
    assetEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { events.push({ ...data }); return { ...data }; } },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) },
    changeToken: { upsert: async () => ({}) },
    $queryRaw: async () => []
  };
  if (tidRow) db.tid = {
    findUnique: async () => ({ ...tidRow }),
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { tidUpdates.push({ id: where.id, ...data }); Object.assign(tidRow, data); return { ...tidRow }; }
  };
  if (devRow) db.posDevice = {
    findUnique: async () => ({ ...devRow }),
    update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(devRow, data); return { ...devRow }; }
  };
  db.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => fn(db);
  return { db: db as unknown as Db, tidUpdates, events, tidRow, devRow };
}

describe('export-request — DUYỆT: bất biến TID sau giao (TID-2 / TID-3)', () => {
  // TID-2 — POS + kèm TID (RENT 0đ): gán TID kèm máy cho khách = ĐÃ GIAO → deliveredAt PHẢI set (không "chưa giao").
  it('TID-2 — duyệt POS+TID → TID có deliveredAt set (đã giao) + ACTIVE + posSerial', async () => {
    const er = seedER({ kind: 'POS', handoverKind: 'RENT', withTid: true, quantity: 1, unitPrice: 0n, amount: 0n, bankId: 1, requesterUserId: 2 });
    const tid: FakeTid = { id: 1, tid: 'T1', status: 'UNASSIGNED', posSerial: null, bankId: 1, partnerId: null, agentId: null, customerId: null, deliveredAt: null, deletedAt: null };
    const dev: FakeDev = { id: 100, serial: 'S1', status: 'IN_STOCK', currentTid: null, bankId: 1, warehouseId: 1, currentAgentId: null, deletedAt: null };
    const { db, tidUpdates } = makeApproveHarness({ er, tid, dev });
    const r = await approveExportRequest(ctx(db, authUser(9, ['EXPORT_REQUEST_APPROVE'])), 10, [{ seq: 1, posSerial: 'S1', tid: 'T1' }]);
    expect(r.ok).toBe(true);
    const upd = tidUpdates.find((u) => u['status'] === 'ACTIVE')!;
    expect(upd).toBeDefined();
    expect(upd['posSerial']).toBe('S1');
    expect(upd['customerId']).toBe(1);
    expect(upd['deliveredAt']).toBeInstanceOf(Date); // TID-2: không còn null "chưa giao"
  });

  // TID-3 — TID lẻ RENT: giao (deliveredAt) PHẢI kèm nâng UNASSIGNED→ACTIVE (delivered⟹ACTIVE).
  it('TID-3 — duyệt TID lẻ (RENT) → status ACTIVE + deliveredAt set (không còn delivered-nhưng-UNASSIGNED)', async () => {
    const er = seedER({ kind: 'TID', handoverKind: 'RENT', withTid: false, quantity: 1, unitPrice: 0n, amount: 0n, partnerId: null, bankId: null, requesterUserId: 2 });
    const tid: FakeTid = { id: 1, tid: 'T1', status: 'UNASSIGNED', posSerial: null, bankId: null, partnerId: null, agentId: null, customerId: null, deliveredAt: null, deletedAt: null };
    const { db, tidUpdates } = makeApproveHarness({ er, tid });
    const r = await approveExportRequest(ctx(db, authUser(9, ['EXPORT_REQUEST_APPROVE'])), 10, [{ seq: 1, tid: 'T1' }]);
    expect(r.ok).toBe(true);
    const upd = tidUpdates.find((u) => u['deliveredAt'] instanceof Date)!;
    expect(upd).toBeDefined();
    expect(upd['status']).toBe('ACTIVE'); // TID-3: promote UNASSIGNED→ACTIVE khi giao
    expect(upd['deliveredAt']).toBeInstanceOf(Date);
  });

  // TID-1 guard — TID lẻ DEAD (đã thay, deliveredAt bị làm rỗng) KHÔNG được GIAO LẠI qua duyệt xuất kho RENT.
  // Guard trạng-thái-terminal 'deliver' chặn → INVALID_STATE, KHÔNG booking doanh thu, KHÔNG ghi deliveredAt.
  it('TID-1 guard — duyệt TID lẻ RENT trên TID DEAD → INVALID_STATE, không ghi deliveredAt (không đặt lại delivered⟹ACTIVE)', async () => {
    const er = seedER({ kind: 'TID', handoverKind: 'RENT', withTid: false, quantity: 1, unitPrice: 0n, amount: 0n, partnerId: null, bankId: null, requesterUserId: 2 });
    const tid: FakeTid = { id: 1, tid: 'T1', status: 'DEAD', posSerial: null, bankId: null, partnerId: null, agentId: null, customerId: 7, deliveredAt: null, deletedAt: null };
    const { db, tidUpdates } = makeApproveHarness({ er, tid });
    const r = await approveExportRequest(ctx(db, authUser(9, ['EXPORT_REQUEST_APPROVE'])), 10, [{ seq: 1, tid: 'T1' }]);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('INVALID_STATE');
    expect(tidUpdates.find((u) => u['deliveredAt'] instanceof Date)).toBeUndefined(); // KHÔNG giao
  });

  // TID-3 guard — TID lẻ đã ACTIVE (không phải UNASSIGNED) khi giao → KHÔNG bị hạ/đổi trạng thái (undefined = giữ).
  it('TID-3 guard — TID lẻ RENT đang ACTIVE (chưa giao) → giao chỉ set deliveredAt, KHÔNG đụng status (undefined)', async () => {
    const er = seedER({ kind: 'TID', handoverKind: 'RENT', withTid: false, quantity: 1, unitPrice: 0n, amount: 0n, partnerId: null, bankId: null, requesterUserId: 2 });
    const tid: FakeTid = { id: 1, tid: 'T1', status: 'ACTIVE', posSerial: null, bankId: null, partnerId: null, agentId: null, customerId: null, deliveredAt: null, deletedAt: null };
    const { db, tidUpdates } = makeApproveHarness({ er, tid });
    const r = await approveExportRequest(ctx(db, authUser(9, ['EXPORT_REQUEST_APPROVE'])), 10, [{ seq: 1, tid: 'T1' }]);
    expect(r.ok).toBe(true);
    const upd = tidUpdates.find((u) => u['deliveredAt'] instanceof Date)!;
    expect(upd).toBeDefined();
    expect(upd['status']).toBeUndefined(); // chỉ nâng từ UNASSIGNED — ACTIVE giữ nguyên
  });
});

// TID-4 (audit 21/8) — processPosLineTx PHẢI khóa hàng tids TRƯỚC pos_devices (thứ tự khóa TOÀN CỤC, khớp
// assignTid/replaceTid/device-sale). Trước đây khóa pos_devices trước rồi assignTidLineTx mới khóa tids →
// pos-trước-tid = ngược chiều → ABBA deadlock với assignTid. Mirror lock-order test của replaceTid (tid.test.ts).
describe('export-request — TID-4 lock order (tids TRƯỚC pos_devices, chống ABBA)', () => {
  it('processPosLineTx (POS+withTid) khóa hàng tids TRƯỚC pos_devices', async () => {
    const er = seedER({ kind: 'POS', handoverKind: 'RENT', withTid: true, quantity: 1, unitPrice: 0n, amount: 0n, bankId: 1, requesterUserId: 2 });
    const tid: FakeTid = { id: 1, tid: 'T1', status: 'UNASSIGNED', posSerial: null, bankId: 1, partnerId: null, agentId: null, customerId: null, deliveredAt: null, deletedAt: null };
    const dev: FakeDev = { id: 100, serial: 'S1', status: 'IN_STOCK', currentTid: null, bankId: 1, warehouseId: 1, currentAgentId: null, deletedAt: null };
    const { db } = makeApproveHarness({ er, tid, dev });
    const locks: string[] = [];
    // Ghi lại thứ tự khóa hàng FOR UPDATE: chỉ quan tâm tids vs pos_devices (bỏ export_requests).
    (db as unknown as Record<string, unknown>).$queryRaw = async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      if (sql.includes('FROM tids')) locks.push('tid');
      else if (sql.includes('FROM pos_devices')) locks.push('pos');
      return [];
    };
    const r = await approveExportRequest(ctx(db, authUser(9, ['EXPORT_REQUEST_APPROVE'])), 10, [{ seq: 1, posSerial: 'S1', tid: 'T1' }]);
    expect(r.ok).toBe(true);
    // Khóa hàng TID XUẤT HIỆN TRƯỚC khóa pos_devices (thứ tự toàn cục — chống ABBA với assignTid tid→pos).
    expect(locks.length).toBeGreaterThanOrEqual(2);
    expect(locks[0]).toBe('tid');
    expect(locks.indexOf('tid')).toBeLessThan(locks.indexOf('pos'));
  });
});
