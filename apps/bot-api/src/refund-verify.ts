// #2c (LANE B Vòng 2) — CHẶN client tự khai `refundAmount`. ĐÃ LÀM: chính module này là bản thực thi (server đọc lại
// ảnh THẬT + OCR + đối chiếu). (Trước đây ghi "NỢ/TODO" — nay đã xong, sửa nhãn cho khỏi hiểu lầm còn treo, 3/9.)
//
// Bối cảnh: khi lưu tin "Hoàn tiền" (chat-message-service.ts sendMessage — kind IMAGE, metadataJson.isRefundImage
// :true, có ảnh biên lai đính kèm), server TRƯỚC ĐÂY nhận NGUYÊN `refundAmount` do CLIENT tự khai trong
// metadataJson, KHÔNG đối chiếu lại với số OCR đọc từ ảnh. Lane B đã đóng lỗ "thành viên khác bịa số" bằng lọc
// senderId (refund-service/refund-report-service) — đây là LỚP 2: CHÍNH chủ bill vẫn có thể (vô tình hoặc cố ý)
// khai số hoàn KHÁC số thật trên ảnh (OCR ở /refund/ocr-preview chỉ để XEM TRƯỚC, client sửa tay được → không
// ràng buộc gì con số cuối cùng gửi lên).
//
// Cơ chế: lúc LƯU, server đọc LẠI ảnh THẬT đang gắn (getAttachmentFile → buffer) → callOcrService (CÙNG OCR
// microservice, KHÔNG tin kết quả client kèm — client kiểm soát được nên KHÔNG dùng để xác thực) →
// buildRefundReceiptPreview → so `parsedAmount` với `refundAmount` client khai. Khớp trong ngưỡng
// REFUND_MATCH_TOLERANCE_VND (TÁI DÙNG đúng ngưỡng ±3.000đ Admin Demo chốt, KHÔNG khai ngưỡng thứ 2) → verified.
// LỆCH / OCR không đọc ra số / OCR service chết → verified=false + cờ `refundUnverified:true` trong metadata.
//
// Triết lý (CÙNG mọi field mở rộng khác trong hệ OCR bill): KHÔNG throw / KHÔNG chặn gửi — chỉ GẮN CỜ cảnh báo.
// Hệ quả cờ: refund-report-service.ts (KPI) + refund-service.ts (danh sách cộng dồn) BỎ QUA khoản
// `refundUnverified` → trạng thái bill KHÔNG BAO GIỜ tự thành "Hoàn đủ/matched" nhờ 1 khoản chưa kiểm chứng.
import { readFile } from 'node:fs/promises';
import type { getBotDb } from './db.js';
import { getAttachmentFile } from './chat-attachment-service.js';
import { callOcrService } from './ocr-bridge.js';
import { buildRefundReceiptPreview } from './ocr-bridge.js';
import { REFUND_MATCH_TOLERANCE_VND } from './refund-service.js';

type Db = ReturnType<typeof getBotDb>;

export type RefundVerifyOutcome =
  | 'verified' // OCR đọc ra số khớp client khai (≤ ngưỡng).
  | 'amount_mismatch' // OCR đọc ra số nhưng LỆCH client khai vượt ngưỡng.
  | 'ocr_unreadable' // OCR chạy được nhưng KHÔNG đọc ra dòng số tiền nào.
  | 'ocr_unavailable' // OCR service chết/không gọi được/từ chối ảnh (không xác thực được).
  | 'no_attachment'; // tin hoàn tiền KHÔNG có ảnh đính kèm để đối chiếu.

export interface RefundVerification {
  verified: boolean;
  outcome: RefundVerifyOutcome;
  /** Số OCR server đọc lại từ ảnh THẬT (null nếu không đọc được / không có ảnh). */
  ocrAmount: number | null;
  /** Số client khai (đối chiếu để đại lý tự soi khi lệch). */
  claimedAmount: number;
}

/** So sánh THUẦN số client khai với số OCR đọc được. verified CHỈ khi OCR có số VÀ |lệch| ≤ ngưỡng. Ngưỡng
 * mặc định = REFUND_MATCH_TOLERANCE_VND (±3.000đ, CÙNG ngưỡng "khớp" của computeRefundAggregate — 1 nguồn số). */
export function reconcileRefundAmount(
  claimedAmount: number,
  ocrAmount: number | null,
  tolerance: number = REFUND_MATCH_TOLERANCE_VND
): { verified: boolean; outcome: RefundVerifyOutcome } {
  if (ocrAmount == null || !Number.isFinite(ocrAmount)) {
    return { verified: false, outcome: 'ocr_unreadable' };
  }
  if (Math.abs(claimedAmount - ocrAmount) <= tolerance) {
    return { verified: true, outcome: 'verified' };
  }
  return { verified: false, outcome: 'amount_mismatch' };
}

/** Đọc LẠI ảnh biên lai THẬT đang gắn vào tin hoàn tiền → OCR → đối chiếu số client khai. KHÔNG throw cho mọi
 * nhánh lỗi nghiệp vụ (ảnh mất/OCR chết/không đọc được) — trả RefundVerification với verified=false để caller
 * gắn cờ cảnh báo, ĐÚNG triết lý "cảnh báo không chặn". Chỉ ném nếu lỗi hệ thống thật không lường trước (để bug
 * lộ ra, không nuốt câm — R198). */
export async function verifyRefundAttachment(
  db: Db,
  attachmentId: string,
  claimedAmount: number
): Promise<RefundVerification> {
  const file = await getAttachmentFile(db, attachmentId);
  if (!file) {
    // Ảnh biến mất khỏi đĩa / attachment không tồn tại → không đối chiếu được.
    return { verified: false, outcome: 'ocr_unavailable', ocrAmount: null, claimedAmount };
  }
  const buffer = await readFile(file.filePath);
  const ocr = await callOcrService(buffer, file.fileName);
  if (!ocr.ok) {
    return { verified: false, outcome: 'ocr_unavailable', ocrAmount: null, claimedAmount };
  }
  const preview = buildRefundReceiptPreview(ocr.lines);
  const ocrAmount = preview.parsedAmount;
  const { verified, outcome } = reconcileRefundAmount(claimedAmount, ocrAmount);
  return { verified, outcome, ocrAmount, claimedAmount };
}

interface RefundLikeMetadata {
  isRefundImage?: boolean;
  refundAmount?: unknown;
  refundUnverified?: unknown;
  refundVerification?: unknown;
  [k: string]: unknown;
}

/** Nếu `metadataJson` là tin hoàn tiền (isRefundImage:true), server TỰ đối chiếu số khai với OCR ảnh đính kèm
 * và GẮN CỜ vào metadata (ghi đè MỌI giá trị `refundUnverified`/`refundVerification` client tự nhét — KHÔNG tin
 * client). Trả về chuỗi metadataJson MỚI (đã gắn cờ) hoặc NGUYÊN chuỗi cũ nếu không phải tin hoàn tiền/parse
 * lỗi. KHÔNG throw. Dùng ở sendMessage() TRƯỚC khi ghi DB. */
export async function annotateRefundMetadataOnSave(
  db: Db,
  attachmentId: string | undefined,
  metadataJson: string | null | undefined
): Promise<string | null | undefined> {
  if (!metadataJson) return metadataJson;
  let meta: RefundLikeMetadata;
  try {
    meta = JSON.parse(metadataJson) as RefundLikeMetadata;
  } catch {
    return metadataJson; // metadata hỏng — không phải việc của hàm này, giữ nguyên (service khác đã giới hạn độ dài).
  }
  if (meta.isRefundImage !== true) return metadataJson;

  // Là tin hoàn tiền → TUYỆT ĐỐI không giữ cờ client tự khai (chống client tự "xác nhận đã kiểm chứng").
  delete meta.refundUnverified;
  delete meta.refundVerification;

  const claimed = typeof meta.refundAmount === 'number' && Number.isFinite(meta.refundAmount) ? meta.refundAmount : null;

  let verification: RefundVerification;
  if (!attachmentId) {
    // Tin hoàn tiền KHÔNG kèm ảnh (luồng thật LUÔN có ảnh biên lai) → không đối chiếu được → coi CHƯA kiểm chứng.
    verification = { verified: false, outcome: 'no_attachment', ocrAmount: null, claimedAmount: claimed ?? 0 };
  } else if (claimed == null || claimed <= 0) {
    // Có ảnh nhưng client KHÔNG khai số hợp lệ → vẫn OCR để ghi lại ocrAmount, nhưng verified=false.
    const v = await verifyRefundAttachment(db, attachmentId, 0);
    verification = { verified: false, outcome: v.outcome === 'verified' ? 'amount_mismatch' : v.outcome, ocrAmount: v.ocrAmount, claimedAmount: 0 };
  } else {
    verification = await verifyRefundAttachment(db, attachmentId, claimed);
  }

  meta.refundVerification = verification;
  if (!verification.verified) meta.refundUnverified = true;
  return JSON.stringify(meta);
}
