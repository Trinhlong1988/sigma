// SIGMA "Doanh số theo nhóm chat" (1/8, model scope-khách 21/8) — test getRoomRevenueReport (doanh số suy
// TỪ KHÁCH qua customer_chat_groups; linkTidToRoom/unlinkTidFromRoom ĐÃ GỠ 21/8), CÙNG khuôn kpi.test.ts (qua
// makeLoWithAmount() để kiểm soát createdAt chính xác, không phụ thuộc thời gian chạy test).
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { ChatServiceError } from '../src/services/chat-room-service.js';
import { getRoomRevenueReport, resolveActiveRoomAtDate } from '../src/services/chat-room-tid-service.js';
import { makeAgent, makeBank, makeCardType, makeChatRoom, makeChatRoomMember, makeCustomer, makeCustomerChatGroup, makeFeeType, makeQuoteReadyTid, makeTid } from './fixtures.js';

async function makeLoWithAmount(opts: {
  agentId: number;
  tidId: number;
  cardTypeId: number;
  feeTypeId: number;
  amountBeforeFee: bigint;
  feeApplied?: bigint;
  createdAt: Date;
  status?: string;
}) {
  const db = getBotDb();
  const fee = opts.feeApplied ?? 0n;
  const lo = await db.lo.create({
    data: {
      agentId: opts.agentId,
      status: opts.status ?? 'PENDING',
      expectedTotalAmount: opts.amountBeforeFee - fee,
      createdAt: opts.createdAt,
      cancelledAt: opts.status === 'CANCELLED' ? opts.createdAt : null,
      cancelReason: opts.status === 'CANCELLED' ? 'test hủy' : null
    }
  });
  await db.loRow.create({
    data: {
      loId: lo.id,
      tidId: opts.tidId,
      cardTypeId: opts.cardTypeId,
      feeTypeId: opts.feeTypeId,
      amountBeforeFee: opts.amountBeforeFee,
      feeApplied: fee,
      amountAfterFee: opts.amountBeforeFee - fee,
      createdAt: opts.createdAt
    }
  });
  return lo;
}


// MODEL MỚI (Admin Demo 21/8): doanh số phòng = LoRow của TID thuộc KHÁCH gắn phòng (customer_chat_groups →
// customer → tids.customer_id), KHÔNG còn dựa chat_room_tids/tid.agentId. Helper dựng: phòng GROUP + member(agent)
// + khách + customer_chat_group(khách→phòng) + N TID của khách (agentId = null CỐ Ý — chứng minh fix bug
// agentId-luôn-null làm doanh số = 0 ở audit 20/8 bị sót).
async function setupRoomCustomerTids(tidCount: number): Promise<{ agent: { id: number }; room: { id: string }; customer: { id: number }; cardType: { id: number }; feeType: { id: number }; tids: { id: number }[] }> {
  const agent = await makeAgent();
  const room = await makeChatRoom({ type: 'GROUP' });
  await makeChatRoomMember(room.id, agent.id);
  const customer = await makeCustomer();
  await makeCustomerChatGroup({ customerId: customer.id, roomId: room.id });
  const bank = await makeBank();
  const cardType = await makeCardType(bank.id);
  const feeType = await makeFeeType();
  const tids: { id: number }[] = [];
  for (let i = 0; i < tidCount; i++) tids.push(await makeTid({ customerId: customer.id, agentId: null, bankId: bank.id }));
  return { agent, room, customer, cardType, feeType, tids };
}

describe('getRoomRevenueReport (model scope-khách)', () => {
  it('REGRESSION (fix audit sót): TID có agentId=NULL vẫn tính doanh số ĐÚNG — loại CANCELLED, ngoài khoảng, TID khách khác', async () => {
    const { agent, room, cardType, feeType, tids } = await setupRoomCustomerTids(1);
    const tid = tids[0];
    const from = new Date(2026, 6, 1, 0, 0, 0);
    const to = new Date(2026, 7, 1, 0, 0, 0);
    const inRange = new Date(2026, 6, 10, 8, 0, 0);
    const outOfRange = new Date(2026, 5, 1, 12, 0, 0);
    const base = { agentId: agent.id, tidId: tid.id, cardTypeId: cardType.id, feeTypeId: feeType.id };
    await makeLoWithAmount({ ...base, amountBeforeFee: 10_000_000n, feeApplied: 200_000n, createdAt: inRange, status: 'PENDING' });
    await makeLoWithAmount({ ...base, amountBeforeFee: 5_000_000n, feeApplied: 100_000n, createdAt: inRange, status: 'CANCELLED' });
    await makeLoWithAmount({ ...base, amountBeforeFee: 3_000_000n, feeApplied: 60_000n, createdAt: outOfRange, status: 'PENDING' });

    // TID của KHÁCH KHÁC (không thuộc phòng này) — KHÔNG được tính.
    const other = await setupRoomCustomerTids(1);
    await makeLoWithAmount({ agentId: other.agent.id, tidId: other.tids[0].id, cardTypeId: other.cardType.id, feeTypeId: other.feeType.id, amountBeforeFee: 8_000_000n, createdAt: inRange, status: 'PENDING' });

    const report = await getRoomRevenueReport(getBotDb(), agent.id, room.id, { from, to });
    expect(report.totalGross).toBe(10_000_000);
    expect(report.totalFee).toBe(200_000);
    expect(report.totalNet).toBe(9_800_000);
    expect(report.loCount).toBe(1);
    expect(report.rows).toHaveLength(1);
    expect(report.tids.map((t) => t.tidId)).toEqual([tid.id]);
  });

  it('gộp NHIỀU TID của cùng khách', async () => {
    const { agent, room, cardType, feeType, tids } = await setupRoomCustomerTids(2);
    const day = new Date(2026, 6, 10, 8, 0, 0);
    const base = { agentId: agent.id, cardTypeId: cardType.id, feeTypeId: feeType.id };
    await makeLoWithAmount({ ...base, tidId: tids[0].id, amountBeforeFee: 1_000_000n, createdAt: day });
    await makeLoWithAmount({ ...base, tidId: tids[1].id, amountBeforeFee: 2_000_000n, createdAt: day });
    const report = await getRoomRevenueReport(getBotDb(), agent.id, room.id, { from: new Date(2026, 6, 1), to: new Date(2026, 7, 1) });
    expect(report.totalGross).toBe(3_000_000);
    expect(report.loCount).toBe(2);
    expect(report.tids.map((t) => t.tidId).sort()).toEqual([tids[0].id, tids[1].id].sort());
  });

  it('lọc theo 1 TID cụ thể (tidId option) → CHỈ tính TID đó', async () => {
    const { agent, room, cardType, feeType, tids } = await setupRoomCustomerTids(2);
    const day = new Date(2026, 6, 10, 8, 0, 0);
    const base = { agentId: agent.id, cardTypeId: cardType.id, feeTypeId: feeType.id };
    await makeLoWithAmount({ ...base, tidId: tids[0].id, amountBeforeFee: 1_000_000n, createdAt: day });
    await makeLoWithAmount({ ...base, tidId: tids[1].id, amountBeforeFee: 2_000_000n, createdAt: day });
    const report = await getRoomRevenueReport(getBotDb(), agent.id, room.id, { from: new Date(2026, 6, 1), to: new Date(2026, 7, 1), tidId: tids[0].id });
    expect(report.totalGross).toBe(1_000_000);
    expect(report.rows.every((r) => r.tidId === tids[0].id)).toBe(true);
  });

  it('lọc theo TID của KHÁCH KHÁC (không thuộc phòng) → TID_NOT_IN_ROOM', async () => {
    const { agent, room } = await setupRoomCustomerTids(1);
    const other = await setupRoomCustomerTids(1);
    await expect(
      getRoomRevenueReport(getBotDb(), agent.id, room.id, { from: new Date(2026, 0, 1), to: new Date(2026, 11, 31), tidId: other.tids[0].id })
    ).rejects.toMatchObject({ code: 'TID_NOT_IN_ROOM' });
  });

  it('from >= to → VALIDATION', async () => {
    const { agent, room } = await setupRoomCustomerTids(0);
    await expect(
      getRoomRevenueReport(getBotDb(), agent.id, room.id, { from: new Date(2026, 6, 10), to: new Date(2026, 6, 1) })
    ).rejects.toMatchObject({ code: 'VALIDATION' });
  });

  it('không phải thành viên phòng → NOT_MEMBER', async () => {
    const agent = await makeAgent();
    const room = await makeChatRoom({ type: 'GROUP' });
    await expect(
      getRoomRevenueReport(getBotDb(), agent.id, room.id, { from: new Date(2026, 0, 1), to: new Date(2026, 11, 31) })
    ).rejects.toMatchObject({ code: 'NOT_MEMBER' });
  });

  it('phòng chưa gắn khách / khách chưa có TID → 0 tất cả field, KHÔNG lỗi', async () => {
    const { agent, room } = await setupRoomCustomerTids(0); // khách gắn phòng nhưng 0 TID
    const report = await getRoomRevenueReport(getBotDb(), agent.id, room.id, { from: new Date(2026, 0, 1), to: new Date(2026, 11, 31) });
    expect(report.totalGross).toBe(0);
    expect(report.loCount).toBe(0);
    expect(report.rows).toEqual([]);
    expect(report.tids).toEqual([]);
  });
});

// [Admin Demo 7/9] MƯỢN TID: đại lý A quẹt nhờ TID của B → doanh số lô về A (người mượn), KHÔNG về chủ TID B.
describe('MƯỢN TID — doanh số lô mượn về đại lý MƯỢN, chống lọt sang chủ TID', () => {
  it('lô trên TID của B nhưng borrowed_by A → VÀO phòng A (borrowed=true) + RA khỏi phòng B', async () => {
    const db = getBotDb();
    const A = await setupRoomCustomerTids(1); // đại lý MƯỢN
    const B = await setupRoomCustomerTids(1); // CHỦ TID
    const day = new Date(2026, 6, 10, 8, 0, 0);
    const from = new Date(2026, 6, 1), to = new Date(2026, 7, 1);
    // Lô quẹt trên TID của B, A mượn → gán borrowed_by = khách A.
    const lo = await makeLoWithAmount({ agentId: A.agent.id, tidId: B.tids[0].id, cardTypeId: B.cardType.id, feeTypeId: B.feeType.id, amountBeforeFee: 6_000_000n, feeApplied: 90_000n, createdAt: day });
    await db.$executeRawUnsafe('UPDATE los SET borrowed_by_customer_id = $1 WHERE id = $2', A.customer.id, lo.id);
    // Lô RIÊNG của A (không mượn) để chắc phòng A gộp cả hai.
    await makeLoWithAmount({ agentId: A.agent.id, tidId: A.tids[0].id, cardTypeId: A.cardType.id, feeTypeId: A.feeType.id, amountBeforeFee: 1_000_000n, feeApplied: 20_000n, createdAt: day });

    // Phòng A: gồm lô mượn (6tr) + lô riêng (1tr) = 7tr; lô mượn có borrowed=true.
    const repA = await getRoomRevenueReport(db, A.agent.id, A.room.id, { from, to });
    expect(repA.totalGross).toBe(7_000_000);
    expect(repA.loCount).toBe(2);
    const borrowedRow = repA.rows.find((r) => r.borrowed);
    expect(borrowedRow).toBeTruthy();
    expect(borrowedRow!.gross).toBe(6_000_000);
    expect(repA.rows.filter((r) => !r.borrowed)).toHaveLength(1); // lô riêng không cờ mượn

    // Phòng B (chủ TID): KHÔNG được tính lô mượn-ra → 0.
    const repB = await getRoomRevenueReport(db, B.agent.id, B.room.id, { from, to });
    expect(repB.totalGross).toBe(0);
    expect(repB.rows).toHaveLength(0);
  });

  it('lọc theo 1 TID (tidId) KHÔNG kéo lô mượn (borrowScope rỗng)', async () => {
    const db = getBotDb();
    const A = await setupRoomCustomerTids(1);
    const B = await setupRoomCustomerTids(1);
    const day = new Date(2026, 6, 10, 8, 0, 0);
    const lo = await makeLoWithAmount({ agentId: A.agent.id, tidId: B.tids[0].id, cardTypeId: B.cardType.id, feeTypeId: B.feeType.id, amountBeforeFee: 6_000_000n, createdAt: day });
    await db.$executeRawUnsafe('UPDATE los SET borrowed_by_customer_id = $1 WHERE id = $2', A.customer.id, lo.id);
    await makeLoWithAmount({ agentId: A.agent.id, tidId: A.tids[0].id, cardTypeId: A.cardType.id, feeTypeId: A.feeType.id, amountBeforeFee: 1_000_000n, createdAt: day });
    // Lọc TID riêng của A → chỉ 1tr, KHÔNG kéo lô mượn (TID của B ∉ phòng, borrowScope rỗng khi lọc theo tid).
    const rep = await getRoomRevenueReport(db, A.agent.id, A.room.id, { from: new Date(2026, 6, 1), to: new Date(2026, 7, 1), tidId: A.tids[0].id });
    expect(rep.totalGross).toBe(1_000_000);
    expect(rep.rows.every((r) => !r.borrowed)).toBe(true);
  });
});

// Xác nhận ChatServiceError export dùng được ở test file này (import trực tiếp, không qua instanceof lỏng lẻo).
describe('sanity', () => {
  it('ChatServiceError có field code đúng như đã import', () => {
    const err = new ChatServiceError('X', 'y');
    expect(err.code).toBe('X');
  });
});

// [Admin Demo 7/9] GATE attribution theo NGÀY (THANH NAM-4 chuyển Nam Hà→Bảo từ 5/9). Khách 1 nhóm → không regress.
describe('resolveActiveRoomAtDate — phòng active của khách tại ngày bill', () => {
  const D = (s: string) => new Date(s + 'T00:00:00+07:00');
  it('khách 1 nhóm active → LUÔN phòng đó (kể cả bill trước assignedFrom — không mất lịch sử)', () => {
    const g = [{ roomId: 'R1', assignedAt: D('2026-09-01'), unassignedAt: null }];
    expect(resolveActiveRoomAtDate(g, D('2026-08-20'))).toBe('R1'); // bill TRƯỚC gán → vẫn R1
    expect(resolveActiveRoomAtDate(g, D('2026-09-10'))).toBe('R1');
  });
  it('chuyển 5/9: trước 5/9 → Nam Hà, từ 5/9 → Bảo', () => {
    const g = [
      { roomId: 'NAMHA', assignedAt: D('2026-08-01'), unassignedAt: D('2026-09-05') },
      { roomId: 'BAO', assignedAt: D('2026-09-05'), unassignedAt: null }
    ];
    expect(resolveActiveRoomAtDate(g, D('2026-09-04'))).toBe('NAMHA');
    expect(resolveActiveRoomAtDate(g, D('2026-09-05'))).toBe('BAO'); // đúng mốc = phòng mới (nửa mở)
    expect(resolveActiveRoomAtDate(g, D('2026-09-10'))).toBe('BAO');
    expect(resolveActiveRoomAtDate(g, D('2026-07-01'))).toBe('NAMHA'); // trước tất cả → phòng đầu
  });
  it('không nhóm → null', () => expect(resolveActiveRoomAtDate([], D('2026-09-05'))).toBeNull());
});
