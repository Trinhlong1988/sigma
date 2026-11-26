// SIGMA (2/8, tính năng "Hoàn tiền" MỚI, Admin Demo yêu cầu trực tiếp) — logic KHÔNG-thuộc-OCR cho luồng xác
// nhận hoàn tiền: (1) đối chiếu tên/số tài khoản NGƯỜI NHẬN đọc từ biên lai chuyển khoản hoàn tiền với dữ liệu
// "TK nhận tiền" ĐÃ CẤU HÌNH cho TID (bill gốc), (2) tính trạng thái so khớp CỘNG DỒN nhiều lần hoàn tiền cho
// CÙNG 1 bill gốc (Admin Demo xác nhận 2/8: "CHO PHÉP hoàn tiền NHIỀU LẦN cho 1 bill" — cơ chế cumulative), (3)
// liệt kê các lần hoàn tiền ĐÃ XÁC NHẬN cho 1 tin nhắn bill gốc (dùng để tính lại tổng lúc mở panel mới/sửa).
//
// ĐIỀU TRA NGUỒN DỮ LIỆU "tài khoản đã cấu hình" (BẮT BUỘC trước khi code, theo đúng yêu cầu "CẤM SUY LUẬN"):
// đã tự query DB production `sigma` (2/8) — bảng `receive_accounts` (model `ReceiveAccount`, schema.prisma
// "Tài khoản nhận tiền – ủy quyền §8b") HIỆN CÓ 0 DÒNG, bảng `tids` CŨNG 0 DÒNG (chưa ai cấu hình TID/khách
// hàng/tài khoản nhận tiền thật qua app quản lý SigMa `apps/desktop` tính tới lúc build tính năng này). Đường
// liên kết SCHEMA có thật: `Tid.receiveAccountId` (int, "TK nhận tiền §8") → `ReceiveAccount.id` — Admin Demo xác
// nhận trực tiếp (2/8, làm rõ chiều giao dịch): "Người nhận" trên bill hoàn tiền LUÔN LÀ khách hàng, phải khớp
// với "khách hàng đã cấu hình cho TID đó" — ĐÚNG khớp với đường liên kết `Tid.receiveAccountId` này (KHÔNG có
// đường liên kết nào khác hợp lý hơn trong schema). Kết luận: dùng đường liên kết này để so khớp, NHƯNG vì dữ
// liệu THẬT hiện đang RỖNG, mọi TID thật hôm nay sẽ trả `not_configured` — ĐÂY LÀ TRẠNG THÁI THẬT của hệ thống
// (không phải bug), UI hiển thị RÕ "chưa cấu hình — không đối chiếu được" chứ KHÔNG ngầm coi là "khớp". Ghi rõ
// trong báo cáo cuối cho Admin Demo: tính năng so khớp CHỈ có ý nghĩa THẬT sau khi có người dùng `apps/desktop`
// cấu hình receive_accounts + gán `Tid.receiveAccountId` cho từng TID.
import type { Db } from '@sigma/database';
import { ChatServiceError, assertActiveMember } from './services/chat-room-service.js';
import { normalizeCode } from './refund-dedup.js';

// ── Đối chiếu Người nhận (tên + số tài khoản) ─────────────────────────────────────────────────────────────

export type RecipientMatchStatus = 'matched' | 'mismatched' | 'not_configured' | 'no_tid' | 'unread';

export interface RecipientMatchResult {
  status: RecipientMatchStatus;
  /** Dữ liệu ĐÃ CẤU HÌNH cho TID (nếu có) — hiển thị để đại lý tự đối chiếu bằng mắt khi status !== 'matched'. */
  configuredAccountName: string | null;
  configuredAccountNumber: string | null;
  message: string;
}

const COMBINING_MARKS_RE = /[̀-ͯ]/g;

function normalizeNameForCompare(s: string): string {
  return s
    .replace(/đ/gi, 'd')
    .normalize('NFD')
    .replace(COMBINING_MARKS_RE, '')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeAccountNumberForCompare(s: string): string {
  return s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** Đối chiếu tên+số tài khoản NGƯỜI NHẬN (đọc từ OCR biên lai hoàn tiền) với `ReceiveAccount` đã cấu hình cho
 * TID của bill gốc (`Tid.receiveAccountId`, xem điều tra nguồn dữ liệu đầu file). KHÔNG BAO GIỜ throw cho
 * nhánh "thiếu dữ liệu" (TID không khớp/chưa cấu hình/OCR chưa đọc được) — đây là CẢNH BÁO hiển thị, không
 * chặn luồng gửi (đúng tinh thần mọi field mở rộng khác trong hệ OCR bill). CHỈ trả `'matched'` khi ĐỦ dữ liệu
 * 2 phía (đã cấu hình + OCR đọc được) VÀ khớp — tuyệt đối không ngầm định "khớp" khi thiếu dữ liệu 1 trong 2
 * phía (rủi ro tài chính thật, xem chỉ đạo brief "ưu tiên báo cảnh báo hơn tự tin kết luận khớp"). */
export async function matchRefundRecipient(
  db: Db,
  agentId: number,
  originalTid: string | null | undefined,
  recipientName: string | null,
  recipientAccountNumber: string | null,
  // #4 (3/8, LANE B Vòng 2) — ô "tài khoản" trên biên lai là MÃ VietQR/napas (KHÔNG phải dãy số TK thuần) →
  // so SỐ sẽ LỆCH giả. Khi cờ này bật, BỎ so số, CHỈ đối chiếu TÊN người nhận (khớp tên → matched dù không có
  // số để so). Ngầm định false = so đủ cả tên+số như cũ.
  recipientAccountIsVietQR = false
): Promise<RecipientMatchResult> {
  const tidTrimmed = originalTid?.trim();
  if (!tidTrimmed) {
    return {
      status: 'no_tid',
      configuredAccountName: null,
      configuredAccountNumber: null,
      message: 'Bill gốc không có TID đọc được — không đối chiếu tài khoản nhận tự động được.'
    };
  }

  const tid = await db.tid.findFirst({ where: { tid: tidTrimmed, agentId, deletedAt: null } });
  if (!tid || tid.receiveAccountId == null) {
    return {
      status: 'not_configured',
      configuredAccountName: null,
      configuredAccountNumber: null,
      message: 'TID này CHƯA cấu hình tài khoản nhận tiền trong hệ thống — không đối chiếu tự động được, tự kiểm tra thủ công.'
    };
  }

  const account = await db.receiveAccount.findUnique({ where: { id: tid.receiveAccountId } });
  if (!account || account.deletedAt) {
    return {
      status: 'not_configured',
      configuredAccountName: null,
      configuredAccountNumber: null,
      message: 'Tài khoản nhận tiền đã cấu hình cho TID này không còn tồn tại — không đối chiếu tự động được, tự kiểm tra thủ công.'
    };
  }

  // #4 (3/8) — ô "tài khoản" là MÃ VietQR/napas (recipientAccountIsVietQR): số của mã KHÁC HẲN dãy số STK cấu
  // hình → so số sẽ LỆCH giả (tick "khớp" sai HOẶC báo lệch giả). BỎ so số, CHỈ đối chiếu TÊN người nhận.
  if (recipientAccountIsVietQR) {
    if (!recipientName) {
      return {
        status: 'unread',
        configuredAccountName: account.accountName,
        configuredAccountNumber: account.accountNumber,
        message: 'Ô "tài khoản" trên biên lai là mã VietQR (không so được số) và KHÔNG đọc được tên người nhận — tự đối chiếu bằng mắt.'
      };
    }
    const nameMatchesQr = normalizeNameForCompare(recipientName) === normalizeNameForCompare(account.accountName);
    if (nameMatchesQr) {
      return {
        status: 'matched',
        configuredAccountName: account.accountName,
        configuredAccountNumber: account.accountNumber,
        message: 'Ô "tài khoản" là mã VietQR — đối chiếu theo TÊN người nhận: tên KHỚP dữ liệu đã cấu hình.'
      };
    }
    return {
      status: 'mismatched',
      configuredAccountName: account.accountName,
      configuredAccountNumber: account.accountNumber,
      message: 'CẢNH BÁO: ô "tài khoản" là mã VietQR, tên người nhận KHÔNG khớp dữ liệu đã cấu hình cho TID này — kiểm tra kỹ trước khi xác nhận.'
    };
  }

  if (!recipientName && !recipientAccountNumber) {
    return {
      status: 'unread',
      configuredAccountName: account.accountName,
      configuredAccountNumber: account.accountNumber,
      message: 'Không đọc được tên/số tài khoản người nhận từ ảnh — tự đối chiếu bằng mắt với dữ liệu đã cấu hình.'
    };
  }

  const nameMatches = recipientName == null ? null : normalizeNameForCompare(recipientName) === normalizeNameForCompare(account.accountName);
  const accountMatches =
    recipientAccountNumber == null ? null : normalizeAccountNumberForCompare(recipientAccountNumber) === normalizeAccountNumberForCompare(account.accountNumber);

  // 1 trong 2 field OCR không đọc được → KHÔNG đủ dữ liệu kết luận, kể cả field còn lại có khớp — tránh báo
  // "khớp" chỉ dựa trên 1 nửa dữ liệu (rủi ro tài chính thật).
  if (nameMatches === null || accountMatches === null) {
    return {
      status: 'unread',
      configuredAccountName: account.accountName,
      configuredAccountNumber: account.accountNumber,
      message: 'Chỉ đọc được MỘT trong hai (tên/số tài khoản người nhận) từ ảnh — tự đối chiếu bằng mắt phần còn lại.'
    };
  }

  if (nameMatches && accountMatches) {
    return { status: 'matched', configuredAccountName: account.accountName, configuredAccountNumber: account.accountNumber, message: 'Tên và số tài khoản người nhận khớp dữ liệu đã cấu hình.' };
  }

  const parts: string[] = [];
  if (!nameMatches) parts.push('tên người nhận KHÔNG khớp');
  if (!accountMatches) parts.push('số tài khoản nhận KHÔNG khớp');
  return {
    status: 'mismatched',
    configuredAccountName: account.accountName,
    configuredAccountNumber: account.accountNumber,
    message: `CẢNH BÁO: ${parts.join(' và ')} dữ liệu đã cấu hình cho TID này — kiểm tra kỹ trước khi xác nhận.`
  };
}

// ── Trạng thái so khớp CỘNG DỒN (Admin Demo 2/8: cho phép hoàn tiền nhiều lần cho 1 bill) ───────────────────────

export type RefundAggregateStatus = 'none' | 'partial' | 'matched' | 'over';

/** Sai số cho phép (VND) coi là "khớp" — Admin Demo chốt "≤3.000đ". Chỉ số CHÊNH DƯƠNG (đã hoàn NHIỀU HƠN mức
 * phải hoàn) vượt ngưỡng mới gọi "Hoàn thừa" (Admin Demo làm rõ 2/8: "CHỈ báo đỏ khi HOÀN THỪA"). Chênh ÂM vượt
 * ngưỡng (đã hoàn ÍT HƠN) gọi "Hoàn thiếu"/`'partial'`, màu cảnh báo KHÁC đỏ (không dùng chữ "thừa" sai nghĩa). */
export const REFUND_MATCH_TOLERANCE_VND = 3000;

export interface RefundAggregateResult {
  status: RefundAggregateStatus;
  /** totalConfirmed − requiredAmount. Dương = hoàn thừa, âm = hoàn thiếu/chưa hoàn hết. */
  diff: number;
  totalConfirmed: number;
  requiredAmount: number;
}

/** Tính trạng thái CỘNG DỒN mọi lần hoàn tiền ĐÃ XÁC NHẬN cho 1 bill gốc — so TỔNG với "số tiền phải hoàn"
 * (đã tính theo công thức phí có sẵn), KHÔNG so từng lần riêng lẻ (Admin Demo 2/8: "nếu so riêng lẻ, hoàn lần 1/2
 * sẽ luôn báo thiếu sai bản chất"). Hàm THUẦN — dùng CHUNG cho preview lúc đang nhập (tổng = các lần đã lưu +
 * lần đang xem trước, CHƯA lưu) LẪN báo cáo Doanh số (tổng = các lần đã lưu, sau khi 1 lần vừa được sửa/thêm). */
export function computeRefundAggregate(requiredAmount: number, totalConfirmed: number): RefundAggregateResult {
  const diff = totalConfirmed - requiredAmount;
  if (totalConfirmed <= 0) return { status: 'none', diff: -requiredAmount, totalConfirmed, requiredAmount };
  if (diff > REFUND_MATCH_TOLERANCE_VND) return { status: 'over', diff, totalConfirmed, requiredAmount };
  if (diff < -REFUND_MATCH_TOLERANCE_VND) return { status: 'partial', diff, totalConfirmed, requiredAmount };
  return { status: 'matched', diff, totalConfirmed, requiredAmount };
}

// ── Danh sách lần hoàn tiền đã xác nhận cho 1 bill gốc ────────────────────────────────────────────────────

export interface RefundConfirmationSummary {
  messageId: string;
  amount: number;
  createdAt: Date;
  editedAt: Date | null;
}

interface RawRefundMetadata {
  isRefundImage?: boolean;
  refundAmount?: number;
  // NỢ #2c (3/8) — cờ server gắn khi số hoàn client khai KHÔNG khớp OCR ảnh. Khoản chưa kiểm chứng KHÔNG cộng
  // dồn vào tổng "đã hoàn" (không tự đẩy trạng thái sang "Hoàn đủ"). Xem refund-verify.ts.
  refundUnverified?: boolean;
  // [Agent-4 11/9 — PARITY với KPI] mã CK rút từ OCR (routes/me.ts ghi khi gửi) — dùng KHỬ TRÙNG cùng-mã-CK
  // cho 1 bill Y HỆT buildRefundKpiReport (2a 4/8). CÙNG shape refund-dedup, chỉ khai phần cần đọc.
  refundDedup?: { transferCode?: string | null } | null;
}

/** Liệt kê MỌI tin nhắn "Hoàn tiền" (kind IMAGE, metadataJson.isRefundImage===true) đang TRẢ LỜI
 * (`replyToMessageId`) 1 tin nhắn bill gốc cụ thể — dùng để tính lại tổng cộng dồn lúc mở panel "Hoàn tiền"
 * MỚI (cộng thêm lần đang nhập) hoặc lúc "Sửa" 1 lần hoàn tiền cụ thể (loại trừ chính nó, cộng lại giá trị
 * MỚI). `requesterAgentId` PHẢI là thành viên ĐANG hoạt động của phòng chứa tin nhắn gốc (assertActiveMember —
 * CÙNG ranh giới bảo mật `listMessages()`/`listChatMessageReactions()` đã áp cho toàn bộ dữ liệu theo-phòng). */
export async function listRefundConfirmationsForMessage(db: Db, requesterAgentId: number, originalMessageId: string): Promise<RefundConfirmationSummary[]> {
  const original = await db.chatMessage.findUnique({ where: { id: originalMessageId }, select: { id: true, roomId: true, senderId: true } });
  if (!original) {
    throw new ChatServiceError('MESSAGE_NOT_FOUND', `Tin nhắn id=${originalMessageId} không tồn tại.`);
  }
  await assertActiveMember(db, original.roomId, requesterAgentId);

  // #2 (3/8, LANE B Vòng 2 — bảo mật) — CHỈ đếm confirmation do NGƯỜI GỬI BILL GỐC (người bán thực hiện hoàn
  // tiền) post. Thành viên KHÁC (khách/kẻ gian) tự post ảnh "hoàn tiền" bịa số KHÔNG được tính (chống tự "xác
  // nhận đã hoàn đủ"). Lọc `senderId` ngay ở query — rẻ hơn + không lấy thừa.
  const replies = await db.chatMessage.findMany({
    where: { replyToMessageId: originalMessageId, senderId: original.senderId, deletedAt: null, kind: 'IMAGE' },
    select: { id: true, metadataJson: true, createdAt: true, editedAt: true },
    orderBy: { createdAt: 'asc' }
  });

  const results: RefundConfirmationSummary[] = [];
  // [Agent-4 11/9 — PARITY KPI ↔ PANEL] KHỬ TRÙNG theo transferCode (chuẩn hoá) Y HỆT buildRefundKpiReport (2a 4/8):
  // đại lý bỏ qua cảnh báo dedup gửi 2 lần CÙNG mã CK cho 1 bill → KPI tính 1 lần nhưng panel/aggregate trước đây
  // cộng ĐÔI → cùng bill 2 màn 2 số (bill nhảy "Hoàn đủ/thừa" giả ở panel). Mỗi mã CK chỉ tính 1 lần / 1 bill;
  // khoản KHÔNG có mã (OCR không đọc được) giữ hành vi cũ — cộng đủ, không đủ dữ liệu khẳng định trùng.
  const seenCodes = new Set<string>();
  for (const r of replies) {
    if (!r.metadataJson) continue;
    let parsed: RawRefundMetadata;
    try {
      parsed = JSON.parse(r.metadataJson) as RawRefundMetadata;
    } catch {
      continue; // metadataJson hỏng — bỏ qua, KHÔNG throw (đây là tổng hợp hiển thị, không phải check bảo mật bắt buộc).
    }
    if (parsed.isRefundImage !== true || typeof parsed.refundAmount !== 'number' || !(parsed.refundAmount > 0)) continue;
    // NỢ #2c (3/8) — BỎ QUA khoản server chưa kiểm chứng (client khai lệch số OCR ảnh) → không cộng dồn thành "Hoàn đủ".
    if (parsed.refundUnverified === true) continue;
    const code = normalizeCode(parsed.refundDedup?.transferCode);
    if (code) {
      if (seenCodes.has(code)) continue; // CÙNG mã CK đã tính cho bill này → bỏ (1 giao dịch thật chụp/gửi 2 lần)
      seenCodes.add(code);
    }
    results.push({ messageId: r.id, amount: parsed.refundAmount, createdAt: r.createdAt, editedAt: r.editedAt ?? null });
  }
  return results;
}
