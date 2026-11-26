// Ô nhập tin nhắn + nút đính kèm ảnh/vị trí/chụp màn hình (mục 23)/file (mục 30)/ghi âm (mục 37) +
// panel emoji-sticker (mục 38).
//
// SIGMA (31/7, mục 23 — chụp màn hình gửi vào chat THẬT, thay nút mock cũ "bấm 1 phát tạo tin nhắn ảnh
// giả `chup-man-hinh-N.png` ngay lập tức" ở ConversationScreen.tsx `captureScreen()` CŨ, đã XÓA):
//   - Bấm nút Camera "Chụp màn hình" → `captureScreenshot()` (screen-capture.ts — THẬT, dùng chuẩn Web Screen
//     Capture API `getDisplayMedia()`, xem comment đầu file đó) → trình duyệt tự hiện dialog cho người dùng
//     chọn màn hình/cửa sổ/tab → vẽ 1 khung hình → PNG Blob → tải lên qua `uploadAndSend()` (CÙNG hạ tầng
//     upload dùng chung với ảnh/file/voice, gọi với `kind:'image'` — server allowlist `image/png` đã có sẵn).
//   - `capturingScreen` (cục bộ) = đang trong giai đoạn chờ dialog chọn màn hình + vẽ khung hình (TRƯỚC khi
//     có Blob để upload) — disable + xoay icon nút Camera, CÙNG khuôn `attachBusy` cho ảnh/file/voice. Sau khi
//     có Blob, `uploadAndSend(file,'image')` tự chuyển sang `attachBusy==='image'` (dùng CHUNG luồng/UI với
//     nút "Đính kèm ảnh" — 1 ảnh đang tải lên là 1 ảnh đang tải lên, không cần state riêng cho giai đoạn này).
//   - Lỗi (`captureScreenshot()` throw — người dùng bấm "Hủy" ở dialog chọn màn hình, API không tồn tại trên
//     thiết bị này, không đọc được nội dung) → hiện qua `onAttachError` (banner lỗi CHUNG đã có, CÙNG khuôn
//     ảnh/file/voice), KHÔNG vỡ UI.
//   - **GAP THẬT trên Android WebView (APK Capacitor) — ĐÃ TỰ TRA CỨU (KHÔNG suy đoán), xem chi tiết nguồn ở
//     đầu `screen-capture.ts`:** MDN `browser-compat-data` xác nhận `getDisplayMedia` KHÔNG được hỗ trợ trên
//     Android WebView LẪN Chrome Android (`webview_android` mirror `chrome_android` = `version_added: false`).
//     Trên APK Android, `isScreenCaptureSupported()` (screen-capture.ts) sẽ trả `false` → nút bấm hiện lỗi
//     "Thiết bị/trình duyệt này không hỗ trợ chụp màn hình" qua `onAttachError`, KHÔNG crash — nhưng tính
//     năng CHƯA dùng được thật trên Android, chỉ Engineering PASS trên trình duyệt desktop (Chrome/Edge).
//
// SIGMA (31/7, việc #5 — ghi âm tin nhắn thoại THẬT, thay nút mock cũ "bấm 1 phát tạo tin nhắn giả
// `{duration:'0:12'}` ngay lập tức" ở ConversationScreen.tsx `recordVoice()` CŨ, đã XÓA):
//   - Bấm nút Mic LẦN 1 → `startRecording()` (voice-recording.ts, THẬT — MediaRecorder+getUserMedia, ĐÃ có sẵn
//     trước đó nhưng mồ côi, KHÔNG nơi nào gọi tới) → xin quyền mic, ghi âm thật, đổi icon Mic→Square + màu đỏ
//     + hiện đồng hồ đếm mm:ss sống (elapsed từ lúc bắt đầu, cập nhật mỗi 250ms).
//   - Bấm LẦN 2 (CÙNG 1 nút) → `stop()` lấy Blob → nếu ghi QUÁ NGẮN (< MIN_RECORDING_DURATION_MS, khả năng bấm
//     nhầm) → âm thầm hủy, KHÔNG mở preview (CÙNG tinh thần "hủy picker không phải lỗi thật" của
//     handleAttachImageClick() dưới) → ngược lại, MỞ PREVIEW xác nhận (xem 1/8 bên dưới — KHÔNG upload/gửi
//     NGAY ở bước này nữa, xem lý do sửa đổi).
//   - `durationSeconds` đo bằng WALL-CLOCK thật (Date.now() lúc bắt đầu → Date.now() lúc dừng), KHÔNG đo qua
//     `<audio>` element metadata — Chrome/Chromium có lỗi đã biết rộng rãi: Blob WebM do MediaRecorder tạo ra
//     báo `duration=Infinity` ngay sau khi tải (thiếu Cues/SeekHead trong header), nên đo trực tiếp thời gian
//     ghi THẬT đáng tin cậy hơn hẳn, xem thêm chat-client.ts formatSecondsToDurationLabel()/VoiceMessageBubble.tsx.
//   - Lỗi ghi âm (`startRecording()` throw — từ chối quyền/không có mic/mic đang bận, đã dịch tiếng Việt sẵn ở
//     voice-recording.ts) → hiện qua `onAttachError` (banner lỗi CHUNG đã có, CÙNG khuôn ảnh/file), KHÔNG vỡ UI.
//   - Unmount/đổi phòng giữa lúc đang ghi (điều hướng đi nơi khác) → TỰ ĐỘNG dừng recorder + giải phóng mic
//     (cleanup effect) — KHÔNG để mic treo chạy nền sau khi rời màn hình.
//
// SIGMA (1/8, Admin Demo yêu cầu — "lỡ tay là gửi rác luôn, cần chặn lại") — SỬA hành vi bước 2 ở trên: dừng
// ghi âm KHÔNG còn upload+gửi NGAY LẬP TỨC nữa (hành vi CŨ, đã bỏ). Thay vào đó mở `voiceDraft` (Blob cục bộ +
// object URL preview, CÙNG khuôn `billDraft`/`openBillDraft()`/`closeBillDraft()` đã có sẵn cho luồng "Quét
// bill" — tái dùng ĐÚNG pattern, không phát minh cơ chế mới): hiện thanh xác nhận kiểu Zalo (nút Nghe lại
// play/pause qua `<audio>` + object URL cục bộ, CÙNG cách `VoiceMessageBubble.tsx` phát audio đã ghi — khác 1
// điểm: ở ĐÂY là Blob CHƯA upload, dùng THẲNG `URL.createObjectURL(blob)` cục bộ, KHÔNG qua
// `fetchAttachmentObjectUrl()`/CSRF vì chưa có gì trên server để fetch) kèm 2 nút "Gửi" (upload+gửi THẬT lúc
// này, xem `confirmVoiceSend()`) / "Xóa" (`closeVoiceDraft()` — bỏ Blob, thu hồi object URL, quay lại composer
// bình thường, KHÔNG gửi gì). Panel này THAY THẾ hàng nút chính (textarea/Send/Mic...) khi đang preview — xem
// JSX cuối file (nhánh `voiceDraft ? ... : ...`).
//
// 26/7 (B29-tiếp) — thêm 2 tính năng nối RC THẬT:
//   1. Bộ đếm ký tự + tự tách khi vượt MAX_MESSAGE_CHARS (splitMessageIntoChunks, rc-realtime.ts) — gửi TUẦN
//      TỰ từng đoạn (đợi đoạn trước xong mới gửi đoạn sau, xem prop `onSend` giờ nhận Promise) để giữ đúng
//      thứ tự hiển thị (real-time WS đẩy tin về theo thứ tự RC nhận, gửi dồn dập song song CÓ THỂ đảo thứ tự).
//   2. Typing indicator — gọi `onTypingChange(true/false)` khi người dùng gõ/ngừng gõ, DEBOUNCE ở ĐÂY (ngưỡng
//      UX tự chọn — xem TYPING_STOP_DEBOUNCE_MS bên dưới), KHÔNG debounce trong sendTypingStatus() (hàm đó
//      chỉ gửi ngay khi được gọi, xem rc-realtime.ts).
//
// 27/7 ("Phần 1" kế hoạch đính kèm) — đính kèm ảnh/file THẬT (thay mock `dinh-kem-*.jpg`/`TaiLieu_*.pdf` cũ):
//   - Ảnh: `@capacitor/camera` (`Camera.getPhoto`, `CameraSource.Prompt` — cho chọn Máy ảnh/Thư viện) trên app
//     di động thật (`Capacitor.isNativePlatform()`); trình duyệt thường (web-demo chạy dev/preview) KHÔNG có
//     API camera-chụp gốc tương đương → fallback `<input type="file" accept="image/*">` ẩn (CÙNG cách xử lý
//     "web vs native" đã dùng ở MyQrScreen.tsx cho quét QR).
//   - File: LUÔN `<input type="file">` ẩn (không có khái niệm "camera" cho file thường).
//   - Cả 2 nhánh: tải lên qua `uploadChatAttachment()` (rc-realtime.ts, multipart tới bot-api) rồi gọi prop
//     MỚI `onSendAttachment` (KHÔNG tự gọi sendMessage() ở component này — composer không biết room.id, giữ
//     đúng phân tầng đã có: parent ConversationScreen.tsx mới nắm room.id, xem cách `onSend` hiện có hoạt
//     động). Lỗi (quá 50MB/sai định dạng/mạng/gửi tin marker thất bại) hiện qua banner lỗi CHUNG của parent
//     (`sendError`, CÙNG chỗ lỗi gửi tin nhắn thường) — KHÔNG thêm 1 ô lỗi riêng ở đây (tái dùng convention đã
//     có, đúng yêu cầu).
//   - `attachBusy` (cục bộ, CHỈ ở component này) disable đúng 1 nút đang xử lý + hiện icon xoay — KHÔNG khóa
//     cả composer (người dùng vẫn gõ/gửi tin chữ bình thường trong lúc ảnh/file đang tải lên nền).
//
// B82 (31/7, Admin Demo tự cầm điện thoại test báo ảnh chụp thật — hàng nút tràn/che trên màn hình hẹp) — gom
// bớt nút vào menu "+" kiểu Zalo, thay vì 6 icon (Smile/Image/MapPin/Camera/Paperclip/Mic) cùng nằm 1 hàng
// ngang (do B76+B79 thêm Mic/Camera vào ĐÚNG hàng cũ, quá nhiều phần tử cho màn hình điện thoại hẹp):
//   - Hàng chính (luôn hiện) CHỈ còn: Emoji, "Đính kèm ảnh" (hành động dùng thường xuyên nhất, giữ trực
//     tiếp), nút MỚI "+" (`moreMenuOpen`, CÙNG khuôn panel nổi `emojiOpen` — absolute bottom-full), Mic (ghi
//     âm cũng là thao tác thường dùng, giữ trực tiếp ngoài cùng giống Zalo), textarea, nút Gửi.
//   - Bấm "+" mở panel nổi 3 lựa chọn dạng icon lớn + nhãn chữ (giống lưới sticker đã có, KHÔNG phải dropdown
//     danh sách chữ): "Vị trí" (`onShareLocation`), "Chụp màn hình" (`handleCaptureScreenClick`), "File"
//     (`handleAttachFileClick`) — GIỮ NGUYÊN 100% logic 3 hàm này, CHỈ đổi vị trí nút kích hoạt. Bấm 1 lựa
//     chọn → tự đóng panel "+".
//   - `emojiOpen`/`moreMenuOpen` loại trừ lẫn nhau (bấm cái này tự đóng cái kia) — CHỈ 1 panel nổi hiện tại 1
//     thời điểm, tránh chồng 2 panel. Panel Emoji cũ KHÔNG có cơ chế tự đóng khi bấm ra ngoài (đã grep xác
//     nhận), nên panel "+" cũng KHÔNG thêm cơ chế đó (ngoài phạm vi fix này).
//   - Đang ghi âm (`recording=true`) → ẨN TẠM nút "+" (nhường chỗ hiện đồng hồ đếm giây + nút dừng NGAY TRÊN
//     nút Mic, xem JSX dưới — tránh tràn hàng lúc đang ghi).
import { lazy, Suspense, useEffect, useRef, useState, type ChangeEvent, type JSX } from 'react';
import { Camera as CameraIcon, Image as ImageIcon, MapPin, Mic, Pause, Paperclip, Play, Plus, ScanLine, Send, Smile, Square, Trash2 } from 'lucide-react';
import { DotsLoader } from './DotsLoader';
import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Capacitor } from '@capacitor/core';
import { MAX_MESSAGE_CHARS, splitMessageIntoChunks, uploadChatAttachment, type UploadedChatAttachment } from '../lib/rc-realtime';
import { formatSecondsToDurationLabel } from '../lib/chat-client';
import { startRecording, type VoiceRecordingHandle } from '../lib/voice-recording';
import { captureScreenshot } from '../lib/screen-capture';
// LAG-FIX v2 WIRE (12/8) — nối thư viện thu nhỏ ảnh (image-resize.ts) vào 2 đường "Ảnh" THƯỜNG bên dưới
// (handlePickedImageFile + handleAttachImageClick). CỐ Ý KHÔNG dùng cho Quét bill/Chụp màn hình/File/Ghi âm —
// xem docstring composer-image-send.ts + đầu image-resize.ts cho lý do phạm vi hẹp.
import { sendResizedImage } from '../lib/composer-image-send';
// P4 (6/8, tách chunk) — OcrBillPreview kéo theo `lib/bill-table-image` (~39KB canvas ghép ảnh bill). Chỉ mở
// khi người dùng "Quét bill" (billDraft) → nạp ĐỘNG (lazy) để 39KB tách khỏi chunk ConversationScreen (tải
// ngay lúc mở phòng). Bọc <Suspense fallback={null}> tại chỗ render.
const OcrBillPreview = lazy(() => import('./OcrBillPreview').then((m) => ({ default: m.OcrBillPreview })));
import type { BillMessageMeta } from '../lib/bill-message-meta';
// Tag @ mention kiểu Zalo (13/8) — dò token @ tại caret / lọc thành viên không dấu / chèn @Tên / trích mention.
import {
  findMentionQuery,
  filterMentionCandidatesWithAll,
  applyMention,
  extractActiveMentions,
  type MentionMember,
  type MentionDraft,
  type MentionQuery
} from '../lib/mention';

/** Đuôi file chấp nhận cho input "Đính kèm file" (gợi ý picker hệ điều hành — KHÔNG phải kiểm tra bảo mật
 * thật, đó là việc của server qua magic-bytes, xem chat-attachment-service.ts ALLOWED_MIME_TO_EXT). Chọn file
 * ngoài danh sách này vẫn bị server từ chối đúng, chỉ là picker không GỢI Ý sẵn — trải nghiệm tốt hơn, không
 * phải lớp bảo mật. */
const FILE_ACCEPT = '.pdf,.docx,.xlsx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** Sau NGẦN NÀY mili-giây không gõ thêm → tự báo "ngừng gõ" (quyết định UX tự chọn, KHÔNG phải hành vi RC —
 * RC không tự có khái niệm timeout, xem comment rc-realtime.ts). 2.5s là ngưỡng phổ biến ở các app chat
 * tương tự (đủ để không nhấp nháy liên tục khi gõ ngắt quãng bình thường, không quá lâu khiến chỉ báo "còn
 * treo" sau khi người dùng đã thật sự dừng gõ). */
const TYPING_STOP_DEBOUNCE_MS = 2500;

// ~40 emoji unicode phổ biến (mục 38 — tab Emoji, bấm chèn THẬT vào ô nhập).
const EMOJIS = [
  '😀', '😁', '😂', '🤣', '😊', '😍', '😘', '😎', '🤔', '😅',
  '😭', '😡', '👍', '👎', '👌', '🙏', '👏', '💪', '🤝', '✌️',
  '❤️', '💔', '💯', '🔥', '⭐', '🎉', '🎁', '💰', '💸', '🏦',
  '📱', '💳', '🧾', '📊', '✅', '❌', '⚠️', '⏰', '📍', '🚀'
];

// 8 sticker mock — emoji to trên nền màu (Phase 1+ mới là bộ sticker ảnh thật).
const STICKERS = [
  { emoji: '🥰', bg: '#fde68a' },
  { emoji: '😆', bg: '#bbf7d0' },
  { emoji: '😱', bg: '#bfdbfe' },
  { emoji: '🤑', bg: '#fbcfe8' },
  { emoji: '👍', bg: '#ddd6fe' },
  { emoji: '🎉', bg: '#fecaca' },
  { emoji: '💸', bg: '#a7f3d0' },
  { emoji: '🫡', bg: '#e2e8f0' }
];

export function MessageComposer({
  onSend,
  onSendAttachment,
  onAttachError,
  onShareLocation,
  onSendSticker,
  onTypingChange,
  initialEmojiOpen,
  mentionMembers
}: {
  /** Gửi 1 đoạn tin nhắn (ĐÃ tách sẵn nếu vượt ngưỡng, xem submit() bên dưới). Audit độc lập 26/7 (finding
   * HIGH, xem BUGS_FIXED.md): PHẢI trả tín hiệu thành/bại rõ ràng (`boolean`/`Promise<boolean>`, `true` =
   * thành công) — submit() dừng NGAY vòng lặp gửi nhiều đoạn khi 1 đoạn thất bại, KHÔNG âm thầm gửi tiếp các
   * đoạn sau (mất dữ liệu không dấu vết). Hỗ trợ cả sync lẫn async (ConversationScreen.tsx dùng async, gọi RC
   * qua rc-realtime.ts). Không trả gì (`void`) coi như LUÔN thành công (Phase 0 mock chưa có khái niệm lỗi). */
  /** Tag @ mention (13/8) — tham số THỨ 2 `mentions` (OPTIONAL): danh sách người được nhắc CÒN trong đoạn text
   * này (agentId + tên hiển thị), parent (ConversationScreen) dùng để dựng `metadataJson.mentions` gửi lên server.
   * `undefined`/rỗng = đoạn không có mention (GIỮ NGUYÊN hành vi cũ 100%). */
  onSend: (text: string, mentions?: MentionDraft[]) => boolean | void | Promise<boolean | void>;
  /** 27/7 — gọi SAU KHI file đã tải lên bot-api thành công (component này tự lo bước upload, xem
   * uploadAndSend() bên dưới) — parent (ConversationScreen.tsx) chịu trách nhiệm gửi tin nhắn marker RC thật
   * qua sendMessage() + PATCH roomId (composer không giữ room.id). Trả `false`/reject → hiện lỗi qua banner
   * chung của parent, CÙNG khuôn `onSend`. Optional — KHÔNG bắt buộc mọi nơi dùng MessageComposer khác (nếu
   * có Phase mock) phải nối, giống `onTypingChange`. */
  /** 31/7 (việc #5) — mở rộng `kind` thêm `'voice'` + tham số `durationSeconds` (chỉ có nghĩa cho voice, đo
   * WALL-CLOCK thật lúc ghi âm — xem comment đầu file). `image`/`file` gọi hàm này với `durationSeconds`
   * `undefined` (KHÔNG đổi hành vi 2 luồng cũ). */
  /** 1/8 — mở rộng thêm `caption` (chỉ có nghĩa cho `kind==='image'` khi gửi từ luồng "Quét bill" mới, xem
   * `handleConfirmBillSend()`/`OcrBillPreview.tsx`): số tiền OCR đã người dùng xác nhận/sửa tay, VD
   * "Bill: 52.700.000đ" — parent (ConversationScreen.tsx `sendAttachment()`) dùng làm `body` tin nhắn THAY vì
   * `fileName` mặc định khi có giá trị. `undefined` (luồng ảnh/file/voice cũ) → GIỮ NGUYÊN hành vi cũ (`body`
   * = `fileName`), KHÔNG đổi behavior 3 luồng hiện có. */
  onSendAttachment?: (
    upload: UploadedChatAttachment,
    kind: 'image' | 'file' | 'voice',
    fileName: string,
    mimeType: string,
    sizeBytes: number,
    durationSeconds?: number,
    caption?: string,
    /** B112 (2/8) — CHỈ có giá trị cho luồng "Quét bill" khi ảnh ĐÃ GHÉP bảng (xem docstring `onConfirm`
     * OcrBillPreview.tsx) — parent (ConversationScreen.tsx `sendAttachment()`) dùng để build `metadataJson`
     * ĐẦY ĐỦ (`buildBillMetadataJson()`, bill-message-meta.ts) thay vì chỉ `{isBillImage:true}` cũ, cho phép
     * "Sửa" lại sau này. `undefined` (mọi luồng khác + bill fallback ảnh gốc chưa ghép) → GIỮ NGUYÊN hành vi
     * cũ. */
    billMeta?: BillMessageMeta
  ) => boolean | void | Promise<boolean | void>;
  /** 27/7 — báo lỗi xảy ra Ở TẦNG UPLOAD (quá 50MB/sai định dạng/mạng lỗi/không mở được Camera/không ghi âm
   * được — 31/7 mở rộng thêm nguồn lỗi ghi âm, CÙNG đường báo lỗi này) — TRƯỚC KHI có attachment id để gọi
   * `onSendAttachment`, nên cần đường báo lỗi RIÊNG (khác `onSendAttachment` trả `false`, đó là lỗi Ở BƯỚC GỬI
   * TIN MARKER RC, sau khi upload đã xong). Parent nên set CHUNG 1 banner lỗi (`sendError`) cho cả nguồn —
   * người dùng không cần phân biệt, chỉ cần thấy lỗi rõ ràng. */
  onAttachError?: (message: string) => void;
  onShareLocation?: () => void;
  onSendSticker?: (emoji: string) => void;
  /** Báo đang gõ (true)/ngừng gõ (false) — CHỈ có ý nghĩa khi component nối RC thật (ConversationScreen
   * truyền vào); optional để KHÔNG bắt buộc mọi nơi dùng MessageComposer khác (nếu có Phase mock) phải nối. */
  onTypingChange?: (isTyping: boolean) => void;
  initialEmojiOpen?: boolean;
  /** Tag @ mention kiểu Zalo (13/8) — danh sách thành viên phòng (agentId + tên hiển thị) để gợi ý khi gõ `@`.
   * CHỈ truyền cho phòng GROUP (ConversationScreen tự lọc: DIRECT 1-1 KHÔNG cần mention). `undefined`/rỗng =
   * TẮT tính năng mention (không hiện dropdown) — GIỮ NGUYÊN hành vi cũ cho mọi nơi khác dùng composer. Đã loại
   * chính mình + thành viên đã rời/vô hiệu hóa ở phía parent. */
  mentionMembers?: MentionMember[];
}): JSX.Element {
  const [text, setText] = useState('');
  // Tag @ mention kiểu Zalo (13/8) — dropdown gợi ý thành viên khi caret ở trong token `@xxx`. `mentionQuery` =
  // token hiện tại (null = không mở dropdown); `mentionCandidates` = thành viên khớp; `mentionActiveIndex` =
  // dòng đang chọn (↑↓). `mentionDraftsRef` giữ mọi mention ĐÃ CHÈN (agentId+tên) — lúc gửi trích lại những cái
  // CÒN trong text. `textareaRef` để đọc/đặt caret; `pendingCaretRef` đặt caret sau khi chèn xong (post-render).
  const mentionEnabled = !!mentionMembers && mentionMembers.length > 0;
  const [mentionQuery, setMentionQuery] = useState<MentionQuery | null>(null);
  const [mentionCandidates, setMentionCandidates] = useState<MentionMember[]>([]);
  const [mentionActiveIndex, setMentionActiveIndex] = useState(0);
  const mentionDraftsRef = useRef<MentionDraft[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const [emojiOpen, setEmojiOpen] = useState(!!initialEmojiOpen);
  // B82 (31/7) — panel nổi "+" (Vị trí/Chụp màn hình/File), CÙNG khuôn `emojiOpen`. Loại trừ lẫn nhau với
  // `emojiOpen` (xem 2 hàm toggle bên dưới JSX nút Smile/Plus) — chỉ 1 panel nổi hiện tại 1 thời điểm.
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const [tab, setTab] = useState<'emoji' | 'sticker'>('emoji');
  const [sending, setSending] = useState(false);
  // 27/7 — 'image'/'file'/'voice' (31/7) = đang tải lên đúng loại đó (disable + xoay icon ĐÚNG 1 nút, KHÔNG
  // khóa nút kia), `null` = rảnh. KHÔNG dùng chung biến `sending` (đó là cho gửi CHỮ, 2 luồng độc lập, gửi chữ
  // vẫn dùng được bình thường trong lúc ảnh/file/voice đang tải lên nền). LƯU Ý: `attachBusy==='voice'` CHỈ
  // đúng ở GIAI ĐOẠN UPLOAD SAU KHI dừng ghi âm — trong LÚC đang ghi âm dùng state `recording` riêng (KHÔNG
  // phải attachBusy — 2 trạng thái UI khác hẳn nhau: "đang ghi" vs "đang tải lên", xem JSX nút Mic dưới).
  const [attachBusy, setAttachBusy] = useState<'image' | 'file' | 'voice' | null>(null);
  const imageFileInputRef = useRef<HTMLInputElement | null>(null); // fallback web (KHÔNG có Capacitor Camera).
  const genericFileInputRef = useRef<HTMLInputElement | null>(null);
  // 31/7 (việc #5) — ghi âm tin nhắn thoại THẬT, xem comment đầu file. `recording` = đang ghi (nút Mic→Square
  // đỏ); `recordElapsedMs` cập nhật mỗi 250ms để hiện đồng hồ đếm sống; `recordHandleRef`/`recordStartedAtRef`
  // giữ handle `stop()` + mốc `Date.now()` lúc bắt đầu (ref, KHÔNG phải state — không cần re-render khi đổi,
  // chỉ đọc lại lúc dừng).
  const [recording, setRecording] = useState(false);
  const [recordElapsedMs, setRecordElapsedMs] = useState(0);
  const recordHandleRef = useRef<VoiceRecordingHandle | null>(null);
  const recordStartedAtRef = useRef<number>(0);
  const recordTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 1/8 (Admin Demo yêu cầu — xác nhận/hủy TRƯỚC khi gửi ghi âm) — `voiceDraft` = bản ghi ĐÃ dừng, đang chờ người
  // dùng xác nhận (object URL cục bộ, KHÔNG phải URL server — CHƯA upload gì cho tới khi bấm "Gửi", xem
  // `confirmVoiceSend()`). `voiceDraftRef` mirror ĐÚNG giá trị hiện tại (CÙNG lý do `billDraftRef` ở trên —
  // effect cleanup unmount không bị lệch pha đọc state cũ qua closure). `voicePreviewPlaying`/
  // `voicePreviewAudioRef` cho nút Nghe lại play/pause trong panel xác nhận.
  const [voiceDraft, setVoiceDraft] = useState<{ blob: Blob; previewUrl: string; durationSeconds: number } | null>(null);
  const voiceDraftRef = useRef<{ blob: Blob; previewUrl: string; durationSeconds: number } | null>(null);
  const [voicePreviewPlaying, setVoicePreviewPlaying] = useState(false);
  const voicePreviewAudioRef = useRef<HTMLAudioElement | null>(null);
  // Mục 23 (31/7) — chụp màn hình THẬT, xem comment đầu file. `capturingScreen` CHỈ đúng trong giai đoạn chờ
  // dialog chọn màn hình + vẽ khung hình (TRƯỚC khi có Blob) — sau đó `uploadAndSend()` tự chuyển sang
  // `attachBusy==='image'` (dùng CHUNG UI/luồng với ảnh thường, xem nút Camera bên dưới).
  const [capturingScreen, setCapturingScreen] = useState(false);
  // Theo dõi trạng thái "đang báo gõ" cục bộ (tránh gọi onTypingChange(true) LẶP LẠI mỗi phím gõ — chỉ gọi
  // lúc CHUYỂN từ ngừng→đang gõ; false thì gọi lại mỗi lần hết hạn debounce/gửi tin/unmount, vô hại nếu gọi
  // lặp vì sendTypingStatus() không có trạng thái để lệch).
  const isTypingRef = useRef(false);
  const stopTypingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 1/8 (Admin Demo báo thật — panel emoji/sticker + panel "+" không tự ẩn khi chạm ra ngoài) — ref bọc quanh
  // panel NỔI + ref bọc quanh nút BẤM MỞ tương ứng (Smile/Plus), dùng cho click-outside bên dưới. Loại trừ cả
  // 2 ref (không chỉ panel) khỏi "ngoài" — nếu chỉ loại trừ panel, bấm LẠI đúng nút mở để tự đóng sẽ bị
  // listener đóng trước (mousedown) rồi onClick của nút lại mở lại ngay sau (nhấp nháy, không đóng được bằng
  // chính nút mở).
  const emojiPanelRef = useRef<HTMLDivElement | null>(null);
  const emojiToggleRef = useRef<HTMLButtonElement | null>(null);
  const moreMenuPanelRef = useRef<HTMLDivElement | null>(null);
  const moreMenuToggleRef = useRef<HTMLButtonElement | null>(null);
  // 1/8 — "Quét bill" (RIÊNG nút "Ảnh" thường, xem comment handleScanBillClick() dưới). `scanningBill` = đang
  // chờ Camera.getPhoto()/dialog chọn ảnh (TRƯỚC khi có File để mở preview) — CÙNG khuôn `capturingScreen`.
  // `billDraft` = ảnh ĐÃ chụp/chọn xong, đang chờ người dùng xác nhận trong `OcrBillPreview.tsx` (`previewUrl`
  // là object URL cục bộ, KHÔNG phải URL server — ảnh CHƯA upload gì cho tới khi bấm "Gửi" trong panel đó, xem
  // handleConfirmBillSend()). `billDraftRef` mirror ĐÚNG giá trị `billDraft` hiện tại (không lệch pha như đọc
  // state qua closure cũ trong effect cleanup) để effect unmount bên dưới thu hồi object URL nếu người dùng rời
  // phòng/unmount giữa lúc panel preview còn đang mở (tránh rò rỉ object URL).
  const [scanningBill, setScanningBill] = useState(false);
  const [billDraft, setBillDraft] = useState<{ file: File; previewUrl: string } | null>(null);
  const billDraftRef = useRef<{ file: File; previewUrl: string } | null>(null);
  const billFileInputRef = useRef<HTMLInputElement | null>(null); // fallback web (KHÔNG có Capacitor Camera).

  useEffect(() => setEmojiOpen(!!initialEmojiOpen), [initialEmojiOpen]);

  // Click/chạm RA NGOÀI panel emoji/sticker → tự đóng (chuẩn UX popover, Admin Demo báo thật 1/8) — CHỈ đăng ký
  // listener khi panel đang mở (tránh rò rỉ listener sống suốt vòng đời component). `mousedown`/`touchstart`
  // (KHÔNG phải `click`) — bắt được TRƯỚC khi target con bên trong panel kịp xử lý onClick riêng của nó, và
  // tương thích cả chuột lẫn cảm ứng.
  useEffect(() => {
    if (!emojiOpen) return;
    function handleOutside(e: MouseEvent | TouchEvent): void {
      const target = e.target as Node;
      if (emojiPanelRef.current?.contains(target)) return;
      if (emojiToggleRef.current?.contains(target)) return;
      setEmojiOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchstart', handleOutside);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
    };
  }, [emojiOpen]);

  // CÙNG cơ chế trên, áp dụng cho panel "+" (Vị trí/Chụp màn hình/File, B82).
  useEffect(() => {
    if (!moreMenuOpen) return;
    function handleOutside(e: MouseEvent | TouchEvent): void {
      const target = e.target as Node;
      if (moreMenuPanelRef.current?.contains(target)) return;
      if (moreMenuToggleRef.current?.contains(target)) return;
      setMoreMenuOpen(false);
    }
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('touchstart', handleOutside);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('touchstart', handleOutside);
    };
  }, [moreMenuOpen]);

  // Dọn timer + báo ngừng gõ khi rời màn hình (đổi phòng/unmount) — KHÔNG để lại chỉ báo "đang gõ" treo mãi
  // phía người nhận nếu người dùng rời đi giữa chừng không gõ tiếp.
  useEffect(() => {
    return () => {
      if (stopTypingTimerRef.current) clearTimeout(stopTypingTimerRef.current);
      if (isTypingRef.current) {
        isTypingRef.current = false;
        onTypingChange?.(false);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ chạy cleanup lúc unmount, không phải mỗi lần onTypingChange đổi identity.
  }, []);

  /** Tag @ mention (13/8) — dò lại token @ tại caret sau mỗi lần gõ/di chuyển caret. Đóng dropdown nếu caret
   *  không nằm trong token mention HOẶC không còn thành viên nào khớp. `mentionEnabled=false` (DIRECT/không có
   *  thành viên) → luôn no-op. */
  function refreshMentionState(value: string, caret: number | null | undefined): void {
    if (!mentionEnabled || caret == null) {
      if (mentionQuery) setMentionQuery(null);
      return;
    }
    const q = findMentionQuery(value, caret);
    if (!q) {
      if (mentionQuery) setMentionQuery(null);
      return;
    }
    const candidates = filterMentionCandidatesWithAll(mentionMembers ?? [], q.query);
    if (candidates.length === 0) {
      if (mentionQuery) setMentionQuery(null);
      return;
    }
    setMentionQuery(q);
    setMentionCandidates(candidates);
    setMentionActiveIndex(0);
  }

  function closeMentionDropdown(): void {
    if (mentionQuery) setMentionQuery(null);
  }

  /** Chọn 1 thành viên trong dropdown → thay token `@xxx` bằng `@Tên `, ghi nhớ mention (agentId), đặt caret
   *  ngay sau tên (post-render qua pendingCaretRef). */
  function selectMention(member: MentionMember): void {
    const q = mentionQuery;
    if (!q) return;
    const { text: newText, caret } = applyMention(text, q, member);
    setText(newText);
    mentionDraftsRef.current = [...mentionDraftsRef.current, { agentId: member.agentId, name: member.name }];
    setMentionQuery(null);
    pendingCaretRef.current = caret;
  }

  // Đặt lại caret + focus sau khi chèn `@Tên ` (state text đã cập nhật, DOM vừa render xong).
  useEffect(() => {
    if (pendingCaretRef.current != null && textareaRef.current) {
      const pos = pendingCaretRef.current;
      pendingCaretRef.current = null;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(pos, pos);
    }
  }, [text]);

  function handleTextChange(v: string, caret?: number): void {
    setText(v);
    refreshMentionState(v, caret);
    if (v.length === 0) mentionDraftsRef.current = []; // xóa sạch ô nhập → quên mọi mention đã chèn.
    if (!onTypingChange) return;
    if (v.trim().length === 0) {
      // Xóa hết nội dung — coi như ngừng gõ ngay, không đợi debounce.
      if (stopTypingTimerRef.current) clearTimeout(stopTypingTimerRef.current);
      if (isTypingRef.current) {
        isTypingRef.current = false;
        onTypingChange(false);
      }
      return;
    }
    if (!isTypingRef.current) {
      isTypingRef.current = true;
      onTypingChange(true);
    }
    if (stopTypingTimerRef.current) clearTimeout(stopTypingTimerRef.current);
    stopTypingTimerRef.current = setTimeout(() => {
      isTypingRef.current = false;
      onTypingChange(false);
    }, TYPING_STOP_DEBOUNCE_MS);
  }

  async function submit(): Promise<void> {
    const v = text.trim();
    if (!v || sending) return;

    // Gửi rồi → coi như ngừng gõ ngay (không đợi debounce cũ), xem comment TYPING_STOP_DEBOUNCE_MS đầu file.
    if (stopTypingTimerRef.current) clearTimeout(stopTypingTimerRef.current);
    if (isTypingRef.current) {
      isTypingRef.current = false;
      onTypingChange?.(false);
    }

    closeMentionDropdown();
    // Tag @ mention (13/8) — chốt danh sách mention CÒN trong toàn bộ nội dung TRƯỚC khi tách đoạn (mỗi đoạn tự
    // lọc lại các mention rơi vào đúng đoạn đó, xem trong vòng lặp dưới).
    const draftsAtSend = mentionDraftsRef.current;
    const chunks = splitMessageIntoChunks(v);
    // Audit độc lập 26/7 (finding HIGH, xem BUGS_FIXED.md): KHÔNG setText('') TRƯỚC vòng lặp nữa — nội dung
    // gốc chỉ bị xóa SAU KHI xác nhận MỌI đoạn đã gửi thành công (xem dưới). Nếu 1 đoạn giữa chừng lỗi, các
    // đoạn CHƯA gửi được ghép lại đưa TRỞ VÀO ô nhập (không mất, người dùng tự thấy rõ phần nào chưa đi).
    setSending(true);
    try {
      // TUẦN TỰ — đợi đoạn trước gửi xong (RC xác nhận) mới gửi đoạn sau, tránh đảo thứ tự hiển thị real-time
      // (xem comment onSend ở trên). DỪNG NGAY khi 1 đoạn thất bại — KHÔNG gửi tiếp các đoạn sau.
      for (let i = 0; i < chunks.length; i++) {
        // Chỉ đính mention có `@Tên` NẰM TRONG đúng đoạn này (tin dài bị tách nhiều đoạn — mention theo đoạn chứa nó).
        const chunkMentions = extractActiveMentions(chunks[i], draftsAtSend);
        const ok = await onSend(chunks[i], chunkMentions.length > 0 ? chunkMentions : undefined);
        if (ok === false) {
          // Giữ lại đúng phần CHƯA gửi (đoạn lỗi + mọi đoạn sau nó) trong ô nhập — không mất dữ liệu.
          setText(chunks.slice(i).join(' '));
          return;
        }
      }
      setText('');
      mentionDraftsRef.current = []; // gửi xong sạch ô nhập → quên mọi mention đã chèn.
    } finally {
      setSending(false);
    }
  }

  /** Tải 1 file lên bot-api rồi báo parent (`onSendAttachment`) gửi tin nhắn marker RC thật. `mimeType`/
   * `sizeBytes` lấy TRỰC TIẾP từ `File` phía trình duyệt (KHÔNG chờ server trả lại) — chỉ dùng để hiển thị
   * (icon loại file/dung lượng) trong marker JSON, KHÔNG phải nguồn sự thật bảo mật: `Content-Type` THẬT lúc
   * tải file về vẫn luôn lấy từ mime server đã sniff qua magic-bytes (xem GET /v1/chat/attachments/:id), dù
   * marker ghi gì. `durationSeconds` (31/7) — CHỈ có nghĩa cho kind='voice', xem comment đầu file. `caption`
   * (1/8) — CHỈ có nghĩa cho luồng "Quét bill" mới (kind='image'), xem docstring prop `onSendAttachment`. */
  async function uploadAndSend(
    file: File,
    kind: 'image' | 'file' | 'voice',
    durationSeconds?: number,
    caption?: string,
    billMeta?: BillMessageMeta
  ): Promise<void> {
    setAttachBusy(kind);
    try {
      const uploadRes = await uploadChatAttachment(file);
      if (!uploadRes.ok) {
        onAttachError?.(uploadRes.message);
        return;
      }
      const ok = await onSendAttachment?.(
        uploadRes.data,
        kind,
        file.name,
        file.type || 'application/octet-stream',
        file.size,
        durationSeconds,
        caption,
        billMeta
      );
      // ok===false → parent TỰ set banner lỗi của chính nó (xem sendAttachment() ConversationScreen.tsx, CÙNG
      // khuôn onSend() ở trên) — KHÔNG cần gọi onAttachError() thêm ở đây, tránh 2 banner lỗi chồng nhau.
      void ok;
    } finally {
      setAttachBusy(null);
    }
  }

  /** 31/7 (việc #5) — bấm nút Mic lần dừng ghi âm dưới ngưỡng này (khả năng bấm nhầm/bấm-nhả quá nhanh) → âm
   * thầm hủy, KHÔNG upload/gửi tin — CÙNG tinh thần "hủy picker không phải lỗi thật" (handleAttachImageClick
   * trên), tránh gửi hàng loạt tin nhắn thoại 0 giây vô nghĩa nếu người dùng lỡ chạm 2 lần liên tiếp. */
  const MIN_RECORDING_DURATION_MS = 500;

  async function handleRecordClick(): Promise<void> {
    if (attachBusy) return; // đang upload ảnh/file/voice khác — không cho bắt đầu ghi âm chồng lên.

    if (!recording) {
      try {
        recordHandleRef.current = await startRecording();
      } catch (err) {
        // Lỗi ĐÃ dịch tiếng Việt sẵn ở voice-recording.ts (quyền bị từ chối/không có mic/mic đang bận).
        onAttachError?.(err instanceof Error ? err.message : 'Không thể bắt đầu ghi âm — vui lòng thử lại.');
        return;
      }
      recordStartedAtRef.current = Date.now();
      setRecordElapsedMs(0);
      setRecording(true);
      setMoreMenuOpen(false); // B82 — nút "+" ẩn tạm lúc đang ghi (xem JSX), đóng luôn panel nếu đang mở.
      recordTimerRef.current = setInterval(() => {
        setRecordElapsedMs(Date.now() - recordStartedAtRef.current);
      }, 250);
      return;
    }

    // Lần bấm thứ 2 — dừng ghi âm.
    if (recordTimerRef.current) {
      clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    setRecording(false);
    const handle = recordHandleRef.current;
    recordHandleRef.current = null;
    if (!handle) return; // không nên xảy ra (recording=true luôn đi kèm handle), phòng hờ an toàn kiểu.

    const elapsedMs = Date.now() - recordStartedAtRef.current;
    const blob = await handle.stop(); // GIẢI PHÓNG mic ngay trong stop() (xem voice-recording.ts).
    if (elapsedMs < MIN_RECORDING_DURATION_MS) return; // bấm nhầm quá nhanh — hủy im lặng, xem JSDoc hằng số trên.

    // 1/8 — KHÔNG upload+gửi ngay nữa (hành vi CŨ) — mở panel xác nhận, xem comment đầu file + openVoiceDraft().
    const durationSeconds = Math.round(elapsedMs / 1000);
    openVoiceDraft(blob, durationSeconds);
  }

  /** Mở object URL cục bộ cho bản ghi vừa dừng — CHƯA upload gì lên server (CÙNG khuôn `openBillDraft()`). */
  function openVoiceDraft(blob: Blob, durationSeconds: number): void {
    const draft = { blob, previewUrl: URL.createObjectURL(blob), durationSeconds };
    voiceDraftRef.current = draft;
    setVoiceDraft(draft);
  }

  /** Đóng panel xác nhận + thu hồi object URL cục bộ (bấm "Xóa" HOẶC ngay sau khi bấm "Gửi", xem
   * confirmVoiceSend() — cả 2 trường hợp đều phải dọn URL, CÙNG khuôn closeBillDraft()). */
  function closeVoiceDraft(): void {
    const prev = voiceDraftRef.current;
    if (prev) URL.revokeObjectURL(prev.previewUrl);
    voiceDraftRef.current = null;
    setVoiceDraft(null);
    setVoicePreviewPlaying(false);
  }

  /** Nút "Nghe lại" trong panel xác nhận — play/pause bản ghi cục bộ qua chính thẻ `<audio>` (object URL, KHÔNG
   * qua CSRF/fetch vì đây là Blob cục bộ CHƯA upload, xem comment đầu file). */
  function toggleVoicePreviewPlay(): void {
    const el = voicePreviewAudioRef.current;
    if (!el) return;
    if (voicePreviewPlaying) el.pause();
    else void el.play().catch(() => {}); // hiếm khi bị chặn (đây là user-gesture click) — bỏ qua an toàn, không vỡ UI.
  }

  /** Bấm "Gửi" trong panel xác nhận — đóng panel NGAY (dọn object URL cục bộ) rồi mới upload+gửi NỀN qua
   * `uploadAndSend()` (CÙNG hạ tầng voice cũ — hiện spinner ở icon Mic hàng chính, `attachBusy==='voice'`,
   * composer quay lại hàng nút bình thường ngay khi panel đóng). */
  async function confirmVoiceSend(): Promise<void> {
    const draft = voiceDraft;
    closeVoiceDraft();
    if (!draft) return;
    const file = new File([draft.blob], `voice-${Date.now()}.webm`, { type: draft.blob.type || 'audio/webm' });
    await uploadAndSend(file, 'voice', draft.durationSeconds);
  }

  // Rời màn hình (đổi phòng/unmount) GIỮA LÚC đang ghi âm → dừng recorder + giải phóng mic ngay, KHÔNG để mic
  // treo chạy nền (đèn/icon "đang dùng mic" hệ điều hành phải tắt) — KHÔNG upload bản ghi dở dang.
  useEffect(() => {
    return () => {
      if (recordTimerRef.current) clearInterval(recordTimerRef.current);
      if (recordHandleRef.current) void recordHandleRef.current.stop();
    };
  }, []);

  // 1/8 — rời màn hình (đổi phòng/unmount) GIỮA LÚC panel xác nhận ghi âm còn mở → thu hồi object URL cục bộ
  // ngay, KHÔNG để rò rỉ (CÙNG khuôn cleanup billDraftRef ở dưới — đọc qua ref, KHÔNG phải state, lý do y hệt).
  useEffect(() => {
    return () => {
      if (voiceDraftRef.current) URL.revokeObjectURL(voiceDraftRef.current.previewUrl);
    };
  }, []);

  // 1/8 — rời màn hình (đổi phòng/unmount) GIỮA LÚC panel "Quét bill" preview còn mở → thu hồi object URL cục
  // bộ ngay, KHÔNG để rò rỉ (CÙNG tinh thần cleanup ghi âm trên). Đọc qua `billDraftRef` (KHÔNG phải `billDraft`
  // qua closure — effect deps=[] chỉ chạy 1 lần lúc mount, closure sẽ giữ giá trị CŨ `null` mãi mãi nếu đọc
  // state trực tiếp, xem docstring `billDraftRef` ở khai báo).
  useEffect(() => {
    return () => {
      if (billDraftRef.current) URL.revokeObjectURL(billDraftRef.current.previewUrl);
    };
  }, []);

  /** Mục 23 (31/7) — bấm nút "Chụp màn hình": `captureScreenshot()` (screen-capture.ts) tự lo TOÀN BỘ
   * `getDisplayMedia()`+canvas+PNG Blob (xem comment đầu file đó, gồm GAP THẬT Android WebView đã tự tra
   * cứu). Lỗi (hủy dialog/API không tồn tại/không đọc được nội dung) → banner lỗi CHUNG `onAttachError`,
   * KHÔNG crash — CÙNG khuôn `handleAttachImageClick()`/`handleRecordClick()`. */
  async function handleCaptureScreenClick(): Promise<void> {
    if (attachBusy || recording || capturingScreen) return; // đang bận thao tác đính kèm khác — không chồng lên.
    setCapturingScreen(true);
    let result: { blob: Blob; fileName: string };
    try {
      result = await captureScreenshot();
    } catch (err) {
      setCapturingScreen(false);
      onAttachError?.(err instanceof Error ? err.message : 'Không thể chụp màn hình — vui lòng thử lại.');
      return;
    }
    setCapturingScreen(false);
    const file = new File([result.blob], result.fileName, { type: 'image/png' });
    await uploadAndSend(file, 'image');
  }

  async function handleAttachImageClick(): Promise<void> {
    if (attachBusy) return;
    if (!Capacitor.isNativePlatform()) {
      // Trình duyệt thường (dev/preview web-demo) — KHÔNG có API camera-chụp gốc tương đương, dùng input file
      // ảnh chuẩn thay thế (CÙNG cách MyQrScreen.tsx báo rõ "chưa hỗ trợ trên trình duyệt" cho quét QR, ở đây
      // chọn fallback thay vì chặn hẳn vì "chọn ảnh có sẵn" vẫn làm được tốt trên web, không cần camera thật).
      imageFileInputRef.current?.click();
      return;
    }
    setAttachBusy('image');
    try {
      const photo = await Camera.getPhoto({
        source: CameraSource.Prompt,
        resultType: CameraResultType.Uri,
        quality: 85,
        promptLabelHeader: 'Chọn ảnh',
        promptLabelPhoto: 'Thư viện ảnh',
        promptLabelPicture: 'Chụp ảnh',
        promptLabelCancel: 'Hủy'
      });
      if (!photo.webPath) throw new Error('Không lấy được đường dẫn ảnh từ Camera.');
      const blob = await (await fetch(photo.webPath)).blob();
      const ext = (photo.format || 'jpg').toLowerCase();
      const file = new File([blob], `anh-${Date.now()}.${ext}`, { type: blob.type || `image/${ext}` });
      setAttachBusy(null); // uploadAndSend() tự set lại 'image' — tránh 2 lần setAttachBusy('image') chồng nhau vô hại nhưng thừa.
      // LAG-FIX v2 WIRE — thu nhỏ ảnh phía client TRƯỚC upload (best-effort, không chặn gửi — xem composer-image-send.ts).
      await sendResizedImage(file, (prepared) => uploadAndSend(prepared, 'image'));
    } catch (err) {
      setAttachBusy(null);
      // Người dùng tự hủy picker (Capacitor trả reject với message chứa "cancel") — KHÔNG phải lỗi thật, im lặng.
      const isCancel = err instanceof Error && /cancel/i.test(err.message);
      if (isCancel) return;
      // ROBUST FALLBACK (Admin Demo 13/8 "chưa vào được thư viện ảnh") — Camera.getPhoto có thể LỖI mở thư viện trên
      // Android 13 (plugin coi photos=granted nhưng gallery-intent tùy máy/ROM). Fallback trình-chọn-file hệ thống
      // <input type=file accept=image/*> trong WebView — PERMISSION-LESS, LUÔN mở được (chọn thư viện HOẶC camera).
      // onChange → handlePickedImageFile. Đây là đường chắc ăn thay vì chỉ báo lỗi.
      imageFileInputRef.current?.click();
    }
  }

  function handleAttachFileClick(): void {
    if (attachBusy) return;
    genericFileInputRef.current?.click();
  }

  /** 1/8 — "Quét bill": chụp/chọn 1 ảnh CÙNG cấu hình Camera.getPhoto()/fallback input-file như
   * `handleAttachImageClick()` trên (copy nguyên `promptLabel*`), khác biệt DUY NHẤT là KHÔNG upload ngay —
   * mở `billDraft` để `OcrBillPreview.tsx` tự gọi `/ocr-preview` đọc số tiền + cho người dùng xác nhận/sửa tay
   * TRƯỚC khi thật sự gửi (chỉ upload SAU khi bấm "Gửi" trong panel đó, xem `handleConfirmBillSend()` dưới) —
   * đúng yêu cầu tường minh Admin Demo: "Quét bill" là luồng RIÊNG với "Ảnh" thường (ảnh thường KHÔNG chạy OCR). */
  async function handleScanBillClick(): Promise<void> {
    if (attachBusy || recording || capturingScreen || scanningBill || billDraft) return;
    if (!Capacitor.isNativePlatform()) {
      // CÙNG lý do handleAttachImageClick() — trình duyệt thường không có API camera-chụp gốc tương đương.
      billFileInputRef.current?.click();
      return;
    }
    setScanningBill(true);
    try {
      // 1/8 — ĐÃ THỬ thêm `width: 1600` ở đây để giảm thời gian tải ảnh lên qua mạng di động (song song với
      // resize phía server, ocr-service/main.py). Admin Demo yêu cầu tường minh "phải đảm bảo chính xác việc OCR,
      // cam kết bằng chứng" TRƯỚC khi chấp nhận đánh đổi tốc độ — chưa có cách kiểm chứng thật (cần thiết bị
      // Android thật + so sánh độ chính xác đọc số 2 cách resize, KHÔNG thể verify chỉ bằng code/test) nên ĐÃ
      // HOÀN TÁC, GIỮ NGUYÊN chụp full-res như cũ. CHỈ resize phía server (đã kiểm chứng kỹ bằng bill thật,
      // xem B88) — an toàn hơn, dù chậm hơn ở khâu tải lên. KHÔNG tự ý thêm lại `width` nếu chưa có bằng chứng
      // thật từ thiết bị.
      const photo = await Camera.getPhoto({
        source: CameraSource.Prompt,
        resultType: CameraResultType.Uri,
        quality: 85,
        promptLabelHeader: 'Chọn ảnh',
        promptLabelPhoto: 'Thư viện ảnh',
        promptLabelPicture: 'Chụp ảnh',
        promptLabelCancel: 'Hủy'
      });
      if (!photo.webPath) throw new Error('Không lấy được đường dẫn ảnh từ Camera.');
      const blob = await (await fetch(photo.webPath)).blob();
      const ext = (photo.format || 'jpg').toLowerCase();
      const file = new File([blob], `bill-${Date.now()}.${ext}`, { type: blob.type || `image/${ext}` });
      openBillDraft(file);
    } catch (err) {
      // Người dùng tự hủy picker — KHÔNG phải lỗi thật, CÙNG xử lý handleAttachImageClick() trên.
      const isCancel = err instanceof Error && /cancel/i.test(err.message);
      if (!isCancel) onAttachError?.('Không mở được camera/thư viện ảnh, vui lòng thử lại.');
    } finally {
      setScanningBill(false);
    }
  }

  /** Mở object URL cục bộ cho ảnh vừa chụp/chọn — CHƯA upload gì lên server, `OcrBillPreview.tsx` tự gọi
   * `previewLoOcr()` để ĐỌC. Ảnh CHỈ thật sự upload+gửi khi bấm "Gửi" trong panel đó. */
  function openBillDraft(file: File): void {
    const draft = { file, previewUrl: URL.createObjectURL(file) };
    billDraftRef.current = draft;
    setBillDraft(draft);
  }

  /** Đóng panel preview + thu hồi object URL cục bộ (bấm "Hủy" HOẶC ngay sau khi bấm "Gửi", xem
   * handleConfirmBillSend() — cả 2 trường hợp đều phải dọn URL, KHÔNG chỉ nhánh Hủy). */
  function closeBillDraft(): void {
    const prev = billDraftRef.current;
    if (prev) URL.revokeObjectURL(prev.previewUrl);
    billDraftRef.current = null;
    setBillDraft(null);
  }

  async function handlePickedBillFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    openBillDraft(file);
  }

  /** Bấm "Gửi" trong `OcrBillPreview.tsx` (`onConfirm`) — đóng panel NGAY (đúng docstring `onConfirm` ở đó,
   * panel KHÔNG tự giữ trạng thái "đang gửi") rồi gửi ĐÚNG 1 TIN NHẮN ẢNH qua `uploadAndSend()` (CÙNG hạ tầng
   * ảnh thường, hiện spinner ở icon "Ảnh" hàng chính — `attachBusy==='image'`).
   * CẬP NHẬT 1/8 (Admin Demo tường minh: "bảng thông tin khi quét ra và bill nằm trên 1 tin nhắn không tách") —
   * TRƯỚC ĐÂY hàm này gửi 2 TIN NHẮN ẢNH LIÊN TIẾP (ảnh bill gốc rồi tới ảnh bảng kẻ ô riêng). GIỜ
   * `OcrBillPreview.tsx handleSend()` ĐÃ TỰ GHÉP ảnh bill gốc + bảng kẻ ô vào 1 File DUY NHẤT
   * (`composeBillImage()`, bill-table-image.ts — hoặc NGUYÊN ảnh gốc nếu không có field mở rộng nào đọc
   * được/ghép lỗi, xem docstring `onConfirm` ở đó) TRƯỚC khi gọi callback này — hàm này chỉ còn việc upload
   * NGUYÊN `file` nhận được kèm `amountCaption`. */
  async function handleConfirmBillSend(amountCaption: string, file: File, billMeta: BillMessageMeta | null): Promise<void> {
    closeBillDraft();
    await uploadAndSend(file, 'image', undefined, amountCaption, billMeta ?? undefined);
  }

  async function handlePickedImageFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = ''; // cho phép chọn LẠI đúng file cũ lần sau (input không tự bắn change nếu value không đổi).
    if (!file) return;
    // LAG-FIX v2 WIRE — thu nhỏ ảnh phía client TRƯỚC upload (best-effort, không chặn gửi — xem composer-image-send.ts).
    await sendResizedImage(file, (prepared) => uploadAndSend(prepared, 'image'));
  }

  async function handlePickedGenericFile(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await uploadAndSend(file, 'file');
  }

  const charCount = text.length;
  const overLimit = charCount > MAX_MESSAGE_CHARS;
  // Chỉ hiện bộ đếm khi gần/vượt ngưỡng (>80%) — tránh làm rối UI lúc gõ tin ngắn bình thường (tối giản theo
  // đúng yêu cầu, không thiết kế cầu kỳ).
  const showCounter = charCount > MAX_MESSAGE_CHARS * 0.8;

  // 7/8 (Fold cover): p-1.5 ở màn hẹp (nút icon co gọn để cả hàng composer vừa khít 344 + font rất-lớn), sm+ p-2.
  const iconBtn = 'rounded-full p-1.5 text-slate-400 transition hover:bg-appbg hover:text-brand sm:p-2';

  return (
    <div className="relative border-t border-line bg-white">
      {/* Tag @ mention kiểu Zalo (13/8) — dropdown gợi ý thành viên nhóm nổi phía trên composer (CÙNG khuôn panel
          emoji: absolute bottom-full, border-line/bg-white/shadow-card — đồng bộ design-system). Chỉ hiện khi
          caret ở trong token `@xxx` + có thành viên khớp. Nút ứng viên dùng onMouseDown preventDefault để KHÔNG
          làm textarea blur (giữ focus + caret) trước khi onClick chèn xong. */}
      {mentionQuery && mentionCandidates.length > 0 && (
        <div className="absolute bottom-full left-3 z-20 mb-2 max-h-56 w-72 overflow-auto rounded-lg-mac border border-line bg-white py-1 shadow-card">
          {mentionCandidates.map((m, idx) => (
            <button
              key={m.agentId}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => selectMention(m)}
              onMouseEnter={() => setMentionActiveIndex(idx)}
              className={
                'flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition ' +
                (idx === mentionActiveIndex ? 'bg-brand/10 text-brand' : 'text-slate-700 hover:bg-appbg')
              }
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/15 text-xs font-semibold text-brand">
                {(m.name.trim()[0] ?? '?').toUpperCase()}
              </span>
              <span className="truncate">{m.name}</span>
            </button>
          ))}
        </div>
      )}
      {/* Panel emoji/sticker nổi phía trên composer (mục 38). */}
      {emojiOpen && (
        <div ref={emojiPanelRef} className="absolute bottom-full left-3 z-20 mb-2 w-80 rounded-lg-mac border border-line bg-white p-3 shadow-card">
          <div className="mb-2 inline-flex gap-1 rounded-xl bg-brand/15 p-1">
            {(['emoji', 'sticker'] as const).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={
                  'rounded-lg px-3 py-1.5 text-xs font-semibold transition ' +
                  (tab === t ? 'bg-white text-brand shadow-sm' : 'text-brand/70 hover:bg-white/60')
                }
              >
                {t === 'emoji' ? 'Biểu tượng' : 'Nhãn dán'}
              </button>
            ))}
          </div>
          {tab === 'emoji' ? (
            <div className="grid max-h-48 grid-cols-8 gap-1 overflow-auto">
              {EMOJIS.map((e) => (
                <button
                  key={e}
                  onClick={() => {
                    setText((t) => t + e);
                    // 1/8 (Admin Demo báo thật) — nhánh DUY NHẤT trong panel emoji/sticker trước đây KHÔNG tự
                    // đóng (sticker/vị trí/chụp màn hình/file đều ĐÃ đóng sẵn, xem comment B82) — bổ sung cho
                    // ĐỦ, cùng chuẩn "bấm 1 lựa chọn → tự đóng panel" toàn bộ file này.
                    setEmojiOpen(false);
                  }}
                  className="rounded-md p-1 text-xl transition hover:scale-125 hover:bg-appbg"
                >
                  {e}
                </button>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-2">
              {STICKERS.map((s) => (
                <button
                  key={s.emoji}
                  onClick={() => {
                    onSendSticker?.(s.emoji);
                    setEmojiOpen(false);
                  }}
                  className="flex h-16 items-center justify-center rounded-lg text-4xl transition hover:scale-105"
                  style={{ backgroundColor: s.bg }}
                >
                  {s.emoji}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* B82 (31/7) — panel nổi "+" (Vị trí/Chụp màn hình/File), CÙNG khuôn panel emoji/sticker trên (absolute
          bottom-full). 3 lựa chọn dạng icon lớn + nhãn chữ nhỏ (giống lưới sticker, KHÔNG phải dropdown danh
          sách chữ) — GIỮ NGUYÊN 100% logic onShareLocation/handleCaptureScreenClick/handleAttachFileClick, chỉ
          đổi vị trí nút kích hoạt (trước ở hàng chính, giờ trong panel này). Bấm 1 lựa chọn → tự đóng panel. */}
      {moreMenuOpen && (
        <div ref={moreMenuPanelRef} className="absolute bottom-full left-3 z-20 mb-2 w-64 rounded-lg-mac border border-line bg-white p-3 shadow-card">
          {/* 1/8 — thêm mục "Quét bill" (4 mục) → đổi grid-cols-3 sang grid-cols-2 (2x2) cho gọn, KHÔNG để 1 mục
              lẻ trôi dạt hàng dưới. GIỮ NGUYÊN 100% logic 3 mục cũ (Vị trí/Chụp màn hình/File), chỉ đổi layout
              grid bao quanh. */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => {
                onShareLocation?.();
                setMoreMenuOpen(false);
              }}
              className="flex h-16 flex-col items-center justify-center gap-1 rounded-lg text-slate-600 transition hover:bg-appbg"
            >
              <MapPin className="h-6 w-6 text-brand" />
              <span className="text-[11px]">Vị trí</span>
            </button>
            <button
              type="button"
              onClick={() => {
                void handleCaptureScreenClick();
                setMoreMenuOpen(false);
              }}
              disabled={capturingScreen || attachBusy === 'image' || attachBusy === 'file' || attachBusy === 'voice'}
              className="flex h-16 flex-col items-center justify-center gap-1 rounded-lg text-slate-600 transition hover:bg-appbg disabled:cursor-not-allowed disabled:opacity-50"
            >
              <CameraIcon className="h-6 w-6 text-brand" />
              <span className="text-[11px]">Chụp màn hình</span>
            </button>
            <button
              type="button"
              onClick={() => {
                handleAttachFileClick();
                setMoreMenuOpen(false);
              }}
              disabled={attachBusy === 'file'}
              className="flex h-16 flex-col items-center justify-center gap-1 rounded-lg text-slate-600 transition hover:bg-appbg disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Paperclip className="h-6 w-6 text-brand" />
              <span className="text-[11px]">File</span>
            </button>
            {/* B123 (2/8, Admin Demo yêu cầu trực tiếp — "Quét bill" dùng thường xuyên hơn "Ảnh" thường, đổi chỗ
                cho nhau) — "Ảnh" thường (KHÔNG chạy OCR) CHUYỂN VÀO panel "+" này, NHƯỜNG vị trí hàng chính cho
                "Quét bill" (xem JSX hàng chính bên dưới). GIỮ NGUYÊN 100% logic `handleAttachImageClick()`, chỉ
                đổi vị trí nút kích hoạt — CÙNG pattern B82 đã áp cho Vị trí/Chụp màn hình/File. */}
            <button
              type="button"
              onClick={() => {
                void handleAttachImageClick();
                setMoreMenuOpen(false);
              }}
              disabled={attachBusy === 'image'}
              className="flex h-16 flex-col items-center justify-center gap-1 rounded-lg text-slate-600 transition hover:bg-appbg disabled:cursor-not-allowed disabled:opacity-50"
            >
              {attachBusy === 'image' ? <DotsLoader size="lg" /> : <ImageIcon className="h-6 w-6 text-brand" />}
              <span className="text-[11px]">Ảnh</span>
            </button>
          </div>
        </div>
      )}

      {/* 1/8 — panel xem trước OCR sau khi "Quét bill" (xem OcrBillPreview.tsx + handleScanBillClick() trên).
          Modal tự portal ra document.body nên vị trí đặt trong cây JSX ở đây không ảnh hưởng layout hiển thị. */}
      {billDraft && (
        <Suspense fallback={null}>
          <OcrBillPreview
            file={billDraft.file}
            previewUrl={billDraft.previewUrl}
            onCancel={closeBillDraft}
            onConfirm={(amountCaption, file, billMeta) => void handleConfirmBillSend(amountCaption, file, billMeta)}
          />
        </Suspense>
      )}

      {/* Bộ đếm ký tự (26/7, B29-tiếp) — chỉ hiện khi gần/vượt ngưỡng, xem showCounter ở trên. Vượt ngưỡng
          KHÔNG chặn gửi (submit() tự tách nhiều đoạn) — chỉ đổi màu cảnh báo + ghi rõ "sẽ tách N tin". */}
      {showCounter && (
        <div className={'flex items-center justify-end gap-1.5 px-4 pt-1.5 text-[11px] ' + (overLimit ? 'text-danger' : 'text-slate-400')}>
          {overLimit && <span>Tin nhắn dài sẽ tự tách thành {splitMessageIntoChunks(text).length} đoạn khi gửi —</span>}
          <span>
            {charCount}/{MAX_MESSAGE_CHARS}
          </span>
        </div>
      )}

      {/* 1/8 — panel xác nhận/hủy ghi âm (Admin Demo yêu cầu — xem comment đầu file), THAY THẾ hàng nút chính bên
          dưới trong lúc đang preview (CÙNG mức "an toàn trước khi gửi" như luồng "Quét bill"/OcrBillPreview,
          nhưng gọn hơn — inline ngay trong composer, không cần modal riêng, đúng yêu cầu "làm gọn"). */}
      {voiceDraft ? (
        <div className="flex items-center gap-2 p-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <audio
            ref={voicePreviewAudioRef}
            src={voiceDraft.previewUrl}
            preload="metadata"
            className="hidden"
            onPlay={() => setVoicePreviewPlaying(true)}
            onPause={() => setVoicePreviewPlaying(false)}
            onEnded={() => setVoicePreviewPlaying(false)}
          />
          <button
            type="button"
            onClick={toggleVoicePreviewPlay}
            title={voicePreviewPlaying ? 'Tạm dừng' : 'Nghe lại'}
            className="btn-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-white"
          >
            {voicePreviewPlaying ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" />}
          </button>
          <span className="flex-1 text-sm font-medium tabular-nums text-slate-600">
            Ghi âm {formatSecondsToDurationLabel(voiceDraft.durationSeconds)}
          </span>
          <button
            type="button"
            onClick={closeVoiceDraft}
            title="Xóa bản ghi"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-appbg hover:text-danger"
          >
            <Trash2 className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={() => void confirmVoiceSend()}
            title="Gửi tin nhắn thoại"
            className="btn-primary flex h-10 w-10 shrink-0 items-center justify-center rounded-full p-2.5 text-white"
          >
            <Send className="h-5 w-5" />
          </button>
        </div>
      ) : (
        // B41 (27/7) — cộng thêm safe-area đáy (CÙNG lý do Sidebar.tsx đăng xuất) — ô nhập tin/nút gửi là hàng
        // cuối cùng của màn chat, chạm mép dưới màn hình thật, dễ bị thanh cử chỉ điện thoại che 1 phần.
        // 7/8 (Fold cover 344 + font rất-lớn): gap/padding co ở màn hẹp để 4 nút icon + ô nhập + Gửi vừa khít 1
        // hàng, KHÔNG tràn; sm+ trả lại khoảng cách chuẩn.
        <div className="flex items-end gap-0.5 p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:gap-1.5 sm:p-3 sm:pb-[max(0.75rem,env(safe-area-inset-bottom))]">
          <button
            ref={emojiToggleRef}
            type="button"
            onClick={() => {
              setEmojiOpen((v) => !v);
              setMoreMenuOpen(false); // B82 — loại trừ lẫn nhau với panel "+".
            }}
            title="Biểu tượng cảm xúc / Nhãn dán"
            className={iconBtn + (emojiOpen ? ' text-brand' : '')}
          >
            <Smile className="h-5 w-5" />
          </button>
          {/* 27/7 — input file ẩn (KHÔNG hiện trên UI, chỉ trigger qua .click() từ nút thật phía dưới). */}
          <input ref={imageFileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => void handlePickedImageFile(e)} />
          <input ref={genericFileInputRef} type="file" accept={FILE_ACCEPT} className="hidden" onChange={(e) => void handlePickedGenericFile(e)} />
          {/* 1/8 — fallback web (KHÔNG có Capacitor Camera) cho "Quét bill", CÙNG pattern imageFileInputRef trên. */}
          <input ref={billFileInputRef} type="file" accept="image/*" className="hidden" onChange={(e) => void handlePickedBillFile(e)} />
          {/* B123 (2/8, Admin Demo yêu cầu trực tiếp) — "Quét bill" thay "Ảnh" thường ở hàng chính (dùng thường
              xuyên hơn hẳn "Ảnh" thường trong nghiệp vụ bán TID/đối soát bill — xem comment panel "+" phía trên
              cho lý do đổi chỗ). GIỮ NGUYÊN 100% logic `handleScanBillClick()`, chỉ đổi vị trí nút kích hoạt. */}
          <button
            type="button"
            onClick={() => void handleScanBillClick()}
            disabled={scanningBill || attachBusy === 'image' || attachBusy === 'file' || attachBusy === 'voice' || !!billDraft}
            title="Quét bill"
            className={iconBtn + ' disabled:cursor-not-allowed disabled:opacity-50'}
          >
            {scanningBill ? <DotsLoader /> : <ScanLine className="h-5 w-5" />}
          </button>
          {/* B82 (31/7) — nút "+" gom Vị trí/Chụp màn hình/File vào panel nổi (xem trên), thay vì 3 icon riêng
              trên hàng chính (kiểu Zalo). Ẩn TẠM lúc đang ghi âm để nhường chỗ đồng hồ đếm + nút dừng. */}
          {!recording && (
            <button
              ref={moreMenuToggleRef}
              type="button"
              onClick={() => {
                setMoreMenuOpen((v) => !v);
                setEmojiOpen(false); // loại trừ lẫn nhau với panel emoji/sticker.
              }}
              title="Thêm (Vị trí / Chụp màn hình / File)"
              className={iconBtn + (moreMenuOpen ? ' text-brand' : '')}
            >
              <Plus className="h-5 w-5" />
            </button>
          )}
          {/* 31/7 (việc #5) — ghi âm THẬT, xem comment đầu file: lần bấm 1 = bắt đầu (Mic thường), đang ghi = nút
              đỏ + đồng hồ đếm sống + icon Square (bấm để dừng — 1/8: dừng giờ mở panel xác nhận ở trên, KHÔNG
              upload ngay), đang tải lên (SAU KHI bấm "Gửi" trong panel xác nhận) = spinner (CÙNG khuôn ảnh/file). */}
          <button
            type="button"
            onClick={() => void handleRecordClick()}
            disabled={attachBusy === 'image' || attachBusy === 'file' || attachBusy === 'voice'}
            title={recording ? 'Dừng ghi âm' : 'Ghi âm tin nhắn thoại'}
            className={
              (recording
                ? 'flex items-center gap-1 rounded-full bg-danger px-2.5 py-2 text-white transition hover:brightness-110'
                : iconBtn) + ' disabled:cursor-not-allowed disabled:opacity-50'
            }
          >
            {attachBusy === 'voice' ? (
              <DotsLoader />
            ) : recording ? (
              <>
                <Square className="h-4 w-4 fill-current" />
                <span className="text-xs font-medium tabular-nums">{formatSecondsToDurationLabel(recordElapsedMs / 1000)}</span>
              </>
            ) : (
              <Mic className="h-5 w-5" />
            )}
          </button>
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => handleTextChange(e.target.value, e.target.selectionStart)}
            // Tag @ mention (13/8) — caret di chuyển (bấm chuột / phím mũi tên) mà KHÔNG đổi text vẫn phải dò lại
            // token @ (vd bấm vào giữa 1 @token đang gõ dở). onSelect phủ mọi thay đổi vùng chọn/caret.
            onSelect={(e) => refreshMentionState(text, (e.target as HTMLTextAreaElement).selectionStart)}
            onKeyDown={(e) => {
              // Tag @ mention (13/8) — khi dropdown mở, các phím điều hướng THUỘC VỀ dropdown (chặn hành vi mặc
              // định của textarea, gồm cả Enter-gửi bên dưới).
              if (mentionQuery && mentionCandidates.length > 0) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionActiveIndex((i) => (i + 1) % mentionCandidates.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionActiveIndex((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  selectMention(mentionCandidates[mentionActiveIndex] ?? mentionCandidates[0]);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  closeMentionDropdown();
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            // Đóng dropdown khi rời ô nhập (bấm ra ngoài) — chọn ứng viên dùng onMouseDown preventDefault để KHÔNG
            // kích hoạt blur này trước khi click xử lý xong (xem nút ứng viên bên dưới).
            onBlur={closeMentionDropdown}
            rows={1}
            placeholder="Nhập tin nhắn..."
            // 7/8 (Fold cover 344 + font rất-lớn): min-w-0 để textarea co được dưới min-content (textarea mặc định
            // min-width theo cols → KHÔNG co → đẩy nút Gửi tràn 9px khỏi mép). min-w-0 → nút Gửi luôn vừa khít.
            className="max-h-28 min-w-0 flex-1 resize-none rounded-full border border-line bg-appbg px-4 py-2.5 text-sm outline-none transition focus:border-brand focus:bg-white"
          />
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!text.trim() || sending}
            className="btn-primary flex shrink-0 items-center justify-center rounded-full p-2.5 text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Send className="h-5 w-5" />
          </button>
        </div>
      )}
    </div>
  );
}
