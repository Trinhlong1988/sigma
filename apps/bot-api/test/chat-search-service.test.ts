// SIGMA B103 — test chat-search-service.ts (searchMessages), quy mô cỡ agent Explore + LEAD tự viết vì đây
// là fix bug NGHIÊM TRỌNG Admin Demo báo trực tiếp: tìm tin nhắn thật (có dấu "."/chữ thường "hi") không ra kết
// quả, chỉ thấy dữ liệu mock cũ (panel tìm kiếm ChatListScreen.tsx CHƯA BAO GIỜ nối qua chat_messages thật).
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { sendMessage } from '../src/services/chat-message-service.js';
import { searchMessages } from '../src/services/chat-search-service.js';
import { makeAgent, makeChatRoom, makeChatRoomMember, makeFriends } from './fixtures.js';

describe('searchMessages', () => {
  it('tìm ĐÚNG kịch bản bug thật (Admin Demo báo 1/8): tin nhắn có dấu "." và chữ "hi" → tìm ra, khớp snippet/roomId', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const nam = await makeAgent(undefined, { name: 'Nam' });
    const room = await db.chatRoom.create({ data: { type: 'DIRECT', name: null } }); // DIRECT thật KHÔNG có name — kiểm tra roomName trả về null đúng thiết kế.
    await makeChatRoomMember(room.id, me.id);
    await makeChatRoomMember(room.id, nam.id);
    // AUDIT-4 (4/8): phòng DIRECT THẬT chỉ tồn tại giữa 2 người là bạn bè (creation gate) — sendMessage() nay
    // enforce canMessageAgent() cho DIRECT (bịt lỗ hổng chặn/hủy-kết-bạn). Fixture phải phản ánh thực tế: đặt
    // quan hệ bạn bè trước khi gửi (không thì 403 CANNOT_MESSAGE — đúng invariant mới, không phải lỗi test này).
    await makeFriends(me.id, nam.id);
    const sent = await sendMessage(db, { roomId: room.id, senderId: me.id, kind: 'TEXT', body: 'chào Nam. hi nhé, mai họp lúc 9h' });

    const hits = await searchMessages(db, me.id, 'hi');
    expect(hits.some((h) => h.messageId === sent.id)).toBe(true);
    const hit = hits.find((h) => h.messageId === sent.id)!;
    expect(hit.roomId).toBe(room.id);
    expect(hit.snippet).toBe('chào Nam. hi nhé, mai họp lúc 9h');
    expect(hit.roomName).toBeNull(); // DIRECT không có tên riêng — client tự resolve tên đối phương.
    void nam; // giữ biến cho rõ ngữ cảnh kịch bản (2 phía DIRECT), không dùng trực tiếp field nào của nó.
  });

  it('không phân biệt hoa/thường', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, me.id);
    const sent = await sendMessage(db, { roomId: room.id, senderId: me.id, kind: 'TEXT', body: 'Xin CHÀO cả nhà' });
    const hits = await searchMessages(db, me.id, 'chào');
    expect(hits.some((h) => h.messageId === sent.id)).toBe(true);
  });

  it('KHÔNG trả tin nhắn của phòng mình KHÔNG phải thành viên (an ninh dữ liệu)', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const other = await makeAgent();
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, other.id); // me KHÔNG phải thành viên
    await sendMessage(db, { roomId: room.id, senderId: other.id, kind: 'TEXT', body: 'bí mật riêng tư abc' });
    const hits = await searchMessages(db, me.id, 'bí mật');
    expect(hits).toEqual([]);
  });

  it('tin đã thu hồi (deletedAt) KHÔNG hiện trong kết quả', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, me.id);
    const sent = await sendMessage(db, { roomId: room.id, senderId: me.id, kind: 'TEXT', body: 'tin sẽ bị thu hồi ngay' });
    await db.chatMessage.update({ where: { id: sent.id }, data: { deletedAt: new Date() } });
    const hits = await searchMessages(db, me.id, 'thu hồi');
    expect(hits).toEqual([]);
  });

  it('tin KHÔNG phải TEXT (vd IMAGE, body chỉ là caption) — KHÔNG lọt vào kết quả (chỉ tìm tin TEXT, tránh false-positive trên caption ảnh)', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, me.id);
    const attachment = await db.chatAttachment.create({
      data: { uploaderId: me.id, fileName: 'a.jpg', mimeType: 'image/jpeg', sizeBytes: 100, checksum: 'x'.repeat(64), storagePath: '/tmp/a.jpg', roomId: room.id }
    });
    await sendMessage(db, { roomId: room.id, senderId: me.id, kind: 'IMAGE', body: 'caption có chữ đặc biệt xyz', attachmentId: attachment.id });
    const hits = await searchMessages(db, me.id, 'đặc biệt');
    expect(hits).toEqual([]);
  });

  it('rời phòng (leftAt) → KHÔNG còn tìm thấy tin nhắn cũ của phòng đó', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const room = await makeChatRoom({ type: 'GROUP' });
    const membership = await makeChatRoomMember(room.id, me.id);
    await sendMessage(db, { roomId: room.id, senderId: me.id, kind: 'TEXT', body: 'tin nhắn lúc còn ở phòng' });
    await db.chatRoomMember.update({ where: { id: membership.id }, data: { leftAt: new Date() } });
    const hits = await searchMessages(db, me.id, 'còn ở phòng');
    expect(hits).toEqual([]);
  });

  it('q rỗng/chỉ khoảng trắng → trả [] ngay, KHÔNG query toàn bảng', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    expect(await searchMessages(db, me.id, '')).toEqual([]);
    expect(await searchMessages(db, me.id, '   ')).toEqual([]);
  });

  it('agent chưa gắn phòng nào → trả [] ngay (không lỗi)', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    expect(await searchMessages(db, me.id, 'bất kỳ')).toEqual([]);
  });

  // B107 (2/8, Admin Demo yêu cầu tìm kiếm NGAY TRONG 1 khung chat, kiểu Zalo, có bộ đếm+điều hướng) — tham số
  // roomId tùy chọn, CHỈ tìm trong 1 phòng cụ thể.
  describe('tham số roomId (B107 — tìm trong 1 phòng cụ thể)', () => {
    it('có roomId → CHỈ trả kết quả của phòng đó, dù cùng nội dung khớp ở phòng KHÁC', async () => {
      const db = getBotDb();
      const me = await makeAgent();
      const roomA = await makeChatRoom({ type: 'GROUP' });
      const roomB = await makeChatRoom({ type: 'GROUP' });
      await makeChatRoomMember(roomA.id, me.id);
      await makeChatRoomMember(roomB.id, me.id);
      const sentA = await sendMessage(db, { roomId: roomA.id, senderId: me.id, kind: 'TEXT', body: 'ca hai phong deu co tu khoa dac biet' });
      await sendMessage(db, { roomId: roomB.id, senderId: me.id, kind: 'TEXT', body: 'ca hai phong deu co tu khoa dac biet' });

      const hits = await searchMessages(db, me.id, 'dac biet', roomA.id);
      expect(hits).toHaveLength(1);
      expect(hits[0].messageId).toBe(sentA.id);
      expect(hits[0].roomId).toBe(roomA.id);
    });

    it('roomId mà agent KHÔNG phải thành viên → trả [] (an ninh dữ liệu, KHÔNG throw)', async () => {
      const db = getBotDb();
      const me = await makeAgent();
      const other = await makeAgent();
      const room = await makeChatRoom({ type: 'GROUP' });
      await makeChatRoomMember(room.id, other.id); // me KHÔNG phải thành viên
      await sendMessage(db, { roomId: room.id, senderId: other.id, kind: 'TEXT', body: 'noi dung bi mat rieng tu' });
      expect(await searchMessages(db, me.id, 'bi mat', room.id)).toEqual([]);
    });

    it('không truyền roomId (undefined) → hành vi CŨ giữ nguyên, gộp mọi phòng', async () => {
      const db = getBotDb();
      const me = await makeAgent();
      const roomA = await makeChatRoom({ type: 'GROUP' });
      const roomB = await makeChatRoom({ type: 'GROUP' });
      await makeChatRoomMember(roomA.id, me.id);
      await makeChatRoomMember(roomB.id, me.id);
      await sendMessage(db, { roomId: roomA.id, senderId: me.id, kind: 'TEXT', body: 'tu khoa gop chung ca hai' });
      await sendMessage(db, { roomId: roomB.id, senderId: me.id, kind: 'TEXT', body: 'tu khoa gop chung ca hai' });
      const hits = await searchMessages(db, me.id, 'gop chung');
      expect(hits).toHaveLength(2);
    });
  });
});
