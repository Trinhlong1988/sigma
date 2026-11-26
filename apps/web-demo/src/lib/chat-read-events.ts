// TICK "đã đọc" + XÓA BADGE CHƯA ĐỌC (5/8, Admin Demo "số tin chưa đọc không clear khi mở xem rồi quay lại") —
// pub-sub NỘI BỘ (module-level, không mạng) để ConversationScreen báo "vừa đánh dấu đã đọc phòng X" cho:
//   - ChatListScreen: đặt unreadCount phòng đó về 0 NGAY (không đợi remount/refetch).
//   - AppShell: cập nhật lại TỔNG số tin chưa đọc trên badge Sidebar "Trò chuyện".
// CÙNG Ý TƯỞNG `subscribeChatCategoriesChanged()` (mock-data/categories.ts) — pub-sub cục bộ đơn giản, KHÔNG
// kéo thêm state-manager. Không dùng WebSocket vì đây là hành động của CHÍNH client này (không cần round-trip
// server để tự biết mình vừa đọc phòng nào).
const listeners = new Set<(roomId: string) => void>();

/** Báo phòng `roomId` vừa được đánh dấu đã đọc (unread về 0).
 *
 * LƯU Ý (sửa 6/8 — comment cũ ghi "gọi SAU khi markChatRoomRead() thành công" là SAI SỰ THẬT): ConversationScreen
 * phát sự kiện này OPTIMISTIC (item 8a) NGAY khi mở phòng — TRƯỚC khi POST markChatRoomRead ghi lastReadMessageId
 * xong. Vì vậy listener KHÔNG được re-fetch server ngay trên sự kiện này (server có thể còn trả count CŨ/stale) —
 * phải cập nhật OPTIMISTIC tại chỗ (đặt phòng đó = 0), như ChatListScreen và AppShell (unread-badge.ts) đang làm. */
export function emitRoomRead(roomId: string): void {
  for (const fn of [...listeners]) {
    try {
      fn(roomId);
    } catch {
      // 1 listener lỗi KHÔNG được chặn các listener khác (best-effort, cập nhật badge là UX phụ).
    }
  }
}

/** Đăng ký nhận sự kiện "phòng vừa đọc". Trả hàm hủy — gọi lúc unmount. */
export function subscribeRoomRead(onRead: (roomId: string) => void): () => void {
  listeners.add(onRead);
  return () => {
    listeners.delete(onRead);
  };
}

// ĐỒNG BỘ ĐÃ-ĐỌC ĐA THIẾT BỊ (7/8, Admin Demo) — "đọc tất cả" ở 1 máy → máy khác cùng tài khoản nhận WS
// 'all-read-self' → emitAllRead() để clear TOÀN BỘ đỏ + badge + notification. Tách kênh riêng (không loop
// emitRoomRead từng phòng vì máy nhận có thể không biết đủ danh sách phòng) — listener tự xử "về 0 hết".
const allReadListeners = new Set<() => void>();

/** Báo TẤT CẢ phòng vừa được đánh dấu đã đọc (đọc-tất-cả, hoặc đồng bộ từ máy khác). */
export function emitAllRead(): void {
  for (const fn of [...allReadListeners]) {
    try {
      fn();
    } catch {
      // 1 listener lỗi KHÔNG chặn listener khác (best-effort, badge là UX phụ).
    }
  }
}

/** Đăng ký nhận sự kiện "đã đọc tất cả". Trả hàm hủy — gọi lúc unmount. */
export function subscribeAllRead(onAllRead: () => void): () => void {
  allReadListeners.add(onAllRead);
  return () => {
    allReadListeners.delete(onAllRead);
  };
}
