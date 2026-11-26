// TỔNG số tin chưa đọc cho badge icon app + Sidebar (6/8, Admin Demo báo 3 lỗi: icon lệch 4-vs-2 / đọc xong không
// clear / phải làm 2 lần). Logic THUẦN (Map roomId→unreadCount, không I/O) để AppShell giữ ở ref + test tất định.
//
// GỐC BUG (điều tra từ code): AppShell cũ re-fetch server (`listChatRooms`) NGAY khi nhận sự kiện "đã đọc phòng"
// — nhưng ConversationScreen phát sự kiện đó OPTIMISTIC (item 8a) TRƯỚC khi POST markChatRoomRead ghi
// lastReadMessageId xong → server trả count CŨ (stale) → badge sai/không clear/phải làm 2 lần. FIX: AppShell giữ
// MAP cục bộ; đọc phòng → đặt phòng đó = 0 NGAY (0ms, KHÔNG re-fetch); tin mới → +1 tại chỗ; server chỉ dùng để
// dựng baseline lúc mount (refreshUnread). CÙNG cách ChatListScreen cập nhật optimistic per-room → tổng icon khớp
// tổng hiển thị trong app (hết lệch 4-vs-2).

export type UnreadMap = Map<string, number>;

/** Dựng map từ danh sách phòng server (chỉ giữ phòng còn tin chưa đọc — nguồn `listChatRooms`). */
export function buildUnreadMap(rooms: ReadonlyArray<{ id: string; unreadCount: number }>): UnreadMap {
  const m: UnreadMap = new Map();
  for (const r of rooms) {
    if (r.unreadCount > 0) m.set(r.id, r.unreadCount);
  }
  return m;
}

/** TỔNG chưa đọc = cộng mọi giá trị trong map (phòng đã đọc = 0, không đóng góp). */
export function sumUnread(map: UnreadMap): number {
  let s = 0;
  for (const v of map.values()) s += v;
  return s;
}

/** Đọc phòng `roomId` → về 0 NGAY (optimistic). Trả `true` nếu có thay đổi (để caller mới recompute + set badge),
 * `false` nếu phòng vốn đã 0/không có (tránh render thừa). KHÔNG re-fetch server (chống stale 8a). */
export function markRoomRead(map: UnreadMap, roomId: string): boolean {
  if ((map.get(roomId) ?? 0) === 0) return false;
  map.set(roomId, 0);
  return true;
}

/** Tin MỚI realtime cho phòng KHÔNG đang mở → +1 tại chỗ (optimistic, icon cộng ngay). Mỗi `chat-notify` = 1 tin.
 * Dùng khi server KHÔNG kèm unreadCount (payload cũ) — xem setRoomUnread cho đường server-truth. */
export function incrementRoomUnread(map: UnreadMap, roomId: string): void {
  map.set(roomId, (map.get(roomId) ?? 0) + 1);
}

/** ĐỒNG NHẤT SỐ ĐẾM MỌI NỀN (7/8, Admin Demo "exe 3 / apk 2 lệch") — ĐẶT unread của phòng = giá trị SERVER tính
 * (chat-notify.unreadCount), thay vì +1 optimistic mỗi máy tự đếm (trôi lệch). count<=0 → xoá khỏi map (phòng đã
 * đọc hết). Trả `true` nếu tổng có thể đổi (caller recompute badge). */
export function setRoomUnread(map: UnreadMap, roomId: string, count: number): boolean {
  const next = Math.max(0, Math.floor(count) || 0);
  const prev = map.get(roomId) ?? 0;
  if (next === prev) return false;
  if (next === 0) map.delete(roomId);
  else map.set(roomId, next);
  return true;
}
