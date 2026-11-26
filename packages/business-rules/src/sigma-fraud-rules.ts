// SIGMA (2026-07-22) — Rule A-E chống gian lận cho "Lô"/"bill lẻ" (xem apps/bot-api/src/routes/lo.ts) +
// logic tam giác đối soát (triangulation) + cảnh báo trùng "số lô". Pure logic — KHÔNG DB, KHÔNG Electron,
// khớp quy ước packages/business-rules (file-per-concern, xem transaction.rules.ts/audit.rules.ts).
//
// Mọi rule trả `{ violated: boolean; message: string }` — KHÔNG throw cho "không vi phạm" (chỉ throw cho lỗi
// LẬP TRÌNH thật sự, vd input sai shape) — yêu cầu LEAD, tránh caller phải try/catch cho luồng bình thường.

export interface RuleResult {
  violated: boolean;
  message: string;
}

const vnd = (n: number): string => Math.round(n).toLocaleString('vi-VN');

// ── Rule A — số tiền/lệnh quẹt ────────────────────────────────────────────────
// LEAD chốt: đạt ĐÚNG mức tối đa cũng ĐÃ là vi phạm (>=, không phải >).
export function checkMaxAmountPerSwipe(amount: number, maxAmountPerSwipe: number | null): RuleResult {
  if (maxAmountPerSwipe == null) return { violated: false, message: 'Không giới hạn số tiền/lệnh quẹt.' };
  if (amount >= maxAmountPerSwipe) {
    return {
      violated: true,
      message: `Số tiền ${vnd(amount)} đ ĐÃ CHẠM/VƯỢT mức tối đa cho phép mỗi lệnh quẹt (${vnd(maxAmountPerSwipe)} đ).`
    };
  }
  return { violated: false, message: 'Số tiền trong hạn mức cho phép mỗi lệnh quẹt.' };
}

// ── Trợ giúp biên NGÀY theo LOCAL (giờ máy chủ), half-open — CÙNG công thức localDayBounds
// (apps/desktop/src/main/tid-service.ts, B24) / getMonthlyProfit (dashboard-service.ts) đã dùng trong repo
// GLB gốc. Bản Electron-only KHÔNG import được vào bot-api/vitest (guard.ts qua Electron) → viết lại THUẦN
// ở đây, giữ NGUYÊN công thức so sánh y/m/d local, không phát minh quy ước biên mới.
export function isSameLocalDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// ── Rule B — số lệnh quẹt/ngày cho 1 thẻ ──────────────────────────────────────
// ASSUMPTION (build 22/7, chưa LEAD chốt riêng): scope THEO THẺ (cardLast4), giống cách đề bài phát biểu
// ("số lệnh quẹt/ngày/thẻ"). Caller lọc TRƯỚC (cùng cardLast4 + isSameLocalDay so target day) rồi truyền
// mảng mốc quẹt CÙNG NGÀY đó vào đây — giữ hàm thuần đơn giản, dễ test độc lập khỏi việc lọc ngày.
export function checkMaxSwipesPerDayPerCard(sameDayCardSwipes: Date[], maxSwipesPerDayPerCard: number | null): RuleResult {
  if (maxSwipesPerDayPerCard == null) return { violated: false, message: 'Không giới hạn số lệnh quẹt/ngày cho thẻ này.' };
  const count = sameDayCardSwipes.length;
  if (count > maxSwipesPerDayPerCard) {
    return {
      violated: true,
      message: `Thẻ này đã quẹt ${count} lệnh trong ngày, VƯỢT mức tối đa cho phép (${maxSwipesPerDayPerCard} lệnh/ngày).`
    };
  }
  return { violated: false, message: `Thẻ này quẹt ${count} lệnh trong ngày, trong hạn mức.` };
}

// ── Rule C — số tiền "tròn" bất thường ────────────────────────────────────────
// ASSUMPTION (build 22/7, CHƯA LEAD chốt ngưỡng chính xác): LEAD chỉ cho 2 ví dụ 5.000.000đ và 10.000.000đ.
// Ngưỡng cụ thể ("tròn" tới đâu là đủ nghi vấn — bội 1.000.000? 500.000? 100.000?) KHÔNG được nói rõ hơn.
// Chọn "bội số của 1.000.000đ" vì đây là ngưỡng RỘNG NHẤT khớp CẢ 2 ví dụ mà không tự nới rộng hơn nữa
// (CẤM suy luận rộng hơn). Nếu Admin Demo muốn mịn hơn (vd bội 500.000) — cần xác nhận riêng trước khi đổi.
const ROUND_AMOUNT_UNIT_VND = 1_000_000;
export function checkRoundAmount(amount: number, disallowRoundAmounts: boolean): RuleResult {
  if (!disallowRoundAmounts) return { violated: false, message: 'Không bật kiểm tra số tiền tròn.' };
  const isRound = amount > 0 && amount % ROUND_AMOUNT_UNIT_VND === 0;
  if (isRound) {
    return {
      violated: true,
      message: `Số tiền ${vnd(amount)} đ là số TRÒN (bội số ${vnd(ROUND_AMOUNT_UNIT_VND)} đ) — nghi vấn, cần kiểm tay.`
    };
  }
  return { violated: false, message: 'Số tiền không tròn bất thường.' };
}

// ── Rule D — khoảng cách thời gian tối thiểu giữa 2 lệnh quẹt liên tiếp ───────
// ASSUMPTION (build 22/7, chưa LEAD chốt riêng): scope THEO THẺ (cardLast4), ĐỒNG NHẤT cách scope Rule B/E
// cho nhất quán (đề bài không nói rõ theo thẻ hay theo TID/đại lý). Hàm tự SẮP XẾP input (không bắt caller
// phải tự sort trước — tránh 1 lớp lỗi "quên sort" âm thầm).
export function checkMinGapBetweenSwipes(cardSwipeTimes: Date[], minGapMinutesBetweenSwipes: number | null): RuleResult {
  if (minGapMinutesBetweenSwipes == null) return { violated: false, message: 'Không giới hạn khoảng cách thời gian giữa 2 lệnh quẹt.' };
  if (cardSwipeTimes.length < 2) return { violated: false, message: 'Chưa đủ 2 lệnh quẹt để so khoảng cách.' };
  const sorted = [...cardSwipeTimes].sort((a, b) => a.getTime() - b.getTime());
  for (let i = 1; i < sorted.length; i++) {
    const gapMin = (sorted[i].getTime() - sorted[i - 1].getTime()) / 60_000;
    if (gapMin < minGapMinutesBetweenSwipes) {
      return {
        violated: true,
        message: `2 lệnh quẹt liên tiếp của thẻ này cách nhau ${gapMin.toFixed(1)} phút, DƯỚI mức tối thiểu yêu cầu (${minGapMinutesBetweenSwipes} phút).`
      };
    }
  }
  return { violated: false, message: 'Khoảng cách giữa các lệnh quẹt liên tiếp của thẻ này đều đạt tối thiểu.' };
}

// ── Rule E — trùng số tiền trong khoảng thời gian gần nhau ────────────────────
// ASSUMPTION (build 22/7, chưa LEAD chốt riêng): scope THEO THẺ (cardLast4), CÙNG lý do với Rule D.
export function checkRepeatedAmountNearby(
  cardSwipes: { ocrAmount: number; swipeAt: Date }[],
  disallowRepeatedAmountNearby: boolean,
  repeatedAmountWindowMinutes: number | null
): RuleResult {
  if (!disallowRepeatedAmountNearby) return { violated: false, message: 'Không bật kiểm tra trùng số tiền gần nhau.' };
  if (repeatedAmountWindowMinutes == null) {
    // Lỗi CẤU HÌNH (bad input shape thật sự — disallow bật nhưng thiếu ngưỡng cửa sổ) → throw, KHÔNG đoán ngầm.
    throw new Error('repeatedAmountWindowMinutes bắt buộc khi disallowRepeatedAmountNearby=true.');
  }
  const sorted = [...cardSwipes].sort((a, b) => a.swipeAt.getTime() - b.swipeAt.getTime());
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const gapMin = (sorted[j].swipeAt.getTime() - sorted[i].swipeAt.getTime()) / 60_000;
      if (gapMin > repeatedAmountWindowMinutes) break; // đã sort theo thời gian → mọi k>j còn xa hơn nữa
      if (sorted[i].ocrAmount === sorted[j].ocrAmount) {
        return {
          violated: true,
          message: `2 lệnh quẹt cùng số tiền ${vnd(sorted[i].ocrAmount)} đ cách nhau ${gapMin.toFixed(1)} phút (trong ngưỡng ${repeatedAmountWindowMinutes} phút) — nghi vấn trùng lặp.`
        };
      }
    }
  }
  return { violated: false, message: 'Không phát hiện số tiền trùng lặp gần nhau.' };
}

// ── Rule F — tổng số tiền quẹt/ngày cho 1 TID ─────────────────────────────────
// LEAD chốt (build 22/7): khác CHIỀU với Rule A (từng lệnh đơn) và Rule B (SỐ LỆNH/ngày/thẻ) — Rule F là
// TỔNG TIỀN/ngày, scope THEO TID (không phải thẻ). Caller lọc TRƯỚC (cùng tidId + isSameLocalDay so target
// day, join LoBill→Lo→LoRow.tidId — xem fetchTidSwipeAmountsForAgent/resolveLoFirstRowTidId ở lo-service.ts)
// rồi truyền mảng SỐ TIỀN cùng ngày đó vào đây — giữ hàm thuần đơn giản, khớp khuôn Rule B.
// So sánh strict `>` (vượt mới vi phạm, ĐÚNG BẰNG mức tối đa KHÔNG vi phạm) — khớp chiều Rule B ("count >
// max"), KHÁC Rule A (">=", LEAD chốt riêng cho đơn-lệnh, không tự suy ra áp dụng chung cho Rule F).
export function checkMaxDailyTotalPerTid(sameDayTidAmounts: number[], maxDailyTotalPerTid: number | null): RuleResult {
  if (maxDailyTotalPerTid == null) return { violated: false, message: 'Không giới hạn tổng số tiền quẹt/ngày cho TID này.' };
  const total = sameDayTidAmounts.reduce((sum, a) => sum + a, 0);
  if (total > maxDailyTotalPerTid) {
    return {
      violated: true,
      message: `Tổng số tiền quẹt trong ngày của TID này là ${vnd(total)} đ, VƯỢT mức tối đa cho phép (${vnd(maxDailyTotalPerTid)} đ/ngày).`
    };
  }
  return { violated: false, message: `Tổng số tiền quẹt trong ngày của TID này là ${vnd(total)} đ, trong hạn mức.` };
}

// ── Triangulation — quy trách nhiệm khi tổng KHÔNG khớp expectedTotal ─────────
export type TriangulationBlame = 'NONE' | 'SUMMARY' | 'INDIVIDUALS' | 'BOTH_SUSPECT';
export interface TriangulationResult {
  blame: TriangulationBlame;
  message: string;
}

/**
 * expectedTotal = tổng dự kiến lúc báo giá (Lo.expectedTotalAmount).
 * summaryOcrTotal = số tiền OCR từ bill TỔNG KẾT.
 * sumOfIndividualBillsOcrTotal = Σ ocrAmount của các bill LẺ đã ghi cho lô này.
 * KHÔNG cố xác định CỤ THỂ bill lẻ nào sai khi blame=INDIVIDUALS — không có cách suy ra robust từ dữ liệu
 * hiện có (nhiều tổ hợp có thể cho cùng 1 tổng lệch), nói thẳng "cần kiểm tay" thay vì đoán (yêu cầu LEAD).
 */
export function triangulateMismatch(expectedTotal: number, summaryOcrTotal: number, sumOfIndividualBillsOcrTotal: number): TriangulationResult {
  const summaryMatches = summaryOcrTotal === expectedTotal;
  const individualsMatch = sumOfIndividualBillsOcrTotal === expectedTotal;

  if (summaryMatches && individualsMatch) {
    return { blame: 'NONE', message: 'Bill tổng kết và tổng bill lẻ đều khớp số tiền dự kiến.' };
  }
  if (summaryMatches && !individualsMatch) {
    return {
      blame: 'INDIVIDUALS',
      message: `Bill tổng kết khớp (${vnd(summaryOcrTotal)} đ) nhưng tổng các bill lẻ (${vnd(sumOfIndividualBillsOcrTotal)} đ) LỆCH so với dự kiến (${vnd(expectedTotal)} đ) — cần kiểm tay các bill lẻ (không xác định được bill nào sai cụ thể).`
    };
  }
  if (!summaryMatches && individualsMatch) {
    return {
      blame: 'SUMMARY',
      message: `Tổng các bill lẻ khớp dự kiến nhưng bill tổng kết (${vnd(summaryOcrTotal)} đ) LỆCH so với dự kiến (${vnd(expectedTotal)} đ) — nghi bill tổng kết OCR sai/đọc nhầm.`
    };
  }
  return {
    blame: 'BOTH_SUSPECT',
    message: `CẢ bill tổng kết (${vnd(summaryOcrTotal)} đ) VÀ tổng bill lẻ (${vnd(sumOfIndividualBillsOcrTotal)} đ) đều LỆCH so với dự kiến (${vnd(expectedTotal)} đ) — không đoán bên nào đáng ngờ hơn, cần kiểm tay toàn bộ lô.`
  };
}

// ── Cảnh báo trùng "số lô" (bank-assigned) trong lịch sử CÙNG TID ─────────────
// SCOPE THEO TID (LEAD chỉnh lại 23/7 — sửa từ scope "cùng đại lý" ban đầu): mỗi TID có bộ đếm kết toán
// riêng độc lập ở ngân hàng, nên 2 TID khác nhau trùng số lô là BÌNH THƯỜNG (kể cả CÙNG đại lý) — CHỈ đáng
// ngờ khi CÙNG 1 TID báo trùng số. Query lấy `sameTidPastLoNumbers` là việc của caller (DB, join qua LoRow —
// xem lo-service.ts/resolveLoFirstRowTidId) — hàm này CHỈ so sánh thuần trên danh sách đã fetch, giữ để test
// được độc lập khỏi Prisma/DB (yêu cầu LEAD).
export interface LoNumberReuseResult {
  violated: boolean;
  message: string;
}
export function checkLoNumberReuse(newLoNumber: number | null, sameTidPastLoNumbers: (number | null)[]): LoNumberReuseResult {
  if (newLoNumber == null) return { violated: false, message: 'Chưa có số lô (ngân hàng cấp) để kiểm tra trùng.' };
  const reused = sameTidPastLoNumbers.some((n) => n != null && n === newLoNumber);
  if (reused) {
    return {
      violated: true,
      message: `Số lô ${newLoNumber} ĐÃ từng ghi nhận trước đây cho TID này — nghi ngờ OCR đọc nhầm / gửi lại ảnh cũ / gian lận (chỉ CẢNH BÁO, không chặn cứng — theo yêu cầu LEAD).`
    };
  }
  return { violated: false, message: `Số lô ${newLoNumber} chưa từng ghi nhận cho TID này.` };
}

// ── Rule G (2026-08-12, Admin Demo chốt) — CẢNH BÁO (KHÔNG chặn) thứ tự/nhảy cóc/trùng số hóa đơn + số lô ─────
// ĐỔI quyết định cũ 23/7 ("số hóa đơn TUYỆT ĐỐI KHÔNG validate liên tục"): nay THÊM CẢNH BÁO — KHÔNG unique
// constraint, KHÔNG chặn CONFIRMED, chỉ HIỆN RÕ để người dùng đối chiếu (nguyên tắc Admin Demo: MỌI bất thường
// PHẢI hiện rõ, KHÔNG im lặng bỏ qua — kể cả reset). 3 NHÓM cảnh báo (đều CHỈ cảnh báo):
//   • DUPLICATE_BILL   → "Bill đã gửi trước đó" (TẤT CẢ dữ liệu OCR của bill trùng 1 bill đã ghi/đã gửi).
//   • *_GAP            → "Khách gửi thiếu bill" (số hóa đơn / số lô nhảy cóc, thiếu số ở giữa).
//   • *_INVERSION / *_RESET / *_BACKWARD → "Kiểm tra lại thứ tự/thời gian" (giờ muộn số nhỏ CÙNG NGÀY;
//     số về nhỏ khi SANG NGÀY MỚI = nghi reset; số lô lùi so với đã ghi).
// Scope THEO TID (mỗi máy POS 1 dãy số) — MBV KHÔNG có số lô nên caller BỎ QUA nhóm số lô cho MBV.
export type LoSequenceWarningKind =
  | 'DUPLICATE_BILL'
  | 'RECEIPT_GAP'
  | 'RECEIPT_INVERSION'
  | 'RECEIPT_RESET'
  | 'LO_NUMBER_GAP'
  | 'LO_NUMBER_BACKWARD';

export interface LoSequenceWarning {
  kind: LoSequenceWarningKind;
  message: string;
}

/** Dấu vân tay 1 "bill lẻ" để so trùng + so thứ tự. `isNew=true` = bill trong batch đối soát HIỆN TẠI;
 * `isNew=false` = bill đã persist ở lô TRƯỚC (cùng TID). Cảnh báo thứ tự CHỈ phát khi cặp liên quan có ÍT
 * NHẤT 1 bill mới (tránh lặp lại cảnh báo lịch sử đã đối soát ở lần trước). */
export interface LoBillFingerprint {
  receiptNumber: number | null;
  ocrAmount: number;
  swipeAt: Date;
  cardLast4: string | null;
  isNew: boolean;
}

const swipeTimeLabel = (d: Date): string =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} ${d.getDate()}/${d.getMonth() + 1}`;

// "Toàn bộ dữ liệu OCR trùng" = cùng số hóa đơn + cùng số tiền + cùng mốc quẹt (ms) + cùng 4 số cuối thẻ.
// (scope TID đã do caller lọc — chỉ nạp bill CÙNG TID vào danh sách so.)
function isSameBill(a: LoBillFingerprint, b: LoBillFingerprint): boolean {
  return (
    a.receiptNumber === b.receiptNumber &&
    a.ocrAmount === b.ocrAmount &&
    a.swipeAt.getTime() === b.swipeAt.getTime() &&
    (a.cardLast4 ?? null) === (b.cardLast4 ?? null)
  );
}
const fingerprintKey = (b: LoBillFingerprint): string =>
  `${b.receiptNumber ?? 'x'}|${b.ocrAmount}|${b.swipeAt.getTime()}|${b.cardLast4 ?? 'x'}`;

/** Phát hiện bill batch TRÙNG TOÀN BỘ OCR với 1 bill đã ghi trước đó (lịch sử cùng TID) HOẶC với 1 bill mới
 * KHÁC trong cùng batch (gửi lại/nhân đôi). Mỗi vân tay trùng chỉ cảnh báo 1 lần. */
export function detectDuplicateBills(bills: LoBillFingerprint[]): LoSequenceWarning[] {
  const warnings: LoSequenceWarning[] = [];
  const history = bills.filter((b) => !b.isNew);
  const batch = bills.filter((b) => b.isNew);
  const emitted = new Set<string>();
  for (let i = 0; i < batch.length; i++) {
    const cur = batch[i];
    const pool = [...history, ...batch.slice(0, i)]; // lịch sử + các bill mới ĐỨNG TRƯỚC trong batch
    if (!pool.some((p) => isSameBill(p, cur))) continue;
    const key = fingerprintKey(cur);
    if (emitted.has(key)) continue;
    emitted.add(key);
    warnings.push({
      kind: 'DUPLICATE_BILL',
      message: `Bill này ĐÃ được gửi trước đó (số HĐ ${cur.receiptNumber ?? '(trống)'}, ${vnd(cur.ocrAmount)} đ, quẹt lúc ${swipeTimeLabel(
        cur.swipeAt
      )}${cur.cardLast4 ? `, thẻ …${cur.cardLast4}` : ''}) — nghi GỬI LẠI/nhân đôi, đối chiếu trước khi xác nhận.`
    });
  }
  return warnings;
}

/** Cảnh báo thứ tự/nhảy cóc số HÓA ĐƠN trong 1 TID: sắp bill theo giờ quẹt tăng → số hóa đơn phải tăng dần
 * trong CÙNG chu kỳ (cùng ngày, tới khi reset). Reset đầu ngày = số về nhỏ khi SANG NGÀY MỚI → vẫn cảnh báo
 * "kiểm tra lại" (KHÔNG im lặng bỏ qua), nhưng phân loại RIÊNG khỏi nghịch-thứ-tự cùng ngày. Gap CÙNG NGÀY =
 * "gửi thiếu bill". Gap KHÁC NGÀY (số đếm liên tục qua ngày) KHÔNG cảnh báo (chu kỳ khác, bình thường). */
export function checkReceiptNumberSequence(bills: LoBillFingerprint[]): LoSequenceWarning[] {
  const numbered = bills.filter((b) => b.receiptNumber != null);
  const sorted = [...numbered].sort((a, b) => {
    const t = a.swipeAt.getTime() - b.swipeAt.getTime();
    return t !== 0 ? t : a.receiptNumber! - b.receiptNumber!;
  });
  const warnings: LoSequenceWarning[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (!prev.isNew && !cur.isNew) continue; // cặp thuần lịch sử → đã đối soát ở lần trước, bỏ qua
    const pn = prev.receiptNumber!;
    const cn = cur.receiptNumber!;
    if (cn === pn) continue; // số trùng → để detectDuplicateBills lo (nếu toàn bộ OCR trùng)
    const sameDay = isSameLocalDay(prev.swipeAt, cur.swipeAt);
    if (cn < pn) {
      if (sameDay) {
        warnings.push({
          kind: 'RECEIPT_INVERSION',
          message: `Kiểm tra lại thứ tự/thời gian: hóa đơn số ${cn} có giờ quẹt MUỘN hơn hóa đơn số ${pn} nhưng số lại NHỎ hơn (cùng ngày, cùng máy POS) — nghi OCR đọc nhầm số hoặc sai thứ tự bill.`
        });
      } else {
        warnings.push({
          kind: 'RECEIPT_RESET',
          message: `Kiểm tra lại: số hóa đơn về NHỎ (${pn} → ${cn}) khi SANG NGÀY MỚI — có thể máy POS reset đầu ngày (thường gặp) nhưng vẫn cần đối chiếu cho chắc.`
        });
      }
    } else if (cn - pn > 1 && sameDay) {
      warnings.push({
        kind: 'RECEIPT_GAP',
        message: `Khách gửi THIẾU bill: số hóa đơn nhảy từ ${pn} → ${cn} (thiếu ${cn - pn - 1} số ở giữa, cùng ngày/cùng máy POS) — đối chiếu xem còn bill chưa gửi.`
      });
    }
  }
  return warnings;
}

/** Cảnh báo nhảy cóc / lùi số LÔ (bank cấp) trong 1 TID. CALLER PHẢI BỎ QUA cho MBV (MBV không có số lô).
 * newLoNumber null (chưa có số lô) → không cảnh báo. Trùng số lô (đã có) do checkLoNumberReuse lo riêng —
 * hàm này CHỈ lo GAP (thiếu số ở giữa) + BACKWARD (số nhỏ hơn số đã ghi). */
export function checkLoNumberSequence(newLoNumber: number | null, sameTidPastLoNumbers: (number | null)[]): LoSequenceWarning[] {
  if (newLoNumber == null) return [];
  const past = sameTidPastLoNumbers.filter((n): n is number => n != null);
  if (past.length === 0) return [];
  const warnings: LoSequenceWarning[] = [];
  const lowers = past.filter((n) => n < newLoNumber);
  if (lowers.length > 0) {
    const predecessor = Math.max(...lowers);
    if (newLoNumber - predecessor > 1) {
      warnings.push({
        kind: 'LO_NUMBER_GAP',
        message: `Khách gửi THIẾU lô: số lô nhảy từ ${predecessor} → ${newLoNumber} cho cùng TID (thiếu ${newLoNumber - predecessor - 1} số lô ở giữa) — đối chiếu xem còn lô chưa đối soát.`
      });
    }
  }
  const maxPast = Math.max(...past);
  if (newLoNumber < maxPast && !past.includes(newLoNumber)) {
    warnings.push({
      kind: 'LO_NUMBER_BACKWARD',
      message: `Kiểm tra lại: số lô ${newLoNumber} NHỎ hơn số lô đã ghi trước đó (${maxPast}) cho cùng TID — nghi OCR đọc nhầm hoặc nhập sai thứ tự.`
    });
  }
  return warnings;
}

// ── Mask/validate cardLast4 — PCI-DSS-style data minimization (hard requirement, không phải style) ──────
// KHÔNG BAO GIỜ tin caller gửi ≤4 ký tự — tự cắt về 4 SỐ CUỐI nếu input dài hơn (vd lỡ gửi cả dãy thẻ),
// và validate ký tự đầu ra CHỈ là chữ số. Trả null nếu input rỗng/không có chữ số nào để mask.
export function maskCardLast4(rawInput: string | null | undefined): string | null {
  if (!rawInput) return null;
  const digitsOnly = rawInput.replace(/\D/g, '');
  if (digitsOnly.length === 0) return null;
  return digitsOnly.slice(-4);
}
