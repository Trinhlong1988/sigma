// Test LÕI THUẦN entity-cancel-service (@sigma/services) — Db GIẢ in-memory. ASSERT error code + message tiếng Việt +
// phân vai + soft-delete + audit. §14 mật khẩu ở ADAPTER (lõi KHÔNG kiểm). Tập trung entity Tid + Customer.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { requestEntityCancel, approveEntityCancel, approveEntityCancelBulk, rejectEntityCancel, listEntityCancelRequests, type ServiceCtx } from '../src/index.js';

function authUser(id: number, permissions: string[], roles: string[] = ['R']): AuthUser {
  return { id, username: `u${id}`, fullName: `User ${id}`, status: 'ACTIVE', forceChangePassword: false, roles, permissions };
}

interface Req { id: number; entityType: string; entityId: number; action: string; reason: string; status: string; requestedBy: number; requestedAt: Date; decidedBy?: number | null; decidedAt?: Date | null; decisionNote?: string | null }
interface Tid { id: number; tid: string; deletedAt: Date | null; posSerial: string | null }
interface Usr { id: number; fullName: string; username: string; deletedAt: Date | null; status: string; permCodes: string[] }

const matchWhere = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v !== null && typeof v === 'object' && 'not' in (v as object)) return row[k] !== (v as { not: unknown }).not;
    return row[k] === v;
  });

interface PosDev { id: number; serial: string; status: string; currentTid: string | null; currentCustomerId: number | null; deletedAt: Date | null }
interface DevDep { customerId?: number | null; tid?: string | null; deviceSerial?: string | null; status: string }
interface ExpReq { id: number; customerId: number; status: string }
interface ExpLine { exportRequestId: number; tid?: string | null }

function makeDb(seed: { reqs?: Req[]; tids?: Tid[]; users?: Usr[]; customers?: { id: number; code: string; fullName: string; deletedAt: Date | null }[]; posDevices?: PosDev[]; deviceDeposits?: DevDep[]; exportRequests?: ExpReq[]; exportRequestLines?: ExpLine[] }) {
  const reqs = seed.reqs ?? [];
  const tids = seed.tids ?? [];
  const users = seed.users ?? [];
  const customers = seed.customers ?? [];
  const posDevices = seed.posDevices ?? [];
  const deviceDeposits = seed.deviceDeposits ?? [];
  const exportRequests = seed.exportRequests ?? [];
  const exportRequestLines = seed.exportRequestLines ?? [];
  const audits: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  let reqId = reqs.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const userInclude = (u: Usr) => ({ ...u, roles: [{ role: { code: 'R', permissions: u.permCodes.map((c) => ({ permission: { code: c } })) } }] });
  const db = {
    approvalRequest: {
      findUnique: async ({ where }: { where: { id: number } }) => reqs.find((r) => r.id === where.id) ?? null,
      findFirst: async ({ where }: { where: Record<string, unknown> }) => reqs.find((r) => matchWhere(r as unknown as Record<string, unknown>, where)) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => reqs.filter((r) => {
        const w = { ...where };
        const et = w['entityType'] as { in?: string[] } | string | undefined;
        delete w['entityType'];
        const base = matchWhere(r as unknown as Record<string, unknown>, w);
        const etOk = et == null ? true : typeof et === 'string' ? r.entityType === et : (et.in?.includes(r.entityType) ?? false);
        return base && etOk;
      }).map((r) => ({ ...r })),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { let count = 0; for (const r of reqs) if (matchWhere(r as unknown as Record<string, unknown>, where)) { Object.assign(r, data); count++; } return { count }; },
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: reqId++, status: 'PENDING', requestedAt: new Date(), ...data } as unknown as Req; reqs.push(row); return { ...row }; }
    },
    tid: {
      findUnique: async ({ where }: { where: { id?: number; tid?: string } }) => tids.find((t) => (where.id !== undefined ? t.id === where.id : t.tid === where.tid)) ?? null,
      count: async () => 0,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { let count = 0; for (const t of tids) if (matchWhere(t as unknown as Record<string, unknown>, where)) { Object.assign(t, data); count++; } return { count }; }
    },
    customer: {
      findUnique: async ({ where }: { where: { id: number } }) => customers.find((c) => c.id === where.id) ?? null,
      count: async () => 0,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { let count = 0; for (const c of customers) if (matchWhere(c as unknown as Record<string, unknown>, where)) { Object.assign(c, data); count++; } return { count }; }
    },
    posDevice: {
      findUnique: async ({ where }: { where: { id: number } }) => posDevices.find((p) => p.id === where.id) ?? null,
      count: async ({ where }: { where?: Record<string, unknown> } = {}) => posDevices.filter((p) => (where ? matchWhere(p as unknown as Record<string, unknown>, where) : true)).length,
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => { let count = 0; for (const p of posDevices) if (matchWhere(p as unknown as Record<string, unknown>, where)) { Object.assign(p, data); count++; } return { count }; }
    },
    deviceDeposit: { count: async ({ where }: { where?: Record<string, unknown> } = {}) => deviceDeposits.filter((d) => (where ? matchWhere(d as unknown as Record<string, unknown>, where) : true)).length },
    exportRequest: {
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => exportRequests.filter((e) => (where ? matchWhere(e as unknown as Record<string, unknown>, where) : true)).map((e) => ({ id: e.id })),
      count: async ({ where }: { where?: Record<string, unknown> } = {}) => exportRequests.filter((e) => (where ? matchWhere(e as unknown as Record<string, unknown>, where) : true)).length
    },
    exportRequestLine: { count: async ({ where }: { where?: { exportRequestId?: { in?: number[] } } } = {}) => { const inIds = where?.exportRequestId?.in; return exportRequestLines.filter((l) => (inIds ? inIds.includes(l.exportRequestId) : true)).length; } },
    deviceSale: { findMany: async () => [] },
    deviceSaleSettlement: { aggregate: async () => ({ _sum: { amount: null } }) },
    user: {
      findUnique: async ({ where }: { where: { id: number } }) => { const u = users.find((x) => x.id === where.id); return u ? userInclude(u) : null; },
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        let list = users;
        if (where && 'deletedAt' in where) list = list.filter((u) => u.deletedAt === (where['deletedAt'] ?? null));
        if (where && 'status' in where) list = list.filter((u) => u.status === where['status']);
        if (where && 'id' in where && where['id'] && typeof where['id'] === 'object') { const ids = (where['id'] as { in: number[] }).in; return list.filter((u) => ids.includes(u.id)).map((u) => ({ id: u.id, fullName: u.fullName, username: u.username })); }
        return list.map((u) => userInclude(u));
      }
    },
    message: { createMany: async ({ data }: { data: Record<string, unknown>[] }) => { messages.push(...data); return { count: data.length }; } },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({}) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db)
  };
  return { db: db as unknown as Db, reqs, tids, customers, posDevices, deviceDeposits, exportRequests, audits, messages };
}
const ctx = (db: Db, user: AuthUser): ServiceCtx => ({ db, user });

describe('entity-cancel — TẠO yêu cầu', () => {
  it('loại không hỗ trợ → VALIDATION', async () => {
    const { db } = makeDb({});
    const r = await requestEntityCancel(ctx(db, authUser(1, [])), 'Fund', 1, 'x');
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Loại dữ liệu không hỗ trợ duyệt hủy.');
  });

  it('thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeDb({});
    const r = await requestEntityCancel(ctx(db, authUser(1, [])), 'Tid', 1, 'x');
    expect(r.error).toBe('FORBIDDEN');
  });

  it('TID đang gắn máy → IN_USE (precheck)', async () => {
    const { db } = makeDb({ tids: [{ id: 1, tid: 'T1', deletedAt: null, posSerial: 'SER1' }] });
    const r = await requestEntityCancel(ctx(db, authUser(1, ['TID_CANCEL_REQUEST'])), 'Tid', 1, 'x');
    expect(r.error).toBe('IN_USE');
    expect(r.message).toContain('SER1');
  });

  it('TID hợp lệ → tạo yêu cầu + audit TID_CANCEL_REQUESTED', async () => {
    const { db, reqs, audits } = makeDb({ tids: [{ id: 1, tid: 'T1', deletedAt: null, posSerial: null }], users: [{ id: 1, fullName: 'U1', username: 'u1', deletedAt: null, status: 'ACTIVE', permCodes: ['TID_CANCEL_REQUEST'] }] });
    const r = await requestEntityCancel(ctx(db, authUser(1, ['TID_CANCEL_REQUEST'])), 'Tid', 1, 'hỏng');
    expect(r.ok).toBe(true);
    expect(reqs[0]!.entityType).toBe('Tid');
    expect(audits.some((a) => a['action'] === 'TID_CANCEL_REQUESTED')).toBe(true);
  });

  it('đã có yêu cầu PENDING → ALREADY_PENDING', async () => {
    const { db } = makeDb({
      tids: [{ id: 1, tid: 'T1', deletedAt: null, posSerial: null }],
      reqs: [{ id: 5, entityType: 'Tid', entityId: 1, action: 'CANCEL', reason: 'r', status: 'PENDING', requestedBy: 2, requestedAt: new Date() }],
      users: [{ id: 1, fullName: 'U1', username: 'u1', deletedAt: null, status: 'ACTIVE', permCodes: ['TID_CANCEL_REQUEST'] }]
    });
    const r = await requestEntityCancel(ctx(db, authUser(1, ['TID_CANCEL_REQUEST'])), 'Tid', 1, 'x');
    expect(r.error).toBe('ALREADY_PENDING');
  });
});

describe('entity-cancel — DUYỆT / TỪ CHỐI', () => {
  const req: Req = { id: 10, entityType: 'Tid', entityId: 1, action: 'CANCEL', reason: 'r', status: 'PENDING', requestedBy: 2, requestedAt: new Date() };

  it('tự duyệt KHÔNG elevated → SELF_APPROVAL_FORBIDDEN', async () => {
    const { db } = makeDb({
      tids: [{ id: 1, tid: 'T1', deletedAt: null, posSerial: null }],
      reqs: [{ ...req, requestedBy: 5 }],
      users: [{ id: 5, fullName: 'U5', username: 'u5', deletedAt: null, status: 'ACTIVE', permCodes: ['TID_CANCEL_APPROVE'] }]
    });
    const r = await approveEntityCancel(ctx(db, authUser(5, ['TID_CANCEL_APPROVE'])), 'Tid', 10);
    expect(r.error).toBe('SELF_APPROVAL_FORBIDDEN');
  });

  it('approver khác duyệt → OK + TID soft-delete + audit TID_CANCEL_APPROVED', async () => {
    const { db, tids, reqs, audits } = makeDb({
      tids: [{ id: 1, tid: 'T1', deletedAt: null, posSerial: null }],
      reqs: [{ ...req, requestedBy: 2 }],
      users: [{ id: 2, fullName: 'U2', username: 'u2', deletedAt: null, status: 'ACTIVE', permCodes: [] }]
    });
    const r = await approveEntityCancel(ctx(db, authUser(9, ['TID_CANCEL_APPROVE'])), 'Tid', 10);
    expect(r.ok).toBe(true);
    expect(tids[0]!.deletedAt).toBeInstanceOf(Date);
    expect(reqs[0]!.status).toBe('APPROVED');
    expect(audits.some((a) => a['action'] === 'TID_CANCEL_APPROVED')).toBe(true);
  });

  it('từ chối thiếu lý do → VALIDATION; có lý do → OK', async () => {
    const { db, reqs } = makeDb({
      tids: [{ id: 1, tid: 'T1', deletedAt: null, posSerial: null }],
      reqs: [{ ...req, requestedBy: 2 }],
      users: [{ id: 2, fullName: 'U2', username: 'u2', deletedAt: null, status: 'ACTIVE', permCodes: [] }]
    });
    const bad = await rejectEntityCancel(ctx(db, authUser(9, ['TID_CANCEL_APPROVE'])), 'Tid', 10, '  ');
    expect(bad.error).toBe('VALIDATION');
    const ok = await rejectEntityCancel(ctx(db, authUser(9, ['TID_CANCEL_APPROVE'])), 'Tid', 10, 'không đúng');
    expect(ok.ok).toBe(true);
    expect(reqs[0]!.status).toBe('REJECTED');
  });

  it('Customer sạch quan hệ → precheck qua + tạo yêu cầu', async () => {
    const { db } = makeDb({
      customers: [{ id: 1, code: 'KH01', fullName: 'Khách A', deletedAt: null }],
      users: [{ id: 1, fullName: 'U1', username: 'u1', deletedAt: null, status: 'ACTIVE', permCodes: ['CUSTOMER_CANCEL_REQUEST'] }]
    });
    const r = await requestEntityCancel(ctx(db, authUser(1, ['CUSTOMER_CANCEL_REQUEST'])), 'Customer', 1, 'nghỉ');
    expect(r.ok).toBe(true);
  });
});

describe('entity-cancel — DANH SÁCH', () => {
  it('không quyền APPROVE nào → FORBIDDEN', async () => {
    const { db } = makeDb({});
    const r = await listEntityCancelRequests(ctx(db, authUser(1, [])));
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền duyệt hủy.');
  });

  it('có quyền → trả DTO gộp loại được duyệt', async () => {
    const { db } = makeDb({
      tids: [{ id: 1, tid: 'T1', deletedAt: null, posSerial: null }],
      reqs: [{ id: 10, entityType: 'Tid', entityId: 1, action: 'CANCEL', reason: 'r', status: 'PENDING', requestedBy: 2, requestedAt: new Date() }],
      users: [{ id: 2, fullName: 'Nhân Viên', username: 'nv', deletedAt: null, status: 'ACTIVE', permCodes: [] }]
    });
    const r = await listEntityCancelRequests(ctx(db, authUser(9, ['TID_CANCEL_APPROVE'])));
    expect(r.ok).toBe(true);
    expect(r.data![0]!.entityTypeLabel).toBe('TID');
    expect(r.data![0]!.entityLabel).toBe('T1');
    expect(r.data![0]!.canApprove).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// REGRESSION — audit cụm DUYỆT HỦY (R201: lõi LIVE @sigma/services). 4 bug:
//   BUG-1 Customer.applyCancel re-guard PHẢI đủ 5 quan hệ (thiếu phiếu xuất PENDING + nợ device-sale).
//   BUG-2 Guard "TID trong export PENDING" = code chết → đã XÓA (precheck TID không đụng exportRequestLine).
//   BUG-4 PosDevice PHẢI chặn DEPLOYED / giữ khách / cọc OPEN theo serial (precheck + re-guard lúc duyệt).
//   (BUG-3 export self-approve ROLE→PERMISSION: TENTATIVE — không đổi vì thiếu permission catalog.)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('entity-cancel — REGRESSION cụm duyệt hủy', () => {
  const custReq = (id: number): Req => ({ id, entityType: 'Customer', entityId: 1, action: 'CANCEL', reason: 'r', status: 'PENDING', requestedBy: 2, requestedAt: new Date() });

  it('BUG-1: duyệt hủy khách có PHIẾU XUẤT KHO PENDING → IN_USE (re-guard 5/5), khách KHÔNG bị xóa', async () => {
    const { db, customers } = makeDb({
      customers: [{ id: 1, code: 'KH01', fullName: 'Khách A', deletedAt: null }],
      reqs: [custReq(10)],
      users: [{ id: 2, fullName: 'U2', username: 'u2', deletedAt: null, status: 'ACTIVE', permCodes: [] }],
      exportRequests: [{ id: 1, customerId: 1, status: 'PENDING' }]
    });
    const r = await approveEntityCancel(ctx(db, authUser(9, ['CUSTOMER_CANCEL_APPROVE'])), 'Customer', 10);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('IN_USE');
    expect(r.message).toContain('phiếu yêu cầu xuất kho');
    expect(customers[0]!.deletedAt).toBeNull(); // rollback re-guard
  });

  it('BUG-4a: precheck máy POS DEPLOYED / đang giữ khách → IN_USE', async () => {
    const { db } = makeDb({
      posDevices: [{ id: 1, serial: 'S1', status: 'DEPLOYED', currentTid: null, currentCustomerId: 5, deletedAt: null }],
      users: [{ id: 1, fullName: 'U1', username: 'u1', deletedAt: null, status: 'ACTIVE', permCodes: ['POS_CANCEL_REQUEST'] }]
    });
    const r = await requestEntityCancel(ctx(db, authUser(1, ['POS_CANCEL_REQUEST'])), 'PosDevice', 1, 'hủy máy giao khách');
    expect(r.error).toBe('IN_USE');
    expect(r.message).toContain('đang giao khách');
  });

  it('BUG-4b: precheck máy POS còn CỌC OPEN theo serial → IN_USE', async () => {
    const { db } = makeDb({
      posDevices: [{ id: 2, serial: 'S2', status: 'IN_STOCK', currentTid: null, currentCustomerId: null, deletedAt: null }],
      deviceDeposits: [{ deviceSerial: 'S2', status: 'OPEN' }],
      users: [{ id: 1, fullName: 'U1', username: 'u1', deletedAt: null, status: 'ACTIVE', permCodes: ['POS_CANCEL_REQUEST'] }]
    });
    const r = await requestEntityCancel(ctx(db, authUser(1, ['POS_CANCEL_REQUEST'])), 'PosDevice', 2, 'hủy máy còn cọc');
    expect(r.error).toBe('IN_USE');
    expect(r.message).toContain('cọc');
  });

  it('BUG-4c: re-guard lúc DUYỆT — máy sạch → DEPLOYED trước khi duyệt → IN_USE, máy KHÔNG bị xóa', async () => {
    const { db, posDevices } = makeDb({
      posDevices: [{ id: 3, serial: 'S3', status: 'IN_STOCK', currentTid: null, currentCustomerId: null, deletedAt: null }],
      reqs: [{ id: 20, entityType: 'PosDevice', entityId: 3, action: 'CANCEL', reason: 'r', status: 'PENDING', requestedBy: 2, requestedAt: new Date() }],
      users: [{ id: 2, fullName: 'U2', username: 'u2', deletedAt: null, status: 'ACTIVE', permCodes: [] }]
    });
    posDevices[0]!.status = 'DEPLOYED';
    posDevices[0]!.currentCustomerId = 5; // phát sinh giao khách sau khi tạo yêu cầu
    const r = await approveEntityCancel(ctx(db, authUser(9, ['POS_CANCEL_APPROVE'])), 'PosDevice', 20);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('IN_USE');
    expect(posDevices[0]!.deletedAt).toBeNull();
  });

  it('BUG-2: precheck TID KHÔNG còn chặn theo phiếu xuất PENDING (code chết đã xóa) → tạo yêu cầu OK', async () => {
    const { db } = makeDb({
      tids: [{ id: 1, tid: 'T1', deletedAt: null, posSerial: null }],
      users: [{ id: 1, fullName: 'U1', username: 'u1', deletedAt: null, status: 'ACTIVE', permCodes: ['TID_CANCEL_REQUEST'] }],
      // Dữ liệu mà GUARD CHẾT cũ tưởng sẽ chặn: phiếu xuất PENDING + dòng ExportRequestLine tham chiếu T1.
      exportRequests: [{ id: 1, customerId: 1, status: 'PENDING' }],
      exportRequestLines: [{ exportRequestId: 1, tid: 'T1' }]
    });
    const r = await requestEntityCancel(ctx(db, authUser(1, ['TID_CANCEL_REQUEST'])), 'Tid', 1, 'hỏng, cần hủy');
    expect(r.ok).toBe(true); // guard chết đã bỏ → không còn IN_USE giả
  });
});

// ───────── DUYỆT GỘP (13/11, sau B152: 1 mật khẩu cho cả lô thay vì 1 request/phiếu) ─────────
describe('entity-cancel — DUYỆT GỘP cả lô', () => {
  const phieu = (id: number, entityId: number, entityType = 'Tid'): Req =>
    ({ id, entityType, entityId, action: 'CANCEL', reason: 'r', status: 'PENDING', requestedBy: 2, requestedAt: new Date() });
  const nguoiTao = { id: 2, fullName: 'U2', username: 'u2', deletedAt: null, status: 'ACTIVE', permCodes: [] };

  it('3 phiếu cùng loại, đủ quyền → done=3, bỏ qua 0, cả 3 TID bị xoá mềm + 3 nhật ký', async () => {
    const { db, tids, reqs, audits } = makeDb({
      tids: [1, 2, 3].map((i) => ({ id: i, tid: `T${i}`, deletedAt: null, posSerial: null })),
      reqs: [phieu(10, 1), phieu(11, 2), phieu(12, 3)],
      users: [nguoiTao]
    });
    const r = await approveEntityCancelBulk(ctx(db, authUser(9, ['TID_CANCEL_APPROVE'])), [
      { entityType: 'Tid', id: 10 }, { entityType: 'Tid', id: 11 }, { entityType: 'Tid', id: 12 }
    ]);
    expect(r.ok).toBe(true);
    expect(r.done).toBe(3);
    expect(r.skipped).toEqual([]);
    expect(tids.every((t) => t.deletedAt instanceof Date)).toBe(true);
    expect(reqs.map((x) => x.status)).toEqual(['APPROVED', 'APPROVED', 'APPROVED']);
    expect(audits.filter((a) => a['action'] === 'TID_CANCEL_APPROVED')).toHaveLength(3);
  });

  it('lô TRỘN loại mà THIẾU quyền 1 loại → chỉ phiếu đó bị bỏ qua FORBIDDEN, phần còn lại VẪN duyệt', async () => {
    const { db, tids, reqs } = makeDb({
      tids: [{ id: 1, tid: 'T1', deletedAt: null, posSerial: null }],
      customers: [{ id: 5, code: 'KH5', fullName: 'Khách 5', deletedAt: null }],
      reqs: [phieu(10, 1), phieu(20, 5, 'Customer')],
      users: [nguoiTao]
    });
    // Chỉ có quyền duyệt TID, KHÔNG có quyền duyệt Khách hàng.
    const r = await approveEntityCancelBulk(ctx(db, authUser(9, ['TID_CANCEL_APPROVE'])), [
      { entityType: 'Tid', id: 10 }, { entityType: 'Customer', id: 20 }
    ]);
    expect(r.ok).toBe(true);
    expect(r.done).toBe(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]!.id).toBe(20);
    expect(r.skipped[0]!.reason).toBe('FORBIDDEN');
    expect(tids[0]!.deletedAt).toBeInstanceOf(Date);
    expect(reqs.find((x) => x.id === 20)!.status).toBe('PENDING'); // phiếu bị bỏ qua KHÔNG đổi trạng thái
  });

  it('phiếu KHÔNG tồn tại / loại lạ → vào danh sách bỏ qua, các phiếu khác vẫn chạy (không đánh đổ cả lô)', async () => {
    const { db, tids } = makeDb({
      tids: [{ id: 1, tid: 'T1', deletedAt: null, posSerial: null }],
      reqs: [phieu(10, 1)],
      users: [nguoiTao]
    });
    const r = await approveEntityCancelBulk(ctx(db, authUser(9, ['TID_CANCEL_APPROVE'])), [
      { entityType: 'Tid', id: 10 }, { entityType: 'Tid', id: 999 }, { entityType: 'KhongCoLoaiNay', id: 1 }
    ]);
    expect(r.done).toBe(1);
    expect(r.skipped.map((x) => x.id)).toEqual([999, 1]);
    expect(r.skipped[1]!.reason).toBe('VALIDATION');
    expect(tids[0]!.deletedAt).toBeInstanceOf(Date);
  });

  it('lô RỖNG → VALIDATION, không duyệt gì', async () => {
    const { db, tids } = makeDb({ tids: [{ id: 1, tid: 'T1', deletedAt: null, posSerial: null }], reqs: [phieu(10, 1)], users: [nguoiTao] });
    const r = await approveEntityCancelBulk(ctx(db, authUser(9, ['TID_CANCEL_APPROVE'])), []);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('VALIDATION');
    expect(r.done).toBe(0);
    expect(tids[0]!.deletedAt).toBeNull();
  });

  it('tự duyệt phiếu CỦA MÌNH trong lô → bỏ qua SELF_APPROVAL_FORBIDDEN (luật 1 phiếu vẫn giữ nguyên trong lô)', async () => {
    const { db, tids } = makeDb({
      tids: [1, 2].map((i) => ({ id: i, tid: `T${i}`, deletedAt: null, posSerial: null })),
      reqs: [{ ...phieu(10, 1), requestedBy: 9 }, phieu(11, 2)],
      users: [nguoiTao, { id: 9, fullName: 'U9', username: 'u9', deletedAt: null, status: 'ACTIVE', permCodes: ['TID_CANCEL_APPROVE'] }]
    });
    const r = await approveEntityCancelBulk(ctx(db, authUser(9, ['TID_CANCEL_APPROVE'])), [
      { entityType: 'Tid', id: 10 }, { entityType: 'Tid', id: 11 }
    ]);
    expect(r.done).toBe(1);
    expect(r.skipped[0]).toMatchObject({ id: 10, reason: 'SELF_APPROVAL_FORBIDDEN' });
    expect(tids[0]!.deletedAt).toBeNull();
    expect(tids[1]!.deletedAt).toBeInstanceOf(Date);
  });
});
