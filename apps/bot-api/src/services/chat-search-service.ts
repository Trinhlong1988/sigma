// SIGMA (1/8, B103 — bug NGHIÊM TRỌNG Admin Demo báo trực tiếp) — tìm kiếm tin nhắn THẬT qua DB, thay
// ChatListScreen.tsx tìm trên mock CHAT_ROOMS/MESSAGES_BY_ROOM cũ. Phát hiện: nhắn tin thật có dấu "."/chữ
// "hi" tìm không ra, chỉ thấy dữ liệu Claude tự tạo để verify (chính là mock đó) — panel tìm kiếm toàn cục
// (mục 33) CHƯA BAO GIỜ nối qua hệ chat lõi thật (chat_messages), dù danh sách chat chính đã cutover từ 29/7.
import { type Db } from '@sigma/database';

export interface MessageSearchHit {
  messageId: string;
  roomId: string;
  roomName: string | null; // null cho phòng DIRECT chưa đặt tên — client tự resolve tên đối phương (CÙNG buildAgentNameResolver()).
  roomType: string;
  senderId: number | null;
  snippet: string;
  createdAt: Date;
}

const MAX_RESULTS = 30;
// DB thật (`sigma`) khởi tạo locale "C" (mặc định Postgres trên Windows) — tự kiểm tra trực tiếp xác nhận
// `ILIKE`/`lower()` phía SQL KHÔNG hạ chữ hoa đúng cho ký tự có dấu tiếng Việt (vd `lower('CHÀO')` trả về
// `"chÀo"`, giữ nguyên À hoa — chỉ ASCII a-z được fold). Đổi collation DB là thay đổi hạ tầng lớn (ALTER
// DATABASE cần recreate từ template0, ảnh hưởng sort/index toàn hệ thống) — NGOÀI PHẠM VI fix bug này, không
// tự ý làm. Fix ở TẦNG JS: lọc so khớp bằng `.toLowerCase()` của Node (V8 xử lý Unicode đúng, xác nhận
// `'CHÀO'.toLowerCase() === 'chào'` → true) thay vì đẩy so khớp xuống SQL.
//
// Đánh đổi CÓ CHỦ ĐÍCH (ghi rõ, không giấu — R196): quét CAP `CANDIDATE_SCAN_LIMIT` tin nhắn GẦN NHẤT trong
// các phòng của agent rồi lọc JS, KHÔNG phải toàn bộ lịch sử vô hạn — với quy mô đội ngũ đại lý nội bộ (không
// phải app nhắn tin đại chúng), đây là NGƯỠNG ĐỦ RỘNG cho usage thật; nếu sau này 1 phòng có lịch sử cực lớn,
// tin quá cũ ngoài ngưỡng có thể không lọt vào kết quả tìm kiếm — CHƯA gặp thật, ghi nhận làm giới hạn đã biết.
const CANDIDATE_SCAN_LIMIT = 3000;

/** Tìm tin nhắn TEXT (chưa thu hồi) có nội dung chứa `q` (không phân biệt hoa/thường, ĐÚNG cho cả tiếng Việt
 * có dấu — xem giải thích CANDIDATE_SCAN_LIMIT ở trên) — CHỈ trong các phòng `requesterAgentId` đang là thành
 * viên HOẠT ĐỘNG (leftAt null, phòng chưa xóa) — tuyệt đối KHÔNG lộ tin nhắn phòng agent không thuộc về (CÙNG
 * nguyên tắc an ninh assertActiveMember() toàn bộ module chat-room-service.ts, KHÔNG viết lại kiểm tra quyền
 * lần 2 — chỉ query trực tiếp theo danh sách roomId đã lọc quyền). Rỗng/toàn khoảng trắng → trả [] ngay.
 *
 * `roomId` tùy chọn (B107, 2/8 — Admin Demo yêu cầu tìm kiếm NGAY TRONG 1 khung chat, kiểu Zalo, có bộ đếm
 * "15/15" + điều hướng lên/xuống) — CHỈ tìm trong 1 phòng cụ thể thay vì gộp tất cả phòng. Vẫn PHẢI qua đúng
 * danh sách phòng agent đang là thành viên (roomId lạ/không phải thành viên → coi như [] rỗng, KHÔNG throw —
 * caller (route) đã tự `assertActiveMember` trước khi gọi tới đây cho nhánh có roomId, xem routes/chat.ts). */
export async function searchMessages(db: Db, requesterAgentId: number, q: string, roomId?: string): Promise<MessageSearchHit[]> {
  const term = q.trim();
  if (term.length === 0) return [];
  const termLower = term.toLowerCase();

  const memberships = await db.chatRoomMember.findMany({
    where: { agentId: requesterAgentId, leftAt: null, room: { deletedAt: null }, ...(roomId ? { roomId } : {}) },
    select: { roomId: true, room: { select: { name: true, type: true } } }
  });
  if (memberships.length === 0) return [];
  const roomMeta = new Map(memberships.map((m) => [m.roomId, { name: m.room.name, type: m.room.type }]));

  const candidates = await db.chatMessage.findMany({
    where: { roomId: { in: [...roomMeta.keys()] }, kind: 'TEXT', deletedAt: null, body: { not: null } },
    select: { id: true, roomId: true, senderId: true, body: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: CANDIDATE_SCAN_LIMIT
  });

  const hits: MessageSearchHit[] = [];
  for (const r of candidates) {
    if (!r.body || !r.body.toLowerCase().includes(termLower)) continue;
    const meta = roomMeta.get(r.roomId);
    hits.push({
      messageId: r.id,
      roomId: r.roomId,
      roomName: meta?.name ?? null,
      roomType: meta?.type ?? 'DIRECT',
      senderId: r.senderId,
      snippet: r.body,
      createdAt: r.createdAt
    });
    if (hits.length >= MAX_RESULTS) break;
  }
  return hits;
}
