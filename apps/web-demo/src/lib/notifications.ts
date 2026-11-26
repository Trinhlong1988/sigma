// Gộp "thông báo trên chuông" (mục Nhật ký/chuông — kế hoạch curried-plotting-hippo.md, Admin Demo 24/7): lễ/
// Tết sắp tới (holidays.ts, thuật toán lịch thật) + sinh nhật bạn bè sắp tới (birthday-notify.ts, dữ liệu bạn
// bè thật qua bot-api). Dùng CHUNG cho components/NotificationBell.tsx (đặt ở TopBar — xem quyết định vị trí
// trong NotificationBell.tsx) và panel "Sắp tới" trên CalendarScreen.tsx, tránh trùng logic 2 nơi.
import { listMyAgentNotifications, markMyAgentNotificationsRead, type AgentNotificationItem } from './agent-api-client';
import { getCachedFriends } from './friends-cache';
import { getUpcomingBirthdays, type UpcomingBirthday } from './birthday-notify';
import { getUpcomingHolidays, type UpcomingEvent } from '@sigma/shared/holidays';

/** Số ngày nhìn về phía trước để tính "sắp tới" cho badge chuông — 14 ngày đủ để thấy trước 1 lễ mà không
 * làm danh sách quá dài (quyết định tự chọn, đổi ở đúng 1 chỗ này nếu LEAD muốn khác). */
export const UPCOMING_WINDOW_DAYS = 14;

export interface NotificationFeed {
  holidays: UpcomingEvent[];
  birthdays: UpcomingBirthday[];
  // B113 (2/8, Admin Demo yêu cầu trực tiếp "bạn bè phải có thông báo khi đổi avatar") — nguồn thứ 3, KHÁC 2
  // nguồn trên (tính toán thuần client-side): LƯU server-side qua GET /v1/me/notifications, có trạng thái
  // đã-đọc/chưa-đọc thật (2 nguồn kia không có khái niệm "đã đọc" — luôn hiện lại mỗi lần mở chuông).
  friendUpdates: AgentNotificationItem[];
  // totalCount = badge số trên chuông. holidays/birthdays đếm CẢ danh sách (không có trạng thái đọc); riêng
  // friendUpdates CHỈ đếm phần CHƯA đọc (unreadFriendUpdateCount) — khớp đúng ngữ nghĩa "có gì MỚI cần xem".
  unreadFriendUpdateCount: number;
  totalCount: number;
  loadError: string | null;
}

/** Tải "feed thông báo" đầy đủ (lễ/Tết sắp tới + sinh nhật bạn bè sắp tới + bạn bè vừa đổi avatar/ảnh bìa) cho
 * hôm nay. Lỗi tải 1 nguồn (chưa đăng nhập/mất mạng) KHÔNG chặn hiển thị 2 nguồn còn lại (3 nguồn ĐỘC LẬP) —
 * ghi vào `loadError` để UI hiện nhẹ nhàng, không vỡ cả bảng thông báo.
 * B122 (2/8) — bạn bè qua `getCachedFriends()` (friends-cache.ts, THAY gọi thẳng `listMyFriends()`) — CÙNG
 * cache AppShell.tsx/ChatListScreen.tsx/birthday-notify.ts đang dùng (xem docstring friends-cache.ts). Đo THẬT
 * TRƯỚC khi sửa: `NotificationBell.tsx` (dùng hàm này) là 1 trong các nguồn gọi `/v1/me/friends` RIÊNG khiến
 * tổng cộng bắn 5 request cho CÙNG dữ liệu lúc mở màn chat rỗng lần đầu. */
export async function loadNotificationFeed(today: Date = new Date()): Promise<NotificationFeed> {
  const holidays = getUpcomingHolidays(today, UPCOMING_WINDOW_DAYS);

  const [friendsRes, notifRes] = await Promise.all([getCachedFriends(), listMyAgentNotifications()]);

  const birthdays = friendsRes.ok ? getUpcomingBirthdays(friendsRes.data.friends, UPCOMING_WINDOW_DAYS, today) : [];
  const friendUpdates = notifRes.ok ? notifRes.data.notifications : [];
  const unreadFriendUpdateCount = notifRes.ok ? notifRes.data.unreadCount : 0;

  const loadError = !friendsRes.ok ? friendsRes.message : !notifRes.ok ? notifRes.message : null;

  return {
    holidays,
    birthdays,
    friendUpdates,
    unreadFriendUpdateCount,
    // FIX (Admin Demo 12/8 "1 event treo không clear"): badge CHỈ đếm cái ĐỌC-ĐƯỢC (unreadFriendUpdateCount).
    // TRƯỚC: cộng holidays.length + birthdays.length — nhưng Tết/sinh nhật sắp tới là NHẮC THƯỜNG TRỰC (không có
    // trạng thái đọc) → badge KHÔNG BAO GIỜ về 0 dù đã đọc hết (event kẹt). Event VẪN hiện trong danh sách chuông
    // (holidays/birthdays trả về nguyên) — chỉ KHÔNG giữ badge sáng mãi. Đọc hết friend-updates → badge = 0.
    totalCount: unreadFriendUpdateCount,
    loadError
  };
}

// ── #32 (6/8, Admin Demo "push nhật ký REALTIME") — helpers THUẦN cập nhật chuông tức thì khi nhận diary-notify
// qua WS, KHÔNG refetch. Tách khỏi component để unit test được. ───────────────────────────────────────────────

/** Dựng 1 item chuông "X vừa đăng nhật ký mới" từ sự kiện realtime. `id` phải DUY NHẤT trong danh sách hiện tại
 * (dùng làm React key) — bell cấp id âm giảm dần để KHÔNG đụng id dương của hàng DB thật (lần refetch sau sẽ thay
 * item lạc quan này bằng hàng thật). readAt=null (mới, CHƯA đọc). */
export function buildDiaryPostNotificationItem(
  ev: { authorAgentId: number; authorName: string; at: string; postId?: string },
  id: number
): AgentNotificationItem {
  // #26 — kèm postId để click item realtime cũng TRỎ ĐÚNG bài + highlight (null nếu sự kiện cũ không có).
  return { id, type: 'DIARY_POST', actorAgentId: ev.authorAgentId, actorAgentName: ev.authorName, postId: ev.postId ?? null, createdAt: ev.at, readAt: null };
}

/** Chèn item chuông Nhật ký mới lên ĐẦU danh sách + tăng unread + tổng badge — OPTIMISTIC, 0 refetch (đúng
 * nguyên tắc real-time). KHÔNG đổi holidays/birthdays. */
export function applyRealtimeDiaryPost(feed: NotificationFeed, item: AgentNotificationItem): NotificationFeed {
  return {
    ...feed,
    friendUpdates: [item, ...feed.friendUpdates],
    unreadFriendUpdateCount: feed.unreadFriendUpdateCount + 1,
    totalCount: feed.totalCount + 1
  };
}

/** Dedupe realtime diary-notify theo postId — trả true (và ĐÁNH DẤU đã thấy) nếu postId CHƯA xử lý; false nếu
 * đã xử lý (chống +1 HAI LẦN khi cả WS lẫn FCM/đa-kết-nối cùng báo 1 bài tới máy đang mở). */
export function markDiaryNotifySeen(seen: Set<string>, postId: string): boolean {
  if (seen.has(postId)) return false;
  seen.add(postId);
  return true;
}

/** Đánh dấu TOÀN BỘ thông báo "bạn bè đổi avatar/ảnh bìa" đã đọc — gọi khi mở dropdown chuông (giống Zalo/
 * Messenger: badge biến mất ngay khi xem, không cần bấm từng cái). Best-effort — lỗi mạng KHÔNG throw ra UI,
 * badge chỉ đơn giản còn nguyên tới lần mở kế tiếp thử lại (KHÔNG mất dữ liệu, chỉ chưa đồng bộ được trạng
 * thái đã đọc). */
export async function markFriendUpdateNotificationsRead(): Promise<void> {
  await markMyAgentNotificationsRead();
}
