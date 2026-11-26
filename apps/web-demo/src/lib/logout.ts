// Đăng xuất dùng chung — tách từ App.tsx (SettingsRoute) để Sidebar (nút mới, luôn hiển thị, port vị
// trí từ GLB desktop) và màn Cài đặt (nút cũ) gọi CHUNG một đường logic, tránh lệch hành vi.
// Audit HIGH 24/7 (B11): rcLogout() best-effort (không throw) — LUÔN clearSession() + điều hướng về /login dù
// revoke phía RC thành công hay thất bại (mất mạng/RC tạm down không được chặn đăng xuất cục bộ).
// SIGMA (26/7) — kiến trúc mới: rcLogout() giờ gọi bot-api /v1/auth/web-logout (cookie tự gửi kèm), KHÔNG
// còn nhận authToken/userId (session cục bộ không còn giữ token, xem session.ts) — gọi được ngay cả khi
// getSession() null (cookie có thể còn hợp lệ dù localStorage đã mất, vd người dùng tự xóa site data cục bộ
// nhưng chưa hết hạn cookie 30 ngày — vẫn nên cố gắng revoke phía server cho sạch).
import type { NavigateFunction } from 'react-router';
import { clearSession } from './session';
import { clearAuthenticatedAgentCache } from './bot-api-client';
import { clearMessagesCache } from './messages-cache';
import { clearRoomsListCache } from './rooms-list-cache';
import { clearFriendsCachePersist } from './friends-cache';
import { clearDiaryFeedCache } from './diary-feed-cache';
import { clearPersistedCatFilter } from './chat-category-filter-persist';
import { rcLogout } from './rc-client';
import { closeOverlayForNavigation } from './back-intercept';
import { resetRealtimeConnection } from './rc-realtime';
import { resetChatRealtimeConnection } from './chat-realtime';
import { closeCallSignalingSocket } from './call-signaling-client';
import { clearAllToasts } from './toast-store';
import { ROUTES } from '../routes';

// Audit độc lập 26/7 (finding LOW, xem BUGS_FIXED.md): đăng xuất PHẢI đóng kết nối WebSocket real-time hiện
// có (nếu đang mở) — trước đây chỉ xóa session cục bộ, để socket cũ treo lại nếu đăng nhập tài khoản khác
// ngay trong cùng tab (không reload trang).
// Phase 3 "real-time" (29/7) — CÙNG áp cho kết nối chat lõi MỚI (chat-realtime.ts) — 2 kết nối độc lập, cả 2
// đều PHẢI đóng lúc đăng xuất, không chỉ cái cũ.
// Nợ độ tin cậy đánh thức cuộc gọi (30/7) — AppShell.tsx giờ CHỦ ĐỘNG mở kết nối call-signaling NGAY lúc vào
// AppShell (không chỉ lúc CallScreen/IncomingCallScreen tự mount như trước), nên đây là kết nối WS THỨ 3 có
// thể đang mở lúc đăng xuất — CÙNG lớp bug LOW đã bắt ở trên (2 kết nối cũ), extend NGAY luôn thay vì để lọt
// qua lần nữa (đăng nhập tài khoản khác ngay trong tab sẽ mang theo cookie phiên CŨ nếu không đóng).
export function performLogout(navigate: NavigateFunction): void {
  // BUG "đăng xuất bị KẸT" (Admin Demo 11/9, tái hiện đo thật bằng scripts/harness-logout.ts): nút Đăng xuất
  // (Sidebar + Cài đặt) đều xác nhận qua ConfirmDialog → Modal → useBackIntercept đã PUSH 1 history entry
  // sentinel (back-intercept.ts). Bấm xác nhận → navigate('/login') push route thật, RỒI Modal unmount →
  // cleanup sentinel gọi history.back() → NUỐT LUÔN entry /login vừa push → URL bật ngược về /app/chat trong
  // khi session đã xóa = màn KẸT ở app cũ, phải kill app mới thấy màn đăng nhập. Cùng lớp "BUG 1 đóng-để-điều-
  // hướng" đã có thuốc sẵn closeOverlayForNavigation() (GroupInfoPanel dùng) — đường logout trước đây KHÔNG
  // gọi. PHẢI gọi TRƯỚC navigate (đọc stack overlay khi chúng còn mount) để MỌI cleanup overlay lượt này bỏ
  // history.back. Không overlay nào mở → no-op an toàn.
  closeOverlayForNavigation();
  void rcLogout();
  resetRealtimeConnection();
  resetChatRealtimeConnection();
  closeCallSignalingSocket();
  clearAllToasts(); // item 3 (6/8) — không để toast tin nhắn của phiên cũ rớt sang phiên/tài khoản mới.
  // P1+P3+P5 (6/8) — xóa cache FE theo phiên (danh tính agentId + tin nhắn theo phòng) để tài khoản đăng nhập
  // kế tiếp trên CÙNG tab KHÔNG dùng nhầm agentId / KHÔNG thấy tin của người trước. Cùng lớp lo ngại clearSession.
  clearAuthenticatedAgentCache();
  clearMessagesCache();
  clearRoomsListCache(); // PERF SWR persist (15/8): rooms cache nay sống qua reload/sessionStorage → PHẢI xóa lúc
  // đăng xuất để tài khoản kế trên cùng tab KHÔNG thấy danh sách phòng của người trước (cùng lớp clearMessagesCache).
  clearFriendsCachePersist(); // tương tự: danh bạ last-known bền → xóa lúc đăng xuất (chống lộ chéo tài khoản).
  clearDiaryFeedCache(); // feed Nhật ký cache → xóa lúc đăng xuất.
  clearPersistedCatFilter(); // phân loại đang lọc (bền qua điều hướng) → xóa để tài khoản kế không kế thừa bộ lọc người trước.
  clearSession();
  navigate(ROUTES.login);
}
