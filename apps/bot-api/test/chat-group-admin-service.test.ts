// SIGMA "nhóm chat đầy đủ như Zalo" (5/8) — regression cho 5 tính năng quản trị nhóm bổ sung ở
// chat-room-service.ts: (1) GHIM NHIỀU / "Bảng tin" (PinnedMessage), (2) DUYỆT thành viên (ChatRoomJoinRequest),
// (3) GIỚI HẠN số thành viên (maxMembers), (4) AVATAR nhóm (BLOB), (5) thăng/giáng/chuyển OWNER (changeMemberRole).
// Gọi THẲNG hàm service trên throwaway DB (global-setup.ts đã migrate deploy 20260805150000_chat_group_admin),
// CÙNG khuôn chat-room-service.test.ts.
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeFriends } from './fixtures.js';
import {
  ChatServiceError,
  addMember,
  approveJoin,
  changeMemberRole,
  createGroupRoom,
  findOrCreateDirectRoom,
  getRoomAvatar,
  listPendingJoinRequests,
  listPinnedMessages,
  pinMessage,
  rejectJoin,
  requestJoin,
  saveRoomAvatar,
  unpinMessage,
  updateGroupSettings
} from '../src/services/chat-room-service.js';
import { sendMessage } from '../src/services/chat-message-service.js';

// PNG 1x1 THẬT ĐẦY ĐỦ (signature + IHDR + IDAT + IEND) — CÙNG buffer chat-attachment-service.test.ts.
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const PLAIN_TEXT_AS_JPG = Buffer.from('day chi la mot file .txt gia mao doi ten thanh .jpg, khong phai anh that', 'utf8');

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ChatServiceError code=${code} nhưng KHÔNG throw.`);
  } catch (err) {
    expect(err).toBeInstanceOf(ChatServiceError);
    expect((err as ChatServiceError).code).toBe(code);
  }
}

/** Tạo 1 nhóm hợp lệ (creator OWNER + 2 MEMBER) — trả owner + room + 2 member. */
async function makeGroup() {
  const db = getBotDb();
  const owner = await makeAgent();
  const m1 = await makeAgent();
  const m2 = await makeAgent();
  await makeFriends(owner.id, m1.id);
  await makeFriends(owner.id, m2.id);
  const room = await createGroupRoom(db, owner.id, 'Nhóm QA', [m1.id, m2.id]);
  return { owner, m1, m2, room };
}

async function makeMsg(roomId: string, senderId: number, body: string): Promise<string> {
  const db = getBotDb();
  const msg = await sendMessage(db, { roomId, senderId, kind: 'TEXT', body });
  return msg.id;
}

// ── 1. GHIM NHIỀU / "Bảng tin" ──────────────────────────────────────────────────────────────────────────────
describe('chat-group-admin — GHIM NHIỀU / Bảng tin', () => {
  it('ghim 3 tin → listPinnedMessages trả 3, MỚI NHẤT trước, pinnedMessageId = tin ghim cuối', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup();
    const a = await makeMsg(room.id, owner.id, 'tin A');
    const b = await makeMsg(room.id, owner.id, 'tin B');
    const c = await makeMsg(room.id, owner.id, 'tin C');
    await pinMessage(db, room.id, owner.id, a);
    await new Promise((r) => setTimeout(r, 5));
    await pinMessage(db, room.id, owner.id, b);
    await new Promise((r) => setTimeout(r, 5));
    await pinMessage(db, room.id, owner.id, c);

    const pins = await listPinnedMessages(db, room.id, owner.id);
    expect(pins.length).toBe(3);
    expect(pins.map((p) => p.messageId)).toEqual([c, b, a]); // pinnedAt desc
    expect(pins[0].message?.body).toBe('tin C');
    expect(pins[0].pinnedByAgentId).toBe(owner.id);
    const roomRow = await db.chatRoom.findUnique({ where: { id: room.id } });
    expect(roomRow!.pinnedMessageId).toBe(c);
  });

  it('ghim CÙNG 1 tin 2 lần → idempotent (1 hàng, KHÔNG dời pinnedAt/pinnedBy gốc)', async () => {
    const db = getBotDb();
    const { owner, m1, room } = await makeGroup();
    await changeMemberRole(db, room.id, owner.id, m1.id, 'ADMIN'); // để ghim bằng người khác lần 2
    const a = await makeMsg(room.id, owner.id, 'tin A');
    await pinMessage(db, room.id, owner.id, a);
    const first = await db.pinnedMessage.findFirst({ where: { roomId: room.id, messageId: a } });
    await new Promise((r) => setTimeout(r, 5));
    await pinMessage(db, room.id, m1.id, a); // ADMIN ghim lại
    const rows = await db.pinnedMessage.findMany({ where: { roomId: room.id, messageId: a } });
    expect(rows.length).toBe(1);
    expect(rows[0].pinnedByAgentId).toBe(owner.id); // giữ người ghim gốc
    expect(rows[0].pinnedAt.getTime()).toBe(first!.pinnedAt.getTime()); // KHÔNG dời
  });

  it('MEMBER thường KHÔNG ghim được → FORBIDDEN_ROLE; ADMIN thì được', async () => {
    const db = getBotDb();
    const { owner, m1, m2, room } = await makeGroup();
    const a = await makeMsg(room.id, owner.id, 'x');
    await expectCode(pinMessage(db, room.id, m1.id, a), 'FORBIDDEN_ROLE');
    await changeMemberRole(db, room.id, owner.id, m2.id, 'ADMIN');
    await pinMessage(db, room.id, m2.id, a); // không throw
    const pins = await listPinnedMessages(db, room.id, m2.id);
    expect(pins.length).toBe(1);
  });

  it('gỡ ghim 1 tin cụ thể → còn lại, pinnedMessageId lùi về tin còn lại mới nhất', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup();
    const a = await makeMsg(room.id, owner.id, 'A');
    const b = await makeMsg(room.id, owner.id, 'B');
    await pinMessage(db, room.id, owner.id, a);
    await new Promise((r) => setTimeout(r, 5));
    await pinMessage(db, room.id, owner.id, b);
    await unpinMessage(db, room.id, owner.id, b); // gỡ đúng b
    const pins = await listPinnedMessages(db, room.id, owner.id);
    expect(pins.map((p) => p.messageId)).toEqual([a]);
    const roomRow = await db.chatRoom.findUnique({ where: { id: room.id } });
    expect(roomRow!.pinnedMessageId).toBe(a);
  });

  it('gỡ ghim KHÔNG messageId → gỡ TẤT CẢ, pinnedMessageId=null (tương thích DELETE /pin cũ)', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup();
    const a = await makeMsg(room.id, owner.id, 'A');
    const b = await makeMsg(room.id, owner.id, 'B');
    await pinMessage(db, room.id, owner.id, a);
    await pinMessage(db, room.id, owner.id, b);
    await unpinMessage(db, room.id, owner.id); // không messageId → clear all
    const pins = await listPinnedMessages(db, room.id, owner.id);
    expect(pins.length).toBe(0);
    const roomRow = await db.chatRoom.findUnique({ where: { id: room.id } });
    expect(roomRow!.pinnedMessageId).toBeNull();
  });

  it('ghim tin của phòng KHÁC / tin đã xóa mềm → NOT_FOUND', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup();
    const other = await makeGroup();
    const foreignMsg = await makeMsg(other.room.id, other.owner.id, 'thuộc phòng khác');
    await expectCode(pinMessage(db, room.id, owner.id, foreignMsg), 'NOT_FOUND');

    const mine = await makeMsg(room.id, owner.id, 'sẽ xóa');
    await db.chatMessage.update({ where: { id: mine }, data: { deletedAt: new Date() } });
    await expectCode(pinMessage(db, room.id, owner.id, mine), 'NOT_FOUND');
  });

  it('tin bị thu hồi SAU khi ghim → vẫn trong danh sách nhưng message=null', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup();
    const a = await makeMsg(room.id, owner.id, 'A');
    await pinMessage(db, room.id, owner.id, a);
    await db.chatMessage.update({ where: { id: a }, data: { deletedAt: new Date() } });
    const pins = await listPinnedMessages(db, room.id, owner.id);
    expect(pins.length).toBe(1);
    expect(pins[0].message).toBeNull();
  });

  it('người ngoài phòng xem Bảng tin → NOT_MEMBER', async () => {
    const db = getBotDb();
    const { room } = await makeGroup();
    const stranger = await makeAgent();
    await expectCode(listPinnedMessages(db, room.id, stranger.id), 'NOT_MEMBER');
  });
});

// ── 2. DUYỆT THÀNH VIÊN ────────────────────────────────────────────────────────────────────────────────────
describe('chat-group-admin — DUYỆT thành viên', () => {
  it('requireApproval=false → requestJoin vào THẲNG (JOINED)', async () => {
    const db = getBotDb();
    const { room } = await makeGroup();
    const newcomer = await makeAgent();
    const result = await requestJoin(db, room.id, newcomer.id);
    expect(result.status).toBe('JOINED');
    const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: newcomer.id } } });
    expect(member?.leftAt).toBeNull();
  });

  it('requireApproval=true → requestJoin tạo PENDING; OWNER thấy trong listPending; approve → thành viên', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup();
    await updateGroupSettings(db, room.id, owner.id, { requireApproval: true });
    const newcomer = await makeAgent();

    const result = await requestJoin(db, room.id, newcomer.id);
    expect(result.status).toBe('PENDING');
    const pending = await listPendingJoinRequests(db, room.id, owner.id);
    expect(pending.map((p) => p.agentId)).toContain(newcomer.id);

    const member = await approveJoin(db, room.id, owner.id, newcomer.id);
    expect(member.agentId).toBe(newcomer.id);
    const req = await db.chatRoomJoinRequest.findFirst({ where: { roomId: room.id, agentId: newcomer.id } });
    expect(req?.status).toBe('APPROVED');
    expect(req?.decidedBy).toBe(owner.id);
    // Không còn PENDING nào.
    expect((await listPendingJoinRequests(db, room.id, owner.id)).length).toBe(0);
  });

  it('MEMBER thường KHÔNG được duyệt/từ chối/xem danh sách chờ → FORBIDDEN_ROLE', async () => {
    const db = getBotDb();
    const { owner, m1, room } = await makeGroup();
    await updateGroupSettings(db, room.id, owner.id, { requireApproval: true });
    const newcomer = await makeAgent();
    await requestJoin(db, room.id, newcomer.id);
    await expectCode(listPendingJoinRequests(db, room.id, m1.id), 'FORBIDDEN_ROLE');
    await expectCode(approveJoin(db, room.id, m1.id, newcomer.id), 'FORBIDDEN_ROLE');
    await expectCode(rejectJoin(db, room.id, m1.id, newcomer.id), 'FORBIDDEN_ROLE');
  });

  it('rejectJoin → REJECTED; sau đó xin LẠI được (partial-unique chỉ chặn PENDING)', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup();
    await updateGroupSettings(db, room.id, owner.id, { requireApproval: true });
    const newcomer = await makeAgent();
    await requestJoin(db, room.id, newcomer.id);
    await rejectJoin(db, room.id, owner.id, newcomer.id);
    expect((await listPendingJoinRequests(db, room.id, owner.id)).length).toBe(0);
    // xin lại
    const again = await requestJoin(db, room.id, newcomer.id);
    expect(again.status).toBe('PENDING');
    const rows = await db.chatRoomJoinRequest.findMany({ where: { roomId: room.id, agentId: newcomer.id } });
    expect(rows.length).toBe(2); // 1 REJECTED (lịch sử) + 1 PENDING mới
  });

  it('requestJoin 2 lần khi cần duyệt → idempotent (đúng 1 PENDING)', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup();
    await updateGroupSettings(db, room.id, owner.id, { requireApproval: true });
    const newcomer = await makeAgent();
    const r1 = await requestJoin(db, room.id, newcomer.id);
    const r2 = await requestJoin(db, room.id, newcomer.id);
    expect(r1.status).toBe('PENDING');
    expect(r2.status).toBe('PENDING');
    const pending = await db.chatRoomJoinRequest.findMany({ where: { roomId: room.id, agentId: newcomer.id, status: 'PENDING' } });
    expect(pending.length).toBe(1);
  });

  it('requestJoin khi ĐÃ là thành viên → ALREADY_MEMBER', async () => {
    const db = getBotDb();
    const { m1, room } = await makeGroup();
    await expectCode(requestJoin(db, room.id, m1.id), 'ALREADY_MEMBER');
  });

  it('requestJoin vào phòng DIRECT → VALIDATION', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await makeFriends(a.id, b.id);
    const direct = await findOrCreateDirectRoom(db, a.id, b.id);
    const c = await makeAgent();
    await expectCode(requestJoin(db, direct.id, c.id), 'VALIDATION');
  });

  it('approveJoin khi KHÔNG có yêu cầu PENDING → JOIN_REQUEST_NOT_FOUND', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup();
    const stranger = await makeAgent();
    await expectCode(approveJoin(db, room.id, owner.id, stranger.id), 'JOIN_REQUEST_NOT_FOUND');
  });
});

// ── 3. GIỚI HẠN SỐ THÀNH VIÊN ──────────────────────────────────────────────────────────────────────────────
describe('chat-group-admin — GIỚI HẠN số thành viên (maxMembers)', () => {
  it('addMember vượt trần → ROOM_FULL (thông báo tiếng Việt)', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup(); // đang 3 người
    await updateGroupSettings(db, room.id, owner.id, { maxMembers: 3 });
    const extra = await makeAgent();
    await makeFriends(owner.id, extra.id);
    await expectCode(addMember(db, room.id, owner.id, extra.id), 'ROOM_FULL');
  });

  it('approveJoin vượt trần → ROOM_FULL', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup(); // 3 người
    await updateGroupSettings(db, room.id, owner.id, { maxMembers: 3, requireApproval: true });
    const newcomer = await makeAgent();
    await requestJoin(db, room.id, newcomer.id);
    await expectCode(approveJoin(db, room.id, owner.id, newcomer.id), 'ROOM_FULL');
  });

  it('requestJoin (vào thẳng) vượt trần → ROOM_FULL', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup();
    await updateGroupSettings(db, room.id, owner.id, { maxMembers: 3 });
    const newcomer = await makeAgent();
    await expectCode(requestJoin(db, room.id, newcomer.id), 'ROOM_FULL');
  });

  it('idempotent add của thành viên SẴN CÓ khi đã đầy → KHÔNG lỗi', async () => {
    const db = getBotDb();
    const { owner, m1, room } = await makeGroup();
    await updateGroupSettings(db, room.id, owner.id, { maxMembers: 3 });
    // m1 đã là thành viên — add lại không tăng số, không lỗi.
    const r = await addMember(db, room.id, owner.id, m1.id);
    expect(r.agentId).toBe(m1.id);
  });

  it('đặt maxMembers NHỎ HƠN số thành viên hiện tại → VALIDATION', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup(); // 3 người
    await expectCode(updateGroupSettings(db, room.id, owner.id, { maxMembers: 2 }), 'VALIDATION');
  });

  it('tái kích hoạt người ĐÃ rời cũng bị tính trần', async () => {
    const db = getBotDb();
    const { owner, m1, room } = await makeGroup();
    // m1 rời → còn 2 người; đặt trần = 2.
    await db.chatRoomMember.update({ where: { roomId_agentId: { roomId: room.id, agentId: m1.id } }, data: { leftAt: new Date() } });
    await updateGroupSettings(db, room.id, owner.id, { maxMembers: 2 });
    // owner & m1 vẫn là bạn (makeGroup đã kết bạn) — tình bạn KHÔNG mất khi rời phòng. Tái kích hoạt m1 (quay
    // lại chiếm 1 chỗ) khi phòng đã đủ 2/2 → ROOM_FULL.
    await expectCode(addMember(db, room.id, owner.id, m1.id), 'ROOM_FULL');
  });

  it('maxMembers=null (bỏ giới hạn) → thêm thoải mái', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup();
    await updateGroupSettings(db, room.id, owner.id, { maxMembers: 3 });
    await updateGroupSettings(db, room.id, owner.id, { maxMembers: null });
    const extra = await makeAgent();
    await makeFriends(owner.id, extra.id);
    const r = await addMember(db, room.id, owner.id, extra.id);
    expect(r.agentId).toBe(extra.id);
  });
});

// ── 4. AVATAR NHÓM ─────────────────────────────────────────────────────────────────────────────────────────
describe('chat-group-admin — AVATAR nhóm', () => {
  it('OWNER upload PNG hợp lệ → lưu BLOB + avatarUrl trỏ endpoint; getRoomAvatar trả đúng buffer', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup();
    const r = await saveRoomAvatar(db, room.id, owner.id, PNG_1PX);
    expect(r.ok).toBe(true);
    const roomRow = await db.chatRoom.findUnique({ where: { id: room.id } });
    expect(roomRow!.avatarImageMime).toBe('image/png');
    expect(roomRow!.avatarUrl).toBe(`/v1/chat/rooms/${room.id}/avatar`);
    const media = await getRoomAvatar(db, room.id, owner.id);
    expect(media).not.toBeNull();
    expect(Buffer.compare(media!.buffer, PNG_1PX)).toBe(0);
    expect(media!.mimeType).toBe('image/png');
  });

  it('MEMBER thường upload → FORBIDDEN_ROLE', async () => {
    const db = getBotDb();
    const { m1, room } = await makeGroup();
    await expectCode(saveRoomAvatar(db, room.id, m1.id, PNG_1PX), 'FORBIDDEN_ROLE');
  });

  it('file giả mạo (text đổi đuôi) → {ok:false, MIME_NOT_ALLOWED}', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup();
    const r = await saveRoomAvatar(db, room.id, owner.id, PLAIN_TEXT_AS_JPG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('MIME_NOT_ALLOWED');
  });

  it('phòng DIRECT không đặt được avatar nhóm — thành viên DIRECT luôn role MEMBER nên chặn ở FORBIDDEN_ROLE', async () => {
    // saveRoomAvatar gọi assertOwnerOrAdmin TRƯỚC (CÙNG thứ tự updateGroupSettings) — phòng DIRECT không có
    // OWNER/ADMIN nên FORBIDDEN_ROLE chặn trước cả guard "chỉ GROUP" (guard GROUP là phòng thủ tầng 2). Kết quả
    // thực tế: DIRECT không thể đặt avatar nhóm — đúng ý định.
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await makeFriends(a.id, b.id);
    const direct = await findOrCreateDirectRoom(db, a.id, b.id);
    await expectCode(saveRoomAvatar(db, direct.id, a.id, PNG_1PX), 'FORBIDDEN_ROLE');
  });

  it('getRoomAvatar cho người ngoài phòng → NOT_MEMBER; chưa đặt ảnh → null', async () => {
    const db = getBotDb();
    const { owner, room } = await makeGroup();
    const stranger = await makeAgent();
    await expectCode(getRoomAvatar(db, room.id, stranger.id), 'NOT_MEMBER');
    expect(await getRoomAvatar(db, room.id, owner.id)).toBeNull(); // chưa upload
  });
});

// ── 5. THĂNG / GIÁNG / CHUYỂN OWNER (đã có changeMemberRole — regression xác nhận hoạt động) ──────────────────
describe('chat-group-admin — thăng/giáng/chuyển OWNER', () => {
  it('OWNER thăng MEMBER → ADMIN rồi giáng lại MEMBER', async () => {
    const db = getBotDb();
    const { owner, m1, room } = await makeGroup();
    const up = await changeMemberRole(db, room.id, owner.id, m1.id, 'ADMIN');
    expect(up.role).toBe('ADMIN');
    const down = await changeMemberRole(db, room.id, owner.id, m1.id, 'MEMBER');
    expect(down.role).toBe('MEMBER');
  });

  it('OWNER chuyển quyền (set OWNER cho người khác) → requester tự hạ ADMIN, phòng đúng 1 OWNER', async () => {
    const db = getBotDb();
    const { owner, m1, room } = await makeGroup();
    await changeMemberRole(db, room.id, owner.id, m1.id, 'OWNER');
    const members = await db.chatRoomMember.findMany({ where: { roomId: room.id, leftAt: null } });
    const byId = new Map(members.map((mm) => [mm.agentId, mm.role]));
    expect(byId.get(m1.id)).toBe('OWNER');
    expect(byId.get(owner.id)).toBe('ADMIN');
    expect(members.filter((mm) => mm.role === 'OWNER').length).toBe(1);
  });

  it('ADMIN KHÔNG được tự phong OWNER → FORBIDDEN_ROLE', async () => {
    const db = getBotDb();
    const { owner, m1, m2, room } = await makeGroup();
    await changeMemberRole(db, room.id, owner.id, m1.id, 'ADMIN');
    await expectCode(changeMemberRole(db, room.id, m1.id, m2.id, 'OWNER'), 'FORBIDDEN_ROLE');
  });
});
