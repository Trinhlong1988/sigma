// Kiểu dữ liệu MOCK cho Phase 0 (demo thiết kế thuần frontend). KHÔNG khớp 1-1 với schema Prisma thật
// của bot-api — chỉ đủ để dựng UI, sẽ được thay bằng dữ liệu thật ở Phase 1+.
import type { BillMessageMeta } from '../lib/bill-message-meta';
import type { RefundMessageMeta } from '../lib/refund-message-meta';
export interface StatusOptionDto {
  code: string;
  label: string;
  tone: string;
  active: boolean;
}

/** Trạng thái kết bạn (mục 27): friend = bạn bè, none = chưa kết bạn, pending = đã gửi lời mời. */
export type FriendStatus = 'friend' | 'none' | 'pending';

export interface Agent {
  id: string;
  name: string;
  phone: string;
  avatarColor: string;
  role: string;
  online?: boolean;
  /** username hiển thị trên QR cá nhân (mục 24 — QR kết bạn như Zalo). */
  username?: string;
  /** Trạng thái kết bạn với tài khoản hiện tại (mục 27). */
  friendStatus?: FriendStatus;
  /** Email liên hệ — dùng để tìm kiếm trong Danh bạ (mở rộng 24/7, Phase 0 vẫn là mock). */
  email?: string;
}

/** Lời mời kết bạn đang chờ (mục 27). `source` = nguồn lời mời (mục 34 — quyền riêng tư như Zalo). */
export interface FriendRequest {
  id: string;
  name: string;
  username: string;
  avatarColor: string;
  mutual: string;
  source: string;
}

/** Phân loại nhóm chat như Zalo (mục 21 — Admin Demo bổ sung 23/7): tên + màu tự chọn, gán cho room. */
export interface Category {
  id: string;
  name: string;
  color: string;
}

export interface ChatRoom {
  id: string;
  name: string;
  isGroup: boolean;
  avatarColor: string;
  lastMessage: string;
  lastTime: string;
  unreadCount: number;
  pinnedMessageId?: string;
  /** Phân loại (mục 21) — undefined = chưa gán phân loại. */
  categoryId?: string;
  /** 5/8 — agentId ĐỐI PHƯƠNG của phòng DIRECT (null/undefined cho phòng GROUP hoặc mock cũ) — để hiện ẢNH
   * avatar THẬT của người đó (AgentAvatar) ở danh sách chat + header hội thoại thay vì chỉ chữ cái đầu.
   * mapChatRoomSummary() (chat-client.ts) map từ `RoomSummaryDto.otherAgentId`. */
  otherAgentId?: number | null;
  /** Avatar nhóm đồng bộ (8/8) — true = phòng GROUP ĐÃ đặt ảnh đại diện riêng (server trả `RoomSummaryDto.avatarUrl`
   * != null) → mọi nơi render (danh sách/header/tìm kiếm) hiện ẢNH nhóm THẬT (RoomAvatar) thay vì chỉ vòng tròn
   * màu. false = nhóm chưa đặt ảnh → giữ vòng tròn màu (KHÔNG fetch, tránh 404 mỗi phòng). undefined = phòng
   * DIRECT hoặc mock cũ (không áp dụng ảnh nhóm). mapChatRoomSummary() (chat-client.ts) map từ `dto.avatarUrl`. */
  hasGroupAvatar?: boolean;
  /** Item 13 (6/8) — presence ONLINE đối phương (DIRECT): true=online, false=offline, undefined=không rõ (GROUP
   *  hoặc mock cũ) → ChatList ẩn chấm presence. */
  online?: boolean;
  /** "X phút trước" (6/8) — ISO hoạt động cuối của đối phương DIRECT (offline) hoặc null. */
  lastSeenAt?: string | null;
  /** Menu hội thoại (7/8) — tắt thông báo (mute) / ghim hội thoại lên đầu (per-agent). undefined = false. */
  muted?: boolean;
  pinned?: boolean;
}

export type ChatMessageType = 'text' | 'image' | 'location' | 'qr' | 'system' | 'file' | 'voice';
// 'sending'/'failed' (5/8, Admin Demo "tin nhắn vừa gửi không hiện ngay") — trạng thái LẠC QUAN cục bộ của tin
// CHÍNH mình vừa bấm gửi, TRƯỚC khi server xác nhận (append ngay kiểu Zalo): 'sending' = đang gửi (đồng hồ),
// 'failed' = gửi lỗi (chấm than). 'sent'/'delivered'/'seen' = sau khi server nhận (tick 1/2/2-xanh).
export type ChatMessageStatus = 'sending' | 'failed' | 'sent' | 'delivered' | 'seen';

/** Loại file cho FileMessageCard (mục 30) — quyết định icon + màu. */
export type FileKind = 'pdf' | 'xlsx' | 'docx' | 'zip';

/** Cảm xúc trên 1 tin nhắn (mục 29 — như Zalo). */
export interface MessageReaction {
  emoji: string;
  count: number;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  senderId: string;
  senderName: string;
  mine?: boolean;
  type: ChatMessageType;
  text?: string;
  time: string;
  status: ChatMessageStatus;
  pinned?: boolean;
  imageUrl?: string;
  location?: { lat: number; lng: number; label: string };
  qr?: { amount: number; tid: string; bank: string };
  /** Tin nhắn dạng file/tài liệu (mục 30). `url` (27/7 — đính kèm file THẬT, optional: mock cũ không có tải
   * xuống thật) trỏ tới `GET /v1/chat/attachments/:id` (bot-api), xem rc-realtime.ts mapRcMessage(). */
  file?: { name: string; size: string; kind: FileKind; url?: string };
  /** B106 (2/8) — đánh dấu tin ảnh IMAGE là ảnh bill đã quét OCR (ghép bảng kẻ ô), để ChatBubble.tsx quyết
   * định layout rộng/không-cắt-viền — THAY heuristic cũ `text?.startsWith('Bill: ')` (giòn, phụ thuộc đúng
   * NGUYÊN VĂN caption — B106 đổi caption sang mẫu "POS ..." nên heuristic cũ vỡ hoàn toàn). Từ `metadataJson`
   * `{isBillImage:true}` set lúc gửi (xem ConversationScreen.tsx sendAttachment()). */
  isBillImage?: boolean;
  /** B112 (2/8) — id attachment THẬT của tin nhắn (chỉ set cho IMAGE/FILE/VOICE, xem chat-client.ts
   * mapChatMessage()) — cần để "Sửa" bill (EditBillMessageModal.tsx) fetch lại ẢNH GHÉP hiện có (qua
   * `chatAttachmentDownloadUrl(attachmentId)`) rồi cắt lại phần ảnh bill gốc, xem `cropTopOfImage()`
   * bill-table-image.ts. KHÔNG dùng để hiển thị (đã có `imageUrl`/`file.url`/`voice.url` riêng cho việc đó). */
  attachmentId?: string;
  /** B112 (2/8) — metadata bill ĐẦY ĐỦ (billFields OCR gốc + số tiền đã xác nhận + ranh giới ảnh/bảng), parse
   * từ `ChatMessage.metadataJson` qua `parseBillMetadata()` (bill-message-meta.ts). `undefined` = KHÔNG phải
   * bill ĐÃ GHÉP đủ dữ liệu để sửa (ảnh thường, HOẶC bill gửi qua nhánh fallback ảnh gốc chưa ghép — B106 cũ
   * chỉ có `{isBillImage:true}`, không đủ field mới) — nút "Sửa" CHỈ hiện khi field này có giá trị VÀ
   * `isBillImage===true` VÀ `mine===true`, xem `canEditBillMessage()` chat-client.ts. */
  billMeta?: BillMessageMeta;
  /** B123 (2/8, tính năng "Hoàn tiền" MỚI) — true = tin nhắn ẢNH xác nhận HOÀN TIỀN (KHÁC hẳn `isBillImage`,
   * bill GỐC — 2 field LOẠI TRỪ NHAU, KHÔNG BAO GIỜ cùng true) — dùng để ChatBubble.tsx chọn khung hiển thị
   * rộng-không-crop CÙNG `isBillImage` (ảnh ghép bảng cũng cao như bill, xem `message.isBillImage` comment cũ
   * B106). Parse từ `metadataJson.isRefundImage`, xem `parseRefundMetadata()` refund-message-meta.ts. */
  isRefundImage?: boolean;
  /** B123 (2/8) — metadata ĐẦY ĐỦ tin nhắn hoàn tiền (refundFields OCR + số tiền + trạng thái cộng dồn/đối
   * chiếu người nhận TẠI THỜI ĐIỂM xác nhận + lịch sử sửa) — `undefined` nếu KHÔNG phải tin hoàn tiền đủ dữ
   * liệu. Dùng để "Sửa" (EditRefundMessageModal.tsx) + hiện lại cảnh báo đã lưu. */
  refundMeta?: RefundMessageMeta;
  /** B112 (2/8) — thời điểm sửa gần nhất (ISO, `ChatMessage.editedAt`) — `undefined`/không có = chưa từng sửa.
   * ChatBubble.tsx hiện nhãn nhỏ "(đã chỉnh sửa)" cạnh giờ gửi khi có giá trị, kiểu Zalo. */
  editedAt?: string;
  /** Tin nhắn thoại (mục 37) — thời lượng hiển thị, sóng âm vẽ tĩnh từ seed id. `url` (31/7 — ghi âm+phát
   * THẬT, việc #5) trỏ tới `GET /v1/chat/attachments/:id` (bot-api), CÙNG pattern `file.url` ở trên —
   * `undefined` = tin voice mock cũ (`mock-data/chats.ts`, KHÔNG có audio thật để phát — `VoiceMessageBubble`
   * tự fallback về demo progress giả cho trường hợp này, xem comment đầu component đó). */
  voice?: { duration: string; url?: string };
  /** Cảm xúc đã thả (mục 29). */
  reactions?: MessageReaction[];
  /** Thời điểm GỬI THẬT (ISO, từ field `ts` của Rocket.Chat — xem rc-realtime.ts parseRcDate) — 24/7, cần
   * cho ràng buộc "Thu hồi chỉ trong 48h kể từ lúc gửi" (KHÁC `time`, vốn chỉ là chuỗi hiển thị rút gọn
   * "14:32"/"Hôm qua", KHÔNG đủ để tính mốc thời gian chính xác). undefined cho tin nhắn mock thuần
   * (attachImage/shareLocation/... local — KHÔNG có nguồn RC thật, các luồng đó KHÔNG áp ràng buộc 48h vì
   * chưa nối RC thật, xem ConversationScreen.tsx). */
  sentAtIso?: string;
  /** Tính năng "Trả lời" kiểu Zalo (1/8) — id tin nhắn GỐC được trả lời (`ChatMessageDto.replyToMessageId`,
   * server đã nhận/trả field này từ trước — xem chat-client.ts mapChatMessage()). `undefined` = tin thường,
   * không phải trả lời. ConversationScreen.tsx tự resolve tin gốc từ `messages` đã tải trong state theo id
   * này (KHÔNG gọi thêm API) rồi truyền xuống ChatBubble qua prop `repliedMessage` để hiện trích dẫn. */
  replyToMessageId?: string;
  /** Tag @ mention kiểu Zalo (13/8) — danh sách TÊN hiển thị đã được nhắc trong tin (từ `metadataJson.mentionNames`,
   * xem chat-client.ts mapChatMessage() + mention.ts). ChatBubble.tsx tô đậm/nổi bật các `@Tên` này trong nội
   * dung. `undefined`/rỗng = tin thường không có mention. KHÔNG dùng cho backend (backend đọc `metadataJson.mentions`
   * = mảng agentId để tạo thông báo MENTION). */
  mentions?: string[];
  /** Bill CHUYỂN KHOẢN (CK) gửi vào phòng chat (1/9, Admin Demo "cấm text lộn xộn") — tin IMAGE có `metadataJson`
   * `{isTransferRefund:true, ...}` do backend `ocr-send-service.ts` sinh (postDealerRefundCk / postInvestorTransferCk).
   * KHÁC hẳn bill POS (`isBillImage`) và hoàn tiền lẻ (`isRefundImage`, ảnh ghép bảng) — CK transfer TRƯỚC ĐÂY
   * KHÔNG có flag riêng nên rơi vào "ảnh thô + caption text nhiều dòng lộn xộn". Có giá trị → ChatBubble.tsx
   * render `TransferCkCard` (ẢNH bill trái + BẢNG tham số phải, chia ô) THAY cho ảnh-thô+caption. `undefined` =
   * KHÔNG phải bill CK. Parse an toàn từ `metadataJson` qua `parseTransferCkMeta()` (chat-client.ts) — metadata
   * hỏng/thiếu → undefined, KHÔNG throw. */
  transferCk?: TransferCkMeta;
  /** Admin Demo 1/9 — meta ĐẦY ĐỦ bill POS (bank/dateTime/feeLabel/feePct) từ `metadataJson.posBill` do server gắn
   *  khi gửi (dealer/investor). Card POS ƯU TIÊN meta này để hiện đủ tham số NGANG (HKD·TID·Bank·Ngày·Phí), KHÔNG
   *  chỉ parse caption (caption thiếu Bank/Ngày/Phí). `undefined` = bill CŨ (chỉ caption) → card fallback caption. */
  posBillMeta?: PosBillMeta;
}

/** Meta ĐẦY ĐỦ bill POS server gắn vào tin nhắn (metadataJson.posBill). feePct = % phí (bán/cài máy) đã /1000. */
export interface PosBillMeta {
  tid?: string | null;
  hkd?: string | null;
  bank?: string | null;
  dateTime?: string | null;
  amount: number;
  lo?: string | null;
  /** Nhãn phí: 'Phí bán' (phòng đại lý) hoặc 'Phí cài máy' (phòng NĐT). */
  feeLabel?: string | null;
  feePct?: number | null;
  /** Nhãn tiền sau phí: 'Phải hoàn' (đại lý) / 'Tiền về' (NĐT). netAmount = tổng − phí (Admin Demo 1/9). */
  netLabel?: string | null;
  netAmount?: number | null;
  /** Admin Demo 7/9 — tiêu đề card (mặc định 'Bill POS'); bill QR đặt 'Hoàn tiền đại lý (QR)' / 'Bill QR (NĐT)'. */
  title?: string | null;
  /** Số giao dịch QR (ref) — hiện Ô "Số GD" trên card (bill POS không có → ẩn). */
  ref?: string | null;
  /** true = ẩn nút "Sửa" (card QR hoàn tiền — không sửa qua BillParamEditModal của POS). */
  hideEdit?: boolean;
  /** [Admin Demo 25/9] GIAO DỊCH HỦY trên bill tổng kết — doanh số ghi nhận = amount − voidAmount. Phải tới được
   *  thẻ + modal sửa, nếu không người sửa không có chỗ nhập tay khi OCR đọc hụt dòng HỦY. */
  voidAmount?: number | null;
  voidCount?: number | null;
}

/** Loại bill CHUYỂN KHOẢN (CK) suy ra từ cờ metadata backend (ocr-send-service.ts):
 *  - REFUND              = Hoàn tiền đại lý (`isDealerRefundCk`, refundAmount ≥ 0, hướng SIGMA_TO_DEALER)
 *  - DEALER_REFUND_OVER  = Đại lý hoàn thừa về SigMa (`isDealerRefundCk`, refundAmount < 0, hướng DEALER_TO_ALPHA)
 *  - ADVANCE             = Đại lý ứng trước (`isDealerAdvanceCk`)
 *  - INVESTOR_ADVANCE    = Tạm ứng NĐT (`isInvestorAdvanceCk`)
 *  - INVESTOR_REPAYMENT  = NĐT hoàn thừa tạm ứng (`isInvestorRepaymentCk`) */
export type TransferCkKind = 'REFUND' | 'DEALER_REFUND_OVER' | 'ADVANCE' | 'INVESTOR_ADVANCE' | 'INVESTOR_REPAYMENT';

export interface TransferCkMeta {
  kind: TransferCkKind;
  /** Số tiền GD (có thể ÂM với DEALER_REFUND_OVER — UI hiển thị trị tuyệt đối + nhãn hướng). */
  amount: number;
  /** Ngày TRÊN bill CK (chuỗi `dd/MM/yyyy` hoặc ISO ngày, backend `billDate`). CHỈ có ở CK đại lý — CK NĐT
   *  backend hiện KHÔNG kèm `billDate` → undefined. */
  billDate?: string;
  /** Mã giao dịch (backend `ckTxnKey`, vd `ck|ref|FT2412...` / `ck|hash|...`) — dùng dedup. UI rút gọn hiển thị. */
  ckTxnKey?: string;
  /** Hướng bill (backend `direction`: SIGMA_TO_DEALER / DEALER_TO_ALPHA / SIGMA_TO_INVESTOR / INVESTOR_TO_ALPHA).
   *  CHỈ có ở CK NĐT (advance/repayment) — CK đại lý backend KHÔNG kèm → undefined. */
  direction?: string;
  /** Tên ĐẠI LÝ/NĐT (đích) — server gắn từ nhóm/entity (Admin Demo 1/9 "hiện tên trên card"). Ưu tiên hiện. */
  partyName?: string;
  /** Tên người GỬI / NHẬN trên bill CK (từ OCR) — fallback khi không có partyName. */
  senderName?: string;
  receiverName?: string;
  /** Trạng thái chuyển khoản (Admin Demo 1/9 "thêm trạng thái bill CK: thành công tích xanh, thất bại đỏ"). Card CK
   *  chỉ được post SAU khi ghi giao dịch thành công (fail-closed) → mặc định = 'success'. `undefined` (bill cũ) cũng
   *  coi như success (đã post = đã thành công). 'failed' dành cho trường hợp post-được-nhưng-lỗi (vd partial). */
  status?: 'success' | 'failed';
}

export interface TidItem {
  id: string;
  code: string;
  bank: string;
  feePercent: number;
}

export interface LoRecord {
  id: string;
  code: string;
  date: string;
  totalAmount: number;
  status: string;
  flagCount: number;
}

// 'TRI' = cờ "đối chiếu tam giác lệch" (triangulateMismatch trong packages/business-rules/src/
// sigma-fraud-rules.ts) — khái niệm THẬT trong engine nhưng KHÔNG phải Rule A-F, tách mã riêng
// theo finding CMD_AUDIT 23/7 (trước đây demo gán nhầm "lệch OCR" vào Rule A).
export type FraudRuleCode = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'TRI';
export type FraudSeverity = 'nhe' | 'nghiem_trong';

export interface FraudFlag {
  rule: FraudRuleCode;
  severity: FraudSeverity;
  description: string;
}

export interface ReconcileLine {
  id: string;
  tid: string;
  amount: number;
  billMatched: boolean;
  flags: FraudFlag[];
}

export interface KpiMonth {
  month: string;
  revenue: number;
  tidSold: number;
}
