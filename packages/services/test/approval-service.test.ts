// Test LÕI THUẦN approval-service (@sigma/services) — Db GIẢ in-memory + ServiceCtx = { db, user }. ASSERT giá trị cụ thể:
// error code + nguyên văn message tiếng Việt + audit + phân vai (self/elevated). §14 mật khẩu ở ADAPTER (lõi KHÔNG kiểm).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { requestCancelBill, approveCancelBill, rejectCancelBill, listCancelRequests, type ServiceCtx } from '../src/index.js';

const REQUEST = 'BILL_CANCEL_REQUEST';
const APPROVE = 'BILL_CANCEL_APPROVE';
const ELEVATED = 'BILL_CANCEL_APPROVE_ELEVATED';

function authUser(id: number, permissions: string[]): AuthUser {
  return { id, username: `u${id}`, fullName: `User ${id}`, status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

interface Tx { id: number; status: string; deletedAt: Date | null; code: string; amount: number; revenueAmount?: number; updatedBy?: number | null; cancelReason?: string | null; cancelRequestId?: number | null; cancelledAt?: Date | null }
interface Req { id: number; entityType: string; entityId: number; action: string; reason: string; status: string; requestedBy: number; requestedAt: Date; decidedBy?: number | null; decidedAt?: Date | null; decisionNote?: string | null }
interface Usr { id: number; fullName: string; username: string; deletedAt: Date | null; status: string; permCodes: string[] }

function makeDb(seed: { txs?: Tx[]; reqs?: Req[]; users?: Usr[] }) {
  const txs = seed.txs ?? [];
  const reqs = seed.reqs ?? [];
  const users = seed.users ?? [];
  const audits: Record<string, unknown>[] = [];
  const messages: Record<string, unknown>[] = [];
  let reqId = reqs.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const userInclude = (u: Usr) => ({ ...u, roles: [{ role: { code: 'R', permissions: u.permCodes.map((c) => ({ permission: { code: c } })) } }] });
  const matchWhere = <T extends Record<string, unknown>>(row: T, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (v !== null && typeof v === 'object' && 'not' in (v as object)) return (row as Record<string, unknown>)[k] !== (v as { not: unknown }).not;
      return (row as Record<string, unknown>)[k] === v;
    });
  const db = {
    transaction: {
      findUnique: async ({ where }: { where: { id: number } }) => txs.find((t) => t.id === where.id) ?? null,
      findMany: async ({ where }: { where: { id: { in: number[] } } }) => txs.filter((t) => where.id.in.includes(t.id)).map((t) => ({ ...t })),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const t of txs) if (matchWhere(t as unknown as Record<string, unknown>, where)) { Object.assign(t, data); count++; }
        return { count };
      }
    },
    approvalRequest: {
      findUnique: async ({ where }: { where: { id: number } }) => reqs.find((r) => r.id === where.id) ?? null,
      findMany: async ({ where }: { where: Record<string, unknown> }) => reqs.filter((r) => matchWhere(r as unknown as Record<string, unknown>, where)).map((r) => ({ ...r })),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        let count = 0;
        for (const r of reqs) if (matchWhere(r as unknown as Record<string, unknown>, where)) { Object.assign(r, data); count++; }
        return { count };
      },
      create: async ({ data }: { data: Record<string, unknown> }) => { const row = { id: reqId++, status: 'PENDING', requestedAt: new Date(), ...data } as unknown as Req; reqs.push(row); return { ...row }; }
    },
    user: {
      findUnique: async ({ where }: { where: { id: number } }) => { const u = users.find((x) => x.id === where.id); return u ? userInclude(u) : null; },
      findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
        let list = users;
        if (where && 'deletedAt' in where) list = list.filter((u) => u.deletedAt === (where['deletedAt'] ?? null));
        if (where && 'status' in where) list = list.filter((u) => u.status === where['status']);
        if (where && 'id' in where && where['id'] && typeof where['id'] === 'object') { const ids = (where['id'] as { in: number[] }).in; list = list.filter((u) => ids.includes(u.id)); return list.map((u) => ({ id: u.id, fullName: u.fullName, username: u.username })); }
        return list.map((u) => userInclude(u));
      }
    },
    message: { createMany: async ({ data }: { data: Record<string, unknown>[] }) => { messages.push(...data); return { count: data.length }; } },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({}) },
    // [B309 24/11] duyệt-hủy nay hủy CẢ LÔ qua raw SQL — mock trả 0 dòng (không có bảng los trong mock
    // này, test chỉ khẳng định GD CANCELLED). Shape đúng: executeRaw* trả số dòng ảnh hưởng.
    $executeRawUnsafe: async () => 0,
    // [B323 24/11] guard "GD đã thu công nợ thì không hủy" đếm cashDebtSettlement — test này không seed
    // phiếu thu ⇒ 0 (bill hủy được bình thường). Shape đúng: count trả number.
    cashDebtSettlement: { count: async () => 0 },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db)
  };
  return { db: db as unknown as Db, txs, reqs, audits, messages };
}

function ctx(db: Db, user: AuthUser): ServiceCtx { return { db, user }; }

describe('approval-service — TẠO yêu cầu hủy bill', () => {
  it('thiếu quyền REQUEST → FORBIDDEN nguyên văn', async () => {
    const { db } = makeDb({});
    const r = await requestCancelBill(ctx(db, authUser(1, [])), 1, 'lý do');
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('thiếu lý do → VALIDATION', async () => {
    const { db } = makeDb({});
    const r = await requestCancelBill(ctx(db, authUser(1, [REQUEST])), 1, '  ');
    expect(r.error).toBe('VALIDATION');
    expect(r.message).toBe('Vui lòng nhập lý do hủy bill.');
  });

  it('bill không tồn tại → NOT_FOUND', async () => {
    const { db } = makeDb({});
    const r = await requestCancelBill(ctx(db, authUser(1, [REQUEST])), 99, 'x');
    expect(r.error).toBe('NOT_FOUND');
  });

  it('bill không POSTED → INVALID_STATE', async () => {
    const { db } = makeDb({ txs: [{ id: 1, status: 'CANCEL_PENDING', deletedAt: null, code: 'B1', amount: 100 }] });
    const r = await requestCancelBill(ctx(db, authUser(1, [REQUEST])), 1, 'x');
    expect(r.error).toBe('INVALID_STATE');
  });

  it('[B323] bill ĐÃ THU CÔNG NỢ → TXN_HAS_SETTLEMENT, KHÔNG tạo yêu cầu hủy', async () => {
    const { db, txs, reqs } = makeDb({ txs: [{ id: 1, status: 'POSTED', deletedAt: null, code: 'B1', amount: 100 }] });
    // GD có 1 phiếu thu công nợ — hủy sẽ làm phiếu + quỹ mồ côi (twin-path deleteTransactions đã chặn).
    (db as unknown as { cashDebtSettlement: { count: (a: unknown) => Promise<number> } }).cashDebtSettlement.count = async () => 1;
    const r = await requestCancelBill(ctx(db, authUser(1, [REQUEST])), 1, 'thử hủy GD đã thu');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('TXN_HAS_SETTLEMENT');
    expect(txs[0]!.status).toBe('POSTED'); // KHÔNG chuyển CANCEL_PENDING
    expect(reqs.length).toBe(0);
  });

  it('hợp lệ → tạo yêu cầu CANCEL_PENDING + audit BILL_CANCEL_REQUESTED', async () => {
    const { db, txs, reqs, audits } = makeDb({ txs: [{ id: 1, status: 'POSTED', deletedAt: null, code: 'B1', amount: 100 }], users: [{ id: 1, fullName: 'U1', username: 'u1', deletedAt: null, status: 'ACTIVE', permCodes: [REQUEST] }] });
    const r = await requestCancelBill(ctx(db, authUser(1, [REQUEST])), 1, 'sai số tiền');
    expect(r.ok).toBe(true);
    expect(txs[0]!.status).toBe('CANCEL_PENDING');
    expect(reqs[0]!.reason).toBe('sai số tiền');
    expect(audits.some((a) => a['action'] === 'BILL_CANCEL_REQUESTED')).toBe(true);
  });
});

describe('approval-service — DUYỆT / TỪ CHỐI (phân vai)', () => {
  const baseReq: Req = { id: 10, entityType: 'Transaction', entityId: 1, action: 'CANCEL', reason: 'r', status: 'PENDING', requestedBy: 2, requestedAt: new Date() };

  it('tự duyệt KHÔNG elevated → SELF_APPROVAL_FORBIDDEN + audit denied', async () => {
    const { db, audits } = makeDb({
      txs: [{ id: 1, status: 'CANCEL_PENDING', deletedAt: null, code: 'B1', amount: 100 }],
      reqs: [{ ...baseReq, requestedBy: 5 }],
      users: [{ id: 5, fullName: 'U5', username: 'u5', deletedAt: null, status: 'ACTIVE', permCodes: [APPROVE] }]
    });
    const r = await approveCancelBill(ctx(db, authUser(5, [APPROVE])), 10);
    expect(r.error).toBe('SELF_APPROVAL_FORBIDDEN');
    expect(r.message).toBe('Chỉ Admin mới được tự duyệt yêu cầu của chính mình.');
    expect(audits.some((a) => a['action'] === 'BILL_CANCEL_APPROVED')).toBe(true);
  });

  it('yêu cầu của Manager (có APPROVE) mà approver không elevated → NEED_ELEVATED', async () => {
    const { db } = makeDb({
      txs: [{ id: 1, status: 'CANCEL_PENDING', deletedAt: null, code: 'B1', amount: 100 }],
      reqs: [{ ...baseReq, requestedBy: 2 }],
      users: [{ id: 2, fullName: 'U2', username: 'u2', deletedAt: null, status: 'ACTIVE', permCodes: [APPROVE] }]
    });
    const r = await approveCancelBill(ctx(db, authUser(9, [APPROVE])), 10);
    expect(r.error).toBe('NEED_ELEVATED');
  });

  it('approver khác duyệt yêu cầu của nhân viên thường → OK + bill CANCELLED + audit', async () => {
    const { db, txs, reqs, audits } = makeDb({
      txs: [{ id: 1, status: 'CANCEL_PENDING', deletedAt: null, code: 'B1', amount: 100, revenueAmount: 100 }],
      reqs: [{ ...baseReq, requestedBy: 2 }],
      users: [{ id: 2, fullName: 'U2', username: 'u2', deletedAt: null, status: 'ACTIVE', permCodes: [] }]
    });
    const r = await approveCancelBill(ctx(db, authUser(9, [APPROVE])), 10);
    expect(r.ok).toBe(true);
    expect(txs[0]!.status).toBe('CANCELLED');
    expect(reqs[0]!.status).toBe('APPROVED');
    expect(audits.some((a) => a['action'] === 'BILL_CANCEL_APPROVED')).toBe(true);
  });

  it('[incident GD04426 25/11] duyệt yêu cầu mà bill ĐÃ CANCELLED trước đó → ĐÓNG yêu cầu + báo RÕ (không "Bill không tồn tại")', async () => {
    const { db, reqs } = makeDb({
      txs: [{ id: 1, status: 'CANCELLED', deletedAt: new Date(), code: 'GD04426', amount: 100 }],
      reqs: [{ ...baseReq, requestedBy: 2 }],
      users: [{ id: 2, fullName: 'U2', username: 'u2', deletedAt: null, status: 'ACTIVE', permCodes: [] }]
    });
    const r = await approveCancelBill(ctx(db, authUser(9, [APPROVE])), 10);
    expect(r.ok).toBe(true);
    expect(r.message).toContain('đã được hủy trước đó');
    expect(reqs[0]!.status).toBe('APPROVED'); // yêu cầu được ĐÓNG, không còn treo PENDING
  });

  it('Admin (elevated) tự duyệt yêu cầu của mình → OK', async () => {
    const { db, txs } = makeDb({
      txs: [{ id: 1, status: 'CANCEL_PENDING', deletedAt: null, code: 'B1', amount: 100 }],
      reqs: [{ ...baseReq, requestedBy: 7 }],
      users: [{ id: 7, fullName: 'U7', username: 'u7', deletedAt: null, status: 'ACTIVE', permCodes: [APPROVE, ELEVATED] }]
    });
    const r = await approveCancelBill(ctx(db, authUser(7, [APPROVE, ELEVATED])), 10);
    expect(r.ok).toBe(true);
    expect(txs[0]!.status).toBe('CANCELLED');
  });

  it('từ chối thiếu lý do → VALIDATION; có lý do → OK + bill hoàn POSTED', async () => {
    const { db, txs, reqs } = makeDb({
      txs: [{ id: 1, status: 'CANCEL_PENDING', deletedAt: null, code: 'B1', amount: 100 }],
      reqs: [{ ...baseReq, requestedBy: 2 }],
      users: [{ id: 2, fullName: 'U2', username: 'u2', deletedAt: null, status: 'ACTIVE', permCodes: [] }]
    });
    const bad = await rejectCancelBill(ctx(db, authUser(9, [APPROVE])), 10, '  ');
    expect(bad.error).toBe('VALIDATION');
    const ok = await rejectCancelBill(ctx(db, authUser(9, [APPROVE])), 10, 'không hợp lệ');
    expect(ok.ok).toBe(true);
    expect(txs[0]!.status).toBe('POSTED');
    expect(reqs[0]!.status).toBe('REJECTED');
  });
});

describe('approval-service — DANH SÁCH', () => {
  it('trả DTO có canApprove theo phân vai', async () => {
    const { db } = makeDb({
      txs: [{ id: 1, status: 'CANCEL_PENDING', deletedAt: null, code: 'B1', amount: 500 }],
      reqs: [{ id: 10, entityType: 'Transaction', entityId: 1, action: 'CANCEL', reason: 'r', status: 'PENDING', requestedBy: 2, requestedAt: new Date() }],
      users: [{ id: 2, fullName: 'Nhân Viên', username: 'nv', deletedAt: null, status: 'ACTIVE', permCodes: [] }]
    });
    const r = await listCancelRequests(ctx(db, authUser(9, [APPROVE])));
    expect(r.ok).toBe(true);
    expect(r.data![0]!.billCode).toBe('B1');
    expect(r.data![0]!.amount).toBe(500);
    expect(r.data![0]!.canApprove).toBe(true);
    expect(r.data![0]!.requestedByName).toBe('Nhân Viên');
  });
});
