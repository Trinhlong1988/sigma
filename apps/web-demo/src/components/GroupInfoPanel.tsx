// Panel thông tin nhóm chat kiểu Zalo (Admin Demo 25/7): "xem thành viên nhóm chat, xem file đã gửi cho 1
// người/cho nhóm, lọc tin nhắn nhóm từ ngày đến ngày... lọc thông minh như đã làm với glb không phân biệt
// hoa thường" + "nhóm có bổ nhiệm trưởng nhóm, phó nhóm, có chế độ... quyền chỉ trưởng nhóm, phó nhóm...
// có quyền gửi tin nhắn". Mở từ icon "Info" trên header ConversationScreen.tsx (xem prop onOpenInfo ở đó).
//
// Phase 3 "real-time" (29/7, cutover) — CẮT phần "Thành viên" + đổi/phong vai trò sang hệ chat lõi TỰ XÂY
// (chat-client.ts, `/v1/chat/rooms/:roomId/members`) — API ĐÃ ĐỦ để port toàn bộ (đúng brief: "nếu
// /v1/chat/rooms/:roomId/members đã đủ, port luôn"). Vai trò đổi tên OWNER/ADMIN/MEMBER (thay owner/moderator
// RC cũ) — hiển thị NGUYÊN NHÃN "Trưởng nhóm"/"Phó nhóm" cho quen mắt người dùng, ngữ nghĩa dưới đất khác 1
// chỗ QUAN TRỌNG: hệ mới CHỈ ĐÚNG 1 OWNER TẠI MỌI THỜI ĐIỂM (đặt Trưởng nhóm mới = CHUYỂN NHƯỢNG, tự động hạ
// Trưởng nhóm cũ xuống Phó nhóm — KHÔNG có khái niệm "gỡ Trưởng nhóm" đứng một mình như RC owner/moderator độc
// lập cũ, xem changeMemberRole() chat-room-service.ts).
//
// TAB "File đã gửi" + cài đặt "Chỉ Trưởng/Phó được gửi tin" (readOnly) — debt-chat-gaps (31/7, Việc 3+4): CẢ
// 2 GAP Ở TRÊN ĐÃ ĐÓNG.
//   - Files: route mới `GET /v1/chat/rooms/:roomId/attachments` (listRoomAttachments(), chat-message-service.ts)
//     — liệt kê MỌI attachment đã gửi thành công trong phòng, tải lười (lazy) khi bấm vào tab này lần đầu.
//   - readOnly: field mới `ChatRoom.readOnly` (schema.prisma, migration `20260731100000_chat_room_read_only`) +
//     `updateGroupSettings()`/`sendMessage()` (chat-room-service.ts/chat-message-service.ts) enforce THẬT ở
//     server — toggle dưới đây (tab "Thành viên", CHỈ hiện cho OWNER/ADMIN — CÙNG gate `assertOwnerOrAdmin()`
//     phía server) chỉ gọi `updateChatRoomSettings()`.
//
// "Chặn thành viên tham gia" — hệ mới: addMember() (chat-room-service.ts) CHỈ OWNER/ADMIN mời được (assertOwnerOrAdmin),
// KHÔNG có "link tham gia công khai" nào — đã đủ đúng yêu cầu, không cần thêm UI/cơ chế.
// "Support có quyền gửi tin nhắn" — CHƯA LÀM (không suy đoán/bịa vai trò "support"), giữ nguyên như trước Phase 3.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { BarChart3, BellOff, Camera, Check, Crown, FileText, Image as ImageIcon, MessageCircle, Pencil, Pin, Search, Shield, Trash2, UserCheck, UserPlus, Users, UserX, X } from 'lucide-react';
import { useNavigate } from 'react-router';
import { ROUTES } from '../routes';
import { createOrGetDirectRoom, dissolveChatRoom, muteConversation } from '../lib/chat-client';
import { DotsLoader } from './DotsLoader';
import { ConfirmDialog } from './ConfirmDialog';
import { Switch } from './Switch';
import type { ChatMessage, ChatRoom } from '../mock-data/types';
import { smartIncludes } from '../lib/smart-search';
import {
  addChatRoomMember,
  approveRoomJoinRequest,
  buildAgentNameResolver,
  changeChatRoomMemberRole,
  chatAttachmentDownloadUrl,
  getChatRoomDetail,
  listChatRoomAttachments,
  listChatRoomMembers,
  listRoomJoinRequests,
  rejectRoomJoinRequest,
  removeChatRoomMember,
  roomAvatarUrl,
  updateChatRoomSettings,
  uploadRoomAvatar,
  type ChatRoomAttachmentDto,
  type ChatRoomMemberDto,
  type JoinRequestDto
} from '../lib/chat-client';
import { AttachmentImage } from './ChatBubble';
import { Lightbox } from './Lightbox';
import { AgentAvatar } from './AgentAvatar';
import { avatarColorForKey } from '../lib/avatar-color';
import { useBackIntercept, closeOverlayForNavigation } from '../lib/back-intercept';
import { getCachedFriends, invalidateFriendsCache } from '../lib/friends-cache';
import type { FriendListItem } from '../lib/agent-api-client';
import { sendFriendRequest } from '../lib/agent-api-client';
import { assignChatRoomCategory, notifyChatCategoriesChanged, subscribeChatCategoriesChanged, type ChatCategoryDto } from '../lib/agent-api-client';
import { getCachedChatCategories } from '../lib/categories-cache';

// Việc 1 (1/8, gallery-lightbox-swipe) — TÁCH tab "File" cũ thành 2 tab con "Ảnh"/"File" (Admin Demo yêu cầu
// "ảnh sắp xếp theo ngày, hiện mini size như zalo" + "file cũng hiện theo ngày") — CÙNG 1 nguồn dữ liệu
// `attachments` (GET .../attachments, tải lười 1 lần cho CẢ 2 tab, xem effect bên dưới), chỉ chia theo
// `mimeType` (bắt đầu `image/` = Ảnh, còn lại = File).
type InfoTab = 'members' | 'photos' | 'files' | 'filter';
type UiRole = 'OWNER' | 'ADMIN' | 'MEMBER';

// Việc 2 (1/8) — hàm `colorForMember()` riêng của file này đã BỊ XÓA (trùng ý tưởng nhưng công thức tách biệt
// với ContactsScreen.tsx/chat-client.ts, gây avatar cùng 1 agent lệch màu tùy màn — bug Admin Demo báo). Dùng
// thẳng `avatarColorForAgent()` (avatar-color.ts) DÙNG CHUNG toàn app.

function formatDateTime(iso: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** debt-chat-gaps (31/7, Việc 3) — hiển thị `sizeBytes` THẬT (magic-bytes lúc upload) cho tab "File", CÙNG
 * ngưỡng đơn vị `formatFileSize()` (chat-client.ts, không export được — file đó cố ý giữ riêng cho mapping
 * ChatMessage, viết lại tối giản ở đây cho tab File). */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Việc 1 (1/8) — nhãn nhóm theo ngày kiểu Zalo ("Hôm nay"/"Hôm qua"/dd/mm/yyyy), so theo NGÀY LOCAL (không
 * phải UTC/giờ tuyệt đối — 2 ảnh gửi 23h55 và 00h05 khác ngày local phải RƠI 2 NHÓM khác nhau). */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86_400_000);
  if (diffDays === 0) return 'Hôm nay';
  if (diffDays === 1) return 'Hôm qua';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'invalid';
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Nhóm danh sách (ĐÃ sắp `createdAt` desc từ backend, xem listRoomAttachments() chat-message-service.ts —
 * mới nhất trước) thành từng cụm theo ngày, GIỮ NGUYÊN thứ tự mới→cũ cả trong lẫn ngoài nhóm ("mới nhất lên
 * đầu" đúng yêu cầu Admin Demo). Gộp bằng cách so nhóm liền trước (KHÔNG cần Map/sort lại) vì input đã liền kề
 * theo ngày sẵn. */
function groupByDay<T extends { createdAt: string }>(items: T[]): { key: string; label: string; items: T[] }[] {
  const groups: { key: string; label: string; items: T[] }[] = [];
  for (const item of items) {
    const key = dayKey(item.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(item.createdAt), items: [item] });
  }
  return groups;
}

function roleBadge(role: UiRole): JSX.Element | null {
  if (role === 'OWNER') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-semibold text-amber-700">
        <Crown className="h-3 w-3" /> Trưởng nhóm
      </span>
    );
  }
  if (role === 'ADMIN') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-brand-tint px-2 py-0.5 text-[11px] font-semibold text-brand">
        <Shield className="h-3 w-3" /> Phó nhóm
      </span>
    );
  }
  return null;
}

export function GroupInfoPanel({
  room,
  myAgentId,
  messages,
  autoOpenAddMembers,
  onClose,
  onOpenPhoto,
  onOpenRevenue,
  onOpenPinBoard
}: {
  room: ChatRoom;
  /** Lối tắt "Thêm thành viên" từ icon group+ header ConversationScreen (Admin Demo 8/8) — true khi mount thì TỰ mở
   * modal thêm thành viên. Panel unmount mỗi lần đóng nên mỗi lần mở group+ là mount mới → mount-effect chạy lại. */
  autoOpenAddMembers?: boolean;
  /** agentId số của chính người dùng hiện tại (ConversationScreen đã tự gọi fetchAuthenticatedAgent() 1 lần,
   * truyền xuống — KHÔNG tự gọi lại ở đây, tránh 2 nơi cùng fetch danh tính). `null` = chưa tải xong (hiện
   * tạm coi như không phải owner, gate quyền tự nới rộng ngay khi có giá trị thật). */
  myAgentId: number | null;
  /** Tin nhắn ĐÃ TẢI của phòng (ConversationScreen đã có sẵn qua listChatMessages) — tái dùng cho tab "Lọc tin
   * nhắn", KHÔNG gọi lại server (phòng đang mở đã có đủ lịch sử hiển thị trên màn). */
  messages: ChatMessage[];
  onClose: () => void;
  /** Việc 1+2 (1/8, gallery-lightbox-swipe) — bấm 1 ảnh trong lưới tab "Ảnh" → mở lightbox DÙNG CHUNG của
   * ConversationScreen.tsx (KHÔNG viết lightbox riêng ở panel này). Truyền lên TOÀN BỘ danh sách ảnh phòng
   * (`photos`, nguồn `attachments` đã tải — có thể vượt phạm vi `messages` đã tải nếu phòng có lịch sử dài)
   * + id ảnh vừa bấm để ConversationScreen tự dựng danh sách điều hướng trước/sau. `undefined` = bỏ qua click
   * (không nên xảy ra thực tế, panel luôn được ConversationScreen render kèm prop này). */
  onOpenPhoto?: (photos: ChatRoomAttachmentDto[], clickedAttachmentId: string) => void;
  /** "Doanh số theo nhóm chat" (1/8, B100) — mở màn RoomRevenueScreen.tsx. `undefined` = ẩn nút (phòng ngừa
   * call site cũ chưa kịp truyền, không nên xảy ra thực tế vì ConversationScreen.tsx luôn truyền). */
  onOpenRevenue?: () => void;
  /** "BẢNG TIN" / GHIM NHIỀU (5/8) — mở PinBoardPanel (do ConversationScreen sở hữu). `undefined` = ẩn nút
   * (phòng ngừa call site cũ chưa truyền). */
  onOpenPinBoard?: () => void;
}): JSX.Element {
  // Nút back (cứng Android) khi panel MỞ → ĐÓNG panel (lùi đúng 1 bước về phòng chat), KHÔNG lùi route về danh
  // sách (Admin Demo 18/8). Panel chỉ mount khi đang mở nên active=true.
  useBackIntercept(true, onClose);
  const navigate = useNavigate();
  const [tab, setTab] = useState<InfoTab>('members');

  const [members, setMembers] = useState<ChatRoomMemberDto[] | null>(null);
  const [membersError, setMembersError] = useState<string | null>(null);

  // PHÂN LOẠI phòng (Admin Demo 16/8 "nút sửa phân loại trong thông tin nhóm để xóa/đổi phân loại cho mỗi nhóm") —
  // hiện phân loại HIỆN TẠI + đổi/bỏ ngay tại panel. Danh mục = của CHÍNH mình; đổi xong notifyChatCategoriesChanged()
  // → categories-cache tự invalidate + Sidebar/ChatList/CategoryManager đồng bộ (subscribe cùng bus reload).
  const [categories, setCategories] = useState<ChatCategoryDto[]>([]);
  const [catBusy, setCatBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => { const r = await getCachedChatCategories(); if (alive && r.ok) setCategories(r.data); };
    void load();
    const unsub = subscribeChatCategoriesChanged(() => void load());
    return () => { alive = false; unsub(); };
  }, []);
  const currentCategoryId = useMemo(() => categories.find((c) => c.roomIds.includes(room.id))?.id ?? '', [categories, room.id]);
  async function changeRoomCategory(categoryId: string): Promise<void> {
    if (catBusy || categoryId === currentCategoryId) return;
    setCatBusy(true);
    const r = await assignChatRoomCategory(room.id, categoryId || null);
    setCatBusy(false);
    if (r.ok) notifyChatCategoriesChanged(); // cache tự invalidate + subscribe reload (đồng bộ mọi nơi)
  }
  const [membersLoading, setMembersLoading] = useState(true);
  // agentId → tên hiển thị (danh bạ bạn bè, xem chat-client.ts buildAgentNameResolver — CÙNG nguồn ChatListScreen/
  // ConversationScreen dùng, tránh 2 cách tra tên khác nhau trong cùng màn hình chat).
  const [resolveName, setResolveName] = useState<(agentId: number) => string | undefined>(() => () => undefined);

  // B107-tiếp (2/8, Admin Demo: "kết bạn phải như zalo, kết bạn có button trong danh sách thành viên nhóm chat")
  // — nút "Kết bạn" ngay trong danh sách thành viên cho người CHƯA phải bạn bè (và chưa gửi lời mời chờ).
  // `friendAgentIds`/`outgoingAgentIds` từ `getCachedFriends()` (CÙNG cache ContactsScreen.tsx/chat-client.ts
  // đã dùng, không gọi API riêng thêm). `justSentIds` state cục bộ — cập nhật UI ngay lúc bấm mà KHÔNG cần đợi
  // cache tự làm mới (invalidateFriendsCache() gọi kèm nhưng cache mới chỉ có hiệu lực ở LẦN TẢI SAU).
  const [friendAgentIds, setFriendAgentIds] = useState<Set<number>>(new Set());
  const [outgoingAgentIds, setOutgoingAgentIds] = useState<Set<number>>(new Set());
  // #29 (Admin Demo 8/8 "thêm thành viên vào nhóm hiện có, tìm kiếm → tick nhiều → add") — modal chọn bạn bè để thêm.
  const [addOpen, setAddOpen] = useState(false);
  const [addFriends, setAddFriends] = useState<FriendListItem[]>([]);
  const [addSearch, setAddSearch] = useState('');
  const [addSelected, setAddSelected] = useState<Set<number>>(new Set());
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  // BUG 3 (web) — modal "Thêm thành viên" là <div> thô (KHÔNG phải <Modal> tự đăng ký back-handler như
  // Lightbox/ConfirmDialog). Đăng ký riêng để BACK khi modal mở chỉ ĐÓNG MODAL (lùi đúng 1 bước), thay vì đóng
  // CẢ panel. Handler trên cùng (LIFO) → back đóng modal trước panel. Gỡ tự động khi addOpen=false/unmount.
  useBackIntercept(addOpen, () => setAddOpen(false));
  // Lối tắt icon group+ header (Admin Demo 8/8) — mở panel từ group+ (autoOpenAddMembers=true) thì TỰ bật modal thêm
  // thành viên NGAY khi mount (mở từ nút Info thường → false → không bật). Chạy 1 lần/mount ([]).
  useEffect(() => {
    if (autoOpenAddMembers) void openAddMembers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [justSentIds, setJustSentIds] = useState<Set<number>>(new Set());
  const [friendActionBusyId, setFriendActionBusyId] = useState<number | null>(null);
  const [friendActionError, setFriendActionError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getCachedFriends().then((res) => {
      if (cancelled || !res.ok) return;
      setFriendAgentIds(new Set(res.data.friends.map((f) => f.agentId)));
      setOutgoingAgentIds(new Set(res.data.outgoingRequests.map((r) => r.agentId)));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSendFriendRequest(targetAgentId: number): Promise<void> {
    setFriendActionBusyId(targetAgentId);
    setFriendActionError(null);
    const res = await sendFriendRequest(targetAgentId);
    setFriendActionBusyId(null);
    if (!res.ok) {
      setFriendActionError(res.message);
      return;
    }
    invalidateFriendsCache();
    if (res.data.autoAccepted) {
      setFriendAgentIds((prev) => new Set(prev).add(targetAgentId));
    } else {
      setJustSentIds((prev) => new Set(prev).add(targetAgentId));
    }
  }

  const [settingsError, setSettingsError] = useState<string | null>(null);
  // #31 (8/8, Admin Demo "kích hoạt đổi tên nhóm") — sửa tên nhóm inline (server updateGroupSettings name đã có, chỉ
  // thiếu UI). displayName cập nhật local ngay sau lưu (prop `room` do parent giữ, không có callback báo về).
  const [displayName, setDisplayName] = useState(room.name);
  const [nameEditing, setNameEditing] = useState(false);
  const [nameInput, setNameInput] = useState(room.name);
  const [nameBusy, setNameBusy] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [roleActionBusy, setRoleActionBusy] = useState<number | null>(null); // agentId đang xử lý

  // debt-chat-gaps (31/7, Việc 4) — "chỉ trưởng/phó nhóm được gửi tin" (ChatRoom.readOnly). `null` = chưa tải
  // xong giá trị thật (ẩn toggle, tránh hiện sai trạng thái trong khoảnh khắc đầu) — `room` (prop, kiểu UI rút
  // gọn `mock-data/types.ts`) KHÔNG mang field này (chỉ `ChatRoomDetailDto` mới có, xem chat-client.ts), phải
  // tự gọi `getChatRoomDetail()` riêng ở đây.
  const [roomReadOnly, setRoomReadOnly] = useState<boolean | null>(null);
  const [readOnlyBusy, setReadOnlyBusy] = useState(false);
  const [readOnlyError, setReadOnlyError] = useState<string | null>(null);

  // #30 (TẮT THÔNG BÁO NHÓM) — trạng thái tắt thông báo của CHÍNH mình trong nhóm (mutedUntil > now). Đọc từ
  // getChatRoomDetail (member của mình, xem effect bên dưới); toggle qua muteConversation() (best-effort, optimistic).
  const [groupMuted, setGroupMuted] = useState(false);
  const [muteBusy, setMuteBusy] = useState(false);

  // GIẢI TÁN NHÓM (dissolve) — CHỈ trưởng nhóm (OWNER). Xác nhận qua ConfirmDialog rồi gọi dissolveChatRoom →
  // onClose + về danh sách trò chuyện. `dissolveConfirm` mở hộp xác nhận; `dissolveError` hiện lỗi nếu server từ chối.
  const [dissolveConfirm, setDissolveConfirm] = useState(false);
  const [dissolveError, setDissolveError] = useState<string | null>(null);

  // "nhóm chat đầy đủ như Zalo" (5/8) — DUYỆT thành viên (requireApproval) + GIỚI HẠN số (maxMembers) + AVATAR
  // nhóm. Tất cả đọc từ CÙNG `getChatRoomDetail()` đã gọi cho readOnly (KHÔNG thêm round-trip). `null` = chưa
  // tải xong (ẩn control, tránh nháy sai trạng thái ban đầu).
  const [requireApproval, setRequireApproval] = useState<boolean | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);
  const [maxMembers, setMaxMembers] = useState<number | null>(null);
  const [maxMembersInput, setMaxMembersInput] = useState<string>(''); // ô nhập số (rỗng = không giới hạn).
  const [maxMembersBusy, setMaxMembersBusy] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);
  // Avatar nhóm — `avatarVersion` đổi mỗi lần upload thành công để phá cache <img> (URL cố định /avatar).
  // Admin Demo 18/8 — KHỞI TẠO từ `room.hasGroupAvatar` (danh sách phòng ĐÃ biết nhóm có ảnh chưa, map sẵn từ
  // RoomSummaryDto.avatarUrl) → mở panel hiện NGAY AttachmentImage ảnh nhóm, KHÔNG nháy vòng-tròn-chữ-cái ban đầu
  // rồi mới ra ảnh (trước đây init false → luôn chớp placeholder tới khi getChatRoomDetail trả về). getChatRoomDetail
  // vẫn xác nhận/cập nhật lại bên dưới (đúng/mới nhất).
  const [hasAvatar, setHasAvatar] = useState(room.hasGroupAvatar === true);
  const [avatarVersion, setAvatarVersion] = useState(0);
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  // XÁC NHẬN LƯU/HỦY khi đổi ảnh (Admin Demo 17/8: "đổi avatar cần có xác nhận lưu hoặc hủy khi đổi" — trước đây
  // chọn file là UPLOAD NGAY, không xem trước/không xác nhận → dễ tưởng "đổi không được"). Chọn ảnh → giữ ở
  // `pendingAvatarFile` + tạo `pendingAvatarPreview` (object URL cục bộ) để XEM TRƯỚC; chỉ upload khi bấm "Lưu".
  const [pendingAvatarFile, setPendingAvatarFile] = useState<File | null>(null);
  const [pendingAvatarPreview, setPendingAvatarPreview] = useState<string | null>(null);
  // Thu hồi object URL preview khi đổi ảnh khác / đóng panel (chống rò bộ nhớ). Revoke lặp là no-op an toàn.
  useEffect(() => () => { if (pendingAvatarPreview) URL.revokeObjectURL(pendingAvatarPreview); }, [pendingAvatarPreview]);
  // zoom (5/8) — mở avatar nhóm phóng to (Lightbox/ZoomableImage) khi bấm vào ảnh (chỉ khi ĐÃ có ảnh thật).
  const [avatarLightbox, setAvatarLightbox] = useState(false);
  const avatarFileInputRef = useRef<HTMLInputElement>(null);

  // Duyệt thành viên — danh sách yêu cầu ĐANG chờ (OWNER/ADMIN). Tải khi requireApproval bật + là OWNER/ADMIN.
  const [joinRequests, setJoinRequests] = useState<JoinRequestDto[]>([]);
  const [joinRequestsError, setJoinRequestsError] = useState<string | null>(null);
  const [joinActionBusyId, setJoinActionBusyId] = useState<number | null>(null);

  // debt-chat-gaps (31/7, Việc 3) — tab "File" (GET /v1/chat/rooms/:roomId/attachments). Tải LƯỜI (lazy) — CHỈ
  // gọi lần đầu người dùng thật sự bấm vào tab này (xem effect bên dưới), tránh round-trip vô ích cho phòng
  // hiếm khi ai mở tab File.
  const [attachments, setAttachments] = useState<ChatRoomAttachmentDto[] | null>(null);
  const [attachmentsError, setAttachmentsError] = useState<string | null>(null);
  const [attachmentsLoading, setAttachmentsLoading] = useState(false);
  const [attachmentsLoaded, setAttachmentsLoaded] = useState(false);

  // Việc 1 (1/8) — chia `attachments` thành 2 nhóm theo `mimeType`, DÙNG CHUNG cho cả tab "Ảnh" lẫn tab "File"
  // (cùng 1 lần tải, xem effect lazy-load bên dưới).
  const photos = useMemo(() => (attachments ?? []).filter((a) => a.mimeType.startsWith('image/')), [attachments]);
  const files = useMemo(() => (attachments ?? []).filter((a) => !a.mimeType.startsWith('image/')), [attachments]);

  const [filterFrom, setFilterFrom] = useState('');
  const [filterTo, setFilterTo] = useState('');
  const [filterQuery, setFilterQuery] = useState('');

  const canManage = room.isGroup;
  const myMember = members?.find((m) => m.agentId === myAgentId);
  const isOwner = myMember?.role === 'OWNER';
  // debt-chat-gaps (31/7, Việc 4) — gate toggle readOnly CÙNG quyền với server (assertOwnerOrAdmin() trong
  // updateGroupSettings(), chat-room-service.ts) — KHÁC `isOwner` thuần đang dùng cho nút đổi vai trò (quyết
  // định UI riêng của Phase 3, không đụng ở đây).
  const isOwnerOrAdmin = myMember?.role === 'OWNER' || myMember?.role === 'ADMIN';

  useEffect(() => {
    let cancelled = false;
    buildAgentNameResolver().then((fn) => {
      if (!cancelled) setResolveName(() => fn);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Thành viên — tải khi mở panel (luôn cần cho cả xác định isOwner lẫn hiện tab Thành viên mặc định).
  useEffect(() => {
    let cancelled = false;
    setMembersLoading(true);
    setMembersError(null);
    listChatRoomMembers(room.id).then((r) => {
      if (cancelled) return;
      setMembersLoading(false);
      if (r.ok) setMembers(r.data);
      else setMembersError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [room.id]);

  // debt-chat-gaps (31/7, Việc 4) — tải giá trị readOnly THẬT hiện tại của phòng (chỉ có ý nghĩa cho GROUP, xem
  // comment schema.prisma) — `getChatRoomDetail()` KHÔNG throw cho DIRECT, chỉ CHƯA cần gọi (canManage=false).
  useEffect(() => {
    if (!canManage) return;
    let cancelled = false;
    getChatRoomDetail(room.id).then((r) => {
      if (cancelled) return;
      if (r.ok) {
        setRoomReadOnly(r.data.readOnly);
        // "nhóm chat đầy đủ như Zalo" (5/8) — nạp cờ duyệt + trần thành viên + có avatar chưa.
        setRequireApproval(r.data.requireApproval);
        setMaxMembers(r.data.maxMembers);
        setMaxMembersInput(r.data.maxMembers != null ? String(r.data.maxMembers) : '');
        setHasAvatar(r.data.avatarUrl != null);
        // #30 — trạng thái tắt thông báo của CHÍNH mình (member của mình trong detail có mutedUntil).
        const mine = myAgentId != null ? r.data.members.find((m) => m.agentId === myAgentId) : undefined;
        if (mine) setGroupMuted(mine.mutedUntil != null && new Date(mine.mutedUntil).getTime() > Date.now());
      }
    });
    return () => {
      cancelled = true;
    };
  }, [room.id, canManage, myAgentId]);

  // Duyệt thành viên (5/8) — tải danh sách yêu cầu chờ khi DUYỆT đang bật + mình là OWNER/ADMIN. Tải lại mỗi khi
  // `requireApproval` bật lên (vừa tải xong hoặc vừa toggle) — tắt duyệt thì xóa danh sách (không còn ý nghĩa).
  useEffect(() => {
    if (!canManage || !isOwnerOrAdmin || requireApproval !== true) {
      setJoinRequests([]);
      return;
    }
    let cancelled = false;
    setJoinRequestsError(null);
    listRoomJoinRequests(room.id).then((r) => {
      if (cancelled) return;
      if (r.ok) setJoinRequests(r.data);
      else setJoinRequestsError(r.message);
    });
    return () => {
      cancelled = true;
    };
  }, [room.id, canManage, isOwnerOrAdmin, requireApproval]);

  // debt-chat-gaps (31/7, Việc 3) — tab "File" tải LƯỜI, CHỈ 1 LẦN (attachmentsLoaded chặn gọi lại mỗi lần
  // chuyển qua lại giữa các tab). Việc 1 (1/8) — tab "Ảnh" MỚI dùng CHUNG đúng 1 lần tải này (cùng nguồn
  // `attachments`, chỉ khác cách lọc/hiển thị) — bấm sang tab nào trong 2 tab (Ảnh/File) trước cũng kích hoạt
  // tải, tab còn lại dùng lại NGAY, không gọi thêm lần 2.
  useEffect(() => {
    if ((tab !== 'files' && tab !== 'photos') || attachmentsLoaded) return;
    let cancelled = false;
    setAttachmentsLoading(true);
    setAttachmentsError(null);
    // FIX-PERF (4/8) — server ĐÃ phân trang (mặc định 30/trang, xem listChatRoomAttachments). Panel này TRƯỚC
    // đây nhận CẢ danh sách 1 lượt; giữ NGUYÊN hành vi hiển thị "mọi file" bằng cách kéo TỪNG trang (cursor
    // `before`=id tin cũ nhất đã có) tới hết `hasMore`, cap 40 trang (≈4000 file — chặn vòng lặp vô hạn/phòng
    // khổng lồ). Mỗi request giờ dùng partial index (bounded), KHÔNG còn 1 câu quét-lọc toàn bộ tin của phòng.
    (async () => {
      const acc: ChatRoomAttachmentDto[] = [];
      let before: string | undefined;
      for (let page = 0; page < 40; page++) {
        const r = await listChatRoomAttachments(room.id, { before, limit: 100 });
        if (cancelled) return;
        if (!r.ok) {
          setAttachmentsError(r.message);
          break;
        }
        acc.push(...r.data.attachments);
        if (!r.data.hasMore || r.data.attachments.length === 0) break;
        before = r.data.attachments[r.data.attachments.length - 1].messageId;
      }
      if (cancelled) return;
      setAttachmentsLoading(false);
      setAttachmentsLoaded(true);
      setAttachments(acc);
    })();
    return () => {
      cancelled = true;
    };
  }, [tab, room.id, attachmentsLoaded]);

  /** Bật/tắt "chỉ trưởng/phó nhóm được gửi tin" — chỉ gọi được khi ĐÃ biết giá trị hiện tại (`roomReadOnly`
   * khác null, xem effect trên) để đảo đúng chiều, tránh race hiện sai trạng thái lúc chưa tải xong. */
  async function toggleReadOnly(): Promise<void> {
    if (roomReadOnly === null || readOnlyBusy) return;
    setReadOnlyBusy(true);
    setReadOnlyError(null);
    const r = await updateChatRoomSettings(room.id, { readOnly: !roomReadOnly });
    setReadOnlyBusy(false);
    if (!r.ok) {
      setReadOnlyError(r.message);
      return;
    }
    setRoomReadOnly(r.data.readOnly);
  }

  /** Bật/tắt DUYỆT thành viên (requireApproval) — chỉ gọi khi đã biết giá trị hiện tại (tránh đảo sai chiều). */
  async function toggleApproval(): Promise<void> {
    if (requireApproval === null || approvalBusy) return;
    setApprovalBusy(true);
    setSettingsSaveError(null);
    const r = await updateChatRoomSettings(room.id, { requireApproval: !requireApproval });
    setApprovalBusy(false);
    if (!r.ok) {
      setSettingsSaveError(r.message);
      return;
    }
    setRequireApproval(r.data.requireApproval);
  }

  /** Lưu GIỚI HẠN số thành viên. Ô rỗng = bỏ giới hạn (null). Số phải nguyên dương ≥ số thành viên hiện tại
   * (server tự validate lần cuối — ở đây chỉ chặn hình dạng rõ ràng sai để phản hồi nhanh). */
  async function saveMaxMembers(): Promise<void> {
    if (maxMembersBusy) return;
    const trimmed = maxMembersInput.trim();
    let value: number | null;
    if (trimmed === '') {
      value = null;
    } else {
      const n = Number(trimmed);
      if (!Number.isInteger(n) || n <= 0) {
        setSettingsSaveError('Giới hạn thành viên phải là số nguyên dương (hoặc để trống để bỏ giới hạn).');
        return;
      }
      value = n;
    }
    setMaxMembersBusy(true);
    setSettingsSaveError(null);
    const r = await updateChatRoomSettings(room.id, { maxMembers: value });
    setMaxMembersBusy(false);
    if (!r.ok) {
      setSettingsSaveError(r.message);
      return;
    }
    setMaxMembers(r.data.maxMembers);
    setMaxMembersInput(r.data.maxMembers != null ? String(r.data.maxMembers) : '');
  }

  /** Chọn ảnh mới — KHÔNG upload ngay (Admin Demo 17/8). Tạo PREVIEW cục bộ (object URL) để xem trước; chờ bấm
   * "Lưu" (confirmSaveAvatar) hoặc "Hủy" (cancelPendingAvatar). Thu hồi preview cũ nếu chọn đè ảnh khác. */
  function handleAvatarSelected(file: File | undefined): void {
    if (!file || avatarBusy) return;
    setAvatarError(null);
    setPendingAvatarPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setPendingAvatarFile(file);
  }

  /** Bỏ ảnh đang chờ — thu hồi object URL, xóa lỗi. Dùng cho nút "Hủy" và sau khi lưu xong. */
  function cancelPendingAvatar(): void {
    setPendingAvatarFile(null);
    setPendingAvatarPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setAvatarError(null);
  }

  /** LƯU ảnh đang chờ — upload multipart (server sniff magic-bytes, chỉ jpeg/png/webp ≤5MB). Thành công → tăng
   * `avatarVersion` phá cache <img> (URL /avatar cố định) + dọn preview. Lỗi → GIỮ preview để thử lại/hủy. */
  async function confirmSaveAvatar(): Promise<void> {
    if (!pendingAvatarFile || avatarBusy) return;
    setAvatarBusy(true);
    setAvatarError(null);
    const r = await uploadRoomAvatar(room.id, pendingAvatarFile);
    setAvatarBusy(false);
    if (!r.ok) {
      setAvatarError(r.message);
      return;
    }
    setHasAvatar(true);
    setAvatarVersion((v) => v + 1);
    cancelPendingAvatar();
  }

  /** #31 — lưu tên nhóm mới (OWNER/ADMIN). Trim + cap giống server; rỗng/không đổi → hủy sửa. Thành công → cập
   * nhật displayName tại chỗ (mọi máy khác nhận qua realtime settings-updated của ConversationScreen). */
  async function saveName(): Promise<void> {
    const trimmed = nameInput.trim();
    if (!trimmed) {
      setNameError('Tên nhóm không được để trống.');
      return;
    }
    if (trimmed === displayName) {
      setNameEditing(false);
      return;
    }
    setNameBusy(true);
    setNameError(null);
    const r = await updateChatRoomSettings(room.id, { name: trimmed });
    setNameBusy(false);
    if (!r.ok) {
      setNameError(r.message);
      return;
    }
    setDisplayName(trimmed);
    setNameEditing(false);
  }

  /** #32 (Admin Demo "có nút nhắn tin riêng") — mở/ tạo phòng DIRECT với 1 thành viên rồi điều hướng vào (như Zalo).
   * Chỉ hiện cho thành viên ĐÃ là bạn (createOrGetDirectRoom gate canMessageAgent phía server). Đóng panel trước. */
  async function handleMessageMember(agentId: number): Promise<void> {
    setFriendActionBusyId(agentId);
    setFriendActionError(null);
    const r = await createOrGetDirectRoom(agentId);
    setFriendActionBusyId(null);
    if (!r.ok) {
      setFriendActionError(r.message);
      return;
    }
    closeOverlayForNavigation(); // BUG 1 (web): đóng-để-điều-hướng → cleanup panel KHÔNG history.back (giữ route mới).
    onClose();
    navigate(ROUTES.chatRoom(r.data.id));
  }

  /** CLICK MEMBER → XEM PROFILE — bấm avatar/tên 1 thành viên → mở trang cá nhân (nhật ký) của họ, CÙNG route
   * ROUTES.diaryOf(agentId) mà ContactsScreen dùng cho "xem hồ sơ" (bot-api tự chặn NOT_VISIBLE nếu không phải
   * bạn/của mình). KHÔNG dựng modal profile riêng (chưa có component tái dùng gọn) — điều hướng nhẹ, đóng panel
   * trước. Bấm CHÍNH mình → mở hồ sơ của mình (ROUTES.profile). */
  function openMemberProfile(agentId: number): void {
    closeOverlayForNavigation(); // BUG 1 (web): đóng-để-điều-hướng → cleanup panel KHÔNG history.back (giữ route mới).
    onClose();
    navigate(agentId === myAgentId ? ROUTES.profile : ROUTES.diaryOf(agentId));
  }

  /** #29 — mở modal thêm thành viên: nạp danh sách bạn bè (cache dùng chung). */
  async function openAddMembers(): Promise<void> {
    setAddOpen(true);
    setAddSearch('');
    setAddSelected(new Set());
    setAddError(null);
    const res = await getCachedFriends();
    if (res.ok) setAddFriends(res.data.friends);
  }
  function toggleAddSelect(agentId: number): void {
    setAddSelected((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }
  /** #29 — thêm CÁC thành viên đã tick vào nhóm (addMember từng người, server gate OWNER/ADMIN + bạn bè + trần).
   * Xong nạp lại danh sách thành viên. Có ai lỗi → hiện lỗi, GIỮ modal để thử lại; tất cả OK → đóng. */
  async function submitAddMembers(): Promise<void> {
    const ids = [...addSelected];
    if (ids.length === 0 || addBusy) return;
    setAddBusy(true);
    setAddError(null);
    const results = await Promise.all(ids.map((id) => addChatRoomMember(room.id, id)));
    const failed = results.filter((r) => !r.ok);
    const mr = await listChatRoomMembers(room.id);
    if (mr.ok) setMembers(mr.data);
    setAddBusy(false);
    if (failed.length > 0) {
      const first = failed[0];
      setAddError(`Thêm ${failed.length}/${ids.length} người thất bại${!first.ok ? `: ${first.message}` : ''}.`);
      setAddSelected(new Set()); // đã nạp lại members; bỏ chọn để tránh thêm trùng.
      return;
    }
    setAddOpen(false);
  }

  /** #33 (Admin Demo "chỉ trưởng phó mới được xóa mem") — kick 1 thành viên khỏi nhóm (server removeMember gate
   * OWNER/ADMIN + phát tin hệ thống "X đã xóa Y"). Xong nạp lại danh sách thành viên. */
  async function handleKickMember(agentId: number): Promise<void> {
    if (roleActionBusy != null) return;
    setRoleActionBusy(agentId);
    setSettingsError(null);
    const r = await removeChatRoomMember(room.id, agentId);
    if (!r.ok) {
      setSettingsError(r.message);
      setRoleActionBusy(null);
      return;
    }
    const mr = await listChatRoomMembers(room.id);
    if (mr.ok) setMembers(mr.data);
    setRoleActionBusy(null);
  }

  /** #33 (Admin Demo "kiểm tra tính năng rời khỏi nhóm của mem") — TỰ rời nhóm: removeMember với chính mình. Server
   * phát tin hệ thống "X đã rời nhóm" + chặn OWNER rời khi chưa nhường quyền (hiện lỗi). Rời xong → đóng panel +
   * về danh sách trò chuyện (không còn là thành viên nên không xem phòng nữa). */
  const [leaveBusy, setLeaveBusy] = useState(false);
  async function handleLeaveGroup(): Promise<void> {
    if (myAgentId == null || leaveBusy) return;
    setLeaveBusy(true);
    setSettingsError(null);
    const r = await removeChatRoomMember(room.id, myAgentId);
    setLeaveBusy(false);
    if (!r.ok) {
      setSettingsError(r.message); // vd OWNER phải nhường quyền trước.
      return;
    }
    closeOverlayForNavigation(); // BUG 1 (web): đóng-để-điều-hướng → cleanup panel KHÔNG history.back (giữ route mới).
    onClose();
    navigate(ROUTES.chat);
  }

  /** #30 (TẮT THÔNG BÁO NHÓM) — bật/tắt tắt thông báo nhóm cho CHÍNH mình. Optimistic (đổi UI ngay); best-effort
   * — server lỗi thì trả lại trạng thái cũ (không chặn thao tác khác). muteConversation() đã có sẵn. */
  async function toggleGroupMute(): Promise<void> {
    if (muteBusy) return;
    const next = !groupMuted;
    setGroupMuted(next); // optimistic
    setMuteBusy(true);
    const r = await muteConversation(room.id, next);
    setMuteBusy(false);
    if (!r.ok) setGroupMuted(!next); // hoàn tác nếu server từ chối.
  }

  /** GIẢI TÁN NHÓM (dissolve) — CHỈ trưởng nhóm. Đã xác nhận qua ConfirmDialog → gọi dissolveChatRoom. Thành công
   * → đóng panel + về danh sách trò chuyện (phòng đã bị xóa mềm, không còn quyền vào; các máy khác nhận
   * room-dissolved tự rời). Lỗi → hiện trong hộp xác nhận, GIỮ hộp để đọc. */
  async function handleDissolveGroup(): Promise<void> {
    setDissolveError(null);
    const r = await dissolveChatRoom(room.id);
    if (!r.ok) {
      setDissolveError(r.message);
      return;
    }
    setDissolveConfirm(false);
    closeOverlayForNavigation(); // BUG 1 (web): đóng-để-điều-hướng → cleanup panel KHÔNG history.back (giữ route mới).
    onClose();
    navigate(ROUTES.chat);
  }

  /** Duyệt/từ chối 1 yêu cầu vào nhóm. Thành công → bỏ khỏi danh sách chờ tại chỗ (server cũng phát realtime cho
   * ConversationScreen của các máy khác). */
  async function decideJoinRequest(agentId: number, action: 'approve' | 'reject'): Promise<void> {
    setJoinActionBusyId(agentId);
    setJoinRequestsError(null);
    const r = action === 'approve' ? await approveRoomJoinRequest(room.id, agentId) : await rejectRoomJoinRequest(room.id, agentId);
    setJoinActionBusyId(null);
    if (!r.ok) {
      setJoinRequestsError(r.message);
      return;
    }
    setJoinRequests((prev) => prev.filter((jr) => jr.agentId !== agentId));
    // Duyệt xong → thành viên mới xuất hiện; tải lại danh sách thành viên (đơn giản/an toàn hơn tự chèn).
    if (action === 'approve') {
      listChatRoomMembers(room.id).then((refreshed) => {
        if (refreshed.ok) setMembers(refreshed.data);
      });
    }
  }

  const filteredMessages = useMemo(() => {
    const fromMs = filterFrom ? new Date(`${filterFrom}T00:00:00`).getTime() : null;
    const toMs = filterTo ? new Date(`${filterTo}T23:59:59.999`).getTime() : null;
    return messages
      .filter((m) => m.type !== 'system')
      .filter((m) => {
        if (fromMs !== null || toMs !== null) {
          if (!m.sentAtIso) return false;
          const ts = new Date(m.sentAtIso).getTime();
          if (fromMs !== null && ts < fromMs) return false;
          if (toMs !== null && ts > toMs) return false;
        }
        return true;
      })
      .filter((m) => smartIncludes(m.text, filterQuery) || smartIncludes(m.senderName, filterQuery));
  }, [messages, filterFrom, filterTo, filterQuery]);

  /** Đổi vai trò 1 thành viên. `role==='OWNER'` = CHUYỂN NHƯỢNG chủ phòng (chỉ hiện nút này khi target CHƯA
   * là OWNER — xem JSX, không có "gỡ Trưởng nhóm" đứng một mình vì ngữ nghĩa hệ mới không cho phép phòng
   * không có OWNER). `role==='ADMIN'|'MEMBER'` = bật/tắt Phó nhóm bình thường (CÙNG hành vi cũ). */
  async function changeRole(member: ChatRoomMemberDto, role: UiRole): Promise<void> {
    setRoleActionBusy(member.agentId);
    setSettingsError(null);
    const r = await changeChatRoomMemberRole(room.id, member.agentId, role);
    setRoleActionBusy(null);
    if (!r.ok) {
      setSettingsError(r.message);
      return;
    }
    // Chuyển nhượng OWNER làm requester (chính mình, nếu đang là OWNER) tự động hạ xuống ADMIN — cập nhật LẠI
    // TOÀN BỘ danh sách theo response (đơn giản/an toàn hơn tự suy luận local, vì service có thể đổi CẢ 2 hàng
    // trong 1 lượt — xem changeMemberRole() chat-room-service.ts).
    listChatRoomMembers(room.id).then((refreshed) => {
      if (refreshed.ok) setMembers(refreshed.data);
    });
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-slate-900/30" onClick={onClose}>
      <div className="flex h-full w-full max-w-sm flex-col border-l border-line bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-line px-4 py-3.5">
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Thông tin {room.isGroup ? 'nhóm' : 'hội thoại'}</h3>
            <p className="truncate text-xs text-slate-500">{displayName}</p>
          </div>
          <button onClick={onClose} className="rounded p-1.5 text-slate-400 hover:bg-appbg hover:text-slate-600">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* AVATAR NHÓM + số thành viên + Bảng tin (5/8) — CHỈ phòng GROUP. Avatar THẬT nếu đã đặt (roomAvatarUrl,
            phá cache qua avatarVersion), ngược lại vòng tròn màu brand với chữ cái đầu. OWNER/ADMIN đổi ảnh qua
            nút Camera. */}
        {/* Avatar + tên + số thành viên — hiện cho MỌI thành viên nhóm (canManage = room.isGroup). Nút Camera đổi
            ảnh gated isOwnerOrAdmin bên trong. Ảnh nay tải qua AttachmentImage (blob CSRF) nên XEM được. */}
        {canManage && (
          <div className="flex items-center gap-3 border-b border-line px-4 py-3">
            {/* h-14 w-14 CỐ ĐỊNH (Admin Demo 21/8 "avatar to một nhịp rồi thu nhỏ") — chặn layout-shift: trước đây
                container không ép cỡ, placeholder loading mặc định của AttachmentImage (h-40 w-52 = 160×208) phình
                ra rồi ảnh thật (56×56) co lại. Ép cỡ container + truyền loadingClassName/failedClassName 56px. */}
            <div className="relative h-14 w-14 shrink-0">
              {pendingAvatarPreview ? (
                // XEM TRƯỚC ảnh MỚI CHỌN (cục bộ, chưa upload) — vòng brand để phân biệt trạng thái "đang chờ Lưu".
                <img
                  src={pendingAvatarPreview}
                  alt="Ảnh nhóm mới chọn"
                  className="h-14 w-14 rounded-full object-cover ring-2 ring-brand"
                />
              ) : hasAvatar ? (
                // #31/#32 (8/8, Admin Demo "đặt avatar chưa dùng được, phải XEM được ảnh") — GỐC: <img src> THÔ tới
                // endpoint avatar (đòi header CSRF) → 403, ảnh không tải. Dùng AttachmentImage (tự fetch blob có
                // credentials+CSRF, CÙNG cơ chế ảnh tin nhắn). Ảnh do SERVER lưu → ĐỒNG NHẤT mọi user.
                <AttachmentImage
                  url={roomAvatarUrl(room.id, avatarVersion)}
                  alt={room.name}
                  onClick={() => setAvatarLightbox(true)}
                  className="h-14 w-14 cursor-pointer rounded-full object-cover"
                  loadingClassName="h-14 w-14 animate-pulse rounded-full bg-slate-200"
                  failedClassName="flex h-14 w-14 items-center justify-center rounded-full bg-slate-200 text-[10px] text-slate-500"
                />
              ) : (
                <div
                  className="flex h-14 w-14 items-center justify-center rounded-full text-xl font-semibold text-white"
                  // Item 7 (6/8) — avatar NHÓM (không đại diện 1 người) → NGUỒN DUY NHẤT avatarColorForKey(room.id),
                  // thay `room.avatarColor` (màu server theo room, không xác định). Thành viên nhóm đã dùng AgentAvatar.
                  style={{ backgroundColor: avatarColorForKey(room.id) }}
                >
                  {room.name[0]?.toUpperCase() ?? '?'}
                </div>
              )}
              {isOwnerOrAdmin && (
                <>
                  {pendingAvatarPreview ? (
                    // ĐANG CHỜ XÁC NHẬN — nút LƯU (Check, xanh, góc phải-dưới) + HỦY (X, đỏ, góc trái-dưới) thay
                    // cho nút Camera. Upload chỉ chạy khi bấm "Lưu" (Admin Demo 17/8: "cần có xác nhận lưu hoặc hủy").
                    <>
                      <button
                        type="button"
                        data-testid="save-group-avatar"
                        disabled={avatarBusy}
                        onClick={() => void confirmSaveAvatar()}
                        title="Lưu ảnh nhóm"
                        aria-label="Lưu ảnh nhóm"
                        className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-emerald-500 text-white shadow disabled:opacity-50"
                      >
                        {avatarBusy ? <DotsLoader size="sm" color="white" /> : <Check className="h-3.5 w-3.5" />}
                      </button>
                      <button
                        type="button"
                        data-testid="cancel-group-avatar"
                        disabled={avatarBusy}
                        onClick={cancelPendingAvatar}
                        title="Hủy đổi ảnh"
                        aria-label="Hủy đổi ảnh"
                        className="absolute -bottom-0.5 -left-0.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-rose-500 text-white shadow disabled:opacity-50"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      data-testid="change-group-avatar"
                      disabled={avatarBusy}
                      onClick={() => avatarFileInputRef.current?.click()}
                      title="Đổi ảnh nhóm"
                      aria-label="Đổi ảnh nhóm"
                      className="absolute -bottom-0.5 -right-0.5 flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-brand text-white shadow disabled:opacity-50"
                    >
                      {avatarBusy ? <DotsLoader size="sm" color="white" /> : <Camera className="h-3 w-3" />}
                    </button>
                  )}
                  <input
                    ref={avatarFileInputRef}
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      handleAvatarSelected(e.target.files?.[0]);
                      e.target.value = ''; // cho phép chọn lại CÙNG file lần sau.
                    }}
                  />
                </>
              )}
            </div>
            <div className="min-w-0 flex-1">
              {/* #31 — đổi tên nhóm inline. OWNER/ADMIN thấy bút; bấm → ô nhập + Lưu/Hủy. */}
              {nameEditing ? (
                <div className="flex items-center gap-1.5">
                  <input
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveName();
                      if (e.key === 'Escape') {
                        setNameEditing(false);
                        setNameInput(displayName);
                      }
                    }}
                    disabled={nameBusy}
                    autoFocus
                    maxLength={100}
                    aria-label="Tên nhóm"
                    className="min-w-0 flex-1 rounded border border-line bg-white px-2 py-1 text-sm font-semibold text-slate-800 outline-none focus:border-brand"
                  />
                  <button onClick={() => void saveName()} disabled={nameBusy} aria-label="Lưu tên" title="Lưu" className="shrink-0 rounded-full p-1 text-brand hover:bg-brand-tint disabled:opacity-50">
                    {nameBusy ? <DotsLoader size="sm" /> : <Check className="h-4 w-4" />}
                  </button>
                  <button onClick={() => { setNameEditing(false); setNameInput(displayName); setNameError(null); }} disabled={nameBusy} aria-label="Hủy" title="Hủy" className="shrink-0 rounded-full p-1 text-slate-400 hover:bg-appbg disabled:opacity-50">
                    <X className="h-4 w-4" />
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-sm font-semibold text-slate-800">{displayName}</p>
                  {isOwnerOrAdmin && (
                    <button
                      onClick={() => { setNameInput(displayName); setNameEditing(true); setNameError(null); }}
                      aria-label="Đổi tên nhóm"
                      title="Đổi tên nhóm"
                      className="shrink-0 rounded-full p-1 text-slate-400 hover:bg-appbg hover:text-brand"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              )}
              {nameError && <p className="mt-0.5 text-[11px] text-danger">{nameError}</p>}
              <p className="text-xs text-slate-500">
                {members ? members.length : '—'}
                {maxMembers != null ? `/${maxMembers}` : ''} thành viên
              </p>
              {avatarError && <p className="mt-0.5 text-[11px] text-danger">{avatarError}</p>}
              {pendingAvatarPreview && !avatarError && (
                <p className="mt-0.5 text-[11px] text-brand">Ảnh mới đã chọn — bấm ✓ để Lưu hoặc ✕ để Hủy.</p>
              )}
            </div>
          </div>
        )}
        {/* zoom (5/8) — Lightbox avatar nhóm phóng to (ZoomableImage). Chỉ mở khi CÓ ảnh thật. */}
        {avatarLightbox && hasAvatar && (
          <Lightbox title="Ảnh nhóm" onClose={() => setAvatarLightbox(false)}>
            {/* dùng children (AttachmentImage) thay src thô để phóng to cũng qua blob CSRF-safe (Lightbox hỗ trợ). */}
            <AttachmentImage url={roomAvatarUrl(room.id, avatarVersion)} alt={room.name} className="max-h-[85vh] max-w-[90vw] object-contain" />
          </Lightbox>
        )}
        {/* #29 — MODAL thêm thành viên: tìm kiếm bạn bè (chưa ở trong nhóm) + tick NHIỀU + Thêm(N). */}
        {addOpen && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4" onClick={() => !addBusy && setAddOpen(false)}>
            <div className="flex max-h-[80vh] w-full max-w-sm flex-col overflow-hidden rounded-lg-mac bg-white shadow-card" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <span className="text-sm font-semibold text-slate-800">Thêm thành viên</span>
                <button onClick={() => setAddOpen(false)} disabled={addBusy} aria-label="Đóng" className="text-slate-400 hover:text-slate-600 disabled:opacity-50">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="border-b border-line px-4 py-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    value={addSearch}
                    onChange={(e) => setAddSearch(e.target.value)}
                    placeholder="Tìm bạn bè..."
                    aria-label="Tìm bạn bè để thêm"
                    className="w-full rounded-lg-mac border border-line bg-appbg py-2 pl-9 pr-3 text-sm outline-none focus:border-brand"
                  />
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-2 py-2">
                {(() => {
                  const memberIdSet = new Set((members ?? []).map((m) => m.agentId));
                  const candidates = addFriends.filter((f) => !memberIdSet.has(f.agentId) && smartIncludes(f.agentName, addSearch));
                  if (candidates.length === 0) {
                    return <p className="py-6 text-center text-xs text-slate-400">Không có bạn bè phù hợp để thêm.</p>;
                  }
                  return candidates.map((f) => (
                    <button key={f.agentId} onClick={() => toggleAddSelect(f.agentId)} className="flex w-full items-center gap-3 rounded-lg-mac px-2 py-2 text-left hover:bg-appbg">
                      <AgentAvatar agentId={f.agentId} name={f.agentName} size={36} />
                      <span className="min-w-0 flex-1 truncate text-sm text-slate-800">{f.agentName}</span>
                      <span className={'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border ' + (addSelected.has(f.agentId) ? 'border-brand bg-brand text-white' : 'border-line')}>
                        {addSelected.has(f.agentId) && <Check className="h-3.5 w-3.5" />}
                      </span>
                    </button>
                  ));
                })()}
              </div>
              {addError && <p className="px-4 py-1 text-[11px] text-danger">{addError}</p>}
              <div className="flex gap-2 border-t border-line px-4 py-3">
                <button onClick={() => setAddOpen(false)} disabled={addBusy} className="btn-soft flex-1 rounded-lg-mac py-2 text-sm disabled:opacity-50">Hủy</button>
                <button
                  onClick={() => void submitAddMembers()}
                  disabled={addBusy || addSelected.size === 0}
                  className="btn-primary flex-1 rounded-lg-mac py-2 text-sm font-medium text-white disabled:opacity-50"
                >
                  {addBusy ? <DotsLoader size="sm" color="white" /> : `Thêm (${addSelected.size})`}
                </button>
              </div>
            </div>
          </div>
        )}
        {/* Bảng tin (5/8) — mở PinBoardPanel (do ConversationScreen sở hữu). Hiện cho mọi thành viên. */}
        {onOpenPinBoard && (
          <button
            data-testid="open-pin-board-from-info"
            onClick={onOpenPinBoard}
            className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm font-semibold text-brand hover:bg-brand-tint"
          >
            <Pin className="h-4 w-4" /> Bảng tin
          </button>
        )}

        {/* "Doanh số theo nhóm chat" (1/8, B100) — nút riêng NGAY DƯỚI header, TRƯỚC tab bar (không nhét thành
            tab thứ 5 — màn đích cần nhiều không gian dọc cho biểu đồ/bảng, xứng đáng 1 màn riêng thay vì tab
            con chật trong panel trượt này, CÙNG lý do "Bán TID"/"Đối soát" cũng là màn/modal riêng, không phải
            tab). */}
        {onOpenRevenue && (
          <button
            onClick={onOpenRevenue}
            className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-sm font-semibold text-brand hover:bg-brand-tint"
          >
            <BarChart3 className="h-4 w-4" /> Doanh số
          </button>
        )}

        <div className="flex border-b border-line text-sm">
          <button
            data-testid="info-tab-members"
            onClick={() => setTab('members')}
            className={'flex flex-1 items-center justify-center gap-1.5 py-2.5 font-medium ' + (tab === 'members' ? 'border-b-2 border-brand text-brand' : 'text-slate-500 hover:text-slate-700')}
          >
            <Users className="h-4 w-4" /> Thành viên
          </button>
          <button
            data-testid="info-tab-photos"
            onClick={() => setTab('photos')}
            className={'flex flex-1 items-center justify-center gap-1.5 py-2.5 font-medium ' + (tab === 'photos' ? 'border-b-2 border-brand text-brand' : 'text-slate-500 hover:text-slate-700')}
          >
            <ImageIcon className="h-4 w-4" /> Ảnh
          </button>
          <button
            data-testid="info-tab-files"
            onClick={() => setTab('files')}
            className={'flex flex-1 items-center justify-center gap-1.5 py-2.5 font-medium ' + (tab === 'files' ? 'border-b-2 border-brand text-brand' : 'text-slate-500 hover:text-slate-700')}
          >
            <FileText className="h-4 w-4" /> File
          </button>
          <button
            data-testid="info-tab-filter"
            onClick={() => setTab('filter')}
            className={'flex flex-1 items-center justify-center gap-1.5 py-2.5 font-medium ' + (tab === 'filter' ? 'border-b-2 border-brand text-brand' : 'text-slate-500 hover:text-slate-700')}
          >
            <Search className="h-4 w-4" /> Lọc tin
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {tab === 'members' && (
            <div className="p-4">
              {/* #29 — nút "Thêm thành viên" cho MỌI thành viên (Admin Demo "ai cũng thêm được") mở modal chọn bạn bè. */}
              {canManage && (
                <button
                  onClick={() => void openAddMembers()}
                  className="btn-primary mb-3 flex w-full items-center justify-center gap-2 rounded-lg-mac px-3 py-2.5 text-sm font-medium text-white"
                >
                  <UserPlus className="h-4 w-4" /> Thêm thành viên
                </button>
              )}
              {/* #30 (TẮT THÔNG BÁO NHÓM) — hàng toggle cho MỌI thành viên (không chỉ OWNER/ADMIN): tắt/bật thông
                  báo nhóm của CHÍNH mình (mutedUntil per-agent). Dùng Switch chung + muteConversation() đã có. */}
              {canManage && (
                <div className="mb-3 flex items-center justify-between gap-3 rounded-lg-mac border border-line px-3 py-2.5">
                  <div className="flex min-w-0 items-center gap-2">
                    <BellOff className="h-4 w-4 shrink-0 text-slate-400" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-700">Tắt thông báo nhóm</p>
                      <p className="text-[11px] text-slate-400">Không báo chuông/đẩy tin mới của nhóm này (chỉ mình bạn).</p>
                    </div>
                  </div>
                  <Switch
                    testId="toggle-group-mute"
                    on={groupMuted}
                    disabled={muteBusy}
                    onChange={() => void toggleGroupMute()}
                  />
                </div>
              )}
              {/* PHÂN LOẠI phòng (Admin Demo 16/8) — đổi/bỏ phân loại NGAY tại đây (tiện hơn mở trình quản lý). */}
              <div className="mb-3 flex items-center justify-between gap-3 rounded-lg-mac border border-line px-3 py-2.5">
                <div className="flex min-w-0 items-center gap-2">
                  <Pencil className="h-4 w-4 shrink-0 text-slate-400" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-700">Phân loại</p>
                    <p className="text-[11px] text-slate-400">Xếp {room.isGroup ? 'nhóm' : 'hội thoại'} này vào một phân loại (chỉ mình bạn thấy) — chọn để đổi hoặc bỏ.</p>
                  </div>
                </div>
                <select
                  data-testid="room-category-select"
                  value={currentCategoryId}
                  disabled={catBusy}
                  onChange={(e) => void changeRoomCategory(e.target.value)}
                  className="max-w-[45%] shrink-0 rounded-lg border border-line bg-white px-2 py-1.5 text-sm text-slate-700 disabled:opacity-50"
                >
                  <option value="">Không phân loại</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
              {/* debt-chat-gaps (31/7, Việc 4) — "Chỉ Trưởng/Phó được gửi tin" (ChatRoom.readOnly). Chỉ hiện
                  cho OWNER/ADMIN (CÙNG gate assertOwnerOrAdmin() phía server) + phòng GROUP + ĐÃ tải xong giá
                  trị thật (roomReadOnly !== null, xem effect getChatRoomDetail() ở trên) — tránh nháy sai
                  trạng thái trong khoảnh khắc đầu. */}
              {canManage && isOwnerOrAdmin && roomReadOnly !== null && (
                <div className="mb-3 flex items-center justify-between gap-3 rounded-lg-mac border border-line px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-700">Chỉ trưởng/phó nhóm được gửi tin</p>
                    <p className="text-[11px] text-slate-400">Thành viên thường chỉ xem, không gửi được tin nhắn mới.</p>
                  </div>
                  {/* 5/8 (Admin Demo "toggle bật/tắt vẫn cũ") — nút gạt CHUNG <Switch> (toggle-3d, bật = gradient
                      brand) thay toggle viết tay bg-brand/bg-slate-300 → đồng nhất mọi toggle toàn app. */}
                  <Switch
                    testId="toggle-read-only"
                    on={roomReadOnly === true}
                    disabled={readOnlyBusy}
                    onChange={() => void toggleReadOnly()}
                  />
                </div>
              )}
              {readOnlyError && <p className="mb-2 text-xs text-danger">{readOnlyError}</p>}

              {/* DUYỆT thành viên + GIỚI HẠN số (5/8) — CHỈ OWNER/ADMIN + phòng GROUP + ĐÃ tải xong cài đặt. */}
              {canManage && isOwnerOrAdmin && requireApproval !== null && (
                <div className="mb-3 space-y-3 rounded-lg-mac border border-line px-3 py-2.5">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-700">Duyệt thành viên mới</p>
                      <p className="text-[11px] text-slate-400">Người xin vào phải được trưởng/phó nhóm duyệt.</p>
                    </div>
                    <Switch
                      testId="toggle-require-approval"
                      on={requireApproval === true}
                      disabled={approvalBusy}
                      onChange={() => void toggleApproval()}
                    />
                  </div>
                  <div className="flex items-center justify-between gap-3 border-t border-line pt-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-700">Giới hạn thành viên</p>
                      <p className="text-[11px] text-slate-400">Để trống = không giới hạn.</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <input
                        type="number"
                        min={1}
                        data-testid="max-members-input"
                        value={maxMembersInput}
                        onChange={(e) => setMaxMembersInput(e.target.value)}
                        placeholder="∞"
                        className="w-16 rounded-md border border-line px-2 py-1 text-sm outline-none focus:border-brand"
                      />
                      <button
                        type="button"
                        data-testid="save-max-members"
                        disabled={maxMembersBusy}
                        onClick={() => void saveMaxMembers()}
                        className="btn-primary rounded-full px-3 py-1 text-xs text-white disabled:opacity-50"
                      >
                        {maxMembersBusy ? <DotsLoader size="sm" /> : 'Lưu'}
                      </button>
                    </div>
                  </div>
                  {settingsSaveError && <p className="text-[11px] text-danger">{settingsSaveError}</p>}
                </div>
              )}

              {/* DANH SÁCH XIN VÀO (5/8) — CHỈ khi DUYỆT bật + OWNER/ADMIN. Duyệt/Từ chối từng người. */}
              {canManage && isOwnerOrAdmin && requireApproval === true && (
                <div className="mb-3">
                  <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-slate-500">
                    <UserCheck className="h-3.5 w-3.5" /> Yêu cầu vào nhóm ({joinRequests.length})
                  </p>
                  {joinRequestsError && <p className="mb-1 text-[11px] text-danger">{joinRequestsError}</p>}
                  {joinRequests.length === 0 ? (
                    <p className="rounded-lg-mac border border-dashed border-line px-3 py-2 text-center text-[11px] text-slate-400">
                      Không có yêu cầu nào đang chờ.
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {joinRequests.map((jr) => {
                        const name = resolveName(jr.agentId) ?? `Đại lý #${jr.agentId}`;
                        return (
                          <li key={jr.id} className="flex items-center gap-2 rounded-lg-mac border border-line px-2 py-1.5">
                            <AgentAvatar agentId={jr.agentId} name={name} size={32} textClassName="text-xs" />
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-700">{name}</span>
                            <button
                              type="button"
                              data-testid={`approve-join-${jr.agentId}`}
                              disabled={joinActionBusyId === jr.agentId}
                              onClick={() => void decideJoinRequest(jr.agentId, 'approve')}
                              title="Duyệt"
                              aria-label="Duyệt"
                              className="shrink-0 rounded-full p-1.5 text-brand hover:bg-brand-tint disabled:opacity-50"
                            >
                              {joinActionBusyId === jr.agentId ? <DotsLoader size="sm" /> : <Check className="h-4 w-4" />}
                            </button>
                            <button
                              type="button"
                              data-testid={`reject-join-${jr.agentId}`}
                              disabled={joinActionBusyId === jr.agentId}
                              onClick={() => void decideJoinRequest(jr.agentId, 'reject')}
                              title="Từ chối"
                              aria-label="Từ chối"
                              className="shrink-0 rounded-full p-1.5 text-slate-400 hover:bg-danger/5 hover:text-danger disabled:opacity-50"
                            >
                              <UserX className="h-4 w-4" />
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              )}

              {membersLoading && (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
                  <DotsLoader /> Đang tải danh sách thành viên...
                </div>
              )}
              {membersError && <p className="py-4 text-center text-sm text-danger">{membersError}</p>}
              {settingsError && <p className="py-2 text-center text-sm text-danger">{settingsError}</p>}
              {friendActionError && <p className="py-2 text-center text-sm text-danger">{friendActionError}</p>}
              {members && (
                <ul className="space-y-1">
                  {members.map((m) => {
                    // #32 — TÊN THẬT từ server (m.name, đồng nhất mọi user) ưu tiên; resolveName/fallback chỉ dự phòng.
                    const displayName = m.name ?? resolveName(m.agentId) ?? `Người dùng #${m.agentId}`;
                    const isMe = m.agentId === myAgentId;
                    return (
                      <li key={m.agentId} className="flex items-center gap-3 rounded-lg-mac px-2 py-2 hover:bg-appbg">
                        {/* CLICK MEMBER → XEM PROFILE — avatar + tên bấm được, mở trang cá nhân (openMemberProfile).
                            Bọc trong 1 <button> flex-1 để KHÔNG đụng các nút hành động (Kết bạn/Nhắn tin/Kick) bên phải. */}
                        <button
                          type="button"
                          data-testid={`member-profile-${m.agentId}`}
                          onClick={() => openMemberProfile(m.agentId)}
                          title={`Xem trang cá nhân của ${displayName}`}
                          className="flex min-w-0 flex-1 items-center gap-3 rounded-lg-mac text-left"
                        >
                          <AgentAvatar agentId={m.agentId} name={displayName} size={36} />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-1.5">
                              <span className="truncate text-sm font-medium text-slate-800">{displayName}</span>
                              {isMe && <span className="text-[11px] text-slate-400">(Bạn)</span>}
                            </div>
                            <div className="flex items-center gap-1.5">{roleBadge(m.role)}</div>
                          </div>
                        </button>
                        {/* GÓI HÀNH ĐỘNG (Admin Demo 18/8, ảnh THẬT: nút "Xóa" bị cắt mép phải màn nhỏ) — bọc MỌI nút
                            thao tác vào 1 cụm flex-wrap justify-end: màn hẹp thì tự XUỐNG DÒNG thay vì tràn ngang.
                            min-w-0 để cụm co được, nhường chỗ tên (flex-1) truncate. */}
                        <div className="flex min-w-0 flex-wrap items-center justify-end gap-1">
                        {/* B107-tiếp (2/8) — nút "Kết bạn" kiểu Zalo ngay trong danh sách thành viên, cho
                            người CHƯA phải bạn bè (bất kỳ thành viên nào cũng thấy được, KHÔNG giới hạn
                            OWNER — khác khối đổi vai trò bên dưới). */}
                        {!isMe && !friendAgentIds.has(m.agentId) && (
                          <div className="shrink-0">
                            {outgoingAgentIds.has(m.agentId) || justSentIds.has(m.agentId) ? (
                              <span className="text-[11px] text-slate-400">Đã gửi lời mời</span>
                            ) : (
                              <button
                                disabled={friendActionBusyId === m.agentId}
                                onClick={() => void handleSendFriendRequest(m.agentId)}
                                title="Kết bạn"
                                className="btn-primary flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-white disabled:opacity-50"
                              >
                                {friendActionBusyId === m.agentId ? <DotsLoader size="sm" color="white" /> : <UserPlus className="h-3 w-3" />} Kết bạn
                              </button>
                            )}
                          </div>
                        )}
                        {/* #32 (Admin Demo "có nút nhắn tin riêng") — thành viên ĐÃ là bạn → nút Nhắn tin mở DM. */}
                        {!isMe && friendAgentIds.has(m.agentId) && (
                          <button
                            disabled={friendActionBusyId === m.agentId}
                            onClick={() => void handleMessageMember(m.agentId)}
                            title={`Nhắn tin với ${displayName}`}
                            aria-label={`Nhắn tin với ${displayName}`}
                            className="btn-soft flex shrink-0 items-center gap-1 px-2 py-1 text-[11px] font-medium disabled:opacity-50"
                          >
                            {friendActionBusyId === m.agentId ? <DotsLoader size="sm" /> : <MessageCircle className="h-3 w-3" />} Nhắn tin
                          </button>
                        )}
                        {canManage && isOwner && !isMe && (
                          <div className="flex shrink-0 flex-col items-end gap-1 text-[11px]">
                            <button
                              data-testid={`role-moderator-${m.agentId}`}
                              disabled={roleActionBusy === m.agentId}
                              onClick={() => changeRole(m, m.role === 'ADMIN' ? 'MEMBER' : 'ADMIN')}
                              className="rounded border border-line px-2 py-1 text-brand hover:bg-brand-tint disabled:opacity-50"
                            >
                              {m.role === 'ADMIN' ? 'Gỡ Phó nhóm' : 'Đặt Phó nhóm'}
                            </button>
                            {m.role !== 'OWNER' && (
                              <button
                                data-testid={`role-owner-${m.agentId}`}
                                disabled={roleActionBusy === m.agentId}
                                onClick={() => changeRole(m, 'OWNER')}
                                className="rounded border border-line px-2 py-1 text-amber-600 hover:bg-amber-50 disabled:opacity-50"
                                title="Chuyển quyền Trưởng nhóm cho người này (bạn sẽ tự động thành Phó nhóm)"
                              >
                                Đặt Trưởng nhóm
                              </button>
                            )}
                          </div>
                        )}
                        {/* #33 (Admin Demo "chỉ trưởng phó mới được xóa mem") — nút KICK cho OWNER/ADMIN, không tự
                            xóa mình, KHÔNG xóa được Trưởng nhóm (phải nhường quyền trước). */}
                        {isOwnerOrAdmin && !isMe && m.role !== 'OWNER' && (
                          <button
                            data-testid={`kick-${m.agentId}`}
                            disabled={roleActionBusy === m.agentId}
                            onClick={() => void handleKickMember(m.agentId)}
                            title={`Xóa ${displayName} khỏi nhóm`}
                            aria-label={`Xóa ${displayName} khỏi nhóm`}
                            className="flex shrink-0 items-center gap-1 rounded border border-danger/40 px-2 py-1 text-[11px] text-danger hover:bg-danger/10 disabled:opacity-50"
                          >
                            {roleActionBusy === m.agentId ? <DotsLoader size="sm" /> : <UserX className="h-3 w-3" />} Xóa
                          </button>
                        )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              {/* #33 — RỜI NHÓM (mọi thành viên). OWNER bị chặn tới khi nhường quyền (server báo lỗi rõ). */}
              <button
                onClick={() => void handleLeaveGroup()}
                disabled={leaveBusy}
                className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg-mac border border-danger/40 px-3 py-2.5 text-sm font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
              >
                {leaveBusy ? <DotsLoader size="sm" /> : <UserX className="h-4 w-4" />} Rời nhóm
              </button>
              {/* GIẢI TÁN NHÓM (dissolve) — CHỈ trưởng nhóm (OWNER). Xác nhận qua ConfirmDialog (danger) rồi gọi
                  dissolveChatRoom → xóa mềm nhóm, mọi máy nhận room-dissolved tự rời. */}
              {isOwner && (
                <button
                  data-testid="dissolve-group"
                  onClick={() => { setDissolveError(null); setDissolveConfirm(true); }}
                  className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg-mac bg-danger px-3 py-2.5 text-sm font-medium text-white hover:opacity-90"
                >
                  <Trash2 className="h-4 w-4" /> Giải tán nhóm
                </button>
              )}
            </div>
          )}

          {tab === 'photos' && (
            <div className="p-3">
              {/* Việc 1 (1/8) — lưới mini kiểu Zalo, nhóm theo ngày gửi (mới nhất lên đầu, groupByDay() giữ
                  nguyên thứ tự desc backend đã trả). Bấm 1 ảnh → mở lightbox DÙNG CHUNG ConversationScreen.tsx
                  (onOpenPhoto, KHÔNG viết lightbox riêng ở đây). */}
              {attachmentsLoading && (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
                  <DotsLoader /> Đang tải ảnh...
                </div>
              )}
              {attachmentsError && <p className="py-4 text-center text-sm text-danger">{attachmentsError}</p>}
              {attachments && photos.length === 0 && (
                <p className="py-8 text-center text-sm text-slate-400">Chưa có ảnh nào được gửi trong cuộc trò chuyện này.</p>
              )}
              {attachments && photos.length > 0 && (
                <div className="space-y-4">
                  {groupByDay(photos).map((group) => (
                    <div key={group.key}>
                      <p className="mb-1.5 px-0.5 text-xs font-medium text-slate-400">{group.label}</p>
                      <div className="grid grid-cols-4 gap-1">
                        {group.items.map((att) => (
                          <button
                            key={att.attachmentId}
                            type="button"
                            data-testid={`photo-thumb-${att.attachmentId}`}
                            title={att.fileName}
                            onClick={() => onOpenPhoto?.(photos, att.attachmentId)}
                            className="aspect-square overflow-hidden rounded-md bg-slate-100"
                          >
                            <AttachmentImage
                              url={chatAttachmentDownloadUrl(att.attachmentId)}
                              alt={att.fileName}
                              className="h-full w-full object-cover"
                              loadingClassName="flex h-full w-full items-center justify-center bg-slate-100 text-[10px] text-slate-400"
                              failedClassName="flex h-full w-full items-center justify-center bg-slate-100 text-[10px] text-slate-400"
                            />
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'files' && (
            <div className="p-4">
              {/* debt-chat-gaps (31/7, Việc 3) — GET /v1/chat/rooms/:roomId/attachments (listRoomAttachments(),
                  chat-message-service.ts), tải lười lần đầu bấm tab này (xem effect ở trên). Việc 1 (1/8) —
                  GIỮ NGUYÊN cách hiển thị từng dòng (icon+tên+size+người gửi+giờ), chỉ THÊM header nhóm theo
                  ngày (groupByDay()) bọc ngoài, và lọc bớt ảnh (đã sang tab "Ảnh" riêng, `files` = mimeType
                  KHÔNG bắt đầu `image/`). */}
              {attachmentsLoading && (
                <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
                  <DotsLoader /> Đang tải danh sách file...
                </div>
              )}
              {attachmentsError && <p className="py-4 text-center text-sm text-danger">{attachmentsError}</p>}
              {attachments && files.length === 0 && (
                <p className="py-8 text-center text-sm text-slate-400">Chưa có file nào được gửi trong cuộc trò chuyện này.</p>
              )}
              {attachments && files.length > 0 && (
                <div className="space-y-3">
                  {groupByDay(files).map((group) => (
                    <div key={group.key}>
                      <p className="mb-1 px-0.5 text-xs font-medium text-slate-400">{group.label}</p>
                      <ul className="space-y-1">
                        {group.items.map((att) => (
                          <li key={att.attachmentId}>
                            <a
                              href={chatAttachmentDownloadUrl(att.attachmentId)}
                              target="_blank"
                              rel="noreferrer"
                              className="flex items-center gap-3 rounded-lg-mac px-2 py-2 hover:bg-appbg"
                            >
                              <div className="icon-tile flex h-9 w-9 shrink-0 items-center justify-center rounded-lg">
                                <FileText className="h-4.5 w-4.5" />
                              </div>
                              <div className="min-w-0 flex-1">
                                <p className="truncate text-sm font-medium text-slate-700">{att.fileName}</p>
                                <p className="truncate text-[11px] text-slate-400">
                                  {formatBytes(att.sizeBytes)} · {resolveName(att.uploaderId) ?? `Đại lý #${att.uploaderId}`} · {formatDateTime(att.createdAt)}
                                </p>
                              </div>
                            </a>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {tab === 'filter' && (
            <div className="flex h-full flex-col">
              <div className="space-y-2.5 border-b border-line p-4">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
                  <input
                    value={filterQuery}
                    onChange={(e) => setFilterQuery(e.target.value)}
                    placeholder="Tìm nội dung tin nhắn hoặc tên người gửi..."
                    className="w-full rounded-md border border-line py-2 pl-8 pr-2.5 text-sm outline-none focus:border-brand"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label className="flex-1 text-xs text-slate-500">
                    Từ ngày
                    <input
                      type="date"
                      value={filterFrom}
                      onChange={(e) => setFilterFrom(e.target.value)}
                      className="mt-0.5 w-full rounded-md border border-line px-2 py-1.5 text-sm outline-none focus:border-brand"
                    />
                  </label>
                  <label className="flex-1 text-xs text-slate-500">
                    Đến ngày
                    <input
                      type="date"
                      value={filterTo}
                      onChange={(e) => setFilterTo(e.target.value)}
                      className="mt-0.5 w-full rounded-md border border-line px-2 py-1.5 text-sm outline-none focus:border-brand"
                    />
                  </label>
                </div>
                <p className="text-[11px] text-slate-400">Tìm không phân biệt hoa/thường và không phân biệt dấu tiếng Việt (vd "duc" khớp "Đức").</p>
              </div>
              <div className="flex-1 overflow-auto p-4">
                <p className="mb-2 text-xs text-slate-400">{filteredMessages.length} tin nhắn khớp</p>
                <ul className="space-y-2">
                  {filteredMessages.map((m) => (
                    <li key={m.id} className="rounded-lg-mac border border-line p-2.5">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium text-slate-700">{m.senderName}</span>
                        <span className="text-[11px] text-slate-400">{formatDateTime(m.sentAtIso ?? '') || m.time}</span>
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-sm text-slate-600">{m.text || '(tin nhắn đính kèm)'}</p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
      {/* GIẢI TÁN NHÓM (dissolve) — hộp xác nhận (danger). Render Ở CẤP GỐC panel (Modal tự phủ fixed) để không
          dính stopPropagation của khung panel. Lỗi server hiện ngay dưới nội dung, GIỮ hộp để đọc/thử lại. */}
      {dissolveConfirm && (
        <ConfirmDialog
          title="Giải tán nhóm"
          message={`Giải tán nhóm "${displayName}"? Toàn bộ thành viên sẽ bị đưa ra khỏi nhóm và không thể truy cập cuộc trò chuyện này nữa. Hành động không thể hoàn tác.${dissolveError ? `\n\nLỗi: ${dissolveError}` : ''}`}
          confirmLabel="Giải tán nhóm"
          danger
          onCancel={() => { setDissolveConfirm(false); setDissolveError(null); }}
          onConfirm={handleDissolveGroup}
        />
      )}
    </div>
  );
}
