// P3+P5 (6/8, tối ưu tốc độ mở khung chat) — cache tin nhắn theo `roomId` + stale-while-revalidate (SWR).
// MẪU: `lib/rooms-list-cache.ts` (cache danh sách phòng) + `lib/categories-cache.ts` (cache có invalidate). Ở
// đây KHÔNG có TTL: cache SỐNG suốt phiên (module-level), luôn được REVALIDATE nền mỗi lần mở phòng nên không
// sợ cũ — mục tiêu DUY NHẤT là hiện NGAY bản đã tải trước đó (0ms, hết nháy trắng `setMessages([])`) trong khi
// mạng đi lấy bản mới nền. Nguồn cache = tin nhắn ĐÃ MAP (`ChatMessage`, gồm cả reaction đã merge) — đúng shape
// mà ConversationScreen.tsx render thẳng, không map lại.
//
// AN TOÀN ĐA-TÀI-KHOẢN: cache PHẢI bị xóa lúc đăng xuất (performLogout → clearMessagesCache) để phiên/tài khoản
// kế tiếp trên CÙNG tab KHÔNG thấy tin của người trước (cùng lớp lo ngại đã xử lý cho clearRoomsListCache()).
//
// CHỐNG PHÌNH BỘ NHỚ: LRU cứng `MAX_ROOMS` phòng (Map giữ thứ tự chèn = thứ tự truy cập gần nhất — đọc/ghi đều
// đưa phòng lên "mới nhất"). Ảnh/file trong tin là URL (chat-client.ts chatAttachmentDownloadUrl), KHÔNG phải
// blob → mỗi phòng nhẹ, nhưng vẫn chặn trên để phiên chuyển hàng trăm phòng không giữ vô hạn.
import type { ChatMessage } from '../mock-data/types';

export interface CachedRoomMessages {
  /** Tin nhắn đã map + sắp CŨ→MỚI (đúng thứ tự hiển thị ConversationScreen), gồm reaction đã merge nếu có. */
  messages: ChatMessage[];
  /** Còn tin CŨ hơn để "cuộn-lên-tải-thêm" hay không (từ `res.data.hasMore` server) — khôi phục cùng messages. */
  hasMoreOlder: boolean;
  cachedAt: number;
}

/** Số phòng tối đa giữ trong cache (LRU). Đủ lớn cho thói quen chuyển-qua-lại vài chục phòng/phiên. */
export const MESSAGES_CACHE_MAX_ROOMS = 30;

// Map giữ ĐÚNG thứ tự chèn: entry được `delete` rồi `set` lại mỗi lần truy cập → khóa cũ nhất luôn ở đầu
// iterator (dùng để trục xuất khi vượt cap). KHÔNG dùng TTL — SWR tự lo độ tươi.
const cache = new Map<string, CachedRoomMessages>();

/** Bỏ các tin CHỈ-CỤC-BỘ (lạc quan/mock) khỏi ảnh chụp cache — chúng sẽ được server xác nhận lại (pending) hoặc
 * vốn chưa nối thật (local/fwd), KHÔNG nên "đông cứng" vào cache để hiện lại ở lần mở sau (revalidate sẽ phủ
 * đúng danh sách server). Nối quy ước id: `pending-*` (send() lạc quan), `local-*`/`local-sticker-*` (sticker/
 * vị trí mock), `fwd-*` (chuyển tiếp mock) — xem ConversationScreen.tsx. */
function stripLocalOnly(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((m) => !m.id.startsWith('pending-') && !m.id.startsWith('local-') && !m.id.startsWith('fwd-'));
}

/** Trả bản cache của phòng (và đưa phòng lên "mới nhất" trong LRU), hoặc `null` nếu chưa từng cache. */
export function getCachedRoomMessages(roomId: string): CachedRoomMessages | null {
  const hit = cache.get(roomId);
  if (!hit) return null;
  cache.delete(roomId);
  cache.set(roomId, hit);
  return hit;
}

/** Ghi/ghi đè cache tin nhắn của phòng. Tự lọc tin chỉ-cục-bộ + trục xuất phòng cũ nhất khi vượt LRU cap. */
export function setCachedRoomMessages(roomId: string, messages: ChatMessage[], hasMoreOlder: boolean): void {
  cache.delete(roomId);
  cache.set(roomId, { messages: stripLocalOnly(messages), hasMoreOlder, cachedAt: Date.now() });
  while (cache.size > MESSAGES_CACHE_MAX_ROOMS) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Xóa cache 1 phòng — gọi sau hành động chắc chắn làm cache lệch nặng bản server (hiện chưa cần, để sẵn cho
 * đối xứng với rooms-list-cache clear-theo-phòng nếu về sau invalidate cục bộ). */
export function clearRoomMessagesCache(roomId: string): void {
  cache.delete(roomId);
}

/** Xóa TOÀN BỘ cache — BẮT BUỘC gọi lúc đăng xuất (chống rò tin giữa 2 tài khoản trên cùng tab). */
export function clearMessagesCache(): void {
  cache.clear();
}
