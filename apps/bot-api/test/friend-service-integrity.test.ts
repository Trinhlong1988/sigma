// LANE C Vòng 2 (3/8) — TOÀN VẸN GHI DỮ LIỆU cho kết bạn (friend-service.ts). Test TÁI HIỆN các tình huống
// GHI SAI/GHI TRÙNG mà tsc/test-happy-path KHÔNG lộ: gửi lời mời TRÙNG khi 2 request đồng thời (double-click
// "Kết bạn"). Chạy trên throwaway Postgres THẬT (global-setup.ts) — partial unique index
// `friend_requests_pair_active_uq` (migration 20260724190000_friend_requests) là bất biến DB đang được kiểm.
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { sendFriendRequest, acceptFriendRequest, listFriends } from '../src/friend-service.js';
import { makeAgent, makeFriends } from './fixtures.js';
import { registerAgentConnection, unregisterAgentConnection, type ChatRealtimeConnection } from '../src/chat-realtime-hub.js';

/** Đếm số hàng quan hệ ĐANG SỐNG (PENDING/ACCEPTED) giữa 2 agent — bất kể chiều. */
async function countLiveRelations(a: number, b: number): Promise<number> {
  const db = getBotDb();
  return db.friendRequest.count({
    where: {
      status: { in: ['PENDING', 'ACCEPTED'] },
      OR: [
        { fromAgentId: a, toAgentId: b },
        { fromAgentId: b, toAgentId: a }
      ]
    }
  });
}

describe('friend-service — toàn vẹn ghi (chống PENDING trùng)', () => {
  it('DB có bất biến: đã có 1 PENDING (A→B) thì create thẳng 1 PENDING (B→A) NÉM P2002 (không cho 2 hàng sống)', async () => {
    const db = getBotDb();
    const A = await makeAgent();
    const B = await makeAgent();
    await db.friendRequest.create({ data: { fromAgentId: A.id, toAgentId: B.id, status: 'PENDING' } });
    // Cùng CẶP (không phân biệt chiều) → vi phạm partial unique index (LEAST/GREATEST) WHERE status sống.
    await expect(
      db.friendRequest.create({ data: { fromAgentId: B.id, toAgentId: A.id, status: 'PENDING' } })
    ).rejects.toMatchObject({ code: 'P2002' });
    expect(await countLiveRelations(A.id, B.id)).toBe(1);
  });

  it('2 sendFriendRequest(A→B) ĐỒNG THỜI → đúng 1 PENDING, KHÔNG request nào ném lỗi thô (P2002) ra ngoài', async () => {
    const db = getBotDb();
    const A = await makeAgent();
    const B = await makeAgent();

    // Double-click "Kết bạn": 2 lời gọi gần như đồng thời, cùng vượt qua findActiveRelation() (chưa thấy hàng
    // nào) rồi cùng create → 1 thắng, 1 phải bị partial unique index chặn ở DB. Service PHẢI nuốt P2002 và
    // trả kết quả nghiệp vụ sạch (REQUEST_ALREADY_SENT), KHÔNG để lỗi Prisma thô rơi ra route → 500.
    const results = await Promise.allSettled([
      sendFriendRequest(db, A.id, B.id),
      sendFriendRequest(db, A.id, B.id)
    ]);

    // (1) KHÔNG promise nào bị reject (lỗi thô lọt ra ngoài).
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected, `Có ${rejected.length} lời gọi ném lỗi thô: ${rejected.map((r) => (r as PromiseRejectedResult).reason).join(' | ')}`).toHaveLength(0);

    // (2) Đúng 1 hàng PENDING sống trong DB (không ghi trùng).
    expect(await countLiveRelations(A.id, B.id)).toBe(1);

    // (3) 1 lời gọi ok:true (tạo được), lời còn lại ok:false với mã REQUEST_ALREADY_SENT (không phải lỗi lạ).
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof sendFriendRequest>>>).value);
    const oks = values.filter((v) => v.ok === true);
    const notOks = values.filter((v) => v.ok === false);
    expect(oks).toHaveLength(1);
    expect(notOks).toHaveLength(1);
    expect((notOks[0] as { error: string }).error).toBe('REQUEST_ALREADY_SENT');
  });

  it('2 sendFriendRequest NGƯỢC CHIỀU (A→B và B→A) ĐỒNG THỜI → 1 hàng sống, không ném lỗi thô', async () => {
    const db = getBotDb();
    const A = await makeAgent();
    const B = await makeAgent();

    const results = await Promise.allSettled([
      sendFriendRequest(db, A.id, B.id),
      sendFriendRequest(db, B.id, A.id)
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected, `Có ${rejected.length} lời gọi ném lỗi thô`).toHaveLength(0);
    // 1 hàng sống duy nhất (có thể PENDING hoặc ACCEPTED nếu 1 bên rơi vào nhánh auto-accept của bên kia —
    // điều quan trọng: KHÔNG có 2 hàng, KHÔNG có lỗi 500).
    expect(await countLiveRelations(A.id, B.id)).toBe(1);
  });

  it('acceptFriendRequest 2 lần ĐỒNG THỜI cùng requestId → ACCEPTED, 1 hàng, không lỗi thô', async () => {
    const db = getBotDb();
    const A = await makeAgent();
    const B = await makeAgent();
    const sent = await sendFriendRequest(db, A.id, B.id);
    expect(sent.ok).toBe(true);
    const reqId = (sent as { data: { id: number } }).data.id;

    const results = await Promise.allSettled([
      acceptFriendRequest(db, B.id, reqId),
      acceptFriendRequest(db, B.id, reqId)
    ]);
    const rejected = results.filter((r) => r.status === 'rejected');
    expect(rejected, `Có ${rejected.length} lời gọi accept ném lỗi thô`).toHaveLength(0);

    const live = await db.friendRequest.findMany({
      where: { OR: [{ fromAgentId: A.id, toAgentId: B.id }, { fromAgentId: B.id, toAgentId: A.id }] }
    });
    expect(live).toHaveLength(1);
    expect(live[0].status).toBe('ACCEPTED');
  });
});

// BUG#10 (6/8, Admin Demo "danh bạ trạng thái online kiểu Zalo") — listFriends() PHẢI trả `online` THẬT theo
// presence hub WS (agentHasOpenConnection), KHÔNG hard-code null. Đăng ký 1 kết nối WS giả cho bạn → online:true;
// không đăng ký → online:false. Nối chấm XANH/ĐỎ ở ContactsScreen.tsx.
describe('friend-service — listFriends trả trạng thái online THẬT (BUG#10)', () => {
  function fakeConn(agentId: number): ChatRealtimeConnection {
    // agentHasOpenConnection chỉ cần set kết nối non-empty; ws không bị chạm trong đăng ký/đếm.
    return { ws: {} as unknown as ChatRealtimeConnection['ws'], agentId, sessionId: `test-sess-${agentId}-${Math.random()}` };
  }

  it('bạn có kết nối WS mở → online:true; bạn không có kết nối → online:false', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const onlineFriend = await makeAgent();
    const offlineFriend = await makeAgent();
    await makeFriends(me.id, onlineFriend.id);
    await makeFriends(me.id, offlineFriend.id);

    const conn = fakeConn(onlineFriend.id);
    registerAgentConnection(onlineFriend.id, conn);
    try {
      const res = await listFriends(db, me.id);
      const on = res.friends.find((f) => f.agentId === onlineFriend.id);
      const off = res.friends.find((f) => f.agentId === offlineFriend.id);
      expect(on?.online).toBe(true);
      expect(off?.online).toBe(false);
    } finally {
      unregisterAgentConnection(onlineFriend.id, conn);
    }
  });
});
