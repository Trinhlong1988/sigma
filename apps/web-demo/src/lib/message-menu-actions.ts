// Menu thao tác tin nhắn THEO LOẠI (chuột-phải / long-press) + thanh lối tắt khi HOVER — kiểu Zalo, GIỮ
// NGUYÊN brand SigMa (icon lucide + Button/menu-style sẵn có). Tách phần LOGIC CHỌN ACTION ra hàm THUẦN để
// test được ở env node (repo CHƯA có jsdom — cùng lớp "pure-logic test" với context-menu-position.ts,
// reply-preview.ts...), KHÔNG dựng cây React. Màn ConversationScreen.tsx dùng hàm này làm 1 NGUỒN DUY NHẤT
// quyết định action nào hiện cho từng loại tin (đồng thời để đếm bề rộng menu chính xác — bài học B101 "menu
// ngữ cảnh tràn khung": mọi nút PHẢI vào phép tính bề rộng).
//
// LƯU Ý phạm vi: hàm này CHỈ quyết định các action THEO LOẠI TIN (reply/forward/copy/mở-sao-chép-liên-kết/
// tải-xuống/thu-hồi). Các nút phụ thuộc QUYỀN NGHIỆP VỤ (Sửa bill/Hoàn tiền/Ghim — gate async canEditBill*/
// canOpenRefund/canManagePins) do màn hình tự chèn riêng, KHÔNG gộp vào đây (giữ hàm thuần, không phụ thuộc
// trạng thái phòng/vai trò).
import type { ChatMessageType } from '../mock-data/types';

export type MessageMenuAction =
  | 'reply' // Trả lời (mọi loại trừ system)
  | 'forward' // Chuyển tiếp (mọi loại trừ system)
  | 'copy' // Sao chép nội dung — CHỈ tin text (ảnh/file/voice KHÔNG có text để copy)
  | 'openLink' // Mở liên kết — CHỈ tin text CÓ link
  | 'copyLink' // Sao chép liên kết — CHỈ tin text CÓ link
  | 'download' // Tải xuống — CHỈ ảnh/file có đính kèm THẬT (LƯU về máy/thư viện, KHÔNG share)
  | 'share' // Chia sẻ sang ứng dụng khác — CHỈ ảnh/file có đính kèm THẬT (RIÊNG khỏi Tải xuống, B-DL/SHARE 11/8)
  | 'delete'; // Thu hồi — CHỈ tin của MÌNH

export interface MessageMenuActionsInput {
  type: ChatMessageType;
  /** Tin của chính mình → cho Thu hồi. */
  isMine: boolean;
  /** text tin chứa ít nhất 1 URL http(s) — CHỈ xét cho tin type 'text' (caller đã kiểm bằng extractFirstUrl). */
  hasLink: boolean;
  /** Đính kèm tải được THẬT: ảnh có URL thật HOẶC file có url. CHỈ xét cho image/file (ảnh mock placeholder
   *  không có URL thật → false → KHÔNG hiện "Tải xuống", tránh nút chết). */
  canDownload: boolean;
}

// URL http(s) trong 1 đoạn text. Cố ý ĐƠN GIẢN + an toàn: dừng ở khoảng trắng / vài ký tự bao đóng — KHÔNG
// cố bắt mọi biến thể URL (đủ cho "Mở/Sao chép liên kết" kiểu Zalo). `i` để bắt HTTP/HTTPS hoa thường.
const URL_REGEX = /https?:\/\/[^\s<>"'`]+/i;

/** URL http(s) ĐẦU TIÊN trong text (đã bỏ dấu câu/ngoặc dính đuôi, vd "Xem https://a.com." → "https://a.com"),
 *  hoặc null nếu không có. Hàm THUẦN. */
export function extractFirstUrl(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = text.match(URL_REGEX);
  if (!m) return null;
  return m[0].replace(/[.,;:!?)\]}]+$/, '');
}

/** true nếu tin type 'text' chứa link (các loại khác luôn false — ảnh/file/qr... không xét link trong caption). */
export function messageHasLink(type: ChatMessageType, text: string | undefined | null): boolean {
  return type === 'text' && extractFirstUrl(text) !== null;
}

/** Danh sách action HIỂN THỊ theo LOẠI tin, theo THỨ TỰ render trong menu ngang (kiểu Zalo). Hàm THUẦN. */
export function menuActionsForMessage(input: MessageMenuActionsInput): MessageMenuAction[] {
  const { type, isMine, hasLink, canDownload } = input;
  if (type === 'system') return []; // tin hệ thống: không có menu thao tác.
  const actions: MessageMenuAction[] = ['reply', 'forward'];
  // Đính kèm THẬT (ảnh/file) → Tải xuống + Chia sẻ (2 hành động TÁCH BẠCH, B-DL/SHARE 11/8): Tải = lưu về
  // máy/thư viện; Chia sẻ = gửi sang ứng dụng khác. 'share' NGAY SAU 'download' để thứ tự render menu ổn định.
  if ((type === 'image' || type === 'file') && canDownload) actions.push('download', 'share');
  if (type === 'text') {
    actions.push('copy');
    if (hasLink) actions.push('openLink', 'copyLink');
  }
  if (isMine) actions.push('delete');
  return actions;
}
