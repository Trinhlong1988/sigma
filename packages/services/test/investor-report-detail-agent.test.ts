// REGRESSION (Admin Demo 2/9 "lấp cột Đại lý ở báo cáo NĐT"): investorReportDetail resolve TÊN ĐẠI LÝ per-lô qua
// TID.customer_id → customer_chat_groups(unassigned_at IS NULL) → chat_rooms.name. Test khẳng định:
//  • khách map ĐÚNG 1 phòng đang hoạt động → agentName = tên phòng;
//  • khách map >1 phòng (không 1-1) → agentName = '' (KHÔNG bịa);
//  • bill không có customer_id → agentName = '';
//  • phòng ĐÃ GỠ (unassigned_at != null) KHÔNG làm khách 1-phòng thành "nhiều phòng".
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { investorReportDetail, type ServiceCtx } from '../src/index.js';
import { table, type Rec } from './_fake-db.js';

const INV = 15;
const authUser = (permissions: string[]): AuthUser =>
  ({ id: 7, username: 't', fullName: 'T', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions });

// 3 bill: customer 212 (1 phòng active) · customer 999 (2 phòng active) · customer_id null.
const D = new Date('2026-09-01T05:00:00Z'); // 12:00 VN — trong kỳ.
const txnRows: Rec[] = [
  { amount: 10_000_000n, phi_cai_may_milli: 0, install_fee_amount: 0, txn_date: D, tid: '531', customer_id: 212, tid_fee: 100, hkd_name: 'HKD A', bank_name: 'MB', so_lo: '1', bill_key: 'nat|531|1|' },
  { amount: 20_000_000n, phi_cai_may_milli: 0, install_fee_amount: 0, txn_date: D, tid: '532', customer_id: 999, tid_fee: 100, hkd_name: 'HKD B', bank_name: 'MB', so_lo: '2', bill_key: 'nat|532|2|' },
  { amount: 30_000_000n, phi_cai_may_milli: 0, install_fee_amount: 0, txn_date: D, tid: '533', customer_id: null, tid_fee: 100, hkd_name: 'HKD C', bank_name: 'MB', so_lo: '3', bill_key: 'nat|533|3|' }
];

function makeDb(): Rec {
  return {
    investor: table([{ id: INV, fullName: 'Ông Thông', nickname: 'Thông', investFeeMilli: 100, deletedAt: null }]),
    // Chỉ có nhánh transactions (advances → []). Trả nguyên txnRows (đã đúng snake_case shape service đọc).
    $queryRawUnsafe: async (sql: string) => (sql.includes('investor_advances') ? [] : txnRows),
    customerChatGroup: table([
      { customerId: 212, roomId: 'room-binh', unassignedAt: null },
      { customerId: 212, roomId: 'room-old', unassignedAt: new Date('2026-01-01T00:00:00Z') }, // đã gỡ → bỏ qua
      { customerId: 999, roomId: 'room-a', unassignedAt: null },
      { customerId: 999, roomId: 'room-b', unassignedAt: null } // 2 phòng active → không 1-1
    ]),
    chatRoom: table([
      { id: 'room-binh', name: 'ĐL- Anh Bình Sài Gòn' },
      { id: 'room-a', name: 'ĐL A' },
      { id: 'room-b', name: 'ĐL B' }
    ])
  };
}

const ctx = (db: Rec): ServiceCtx => ({ db: db as unknown as Db, user: authUser(['REVENUE_VIEW']) });
const KY = { investorId: INV, from: '2026-09-01', to: '2026-09-01' };

describe('investorReportDetail — tên đại lý per-lô [Admin Demo 2/9]', () => {
  it('khách 1 phòng → tên phòng; khách >1 phòng → ""; không customer → ""', async () => {
    const r = await investorReportDetail(ctx(makeDb()), KY);
    expect(r.ok).toBe(true);
    const byTid = new Map(r.data!.bills.map((b) => [b.tid, b.agentName]));
    expect(byTid.get('531')).toBe('ĐL- Anh Bình Sài Gòn'); // đúng 1 phòng active (phòng đã gỡ không tính)
    expect(byTid.get('532')).toBe(''); // 2 phòng active → không 1-1 → trống
    expect(byTid.get('533')).toBe(''); // customer_id null → trống
  });
});
