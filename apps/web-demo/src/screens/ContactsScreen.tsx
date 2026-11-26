// Danh bạ (mục 27 — kết bạn/hủy kết bạn + mục 24 — QR kết bạn), 24/7 CHUYỂN TỪ MOCK SANG THẬT: gọi
// apps/bot-api/src/routes/me.ts (`/v1/me/friends/*`, RC-auth) qua lib/agent-api-client.ts — KHÔNG còn state
// cục bộ giả lập. Tra cứu người mới qua mã đại lý CHÍNH XÁC (lookupAgentByCode — KHÔNG phải "Danh bạ nội bộ"
// tìm kiếm mờ theo tên/email, mục đó còn treo riêng trong VERSION.md). Ô tìm kiếm (mục 33, đã có trước) GIỮ
// NGUYÊN UX, đổi nguồn dữ liệu sang lọc TRÊN DANH SÁCH BẠN BÈ THẬT (tên/mã đại lý — KHÔNG còn username/SĐT/
// email vì bot-api không trả các trường đó qua /v1/me/friends).
//
// B40 (27/7, Admin Demo báo thật "kết bạn xong không nhắn tin được") — SỬA: "Nhắn tin" TRƯỚC ĐÂY gọi
// onChat(String(agentId)) rồi App.tsx tra bảng tĩnh AGENT_TO_ROOM (chỉ map sẵn 3 phòng mock a1/a2/a3) — bạn
// mới kết bạn KHÔNG có trong bảng này nên luôn rơi về danh sách chat chung, KHÔNG mở đúng phòng. Giờ tạo/lấy
// phòng DM THẬT qua createOrGetDirectRoom(f.agentId) (chat-client.ts), rồi onChat NHẬN THẲNG roomId thật để
// điều hướng — xem App.tsx ContactsRoute. onCall (gọi thoại/video) fix-contacts-call (31/7) — ĐÃ đóng nốt cùng
// lỗ hổng (App.tsx ContactsRoute.onCall giờ cũng resolve phòng DIRECT thật + calleeAgentId qua
// buildContactCallNavigation(), CallScreen.tsx đã nối WebRTC thật từ Phase 4, KHÔNG còn "chế độ giả lập" cho
// luồng gọi từ Danh bạ — xem BUGS_FIXED.md B62, nối tiếp B40/B59).
import { useCallback, useEffect, useState, type JSX } from 'react';
import {
  BookOpen,
  Cake,
  Check,
  MessageCircle,
  Pencil,
  Phone,
  QrCode,
  Search,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  User,
  UserMinus,
  UserPlus,
  Users,
  Video,
  X
} from 'lucide-react';
import { Button } from '../components/Button';
import { DotsLoader } from '../components/DotsLoader';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { inputCls } from '../components/Field';
import {
  acceptFriendRequest,
  blockFriend,
  isRecentlyAcceptedFriend,
  lookupAgentByCode,
  lookupAgentByContact,
  rejectFriendRequest,
  sendFriendRequest,
  setFriendCategory,
  setFriendNickname,
  unblockFriend,
  unfriend,
  type AgentLookupResult,
  type FriendCategory,
  type FriendListItem,
  type FriendListResult,
  type FriendRequestListItem
} from '../lib/agent-api-client';
import { createOrGetDirectRoom } from '../lib/chat-client';
import { getCachedFriends, invalidateFriendsCache, peekCachedFriends } from '../lib/friends-cache';
import { AgentAvatar, invalidateAllAgentAvatars } from '../components/AgentAvatar';
import { OnlineDot } from '../components/OnlineDot';
import { PresenceStatusText } from '../components/PresenceStatusText';
import { seedPresence } from '../lib/presence-store';
import { requestPresenceCheck } from '../lib/presence-check';
import { fetchAttachmentObjectUrl } from '../lib/attachment-blob';

/** URL gốc bot-api (CÙNG quy ước AgentAvatar.tsx/diary-api.ts) — dùng để tải ảnh bìa THẬT của bạn bè trong
 * modal hồ sơ mini (route đọc theo :id nên NGƯỜI KHÁC xem được, xem routes/me.ts). */
function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

/** 4/8 — định dạng ngày sinh bạn bè (ISO từ Agent.dateOfBirth @db.Date, lưu nửa đêm UTC) → "DD/MM/YYYY".
 * Dùng getUTC* (KHÔNG local) để không lệch 1 ngày ở UTC+7. null/không hợp lệ → "Chưa cập nhật". */
function formatDob(iso: string | null): string {
  if (!iso) return 'Chưa cập nhật';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Chưa cập nhật';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

/** 4/8 — nhãn giới tính tiếng Việt từ mã Agent.gender ("MALE"|"FEMALE"|"OTHER"). Khác/null → "Chưa cập nhật". */
function formatGender(g: string | null): string {
  if (g === 'MALE') return 'Nam';
  if (g === 'FEMALE') return 'Nữ';
  if (g === 'OTHER') return 'Khác';
  return 'Chưa cập nhật';
}

/** 25/7 (Admin Demo yêu cầu "chặn cuộc gọi, chặn tin nhắn") — true nếu MÌNH không thể nhắn tin/gọi cho người
 * này: HOẶC mình đã chặn họ (blockedByMe — tự nhất quán, đã chặn thì không tự nhắn/gọi cho họ nữa), HOẶC họ
 * đã chặn mình (blockedThem — enforcement thật, xem báo cáo quyết định thiết kế). CHỈ dùng field blockedThem
 * để QUYẾT ĐỊNH disable, KHÔNG hiện chữ "họ đã chặn bạn" ra UI (đúng yêu cầu giữ đơn giản). */
function isBlockedForMe(f: FriendListItem): boolean {
  return f.blockedByMe || f.blockedThem;
}

/** Việc 2 (1/8) — TRƯỚC ĐÂY file này tự viết hàm riêng `colorForAgent()` (modulo THÔ `id % palette.length`,
 * KHÔNG hash), lệch với hash polynomial dùng ở chat-client.ts/GroupInfoPanel.tsx → CÙNG 1 agent hiện 2 màu
 * avatar khác nhau tùy màn hình (bug Admin Demo báo). Đã hợp nhất về `avatarColorForAgent()` (avatar-color.ts) —
 * DÙNG CHUNG với mọi màn khác hiển thị avatar theo agentId. */

/** 31/7 (phân loại bạn bè) — nhãn hiển thị + màu badge cho 2 giá trị hợp lệ (null = "Không phân loại", KHÔNG
 * hiện badge cho trường hợp này, xem chỗ dùng ở list row). */
const CATEGORY_LABEL: Record<'FAMILY' | 'WORK', string> = { FAMILY: 'Gia đình', WORK: 'Công việc' };
const CATEGORY_BADGE_CLASS: Record<'FAMILY' | 'WORK', string> = {
  FAMILY: 'bg-brand-tint text-brand',
  WORK: 'bg-warning/15 text-warning'
};

/** So khớp không phân biệt hoa/thường (mục 33 — giữ nguyên hành vi ô tìm kiếm đã có). */
function matches(haystack: string | null | undefined, q: string): boolean {
  return !!haystack && haystack.toLowerCase().includes(q.toLowerCase());
}

export function ContactsScreen({
  onChat,
  onCall,
  onOpenMyQr,
  onOpenDiary
}: {
  /** B40 (27/7), Phase 3 (29/7) cutover — nhận THẲNG roomId phòng DIRECT thật của hệ chat lõi mới (KHÔNG còn
   * agentId, KHÔNG còn RC roomId) — ContactsScreen tự resolve qua createOrGetDirectRoom() (chat-client.ts)
   * TRƯỚC khi gọi callback này, xem handleMessageFriend() bên dưới. */
  onChat: (roomId: string) => void;
  /** 25/7 — bắt đầu cuộc gọi thoại/video tới 1 bạn bè, xem CallScreen.tsx. `agentId` (chuỗi số của
   * `profile.agentId`) là định danh CHÍNH XÁC người được gọi — App.tsx `ContactsRoute.onCall` (fix-contacts-call
   * 31/7) tự resolve phòng DIRECT thật qua createOrGetDirectRoom(agentId) rồi buildContactCallNavigation()
   * (call-signaling-client.ts) để đổ chuông đối phương THẬT qua WebRTC (Phase 4), KHÔNG còn rơi vào "chế độ
   * xem trước" như trước (bảng tĩnh AGENT_TO_ROOM cũ đã xóa). */
  /** fix-call-name (31/7, B67) — `calleeName` (TÙY CHỌN, tên hiển thị hồ sơ đang xem — `profile.nickname ??
   * profile.agentName`, CÙNG field render ở phần header hồ sơ ngay dưới) — App.tsx `ContactsRoute.onCall`
   * truyền tiếp cho `buildContactCallNavigation()` để CallScreen hiện ĐÚNG tên thay vì tra bảng mock
   * `CHAT_ROOMS` (gần như luôn miss với phòng DIRECT thật, xem BUGS_FIXED.md B67). */
  onCall?: (agentId: string, kind: 'voice' | 'video', calleeName?: string) => void;
  onOpenMyQr?: () => void;
  /** Nhật ký (mục 40) — mở nhật ký của 1 đại lý bạn bè (route /app/diary/:agentId). App.tsx `ContactsRoute`
   * truyền navigate(ROUTES.diaryOf(agentId)); bot-api tự chặn NOT_VISIBLE nếu không phải bạn/của mình. */
  onOpenDiary?: (agentId: number) => void;
}): JSX.Element {
  // PERF SWR (15/8) — khởi tạo TỪ bản danh bạ biết-lần-cuối (peek, memory/sessionStorage) → render NGAY khi mở
  // lại, KHÔNG spinner. Chỉ hiện "Đang tải" khi CHƯA từng có (peek null). Mount effect vẫn revalidate nền.
  const [data, setData] = useState<FriendListResult | null>(() => peekCachedFriends());
  const [loading, setLoading] = useState(() => peekCachedFriends() == null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyIds, setBusyIds] = useState<Set<string>>(new Set()); // "action:id" đang xử lý — chặn double-click
  const [actionError, setActionError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const [lookupCode, setLookupCode] = useState('');
  const [lookupBusy, setLookupBusy] = useState(false);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupResult, setLookupResult] = useState<AgentLookupResult | null>(null);

  // 31/7 — căn cứ tìm bạn THỨ 2 (email/SĐT), CHỈ THÊM bên cạnh ô mã đại lý ở trên (GIỮ NGUYÊN, không đổi).
  // contactResults LUÔN là MẢNG nội bộ (kể cả nhánh email chỉ 1 kết quả — bọc [x] cho đồng nhất render), null
  // = chưa tìm/đã đóng, mảng rỗng = đã tìm nhưng không thấy ai (khác lookupError — đó là lỗi thật sự).
  const [contactQuery, setContactQuery] = useState('');
  const [contactBusy, setContactBusy] = useState(false);
  const [contactError, setContactError] = useState<string | null>(null);
  const [contactResults, setContactResults] = useState<AgentLookupResult[] | null>(null);

  const [profile, setProfile] = useState<FriendListItem | null>(null);
  // 6/8 (Admin Demo "ảnh bìa bạn bè KHÔNG hiện khi xem hồ sơ") — modal hồ sơ mini TRƯỚC ĐÂY luôn vẽ gradient
  // brand→teal cứng, KHÔNG BAO GIỜ tải ảnh bìa THẬT của bạn (dù bạn đã đặt — backend `GET /v1/agents/:id/cover`
  // đọc chéo được, xác nhận 200). Tải ảnh bìa khi mở modal (CÙNG cách PublicProfileScreen.tsx đã làm đúng),
  // fallback gradient khi bạn chưa đặt/404. Tải MỚI mỗi lần mở (không cache vĩnh viễn) → bạn đổi bìa, mở lại
  // thấy bản mới (đáp ứng "reload ra đúng, không kẹt bản cũ").
  const [profileCoverUrl, setProfileCoverUrl] = useState<string | null>(null);
  useEffect(() => {
    setProfileCoverUrl(null);
    if (!profile) return;
    let cancelled = false;
    fetchAttachmentObjectUrl(`${botApiBaseUrl()}/v1/agents/${profile.agentId}/cover`)
      .then((url) => { if (!cancelled) setProfileCoverUrl(url); })
      .catch(() => { if (!cancelled) setProfileCoverUrl(null); });
    return () => { cancelled = true; };
  }, [profile]);
  const [confirmUnfriend, setConfirmUnfriend] = useState<FriendListItem | null>(null);

  // 25/7 (biệt danh) — modal sửa biệt danh, mở từ hồ sơ mini. friend=null → đóng.
  const [editingNickname, setEditingNickname] = useState<FriendListItem | null>(null);
  const [nicknameInput, setNicknameInput] = useState('');
  const [nicknameBusy, setNicknameBusy] = useState(false);
  const [nicknameError, setNicknameError] = useState<string | null>(null);

  // 25/7 (chặn) — ConfirmDialog TRƯỚC khi chặn (đúng yêu cầu); bỏ chặn không cần xác nhận (đảo ngược được,
  // rủi ro thấp).
  const [confirmBlock, setConfirmBlock] = useState<FriendListItem | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    // B86-tiếp (1/8, việc 1) — qua cache dùng chung (friends-cache.ts): lần mount ĐẦU (hoặc sau khi 1 hành động
    // mutating đã tự invalidate() ở đúng nơi gọi reload(), xem doBlock/doUnblock/... bên dưới) sẽ fetch THẬT;
    // các lần reload() khác (vd điều hướng qua lại Danh bạ nhiều lần trong 1 phiên, KHÔNG có gì đổi) ăn theo
    // cache, không gọi mạng thừa.
    const r = await getCachedFriends();
    setLoading(false);
    if (r.ok) {
      setData(r.data);
    } else {
      setLoadError(r.message);
    }
  }, []);

  // 5/8 (bug Admin Demo "gửi lời mời + Thu hồi LOAD GIẬT") — làm mới danh sách NGẦM: KHÔNG bật `loading=true` (thứ
  // khiến TOÀN BỘ danh sách biến thành spinner "Đang tải danh bạ..." → nhảy/giật mỗi lần gửi/thu hồi). Danh sách
  // hiện tại GIỮ NGUYÊN trên màn (đã cập nhật optimistic ở nơi gọi), chỉ âm thầm đồng bộ lại dữ liệu thật từ
  // server (cache đã invalidate ở nơi gọi nên đây fetch mới). Dùng cho MỌI thao tác mutating thay cho reload().
  const refreshFriendsQuiet = useCallback(async () => {
    const r = await getCachedFriends();
    if (r.ok) setData(r.data);
    else setLoadError(r.message);
  }, []);

  // B107-tiếp (2/8, Admin Demo báo "không thấy hiển thị yêu cầu kết bạn để đồng ý") — GỐC THẬT: cache
  // friends-cache.ts KHÔNG có TTL, CHỈ tự làm mới khi CHÍNH MÌNH thao tác (gửi/chấp nhận/từ chối/chặn...) —
  // đã ghi rõ trong docstring module đó "người khác chấp nhận lời mời/gửi lời mời mới TỚI MÌNH vẫn cần điều
  // hướng lại/tải lại trang mới thấy". Với MỌI dữ liệu khác (tên/biệt danh/phân loại) đây là đánh đổi chấp
  // nhận được, nhưng "lời mời kết bạn MỚI TỚI" là đúng NGHIỆP VỤ CHÍNH màn này tồn tại để phục vụ — cache cũ
  // (từ lần mở Danh bạ TRƯỚC ĐÓ trong cùng phiên, TRƯỚC KHI lời mời mới tới) khiến lời mời hoàn toàn KHÔNG
  // hiện dù backend đã có đúng (xác nhận qua test `me-friends.test.ts` "B gọi GET /v1/me/friends NGAY SAU ĐÓ
  // thấy ĐÚNG lời mời"). Fix: invalidate cache TRƯỚC lần tải ĐẦU mỗi khi màn này MOUNT (không phải mỗi
  // reload() — các lần reload() SAU do hành động của chính mình đã tự invalidate ĐÚNG chỗ, KHÔNG cần double).
  useEffect(() => {
    invalidateFriendsCache(); // xoá cache-điều-khiển-fetch → BẮT BUỘC fetch mới (bắt lời mời kết bạn mới); bản
    // last-known bền VẪN còn cho render tức thời (xem friends-cache.ts). 5/8: làm mới nền avatar THẬT bạn bè.
    invalidateAllAgentAvatars();
    // PERF SWR (15/8) — ĐÃ có danh bạ (peek) → hiện NGAY + revalidate NGẦM (KHÔNG spinner chặn; lời mời mới hiện
    // sau ~1 vòng fetch). Chưa từng có → reload() với spinner như cũ.
    if (peekCachedFriends()) void refreshFriendsQuiet();
    else void reload();
  }, [reload, refreshFriendsQuiet]);

  // Hồ sơ mini (`profile`) giữ 1 SNAPSHOT của FriendListItem lúc mở — sau khi đặt biệt danh/chặn xong,
  // `reload()` cập nhật `data` nhưng KHÔNG tự đồng bộ `profile` (state riêng) → modal hồ sơ sẽ hiện dữ liệu
  // CŨ (biệt danh vừa đổi không hiện ngay) nếu không có effect này. Đồng bộ lại `profile` theo agentId mỗi
  // khi `data` đổi — nếu bạn bè đó không còn trong danh sách (vd vừa unfriend ở nơi khác), tự đóng modal.
  useEffect(() => {
    if (!profile || !data) return;
    const updated = data.friends.find((f) => f.agentId === profile.agentId);
    setProfile(updated ?? null);
  }, [data]);

  // PRESENCE LIVE (6/8) — SEED presence-store từ `online`+`lastSeenAt` server trả kèm danh sách bạn bè (vẽ đúng
  // ngay lần đầu, kể cả nhãn "X phút trước"); sau đó `presence-update` qua WS (chat-realtime.ts) tự cập nhật store
  // → chấm/nhãn đổi real-time. Đồng thời FCM-ping-on-view: gọi POST /v1/presence/check cho MỌI bạn (throttle 30s/
  // id trong presence-check.ts) để server đánh thức máy họ → nếu còn reachable thì chuyển online gần realtime.
  useEffect(() => {
    if (!data) return;
    const active = data.friends.filter((f) => !f.deactivated);
    // trustOffline:false (Admin Demo 21/8 "quay lại danh bạ báo offline lâu sau mới online") — `data` khởi từ CACHE
    // (peekCachedFriends) có thể STALE: bạn chạy APK nền thường bị đếm online=false lúc fetch danh sách dù đang
    // sống. Seed mặc định (trustOffline=true) ghi đè agent-đang-online-trong-store thành offline NGAY → nháy xám,
    // phải chờ hysteresis 4.5s/WS mới xanh lại. CHỈ áp online=true từ danh sách; offline vẫn tới tin cậy+tức thì
    // qua WS presence-update. (Thiết kế đã hỗ trợ sẵn — ContactsScreen trước chỉ quên dùng.)
    seedPresence(active.map((f) => [f.agentId, f.online, f.lastSeenAt] as const), { trustOffline: false });
    requestPresenceCheck(active.map((f) => f.agentId));
  }, [data]);

  async function doSetNickname(): Promise<void> {
    if (!editingNickname) return;
    const trimmed = nicknameInput.trim();
    setNicknameBusy(true);
    setNicknameError(null);
    const r = await setFriendNickname(editingNickname.agentId, trimmed.length > 0 ? trimmed : null);
    setNicknameBusy(false);
    if (!r.ok) {
      setNicknameError(r.message);
      return;
    }
    setEditingNickname(null);
    // B86-tiếp (1/8) — invalidate CHỦ ĐỘNG cache friends dùng chung (friends-cache.ts) NGAY sau khi server xác
    // nhận đổi biệt danh thành công — reload() ngay dưới sẽ tự fetch THẬT (cache đang nguội), CÙNG lúc mọi màn
    // khác (ChatListScreen/ConversationScreen/GroupInfoPanel qua buildAgentNameResolver()) lần tới sẽ thấy tên
    // hiển thị MỚI thay vì tên cache cũ.
    invalidateFriendsCache();
    await refreshFriendsQuiet(); // 5/8 — đồng bộ ngầm, không spinner toàn màn (mượt).
  }

  async function doBlock(agentId: number): Promise<void> {
    const r = await blockFriend(agentId);
    if (!r.ok) {
      setActionError(r.message);
      return;
    }
    setConfirmBlock(null);
    invalidateFriendsCache(); // B86-tiếp (1/8) — blockedByMe đổi, phải invalidate để reload() thấy trạng thái mới.
    await refreshFriendsQuiet(); // 5/8 — đồng bộ ngầm, không spinner toàn màn.
  }

  async function doUnblock(agentId: number): Promise<void> {
    const r = await unblockFriend(agentId);
    if (!r.ok) {
      setActionError(r.message);
      return;
    }
    invalidateFriendsCache(); // B86-tiếp (1/8) — cùng lý do doBlock().
    await refreshFriendsQuiet(); // 5/8 — đồng bộ ngầm, không spinner toàn màn.
  }

  /** 31/7 (phân loại bạn bè) — CÙNG khuôn doBlock/doUnblock (gọi ngay khi đổi dropdown, không cần modal xác
   * nhận riêng — đảo ngược được, rủi ro thấp giống nickname). Quản lý busyIds riêng (key `category:{id}`) để
   * disable dropdown trong lúc chờ, KHÔNG dùng withBusy() vì hàm này cần nhận thêm tham số `category`. */
  async function doSetCategory(agentId: number, category: FriendCategory): Promise<void> {
    const key = `category:${agentId}`;
    setBusyIds((prev) => new Set(prev).add(key));
    setActionError(null);
    const r = await setFriendCategory(agentId, category);
    setBusyIds((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (!r.ok) {
      setActionError(r.message);
      return;
    }
    invalidateFriendsCache(); // B86-tiếp (1/8) — category đổi, cùng lý do doBlock().
    await refreshFriendsQuiet(); // 5/8 — đồng bộ ngầm, không spinner toàn màn.
  }

  function withBusy(key: string, fn: () => Promise<void>): () => Promise<void> {
    return async () => {
      setBusyIds((prev) => new Set(prev).add(key));
      setActionError(null);
      try {
        await fn();
      } finally {
        setBusyIds((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    };
  }

  /** B40 (27/7) — tạo/lấy phòng DM thật với bạn bè `f` qua rcUsername (CÙNG hàm PublicProfileScreen.tsx dùng
   * cho quét QR), rồi mới điều hướng — thay hẳn kiểu cũ onChat(String(agentId)) tra bảng tĩnh AGENT_TO_ROOM
   * (luôn thiếu bạn mới). rcUsername null (bạn bè chưa link RC — hiếm, chỉ 6 tài khoản di trú cũ chưa có) →
   * báo lỗi rõ, KHÔNG gọi mạng vô ích. */
  async function handleMessageFriend(f: FriendListItem): Promise<void> {
    // Phase 3 (29/7) cutover — tạo/lấy phòng DIRECT qua hệ chat lõi mới (createOrGetDirectRoom, chat-client.ts).
    // KHÔNG còn cần rcUsername (đó là điều kiện của luồng RC im.create cũ) — hệ mới chỉ cần agentId, service tự
    // kiểm 2 bên đã là bạn bè (canMessageAgent(), luôn đúng ở đây vì `f` lấy từ chính danh sách bạn bè).
    const r = await createOrGetDirectRoom(f.agentId);
    if (!r.ok) {
      setActionError(r.message);
      return;
    }
    onChat(r.data.id);
  }

  async function doLookup(): Promise<void> {
    const code = lookupCode.trim();
    if (!code) return;
    setLookupBusy(true);
    setLookupError(null);
    setLookupResult(null);
    const r = await lookupAgentByCode(code);
    setLookupBusy(false);
    if (!r.ok) {
      setLookupError(r.message);
      return;
    }
    setLookupResult(r.data);
  }

  /** 31/7 — CÙNG khuôn doLookup() ở trên, khác nguồn (email/SĐT thay vì mã đại lý chính xác). data trả về từ
   * bot-api có thể là 1 object (nhánh email) hoặc mảng (nhánh SĐT) — bọc thống nhất thành mảng để render 1
   * danh sách duy nhất phía dưới, KHÔNG cần 2 nhánh JSX khác nhau. */
  async function doLookupByContact(): Promise<void> {
    const q = contactQuery.trim();
    if (!q) return;
    setContactBusy(true);
    setContactError(null);
    setContactResults(null);
    const r = await lookupAgentByContact(q);
    setContactBusy(false);
    if (!r.ok) {
      setContactError(r.message);
      return;
    }
    setContactResults(Array.isArray(r.data) ? r.data : [r.data]);
  }

  /** Gửi lời mời kết bạn từ danh sách kết quả tìm theo email/SĐT rồi đóng luôn khối kết quả đó — CÙNG hành vi
   * đóng của doSendRequest() với ô mã đại lý (setLookupResult(null)/setLookupCode('')). */
  async function doSendRequestFromContact(agentId: number): Promise<void> {
    await doSendRequest(agentId);
    setContactResults(null);
    setContactQuery('');
  }

  async function doSendRequest(agentId: number): Promise<void> {
    const r = await sendFriendRequest(agentId);
    if (!r.ok) {
      setActionError(r.message);
      return;
    }
    setInfoMessage(r.data.autoAccepted ? 'Đã thành bạn bè!' : 'Đã gửi lời mời kết bạn.');
    setLookupResult(null);
    setLookupCode('');
    // B86-tiếp (1/8) — gửi lời mời có thể autoAccepted:true (thành bạn NGAY) hoặc chỉ thêm outgoingRequests —
    // CẢ 2 trường hợp đều đổi shape FriendListResult, invalidate rồi để refresh ngầm fetch thật.
    invalidateFriendsCache();
    await refreshFriendsQuiet(); // 5/8 — đồng bộ ngầm, không spinner toàn màn (danh sách không nhảy/giật).
  }

  async function doAccept(requestId: number): Promise<void> {
    // 5/8 — OPTIMISTIC: bỏ ngay lời mời khỏi incomingRequests để dòng biến mất tức thì; refresh ngầm bổ sung
    // bạn mới vào friends[]. Rollback nếu API lỗi.
    const snapshot = data;
    setData((cur) => (cur ? { ...cur, incomingRequests: cur.incomingRequests.filter((rq) => rq.requestId !== requestId) } : cur));
    const r = await acceptFriendRequest(requestId);
    if (!r.ok) {
      setActionError(r.message);
      setData(snapshot);
      return;
    }
    invalidateFriendsCache(); // B86-tiếp (1/8) — chấp nhận lời mời → thêm bạn mới, cùng lý do doSendRequest().
    await refreshFriendsQuiet(); // 5/8 — đồng bộ ngầm, không spinner toàn màn.
  }

  async function doReject(requestId: number): Promise<void> {
    // 5/8 — OPTIMISTIC: bỏ ngay lời mời khỏi incomingRequests; rollback nếu lỗi.
    const snapshot = data;
    setData((cur) => (cur ? { ...cur, incomingRequests: cur.incomingRequests.filter((rq) => rq.requestId !== requestId) } : cur));
    const r = await rejectFriendRequest(requestId);
    if (!r.ok) {
      setActionError(r.message);
      setData(snapshot);
      return;
    }
    invalidateFriendsCache(); // B86-tiếp (1/8) — từ chối lời mời → incomingRequests đổi.
    await refreshFriendsQuiet(); // 5/8 — đồng bộ ngầm, không spinner toàn màn.
  }

  async function doUnfriend(agentId: number): Promise<void> {
    // 5/8 (bug Admin Demo "Thu hồi LOAD GIẬT") — OPTIMISTIC: bỏ NGAY người này khỏi cả friends[] và outgoingRequests[]
    // (Thu hồi lời mời ĐÃ GỬI = cùng endpoint unfriend) để dòng biến mất tức thì, không chờ round-trip + re-fetch.
    // Chụp snapshot để ROLLBACK nếu API lỗi. Đóng modal/confirm trước cho mượt.
    const snapshot = data;
    setConfirmUnfriend(null);
    setProfile(null);
    setData((cur) =>
      cur
        ? {
            ...cur,
            friends: cur.friends.filter((f) => f.agentId !== agentId),
            outgoingRequests: cur.outgoingRequests.filter((rq) => rq.agentId !== agentId)
          }
        : cur
    );
    const r = await unfriend(agentId);
    if (!r.ok) {
      setActionError(r.message);
      setData(snapshot); // rollback về đúng trạng thái trước khi bấm.
      return;
    }
    invalidateFriendsCache(); // B86-tiếp (1/8) — hủy kết bạn/thu hồi lời mời → friends[]/outgoingRequests[] đổi.
    await refreshFriendsQuiet(); // 5/8 — đồng bộ ngầm (KHÔNG spinner toàn màn) sau khi đã optimistic ở trên.
  }

  const allFriends = data?.friends ?? [];
  const incoming = data?.incomingRequests ?? [];
  const outgoing = data?.outgoingRequests ?? [];

  const q = query.trim();
  // 25/7 — tìm theo biệt danh MÌNH đã đặt CŨNG khớp (đúng kỳ vọng "dễ tìm" — lý do chính người dùng đặt biệt
  // danh), bên cạnh tên thật/mã đại lý đã có từ trước.
  const friends = !q
    ? allFriends
    : allFriends.filter((f) => matches(f.agentName, q) || matches(f.agentCode, q) || matches(f.nickname, q));

  return (
    // 7/8 (Admin Demo — Danh bạ tràn/cuộn ngang trên Fold cover): overflow-y-auto (KHÔNG cho cuộn NGANG, nội dung
    // phải tự fit), header co gọn (min-w-0/truncate + nút icon-only trên màn hẹp).
    <div className="h-full overflow-y-auto overflow-x-hidden bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h1 className="min-w-0 truncate text-base font-bold text-slate-800">Danh bạ</h1>
        {/* Mục 24 — nút QR cá nhân ở header danh bạ. 7/8: dùng CHUNG <Button> (soft, 3D brand) + icon-only trên
            màn hẹp (collapseLabel) để không tràn, lg+ hiện lại chữ. */}
        <Button
          variant="soft"
          size="sm"
          collapseLabel
          onClick={onOpenMyQr}
          title="Mã QR của tôi"
          aria-label="Mã QR của tôi"
          icon={<QrCode className="h-4 w-4" />}
        >
          Mã QR của tôi
        </Button>
      </div>

      {actionError && (
        <div className="mb-3 rounded-lg-mac border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">{actionError}</div>
      )}
      {infoMessage && (
        <div className="mb-3 flex items-center gap-2 rounded-lg-mac border border-brand/30 bg-brand-tint px-3 py-2 text-xs text-brand">
          <Sparkles className="h-3.5 w-3.5" /> {infoMessage}
        </div>
      )}

      {/* Thêm bạn qua mã người dùng (căn cứ tối thiểu để gửi lời mời — KHÔNG phải tìm kiếm Danh bạ đầy đủ). */}
      <div className="mb-5 rounded-lg-mac border border-dashed border-brand/40 bg-brand-tint/60 p-3">
        <div className="mb-1.5 text-sm font-semibold text-brand">Thêm bạn qua mã người dùng</div>
        <div className="flex gap-2">
          <input
            value={lookupCode}
            onChange={(e) => {
              setLookupCode(e.target.value);
              setLookupResult(null);
              setLookupError(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && doLookup()}
            placeholder="Nhập mã người dùng, vd DL001"
            className={inputCls + ' min-w-0 flex-1 bg-white'}
          />
          <button
            onClick={doLookup}
            disabled={lookupBusy || !lookupCode.trim()}
            className="btn-primary flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
          >
            {lookupBusy ? <DotsLoader size="sm" color="white" /> : <Search className="h-3.5 w-3.5" />} Tìm
          </button>
        </div>
        {lookupError && <div className="mt-2 text-xs text-danger">{lookupError}</div>}
        {lookupResult && (
          <div className="mt-2 flex items-center gap-3 rounded-lg-mac border border-line bg-white px-3 py-2">
            <AgentAvatar agentId={lookupResult.id} name={lookupResult.name} size={32} textClassName="text-xs" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold text-slate-800">{lookupResult.name}</div>
              <div className="truncate text-xs text-slate-500">Mã: {lookupResult.code ?? '—'}</div>
            </div>
            <button
              onClick={() => doSendRequest(lookupResult.id)}
              className="btn-primary flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white"
            >
              <UserPlus className="h-3.5 w-3.5" /> Kết bạn
            </button>
          </div>
        )}
        <div className="mt-1.5 text-xs text-slate-500">hoặc quét mã QR của bạn bè</div>

        {/* 31/7 — căn cứ tìm bạn THỨ 2 (email/SĐT), CHỈ THÊM bên dưới ô mã đại lý — ô mã đại lý ở trên GIỮ
            NGUYÊN 100%, không đổi hành vi/UX. SĐT có thể ra nhiều kết quả (phone KHÔNG unique) nên render
            danh sách, KHÔNG chỉ 1 thẻ như ô mã đại lý. */}
        <div className="mt-3 border-t border-brand/20 pt-3">
          <div className="mb-1.5 text-sm font-semibold text-brand">Hoặc tìm theo email/SĐT</div>
          <div className="flex gap-2">
            <input
              value={contactQuery}
              onChange={(e) => {
                setContactQuery(e.target.value);
                setContactResults(null);
                setContactError(null);
              }}
              onKeyDown={(e) => e.key === 'Enter' && doLookupByContact()}
              placeholder="Nhập email hoặc số điện thoại"
              className={inputCls + ' min-w-0 flex-1 bg-white'}
            />
            <button
              onClick={doLookupByContact}
              disabled={contactBusy || !contactQuery.trim()}
              className="btn-primary flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 text-xs font-medium text-white disabled:opacity-50"
            >
              {contactBusy ? <DotsLoader size="sm" color="white" /> : <Search className="h-3.5 w-3.5" />} Tìm
            </button>
          </div>
          {contactError && <div className="mt-2 text-xs text-danger">{contactError}</div>}
          {contactResults && contactResults.length === 0 && (
            <div className="mt-2 text-xs text-slate-500">Không tìm thấy người dùng nào khớp.</div>
          )}
          {contactResults && contactResults.length > 0 && (
            <div className="mt-2 space-y-2">
              {contactResults.map((item) => (
                <div key={item.id} className="flex items-center gap-3 rounded-lg-mac border border-line bg-white px-3 py-2">
                  <AgentAvatar agentId={item.id} name={item.name} size={32} textClassName="text-xs" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-semibold text-slate-800">{item.name}</div>
                    <div className="truncate text-xs text-slate-500">Mã: {item.code ?? '—'}</div>
                  </div>
                  <button
                    onClick={() => doSendRequestFromContact(item.id)}
                    className="btn-primary flex shrink-0 items-center gap-1 whitespace-nowrap px-2.5 py-1.5 text-xs font-medium text-white"
                  >
                    <UserPlus className="h-3.5 w-3.5 shrink-0" /> <span className="hidden sm:inline">Gửi lời mời kết bạn</span><span className="sm:hidden">Kết bạn</span>
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {loading && (
        <div className="flex items-center justify-center gap-2 py-6 text-sm text-slate-400">
          <DotsLoader /> Đang tải danh bạ...
        </div>
      )}
      {loadError && (
        <div className="mb-4 rounded-lg-mac border border-danger/30 bg-danger/5 px-3 py-2 text-xs text-danger">
          Không tải được danh bạ: {loadError}
        </div>
      )}

      {!loading && !loadError && (
        <>
          {/* Mục 27 — lời mời kết bạn NHẬN VỀ. */}
          {incoming.length > 0 && (
            <div className="mb-5">
              <h2 className="mb-2 text-sm font-semibold text-slate-600">Lời mời kết bạn ({incoming.length})</h2>
              <div className="divide-y divide-line rounded-lg-mac border border-line">
                {incoming.map((r: FriendRequestListItem) => {
                  const acceptKey = `accept:${r.requestId}`;
                  const rejectKey = `reject:${r.requestId}`;
                  return (
                    <div key={r.requestId} className="flex items-center gap-3 px-4 py-3">
                      <AgentAvatar agentId={r.agentId} name={r.agentName} size={40} />
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-slate-800">{r.agentName}</div>
                        <div className="text-xs text-slate-500">Mã: {r.agentCode ?? '—'}</div>
                      </div>
                      <button
                        onClick={withBusy(acceptKey, () => doAccept(r.requestId))}
                        disabled={busyIds.has(acceptKey) || busyIds.has(rejectKey)}
                        title="Chấp nhận"
                        className="btn-primary flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white disabled:opacity-50"
                      >
                        <Check className="h-3.5 w-3.5" /> Chấp nhận
                      </button>
                      <button
                        onClick={withBusy(rejectKey, () => doReject(r.requestId))}
                        disabled={busyIds.has(acceptKey) || busyIds.has(rejectKey)}
                        title="Từ chối"
                        className="rounded-md border border-line p-1.5 text-slate-500 hover:bg-appbg disabled:opacity-50"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Lời mời ĐÃ GỬI, đang chờ đối phương trả lời. */}
          {outgoing.length > 0 && (
            <div className="mb-5">
              <h2 className="mb-2 text-sm font-semibold text-slate-600">Đã gửi lời mời ({outgoing.length})</h2>
              <div className="divide-y divide-line rounded-lg-mac border border-line">
                {outgoing.map((r: FriendRequestListItem) => {
                  const key = `unfriend:${r.agentId}`;
                  return (
                    <div key={r.requestId} className="flex items-center gap-3 px-4 py-3">
                      <AgentAvatar agentId={r.agentId} name={r.agentName} size={40} />
                      <div className="flex-1">
                        <div className="text-sm font-semibold text-slate-800">{r.agentName}</div>
                        <div className="text-xs text-slate-500">Mã: {r.agentCode ?? '—'} · Đang chờ phản hồi</div>
                      </div>
                      {/* 5/8 (Admin Demo: "Thu hồi PHẢI đỏ CÙNG TONE Đăng xuất") — dùng <Button variant="danger">
                          = .btn-danger (pill ĐỎ glass), thay nút viền xám cũ. Đồng bộ tuyệt đối với nút Đăng
                          xuất (Cài đặt) cũng variant="danger". size="sm" cho gọn trong hàng lời mời. */}
                      <Button
                        variant="danger"
                        size="sm"
                        onClick={withBusy(key, () => doUnfriend(r.agentId))}
                        disabled={busyIds.has(key)}
                      >
                        Thu hồi
                      </Button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Ô tìm kiếm (mục 33) — lọc TRÊN danh sách bạn bè thật theo tên/mã đại lý. */}
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Tìm bạn bè theo tên hoặc mã người dùng..."
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

          {/* Bạn bè thật (ACCEPTED). */}
          <h2 className="mb-2 text-sm font-semibold text-slate-600">
            Bạn bè {q ? `(${friends.length} kết quả cho "${q}")` : `(${friends.length})`}
          </h2>
          {q && friends.length === 0 ? (
            <div className="flex flex-col items-center gap-2 rounded-lg-mac border border-line p-8 text-center text-sm text-slate-400">
              <Search className="h-8 w-8 text-slate-300" />
              Không tìm thấy bạn bè nào khớp "{q}".
            </div>
          ) : !q && friends.length === 0 ? (
            <div className="rounded-lg-mac border border-dashed border-line px-4 py-6 text-center text-sm text-slate-400">
              Chưa có bạn bè nào — thử thêm bạn qua mã người dùng ở trên.
            </div>
          ) : (
            <div className="divide-y divide-line rounded-lg-mac border border-line">
              {friends.map((f) => {
                const isNew = isRecentlyAcceptedFriend(f.acceptedAt);
                return (
                  <div key={f.requestId} className="flex items-center gap-3 px-4 py-3">
                    <button onClick={() => setProfile(f)} className="flex flex-1 items-center gap-3 text-left">
                      <AgentAvatar agentId={f.agentId} name={f.agentName} size={40}>
                        {/* Chấm trạng thái kiểu Zalo (BUG#10, 6/8) — presence THẬT từ bot-api (hub WS
                            agentHasOpenConnection, xem friend-service.ts listFriends): XANH LÁ = online,
                            ĐỎ = offline. Chỉ ẩn chấm khi f.online == null (bạn đã vô hiệu hóa/dữ liệu cũ chưa
                            có trường online) — KHÔNG hiện sai trạng thái. */}
                        {f.online != null && !f.deactivated && (
                          <OnlineDot
                            online={f.online}
                            agentId={f.agentId} // presence LIVE (presence-store) → chấm đổi màu ngay khi bạn on/off.
                            size={10}
                            className="absolute -bottom-0.5 -right-0.5 border-2 border-white"
                            title={f.online ? 'Đang hoạt động' : 'Ngoại tuyến'}
                          />
                        )}
                      </AgentAvatar>
                      <div className="flex-1">
                        <div className="flex items-center gap-1.5">
                          {/* 25/7 — hiện biệt danh THAY CHO tên thật nếu đã đặt (kèm tên thật nhỏ bên dưới
                              để không nhầm lẫn, xem dòng ngay dưới). */}
                          <span className="text-sm font-semibold text-slate-800">{f.nickname ?? f.agentName}</span>
                          {/* Badge "Bạn mới" (Admin Demo bổ sung 24/7, ngưỡng chốt lại 2/8) — acceptedAt trong vòng
                              NEW_FRIEND_BADGE_THRESHOLD_MINUTES phút (agent-api-client.ts, hiện = 60 phút). */}
                          {isNew && (
                            <span className="rounded-full bg-success/15 px-1.5 py-0.5 text-[10px] font-semibold text-success">Bạn mới</span>
                          )}
                          {/* 31/7 — badge phân loại nhỏ (chỉ hiện khi ĐÃ phân loại — null = "Không phân
                              loại" thì không hiện gì, tránh rác UI cho phần lớn bạn bè chưa phân loại). Đổi
                              phân loại qua dropdown trong hồ sơ mini (bấm vào dòng này mở profile). */}
                          {f.category && (
                            <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${CATEGORY_BADGE_CLASS[f.category]}`}>
                              {CATEGORY_LABEL[f.category]}
                            </span>
                          )}
                        </div>
                        {f.nickname && <div className="text-xs text-slate-400">{f.agentName}</div>}
                        {/* Trạng thái online kiểu Zalo (BUG#10, 6/8) — dòng RIÊNG dưới tên, cỡ chữ 11px. XANH =
                            đang hoạt động, xám = ngoại tuyến. Ẩn khi f.online==null hoặc bạn đã vô hiệu hóa.
                            (6/8, Admin Demo chốt) — ĐÃ BỎ dòng "Mã ĐL: XX" cũ ở đây, chỉ giữ dòng trạng thái này.
                            GHI CHÚ LEAD: "hoạt động lúc HH:MM" cần cột last-seen cho Agent (chưa có) — không bịa. */}
                        {f.online != null && !f.deactivated && (
                          <PresenceStatusText agentId={f.agentId} online={f.online} lastSeenAt={f.lastSeenAt} className="block text-[11px]" />
                        )}
                      </div>
                    </button>
                    <button
                      onClick={withBusy(`message:${f.agentId}`, () => handleMessageFriend(f))}
                      disabled={isBlockedForMe(f) || busyIds.has(`message:${f.agentId}`)}
                      title={isBlockedForMe(f) ? 'Không thể nhắn tin — đã chặn' : 'Nhắn tin'}
                      className="rounded-full p-2 text-brand hover:bg-brand-tint disabled:cursor-not-allowed disabled:text-slate-300 disabled:hover:bg-transparent"
                    >
                      {busyIds.has(`message:${f.agentId}`) ? <DotsLoader size="sm" /> : <MessageCircle className="h-4 w-4" />}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {/* Modal hồ sơ mini (mục 27). */}
      {profile && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setProfile(null)}>
          <div
            className="w-full max-w-xs overflow-hidden rounded-lg-mac border border-line bg-white shadow-card"
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className={`relative flex flex-col items-center gap-2 bg-cover bg-center px-6 py-6 text-white ${profileCoverUrl ? '' : 'bg-gradient-to-br from-brand to-brand-teal'}`}
              style={profileCoverUrl ? { backgroundImage: `url(${profileCoverUrl})` } : undefined}
            >
              {/* Lớp phủ tối nhẹ khi có ảnh bìa THẬT — giữ chữ trắng (tên/mã) đọc được trên mọi ảnh sáng. */}
              {profileCoverUrl && <div className="absolute inset-0 bg-black/25" />}
              <AgentAvatar
                agentId={profile.agentId}
                name={profile.nickname ?? profile.agentName}
                size={64}
                textClassName="text-2xl"
                className="relative border-2 border-white/60"
              />
              <div className="relative text-base font-semibold">{profile.nickname ?? profile.agentName}</div>
              {/* 25/7 — tên thật nhỏ bên dưới khi đang hiện biệt danh, tránh nhầm lẫn "đây là ai thật". */}
              {profile.nickname && <div className="relative text-xs text-white/70">{profile.agentName}</div>}
              <div className="relative text-xs text-white/70">Mã: {profile.agentCode ?? '—'}</div>
            </div>
            <div className="flex flex-col gap-2 p-4">
              {/* 4/8 (Admin Demo) — thông tin ĐỌC-ONLY của bạn: ngày sinh + giới tính (nguồn Agent.dateOfBirth/
                  gender qua /v1/me/friends). Hiện "Chưa cập nhật" nếu bạn chưa khai (không ẩn hàng — để rõ). */}
              <div className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm text-slate-600">
                <span className="flex items-center gap-2">
                  <Cake className="h-3.5 w-3.5" /> Ngày sinh
                </span>
                <span className="text-xs font-medium text-slate-500">{formatDob(profile.dateOfBirth)}</span>
              </div>
              <div className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-sm text-slate-600">
                <span className="flex items-center gap-2">
                  <User className="h-3.5 w-3.5" /> Giới tính
                </span>
                <span className="text-xs font-medium text-slate-500">{formatGender(profile.gender)}</span>
              </div>

              {/* 25/7 — Đặt/xóa biệt danh (mục "đặt tên gợi nhớ cho bạn bè"). */}
              <button
                onClick={() => {
                  setNicknameInput(profile.nickname ?? '');
                  setNicknameError(null);
                  setEditingNickname(profile);
                }}
                className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-left text-sm text-slate-600 hover:bg-appbg"
              >
                <span className="flex items-center gap-2">
                  <Pencil className="h-3.5 w-3.5" /> Đặt biệt danh
                </span>
                <span className="text-xs text-slate-400">{profile.nickname ?? 'Chưa đặt'}</span>
              </button>

              {/* 31/7 — phân loại bạn bè (Gia đình/Công việc), CÙNG khuôn hàng biệt danh ở trên nhưng đổi
                  ngay qua dropdown (không cần modal riêng, đảo ngược được — cùng lý do bỏ chặn không cần
                  ConfirmDialog). */}
              <label className="flex items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-sm text-slate-600">
                <span className="flex items-center gap-2">
                  <Users className="h-3.5 w-3.5" /> Phân loại
                </span>
                <select
                  value={profile.category ?? ''}
                  disabled={busyIds.has(`category:${profile.agentId}`)}
                  onChange={(e) => {
                    const v = e.target.value;
                    doSetCategory(profile.agentId, v === '' ? null : (v as FriendCategory));
                  }}
                  className="rounded-md border border-line bg-white px-2 py-1 text-xs text-slate-600 outline-none focus:border-brand disabled:opacity-50"
                >
                  <option value="">Không phân loại</option>
                  <option value="FAMILY">Gia đình</option>
                  <option value="WORK">Công việc</option>
                </select>
              </label>

              {/* 25/7 — chặn cuộc gọi/tin nhắn: nút gọi/nhắn tin ẩn tác dụng (disabled) khi mình đã chặn họ
                  HOẶC họ đã chặn mình (isBlockedForMe — xem hàm đầu file). KHÔNG hiện rõ "họ đã chặn bạn" ra
                  UI (chỉ dùng nội bộ để enforce), chỉ hiện cảnh báo trung lập khi có block CHỦ ĐỘNG từ mình. */}
              {isBlockedForMe(profile) && (
                <div className="flex items-center gap-2 rounded-lg-mac border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-warning">
                  <ShieldAlert className="h-3.5 w-3.5 shrink-0" /> Không thể nhắn tin/gọi cho người này.
                </div>
              )}

              <Button
                icon={<MessageCircle className="h-4 w-4" />}
                className="w-full"
                disabled={isBlockedForMe(profile)}
                onClick={async () => {
                  const f = profile;
                  setProfile(null);
                  await handleMessageFriend(f);
                }}
              >
                Nhắn tin
              </Button>

              {/* Nhật ký (mục 40) — xem nhật ký của người bạn này (route /app/diary/:agentId). Chỉ hiện nếu
                  App.tsx truyền onOpenDiary (route ContactsScreen thật luôn có). */}
              {onOpenDiary && (
                <Button
                  variant="neutral"
                  icon={<BookOpen className="h-4 w-4" />}
                  className="w-full"
                  onClick={() => {
                    const id = profile.agentId;
                    setProfile(null);
                    onOpenDiary(id);
                  }}
                >
                  Xem nhật ký
                </Button>
              )}

              {/* 25/7 (mục "chặn cuộc gọi") — gọi thoại/video THẬT qua WebRTC (fix-contacts-call 31/7, xem
                  BUGS_FIXED.md B62 — trước đó rơi vào "chế độ xem trước" vì App.tsx tra bảng tĩnh
                  AGENT_TO_ROOM). Chỉ hiện nếu App.tsx có truyền onCall (route ContactsScreen thật luôn có). */}
              {onCall && (
                <div className="flex gap-2">
                  <Button
                    variant="neutral"
                    className="flex-1"
                    icon={<Phone className="h-4 w-4" />}
                    disabled={isBlockedForMe(profile)}
                    onClick={() => {
                      const id = profile.agentId;
                      const calleeName = profile.nickname ?? profile.agentName;
                      setProfile(null);
                      onCall(String(id), 'voice', calleeName);
                    }}
                  >
                    Gọi
                  </Button>
                  <Button
                    variant="neutral"
                    className="flex-1"
                    icon={<Video className="h-4 w-4" />}
                    disabled={isBlockedForMe(profile)}
                    onClick={() => {
                      const id = profile.agentId;
                      const calleeName = profile.nickname ?? profile.agentName;
                      setProfile(null);
                      onCall(String(id), 'video', calleeName);
                    }}
                  >
                    Video
                  </Button>
                </div>
              )}

              {/* 25/7 — Chặn/Bỏ chặn (mục "chặn cuộc gọi, chặn tin nhắn"). Bỏ chặn không cần ConfirmDialog
                  (đảo ngược được, rủi ro thấp) — CHẶN thì bắt buộc xác nhận (đúng yêu cầu). */}
              {profile.blockedByMe ? (
                <Button
                  variant="neutral"
                  icon={<ShieldCheck className="h-4 w-4" />}
                  className="w-full"
                  onClick={() => doUnblock(profile.agentId)}
                >
                  Bỏ chặn
                </Button>
              ) : (
                <Button
                  variant="neutral"
                  icon={<ShieldAlert className="h-4 w-4" />}
                  className="w-full"
                  onClick={() => setConfirmBlock(profile)}
                >
                  Chặn
                </Button>
              )}

              <Button
                variant="neutral"
                icon={<UserMinus className="h-4 w-4" />}
                className="w-full"
                onClick={() => setConfirmUnfriend(profile)}
              >
                Hủy kết bạn
              </Button>
            </div>
          </div>
        </div>
      )}

      {confirmUnfriend && (
        <ConfirmDialog
          title="Hủy kết bạn"
          message={`Hủy kết bạn với ${confirmUnfriend.nickname ?? confirmUnfriend.agentName}? Hai bạn sẽ không còn thấy nhau trong danh sách bạn bè.`}
          confirmLabel="Hủy kết bạn"
          danger
          onCancel={() => setConfirmUnfriend(null)}
          onConfirm={() => doUnfriend(confirmUnfriend.agentId)}
        />
      )}

      {confirmBlock && (
        <ConfirmDialog
          title="Chặn người này"
          message={`Chặn ${confirmBlock.nickname ?? confirmBlock.agentName}? Sau khi chặn, người này sẽ KHÔNG thể gọi điện hoặc nhắn tin cho bạn nữa. Bạn có thể bỏ chặn bất cứ lúc nào.`}
          confirmLabel="Chặn"
          danger
          onCancel={() => setConfirmBlock(null)}
          onConfirm={() => doBlock(confirmBlock.agentId)}
        />
      )}

      {/* 25/7 — modal sửa biệt danh. */}
      {editingNickname && (
        <Modal title="Đặt biệt danh" onClose={() => setEditingNickname(null)} width="max-w-sm" onSubmit={doSetNickname}>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-700">
              Biệt danh cho {editingNickname.agentName} <span className="font-normal text-slate-400">(chỉ mình bạn thấy)</span>
            </span>
            <input
              value={nicknameInput}
              autoFocus
              maxLength={50}
              onChange={(e) => setNicknameInput(e.target.value)}
              placeholder="Để trống = dùng tên thật"
              className={inputCls}
            />
          </label>
          {nicknameError && <div className="mt-2 text-xs text-danger">{nicknameError}</div>}
          <div className="mt-5 flex justify-end gap-2">
            <button
              onClick={() => setEditingNickname(null)}
              className="rounded-md border border-line px-4 py-2 text-sm font-medium text-slate-600 hover:bg-appbg"
            >
              Hủy
            </button>
            <Button onClick={doSetNickname} disabled={nicknameBusy} icon={nicknameBusy ? <DotsLoader size="sm" color="white" /> : undefined}>
              Lưu
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
