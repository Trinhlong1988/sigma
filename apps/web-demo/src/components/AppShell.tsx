// App shell (layout route) — Sidebar + TopBar bọc mọi màn "đã đăng nhập". Sidebar ẩn dưới lg (mobile-
// width), thay bằng drawer trượt mở qua nút hamburger trên TopBar — responsive THẬT bằng Tailwind
// breakpoint (không phải 2 codebase riêng), theo đúng spec mục 5.
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Sidebar } from './Sidebar';
import { TopBar } from './TopBar';
import { useTheme } from './ThemeToggle';
import { ToastHost } from './toast/ToastHost';
import { NotificationPermissionBanner } from './NotificationPermissionBanner';
import { SellTidModal } from '../screens/SellTidModal';
import { performLogout } from '../lib/logout';
import { ROUTES } from '../routes';
import { listChatRooms } from '../lib/chat-client';
import { pushToast } from '../lib/toast-store';
import { isMessageNotifEnabled, getToastDurationSec } from '../lib/notification-settings';
import { notifyOsBackground, ensureWebNotificationPermission, wireOsNotificationClick, setPcUnreadBadge, setNativeAppBadge, clearRoomNotification, clearAllRoomNotifications, isAppInBackground, wireForegroundTracking, isElectronRuntime } from '../lib/os-notification';
import { playNotificationChime, isAudioEnabled } from '../lib/audio-player';
import { runDailyBirthdayCheck } from '../lib/birthday-notify';
import { initPushNotifications } from '../lib/push-notifications';
import { startVersionCheck } from '../lib/version-check';
import { primeCameraPermission, primeMicrophonePermission } from '../lib/permission-priming';
import { buildIncomingCallNavigation, ensureCallSignalingSocket, onCallSignalingMessage } from '../lib/call-signaling-client';
import { getCachedFriends } from '../lib/friends-cache';
import { fetchAuthenticatedAgent, getCachedAgentId } from '../lib/bot-api-client';
import { subscribeChatNotify } from '../lib/chat-realtime';
import { subscribeRoomRead, subscribeAllRead } from '../lib/chat-read-events';
import { roomAvatarUrl } from '../lib/chat-client';
import { buildUnreadMap, sumUnread, markRoomRead, incrementRoomUnread, setRoomUnread, type UnreadMap } from '../lib/unread-badge';
// Fix "số chưa đọc không cộng dồn theo tin, lệch với icon" (7/8, Admin Demo) — AppShell (LUÔN mount) giữ cache danh
// sách phòng ĐỒNG BỘ khi ChatListScreen KHÔNG mount (đang ở phòng khác/tab khác), nếu không cache stale → mở lại
// danh sách trong 8s TTL thấy bubble số CŨ dù icon đã +đúng. Dùng CÙNG applyIncomingMessageToRooms như ChatListScreen.
import { applyIncomingMessageToRooms } from '../lib/chat-list-live';
import { getFreshRoomsListCache, setRoomsListCache, clearRoomsListCache } from '../lib/rooms-list-cache';
import { formatMessageTime } from '../lib/chat-client';
import { agentAvatarUrl } from '../lib/avatar-url';
import { resolveNotifyAvatar } from '../lib/notify-avatar';
import { fetchAttachmentDataUrl } from '../lib/attachment-blob';

const TITLES: Array<[string, string]> = [
  [ROUTES.chat, 'Trò chuyện'],
  [ROUTES.revenue, 'Doanh số'],
  [ROUTES.lo, 'Lô & Đối soát'],
  [ROUTES.kpi, 'Báo cáo/KPI'],
  [ROUTES.contacts, 'Danh bạ'],
  [ROUTES.settings, 'Cài đặt'],
  [ROUTES.qr, 'Hiển thị QR'],
  [ROUTES.sellTid, 'Bán TID'],
  [ROUTES.myQr, 'Mã QR của tôi'],
  [ROUTES.security, 'Tài khoản & bảo mật'],
  [ROUTES.profile, 'Hồ sơ của tôi'],
  [ROUTES.diary, 'Nhật ký'],
  [ROUTES.calendar, 'Lịch']
];

function titleFor(pathname: string): string {
  return TITLES.find(([p]) => pathname.startsWith(p))?.[1] ?? 'SigMa';
}

export interface AppShellContext {
  theme: 'light' | 'dark';
  toggleTheme: () => void;
}

export function AppShell(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { theme, toggle } = useTheme();
  const [mobileOpen, setMobileOpen] = useState(false);
  // Mục 36 — bong bóng cuộc gọi nổi (?callpill=1 — CallScreen thu nhỏ điều hướng về đây).
  const showCallPill = searchParams.get('callpill') === '1';

  // FIX-DEMOCK (4/8) — ĐÃ BỎ `openFlags` (đếm cờ gian lận từ mock RECONCILE_DETAIL) cùng với việc ẩn mục
  // "Cảnh báo gian lận" ở Sidebar: badge đó là số BỊA từ mock-data/lo, không phải cờ thật của đại lý.

  // Badge "Trò chuyện" ở Sidebar — bug tìm thấy 31/7 (bug-bash): trước đây tính từ `CHAT_ROOMS`
  // (mock-data/chats.ts, mảng demo TĨNH Phase 0 — 5 liên hệ giả "Trần Thị Hồng"/"Lê Minh Khôi"...), KHÔNG
  // liên quan phòng chat THẬT của agent đang đăng nhập — số hiện ra sai (cố định bất kể tài khoản nào đăng
  // nhập/đã đọc gì thật). Đổi sang gọi `listChatRooms({unreadOnly:true})` (chat-client.ts, GET
  // /v1/chat/rooms?unreadOnly=true — route THẬT `routes/chat.ts` lấy agentId từ `req.agent!.id` do
  // `requireSession` gắn từ session server-side, KHÔNG nhận agentId từ client → không thể rò số của người
  // khác, xem xác nhận security ở BUGS_FIXED.md). Dùng `listChatRooms()` THÔ (không phải
  // `listChatRoomsWithNames()` mà ChatListScreen.tsx dùng) vì ở đây chỉ cần TỔNG unreadCount, không cần tên
  // hiển thị phòng → tránh gọi thêm `buildAgentNameResolver()`/`listMyFriends()` không cần thiết cho 1 con số
  // badge. `unreadOnly:true` chỉ trả phòng còn tin chưa đọc — tổng unreadCount trên tập con này bằng hệt
  // tổng trên toàn bộ phòng (phòng đã đọc hết luôn có unreadCount=0, không đóng góp gì dù lọc hay không) —
  // chọn nhánh này để giảm tải response.
  //
  // Đã đọc kỹ ChatListScreen.tsx/ConversationScreen.tsx TRƯỚC khi viết đoạn này: KHÔNG có cơ chế
  // live-update/polling/WebSocket nào cho danh sách phòng ở nơi khác trong codebase để mà nối chung —
  // `subscribeCategoriesChanged()` (mock-data/categories.ts) là pub-sub RIÊNG cho mảng mock `CATEGORIES` bị
  // mutate trực tiếp bởi `CategoryManagerModal`, không áp dụng cho phòng chat/unreadCount thật. Fetch 1 LẦN
  // lúc mount, CÙNG PATTERN `listChatRoomsWithNames()` ở ChatListScreen.tsx (không có refetch định kỳ ở đó
  // cũng — ngoài phạm vi bug này để thêm cơ chế live mới, xem DO NOT TOUCH trong báo cáo B-fix). Lỗi tải
  // KHÔNG throw/hiện lỗi ra UI (badge chỉ là phụ, giữ nguyên giá trị cũ — mặc định 0 — nếu tải lỗi), CÙNG tinh
  // thần best-effort mọi useEffect khác trong file này.
  // FIX badge icon (6/8, Admin Demo 3 lỗi: icon lệch 4-vs-2 / đọc xong không clear / phải làm 2 lần) — GỐC: code cũ
  // re-fetch server NGAY trên sự kiện "đã đọc phòng", nhưng ConversationScreen phát sự kiện đó OPTIMISTIC (item 8a)
  // TRƯỚC khi POST markChatRoomRead ghi xong → server trả count CŨ (stale) → badge sai/không clear. FIX: giữ MAP
  // roomId→unreadCount cục bộ (unread-badge.ts). Đọc phòng → phòng đó = 0 NGAY (0ms, KHÔNG re-fetch → hết stale);
  // tin mới → +1 tại chỗ; server CHỈ dựng baseline lúc mount. CÙNG cách optimistic ChatListScreen → tổng icon khớp
  // tổng trong app (hết lệch). `unreadChat` = tổng map (state để re-render + đẩy lên badge icon).
  const unreadMapRef = useRef<UnreadMap>(new Map());
  const [unreadChat, setUnreadChat] = useState(0);
  // Recompute TỔNG từ map hiện tại rồi set state — stable (đọc ref, không phụ thuộc biến ngoài) để dùng trong
  // mọi effect (mount/đọc-phòng/tin-mới) mà KHÔNG gây resubscribe.
  const recomputeUnreadBadge = useCallback(() => {
    setUnreadChat(sumUnread(unreadMapRef.current));
  }, []);
  // BASELINE từ server (nguồn chân lý theo lastReadMessageId) — CHỈ gọi lúc mount (KHÔNG gọi trên emit optimistic,
  // tránh đọc count stale khi POST đọc chưa ghi xong). Dựng lại toàn bộ map rồi recompute.
  const refreshUnread = useCallback(() => {
    listChatRooms({ unreadOnly: true }).then((res) => {
      if (res.ok) {
        unreadMapRef.current = buildUnreadMap(res.data);
        recomputeUnreadBadge();
      } else {
        // eslint-disable-next-line no-console
        console.error('[AppShell] tải số tin nhắn chưa đọc thất bại:', res.message);
      }
    });
  }, [recomputeUnreadBadge]);
  useEffect(() => {
    refreshUnread();
    // Đọc 1 phòng (ConversationScreen → emitRoomRead) → đặt phòng đó = 0 NGAY (optimistic, 0ms). KHÔNG re-fetch
    // server (đó chính là lỗi cũ: emit là optimistic 8a, POST chưa ghi → refetch trả stale → badge không clear).
    const off = subscribeRoomRead((roomId) => {
      if (markRoomRead(unreadMapRef.current, roomId)) recomputeUnreadBadge();
      // CLEAR NOTIFICATION XUYÊN THIẾT BỊ (7/8, Admin Demo "đọc ở nền khác thì icon topbar APK phải clear") — đọc
      // phòng ở BẤT KỲ máy nào → xoá notification thanh trạng thái + badge của phòng đó trên APK (no-op web/exe:
      // badge do sidebar/taskbar lo). Đây là GỐC "badge đỏ APK lệch số": trước chỉ cancel khi đọc TRÊN CHÍNH APK.
      clearRoomNotification(roomId);
      // Đồng bộ cache: đặt phòng đó = 0 (idempotent nếu ChatListScreen cũng đang mount đặt 0) → mở lại danh sách
      // KHÔNG thấy bubble đỏ cũ dù đã đọc (kể cả đọc từ máy khác qua room-read-self).
      const cached = getFreshRoomsListCache();
      if (cached) {
        let changed = false;
        const next = cached.map((r) => {
          if (r.id === roomId && r.unreadCount > 0) { changed = true; return { ...r, unreadCount: 0 }; }
          return r;
        });
        if (changed) setRoomsListCache(next);
      }
    });
    // ĐỒNG BỘ ĐA THIẾT BỊ (7/8) — máy khác "đọc tất cả" (WS all-read-self → emitAllRead) → xoá sạch map + badge=0 +
    // vô hiệu cache (buộc danh sách tải lại số 0 đúng lần mở kế).
    const offAll = subscribeAllRead(() => {
      if (unreadMapRef.current.size > 0) {
        unreadMapRef.current.clear();
        recomputeUnreadBadge();
      }
      clearRoomsListCache();
      clearAllRoomNotifications(); // APK: "đọc tất cả" ở máy khác → xoá MỌI notification thanh trạng thái.
    });
    return () => {
      off();
      offAll();
    };
  }, [refreshUnread, recomputeUnreadBadge]);

  // BUG#8b (6/8, Admin Demo "badge trên ICON app desktop") — đồng bộ TỔNG unread lên icon taskbar/dock EXE mỗi khi
  // unreadChat đổi (mount, có tin mới realtime, đọc phòng → emitRoomRead). No-op trên web/APK (không có bridge).
  // Clear tức thì: unreadChat về 0 (đọc hết) → setPcUnreadBadge(0) → main xóa overlay ngay, không trễ.
  useEffect(() => {
    setPcUnreadBadge(unreadChat);
    // #8-tiếp (8/8, Admin Demo "mở app thấy 62 nhưng ICON APK 21 — bộ đếm đơ, chỉ push nền mới cộng") — ĐỒNG BỘ
    // TỔNG chưa đọc THẬT (realtime, gồm tin WS lúc app mở) lên badge launcher APK, SONG SONG setPcUnreadBadge của
    // EXE. Trước đây badge APK chỉ do FCM đặt khi Ở NỀN → tin nhận qua WebSocket lúc mở KHÔNG chạm badge → kẹt.
    setNativeAppBadge(unreadChat);
    // ĐỒNG NHẤT CHUẨN ZALO/FACEBOOK (7/8, Admin Demo) — WEB: hiện TỔNG chưa đọc ngay TIÊU ĐỀ TAB trình duyệt
    // "(3) SigMa" (như "(3) Zalo"/"(3) Messenger") → thấy số ngay cả khi ở tab khác. EXE tự ép title về
    // "SigMa" (main.js page-title-updated) nên dòng này chỉ có tác dụng trên web; APK không có tiêu đề tab.
    // 99+ để không phình. Về 0 → tên gốc. Guard typeof document (an toàn env test/native).
    if (typeof document !== 'undefined') {
      document.title = unreadChat > 0 ? `(${unreadChat > 99 ? '99+' : unreadChat}) SigMa` : 'SigMa';
    }
  }, [unreadChat]);

  // B107-tiếp (2/8, Admin Demo yêu cầu trực tiếp "phải có thông báo số lượng lời mời kết bạn") — badge số lời
  // mời kết bạn ĐANG CHỜ trên mục "Danh bạ" sidebar, CÙNG PATTERN unreadChat/openFlags ở trên (fetch 1 lần lúc
  // mount, lỗi không chặn UI). Qua `getCachedFriends()` (friends-cache.ts) — CÙNG cache ContactsScreen.tsx
  // dùng, không gọi API riêng thêm; ContactsScreen tự invalidate lúc mount (B107-tiếp fix) nên badge này cũng
  // tự đúng nếu AppShell mount SAU khi Danh bạ đã ghé qua trong CÙNG phiên — trường hợp AppShell mount TRƯỚC
  // (mở app lần đầu, chưa từng ghé Danh bạ) badge có thể trễ tới khi cache tự làm mới (giới hạn đã biết, CÙNG
  // toàn bộ hệ friends-cache — không có real-time push, xem docstring module đó).
  const [pendingFriendRequests, setPendingFriendRequests] = useState(0);
  useEffect(() => {
    let cancelled = false;
    getCachedFriends().then((res) => {
      if (cancelled) return;
      if (res.ok) setPendingFriendRequests(res.data.incomingRequests.length);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // P1 (6/8, tối ưu tốc độ mở khung chat) — LÀM ẤM cache danh tính chính mình (`GET /v1/auth/me`) NGAY lúc vào
  // AppShell (1 lần/phiên), để khi người dùng mở phòng chat đầu tiên, `getCachedAgentId()` đã có sẵn →
  // ConversationScreen.tsx seed myAgentId đồng bộ, KHÔNG chờ hop /auth/me nữa (xem bot-api-client.ts). Bỏ qua
  // nếu cache đã ấm (đăng nhập vừa xong LoginScreen đã gọi /auth/me). Best-effort, KHÔNG chặn/không hiện lỗi.
  useEffect(() => {
    if (getCachedAgentId() != null) return;
    void fetchAuthenticatedAgent();
  }, []);

  // Thông báo sinh nhật bạn bè (mục "Lịch" — Admin Demo 24/7): chạy 1 LẦN mỗi khi vào AppShell (tức 1 lần/phiên
  // đăng nhập — AppShell chỉ mount lại khi rời/quay lại toàn bộ nhóm route /app/*, KHÔNG mount lại mỗi khi
  // đổi màn con bên trong, xem key={location.pathname} chỉ nằm ở khối <Outlet> bên dưới). Tự chống trùng
  // trong ngày qua localStorage (xem birthday-notify.ts) — an toàn gọi lại nếu AppShell mount lại (F5/đăng
  // nhập lại). KHÔNG throw, không hiện lỗi ra UI (best-effort, chạy nền im lặng đúng phạm vi đã chốt).
  useEffect(() => {
    runDailyBirthdayCheck().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[birthday-notify] chạy kiểm tra sinh nhật thất bại:', err);
    });
  }, []);

  // Push notification kiểu Zalo (26/7, FCM) — CÙNG vị trí/lý do mount như runDailyBirthdayCheck() ở trên (1
  // lần/phiên đăng nhập, AppShell chỉ mount lại khi rời/quay lại nhóm route /app/*). NO-OP trên bản web
  // (Capacitor.isNativePlatform() false — xem push-notifications.ts), an toàn gọi ở mọi nền tảng.
  useEffect(() => {
    initPushNotifications(navigate).catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[push-notifications] khởi tạo thất bại:', err);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Xin quyền Camera lúc mở app (27/7, Admin Demo yêu cầu "xin quyền 1 lượt lúc mở app") — CÙNG vị trí/lý do
  // mount như 2 useEffect trên, xem permission-priming.ts.
  useEffect(() => {
    primeCameraPermission().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[permission-priming] xin quyền camera thất bại:', err);
    });
  }, []);

  // Auto-phát hiện bản web MỚI (Admin Demo 15/8 "website vẫn bản cũ") — SPA đang mở KHÔNG tự cập nhật tới khi reload;
  // định kỳ so bundle hash với server → khác = hiện banner "Tải lại". KHÔNG tự reload (tránh mất thao tác đang gõ).
  const [newVersionAvailable, setNewVersionAvailable] = useState(false);
  useEffect(() => startVersionCheck(() => setNewVersionAvailable(true)), []);

  // SIGMA Phase 4 (30/7) — xin quyền Micro lúc mở app, CÙNG vị trí/lý do useEffect camera ở trên: gọi
  // thoại/video WebRTC tự xây (webrtc-call.ts) giờ là tính năng THẬT tiêu thụ quyền này.
  useEffect(() => {
    primeMicrophonePermission().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[permission-priming] xin quyền micro thất bại:', err);
    });
  }, []);

  // Nợ độ tin cậy đánh thức cuộc gọi (30/7): đọc kỹ call-signaling-client.ts + CallScreen.tsx +
  // IncomingCallScreen.tsx TRƯỚC khi viết đoạn này — xác nhận THẬT (không suy đoán) là CẢ HAI màn đó hiện
  // KHÔNG hề lắng nghe message type 'incoming_call' (chỉ lọc call_accepted/offer/answer/call_timeout/call_end/
  // call_answered_elsewhere theo 1 callId ĐÃ BIẾT sẵn từ props điều hướng) — nghĩa là TRƯỚC ĐỢT NÀY, nếu người
  // dùng đang ở màn khác (chat/KPI/danh bạ...) khi có cuộc gọi tới, KHÔNG CÓ GÌ đánh thức họ cả (kết nối WS
  // signaling còn chưa được mở, vì trước đây chỉ CallScreen/IncomingCallScreen tự mở lúc CHÍNH NÓ mount).
  //
  // Mount ở đây — CÙNG vị trí/lý do initPushNotifications() (1 lần mỗi khi vào AppShell = 1 lần/phiên đăng
  // nhập, đúng yêu cầu "sau khi có phiên đăng nhập hợp lệ": AppShell nằm TRONG RequireAuth, xem App.tsx) — để:
  // (1) MỞ kết nối signaling NGAY dù CHƯA vào màn gọi nào (ensureCallSignalingSocket() singleton/idempotent —
  //     xem call-signaling-client.ts: tái dùng nguyên connection nếu đang OPEN, KHÔNG mở 2 lần khi
  //     CallScreen/IncomingCallScreen tự gọi lại sau đó);
  // (2) Lắng nghe 'incoming_call' BẤT KỂ đang ở route con nào trong AppShell, điều hướng sang màn gọi đến kèm
  //     dữ liệu THẬT qua location.state (callId/callerAgentId/callerName/kind — App.tsx IncomingCallRoute đọc
  //     lại để truyền tiếp cho IncomingCallScreen, thay vì mù dữ liệu như route demo cũ).
  //
  // QUYẾT ĐỊNH CHỐNG DOUBLE-LISTENER/DOUBLE-RING (ghi rõ theo yêu cầu brief): route /app/call/incoming
  // (IncomingCallScreen) và /app/call/:kind (CallScreen) đều nằm NGOÀI cây AppShell (fullscreen, không
  // sidebar/topbar — xem App.tsx, khối 2 route đó khai SAU khi đóng <Route element={<AppShell />}>). Nghĩa là
  // navigate() sang 1 trong 2 màn đó làm AppShell UNMOUNT NGAY LẬP TỨC — cleanup effect này tự gọi off() hủy
  // đăng ký listener TRƯỚC KHI màn gọi đến/màn gọi kịp mount xong. Hơn nữa IncomingCallScreen/CallScreen tự
  // chúng KHÔNG đăng ký listener nào cho type 'incoming_call' (đã xác nhận ở trên) nên dù giả sử có 1 tick
  // chồng lấp, KHÔNG có 2 listener nào cùng phản ứng với CÙNG 1 sự kiện 'incoming_call' — không thể nhân đôi
  // điều hướng/chuông reo. KHÔNG gọi closeCallSignalingSocket() ở cleanup effect này — kết nối là singleton
  // dùng CHUNG xuyên suốt phiên, CallScreen/IncomingCallScreen mount NGAY SAU khi AppShell unmount vẫn cần
  // đúng connection này còn mở; kết nối chỉ thật sự đóng lúc đăng xuất (xem lib/logout.ts — đã nối thêm
  // closeCallSignalingSocket() ở đó, CÙNG pattern resetRealtimeConnection()/resetChatRealtimeConnection() hiện
  // có, tránh lặp lại đúng bug LOW từng bị bắt trước đây: "logout không đóng WS cũ").
  useEffect(() => {
    ensureCallSignalingSocket().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[call-signaling-client] mở kết nối signaling lúc vào AppShell thất bại:', err);
    });
    const off = onCallSignalingMessage((msg) => {
      const nav = buildIncomingCallNavigation(msg);
      if (nav) navigate(nav.path, { state: nav.state });
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // B115-tiếp (2/8, Admin Demo "phải thông báo push nổi màn hình bất kể trường hợp nào như zalo") — banner/toast
  // "có tin nhắn mới" khi app đang mở nhưng KHÔNG ở đúng phòng vừa có tin (case #2) — CÙNG VỊ TRÍ/LÝ DO mount
  // như khối `ensureCallSignalingSocket()` ở trên (1 lần/phiên đăng nhập, lắng nghe BẤT KỂ đang ở route con
  // nào). `subscribeChatNotify()` tự mở kết nối real-time chat NGAY (không đợi mở phòng nào), xem chat-realtime.ts.
  //
  // Dùng ref cho pathname hiện tại (KHÔNG đưa location.pathname vào deps effect) — tránh unsubscribe/subscribe
  // lại listener mỗi lần đổi route (rẻ hơn, và tránh rớt đúng lúc chuyển màn); listener đọc giá trị MỚI NHẤT
  // qua ref tại thời điểm nhận sự kiện, không bị "đóng băng" giá trị cũ lúc effect chạy lần đầu.
  const currentPathRef = useRef(location.pathname);
  useEffect(() => {
    currentPathRef.current = location.pathname;
  }, [location.pathname]);

  // Item 2+3 (6/8) — có tin MỚI của phòng KHÔNG mở: cập nhật badge → GATE MUTE → hiện toast (app focus) HOẶC
  // thông báo cấp OS (app ở nền). Thay banner đơn 1-cái cũ bằng STACK toast (toast-store + ToastHost).
  useEffect(() => {
    const off = subscribeChatNotify((payload) => {
      const isCurrentRoom = currentPathRef.current === ROUTES.chatRoom(payload.roomId);
      // App Ở NỀN/không focus? EXE: dùng foreground THẬT từ main (document.hasFocus KHÔNG tin cậy trong Electron —
      // GỐC bug "exe không có push"). WEB/APK: document.hidden || !document.hasFocus(). Xem os-notification.isAppInBackground.
      const inBackground = isAppInBackground();

      // Case #1 — đang MỞ đúng phòng đó + app ĐANG HIỆN (foreground): tin đã hiện trong khung chat qua
      // 'new-message', KHÔNG báo gì thêm (như Zalo). GỐC bug (Admin Demo 7/8 "exe không có push góc phải"): TRƯỚC
      // return NGAY khi trùng phòng, KỂ CẢ lúc app thu tray/ở nền → user KHÔNG nhìn thấy khung mà cũng KHÔNG có OS
      // toast. FIX: chỉ bỏ qua khi trùng phòng VÀ đang foreground; nếu ở NỀN thì rơi xuống nhánh OS-notif bên dưới.
      if (isCurrentRoom && !inBackground) return;

      // Badge tin chưa đọc: CHỈ tăng khi KHÔNG phải phòng đang mở. Trùng-phòng-nhưng-ở-nền → KHÔNG +1 (mở app ra
      // là đọc ngay khung đang mở), chỉ cần OS toast. Item badge-fix (6/8): +1 tại chỗ (optimistic) thay vì re-fetch.
      if (!isCurrentRoom) {
        // ĐỒNG NHẤT SỐ ĐẾM (7/8) — nếu server kèm unreadCount (nguồn chân lý) → ĐẶT số theo server (mọi nền cùng
        // số, hết lệch exe/apk); thiếu (payload cũ) → +1 optimistic như trước.
        if (payload.unreadCount != null) {
          if (setRoomUnread(unreadMapRef.current, payload.roomId, payload.unreadCount)) recomputeUnreadBadge();
        } else {
          incrementRoomUnread(unreadMapRef.current, payload.roomId);
          recomputeUnreadBadge();
        }
        // ĐỒNG BỘ CACHE DANH SÁCH (7/8) — CHỈ khi ChatListScreen KHÔNG mount (nó tự patch khi mount → tránh +2).
        if (currentPathRef.current !== ROUTES.chat) {
          const cached = getFreshRoomsListCache();
          if (cached) {
            const patched = applyIncomingMessageToRooms(cached, payload.roomId, payload.preview, formatMessageTime(payload.createdAt));
            if (patched.found) setRoomsListCache(patched.rooms);
            else clearRoomsListCache(); // phòng chưa có trong cache (tin đầu) → buộc refetch lần mở kế.
          }
        }
      }
      // GATE MUTE (item 2) — tắt thông báo tin nhắn trên thiết bị này → không toast/không chuông/không OS-notif.
      if (!isMessageNotifEnabled()) return;

      const isGroup = payload.roomType === 'GROUP';
      // Kiểu Zalo: GROUP hiện tên nhóm + "Người gửi: nội dung"; DIRECT hiện thẳng tên người gửi + nội dung.
      const title = isGroup ? payload.roomName ?? 'Nhóm chat' : payload.senderName;
      const body = isGroup ? `${payload.senderName}: ${payload.preview}` : payload.preview;
      const parsedMs = new Date(payload.createdAt).getTime();
      const createdAtMs = Number.isNaN(parsedMs) ? Date.now() : parsedMs;

      // Item 12 (6/8) — avatar kiểu Zalo: DIRECT = ảnh người gửi; GROUP = ảnh nhóm (404 chưa đặt → fallback ô
      // màu+chữ). Màu/chữ fallback đồng nhất với avatar cùng đối tượng ở Danh bạ/khung chat (avatar-color.ts).
      const avatar = resolveNotifyAvatar(
        { roomType: payload.roomType, roomId: payload.roomId, senderAgentId: payload.senderAgentId, roomName: payload.roomName, senderName: payload.senderName },
        { agentAvatarUrl, roomAvatarUrl }
      );

      // EXE (Admin Demo chốt "1" 7/8) — LUÔN dùng popup góc phải-dưới Windows (notification.html), KHÔNG dùng toast
      // trong-app: 1 kiểu 1 vị trí nhất quán. Renderer đã gate ở trên (trùng phòng + foreground → return) nên tới
      // đây là "cần báo" → đẩy popup dù app đang focus (main.js không còn chặn isFocused). WEB: giữ như cũ —
      // foreground = toast tự vẽ (ToastHost) + chuông; ở nền = OS Notification (cần quyền) + chuông web-audio.
      if (isElectronRuntime() || inBackground) {
        // Tải avatar → data URL để đính làm icon thông báo OS (best-effort). 404/lỗi → thông báo KHÔNG icon (như cũ).
        // KHÔNG chặn: gửi thông báo NGAY khi có (hoặc không) icon, không để lỗi tải avatar làm rớt thông báo.
        const onClick = (): void => {
          navigate(ROUTES.chatRoom(payload.roomId));
        };
        // 7/8 — cờ ÂM THANH (isAudioEnabled) đính vào popup EXE để popup tôn trọng toggle "Âm thanh" ở Cài đặt
        // (trước popup luôn kêu). WEB Notification không có cờ này (âm do OS/trình duyệt lo).
        const playSound = isAudioEnabled();
        fetchAttachmentDataUrl(avatar.avatarUrl).then(
          (iconDataUrl) => notifyOsBackground({ title, body, roomId: payload.roomId, iconDataUrl, playSound }, onClick),
          () => notifyOsBackground({ title, body, roomId: payload.roomId, playSound }, onClick)
        );
        // CHUÔNG khi Ở NỀN (Admin Demo 7/8 "web ở nền mất chuông, âm lúc có lúc không") — GỐC: nhánh này TRƯỚC đây
        // return ngay sau notifyOsBackground, mà WEB Notification KHÔNG kèm web-audio → web nền im hoàn toàn. Nay
        // WEB tự phát chuông (AudioContext vẫn chạy ở tab ẩn khi đã mở khoá). EXE nền KHÔNG kêu ở đây vì popup
        // tự-vẽ (notification.html) đã tự kêu → tránh kêu ĐÔI. 1 tin = 1 chuông (Admin Demo 8/8) — KHÔNG throttle;
        // audio-player tự xếp hàng chuông nối tiếp khi dồn dập.
        if (!isElectronRuntime() && playSound) playNotificationChime();
        return;
      }
      pushToast(
        {
          roomId: payload.roomId,
          title,
          body,
          avatarColor: avatar.avatarColor,
          avatarLabel: avatar.avatarLabel,
          avatarUrl: avatar.avatarUrl,
          createdAtMs
        },
        (getToastDurationSec() + 1) * 1000 // tự ẩn = thời-gian-cấu-hình + 1s (Admin Demo chốt).
      );
      // 1 tin = 1 chuông (Admin Demo 8/8) — KHÔNG throttle gộp-lô; audio-player xếp hàng chuông nối tiếp khi dồn dập.
      playNotificationChime();
    });
    return off;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // EXE — click vào OS Notification (main.js gửi lại renderer) → mở đúng phòng. WEB xử lý click ngay trong
  // notifyOsBackground(). No-op nếu không phải EXE.
  useEffect(() => wireOsNotificationClick((roomId) => navigate(ROUTES.chatRoom(roomId))), []);

  // EXE (7/8) — nhận trạng thái FOREGROUND THẬT từ main để quyết định inBackground chính xác (GỐC "exe không có
  // push": document.hasFocus không tin cậy). WEB/APK: no-op. Xem os-notification.wireForegroundTracking.
  useEffect(() => wireForegroundTracking(), []);

  // WEB — xin quyền Notification 1 lượt để hiện OS toast khi tab ẩn. EXE/native no-op (xem os-notification.ts).
  useEffect(() => {
    void ensureWebNotificationPermission();
  }, []);

  // Demo capture (?notif=1) — đẩy 1 toast MẪU vào store để chụp ảnh (thay NotificationToast mock cũ). Chỉ 1 lần,
  // giữ lâu (60s) để chụp ổn định.
  const demoPushedRef = useRef(false);
  useEffect(() => {
    if (searchParams.get('notif') !== '1' || demoPushedRef.current) return;
    demoPushedRef.current = true;
    pushToast(
      {
        roomId: 'room-hong',
        title: 'Trần Thị Hồng',
        body: 'Dạ em gửi lại QR nhận tiền ạ',
        avatarColor: '#16a34a',
        avatarLabel: 'T',
        createdAtMs: Date.now()
      },
      60_000
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-appbg">
      {/* Banner BẢN MỚI (15/8, sửa 16/8 "tràn mép dưới điện thoại") — pill NỔI giữa-dưới, tôn trọng safe-area
          (env inset-bottom → KHÔNG tràn mép/đè nút home phone), max-width + wrap → không tràn ngang màn nhỏ,
          KHÔNG đè header trên. pointer-events-none ở lớp bọc để không chặn thao tác toàn màn, pill thì bật lại. */}
      {newVersionAvailable && (
        <div
          className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex justify-center px-3"
          style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
        >
          <div className="pointer-events-auto flex max-w-[94%] flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-2xl bg-brand px-4 py-2.5 text-sm text-white shadow-lg">
            <span>Đã có phiên bản mới của SigMa.</span>
            <button onClick={() => window.location.reload()} className="shrink-0 rounded-full bg-white/95 px-4 py-1 text-xs font-semibold text-brand hover:bg-white">
              Tải lại ngay
            </button>
          </div>
        </div>
      )}
      <div className="hidden lg:flex">
        <Sidebar
          activePath={location.pathname}
          onNavigate={(p) => navigate(p)}
          unreadChat={unreadChat}
          pendingFriendRequests={pendingFriendRequests}
          onOpenSellTid={() => navigate(ROUTES.sellTid)}
          onLogout={() => performLogout(navigate)}
        />
      </div>

      {mobileOpen && (
        <div className="fixed inset-0 z-30 flex lg:hidden">
          <div className="absolute inset-0 bg-slate-900/40" onClick={() => setMobileOpen(false)} />
          <div className="relative">
            <Sidebar
              activePath={location.pathname}
              onNavigate={(p) => {
                navigate(p);
                setMobileOpen(false);
              }}
              unreadChat={unreadChat}
              pendingFriendRequests={pendingFriendRequests}
              onOpenSellTid={() => {
                navigate(ROUTES.sellTid);
                setMobileOpen(false);
              }}
              onLogout={() => performLogout(navigate)}
            />
          </div>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          title={titleFor(location.pathname)}
          theme={theme}
          onToggleTheme={toggle}
          onOpenMobileMenu={() => setMobileOpen(true)}
          onOpenCalendar={() => navigate(ROUTES.calendar)}
        />
        {/* Banner nhắc BẬT QUYỀN THÔNG BÁO trình duyệt (7/8) — CHỈ web + khi quyền chưa 'granted' → để nhận
            desktop notification khi ở tab/ứng dụng khác. exe/apk tự ẩn (xem NotificationPermissionBanner). */}
        <NotificationPermissionBanner />
        <div className="min-h-0 flex-1 overflow-hidden">
          {/* Port nguyên xi từ GLB desktop Dashboard.tsx (Admin Demo 15/7) — key thay đổi theo route →
              re-mount + replay animation `.page-enter` (styles.css) mỗi lần chuyển màn chính. */}
          <div key={location.pathname} className="page-enter h-full">
            <Outlet context={{ theme, toggleTheme: toggle } satisfies AppShellContext} />
          </div>
        </div>
      </div>

      {location.pathname === ROUTES.sellTid && <SellTidModal onClose={() => navigate(ROUTES.chat)} />}

      {/* Item 3 (6/8) — STACK toast tin nhắn kiểu Zalo (thay banner đơn cũ): xếp theo thời gian, quick-reply
          inline, 2 kiểu corner/top-drop theo Cài đặt. Bao gồm cả tin thật (subscribeChatNotify) lẫn demo ?notif=1. */}
      <ToastHost />

      {/* Mục 36 — bong bóng cuộc gọi nổi (avatar + đồng hồ + viền pulse), bấm quay lại cuộc gọi. */}
      {showCallPill && (
        <button
          onClick={() => navigate(ROUTES.call('voice'))}
          title="Quay lại cuộc gọi"
          className="fixed bottom-24 right-4 z-40 flex flex-col items-center gap-1"
        >
          <span className="relative flex h-14 w-14 items-center justify-center">
            <span className="absolute inset-0 animate-ping rounded-full bg-brand/40" />
            <span className="relative flex h-12 w-12 items-center justify-center rounded-full border-2 border-brand bg-[#16a34a] text-lg font-bold text-white shadow-card">
              T
            </span>
          </span>
          <span className="rounded-full bg-slate-900/80 px-2 py-0.5 font-mono text-[11px] text-white">02:34</span>
        </button>
      )}
    </div>
  );
}
