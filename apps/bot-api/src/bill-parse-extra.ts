// SIGMA — PARSE CHI TIẾT 2 loại bill "phi doanh-số" cho tính năng tự lấy bill từ Zalo.
//
// Bổ trợ cho bill-classify.ts (KHÔNG sửa file đó). Sau khi classifyBillType() quyết định loại,
// module này rút các trường CỤ THỂ:
//   - SETTLEMENT (bill kết toán tổng lô POS): TID máy, số lô, tổng số giao dịch, tổng tiền,
//     và bảng tiền theo từng loại thẻ (MASTERCARD/VISA/JCB...).
//   - REFUND_TRANSFER (ảnh app ngân hàng chuyển-hoàn-tiền): số tiền, tên người nhận, mã giao dịch.
//
// Ràng buộc thiết kế (giống bill-classify.ts):
//   - Hàm THUẦN: không DB, không mạng, input = mảng dòng OCR đã có sẵn (PaddleOCR PP-OCRv6).
//   - KHÔNG import chéo bill-classify/ocr-bridge → copy type OcrLine + chuẩn hoá text tại chỗ.
//   - OCR tiếng Việt hay MẤT DẤU + lẫn ký tự nên chuẩn hoá = NFD bỏ dấu + đ→d + uppercase + gộp space,
//     rồi so khớp CHỨA (includes/regex) linh hoạt, KHÔNG so khớp cả dòng.
//   - CẤM suy luận value: mọi rule bám đúng OCR THẬT của fixture, không bịa số.

/** Copy tối thiểu của OcrLine (KHÔNG import ocr-bridge/bill-classify để tránh vòng). */
export interface OcrLine {
  text: string;
  score: number;
}

/**
 * Chuẩn hoá 1 đoạn text OCR để so khớp không dấu (copy nguyên bản logic bill-classify.normalizeOcrText):
 *   - tách dấu tổ hợp (NFD) rồi bỏ các dấu thanh/mũ (U+0300..U+036F)
 *   - đ/Đ → D (không nằm trong dải kết hợp NFD nên xử riêng)
 *   - uppercase + gộp mọi khoảng trắng liên tiếp thành 1 space
 */
export function normalizeOcrText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // bỏ dấu thanh + dấu mũ tiếng Việt (combining marks)
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Rút giá trị TIỀN (VND) từ 1 dòng OCR đã chuẩn hoá.
 *   - OCR đọc VND hay ra "UND"; phân cách nghìn có thể là CHẤM ("64.207.000") HOẶC PHẨY ("123,464,000").
 *   - Ưu tiên cụm số có phân-cách-nghìn (grouped), fallback số ≥4 chữ số kèm đuôi VND/UND.
 *   - Trả về số nguyên đồng, hoặc null nếu dòng không phải tiền (vd count "11", số TK "1907 3333...").
 */
function moneyValue(norm: string): number | null {
  // Cụm số có phân cách nghìn: 1-3 chữ số rồi ≥1 nhóm [.,]xxx  → "112,999,000" / "64.207.000".
  const grouped = norm.match(/\d{1,3}(?:[.,]\d{3})+/);
  if (grouped) {
    const digits = grouped[0].replace(/\D/g, '');
    return digits ? Number.parseInt(digits, 10) : null;
  }
  // Số ≥4 chữ số dính ngay đuôi tiền tệ (không phân cách): "500000VND".
  const cur = norm.match(/(\d{4,})\s*(?:VND|UND)\b/);
  if (cur) return Number.parseInt(cur[1], 10);
  return null;
}

// =============================== HÀM 1: parseSettlementBill ===============================

export interface SettlementParsed {
  tid: string | null; // TID máy POS
  batchNumber: string | null; // Số Lô (BATCH No)
  totalCount: number | null; // TỔNG: N (số giao dịch trong lô)
  totalAmount: number | null; // dòng tổng (VND) — số nguyên đồng
  perCard: { scheme: string; count: number | null; amount: number }[]; // theo THẺ
}

/**
 * Rút chi tiết bill KẾT TOÁN (settlement) POS.
 *
 * Layout OCR THẬT (PaddleOCR, cột có thể lệch) — quy tắc bám fixture:
 *   - tid       : chuỗi số ngay sau "TID:" (cùng dòng "TID: 53550072/SEQ:...").
 *   - batchNumber: chuỗi số thuần đứng NGAY TRƯỚC nhãn "BATCH No/SO LO" (OCR lệch cột: value trước label);
 *                  fallback số thuần ngay SAU nhãn.
 *   - Vùng "grand" = các dòng TRƯỚC nhãn "THE:" đầu tiên. Trong đó "TONG:" mở tổng lô:
 *       totalCount = số nhỏ (≤4 chữ số) ngay sau "TONG:"; totalAmount = cụm tiền đầu tiên sau "TONG:".
 *   - Mỗi khối thẻ mở bằng "THE:" → scheme = token chữ-cái đầu tiên (MASTERCARD/VISA/JCB);
 *       amount = cụm tiền ĐẦU TIÊN trong khối (dù đứng trước hay sau count);
 *       count  = số 1-3 chữ số đầu tiên trong khối (thường sau "TONG:").
 *   - Suy count thiếu: nếu totalCount biết và ĐÚNG MỘT thẻ thiếu count → count = totalCount − Σ(count khác)
 *       (bám invariant Σ count = totalCount; vd JCB = 11 − 9 − 1 = 1). Chỉ áp khi kết quả ≥ 1.
 */
export function parseSettlementBill(lines: OcrLine[]): SettlementParsed {
  const result: SettlementParsed = {
    tid: null,
    batchNumber: null,
    totalCount: null,
    totalAmount: null,
    perCard: []
  };
  if (!Array.isArray(lines) || lines.length === 0) return result;

  const N = lines.map((l) => normalizeOcrText(l?.text ?? ''));

  // --- tid ---
  for (const tok of N) {
    const m = tok.match(/TID:\s*(\d+)/);
    if (m) {
      result.tid = m[1];
      break;
    }
  }

  // --- batchNumber: số thuần cạnh nhãn "BATCH" / "SO LO" (ưu tiên TRƯỚC nhãn) ---
  const labelIdx = N.findIndex((t) => t.includes('BATCH') || t.includes('SO LO'));
  if (labelIdx >= 0) {
    const isPureNum = (t: string) => /^\d{3,8}$/.test(t);
    let batch: string | null = null;
    for (let i = labelIdx - 1; i >= 0; i--) {
      if (isPureNum(N[i])) {
        batch = N[i];
        break;
      }
    }
    if (batch == null) {
      for (let i = labelIdx + 1; i < N.length; i++) {
        if (isPureNum(N[i])) {
          batch = N[i];
          break;
        }
      }
    }
    result.batchNumber = batch;
  }

  // --- Ranh giới khối thẻ: mọi vị trí "THE:" ---
  const theIdx: number[] = [];
  N.forEach((t, i) => {
    if (t.startsWith('THE:')) theIdx.push(i);
  });
  const firstThe = theIdx.length > 0 ? theIdx[0] : N.length;

  // --- Vùng grand (trước "THE:" đầu tiên): totalCount + totalAmount ---
  const grandTongIdx = N.findIndex((t, i) => i < firstThe && t.startsWith('TONG:'));
  const grandStart = grandTongIdx >= 0 ? grandTongIdx + 1 : 0;
  for (let i = grandStart; i < firstThe; i++) {
    if (result.totalCount == null && /^\d{1,4}$/.test(N[i])) result.totalCount = Number.parseInt(N[i], 10);
    if (result.totalAmount == null) {
      const mv = moneyValue(N[i]);
      if (mv != null) result.totalAmount = mv;
    }
    if (result.totalCount != null && result.totalAmount != null) break;
  }

  // --- Từng khối thẻ ---
  for (let k = 0; k < theIdx.length; k++) {
    const start = theIdx[k];
    const end = k + 1 < theIdx.length ? theIdx[k + 1] : N.length;
    let scheme: string | null = null;
    let amount: number | null = null;
    let count: number | null = null;
    for (let i = start + 1; i < end; i++) {
      const tok = N[i];
      if (scheme == null && /^[A-Z]{2,}$/.test(tok)) scheme = tok;
      if (count == null && /^\d{1,3}$/.test(tok)) count = Number.parseInt(tok, 10);
      if (amount == null) {
        const mv = moneyValue(tok);
        if (mv != null) amount = mv;
      }
    }
    if (scheme != null && amount != null) {
      result.perCard.push({ scheme, count, amount });
    }
  }

  // --- Suy count còn thiếu bằng invariant Σ count = totalCount (chỉ khi đúng 1 thẻ thiếu) ---
  if (result.totalCount != null) {
    const missing = result.perCard.filter((c) => c.count == null);
    if (missing.length === 1) {
      const sumKnown = result.perCard.reduce((s, c) => s + (c.count ?? 0), 0);
      const inferred = result.totalCount - sumKnown;
      if (inferred >= 1) missing[0].count = inferred;
    }
  }

  return result;
}

// =============================== HÀM 2: parseRefundTransfer ===============================

export interface RefundTransferParsed {
  amount: number | null; // số tiền chuyển (VND)
  recipientName: string | null; // tên người nhận (đại lý) nếu đọc được
  refCode: string | null; // mã giao dịch (FT... / mã tham chiếu)
}

/**
 * Rút chi tiết ảnh CHUYỂN KHOẢN HOÀN TIỀN (app ngân hàng).
 *
 * Quy tắc bám OCR THẬT:
 *   - amount: ưu tiên cụm tiền ĐẦU TIÊN xuất hiện TỪ dòng chứa "THANH CONG" trở đi
 *       (số CHÍNH của giao dịch, tránh nhặt nhầm số phụ/âm phía trên như "-43,382,000").
 *       Fallback: cụm tiền đầu tiên trong toàn ảnh nếu không thấy "THANH CONG".
 *   - recipientName: tên IN HOA ngay sau "DEN " (Đến), vd "DEN KHACH HANG 20" → "KHACH HANG 20".
 *   - refCode: theo thứ tự ưu tiên — mã "FT" + ≥8 chữ số → chuỗi ngay sau nhãn "MA GIAO DICH"
 *       → mã dạng "MP3MX/299841". Không thấy → null.
 */
export function parseRefundTransfer(lines: OcrLine[]): RefundTransferParsed {
  const result: RefundTransferParsed = { amount: null, recipientName: null, refCode: null };
  if (!Array.isArray(lines) || lines.length === 0) return result;

  const N = lines.map((l) => normalizeOcrText(l?.text ?? ''));

  // --- amount: từ dòng "THANH CONG" trở đi (fallback: toàn ảnh) ---
  const successIdx = N.findIndex((t) => t.includes('THANH CONG'));
  const amtStart = successIdx >= 0 ? successIdx : 0;
  for (let i = amtStart; i < N.length; i++) {
    const mv = moneyValue(N[i]);
    if (mv != null) {
      result.amount = mv;
      break;
    }
  }
  if (result.amount == null && successIdx >= 0) {
    // "THANH CONG" có nhưng không có tiền sau nó → quét toàn ảnh làm fallback.
    for (const tok of N) {
      const mv = moneyValue(tok);
      if (mv != null) {
        result.amount = mv;
        break;
      }
    }
  }

  // --- recipientName: sau "DEN " ---
  for (let i = 0; i < N.length; i++) {
    const tok = N[i];
    const m = tok.match(/^DEN\s+([A-Z][A-Z ]+)$/);
    if (m) {
      result.recipientName = m[1].trim();
      break;
    }
    // Biến thể: nhãn "DEN" đứng riêng, tên ở dòng kế.
    if ((tok === 'DEN' || tok === 'DEN:') && i + 1 < N.length && /^[A-Z][A-Z ]+$/.test(N[i + 1])) {
      result.recipientName = N[i + 1].trim();
      break;
    }
  }

  // --- refCode ---
  // 1) FT + ≥8 chữ số
  for (const tok of N) {
    const m = tok.match(/\bFT\d{8,}\b/);
    if (m) {
      result.refCode = m[0];
      break;
    }
  }
  // 2) chuỗi ngay sau nhãn "MA GIAO DICH"
  if (result.refCode == null) {
    const gdIdx = N.findIndex((t) => t.includes('MA GIAO DICH'));
    if (gdIdx >= 0 && gdIdx + 1 < N.length) {
      const cand = N[gdIdx + 1].trim();
      if (/[A-Z0-9]/.test(cand)) result.refCode = cand;
    }
  }
  // 3) mã dạng "MP3MX/299841"
  if (result.refCode == null) {
    for (const tok of N) {
      const m = tok.match(/\b([A-Z0-9]{4,}\/\d{4,})\b/);
      if (m) {
        result.refCode = m[1];
        break;
      }
    }
  }

  return result;
}
