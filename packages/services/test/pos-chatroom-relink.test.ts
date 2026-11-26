// TID-5 (audit 21/8) — "cướp doanh số theo giai đoạn": ĐỔI KHÁCH giữ máy (changeCustomer) và THU HỒI máy (recall)
// phải MAINTAIN link ChatRoomTid. Trước đây changeCustomer chỉ đổi customerId (chatRoomTid GIỮ phòng khách CŨ →
// doanh số TID dồn nhầm về nhóm chat khách cũ); recall reset để chatRoomTid active dù TID không còn khách.
// Db GIẢ in-memory ĐÚNG SHAPE Prisma (khuôn pos.test.ts) — KHÔNG cần Postgres.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { changeCustomerPos, recallPos, type ServiceCtx } from '../src/index.js';

const MANAGE = 'POS_MANAGE';
function authUser(permissions: string[]): AuthUser {
  return { id: 9, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
const ctxOf = (fake: Record<string, unknown>, perms: string[]): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(perms) });

const OLD_CUSTOMER = 100;
const NEW_CUSTOMER = 200;

interface CrtRow { id: number; tidId: number; roomId: string; unlinkedAt: Date | null }

/** Store ChatRoomTid + delegate giả (findFirst/update/create) — ghi lại thao tác để assert. */
function chatStore(seed: CrtRow[]) {
  const rows = seed.map((r) => ({ ...r }));
  let nextId = rows.reduce((m, r) => Math.max(m, r.id), 0) + 1;
  const delegate = {
    findFirst: async ({ where }: { where: { tidId: number; unlinkedAt: null } }) =>
      rows.find((r) => r.tidId === where.tidId && r.unlinkedAt === null) ?? null,
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
      const r = rows.find((x) => x.id === where.id)!;
      Object.assign(r, data);
      return { ...r };
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      const row: CrtRow = { id: nextId++, tidId: data['tidId'] as number, roomId: data['roomId'] as string, unlinkedAt: null };
      rows.push(row);
      return { ...row };
    }
  };
  return { rows, delegate };
}

describe('POS TID-5 — changeCustomer relink phòng chat (chống cướp doanh số)', () => {
  it('đổi khách → khách MỚI có ĐÚNG 1 phòng → soft-unlink phòng CŨ + link phòng MỚI của khách mới', async () => {
    const TID_ID = 11;
    const { rows: crt, delegate: chatRoomTid } = chatStore([{ id: 10, tidId: TID_ID, roomId: 'ROOM_OLD', unlinkedAt: null }]);
    const cur: Record<string, unknown> = { id: 1, serial: 'S1', status: 'DEPLOYED', warehouseId: null, currentTid: 'T1', currentCustomerId: OLD_CUSTOMER, currentAgentId: 7 };
    const fake: Record<string, unknown> = {
      posDevice: { findUnique: async () => ({ ...cur }), update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(cur, data); return { ...cur }; } },
      customer: {
        findFirst: async ({ where }: { where: { id: number } }) => (where.id === NEW_CUSTOMER ? { id: NEW_CUSTOMER } : null),
        // Khách mới #200 gắn đại lý #55 (agentId) → activeRoomIdsForCustomer tra phòng của đại lý này.
        findUnique: async ({ where }: { where: { id: number } }) => (where.id === NEW_CUSTOMER ? { agentId: 55 } : null)
      },
      chatRoomMember: {
        findMany: async ({ where }: { where: { agentId: number } }) => (where.agentId === 55 ? [{ roomId: 'ROOM_NEW' }] : []),
        findFirst: async ({ where }: { where: { roomId: string; agentId: number } }) => (where.roomId === 'ROOM_NEW' && where.agentId === 55 ? { id: 1 } : null)
      },
      chatRoom: { findMany: async ({ where }: { where: { id: { in: string[] } } }) => where.id.in.map((id) => ({ id })) },
      chatRoomTid,
      tid: { updateMany: async () => ({ count: 1 }), findUnique: async () => ({ id: TID_ID }) },
      assetEvent: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) },
      auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) },
      changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) },
      $queryRaw: async () => [],
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] })
    };
    const r = await changeCustomerPos(ctxOf(fake, [MANAGE]), 'S1', { customerId: NEW_CUSTOMER });
    expect(r.ok).toBe(true);
    // Phòng CŨ đã soft-unlink.
    const oldLink = crt.find((x) => x.id === 10)!;
    expect(oldLink.unlinkedAt).not.toBe(null);
    // Có 1 link ACTIVE mới trỏ ROOM_NEW.
    const active = crt.filter((x) => x.unlinkedAt === null);
    expect(active).toHaveLength(1);
    expect(active[0]!.roomId).toBe('ROOM_NEW');
    expect(active[0]!.tidId).toBe(TID_ID);
  });

  it('đổi khách → khách MỚI KHÔNG có đại lý/phòng → CHỈ soft-unlink phòng CŨ (không link mới)', async () => {
    const TID_ID = 11;
    const { rows: crt, delegate: chatRoomTid } = chatStore([{ id: 10, tidId: TID_ID, roomId: 'ROOM_OLD', unlinkedAt: null }]);
    const cur: Record<string, unknown> = { id: 1, serial: 'S1', status: 'DEPLOYED', warehouseId: null, currentTid: 'T1', currentCustomerId: OLD_CUSTOMER, currentAgentId: 7 };
    const fake: Record<string, unknown> = {
      posDevice: { findUnique: async () => ({ ...cur }), update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(cur, data); return { ...cur }; } },
      customer: {
        findFirst: async ({ where }: { where: { id: number } }) => (where.id === NEW_CUSTOMER ? { id: NEW_CUSTOMER } : null),
        findUnique: async () => ({ agentId: null }) // khách mới chưa gắn đại lý → không phòng
      },
      chatRoomMember: { findMany: async () => [], findFirst: async () => null },
      chatRoom: { findMany: async () => [] },
      chatRoomTid,
      tid: { updateMany: async () => ({ count: 1 }), findUnique: async () => ({ id: TID_ID }) },
      assetEvent: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) },
      auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) },
      changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) },
      $queryRaw: async () => [],
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] })
    };
    const r = await changeCustomerPos(ctxOf(fake, [MANAGE]), 'S1', { customerId: NEW_CUSTOMER });
    expect(r.ok).toBe(true);
    // Phòng CŨ đã unlink; KHÔNG có link ACTIVE nào (không tự đoán phòng).
    expect(crt.find((x) => x.id === 10)!.unlinkedAt).not.toBe(null);
    expect(crt.filter((x) => x.unlinkedAt === null)).toHaveLength(0);
  });
});

describe('POS TID-5 — recall thu hồi máy → soft-unlink phòng chat', () => {
  it('recall máy đang mang TID → TID reset (UNASSIGNED, không khách) + chatRoomTid soft-unlink', async () => {
    const TID_ID = 11;
    const { rows: crt, delegate: chatRoomTid } = chatStore([{ id: 10, tidId: TID_ID, roomId: 'ROOM_OLD', unlinkedAt: null }]);
    const cur: Record<string, unknown> = { id: 1, serial: 'S1', status: 'DEPLOYED', warehouseId: null, currentTid: 'T1', currentCustomerId: OLD_CUSTOMER, currentAgentId: 7 };
    const tidRow = { id: TID_ID, tid: 'T1', status: 'ACTIVE', posSerial: 'S1', customerId: OLD_CUSTOMER, agentId: 7 };
    const fake: Record<string, unknown> = {
      posDevice: {
        findUnique: async () => ({ ...cur }),
        update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(cur, data); return { ...cur }; },
        updateMany: async () => ({ count: 1 })
      },
      warehouse: { findFirst: async ({ where }: { where: { id: number } }) => (where.id === 1 ? { id: 1, deletedAt: null, address: '12 Kho', managerUserId: null } : null) },
      tid: { findUnique: async () => ({ ...tidRow }), update: async () => ({}) },
      posTidBinding: { updateMany: async () => ({ count: 1 }) },
      chatRoomTid,
      // recall hoàn cọc: không có cọc OPEN → rỗng.
      deviceDeposit: { findMany: async () => [] },
      assetEvent: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) },
      auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) },
      changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) },
      $queryRaw: async () => [],
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] })
    };
    const r = await recallPos(ctxOf(fake, [MANAGE]), 'S1', { toWarehouseId: 1 });
    expect(r.ok).toBe(true);
    // chatRoomTid của TID đã soft-unlink (không còn link active).
    expect(crt.find((x) => x.id === 10)!.unlinkedAt).not.toBe(null);
    expect(crt.filter((x) => x.unlinkedAt === null)).toHaveLength(0);
  });
});
