// REGRESSION (Admin Demo chốt 12/8) — "Đổi khách giữ máy" (changeCustomer) KHÔNG được đụng cọc (DeviceDeposit):
// cọc luôn GẮN với KHÁCH ĐÃ ĐẶT CỌC (khách CŨ). Khi sau đó THU HỒI máy (recall), tiền hoàn cọc phải về ĐÚNG
// khách CŨ — người thật sự đã bỏ tiền cọc — KHÔNG theo khách MỚI vừa đổi. Đây là 2 bất biến độc lập:
//   (A) changeCustomer: chỉ đổi posDevice.currentCustomerId + tid.customerId (TID theo máy) — TUYỆT ĐỐI KHÔNG
//       ghi/sửa DeviceDeposit (deviceDeposit.update KHÔNG bao giờ được gọi).
//   (B) recall: refundOpenDepositsForSerialTx dùng dep.customerId (khách trên chứng từ cọc = khách CŨ) làm
//       customerId của bút toán CHI hoàn cọc — KHÔNG dùng currentCustomerId hiện tại của máy.
// Db GIẢ in-memory ĐÚNG SHAPE Prisma (cùng khuôn pos.test.ts) — KHÔNG cần Postgres.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { changeCustomerPos, recallPos, type ServiceCtx } from '../src/index.js';

const MANAGE = 'POS_MANAGE';
function authUser(permissions: string[]): AuthUser {
  return { id: 9, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
const ctxOf = (fake: Record<string, unknown>, perms: string[]): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(perms) });

const OLD_CUSTOMER = 100; // khách đã đặt cọc + đang giữ máy
const NEW_CUSTOMER = 200; // khách mới nhận máy sau khi "Đổi khách giữ máy"

describe('POS đổi khách giữ máy — cọc KHÔNG theo khách mới (Admin Demo 12/8)', () => {
  it('(A) changeCustomer đổi currentCustomerId + TID theo máy, TUYỆT ĐỐI KHÔNG đụng DeviceDeposit (cọc giữ khách CŨ)', async () => {
    const audits: Record<string, unknown>[] = [];
    const events: Record<string, unknown>[] = [];
    const tidUpdates: Record<string, unknown>[] = [];
    const depositUpdates: Record<string, unknown>[] = [];
    const cur: Record<string, unknown> = { id: 1, serial: 'S1', status: 'DEPLOYED', warehouseId: null, currentTid: 'T1', currentCustomerId: OLD_CUSTOMER, currentAgentId: 7 };

    const fake: Record<string, unknown> = {
      posDevice: {
        findUnique: async () => ({ ...cur }),
        update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(cur, data); return { ...cur }; }
      },
      // Khách MỚI id=200 hợp lệ (tồn tại, chưa xóa). findUnique (agentId null) cho nhánh TID-5 relink phòng chat:
      // khách mới CHƯA gắn đại lý → không có phòng → chỉ soft-unlink phòng cũ (không đụng cọc).
      customer: {
        findFirst: async ({ where }: { where: { id: number } }) => (where.id === NEW_CUSTOMER ? { id: NEW_CUSTOMER } : null),
        findUnique: async ({ where }: { where: { id: number } }) => (where.id === NEW_CUSTOMER ? { agentId: null } : null)
      },
      tid: {
        updateMany: async ({ data }: { data: Record<string, unknown> }) => { tidUpdates.push({ ...data }); return { count: 1 }; },
        findUnique: async () => ({ id: 11 })
      },
      // TID-5: relink phòng chat — khách mới không có phòng → unlinkActiveTidRoom tra chatRoomTid (không có phòng active → no-op).
      chatRoomTid: { findFirst: async () => null, update: async () => ({}), create: async () => ({}) },
      assetEvent: { create: async ({ data }: { data: Record<string, unknown> }) => { events.push({ ...data }); return { ...data }; } },
      // CỌC: nếu changeCustomer GHI vào đây thì test PHẢI đỏ. update là bẫy — ghi lại mọi lần gọi.
      deviceDeposit: {
        findMany: async () => { depositUpdates.push({ called: 'findMany' }); return []; },
        update: async ({ data }: { data: Record<string, unknown> }) => { depositUpdates.push({ ...data }); return { ...data }; }
      },
      auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
      changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) },
      $queryRaw: async () => [],
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] })
    };

    const r = await changeCustomerPos(ctxOf(fake, [MANAGE]), 'S1', { customerId: NEW_CUSTOMER });
    expect(r.ok).toBe(true);
    // Máy đổi sang khách MỚI.
    expect(cur.currentCustomerId).toBe(NEW_CUSTOMER);
    // TID đi theo MÁY → gán khách MỚI.
    expect(tidUpdates).toHaveLength(1);
    expect(tidUpdates[0]!['customerId']).toBe(NEW_CUSTOMER);
    // BẤT BIẾN CHÍNH: cọc TUYỆT ĐỐI không bị đụng — deviceDeposit.update KHÔNG được gọi lần nào.
    expect(depositUpdates.every((d) => d['called'] === 'findMany')).toBe(true);
    expect(depositUpdates.some((d) => 'customerId' in d || 'status' in d)).toBe(false);
  });

  it('(B) recall sau khi đã đổi khách → hoàn cọc về ĐÚNG khách CŨ (dep.customerId), KHÔNG theo khách hiện tại của máy', async () => {
    const cashEntries: Record<string, unknown>[] = [];
    const refunds: Record<string, unknown>[] = [];
    const depositStatus: Record<number, string> = { 50: 'OPEN' };
    // Máy hiện GIỮ bởi khách MỚI (200) sau khi đã changeCustomer. currentTid=null để cô lập nghiệp vụ cọc.
    const cur: Record<string, unknown> = { id: 1, serial: 'S1', status: 'DEPLOYED', warehouseId: null, currentTid: null, currentCustomerId: NEW_CUSTOMER, currentAgentId: 7 };
    // Chứng từ cọc GẮN khách CŨ (100) — người thật sự bỏ tiền cọc.
    const deposit = { id: 50, code: 'CO01', deviceSerial: 'S1', tid: null, status: 'OPEN', customerId: OLD_CUSTOMER, amount: 5_000_000n };

    const fake: Record<string, unknown> = {
      posDevice: {
        findUnique: async () => ({ ...cur }),
        update: async ({ data }: { data: Record<string, unknown> }) => { Object.assign(cur, data); return { ...cur }; }
      },
      warehouse: { findFirst: async ({ where }: { where: { id: number } }) => (where.id === 1 ? { id: 1, deletedAt: null, address: '12 Kho', managerUserId: null } : null) },
      assetEvent: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) },
      deviceDeposit: {
        findMany: async () => [{ id: deposit.id }],
        findUnique: async ({ where }: { where: { id: number } }) => (where.id === deposit.id ? { ...deposit, status: depositStatus[deposit.id] } : null),
        update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { if (data['status']) depositStatus[where.id] = data['status'] as string; return { ...deposit, ...data }; }
      },
      deviceDepositRefund: {
        aggregate: async () => ({ _sum: { amount: 0n } }),
        create: async ({ data }: { data: Record<string, unknown> }) => { refunds.push({ ...data }); return { ...data }; }
      },
      cashCategory: { findFirst: async () => ({ id: 1 }) },
      cashEntry: {
        findFirst: async () => ({ fundId: 1 }),
        create: async ({ data }: { data: Record<string, unknown> }) => { cashEntries.push({ ...data }); return { id: 999, ...data }; }
      },
      codeCounter: { upsert: async ({ where }: { where: { prefix: string } }) => ({ prefix: where.prefix, lastValue: 1 }) },
      auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => ({ ...data }) },
      changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) },
      $queryRaw: async () => [],
      $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({ ...fake, $queryRaw: async () => [] })
    };

    const r = await recallPos(ctxOf(fake, [MANAGE]), 'S1', { toWarehouseId: 1, fundId: 1, method: 'CK' });
    expect(r.ok).toBe(true);
    // Có ĐÚNG 1 bút toán CHI hoàn cọc.
    expect(cashEntries).toHaveLength(1);
    // BẤT BIẾN CHÍNH: hoàn về khách CŨ (100) — người đặt cọc — KHÔNG phải khách hiện tại của máy (200).
    expect(cashEntries[0]!['customerId']).toBe(OLD_CUSTOMER);
    expect(cashEntries[0]!['customerId']).not.toBe(NEW_CUSTOMER);
    expect(cashEntries[0]!['kind']).toBe('CHI');
    expect(cashEntries[0]!['amount']).toBe(5_000_000n);
    // Cọc đã đóng (REFUNDED) sau khi hoàn.
    expect(depositStatus[50]).toBe('REFUNDED');
    expect(refunds).toHaveLength(1);
  });
});
