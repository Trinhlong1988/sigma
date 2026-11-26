// REGRESSION cho FIX 5/9 (Admin Demo) — "dropdown chọn lại TID vẫn câm mù gửi". Khi OCR đọc nhầm TID (bill UNROUTED),
// người review chọn TID đúng ở dropdown → CLIENT gọi /v1/ocr-send/reroute → rerouteBillForTid RE-RESOLVE định tuyến +
// loại thẻ + phòng đại lý/NĐT + HKD/bank cho TID MỚI để nút Gửi mở khoá được. Test khoá: reroute TID hợp lệ trả ĐỦ
// dealerRoomId + availableCardTypes + primaryCardTypeId + phòng NĐT → UI có đủ dữ liệu bật gửi; TID rác → rỗng + cảnh báo.
import { describe, it, expect } from 'vitest';
import { rerouteBillForTid } from '../src/ocr-send-service.js';

// TID ĐÚNG sau khi sửa (59930062) route được; mọi TID khác coi như KHÔNG có trong hệ thống (mô phỏng TID rác 59930002).
const GOOD_TID = '59930062';
const past = new Date('2026-01-01T00:00:00Z');

function fakeDb() {
  return {
    tid: {
      findFirst: async ({ where }: { where: { tid?: string; deletedAt?: unknown } }) =>
        where.tid === GOOD_TID
          ? { id: 10, tid: GOOD_TID, customerId: 100, partnerId: 200, bankId: 15, hkdName: 'HKD DEMO 5 2' }
          : null,
      findMany: async ({ where }: { where: { customerId?: { in: number[] } } }) =>
        where.customerId?.in?.includes(100)
          ? [{ id: 10, tid: GOOD_TID, hkdName: 'HKD DEMO 5 2', bankId: 15, createdAt: past }]
          : [],
      findUnique: async ({ where }: { where: { id: number } }) =>
        where.id === 10 ? { receiveAccountId: 300 } : null
    },
    // [9/9] resolveBillRouting nay ĐẾM NGƯỜI THẬT trong phòng đại lý (lưới "phòng chỉ có bot") → fake phải có 2 model này.
    chatRoomMember: { findMany: async () => [{ roomId: 'R-dealer', agentId: 270 }] },
    agent: { count: async () => 1, findMany: async () => [{ id: 270 }], findFirst: async () => ({ id: 412 }) },
    customerChatGroup: {
      findFirst: async ({ where }: { where: { customerId?: number; roomId?: unknown } }) =>
        where.customerId === 100 ? { roomId: 'R-dealer' } : null,
      findMany: async ({ where }: { where: { roomId?: string } }) =>
        where.roomId === 'R-dealer' ? [{ customerId: 100 }] : []
    },
    receiveAccount: {
      findFirst: async ({ where }: { where: { id: number } }) => (where.id === 300 ? { investorId: 400 } : null)
    },
    investorChatGroup: {
      findMany: async ({ where }: { where: { investorId?: number } }) =>
        where.investorId === 400 ? [{ roomId: 'R-investor', assignedFrom: past }] : []
    },
    feeRate: {
      findMany: async ({ where }: { where: { partnerId?: number } }) =>
        where.partnerId === 200 ? [{ cardTypeId: 15, effectiveFrom: past }] : []
    },
    cardType: {
      findUnique: async ({ where }: { where: { id: number } }) =>
        where.id === 15 ? { name: 'MB', bankId: 15, deletedAt: null } : null
    },
    tidSellFee: { findMany: async () => [] },
    feeSellQuote: { findMany: async () => [] },
    bank: {
      findUnique: async ({ where }: { where: { id: number } }) => (where.id === 15 ? { name: 'MB' } : null)
    },
    chatRoom: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        where.id === 'R-dealer' ? { name: 'ĐL Thái Bình' } : where.id === 'R-investor' ? { name: 'NĐT Test' } : null
    }
  } as never;
}

describe('rerouteBillForTid — re-resolve khi ĐỔI TID (mở khoá gửi cho TID đúng)', () => {
  it('TID đúng → trả ĐỦ dealerRoomId/name + availableCardTypes + primaryCardTypeId + phòng NĐT + HKD/bank', async () => {
    const r = await rerouteBillForTid(fakeDb(), GOOD_TID, new Date('2026-09-05T03:00:00Z'));
    expect(r.dealerRoomId).toBe('R-dealer');
    expect(r.dealerRoomName).toBe('ĐL Thái Bình');
    expect(r.investorRoomId).toBe('R-investor');
    expect(r.investorRoomName).toBe('NĐT Test');
    expect(r.availableCardTypes.map((c) => c.id)).toContain(15);
    expect(r.primaryCardTypeId).toBe(15);
    expect(r.hkdName).toBe('HKD DEMO 5 2');
    expect(r.bankName).toBe('MB');
  });

  it('TID rác (không có trong hệ thống) → dealerRoomId null + KHÔNG có thẻ + có cảnh báo (nút Gửi vẫn khoá)', async () => {
    const r = await rerouteBillForTid(fakeDb(), '59930002', new Date('2026-09-05T03:00:00Z'));
    expect(r.dealerRoomId).toBeNull();
    expect(r.availableCardTypes).toHaveLength(0);
    expect(r.primaryCardTypeId).toBeNull();
    expect(r.warnings.join(' ')).toMatch(/không có trong hệ thống/i);
  });
});
