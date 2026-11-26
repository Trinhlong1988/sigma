// SIGMA LANE B Vòng 2 (#5, 3/8, Admin Demo yêu cầu trực tiếp) — CHỐNG HOÀN TIỀN TRÙNG. Khi đại lý xác nhận 1
// lần hoàn tiền, so khóa (mã chuyển tiền/số tham chiếu = KHÓA MẠNH, + STK nhận + số tiền + ngày giờ) với các
// lần hoàn ĐÃ ghi của CHÍNH đại lý đó → nếu TRÙNG mã chuyển tiền → CẢNH BÁO "đã hoàn trước đó, cách đây X".
//
// PHÂN BIỆT RÕ (Admin Demo nhấn mạnh):
//   - Hoàn NHIỀU LẦN HỢP LỆ (cumulative B123): cùng bill, MỖI lần là 1 giao dịch chuyển khoản KHÁC → mã
//     chuyển tiền KHÁC nhau → KHÔNG phải trùng (vẫn cộng dồn bình thường).
//   - Hoàn TRÙNG (gian lận/nhầm): CÙNG mã chuyển tiền (napas/FT) = CÙNG 1 giao dịch chuyển khoản bị ghi 2 lần.
// Mã chuyển tiền là KHÓA MẠNH: 2 bill khác nhau tình cờ trùng số tiền + ngày giờ nhưng KHÁC mã → KHÔNG trùng.
// THIẾU mã chuyển tiền (OCR không đọc được) → KHÔNG khẳng định trùng, chỉ "không đủ dữ liệu đối chiếu, kiểm
// tay" (nếu số tiền+STK+giờ tình cờ trùng 1 bản ghi cũ → nâng mức nhắc "NGHI TRÙNG, kiểm tay").
//
// "cách đây X" tính bằng HIỆU 2 TIMESTAMP TUYỆT ĐỐI (ms) → ĐỘC LẬP múi giờ (không parse chuỗi ngày giờ trên
// biên lai để trừ — chuỗi đó có thể lệch múi giờ/định dạng; createdAt của tin nhắn là mốc chuẩn UTC trong DB).
import type { Db } from '@sigma/database';

export interface RefundDedupRecord {
  messageId: string;
  createdAt: Date;
  transferCode: string | null;
  amount: number | null;
  recipientAccount: string | null;
  dateTime: string | null; // chuỗi ngày giờ đọc từ biên lai (chỉ để đối chiếu phụ khi THIẾU mã, KHÔNG để tính "cách đây X").
}

export interface RefundDedupCandidate {
  transferCode: string | null;
  amount: number | null;
  recipientAccount: string | null;
  dateTime: string | null;
}

export type RefundDedupStatus = 'ok' | 'duplicate' | 'insufficient_data';

export interface RefundDedupResult {
  status: RefundDedupStatus;
  /** messageId của lần hoàn tiền cũ bị nghi/khẳng định trùng (null nếu không có bản ghi nghi ngờ). */
  matchedMessageId: string | null;
  message: string;
}

/** Chuẩn hoá mã chuyển tiền để so khớp: HOA + bỏ mọi ký tự không phải chữ/số (OCR có thể đọc hoa/thường/chèn
 * dấu cách khác nhau giữa 2 lần chụp CÙNG 1 mã). Rỗng sau chuẩn hoá → null (coi như không có mã).
 * EXPORT (4/8, việc 2a) — khử trùng KPI hoàn tiền (refund-report-service.ts buildRefundKpiReport) PHẢI dùng
 * CHÍNH hàm chuẩn hoá này để "cùng 1 mã CK" khớp y hệt cách dedup lúc gửi tin (bền nhiễu OCR hoa/thường/khoảng
 * trắng) — KHÔNG cài lại lần 2 (tránh 2 định nghĩa "cùng mã" lệch nhau âm thầm). */
export function normalizeCode(s: string | null | undefined): string | null {
  if (!s) return null;
  const c = s.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return c.length > 0 ? c : null;
}

/** "cách đây X" — HIỆU ms tuyệt đối (đã kẹp âm về 0 để lệch đồng hồ nhẹ không ra "âm phút"). */
export function formatRefundAgo(diffMs: number): string {
  const ms = Math.max(0, diffMs);
  if (ms < 60_000) return 'dưới 1 phút';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)} phút`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)} giờ`;
  return `${Math.floor(ms / 86_400_000)} ngày`;
}

/** Hàm THUẦN — so 1 lần hoàn tiền `candidate` với `history` (các lần đã ghi của CÙNG đại lý). `now` để tính
 * "cách đây X". KHÔNG chạm DB (dễ test mọi tình huống biên). */
export function checkDuplicateRefund(candidate: RefundDedupCandidate, history: readonly RefundDedupRecord[], now: Date): RefundDedupResult {
  const code = normalizeCode(candidate.transferCode);

  // Có mã chuyển tiền = KHÓA MẠNH → chỉ cần trùng mã là TRÙNG (bền với nhiễu OCR ở các field khác).
  if (code) {
    const match = history.find((h) => normalizeCode(h.transferCode) === code);
    if (match) {
      const ago = formatRefundAgo(now.getTime() - match.createdAt.getTime());
      return {
        status: 'duplicate',
        matchedMessageId: match.messageId,
        message: `⚠ Biên lai này ĐÃ được ghi nhận TRÙNG trước đó (cách đây ${ago}) — CÙNG mã chuyển tiền ${code}. KHÔNG xác nhận hoàn lại nếu chưa chắc đây là giao dịch mới.`
      };
    }
    return { status: 'ok', matchedMessageId: null, message: '' };
  }

  // THIẾU mã chuyển tiền → KHÔNG đủ dữ liệu khẳng định trùng. Nếu số tiền + STK nhận + ngày giờ tình cờ TRÙNG
  // 1 bản ghi cũ → nâng mức nhắc "NGHI TRÙNG" (vẫn để người dùng tự quyết, KHÔNG tự chặn).
  const candAccount = normalizeCode(candidate.recipientAccount);
  const suspect = history.find(
    (h) =>
      candidate.amount != null &&
      h.amount === candidate.amount &&
      candAccount != null &&
      normalizeCode(h.recipientAccount) === candAccount &&
      candidate.dateTime != null &&
      h.dateTime != null &&
      h.dateTime === candidate.dateTime
  );
  if (suspect) {
    return {
      status: 'insufficient_data',
      matchedMessageId: suspect.messageId,
      message:
        'Không đọc được mã chuyển tiền để đối chiếu chắc chắn, NHƯNG có 1 lần hoàn tiền cũ TRÙNG số tiền + tài khoản nhận + ngày giờ — NGHI TRÙNG, hãy KIỂM TRA TAY trước khi xác nhận.'
    };
  }
  return {
    status: 'insufficient_data',
    matchedMessageId: null,
    message: 'Không đọc được mã chuyển tiền/số tham chiếu trên biên lai — không đủ dữ liệu đối chiếu tự động chống trùng, hãy KIỂM TRA TAY.'
  };
}

/** Quét MỌI tin nhắn "Hoàn tiền" (kind IMAGE, isRefundImage:true) của ĐÚNG đại lý `agentId` → dựng lịch sử
 * khóa dedup từ `metadataJson.refundDedup` (+ refundAmount). CÁCH LY theo senderId (CÙNG ranh giới bảo mật #2 —
 * KHÔNG lẫn lịch sử đại lý khác). Tin bill gốc (isBillImage) KHÔNG lẫn vào (chỉ nhận isRefundImage). */
export async function collectAgentRefundDedupHistory(db: Db, agentId: number, opts: { excludeMessageId?: string } = {}): Promise<RefundDedupRecord[]> {
  const rows = await db.chatMessage.findMany({
    where: { senderId: agentId, kind: 'IMAGE', deletedAt: null },
    select: { id: true, metadataJson: true, createdAt: true }
  });
  const out: RefundDedupRecord[] = [];
  for (const r of rows) {
    if (r.id === opts.excludeMessageId) continue; // loại chính nó khi kiểm tra lúc SỬA 1 lần hoàn tiền.
    if (!r.metadataJson) continue;
    let parsed: { isRefundImage?: boolean; refundAmount?: number; refundDedup?: { transferCode?: string | null; recipientAccount?: string | null; dateTime?: string | null; amount?: number | null } };
    try {
      parsed = JSON.parse(r.metadataJson);
    } catch {
      continue;
    }
    if (parsed.isRefundImage !== true) continue;
    const dd = parsed.refundDedup;
    out.push({
      messageId: r.id,
      createdAt: r.createdAt,
      transferCode: dd?.transferCode ?? null,
      amount: typeof parsed.refundAmount === 'number' ? parsed.refundAmount : typeof dd?.amount === 'number' ? dd.amount : null,
      recipientAccount: dd?.recipientAccount ?? null,
      dateTime: dd?.dateTime ?? null
    });
  }
  return out;
}

/** Tiện ích DB: gom lịch sử của đại lý rồi so `candidate`. `excludeMessageId` để lúc SỬA 1 lần hoàn tiền không
 * tự khớp chính nó. */
export async function checkRefundDuplicateForAgent(
  db: Db,
  agentId: number,
  candidate: RefundDedupCandidate,
  now: Date,
  opts: { excludeMessageId?: string } = {}
): Promise<RefundDedupResult> {
  const history = await collectAgentRefundDedupHistory(db, agentId, opts);
  return checkDuplicateRefund(candidate, history, now);
}
