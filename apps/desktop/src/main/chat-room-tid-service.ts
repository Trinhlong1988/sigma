// GẮN TID VÀO PHÒNG CHAT SIGMA (Admin Demo 3/8, 2 lần chỉnh hướng qua LEAD trong lúc build — xem
// BUGS_FIXED.md Bxxx). KHÔNG xây trang/route bot-api riêng — tích hợp thẳng vào luồng giao/gán TID cho khách
// hàng ĐÃ CÓ SẴN (assignTid/markTidDelivered/createTidUnified, tid-service.ts). Nguyên văn Admin Demo: "TID gắn
// phòng chat bản chất là TID khi đi cho khách hàng, đã có sẵn cơ chế rồi mà, chỉ link vào khi cấu hình ID
// thông tin phòng chat của khách hàng đó thôi" + "chỉ cần tự đồng bộ khi giao đi và giao cho user khách hàng
// nào, link với chat alpha".
//
// Bảng chat_room_tids (Prisma ChatRoomTid) + ChatRoom/ChatRoomMember ĐÃ CÓ SẴN — apps/bot-api tạo/dùng cho
// SigMa tự phục vụ (đại lý tự gắn TID CỦA CHÍNH HỌ, xem apps/bot-api/src/services/chat-room-tid-
// service.ts). Desktop KHÔNG gọi bot-api qua HTTP: main process ở đây dùng THẲNG Prisma (@sigma/database),
// GIỐNG MỌI service khác trong apps/desktop/src/main/*.ts (đã tự kiểm tra tid-service.ts/pos-service.ts/
// agent-qr-service.ts/... — không file nào trong desktop gọi HTTP sang bot-api, 2 app chỉ dùng CHUNG database
// qua Prisma, không dùng chung code service). File này VIẾT LẠI cho desktop, TÁI DÙNG Ý NGHĨA + RÀNG BUỘC
// NGHIỆP VỤ của bản bot-api — không import chéo app (2 tiến trình khác nhau, không cùng workspace dependency).
//
// RÀNG BUỘC nghiệp vụ giữ NGUYÊN như bot-api (đọc kỹ chat-room-tid-service.ts bên đó trước khi sửa file này):
//   • 1 TID chỉ ĐANG gắn (active) 1 phòng tại 1 thời điểm — DB ép bằng partial unique index
//     chat_room_tids_tid_id_active_key (WHERE unlinked_at IS NULL).
//   • Gỡ = SOFT-unlink (SET unlinked_at, KHÔNG xóa hàng) — giữ lịch sử để báo cáo "Doanh số theo nhóm chat"
//     bên bot-api (getRoomRevenueReport) tính đúng theo MỐC THỜI GIAN gắn/gỡ, không "cướp" doanh số quá khứ
//     của phòng trước khi TID chuyển phòng.
//
// KHÁC bot-api ở 2 điểm CHỦ Ý (actor là NHÂN SỰ SigMa thao tác trên desktop, không phải chính đại lý sở hữu
// TID tự phục vụ trên SigMa):
//   1. KHÔNG có assertActiveMember(roomId, requesterAgentId) — nhân sự không phải thành viên phòng chat của
//      khách, không có agentId của chính mình để kiểm theo kiểu đó. Quyền chặn ở ĐÂY = permission desktop
//      (TID_MANAGE) đã đòi tại assignTid/markTidDelivered/createTidUnified TRƯỚC KHI gọi tới hàm ở file này.
//   2. AUTO-MOVE khi TID đang active ở phòng KHÁC: bot-api (tự phục vụ, dễ bấm nhầm) CHẶN + bắt gỡ tay trước
//      (TID_ALREADY_LINKED). Ở đây hàm được gọi TỪ 1 sự kiện giao/gán TID cho khách CỤ THỂ vừa xảy ra thật
//      (không phải click nhầm) — nếu khách mới khác khách cũ, phòng chat đúng cũng đổi theo → tự gỡ (soft)
//      phòng cũ rồi gắn phòng mới, KHÔNG chặn luồng giao TID giữa chừng.
//   `createdBy`/`unlinkedBy` (2 cột kiểu agentId theo comment schema.prisma — "agentId thực hiện gán/gỡ") để
//   NULL khi nhân sự thao tác (không có agentId đúng nghĩa để điền, nhân sự là User desktop, KHÔNG phải
//   Agent) — "ai làm" được ghi vào audit log RIÊNG của desktop (writeAudit, actorUserId = user.id) tại nơi
//   gọi (tid-service.ts), giống mọi thao tác khác trong app này — KHÔNG lồng ghi audit ở file này để tránh
//   audit 2 lần cho cùng 1 thao tác giao TID (audit chính đã có sẵn ở assignTid/markTidDelivered/
//   createTidUnified, chỉ cần thêm chi tiết "đã gắn/chuyển phòng chat nào" vào snapshot `after` của audit đó).
import type { Db } from '@sigma/database';

/** Kiểu param CHUNG cho cả Db đầy đủ LẪN Prisma.TransactionClient trong $transaction (CÙNG khuôn AuditDb ở
 *  audit.ts) — cho phép gọi linkTidToRoomForDelivery() NGAY TRONG transaction giao/gán TID của caller, ATOMIC
 *  (lỗi gắn phòng chat rollback luôn cả thao tác giao TID, không để lệch nửa chừng). */
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
 * Danh sách phòng chat SigMa của đại lý phụ trách 1 khách hàng — Customer.agentId → ChatRoomMember đang
 * hoạt động (leftAt null) của Agent đó. Customer CHƯA gắn agentId (null) → trả mảng rỗng (KHÔNG phải lỗi —
 * nhân sự vẫn giao TID bình thường, chỉ là không có gợi ý phòng nào). 1 Agent có thể ở NHIỀU phòng (DIRECT
 * lẫn GROUP) → trả ĐỦ danh sách, KHÔNG tự đoán chọn 1 phòng "đúng nhất" (Admin Demo chốt trực tiếp 3/8: để nhân
 * sự tự chọn khi có nhiều lựa chọn).
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

  // Phòng DIRECT không có `name` (suy ra từ đối phương, CÙNG quy ước chat-room-service.ts bên bot-api) — tự
  // tra tên Agent đối phương để dropdown có nhãn dễ đọc (service RIÊNG của desktop, không tái dùng route đó).
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

/** Validate roomId tồn tại + còn sống (KHÔNG soft-deleted) — gọi TRƯỚC $transaction ở tid-service.ts, CÙNG
 *  khuôn validate customerId/toAgentId hiện có ở đó (pre-check ngoài transaction, lỗi rõ trước khi mở giao
 *  dịch, không phải rollback giữa chừng vì lỗi có thể biết trước). */
export async function assertChatRoomExists(db: Db, roomId: string): Promise<boolean> {
  const room = await db.chatRoom.findUnique({ where: { id: roomId }, select: { id: true, deletedAt: true } });
  return !!room && room.deletedAt == null;
}

export interface LinkTidToRoomResult {
  moved: boolean; // true nếu TID đang active ở phòng KHÁC, đã tự gỡ (soft) rồi gắn phòng mới
  previousRoomId: string | null;
}

/**
 * Gắn TID vào phòng chat — gọi TỪ BÊN TRONG luồng giao/gán TID cho khách (assignTid/markTidDelivered/
 * createTidUnified, tid-service.ts). KHÔNG tự guard quyền (caller đã đòi TID_MANAGE trước khi gọi tới đây) và
 * KHÔNG tự validate roomId tồn tại (caller PHẢI gọi assertChatRoomExists() trước, NGOÀI transaction — tránh 1
 * round-trip DB thừa trong tx vì roomId luôn đến từ listChatRoomsForCustomer() nhân sự vừa chọn).
 *
 * `db` truyền vào có thể là `tx` (Prisma.TransactionClient trong $transaction của caller) để ATOMIC với
 * chính thao tác giao TID.
 *
 * `customerId` = khách hàng ĐANG được giao TID trong thao tác này — dùng để ép BẤT BIẾN room↔khách bên dưới.
 */
export async function linkTidToRoomForDelivery(db: ChatRoomTidDb, tidId: number, roomId: string, customerId: number): Promise<LinkTidToRoomResult> {
  // BẤT BIẾN room↔khách (LANE C Vòng 2 / B124, 3/8) — phòng PHẢI thuộc ĐÚNG khách đang giao: roomId phải nằm
  // trong tập phòng của Customer.agentId (CÙNG quy tắc listChatRoomsForCustomer() dựng dropdown: agent của khách
  // là thành viên đang hoạt động của phòng). CHẶN lớp "cướp doanh số theo giai đoạn": nhân sự đổi customerId trên
  // form nhưng chatRoomId vẫn GIỮ giá trị CŨ (phòng của khách KHÁC) → nếu không kiểm, doanh số TID của khách mới
  // bị gắn nhầm vào phòng khách cũ (getRoomRevenueReport quy doanh số theo phòng đang gắn). Bản bot-api ép bằng
  // assertActiveMember(room, tid.agentId) + tid.agentId===requester (tự phục vụ); bản desktop (NHÂN SỰ thao tác,
  // không phải thành viên phòng) ép tương đương qua Customer.agentId. roomId đã được caller assertChatRoomExists()
  // (còn sống) — ở đây chỉ thêm ràng buộc QUYỀN-SỞ-HỮU phòng theo khách, KHÔNG nới lỏng kiểm tồn tại.
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
    // AUTO-MOVE (khác bot-api tự phục vụ — xem comment đầu file): soft-unlink phòng cũ, GIỮ lại làm lịch sử.
    await db.chatRoomTid.update({ where: { id: existing.id }, data: { unlinkedAt: new Date(), unlinkedBy: null } });
  }
  try {
    await db.chatRoomTid.create({ data: { roomId, tidId, createdBy: null } });
  } catch (err) {
    // Race hiếm (2 giao dịch cùng lúc gắn cùng TID vào 2 phòng khác nhau) — partial unique index chặn ở DB.
    // KHÔNG có "đọc lại rồi coi là thành công" hợp lý ở đây như bot-api (đó là 1 người tự bấm 2 lần idempotent
    // — ở đây là 2 giao dịch NGHIỆP VỤ khác nhau tranh nhau) → ném lỗi rõ để rollback + nhân sự thử lại.
    if (isUniqueViolation(err)) {
      throw new Error(`TID id=${tidId} vừa được gắn vào phòng chat khác cùng lúc — vui lòng thử lại thao tác.`);
    }
    throw err;
  }
  return { moved: existing != null, previousRoomId: existing?.roomId ?? null };
}
