// Chuông thông báo (yêu cầu Admin Demo 24/7: "có thông báo trên chuông của nhật ký" — kế hoạch curried-
// plotting-hippo.md). QUYẾT ĐỊNH VỊ TRÍ (tự chọn, LEAD review lại): đặt ở TopBar.tsx — hiện TRÊN MỌI màn
// /app/* (giống chuông thông báo Zalo/Messenger luôn nằm ở thanh trên cùng, không chỉ riêng 1 màn) — thay vì
// CHỈ đặt trong DiaryScreen.tsx. Lý do: nội dung chuông (lễ/Tết sắp tới + sinh nhật bạn bè sắp tới) không
// liên quan trực tiếp tới "Nhật ký" (đăng bài/feed) — nếu chỉ đặt ở đó, người dùng phải chủ động vào đúng
// màn Nhật ký mới thấy, giảm khả năng nhận thông báo kịp lúc. Đặt ở TopBar cho khả năng nhìn thấy CAO NHẤT
// (đúng tinh thần "chuông thông báo" thật sự), bấm vào mở dropdown TẠI CHỖ (không bắt buộc rời màn đang xem)
// + có nút "Xem lịch đầy đủ" điều hướng sang CalendarScreen khi cần xem chi tiết/xem trước ngày khác.
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { AtSign, Bell, Cake, Heart, ImageIcon as CoverIcon, MessageSquare, Newspaper, PartyPopper, UserCircle2, UserPlus, UserCheck, Users } from 'lucide-react';
import {
  applyRealtimeDiaryPost,
  buildDiaryPostNotificationItem,
  loadNotificationFeed,
  markDiaryNotifySeen,
  markFriendUpdateNotificationsRead,
  type NotificationFeed
} from '../lib/notifications';
import { subscribeDiaryNotify, subscribeAgentNotify } from '../lib/chat-realtime';
import { playNotificationChime, isAudioEnabled } from '../lib/audio-player';
import type { AgentNotificationItem } from '../lib/agent-api-client';
import { ROUTES } from '../routes';

// 6/8 — nội dung + icon cho MỖI loại thông báo server-side (avatar/cover đổi + Nhật ký bình luận/thả cảm xúc).
// Tách hàm để render 1 chỗ, tránh chuỗi ternary phình khi có thêm loại. Loại Nhật ký điều hướng tới màn Nhật ký.
function notifIcon(type: AgentNotificationItem['type']): ReactNode {
  if (type === 'AVATAR_UPDATED') return <UserCircle2 className="h-4 w-4" />;
  if (type === 'COVER_UPDATED') return <CoverIcon className="h-4 w-4" />;
  if (type === 'DIARY_COMMENT' || type === 'DIARY_COMMENT_FRIEND') return <MessageSquare className="h-4 w-4" />;
  if (type === 'DIARY_POST') return <Newspaper className="h-4 w-4" />; // bạn bè đăng bài mới
  if (type === 'BIRTHDAY') return <Cake className="h-4 w-4" />; // việc #31 — sinh nhật bạn bè
  if (type === 'ANNIVERSARY') return <PartyPopper className="h-4 w-4" />; // việc #31 — kỷ niệm kết bạn
  if (type === 'FRIEND_REQUEST') return <UserPlus className="h-4 w-4" />; // 8/8 — lời mời kết bạn mới
  if (type === 'FRIEND_ACCEPT') return <UserCheck className="h-4 w-4" />; // 8/8 — lời mời được chấp nhận
  if (type === 'GROUP_ADDED') return <Users className="h-4 w-4" />; // 8/8 — được thêm vào nhóm
  if (type === 'MENTION') return <AtSign className="h-4 w-4" />; // 13/8 — được nhắc (@) trong nhóm
  return <Heart className="h-4 w-4" />; // DIARY_REACTION
}
function notifText(n: AgentNotificationItem): string {
  switch (n.type) {
    case 'AVATAR_UPDATED':
      return `${n.actorAgentName} đã cập nhật ảnh đại diện`;
    case 'COVER_UPDATED':
      return `${n.actorAgentName} đã cập nhật ảnh bìa`;
    case 'DIARY_COMMENT':
      return `${n.actorAgentName} đã bình luận bài viết của bạn`;
    case 'DIARY_REACTION':
      return `${n.actorAgentName} đã thả cảm xúc bài viết của bạn`;
    case 'DIARY_COMMENT_FRIEND':
      return `${n.actorAgentName} cũng đã bình luận một bài viết bạn quan tâm`;
    case 'DIARY_REACTION_FRIEND':
      return `${n.actorAgentName} cũng đã thả cảm xúc một bài viết bạn quan tâm`;
    case 'DIARY_POST':
      return `${n.actorAgentName} vừa đăng nhật ký mới`;
    case 'BIRTHDAY':
      return `Hôm nay là sinh nhật ${n.actorAgentName} 🎂`;
    case 'ANNIVERSARY':
      return `Kỷ niệm ngày kết bạn với ${n.actorAgentName} 💛`;
    case 'FRIEND_REQUEST':
      return `${n.actorAgentName} đã gửi cho bạn lời mời kết bạn`;
    case 'FRIEND_ACCEPT':
      return `${n.actorAgentName} đã chấp nhận lời mời kết bạn`;
    case 'GROUP_ADDED':
      return `${n.actorAgentName} đã thêm bạn vào một nhóm`;
    case 'MENTION':
      return `${n.actorAgentName} đã nhắc đến bạn trong một nhóm`;
    default:
      return `${n.actorAgentName} có hoạt động mới`;
  }
}
function isDiaryNotif(type: AgentNotificationItem['type']): boolean {
  return (
    type === 'DIARY_COMMENT' ||
    type === 'DIARY_REACTION' ||
    type === 'DIARY_POST' ||
    type === 'DIARY_COMMENT_FRIEND' ||
    type === 'DIARY_REACTION_FRIEND'
  );
}

/** Route đích khi bấm 1 thông báo — null nếu loại KHÔNG bấm được (avatar/cover/sinh nhật/kỷ niệm chỉ để xem).
 * Nhật ký → feed Nhật ký (kèm ?post= để cuộn/highlight nếu có postId). 8/8 — kết bạn (FRIEND_*) → màn Danh bạ
 * (khối lời mời/danh sách bạn), ĐỒNG NHẤT deep-link push (push-notifications.ts CONTACTS_PUSH_KINDS). Được thêm
 * vào nhóm (GROUP_ADDED) → mở ĐÚNG phòng nhóm theo postId (=roomId); thiếu id → về danh sách chat. */
function notifClickTarget(n: AgentNotificationItem): string | null {
  if (isDiaryNotif(n.type)) return n.postId ? `${ROUTES.diary}?post=${n.postId}` : ROUTES.diary;
  if (n.type === 'FRIEND_REQUEST' || n.type === 'FRIEND_ACCEPT') return ROUTES.contacts;
  if (n.type === 'GROUP_ADDED') return n.postId ? ROUTES.chatRoom(n.postId) : ROUTES.chat;
  if (n.type === 'MENTION') return n.postId ? ROUTES.chatRoom(n.postId) : ROUTES.chat; // 13/8 — mở đúng phòng nhóm
  return null;
}

/** "Vừa xong"/"X phút trước"/"X giờ trước"/"X ngày trước" — CÙNG mức chi tiết tương đối các nơi khác trong
 * app đã dùng cho mốc thời gian gần (KHÔNG suy đoán format mới, giữ tối giản cho B113). */
function relativeTimeVi(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'Vừa xong';
  if (minutes < 60) return `${minutes} phút trước`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} giờ trước`;
  const days = Math.floor(hours / 24);
  return `${days} ngày trước`;
}

export function NotificationBell({ onOpenCalendar }: { onOpenCalendar: () => void }): JSX.Element {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [feed, setFeed] = useState<NotificationFeed | null>(null);
  const [loading, setLoading] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);
  // #32 — dedupe realtime theo postId (chống +1 hai lần WS/FCM) + cấp id ÂM giảm dần cho item lạc quan (không
  // đụng id dương của hàng DB thật; lần refetch sau thay bằng hàng thật). Dùng ref để bền qua re-render.
  const seenPostIdsRef = useRef<Set<string>>(new Set());
  const nextOptimisticIdRef = useRef(-1);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    loadNotificationFeed().then((f) => {
      if (!cancelled) {
        setFeed(f);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // #32 REALTIME — nghe 'diary-notify' (bạn bè vừa đăng bài): chuông đỏ +1 NGAY (0 refetch), chèn item lên đầu.
  // Dedupe theo postId để KHÔNG double khi cả WS lẫn FCM tới cùng máy đang mở. feed chưa tải xong (null) → chỉ
  // đánh dấu đã thấy (lần load ban đầu đã chứa hàng thật) rồi bỏ qua, tránh đếm lệch.
  useEffect(() => {
    return subscribeDiaryNotify((ev) => {
      if (ev.kind === 'diary_post') {
        // Bạn bè đăng bài: dedupe theo postId (chống +1 hai lần WS/FCM) → chèn item lạc quan + chuông.
        if (!markDiaryNotifySeen(seenPostIdsRef.current, ev.postId)) return;
        if (isAudioEnabled()) playNotificationChime();
        const id = nextOptimisticIdRef.current;
        nextOptimisticIdRef.current -= 1;
        setFeed((prev) => (prev ? applyRealtimeDiaryPost(prev, buildDiaryPostNotificationItem(ev, id)) : prev));
      } else {
        // 7/8 (Admin Demo "bình luận/cảm xúc nhật ký không push/không chuông") — có người bình luận/thả cảm xúc bài
        // của MÌNH: chuông NGAY + nạp lại feed để hiện đúng hàng server (DIARY_COMMENT/REACTION đã tạo row) + số
        // đếm chuẩn (KHÔNG dedupe theo postId vì nhiều bình luận cùng 1 bài trùng postId sẽ bị nuốt → lệch số #21).
        if (isAudioEnabled()) playNotificationChime();
        loadNotificationFeed()
          .then((f) => setFeed(f))
          .catch(() => {
            /* best-effort — lỗi mạng không phá chuông/app; lần mở dropdown sau tự nạp lại */
          });
      }
    });
  }, []);

  // 8/8 (Admin Demo "đồng bộ hóa mọi push event số đếm, cộng trừ mọi nền mượt-chuẩn-realtime") — nghe 'agent-notify'
  // (kết bạn/nhóm): chuông NGAY + refetch feed để badge đếm ĐÚNG theo SERVER (nguồn chân lý, đồng bộ web/exe/apk).
  // Dùng refetch (KHÔNG optimistic +1) vì: (a) server đã tạo row → count chuẩn tuyệt đối; (b) refetch idempotent
  // theo count nên WS lẫn FCM tới cùng máy KHÔNG double (khác diary_post phải dedupe postId). CÙNG cách nhánh
  // comment/reaction Nhật ký (Admin Demo đã chấp nhận). Best-effort — lỗi mạng không phá chuông.
  useEffect(() => {
    return subscribeAgentNotify(() => {
      if (isAudioEnabled()) playNotificationChime();
      loadNotificationFeed()
        .then((f) => setFeed(f))
        .catch(() => {
          /* best-effort — lần mở dropdown sau tự nạp lại */
        });
    });
  }, []);

  useEffect(() => {
    // Admin Demo 6/8 (APK): "chuông thông báo mở ra, chạm chỗ khác KHÔNG ẩn về". GỐC: dùng `mousedown` —
    // trên cảm ứng (WebView Android) `mousedown` KHÔNG fire tin cậy khi chạm NGOÀI (chỉ có touch/pointer) →
    // dropdown không đóng. FIX: `pointerdown` phủ CẢ chuột (desktop/exe) LẪN cảm ứng (apk/mobile web) → chạm
    // ngoài đóng ở mọi nền. (pointerdown fire trước click, đóng ngay khi vừa chạm.)
    function onClickOutside(e: PointerEvent): void {
      if (open && boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('pointerdown', onClickOutside);
    return () => document.removeEventListener('pointerdown', onClickOutside);
  }, [open]);

  // #25 — click 1 thông báo → đánh dấu ĐỌC ngay (optimistic): item đó readAt = now → nền về THƯỜNG. Chỉ đổi hiển
  // thị; badge do handleToggle (mở dropdown = mark-all-read server) lo, KHÔNG đụng count ở đây (tránh trừ 2 lần).
  function markOneNotificationRead(id: number): void {
    setFeed((prev) => {
      if (!prev) return prev;
      const item = prev.friendUpdates.find((x) => x.id === id);
      if (!item || item.readAt) return prev;
      const nowIso = new Date().toISOString();
      return { ...prev, friendUpdates: prev.friendUpdates.map((x) => (x.id === id ? { ...x, readAt: nowIso } : x)) };
    });
  }

  const count = feed?.totalCount ?? 0;

  // B113 (2/8, Admin Demo yêu cầu trực tiếp "click chuông đánh dấu đã đọc") — mở dropdown = xem hết friendUpdates
  // (KHÔNG cần chọn từng cái, giống Zalo/Messenger badge biến mất khi mở). Optimistic UPDATE state cục bộ
  // NGAY (badge biến mất tức thì, không đợi round-trip mạng) — markFriendUpdateNotificationsRead() chạy nền,
  // lỗi mạng KHÔNG hiện gì (best-effort, xem docstring notifications.ts) — lần mở dropdown SAU sẽ tự thử lại
  // (feed tải mới mỗi lần mount component, chưa đánh dấu được ở server thì unreadCount vẫn còn nguyên).
  function handleToggle(): void {
    setOpen((v) => {
      const next = !v;
      if (next && feed && feed.unreadFriendUpdateCount > 0) {
        setFeed({ ...feed, unreadFriendUpdateCount: 0, totalCount: feed.totalCount - feed.unreadFriendUpdateCount });
        void markFriendUpdateNotificationsRead();
      }
      return next;
    });
  }

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={handleToggle}
        aria-label="Thông báo"
        title="Thông báo"
        className="relative rounded-full p-2 text-slate-500 transition hover:bg-white hover:text-brand"
      >
        <Bell className="h-5 w-5" />
        {count > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold text-white">
            {count > 9 ? '9+' : count}
          </span>
        )}
      </button>

      {open && (
        <div
          // Admin Demo 18/8 (ảnh THẬT: dropdown thông báo tràn mép TRÁI màn nhỏ vì `absolute right-0` neo theo NÚT
          // chuông — nút không sát mép phải nên w-80 lòi qua trái màn). Đổi sang `fixed` neo VIEWPORT phải + max-w
          // theo bề rộng màn → không bao giờ tràn. top theo safe-area để nằm dưới status bar/notch.
          className="fixed right-2 z-50 w-80 max-w-[calc(100vw-1rem)] overflow-hidden rounded-lg-mac border border-line bg-white shadow-card glass-panel"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 3.25rem)' }}
        >
          <div className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
            <span className="text-sm font-semibold text-slate-800">Thông báo</span>
            <button onClick={onOpenCalendar} className="text-xs font-medium text-brand hover:underline">
              Xem lịch đầy đủ
            </button>
          </div>

          <div className="max-h-80 overflow-auto">
            {loading && <div className="px-3.5 py-6 text-center text-xs text-slate-400">Đang tải...</div>}

            {!loading && feed && feed.holidays.length === 0 && feed.birthdays.length === 0 && feed.friendUpdates.length === 0 && (
              <div className="px-3.5 py-6 text-center text-xs text-slate-400">Chưa có thông báo nào.</div>
            )}

            {/* B113 (2/8) — bạn bè đổi avatar/ảnh bìa; 6/8 — thêm Nhật ký (bình luận/thả cảm xúc). MỚI NHẤT
                trước (đã sort desc ở bot-api). Thông báo Nhật ký bấm được → mở màn Nhật ký (kiểu Zalo/Facebook). */}
            {/* #25 (Admin Demo 8/8, kiểu FB/Zalo) — thông báo CHƯA đọc (readAt==null) nền ĐẬM hơn (bg-brand-tint) + tiêu
                đề đậm + chấm xanh; ĐÃ đọc (đã click) nền THƯỜNG. Click 1 thông báo → đánh dấu đọc ngay (nền về
                thường) + điều hướng. */}
            {!loading &&
              feed?.friendUpdates.map((n) => {
                const clickTarget = notifClickTarget(n);
                const unread = !n.readAt;
                const inner = (
                  <>
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-tint text-brand">
                      {notifIcon(n.type)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className={`truncate text-xs ${unread ? 'font-bold text-slate-900' : 'font-medium text-slate-700'}`}>{notifText(n)}</div>
                      <div className="text-[11px] text-slate-500">{relativeTimeVi(n.createdAt)}</div>
                    </div>
                    {unread && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand" aria-label="Chưa đọc" />}
                  </>
                );
                const rowBg = unread ? 'bg-brand-tint/60 hover:bg-brand-tint' : 'hover:bg-appbg';
                return clickTarget ? (
                  <button
                    key={`n-${n.id}`}
                    onClick={() => {
                      markOneNotificationRead(n.id);
                      setOpen(false);
                      // #26 + 8/8 — TRỎ ĐÚNG đích theo loại (Nhật ký ?post=<id> / Danh bạ / phòng nhóm), tính sẵn ở
                      // notifClickTarget. Thiếu id (sự kiện cũ) → route mặc định của loại đó (feed/danh sách chat).
                      navigate(clickTarget);
                    }}
                    className={`flex w-full items-start gap-2.5 border-b border-line/60 px-3.5 py-2.5 text-left transition ${rowBg}`}
                  >
                    {inner}
                  </button>
                ) : (
                  <div key={`n-${n.id}`} className={`flex items-start gap-2.5 border-b border-line/60 px-3.5 py-2.5 ${unread ? 'bg-brand-tint/60' : ''}`}>
                    {inner}
                  </div>
                );
              })}

            {!loading &&
              feed?.holidays.map((h, i) => (
                <div key={`h-${i}`} className="flex items-start gap-2.5 border-b border-line/60 px-3.5 py-2.5">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-danger/10 text-base">
                    {h.emoji}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-slate-800">{h.name}</div>
                    <div className="text-[11px] text-slate-500">
                      {h.daysUntil === 0 ? 'Hôm nay' : h.daysUntil === 1 ? 'Ngày mai' : `Còn ${h.daysUntil} ngày`}
                      {h.kind === 'tet' && <span className="ml-1 font-semibold text-danger">· Tết</span>}
                    </div>
                  </div>
                  <PartyPopper className="mt-1 h-3.5 w-3.5 shrink-0 text-warning" />
                </div>
              ))}

            {!loading &&
              feed?.birthdays.map((b) => (
                <div key={`b-${b.friend.agentId}`} className="flex items-start gap-2.5 border-b border-line/60 px-3.5 py-2.5">
                  <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-tint text-base">
                    🎂
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-semibold text-slate-800">Sinh nhật {b.friend.agentName}</div>
                    <div className="text-[11px] text-slate-500">{b.isToday ? 'Hôm nay!' : b.daysUntil === 1 ? 'Ngày mai' : `Còn ${b.daysUntil} ngày`}</div>
                  </div>
                  <Cake className="mt-1 h-3.5 w-3.5 shrink-0 text-brand" />
                </div>
              ))}

            {!loading && feed?.loadError && (
              <div className="px-3.5 py-2.5 text-[11px] text-slate-400">
                (Không tải được đủ thông báo: {feed.loadError})
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
