// Bug E (6/8, Admin Demo "A gửi B, B không ở khung → badge đỏ đếm 1 NGAY như Zalo") — biến đổi THUẦN cho danh
// sách phòng khi có tin MỚI realtime (chat-notify). Tách khỏi ChatListScreen.tsx để KIỂM THỬ được (component
// khó unit-test): +1 chưa đọc phòng có tin, đổi preview + nhãn giờ, ĐƯA phòng lên đầu. Phòng KHÔNG có trong
// danh sách (tin đầu tiên của phòng mới) → trả found=false để caller refetch. KHÔNG mutate mảng đầu vào.
import type { ChatRoom } from '../mock-data/types';

export interface ApplyIncomingResult {
  rooms: ChatRoom[];
  found: boolean;
}

/** Áp 1 tin nhắn mới (preview + nhãn giờ đã format) cho phòng `roomId` trong `rooms`. Trả danh sách mới + cờ
 * `found`. Người GỌI đã đảm bảo tin này KHÔNG phải của chính mình (server chat-notify loại trừ người gửi) và
 * KHÔNG đang mở đúng phòng đó (ChatListScreen chỉ mount ở /app/chat, tách route với khung hội thoại). */
export function applyIncomingMessageToRooms(
  rooms: ChatRoom[],
  roomId: string,
  preview: string,
  timeLabel: string
): ApplyIncomingResult {
  const idx = rooms.findIndex((r) => r.id === roomId);
  if (idx === -1) return { rooms, found: false };
  const room = rooms[idx];
  const updated: ChatRoom = {
    ...room,
    unreadCount: room.unreadCount + 1,
    lastMessage: preview,
    lastTime: timeLabel
  };
  return { rooms: [updated, ...rooms.slice(0, idx), ...rooms.slice(idx + 1)], found: true };
}
