// SIGMA Phase 2 (29/7) — chat lõi tự xây, reaction (thả cảm xúc) trên tin nhắn (ChatMessageReaction). Xem
// chat-room-service.ts đầu file cho bối cảnh chung.
import type { Db } from '@sigma/database';
import { assertActiveMember, ChatServiceError } from './chat-room-service.js';

export type ChatReactionAction = 'added' | 'removed' | 'changed';

// Audit độc lập 29/7 (MEDIUM): chưa có chặn độ dài — client bất kỳ có thể gửi 1 chuỗi rất dài làm "emoji" (mỗi
// agent chỉ 1 hàng/1 tin nhắn nhờ @@unique nên không phình DB nhanh, nhưng vẫn phá layout UI/không hợp lệ).
// Audit độc lập ĐỢT 2 (29/7, LOW — đã tự chạy `node -e` xác nhận bằng số thật, không đoán): đếm bằng `.length`
// (UTF-16 code unit) từ chối NHẦM emoji ghép hợp lệ phổ biến — `'👨‍👩‍👧‍👦'.length === 11` (gia đình 4 người),
// vượt ngưỡng cũ 8. Đổi sang đếm CODE POINT (`[...emoji].length`, đúng cách JS lặp qua ký tự Unicode thật, gộp
// đúng surrogate pair) — gia đình 4 người = 7 code point (4 người + 3 dấu nối ZWJ, ZWJ tự nó CŨNG là 1 code
// point riêng dù không hiển thị). Nới ngưỡng lên 12 code point, đủ dư cho ZWJ-sequence dài nhất phổ biến.
const MAX_EMOJI_CODEPOINTS = 12;

export interface ToggleReactionResult<TReaction> {
  action: ChatReactionAction;
  reaction: TReaction | null;
}

/** Map TRỰC TIẾP model Prisma `ChatMessageReaction` (CÙNG shape trả về từ `toggleReaction()` ở trên) — khai rõ
 * ràng thay vì generic ẩn danh, cho `listReactionsForMessages()` dưới đây có kiểu trả cụ thể mà route/test dùng
 * được ngay không cần ép kiểu. */
export interface ChatMessageReactionRow {
  id: number;
  messageId: string;
  agentId: number;
  emoji: string;
  createdAt: Date;
}

/** QUY TẮC ĐÃ CHỐT VỚI Admin Demo (29/7, KHÔNG suy đoán): 1 agent CHỈ 1 reaction/1 tin nhắn
 * (`@@unique([messageId, agentId])`, schema.prisma). Gọi lại:
 *  - CHƯA có reaction của agent này trên tin đó → tạo mới, action='added'.
 *  - ĐÃ có VÀ emoji TRÙNG emoji hiện tại → xóa (unlike), action='removed', reaction=null.
 *  - ĐÃ có VÀ emoji KHÁC → đổi emoji (update), action='changed'.
 * Độc lập tuyệt đối theo TỪNG tin nhắn (1 agent có reaction ở hàng trăm tin khác nhau cùng lúc, không giới hạn).
 *
 * THÊM (quyết định thiết kế của LEAD lúc build, brief không nói rõ toggleReaction có cần kiểm thành viên phòng
 * hay không — chỉ mô tả logic 3 nhánh added/removed/changed): vẫn gọi `assertActiveMember()` trước khi cho phép
 * reaction, để tránh 1 agent KHÔNG thuộc phòng nào đó vẫn thả được cảm xúc lên tin nhắn của phòng mình không có
 * quyền xem — CÙNG nguyên tắc "PHẢI là thành viên mới thao tác được" áp dụng xuyên suốt sendMessage/
 * listMessages/markRead. Không đổi chữ ký hàm (vẫn (db, messageId, agentId, emoji)), chỉ thêm 1 nhánh lỗi
 * NOT_MEMBER có thể ném ra — LEAD review lại nếu không muốn áp giới hạn này. */
export async function toggleReaction(db: Db, messageId: string, agentId: number, emoji: string) {
  const trimmedEmoji = emoji?.trim() ?? '';
  if (!trimmedEmoji) {
    throw new ChatServiceError('VALIDATION', 'emoji không được để trống.');
  }
  if ([...trimmedEmoji].length > MAX_EMOJI_CODEPOINTS) {
    throw new ChatServiceError('VALIDATION', `emoji tối đa ${MAX_EMOJI_CODEPOINTS} code point.`);
  }

  const message = await db.chatMessage.findUnique({ where: { id: messageId } });
  if (!message || message.deletedAt !== null) {
    throw new ChatServiceError('NOT_FOUND', `Tin nhắn id=${messageId} không tồn tại.`);
  }
  await assertActiveMember(db, message.roomId, agentId);

  const existing = await db.chatMessageReaction.findUnique({ where: { messageId_agentId: { messageId, agentId } } });

  if (!existing) {
    const created = await db.chatMessageReaction.create({ data: { messageId, agentId, emoji: trimmedEmoji } });
    return { action: 'added' as const, reaction: created };
  }

  if (existing.emoji === trimmedEmoji) {
    await db.chatMessageReaction.delete({ where: { id: existing.id } });
    return { action: 'removed' as const, reaction: null };
  }

  const updated = await db.chatMessageReaction.update({ where: { id: existing.id }, data: { emoji: trimmedEmoji } });
  return { action: 'changed' as const, reaction: updated };
}

/** debt-chat-gaps (31/7, Việc 1) — khôi phục lịch sử reaction khi tải lại trang: `toggleReaction()` chỉ trả
 * ĐÚNG 1 reaction vừa đổi (real-time), KHÔNG có cách nào lấy TOÀN BỘ reaction hiện có của N tin nhắn cùng lúc
 * (GAP đã ghi ở ConversationScreen.tsx `reactionsByMessageRef` + báo cáo Phase 3). Hàm này gom TẤT CẢ reaction
 * của danh sách `messageIds` bằng ĐÚNG 1 câu query (`findMany({where:{messageId:{in:...}}})`) rồi group theo
 * messageId — TRÁNH N+1 (không query riêng từng tin nhắn). KHÔNG kiểm quyền thành viên phòng ở đây (route gọi
 * hàm này PHẢI tự `assertActiveMember()` + lọc `messageIds` thuộc ĐÚNG phòng đó TRƯỚC khi gọi — xem
 * routes/chat.ts GET .../messages/reactions, cùng nguyên tắc chống rò rỉ cross-room đã áp cho cursor `before`
 * ở listMessages(), chat-message-service.ts). `messageIds` rỗng → trả Map rỗng ngay, không query. */
export async function listReactionsForMessages(db: Db, messageIds: string[]): Promise<Map<string, ChatMessageReactionRow[]>> {
  const map = new Map<string, ChatMessageReactionRow[]>();
  if (messageIds.length === 0) return map;
  const rows = await db.chatMessageReaction.findMany({
    where: { messageId: { in: messageIds } },
    orderBy: { createdAt: 'asc' }
  });
  for (const row of rows) {
    const list = map.get(row.messageId);
    if (list) list.push(row);
    else map.set(row.messageId, [row]);
  }
  return map;
}
