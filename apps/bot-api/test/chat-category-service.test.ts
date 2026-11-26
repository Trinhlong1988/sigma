// SIGMA "Phân loại" (mục 21, việc #4, 31/7) — test service chat-category-service.ts trên DB throwaway
// (global-setup.ts tự migrate deploy MỌI migration bao gồm 20260731180000_chat_category, tự tạo/hủy). CHƯA
// CHẠY ĐƯỢC cho tới khi LEAD `prisma migrate deploy` + `prisma generate` (xem BUGS_FIXED.md — client Prisma
// dùng chung CHƯA biết bảng chat_categories/cột category_id, đây là hệ quả TẤT YẾU đã biết trước, KHÔNG PHẢI
// lỗi logic). Phủ đủ: happy path CRUD, IDOR (agent B không sửa/xóa/gán được category của A), NOT_MEMBER khi
// agent không phải thành viên phòng, validation.
import { describe, expect, it } from 'vitest';
import { getBotDb } from '../src/db.js';
import { assignRoomCategory, createCategory, deleteCategory, listCategories, updateCategory } from '../src/chat-category-service.js';
import { makeAgent, makeChatRoom, makeChatRoomMember } from './fixtures.js';

describe('chat-category-service — Phân loại nhóm chat (mục 21)', () => {
  it('listCategories rỗng cho agent chưa tạo phân loại nào', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const r = await listCategories(db, a.id);
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([]);
  });

  it('createCategory: tên rỗng/chỉ khoảng trắng → VALIDATION', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const r1 = await createCategory(db, a.id, '', '#16a34a');
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.error).toBe('VALIDATION');
    const r2 = await createCategory(db, a.id, '   ', '#16a34a');
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).toBe('VALIDATION');
  });

  it('createCategory: color rỗng → VALIDATION', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const r = await createCategory(db, a.id, 'Gia đình', '');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('VALIDATION');
  });

  it('createCategory thành công → listCategories thấy đúng, roomIds rỗng', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const created = await createCategory(db, a.id, '  Gia đình  ', '#16a34a');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.name).toBe('Gia đình'); // trim
    expect(created.data.agentId).toBe(a.id);
    expect(created.data.roomIds).toEqual([]);

    const list = await listCategories(db, a.id);
    expect(list.data.map((c) => c.id)).toEqual([created.data.id]);
  });

  it('updateCategory: chủ sở hữu đổi tên/màu thành công', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const created = await createCategory(db, a.id, 'Công việc', '#1657d0');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const updated = await updateCategory(db, a.id, created.data.id, { name: 'Công việc mới', color: '#f59e0b' });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.data.name).toBe('Công việc mới');
    expect(updated.data.color).toBe('#f59e0b');
  });

  it('updateCategory: tên rỗng → VALIDATION, KHÔNG đổi dữ liệu cũ', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const created = await createCategory(db, a.id, 'Khách hàng', '#f59e0b');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const r = await updateCategory(db, a.id, created.data.id, { name: '   ' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('VALIDATION');
    const list = await listCategories(db, a.id);
    expect(list.data[0].name).toBe('Khách hàng');
  });

  it('IDOR: agent B không sửa được category của agent A → 404 giống hệt không tồn tại', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    const created = await createCategory(db, a.id, 'Gia đình', '#16a34a');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const r = await updateCategory(db, b.id, created.data.id, { name: 'Hack' });
    expect(r.ok).toBe(false);
    const rErrorCode = !r.ok ? r.error : undefined;
    expect(rErrorCode).toBe('NOT_FOUND');

    const rNonExistent = await updateCategory(db, b.id, 'khong-ton-tai', { name: 'X' });
    expect(rNonExistent.ok).toBe(false);
    if (!rNonExistent.ok) {
      // CÙNG mã lỗi NOT_FOUND cho "không tồn tại" và "tồn tại nhưng không phải của mình" — không lộ khác biệt.
      expect(rNonExistent.error).toBe('NOT_FOUND');
      expect(rNonExistent.error).toBe(rErrorCode);
    }
  });

  it('IDOR: agent B không xóa được category của agent A → 404; category của A vẫn còn nguyên', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    const created = await createCategory(db, a.id, 'Gia đình', '#16a34a');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const r = await deleteCategory(db, b.id, created.data.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NOT_FOUND');

    const list = await listCategories(db, a.id);
    expect(list.data.map((c) => c.id)).toEqual([created.data.id]);
  });

  it('deleteCategory: chủ sở hữu xóa thành công → biến mất khỏi listCategories', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const created = await createCategory(db, a.id, 'Gia đình', '#16a34a');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const r = await deleteCategory(db, a.id, created.data.id);
    expect(r.ok).toBe(true);
    const list = await listCategories(db, a.id);
    expect(list.data).toEqual([]);
  });

  it('deleteCategory: xóa 1 phân loại ĐANG GÁN cho phòng → ChatRoomMember.categoryId tự về null (onDelete SetNull), KHÔNG xóa phòng/thành viên', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const room = await makeChatRoom();
    await makeChatRoomMember(room.id, a.id);
    const created = await createCategory(db, a.id, 'Gia đình', '#16a34a');
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const assigned = await assignRoomCategory(db, a.id, room.id, created.data.id);
    expect(assigned.ok).toBe(true);

    const del = await deleteCategory(db, a.id, created.data.id);
    expect(del.ok).toBe(true);

    const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: a.id } } });
    expect(member).not.toBeNull();
    expect(member?.categoryId).toBeNull();
    const roomStillThere = await db.chatRoom.findUnique({ where: { id: room.id } });
    expect(roomStillThere).not.toBeNull();
  });

  it('assignRoomCategory: agent KHÔNG phải thành viên phòng → NOT_MEMBER', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    const room = await makeChatRoom();
    await makeChatRoomMember(room.id, a.id); // chỉ A là thành viên, B không
    const created = await createCategory(db, b.id, 'Gia đình', '#16a34a');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const r = await assignRoomCategory(db, b.id, room.id, created.data.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NOT_MEMBER');
  });

  it('assignRoomCategory: agent ĐÃ RỜI phòng (leftAt khác null) → NOT_MEMBER', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const room = await makeChatRoom();
    await makeChatRoomMember(room.id, a.id, { leftAt: new Date() });
    const created = await createCategory(db, a.id, 'Gia đình', '#16a34a');
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const r = await assignRoomCategory(db, a.id, room.id, created.data.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NOT_MEMBER');
  });

  it('IDOR: agent B là thành viên phòng nhưng gán category CỦA A (không phải của B) → NOT_FOUND, KHÔNG đổi categoryId', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const b = await makeAgent();
    const room = await makeChatRoom();
    await makeChatRoomMember(room.id, b.id); // B là thành viên phòng
    const createdByA = await createCategory(db, a.id, 'Gia đình', '#16a34a');
    expect(createdByA.ok).toBe(true);
    if (!createdByA.ok) return;

    const r = await assignRoomCategory(db, b.id, room.id, createdByA.data.id);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NOT_FOUND');

    const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId: room.id, agentId: b.id } } });
    expect(member?.categoryId).toBeNull();
  });

  it('assignRoomCategory: happy path gán rồi gỡ (categoryId: null) — roomIds trong listCategories cập nhật đúng', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const room = await makeChatRoom();
    await makeChatRoomMember(room.id, a.id);
    const created = await createCategory(db, a.id, 'Gia đình', '#16a34a');
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const assigned = await assignRoomCategory(db, a.id, room.id, created.data.id);
    expect(assigned.ok).toBe(true);
    if (assigned.ok) expect(assigned.data).toEqual({ roomId: room.id, categoryId: created.data.id });

    let list = await listCategories(db, a.id);
    expect(list.data[0].roomIds).toEqual([room.id]);

    const unassigned = await assignRoomCategory(db, a.id, room.id, null);
    expect(unassigned.ok).toBe(true);
    if (unassigned.ok) expect(unassigned.data).toEqual({ roomId: room.id, categoryId: null });

    list = await listCategories(db, a.id);
    expect(list.data[0].roomIds).toEqual([]);
  });

  it('assignRoomCategory: categoryId kiểu số (không phải chuỗi/null) → VALIDATION', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const room = await makeChatRoom();
    await makeChatRoomMember(room.id, a.id);
    const r = await assignRoomCategory(db, a.id, room.id, 123 as unknown as string);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('VALIDATION');
  });

  it('assignRoomCategory: categoryId không tồn tại → NOT_FOUND', async () => {
    const db = getBotDb();
    const a = await makeAgent();
    const room = await makeChatRoom();
    await makeChatRoomMember(room.id, a.id);
    const r = await assignRoomCategory(db, a.id, room.id, 'khong-ton-tai');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NOT_FOUND');
  });
});
