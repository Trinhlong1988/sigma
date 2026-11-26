// Cụm #28/#29 (6/8, Admin Demo) — test notifyFriendsOfNewPost: khi 1 đại lý đăng bài mới → (1) ghi chuông
// DIARY_POST cho MỌI bạn bè, KHÔNG cho người lạ/không cho chính mình; (2) push FCM cho bạn bè với priority
// 'high' + payload đúng shape (title/body/data). Firebase Admin SDK thật KHÔNG gọi — inject stub messagingClient
// (cùng cách push-notification-service.test.ts). ASSERT GIÁ TRỊ THẬT (không chỉ ok) — bài học mock-shape.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeFriends } from './fixtures.js';
import { notifyFriendsOfNewPost } from '../src/notification-service.js';
import type { PushMessagingClient } from '../src/push-notification-service.js';
import { registerAgentConnection, unregisterAgentConnection, type ChatRealtimeConnection } from '../src/chat-realtime-hub.js';

/** WS giả lập tối thiểu (CÙNG khuôn chat-realtime-hub.test.ts) — chỉ 2 field hub đọc (`send`/`readyState`). */
function fakeConn(agentId: number): ChatRealtimeConnection & { sent: string[] } {
  const sent: string[] = [];
  return {
    agentId,
    sessionId: `sess-${agentId}-${Date.now()}`,
    sent,
    ws: { readyState: 1, send: vi.fn((text: string) => sent.push(text)) }
  } as unknown as ChatRealtimeConnection & { sent: string[] };
}

describe('notifyFriendsOfNewPost — báo bạn bè có bài Nhật ký mới (chuông + push)', () => {
  it('ghi chuông DIARY_POST cho bạn bè (KHÔNG cho người lạ/chính mình) + push priority high đúng payload', async () => {
    const db = getBotDb();
    const author = await makeAgent(undefined, { name: 'Người Đăng' });
    const friend = await makeAgent(undefined, { name: 'Bạn Bè' });
    const stranger = await makeAgent(undefined, { name: 'Người Lạ' });
    await makeFriends(author.id, friend.id); // author — friend là bạn; stranger KHÔNG.

    // Chỉ friend có push token (để kiểm push nhắm đúng bạn bè).
    const friendToken = `tok-friend-${Date.now()}`;
    await db.pushToken.create({ data: { agentId: friend.id, token: friendToken, platform: 'android' } });
    // stranger cũng có token — để CHẮC CHẮN push KHÔNG gửi cho người lạ (không phải bạn → không nằm trong vòng gửi).
    await db.pushToken.create({ data: { agentId: stranger.id, token: `tok-stranger-${Date.now()}`, platform: 'android' } });

    const calls: Array<{ tokens: string[]; notification?: { title: string; body: string }; data?: Record<string, string>; android?: { priority: 'high' } }> = [];
    const client: PushMessagingClient = {
      sendEachForMulticast: async (msg) => {
        calls.push(msg);
        return { responses: msg.tokens.map(() => ({ success: true })) };
      }
    };

    const postId = `post-${Date.now()}`;
    await notifyFriendsOfNewPost(db, author.id, postId, client);

    // (1) Chuông: friend nhận đúng 1 DIARY_POST của author; stranger + author KHÔNG.
    const friendNotifs = await db.agentNotification.findMany({ where: { recipientAgentId: friend.id, actorAgentId: author.id, type: 'DIARY_POST' } });
    expect(friendNotifs).toHaveLength(1);
    expect(await db.agentNotification.count({ where: { recipientAgentId: stranger.id, type: 'DIARY_POST' } })).toBe(0);
    expect(await db.agentNotification.count({ where: { recipientAgentId: author.id, type: 'DIARY_POST' } })).toBe(0);

    // (2) Push: gửi ĐÚNG token của friend (KHÔNG lẫn token người lạ), priority high, payload đúng.
    const friendCall = calls.find((c) => c.tokens.includes(friendToken));
    expect(friendCall).toBeTruthy();
    expect(calls.every((c) => !c.tokens.some((t) => t.startsWith('tok-stranger')))).toBe(true);
    expect(friendCall!.android).toEqual({ priority: 'high' });
    expect(friendCall!.notification).toEqual({ title: 'Nhật ký mới', body: 'Người Đăng vừa đăng nhật ký' });
    expect(friendCall!.data).toMatchObject({ kind: 'diary_post', authorAgentId: String(author.id), postId });
  });

  it('không có bạn bè → no-op (KHÔNG gọi messagingClient, KHÔNG ghi chuông)', async () => {
    const db = getBotDb();
    const lonely = await makeAgent(undefined, { name: 'Không Bạn' });
    let called = false;
    const client: PushMessagingClient = {
      sendEachForMulticast: async (msg) => {
        called = true;
        return { responses: msg.tokens.map(() => ({ success: true })) };
      }
    };
    await notifyFriendsOfNewPost(db, lonely.id, `post-${Date.now()}`, client);
    expect(called).toBe(false);
    expect(await db.agentNotification.count({ where: { actorAgentId: lonely.id, type: 'DIARY_POST' } })).toBe(0);
  });

  // #32 (6/8) — REALTIME: broadcast WS agent-level `diary-notify` cho MỖI bạn bè đang MỞ app (chuông +1 ngay).
  it('broadcast WS diary-notify tới bạn bè đang có kết nối mở (KHÔNG tới người lạ), payload đúng shape', async () => {
    const db = getBotDb();
    const author = await makeAgent(undefined, { name: 'Tác Giả' });
    const friend = await makeAgent(undefined, { name: 'Bạn' });
    const stranger = await makeAgent(undefined, { name: 'Lạ' });
    await makeFriends(author.id, friend.id);

    const friendConn = fakeConn(friend.id);
    const strangerConn = fakeConn(stranger.id);
    registerAgentConnection(friend.id, friendConn);
    registerAgentConnection(stranger.id, strangerConn);
    try {
      const postId = `post-rt-${Date.now()}`;
      // messagingClient no-op để KHÔNG chạm Firebase; chỉ quan tâm nhánh WS broadcast.
      const client: PushMessagingClient = { sendEachForMulticast: async (m) => ({ responses: m.tokens.map(() => ({ success: true })) }) };
      await notifyFriendsOfNewPost(db, author.id, postId, client);

      // Bạn bè NHẬN đúng 1 message diary-notify, shape khớp giao thức client parse.
      expect(friendConn.sent).toHaveLength(1);
      const payload = JSON.parse(friendConn.sent[0]);
      expect(payload).toMatchObject({ msg: 'diary-notify', kind: 'diary_post', authorAgentId: author.id, authorName: 'Tác Giả', postId });
      expect(typeof payload.at).toBe('string');
      // Người LẠ (không phải bạn) KHÔNG nhận gì.
      expect(strangerConn.sent).toHaveLength(0);
    } finally {
      unregisterAgentConnection(friend.id, friendConn);
      unregisterAgentConnection(stranger.id, strangerConn);
    }
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
