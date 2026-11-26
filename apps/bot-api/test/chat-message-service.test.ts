// SIGMA Phase 2 (29/7) — regression cho chat-message-service.ts. Gọi thẳng service (KHÔNG qua HTTP), CÙNG
// khuôn chat-room-service.test.ts.
import { describe, expect, it, vi } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeFriends } from './fixtures.js';
import { createGroupRoom, findOrCreateDirectRoom, updateGroupSettings, changeMemberRole, ChatServiceError } from '../src/services/chat-room-service.js';
import {
  deleteMessage,
  editMessage,
  listMessages,
  listRoomAttachments,
  markRead,
  markAllRead,
  sendMessage,
  MESSAGE_DELETE_WINDOW_HOURS,
  MESSAGE_EDIT_WINDOW_HOURS
} from '../src/services/chat-message-service.js';
import { saveAttachment, getAttachmentRow } from '../src/chat-attachment-service.js';

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ChatServiceError code=${code} nhưng KHÔNG throw.`);
  } catch (err) {
    expect(err).toBeInstanceOf(ChatServiceError);
    expect((err as ChatServiceError).code).toBe(code);
  }
}

async function makeDirectRoom() {
  const db = getBotDb();
  const a = await makeAgent();
  const b = await makeAgent();
  await makeFriends(a.id, b.id);
  const room = await findOrCreateDirectRoom(db, a.id, b.id);
  return { db, a, b, room };
}

describe('chat-message-service — sendMessage', () => {
  it('happy path TEXT — tạo tin nhắn, room.lastMessageAt được cập nhật', async () => {
    const { db, a, room } = await makeDirectRoom();
    const before = await db.chatRoom.findUnique({ where: { id: room.id } });
    expect(before?.lastMessageAt).toBeNull();

    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: '  Xin chào  ' });
    expect(msg.body).toBe('Xin chào'); // đã trim
    expect(msg.senderId).toBe(a.id);
    expect(msg.roomId).toBe(room.id);

    const after = await db.chatRoom.findUnique({ where: { id: room.id } });
    expect(after?.lastMessageAt).not.toBeNull();
  });

  // REGRESSION realtime senderName (Admin Demo 1/9 "tin BILL đến LIVE vẫn Đại lý #412 tới khi tải lại") — giá trị
  // trả về của sendMessage() PHẢI mang senderName = tên agent gửi (tra bảng agents), vì MỌI nơi broadcast tin mới
  // qua WS (routes/chat.ts, ocr-send-service bill CK, investor-crosspost, zalo-bill-ingest) đều broadcast CHÍNH
  // object này — thiếu field này thì tin realtime rơi fallback "Đại lý #id" cho tới khi tải lại (listMessages).
  it('trả về senderName = tên agent gửi (để broadcast realtime mang đúng tên, không "Đại lý #id")', async () => {
    const db = getBotDb();
    const sender = await makeAgent(undefined, { name: 'SigMa Bot Kiểm Thử' });
    const other = await makeAgent();
    await makeFriends(sender.id, other.id);
    const room = await findOrCreateDirectRoom(db, sender.id, other.id);
    const msg = await sendMessage(db, { roomId: room.id, senderId: sender.id, kind: 'TEXT', body: 'chào' });
    expect(msg.senderName).toBe('SigMa Bot Kiểm Thử');
  });

  it('người KHÔNG phải thành viên gửi tin → NOT_MEMBER', async () => {
    const { db, room } = await makeDirectRoom();
    const stranger = await makeAgent();
    await expectCode(sendMessage(db, { roomId: room.id, senderId: stranger.id, kind: 'TEXT', body: 'hack' }), 'NOT_MEMBER');
  });

  it('kind=TEXT nhưng body rỗng/thiếu → VALIDATION', async () => {
    const { db, a, room } = await makeDirectRoom();
    await expectCode(sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: '   ' }), 'VALIDATION');
    await expectCode(sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT' }), 'VALIDATION');
  });

  it('kind không hợp lệ → VALIDATION', async () => {
    const { db, a, room } = await makeDirectRoom();
    // @ts-expect-error test cố tình gửi kind sai để kiểm validation runtime
    await expectCode(sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'STICKER' }), 'VALIDATION');
  });

  it('attachmentId của NGƯỜI KHÁC upload → ATTACHMENT_NOT_OWNED, KHÔNG tạo tin nhắn', async () => {
    const { db, a, b, room } = await makeDirectRoom();
    const uploaded = await saveAttachment(db, PNG_1PX, 'anh.png', b.id); // b upload, a cố gắn vào tin của mình
    if (!uploaded.ok) throw new Error('setup thất bại');
    await expectCode(sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: uploaded.id }), 'ATTACHMENT_NOT_OWNED');
    const count = await db.chatMessage.count({ where: { roomId: room.id } });
    expect(count).toBe(0);
  });

  it('attachmentId ĐÚNG chủ sở hữu → gửi thành công (IMAGE, body optional làm caption)', async () => {
    const { db, a, room } = await makeDirectRoom();
    const uploaded = await saveAttachment(db, PNG_1PX, 'anh.png', a.id);
    if (!uploaded.ok) throw new Error('setup thất bại');
    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: uploaded.id, body: 'caption' });
    expect(msg.attachmentId).toBe(uploaded.id);
    expect(msg.body).toBe('caption');
  });

  // BUG#6 (6/8, Admin Demo "người NHẬN không mở/tải được đính kèm") — sendMessage() PHẢI gắn roomId cho attachment
  // NGAY trong transaction gửi tin (server-authoritative), KHÔNG phụ thuộc PATCH best-effort client (có thể
  // lỗi/đua → room_id null → GET /v1/chat/attachments/:id trả 403 cho người nhận). Attachment vừa upload có
  // roomId=null; sau khi gửi tin tham chiếu nó, roomId PHẢI = phòng đang gửi.
  it('gửi tin có attachment → roomId của attachment được set SERVER-SIDE (BUG#6, người nhận xem được)', async () => {
    const { db, a, room } = await makeDirectRoom();
    const uploaded = await saveAttachment(db, PNG_1PX, 'anh.png', a.id);
    if (!uploaded.ok) throw new Error('setup thất bại');
    const before = await db.chatAttachment.findUnique({ where: { id: uploaded.id } });
    expect(before?.roomId).toBeNull(); // mới upload — chưa thuộc phòng nào
    await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: uploaded.id });
    const after = await db.chatAttachment.findUnique({ where: { id: uploaded.id } });
    expect(after?.roomId).toBe(room.id); // đã gắn phòng ngay khi gửi, không đợi PATCH client
  });

  // debt-chat-gaps (31/7, Việc 2) — GAP đã ghi ở chat-client.ts guessFileKindFromName(): ChatMessageDto trước
  // đây KHÔNG mang mimeType/sizeBytes THẬT của attachment (FE phải đoán theo đuôi tên file). sendMessage() giờ
  // trả kèm 2 field này NGAY lúc gửi (không đợi tải lại trang), lấy từ chính ChatAttachment đã lưu (magic-bytes
  // thật lúc upload, xem saveAttachment()).
  it('attachmentMimeType/attachmentSizeBytes trả ĐÚNG từ ChatAttachment thật (magic-bytes), không phải đoán theo tên', async () => {
    const { db, a, room } = await makeDirectRoom();
    const uploaded = await saveAttachment(db, PNG_1PX, 'anh-gia-danh.pdf', a.id); // tên file khai .pdf nhưng NỘI DUNG thật là PNG
    if (!uploaded.ok) throw new Error('setup thất bại');
    expect(uploaded.mimeType).toBe('image/png'); // xác nhận magic-bytes thắng đuôi tên (đúng thiết kế saveAttachment()).
    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: uploaded.id });
    expect(msg.attachmentMimeType).toBe('image/png');
    expect(msg.attachmentSizeBytes).toBe(PNG_1PX.length);
  });

  it('tin nhắn KHÔNG có attachmentId (TEXT thường) → attachmentMimeType/attachmentSizeBytes = null', async () => {
    const { db, a, room } = await makeDirectRoom();
    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'chỉ chữ' });
    expect(msg.attachmentMimeType).toBeNull();
    expect(msg.attachmentSizeBytes).toBeNull();
  });
});

// debt-chat-gaps (31/7, Việc 4) — "chỉ trưởng/phó nhóm được gửi tin" (ChatRoom.readOnly). Nhóm 3 người tối
// thiểu (createGroupRoom yêu cầu ≥3, xem chat-room-service.ts) để có MEMBER thường KHÁC OWNER thử gửi tin.
describe('chat-message-service — sendMessage readOnly gate (debt-chat-gaps 31/7, Việc 4)', () => {
  async function makeGroupRoom() {
    const db = getBotDb();
    const owner = await makeAgent();
    const admin = await makeAgent();
    const member = await makeAgent();
    await makeFriends(owner.id, admin.id);
    await makeFriends(owner.id, member.id);
    const room = await createGroupRoom(db, owner.id, 'Nhóm readOnly', [admin.id, member.id]);
    await changeMemberRole(db, room.id, owner.id, admin.id, 'ADMIN');
    return { db, owner, admin, member, room };
  }

  it('phòng readOnly=false (mặc định) → MEMBER thường vẫn gửi được bình thường', async () => {
    const { db, member, room } = await makeGroupRoom();
    const msg = await sendMessage(db, { roomId: room.id, senderId: member.id, kind: 'TEXT', body: 'gửi bình thường' });
    expect(msg.body).toBe('gửi bình thường');
  });

  it('bật readOnly=true → MEMBER thường gửi tin bị chặn ROOM_READ_ONLY', async () => {
    const { db, owner, member, room } = await makeGroupRoom();
    await updateGroupSettings(db, room.id, owner.id, { readOnly: true });
    await expectCode(sendMessage(db, { roomId: room.id, senderId: member.id, kind: 'TEXT', body: 'bị chặn' }), 'ROOM_READ_ONLY');
  });

  it('bật readOnly=true → OWNER và ADMIN vẫn gửi được bình thường', async () => {
    const { db, owner, admin, room } = await makeGroupRoom();
    await updateGroupSettings(db, room.id, owner.id, { readOnly: true });
    const ownerMsg = await sendMessage(db, { roomId: room.id, senderId: owner.id, kind: 'TEXT', body: 'trưởng nhóm vẫn gửi được' });
    expect(ownerMsg.body).toBe('trưởng nhóm vẫn gửi được');
    const adminMsg = await sendMessage(db, { roomId: room.id, senderId: admin.id, kind: 'TEXT', body: 'phó nhóm vẫn gửi được' });
    expect(adminMsg.body).toBe('phó nhóm vẫn gửi được');
  });

  it('tắt readOnly lại (false) → MEMBER thường gửi lại được bình thường', async () => {
    const { db, owner, member, room } = await makeGroupRoom();
    await updateGroupSettings(db, room.id, owner.id, { readOnly: true });
    await expectCode(sendMessage(db, { roomId: room.id, senderId: member.id, kind: 'TEXT', body: 'bị chặn' }), 'ROOM_READ_ONLY');
    await updateGroupSettings(db, room.id, owner.id, { readOnly: false });
    const msg = await sendMessage(db, { roomId: room.id, senderId: member.id, kind: 'TEXT', body: 'lại gửi được' });
    expect(msg.body).toBe('lại gửi được');
  });
});

// debt-chat-gaps (31/7, Việc 3) — tab "File" GroupInfoPanel.tsx (đang ẨN, xem comment đầu file đó).
describe('chat-message-service — listRoomAttachments', () => {
  it('trả danh sách attachment ĐÃ gửi trong phòng, MỚI NHẤT TRƯỚC, kèm đủ mimeType/sizeBytes/uploaderId', async () => {
    const { db, a, room } = await makeDirectRoom();
    await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'tin chữ, không tính' });
    const up1 = await saveAttachment(db, PNG_1PX, 'anh1.png', a.id);
    const up2 = await saveAttachment(db, PNG_1PX, 'anh2.png', a.id);
    if (!up1.ok || !up2.ok) throw new Error('setup thất bại');
    await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: up1.id });
    await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: up2.id });

    const result = await listRoomAttachments(db, room.id, a.id);
    // FIX-PERF (4/8) — shape đổi từ mảng trơn sang { attachments, hasMore } (phân trang).
    expect(result.attachments).toHaveLength(2);
    expect(result.hasMore).toBe(false);
    expect(result.attachments[0].attachmentId).toBe(up2.id); // mới nhất trước.
    expect(result.attachments[1].attachmentId).toBe(up1.id);
    expect(result.attachments[0].mimeType).toBe('image/png');
    expect(result.attachments[0].sizeBytes).toBe(PNG_1PX.length);
    expect(result.attachments[0].uploaderId).toBe(a.id);
  });

  it('tin nhắn có attachment ĐÃ bị xóa mềm (deleteMessage null hóa attachmentId) → KHÔNG còn xuất hiện trong danh sách', async () => {
    const { db, a, room } = await makeDirectRoom();
    const up = await saveAttachment(db, PNG_1PX, 'anh.png', a.id);
    if (!up.ok) throw new Error('setup thất bại');
    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: up.id });
    await deleteMessage(db, msg.id, a.id);
    const result = await listRoomAttachments(db, room.id, a.id);
    expect(result.attachments).toHaveLength(0);
  });

  it('phòng chưa có attachment nào → mảng rỗng, KHÔNG lỗi', async () => {
    const { db, a, room } = await makeDirectRoom();
    const result = await listRoomAttachments(db, room.id, a.id);
    expect(result.attachments).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  it('agent KHÔNG phải thành viên phòng → NOT_MEMBER', async () => {
    const { db, room } = await makeDirectRoom();
    const stranger = await makeAgent();
    await expectCode(listRoomAttachments(db, room.id, stranger.id), 'NOT_MEMBER');
  });
});

describe('chat-message-service — listMessages (cursor pagination)', () => {
  it('phân trang cursor KHÔNG lệch khi có tin MỚI chen vào giữa 2 lần tải (khác offset)', async () => {
    const { db, a, room } = await makeDirectRoom();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const m = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: `tin ${i}` });
      ids.push(m.id);
    }
    // Trang 1: 3 tin mới nhất (tin 4,3,2 — desc).
    const page1 = await listMessages(db, room.id, a.id, { limit: 3 });
    expect(page1.messages.map((m) => m.body)).toEqual(['tin 4', 'tin 3', 'tin 2']);
    expect(page1.hasMore).toBe(true);

    // 1 tin MỚI được gửi (chen vào) TRƯỚC khi tải trang 2 — cursor dùng id CŨ NHẤT của trang 1 (tin 2), KHÔNG
    // dùng offset nên KHÔNG bị lệch/trùng bởi tin mới này.
    await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'tin chen ngang' });

    const oldestOfPage1 = page1.messages[page1.messages.length - 1].id;
    const page2 = await listMessages(db, room.id, a.id, { limit: 3, before: oldestOfPage1 });
    expect(page2.messages.map((m) => m.body)).toEqual(['tin 1', 'tin 0']);
    expect(page2.hasMore).toBe(false);
  });

  it('limit mặc định 30, cap tối đa 100 (limit=99999 → vẫn lấy tối đa 100)', async () => {
    const { db, a, room } = await makeDirectRoom();
    await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'chỉ 1 tin' });
    const result = await listMessages(db, room.id, a.id, { limit: 99999 });
    expect(result.messages.length).toBe(1); // chỉ có 1 tin thật, không phải kiểm số 100 ở đây — kiểm KHÔNG throw/lỗi khi limit vượt trần.
    expect(result.hasMore).toBe(false);
  });

  it('người KHÔNG phải thành viên đọc tin → NOT_MEMBER', async () => {
    const { db, room } = await makeDirectRoom();
    const stranger = await makeAgent();
    await expectCode(listMessages(db, room.id, stranger.id), 'NOT_MEMBER');
  });

  it('before trỏ tới id không tồn tại → VALIDATION', async () => {
    const { db, a, room } = await makeDirectRoom();
    await expectCode(listMessages(db, room.id, a.id, { before: 'khong-ton-tai' }), 'VALIDATION');
  });

  it('audit độc lập 29/7 (MEDIUM) — before trỏ tới messageId THẬT nhưng thuộc PHÒNG KHÁC → VALIDATION, KHÔNG dùng làm oracle cross-room', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    const c = await makeAgent();
    await makeFriends(a.id, b.id);
    await makeFriends(a.id, c.id);
    const roomAB = await findOrCreateDirectRoom(db, a.id, b.id);
    const roomAC = await findOrCreateDirectRoom(db, a.id, c.id);
    const msgInOtherRoom = await sendMessage(db, { roomId: roomAC.id, senderId: a.id, kind: 'TEXT', body: 'tin phòng AC' });

    // a LÀ thành viên roomAB thật (không phải NOT_MEMBER) nhưng messageId thuộc roomAC — trước khi vá, câu này
    // trả 200 âm thầm thay vì lỗi, lộ rằng messageId đó tồn tại + đúng createdAt của nó.
    await expectCode(listMessages(db, roomAB.id, a.id, { before: msgInOtherRoom.id }), 'VALIDATION');
  });
});

describe('chat-message-service — deleteMessage (thu hồi, soft, 48h)', () => {
  it('chính người gửi xóa TRONG 48h → deletedAt được set', async () => {
    const { db, a, room } = await makeDirectRoom();
    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'xóa tôi' });
    await deleteMessage(db, msg.id, a.id);
    const row = await db.chatMessage.findUnique({ where: { id: msg.id } });
    expect(row?.deletedAt).not.toBeNull();
  });

  it('NGƯỜI KHÁC (không phải người gửi) cố xóa → FORBIDDEN, deletedAt vẫn null', async () => {
    const { db, a, b, room } = await makeDirectRoom();
    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'của A' });
    await expectCode(deleteMessage(db, msg.id, b.id), 'FORBIDDEN');
    const row = await db.chatMessage.findUnique({ where: { id: msg.id } });
    expect(row?.deletedAt).toBeNull();
  });

  it(`quá ${MESSAGE_DELETE_WINDOW_HOURS}h kể từ lúc gửi → DELETE_WINDOW_EXPIRED, KHÔNG xóa được`, async () => {
    const { db, a, room } = await makeDirectRoom();
    const oldDate = new Date(Date.now() - (MESSAGE_DELETE_WINDOW_HOURS + 1) * 60 * 60 * 1000);
    const oldMsg = await db.chatMessage.create({ data: { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'tin cũ', createdAt: oldDate } });
    await expectCode(deleteMessage(db, oldMsg.id, a.id), 'DELETE_WINDOW_EXPIRED');
    const row = await db.chatMessage.findUnique({ where: { id: oldMsg.id } });
    expect(row?.deletedAt).toBeNull();
  });

  it('tin không tồn tại → NOT_FOUND', async () => {
    const { db, a } = await makeDirectRoom();
    await expectCode(deleteMessage(db, 'khong-ton-tai', a.id), 'NOT_FOUND');
  });

  it('xóa 1 tin đã xóa rồi → idempotent, KHÔNG throw', async () => {
    const { db, a, room } = await makeDirectRoom();
    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'xóa 2 lần' });
    await deleteMessage(db, msg.id, a.id);
    await expect(deleteMessage(db, msg.id, a.id)).resolves.toBeUndefined();
  });

  // REGRESSION FIX thu-hồi-tin-ảnh (12/8) — thu hồi tin CÓ đính kèm phải GỠ quyền tải (xóa row chat_attachments
  // → getAttachmentRow null → route trả 404) + dọn file vật lý. Trước đây attachment vẫn tải được sau thu hồi.
  it('thu hồi tin ẢNH → attachment bị xóa HẲN khỏi DB (gỡ quyền tải)', async () => {
    const { db, a, room } = await makeDirectRoom();
    const up = await saveAttachment(db, PNG_1PX, 'thu-hoi.png', a.id);
    if (!up.ok) throw new Error('setup thất bại');
    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: up.id });
    expect(await getAttachmentRow(db, up.id)).not.toBeNull(); // trước thu hồi: còn tải được.
    await deleteMessage(db, msg.id, a.id);
    expect(await getAttachmentRow(db, up.id)).toBeNull(); // sau thu hồi: row bị xóa → không ai tải được.
  });

  it('thu hồi tin ẢNH KHÔNG phá attachment còn tin CHƯA-XÓA khác dùng (cùng file gắn 2 tin)', async () => {
    const { db, a, room } = await makeDirectRoom();
    const up = await saveAttachment(db, PNG_1PX, 'chung.png', a.id);
    if (!up.ok) throw new Error('setup thất bại');
    const m1 = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: up.id });
    const m2 = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: up.id });
    await deleteMessage(db, m1.id, a.id);
    expect(await getAttachmentRow(db, up.id)).not.toBeNull(); // m2 còn dùng → giữ nguyên.
    await deleteMessage(db, m2.id, a.id);
    expect(await getAttachmentRow(db, up.id)).toBeNull(); // hết tin dùng → mới xóa.
  });
});

describe('chat-message-service — editMessage (Admin Demo chốt 29/7: cửa sổ sửa = 1h, KHÁC 48h của xóa)', () => {
  it('chính người gửi sửa TRONG cửa sổ → body/editedAt cập nhật', async () => {
    const { db, a, room } = await makeDirectRoom();
    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'bản gốc' });
    const updated = await editMessage(db, msg.id, a.id, '  bản sửa  ');
    expect(updated.body).toBe('bản sửa');
    expect(updated.editedAt).not.toBeNull();
  });

  it('NGƯỜI KHÁC cố sửa → FORBIDDEN', async () => {
    const { db, a, b, room } = await makeDirectRoom();
    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'của A' });
    await expectCode(editMessage(db, msg.id, b.id, 'bị hack'), 'FORBIDDEN');
  });

  it('newBody rỗng sau trim → VALIDATION', async () => {
    const { db, a, room } = await makeDirectRoom();
    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'gốc' });
    await expectCode(editMessage(db, msg.id, a.id, '   '), 'VALIDATION');
  });

  it(`quá ${MESSAGE_EDIT_WINDOW_HOURS}h (1h) → EDIT_WINDOW_EXPIRED`, async () => {
    const { db, a, room } = await makeDirectRoom();
    const oldDate = new Date(Date.now() - (MESSAGE_EDIT_WINDOW_HOURS + 1) * 60 * 60 * 1000);
    const oldMsg = await db.chatMessage.create({ data: { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'cũ', createdAt: oldDate } });
    await expectCode(editMessage(db, oldMsg.id, a.id, 'sửa muộn'), 'EDIT_WINDOW_EXPIRED');
  });

  it('regression B49-decision: tin nhắn 2h tuổi — VẪN xóa được (trong 48h) nhưng KHÔNG còn sửa được (quá 1h) — 2 cửa sổ ĐỘC LẬP nhau', async () => {
    const { db, a, room } = await makeDirectRoom();
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    const msg = await db.chatMessage.create({ data: { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'cũ 2h', createdAt: twoHoursAgo } });
    await expectCode(editMessage(db, msg.id, a.id, 'sửa lúc 2h'), 'EDIT_WINDOW_EXPIRED');
    await deleteMessage(db, msg.id, a.id); // 2h < 48h — vẫn xóa được, KHÔNG throw.
    const after = await db.chatMessage.findUnique({ where: { id: msg.id } });
    expect(after?.deletedAt).not.toBeNull();
  });

  it('sửa tin đã bị xóa → VALIDATION', async () => {
    const { db, a, room } = await makeDirectRoom();
    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'sắp xóa' });
    await deleteMessage(db, msg.id, a.id);
    await expectCode(editMessage(db, msg.id, a.id, 'sửa sau khi xóa'), 'VALIDATION');
  });
});

// B112 (2/8, Admin Demo "bill sau khi gửi chưa có nút sửa") — sửa ẢNH BILL đã gửi (ghép lại bảng OCR + đổi ảnh
// đính kèm). Cửa sổ thời gian DÙNG CHUNG editMessage() hiện có (1h) — KHÔNG hằng số riêng, xem comment hàm đó.
describe('chat-message-service — editMessage() với billPatch (B112, sửa ảnh bill đã gửi)', () => {
  async function makeBillMessage(db: ReturnType<typeof getBotDb>, senderId: number, roomId: string) {
    const uploaded = await saveAttachment(db, PNG_1PX, 'bill-goc.jpg', senderId);
    if (!uploaded.ok) throw new Error('setup thất bại');
    const metadataJson = JSON.stringify({ isBillImage: true, billAmount: 4_000_000, billImageHeightPx: 800, billFields: { tid: null } });
    const msg = await sendMessage(db, { roomId, senderId, kind: 'IMAGE', attachmentId: uploaded.id, body: 'POS ... - 4.000.000đ', metadataJson });
    return { msg, uploaded };
  }

  it('happy path — người gửi sửa TRONG cửa sổ 1h → attachmentId/metadataJson/body/editedAt cập nhật đúng ảnh mới', async () => {
    const { db, a, room } = await makeDirectRoom();
    const { msg } = await makeBillMessage(db, a.id, room.id);
    const newUpload = await saveAttachment(db, PNG_1PX, 'bill-ghep-moi.jpg', a.id);
    if (!newUpload.ok) throw new Error('setup thất bại');
    const newMetadataJson = JSON.stringify({ isBillImage: true, billAmount: 5_500_000, billImageHeightPx: 810, billFields: { tid: null } });

    const updated = await editMessage(db, msg.id, a.id, 'POS ... - 5.500.000đ', { newAttachmentId: newUpload.id, newMetadataJson });
    expect(updated.attachmentId).toBe(newUpload.id);
    expect(updated.metadataJson).toBe(newMetadataJson);
    expect(updated.body).toBe('POS ... - 5.500.000đ');
    expect(updated.editedAt).not.toBeNull();
  });

  it('tin nhắn KHÔNG phải kind IMAGE (vd TEXT) + billPatch → VALIDATION, KHÔNG đổi gì', async () => {
    const { db, a, room } = await makeDirectRoom();
    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'chỉ chữ' });
    const newUpload = await saveAttachment(db, PNG_1PX, 'x.jpg', a.id);
    if (!newUpload.ok) throw new Error('setup thất bại');
    await expectCode(
      editMessage(db, msg.id, a.id, 'sửa', { newAttachmentId: newUpload.id, newMetadataJson: JSON.stringify({ isBillImage: true, billAmount: 1000 }) }),
      'VALIDATION'
    );
  });

  it('tin ẢNH nhưng KHÔNG phải bill đã ghép (metadataJson thiếu isBillImage:true) → VALIDATION', async () => {
    const { db, a, room } = await makeDirectRoom();
    const uploaded = await saveAttachment(db, PNG_1PX, 'anh-thuong.jpg', a.id);
    if (!uploaded.ok) throw new Error('setup thất bại');
    const msg = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: uploaded.id });
    const newUpload = await saveAttachment(db, PNG_1PX, 'y.jpg', a.id);
    if (!newUpload.ok) throw new Error('setup thất bại');
    await expectCode(
      editMessage(db, msg.id, a.id, 'sửa', { newAttachmentId: newUpload.id, newMetadataJson: JSON.stringify({ isBillImage: true, billAmount: 1000 }) }),
      'VALIDATION'
    );
  });

  it('newMetadataJson thiếu billAmount hợp lệ (>0) → VALIDATION', async () => {
    const { db, a, room } = await makeDirectRoom();
    const { msg } = await makeBillMessage(db, a.id, room.id);
    const newUpload = await saveAttachment(db, PNG_1PX, 'z.jpg', a.id);
    if (!newUpload.ok) throw new Error('setup thất bại');
    await expectCode(
      editMessage(db, msg.id, a.id, 'sửa', { newAttachmentId: newUpload.id, newMetadataJson: JSON.stringify({ isBillImage: true, billAmount: 0 }) }),
      'VALIDATION'
    );
    await expectCode(
      editMessage(db, msg.id, a.id, 'sửa', { newAttachmentId: newUpload.id, newMetadataJson: JSON.stringify({ isBillImage: true }) }),
      'VALIDATION'
    );
  });

  it('newAttachmentId do NGƯỜI KHÁC upload → ATTACHMENT_NOT_OWNED, KHÔNG đổi tin nhắn gốc', async () => {
    const { db, a, b, room } = await makeDirectRoom();
    const { msg } = await makeBillMessage(db, a.id, room.id);
    const strangerUpload = await saveAttachment(db, PNG_1PX, 'cua-b.jpg', b.id);
    if (!strangerUpload.ok) throw new Error('setup thất bại');
    const newMetadataJson = JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billImageHeightPx: 800 });
    await expectCode(editMessage(db, msg.id, a.id, 'sửa', { newAttachmentId: strangerUpload.id, newMetadataJson }), 'ATTACHMENT_NOT_OWNED');
    const after = await db.chatMessage.findUnique({ where: { id: msg.id } });
    expect(after?.attachmentId).not.toBe(strangerUpload.id);
  });

  it('quá MESSAGE_EDIT_WINDOW_HOURS (1h) → EDIT_WINDOW_EXPIRED trước cả khi chạm billPatch', async () => {
    const { db, a, room } = await makeDirectRoom();
    const uploaded = await saveAttachment(db, PNG_1PX, 'bill.jpg', a.id);
    if (!uploaded.ok) throw new Error('setup thất bại');
    const oldDate = new Date(Date.now() - (MESSAGE_EDIT_WINDOW_HOURS + 1) * 60 * 60 * 1000);
    const oldMsg = await db.chatMessage.create({
      data: {
        roomId: room.id,
        senderId: a.id,
        kind: 'IMAGE',
        attachmentId: uploaded.id,
        metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1000, billImageHeightPx: 800 }),
        createdAt: oldDate
      }
    });
    const newUpload = await saveAttachment(db, PNG_1PX, 'moi.jpg', a.id);
    if (!newUpload.ok) throw new Error('setup thất bại');
    await expectCode(
      editMessage(db, oldMsg.id, a.id, 'sửa muộn', {
        newAttachmentId: newUpload.id,
        newMetadataJson: JSON.stringify({ isBillImage: true, billAmount: 2000, billImageHeightPx: 800 })
      }),
      'EDIT_WINDOW_EXPIRED'
    );
  });
});

// SIGMA (2/8, tính năng "Hoàn tiền" MỚI) — editMessage() billPatch EXTEND chấp nhận CẢ `isRefundImage:true`
// (tin nhắn xác nhận hoàn tiền, KHÔNG chỉ `isBillImage:true` cũ) — CÙNG cơ chế "Sửa" B112, xem comment hàm đó.
describe('chat-message-service — editMessage() với billPatch cho tin nhắn HOÀN TIỀN (isRefundImage)', () => {
  async function makeRefundMessage(db: ReturnType<typeof getBotDb>, senderId: number, roomId: string, replyToMessageId?: string) {
    const uploaded = await saveAttachment(db, PNG_1PX, 'hoan-tien.jpg', senderId);
    if (!uploaded.ok) throw new Error('setup thất bại');
    const metadataJson = JSON.stringify({ isRefundImage: true, refundAmount: 3_940_000 });
    const msg = await sendMessage(db, { roomId, senderId, kind: 'IMAGE', attachmentId: uploaded.id, body: 'Hoàn tiền 3.940.000đ', replyToMessageId, metadataJson });
    return { msg, uploaded };
  }

  // AUDIT-1 (3/8) — CẬP NHẬT sau khi vá bug bảo mật: SỬA tin hoàn tiền giờ CHẠY LẠI server re-OCR
  // (annotateRefundMetadataOnSave) như sendMessage — KHÔNG còn ghi verbatim metadataJson client (đó chính là
  // lỗ hổng #2c bị né qua đường Sửa). Stub OCR đọc ĐÚNG 4tr (khớp số khai) → verified, KHÔNG cờ refundUnverified.
  // Xem test riêng test/refund-edit-bypass-2c.test.ts cho ca bơm số lệch → refundUnverified=true.
  it('happy path — sửa tin hoàn tiền TRONG cửa sổ 1h → attachment/refundAmount mới + server re-OCR verified (khớp ảnh)', async () => {
    const { db, a, room } = await makeDirectRoom();
    const { msg } = await makeRefundMessage(db, a.id, room.id);
    const newUpload = await saveAttachment(db, PNG_1PX, 'hoan-tien-sua.jpg', a.id);
    if (!newUpload.ok) throw new Error('setup thất bại');
    const newMetadataJson = JSON.stringify({ isRefundImage: true, refundAmount: 4_000_000 });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true, lines: [{ text: 'VND 4000.000', score: 0.98 }] }) }));
    try {
      const updated = await editMessage(db, msg.id, a.id, 'Hoàn tiền 4.000.000đ', { newAttachmentId: newUpload.id, newMetadataJson });
      expect(updated.attachmentId).toBe(newUpload.id);
      expect(updated.editedAt).not.toBeNull();
      const meta = JSON.parse(updated.metadataJson!) as { refundAmount?: number; refundUnverified?: boolean; refundVerification?: { verified: boolean; ocrAmount: number | null } };
      expect(meta.refundAmount).toBe(4_000_000); // số khai mới được giữ...
      expect(meta.refundUnverified).not.toBe(true); // ...VÀ đã được server re-OCR xác nhận (khớp ảnh 4tr).
      expect(meta.refundVerification?.verified).toBe(true);
      expect(meta.refundVerification?.ocrAmount).toBe(4_000_000);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('newMetadataJson thiếu refundAmount hợp lệ (>0) → VALIDATION', async () => {
    const { db, a, room } = await makeDirectRoom();
    const { msg } = await makeRefundMessage(db, a.id, room.id);
    const newUpload = await saveAttachment(db, PNG_1PX, 'z.jpg', a.id);
    if (!newUpload.ok) throw new Error('setup thất bại');
    await expectCode(
      editMessage(db, msg.id, a.id, 'sửa', { newAttachmentId: newUpload.id, newMetadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 0 }) }),
      'VALIDATION'
    );
    await expectCode(
      editMessage(db, msg.id, a.id, 'sửa', { newAttachmentId: newUpload.id, newMetadataJson: JSON.stringify({ isRefundImage: true }) }),
      'VALIDATION'
    );
  });

  it('tin gốc là HOÀN TIỀN nhưng metadataJson MỚI đổi sang isBillImage (đổi loại tin qua đường Sửa) → VALIDATION, KHÔNG cho phép', async () => {
    const { db, a, room } = await makeDirectRoom();
    const { msg } = await makeRefundMessage(db, a.id, room.id);
    const newUpload = await saveAttachment(db, PNG_1PX, 'z.jpg', a.id);
    if (!newUpload.ok) throw new Error('setup thất bại');
    await expectCode(
      editMessage(db, msg.id, a.id, 'sửa', {
        newAttachmentId: newUpload.id,
        newMetadataJson: JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billImageHeightPx: 800 })
      }),
      'VALIDATION'
    );
  });

  it('tin gốc là BILL GỐC (isBillImage) nhưng metadataJson MỚI đổi sang isRefundImage → VALIDATION, KHÔNG cho phép (đối xứng chiều ngược lại)', async () => {
    const { db, a, room } = await makeDirectRoom();
    const uploaded = await saveAttachment(db, PNG_1PX, 'bill-goc.jpg', a.id);
    if (!uploaded.ok) throw new Error('setup thất bại');
    const msg = await sendMessage(db, {
      roomId: room.id,
      senderId: a.id,
      kind: 'IMAGE',
      attachmentId: uploaded.id,
      metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billImageHeightPx: 800 })
    });
    const newUpload = await saveAttachment(db, PNG_1PX, 'z.jpg', a.id);
    if (!newUpload.ok) throw new Error('setup thất bại');
    await expectCode(
      editMessage(db, msg.id, a.id, 'sửa', { newAttachmentId: newUpload.id, newMetadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 1_000_000 }) }),
      'VALIDATION'
    );
  });

  it('replyToMessageId (liên kết bill gốc) GIỮ NGUYÊN sau khi sửa — cơ chế quote-reply KHÔNG bị đổi qua "Sửa"', async () => {
    const { db, a, room } = await makeDirectRoom();
    const billUpload = await saveAttachment(db, PNG_1PX, 'bill.jpg', a.id);
    if (!billUpload.ok) throw new Error('setup thất bại');
    const bill = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'IMAGE', attachmentId: billUpload.id, metadataJson: JSON.stringify({ isBillImage: true, billAmount: 1_000_000, billImageHeightPx: 800 }) });
    const { msg } = await makeRefundMessage(db, a.id, room.id, bill.id);
    const newUpload = await saveAttachment(db, PNG_1PX, 'hoan-tien-sua.jpg', a.id);
    if (!newUpload.ok) throw new Error('setup thất bại');
    const updated = await editMessage(db, msg.id, a.id, 'sửa', {
      newAttachmentId: newUpload.id,
      newMetadataJson: JSON.stringify({ isRefundImage: true, refundAmount: 4_000_000 })
    });
    expect(updated.replyToMessageId).toBe(bill.id);
  });
});

describe('chat-message-service — markRead', () => {
  it('cập nhật ChatRoomMember.lastReadMessageId đúng', async () => {
    const { db, a, b, room } = await makeDirectRoom();
    const msg = await sendMessage(db, { roomId: room.id, senderId: b.id, kind: 'TEXT', body: 'đọc tôi' });
    await markRead(db, room.id, a.id, msg.id);
    const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: a.id } } });
    expect(member?.lastReadMessageId).toBe(msg.id);
  });

  it('người KHÔNG phải thành viên gọi markRead → NOT_MEMBER', async () => {
    const { db, room } = await makeDirectRoom();
    const stranger = await makeAgent();
    await expectCode(markRead(db, room.id, stranger.id, 'bat-ky-id'), 'NOT_MEMBER');
  });

  it('TICK "đã đọc" (5/8) — trả về createdAt của tin đã đọc (route dùng để phát read-receipt)', async () => {
    const { db, a, b, room } = await makeDirectRoom();
    const msg = await sendMessage(db, { roomId: room.id, senderId: b.id, kind: 'TEXT', body: 'đọc tôi' });
    const result = await markRead(db, room.id, a.id, msg.id);
    expect(result.createdAt).toBeInstanceOf(Date);
    expect(result.createdAt.getTime()).toBe(msg.createdAt.getTime());
  });
});

describe('chat-message-service — markAllRead (Admin Demo chốt 29/7, "tích chọn đã đọc tất cả")', () => {
  it('đánh dấu đã đọc CẢ 2 phòng cùng lúc, mỗi phòng trỏ đúng tin MỚI NHẤT của phòng đó', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const x = await makeAgent();
    const y = await makeAgent();
    await makeFriends(me.id, x.id);
    await makeFriends(me.id, y.id);
    const roomX = await findOrCreateDirectRoom(db, me.id, x.id);
    const roomY = await findOrCreateDirectRoom(db, me.id, y.id);
    const lastX = await sendMessage(db, { roomId: roomX.id, senderId: x.id, kind: 'TEXT', body: 'tin X' });
    await sendMessage(db, { roomId: roomY.id, senderId: y.id, kind: 'TEXT', body: 'tin Y1' });
    const lastY = await sendMessage(db, { roomId: roomY.id, senderId: y.id, kind: 'TEXT', body: 'tin Y2 mới nhất' });

    await markAllRead(db, me.id);

    const memberX = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: roomX.id, agentId: me.id } } });
    const memberY = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: roomY.id, agentId: me.id } } });
    expect(memberX?.lastReadMessageId).toBe(lastX.id);
    expect(memberY?.lastReadMessageId).toBe(lastY.id);
  });

  it('phòng chưa có tin nào → lastReadMessageId GIỮ NGUYÊN null, không lỗi', async () => {
    const { db, a, room } = await makeDirectRoom();
    await markAllRead(db, a.id);
    const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: a.id } } });
    expect(member?.lastReadMessageId).toBeNull();
  });

  it('agent không tham gia phòng nào → KHÔNG lỗi, no-op', async () => {
    const db = getBotDb();
    const lonely = await makeAgent();
    await expect(markAllRead(db, lonely.id)).resolves.toBeUndefined();
  });

  // FIX-PERF (4/8, regression cho bản gộp CROSS JOIN LATERAL) — tin MỚI NHẤT của phòng bị xóa mềm → phải trỏ
  // tới tin KẾ TIẾP chưa xóa (LATERAL lọc deleted_at IS NULL, GIỮ NGUYÊN hành vi findFirst cũ). Bảo vệ trước
  // rủi ro index (created_at DESC) vô tình trỏ tin đã xóa.
  it('tin mới nhất bị xóa mềm → markAllRead trỏ tới tin kế tiếp CHƯA xóa (không phải tin đã xóa)', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const x = await makeAgent();
    await makeFriends(me.id, x.id);
    const room = await findOrCreateDirectRoom(db, me.id, x.id);
    const older = await sendMessage(db, { roomId: room.id, senderId: x.id, kind: 'TEXT', body: 'tin cũ hơn' });
    const newest = await sendMessage(db, { roomId: room.id, senderId: x.id, kind: 'TEXT', body: 'tin mới nhất' });
    await deleteMessage(db, newest.id, x.id); // người gửi tự thu hồi tin mới nhất.

    await markAllRead(db, me.id);

    const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: me.id } } });
    expect(member?.lastReadMessageId).toBe(older.id); // KHÔNG phải newest.id (đã xóa).
  });

  // FIX-PERF (4/8) — bản gộp CHỈ động vào phòng agent ĐANG là thành viên hoạt động (left_at IS NULL). Phòng
  // agent đã RỜI không được đánh dấu (WHERE rm.left_at IS NULL trong cả SELECT LATERAL lẫn UPDATE).
  it('phòng agent ĐÃ RỜI (left_at) → markAllRead KHÔNG đụng tới', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const x = await makeAgent();
    await makeFriends(me.id, x.id);
    const room = await findOrCreateDirectRoom(db, me.id, x.id);
    await sendMessage(db, { roomId: room.id, senderId: x.id, kind: 'TEXT', body: 'tin' });
    await db.chatRoomMember.update({ where: { roomId_agentId: { roomId: room.id, agentId: me.id } }, data: { leftAt: new Date() } });

    await markAllRead(db, me.id);

    const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: me.id } } });
    expect(member?.lastReadMessageId).toBeNull(); // đã rời → không đánh dấu.
  });
});

// FIX-PERF (4/8) — HỢP ĐỒNG cursor `before` của listMessages: PHẢI là id tin nhắn (không phải timestamp). Bug
// thật ConversationScreen.tsx truyền `oldest.sentAtIso` (ISO string) → server không tìm thấy id → LUÔN throw →
// tải tin cũ HỎNG. Test này khóa hợp đồng: id hợp lệ hoạt động; chuỗi KHÔNG-phải-id (vd ISO timestamp) throw.
describe('chat-message-service — listMessages cursor `before` PHẢI là message id (FIX-PERF regression)', () => {
  it('before = id tin nhắn thật → tải trang tin CŨ hơn, KHÔNG throw', async () => {
    const { db, a, room } = await makeDirectRoom();
    const m1 = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'tin 1 (cũ nhất)' });
    await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'tin 2' });
    const m3 = await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'tin 3 (mới nhất)' });
    // before = id tin mới nhất → chỉ trả tin cũ hơn nó (m2, m1), KHÔNG gồm chính m3.
    const older = await listMessages(db, room.id, a.id, { before: m3.id, limit: 50 });
    const ids = older.messages.map((m) => m.id);
    expect(ids).not.toContain(m3.id);
    expect(ids).toContain(m1.id);
  });

  it('before = chuỗi KHÔNG phải id (vd ISO timestamp) → throw VALIDATION (chứng minh vì sao FE phải truyền oldest.id)', async () => {
    const { db, a, room } = await makeDirectRoom();
    await sendMessage(db, { roomId: room.id, senderId: a.id, kind: 'TEXT', body: 'tin' });
    await expectCode(listMessages(db, room.id, a.id, { before: new Date().toISOString(), limit: 50 }), 'VALIDATION');
  });
});
