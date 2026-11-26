// Routing/app shell (spec mục 5) — dùng react-router-dom thay vì tự quản state, chủ yếu để
// scripts/capture-frames.ts điều hướng thẳng qua URL (page.goto) khi chụp ảnh demo từng màn.
import { lazy, Suspense, useEffect, useRef, useState, type JSX } from 'react';
import { CongNoDaiLyScreen } from './screens/CongNoDaiLyScreen';
import {
  useOutletContext,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
  Navigate,
  Outlet,
  Route,
  Routes
} from 'react-router';
import { AppShell, type AppShellContext } from './components/AppShell';
import { ChunkErrorBoundary } from './components/ChunkErrorBoundary';
// Lane D vòng 2 (3/8) — code-split theo route: mỗi màn nạp ĐỘNG (React.lazy) thay vì import tĩnh đầu file →
// tách khỏi chunk chính (index.js). TRƯỚC ĐÂY toàn bộ ~22 màn + phụ thuộc nặng (leaflet/qrcode qua các màn con)
// gộp vào 1 chunk 799KB tải hết lúc mở app dù người dùng chỉ vào 1-2 màn. Giờ chunk chính chỉ còn shell +
// router + màn đang xem; các màn khác tải khi điều hướng tới (bọc <Suspense> ở <Routes>). AppShell/AppSplash
// GIỮ import tĩnh (khung + splash luôn cần ngay từ đầu). Named export → map về `default` cho React.lazy.
const LoginScreen = lazy(() => import('./screens/LoginScreen').then((m) => ({ default: m.LoginScreen })));
const OtpScreen = lazy(() => import('./screens/OtpScreen').then((m) => ({ default: m.OtpScreen })));
const ChatListScreen = lazy(() => import('./screens/ChatListScreen').then((m) => ({ default: m.ChatListScreen })));
const ConversationScreen = lazy(() => import('./screens/ConversationScreen').then((m) => ({ default: m.ConversationScreen })));
const RoomRevenueScreen = lazy(() => import('./screens/RoomRevenueScreen').then((m) => ({ default: m.RoomRevenueScreen })));
const MyRevenueScreen = lazy(() => import('./screens/MyRevenueScreen').then((m) => ({ default: m.MyRevenueScreen })));
const LoHistoryScreen = lazy(() => import('./screens/LoHistoryScreen').then((m) => ({ default: m.LoHistoryScreen })));
const ReconcileDetailScreen = lazy(() => import('./screens/ReconcileDetailScreen').then((m) => ({ default: m.ReconcileDetailScreen })));
const KpiReportScreen = lazy(() => import('./screens/KpiReportScreen').then((m) => ({ default: m.KpiReportScreen })));
const InvestorRevenueScreen = lazy(() => import('./screens/InvestorRevenueScreen').then((m) => ({ default: m.InvestorRevenueScreen })));
const OcrSendScreen = lazy(() => import('./screens/OcrSendScreen').then((m) => ({ default: m.OcrSendScreen })));
const StatementReconScreen = lazy(() => import('./screens/StatementReconScreen').then((m) => ({ default: m.StatementReconScreen })));
const AlphaAggregateScreen = lazy(() => import('./screens/AlphaAggregateScreen').then((m) => ({ default: m.AlphaAggregateScreen })));
const BaoCoReportScreen = lazy(() => import('./screens/BaoCoReportScreen').then((m) => ({ default: m.BaoCoReportScreen })));
const BinCheckScreen = lazy(() => import('./screens/BinCheckScreen').then((m) => ({ default: m.BinCheckScreen })));
const PromoProgramsScreen = lazy(() => import('./screens/PromoProgramsScreen').then((m) => ({ default: m.PromoProgramsScreen })));
const ContactsScreen = lazy(() => import('./screens/ContactsScreen').then((m) => ({ default: m.ContactsScreen })));
const SettingsScreen = lazy(() => import('./screens/SettingsScreen').then((m) => ({ default: m.SettingsScreen })));
const QrDisplayScreen = lazy(() => import('./screens/QrDisplayScreen').then((m) => ({ default: m.QrDisplayScreen })));
const MyQrScreen = lazy(() => import('./screens/MyQrScreen').then((m) => ({ default: m.MyQrScreen })));
const QrLoginScreen = lazy(() => import('./screens/QrLoginScreen').then((m) => ({ default: m.QrLoginScreen })));
const QrScannerScreen = lazy(() => import('./screens/QrScannerScreen').then((m) => ({ default: m.QrScannerScreen })));
const AccountSecurityScreen = lazy(() => import('./screens/AccountSecurityScreen').then((m) => ({ default: m.AccountSecurityScreen })));
const CallScreen = lazy(() => import('./screens/CallScreen').then((m) => ({ default: m.CallScreen })));
const IncomingCallScreen = lazy(() => import('./screens/IncomingCallScreen').then((m) => ({ default: m.IncomingCallScreen })));
const ProfileScreen = lazy(() => import('./screens/ProfileScreen').then((m) => ({ default: m.ProfileScreen })));
const PublicProfileScreen = lazy(() => import('./screens/PublicProfileScreen').then((m) => ({ default: m.PublicProfileScreen })));
const DiaryScreen = lazy(() => import('./screens/DiaryScreen').then((m) => ({ default: m.DiaryScreen })));
const CalendarScreen = lazy(() => import('./screens/CalendarScreen').then((m) => ({ default: m.CalendarScreen })));
const LockScreenPreview = lazy(() => import('./screens/LockScreenPreview').then((m) => ({ default: m.LockScreenPreview })));
const GalleryPage = lazy(() => import('./screens/GalleryPage').then((m) => ({ default: m.GalleryPage })));
import { CHAT_ROOMS } from './mock-data/chats';
import { ROUTES } from './routes';
import { getSession, onSessionExpired } from './lib/session';
import { startPresenceHeartbeat, sendPresenceOffline } from './lib/presence-heartbeat';
import { subscribeRoomRead, subscribeAllRead } from './lib/chat-read-events';
import { clearRoomNotification, clearAllRoomNotifications } from './lib/os-notification';
import { performLogout } from './lib/logout';
import { runTopBackHandler } from './lib/back-intercept';
import { createOrGetDirectRoom, listChatRoomsWithNames } from './lib/chat-client';
import { getFreshRoomsListCache, setRoomsListCache } from './lib/rooms-list-cache';
import { buildContactCallNavigation, buildStartCallNavigation } from './lib/call-signaling-client';
import type { ChatRoom } from './mock-data/types';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import { AppSplash } from './components/AppSplash';

// Bảo vệ route (mục 5 nhiệm vụ "chat lõi" + audit HIGH 24/7 phần đăng xuất): mọi route TRONG AppShell
// (chat, đối soát, KPI, cài đặt...) đều cần phiên đăng nhập RC thật — chưa có getSession() → về thẳng
// /login. Áp DÙNG CHUNG cho toàn bộ nhóm route AppShell (không chỉ /app/chat riêng) vì tất cả đều đọc
// dữ liệu qua session hiện tại, không có lý do tách riêng từng route.
function RequireAuth(): JSX.Element {
  // GIA CỐ bug "đăng xuất KẸT" (11/9, xem lib/logout.ts + harness-logout.ts): subscribe location để React
  // KHÔNG bail-out re-render component này khi route đổi (element prop ổn định + không consume context nào →
  // trước đây React bỏ qua, getSession() KHÔNG được đọc lại — nếu 1 điều hướng /login bị nuốt (sentinel
  // back-intercept pop nhầm) thì người dùng đứng nguyên trong /app/* với session ĐÃ XÓA mà guard không hề
  // chạy lại). Có useLocation() → mọi lần đổi location đều re-check session → session chết là bật về /login
  // ở lần điều hướng kế tiếp, không kẹt vĩnh viễn.
  useLocation();
  const session = getSession();
  if (!session) return <Navigate to={ROUTES.login} replace />;
  return (
    <>
      <PresenceHeartbeatWatcher />
      <NotificationClearWatcher />
      <Outlet />
    </>
  );
}

// Việc #24 Part B (6/8, Admin Demo "badge icon launcher không clear khi đọc") — khi ĐỌC 1 phòng (emitRoomRead từ
// ConversationScreen — KHÔNG sửa file đó), hủy notification native của phòng đó → badge launcher APK giảm/về 0.
// APK-only (clearRoomNotification tự no-op web/exe). Đặt Ở App.tsx cấp cao (KHÔNG đụng ConversationScreen), mount
// suốt phiên đăng nhập cùng PresenceHeartbeatWatcher.
function NotificationClearWatcher(): null {
  useEffect(() => {
    const off = subscribeRoomRead((roomId) => clearRoomNotification(roomId));
    // ĐỒNG BỘ ĐA THIẾT BỊ (7/8) — "đọc tất cả" (kể cả từ máy khác qua WS all-read-self → emitAllRead) → hủy MỌI
    // notification native → badge launcher APK về 0.
    const offAll = subscribeAllRead(() => clearAllRoomNotifications());
    return () => { off(); offAll(); };
  }, []);
  return null;
}

// PRESENCE real-time (6/8, Admin Demo) — CHỈ chạy khi ĐÃ đăng nhập: RequireAuth render component này cho MỌI route
// /app/* và unmount NGAY khi về /login (đăng xuất/hết phiên). start lúc mount, stop + báo /offline lúc unmount →
// server phát presence-offline realtime cho bạn bè/đồng-thành-viên (0 độ trễ). Mount 1 lần cho cả cụm route
// (RequireAuth KHÔNG remount khi điều hướng nội bộ giữa các /app/*, chỉ Outlet đổi) → heartbeat liên tục suốt
// phiên, chỉ dừng khi thật sự rời khu vực đăng nhập. Đặt Ở App.tsx (KHÔNG đụng AppShell.tsx — agent khác sở hữu).
function PresenceHeartbeatWatcher(): null {
  useEffect(() => {
    const stop = startPresenceHeartbeat();
    return () => {
      stop();
      void sendPresenceOffline(); // đăng xuất/hết phiên → báo offline NGAY (best-effort, KHÔNG throw).
    };
  }, []);
  return null;
}

// SigMa (27/7) — root path '/' KHÔNG còn hiện GalleryPage (bản ship thật cho khách trước đây mở app ra
// thấy ngay màn trưng bày thiết kế mock, xem BUGS_FIXED.md). Đăng nhập rồi → thẳng danh sách chat, chưa đăng
// nhập → màn đăng nhập — cùng logic RequireAuth, tách riêng vì đây là redirect vô điều kiện, không bọc AppShell.
function RootRedirect(): JSX.Element {
  const session = getSession();
  return <Navigate to={session ? ROUTES.chat : ROUTES.login} replace />;
}

// --- route wrappers: chuyển callback-props của từng screen sang điều hướng react-router thật ---

function LoginRoute(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  // true khi SessionExpiredWatcher vừa điều hướng về đây do token RC hết hạn (state.expired, xem
  // SessionExpiredWatcher dưới) — KHÁC lần mở app đầu tiên/bấm "Đăng xuất" chủ động (không có state này).
  const expired = (location.state as { expired?: boolean } | null)?.expired === true;
  // #3 (6/8) — bị ĐÁ do đăng nhập thiết bị khác cùng nền (kiểu Zalo) → banner RIÊNG thay vì "phiên hết hạn".
  const revoked = (location.state as { revoked?: boolean } | null)?.revoked === true;
  return (
    <LoginScreen
      expiredNotice={expired}
      revokedNotice={revoked}
      onSubmitEmail={(email) => navigate(ROUTES.otp, { state: { email } })}
      onLoggedIn={() => navigate(ROUTES.chat)}
      onQrLogin={() => navigate(ROUTES.qrLogin)}
    />
  );
}

// SIGMA (3/8) — màn đăng nhập bằng QR phía MÁY TẠO QR (public). Đăng nhập xong → vào danh sách chat.
function QrLoginRoute(): JSX.Element {
  const navigate = useNavigate();
  return <QrLoginScreen onLoggedIn={() => navigate(ROUTES.chat)} onBack={() => navigate(ROUTES.login)} />;
}

// SIGMA (3/8) — màn quét mã đăng nhập phía ĐIỆN THOẠI (trong AppShell — cần đã đăng nhập).
function QrScanRoute(): JSX.Element {
  const navigate = useNavigate();
  return <QrScannerScreen onBack={() => navigate(-1)} />;
}

// 24/7 (task "duy trì đăng nhập 24/24 + tự về /login khi hết hạn") — rc-realtime.ts/agent-api-client.ts/
// kpi-client.ts (tầng gọi API chung) gọi handleSessionExpired() (lib/session.ts) khi phát hiện 401 "token RC
// hết hạn/không hợp lệ" — hàm đó CHỈ dọn localStorage + bắn sự kiện qua pub/sub thuần (KHÔNG biết gì về
// router, đặt ở lib/ để mọi client tái dùng được, kể cả ngoài React). Component này là NƠI DUY NHẤT lắng
// nghe sự kiện đó và THỰC SỰ điều hướng (cần router context — useNavigate) → về /login kèm state.expired=true
// để LoginScreen hiện banner rõ ràng thay vì lỗi mập mờ nằm rải rác ở từng màn. Mount xuyên suốt vòng đời App
// (không chỉ trong RequireAuth) để bắt được sự kiện bất kỳ lúc nào người dùng đang ở route nào (chat, KPI, Lô...).
function SessionExpiredWatcher(): null {
  const navigate = useNavigate();
  useEffect(() => {
    return onSessionExpired((reason) => {
      // #3 (6/8) — 'revoked' (bị đá do đăng nhập thiết bị khác cùng nền) hiện banner RIÊNG; 'expired' giữ như cũ.
      navigate(ROUTES.login, { replace: true, state: reason === 'revoked' ? { revoked: true } : { expired: true } });
    });
  }, [navigate]);
  return null;
}

// Việc 3 (1/8, Admin Demo báo "nút back Android thoát app thay vì lùi bước trong Cài đặt") — TRƯỚC ĐÂY toàn app
// KHÔNG có bất kỳ listener nào cho nút back phần cứng/gesture Android (đã grep xác nhận KHÔNG có
// `backButton`/`App.addListener` ở apps/web-demo/src trước fix này). KHÔNG đăng ký listener → Capacitor để
// WebView xử lý theo native back-stack mặc định, KHÔNG biết gì về route SPA hiện tại → bấm back ở màn con (vd
// Cài đặt) thoát thẳng app thay vì lùi 1 bước như hành vi Android chuẩn.
//
// CHỈ áp dụng native Android (Capacitor.isNativePlatform() + getPlatform()==='android' — web/dev bỏ qua hoàn
// toàn, iOS không có nút back phần cứng nên KHÔNG đăng ký, gesture vuốt cạnh iOS do hệ điều hành tự xử lý
// riêng, không qua sự kiện này, đúng brief). Logic theo ĐÚNG mẫu chính thức Capacitor App plugin (canGoBack +
// exitApp): route HIỆN TẠI KHÔNG phải màn gốc (ROUTES.chat — danh sách chat, "Trang chủ") VÀ WebView còn lùi
// được (`canGoBack` Capacitor tự tính từ native back-stack, phản ánh đúng các lần pushState của react-router
// BrowserRouter) → `navigate(-1)` lùi 1 bước trong SPA. Ngược lại (đang ở màn gốc, HOẶC hết chỗ lùi) →
// `CapacitorApp.exitApp()` — hành vi mặc định "thoát/ẩn app" (Capacitor KHÔNG tự làm hộ việc này 1 khi ĐÃ có
// listener riêng, phải tự gọi, xem docs chính thức Capacitor App plugin phần backButton).
//
// Dùng `locationRef` (thay vì đưa `location` vào dependency array useEffect) để KHÔNG phải gỡ+đăng ký lại
// listener mỗi lần đổi route (tốn kém vô ích, listener chỉ cần đăng ký ĐÚNG 1 LẦN lúc mount, luôn đọc route
// MỚI NHẤT qua ref tại thời điểm nút back được bấm).
function AndroidBackButtonWatcher(): null {
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;

  useEffect(() => {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android') return undefined;

    const handlePromise = CapacitorApp.addListener('backButton', ({ canGoBack }) => {
      // Admin Demo 18/8 — back CHỈ lùi ĐÚNG 1 bước. Nếu có OVERLAY đang mở (panel Thông tin hội thoại/Bảng tin
      // ghim/modal…, đăng ký qua useBackIntercept) → đóng overlay TRÊN CÙNG trước, KHÔNG lùi route (tránh nhảy
      // thẳng phòng-chat → danh sách, bỏ qua bước đóng panel).
      if (runTopBackHandler()) return;
      const isRootScreen = locationRef.current.pathname === ROUTES.chat;
      if (!isRootScreen && canGoBack) {
        navigate(-1);
      } else {
        // Admin Demo 8/8 — nút BACK ở màn GỐC PHẢI hành xử như nút HOME: đưa app XUỐNG NỀN giữ nguyên trạng thái
        // (như Zalo), KHÔNG exitApp() (thoát hẳn → mở lại cold-start splash + reload, mất màn đang thao tác).
        // minimizeApp() = moveTaskToBack: activity sống, mở lại resume đúng giao diện đang dùng.
        void CapacitorApp.minimizeApp();
      }
    });

    return () => {
      void handlePromise.then((handle) => handle.remove());
    };
  }, [navigate]);

  return null;
}

function OtpRoute(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state ?? {}) as { email?: string };
  const email = state.email ?? 'ban@vidu.com';
  return <OtpScreen email={email} onVerified={() => navigate(ROUTES.chat)} onBack={() => navigate(ROUTES.login)} />;
}

function ChatListRoute(): JSX.Element {
  const navigate = useNavigate();
  // ?cat=<id> lọc theo phân loại (sidebar mục 21), ?manage=1 mở sẵn modal quản lý phân loại
  // (capture-frames chụp state modal mở).
  const [searchParams] = useSearchParams();
  return (
    <ChatListScreen
      onOpenRoom={(room) => navigate(ROUTES.chatRoom(room.id))}
      onOpenRoomId={(roomId) => navigate(ROUTES.chatRoom(roomId))}
      onOpenRoomMessage={(roomId, messageId) => navigate(`${ROUTES.chatRoom(roomId)}?jumpTo=${encodeURIComponent(messageId)}`)}
      initialCategoryId={searchParams.get('cat') ?? undefined}
      openManage={searchParams.get('manage') === '1'}
      initialQuery={searchParams.get('q') ?? undefined}
    />
  );
}

// Phòng chat đến từ hệ chat lõi tự xây THẬT (Phase 3 cutover 29/7, listChatRoomsWithNames() — chat-client.ts,
// THAY listRooms() cũ của rc-realtime.ts/Rocket.Chat). ChatListScreen tự gọi listChatRoomsWithNames() riêng
// cho danh sách, ở đây gọi LẠI (không cache chung — chấp nhận double-fetch nhỏ, đúng phạm vi "chat lõi", chưa
// làm state management chung) để tự tìm đúng room theo :roomId trên URL.
function ConversationRoute(): JSX.Element {
  const navigate = useNavigate();
  const { roomId } = useParams();
  const [searchParams] = useSearchParams();
  // B105 (2/8, Admin Demo yêu cầu "mở khung chat không chờ loading chặn màn hình, như Zalo") — khởi tạo TỪ cache
  // dùng chung (lib/rooms-list-cache.ts) nếu phòng ĐÃ có sẵn trong đó (trường hợp phổ biến nhất: vừa bấm vào
  // 1 phòng từ ChatListScreen, cache vừa được set NGAY TRƯỚC LÚC điều hướng) → render khung chat NGAY LẬP TỨC,
  // không còn màn "Đang tải phòng chat..." chặn giữa. undefined = thật sự chưa có gì (cache miss/nguội) — VẪN
  // GIỮ hành vi chờ như cũ cho trường hợp đó (an toàn cho phòng DIRECT vừa tạo — xem comment
  // rooms-list-cache.ts giải thích tại sao KHÔNG được bỏ fetch fresh).
  const [room, setRoom] = useState<ChatRoom | null | undefined>(() => {
    const cached = getFreshRoomsListCache();
    return cached ? (cached.find((r) => r.id === roomId) ?? undefined) : undefined;
  });

  useEffect(() => {
    // Đổi phòng (điều hướng giữa 2 hội thoại khác nhau, không phải remount) — seed lại từ cache cho phòng MỚI
    // trước khi effect fetch chạy, tránh 1 nhịp hiện loading thừa nếu phòng mới cũng đã có sẵn trong cache.
    const cached = getFreshRoomsListCache();
    setRoom(cached ? (cached.find((r) => r.id === roomId) ?? undefined) : undefined);

    let cancelled = false;
    // LUÔN fetch fresh dù cache hit hay miss — cache chỉ dùng để RENDER SỚM, không thay thế nguồn dữ liệu thật
    // (đảm bảo đúng/mới nhất, và phòng DIRECT vừa tạo — chưa kịp vào cache — vẫn được tìm ra đúng qua đây).
    listChatRoomsWithNames().then((res) => {
      if (cancelled) return;
      if (!res.ok) {
        setRoom((prev) => prev ?? null); // đã có sẵn từ cache thì GIỮ NGUYÊN (không giật về lỗi khi cache còn hiển thị được), cache miss mới thật sự báo null.
        return;
      }
      setRoomsListCache(res.data);
      setRoom(res.data.find((r) => r.id === roomId) ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [roomId]);

  if (room === undefined) {
    return <div className="flex h-full items-center justify-center text-sm text-slate-400">Đang tải phòng chat...</div>;
  }
  if (!room) return <Navigate to={ROUTES.chat} replace />;
  return (
    <ConversationScreen
      room={room}
      onBack={() => navigate(ROUTES.chat)}
      // fix-call-wiring (31/7) — TRƯỚC ĐÂY chỉ navigate {roomId}, KHÔNG BAO GIỜ kèm agentId đối phương → nút
      // "Gọi thoại"/"Gọi video" từ 1 hội thoại THẬT luôn rơi vào "chế độ xem trước" của CallScreen (KHÔNG đổ
      // chuông thật, xem comment đầu file đó) — gap để lại CỐ Ý lúc build Phase 4, giờ đã đóng: ConversationScreen
      // tự resolve `calleeAgentId` (state callPeerAgentId, xem effect getChatRoomDetail() ở đó) và truyền lên
      // qua tham số thứ 2 của onStartCall. buildStartCallNavigation() (call-signaling-client.ts, hàm THUẦN,
      // CÙNG pattern buildIncomingCallNavigation()) quyết định path+state — trả `null` cho phòng GROUP (Phase 4
      // chỉ 1-1; ConversationScreen cũng đã tự ẩn nút gọi cho GROUP, đây là lớp phòng thủ thứ 2) nên không điều
      // hướng gì trong trường hợp đó.
      onStartCall={(kind, calleeAgentId) => {
        // fix-call-name (31/7, B67) — truyền kèm room.name THẬT (đã có sẵn từ listChatRoomsWithNames(), không
        // cần round-trip thêm) làm calleeName, để CallRoute hiển thị ĐÚNG tên thay vì tra CHAT_ROOMS mock.
        const nav = buildStartCallNavigation(kind, room, calleeAgentId ?? null, room.name);
        if (nav) navigate(nav.path, { state: nav.state });
      }}
      onOpenRevenue={() => navigate(ROUTES.chatRoomRevenue(room.id))}
      // "Tạo nhóm chat cùng người này" (30/7) — tạo phòng GROUP mới từ DIRECT xong → mở luôn phòng mới (CÙNG
      // convention onBack/onOpenRevenue: điều hướng nằm ở route này, không trong ConversationScreen).
      onCreateGroupNavigate={(newRoomId) => navigate(ROUTES.chatRoom(newRoomId))}
      initialEmojiOpen={searchParams.get('emoji') === '1'}
      // B107 (2/8) — bấm 1 kết quả "Tin nhắn" từ panel tìm kiếm toàn cục (ChatListScreen.tsx) điều hướng kèm
      // ?jumpTo=<messageId> — ConversationScreen tự cuộn/nổi bật tin đó (tự tải thêm trang cũ hơn nếu cần).
      initialJumpToMessageId={searchParams.get('jumpTo') ?? undefined}
    />
  );
}

// Màn cuộc gọi giả lập (mục 28) — :kind = voice|video; room lấy từ location.state (mặc định:
// voice = 1-1 với room-hong, video = nhóm đối soát) để capture-frames goto thẳng URL vẫn có dữ liệu.
//
// Nợ độ tin cậy đánh thức cuộc gọi (30/7) — location.state giờ CÓ THỂ kèm callId/peerAgentId THẬT (do
// IncomingCallRoute bên dưới truyền qua khi người dùng bấm "Chấp nhận" 1 cuộc gọi đến THẬT — xem
// AppShell.tsx global listener 'incoming_call'). CẢ HAI field ĐỀU TÙY CHỌN — undefined (route demo cũ,
// capture-frames goto thẳng URL không kèm state) → CallScreen tự rơi về "chế độ xem trước" y hệt trước đây
// (xem CallScreen.tsx isRealMode), KHÔNG đổi hành vi mặc định.
//
// fix-call-wiring (31/7) — thêm `calleeAgentId` (vai trò CALLER, do ConversationRoute ở trên truyền qua khi
// bấm "Gọi thoại"/"Gọi video" từ 1 hội thoại DIRECT THẬT — xem buildStartCallNavigation()). TÙY CHỌN CÙNG lý do
// callId/peerAgentId ở trên — undefined (route demo cũ/GROUP đã bị chặn ở ConversationRoute) → CallScreen vẫn
// rơi về "chế độ xem trước", KHÔNG đổi hành vi mặc định.
function CallRoute(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const { kind } = useParams();
  const callKind: 'voice' | 'video' = kind === 'video' ? 'video' : 'voice';
  const state =
    (location.state as
      | { roomId?: string; callId?: string; peerAgentId?: number; calleeAgentId?: number; calleeName?: string }
      | null) ?? {};
  const fallbackId = callKind === 'video' ? 'room-nhom-doi-soat' : 'room-hong';
  const mockRoom = CHAT_ROOMS.find((r) => r.id === (state.roomId ?? fallbackId)) ?? CHAT_ROOMS[0];
  // fix-call-name (31/7, B67 xem BUGS_FIXED.md) — BUG THẬT (Admin Demo test máy thật: gọi "Hải Nam" cả thoại lẫn
  // video đều hiện tên "Trần Thị Hồng" trên màn của MÌNH — WebRTC vẫn đổ chuông ĐÚNG người, chỉ SAI TÊN HIỂN
  // THỊ). Gốc: `CHAT_ROOMS` là mock tĩnh 5 phòng demo; phòng DIRECT thật tạo qua `createOrGetDirectRoom()` có
  // id hoàn toàn khác (không match mock) nên `.find()` phía trên GẦN NHƯ LUÔN miss → rơi về `CHAT_ROOMS[0]`
  // ("Trần Thị Hồng") BẤT KỂ đang gọi ai. Khi `state.roomId` THẬT có mặt (nay luôn có kèm `calleeName` — xem
  // `ConversationRoute`/`ContactsRoute`/`IncomingCallRoute.onAccept` dưới, đều đi qua
  // `buildStartCallNavigation()`/`buildContactCallNavigation()`) → dựng `room` từ DỮ LIỆU THẬT: `.id` = roomId
  // thật (CallScreen dùng để điều hướng `onEnd`/`onMinimize` về đúng phòng chat), `.name` = calleeName thật —
  // các field còn lại (`avatarColor`/`isGroup`/...) chỉ ảnh hưởng THẨM MỸ nên tái dùng filler từ `mockRoom`,
  // không cần dữ liệu thật. KHÔNG có `state.roomId` (route demo cũ/capture-frames goto thẳng URL, không kèm
  // state) → GIỮ NGUYÊN 100% hành vi cũ (room mock đầy đủ).
  const room: ChatRoom = state.roomId ? { ...mockRoom, id: state.roomId, name: state.calleeName ?? mockRoom.name } : mockRoom;
  return (
    <CallScreen
      kind={callKind}
      room={room}
      callId={state.callId}
      peerAgentId={state.peerAgentId}
      calleeAgentId={state.calleeAgentId}
      onEnd={() => navigate(ROUTES.chatRoom(room.id))}
      // Mục 36 — thu nhỏ: về chat kèm ?callpill=1 (AppShell vẽ bong bóng nổi).
      onMinimize={() => navigate(`${ROUTES.chatRoom('room-hong')}?callpill=1`)}
    />
  );
}

// Màn cuộc gọi ĐẾN (mục 36) — chấp nhận → gọi video nhóm; từ chối → danh sách chat; nhắn nhanh →
// mở thẳng phòng chat 1-1.
//
// Nợ độ tin cậy đánh thức cuộc gọi (30/7) — location.state giờ CÓ THỂ kèm dữ liệu THẬT (callId/callerAgentId/
// callerName/kind) do AppShell.tsx global listener truyền qua lúc điều hướng vào đây từ 1 sự kiện
// 'incoming_call' THẬT nhận qua WebSocket signaling (call-signaling-client.ts buildIncomingCallNavigation()).
// KHÔNG có state (route demo cũ /app/call/incoming goto thẳng URL, vd capture-frames/GalleryPage) → mọi field
// undefined, IncomingCallScreen tự rơi về "chế độ demo" y hệt trước đây (KHÔNG đổi hành vi mặc định) — "Chấp
// nhận" khi đó vẫn điều hướng sang gọi video nhóm demo NHƯ CŨ (không có callId thật để nối signaling).
function IncomingCallRoute(): JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const state = (location.state as { callId?: string; callerAgentId?: number; callerName?: string; kind?: 'VOICE' | 'VIDEO' } | null) ?? {};
  // fix-call-name (31/7, B67) — đã KIỂM TRA: `room` ở đây KHÔNG có cùng lỗi hiện sai tên như CallRoute vì
  // IncomingCallScreen.tsx tự tính `displayName = callerName ?? room.name` và render `displayName` (không phải
  // `room.name` trực tiếp) — `callerName` (state, xác thực từ server) luôn có mặt ở chế độ THẬT nên tên hiển
  // thị ở màn NÀY luôn đúng dù `room` là mock cứng 'room-hong' (chỉ còn dùng cho `avatarColor` — thẩm mỹ). Bug
  // display-name PHIÊN BẢN callee-side thật sự nằm ở `onAccept` bên dưới (điều hướng SANG CallRoute) — đã sửa
  // ở đó (truyền `calleeName: state.callerName`), không phải ở `room` này.
  const room = CHAT_ROOMS.find((r) => r.id === 'room-hong') ?? CHAT_ROOMS[0];
  return (
    <IncomingCallScreen
      room={room}
      callId={state.callId}
      callerName={state.callerName}
      kind={state.kind}
      onAccept={() => {
        const callKind = state.kind === 'VOICE' ? 'voice' : 'video';
        // fix-call-name (31/7, B67) — kèm calleeName = state.callerName (tên caller đã xác thực từ server,
        // IncomingCallScreen đã dùng làm displayName của MÀN NÀY) để CallRoute (màn kế tiếp sau khi bấm Chấp
        // nhận) cũng hiển thị ĐÚNG tên — trước đây CallRoute tra CHAT_ROOMS bằng `room.id` ở đây (LUÔN là
        // mock 'room-hong' cứng, xem comment `room` phía trên) nên rơi ĐÚNG lỗi hiện "Trần Thị Hồng" y hệt
        // phía caller, chỉ khác entry point (đây là phía CALLEE, sau khi accept).
        navigate(ROUTES.call(callKind), {
          state: { roomId: room.id, callId: state.callId, peerAgentId: state.callerAgentId, calleeName: state.callerName }
        });
      }}
      onReject={() => navigate(ROUTES.chat)}
      onQuickReply={() => navigate(ROUTES.chatRoom(room.id))}
    />
  );
}

function MyQrRoute(): JSX.Element {
  const [searchParams] = useSearchParams();
  return <MyQrScreen initialScanOpen={searchParams.get('scan') === '1'} />;
}

function LoHistoryRoute(): JSX.Element {
  const navigate = useNavigate();
  return <LoHistoryScreen onOpenDetail={(loId) => navigate(ROUTES.loDetail(String(loId)))} />;
}

function ReconcileDetailRoute(): JSX.Element {
  const navigate = useNavigate();
  const { loId } = useParams();
  if (!loId) return <Navigate to={ROUTES.lo} replace />;
  return <ReconcileDetailScreen loId={loId} onBack={() => navigate(ROUTES.lo)} />;
}

function ContactsRoute(): JSX.Element {
  const navigate = useNavigate();
  return (
    <ContactsScreen
      // B40 (27/7) — ContactsScreen giờ tự resolve phòng DM thật qua createOrGetDirectRoom() TRƯỚC khi gọi
      // onChat, nên tham số ở đây ĐÃ LÀ roomId thật (không còn agentId/bảng tĩnh AGENT_TO_ROOM nữa — bảng đó
      // đã bị xóa hẳn ở fix-contacts-call 31/7, xem onCall bên dưới).
      onChat={(roomId) => navigate(ROUTES.chatRoom(roomId))}
      // fix-contacts-call (31/7) — TRƯỚC ĐÂY tra bảng tĩnh AGENT_TO_ROOM (chỉ map sẵn 3 phòng mock a1/a2/a3,
      // friend mới/thật KHÔNG có trong bảng → luôn rơi về /app/chat, KHÔNG BAO GIỜ đổ chuông) rồi nếu có map
      // được thì navigate {roomId} KHÔNG kèm calleeAgentId (CallScreen luôn rơi "chế độ xem trước", CÙNG lớp
      // bug B59 đã sửa cho ConversationRoute — B59 tự ghi lại "Phát hiện phụ CHƯA sửa: ContactsRoute.onCall có
      // cùng lỗ hổng, ngoài scope lúc đó", giờ đóng nốt ở đây). Giờ resolve phòng DIRECT THẬT qua
      // createOrGetDirectRoom(agentId) (chat-client.ts, CÙNG hàm handleMessageFriend() trong ContactsScreen.tsx
      // đã dùng cho onChat) rồi buildContactCallNavigation() (call-signaling-client.ts, hàm thuần) quyết định
      // path+state — agentId ở đây ĐÃ LÀ định danh chính xác người được gọi (ContactsScreen truyền thẳng
      // profile.agentId, xem prop onCall) nên KHÔNG cần dò lại qua resolveDirectPeerAgentId()/
      // getChatRoomDetail() như ConversationRoute (xem comment buildContactCallNavigation()). Lỗi tạo/lấy
      // phòng (vd CANNOT_MESSAGE nếu 2 bên lỡ không còn là bạn) → về /app/chat, giữ NGUYÊN fallback im lặng đã
      // có từ trước (không có chỗ hiện lỗi ở route-level component này, khớp hành vi cũ).
      // fix-call-name (31/7, B67) — ContactsScreen.tsx giờ truyền kèm tham số thứ 3 `calleeName` (tên hiển thị
      // hồ sơ đang xem, `profile.nickname ?? profile.agentName` — CÙNG field ContactsScreen tự hiển thị trên
      // hồ sơ, xem prop onCall ở đó) → CallRoute dùng để hiện ĐÚNG tên thay vì tra CHAT_ROOMS mock.
      onCall={(agentIdStr, kind, calleeName) => {
        const agentId = Number(agentIdStr);
        if (!Number.isFinite(agentId)) {
          navigate(ROUTES.chat);
          return;
        }
        createOrGetDirectRoom(agentId).then((res) => {
          if (!res.ok) {
            navigate(ROUTES.chat);
            return;
          }
          const nav = buildContactCallNavigation(kind, res.data, agentId, calleeName);
          if (nav) navigate(nav.path, { state: nav.state });
        });
      }}
      onOpenMyQr={() => navigate(ROUTES.myQr)}
      // Nhật ký (mục 40) — mở nhật ký của 1 đại lý bạn bè từ hồ sơ (ContactsScreen). Điều hướng thuần
      // (không async), bot-api tự chặn NOT_VISIBLE nếu không phải bạn/của mình.
      onOpenDiary={(agentId) => navigate(ROUTES.diaryOf(agentId))}
    />
  );
}

// Hồ sơ công khai theo username RC (25/7, mục "link cá nhân") — :username từ URL /app/u/:username.
function PublicProfileRoute(): JSX.Element {
  const navigate = useNavigate();
  const { username } = useParams();
  if (!username) return <Navigate to={ROUTES.chat} replace />;
  return <PublicProfileScreen username={username} onOpenChat={(roomId) => navigate(ROUTES.chatRoom(roomId))} />;
}

function SettingsRoute(): JSX.Element {
  const navigate = useNavigate();
  const { theme, toggleTheme } = useOutletContext<AppShellContext>();
  return (
    <SettingsScreen
      theme={theme}
      onToggleTheme={toggleTheme}
      onOpenMyQr={() => navigate(ROUTES.myQr)}
      onOpenSecurity={() => navigate(ROUTES.security)}
      onOpenProfile={() => navigate(ROUTES.profile)}
      onOpenQrScan={() => navigate(ROUTES.qrScan)}
      onLogout={() => performLogout(navigate)}
    />
  );
}

// B105 (2/8) — splash "Ánh sáng quét" chỉ hiện ĐÚNG 1 LẦN lúc App() mount thật (App() KHÔNG remount khi điều
// hướng SPA nội bộ — react-router chỉ đổi <Route> con, nên đây tự nhiên là "1 lần/vòng đời trang", không cần
// sessionStorage đánh dấu). BỎ QUA hoàn toàn khi: (a) `navigator.webdriver` (Playwright/automation — tự động
// né capture-frames.ts + mọi script verify Playwright trong dự án mà KHÔNG cần sửa các script đó, vì
// Playwright luôn set cờ này true) hoặc (b) `prefers-reduced-motion` (khuyến nghị a11y chuẩn — không ép hiệu
// ứng chuyển động lên người dùng đã tắt animation hệ thống).
const SPLASH_DURATION_MS = 1000;
function shouldSkipSplash(): boolean {
  if (typeof navigator !== 'undefined' && navigator.webdriver) return true;
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return true;
  // 6/8 (Admin Demo "sao 5-6s mới vào app") — vỏ EXE ĐÃ có splash.html NATIVE của Electron (hiện NGAY từ lúc app
  // ready, trước cả renderer) → hiện lại React AppSplash 1s nữa là THỪA (2 splash chồng, phí ~1s). Trên exe bỏ
  // React splash: cửa sổ chính chỉ show ở 'ready-to-show' (renderer đã vẽ khung đầu) nên KHÔNG chớp trắng.
  if (typeof window !== 'undefined' && (window as unknown as { SigMaPC?: { isElectron?: boolean } }).SigMaPC?.isElectron) return true;
  return false;
}

export function App(): JSX.Element {
  const [showSplash, setShowSplash] = useState(() => !shouldSkipSplash());
  useEffect(() => {
    if (!showSplash) return;
    const t = setTimeout(() => setShowSplash(false), SPLASH_DURATION_MS);
    return () => clearTimeout(t);
  }, [showSplash]);

  if (showSplash) return <AppSplash />;

  return (
    <>
      <SessionExpiredWatcher />
      <AndroidBackButtonWatcher />
      {/* Lane D vòng 2 — 1 ranh giới Suspense chung cho MỌI route lazy: khi màn đang tải chunk, hiện fallback
          gọn (nền app + chấm loader) thay vì trắng xoá. Đa số điều hướng là chunk nhỏ tải gần như tức thì.
          #16 (8/8) — bọc thêm ChunkErrorBoundary: khi chunk lazy TẢI LỖI (index.html cache cũ sau redeploy →
          chunk-hash 404, hoặc bundle exe/apk thiếu chunk) thì dynamic import reject → TRƯỚC ĐÂY React unmount cả
          cây → TRANG TRẮNG (Admin Demo gặp ở "Xem nhật ký" — DiaryScreen là chunk mới thêm). Boundary tự tải lại 1
          lần (index mới trỏ đúng chunk) + fallback có nút "Tải lại" nếu vẫn lỗi. Xem ChunkErrorBoundary.tsx. */}
      <ChunkErrorBoundary>
      <Suspense fallback={<div className="flex h-full min-h-screen items-center justify-center bg-appbg text-sm text-slate-400">Đang tải…</div>}>
      <Routes>
      <Route path="/" element={<RootRedirect />} />
      <Route path={ROUTES.gallery} element={<GalleryPage />} />
      <Route path={ROUTES.login} element={<LoginRoute />} />
      <Route path={ROUTES.otp} element={<OtpRoute />} />
      {/* SIGMA (3/8) — đăng nhập bằng QR phía máy tạo QR: PUBLIC (chưa đăng nhập), NGOÀI RequireAuth. */}
      <Route path={ROUTES.qrLogin} element={<QrLoginRoute />} />

      {/* RequireAuth bọc NGOÀI AppShell: mọi route /app/* cần phiên đăng nhập RC thật (getSession() null →
          về /login) — áp dụng chung cho cả nhóm, không riêng /app/chat (audit HIGH 24/7). */}
      <Route element={<RequireAuth />}>
        <Route element={<AppShell />}>
          <Route path={ROUTES.chat} element={<ChatListRoute />} />
          <Route path={`${ROUTES.chat}/:roomId`} element={<ConversationRoute />} />
          {/* "Doanh số theo nhóm chat" (1/8, B100) — mở từ nút trong GroupInfoPanel.tsx HOẶC nối tắt MyRevenueScreen. */}
          <Route path={`${ROUTES.chat}/:roomId/revenue`} element={<RoomRevenueScreen />} />
          {/* Nối tắt doanh số ra ngoài cửa sổ chat (Admin Demo 21/8) — liệt kê nhóm đại lý, vào thẳng từ Sidebar. */}
          <Route path={ROUTES.revenue} element={<MyRevenueScreen />} />
          {/* [Admin Demo 17/9] Sổ tiền đại lý đang cầm — lô chưa hoàn, tách riêng từng nhà. */}
          <Route path={ROUTES.congNo} element={<CongNoDaiLyScreen />} />
          <Route path={ROUTES.lo} element={<LoHistoryRoute />} />
          <Route path={`${ROUTES.lo}/:loId`} element={<ReconcileDetailRoute />} />
          {/* FIX-DEMOCK (4/8) — route /app/fraud ĐÃ GỠ: FraudAlertsScreen 100% mock (RECONCILE_DETAIL), chưa có
              API tổng hợp cờ gian lận thật. Điều hướng vào /app/fraud nay rơi vào fallback Navigate cuối. */}
          <Route path={ROUTES.kpi} element={<KpiReportScreen />} />
          <Route path={ROUTES.investorRevenue} element={<InvestorRevenueScreen />} />
          <Route path={ROUTES.ocrSend} element={<OcrSendScreen />} />
          <Route path={ROUTES.statementRecon} element={<StatementReconScreen />} />
          {/* Tổng gộp SigMa — server chặn 403 nếu không phải chủ (màn tự hiện thông báo). */}
          <Route path={ROUTES.alphaAggregate} element={<AlphaAggregateScreen />} />
          <Route path={ROUTES.baoCoReport} element={<BaoCoReportScreen />} />
          <Route path={ROUTES.binCheck} element={<BinCheckScreen />} />
          <Route path={ROUTES.promoPrograms} element={<PromoProgramsScreen />} />
          <Route path={ROUTES.contacts} element={<ContactsRoute />} />
          <Route path={ROUTES.settings} element={<SettingsRoute />} />
          <Route path={ROUTES.qr} element={<QrDisplayScreen />} />
          <Route path={ROUTES.myQr} element={<MyQrRoute />} />
          {/* SIGMA (3/8) — quét mã đăng nhập cho máy khác (điện thoại đã đăng nhập). */}
          <Route path={ROUTES.qrScan} element={<QrScanRoute />} />
          <Route path={ROUTES.security} element={<AccountSecurityScreen />} />
          <Route path={ROUTES.profile} element={<ProfileScreen />} />
          {/* Link cá nhân (25/7, mục 24/34) — /app/u/:username, hồ sơ CÔNG KHAI người khác. */}
          <Route path="/app/u/:username" element={<PublicProfileRoute />} />
          <Route path={ROUTES.diary} element={<DiaryScreen />} />
          {/* Nhật ký của 1 đại lý khác (mục 40) — mở từ "Xem nhật ký" trên hồ sơ bạn bè (ContactsScreen). */}
          <Route path="/app/diary/:agentId" element={<DiaryScreen />} />
          <Route path={ROUTES.calendar} element={<CalendarScreen />} />
          {/* /app/sell-tid: AppShell tự vẽ modal đè lên khi khớp path này (xem AppShell.tsx) — nền vẫn
              là danh sách chat để có nội dung phía sau modal khi chụp ảnh. */}
          <Route path={ROUTES.sellTid} element={<ChatListRoute />} />
        </Route>
      </Route>

      {/* Màn gọi (mục 28/36) — NGOÀI AppShell: fullscreen, không sidebar/topbar.
          Route tĩnh /app/call/incoming khai TRƯỚC :kind (React Router xếp hạng tĩnh cao hơn). */}
      <Route path={ROUTES.incomingCall} element={<IncomingCallRoute />} />
      <Route path="/app/call/:kind" element={<CallRoute />} />

      {/* Preview push màn khóa (mục 35) — route riêng để capture. */}
      <Route path={ROUTES.lockscreenPreview} element={<LockScreenPreview />} />

      <Route path="*" element={<RootRedirect />} />
      </Routes>
      </Suspense>
      </ChunkErrorBoundary>
    </>
  );
}
