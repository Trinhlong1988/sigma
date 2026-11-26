// SIGMA Phase 2 (29/7) — regression cho chat-reaction-service.ts. Gọi thẳng service (KHÔNG qua HTTP), CÙNG
// khuôn chat-message-service.test.ts.
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeFriends } from './fixtures.js';
import { findOrCreateDirectRoom, ChatServiceError } from '../src/services/chat-room-service.js';
import { sendMessage } from '../src/services/chat-message-service.js';
import { toggleReaction, listReactionsForMessages } from '../src/services/chat-reaction-service.js';

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ChatServiceError code=${code} nhưng KHÔNG throw.`);
  } catch (err) {
    expect(err).toBeInstanceOf(ChatServiceError);
    expect((err as ChatServiceError).code).toBe(code);
  }
}

async function makeDirectRoomWithMessage() {
  const db = getBotDb();
  const a = await makeAgent();
  const b = await makeAgent();
  await makeFriends(a.id, b.id);
  const room = await findOrCreateDirectRoom(db, a.id, b.id);
  const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'phản ứng đi' });
  return { db, a, b, room, msg };
}

describe('chat-reaction-service — toggleReaction', () => {
  it('CHƯA có reaction → tạo mới, action=added', async () => {
    const { db, a, msg } = await makeDirectRoomWithMessage();
    const result = await toggleReaction(db, msg.id, a.id, '👍');
    expect(result.action).toBe('added');
    expect(result.reaction?.emoji).toBe('👍');
    expect(result.reaction?.agentId).toBe(a.id);
    expect(result.reaction?.messageId).toBe(msg.id);
  });

  it('ĐÃ có reaction, bấm lại ĐÚNG emoji cũ → xóa (unlike), action=removed, reaction=null', async () => {
    const { db, a, msg } = await makeDirectRoomWithMessage();
    await toggleReaction(db, msg.id, a.id, '👍');
    const result = await toggleReaction(db, msg.id, a.id, '👍');
    expect(result.action).toBe('removed');
    expect(result.reaction).toBeNull();
    const count = await db.chatMessageReaction.count({ where: { messageId: msg.id, agentId: a.id } });
    expect(count).toBe(0);
  });

  it('ĐÃ có reaction, đổi sang emoji KHÁC → update, action=changed', async () => {
    const { db, a, msg } = await makeDirectRoomWithMessage();
    await toggleReaction(db, msg.id, a.id, '👍');
    const result = await toggleReaction(db, msg.id, a.id, '😂');
    expect(result.action).toBe('changed');
    expect(result.reaction?.emoji).toBe('😂');
    const count = await db.chatMessageReaction.count({ where: { messageId: msg.id, agentId: a.id } });
    expect(count).toBe(1); // vẫn chỉ 1 hàng — đổi tại chỗ, không tạo thêm.
  });

  it('2 agent KHÁC NHAU cùng reaction 1 tin → 2 hàng độc lập, KHÔNG đụng nhau', async () => {
    const { db, a, b, msg } = await makeDirectRoomWithMessage();
    const resultA = await toggleReaction(db, msg.id, a.id, '👍');
    const resultB = await toggleReaction(db, msg.id, b.id, '❤️');
    expect(resultA.action).toBe('added');
    expect(resultB.action).toBe('added');
    const count = await db.chatMessageReaction.count({ where: { messageId: msg.id } });
    expect(count).toBe(2);
    // A đổi emoji KHÔNG ảnh hưởng reaction của B.
    await toggleReaction(db, msg.id, a.id, '😢');
    const bRow = await db.chatMessageReaction.findUnique({ where: { messageId_agentId: { messageId: msg.id, agentId: b.id } } });
    expect(bRow?.emoji).toBe('❤️');
  });

  it('1 agent reaction ĐỘC LẬP trên NHIỀU tin nhắn khác nhau cùng lúc — không giới hạn/không đụng nhau', async () => {
    const { db, a, room } = await makeDirectRoomWithMessage();
    const msg2 = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'tin 2' });
    const msg3 = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'tin 3' });
    await toggleReaction(db, msg2.id, a.id, '🔥');
    await toggleReaction(db, msg3.id, a.id, '🎉');
    const r2 = await db.chatMessageReaction.findUnique({ where: { messageId_agentId: { messageId: msg2.id, agentId: a.id } } });
    const r3 = await db.chatMessageReaction.findUnique({ where: { messageId_agentId: { messageId: msg3.id, agentId: a.id } } });
    expect(r2?.emoji).toBe('🔥');
    expect(r3?.emoji).toBe('🎉');
  });

  it('messageId không tồn tại → NOT_FOUND', async () => {
    const { db, a } = await makeDirectRoomWithMessage();
    await expectCode(toggleReaction(db, 'khong-ton-tai', a.id, '👍'), 'NOT_FOUND');
  });

  it('agent KHÔNG phải thành viên phòng chứa tin nhắn → NOT_MEMBER', async () => {
    const { db, msg } = await makeDirectRoomWithMessage();
    const stranger = await makeAgent();
    await expectCode(toggleReaction(db, msg.id, stranger.id, '👍'), 'NOT_MEMBER');
  });

  it('emoji rỗng/thiếu → VALIDATION', async () => {
    const { db, a, msg } = await makeDirectRoomWithMessage();
    await expectCode(toggleReaction(db, msg.id, a.id, ''), 'VALIDATION');
    await expectCode(toggleReaction(db, msg.id, a.id, '   '), 'VALIDATION');
  });

  it('audit độc lập 29/7 (MEDIUM) — emoji quá dài (>8 ký tự) → VALIDATION, không tạo hàng', async () => {
    const { db, a, msg } = await makeDirectRoomWithMessage();
    await expectCode(toggleReaction(db, msg.id, a.id, 'a'.repeat(500)), 'VALIDATION');
    const count = await db.chatMessageReaction.count({ where: { messageId: msg.id } });
    expect(count).toBe(0);
  });
});

// debt-chat-gaps (31/7, Việc 1) — khôi phục lịch sử reaction khi tải lại trang (GAP đã ghi ở
// ConversationScreen.tsx `reactionsByMessageRef`/báo cáo Phase 3): trước đây KHÔNG có cách lấy TOÀN BỘ reaction
// của N tin nhắn cùng lúc — chỉ có toggleReaction() (1 tin/1 lần). listReactionsForMessages() gom qua ĐÚNG 1 query.
describe('chat-reaction-service — listReactionsForMessages', () => {
  it('nhiều tin nhắn, nhiều agent react khác nhau → group ĐÚNG theo messageId, 1 query duy nhất', async () => {
    const { db, a, b, room, msg } = await makeDirectRoomWithMessage();
    const msg2 = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'tin 2' });
    const msg3 = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'tin 3 (không ai react)' });
    await toggleReaction(db, msg.id, a.id, '👍');
    await toggleReaction(db, msg.id, b.id, '❤️');
    await toggleReaction(db, msg2.id, b.id, '🔥');

    const map = await listReactionsForMessages(db, [msg.id, msg2.id, msg3.id]);
    expect(map.size).toBe(2); // msg3 không ai react → KHÔNG có entry (không phải mảng rỗng vô nghĩa).
    const msgReactions = map.get(msg.id) ?? [];
    expect(msgReactions).toHaveLength(2);
    expect(msgReactions.map((r) => r.emoji).sort()).toEqual(['👍', '❤️'].sort());
    expect(msgReactions.every((r) => r.messageId === msg.id)).toBe(true);
    const msg2Reactions = map.get(msg2.id) ?? [];
    expect(msg2Reactions).toHaveLength(1);
    expect(msg2Reactions[0].emoji).toBe('🔥');
    expect(msg2Reactions[0].agentId).toBe(b.id);
    expect(map.has(msg3.id)).toBe(false);
  });

  it('messageIds rỗng → trả Map rỗng ngay, KHÔNG query DB', async () => {
    const { db } = await makeDirectRoomWithMessage();
    const map = await listReactionsForMessages(db, []);
    expect(map.size).toBe(0);
  });

  it('unlike (removed) rồi gọi listReactionsForMessages → KHÔNG còn entry của agent đó', async () => {
    const { db, a, msg } = await makeDirectRoomWithMessage();
    await toggleReaction(db, msg.id, a.id, '👍');
    await toggleReaction(db, msg.id, a.id, '👍'); // bấm lại → unlike.
    const map = await listReactionsForMessages(db, [msg.id]);
    expect(map.has(msg.id)).toBe(false);
  });
});
