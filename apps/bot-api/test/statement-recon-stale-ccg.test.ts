// [Agent-4 phản biện 11/9 — MAP PHÒNG→KHÁCH LẤY CẢ LINK ĐÃ GỠ] reconcileStatement (và findMissingOcrBills) query
// customerChatGroup KHÔNG lọc `unassignedAt: null` — khác MỌI chỗ live khác của repo (agentScopeCustomerIds,
// investorReportDetail agent-name, alpha-aggregate đều lọc active). Phòng đã ĐỔI CHỦ (khách cũ unassigned, khách
// mới active) → Map roomId→customerId last-wins NUỐT khách active bằng dòng stale (thứ tự findMany không đảm bảo)
// → tổng hoàn theo đại lý (byDealer.customerId) + báo cáo bill-thiếu-OCR gán vào KHÁCH CŨ. Cùng họ bug incident
// "đổi chủ máy KÉO doanh số sang đại lý mới". Fake db ở đây TÔN TRỌNG where.unassignedAt (khác fake cũ bỏ qua
// where) — xếp dòng STALE SAU CÙNG để last-wins bắn deterministic khi code quên lọc.
import { describe, it, expect } from 'vitest';
import { reconcileStatement, type ParsedStatement } from '../src/statement-recon.js';

function fakeDb() {
  const ccgRows = [
    { roomId: 'r1', customerId: 99, unassignedAt: null },                      // khách ĐANG active của phòng
    { roomId: 'r1', customerId: 88, unassignedAt: new Date('2026-09-01') }     // khách CŨ đã gỡ (stale) — xếp sau
  ];
  return {
    chatMessage: { findMany: async () => [{ roomId: 'r1', metadataJson: '{"isDealerRefundCk":true,"receiverAcct":"112233","receiverName":"KHACH HANG 33"}' }] },
    customerChatGroup: {
      findMany: async (args?: { where?: Record<string, unknown> }) => {
        const w = args?.where ?? {};
        return ccgRows.filter((r) => !('unassignedAt' in w) || r.unassignedAt === w['unassignedAt']);
      }
    },
    chatRoom: { findMany: async () => [{ id: 'r1', name: 'ĐL- Loc SG' }] },
    customer: { findMany: async (args?: { where?: { id?: { in?: number[] } } }) => {
      const all = [{ id: 99, fullName: 'Loc SG', nickname: null }, { id: 88, fullName: 'Chu Cu', nickname: null }];
      const ids = args?.where?.id?.in;
      return ids ? all.filter((c) => ids.includes(c.id)) : all;
    } },
    investor: { findMany: async () => [] },
    receiveAccount: { findMany: async () => [] },
    $queryRawUnsafe: async () => []
  } as unknown as Parameters<typeof reconcileStatement>[0];
}

const parsed: ParsedStatement = {
  accountHolder: 'KHACH HANG 01', accountNumber: 'DEMO-ACCT', accountBank: 'MB',
  txns: [
    // Tiền RA khớp STK đại lý 112233 → DEALER_REFUND, phải gán khách ACTIVE (99), không phải khách cũ (88).
    { rowIndex: 1, dateTime: '2026-09-07T10:00:00', ref: 'F1', debit: 400_000, credit: 0, desc: null, cpName: 'KHACH HANG 33', cpAccount: '112233', cpBank: 'MB', descName: null }
  ]
};

describe('reconcileStatement — phòng đổi chủ: chỉ link ACTIVE được attribute (chống stale customer_chat_groups)', () => {
  it('hoàn đại lý gán customerId ACTIVE (99), KHÔNG gán khách đã gỡ (88)', async () => {
    const r = await reconcileStatement(fakeDb(), parsed);
    const t = r.txns.find((x) => x.ref === 'F1')!;
    expect(t.kind).toBe('DEALER_REFUND');
    expect(t.matchedCustomerId).toBe(99); // TRƯỚC FIX: map last-wins dính dòng stale → 88
    const d = r.byDealer.find((x) => x.account === '112233')!;
    expect(d.customerId).toBe(99);
    expect(d.total).toBe(400_000);
  });
});
