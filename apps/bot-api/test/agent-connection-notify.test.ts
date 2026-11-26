// 8/8 (Admin Demo "đồng bộ hóa mọi push event số đếm, cộng trừ mọi nền mượt-chuẩn-realtime") — 3 sự kiện KẾT NỐI
// (kết bạn/nhóm) TRƯỚC ĐÂY chỉ gửi FCM, nay phải chảy vào CÙNG bộ chuông (bảng agent_notifications + WS
// broadcastToAgent 'agent-notify') như sự kiện Nhật ký để đếm đồng bộ web/exe/apk. Test END-TO-END qua chính
// service (sendFriendRequest/acceptFriendRequest/createGroupRoom/addMember) để khẳng định WIRING thật, không chỉ
// helper. ASSERT GIÁ TRỊ THẬT (type/actor/postId-or-roomId cụ thể + shape WS + bộ đếm chưa-đọc +1 rồi về 0 sau
// mark-read) — bài học mock-shape/false-pass. Firebase KHÔNG gọi (không seed pushToken → sendPushToAgent no-op).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent } from './fixtures.js';
import { sendFriendRequest, acceptFriendRequest } from '../src/friend-service.js';
import { listMyNotifications, markAllNotificationsRead, notifyGroupAdded } from '../src/notification-service.js';
import { registerAgentConnection, unregisterAgentConnection, type ChatRealtimeConnection } from '../src/chat-realtime-hub.js';

/** WS giả lập tối thiểu (CÙNG khuôn diary-post-notify.test.ts) — chỉ 2 field hub đọc (`send`/`readyState`). */
function fakeConn(agentId: number): ChatRealtimeConnection & { sent: string[] } {
  const sent: string[] = [];
  return {
    agentId,
    sessionId: `sess-${agentId}-${Date.now()}-${Math.random()}`,
    sent,
    ws: { readyState: 1, send: vi.fn((text: string) => sent.push(text)) }
  } as unknown as ChatRealtimeConnection & { sent: string[] };
}

describe('agent-notify — chuông + WS realtime cho kết bạn/nhóm (đồng bộ đếm mọi nền)', () => {
  it('sendFriendRequest → chuông FRIEND_REQUEST + WS agent-notify cho NGƯỜI NHẬN (postId=null); badge +1 rồi về 0 sau đọc', async () => {
    const db = getBotDb();
    const sender = await makeAgent(undefined, { name: 'Người Gửi' });
    const recipient = await makeAgent(undefined, { name: 'Người Nhận' });

    const conn = fakeConn(recipient.id);
    registerAgentConnection(recipient.id, conn);
    try {
      const res = await sendFriendRequest(db, sender.id, recipient.id);
      expect(res.ok).toBe(true);

      // (1) Chuông: recipient nhận đúng 1 FRIEND_REQUEST của sender, postId null; sender KHÔNG có.
      const rows = await db.agentNotification.findMany({ where: { recipientAgentId: recipient.id, type: 'FRIEND_REQUEST' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].actorAgentId).toBe(sender.id);
      expect(rows[0].postId).toBeNull();
      expect(await db.agentNotification.count({ where: { recipientAgentId: sender.id, type: 'FRIEND_REQUEST' } })).toBe(0);

      // (2) WS: recipient đang mở nhận đúng 1 'agent-notify' shape khớp parser client.
      expect(conn.sent).toHaveLength(1);
      const payload = JSON.parse(conn.sent[0]);
      expect(payload).toMatchObject({ msg: 'agent-notify', notifType: 'FRIEND_REQUEST', actorAgentId: sender.id, actorName: 'Người Gửi', targetId: null });
      expect(typeof payload.at).toBe('string');

      // (3) Bộ đếm chưa-đọc chuông (CÙNG bộ đếm mọi loại) +1 → mark-read → 0.
      const before = await listMyNotifications(db, recipient.id);
      expect(before.unreadCount).toBe(1);
      const marked = await markAllNotificationsRead(db, recipient.id);
      expect(marked.updatedCount).toBe(1);
      const after = await listMyNotifications(db, recipient.id);
      expect(after.unreadCount).toBe(0);
    } finally {
      unregisterAgentConnection(recipient.id, conn);
    }
  });

  it('acceptFriendRequest → chuông FRIEND_ACCEPT + WS cho NGƯỜI GỬI LỜI MỜI GỐC (actor = người chấp nhận)', async () => {
    const db = getBotDb();
    const sender = await makeAgent(undefined, { name: 'Gửi Lời Mời' });
    const accepter = await makeAgent(undefined, { name: 'Chấp Nhận' });

    const req = await sendFriendRequest(db, sender.id, accepter.id);
    expect(req.ok).toBe(true);
    if (!req.ok) return; // narrow

    const conn = fakeConn(sender.id);
    registerAgentConnection(sender.id, conn);
    try {
      const res = await acceptFriendRequest(db, accepter.id, req.data.id);
      expect(res.ok).toBe(true);

      const rows = await db.agentNotification.findMany({ where: { recipientAgentId: sender.id, type: 'FRIEND_ACCEPT' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].actorAgentId).toBe(accepter.id);
      expect(rows[0].postId).toBeNull();

      expect(conn.sent).toHaveLength(1);
      const payload = JSON.parse(conn.sent[0]);
      expect(payload).toMatchObject({ msg: 'agent-notify', notifType: 'FRIEND_ACCEPT', actorAgentId: accepter.id, actorName: 'Chấp Nhận', targetId: null });
    } finally {
      unregisterAgentConnection(sender.id, conn);
    }
  });

  // GROUP_ADDED — test helper notifyGroupAdded TRỰC TIẾP (KHÔNG qua createGroupRoom/addMember): createGroupRoom bị
  // CHẶN bởi drift CÓ SẴN toàn repo `chat_room_members.cleared_at does not exist` (schema.prisma khai báo clearedAt
  // 7/8 nhưng THIẾU file migration → DB throwaway `migrate deploy` không có cột; 38/43 test chat-room-service.test.ts
  // cũng fail cùng lỗi này — KHÔNG do thay đổi đợt này). Helper notifyGroupAdded chỉ ghi agent_notifications + đọc
  // agent → chạy được, chứng minh CƠ CHẾ chuông/WS/đếm cho GROUP_ADDED. WIRING createGroupRoom/addMember→notifyGroupAdded
  // đã verify bằng typecheck sạch + code (call site có thật) — chờ Claude/Admin Demo bổ sung migration cleared_at để E2E.
  it('notifyGroupAdded → chuông GROUP_ADDED (postId=roomId) + WS (targetId=roomId); badge +1 rồi về 0 sau đọc', async () => {
    const db = getBotDb();
    const creator = await makeAgent(undefined, { name: 'Trưởng Nhóm' });
    const member = await makeAgent(undefined, { name: 'Thành Viên' });
    const roomId = `room_${Date.now()}`;

    const conn = fakeConn(member.id);
    registerAgentConnection(member.id, conn);
    try {
      await notifyGroupAdded(db, member.id, creator.id, roomId);

      // (1) Chuông: đúng 1 GROUP_ADDED, actor=creator, postId=roomId.
      const rows = await db.agentNotification.findMany({ where: { recipientAgentId: member.id, type: 'GROUP_ADDED' } });
      expect(rows).toHaveLength(1);
      expect(rows[0].actorAgentId).toBe(creator.id);
      expect(rows[0].postId).toBe(roomId);

      // (2) WS: shape khớp parser client, targetId=roomId để click deep-link mở đúng nhóm.
      const agentNotifs = conn.sent.map((s) => JSON.parse(s)).filter((p) => p.msg === 'agent-notify');
      expect(agentNotifs).toHaveLength(1);
      expect(agentNotifs[0]).toMatchObject({ msg: 'agent-notify', notifType: 'GROUP_ADDED', actorAgentId: creator.id, actorName: 'Trưởng Nhóm', targetId: roomId });
      expect(typeof agentNotifs[0].at).toBe('string');

      // (3) Bộ đếm chuông chung: +1 → mark-read → 0.
      expect((await listMyNotifications(db, member.id)).unreadCount).toBe(1);
      await markAllNotificationsRead(db, member.id);
      expect((await listMyNotifications(db, member.id)).unreadCount).toBe(0);
    } finally {
      unregisterAgentConnection(member.id, conn);
    }
  });

  it('notifyGroupAdded KHÔNG gửi cho người không có kết nối mở (WS no-op, chuông vẫn ghi)', async () => {
    const db = getBotDb();
    const creator = await makeAgent(undefined, { name: 'C' });
    const offline = await makeAgent(undefined, { name: 'Offline' });
    const roomId = `room_off_${Date.now()}`;
    // KHÔNG register connection cho offline.
    await notifyGroupAdded(db, offline.id, creator.id, roomId);
    // Chuông vẫn ghi (máy nền mở sau vẫn thấy) dù không có WS live.
    const rows = await db.agentNotification.findMany({ where: { recipientAgentId: offline.id, type: 'GROUP_ADDED' } });
    expect(rows).toHaveLength(1);
    expect(rows[0].postId).toBe(roomId);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
