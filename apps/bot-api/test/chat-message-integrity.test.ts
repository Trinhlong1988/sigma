// LANE C Vòng 2 (3/8) — TOÀN VẸN GHI DỮ LIỆU cho chat-message-service.ts: chống GHI SAI con trỏ tham chiếu
// tin nhắn. 2 lớp lỗi tái hiện:
//   #2 sendMessage GHI `replyToMessageId` KHÔNG validate → trả lời XUYÊN PHÒNG (id tin của phòng khác).
//   #3 markRead GHI `lastReadMessageId` TÙY Ý → con trỏ "đã đọc" trỏ tới tin KHÔNG thuộc phòng.
// Chạy trên throwaway Postgres THẬT (global-setup.ts), gọi thẳng service (KHÔNG qua HTTP) — CÙNG khuôn
// chat-message-service.test.ts.
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeFriends } from './fixtures.js';
import { findOrCreateDirectRoom, ChatServiceError } from '../src/services/chat-room-service.js';
import { sendMessage, markRead } from '../src/services/chat-message-service.js';

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ChatServiceError code=${code} nhưng KHÔNG throw.`);
  } catch (err) {
    expect(err).toBeInstanceOf(ChatServiceError);
    expect((err as ChatServiceError).code).toBe(code);
  }
}

/** 2 phòng DIRECT chia sẻ CÙNG 1 agent A (A ở cả 2 phòng — mô phỏng đúng kịch bản "biết id tin phòng khác"). */
async function twoRoomsSharingA() {
  const db = getBotDb();
  const a = await makeAgent();
  const b = await makeAgent();
  const c = await makeAgent();
  await makeFriends(a.id, b.id);
  await makeFriends(a.id, c.id);
  const room1 = await findOrCreateDirectRoom(db, a.id, b.id); // A + B
  const room2 = await findOrCreateDirectRoom(db, a.id, c.id); // A + C
  return { db, a, b, c, room1, room2 };
}

describe('chat-message-service — #2 sendMessage validate replyToMessageId (chống trả lời xuyên phòng)', () => {
  it('reply tới tin của PHÒNG KHÁC → VALIDATION (KHÔNG ghi replyToMessageId chéo phòng)', async () => {
    const { db, a, c, room1, room2 } = await twoRoomsSharingA();
    // Tin gốc nằm ở room2 (A gửi cho C).
    const foreign = await sendMessage(db, { roomId: room2.id, senderId: a.id, kind: 'TEXT', body: 'tin phòng 2' });
    // A gửi vào room1 nhưng trả lời id tin của room2 → PHẢI bị chặn.
    await expectCode(
      sendMessage(db, { roomId: room1.id, senderId: a.id, kind: 'TEXT', body: 'trả lời chéo', replyToMessageId: foreign.id }),
      'VALIDATION'
    );
    void c;
    // Đảm bảo KHÔNG có tin nào bị ghi vào room1 với con trỏ chéo.
    const leaked = await db.chatMessage.findMany({ where: { roomId: room1.id, replyToMessageId: foreign.id } });
    expect(leaked).toHaveLength(0);
  });

  it('reply tới id KHÔNG tồn tại → VALIDATION', async () => {
    const { db, a, room1 } = await twoRoomsSharingA();
    await expectCode(
      sendMessage(db, { roomId: room1.id, senderId: a.id, kind: 'TEXT', body: 'x', replyToMessageId: 'khong-ton-tai-123' }),
      'VALIDATION'
    );
  });

  it('reply tới tin ĐÃ XÓA (soft-delete) trong CÙNG phòng → VALIDATION', async () => {
    const { db, a, room1 } = await twoRoomsSharingA();
    const orig = await sendMessage(db, { roomId: room1.id, senderId: a.id, kind: 'TEXT', body: 'gốc' });
    await db.chatMessage.update({ where: { id: orig.id }, data: { deletedAt: new Date() } });
    await expectCode(
      sendMessage(db, { roomId: room1.id, senderId: a.id, kind: 'TEXT', body: 'trả lời tin đã xóa', replyToMessageId: orig.id }),
      'VALIDATION'
    );
  });

  it('reply tới tin HỢP LỆ cùng phòng, chưa xóa → GHI được replyToMessageId đúng', async () => {
    const { db, a, room1 } = await twoRoomsSharingA();
    const orig = await sendMessage(db, { roomId: room1.id, senderId: a.id, kind: 'TEXT', body: 'gốc' });
    const reply = await sendMessage(db, { roomId: room1.id, senderId: a.id, kind: 'TEXT', body: 'trả lời', replyToMessageId: orig.id });
    expect(reply.replyToMessageId).toBe(orig.id);
  });
});

describe('chat-message-service — #3 markRead validate lastReadMessageId (chống con trỏ đã-đọc trỏ tin lạ)', () => {
  it('markRead với id tin của PHÒNG KHÁC → VALIDATION (KHÔNG ghi lastReadMessageId chéo phòng)', async () => {
    const { db, a, room1, room2 } = await twoRoomsSharingA();
    const foreign = await sendMessage(db, { roomId: room2.id, senderId: a.id, kind: 'TEXT', body: 'tin phòng 2' });
    await expectCode(markRead(db, room1.id, a.id, foreign.id), 'VALIDATION');
    // Con trỏ của A trong room1 KHÔNG được ghi id lạ.
    const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room1.id, agentId: a.id } } });
    expect(member?.lastReadMessageId).not.toBe(foreign.id);
  });

  it('markRead với id KHÔNG tồn tại → VALIDATION', async () => {
    const { db, a, room1 } = await twoRoomsSharingA();
    await expectCode(markRead(db, room1.id, a.id, 'khong-ton-tai-999'), 'VALIDATION');
  });

  it('markRead với id tin HỢP LỆ trong CÙNG phòng → ghi lastReadMessageId đúng', async () => {
    const { db, a, room1 } = await twoRoomsSharingA();
    const msg = await sendMessage(db, { roomId: room1.id, senderId: a.id, kind: 'TEXT', body: 'tin phòng 1' });
    await markRead(db, room1.id, a.id, msg.id);
    const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room1.id, agentId: a.id } } });
    expect(member?.lastReadMessageId).toBe(msg.id);
  });
});
