// Danh sách chat + thanh chip lọc phân loại (mục 21) + modal "Quản lý phân loại" + TÌM KIẾM TOÀN CỤC
// (mục 33): gõ ≥1 ký tự hiện panel 3 nhóm Người/Tin nhắn/Nhóm. props initialCategoryId/openManage/initialQuery
// nhận từ URL search params (?cat=...&manage=1&q=...) — để sidebar lọc được và capture-frames chụp được từng
// state.
//
// B103 (1/8, fix bug NGHIÊM TRỌNG Admin Demo báo trực tiếp) — TRƯỚC ĐÂY cả 3 nhóm kết quả lọc trên mock
// `CHAT_ROOMS`/`MESSAGES_BY_ROOM`/`AGENTS` (KHÔNG BAO GIỜ nối qua hệ chat lõi thật dù danh sách chat chính đã
// cutover từ 29/7) — nhắn tin thật (dấu "."/chữ "hi") tìm không ra, chỉ thấy dữ liệu test giả lập. Đổi cả 3
// nhóm sang dữ liệu THẬT: "Nhóm" lọc trên `rcRooms` đã tải (real, cùng nguồn danh sách chat chính) — KHÔNG gọi
// API mới; "Người" lọc trên bạn bè thật (`getCachedFriends()`, CÙNG cache dùng chung ContactsScreen.tsx —
// PHẠM VI CỐ Ý giới hạn bạn bè, KHÔNG mở tìm kiếm toàn bộ danh bạ hệ thống, tránh lộ dữ liệu agent khác); "Tin
// nhắn" gọi backend mới `GET /v1/chat/search/messages` (chat-search-service.ts — CHỈ trả tin trong phòng đang
// là thành viên, xem an ninh dữ liệu ở đó).
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type JSX } from 'react';
import { MessageSquareText, Search, Settings2, Users, X } from 'lucide-react';
import { Button } from '../components/Button';
import { DotsLoader } from '../components/DotsLoader';
import { ChatList } from '../components/ChatList';
import { CategoryManagerModal } from '../components/CategoryManagerModal';
import { CreateGroupModal } from '../components/CreateGroupModal';
import { ConversationMenu, type ConversationAction } from '../components/ConversationMenu';
import { ConfirmDialog } from '../components/ConfirmDialog';
import {
  muteConversation, pinConversation, markConversationUnread,
  hideConversation, removeConversation, reportConversation
} from '../lib/chat-client';
import { subscribeChatCategoriesChanged, type ChatCategoryDto } from '../lib/agent-api-client';
import type { FriendListItem } from '../lib/agent-api-client';
import { getCachedFriends } from '../lib/friends-cache';
import { getCachedChatCategories } from '../lib/categories-cache';
import { getPersistedCatFilter, setPersistedCatFilter } from '../lib/chat-category-filter-persist';
import { AgentAvatar } from '../components/AgentAvatar';
import { RoomAvatar } from '../components/RoomAvatar';
import { seedPresence } from '../lib/presence-store';
import type { ChatRoom } from '../mock-data/types';
import { createOrGetDirectRoom, formatMessageTime, listChatRoomsWithNames, searchChatMessages, type MessageSearchHitDto } from '../lib/chat-client';
import { subscribeChatNotify } from '../lib/chat-realtime';
import { applyIncomingMessageToRooms } from '../lib/chat-list-live';
import { clearRoomsListCache, getStaleRoomsListCache, setRoomsListCache } from '../lib/rooms-list-cache';
import { subscribeRoomRead } from '../lib/chat-read-events';

/** So khớp không phân biệt hoa/thường (chuẩn Unicode qua `.toLowerCase()` của JS — ĐÚNG cho tiếng Việt có
 * dấu, KHÁC với ILIKE/lower() phía Postgres locale "C" của DB thật, xem chat-search-service.ts). */
function matches(haystack: string | undefined | null, q: string): boolean {
  return !!haystack && haystack.toLowerCase().includes(q.toLowerCase());
}

/** Định dạng giờ:phút ngắn cho kết quả tìm tin nhắn (CÙNG kiểu "time" hiển thị trên ChatList.tsx). */
function formatHitTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

// B86-tiếp (1/8, việc 2) — audit tốc độ B86 đo THẬT: React Router UNMOUNT hẳn ChatListScreen khi điều hướng
// sang `/app/chat/:roomId` (route element khác — ConversationRoute, xem App.tsx) rồi REMOUNT khi quay lại
// `/app/chat` → effect mount gọi lại `listChatRoomsWithNames()` (REST full-fetch TOÀN BỘ danh sách phòng) MỖI
// LẦN, kể cả khi chỉ vừa rời màn 1-2 giây trước (vd mở nhầm 1 phòng rồi bấm Back ngay).
//
// ĐÃ KIỂM hạ tầng realtime hiện có TRƯỚC khi quyết định hướng này (đọc chat-realtime.ts + comment
// AppShell.tsx dòng ~75 "KHÔNG có cơ chế live-update/polling/WebSocket nào cho danh sách phòng... để mà nối
// chung" — 1 agent KHÁC đã tự xác nhận y hệt kết luận này khi làm badge unread 31/7, ĐỘC LẬP với đợt audit
// này): server (`chat-realtime-hub.ts`/`chat-realtime-proxy.ts`) CHỈ phát sự kiện THEO TỪNG PHÒNG đã
// `subscribe-room` (tin nhắn mới/sửa/xóa/reaction/typing/room-updated/member-changed CỦA 1 roomId cụ thể) —
// KHÔNG có sự kiện CẤP TOÀN CỤC kiểu "phòng X vừa có tin mới" phát cho MỌI phòng của 1 agent bất kể phòng đó
// có đang mở hay không. ChatListScreen KHÔNG mở bất kỳ phòng nào (chỉ hiện preview), nên KHÔNG có gì để
// subscribe-room — nối vào hạ tầng hiện có là KHÔNG THỂ mà không thêm 1 loại sự kiện MỚI ở bot-api (vd
// "room-list-updated" phát theo agentId, không theo roomId) — NGOÀI PHẠM VI khoản optimization nhỏ này, rủi ro
// cao hơn hẳn lợi ích (đổi wire protocol + thêm subscription per-agent ở server), ĐÃ DỪNG LẠI ở đây, KHÔNG tự
// chế thêm — báo LEAD nếu muốn làm tiếp ở đợt sau.
//
// GIẢI PHÁP TỐI THIỂU (đúng gợi ý brief "chỉ refetch khi thật sự quay lại màn sau khi rời đi quá lâu"): cache
// TTL NGẮN (module-level, KHÔNG dùng chung với App.tsx `ConversationRoute` — route đó gọi
// `listChatRoomsWithNames()` RIÊNG để tìm 1 phòng theo :roomId, CỐ Ý giữ nguyên fetch tươi 100% ở đó vì phòng
// DIRECT vừa tạo (vd bấm "Nhắn tin" từ Danh bạ) PHẢI xuất hiện trong danh sách NGAY — nếu cache đó cũng dùng
// TTL này, phòng vừa tạo có thể tạm thời "không tìm thấy" trong vài giây → điều hướng sai về lại danh sách
// chat, MỘT BUG THẬT chứ không phải optimization). TTL = 8 GIÂY (ngắn hơn hẳn 30-60s gợi ý cho friends-cache.ts
// việc 1 — danh sách phòng đổi THƯỜNG XUYÊN hơn nhiều lần danh sách bạn bè: mỗi tin nhắn mới đổi preview/thứ
// tự sắp xếp) — đủ để loại bỏ refetch thừa cho thao tác "bấm nhầm rồi Back ngay"/điều hướng qua lại nhanh,
// nhưng KHÔNG đủ dài để hiện dữ liệu cũ đáng kể nếu người dùng thật sự rời màn quá lâu.
export function ChatListScreen({
  onOpenRoom,
  onOpenRoomId,
  onOpenRoomMessage,
  initialCategoryId,
  openManage,
  initialQuery
}: {
  onOpenRoom: (room: ChatRoom) => void;
  /** B103 — mở phòng chỉ CÓ roomId (chưa có object ChatRoom đầy đủ), dùng khi bấm 1 "Người" trong kết quả tìm
   * kiếm: cần tạo/lấy phòng DIRECT qua createOrGetDirectRoom() TRƯỚC (server trả về DTO khác hình dạng
   * ChatRoom UI) rồi mới điều hướng — theo ĐÚNG quy ước "màn hình không tự useNavigate(), điều hướng qua
   * callback prop từ App.tsx" (cùng ConversationScreen.tsx onOpenRevenue/onBack). */
  onOpenRoomId?: (roomId: string) => void;
  /** B107 (2/8, Admin Demo: "mở ra không trỏ cuộn đúng đến tin nhắn đấy") — bấm 1 kết quả "Tin nhắn" → mở ĐÚNG
   * phòng VÀ cuộn/nổi bật ĐÚNG tin đó (ConversationScreen tự xử lý qua query `?jumpTo=`, xem App.tsx). */
  onOpenRoomMessage?: (roomId: string, messageId: string) => void;
  initialCategoryId?: string;
  openManage?: boolean;
  initialQuery?: string;
}): JSX.Element {
  // UX (Admin Demo 17/8) — khôi phục phân loại đang lọc khi màn MOUNT (nếu URL không chỉ định ?cat=): "vào phòng
  // chat từ 1 phân loại → back → phải quay về ĐÚNG phân loại đó" (trước đây back luôn rơi về "Tất cả" vì màn
  // remount, filter khởi tạo lại từ ?cat= rỗng). Xem chat-category-filter-persist.ts. `?cat=` (deep-link sidebar)
  // LUÔN ưu tiên hơn giá trị ghi nhớ.
  const [filter, setFilterState] = useState<string | undefined>(initialCategoryId ?? getPersistedCatFilter());
  const setFilter = useCallback((id: string | undefined) => {
    setFilterState(id);
    setPersistedCatFilter(id); // ghi nhớ để lần remount kế (back từ phòng chat) khôi phục đúng.
  }, []);
  const [manageOpen, setManageOpen] = useState(!!openManage);
  // Nút "Tạo nhóm chat" ĐỘC LẬP (Admin Demo 5/8) — mở modal chọn ≥2 bạn bè + nhập tên; tạo xong điều hướng phòng mới.
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  // MENU HỘI THOẠI (7/8) — nhấn giữ/chuột-phải 1 dòng → {room, rect} để định vị ConversationMenu.
  const [convMenu, setConvMenu] = useState<{ room: ChatRoom; rect: DOMRect } | null>(null);
  // XÓA HỘI THOẠI kiểu Zalo (7/8) — phòng đang chờ XÁC NHẬN xóa (mở ConfirmDialog). null = không có.
  const [removeConfirm, setRemoveConfirm] = useState<ChatRoom | null>(null);
  const [query, setQuery] = useState(initialQuery ?? '');
  // Cutover 31/7 (việc #4) — phân loại nay là dữ liệu THẬT (apps/bot-api /v1/me/categories, KHÔNG còn mảng
  // mock module-level CATEGORIES). Tải lúc mount + subscribeChatCategoriesChanged() (agent-api-client.ts, bus
  // MỚI thay notifyCategoriesChanged mock cũ) để thanh chip lọc + roomIds tự cập nhật khi
  // CategoryManagerModal tạo/sửa/xóa/gán phân loại.
  // B122 (2/8) — qua `getCachedChatCategories()` (categories-cache.ts, THAY gọi thẳng `listChatCategories()`)
  // — CÙNG cache Sidebar.tsx đang dùng (xem docstring categories-cache.ts).
  const [categories, setCategories] = useState<ChatCategoryDto[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const r = await getCachedChatCategories();
      if (!cancelled && r.ok) setCategories(r.data);
    }
    load();
    const unsubscribe = subscribeChatCategoriesChanged(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  // roomId → categoryId (CỦA CHÍNH đại lý đang đăng nhập) — suy ra từ roomIds nhúng trong từng category (API
  // trả sẵn, xem chat-category-service.ts listCategories()) — KHÔNG còn field categoryId trên UiChatRoom
  // thật (rcRooms dưới đây tới từ /v1/chat/rooms, hệ chat lõi KHÔNG biết khái niệm phân loại).
  const categoryIdByRoomId = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of categories) {
      for (const roomId of cat.roomIds) map.set(roomId, cat.id);
    }
    return map;
  }, [categories]);
  // Cùng dữ liệu trên nhưng kèm name/color — dùng cho chấm/tag màu ở ChatList.tsx (thay categoryById mock cũ).
  const categoryInfoByRoomId = useMemo(() => {
    const map = new Map<string, { name: string; color: string }>();
    for (const cat of categories) {
      for (const roomId of cat.roomIds) map.set(roomId, { name: cat.name, color: cat.color });
    }
    return map;
  }, [categories]);
  // Nếu phân loại ĐANG lọc (thường do khôi phục từ ghi nhớ) không còn tồn tại — vd người dùng vừa XÓA nó ở
  // CategoryManagerModal — thì reset về "Tất cả" để không hiện danh sách rỗng khó hiểu (chip của nó cũng không
  // còn để bấm tắt). Chỉ chạy khi categories đã tải (mảng rỗng lúc chưa tải KHÔNG được coi là "đã xóa").
  useEffect(() => {
    if (filter && categories.length > 0 && !categories.some((c) => c.id === filter)) {
      setFilter(undefined);
    }
  }, [filter, categories, setFilter]);
  // Danh sách phòng chat THẬT (hệ chat lõi tự xây, Phase 3 cutover 29/7) của agent đang đăng nhập — gọi lúc
  // mount. rooms=null = đang tải lần đầu (hiện spinner); loadError giữ nguyên rooms cũ (nếu có) để không giật UI.
  // B86-tiếp (1/8, việc 2) — khởi tạo TỪ cache nếu còn "nóng" (`lib/rooms-list-cache.ts`, dùng CHUNG với
  // App.tsx ConversationRoute từ B105) để tránh hiện loading spinner + gọi mạng thừa khi remount trong vòng
  // vài giây. Cache NGUỘI (null/quá hạn) → giữ `null` như cũ (hiện "Đang tải...", xem nhánh render
  // `rcRooms === null` bên dưới).
  const [rcRooms, setRcRooms] = useState<ChatRoom[] | null>(() => getStaleRoomsListCache());
  const [roomsError, setRoomsError] = useState<string | null>(null);
  // Ref gương của rcRooms — để handler realtime (chat-notify) đọc state MỚI NHẤT đồng bộ mà không cần đưa
  // rcRooms vào deps effect (tránh resubscribe mỗi lần danh sách đổi).
  const rcRoomsRef = useRef<ChatRoom[] | null>(rcRooms);
  useEffect(() => {
    rcRoomsRef.current = rcRooms;
  }, [rcRooms]);

  // PRESENCE LIVE (6/8) — SEED presence-store từ `online`/`lastSeenAt` của phòng DIRECT. Sau đó `presence-update`
  // qua WS tự cập nhật store → chấm online đổi màu real-time, 0 refetch. GROUP không có presence → bỏ qua.
  //
  // #22b (6/8, Admin Demo "bạn ONLINE hiện ĐỎ tới khi navigate") — `rcRooms` khởi tạo từ SWR CACHE (getFreshRoomsListCache,
  // có thể stale `online:false` từ phiên trước). Effect NÀY chạy cho CẢ cache LẪN fresh (deps [rcRooms]) → dùng
  // `trustOffline:false` để KHÔNG assert offline (đỏ) từ cache cũ → chấm ra XÁM-neutral cho tới khi FRESH xác nhận.
  // `online:true` vẫn seed ngay (hiện XANH tức thì, an toàn). Fresh authoritative seed nằm ở 2 handler fetch bên dưới.
  useEffect(() => {
    if (!rcRooms) return;
    seedPresence(
      rcRooms.filter((r) => !r.isGroup && r.otherAgentId != null).map((r) => [r.otherAgentId as number, r.online, r.lastSeenAt] as const),
      { trustOffline: false }
    );
  }, [rcRooms]);

  // P3+P5 (6/8) — STALE-WHILE-REVALIDATE cho danh sách phòng: TRƯỚC ĐÂY nếu cache còn "nóng" (trong TTL 8s) thì
  // BỎ QUA refetch hoàn toàn → danh sách có thể cũ tới hết TTL. Nay: LUÔN render bản cache NGAY (đã seed vào
  // state ban đầu ở trên → KHÔNG spinner khi có cache) VÀ luôn revalidate NỀN mỗi lần mount (cập nhật im lặng,
  // không nháy loading). Server+DB nhanh (research đo vài ms) nên chi phí thấp; realtime chat-notify vẫn patch
  // danh sách tức thời như cũ. Cache MISS (rcRooms null) → hiện "Đang tải..." như cũ tới khi fetch xong.
  useEffect(() => {
    let cancelled = false;
    listChatRoomsWithNames().then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setRcRooms(res.data);
        setRoomsError(null);
        setRoomsListCache(res.data);
        // #22b — nguồn FRESH từ server: seed AUTHORITATIVE (trustOffline mặc định true) → xác nhận offline THẬT
        // (đỏ) cho bạn thật sự ngoại tuyến; bạn online → xanh. Ghi đè mọi giá trị stale/neutral từ cache.
        seedPresence(
          res.data.filter((r) => !r.isGroup && r.otherAgentId != null).map((r) => [r.otherAgentId as number, r.online, r.lastSeenAt] as const)
        );
      } else {
        setRcRooms((prev) => prev ?? []);
        setRoomsError(res.message);
        // Lỗi KHÔNG cache — lần mount kế tiếp tự thử lại thật (CÙNG nguyên tắc friends-cache.ts).
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // P4 (6/8, tối ưu tốc độ mở khung chat) — PREFETCH chunk ConversationScreen (+MessageComposer/ChatBubble…)
  // lúc RẢNH khi đang ở danh sách chat, để lần bấm mở phòng đầu tiên KHÔNG phải tải chunk 127KB tại-chỗ (chunk
  // đã ấm trong cache trình duyệt). Cùng module specifier với App.tsx lazy() → Vite dedupe về CÙNG chunk. Chạy
  // ở requestIdleCallback (không tranh băng thông với tải danh sách phòng), fallback setTimeout cho Safari/WebView.
  useEffect(() => {
    const prefetch = (): void => {
      void import('./ConversationScreen');
    };
    const ric = (window as unknown as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    if (typeof ric === 'function') {
      const handle = ric(prefetch);
      const cic = (window as unknown as { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
      return () => {
        if (typeof cic === 'function') cic(handle);
      };
    }
    const t = setTimeout(prefetch, 1200);
    return () => clearTimeout(t);
  }, []);

  // Bug #2 (5/8, Admin Demo "số tin chưa đọc không clear") — khi ConversationScreen đánh dấu đã đọc 1 phòng
  // (emitRoomRead), đặt unreadCount phòng đó về 0 NGAY trong danh sách + cập nhật cache (không đợi remount/
  // refetch). Danh sách còn "nóng" trong TTL sẽ KHÔNG tự refetch nên phải chỉnh tại chỗ, nếu không badge treo.
  useEffect(() => {
    return subscribeRoomRead((roomId) => {
      setRcRooms((prev) => {
        if (!prev) return prev;
        let changed = false;
        const next = prev.map((r) => {
          if (r.id === roomId && r.unreadCount > 0) {
            changed = true;
            return { ...r, unreadCount: 0 };
          }
          return r;
        });
        if (!changed) return prev;
        setRoomsListCache(next); // giữ cache đồng bộ để lần mở lại trong TTL không thấy badge cũ quay lại.
        return next;
      });
    });
  }, []);

  // Bug E (6/8, Admin Demo "A gửi B, B không ở khung → badge đỏ đếm 1 NGAY như Zalo") — TRƯỚC ĐÂY danh sách phòng
  // đứng IM khi có tin mới realtime (chỉ nổi banner thoáng qua ở AppShell), badge/preview/thứ tự KHÔNG đổi tới
  // khi remount/refetch → người dùng KHÔNG thấy tin mới. Nghe `chat-notify` (server CHỈ phát cho NGƯỜI NHẬN,
  // ĐÃ loại trừ người gửi — routes/chat.ts notifyRoomMembersOfNewMessage) → cập nhật NGAY phòng tương ứng:
  // +1 chưa đọc, đổi preview + giờ, đưa lên đầu (kiểu Zalo). ChatListScreen chỉ mount ở /app/chat (route riêng
  // với khung hội thoại /app/chat/:id) nên khi ở đây KHÔNG có phòng nào đang mở → luôn an toàn để +1. Phòng
  // CHƯA có trong danh sách (vừa tạo/tin đầu tiên) → refetch để nạp vào. Cache đồng bộ để remount không mất.
  useEffect(() => {
    return subscribeChatNotify((payload) => {
      // Quyết định patch-tại-chỗ vs refetch dựa trên state HIỆN TẠI qua ref (KHÔNG đọc `found` bên trong updater
      // setState — updater có thể chạy trễ/gọi 2 lần ở StrictMode, đọc cờ đó ngoài updater là race).
      const list = rcRoomsRef.current;
      const patched = list ? applyIncomingMessageToRooms(list, payload.roomId, payload.preview, formatMessageTime(payload.createdAt)) : null;
      if (patched && patched.found) {
        setRcRooms(patched.rooms);
        setRoomsListCache(patched.rooms);
      } else {
        // Phòng chưa có trong danh sách (tin nhắn ĐẦU TIÊN của 1 phòng mới) → tải lại để hiện nó.
        listChatRoomsWithNames().then((res) => {
          if (res.ok) {
            setRcRooms(res.data);
            setRoomsListCache(res.data);
            // #22b — nguồn fresh → seed authoritative (xác nhận offline thật).
            seedPresence(
              res.data.filter((r) => !r.isGroup && r.otherAgentId != null).map((r) => [r.otherAgentId as number, r.online, r.lastSeenAt] as const)
            );
          }
        });
      }
    });
  }, []);

  // Đồng bộ filter khi URL ?cat= THỰC SỰ ĐỔI mà màn KHÔNG remount (vd bấm phân loại khác ở Sidebar → chỉ đổi
  // searchParams). So sánh với GIÁ TRỊ đã thấy lần trước (ref khởi tạo = initialCategoryId hiện tại) thay vì cờ
  // boolean skip-first: đối kháng React StrictMode dev (effect chạy 2 lần trên CÙNG instance/CÙNG ref) — với cờ
  // boolean, lần chạy thứ 2 sẽ gọi setFilter(undefined) GHI ĐÈ giá trị vừa khôi phục + XOÁ ghi nhớ → back lại về
  // "Tất cả" (bug đã bắt được lúc kiểm chứng Playwright 17/8). So-sánh-giá-trị: cả 2 lần đều thấy "không đổi" →
  // no-op, an toàn. Chỉ setFilter khi initialCategoryId khác giá trị trước (deep-link ?cat= đổi thật).
  const lastInitialCat = useRef(initialCategoryId);
  useEffect(() => {
    if (initialCategoryId === lastInitialCat.current) return; // mount / StrictMode re-fire → không đụng filter.
    lastInitialCat.current = initialCategoryId;
    setFilter(initialCategoryId);
  }, [initialCategoryId, setFilter]);
  useEffect(() => setManageOpen(!!openManage), [openManage]);
  useEffect(() => setQuery(initialQuery ?? ''), [initialQuery]);

  const rooms = filter ? (rcRooms ?? []).filter((r) => categoryIdByRoomId.get(r.id) === filter) : rcRooms ?? [];

  // B103 — bạn bè THẬT (tải 1 lần lúc mount, dùng chung cache friends-cache.ts — CÙNG dữ liệu ContactsScreen.tsx
  // đang dùng, KHÔNG gọi API riêng). Chỉ cần cho panel tìm kiếm "Người" — KHÔNG ảnh hưởng luồng chat chính.
  const [friends, setFriends] = useState<FriendListItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    getCachedFriends().then((res) => {
      if (!cancelled && res.ok) setFriends(res.data.friends);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  const [openChatError, setOpenChatError] = useState<string | null>(null);
  async function handleOpenChatWithFriend(agentId: number): Promise<void> {
    setOpenChatError(null);
    const r = await createOrGetDirectRoom(agentId);
    if (!r.ok) {
      setOpenChatError(r.message);
      return;
    }
    onOpenRoomId?.(r.data.id);
  }

  // B103 — kết quả tìm tin nhắn THẬT (backend `GET /v1/chat/search/messages`, debounce 300ms tránh gọi mạng
  // mỗi ký tự gõ). Đổi query → hủy timer cũ trước khi đặt timer mới (KHÔNG dùng AbortController vì chatFetch()
  // hiện chưa hỗ trợ — kết quả trả chậm của lần gõ trước bị `cancelled` chặn ghi đè, tránh nhấp nháy sai thứ tự).
  const [messageHits, setMessageHits] = useState<MessageSearchHitDto[]>([]);
  const [messageHitsLoading, setMessageHitsLoading] = useState(false);
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setMessageHits([]);
      setMessageHitsLoading(false);
      return;
    }
    let cancelled = false;
    setMessageHitsLoading(true);
    const timer = setTimeout(() => {
      searchChatMessages(q).then((res) => {
        if (cancelled) return;
        setMessageHitsLoading(false);
        if (res.ok) setMessageHits(res.data);
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [query]);

  // Mục 33 — kết quả tìm kiếm 3 nhóm. "Người"/"Nhóm" lọc TỨC THỜI trên dữ liệu thật đã tải sẵn (bạn bè/rcRooms);
  // "Tin nhắn" đến từ state bất đồng bộ ở trên (gọi backend, không lọc client-side).
  const searchResults = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    const people = friends.filter((f) => matches(f.agentName, q) || matches(f.nickname, q) || matches(f.agentCode, q));
    const groups = (rcRooms ?? []).filter((r) => r.isGroup && matches(r.name, q));
    return { people, messageHits, groups };
  }, [query, friends, rcRooms, messageHits]);

  // MENU HỘI THOẠI (7/8) — xử hành động: cập nhật danh sách LẠC QUAN (phòng biến mất/ghim lên đầu = phản hồi trực
  // quan) + gọi API; lỗi → refetch để đồng bộ lại server. Ẩn/Xóa/Báo xấu đều loại phòng khỏi danh sách phía mình.
  const patchConvRooms = (fn: (list: ChatRoom[]) => ChatRoom[]): void => {
    setRcRooms((prev) => { if (!prev) return prev; const next = fn(prev); setRoomsListCache(next); return next; });
  };
  const sortPinnedFirst = (l: ChatRoom[]): ChatRoom[] => l.map((r, i) => [r, i] as const)
    .sort((a, b) => (b[0].pinned ? 1 : 0) - (a[0].pinned ? 1 : 0) || a[1] - b[1]).map(([r]) => r);
  async function handleConvAction(action: ConversationAction, room: ChatRoom): Promise<void> {
    const rid = room.id;
    const removeFromList = (): void => patchConvRooms((l) => l.filter((r) => r.id !== rid));
    try {
      switch (action) {
        case 'markUnread':
          patchConvRooms((l) => l.map((r) => (r.id === rid ? { ...r, unreadCount: Math.max(1, r.unreadCount) } : r)));
          await markConversationUnread(rid); break;
        case 'togglePin': {
          const now = !room.pinned;
          patchConvRooms((l) => sortPinnedFirst(l.map((r) => (r.id === rid ? { ...r, pinned: now } : r))));
          await pinConversation(rid, now); break;
        }
        case 'toggleMute': {
          const now = !room.muted;
          patchConvRooms((l) => l.map((r) => (r.id === rid ? { ...r, muted: now } : r)));
          await muteConversation(rid, now); break;
        }
        case 'categorize': setManageOpen(true); break;      // gán phân loại trong CategoryManagerModal
        case 'addToGroup': setCreateGroupOpen(true); break;  // tạo nhóm cùng người này
        case 'hide': removeFromList(); await hideConversation(rid, true); break;
        // XÓA HỘI THOẠI kiểu Zalo (7/8, Admin Demo) — PHẢI xác nhận (xóa toàn bộ nội dung, chỉ phía mình) TRƯỚC khi
        // xóa. Không xóa ngay: mở ConfirmDialog, việc xóa thật nằm ở onConfirm (setRemoveConfirm bên dưới).
        case 'remove': setRemoveConfirm(room); break;
        case 'report': removeFromList(); await reportConversation(rid); break;
      }
    } catch {
      // Lỗi mạng/permission → tải lại danh sách để không lệch với server (bỏ lạc quan sai).
      clearRoomsListCache();
      const res = await listChatRoomsWithNames();
      if (res.ok) { setRcRooms(res.data); setRoomsListCache(res.data); }
    }
  }

  return (
    <div className="flex h-full flex-col bg-white">
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h1 className="min-w-0 truncate text-base font-bold text-slate-800">Trò chuyện</h1>
        {/* 2 nút hành động chính — Admin Demo (5/8) yêu cầu NỔI BẬT + ĐỒNG NHẤT + 3D như website. Trước viết tay
            `bg-brand`/`bg-brand-tint` phẳng, LẠC hệ thống nút. Nay dùng CHUNG <Button> (soft = phụ, viền/nền
            tint brand; confirm = chính, gradient brand→teal + kính nổi 3D) — size="sm" để gọn trên header. */}
        {/* 7/8 (Admin Demo — Fold 4 cover 344px tràn): nút hành động header thu về ICON-ONLY trên màn hẹp
            (collapseLabel), lg+ (EXE/desktop) hiện lại icon+chữ. min-w-0 để cụm co được, không đẩy tràn. */}
        <div className="flex min-w-0 shrink items-center gap-2">
          <Button variant="soft" size="sm" collapseLabel onClick={() => setManageOpen(true)} title="Quản lý phân loại" aria-label="Quản lý phân loại" icon={<Settings2 className="h-4 w-4" />}>
            Phân loại
          </Button>
          <Button
            variant="confirm"
            size="sm"
            collapseLabel
            onClick={() => setCreateGroupOpen(true)}
            title="Tạo nhóm chat mới"
            aria-label="Tạo nhóm chat mới"
            data-testid="open-create-group"
            icon={<Users className="h-4 w-4" />}
          >
            Tạo nhóm chat
          </Button>
        </div>
      </div>

      {/* Mục 33 — ô tìm kiếm toàn cục. */}
      <div className="border-b border-line px-4 py-2.5">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Tìm người, tin nhắn, nhóm..."
            className="w-full rounded-full border border-line bg-appbg py-2 pl-9 pr-9 text-sm outline-none transition focus:border-brand focus:bg-white"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              aria-label="Xóa tìm kiếm"
              className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 hover:text-slate-600"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Chip lọc theo phân loại (mục 21) — bấm lọc THẬT trên mock data. Ẩn khi đang tìm kiếm. */}
      <div className={'flex flex-wrap gap-1.5 border-b border-line px-4 py-2.5' + (searchResults ? ' hidden' : '')}>
        <button
          onClick={() => setFilter(undefined)}
          className={
            'filter-chip rounded-full px-3 py-1 text-xs font-medium ' +
            (!filter ? 'filter-chip--active text-white' : 'bg-appbg text-slate-600')
          }
          // 5/8 (Admin Demo "trò chuyện Tất cả cũng cũ" + "mọi accent 1 tông brand") — active = CHÍNH
          // `var(--gradient-accent)` (#1877d6→#3bc3d0), CÙNG gradient brand với sidebar active + toggle-ON →
          // đồng nhất tuyệt đối. Giữ 3D highlight qua .filter-chip--active (--chip-c = brand cho bóng đổ).
          style={!filter ? ({ background: 'var(--gradient-accent)', ['--chip-c']: 'var(--color-brand)' } as CSSProperties) : undefined}
        >
          Tất cả
        </button>
        {categories.map((cat) => {
          const active = filter === cat.id;
          return (
            <button
              key={cat.id}
              onClick={() => setFilter(active ? undefined : cat.id)}
              className={
                'filter-chip flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ' +
                (active ? 'filter-chip--active text-white' : 'bg-appbg text-slate-600')
              }
              style={active ? ({ backgroundColor: cat.color, ['--chip-c']: cat.color } as CSSProperties) : undefined}
            >
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: active ? '#ffffff' : cat.color }} />
              {cat.name}
            </button>
          );
        })}
      </div>

      {/* Mục 33 — panel kết quả 3 nhóm khi có query; ngược lại hiện danh sách chat thường. */}
      {searchResults ? (
        <div className="flex-1 overflow-auto">
          {!messageHitsLoading && searchResults.people.length === 0 && searchResults.messageHits.length === 0 && searchResults.groups.length === 0 && (
            <div className="flex flex-col items-center gap-2 p-8 text-center text-sm text-slate-400">
              <Search className="h-8 w-8 text-slate-300" />
              Không tìm thấy kết quả cho "{query}".
            </div>
          )}

          {openChatError && <div className="border-b border-line bg-danger/5 px-4 py-2 text-xs text-danger">{openChatError}</div>}

          {searchResults.people.length > 0 && (
            <div className="border-b border-line pb-2">
              <h3 className="px-4 pb-1 pt-3 text-xs font-semibold uppercase text-slate-400">Người</h3>
              {searchResults.people.map((f) => {
                const displayName = f.nickname || f.agentName;
                return (
                  <button
                    key={f.agentId}
                    onClick={() => handleOpenChatWithFriend(f.agentId)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-appbg"
                  >
                    <AgentAvatar agentId={f.agentId} name={displayName} size={36} />
                    <div className="flex-1">
                      <div className="text-sm font-semibold text-slate-800">{displayName}</div>
                      <div className="text-xs text-slate-500">Mã: {f.agentCode ?? '—'}</div>
                    </div>
                    <span className="text-xs text-slate-400">Bạn bè</span>
                  </button>
                );
              })}
            </div>
          )}

          {(searchResults.messageHits.length > 0 || messageHitsLoading) && (
            <div className="border-b border-line pb-2">
              <h3 className="flex items-center gap-2 px-4 pb-1 pt-3 text-xs font-semibold uppercase text-slate-400">
                Tin nhắn {messageHitsLoading && <DotsLoader size="sm" />}
              </h3>
              {searchResults.messageHits.map((hit) => {
                const room = (rcRooms ?? []).find((r) => r.id === hit.roomId);
                const roomName = room?.name || hit.roomName || 'Cuộc trò chuyện';
                return (
                  <button
                    key={hit.messageId}
                    onClick={() => room && (onOpenRoomMessage ? onOpenRoomMessage(room.id, hit.messageId) : onOpenRoom(room))}
                    disabled={!room}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-appbg disabled:opacity-50"
                  >
                    <MessageSquareText className="h-5 w-5 shrink-0 text-slate-400" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm text-slate-700">{hit.snippet}</div>
                      <div className="text-xs text-slate-400">
                        {roomName} · {formatHitTime(hit.createdAt)}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {searchResults.groups.length > 0 && (
            <div className="pb-2">
              <h3 className="px-4 pb-1 pt-3 text-xs font-semibold uppercase text-slate-400">Nhóm</h3>
              {searchResults.groups.map((room) => (
                <button key={room.id} onClick={() => onOpenRoom(room)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-appbg">
                  {/* Avatar ĐỒNG BỘ (8/8) — kết quả tìm "Nhóm" cũng hiện ẢNH nhóm THẬT nếu đã đặt (RoomAvatar),
                      chưa đặt → vòng tròn màu + icon Users (như cũ). */}
                  <RoomAvatar room={room} size={36} groupFallback="icon" />
                  <div className="flex-1">
                    <div className="text-sm font-semibold text-slate-800">{room.name}</div>
                    <div className="text-xs text-slate-500">{room.lastMessage}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : rcRooms === null ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-sm text-slate-400">
          <DotsLoader />
          Đang tải danh sách trò chuyện...
        </div>
      ) : (
        <>
          {roomsError && (
            <div className="border-b border-line bg-danger/5 px-4 py-2 text-xs text-danger">
              Không tải được danh sách trò chuyện mới nhất: {roomsError}
            </div>
          )}
          <ChatList
            rooms={rooms}
            onSelect={onOpenRoom}
            categoryByRoomId={categoryInfoByRoomId}
            onRequestMenu={(room, rect) => setConvMenu({ room, rect })}
          />
        </>
      )}

      {manageOpen && (
        <CategoryManagerModal
          onClose={() => {
            setManageOpen(false);
          }}
        />
      )}

      {createGroupOpen && (
        <CreateGroupModal
          onClose={() => setCreateGroupOpen(false)}
          onCreated={(newRoomId) => {
            setCreateGroupOpen(false);
            // Phòng vừa tạo có thể chưa nằm trong cache 8s của danh sách chat — xóa để lần quay lại tự tải mới,
            // tránh nhóm mới "biến mất" khỏi danh sách trong vài giây (điều hướng vào phòng vẫn fetch tươi riêng).
            clearRoomsListCache();
            // Điều hướng vào phòng GROUP mới — reuse onOpenRoomId (App.tsx → navigate(ROUTES.chatRoom(id))).
            onOpenRoomId?.(newRoomId);
          }}
        />
      )}

      {/* MENU HỘI THOẠI (7/8) — nhấn giữ/chuột-phải 1 dòng danh sách. */}
      {convMenu && (
        <ConversationMenu
          room={convMenu.room}
          anchorRect={convMenu.rect}
          onAction={(action) => void handleConvAction(action, convMenu.room)}
          onClose={() => setConvMenu(null)}
        />
      )}

      {/* XÓA HỘI THOẠI kiểu Zalo (7/8, Admin Demo "phải hỏi xác nhận xóa toàn bộ nội dung, chỉ xóa phía bạn") —
          xác nhận TRƯỚC khi xóa. Xóa = ẩn toàn bộ lịch sử phía mình (server clearedAt) + rời danh sách; nhắn lại
          mở ra TRỐNG. Phía người kia KHÔNG bị ảnh hưởng. */}
      {removeConfirm && (
        <ConfirmDialog
          title="Xóa hội thoại"
          message={`Xóa toàn bộ nội dung trò chuyện với "${removeConfirm.name}"? Chỉ xóa ở phía bạn — người kia vẫn thấy cuộc trò chuyện. Mở lại sẽ trống, chỉ hiện tin nhắn mới.`}
          confirmLabel="Xóa hội thoại"
          danger
          onCancel={() => setRemoveConfirm(null)}
          onConfirm={async () => {
            const rid = removeConfirm.id;
            setRemoveConfirm(null);
            setRcRooms((l) => (l ? l.filter((r) => r.id !== rid) : l));
            try {
              await removeConversation(rid);
            } catch {
              // Lỗi → tải lại để không lệch server.
              clearRoomsListCache();
              const res = await listChatRoomsWithNames();
              if (res.ok) { setRcRooms(res.data); setRoomsListCache(res.data); }
            }
          }}
        />
      )}
    </div>
  );
}
