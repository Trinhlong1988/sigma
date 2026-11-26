// GẮN TID VÀO PHÒNG CHAT SIGMA — LÕI THUẦN nhận `db` PARAM (PORT nguyên nghiệp vụ từ
// apps/desktop/src/main/chat-room-tid-service.ts; desktop file vốn đã thuần, chỉ import type Db — không guard/
// Electron). Đưa vào @sigma/services để CẢ desktop LẪN quanly-api dùng CHUNG, KHÔNG để tid.ts phụ thuộc desktop.
//
// RÀNG BUỘC nghiệp vụ GIỮ NGUYÊN như desktop/bot-api:
//   • 1 TID chỉ ĐANG gắn (active) 1 phòng tại 1 thời điểm — DB ép bằng partial unique index
//     chat_room_tids_tid_id_active_key (WHERE unlinked_at IS NULL).
//   • Gỡ = SOFT-unlink (SET unlinked_at, KHÔNG xóa hàng) — giữ lịch sử để báo cáo doanh số theo nhóm chat.
//   • AUTO-MOVE khi TID đang active ở phòng KHÁC (gọi từ 1 sự kiện giao/gán TID thật, không phải click nhầm):
//     soft-unlink phòng cũ rồi gắn phòng mới, KHÔNG chặn luồng giao TID giữa chừng.
//   • BẤT BIẾN room↔khách: phòng PHẢI thuộc Customer.agentId của khách đang giao (chống "cướp doanh số").
//   `createdBy`/`unlinkedBy` để NULL (nhân sự thao tác là User, không có agentId Agent) — "ai làm" ghi ở audit
//   log của caller (tid.ts, actorUserId = ctx.user.id), KHÔNG audit ở file này (tránh audit 2 lần).
import type { Db } from '@sigma/database';

/** Kiểu param CHUNG cho cả Db đầy đủ LẪN Prisma.TransactionClient trong $transaction — cho phép gọi
 *  linkTidToRoomForDelivery() NGAY TRONG transaction giao/gán TID của caller, ATOMIC (lỗi gắn phòng rollback
 *  luôn cả thao tác giao TID). */
type ChatRoomTidDb = Pick<Db, 'chatRoomTid' | 'customer' | 'chatRoomMember'>;

export interface ChatRoomOptionDto {
  roomId: string;
  type: string; // 'DIRECT' | 'GROUP'
  displayName: string;
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/**
 * Lỗi RACE gắn phòng chat (partial-unique P2002 chặn ở DB): 2 giao dịch cùng lúc gắn cùng 1 TID vào 2 phòng
 * khác nhau. Caller nên map sang CONFLICT/"thử lại" (KHÔNG để rơi 500). Là subclass Error nên caller cũ vẫn bắt
 * được như Error bình thường (message giữ nguyên) — chỉ caller MUỐN xử lý riêng mới `instanceof` được.
 */
export class ChatRoomTidConflictError extends Error {
  readonly conflict = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'ChatRoomTidConflictError';
  }
}

/**
 * Danh sách phòng chat SigMa của đại lý phụ trách 1 khách hàng — Customer.agentId → ChatRoomMember đang
 * hoạt động (leftAt null) của Agent đó. Customer CHƯA gắn agentId (null) → trả mảng rỗng (KHÔNG phải lỗi).
 * 1 Agent có thể ở NHIỀU phòng → trả ĐỦ danh sách, KHÔNG tự đoán chọn 1 phòng "đúng nhất".
 */
export async function listChatRoomsForCustomer(db: Db, customerId: number): Promise<ChatRoomOptionDto[]> {
  if (!Number.isInteger(customerId) || customerId <= 0) return [];
  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { agentId: true } });
  if (!customer || customer.agentId == null) return [];

  const memberships = await db.chatRoomMember.findMany({ where: { agentId: customer.agentId, leftAt: null }, select: { roomId: true } });
  if (memberships.length === 0) return [];
  const roomIds = [...new Set(memberships.map((m) => m.roomId))];
  const rooms = await db.chatRoom.findMany({ where: { id: { in: roomIds }, deletedAt: null } });
  if (rooms.length === 0) return [];

  // Phòng DIRECT không có `name` (suy ra từ đối phương) — tự tra tên Agent đối phương để dropdown dễ đọc.
  const directRoomIds = rooms.filter((r) => r.type === 'DIRECT').map((r) => r.id);
  const otherAgentIdByRoom = new Map<string, number>();
  if (directRoomIds.length > 0) {
    const otherMembers = await db.chatRoomMember.findMany({
      where: { roomId: { in: directRoomIds }, agentId: { not: customer.agentId }, leftAt: null }
    });
    for (const m of otherMembers) otherAgentIdByRoom.set(m.roomId, m.agentId);
  }
  const otherAgentIds = [...new Set([...otherAgentIdByRoom.values()])];
  const otherAgents = otherAgentIds.length > 0 ? await db.agent.findMany({ where: { id: { in: otherAgentIds } }, select: { id: true, name: true } }) : [];
  const otherAgentNameById = new Map(otherAgents.map((a) => [a.id, a.name]));

  return rooms
    .map((r) => {
      if (r.type === 'DIRECT') {
        const otherId = otherAgentIdByRoom.get(r.id);
        const otherName = otherId != null ? otherAgentNameById.get(otherId) : undefined;
        return { roomId: r.id, type: r.type, displayName: otherName ? `Chat riêng · ${otherName}` : 'Chat riêng (chưa rõ đối phương)' };
      }
      return { roomId: r.id, type: r.type, displayName: r.name?.trim() || 'Nhóm chưa đặt tên' };
    })
    .sort((a, b) => a.displayName.localeCompare(b.displayName, 'vi'));
}

/** Validate roomId tồn tại + còn sống (KHÔNG soft-deleted) — gọi TRƯỚC $transaction ở tid.ts (pre-check ngoài
 *  transaction, lỗi rõ trước khi mở giao dịch). */
export async function assertChatRoomExists(db: Db, roomId: string): Promise<boolean> {
  const room = await db.chatRoom.findUnique({ where: { id: roomId }, select: { id: true, deletedAt: true } });
  return !!room && room.deletedAt == null;
}

export interface LinkTidToRoomResult {
  moved: boolean; // true nếu TID đang active ở phòng KHÁC, đã tự gỡ (soft) rồi gắn phòng mới
  previousRoomId: string | null;
}

/**
 * Gắn TID vào phòng chat — gọi TỪ BÊN TRONG luồng giao/gán TID cho khách. KHÔNG tự guard quyền (caller đã đòi
 * TID_MANAGE) và KHÔNG tự validate roomId tồn tại (caller PHẢI gọi assertChatRoomExists() trước, NGOÀI
 * transaction). `db` truyền vào có thể là `tx` để ATOMIC với chính thao tác giao TID. `customerId` = khách đang
 * được giao TID — ép BẤT BIẾN room↔khách.
 */
export async function linkTidToRoomForDelivery(db: ChatRoomTidDb, tidId: number, roomId: string, customerId: number): Promise<LinkTidToRoomResult> {
  // BẤT BIẾN room↔khách — phòng PHẢI thuộc ĐÚNG khách đang giao (roomId ∈ tập phòng của Customer.agentId). CHẶN
  // lớp "cướp doanh số theo giai đoạn": nhân sự đổi customerId nhưng chatRoomId vẫn GIỮ giá trị CŨ (phòng khách
  // khác) → nếu không kiểm, doanh số TID của khách mới bị gắn nhầm vào phòng khách cũ.
  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { agentId: true } });
  if (!customer || customer.agentId == null) {
    throw new Error(`Khách hàng #${customerId} chưa gắn đại lý SigMa nên không có phòng chat để gắn TID — bỏ chọn phòng chat hoặc gắn đại lý cho khách trước.`);
  }
  const membership = await db.chatRoomMember.findFirst({
    where: { roomId, agentId: customer.agentId, leftAt: null },
    select: { id: true }
  });
  if (!membership) {
    throw new Error(`Phòng chat đã chọn KHÔNG thuộc khách hàng #${customerId} — chọn lại đúng phòng của khách này (tránh gắn nhầm doanh số sang phòng khách khác).`);
  }

  const existing = await db.chatRoomTid.findFirst({ where: { tidId, unlinkedAt: null } });
  if (existing && existing.roomId === roomId) {
    return { moved: false, previousRoomId: null }; // đã đúng phòng này rồi — idempotent, không tạo hàng mới.
  }
  if (existing) {
    // AUTO-MOVE: soft-unlink phòng cũ, GIỮ lại làm lịch sử.
    await db.chatRoomTid.update({ where: { id: existing.id }, data: { unlinkedAt: new Date(), unlinkedBy: null } });
  }
  try {
    await db.chatRoomTid.create({ data: { roomId, tidId, createdBy: null } });
  } catch (err) {
    // Race hiếm (2 giao dịch cùng lúc gắn cùng TID vào 2 phòng khác nhau) — partial unique index chặn ở DB.
    if (isUniqueViolation(err)) {
      throw new ChatRoomTidConflictError(`TID id=${tidId} vừa được gắn vào phòng chat khác cùng lúc — vui lòng thử lại thao tác.`);
    }
    throw err;
  }
  return { moved: existing != null, previousRoomId: existing?.roomId ?? null };
}

/**
 * Soft-unlink phòng chat ĐANG active của 1 TID (SET unlinked_at, GIỮ hàng làm lịch sử). Dùng khi TID KHÔNG còn
 * gắn khách/phòng nào (thu hồi máy reset, đổi khách sang khách không có phòng…). Trả previousRoomId nếu có.
 */
export async function unlinkActiveTidRoom(db: Pick<Db, 'chatRoomTid'>, tidId: number, unlinkedBy: number | null = null): Promise<string | null> {
  const existing = await db.chatRoomTid.findFirst({ where: { tidId, unlinkedAt: null } });
  if (!existing) return null;
  await db.chatRoomTid.update({ where: { id: existing.id }, data: { unlinkedAt: new Date(), unlinkedBy } });
  return existing.roomId;
}

/** Danh sách roomId active (leftAt null, phòng còn sống) của đại lý phụ trách 1 khách — rút gọn cho auto-relink. */
async function activeRoomIdsForCustomer(db: Pick<Db, 'customer' | 'chatRoomMember' | 'chatRoom'>, customerId: number): Promise<string[]> {
  const customer = await db.customer.findUnique({ where: { id: customerId }, select: { agentId: true } });
  if (!customer || customer.agentId == null) return [];
  const memberships = await db.chatRoomMember.findMany({ where: { agentId: customer.agentId, leftAt: null }, select: { roomId: true } });
  const roomIds = [...new Set(memberships.map((m) => m.roomId))];
  if (roomIds.length === 0) return [];
  const rooms = await db.chatRoom.findMany({ where: { id: { in: roomIds }, deletedAt: null }, select: { id: true } });
  return rooms.map((r) => r.id).sort();
}

type ChatRoomMoveDb = Pick<Db, 'chatRoomTid' | 'customer' | 'chatRoomMember' | 'chatRoom'>;

/**
 * ĐỔI KHÁCH giữ máy (POS changeCustomer) — TID đi theo khách MỚI: soft-unlink phòng khách CŨ + relink phòng khách
 * MỚI (chống "cướp doanh số" — doanh số TID không còn dồn về phòng của khách cũ). Chọn phòng mới KHI xác định DUY
 * NHẤT (đại lý khách mới có ĐÚNG 1 phòng active); nếu khách mới CHƯA gắn đại lý / KHÔNG có phòng / có NHIỀU phòng
 * (mơ hồ) → CHỈ unlink phòng cũ (không tự đoán phòng, tránh gắn nhầm doanh số). Idempotent.
 */
export async function relinkTidRoomOnCustomerChange(db: ChatRoomMoveDb, tidId: number, newCustomerId: number): Promise<LinkTidToRoomResult> {
  const rooms = await activeRoomIdsForCustomer(db, newCustomerId);
  if (rooms.length === 1) {
    // linkTidToRoomForDelivery tự soft-unlink phòng cũ + link phòng mới + ép bất biến room↔khách (đã kiểm membership).
    return linkTidToRoomForDelivery(db, tidId, rooms[0]!, newCustomerId);
  }
  const previousRoomId = await unlinkActiveTidRoom(db, tidId);
  return { moved: previousRoomId != null, previousRoomId };
}
