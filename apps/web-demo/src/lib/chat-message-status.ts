// Logic THUẦN (không I/O, không React) cho 3 bug chat 5/8 — tách riêng để test được KHÔNG cần dựng WebSocket/
// component (CÙNG quy ước `parseChatNotifyPayload()` chat-realtime.ts / `computeReconnectDelay()`):
//   - Bug #1: hòa giải danh sách tin sau khi gửi lạc quan thành công (reconcileSentMessage).
//   - Bug #2: có nên đánh dấu đã đọc tới 1 messageId không (shouldMarkRoomRead).
//   - Bug #3: trạng thái tick HIỂN THỊ cho tin của mình theo mốc đọc của người kia (computeMineDisplayStatus).
import type { ChatMessage, ChatMessageStatus } from '../mock-data/types';

/** Bug #3 + "đã nhận" (5-6/8) — thang trạng thái tick HIỂN THỊ cho tin CỦA MÌNH kiểu Zalo, ưu tiên CAO→THẤP:
 *   1. 'seen'  (2 tick xanh) — `sentAtIso` ≤ `peerReadAtMs` (người kia ĐÃ ĐỌC tới đây).
 *   2. 'delivered' (2 tick xám) — `sentAtIso` ≤ `peerDeliveredAtMs` (người kia ĐANG/ĐÃ online → đã NHẬN).
 *   3. 'sent'  (1 tick xám) — mặc định (người kia offline, chưa nhận).
 * GIỮ NGUYÊN 'sending'/'failed' (lạc quan Bug #1), tin không phải của mình / tin hệ thống. `peerReadAtMs`/
 * `peerDeliveredAtMs` null (nhóm/chưa có dữ liệu) → tầng đó bị bỏ qua. "seen" ⊇ "delivered" (đọc thì tất
 * nhiên đã nhận) nên kiểm seen TRƯỚC. */
export function computeMineDisplayStatus(
  message: ChatMessage,
  peerReadAtMs: number | null,
  peerDeliveredAtMs: number | null = null
): ChatMessageStatus {
  if (!message.mine || message.type === 'system') return message.status;
  if (message.status === 'sending' || message.status === 'failed') return message.status;
  if (!message.sentAtIso) return message.status;
  const sentMs = new Date(message.sentAtIso).getTime();
  if (peerReadAtMs != null && sentMs <= peerReadAtMs) return 'seen';
  if (peerDeliveredAtMs != null && sentMs <= peerDeliveredAtMs) return 'delivered';
  return message.status;
}

/** Bug #1 (5/8) — sau khi gửi THÀNH CÔNG: bỏ bong bóng lạc quan (`optimisticId`) và chèn tin THẬT (`real`).
 * Nếu WS echo đã chèn tin thật TRƯỚC (id thật đã có trong danh sách) → chỉ bỏ bong bóng lạc quan, KHÔNG chèn
 * lại (chống nhân đôi). Thuần: nhận + trả mảng mới, KHÔNG mutate `prev`. */
export function reconcileSentMessage(prev: ChatMessage[], optimisticId: string, real: ChatMessage): ChatMessage[] {
  const withoutOptimistic = prev.filter((m) => m.id !== optimisticId);
  if (withoutOptimistic.some((m) => m.id === real.id)) return withoutOptimistic;
  return [...withoutOptimistic, real];
}

/** Bug #2 (5/8) — có nên gọi markRead tới `messageId` không: PHẢI là id server THẬT (bỏ tin lạc quan/mock cục
 * bộ `pending-`/`local-`/`fwd-` chưa có id server) VÀ khác mốc đã đánh dấu gần nhất `lastMarked` (chống gọi
 * lặp thừa cùng 1 mốc). */
export function shouldMarkRoomRead(messageId: string | undefined, lastMarked: string | null): boolean {
  if (!messageId) return false;
  if (messageId.startsWith('pending-') || messageId.startsWith('local-') || messageId.startsWith('fwd-')) return false;
  return lastMarked !== messageId;
}

/** #12 (8/8, Admin Demo "tin chưa đọc bị clear SAI khi KHÔNG mở trò chuyện") — có nên TỰ ĐÁNH DẤU ĐÃ ĐỌC khi 1 tin
 * MỚI của người khác đến qua WebSocket không. GỐC bug: ConversationScreen của phòng có thể còn MOUNT (là route
 * đang mở) NHƯNG app đang Ở NỀN (bấm HOME trên APK / minimize / đổi tab) — người dùng KHÔNG thực sự nhìn. Trước
 * đây auto-đọc VÔ ĐIỀU KIỆN → tin đến lúc ở nền bị coi "đã đọc" → mất unread (badge không cộng). ĐÚNG kiểu Zalo:
 * chỉ coi là đã đọc khi app đang HIỂN THỊ (foreground). Tin của CHÍNH mình không tính (mine). */
export function shouldAutoReadIncomingMessage(mine: boolean, appInBackground: boolean): boolean {
  return !mine && !appInBackground;
}
