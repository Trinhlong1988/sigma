// Màu avatar ổn định — NGUỒN DUY NHẤT (Việc 2, debt-chat-gaps 1/8).
//
// BỐI CẢNH BUG: Admin Demo báo agent "Nam" hiện avatar màu ĐỎ ở ContactsScreen.tsx nhưng màu XANH ở
// ConversationScreen.tsx/ChatListScreen.tsx (qua chat-client.ts) — điều tra thấy CÓ 4 bản cài đặt hash màu
// avatar copy-paste khác nhau trong codebase, KHÔNG bản nào dùng chung:
//   1. ContactsScreen.tsx `colorForAgent(id)` — modulo THÔ `id % palette.length` (KHÔNG hash, phân bố lệch).
//   2. chat-client.ts `colorForId(dto.id)` — hash polynomial nhưng key theo **room id (cuid)**, KHÔNG PHẢI
//      agentId — với phòng DIRECT, roomId không liên quan gì tới danh tính đối phương → màu hiển thị ở
//      ChatListScreen/ConversationScreen/CallScreen/... hoàn toàn độc lập với màu ở ContactsScreen dù CÙNG 1
//      agent, đây là nguyên nhân CHÍNH gây lệch màu Admin Demo thấy.
//   3. GroupInfoPanel.tsx `colorForMember(id)` — hash polynomial đúng khóa agentId nhưng công thức tách biệt
//      (khác bản #2 dù cùng ý tưởng).
//   4. PublicProfileScreen.tsx `colorForUsername(username)` — hash polynomial theo rcUsername (màn này CHƯA
//      resolve được agentId SigMa tại thời điểm render avatar — chỉ có dữ liệu Rocket.Chat, xem comment
//      đầu file đó — giữ khóa string riêng là hợp lý, KHÔNG gộp về agentId được ở đây).
//
// HỢP NHẤT: đúng 1 palette + đúng 1 hash polynomial. `avatarColorForAgent(agentId)` PHẢI được dùng ở MỌI nơi
// hiển thị avatar gắn với 1 agent CỤ THỂ đã biết agentId (kể cả khi đó là "đối phương" của 1 phòng DIRECT —
// dùng `otherAgentId` của phòng, KHÔNG dùng `roomId`). `avatarColorForKey(key)` CHỈ dùng khi thật sự chưa có
// agentId số (vd PublicProfileScreen theo username) hoặc màu PHÒNG NHÓM tự sinh khi GROUP chưa đặt
// avatarColor riêng (phòng nhóm không đại diện 1 người, không có agentId nào phù hợp để dùng).
const AVATAR_PALETTE: readonly string[] = [
  '#16a34a',
  '#0579cc',
  '#f59e0b',
  '#dc2626',
  '#0891b2',
  '#7c3aed',
  '#db2777',
  '#65a30d'
];

function hashString(key: string): number {
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return hash;
}

/** Màu avatar ổn định cho 1 agent (contact/thành viên) — khóa DUY NHẤT là agentId. MỌI nơi hiển thị avatar
 * của 1 agent cụ thể (Danh bạ, thành viên nhóm, đối phương phòng DIRECT, hồ sơ...) PHẢI gọi hàm này thay vì tự
 * viết hash riêng — đảm bảo CÙNG 1 agentId luôn ra CÙNG 1 màu ở mọi màn hình. */
export function avatarColorForAgent(agentId: number): string {
  return AVATAR_PALETTE[hashString(String(agentId)) % AVATAR_PALETTE.length];
}

/** Màu ổn định theo khóa chuỗi bất kỳ — CHỈ dùng khi chưa có agentId số (vd tra theo rcUsername trước khi
 * link agent) hoặc màu tự sinh cho phòng NHÓM (không đại diện 1 người). KHÔNG dùng cho phòng DIRECT — phòng
 * DIRECT đại diện đúng 1 người (đối phương), phải dùng `avatarColorForAgent(otherAgentId)`. */
export function avatarColorForKey(key: string): string {
  return AVATAR_PALETTE[hashString(key) % AVATAR_PALETTE.length];
}

export { AVATAR_PALETTE };
