// MÀN QUAN TRỌNG NHẤT (spec mục 4) — tick xanh đã xem, banner tin ghim, menu chuột-phải/long-press
// Chuyển tiếp/Xóa, lightbox xem ảnh, LocationShareCard + QrCard + FileMessageCard mẫu, thả cảm
// xúc (mục 29), chụp màn hình THẬT (mục 23), gọi thoại/video (mục 28 — icon header mở màn gọi giả lập).
//
// Phase 3 "real-time" (29/7, cutover — Admin Demo chốt hướng B "đổi hẳn giao diện luôn") — CẮT HẲN Rocket.Chat
// (rc-realtime.ts sendMessage/getRoomHistory/subscribeRoomMessages/subscribeTypingIndicator/sendTypingStatus/
// deleteMessage/recallMessage) cho phần CHAT TEXT, chuyển sang hệ chat lõi TỰ XÂY (chat-client.ts REST +
// chat-realtime.ts WebSocket mới, `/v1/chat/*` + `/v1/chat-realtime`). CÁC TÍNH NĂNG PHỤ CHƯA TỪNG NỐI RC THẬT
// (shareLocation/sendSticker/confirmForward — Phase 0 mock thuần, chỉ append state cục bộ) GIỮ NGUYÊN 100%,
// KHÔNG đụng — ngoài phạm vi cutover này (không gọi transport nào để mà cắt). `recordVoice()` MOCK CŨ ở nhóm
// này ĐÃ XÓA (31/7, việc #5 — xem `sendAttachment()`/`MessageComposer.tsx`: ghi âm giờ đi qua CÙNG hệ chat
// lõi mới `sendChatMessage(kind:'VOICE')`, không còn là tính năng "chưa nối thật" nữa). `captureScreen()` MOCK
// CŨ ở nhóm này CŨNG ĐÃ XÓA (31/7, mục 23 — chụp màn hình THẬT): logic chụp+upload giờ nằm HẲN trong
// `MessageComposer.tsx` (`handleCaptureScreenClick()` gọi `screen-capture.ts`), gửi qua CÙNG
// `sendAttachment(kind:'image', ...)` đã có sẵn (KHÔNG cần hàm trung gian riêng ở màn này nữa — screenshot đi
// qua ĐÚNG con đường 1 ảnh thường, không phải tính năng phụ tách biệt như trước).
//
// GỘP "Xóa"+"Thu hồi" CŨ (2 hành động RC riêng biệt: chat.delete tức thì KHÔNG giới hạn thời gian vs chat.update
// →placeholder giới hạn 48h) THÀNH 1 HÀNH ĐỘNG "Xóa" DUY NHẤT — hệ mới (chat-message-service.ts deleteMessage())
// CHỈ có đúng 1 khái niệm xóa: soft-delete, giới hạn 48h kể từ lúc gửi, hiện placeholder "Tin nhắn đã bị xóa"
// cho mọi người (mapChatMessage() tự làm, xem chat-client.ts) — KHÔNG có API nào cho "xóa tức thì không giới
// hạn thời gian" ở hệ mới, quyết định cutover CHỌN giữ đúng 1 nút theo đúng khả năng backend thật, KHÔNG tự chế
// thêm endpoint. Xem báo cáo Phase 3 mục UX thay đổi.
//
// MENU NGỮ CẢNH (1/8, Admin Demo yêu cầu — ảnh chụp thật + ảnh tham chiếu Zalo):
//   - FIX bug vị trí menu: menu cũ neo theo tọa độ con trỏ/ngón tay (`e.clientX`/`e.clientY`) — long-press
//     mobile cast nhầm `TouchEvent`→`React.MouseEvent` nên 2 field đó luôn `undefined` → menu rơi lệch vị trí
//     (đè lên khung nhập tin). Đổi hẳn sang neo theo BUBBLE (đo `getBoundingClientRect()` qua ref ở
//     ChatBubble.tsx, tính vị trí qua `computeContextMenuPosition()` — context-menu-position.ts) cho CẢ
//     chuột-phải LẪN long-press, không còn đọc tọa độ con trỏ nữa (xem `menu` state đổi từ `{x,y}` sang
//     `{rect}`).
//   - Thêm "Trả lời" (đặt TRÊN "Chuyển tiếp") — set `replyingTo`, hiện thanh preview riêng NGOÀI
//     MessageComposer.tsx (component đó KHÔNG sửa). Gửi tin qua `send()` bên dưới kèm `replyToMessageId`.
//   - Thêm "Copy" (ẩn nếu tin không có `text`, vd ảnh/file/voice trơn không caption).
//   - Đổi NHÃN "Xóa" (1 tin) → "Thu hồi" — HÀNH VI/API GIỮ NGUYÊN 100% (đây vốn đã là soft-delete-cho-mọi-
//     người trong 48h, đúng bản chất "thu hồi" hơn "xóa", quyết định LEAD đã duyệt — KHÔNG có API "xóa chỉ
//     mình tôi" kiểu Zalo thật ở hệ mới). Nút xóa HÀNG LOẠT (chọn nhiều) GIỮ NGUYÊN chữ "Xóa" (khác ngữ cảnh).
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { Banknote, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Download, ExternalLink, Forward, Info, Link2, ListChecks, MoreHorizontal, Pencil, Phone, Pin, PinOff, Reply, Search, Share2, Trash2, UserRoundPlus, UsersRound, Video, X } from 'lucide-react';
import { DotsLoader } from '../components/DotsLoader';
import { BackButton } from '../components/BackButton';
import { AttachmentImage, ChatBubble, isRealImageUrl } from '../components/ChatBubble';
import { RoomAvatar } from '../components/RoomAvatar';
import { ZoomableImage } from '../components/ZoomableImage';
import { computeContextMenuPosition } from '../lib/context-menu-position';
import { extractFirstUrl, menuActionsForMessage } from '../lib/message-menu-actions';
import { downloadAttachment, shareAttachment } from '../lib/attachment-blob';
import { replyPreviewText } from '../lib/reply-preview';
import { MessageComposer } from '../components/MessageComposer';
import { ConfirmDialog } from '../components/ConfirmDialog';
// Panel thông tin nhóm (25/7 — mục "xem thành viên nhóm, file đã gửi, lọc tin nhắn theo ngày + vai trò
// trưởng/phó nhóm"), xem components/GroupInfoPanel.tsx — Phase 3 (29/7) cutover PHẦN THÀNH VIÊN/vai trò sang
// hệ mới; tab "File"/cài đặt "chỉ Trưởng-Phó gửi tin" CHƯA có REST tương đương ở hệ mới, xem comment file đó.
import { GroupInfoPanel } from '../components/GroupInfoPanel';
// MESSAGES_BY_ROOM/CHAT_ROOMS ở đây CHỈ còn dùng cho confirmForward() (tính năng phụ "Chuyển tiếp" — CỐ Ý
// CHƯA NỐI thật kể cả trước/sau Phase 3, ngoài phạm vi "chat lõi", vẫn ghi vào mảng mock như cũ).
import { CHAT_ROOMS, MESSAGES_BY_ROOM } from '../mock-data/chats';
import { CURRENT_AGENT } from '../mock-data/agents';
import type { ChatMessage, ChatRoom } from '../mock-data/types';
// uploadChatAttachment/attachRoomToChatAttachment/UploadedChatAttachment KHÔNG phải giao thức RC (upload đi
// thẳng bot-api `/v1/chat/attachments`, KHÔNG qua Rocket.Chat, xem comment gốc uploadChatAttachment() đầu
// khối "Đính kèm" rc-realtime.ts) — GIỮ NGUYÊN import từ rc-realtime.ts (không phải bỏ sót, đây là hạ tầng
// tải file DÙNG CHUNG cả 2 hệ, "việc khác ngoài chat text" mà brief cho phép giữ lại).
import { attachRoomToChatAttachment, type UploadedChatAttachment } from '../lib/rc-realtime';
import {
  addChatReaction,
  buildAgentNameResolver,
  canDeleteChatMessage,
  // B112 (2/8) — "Sửa" bill đã gửi: canEditBillMessage() gate hiện nút (mine+isBillImage+billMeta+cửa sổ 1h),
  // MESSAGE_EDIT_WINDOW_HOURS chỉ dùng cho chú thích tooltip khi hết hạn (CÙNG khuôn MESSAGE_DELETE_WINDOW_HOURS).
  canEditBillMessage,
  // B123 (2/8, tính năng "Hoàn tiền" MỚI) — canOpenRefund() gate nút "Hoàn tiền" (bill gốc đã ghép đủ dữ liệu,
  // KHÔNG đòi mine/cửa sổ thời gian — xem docstring chat-client.ts); canEditRefundMessage() gate nút "Sửa" cho
  // 1 LẦN HOÀN TIỀN cụ thể đã gửi (CÙNG khuôn canEditBillMessage — mine + đủ dữ liệu + cửa sổ 1h).
  canOpenRefund,
  canEditRefundMessage,
  MESSAGE_EDIT_WINDOW_HOURS,
  chatAttachmentDownloadUrl,
  deleteChatMessage,
  getChatRoomDetail,
  listChatRoomMembers,
  listChatMessageReactions,
  listChatMessages,
  listRoomPins,
  mapChatMessage,
  markChatRoomRead,
  MESSAGE_DELETE_WINDOW_HOURS,
  pinRoomMessage,
  pinnedMessagePreview,
  resolveDirectPeerAgentId,
  searchChatMessages,
  sendChatMessage,
  unpinRoomMessage,
  type ChatMessageDto,
  type ChatRoomAttachmentDto,
  type MessageSearchHitDto,
  type PinnedMessageDto
} from '../lib/chat-client';
import { subscribeDeliveryReceipt, subscribeMessageDeleted, subscribeMessageEdited, subscribePinsUpdated, subscribeReactionUpdate, subscribeReadReceipt, subscribeRoomDissolved, subscribeRoomMessages, subscribeTypingIndicator, sendTypingStatus } from '../lib/chat-realtime';
import { emitRoomRead } from '../lib/chat-read-events';
import { useBackIntercept } from '../lib/back-intercept';
import { seedPresence } from '../lib/presence-store';
import { requestPresenceCheck } from '../lib/presence-check';
import { PresenceStatusText } from '../components/PresenceStatusText';
import { computeMineDisplayStatus, reconcileSentMessage, shouldMarkRoomRead, shouldAutoReadIncomingMessage } from '../lib/chat-message-status';
import { isAppInBackground } from '../lib/os-notification';
import { PinBoardPanel } from '../components/PinBoardPanel';
import { fetchAuthenticatedAgent, getCachedAgentId } from '../lib/bot-api-client';
import { getCachedRoomMessages, setCachedRoomMessages } from '../lib/messages-cache';
import { playMessageSound } from '../lib/audio-player';
import { buildBillMetadataJson, type BillMessageMeta } from '../lib/bill-message-meta';
import { buildMentionMetadataJson, type MentionMember, type MentionDraft } from '../lib/mention';
import { CreateGroupFromDmModal } from '../components/CreateGroupFromDmModal';
import { canCreateGroupFromRoom } from '../lib/create-group-from-dm';
// P4 (6/8, tách chunk) — 3 modal bill/hoàn-tiền chỉ mở theo hành động người dùng (Sửa bill / Hoàn tiền / Sửa
// hoàn tiền) và cùng kéo theo `lib/bill-table-image` (~39KB canvas ghép ảnh). Nạp ĐỘNG (lazy) để 39KB đó TÁCH
// khỏi chunk ConversationScreen (tải ngay khi mở phòng) → chỉ tải khi thật sự soạn bill. Bọc <Suspense
// fallback={null}> tại chỗ render. Cùng lý do OcrBillPreview đã lazy trong MessageComposer.tsx.
const EditBillMessageModal = lazy(() => import('../components/EditBillMessageModal').then((m) => ({ default: m.EditBillMessageModal })));
const RefundBillModal = lazy(() => import('../components/RefundBillModal').then((m) => ({ default: m.RefundBillModal })));
const EditRefundMessageModal = lazy(() => import('../components/EditRefundMessageModal').then((m) => ({ default: m.EditRefundMessageModal })));

let seq = 1000;

const DELETED_MESSAGE_TEXT_VI = 'Tin nhắn đã bị xóa';

export function ConversationScreen({
  room,
  onBack,
  onStartCall,
  onOpenRevenue,
  onCreateGroupNavigate,
  initialEmojiOpen,
  initialJumpToMessageId
}: {
  room: ChatRoom;
  onBack: () => void;
  /** "Doanh số theo nhóm chat" (1/8, B100) — mở màn RoomRevenueScreen.tsx cho phòng này, wire ở App.tsx
   * ConversationRoute (điều hướng, KHÔNG gọi useNavigate() trực tiếp trong màn này — CÙNG convention onBack/
   * onStartCall đã dùng cho toàn bộ điều hướng của component này). */
  onOpenRevenue?: () => void;
  /** Mở màn gọi thoại/video THẬT (mục 28, Phase 4 — WebRTC, xem CallScreen.tsx) — route /app/call/:kind, wire ở
   * App.tsx `ConversationRoute`. `calleeAgentId` (fix-call-wiring 31/7, TÙY CHỌN) — agentId đối phương đã tự
   * resolve qua `resolveDirectPeerAgentId()` (xem effect room-detail dưới); CHỈ CÓ giá trị cho phòng DIRECT khi
   * resolve thành công — undefined thì App.tsx vẫn điều hướng nhưng CallScreen rơi về "chế độ xem trước" (KHÔNG
   * đổ chuông thật), KHÔNG throw. Nút gọi ở header dưới đây tự ẩn hẳn cho phòng GROUP (Phase 4 chỉ làm 1-1) nên
   * onStartCall trong thực tế CHỈ được gọi cho phòng DIRECT. */
  onStartCall?: (kind: 'voice' | 'video', calleeAgentId?: number) => void;
  /** "Tạo nhóm chat cùng người này" (30/7) — sau khi tạo phòng GROUP mới thành công từ 1 phòng DIRECT, điều
   * hướng sang phòng mới. Wire ở App.tsx ConversationRoute (CÙNG convention onBack/onStartCall — màn này KHÔNG
   * gọi useNavigate() trực tiếp). Chỉ phòng DIRECT mới hiện nút mở (canCreateGroupFromRoom). */
  onCreateGroupNavigate?: (newRoomId: string) => void;
  /** Mở sẵn panel emoji/sticker (mục 38 — ?emoji=1, cho capture-frames). */
  initialEmojiOpen?: boolean;
  /** B107 (2/8) — bấm 1 kết quả "Tin nhắn" từ panel tìm kiếm TOÀN CỤC (ChatListScreen.tsx) → mở ĐÚNG phòng
   * này VÀ cuộn/nổi bật ĐÚNG tin nhắn đó ngay khi mở, kiểu Zalo (Admin Demo báo trực tiếp: "mở ra không trỏ cuộn
   * đúng đến tin nhắn đấy"). Wire qua query param `?jumpTo=` ở App.tsx ConversationRoute. */
  initialJumpToMessageId?: string;
}): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  // menu ngữ cảnh (1/8) — `rect` = bubble DOMRect lúc mở (KHÔNG còn tọa độ con trỏ/ngón tay, xem comment đầu
  // file "MENU NGỮ CẢNH").
  const [menu, setMenu] = useState<{ rect: DOMRect; message: ChatMessage } | null>(null);
  const [forwardTarget, setForwardTarget] = useState<ChatMessage | null>(null);
  // Việc 2 (1/8, gallery-lightbox-swipe) — lightbox giờ điều hướng ĐƯỢC trái/phải giữa các ảnh trong phòng,
  // KHÔNG còn chỉ hiện đúng 1 `ChatMessage` được bấm. `items` là danh sách ảnh đã sắp CŨ→MỚI (chronological
  // ascending — index+1 = ảnh MỚI HƠN, KHỚP quy ước "vuốt trái = tiến tới = ảnh sau/mới hơn" bên dưới) — 2
  // nguồn có thể nạp vào đây: (1) `messages` đã tải (mở từ bấm ảnh trong khung chat, xem openLightboxFromMessage
  // dưới) hoặc (2) `attachments` API (mở từ lưới "Ảnh" GroupInfoPanel.tsx, có thể vượt phạm vi `messages` đã
  // tải nếu phòng có lịch sử dài — xem openLightboxFromAttachments). Cả 2 nguồn quy về CÙNG 1 shape `items` +
  // `index` để phần render/điều hướng bên dưới dùng chung ĐÚNG 1 lightbox, không viết lightbox thứ 2.
  const [lightbox, setLightbox] = useState<{ items: { key: string; imageUrl?: string }[]; index: number } | null>(null);
  // Back (cứng Android) khi đang mở overlay xem ẢNH (gallery) hoặc MENU tin nhắn (nhấn giữ) → đóng overlay đó,
  // lùi ĐÚNG 1 bước, KHÔNG lùi route ra danh sách (Admin Demo 18/8). active = overlay đang mở.
  useBackIntercept(lightbox !== null, () => setLightbox(null));
  useBackIntercept(menu !== null, () => setMenu(null));
  // zoom (5/8) — true khi ảnh trong lightbox đang được phóng to (>fit). Khi đang zoom thì KHÔNG cho tap-nền-đóng
  // và KHÔNG cho vuốt-điều-hướng trái/phải (1 ngón kéo lúc đó là PAN ảnh, không phải chuyển ảnh).
  const [lightboxZoomed, setLightboxZoomed] = useState(false);
  const lightboxTouchStartXRef = useRef<number | null>(null);
  // "Trả lời" (1/8) — tin đang được trả lời (null = không trả lời tin nào). Thanh preview riêng bọc NGOÀI
  // MessageComposer.tsx (xem JSX gần cuối file) — component đó KHÔNG sửa, không biết gì về replyingTo.
  const [replyingTo, setReplyingTo] = useState<ChatMessage | null>(null);
  // Xóa thật (mục 5, 24/7; Phase 3 gộp còn 1 hành động — xem comment đầu file) — chọn nhiều để xóa hàng loạt,
  // CÙNG pattern multi-select CategoryManagerModal.tsx (selectMode/selectedIds/ConfirmDialog). Chỉ tin nhắn
  // CỦA MÌNH được chọn (gate ở ChatBubble). Giới hạn MESSAGE_DELETE_WINDOW_HOURS=48 kể từ sentAtIso
  // (chat-client.ts canDeleteChatMessage).
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [confirmDeleteOne, setConfirmDeleteOne] = useState<ChatMessage | null>(null);
  const [confirmDeleteBulk, setConfirmDeleteBulk] = useState(false);
  // "Sửa" bill đã gửi (B112, 2/8) — CÙNG khuôn confirmDeleteOne (state giữ NGUYÊN message đang thao tác) —
  // EditBillMessageModal.tsx tự cập nhật `messages` state qua real-time `message-edited` (subscribeMessageEdited
  // effect đã có sẵn, xem dưới), KHÔNG cần callback riêng để patch state tại chỗ.
  const [editingBillMessage, setEditingBillMessage] = useState<ChatMessage | null>(null);
  // "Hoàn tiền" (B123, 2/8, tính năng MỚI) — CÙNG khuôn editingBillMessage: `refundingMessage` = bill GỐC đang
  // xác nhận hoàn tiền (mở RefundBillModal.tsx, gửi tin nhắn MỚI reply tin này); `editingRefundMessage` = tin
  // nhắn HOÀN TIỀN cụ thể đang sửa (mở EditRefundMessageModal.tsx, PATCH tin nhắn hiện có). RefundBillModal cần
  // biết bill GỐC để tính "số tiền phải hoàn" (tra thẳng trong `messages` state đã tải, KHÔNG gọi thêm API —
  // CÙNG nguyên tắc "Trả lời" resolve tin gốc).
  const [refundingMessage, setRefundingMessage] = useState<ChatMessage | null>(null);
  const [editingRefundMessage, setEditingRefundMessage] = useState<ChatMessage | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  // Panel thông tin nhóm (25/7) — xem components/GroupInfoPanel.tsx.
  const [showInfo, setShowInfo] = useState(false);
  // Lối tắt "Thêm thành viên" (Admin Demo 8/8) — icon group+ trên header mở info + TỰ bật modal thêm thành viên.
  // Panel unmount mỗi khi đóng (showInfo=false) → mở lại = mount mới; cờ này quyết định lần mount TỚI có tự mở
  // modal thêm thành viên không (group+ → true; Info thường → false).
  const [pendingAddMembers, setPendingAddMembers] = useState(false);
  // "BẢNG TIN" / GHIM KHÔNG GIỚI HẠN (5/8, Admin Demo ưu tiên 1) — danh sách tin đã ghim của phòng (nguồn sự thật
  // DUY NHẤT cho CẢ banner ghim lẫn PinBoardPanel). Tải qua listRoomPins() lúc mở phòng + đồng bộ realtime
  // subscribePinsUpdated() (server phát `pins-updated` kèm NGUYÊN danh sách mới sau mỗi lần ghim/bỏ ghim).
  const [pins, setPins] = useState<PinnedMessageDto[]>([]);
  const [pinsLoading, setPinsLoading] = useState(false);
  const [showPinBoard, setShowPinBoard] = useState(false);
  const [pinActionError, setPinActionError] = useState<string | null>(null);
  // Lane D vòng 2 (3/8) — menu "⋯" gom action phụ (video/thông tin/chọn nhiều) ở breakpoint HẸP (<sm): header
  // hội thoại TRƯỚC ĐÂY xếp back+avatar+tên(flex-1 KHÔNG min-w-0)+5 icon trên 1 hàng — trên 390px, cụm icon
  // chiếm ~180px khiến `flex-1` của tên co xuống dưới min-content rồi WRAP DỌC (đo THẬT: tên dài wrap 7 dòng →
  // header cao 235px, icon thứ 6 tràn khỏi màn). Sửa: min-w-0+truncate cụm tên, shrink-0 cụm icon, và ở <sm
  // chỉ giữ 2 icon chính (gọi thoại nếu DIRECT + tìm kiếm) + nút "⋯" mở menu chứa phần còn lại.
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  // "Tạo nhóm chat cùng người này" (30/7) — modal chọn thêm bạn bè từ phòng DIRECT hiện tại.
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  // Typing indicator (Phase 3, 29/7) — tập agentId (SỐ, Agent.id thật) ĐANG gõ chữ trong phòng này (xem
  // chat-realtime.ts subscribeTypingIndicator — hệ MỚI trả agentId, KHÁC username RC chuỗi của bản cũ). Server
  // tự gửi lại "ngừng gõ" (isTyping=false) khi người kia dừng/gửi tin — KHÔNG cần code ở đây tự đặt timeout.
  const [typingAgentIds, setTypingAgentIds] = useState<Set<number>>(new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  // FIX-PERF (4/8) — CUỘN-LÊN-TẢI-THÊM (infinite scroll up). TRƯỚC ĐÂY chỉ tải 50 tin mới nhất 1 lần → phòng
  // hàng nghìn tin KHÔNG xem được lịch sử. Kéo lên đầu khung → tải thêm 50 tin cũ hơn (cursor `before`=id tin
  // cũ nhất đang có), CHÈN LÊN ĐẦU + GIỮ nguyên vị trí cuộn (không nhảy). `hasMoreOlder` từ `res.data.hasMore`
  // của server (đã có sẵn). Ref song song với state để đọc trong onScroll/loader KHÔNG bị closure cũ.
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const hasMoreOlderRef = useRef(false);
  const loadingOlderRef = useRef(false);
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  hasMoreOlderRef.current = hasMoreOlder;
  // Khi CHÈN tin cũ lên đầu, effect auto-cuộn-đáy (theo `messages`) PHẢI bị chặn 1 lần + KHÔI PHỤC vị trí cuộn
  // (giữ đúng chỗ người dùng đang đọc), thay vì nhảy xuống đáy. Ref mang chiều cao/vị trí cuộn ngay TRƯỚC chèn.
  const prependAnchorRef = useRef<{ prevScrollHeight: number; prevScrollTop: number } | null>(null);
  // Âm thanh — id các tin nhắn ĐÃ xử lý qua subscribeRoomMessages (dedup cho playMessageSound(), xem
  // effect bên dưới). Sống suốt vòng đời component (không reset riêng theo phòng) — id (cuid) là duy nhất
  // toàn hệ thống nên không có rủi ro đụng id giữa các phòng khác nhau.
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  // Audit độc lập 30/7 (MEDIUM, đã fix): trước đây mỗi `reaction-update` GHI ĐÈ cả mảng `reactions` của tin
  // nhắn bằng 1 entry duy nhất — người thả SAU xóa mất badge người thả TRƯỚC dù cả 2 vẫn tồn tại thật trong DB.
  // Giữ map messageId → (agentId → emoji) SỐNG SUỐT vòng đời component (ref, không phải state — chỉ để tính
  // toán, không cần re-render riêng) làm nguồn sự thật CỤC BỘ, mỗi sự kiện chỉ sửa ĐÚNG 1 entry (agentId) rồi
  // suy ra lại mảng {emoji,count} từ TOÀN BỘ map hiện có — không còn ghi đè lẫn nhau.
  const reactionsByMessageRef = useRef<Map<string, Map<number, string>>>(new Map());

  // Phase 3 (29/7) — danh tính THẬT của chính mình (agentId số, cần tính `mine`) + resolver tên hiển thị theo
  // agentId (server KHÔNG tự trả tên người gửi trong ChatMessageDto, xem comment mapChatMessage()) — tải 1 LẦN
  // lúc mount (KHÔNG phụ thuộc room.id, danh tính/danh bạ không đổi khi chuyển phòng). `identityReady` chặn
  // effect tải lịch sử/real-time chạy TRƯỚC khi có myAgentId — tránh "mine" tính sai (flash tin của mình hiện
  // như tin người khác) trong khoảnh khắc đầu.
  // P1 (6/8, tối ưu tốc độ mở khung chat) — SEED myAgentId ĐỒNG BỘ từ cache danh tính phiên (bot-api-client.ts
  // getCachedAgentId(), làm ấm ở AppShell/đăng nhập). Cache ẤM → `identityReady` bắt đầu TRUE ngay → 4 effect
  // bên dưới (tải tin/room-detail/real-time/pins) CHẠY NGAY lúc mount với myAgentId ĐÚNG, KHÔNG chờ hop
  // /auth/me (cắt ~150ms/phòng). Cache NGUỘI (F5 giữa phòng / vừa đăng ký) → giữ hành vi cũ (chờ effect dưới).
  const [myAgentId, setMyAgentId] = useState<number | null>(() => getCachedAgentId());
  const [identityReady, setIdentityReady] = useState(() => getCachedAgentId() != null);
  const resolveAgentNameRef = useRef<(agentId: number) => string | undefined>(() => undefined);

  useEffect(() => {
    let cancelled = false;
    // Cache danh tính ĐÃ ẤM (seed ở trên) → KHÔNG gọi lại /auth/me (né hop). Vẫn cần resolver tên hiển thị cho
    // tin của NGƯỜI KHÁC trong nhóm — `buildAgentNameResolver()` đọc friends-cache (đã cache sau lần đầu, rẻ).
    const warm = getCachedAgentId() != null;
    const authPromise = warm ? Promise.resolve(null) : fetchAuthenticatedAgent();
    Promise.all([authPromise, buildAgentNameResolver()]).then(([authRes, resolver]) => {
      if (cancelled) return;
      if (authRes && authRes.ok) setMyAgentId(authRes.data.agent.id);
      resolveAgentNameRef.current = resolver;
      setIdentityReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // debt-chat-gaps (31/7, Việc 4) — "chỉ trưởng/phó nhóm được gửi tin" (ChatRoom.readOnly). `room` (prop, kiểu
  // UI rút gọn `mock-data/types.ts`) KHÔNG mang field này/vai trò của mình — tự gọi `getChatRoomDetail()` riêng
  // (CÙNG cách GroupInfoPanel.tsx làm cho toggle bật/tắt) mỗi khi đổi phòng, đợi `identityReady` trước để so
  // đúng `myAgentId` với danh sách `members` trả về. `myRoleInRoom` null = chưa tải xong/không tìm thấy (coi
  // như MEMBER thường — fail-safe, KHÔNG mở khóa nhầm trong khoảnh khắc chưa có dữ liệu).
  const [roomReadOnly, setRoomReadOnly] = useState(false);
  const [myRoleInRoom, setMyRoleInRoom] = useState<'OWNER' | 'ADMIN' | 'MEMBER' | null>(null);
  // fix-call-wiring (31/7) — agentId đối phương cho phòng DIRECT, tự resolve từ CÙNG response
  // getChatRoomDetail() đã tải ở effect này (không gọi thêm round-trip riêng) — xem resolveDirectPeerAgentId()
  // (chat-client.ts). null = phòng GROUP/chưa tải xong/không resolve được (đối phương đã rời phòng — hiếm,
  // xem comment hàm đó) — nút gọi vẫn hoạt động, chỉ KHÔNG kèm calleeAgentId (CallScreen tự rơi về xem trước).
  const [callPeerAgentId, setCallPeerAgentId] = useState<number | null>(null);
  // TICK "đã đọc" (5/8, Admin Demo "trạng thái đã gửi/đã nhận/đã đọc") — mốc thời gian (ms) người kia (DIRECT peer)
  // đã đọc TỚI (max các nguồn: read-receipt realtime + lastReadMessageId lúc mở phòng). Tin CỦA MÌNH có sentAt ≤
  // mốc này → hiện tick "đã xem" (2 tick xanh). null (chưa có/nhóm) → chỉ hiện "đã gửi" (1 tick). `peerLastReadMessageId`
  // = con trỏ đọc của peer lấy từ getChatRoomDetail lúc mở (resolve ra thời gian qua `messagesById` bên dưới).
  const [peerReadAtMs, setPeerReadAtMs] = useState<number | null>(null);
  const [peerLastReadMessageId, setPeerLastReadMessageId] = useState<string | null>(null);
  // TICK "đã nhận" (6/8, Admin Demo) — mốc thời gian (ms) tới đó người kia (DIRECT peer) đã NHẬN (online). Tin của
  // mình sentAt ≤ mốc này (và CHƯA đọc) → 2 tick xám "đã nhận". Nguồn: (a) peer.online lúc mở phòng → coi như
  // đã nhận mọi tin tới NGAY BÂY GIỜ; (b) delivery-receipt realtime (peer vừa online / tin vừa gửi cho peer online).
  const [peerDeliveredAtMs, setPeerDeliveredAtMs] = useState<number | null>(null);
  // Tag @ mention kiểu Zalo (13/8) — danh sách thành viên (agentId + tên hiển thị) cho dropdown gợi ý khi gõ `@`.
  // CHỈ tải cho phòng GROUP (DIRECT 1-1 KHÔNG cần mention). Loại chính mình + thành viên đã vô hiệu hóa. Dùng
  // listChatRoomMembers() (route trả `name` server-enrich, #32) — getChatRoomDetail() KHÔNG mang tên.
  const [mentionMembers, setMentionMembers] = useState<MentionMember[]>([]);

  useEffect(() => {
    if (!identityReady || !room.isGroup) {
      setMentionMembers([]);
      return;
    }
    let cancelled = false;
    listChatRoomMembers(room.id).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setMentionMembers(
          res.data
            .filter((m) => m.leftAt === null && m.agentId !== myAgentId && !m.deactivated && !!m.name)
            .map((m) => ({ agentId: m.agentId, name: m.name as string }))
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [room.id, room.isGroup, identityReady, myAgentId]);

  useEffect(() => {
    if (!identityReady) return;
    let cancelled = false;
    setRoomReadOnly(false);
    setMyRoleInRoom(null);
    setCallPeerAgentId(null);
    setPeerReadAtMs(null);
    setPeerLastReadMessageId(null);
    setPeerDeliveredAtMs(null);
    getChatRoomDetail(room.id).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setRoomReadOnly(res.data.readOnly);
        const mine = res.data.members.find((m) => m.agentId === myAgentId);
        setMyRoleInRoom(mine?.role ?? null);
        if (myAgentId != null) setCallPeerAgentId(resolveDirectPeerAgentId(res.data, myAgentId));
        // TICK "đã đọc"/"đã nhận" — DIRECT: con trỏ đọc + trạng thái online của ĐỐI PHƯƠNG lúc mở phòng. GROUP:
        // bỏ qua (tick nhóm cần đếm từng người, ngoài phạm vi — nhóm chỉ hiện "đã gửi").
        if (res.data.type === 'DIRECT' && myAgentId != null) {
          const peer = res.data.members.find((m) => m.agentId !== myAgentId && m.leftAt === null);
          setPeerLastReadMessageId(peer?.lastReadMessageId ?? null);
          // peer.online (route đính kèm agentHasOpenConnection) → đã NHẬN mọi tin tới NGAY BÂY GIỜ (đã giao tới
          // thiết bị đang mở). deliveredAt = thời điểm mở phòng (Date.now()).
          if (peer?.online) setPeerDeliveredAtMs(Date.now());
          // PRESENCE (6/8) — SEED presence-store từ peer (online+lastSeenAt) để header hiện "Đang hoạt động"/"X
          // phút trước" đúng ngay; presence-update LIVE sau đó tự cập nhật. + FCM-ping-on-view: đánh thức máy peer
          // (throttle 30s trong presence-check.ts) → nếu còn reachable thì chuyển online gần realtime.
          if (peer) {
            if (peer.online != null) seedPresence([[peer.agentId, peer.online, peer.lastSeenAt] as const]);
            requestPresenceCheck([peer.agentId]);
          }
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [room.id, identityReady, myAgentId]);

  // Chỉ khóa ô nhập khi phòng ĐANG bật readOnly VÀ chính mình KHÔNG phải OWNER/ADMIN — enforce THẬT nằm ở
  // server (sendMessage() sẽ throw ROOM_READ_ONLY nếu cố gửi, xem sendError bên dưới) — khóa ở ĐÂY chỉ để trải
  // nghiệm rõ ràng hơn (không đợi round-trip lỗi mới biết không gửi được), CÙNG tinh thần
  // canDeleteChatMessage()/MESSAGE_DELETE_WINDOW_HOURS.
  const composerLocked = roomReadOnly && myRoleInRoom !== 'OWNER' && myRoleInRoom !== 'ADMIN';

  /** Gán `senderName` hiển thị cho tin KHÔNG PHẢI của mình (ChatBubble chỉ hiện senderName khi `!mine`, xem
   * component đó) — server không trả tên kèm sẵn, tự tra qua danh bạ bạn bè (resolveAgentNameRef), fallback
   * "Đại lý #<id>" CÙNG quy ước mapChatRoomSummary() (chat-client.ts). */
  function withSenderName(msg: ChatMessage): ChatMessage {
    if (msg.mine || msg.senderId === 'system') return msg;
    const idNum = Number(msg.senderId);
    const name = resolveAgentNameRef.current(idNum);
    // Admin Demo 1/9 "người gửi bill là Đại lý #412, phải đúng tên": ưu tiên danh bạ user → TÊN SERVER (msg.senderName
    // từ dto.senderName, server tra bảng agents — BOT/agent-ngoài-danh-bạ vẫn ra đúng tên "SigMa") → cuối mới fallback.
    return { ...msg, senderName: name || msg.senderName || `Đại lý #${msg.senderId}` };
  }

  // Bug #2 (5/8, Admin Demo "số tin chưa đọc không clear") — đánh dấu ĐÃ ĐỌC tới `messageId` (POST .../read). Bỏ
  // qua id LẠC QUAN cục bộ (`pending-`/`local-*` chưa có id server thật — không markRead được). Chống gọi lặp
  // thừa cùng 1 mốc qua `lastMarkedReadRef`. Best-effort: lỗi mạng KHÔNG chặn UI. THÀNH CÔNG → phát
  // `emitRoomRead` để ChatListScreen/AppShell xóa badge chưa đọc NGAY (không đợi remount/refetch).
  const lastMarkedReadRef = useRef<string | null>(null);
  function markRoomReadUpTo(messageId: string | undefined): void {
    if (!shouldMarkRoomRead(messageId, lastMarkedReadRef.current)) return;
    const realId = messageId as string; // shouldMarkRoomRead đã loại undefined/rỗng + id lạc quan.
    lastMarkedReadRef.current = realId;
    // BUG#8 (6/8, Admin Demo "đọc xong rời khung, badge đỏ 1-3s mới tắt — phải TỨC THÌ") — phát emitRoomRead
    // LẠC QUAN NGAY (trước khi đợi round-trip server POST .../read, vốn tốn 1-3s trên mạng). ChatListScreen/
    // AppShell/badge nghe sự kiện này xóa unread NGAY LẬP TỨC (0ms) khi mở phòng, kiểu Zalo. Server POST vẫn
    // chạy để lưu bền mốc đã-đọc (đồng bộ máy khác + reload). Nếu POST lỗi → cho thử lại mốc này lần kế; badge
    // đã clear lạc quan sẽ tự đúng lại ở lần refetch/emit kế (không tệ hơn hành vi cũ, chỉ NHANH hơn khi thành
    // công — trường hợp phổ biến tuyệt đại đa số).
    emitRoomRead(room.id);
    markChatRoomRead(room.id, realId).then((res) => {
      if (!res.ok) lastMarkedReadRef.current = null; // lỗi → cho phép thử lại mốc này ở lần kích hoạt kế.
    });
  }

  // #12 (8/8) — QUAY LẠI FOREGROUND khi đang mở phòng này (bấm HOME rồi mở lại app / chuyển tab về): tin đến lúc
  // ở NỀN đã cố ý GIỮ unread (không auto-đọc, xem gate WS bên dưới) — giờ người dùng đã NHÌN thấy phòng → đánh
  // dấu đọc tới tin mới nhất để badge clear đúng. Chỉ chạy khi trở nên hiển thị + có tin. (visibilitychange đáng
  // tin trên cả web lẫn WebView APK khi Activity resume.)
  useEffect(() => {
    if (!identityReady) return;
    const onVisibility = (): void => {
      if (isAppInBackground()) return; // chỉ xử lý khi TRỞ NÊN hiển thị.
      const latest = messagesRef.current;
      const newest = latest.length > 0 ? latest[latest.length - 1] : undefined;
      if (newest) markRoomReadUpTo(newest.id); // shouldMarkRoomRead lọc id lạc quan + chống gọi lặp cùng mốc.
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- markRoomReadUpTo/messagesRef ổn định theo room.id; chỉ cần chạy lại khi đổi phòng/định danh.
  }, [identityReady, room.id]);

  // Lịch sử tin nhắn THẬT của phòng (hệ chat lõi mới) — tải lại mỗi khi đổi phòng (đợi identityReady TRƯỚC).
  // P3+P5 (6/8) — STALE-WHILE-REVALIDATE: nếu phòng ĐÃ có trong cache (lib/messages-cache.ts — mở lại phòng
  // vừa xem), RENDER NGAY bản cache (0ms, KHÔNG `setMessages([])` gây nháy trắng, KHÔNG spinner "Đang tải...")
  // rồi revalidate nền. Cache MISS (lần đầu) → giữ hành vi cũ (clear + loading). Realtime WS merge phía dưới
  // vẫn hoạt động NGUYÊN VẸN trên bản đã render (không đụng).
  useEffect(() => {
    if (!identityReady) return;
    let cancelled = false;
    const cached = getCachedRoomMessages(room.id);
    if (cached) {
      setMessages(cached.messages);
      setHasMoreOlder(cached.hasMoreOlder);
      hasMoreOlderRef.current = cached.hasMoreOlder;
      setLoadingHistory(false);
      setHistoryError(null);
    } else {
      setLoadingHistory(true);
      setMessages([]);
      setHasMoreOlder(false);
      hasMoreOlderRef.current = false;
    }
    lastMarkedReadRef.current = null; // Bug #2 — đổi phòng: quên mốc đã-đọc cũ để markRead lại cho phòng mới.
    listChatMessages(room.id, { limit: 50 }).then((res) => {
      if (cancelled) return;
      setLoadingHistory(false);
      if (res.ok) {
        setHasMoreOlder(res.data.hasMore);
        hasMoreOlderRef.current = res.data.hasMore;
        // Server trả MỚI NHẤT TRƯỚC (xem listMessages(), chat-message-service.ts) — đảo lại cũ→mới cho đúng
        // thứ tự hiển thị chat (CÙNG cách getRoomHistory() cũ đảo chiều lịch sử RC).
        const mapped = res.data.messages
          .slice()
          .reverse()
          .map((dto) => withSenderName(mapChatMessage(dto, myAgentId)));
        setMessages(mapped);
        setHistoryError(null);
        // P3+P5 (6/8) — ghi bản server MỚI vào cache để lần mở lại phòng này render tức thì (SWR). Reaction
        // merge dưới đây (bất đồng bộ) sẽ ghi ĐÈ lại cache kèm badge; và cleanup effect ghi bản mới nhất (gồm
        // realtime) khi rời phòng — 3 điểm ghi hội tụ về cùng nguồn cache.
        setCachedRoomMessages(room.id, mapped, res.data.hasMore);
        // Bug #2 (5/8) — MỞ phòng = đánh dấu đã đọc tới tin MỚI NHẤT → badge unread về 0 (kiểu Zalo). Tin mới
        // nhất là cuối mảng đã đảo cũ→mới. res.data.messages[0] = tin mới nhất (server sắp desc) — dùng id đó.
        const newestId = res.data.messages[0]?.id;
        if (newestId) markRoomReadUpTo(newestId);

        // debt-chat-gaps (31/7, Việc 1) — khôi phục lịch sử reaction cho các tin VỪA TẢI (GAP đã ghi ở comment
        // effect real-time bên dưới: trước đây `reactionsByMessageRef` CHỈ tích lũy được reaction nhận qua WS
        // TRONG PHIÊN đang mở, tải lại trang/mở lại phòng mất hết badge cũ). ĐÚNG 1 lệnh gọi cho CẢ TRANG (không
        // N+1 theo từng tin nhắn, xem listReactionsForMessages() chat-reaction-service.ts) — seed VÀO CÙNG map
        // real-time đã có sẵn (không viết lại cơ chế, chỉ nạp thêm dữ liệu lúc mount).
        const messageIds = mapped.map((m) => m.id);
        listChatMessageReactions(room.id, messageIds).then((reactionsRes) => {
          if (cancelled || !reactionsRes.ok) return;
          const byMessageId = reactionsRes.data;
          if (Object.keys(byMessageId).length === 0) return;
          for (const [messageId, reactions] of Object.entries(byMessageId)) {
            const perMessage = new Map<number, string>();
            for (const r of reactions) perMessage.set(r.agentId, r.emoji);
            reactionsByMessageRef.current.set(messageId, perMessage);
          }
          setMessages((prev) => {
            const merged = prev.map((m) => {
              const perMessage = reactionsByMessageRef.current.get(m.id);
              if (!perMessage || perMessage.size === 0) return m;
              const counts = new Map<string, number>();
              for (const emoji of perMessage.values()) counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
              return { ...m, reactions: [...counts.entries()].map(([emoji, count]) => ({ emoji, count })) };
            });
            // P3+P5 (6/8) — cập nhật cache kèm badge reaction (không đợi cleanup) để mở lại phòng thấy đủ badge.
            setCachedRoomMessages(room.id, merged, hasMoreOlderRef.current);
            return merged;
          });
        });
      } else {
        setHistoryError(res.message);
      }
    });
    // P3+P5 (6/8) — capture room.id của phòng ĐANG rời cho cleanup (biến đóng đúng phòng, không phải phòng kế).
    const leavingRoomId = room.id;
    return () => {
      cancelled = true;
      // Ghi bản tin nhắn MỚI NHẤT (đã gồm mọi merge realtime WS trong lúc mở phòng) vào cache khi rời phòng →
      // mở lại phòng này render tức thì bản đầy đủ nhất (SWR). `messagesRef` luôn trỏ state hiện tại (xem khai
      // báo ở trên). Rỗng (chưa tải xong / phòng trống) → bỏ qua, tránh ghi cache rỗng đè bản cache tốt hơn.
      const latest = messagesRef.current;
      if (latest.length > 0) setCachedRoomMessages(leavingRoomId, latest, hasMoreOlderRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- withSenderName đọc ref (không đổi identity mỗi render theo nghĩa cần re-run effect), chỉ room.id/identityReady/myAgentId thật sự cần kích hoạt tải lại.
  }, [room.id, identityReady, myAgentId]);

  // Real-time (chat-realtime.ts WebSocket mới, Phase 3): tin nhắn mới/sửa (kể cả tin CHÍNH mình vừa gửi ở
  // send() bên dưới — server KHÔNG loại trừ sender khỏi broadcast new-message, xem chat-realtime-hub.ts) được
  // đẩy về đây — upsert theo id để an toàn (tránh bong bóng trùng nếu server gửi lại/edit).
  useEffect(() => {
    if (!identityReady) return;
    // Âm thanh (Admin Demo 24/7 — bug tự phát hiện qua Playwright verify, không phải suy đoán): dedup theo
    // id PHẢI nằm ở ref NGOÀI updater của setMessages, KHÔNG được gọi playMessageSound() (side effect)
    // bên trong hàm updater `setMessages(prev => ...)` — React 18 StrictMode (đang bật ở main.tsx) CHỦ Ý
    // gọi hàm updater 2 lần ở dev để phát hiện updater không thuần khiết, nên side effect trong đó sẽ bị
    // bắn ĐÚP (đã tự bắt được lỗi này bằng test: before/after lệch +2 thay vì +1 khi bắn 1 tin qua WS giả
    // lập). seenIdsRef không bị StrictMode double-invoke vì mutate ref, không phải state updater.
    const seenIds = seenMessageIdsRef.current;
    const upsert = (dto: ChatMessageDto): void => {
      const incoming = withSenderName(mapChatMessage(dto, myAgentId));
      const isNew = !seenIds.has(incoming.id);
      if (isNew) {
        seenIds.add(incoming.id);
        if (!incoming.mine) {
          playMessageSound();
          // Bug #2 (5/8) + #12 (8/8, Admin Demo "tin chưa đọc bị clear SAI khi KHÔNG mở trò chuyện") — ĐANG MỞ phòng
          // mà có tin MỚI của người khác → đánh dấu đã đọc NGAY (unread giữ 0 realtime, kiểu Zalo). NHƯNG CHỈ khi
          // app đang HIỂN THỊ (foreground): nếu app ở NỀN (bấm HOME/minimize trong khi phòng này vẫn là route mở)
          // thì người dùng CHƯA nhìn → KHÔNG auto-đọc, giữ unread (badge cộng đúng). Quay lại foreground sẽ đọc
          // (effect visibility bên dưới). shouldAutoReadIncomingMessage: !mine && !nền (test chat-message-status).
          if (shouldAutoReadIncomingMessage(!!incoming.mine, isAppInBackground())) markRoomReadUpTo(incoming.id);
        }
      }
      setMessages((prev) => {
        const idx = prev.findIndex((m) => m.id === incoming.id);
        if (idx === -1) return [...prev, incoming];
        const next = [...prev];
        next[idx] = incoming;
        return next;
      });
    };
    const unsubMessage = subscribeRoomMessages(room.id, upsert);
    const unsubEdited = subscribeMessageEdited(room.id, upsert);
    // "Xóa" real-time (Phase 3) — server CHỈ gửi messageId/deletedAt (KHÔNG kèm message đầy đủ, hệ mới không
    // giữ nội dung hiển thị sau xóa) — patch state tại chỗ thành placeholder, CÙNG cách performDeleteOne() xử
    // lý lúc CHÍNH mình xóa (xem dưới) để 2 luồng (tự xóa vs nhận qua real-time do người khác/tab khác xóa)
    // hội tụ về đúng 1 kết quả hiển thị.
    const unsubDeleted = subscribeMessageDeleted(room.id, (messageId) => {
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, type: 'system', text: DELETED_MESSAGE_TEXT_VI, pinned: false } : m)));
    });
    // Cảm xúc real-time (Phase 3, đã fix audit 30/7) — GAP CŨ đã ĐÓNG (debt-chat-gaps 31/7, Việc 1): lịch sử
    // reaction giờ được SEED ngay lúc mount qua `listChatMessageReactions()` (xem effect tải lịch sử ở trên,
    // GHI TRỰC TIẾP vào CÙNG map `reactionsByMessageRef` này) — tải lại trang/mở lại phòng KHÔNG còn mất badge
    // cũ. Trong PHIÊN đang mở, mọi sự kiện nhận được qua WS CỘNG DỒN đúng theo từng agentId (xem
    // reactionsByMessageRef khai ở trên) — không còn ghi đè nhau.
    const unsubReaction = subscribeReactionUpdate(room.id, (messageId, agentId, action, reaction) => {
      const perMessage = reactionsByMessageRef.current.get(messageId) ?? new Map<number, string>();
      if (action === 'removed' || !reaction) {
        perMessage.delete(agentId);
      } else {
        perMessage.set(agentId, reaction.emoji);
      }
      reactionsByMessageRef.current.set(messageId, perMessage);

      const counts = new Map<string, number>();
      for (const emoji of perMessage.values()) counts.set(emoji, (counts.get(emoji) ?? 0) + 1);
      const aggregated = [...counts.entries()].map(([emoji, count]) => ({ emoji, count }));

      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions: aggregated } : m)));
    });
    // TICK "đã đọc" (5/8, Bug #3) — người kia (DIRECT peer) đọc tới đâu → nâng mốc `peerReadAtMs` (tin của
    // mình có sentAt ≤ mốc → hiện 2 tick xanh "đã xem"). Bỏ qua read-receipt của CHÍNH mình (đọc tin người
    // khác không đổi trạng thái tin của mình).
    const unsubReadReceipt = subscribeReadReceipt(room.id, (agentId, _messageId, lastReadAt) => {
      // Chỉ DIRECT (peer là 1 người) mới đổi tick theo read-receipt — NHÓM giữ "đã gửi" (tick "đã xem" nhóm cần
      // đếm TỪNG người, không suy từ 1 thành viên bất kỳ đọc; CÙNG lý do delivery-receipt gate room.isGroup).
      if (agentId === myAgentId || room.isGroup) return;
      const ms = new Date(lastReadAt).getTime();
      if (Number.isNaN(ms)) return;
      setPeerReadAtMs((prev) => (prev == null || ms > prev ? ms : prev));
    });
    // TICK "đã nhận" (6/8) — người kia (DIRECT peer) online tới đâu → nâng mốc `peerDeliveredAtMs`. Bỏ qua
    // delivery-receipt của CHÍNH mình. GROUP: vẫn nhận nhưng `withDisplayStatus` chỉ áp cho DIRECT (peer là 1
    // người) — nhóm giữ "đã gửi" (không đổi tick từ receipt của 1 thành viên bất kỳ).
    const unsubDeliveryReceipt = subscribeDeliveryReceipt(room.id, (agentId, deliveredAt) => {
      if (agentId === myAgentId || room.isGroup) return;
      const ms = new Date(deliveredAt).getTime();
      if (Number.isNaN(ms)) return;
      setPeerDeliveredAtMs((prev) => (prev == null || ms > prev ? ms : prev));
    });
    // GIẢI TÁN NHÓM (dissolve) — trưởng nhóm giải tán nhóm này ở máy khác → server phát room-dissolved. Phòng đã
    // bị xóa mềm, không còn quyền vào → tự rời về danh sách trò chuyện (onBack, CÙNG convention điều hướng màn
    // này — KHÔNG gọi useNavigate trực tiếp). Danh sách phòng tự bỏ phòng này ở lần tải kế (đã lọc deletedAt).
    const unsubRoomDissolved = subscribeRoomDissolved(room.id, () => {
      onBack();
    });
    return () => {
      unsubMessage();
      unsubEdited();
      unsubDeleted();
      unsubReaction();
      unsubReadReceipt();
      unsubDeliveryReceipt();
      unsubRoomDissolved();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- withSenderName đọc ref, không cần trong deps.
  }, [room.id, identityReady, myAgentId]);

  // Typing indicator (Phase 3, 29/7) — đổi phòng thì reset luôn (tránh hiện chỉ báo "đang gõ" của phòng CŨ
  // sau khi đã chuyển sang phòng khác).
  useEffect(() => {
    setTypingAgentIds(new Set());
    const unsubscribe = subscribeTypingIndicator(room.id, (agentId, isTyping) => {
      setTypingAgentIds((prev) => {
        const next = new Set(prev);
        if (isTyping) next.add(agentId);
        else next.delete(agentId);
        return next;
      });
    });
    return () => {
      unsubscribe();
      setTypingAgentIds(new Set());
    };
  }, [room.id]);

  // "BẢNG TIN" / GHIM NHIỀU (5/8) — tải danh sách tin ghim lúc mở phòng + đồng bộ realtime. `subscribePinsUpdated`
  // nhận NGUYÊN danh sách mới mỗi lần ai đó ghim/bỏ ghim (server phát `pins-updated`) → cập nhật thẳng, KHÔNG
  // cần gọi lại REST. Reset `pins`/`showPinBoard` khi đổi phòng (tránh hiện bảng tin phòng cũ trong khoảnh khắc đầu).
  useEffect(() => {
    if (!identityReady) return;
    let cancelled = false;
    setPins([]);
    setShowPinBoard(false);
    setPinsLoading(true);
    listRoomPins(room.id).then((res) => {
      if (cancelled) return;
      setPinsLoading(false);
      if (res.ok) setPins(res.data);
    });
    const unsub = subscribePinsUpdated(room.id, (nextPins) => {
      setPins(nextPins);
    });
    return () => {
      cancelled = true;
      unsub();
    };
  }, [room.id, identityReady]);

  useEffect(() => {
    // FIX-PERF (4/8) — nếu vừa CHÈN tin cũ lên đầu (cuộn-lên-tải-thêm), GIỮ vị trí đọc: bù đúng phần chiều cao
    // tăng thêm, KHÔNG nhảy xuống đáy. `prependAnchorRef` chỉ được set trong loadOlderMessages() ngay trước khi
    // setMessages chèn đầu — dùng 1 lần rồi clear.
    const anchor = prependAnchorRef.current;
    if (anchor && scrollRef.current) {
      const el = scrollRef.current;
      el.scrollTop = el.scrollHeight - anchor.prevScrollHeight + anchor.prevScrollTop;
      prependAnchorRef.current = null;
      return;
    }
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
    pinnedBottomRef.current = true; // vừa neo đáy — ảnh trong tin load xong đổi chiều cao thì effect dưới giữ đáy.
  }, [messages]);

  // FIX GIẬT 11/9 (Admin Demo "load phòng chat, tin OCR bị bóp hẹp xong load về đúng kích thước, giật giật") — LỚP 2:
  // lớp 1 (giữ chỗ kích thước ảnh — AttachmentImage reserveDims + image-dims-cache.ts) đã khử shift khi kích thước
  // ảnh ĐÃ BIẾT; còn đúng 1 trường hợp máy CHƯA TỪNG thấy ảnh (không có gì để giữ chỗ): ảnh về làm bubble đổi chiều
  // cao → nếu đang đọc ở ĐÁY (vị trí mặc định khi mở phòng) thì đáy bị trôi = màn hình giật. Neo lại: nghe sự kiện
  // `load` của MỌI <img> trong khung tin (capture=true vì load không bubble) — nếu người dùng đang neo đáy thì ghim
  // lại đúng đáy ngay sau khi layout đổi. KHÔNG đụng luồng tải tin nhắn/prependAnchor (cuộn-lên-tải-thêm giữ nguyên).
  const pinnedBottomRef = useRef(true);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onImgLoad = (ev: Event): void => {
      if (!(ev.target instanceof HTMLImageElement)) return;
      if (!pinnedBottomRef.current) return;
      // 2 nhịp rAF: chờ layout sau load ổn định rồi mới ghim (load bắn trước khi reflow paint xong).
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (pinnedBottomRef.current && scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }));
    };
    el.addEventListener('load', onImgLoad, true);
    return () => el.removeEventListener('load', onImgLoad, true);
  }, []);

  // FIX-PERF (4/8) — tải thêm 50 tin CŨ hơn khi kéo lên gần đầu khung. Guard `loadingOlderRef` chặn gọi chồng
  // (onScroll bắn liên tục). Dedup theo id (real-time có thể đã chèn tin trùng). Đặt `prependAnchorRef` NGAY
  // trước setMessages để effect auto-cuộn giữ đúng vị trí đọc (xem effect trên).
  async function loadOlderMessages(): Promise<void> {
    if (loadingOlderRef.current || !hasMoreOlderRef.current) return;
    const oldest = messagesRef.current[0];
    if (!oldest) return;
    const el = scrollRef.current;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const res = await listChatMessages(room.id, { before: oldest.id, limit: 50 });
    if (res.ok) {
      const olderMapped = res.data.messages
        .slice()
        .reverse()
        .map((dto) => withSenderName(mapChatMessage(dto, myAgentId)));
      prependAnchorRef.current = { prevScrollHeight: el?.scrollHeight ?? 0, prevScrollTop: el?.scrollTop ?? 0 };
      setMessages((prev) => {
        const existing = new Set(prev.map((m) => m.id));
        const fresh = olderMapped.filter((m) => !existing.has(m.id));
        if (fresh.length === 0) {
          prependAnchorRef.current = null; // không có gì mới để chèn — bỏ anchor, tránh khôi phục nhầm.
          return prev;
        }
        return [...fresh, ...prev];
      });
      setHasMoreOlder(res.data.hasMore);
      hasMoreOlderRef.current = res.data.hasMore;
    }
    loadingOlderRef.current = false;
    setLoadingOlder(false);
  }

  function handleScroll(): void {
    const el = scrollRef.current;
    if (!el) return;
    // FIX GIẬT 11/9 — theo dõi "đang neo đáy" (≤48px cách đáy): ảnh load xong đổi chiều cao chỉ ghim lại đáy
    // khi người dùng THẬT SỰ đang ở đáy, đang đọc tin cũ phía trên thì KHÔNG cướp vị trí cuộn.
    pinnedBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight <= 48;
    // Gần đỉnh (≤120px) + còn tin cũ + không đang tải → kéo thêm.
    if (el.scrollTop <= 120 && hasMoreOlderRef.current && !loadingOlderRef.current) {
      void loadOlderMessages();
    }
  }

  // DM chỉ có ĐÚNG 1 người còn lại — room.name đã LÀ tên hiển thị của người đó (server/mapChatRoomSummary() tự
  // resolve, xem chat-client.ts), nên dùng thẳng. Nhóm có thể nhiều người gõ cùng lúc — tra tên qua
  // resolveAgentNameRef (danh bạ bạn bè đã tải), fallback "Đại lý #<id>" nếu không tra được.
  const typingLabel =
    typingAgentIds.size === 0
      ? null
      : !room.isGroup
        ? `${room.name} đang soạn tin nhắn...`
        : `${[...typingAgentIds].map((id) => resolveAgentNameRef.current(id) ?? `Đại lý #${id}`).join(', ')} đang soạn tin nhắn...`;

  // "Đã gửi"/"Đã xem" (26/7 B29 → mở rộng 5/8, Bug #1/#3) — nhãn tóm tắt dưới tin nhắn CUỐI CÙNG của DM, GIỜ
  // phản ánh ĐÚNG trạng thái thật (đồng bộ với tick trong bong bóng): đang gửi / gửi lỗi / đã xem (peer đọc) /
  // đã gửi. Chỉ DM (nhóm không hiện). Bỏ tin MOCK cục bộ `local-*` (sticker/vị trí — chưa nối thật). Tin lạc
  // quan `pending-*` (Bug #1) VẪN hiện nhãn ("Đang gửi...") — đó là mục đích.
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const showSentLabel =
    !room.isGroup && !!lastMessage && lastMessage.mine && lastMessage.type !== 'system' && !lastMessage.id.startsWith('local-');
  const sentLabelStatus = lastMessage ? computeMineDisplayStatus(lastMessage, peerReadAtMs, peerDeliveredAtMs) : 'sent';
  const sentLabelText =
    sentLabelStatus === 'sending'
      ? 'Đang gửi...'
      : sentLabelStatus === 'failed'
        ? 'Gửi lỗi'
        : sentLabelStatus === 'seen'
          ? 'Đã xem'
          : sentLabelStatus === 'delivered'
            ? 'Đã nhận'
            : 'Đã gửi';

  // B41 (27/7, Admin Demo báo thật: mở được ĐỒNG THỜI nhiều thanh cảm xúc ở nhiều tin nhắn khác nhau) — CHỈ 1
  // tin được mở thanh cảm xúc tại 1 thời điểm (state nâng lên đây, xem ChatBubble.tsx prop pickerOpen/
  // onSetPickerOpen), bấm ra vùng khác tự đóng — TÁI DÙNG đúng listener `window click` đã có sẵn cho menu
  // ngữ cảnh (closeMenu), gộp thêm việc đóng picker vào cùng 1 chỗ.
  const [openReactionPickerId, setOpenReactionPickerId] = useState<string | null>(null);

  useEffect(() => {
    const closeOverlays = (): void => {
      setMenu(null);
      setOpenReactionPickerId(null);
    };
    window.addEventListener('click', closeOverlays);
    return () => window.removeEventListener('click', closeOverlays);
  }, []);

  // "BẢNG TIN" (5/8) — tin ghim MỚI NHẤT (đầu danh sách, server sắp mới→cũ) hiển thị ở banner trên cùng; bấm
  // banner mở PinBoardPanel xem TOÀN BỘ. `pinnedMessageIds` (Set) để menu ngữ cảnh biết tin đang chọn đã ghim
  // chưa → hiện "Ghim" hay "Bỏ ghim".
  const topPin = pins.length > 0 ? pins[0] : null;
  const pinnedMessageIds = useMemo(() => new Set(pins.map((p) => p.messageId)), [pins]);
  const canManagePins = myRoleInRoom === 'OWNER' || myRoleInRoom === 'ADMIN';

  /** Ghim/bỏ ghim 1 tin (OWNER/ADMIN) từ menu ngữ cảnh. Danh sách `pins` tự cập nhật qua realtime `pins-updated`
   * (server phát sau ghi thành công) — KHÔNG tự setPins ở đây để giữ 1 nguồn sự thật, tránh lệch với realtime. */
  async function togglePin(message: ChatMessage): Promise<void> {
    setPinActionError(null);
    const isPinned = pinnedMessageIds.has(message.id);
    const r = isPinned ? await unpinRoomMessage(room.id, message.id) : await pinRoomMessage(room.id, message.id);
    if (!r.ok) setPinActionError(r.message);
    else setPins(r.data); // cập nhật NGAY từ response (realtime cũng sẽ tới, setPins idempotent theo id).
  }

  /** Bấm 1 tin trong Bảng tin → cuộn/nổi bật tin gốc, tự tải thêm trang cũ nếu chưa có trong DOM (CÙNG cơ chế
   * vòng lặp cursor `before` của jumpToSearchResult/initialJumpToMessageId — tách handler dùng chung). */
  async function jumpToPinnedMessage(messageId: string): Promise<void> {
    setShowPinBoard(false);
    if (jumpToMessage(messageId)) return;
    let known = messages;
    for (let i = 0; i < 10; i++) {
      const oldest = known[0];
      if (!oldest) break;
      const res = await listChatMessages(room.id, { before: oldest.id, limit: 50 });
      if (!res.ok || res.data.messages.length === 0) break;
      const olderMapped = res.data.messages
        .slice()
        .reverse()
        .map((dto) => withSenderName(mapChatMessage(dto, myAgentId)));
      known = [...olderMapped, ...known];
      setMessages(known);
      await new Promise((r) => setTimeout(r, 0));
      if (jumpToMessage(messageId)) return;
    }
  }
  // "Trả lời" (1/8) — tra tin GỐC theo id trong `messages` đã tải (KHÔNG gọi thêm API, xem yêu cầu brief) —
  // Map O(1) thay vì `messages.find()` mỗi bong bóng (tối đa 50 tin/trang, không đáng kể nhưng tránh N×N vô
  // ích khi danh sách dài hơn ở lần tải thêm sau này).
  const messagesById = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  // TICK "đã đọc" (5/8, Bug #3) — resolve con trỏ đọc của peer (`peerLastReadMessageId` lấy lúc mở phòng) sang
  // MỐC THỜI GIAN qua `messagesById` (tin đó nằm trong lịch sử đã tải → có `sentAtIso`). Nâng `peerReadAtMs`
  // lên (không hạ) — read-receipt realtime cũng cộng dồn vào cùng state. Nếu con trỏ đọc của peer trỏ tới tin
  // CŨ hơn cửa sổ đã tải (không có trong messagesById) → bỏ qua (nghĩa là peer CHƯA đọc các tin gần đây → giữ
  // "đã gửi", đúng ngữ nghĩa).
  useEffect(() => {
    if (!peerLastReadMessageId) return;
    const msg = messagesById.get(peerLastReadMessageId);
    if (!msg?.sentAtIso) return;
    const ms = new Date(msg.sentAtIso).getTime();
    if (Number.isNaN(ms)) return;
    setPeerReadAtMs((prev) => (prev == null || ms > prev ? ms : prev));
  }, [peerLastReadMessageId, messagesById]);

  // TICK "đã đọc" (5/8, Bug #3) — áp trạng thái hiển thị cho tin CỦA MÌNH: sentAt ≤ `peerReadAtMs` → "đã xem"
  // (2 tick xanh). GIỮ NGUYÊN 'sending'/'failed' (lạc quan, Bug #1) và tin không phải của mình/tin hệ thống.
  // Tin chưa được đọc → giữ nguyên 'sent' (1 tick). Nhóm/`peerReadAtMs`=null → mọi tin chỉ "đã gửi".
  function withDisplayStatus(m: ChatMessage): ChatMessage {
    const status = computeMineDisplayStatus(m, peerReadAtMs, peerDeliveredAtMs);
    return status === m.status ? m : { ...m, status };
  }

  // BUG THẬT (1/8, Admin Demo "bấm vào tin nhắn trả lời... không trôi lên tin nhắn được trả lời như Zalo") —
  // ChatBubble.tsx trước đây KHÔNG có onClick nào cho khối trích dẫn. Cuộn + nổi bật đặt Ở ĐÂY (không phải
  // ChatBubble.tsx) vì cần truy cập DOM của TOÀN danh sách tin nhắn (`document.getElementById`, id gắn ở
  // ChatBubble.tsx `msg-${message.id}`) — 1 bong bóng không tự biết vị trí bong bóng KHÁC trong danh sách.
  const [highlightedMessageId, setHighlightedMessageId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  function jumpToMessage(messageId: string): boolean {
    const el = document.getElementById(`msg-${messageId}`);
    if (!el) return false; // KHÔNG có trong DOM — chưa tải tới (tin quá cũ, xem effect initialJumpToMessageId/searchJumpTo bên dưới tự tải thêm).
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    // Ép replay animation kể cả khi bấm lên/xuống trỏ lại CÙNG tin (Admin Demo "click/mũi tên tới kết quả → nổi
    // lên"): xóa rồi set lại ở frame kế → class `msg-jump-highlight` gỡ+gắn lại → animation nảy-sáng chạy lại.
    setHighlightedMessageId(null);
    requestAnimationFrame(() => setHighlightedMessageId(messageId));
    highlightTimerRef.current = setTimeout(() => setHighlightedMessageId(null), 1900); // khớp animation 1.8s.
    return true;
  }
  useEffect(() => {
    return () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  // B107 (2/8, Admin Demo báo trực tiếp: "mở ra không trỏ cuộn đúng đến tin nhắn đấy") — cuộn/nổi bật ĐÚNG tin
  // nhắn `initialJumpToMessageId` (từ panel tìm kiếm toàn cục) NGAY sau khi lịch sử tải xong. Chỉ 50 tin GẦN
  // NHẤT được tải ban đầu (xem effect trên) — tin tìm kiếm ra CÓ THỂ cũ hơn → tự tải thêm TỐI ĐA 10 trang
  // (500 tin) qua cursor `before` cho tới khi thấy hoặc hết giới hạn (tránh vòng lặp vô hạn nếu tin đã bị xóa
  // giữa lúc tìm kiếm và lúc mở phòng — trường hợp hiếm nhưng phải có chặn). `jumpAttemptedRef` đảm bảo CHỈ
  // thử 1 LẦN cho 1 giá trị prop (đổi phòng/nhận tin mới không kích hoạt lại).
  const jumpAttemptedRef = useRef<string | null>(null);
  const [jumpNotFoundNotice, setJumpNotFoundNotice] = useState(false);
  useEffect(() => {
    if (!initialJumpToMessageId || loadingHistory) return;
    if (jumpAttemptedRef.current === initialJumpToMessageId) return;
    jumpAttemptedRef.current = initialJumpToMessageId;
    let cancelled = false;

    async function attempt(): Promise<void> {
      if (jumpToMessage(initialJumpToMessageId!)) return;
      // Biến cục bộ theo dõi "tin cũ nhất hiện có" xuyên suốt vòng lặp — KHÔNG đọc lại state `messages` (closure
      // cũ, không phản ánh các lần setMessages vừa gọi trong CHÍNH vòng lặp này) — chỉ setMessages() để RENDER,
      // vòng lặp tự quản lý mảng cục bộ riêng.
      let known = messages;
      const MAX_PAGES = 10;
      for (let i = 0; i < MAX_PAGES; i++) {
        if (cancelled) return;
        const oldest = known[0];
        if (!oldest) break;
        // FIX-PERF (4/8) — cursor `before` PHẢI là id tin nhắn (server findUnique theo id + lọc roomId, xem
        // listMessages() chat-message-service.ts). TRƯỚC ĐÂY truyền `oldest.sentAtIso` (ISO timestamp) → server
        // KHÔNG tìm thấy id đó → luôn throw VALIDATION "before không tồn tại" → tải tin cũ HỎNG (nhảy tới tin
        // tìm kiếm cũ hơn 50 tin gần nhất không bao giờ hoạt động). Đúng: `oldest.id`.
        const res = await listChatMessages(room.id, { before: oldest.id, limit: 50 });
        if (cancelled || !res.ok || res.data.messages.length === 0) break;
        const olderMapped = res.data.messages
          .slice()
          .reverse()
          .map((dto) => withSenderName(mapChatMessage(dto, myAgentId)));
        known = [...olderMapped, ...known];
        setMessages(known);
        await new Promise((r) => setTimeout(r, 0)); // nhường 1 tick cho React render trước khi getElementById lần sau.
        if (jumpToMessage(initialJumpToMessageId!)) return;
      }
      if (!cancelled) setJumpNotFoundNotice(true);
    }
    void attempt();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- withSenderName/messagesRef đọc ref, không cần vào deps.
  }, [initialJumpToMessageId, loadingHistory, room.id, myAgentId]);

  // B107 (2/8, Admin Demo yêu cầu trực tiếp: "trong tất cả các mục tìm kiếm phải có đếm số tin nhắn tìm được,
  // mũi tên để chạm... 15/15 14/15... tìm trực tiếp trong khung chat 1-1 hay nhóm") — tìm kiếm NGAY TRONG
  // phòng đang mở, kiểu Zalo: gõ → debounce 300ms gọi `searchChatMessages(q, room.id)` (route mới B107) →
  // danh sách kết quả sắp MỚI NHẤT TRƯỚC (nguyên trạng server trả) → bộ đếm "vị trí hiện tại/tổng số" + nút
  // mũi tên lên/xuống duyệt qua từng kết quả, mỗi lần chuyển tự cuộn+nổi bật ĐÚNG tin đó (tái dùng
  // jumpToMessage() — tự tải thêm trang cũ hơn nếu tin chưa có trong DOM, CÙNG cơ chế initialJumpToMessageId
  // ở trên, không viết lại lần 2).
  const [inRoomSearchOpen, setInRoomSearchOpen] = useState(false);
  const [inRoomSearchQuery, setInRoomSearchQuery] = useState('');
  const [inRoomSearchResults, setInRoomSearchResults] = useState<MessageSearchHitDto[]>([]);
  const [inRoomSearchIndex, setInRoomSearchIndex] = useState(0); // 0 = kết quả MỚI NHẤT (đầu mảng).
  const [inRoomSearchLoading, setInRoomSearchLoading] = useState(false);

  useEffect(() => {
    const q = inRoomSearchQuery.trim();
    if (!q) {
      setInRoomSearchResults([]);
      setInRoomSearchLoading(false);
      return;
    }
    let cancelled = false;
    setInRoomSearchLoading(true);
    const timer = setTimeout(() => {
      searchChatMessages(q, room.id).then((res) => {
        if (cancelled) return;
        setInRoomSearchLoading(false);
        if (res.ok) {
          setInRoomSearchResults(res.data);
          setInRoomSearchIndex(0);
        }
      });
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [inRoomSearchQuery, room.id]);

  /** Nhảy tới kết quả tìm kiếm trong phòng theo `index` — tự tải thêm trang cũ hơn nếu tin chưa có trong DOM
   * (CÙNG cơ chế vòng lặp `before` cursor đã viết cho initialJumpToMessageId, tách hàm dùng CHUNG). */
  async function jumpToSearchResult(index: number): Promise<void> {
    const hit = inRoomSearchResults[index];
    if (!hit) return;
    setInRoomSearchIndex(index);
    if (jumpToMessage(hit.messageId)) return;
    let known = messages;
    for (let i = 0; i < 10; i++) {
      const oldest = known[0];
      if (!oldest) break;
      // FIX-PERF (4/8) — cursor `before` = id tin nhắn, KHÔNG phải sentAtIso (xem comment ở attempt() trên).
      const res = await listChatMessages(room.id, { before: oldest.id, limit: 50 });
      if (!res.ok || res.data.messages.length === 0) break;
      const olderMapped = res.data.messages
        .slice()
        .reverse()
        .map((dto) => withSenderName(mapChatMessage(dto, myAgentId)));
      known = [...olderMapped, ...known];
      setMessages(known);
      await new Promise((r) => setTimeout(r, 0));
      if (jumpToMessage(hit.messageId)) return;
    }
  }

  // Gửi tin nhắn THẬT (POST /v1/chat/rooms/:roomId/messages, hệ chat lõi mới — Phase 3 cutover). KHÔNG tự
  // thêm vào `messages` ở đây — subscribeRoomMessages() ở trên sẽ đẩy tin về qua WebSocket mới (server broadcast
  // KHÔNG loại trừ sender, xem chat-realtime-hub.ts), tránh trùng lặp bong bóng nếu vừa append cục bộ vừa nhận
  // qua real-time.
  // Audit độc lập 26/7 (finding HIGH, xem BUGS_FIXED.md, vẫn áp dụng sau Phase 3): trả `boolean` (true=thành
  // công) để MessageComposer.submit() biết dừng vòng lặp NGAY khi 1 đoạn lỗi (tin dài tự tách nhiều đoạn),
  // giữ lại các đoạn CHƯA gửi trong ô nhập thay vì mất dữ liệu âm thầm.
  // "Trả lời" (1/8) — đọc `replyingTo` NGAY lúc gọi (không phụ thuộc closure cũ) rồi truyền `replyToMessageId`
  // vào body gửi (`SendChatMessageInput.replyToMessageId` đã có sẵn ở chat-client.ts, server cũng đã nhận
  // field này từ trước — routes/chat.ts POST .../messages). Tin dài tự tách nhiều đoạn (splitMessageIntoChunks,
  // MessageComposer.tsx) gọi `send()` TUẦN TỰ nhiều lần cho 1 lần bấm gửi — CHỈ đoạn ĐẦU TIÊN mang
  // `replyToMessageId` (clear `replyingTo` ngay sau khi đoạn đầu thành công) — hợp lý vì "trả lời" là 1 quan hệ
  // giữa 2 tin nhắn, không có ý nghĩa gắn lặp lại cho từng đoạn bị tách của CÙNG 1 lần gửi.
  async function send(text: string, mentions?: MentionDraft[]): Promise<boolean> {
    setSendError(null);
    const replyToMessageId = replyingTo?.id;
    // Tag @ mention (13/8) — dựng metadataJson {mentions:[agentId...], mentionNames:[tên...]} khi đoạn này có
    // nhắc ai (server đọc `mentions` tạo thông báo MENTION; FE tô đậm `mentionNames`). Rỗng → undefined (GIỮ
    // NGUYÊN tin thường). Lọc thêm chỉ giữ mention CÒN là thành viên phòng (server cũng tự validate lại lần nữa).
    const mentionMemberIds = new Set(mentionMembers.map((m) => m.agentId));
    const activeMentions = (mentions ?? []).filter((m) => mentionMemberIds.has(m.agentId));
    const mentionMetadataJson = activeMentions.length > 0 ? buildMentionMetadataJson(activeMentions) ?? undefined : undefined;
    const mentionNames = activeMentions.length > 0 ? activeMentions.map((m) => m.name) : undefined;
    // Bug #1 (5/8, Admin Demo "tin nhắn vừa gửi KHÔNG hiện ngay — phải thoát ra vào lại mới thấy") — APPEND LẠC
    // QUAN NGAY (kiểu Zalo): tin của mình hiện tức thì trạng thái "đang gửi" (đồng hồ), KHÔNG phụ thuộc WS echo
    // hay round-trip REST. Khi server xác nhận → thay bằng tin THẬT (id server) + "đã gửi" (1 tick); lỗi → "gửi
    // lỗi" (chấm than) GIỮ LẠI bong bóng để người dùng biết cần thử lại (không mất chữ âm thầm).
    seq += 1;
    const optimisticId = `pending-${seq}`;
    const optimistic: ChatMessage = {
      id: optimisticId,
      roomId: room.id,
      senderId: myAgentId != null ? String(myAgentId) : CURRENT_AGENT.id,
      senderName: '',
      mine: true,
      type: 'text',
      text,
      time: 'Vừa xong',
      status: 'sending',
      sentAtIso: new Date().toISOString(),
      replyToMessageId,
      mentions: mentionNames // Tag @ mention — bong bóng lạc quan tô đậm ngay, không đợi WS echo.
    };
    setMessages((prev) => [...prev, optimistic]);
    const res = await sendChatMessage(room.id, { kind: 'TEXT', body: text, replyToMessageId, metadataJson: mentionMetadataJson });
    if (!res.ok) {
      setSendError(res.message);
      setMessages((prev) => prev.map((m) => (m.id === optimisticId ? { ...m, status: 'failed' } : m)));
      return false;
    }
    // Hòa giải với WS echo (server broadcast `new-message` cho CẢ sender, xem effect real-time trên): thêm id
    // THẬT vào `seenMessageIdsRef` để upsert KHÔNG append trùng + KHÔNG phát âm cho tin của chính mình. Thay bong
    // bóng lạc quan bằng tin thật; nếu WS echo TỚI TRƯỚC (id thật đã có trong danh sách) → chỉ bỏ bong bóng lạc
    // quan (tránh nhân đôi).
    const real = withSenderName(mapChatMessage(res.data, myAgentId));
    seenMessageIdsRef.current.add(real.id);
    setMessages((prev) => reconcileSentMessage(prev, optimisticId, real));
    if (replyToMessageId) setReplyingTo(null);
    return true;
  }

  // 27/7 ("Phần 1" kế hoạch đính kèm), Phase 3 (29/7) cutover — đính kèm ảnh/file THẬT qua hệ chat lõi mới.
  // MessageComposer.tsx tự lo bước UPLOAD file (Camera/input file + uploadChatAttachment(), rc-realtime.ts —
  // hạ tầng upload dùng chung, KHÔNG phải giao thức RC, xem import đầu file) rồi gọi hàm này — CHỈ lo bước GỬI
  // TIN NHẮN THẬT tham chiếu `attachmentId` (KHÔNG còn marker text kiểu RC cũ — hệ mới có field `attachmentId`
  // riêng trong ChatMessage, xem chat-message-service.ts sendMessage()). KHÔNG tự thêm vào `messages` state ở
  // đây — CÙNG nguyên tắc send() ở trên, để subscribeRoomMessages() đẩy tin về real-time (mapChatMessage() tự
  // nhận diện kind IMAGE/FILE + attachmentId và render đúng, xem chat-client.ts).
  // 31/7 (việc #5) — mở rộng `kind` thêm `'voice'` + tham số `durationSeconds` (đo WALL-CLOCK thật lúc ghi âm,
  // xem MessageComposer.tsx handleRecordClick()) → gửi `kind:'VOICE'` + `metadataJson:{durationMs}` (ĐÚNG shape
  // đã ghi sẵn trong comment schema.prisma `ChatMessage.metadataJson`, KHÔNG tự bịa field mới). `body` bỏ trống
  // cho voice (KHÔNG có caption, khác IMAGE/FILE — server không bắt buộc body ngoài kind='TEXT', xem
  // chat-message-service.ts sendMessage()).
  // 1/8 — mở rộng thêm `caption` (luồng "Quét bill" mới, xem MessageComposer.tsx handleConfirmBillSend() +
  // OcrBillPreview.tsx): số tiền OCR đã người dùng xác nhận, dùng làm `body` THAY `fileName` khi có giá trị —
  // `undefined` (luồng ảnh/file/voice cũ) GIỮ NGUYÊN hành vi cũ 100%.
  async function sendAttachment(
    upload: UploadedChatAttachment,
    kind: 'image' | 'file' | 'voice',
    fileName: string,
    mimeType: string,
    sizeBytes: number,
    durationSeconds?: number,
    caption?: string,
    // B112 (2/8) — CHỈ có giá trị cho bill ĐÃ GHÉP (xem docstring onSendAttachment MessageComposer.tsx) — lưu
    // ĐẦY ĐỦ vào metadataJson (billFields/amount/imageHeightPx) để "Sửa" sau này KHÔNG cần chạy lại OCR.
    billMeta?: BillMessageMeta
  ): Promise<boolean> {
    setSendError(null);
    // `mimeType`/`sizeBytes` KHÔNG cần gửi kèm nữa (khác marker JSON RC cũ) — server tự đọc lại từ
    // ChatAttachment đã lưu (magic-bytes sniff lúc upload, xem chat-attachment-service.ts). Giữ 2 tham số này
    // trong chữ ký hàm để KHÔNG đổi prop `onSendAttachment` của MessageComposer.tsx (dùng chung, không sửa).
    void mimeType;
    void sizeBytes;
    const kindMap: Record<'image' | 'file' | 'voice', ChatMessageDto['kind']> = { image: 'IMAGE', file: 'FILE', voice: 'VOICE' };
    // B106 (2/8) — `caption` CHỈ có giá trị cho luồng "Quét bill" (xem docstring uploadAndSend() MessageComposer.tsx
    // "CHỈ có nghĩa cho luồng Quét bill mới") — tái dùng tín hiệu SẴN CÓ này để đánh dấu isBillImage. B112
    // (2/8) — có `billMeta` (ảnh ĐÃ GHÉP) → lưu metadata ĐẦY ĐỦ qua `buildBillMetadataJson()` (bill-message-
    // meta.ts, NGUỒN DUY NHẤT build shape này, dùng lại y hệt lúc "Sửa") THAY cho `{isBillImage:true}` cụt cũ —
    // bill fallback ảnh gốc chưa ghép (`caption != null` nhưng `billMeta` undefined) GIỮ NGUYÊN hành vi B106 cũ
    // (KHÔNG sửa được sau này, đúng thiết kế — xem comment `onConfirm` OcrBillPreview.tsx).
    const metadataJson =
      kind === 'voice' && durationSeconds != null
        ? JSON.stringify({ durationMs: Math.max(0, Math.round(durationSeconds * 1000)) })
        : kind === 'image' && billMeta != null
          ? buildBillMetadataJson(billMeta)
          : kind === 'image' && caption != null
            ? JSON.stringify({ isBillImage: true })
            : undefined;
    const res = await sendChatMessage(room.id, {
      kind: kindMap[kind],
      attachmentId: upload.id,
      body: kind === 'voice' ? undefined : (caption ?? fileName),
      metadataJson
    });
    if (!res.ok) {
      setSendError(res.message);
      return false;
    }
    // Best-effort, KHÔNG đợi/KHÔNG chặn UI — xem docstring attachRoomToChatAttachment() (rc-realtime.ts, hạ
    // tầng dùng chung, KHÔNG phải RC transport).
    void attachRoomToChatAttachment(upload.id, room.id);
    return true;
  }

  /** Lỗi Ở TẦNG UPLOAD (quá 50MB/sai định dạng/mạng lỗi/Camera không mở được) — xảy ra TRƯỚC khi có attachment
   * id, nên KHÔNG đi qua sendAttachment() ở trên (xem prop `onAttachError` MessageComposer.tsx). Tái dùng
   * ĐÚNG banner lỗi `sendError` đã có — người dùng không cần phân biệt nguồn lỗi. */
  function handleAttachError(message: string): void {
    setSendError(message);
  }

  function shareLocation(): void {
    seq += 1;
    setMessages((prev) => [
      ...prev,
      {
        id: `local-${seq}`,
        roomId: room.id,
        senderId: CURRENT_AGENT.id,
        senderName: CURRENT_AGENT.name,
        mine: true,
        type: 'location',
        time: 'Vừa xong',
        status: 'sent',
        location: { lat: 10.762622, lng: 106.660172, label: 'Vị trí hiện tại của tôi' }
      }
    ]);
  }

  // Mục 38 — gửi sticker (Phase 0: tin text emoji to).
  function sendSticker(emoji: string): void {
    seq += 1;
    setMessages((prev) => [
      ...prev,
      {
        id: `local-sticker-${seq}`,
        roomId: room.id,
        senderId: CURRENT_AGENT.id,
        senderName: CURRENT_AGENT.name,
        mine: true,
        type: 'text',
        text: emoji,
        time: 'Vừa xong',
        status: 'sent'
      }
    ]);
  }

  // Mục 29 — thả cảm xúc (Phase 3 cutover, 29/7) — gọi THẬT `POST /v1/chat/messages/:id/reactions`. Server tự
  // xử lý toggle add/remove/changed (bấm lại đúng emoji đã thả = bỏ thích, xem toggleReaction() chat-reaction-
  // service.ts) — KHÔNG cần code ở đây tự phân biệt add/remove, chỉ gọi 1 hàm addChatReaction() cho MỌI lần
  // bấm. KHÔNG tự cập nhật `messages` state ở đây (CÙNG nguyên tắc send()) — subscribeReactionUpdate() ở trên
  // sẽ đẩy kết quả về qua WebSocket (GAP đã biết: badge chỉ phản ánh sự kiện MỚI NHẤT, xem comment effect đó).
  async function react(message: ChatMessage, emoji: string): Promise<void> {
    const res = await addChatReaction(message.id, emoji);
    if (!res.ok) {
      setActionError(`Thả cảm xúc thất bại: ${res.message}`);
    }
  }

  // ── Xóa THẬT (mục 5, 24/7; Phase 3 gộp còn 1 hành động — xem comment đầu file) — gọi hệ chat lõi mới qua
  // chat-client.ts. KHÔNG dựa vào real-time WS đẩy về để cập nhật UI của CHÍNH thao tác này (dù effect
  // subscribeMessageDeleted() ở trên CŨNG sẽ nhận được sự kiện ngay sau, patch state THEO CÙNG CÁCH — 2 nguồn
  // hội tụ an toàn nhờ cùng field `m.id` match) — cập nhật state cục bộ NGAY sau khi server xác nhận thành
  // công để phản hồi UI tức thì, không đợi round-trip WebSocket.
  async function performDeleteOne(message: ChatMessage): Promise<void> {
    setActionBusy(true);
    setActionError(null);
    const r = await deleteChatMessage(message.id);
    setActionBusy(false);
    if (!r.ok) {
      setActionError(`Xóa tin nhắn thất bại: ${r.message}`);
      return;
    }
    setMessages((prev) => prev.map((m) => (m.id === message.id ? { ...m, type: 'system', text: DELETED_MESSAGE_TEXT_VI, pinned: false } : m)));
    setConfirmDeleteOne(null);
    setMenu(null);
  }

  async function performDeleteBulk(): Promise<void> {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    setActionBusy(true);
    setActionError(null);
    const results = await Promise.all(ids.map((id) => deleteChatMessage(id)));
    setActionBusy(false);
    const succeededIds = new Set(ids.filter((_, i) => results[i].ok));
    const failedCount = ids.length - succeededIds.size;
    setMessages((prev) => prev.map((m) => (succeededIds.has(m.id) ? { ...m, type: 'system', text: DELETED_MESSAGE_TEXT_VI, pinned: false } : m)));
    setSelectedIds(new Set());
    setSelectMode(false);
    setConfirmDeleteBulk(false);
    if (failedCount > 0) {
      setActionError(`Xóa thành công ${succeededIds.size}/${ids.length} tin nhắn — ${failedCount} tin thất bại (thử lại nếu cần).`);
    }
  }

  function toggleSelectMode(): void {
    setSelectMode((v) => !v);
    setSelectedIds(new Set());
    setMenu(null);
  }

  function toggleSelect(message: ChatMessage): void {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(message.id)) next.delete(message.id);
      else next.add(message.id);
      return next;
    });
  }

  function confirmForward(target: ChatRoom): void {
    if (!forwardTarget) return;
    seq += 1;
    MESSAGES_BY_ROOM[target.id] = [
      ...(MESSAGES_BY_ROOM[target.id] ?? []),
      { ...forwardTarget, id: `fwd-${seq}`, roomId: target.id, mine: target.id === room.id, time: 'Vừa xong', status: 'sent' }
    ];
    setForwardTarget(null);
  }

  /** Việc 2 (1/8) — mở lightbox từ 1 ảnh bấm TRONG khung chat (ChatBubble onImageClick). Dựng danh sách điều
   * hướng từ `messages` ĐÃ TẢI trong state (ưu tiên cách đơn giản theo đúng brief, KHÔNG gọi thêm API) — lọc
   * đúng tin `type==='image'`, GIỮ NGUYÊN thứ tự `messages` (đã đảo cũ→mới lúc tải, xem effect lịch sử phía
   * trên) nên index+1 = ảnh mới hơn, khớp quy ước swipe bên dưới. */
  function openLightboxFromMessage(msg: ChatMessage): void {
    const items = messages.filter((m) => m.type === 'image').map((m) => ({ key: m.id, imageUrl: m.imageUrl }));
    const index = items.findIndex((it) => it.key === msg.id);
    setLightboxZoomed(false); // mở ảnh mới luôn bắt đầu ở trạng thái fit (chưa zoom).
    setLightbox({ items, index: index === -1 ? 0 : index });
  }

  /** Việc 1+2 (1/8) — mở lightbox từ lưới "Ảnh" GroupInfoPanel.tsx (onOpenPhoto). `photos` tới từ API
   * attachments (backend trả desc — mới nhất trước, xem listRoomAttachments() chat-message-service.ts) nên
   * PHẢI đảo lại thành cũ→mới trước khi dựng `items`, GIỮ ĐÚNG cùng quy ước index như openLightboxFromMessage
   * ở trên (index+1 = mới hơn) — 1 lightbox, 1 quy ước điều hướng duy nhất dù mở từ nguồn nào. */
  function openLightboxFromAttachments(photos: ChatRoomAttachmentDto[], clickedAttachmentId: string): void {
    const ascending = [...photos].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    const items = ascending.map((p) => ({ key: p.attachmentId, imageUrl: chatAttachmentDownloadUrl(p.attachmentId) }));
    const index = items.findIndex((it) => it.key === clickedAttachmentId);
    setLightboxZoomed(false); // mở ảnh mới luôn bắt đầu ở trạng thái fit (chưa zoom).
    setLightbox({ items, index: index === -1 ? 0 : index });
  }

  function lightboxGoPrev(): void {
    setLightbox((lb) => (lb && lb.index > 0 ? { ...lb, index: lb.index - 1 } : lb));
  }

  function lightboxGoNext(): void {
    setLightbox((lb) => (lb && lb.index < lb.items.length - 1 ? { ...lb, index: lb.index + 1 } : lb));
  }

  /** Vuốt chạm (mobile, KHÔNG cài thêm thư viện — đo delta X thuần `onTouchStart`/`onTouchEnd` theo đúng ràng
   * buộc brief). Ngưỡng 50px tránh nhận nhầm chạm nhẹ/rung tay thành vuốt. Quy ước Zalo: vuốt TRÁI (ngón tay
   * di từ phải sang trái, deltaX âm) = "tiến tới" = ảnh SAU/mới hơn; vuốt PHẢI = ảnh TRƯỚC/cũ hơn. */
  function handleLightboxTouchStart(e: React.TouchEvent): void {
    // Đang zoom hoặc chạm 2 ngón (pinch) → KHÔNG coi là vuốt điều hướng.
    if (lightboxZoomed || e.touches.length > 1) {
      lightboxTouchStartXRef.current = null;
      return;
    }
    lightboxTouchStartXRef.current = e.touches[0]?.clientX ?? null;
  }

  function handleLightboxTouchEnd(e: React.TouchEvent): void {
    const startX = lightboxTouchStartXRef.current;
    lightboxTouchStartXRef.current = null;
    if (startX === null || lightboxZoomed) return;
    const endX = e.changedTouches[0]?.clientX ?? startX;
    const deltaX = endX - startX;
    const SWIPE_THRESHOLD_PX = 50;
    if (Math.abs(deltaX) < SWIPE_THRESHOLD_PX) return;
    if (deltaX < 0) lightboxGoNext();
    else lightboxGoPrev();
  }

  // Việc 2 (1/8) — bàn phím desktop (progressive enhancement, mũi tên trái/phải điều hướng + Esc đóng), CHỈ
  // đăng ký listener khi lightbox đang mở (tránh bắt phím ngoài ý muốn lúc màn hình chat bình thường).
  useEffect(() => {
    if (!lightbox) return;
    function onKeyDown(e: KeyboardEvent): void {
      if (e.key === 'ArrowLeft') lightboxGoPrev();
      else if (e.key === 'ArrowRight') lightboxGoNext();
      else if (e.key === 'Escape') setLightbox(null);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- lightboxGoPrev/Next đọc state qua functional setLightbox (không cần liệt kê), chỉ cần re-run khi TRẠNG THÁI MỞ/ĐÓNG đổi (lightbox null↔non-null), không phải mỗi lần index đổi.
  }, [lightbox !== null]);

  return (
    <div className="relative flex h-full flex-col bg-appbg">
      <div className="flex items-center gap-1 border-b border-line bg-white px-2 py-2.5 sm:gap-3 sm:px-3">
        <BackButton variant="icon-only" onClick={onBack} className="shrink-0 lg:hidden" />
        {/* Avatar ĐỒNG BỘ (8/8) — RoomAvatar dùng CHUNG: DIRECT hiện ẢNH đối phương; GROUP ĐÃ đặt ảnh hiện ẢNH
            NHÓM thật (thay vòng tròn màu cũ, đồng bộ với GroupInfoPanel/danh sách), chưa đặt → vòng tròn màu + chữ
            cái đầu (groupFallback="initial" giữ đúng hiển thị header cũ). */}
        <RoomAvatar room={room} size={36} groupFallback="initial" />
        {/* Lane D vòng 2 (3/8) — `min-w-0` cho phép cụm tên co xuống dưới min-content (mặc định flex item
            min-width:auto KHÔNG co, gây wrap), `truncate` (overflow-hidden + text-ellipsis + whitespace-nowrap)
            giữ tên + trạng thái mỗi thứ ĐÚNG 1 dòng, cắt "…" khi tràn thay vì đổ dọc làm cao header. */}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-800">{room.name}</div>
          {/* Presence THẬT (6/8) — DIRECT: "Đang hoạt động"/"X phút trước" của đối phương (presence-store LIVE + seed
              từ room detail), thay dòng "Đang hoạt động" HARDCODE cũ (luôn xanh, sai). GROUP: không có presence →
              ẩn (không bịa). */}
          {room.otherAgentId != null && (
            <PresenceStatusText agentId={room.otherAgentId} online={null} className="block truncate text-xs" />
          )}
        </div>
        {/* Cụm icon `shrink-0` — KHÔNG BAO GIỜ bị ép co/xuống dòng; luôn nằm gọn 1 hàng bên phải. */}
        <div className="flex shrink-0 items-center gap-0.5 sm:gap-1">
          {/* Mục 28 — gọi thoại/gọi video. fix-call-wiring (31/7): Phase 4 (WebRTC thật) CHỈ làm gọi 1-1 (xem
              comment đầu CallScreen.tsx/call-signaling-server.ts) — ẩn hẳn cho phòng GROUP thay vì để bấm được
              rồi im lặng không làm gì. Gọi thoại GIỮ hiển thị mọi breakpoint; gọi video dồn vào menu "⋯" ở <sm
              (Lane D vòng 2) để header hẹp còn chỗ cho tên. */}
          {!room.isGroup && (
            <button
              onClick={() => onStartCall?.('voice', callPeerAgentId ?? undefined)}
              title="Gọi thoại"
              aria-label="Gọi thoại"
              className="rounded-full p-1.5 text-slate-500 hover:bg-appbg hover:text-brand sm:p-2"
            >
              <Phone className="h-5 w-5" />
            </button>
          )}
          {!room.isGroup && (
            <button
              onClick={() => onStartCall?.('video', callPeerAgentId ?? undefined)}
              title="Gọi video"
              aria-label="Gọi video"
              className="hidden rounded-full p-2 text-slate-500 hover:bg-appbg hover:text-brand sm:inline-flex"
            >
              <Video className="h-5 w-5" />
            </button>
          )}
          {/* B107 (2/8) — tìm kiếm NGAY TRONG phòng đang mở, kiểu Zalo (có bộ đếm + điều hướng lên/xuống, xem
              thanh tìm kiếm bên dưới header). GIỮ hiển thị mọi breakpoint (hành động chính hay dùng). */}
          <button
            onClick={() => setInRoomSearchOpen((v) => !v)}
            title="Tìm trong hội thoại"
            aria-label="Tìm trong hội thoại"
            className={'rounded-full p-1.5 hover:bg-appbg sm:p-2 ' + (inRoomSearchOpen ? 'text-brand' : 'text-slate-500 hover:text-brand')}
          >
            <Search className="h-5 w-5" />
          </button>
          {/* Nút DOANH SỐ nhanh (Admin Demo 21/8 "nút doanh số cạnh nút tìm kiếm để tắt nhanh") — CHỈ nhóm, ngay cạnh
              Tìm kiếm → mở thẳng doanh số phòng, khỏi vào panel Thông tin. GIỮ mọi breakpoint (hành động hay dùng). */}
          {room.isGroup && onOpenRevenue && (
            <button
              onClick={onOpenRevenue}
              title="Doanh số nhóm"
              aria-label="Doanh số nhóm"
              className="rounded-full p-1.5 text-slate-500 hover:bg-appbg hover:text-brand sm:p-2"
            >
              <Banknote className="h-5 w-5" />
            </button>
          )}
          {/* Lối tắt THÊM THÀNH VIÊN (Admin Demo 8/8) — CHỈ nhóm, ngay BÊN PHẢI icon Tìm kiếm. Bấm → mở info panel +
              tự bật modal thêm thành viên (tăng addMembersSignal). GIỮ mọi breakpoint (hành động hay dùng). */}
          {room.isGroup && (
            <button
              onClick={() => { setPendingAddMembers(true); setShowInfo(true); }}
              title="Thêm thành viên"
              aria-label="Thêm thành viên"
              className="rounded-full p-1.5 text-slate-500 hover:bg-appbg hover:text-brand sm:p-2"
            >
              <UserRoundPlus className="h-5 w-5" />
            </button>
          )}
          {/* Panel thông tin nhóm (25/7) — thành viên/file đã gửi/lọc tin nhắn + quản lý vai trò. Dồn vào "⋯" ở <sm. */}
          <button
            onClick={() => { setPendingAddMembers(false); setShowInfo(true); }}
            title="Thông tin hội thoại"
            aria-label="Thông tin hội thoại"
            className={'hidden rounded-full p-2 hover:bg-appbg sm:inline-flex ' + (showInfo ? 'text-brand' : 'text-slate-500 hover:text-brand')}
          >
            <Info className="h-5 w-5" />
          </button>
          {/* "Tạo nhóm chat cùng người này" (30/7) — CHỈ phòng DIRECT (canCreateGroupFromRoom): biến 1-1 thành
              nhóm mới bằng cách chọn thêm bạn bè. Dồn vào "⋯" ở <sm giống Info/chọn-nhiều. */}
          {canCreateGroupFromRoom(room) && (
            <button
              onClick={() => setShowCreateGroup(true)}
              title="Tạo nhóm chat cùng người này"
              aria-label="Tạo nhóm chat cùng người này"
              className="hidden rounded-full p-2 text-slate-500 hover:bg-appbg hover:text-brand sm:inline-flex"
            >
              <UsersRound className="h-5 w-5" />
            </button>
          )}
          {/* Mục 5 (24/7) — bật/tắt chế độ chọn nhiều tin nhắn CỦA MÌNH để xóa hàng loạt. Dồn vào "⋯" ở <sm. */}
          <button
            onClick={toggleSelectMode}
            title={selectMode ? 'Thoát chọn nhiều' : 'Chọn nhiều để xóa'}
            aria-label={selectMode ? 'Thoát chọn nhiều' : 'Chọn nhiều để xóa'}
            className={'hidden rounded-full p-2 hover:bg-appbg sm:inline-flex ' + (selectMode ? 'text-brand' : 'text-slate-500 hover:text-brand')}
          >
            <ListChecks className="h-5 w-5" />
          </button>
          {/* Lane D vòng 2 (3/8) — menu "⋯" CHỈ hiện ở <sm (sm:hidden): chứa video (nếu DIRECT) + thông tin +
              chọn nhiều, giữ header hẹp gọn 1 hàng. Backdrop trong suốt để chạm ngoài là đóng. */}
          <div className="relative sm:hidden">
            <button
              onClick={() => setHeaderMenuOpen((v) => !v)}
              title="Thêm"
              aria-label="Thêm"
              aria-haspopup="menu"
              aria-expanded={headerMenuOpen}
              className={'rounded-full p-1.5 hover:bg-appbg sm:p-2 ' + (headerMenuOpen ? 'text-brand' : 'text-slate-500 hover:text-brand')}
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>
            {headerMenuOpen && (
              <>
                <button aria-hidden tabIndex={-1} onClick={() => setHeaderMenuOpen(false)} className="fixed inset-0 z-10 cursor-default" />
                <div role="menu" className="absolute right-0 top-full z-20 mt-1 w-52 overflow-hidden rounded-xl border border-line bg-white py-1 shadow-lg">
                  {!room.isGroup && (
                    <button
                      role="menuitem"
                      onClick={() => { setHeaderMenuOpen(false); onStartCall?.('video', callPeerAgentId ?? undefined); }}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-appbg"
                    >
                      <Video className="h-4 w-4 shrink-0 text-slate-500" />
                      Gọi video
                    </button>
                  )}
                  <button
                    role="menuitem"
                    onClick={() => { setHeaderMenuOpen(false); setPendingAddMembers(false); setShowInfo(true); }}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-appbg"
                  >
                    <Info className="h-4 w-4 shrink-0 text-slate-500" />
                    Thông tin hội thoại
                  </button>
                  {canCreateGroupFromRoom(room) && (
                    <button
                      role="menuitem"
                      onClick={() => { setHeaderMenuOpen(false); setShowCreateGroup(true); }}
                      className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-appbg"
                    >
                      <UsersRound className="h-4 w-4 shrink-0 text-slate-500" />
                      Tạo nhóm chat cùng người này
                    </button>
                  )}
                  <button
                    role="menuitem"
                    onClick={() => { setHeaderMenuOpen(false); toggleSelectMode(); }}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-slate-700 hover:bg-appbg"
                  >
                    <ListChecks className="h-4 w-4 shrink-0 text-slate-500" />
                    {selectMode ? 'Thoát chọn nhiều' : 'Chọn nhiều để xóa'}
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
      {/* B107 (2/8, Admin Demo: "trong tất cả các mục tìm kiếm phải có đếm số tin nhắn tìm được, mũi tên để
          chạm... 15/15 14/15") — thanh tìm kiếm trong phòng: ô nhập + bộ đếm "vị trí/tổng" + 2 nút mũi tên
          lên/xuống (lên = kết quả CŨ HƠN — index tăng, vì mảng sắp mới→cũ; xuống = kết quả MỚI HƠN). */}
      {inRoomSearchOpen && (
        <div className="flex items-center gap-2 border-b border-line bg-appbg px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-slate-400" />
          <input
            autoFocus
            value={inRoomSearchQuery}
            onChange={(e) => setInRoomSearchQuery(e.target.value)}
            placeholder="Tìm trong hội thoại này..."
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-400"
          />
          {inRoomSearchLoading && <DotsLoader size="sm" />}
          {!inRoomSearchLoading && inRoomSearchQuery.trim() && (
            <span className="shrink-0 text-xs font-medium text-slate-500">
              {inRoomSearchResults.length === 0 ? '0/0' : `${inRoomSearchIndex + 1}/${inRoomSearchResults.length}`}
            </span>
          )}
          <button
            disabled={inRoomSearchResults.length === 0}
            onClick={() => void jumpToSearchResult((inRoomSearchIndex + 1) % inRoomSearchResults.length)}
            title="Kết quả cũ hơn"
            className="shrink-0 rounded-full p-1.5 text-slate-500 hover:bg-white disabled:opacity-30"
          >
            <ChevronUp className="h-4 w-4" />
          </button>
          <button
            disabled={inRoomSearchResults.length === 0}
            onClick={() => void jumpToSearchResult((inRoomSearchIndex - 1 + inRoomSearchResults.length) % inRoomSearchResults.length)}
            title="Kết quả mới hơn"
            className="shrink-0 rounded-full p-1.5 text-slate-500 hover:bg-white disabled:opacity-30"
          >
            <ChevronDown className="h-4 w-4" />
          </button>
          <button
            onClick={() => {
              setInRoomSearchOpen(false);
              setInRoomSearchQuery('');
              setInRoomSearchResults([]);
            }}
            title="Đóng tìm kiếm"
            className="shrink-0 rounded-full p-1.5 text-slate-500 hover:bg-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {jumpNotFoundNotice && (
        <div className="border-b border-line bg-warning/10 px-3 py-2 text-xs text-warning">
          Không tìm thấy tin nhắn — có thể đã bị thu hồi hoặc quá cũ.
          <button onClick={() => setJumpNotFoundNotice(false)} className="ml-2 underline">
            Đóng
          </button>
        </div>
      )}
      {/* "BẢNG TIN" / GHIM NHIỀU (5/8) — banner tin ghim MỚI NHẤT, bấm mở PinBoardPanel xem toàn bộ. Hiện số
          lượng nếu ghim >1 tin. Bấm vào phần nội dung → nhảy tới tin gốc; bấm nút bên phải → mở bảng tin. */}
      {topPin && (
        <div className="flex items-center gap-2 border-b border-line bg-brand-tint px-3 py-2 text-xs text-brand">
          <Pin className="h-3.5 w-3.5 shrink-0" />
          <button
            type="button"
            data-testid="pinned-banner-jump"
            onClick={() => void jumpToPinnedMessage(topPin.messageId)}
            className="min-w-0 flex-1 truncate text-left hover:underline"
          >
            <b>Đã ghim:</b> {pinnedMessagePreview(topPin.message) || '(tin nhắn đính kèm)'}
          </button>
          <button
            type="button"
            data-testid="open-pin-board"
            onClick={() => setShowPinBoard(true)}
            className="shrink-0 rounded-full px-2 py-0.5 font-semibold hover:bg-white/60"
          >
            {pins.length > 1 ? `Xem tất cả (${pins.length})` : 'Bảng tin'}
          </button>
        </div>
      )}
      {pinActionError && (
        <div className="border-b border-line bg-danger/5 px-3 py-2 text-xs text-danger">{pinActionError}</div>
      )}
      {historyError && (
        <div className="border-b border-line bg-danger/5 px-3 py-2 text-xs text-danger">
          Không tải được lịch sử tin nhắn: {historyError}
        </div>
      )}
      <div ref={scrollRef} onScroll={handleScroll} className="flex-1 space-y-3 overflow-auto p-4">
        {loadingHistory && (
          <div className="flex items-center justify-center gap-2 py-6 text-sm text-slate-400">
            <DotsLoader /> Đang tải lịch sử trò chuyện...
          </div>
        )}
        {/* FIX-PERF (4/8) — chỉ báo tải thêm tin CŨ khi cuộn lên đầu (infinite scroll up). */}
        {loadingOlder && (
          <div className="flex items-center justify-center gap-2 py-3 text-xs text-slate-400">
            <DotsLoader size="sm" /> Đang tải tin nhắn cũ hơn...
          </div>
        )}
        {messages.map((m) => (
          <ChatBubble
            key={m.id}
            message={withDisplayStatus(m)}
            repliedMessage={m.replyToMessageId ? messagesById.get(m.replyToMessageId) : undefined}
            onImageClick={(msg) => openLightboxFromMessage(msg)}
            onReact={react}
            onContextMenu={(rect, msg) => {
              // ChatBubble.tsx đã tự preventDefault() sự kiện contextmenu gốc (chuột-phải) — ở đây chỉ còn
              // nhận rect + quyết định có mở menu hay không (1/8, xem comment đầu file "MENU NGỮ CẢNH").
              if (selectMode) return; // đang chọn nhiều — bấm/long-press chỉ để chọn, không mở menu ngữ cảnh
              setMenu({ rect, message: msg });
            }}
            selectMode={selectMode}
            selected={selectedIds.has(m.id)}
            onToggleSelect={toggleSelect}
            pickerOpen={openReactionPickerId === m.id}
            onSetPickerOpen={(open) => setOpenReactionPickerId(open ? m.id : null)}
            onJumpToMessage={jumpToMessage}
            highlighted={highlightedMessageId === m.id}
            onReply={(msg) => setReplyingTo(msg)}
            onForward={(msg) => setForwardTarget(msg)}
          />
        ))}
        {/* "Đã gửi" (26/7, B29-tiếp mục 3) — CHỈ dưới tin nhắn CUỐI CÙNG của DM, xem comment showSentLabel. */}
        {showSentLabel && <div className="pr-1 text-right text-[11px] text-slate-400">{sentLabelText}</div>}
      </div>
      {/* Typing indicator (26/7, B29-tiếp mục 1) — xem comment typingLabel. */}
      {typingLabel && (
        <div className="border-t border-line bg-white px-4 pt-2 text-xs italic text-slate-400">{typingLabel}</div>
      )}
      {sendError && (
        <div className="border-t border-line bg-danger/5 px-3 py-2 text-xs text-danger">Gửi tin nhắn thất bại: {sendError}</div>
      )}
      {actionError && <div className="border-t border-line bg-danger/5 px-3 py-2 text-xs text-danger">{actionError}</div>}
      {selectMode ? (
        // Thanh hành động chọn nhiều (mục 5, 24/7) — thay MessageComposer khi đang chọn (không gõ tin
        // trong lúc chọn để xóa, cùng UX Zalo).
        (<div className="flex items-center justify-between border-t border-line bg-white px-4 py-3">
          <button onClick={toggleSelectMode} className="text-sm text-slate-500 hover:text-slate-700">
            Hủy
          </button>
          <span className="text-sm text-slate-600">Đã chọn {selectedIds.size} tin nhắn</span>
          <button
            onClick={() => setConfirmDeleteBulk(true)}
            disabled={selectedIds.size === 0 || actionBusy}
            className="flex items-center gap-1.5 rounded-md bg-danger px-3 py-2 text-xs font-medium text-white hover:brightness-110 disabled:opacity-50"
          >
            <Trash2 className="h-3.5 w-3.5" /> Xóa ({selectedIds.size})
          </button>
        </div>)
      ) : composerLocked ? (
        // debt-chat-gaps (31/7, Việc 4) — nhóm bật "chỉ trưởng/phó nhóm được gửi tin" VÀ mình là MEMBER thường
        // → thay MessageComposer bằng thông báo, KHÔNG cho gõ (enforce THẬT nằm ở server, xem composerLocked).
        <div className="border-t border-line bg-white px-4 py-3.5 text-center text-xs text-slate-400">
          Nhóm đang bật chế độ chỉ trưởng/phó nhóm được gửi tin nhắn.
        </div>
      ) : (
        <>
          {/* Thanh preview "Trả lời" (1/8, kiểu Zalo) — NGOÀI MessageComposer.tsx (component đó không sửa),
              hiện khi `replyingTo` có giá trị: dòng "Trả lời <tên>" + trích đoạn ngắn nội dung tin gốc + nút X
              hủy. `replyPreviewText()` — reply-preview.ts, hàm thuần dùng chung với khối trích dẫn trong
              ChatBubble.tsx. */}
          {replyingTo && (
            <div className="flex items-center gap-2 border-t border-line bg-appbg px-4 py-2">
              <Reply className="h-4 w-4 shrink-0 text-brand" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-xs font-semibold text-brand">
                  Trả lời {replyingTo.mine ? 'chính mình' : replyingTo.senderName || 'người dùng'}
                </div>
                <div className="truncate text-xs text-slate-500">{replyPreviewText(replyingTo)}</div>
              </div>
              <button
                type="button"
                onClick={() => setReplyingTo(null)}
                aria-label="Hủy trả lời"
                className="shrink-0 rounded-full p-1 text-slate-400 hover:bg-white hover:text-slate-600"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
          )}
          <MessageComposer
            // Audit độc lập 26/7 (finding HIGH, xem BUGS_FIXED.md): KHÔNG có `key` → React Router v6 không tự
            // remount khi chỉ đổi :roomId (cùng route) → state cục bộ (draft đang gõ dở/isTypingRef/timer) SỐNG
            // SÓT qua lần đổi phòng — draft phòng A còn nguyên khi mở phòng B (gửi nhầm nội dung), và chỉ báo
            // "đang gõ" của phòng B bị nuốt nếu đổi phòng ngay trong lúc timer debounce phòng A còn chạy. `key`
            // đổi theo room.id buộc React hủy hẳn instance cũ + tạo instance mới sạch mỗi lần đổi phòng — cleanup
            // effect sẵn có (dòng ~82-91) tự chạy đúng lúc unmount, báo "ngừng gõ" về ĐÚNG phòng cũ trước khi
            // phòng mới khởi tạo.
            key={room.id}
            onSend={send}
            onSendAttachment={sendAttachment}
            onAttachError={handleAttachError}
            onShareLocation={shareLocation}
            onSendSticker={sendSticker}
            onTypingChange={(isTyping) => sendTypingStatus(room.id, isTyping)}
            initialEmojiOpen={initialEmojiOpen}
            // Tag @ mention kiểu Zalo (13/8) — CHỈ phòng GROUP (mảng rỗng cho DIRECT → composer tự tắt mention).
            mentionMembers={mentionMembers}
          />
        </>
      )}
      {menu && (() => {
        // BUG THẬT (1/8, Admin Demo chụp màn hình thật: menu "tràn xuống khung chat") — gốc: `.page-enter` (khối
        // bọc NGOÀI toàn màn hình, AppShell.tsx — hiệu ứng chuyển trang) có `will-change: transform` trong CSS
        // (styles.css) — theo spec CSS, `will-change: transform` tạo CONTAINING BLOCK MỚI cho MỌI hậu duệ
        // `position: fixed`, CÙNG HIỆU ỨNG như đặt `transform` thật (dù không có animation transform nào đang
        // chạy). Nghĩa là menu KHÔNG còn định vị theo TOÀN màn hình (`window.innerWidth/Height`, đúng như
        // `computeContextMenuPosition()` bên dưới tính) mà theo khung `.page-enter` (nhỏ hơn true viewport —
        // KHÔNG tính phần TopBar phía trên) → toạ độ `top` tính đúng theo viewport thật bị áp NHẦM lên khung
        // nhỏ hơn, đẩy menu lệch xuống thêm đúng bằng chiều cao TopBar, dễ tràn xuống khung nhập tin/composer.
        // (Lightbox/dialog khác trong file này dùng `inset-0` — lấp ĐẦY container dù nhỏ hơn viewport thật nên
        // không lộ bug, CHỈ phần tử tính `top`/`left` CHÍNH XÁC theo pixel như menu này mới bị lệch rõ.)
        // FIX: `createPortal` ra thẳng `document.body` — CÙNG kỹ thuật `Modal.tsx` đã dùng sẵn trong app để
        // né đúng lớp lỗi containing-block này (xem comment ChatBubble.tsx nhắc tới Modal.tsx dùng createPortal
        // — module đó KHÔNG viết lại logic mở/đóng, chỉ đổi NƠI render trong DOM tree).
        //
        // Vị trí menu (2/8, Admin Demo test APK thật báo "sao không để menu hàng ngang như lúc chọn icon [cảm
        // xúc]?") — đổi từ danh sách DỌC (text+icon từng dòng) sang THANH NGANG kiểu viên thuốc (pill), CÙNG
        // style `pickerOpen` reaction picker đã có sẵn ở ChatBubble.tsx (`flex items-center gap-* rounded-full
        // border bg-white shadow-card`) — đúng nguyên tắc đồng bộ thiết kế toàn app, và cũng ĐÚNG hành vi Zalo
        // thật (thanh hành động ngang, chỉ icon, khi long-press 1 tin). Neo theo BUBBLE (menu.rect) qua
        // computeContextMenuPosition() — hàm đó orientation-agnostic (chỉ cần width/height ước lượng để
        // clamp), không cần đổi khi đổi layout dọc→ngang.
        // B123 (2/8, tính năng "Hoàn tiền" MỚI — BUG THẬT tự phát hiện lúc verify ảnh chụp thật 360px, mở rộng
        // đúng bug-class B101 "menu ngữ cảnh tràn khung", KHÔNG chỉ vá riêng trường hợp của mình): các hằng số
        // PX TUYỆT ĐỐI cũ (ICON_BTN_SIZE=40/MENU_HORIZONTAL_PADDING=12/MENU_HEIGHT=48) giả định gốc 16px/rem —
        // SAI với app THẬT: `font-scale.ts` đặt `<html>` font-size = 18px MẶC ĐỊNH (mức "Vừa"), có thể tới
        // 22.5px ở mức "Rất lớn" (mục 22 cỡ chữ toàn app) — mọi kích thước nút (`h-10 w-10` = 2.5rem) VÀ
        // khoảng cách (`gap-0.5`/`px-1.5`) đều theo REM, tự phóng to CÙNG tỉ lệ khi người dùng đổi cỡ chữ. Đo
        // THẬT qua Playwright (360px, 6 mục, root 18px mặc định): mỗi nút RENDER 45×45px (KHÔNG PHẢI 40×40 như
        // hằng số cũ giả định) → tổng bề rộng menu THẬT 296.75px trong khi công thức CŨ ước lượng chỉ 252px —
        // hụt 44.75px, ĐỦ để tràn ra ngoài viewport 360px khi đủ 6 mục (Hoàn tiền là mục thứ 6 làm lộ rõ bug
        // tiềm ẩn từ trước, vốn "may mắn" chưa tràn với tối đa 5 mục cũ). Fix TẬN GỐC: đọc `rootFontSizePx`
        // THẬT từ `getComputedStyle(document.documentElement)` NGAY lúc tính (đúng root hiện tại, phản ánh
        // ĐÚNG mức cỡ chữ người dùng đang chọn — không hard-code lại 1 con số px nào), quy đổi TOÀN BỘ theo rem
        // ĐÚNG NHƯ className Tailwind thật đang dùng (h-10 w-10=2.5rem, gap-0.5=0.125rem, px-1.5 2 phía=0.75rem,
        // py-1.5 2 phía=0.75rem, border 1px mỗi phía=2px) — KHÔNG còn ước lượng cố định nào, đúng bề rộng/cao
        // THẬT mọi mức cỡ chữ, mọi lúc.
        const rootFontSizePx = typeof document !== 'undefined' ? parseFloat(getComputedStyle(document.documentElement).fontSize) || 16 : 16;
        const ICON_BTN_REM = 2.5; // h-10 w-10
        const GAP_REM = 0.125; // gap-0.5, giữa MỖI CẶP nút liền kề — (itemCount-1) lần, KHÔNG phải itemCount lần.
        const CONTAINER_PADDING_X_REM = 0.75; // px-1.5 CẢ 2 PHÍA cộng lại (0.375rem × 2)
        const CONTAINER_PADDING_Y_REM = 0.75; // py-1.5 CẢ 2 PHÍA cộng lại
        const CONTAINER_BORDER_PX = 2; // border 1px mỗi phía (trái+phải cho width, trên+dưới cho height)
        // B112 (2/8) — "Sửa" (Pencil) thêm 1 nút NGOÀI "Thu hồi" khi tin thoả canEditBillMessage() (mine +
        // bill đã ghép đủ dữ liệu + còn trong cửa sổ 1h) — CỘNG THÊM vào itemCount để menu KHÔNG bị tràn/cắt
        // (đúng bài học B101 "menu ngữ cảnh tràn khung" — mọi nút mới PHẢI cộng vào phép tính bề rộng này).
        // B123 (2/8, tính năng "Hoàn tiền" MỚI) — "Sửa" giờ CŨNG hiện cho tin nhắn HOÀN TIỀN (canEditRefundMessage,
        // KHÔNG CỘNG THÊM lần 2 — cùng 1 nút "Sửa", chỉ đổi ĐIỀU KIỆN hiện + đổi panel mở tuỳ loại tin, xem JSX
        // dưới) + "Hoàn tiền" (Banknote) MỚI HOÀN TOÀN, CỘNG THÊM 1 vào itemCount — 6 mục tối đa khi đủ điều
        // kiện (Trả lời/Chuyển tiếp/Copy/Sửa/Hoàn tiền/Thu hồi).
        const showEditButton = canEditBillMessage(menu.message) || canEditRefundMessage(menu.message);
        const showRefundButton = canOpenRefund(menu.message);
        // "BẢNG TIN" / GHIM NHIỀU (5/8) — nút "Ghim"/"Bỏ ghim" CHỈ cho OWNER/ADMIN (canManagePins, CÙNG gate
        // server assertOwnerOrAdmin) trên tin THẬT (không phải system/local- chưa nối thật). CỘNG vào itemCount
        // để menu KHÔNG tràn/cắt (bài học B101 — mọi nút mới PHẢI vào phép tính bề rộng menu).
        const showPinButton = canManagePins && menu.message.type !== 'system' && !menu.message.id.startsWith('local-');
        const isMessagePinned = pinnedMessageIds.has(menu.message.id);
        // Menu THEO LOẠI (7/8, kiểu Zalo — GIỮ brand): 1 nguồn duy nhất menuActionsForMessage() quyết định các
        // nút THEO LOẠI TIN (reply/forward/copy/mở-sao-chép-liên-kết/tải-xuống/thu-hồi), các nút NGHIỆP VỤ
        // (Sửa/Hoàn tiền/Ghim) vẫn tính riêng theo gate async ở trên. `menuLink` = URL đầu tiên trong tin TEXT
        // (chỉ khi CÓ link mới hiện Mở/Sao chép liên kết — tin không link KHÔNG hiện). `menuCanDownload` = ảnh
        // có URL thật / file có url (dùng LẠI downloadAttachment như FileMessageCard/ChatBubble, không bịa endpoint).
        const menuLink = menu.message.type === 'text' ? extractFirstUrl(menu.message.text) : null;
        const menuCanDownload =
          (menu.message.type === 'image' && isRealImageUrl(menu.message.imageUrl)) ||
          (menu.message.type === 'file' && !!menu.message.file?.url);
        const coreActions = menuActionsForMessage({
          type: menu.message.type,
          isMine: !!menu.message.mine,
          hasLink: !!menuLink,
          canDownload: menuCanDownload
        });
        // itemCount = số nút THEO LOẠI (coreActions) + nút NGHIỆP VỤ — PHẢI khớp số nút render thật để tính bề
        // rộng menu đúng (bài học B101 "menu ngữ cảnh tràn khung": mọi nút mới PHẢI vào phép tính này).
        const itemCount = coreActions.length + (showEditButton ? 1 : 0) + (showRefundButton ? 1 : 0) + (showPinButton ? 1 : 0);
        const menuWidth = (CONTAINER_PADDING_X_REM + itemCount * ICON_BTN_REM + (itemCount - 1) * GAP_REM) * rootFontSizePx + CONTAINER_BORDER_PX;
        const MENU_HEIGHT = (CONTAINER_PADDING_Y_REM + ICON_BTN_REM) * rootFontSizePx + CONTAINER_BORDER_PX;
        const pos = computeContextMenuPosition({
          bubbleRect: menu.rect,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          menuWidth,
          menuHeight: MENU_HEIGHT
        });
        // B123 (2/8) — Ở MỨC CỠ CHỮ LỚN NHẤT ("Rất lớn", font-scale.ts scale=1.25, root 22.5px) đo THẬT qua
        // Playwright: 6 mục KHÔNG CÒN VỪA dù đã canh lề đúng — bề rộng THẬT (~370px) VƯỢT QUÁ CẢ khung nhìn
        // 360px (kể cả đặt sát mép trái, kê VIEWPORT_MARGIN=8px 2 bên chỉ còn 344px khả dụng). Đây là GIỚI HẠN
        // VẬT LÝ THẬT (6 icon 45px+ mỗi cái không thể ép nhỏ hơn mà vẫn bấm được, không phải lỗi tính toán) —
        // xử lý bằng PHƯƠNG ÁN Admin Demo đã duyệt trước ("cho phép menu tự cuộn ngang") thay vì cắt bớt mục nào:
        // giới hạn `max-width` = khoảng trống khả dụng thật (viewportWidth − 2×VIEWPORT_MARGIN, PHẢI khớp hằng
        // số cùng tên ở context-menu-position.ts) + `overflow-x-auto` — mọi mức cỡ chữ BÌNH THƯỜNG (Nhỏ/Vừa/
        // Lớn) menu vẫn vừa đủ hiện NGUYÊN, KHÔNG cuộn (maxWidth ≥ nội dung thật) — CHỈ mức "Rất lớn" mới cần
        // cuộn để chạm được nút cuối, KHÔNG mất mục nào khỏi menu.
        const VIEWPORT_MARGIN_PX = 8; // PHẢI khớp VIEWPORT_MARGIN (context-menu-position.ts, không export).
        const menuMaxWidthPx = Math.max(0, window.innerWidth - VIEWPORT_MARGIN_PX * 2);
        return createPortal(
          <div
            style={{ left: pos.left, top: pos.top, maxWidth: `${menuMaxWidthPx}px` }}
            onClick={(e) => e.stopPropagation()}
            className="fixed z-30 flex items-center gap-0.5 overflow-x-auto rounded-full border border-line bg-white px-1.5 py-1.5 shadow-card"
          >
            {/* "Trả lời" (1/8, đặt TRƯỚC "Chuyển tiếp") — set replyingTo, thanh preview hiện ở JSX gần cuối file. */}
            <button
              title="Trả lời"
              onClick={() => {
                setReplyingTo(menu.message);
                setMenu(null);
              }}
              className="flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition hover:bg-appbg"
            >
              <Reply className="h-4.5 w-4.5" />
            </button>
            <button
              title="Chuyển tiếp"
              onClick={() => {
                setForwardTarget(menu.message);
                setMenu(null);
              }}
              className="flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition hover:bg-appbg"
            >
              <Forward className="h-4.5 w-4.5" />
            </button>
            {/* "Tải xuống" (7/8, menu THEO LOẠI) — CHỈ ảnh có URL thật / file có url (coreActions 'download').
                B-DL/SHARE (11/8): TẢI = LƯU về máy/thư viện (ảnh→thư viện ảnh trên APK giống Zalo, isImage=true),
                KHÔNG mở share sheet. Chia sẻ tách sang nút riêng bên dưới. */}
            {coreActions.includes('download') && (
              <button
                title="Tải xuống"
                onClick={() => {
                  const isImg = menu.message.type === 'image';
                  const dlUrl = isImg ? menu.message.imageUrl : menu.message.file?.url;
                  const dlName = isImg ? `anh-${menu.message.id}.jpg` : menu.message.file?.name || `tep-${menu.message.id}`;
                  if (dlUrl) {
                    downloadAttachment(dlUrl, dlName, { isImage: isImg }).catch((err) => {
                      setActionError(
                        String((err as { message?: string })?.message) === 'GALLERY_PLUGIN_UNAVAILABLE'
                          ? 'Đã lưu vào Tệp, nhưng chưa vào được Thư viện ảnh (cần cập nhật ứng dụng).'
                          : 'Không tải được tệp đính kèm.'
                      );
                    });
                  }
                  setMenu(null);
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition hover:bg-appbg"
              >
                <Download className="h-4.5 w-4.5" />
              </button>
            )}
            {/* "Chia sẻ" (B-DL/SHARE 11/8, menu THEO LOẠI) — RIÊNG khỏi Tải xuống: gửi đính kèm sang ứng dụng
                khác (share sheet Android / Web Share API). icon Share2 (khác Download). */}
            {coreActions.includes('share') && (
              <button
                title="Chia sẻ"
                onClick={() => {
                  const isImg = menu.message.type === 'image';
                  const shUrl = isImg ? menu.message.imageUrl : menu.message.file?.url;
                  const shName = isImg ? `anh-${menu.message.id}.jpg` : menu.message.file?.name || `tep-${menu.message.id}`;
                  if (shUrl) {
                    shareAttachment(shUrl, shName).catch((err) => {
                      if (String((err as { message?: string })?.message) === 'WEB_SHARE_UNSUPPORTED') {
                        setActionError('Trình duyệt không hỗ trợ chia sẻ. Hãy dùng nút Tải xuống.');
                      } else {
                        setActionError('Không chia sẻ được tệp đính kèm.');
                      }
                    });
                  }
                  setMenu(null);
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition hover:bg-appbg"
              >
                <Share2 className="h-4.5 w-4.5" />
              </button>
            )}
            {/* "Sao chép" (1/8) — CHỈ tin TEXT (coreActions 'copy'; ảnh/file/voice không có text để sao chép). */}
            {coreActions.includes('copy') && (
              <button
                title="Sao chép"
                onClick={() => {
                  navigator.clipboard.writeText(menu.message.text ?? '').catch(() => {
                    setActionError('Không sao chép được nội dung tin nhắn.');
                  });
                  setMenu(null);
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition hover:bg-appbg"
              >
                <Copy className="h-4.5 w-4.5" />
              </button>
            )}
            {/* "Mở liên kết" (7/8) — CHỈ tin TEXT CÓ link (coreActions 'openLink'). Mở tab ngoài AN TOÀN
                (noopener,noreferrer — chặn trang đích chiếm `window.opener`). */}
            {coreActions.includes('openLink') && menuLink && (
              <button
                title="Mở liên kết"
                onClick={() => {
                  window.open(menuLink, '_blank', 'noopener,noreferrer');
                  setMenu(null);
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition hover:bg-appbg"
              >
                <ExternalLink className="h-4.5 w-4.5" />
              </button>
            )}
            {/* "Sao chép liên kết" (7/8) — CHỈ tin TEXT CÓ link (coreActions 'copyLink'). */}
            {coreActions.includes('copyLink') && menuLink && (
              <button
                title="Sao chép liên kết"
                onClick={() => {
                  navigator.clipboard.writeText(menuLink).catch(() => {
                    setActionError('Không sao chép được liên kết.');
                  });
                  setMenu(null);
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition hover:bg-appbg"
              >
                <Link2 className="h-4.5 w-4.5" />
              </button>
            )}
            {/* "Sửa" (B112, 2/8, Admin Demo "bill sau khi đã gửi chưa có nút sửa?") — CHỈ hiện cho tin ẢNH bill đã
                ghép ĐỦ dữ liệu (billFields lưu sẵn), CỦA CHÍNH mình, CÒN trong cửa sổ 1h (canEditBillMessage(),
                CÙNG cửa sổ MESSAGE_EDIT_WINDOW_HOURS đã có sẵn cho MỌI loại sửa tin nhắn — KHÔNG bịa cửa sổ
                riêng). Quá hạn/không đủ điều kiện → ẨN HẲN (KHÔNG disable như "Thu hồi" — "Sửa" là tính năng
                MỚI hoàn toàn, phần lớn tin nhắn KHÔNG PHẢI bill nên hiện icon xám vô nghĩa cho MỌI tin sẽ rối
                hơn là ẩn hẳn, khác "Thu hồi" vốn áp dụng cho MỌI tin của mình).
                B123 (2/8) — GIỜ CŨNG mở EditRefundMessageModal.tsx khi tin đang chọn là HOÀN TIỀN
                (canEditRefundMessage) thay vì bill gốc — 1 nút DUY NHẤT, tự chọn đúng panel theo loại tin. */}
            {showEditButton && (
              <button
                title="Sửa"
                onClick={() => {
                  if (canEditRefundMessage(menu.message)) setEditingRefundMessage(menu.message);
                  else setEditingBillMessage(menu.message);
                  setMenu(null);
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition hover:bg-appbg"
              >
                <Pencil className="h-4.5 w-4.5" />
              </button>
            )}
            {/* "Hoàn tiền" (B123, 2/8, tính năng MỚI, Admin Demo yêu cầu trực tiếp) — CHỈ hiện cho tin ẢNH BILL GỐC
                đã ghép đủ dữ liệu (canOpenRefund, KHÔNG đòi mine/cửa sổ thời gian — bất kỳ thành viên đang hoạt
                động nào của phòng đều xác nhận được, Admin Demo chốt "quyền y hệt gửi tin nhắn thường"). Mở
                RefundBillModal.tsx — gửi tin nhắn ẢNH MỚI (KHÔNG sửa tin gốc) trả lời (quote-reply) tin này. */}
            {showRefundButton && (
              <button
                title="Hoàn tiền"
                onClick={() => {
                  setRefundingMessage(menu.message);
                  setMenu(null);
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full text-slate-700 transition hover:bg-appbg"
              >
                <Banknote className="h-4.5 w-4.5" />
              </button>
            )}
            {/* "Ghim"/"Bỏ ghim" (5/8, "BẢNG TIN" GHIM NHIỀU) — CHỈ OWNER/ADMIN (showPinButton). Tin đã ghim →
                icon PinOff + nhãn "Bỏ ghim"; chưa ghim → Pin + "Ghim". Cập nhật danh sách qua realtime. */}
            {showPinButton && (
              <button
                title={isMessagePinned ? 'Bỏ ghim' : 'Ghim'}
                data-testid={isMessagePinned ? 'menu-unpin' : 'menu-pin'}
                onClick={() => {
                  void togglePin(menu.message);
                  setMenu(null);
                }}
                className="flex h-10 w-10 items-center justify-center rounded-full text-brand transition hover:bg-brand-tint"
              >
                {isMessagePinned ? <PinOff className="h-4.5 w-4.5" /> : <Pin className="h-4.5 w-4.5" />}
              </button>
            )}
            {/* "Thu hồi" (1/8, ĐỔI NHÃN từ "Xóa" — xem comment đầu file "MENU NGỮ CẢNH": HÀNH VI/API GIỮ NGUYÊN
                100%, chỉ đổi chữ hiển thị). Phase 3 gộp "Xóa"+"Thu hồi" cũ RC thành 1 hành động — hệ chat lõi
                mới CHỈ có 1 khái niệm xóa, soft-delete + placeholder, giới hạn MESSAGE_DELETE_WINDOW_HOURS=48h
                kể từ lúc gửi — CHỈ tin nhắn CỦA MÌNH. Quá hạn thì disable kèm chú thích rõ lý do (title tooltip,
                icon dạng list KHÔNG còn chỗ hiện chữ giải thích trực tiếp như bản dọc cũ) thay vì ẩn im lặng. */}
            {menu.message.mine && (
              <>
                {canDeleteChatMessage(menu.message.sentAtIso) ? (
                  <button
                    title="Thu hồi"
                    onClick={() => {
                      setConfirmDeleteOne(menu.message);
                      setMenu(null);
                    }}
                    className="flex h-10 w-10 items-center justify-center rounded-full text-danger transition hover:bg-danger/5"
                  >
                    <Trash2 className="h-4.5 w-4.5" />
                  </button>
                ) : (
                  <div
                    className="flex h-10 w-10 cursor-not-allowed items-center justify-center rounded-full text-slate-300"
                    title={`Chỉ thu hồi được trong vòng ${MESSAGE_DELETE_WINDOW_HOURS} giờ kể từ lúc gửi — đã quá hạn`}
                  >
                    <Trash2 className="h-4.5 w-4.5" />
                  </div>
                )}
              </>
            )}
          </div>,
          document.body
        );
      })()}
      {lightbox &&
        (() => {
          const current = lightbox.items[lightbox.index];
          if (!current) return null;
          const hasPrev = lightbox.index > 0;
          const hasNext = lightbox.index < lightbox.items.length - 1;
          return (
            <div
              className="fixed inset-0 z-40 flex items-center justify-center bg-black/80"
              // zoom (5/8) — tap NỀN đóng CHỈ khi chưa zoom (đang zoom thì tap để tương tác ảnh, không đóng nhầm).
              onClick={() => {
                if (!lightboxZoomed) setLightbox(null);
              }}
              onTouchStart={handleLightboxTouchStart}
              onTouchEnd={handleLightboxTouchEnd}
            >
              <button
                className="absolute right-5 top-5 z-10 text-white"
                onClick={(e) => {
                  e.stopPropagation();
                  setLightbox(null);
                }}
              >
                <X className="h-7 w-7" />
              </button>
              {/* B-DL/SHARE (11/8) — nút TẢI + CHIA SẺ khi xem ảnh phóng to (lightbox trước đây KHÔNG có nút tải).
                  Tải = LƯU về máy/thư viện (ảnh: isImage=true → thư viện ảnh trên APK); Chia sẻ = gửi ứng dụng khác. */}
              {isRealImageUrl(current.imageUrl) && (
                <div className="absolute left-5 top-5 z-10 flex items-center gap-2">
                  <button
                    aria-label="Tải ảnh"
                    title="Tải ảnh"
                    className="flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!current.imageUrl) return;
                      downloadAttachment(current.imageUrl, `anh-${current.key}.jpg`, { isImage: true }).catch((err) => {
                        setActionError(
                          String((err as { message?: string })?.message) === 'GALLERY_PLUGIN_UNAVAILABLE'
                            ? 'Đã lưu vào Tệp, nhưng chưa vào được Thư viện ảnh (cần cập nhật ứng dụng).'
                            : 'Không tải được ảnh.'
                        );
                      });
                    }}
                  >
                    <Download className="h-5 w-5" />
                  </button>
                  <button
                    aria-label="Chia sẻ ảnh"
                    title="Chia sẻ ảnh"
                    className="flex h-10 w-10 items-center justify-center rounded-full bg-black/40 text-white transition hover:bg-black/60"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!current.imageUrl) return;
                      shareAttachment(current.imageUrl, `anh-${current.key}.jpg`).catch((err) => {
                        setActionError(
                          String((err as { message?: string })?.message) === 'WEB_SHARE_UNSUPPORTED'
                            ? 'Trình duyệt không hỗ trợ chia sẻ. Hãy dùng nút Tải xuống.'
                            : 'Không chia sẻ được ảnh.'
                        );
                      });
                    }}
                  >
                    <Share2 className="h-5 w-5" />
                  </button>
                </div>
              )}
              {/* Việc 2 (1/8, gallery-lightbox-swipe) — nút mũi tên trái/phải (desktop/chuột, KHÔNG chỉ dựa
                  vào gesture vuốt), TỰ ẨN ở đầu/cuối danh sách (không có ảnh trước/sau). `stopPropagation` để
                  bấm nút không đóng luôn lightbox (nền `onClick` phía ngoài mới đóng). */}
              {hasPrev && (
                <button
                  className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60 sm:left-4"
                  onClick={(e) => {
                    e.stopPropagation();
                    lightboxGoPrev();
                  }}
                  title="Ảnh trước"
                >
                  <ChevronLeft className="h-7 w-7" />
                </button>
              )}
              {hasNext && (
                <button
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-black/40 p-2 text-white hover:bg-black/60 sm:right-4"
                  onClick={(e) => {
                    e.stopPropagation();
                    lightboxGoNext();
                  }}
                  title="Ảnh sau"
                >
                  <ChevronRight className="h-7 w-7" />
                </button>
              )}
              {/* B83 (31/7) — FIX: ảnh đính kèm THẬT là URL http(s) TUYỆT ĐỐI (`VITE_BOT_API_URL` + `/v1/chat/
                  attachments/:id`, xem chat-client.ts chatAttachmentDownloadUrl()) NÊN điều kiện `isRealImageUrl()`
                  dưới đây LUÔN đúng cho ảnh thật (đã tự verify qua .env.production, KHÔNG suy đoán) — TRƯỚC ĐÂY
                  nhánh true gắn thẳng URL đó vào `<img src>` thô, endpoint lại bắt buộc header CSRF
                  `x-sigma-client` mà request tự động của `<img>` KHÔNG gắn được (CÙNG cơ chế 403 B49 đã fix cho
                  thumbnail ChatBubble.tsx — B49 đổi thumbnail sang `AttachmentImage`/fetch-blob nhưng BỎ SÓT lightbox
                  này, 1 điểm tiêu thụ KHÁC của CÙNG field `imageUrl`, KHÔNG ai cập nhật) → ảnh không mở ra xem được
                  (Admin Demo báo thật, xem BUGS_FIXED.md B81). Nay TÁI DÙNG ĐÚNG `AttachmentImage` (đã export từ
                  ChatBubble.tsx) — cùng cơ chế fetch có credentials+CSRF → blob → object URL, chỉ đổi kích thước qua
                  className cho khung phóng to. Ảnh chụp màn hình (mục 23, 31/7 — đi qua CÙNG luồng ảnh thật) cũng
                  phóng to đúng qua nhánh này. Nhánh else giữ nguyên cho dữ liệu demo/mock cũ (nếu còn sót).
                  Việc 2 (1/8) — CÙNG CƠ CHẾ này áp dụng cho MỌI ảnh hiện trong lightbox kể cả khi chuyển qua
                  ảnh khác (đổi `url` prop → AttachmentImage tự refetch qua effect `[url]` của chính nó, xem
                  ChatBubble.tsx) — KHÔNG lộ URL thô. */}
              {isRealImageUrl(current.imageUrl) ? (
                // zoom (5/8) — bọc ZoomableImage: ảnh chat phóng to được bằng 2 ngón/lăn chuột/double-tap
                // (index.html khóa pinch trình duyệt toàn app). resetKey = URL ảnh hiện tại → điều hướng
                // trái/phải trong gallery TỰ reset về fit. onZoomChange báo trạng thái để tắt tap-nền-đóng +
                // vuốt-điều-hướng khi đang zoom.
                <ZoomableImage resetKey={current.imageUrl} onZoomChange={setLightboxZoomed}>
                  <AttachmentImage
                    url={current.imageUrl}
                    alt="Xem ảnh"
                    onClick={(e) => e.stopPropagation()}
                    className="max-h-[85vh] max-w-[92vw] select-none rounded-lg object-contain"
                    loadingClassName="flex h-80 w-80 animate-pulse items-center justify-center rounded-lg bg-slate-700 text-sm text-slate-200"
                    failedClassName="flex h-80 w-80 items-center justify-center rounded-lg bg-slate-700 text-sm text-slate-200"
                  />
                </ZoomableImage>
              ) : (
                <div className="flex h-80 w-80 items-center justify-center rounded-lg bg-slate-700 text-sm text-slate-200">
                  {current.imageUrl ?? 'anh.jpg'} (xem nhanh)
                </div>
              )}
              {lightbox.items.length > 1 && (
                <div className="absolute bottom-5 left-1/2 -translate-x-1/2 rounded-full bg-black/40 px-3 py-1 text-xs text-white">
                  {lightbox.index + 1}/{lightbox.items.length}
                </div>
              )}
            </div>
          );
        })()}
      {forwardTarget && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setForwardTarget(null)}>
          <div className="w-full max-w-xs rounded-lg-mac border border-line bg-white p-4 shadow-card" onClick={(e) => e.stopPropagation()}>
            <h3 className="mb-2 text-sm font-semibold text-slate-800">Chuyển tiếp đến</h3>
            <div className="max-h-64 space-y-1 overflow-auto">
              {CHAT_ROOMS.filter((r) => r.id !== room.id).map((r) => (
                <button
                  key={r.id}
                  onClick={() => confirmForward(r)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-appbg"
                >
                  <div className="flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold text-white" style={{ backgroundColor: r.avatarColor }}>
                    {r.name[0]}
                  </div>
                  {r.name}
                </button>
              ))}
            </div>
            <button onClick={() => setForwardTarget(null)} className="mt-3 w-full rounded-md border border-line py-2 text-sm text-slate-600 hover:bg-appbg">
              Hủy
            </button>
          </div>
        </div>
      )}
      {/* Xác nhận xóa THẬT (mục 5, 24/7; Phase 3 gộp còn 1 hành động) — luôn qua ConfirmDialog trước khi gọi
          server, cùng pattern CategoryManagerModal.tsx. */}
      {confirmDeleteOne && (
        <ConfirmDialog
          title="Xóa tin nhắn"
          message={`Xóa tin nhắn này? Nội dung sẽ được thay bằng "${DELETED_MESSAGE_TEXT_VI}" cho tất cả mọi người trong cuộc trò chuyện, không thể hoàn tác.`}
          confirmLabel="Xóa"
          danger
          onCancel={() => setConfirmDeleteOne(null)}
          onConfirm={() => performDeleteOne(confirmDeleteOne)}
        />
      )}
      {confirmDeleteBulk && (
        <ConfirmDialog
          title="Xóa nhiều tin nhắn"
          message={`Xóa ${selectedIds.size} tin nhắn đã chọn? Hành động không thể hoàn tác.`}
          confirmLabel={`Xóa (${selectedIds.size})`}
          danger
          onCancel={() => setConfirmDeleteBulk(false)}
          onConfirm={performDeleteBulk}
        />
      )}
      {/* "Sửa" bill đã gửi (B112, 2/8) — chỉ mở khi menu ngữ cảnh chọn tin thoả canEditBillMessage() (xem gate
          ở nút "Sửa" phía trên). Modal tự PATCH tin nhắn xong → real-time `message-edited` (subscribeMessageEdited
          effect đã có sẵn, xem trên) tự cập nhật `messages` state — KHÔNG cần callback patch state thủ công ở
          đây, CÙNG nguyên tắc "không tự thêm vào state, để real-time đẩy về" áp dụng cho send()/react() khác
          trong file này. */}
      {editingBillMessage && (
        <Suspense fallback={null}>
          <EditBillMessageModal message={editingBillMessage} roomId={room.id} onClose={() => setEditingBillMessage(null)} />
        </Suspense>
      )}
      {/* "Hoàn tiền" (B123, 2/8) — mở khi menu ngữ cảnh chọn tin bill gốc thoả canOpenRefund() (xem gate ở nút
          "Hoàn tiền" phía trên). Panel tự gửi tin nhắn MỚI (replyToMessageId trỏ bill gốc) rồi tự đóng — tin
          mới tự xuất hiện qua real-time `new-message` (subscribeRoomMessages đã có sẵn), KHÔNG cần patch state
          thủ công, CÙNG nguyên tắc mọi luồng gửi khác trong file này. */}
      {refundingMessage && (
        <Suspense fallback={null}>
          <RefundBillModal originalMessage={refundingMessage} roomId={room.id} onClose={() => setRefundingMessage(null)} />
        </Suspense>
      )}
      {/* "Sửa" 1 lần hoàn tiền (B123, 2/8) — tự tra bill GỐC trong `messages` đã tải (theo `replyToMessageId`,
          KHÔNG gọi thêm API — CÙNG nguyên tắc resolve tin "Trả lời") để tính lại "số tiền phải hoàn"; KHÔNG tìm
          thấy (bill gốc quá cũ, chưa tải trong 50 tin gần nhất) → panel vẫn mở được, CHỈ ẩn banner trạng thái
          cộng dồn (xem docstring EditRefundMessageModal.tsx). */}
      {editingRefundMessage && (
        <Suspense fallback={null}>
          <EditRefundMessageModal
            message={editingRefundMessage}
            roomId={room.id}
            originalMessage={messages.find((m) => m.id === editingRefundMessage.replyToMessageId)}
            onClose={() => setEditingRefundMessage(null)}
          />
        </Suspense>
      )}
      {showInfo && (
        <GroupInfoPanel
          room={room}
          myAgentId={myAgentId}
          messages={messages}
          autoOpenAddMembers={pendingAddMembers}
          onClose={() => setShowInfo(false)}
          onOpenPhoto={openLightboxFromAttachments}
          onOpenRevenue={onOpenRevenue}
          onOpenPinBoard={() => {
            setShowInfo(false);
            setShowPinBoard(true);
          }}
        />
      )}
      {/* "BẢNG TIN" / GHIM KHÔNG GIỚI HẠN (5/8) — danh sách mọi tin ghim, bấm 1 tin → nhảy tới tin gốc;
          OWNER/ADMIN bỏ ghim từng tin. `pins` là nguồn sự thật chung với banner (realtime đồng bộ). */}
      {showPinBoard && (
        <PinBoardPanel
          roomId={room.id}
          pins={pins}
          loading={pinsLoading}
          canManage={canManagePins}
          resolveName={(id) => resolveAgentNameRef.current(id)}
          onClose={() => setShowPinBoard(false)}
          onJump={(messageId) => void jumpToPinnedMessage(messageId)}
        />
      )}
      {/* "Tạo nhóm chat cùng người này" (30/7) — modal chọn thêm bạn bè từ phòng DIRECT hiện tại; tạo xong điều
          hướng sang phòng GROUP mới (onCreateGroupNavigate wire ở App.tsx). myAgentId truyền xuống (modal tự chờ
          nếu null). */}
      {showCreateGroup && (
        <CreateGroupFromDmModal
          dmRoom={room}
          myAgentId={myAgentId}
          onClose={() => setShowCreateGroup(false)}
          onCreated={(newRoomId) => {
            setShowCreateGroup(false);
            onCreateGroupNavigate?.(newRoomId);
          }}
        />
      )}
    </div>
  );
}
