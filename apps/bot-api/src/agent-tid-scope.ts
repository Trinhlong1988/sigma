// PHẠM VI TID CỦA ĐẠI LÝ — nguồn-của-sự-thật DUY NHẤT (Admin Demo 20/8: "đại lý = khách hàng = 1"; "khách gán link
// chat rồi phải TỰ NHẬN"). Đại lý được thấy/khớp/báo-giá TID của các KHÁCH mà đại lý đó đang là THÀNH VIÊN nhóm
// chat active của khách. Chuỗi: chat_room_members(agentId, chưa rời) → room (GROUP, còn sống) → customer_chat_groups
// (active) → customer. TRƯỚC ĐÂY mỗi nơi (list TID, báo giá, fee-preview) tự gate bằng `tid.agentId` — field này
// LUÔN null trong data → không bill/quote nào từng khớp. Gom về 1 helper để 3+ đường (agents.ts, fee-quote.ts
// quoteRow/previewSellFeeForTid) KHÔNG lệch định nghĩa "TID của đại lý" (audit 20/8 I1).
//
// HARDENING (audit 20/8 C2/N2): CHỈ room `type='GROUP'` và CHƯA xóa — chặn (C2) nhóm khách lỡ trỏ room DIRECT/DM
// thì đối phương DM KHÔNG được thừa hưởng TID; (N2) room đã giải tán (deletedAt) không còn cấp quyền. C1 (1 room
// gán ≥2 khách) hiện data = 0; nếu xảy ra thì mọi thành viên room đó thấy TID cả 2 khách — cần partial-unique
// room_id WHERE unassigned_at IS NULL ở tầng schema (đề xuất, chưa thêm vì data hiện sạch).
import type { Db } from '@sigma/database';

/** Tập customerId mà `agentId` được phép thao tác TID (qua nhóm chat active). [] nếu đại lý không ở nhóm nào hợp lệ. */
export async function agentScopeCustomerIds(db: Db, agentId: number): Promise<number[]> {
  const memberRooms = await db.chatRoomMember.findMany({ where: { agentId, leftAt: null }, select: { roomId: true } });
  const roomIds = [...new Set(memberRooms.map((r) => r.roomId))];
  if (roomIds.length === 0) return [];
  // C2/N2: chỉ giữ room GROUP còn sống trước khi suy ra khách.
  const validRooms = await db.chatRoom.findMany({
    where: { id: { in: roomIds }, type: 'GROUP', deletedAt: null },
    select: { id: true }
  });
  const validRoomIds = validRooms.map((r) => r.id);
  if (validRoomIds.length === 0) return [];
  const groups = await db.customerChatGroup.findMany({
    where: { roomId: { in: validRoomIds }, unassignedAt: null },
    select: { customerId: true }
  });
  return [...new Set(groups.map((g) => g.customerId))];
}

/** Tập investorId mà `agentId` được phép XEM doanh số (Admin Demo 26/8: "ai trong nhóm NĐT — kể cả đại lý — đều xem
 * được"). CÙNG chuỗi như agentScopeCustomerIds nhưng qua `investor_chat_groups` thay vì customer: thành viên nhóm
 * (chưa rời) → room GROUP còn sống → investorChatGroup active → investorId. [] nếu không ở nhóm NĐT nào. */
export async function agentScopeInvestorIds(db: Db, agentId: number): Promise<number[]> {
  const memberRooms = await db.chatRoomMember.findMany({ where: { agentId, leftAt: null }, select: { roomId: true } });
  const roomIds = [...new Set(memberRooms.map((r) => r.roomId))];
  if (roomIds.length === 0) return [];
  const validRooms = await db.chatRoom.findMany({ where: { id: { in: roomIds }, type: 'GROUP', deletedAt: null }, select: { id: true } });
  const validRoomIds = validRooms.map((r) => r.id);
  if (validRoomIds.length === 0) return [];
  const groups = await db.investorChatGroup.findMany({
    where: { roomId: { in: validRoomIds }, unassignedAt: null },
    select: { investorId: true }
  });
  return [...new Set(groups.map((g) => g.investorId))];
}
