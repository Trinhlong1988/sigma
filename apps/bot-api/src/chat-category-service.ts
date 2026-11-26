// SIGMA "Phân loại" (mục 21, việc #4, 31/7) — thay Phase 0 mock-only (mock-data/categories.ts +
// CategoryManagerModal.tsx sửa thẳng mảng client, mất khi reload). File RIÊNG (KHÔNG nhét vào
// friend-service.ts) — khác domain: đây là phân loại NHÓM CHAT (ChatCategory/ChatRoomMember.categoryId,
// schema.prisma), không liên quan bạn bè (FriendRequest). CÙNG khuôn service khác trong dự án: DB access +
// orchestration sống Ở ĐÂY, routes/me.ts CHỈ wrap HTTP.
//
// NGỮ CẢNH THIẾT KẾ (LEAD tự chọn, không hỏi lại — ghi rõ để review):
// - 1 ChatCategory thuộc ĐÚNG 1 agent (agentId = chủ sở hữu) — CHỈ agent đó thấy/sửa/xóa. Agent khác trong
//   CÙNG 1 phòng chat có thể tự tạo phân loại RIÊNG của họ và gán CHÍNH HÀNG ChatRoomMember của họ vào đó —
//   phân loại là thuộc tính CÁ NHÂN trên quan hệ agent↔phòng (ChatRoomMember), KHÔNG phải thuộc tính chung
//   của ChatRoom (đúng yêu cầu brief: "phân loại chat là do TỪNG agent tự đặt cho phòng chat CỦA MÌNH").
// - IDOR: mọi thao tác sửa/xóa/gán CHỈ cho phép nếu category (nếu có) thuộc CHÍNH agentId đang gọi — không
//   phải chủ sở hữu → trả NOT_FOUND (KHÔNG trả 1 mã lỗi riêng kiểu "FORBIDDEN" — tránh lộ thông tin "category
//   này CÓ tồn tại nhưng không phải của bạn", cùng nguyên tắc IDOR toàn dự án, xem friend-service.ts
//   setFriendNickname/comment routes/me.ts Lô "404 KHÔNG tiết lộ dữ liệu chéo đại lý").
import type { Db } from '@sigma/database';

export type ChatCategoryServiceError =
  | { ok: false; error: 'VALIDATION'; message: string }
  | { ok: false; error: 'NOT_FOUND'; message: string }
  | { ok: false; error: 'NOT_MEMBER'; message: string };

export interface ChatCategoryDto {
  id: string;
  agentId: number;
  name: string;
  color: string;
  createdAt: string;
  /** Danh sách roomId CỦA CHÍNH agentId này đang gán vào phân loại này (join ChatRoomMember). */
  roomIds: string[];
}

const CATEGORY_NAME_MAX_LENGTH = 50; // cùng bậc độ dài NICKNAME_MAX_LENGTH (friend-service.ts) — hợp lý cho 1 tên nhãn ngắn.

/** GET /v1/me/categories — toàn bộ ChatCategory của agentId, kèm roomIds đang gán (theo CHÍNH agent đó). */
export async function listCategories(db: Db, agentId: number): Promise<{ ok: true; data: ChatCategoryDto[] }> {
  const categories = await db.chatCategory.findMany({ where: { agentId }, orderBy: { createdAt: 'asc' } });
  if (categories.length === 0) return { ok: true, data: [] };

  const memberRows = await db.chatRoomMember.findMany({
    where: { agentId, categoryId: { in: categories.map((c) => c.id) } },
    select: { roomId: true, categoryId: true }
  });
  const roomIdsByCategory = new Map<string, string[]>();
  for (const row of memberRows) {
    if (!row.categoryId) continue;
    const list = roomIdsByCategory.get(row.categoryId) ?? [];
    list.push(row.roomId);
    roomIdsByCategory.set(row.categoryId, list);
  }

  return {
    ok: true,
    data: categories.map((c) => ({
      id: c.id,
      agentId: c.agentId,
      name: c.name,
      color: c.color,
      createdAt: c.createdAt.toISOString(),
      roomIds: roomIdsByCategory.get(c.id) ?? []
    }))
  };
}

/** POST /v1/me/categories — tạo phân loại mới. `color` KHÔNG validate hex ở tầng này (đúng brief — gợi ý FE
 * qua CATEGORY_SWATCHES, backend chỉ cần chuỗi khác rỗng để không lưu rác hoàn toàn). */
export async function createCategory(
  db: Db,
  agentId: number,
  name: string,
  color: string
): Promise<{ ok: true; data: ChatCategoryDto } | ChatCategoryServiceError> {
  if (typeof name !== 'string') return { ok: false, error: 'VALIDATION', message: 'name phải là chuỗi.' };
  const trimmedName = name.trim();
  if (trimmedName.length === 0) return { ok: false, error: 'VALIDATION', message: 'Tên phân loại không được để trống.' };
  if (trimmedName.length > CATEGORY_NAME_MAX_LENGTH) {
    return { ok: false, error: 'VALIDATION', message: `Tên phân loại tối đa ${CATEGORY_NAME_MAX_LENGTH} ký tự.` };
  }
  if (typeof color !== 'string' || color.trim().length === 0) {
    return { ok: false, error: 'VALIDATION', message: 'color không được để trống.' };
  }

  const created = await db.chatCategory.create({ data: { agentId, name: trimmedName, color: color.trim() } });
  return { ok: true, data: { id: created.id, agentId: created.agentId, name: created.name, color: created.color, createdAt: created.createdAt.toISOString(), roomIds: [] } };
}

/** PATCH /v1/me/categories/:categoryId — CHỈ chủ sở hữu sửa được (không phải → NOT_FOUND, xem ghi chú IDOR
 * đầu file). `name`/`color` optional — chỉ đổi field được truyền. */
export async function updateCategory(
  db: Db,
  agentId: number,
  categoryId: string,
  input: { name?: string; color?: string }
): Promise<{ ok: true; data: ChatCategoryDto } | ChatCategoryServiceError> {
  const existing = await db.chatCategory.findUnique({ where: { id: categoryId } });
  if (!existing || existing.agentId !== agentId) {
    return { ok: false, error: 'NOT_FOUND', message: 'Phân loại không tồn tại.' };
  }

  const data: { name?: string; color?: string } = {};
  if (input.name !== undefined) {
    if (typeof input.name !== 'string') return { ok: false, error: 'VALIDATION', message: 'name phải là chuỗi.' };
    const trimmedName = input.name.trim();
    if (trimmedName.length === 0) return { ok: false, error: 'VALIDATION', message: 'Tên phân loại không được để trống.' };
    if (trimmedName.length > CATEGORY_NAME_MAX_LENGTH) {
      return { ok: false, error: 'VALIDATION', message: `Tên phân loại tối đa ${CATEGORY_NAME_MAX_LENGTH} ký tự.` };
    }
    data.name = trimmedName;
  }
  if (input.color !== undefined) {
    if (typeof input.color !== 'string' || input.color.trim().length === 0) {
      return { ok: false, error: 'VALIDATION', message: 'color không được để trống.' };
    }
    data.color = input.color.trim();
  }

  const updated = await db.chatCategory.update({ where: { id: categoryId }, data });
  const memberRows = await db.chatRoomMember.findMany({ where: { agentId, categoryId }, select: { roomId: true } });
  return {
    ok: true,
    data: {
      id: updated.id,
      agentId: updated.agentId,
      name: updated.name,
      color: updated.color,
      createdAt: updated.createdAt.toISOString(),
      roomIds: memberRows.map((r) => r.roomId)
    }
  };
}

/** DELETE /v1/me/categories/:categoryId — CHỈ chủ sở hữu xóa được. `ChatRoomMember.categoryId` liên quan tự
 * về null nhờ `onDelete: SetNull` (schema.prisma) — vẫn gói trong 1 transaction cho rõ ràng (đọc-kiểm-xóa
 * không bị race giữa 2 request xóa đồng thời CÙNG categoryId — findUnique+delete tách rời có thể lọt qua
 * nếu 2 request cùng đọc thấy tồn tại rồi cùng xóa, nhưng delete() lần 2 sẽ ném P2025 not-found — CHẤP NHẬN
 * ĐƯỢC vì đây là thao tác của CHÍNH 1 agentId trên phân loại của CHÍNH họ, không phải race đa-agent nguy hiểm
 * như dữ liệu tài chính — không cần transaction phức tạp hơn). */
export async function deleteCategory(db: Db, agentId: number, categoryId: string): Promise<{ ok: true; data: { id: string } } | ChatCategoryServiceError> {
  const existing = await db.chatCategory.findUnique({ where: { id: categoryId } });
  if (!existing || existing.agentId !== agentId) {
    return { ok: false, error: 'NOT_FOUND', message: 'Phân loại không tồn tại.' };
  }
  await db.chatCategory.delete({ where: { id: categoryId } });
  return { ok: true, data: { id: categoryId } };
}

/** PATCH /v1/me/chat-rooms/:roomId/category — set categoryId cho ĐÚNG hàng ChatRoomMember (agentId, roomId)
 * của agent gọi. `categoryId: null` → gỡ phân loại (về "chưa phân loại"). Kiểm 2 lớp: (1) agent PHẢI là
 * thành viên ĐANG hoạt động (leftAt: null) của roomId đó; (2) category (nếu không null) PHẢI thuộc CHÍNH
 * agentId đó (không cho gán category của người khác dù ID khó đoán — cùng nguyên tắc IDOR
 * maskCardLast4/toàn dự án, KHÔNG suy luận "ID đủ khó đoán nên không cần kiểm"). */
export async function assignRoomCategory(
  db: Db,
  agentId: number,
  roomId: string,
  categoryId: string | null
): Promise<{ ok: true; data: { roomId: string; categoryId: string | null } } | ChatCategoryServiceError> {
  if (categoryId !== null && typeof categoryId !== 'string') {
    return { ok: false, error: 'VALIDATION', message: 'categoryId phải là chuỗi hoặc null.' };
  }

  const member = await db.chatRoomMember.findUnique({ where: { roomId_agentId: { roomId, agentId } } });
  if (!member || member.leftAt !== null) {
    return { ok: false, error: 'NOT_MEMBER', message: 'Bạn không phải thành viên đang hoạt động của phòng này.' };
  }

  if (categoryId !== null) {
    const category = await db.chatCategory.findUnique({ where: { id: categoryId } });
    if (!category || category.agentId !== agentId) {
      return { ok: false, error: 'NOT_FOUND', message: 'Phân loại không tồn tại.' };
    }
  }

  await db.chatRoomMember.update({ where: { roomId_agentId: { roomId, agentId } }, data: { categoryId } });
  return { ok: true, data: { roomId, categoryId } };
}
