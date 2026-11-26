// bill-reconcile.ts — ĐỐI SOÁT + BẮT TRƯỢT BILL theo lô (PURE LOGIC, an toàn tiền).
//
// Bối cảnh: mỗi bill quẹt thẻ POS có Số Lô (batchNumber) + Số HĐ (invoiceNumber,
// TĂNG DẦN liên tiếp trong 1 lô) + số tiền. Bill kết toán (settlement) của 1 lô cho
// biết tổng số giao dịch (totalCount) + tổng tiền (totalAmount).
//
// Không DB / không mạng / không OCR — làm việc trên dữ liệu ĐÃ parse. Hàm THUẦN.

// ---------------------------------------------------------------------------
// HÀM 1: detectMultipleBillsInImage
// ---------------------------------------------------------------------------

export interface DetectMultiInput {
  /** Số lần xuất hiện dấu hiệu bán ("SALE" + "THANH TOAN") trong ảnh (caller đếm từ OCR). */
  saleOccurrences: number;
  /** Số Số HĐ (invoiceNumber) PHÂN BIỆT tìm thấy trong ảnh (caller đếm từ OCR). */
  distinctInvoiceNumbers: number;
}

/**
 * Quyết định ảnh có chứa NHIỀU bill hay không.
 * True nếu saleOccurrences >= 2 HOẶC distinctInvoiceNumbers >= 2.
 * Caller KHÔNG nên auto-ghi khi hàm trả true (ảnh nhiều-bill cần xử lý riêng).
 */
export function detectMultipleBillsInImage(input: DetectMultiInput): boolean {
  const sale = Number.isFinite(input.saleOccurrences) ? input.saleOccurrences : 0;
  const inv = Number.isFinite(input.distinctInvoiceNumbers) ? input.distinctInvoiceNumbers : 0;
  return sale >= 2 || inv >= 2;
}

// ---------------------------------------------------------------------------
// HÀM 2: reconcileBatch (lõi bắt trượt)
// ---------------------------------------------------------------------------

/** Số HĐ + tiền của 1 bill lẻ đã ghi. */
export interface BillLeRecord {
  invoiceNumber: string;
  amount: number;
}

/** Thông tin bill kết toán (settlement) của 1 lô. */
export interface SettlementInfo {
  totalCount: number | null;
  totalAmount: number | null;
}

export type ReconcileStatus =
  | 'OK'
  | 'MISSING_BILLS'
  | 'COUNT_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'NO_SETTLEMENT';

export interface ReconcileResult {
  status: ReconcileStatus;
  /** Số HĐ nhảy cóc còn thiếu (giữ độ rộng leading-zero như input, vd '000414'). */
  missingInvoiceNumbers: string[];
  collectedCount: number;
  collectedAmount: number;
  expectedCount: number | null;
  expectedAmount: number | null;
  /** Mô tả tiếng Việt để hiển thị / cảnh báo. */
  reasons: string[];
}

/** Định dạng tiền kiểu VN: 112999000 -> "112.999.000". */
function formatMoney(n: number): string {
  const neg = n < 0;
  const digits = Math.abs(Math.round(n)).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return (neg ? '-' : '') + grouped;
}

/** Pad số nguyên về đúng độ rộng leading-zero (vd 414, width 6 -> '000414'). */
function padWidth(value: number, width: number): string {
  const s = value.toString();
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
}

/**
 * Đối soát bill lẻ đã thu thập với settlement → bắt TRƯỢT bill.
 *
 * - Gap Số HĐ: parse invoiceNumber thành số nguyên; tìm dải min..max của các Số HĐ
 *   CÓ MẶT → số nào trong dải mà thiếu = missingInvoiceNumbers (format lại đúng độ
 *   rộng leading-zero). Bill không parse được số → bỏ khỏi gap-check nhưng vẫn đếm.
 * - settlement == null → NO_SETTLEMENT (vẫn trả missing theo gap nội bộ nếu có).
 * - Có settlement: MISSING_BILLS > COUNT_MISMATCH > AMOUNT_MISMATCH > OK.
 */
export function reconcileBatch(
  bills: BillLeRecord[],
  settlement: SettlementInfo | null,
): ReconcileResult {
  const list = Array.isArray(bills) ? bills : [];

  const collectedCount = list.length;
  const collectedAmount = list.reduce(
    (sum, b) => sum + (Number.isFinite(b.amount) ? b.amount : 0),
    0,
  );

  // --- Gap Số HĐ ---
  // Chỉ nhận chuỗi toàn chữ số làm Số HĐ hợp lệ để gap-check.
  const parsed: Array<{ value: number; raw: string }> = [];
  for (const b of list) {
    const raw = (b.invoiceNumber ?? '').toString().trim();
    if (raw.length > 0 && /^\d+$/.test(raw)) {
      parsed.push({ value: parseInt(raw, 10), raw });
    }
  }

  const missingInvoiceNumbers: string[] = [];
  let gapDetail = '';
  if (parsed.length >= 1) {
    // Độ rộng leading-zero để format số thiếu: lấy max độ dài chuỗi Số HĐ có mặt.
    const width = parsed.reduce((w, p) => Math.max(w, p.raw.length), 0);
    const present = new Set(parsed.map((p) => p.value));
    const min = Math.min(...parsed.map((p) => p.value));
    const max = Math.max(...parsed.map((p) => p.value));
    for (let n = min; n <= max; n++) {
      if (!present.has(n)) missingInvoiceNumbers.push(padWidth(n, width));
    }
    if (missingInvoiceNumbers.length > 0) {
      const presentSorted = parsed
        .slice()
        .sort((a, b) => a.value - b.value)
        .map((p) => padWidth(p.value, width))
        .join(',');
      gapDetail = `Trượt bill: thiếu Số HĐ ${missingInvoiceNumbers.join(',')} (có ${presentSorted})`;
    }
  }

  const expectedCount = settlement ? settlement.totalCount : null;
  const expectedAmount = settlement ? settlement.totalAmount : null;
  const reasons: string[] = [];

  // --- Không có settlement ---
  if (settlement == null) {
    if (missingInvoiceNumbers.length > 0) reasons.push(gapDetail);
    reasons.push('Chưa có bill kết toán để đối soát lô này.');
    return {
      status: 'NO_SETTLEMENT',
      missingInvoiceNumbers,
      collectedCount,
      collectedAmount,
      expectedCount,
      expectedAmount,
      reasons,
    };
  }

  // --- Có settlement: ưu tiên MISSING > COUNT > AMOUNT > OK ---
  let status: ReconcileStatus;
  if (missingInvoiceNumbers.length > 0) {
    status = 'MISSING_BILLS';
    reasons.push(gapDetail);
  } else if (settlement.totalCount != null && collectedCount !== settlement.totalCount) {
    status = 'COUNT_MISMATCH';
    reasons.push(`Số lượng lệch: thu ${collectedCount} / kết toán ${settlement.totalCount}`);
  } else if (settlement.totalAmount != null && collectedAmount !== settlement.totalAmount) {
    status = 'AMOUNT_MISMATCH';
    reasons.push(
      `Tổng tiền lệch: thu ${formatMoney(collectedAmount)}đ / kết toán ${formatMoney(settlement.totalAmount)}đ`,
    );
  } else {
    status = 'OK';
    reasons.push('Đối soát khớp: đủ Số HĐ, đúng số lượng và tổng tiền.');
  }

  return {
    status,
    missingInvoiceNumbers,
    collectedCount,
    collectedAmount,
    expectedCount,
    expectedAmount,
    reasons,
  };
}
