// SIGMA Phase 2 (29/7) — regression cho chat-room-service.ts (Phần service, KHÔNG qua HTTP — routes/chat.ts
// thuộc Agent B, xem BUGS_FIXED.md/kế hoạch chat lõi). Gọi thẳng hàm service trên throwaway DB (global-setup.ts
// đã `prisma migrate deploy` migration `20260729100000_chat_core`), CÙNG khuôn chat-attachment-service.test.ts.
//
// LƯU Ý (29/7, Admin Demo chốt "phải thêm thành viên thứ 3 mới được coi là nhóm chat"): createGroupRoom() giờ đòi
// TỐI THIỂU 2 thành viên KHÁC creator (tổng >=3 người) — mọi test dưới đây tạo nhóm CHỈ để làm fixture cho hành
// vi khác (role/pin/transfer...) đều có thêm 1 thành viên "filler" (kết bạn sẵn, không tham gia hành vi được
// test) để hợp lệ tạo phòng, KHÔNG đổi ý nghĩa test gốc.
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { makeAgent, makeFriends, makeChatRoom, makeChatRoomMember, makeCustomer, makeCustomerChatGroup } from './fixtures.js';
import {
  ChatServiceError,
  addMember,
  assertActiveMember,
  autoTransferOwnershipOnDeletion,
  changeMemberRole,
  countUnreadForRoomMember,
  createGroupRoom,
  findOrCreateDirectRoom,
  getRoomDetail,
  listRoomsForAgent,
  pinMessage,
  removeMember,
  requestJoin,
  unpinMessage,
  updateGroupSettings
} from '../src/services/chat-room-service.js';
import { markRead, sendMessage } from '../src/services/chat-message-service.js';

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
    throw new Error(`Expected ChatServiceError code=${code} nhưng KHÔNG throw.`);
  } catch (err) {
    expect(err).toBeInstanceOf(ChatServiceError);
    expect((err as ChatServiceError).code).toBe(code);
  }
}

describe('chat-room-service — findOrCreateDirectRoom', () => {
  it('2 agent là bạn bè → tạo phòng DIRECT mới, 2 thành viên role MEMBER, directPairKey chuẩn hoá min-max', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await makeFriends(a.id, b.id);

    const room = await findOrCreateDirectRoom(db, a.id, b.id);
    expect(room.type).toBe('DIRECT');
    expect(room.directPairKey).toBe(`${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`);
    expect(room.members.map((m) => m.agentId).sort()).toEqual([a.id, b.id].sort());
    expect(room.members.every((m) => m.role === 'MEMBER')).toBe(true);
  });

  it('gọi lại (kể cả đảo chiều a/b) → trả VỀ ĐÚNG 1 phòng đã tạo, KHÔNG tạo phòng trùng', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await makeFriends(a.id, b.id);

    const room1 = await findOrCreateDirectRoom(db, a.id, b.id);
    const room2 = await findOrCreateDirectRoom(db, b.id, a.id); // đảo chiều tham số
    expect(room2.id).toBe(room1.id);

    const count = await db.chatRoom.count({ where: { type: 'DIRECT', directPairKey: room1.directPairKey! } });
    expect(count).toBe(1);
  });

  it('CHƯA là bạn bè → throw CANNOT_MESSAGE, KHÔNG tạo phòng nào cho ĐÚNG cặp này', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await expectCode(findOrCreateDirectRoom(db, a.id, b.id), 'CANNOT_MESSAGE');
    // Đếm SCOPE theo đúng directPairKey của cặp a/b (KHÔNG đếm toàn bộ bảng chat_rooms — các test khác trong
    // CÙNG file chạy tuần tự trên CÙNG 1 throwaway DB, đã có thể tạo DIRECT room khác từ trước, đếm toàn cục sẽ
    // dương tính giả).
    const pairKey = `${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`;
    const count = await db.chatRoom.count({ where: { type: 'DIRECT', directPairKey: pairKey } });
    expect(count).toBe(0);
  });

  it('là bạn bè nhưng A đã chặn B → throw CANNOT_MESSAGE', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await db.friendRequest.create({ data: { fromAgentId: a.id, toAgentId: b.id, status: 'ACCEPTED', acceptedAt: new Date(), blockedByFrom: true } });
    await expectCode(findOrCreateDirectRoom(db, a.id, b.id), 'CANNOT_MESSAGE');
  });

  it('tự tạo phòng với chính mình → VALIDATION', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    await expectCode(findOrCreateDirectRoom(db, a.id, a.id), 'VALIDATION');
  });
});

describe('chat-room-service — createGroupRoom', () => {
  it('happy path — creator tự động OWNER, thành viên khác MEMBER', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const m1 = await makeAgent();
    const m2 = await makeAgent();
    await makeFriends(creator.id, m1.id);
    await makeFriends(creator.id, m2.id);
    const room = await createGroupRoom(db, creator.id, '  Nhóm Test  ', [m1.id, m2.id]);
    expect(room.type).toBe('GROUP');
    expect(room.name).toBe('Nhóm Test'); // đã trim
    const byAgent = new Map(room.members.map((m) => [m.agentId, m.role]));
    expect(byAgent.get(creator.id)).toBe('OWNER');
    expect(byAgent.get(m1.id)).toBe('MEMBER');
    expect(byAgent.get(m2.id)).toBe('MEMBER');
    expect(room.members.length).toBe(3);
  });

  it('memberAgentIds chứa creator (trùng) → KHÔNG tạo 2 hàng thành viên cho creator', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const m1 = await makeAgent();
    const m2 = await makeAgent();
    await makeFriends(creator.id, m1.id);
    await makeFriends(creator.id, m2.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [creator.id, m1.id, m2.id]);
    expect(room.members.length).toBe(3); // creator + m1 + m2 — creator KHÔNG bị đếm 2 lần dù gửi trùng trong input.
  });

  it('tên rỗng (sau trim) → VALIDATION', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const m1 = await makeAgent();
    await makeFriends(creator.id, m1.id);
    await expectCode(createGroupRoom(db, creator.id, '   ', [m1.id]), 'VALIDATION');
  });

  it('memberAgentIds rỗng → VALIDATION', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    await expectCode(createGroupRoom(db, creator.id, 'Nhóm', []), 'VALIDATION');
  });

  it('Admin Demo chốt 29/7 "phải thêm thành viên thứ 3 mới được coi là nhóm chat" — CHỈ 1 thành viên khác (tổng 2 người) → VALIDATION, không tạo phòng', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const m1 = await makeAgent();
    await makeFriends(creator.id, m1.id);
    await expectCode(createGroupRoom(db, creator.id, 'Nhóm', [m1.id]), 'VALIDATION');
    const count = await db.chatRoom.count({ where: { type: 'GROUP', createdBy: creator.id } });
    expect(count).toBe(0);
  });

  it('audit độc lập 29/7 / Admin Demo chốt 29/7 — mời agent ĐÃ CHẶN mình vào nhóm → CANNOT_MESSAGE, KHÔNG tạo phòng', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const blocked = await makeAgent();
    const friendOk = await makeAgent();
    await db.friendRequest.create({ data: { fromAgentId: creator.id, toAgentId: blocked.id, status: 'ACCEPTED', acceptedAt: new Date(), blockedByTo: true } });
    await makeFriends(creator.id, friendOk.id);
    await expectCode(createGroupRoom(db, creator.id, 'Nhóm', [blocked.id, friendOk.id]), 'CANNOT_MESSAGE');
    const count = await db.chatRoom.count({ where: { type: 'GROUP', createdBy: creator.id } });
    expect(count).toBe(0);
  });
});

describe('chat-room-service — assertActiveMember', () => {
  it('không phải thành viên → NOT_MEMBER', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const stranger = await makeAgent();
    const other = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, other.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [other.id, filler.id]);
    await expectCode(assertActiveMember(db, room.id, stranger.id), 'NOT_MEMBER');
  });

  it('đã rời phòng (leftAt set) → NOT_MEMBER', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const m1 = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, m1.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [m1.id, filler.id]);
    await removeMember(db, room.id, m1.id, m1.id); // tự rời
    await expectCode(assertActiveMember(db, room.id, m1.id), 'NOT_MEMBER');
  });

  it('thành viên đang hoạt động → trả về row, KHÔNG throw', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const other = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, other.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [other.id, filler.id]);
    const member = await assertActiveMember(db, room.id, creator.id);
    expect(member.agentId).toBe(creator.id);
    expect(member.role).toBe('OWNER');
  });
});

describe('chat-room-service — getRoomDetail', () => {
  it('người ngoài phòng gọi → NOT_MEMBER', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const stranger = await makeAgent();
    const other = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, other.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [other.id, filler.id]);
    await expectCode(getRoomDetail(db, room.id, stranger.id), 'NOT_MEMBER');
  });

  it('thành viên gọi → trả đủ danh sách members', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const m1 = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, m1.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [m1.id, filler.id]);
    const detail = await getRoomDetail(db, room.id, m1.id);
    expect(detail.id).toBe(room.id);
    expect(detail.members.length).toBe(3);
  });
});

describe('chat-room-service — quản trị phòng: addMember/removeMember/changeMemberRole/pin', () => {
  // #29 (Admin Demo 8/8 "thêm mem thì AI CŨNG thêm được") — nới quyền addMember: MEMBER thường ĐƯỢC thêm (không còn
  // owner-only/FORBIDDEN_ROLE), NHƯNG vẫn giữ gate bạn-bè (canMessageAgent). Test cũ kỳ vọng FORBIDDEN_ROLE là
  // theo chính sách CŨ — đã lỗi thời sau #29 (drift cleared_at che test này bấy lâu, R198). Cập nhật khớp policy.
  it('MEMBER thường ĐƯỢC addMember (policy #29) — thêm BẠN của mình thành công; thêm người LẠ → CANNOT_MESSAGE', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const plainMember = await makeAgent();
    const filler = await makeAgent();
    const friendOfMember = await makeAgent();
    const stranger = await makeAgent();
    await makeFriends(creator.id, plainMember.id);
    await makeFriends(creator.id, filler.id);
    await makeFriends(plainMember.id, friendOfMember.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [plainMember.id, filler.id]);
    // MEMBER thường thêm BẠN của mình → THÀNH CÔNG (chính sách nới quyền, không còn FORBIDDEN_ROLE).
    const added = await addMember(db, room.id, plainMember.id, friendOfMember.id);
    expect(added).toBeTruthy();
    // Nhưng vẫn CHẶN thêm người LẠ (chưa là bạn/đã chặn) → CANNOT_MESSAGE (giữ gate bạn-bè).
    await expectCode(addMember(db, room.id, plainMember.id, stranger.id), 'CANNOT_MESSAGE');
  });

  it('OWNER addMember thành công → thành viên mới role MEMBER; addMember lại (đã là thành viên) → idempotent', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const newGuy = await makeAgent();
    const other = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, other.id);
    await makeFriends(creator.id, filler.id);
    await makeFriends(creator.id, newGuy.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [other.id, filler.id]);
    const added = await addMember(db, room.id, creator.id, newGuy.id);
    expect(added.role).toBe('MEMBER');
    const addedAgain = await addMember(db, room.id, creator.id, newGuy.id);
    expect(addedAgain.agentId).toBe(newGuy.id);
    const count = await db.chatRoomMember.count({ where: { roomId: room.id, agentId: newGuy.id } });
    expect(count).toBe(1); // KHÔNG tạo hàng trùng.
  });

  it('addMember cho agent ĐÃ rời trước đó → tái kích hoạt (clear leftAt), KHÔNG tạo hàng mới', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const m1 = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, m1.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [m1.id, filler.id]);
    await removeMember(db, room.id, creator.id, m1.id);
    await addMember(db, room.id, creator.id, m1.id);
    const row = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: m1.id } } });
    expect(row?.leftAt).toBeNull();
    const count = await db.chatRoomMember.count({ where: { roomId: room.id, agentId: m1.id } });
    expect(count).toBe(1);
  });

  it('Admin Demo chốt 29/7 — addMember agent ĐÃ CHẶN nhau → CANNOT_MESSAGE, KHÔNG thêm được', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const other = await makeAgent();
    const filler = await makeAgent();
    const blocked = await makeAgent();
    await makeFriends(creator.id, other.id);
    await makeFriends(creator.id, filler.id);
    await db.friendRequest.create({ data: { fromAgentId: creator.id, toAgentId: blocked.id, status: 'ACCEPTED', acceptedAt: new Date(), blockedByFrom: true } });
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [other.id, filler.id]);
    await expectCode(addMember(db, room.id, creator.id, blocked.id), 'CANNOT_MESSAGE');
  });

  it('tự rời phòng (removeMember target=self) KHÔNG cần quyền OWNER/ADMIN', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const plainMember = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, plainMember.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [plainMember.id, filler.id]);
    await removeMember(db, room.id, plainMember.id, plainMember.id);
    await expectCode(assertActiveMember(db, room.id, plainMember.id), 'NOT_MEMBER');
  });

  it('MEMBER thường cố xóa NGƯỜI KHÁC → FORBIDDEN_ROLE', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const plainMember = await makeAgent();
    const victim = await makeAgent();
    await makeFriends(creator.id, plainMember.id);
    await makeFriends(creator.id, victim.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [plainMember.id, victim.id]);
    await expectCode(removeMember(db, room.id, plainMember.id, victim.id), 'FORBIDDEN_ROLE');
  });

  it('changeMemberRole: ADMIN không được tự phong OWNER; OWNER thì được (VÀ OWNER cũ tự động hạ ADMIN — chuyển nhượng, KHÔNG phải thêm OWNER thứ 2)', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const admin = await makeAgent();
    const plainMember = await makeAgent();
    await makeFriends(creator.id, admin.id);
    await makeFriends(creator.id, plainMember.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [admin.id, plainMember.id]);
    await changeMemberRole(db, room.id, creator.id, admin.id, 'ADMIN');

    await expectCode(changeMemberRole(db, room.id, admin.id, plainMember.id, 'OWNER'), 'FORBIDDEN_ROLE');
    const promoted = await changeMemberRole(db, room.id, creator.id, plainMember.id, 'OWNER');
    expect(promoted.role).toBe('OWNER');

    // Admin Demo chốt 29/7 "trưởng nhóm đi phó nhóm làm" — OWNER cũ (creator) tự động hạ ADMIN, KHÔNG còn là OWNER
    // song song với plainMember — đúng 1 OWNER duy nhất tại mọi thời điểm.
    const creatorRow = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: creator.id } } });
    expect(creatorRow?.role).toBe('ADMIN');
    const ownerCount = await db.chatRoomMember.count({ where: { roomId: room.id, role: 'OWNER', leftAt: null } });
    expect(ownerCount).toBe(1);
  });

  it('Admin Demo chốt 29/7 — OWNER tự rời phòng khi CÒN người khác → OWNER_MUST_TRANSFER_FIRST, KHÔNG rời được', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const plainMember = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, plainMember.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [plainMember.id, filler.id]);
    await expectCode(removeMember(db, room.id, creator.id, creator.id), 'OWNER_MUST_TRANSFER_FIRST');
    // Vẫn còn là thành viên — chưa bị rời.
    const stillMember = await assertActiveMember(db, room.id, creator.id);
    expect(stillMember.role).toBe('OWNER');
  });

  it('Admin Demo chốt 29/7 — OWNER chuyển nhượng cho phó nhóm TRƯỚC (changeMemberRole→OWNER), rồi tự rời → thành công', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const deputy = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, deputy.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [deputy.id, filler.id]);
    await changeMemberRole(db, room.id, creator.id, deputy.id, 'OWNER'); // chuyển nhượng — creator tự động thành ADMIN.
    await removeMember(db, room.id, creator.id, creator.id); // giờ chỉ còn ADMIN (còn filler khác trong phòng), không còn bị chặn nữa.
    await expectCode(assertActiveMember(db, room.id, creator.id), 'NOT_MEMBER');
    const newOwner = await assertActiveMember(db, room.id, deputy.id);
    expect(newOwner.role).toBe('OWNER');
  });

  it('OWNER là người CUỐI CÙNG còn lại trong phòng (không ai để nhường) → vẫn rời được, phòng để trống', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const plainMember = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, plainMember.id);
    await makeFriends(creator.id, filler.id);
    // Nhóm tạo ĐỦ 3 người (đúng rule tối thiểu) — rồi CẢ 2 thành viên khác lần lượt rời, để OWNER thật sự trở
    // thành người CUỐI CÙNG còn lại (rule "tối thiểu 3 người" chỉ áp lúc TẠO phòng, không áp khi rời sau đó).
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [plainMember.id, filler.id]);
    await removeMember(db, room.id, plainMember.id, plainMember.id);
    await removeMember(db, room.id, filler.id, filler.id);
    await removeMember(db, room.id, creator.id, creator.id); // OWNER giờ là người cuối cùng — được phép rời.
    await expectCode(assertActiveMember(db, room.id, creator.id), 'NOT_MEMBER');
  });

  it('pinMessage/unpinMessage: chỉ OWNER/ADMIN; tin nhắn phải thuộc đúng phòng', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const plainMember = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, plainMember.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [plainMember.id, filler.id]);
    const msg = await sendMessage(db, { roomId: room.id, senderId: plainMember.id, kind: 'TEXT', body: 'xin chào' });

    await expectCode(pinMessage(db, room.id, plainMember.id, msg.id), 'FORBIDDEN_ROLE');

    await pinMessage(db, room.id, creator.id, msg.id);
    const roomAfterPin = await db.chatRoom.findUnique({ where: { id: room.id } });
    expect(roomAfterPin?.pinnedMessageId).toBe(msg.id);

    await unpinMessage(db, room.id, creator.id);
    const roomAfterUnpin = await db.chatRoom.findUnique({ where: { id: room.id } });
    expect(roomAfterUnpin?.pinnedMessageId).toBeNull();
  });

  it('pinMessage với messageId của phòng KHÁC → NOT_FOUND', async () => {
    const db = getBotDb();
    const creatorA = await makeAgent();
    const otherA = await makeAgent();
    const fillerA = await makeAgent();
    await makeFriends(creatorA.id, otherA.id);
    await makeFriends(creatorA.id, fillerA.id);
    const roomA = await createGroupRoom(db, creatorA.id, 'Nhóm A', [otherA.id, fillerA.id]);
    const creatorB = await makeAgent();
    const otherB = await makeAgent();
    const fillerB = await makeAgent();
    await makeFriends(creatorB.id, otherB.id);
    await makeFriends(creatorB.id, fillerB.id);
    const roomB = await createGroupRoom(db, creatorB.id, 'Nhóm B', [otherB.id, fillerB.id]);
    const msgInB = await sendMessage(db, { roomId: roomB.id, senderId: creatorB.id, kind: 'TEXT', body: 'ở phòng B' });
    await expectCode(pinMessage(db, roomA.id, creatorA.id, msgInB.id), 'NOT_FOUND');
  });
});

describe('chat-room-service — listRoomsForAgent', () => {
  it('sort theo lastMessageAt DESC; phòng chưa có tin nào (lastMessageAt null) xuống cuối', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const other1 = await makeAgent();
    const other2 = await makeAgent();
    await makeFriends(me.id, other1.id);
    await makeFriends(me.id, other2.id);

    const roomNoMsg = await findOrCreateDirectRoom(db, me.id, other2.id);
    const roomWithMsg = await findOrCreateDirectRoom(db, me.id, other1.id);
    await sendMessage(db, { roomId: roomWithMsg.id, senderId: other1.id, kind: 'TEXT', body: 'hello' });

    const rooms = await listRoomsForAgent(db, me.id);
    expect(rooms.map((r) => r.id)).toEqual([roomWithMsg.id, roomNoMsg.id]);
    expect(rooms[0].lastMessage?.body).toBe('hello');
    expect(rooms[1].lastMessage).toBeNull();
  });

  it('unreadCount: đếm tin của NGƯỜI KHÁC gửi sau lần đọc cuối, KHÔNG đếm tin của chính mình', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const other = await makeAgent();
    await makeFriends(me.id, other.id);
    const room = await findOrCreateDirectRoom(db, me.id, other.id);

    await sendMessage(db, { roomId: room.id, senderId: other.id, kind: 'TEXT', body: 'tin 1' });
    await sendMessage(db, { roomId: room.id, senderId: me.id, kind: 'TEXT', body: 'tin của tôi' });
    await sendMessage(db, { roomId: room.id, senderId: other.id, kind: 'TEXT', body: 'tin 2' });

    const rooms = await listRoomsForAgent(db, me.id);
    const mine = rooms.find((r) => r.id === room.id)!;
    expect(mine.unreadCount).toBe(2); // 2 tin của `other`, KHÔNG tính tin do `me` tự gửi.
  });

  // REGRESSION FIX unread-tuple (12/8) — con trỏ "đã đọc" là TUPLE (createdAt,id); tin CÙNG millisecond với
  // tin-đã-đọc-cuối nhưng id LỚN HƠN (mới hơn theo tie-break `ORDER BY created_at DESC, id DESC`) TRƯỚC ĐÂY bị
  // đếm SÓT vì unread chỉ so `created_at > since` → badge undercount/kẹt. Chèn tin bằng createdAt/id có kiểm
  // soát (sendMessage() tự đặt now()/cuid nên không ép được cùng-ms). Kiểm CẢ listRoomsForAgent (unreadCountsForRooms
  // raw SQL) LẪN countUnreadForRoomMember (Prisma count — path badge APK/FCM).
  it('unreadCount: tin CÙNG millisecond với con trỏ đọc nhưng id > lastReadId VẪN được đếm (fix tuple compare)', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const other = await makeAgent();
    await makeFriends(me.id, other.id);
    const room = await findOrCreateDirectRoom(db, me.id, other.id);

    const T = new Date('2026-08-10T03:00:00.000Z');
    const Tafter = new Date('2026-08-10T03:00:01.000Z');
    await db.chatMessage.create({ data: { id: 'reg_read_500', roomId: room.id, senderId: other.id, kind: 'TEXT', body: 'cursor', createdAt: T } });
    await db.chatMessage.create({ data: { id: 'reg_read_100', roomId: room.id, senderId: other.id, kind: 'TEXT', body: 'same-ms id thấp hơn cursor', createdAt: new Date(T) } });
    await db.chatMessage.create({ data: { id: 'reg_read_900', roomId: room.id, senderId: other.id, kind: 'TEXT', body: 'same-ms id CAO hơn cursor', createdAt: new Date(T) } });
    await db.chatMessage.create({ data: { id: 'reg_future_1', roomId: room.id, senderId: other.id, kind: 'TEXT', body: 'mới hơn hẳn', createdAt: Tafter } });
    const meMember = await db.chatRoomMember.update({ where: { roomId_agentId: { roomId: room.id, agentId: me.id } }, data: { lastReadMessageId: 'reg_read_500' } });

    // Path 1: listRoomsForAgent (unreadCountsForRooms raw SQL tuple).
    const rooms = await listRoomsForAgent(db, me.id);
    const mine = rooms.find((r) => r.id === room.id)!;
    // Đếm: reg_read_900 (cùng ms, id>cursor) + reg_future_1. KHÔNG đếm reg_read_100 (id<cursor) / reg_read_500 (chính con trỏ).
    expect(mine.unreadCount).toBe(2);

    // Path 2: countUnreadForRoomMember (Prisma count OR tuple — badge APK/FCM).
    const badge = await countUnreadForRoomMember(db, room.id, { agentId: me.id, lastReadMessageId: 'reg_read_500', joinedAt: meMember.joinedAt, clearedAt: meMember.clearedAt });
    expect(badge).toBe(2);
  });

  it('otherAgentId đúng cho phòng DIRECT; null cho phòng GROUP', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const other = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(me.id, other.id);
    await makeFriends(me.id, filler.id);
    const directRoom = await findOrCreateDirectRoom(db, me.id, other.id);
    const groupRoom = await createGroupRoom(db, me.id, 'Nhóm', [other.id, filler.id]);

    const rooms = await listRoomsForAgent(db, me.id);
    expect(rooms.find((r) => r.id === directRoom.id)?.otherAgentId).toBe(other.id);
    expect(rooms.find((r) => r.id === groupRoom.id)?.otherAgentId).toBeNull();
  });

  it('phòng đã rời (leftAt set) KHÔNG còn xuất hiện trong danh sách', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const m1 = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, m1.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [m1.id, filler.id]);
    await removeMember(db, room.id, m1.id, m1.id);
    const rooms = await listRoomsForAgent(db, m1.id);
    expect(rooms.find((r) => r.id === room.id)).toBeUndefined();
  });

  it('unreadOnly:true (Admin Demo chốt 29/7, "lọc chưa đọc như Zalo") — chỉ trả phòng còn tin chưa đọc', async () => {
    const db = getBotDb();
    const me = await makeAgent();
    const readSender = await makeAgent();
    const unreadSender = await makeAgent();
    await makeFriends(me.id, readSender.id);
    await makeFriends(me.id, unreadSender.id);
    const roomRead = await findOrCreateDirectRoom(db, me.id, readSender.id);
    const roomUnread = await findOrCreateDirectRoom(db, me.id, unreadSender.id);
    const msg1 = await sendMessage(db, { roomId: roomRead.id, senderId: readSender.id, kind: 'TEXT', body: 'đã đọc' });
    await sendMessage(db, { roomId: roomUnread.id, senderId: unreadSender.id, kind: 'TEXT', body: 'chưa đọc' });
    await markRead(db, roomRead.id, me.id, msg1.id);

    const all = await listRoomsForAgent(db, me.id);
    expect(all.map((r) => r.id).sort()).toEqual([roomRead.id, roomUnread.id].sort());

    const unreadOnly = await listRoomsForAgent(db, me.id, { unreadOnly: true });
    expect(unreadOnly.map((r) => r.id)).toEqual([roomUnread.id]);
  });

  it('audit độc lập 29/7 (INFO — race chưa từng chứng minh chạy thật) — 2 request findOrCreateDirectRoom ĐỒNG THỜI cho CÙNG 1 cặp agent → chỉ tạo ĐÚNG 1 phòng, không request nào 500', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await makeFriends(a.id, b.id);

    const [roomFromA, roomFromB] = await Promise.all([findOrCreateDirectRoom(db, a.id, b.id), findOrCreateDirectRoom(db, b.id, a.id)]);

    expect(roomFromA.id).toBe(roomFromB.id); // cả 2 request đều thấy CÙNG 1 phòng — không request nào tạo phòng riêng.
    const count = await db.chatRoom.count({ where: { type: 'DIRECT', directPairKey: [a.id, b.id].sort((x, y) => x - y).join('-') } });
    expect(count).toBe(1); // unique index chặn đúng, catch P2002 xử lý đúng — không có 2 phòng trùng cặp.
  });
});

describe('chat-room-service — updateGroupSettings (Admin Demo chốt 29/7: chỉ trưởng/phó nhóm được đổi cài đặt nhóm)', () => {
  it('OWNER đổi tên nhóm thành công', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const m1 = await makeAgent();
    const m2 = await makeAgent();
    await makeFriends(creator.id, m1.id);
    await makeFriends(creator.id, m2.id);
    const room = await createGroupRoom(db, creator.id, 'Tên cũ', [m1.id, m2.id]);
    const updated = await updateGroupSettings(db, room.id, creator.id, { name: 'Tên mới' });
    expect(updated.name).toBe('Tên mới');
  });

  it('MEMBER thường (không phải OWNER/ADMIN) cố đổi tên → FORBIDDEN_ROLE', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const plainMember = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, plainMember.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [plainMember.id, filler.id]);
    await expectCode(updateGroupSettings(db, room.id, plainMember.id, { name: 'Hack tên' }), 'FORBIDDEN_ROLE');
  });

  it('phòng DIRECT (không phải GROUP) → FORBIDDEN_ROLE (thành viên DIRECT LUÔN là MEMBER, không bao giờ OWNER/ADMIN — chặn ở gate quyền trước khi chạm tới kiểm loại phòng)', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    await makeFriends(a.id, b.id);
    const room = await findOrCreateDirectRoom(db, a.id, b.id);
    await expectCode(updateGroupSettings(db, room.id, a.id, { name: 'Không hợp lệ' }), 'FORBIDDEN_ROLE');
  });

  // debt-chat-gaps (31/7, Việc 4) — "chỉ trưởng/phó nhóm được gửi tin" (ChatRoom.readOnly). Enforce THẬT nằm ở
  // sendMessage() (chat-message-service.test.ts) — đây chỉ kiểm updateGroupSettings() ghi ĐÚNG cờ + trả lại
  // đúng trong RoomDetailDto, cùng gate OWNER/ADMIN như name/avatar.
  it('OWNER bật readOnly=true → RoomDetailDto trả readOnly=true; mặc định phòng mới LUÔN readOnly=false', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const m1 = await makeAgent();
    const m2 = await makeAgent();
    await makeFriends(creator.id, m1.id);
    await makeFriends(creator.id, m2.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm readOnly DTO', [m1.id, m2.id]);
    expect(room.readOnly).toBe(false); // mặc định.
    const updated = await updateGroupSettings(db, room.id, creator.id, { readOnly: true });
    expect(updated.readOnly).toBe(true);
    const detail = await getRoomDetail(db, room.id, creator.id);
    expect(detail.readOnly).toBe(true);
  });

  it('MEMBER thường cố bật readOnly → FORBIDDEN_ROLE (CÙNG gate assertOwnerOrAdmin() như name/avatar)', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const plainMember = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, plainMember.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [plainMember.id, filler.id]);
    await expectCode(updateGroupSettings(db, room.id, plainMember.id, { readOnly: true }), 'FORBIDDEN_ROLE');
  });
});

describe('chat-room-service — audit độc lập ĐỢT 2 (29/7): thành viên "ma" (Agent đã bị xóa tài khoản)', () => {
  it('OWNER rời phòng khi "người khác" duy nhất còn lại đã bị xóa tài khoản → coi như KHÔNG còn ai, cho rời (không kẹt vĩnh viễn)', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const ghost = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, ghost.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [ghost.id, filler.id]);
    await removeMember(db, room.id, filler.id, filler.id); // filler tự rời trước, chỉ còn creator(OWNER)+ghost.
    await db.agent.update({ where: { id: ghost.id }, data: { deletedAt: new Date() } }); // ghost "chết" nhưng ChatRoomMember row CHƯA dọn.

    // Trước fix: othersCount đếm cả ghost (leftAt vẫn null) => 409 kẹt vĩnh viễn. Sau fix: ghost bị lọc, coi
    // như creator là người cuối cùng còn lại => cho rời.
    await removeMember(db, room.id, creator.id, creator.id);
    await expectCode(assertActiveMember(db, room.id, creator.id), 'NOT_MEMBER');
  });

  it('changeMemberRole KHÔNG cho phong 1 Agent đã bị xóa tài khoản làm OWNER/ADMIN', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const ghost = await makeAgent();
    const filler = await makeAgent();
    await makeFriends(creator.id, ghost.id);
    await makeFriends(creator.id, filler.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [ghost.id, filler.id]);
    await db.agent.update({ where: { id: ghost.id }, data: { deletedAt: new Date() } });

    await expectCode(changeMemberRole(db, room.id, creator.id, ghost.id, 'ADMIN'), 'NOT_MEMBER');
    await expectCode(changeMemberRole(db, room.id, creator.id, ghost.id, 'OWNER'), 'NOT_MEMBER');
  });

  it('autoTransferOwnershipOnDeletion KHÔNG chọn Agent đã bị xóa làm người kế nhiệm — thăng đúng người còn sống', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const ghostAdmin = await makeAgent(); // sẽ là ADMIN nhưng bị xóa TRƯỚC creator — không được chọn dù role ADMIN ưu tiên hơn.
    const aliveMember = await makeAgent();
    await makeFriends(creator.id, ghostAdmin.id);
    await makeFriends(creator.id, aliveMember.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [ghostAdmin.id, aliveMember.id]);
    await changeMemberRole(db, room.id, creator.id, ghostAdmin.id, 'ADMIN');
    await db.agent.update({ where: { id: ghostAdmin.id }, data: { deletedAt: new Date() } });

    await autoTransferOwnershipOnDeletion(db, creator.id); // creator "bị xóa" — mô phỏng trực tiếp, không chờ 48h thật.

    const newOwner = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: aliveMember.id } } });
    expect(newOwner?.role).toBe('OWNER'); // KHÔNG phải ghostAdmin dù role ADMIN thường được ưu tiên.
    const ghostRow = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: ghostAdmin.id } } });
    expect(ghostRow?.role).toBe('ADMIN'); // ghost giữ nguyên role cũ, KHÔNG được thăng OWNER.
  });
});

describe('chat-room-service — audit độc lập ĐỢT 2 (29/7): race chuyển nhượng OWNER đồng thời', () => {
  it('2 request changeMemberRole(newRole=OWNER) bắn ĐỒNG THỜI cho 2 target khác nhau → CHỈ 1 thành công, còn lại CONFLICT, KHÔNG BAO GIỜ có 2 OWNER', async () => {
    const db = getBotDb();
    const creator = await makeAgent();
    const b = await makeAgent();
    const c = await makeAgent();
    await makeFriends(creator.id, b.id);
    await makeFriends(creator.id, c.id);
    const room = await createGroupRoom(db, creator.id, 'Nhóm', [b.id, c.id]);

    const results = await Promise.allSettled([
      changeMemberRole(db, room.id, creator.id, b.id, 'OWNER'),
      changeMemberRole(db, room.id, creator.id, c.id, 'OWNER')
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');
    expect(succeeded.length).toBe(1); // đúng 1 request thắng.
    expect(failed.length).toBe(1);
    if (failed[0].status === 'rejected') {
      expect((failed[0].reason as ChatServiceError).code).toBe('CONFLICT');
    }

    const ownerCount = await db.chatRoomMember.count({ where: { roomId: room.id, role: 'OWNER', leftAt: null } });
    expect(ownerCount).toBe(1); // bất kể request nào thắng — LUÔN đúng 1 OWNER, không bao giờ 2.
  });
});

// ── BOT-3/BOT-4 (audit 21/8) — PHÒNG GẮN KHÁCH = phạm-vi-tài-chính ─────────────────────────────────────────
// Phòng chat gắn khách qua customer_chat_groups (unassignedAt IS NULL) cấp cho MỌI thành viên active quyền
// xem/khớp/báo-giá/tạo-lô TID của khách đó (agent-tid-scope.ts). Vì vậy VÀO/THÊM người vào phòng loại này = mở
// rộng phạm vi tài chính → siết chặt: self-join CẤM auto-add (luôn PENDING dù requireApproval=false); addMember
// CHỈ OWNER/ADMIN. Helper dựng: phòng GROUP + OWNER + link customer active.
async function makeFinancialScopeRoom() {
  const owner = await makeAgent();
  const room = await makeChatRoom({ type: 'GROUP' }); // requireApproval mặc định = false
  await makeChatRoomMember(room.id, owner.id, { role: 'OWNER' });
  const customer = await makeCustomer();
  await makeCustomerChatGroup({ customerId: customer.id, roomId: room.id }); // unassignedAt null = active
  return { owner, room, customer };
}

describe('chat-room-service — BOT-3 requestJoin trên phòng gắn khách (phạm-vi-tài-chính)', () => {
  it('agent lạ self-join phòng gắn khách (requireApproval=false) → PENDING, KHÔNG vào thẳng', async () => {
    const db = getBotDb();
    const { room } = await makeFinancialScopeRoom();
    const outsider = await makeAgent();

    const res = await requestJoin(db, room.id, outsider.id);
    expect(res.status).toBe('PENDING'); // KHÔNG được JOINED dù requireApproval=false.
    // Chưa là thành viên active → chưa có phạm vi TID của khách.
    const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: outsider.id } } });
    expect(member === null || member.leftAt !== null).toBe(true);
    // Có 1 yêu cầu PENDING chờ OWNER/ADMIN duyệt.
    const pending = await db.chatRoomJoinRequest.count({ where: { roomId: room.id, agentId: outsider.id, status: 'PENDING' } });
    expect(pending).toBe(1);
  });

  it('phòng THƯỜNG (không gắn khách, requireApproval=false) → self-join vẫn JOINED ngay (không hồi quy)', async () => {
    const db = getBotDb();
    const owner = await makeAgent();
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, owner.id, { role: 'OWNER' });
    const outsider = await makeAgent();

    const res = await requestJoin(db, room.id, outsider.id);
    expect(res.status).toBe('JOINED');
    const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: outsider.id } } });
    expect(member?.leftAt ?? null).toBeNull();
  });

  it('phòng gắn khách nhưng kỳ gán ĐÃ HỦY (unassignedAt set) → KHÔNG còn phạm-vi-tài-chính, self-join JOINED', async () => {
    const db = getBotDb();
    const owner = await makeAgent();
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, owner.id, { role: 'OWNER' });
    const customer = await makeCustomer();
    await makeCustomerChatGroup({ customerId: customer.id, roomId: room.id, unassignedAt: new Date() }); // đã hủy gán
    const outsider = await makeAgent();

    const res = await requestJoin(db, room.id, outsider.id);
    expect(res.status).toBe('JOINED'); // link không active → coi như phòng thường.
  });
});

describe('chat-room-service — BOT-4 addMember trên phòng gắn khách (phạm-vi-tài-chính)', () => {
  it('MEMBER thường thêm người vào phòng gắn khách → FORBIDDEN_ROLE (chỉ OWNER/ADMIN)', async () => {
    const db = getBotDb();
    const { room } = await makeFinancialScopeRoom();
    const member = await makeAgent();
    await makeChatRoomMember(room.id, member.id, { role: 'MEMBER' });
    const friend = await makeAgent();
    await makeFriends(member.id, friend.id); // dù là bạn bè, member thường VẪN không được thêm.

    await expectCode(addMember(db, room.id, member.id, friend.id), 'FORBIDDEN_ROLE');
    const added = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: friend.id } } });
    expect(added === null || added.leftAt !== null).toBe(true); // không được thêm.
  });

  it('OWNER thêm bạn vào phòng gắn khách → thành công (giữ được thao tác hợp lệ)', async () => {
    const db = getBotDb();
    const { owner, room } = await makeFinancialScopeRoom();
    const friend = await makeAgent();
    await makeFriends(owner.id, friend.id);

    const dto = await addMember(db, room.id, owner.id, friend.id);
    expect(dto.agentId).toBe(friend.id);
    const added = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: friend.id } } });
    expect(added?.leftAt ?? null).toBeNull();
  });

  it('phòng THƯỜNG (không gắn khách) → MEMBER thường vẫn thêm được bạn (không hồi quy #29)', async () => {
    const db = getBotDb();
    const owner = await makeAgent();
    const room = await makeChatRoom({ type: 'GROUP' });
    await makeChatRoomMember(room.id, owner.id, { role: 'OWNER' });
    const member = await makeAgent();
    await makeChatRoomMember(room.id, member.id, { role: 'MEMBER' });
    const friend = await makeAgent();
    await makeFriends(member.id, friend.id);

    const dto = await addMember(db, room.id, member.id, friend.id);
    expect(dto.agentId).toBe(friend.id);
  });
});
