// SIGMA (2026-07-22) — "Lô" (batch kết toán)/"bill lẻ" service. DB access + orchestration SỐNG Ở ĐÂY
// (caller/route); các rule THUẦN sống trong @sigma/business-rules/sigma-fraud-rules.ts (Rule A-F +
// triangulation + lô-reuse) — hàm ở đây CHỈ fetch dữ liệu + gọi hàm thuần + persist, KHÔNG cài lại logic.
//
// KHÔNG tạo Transaction/doanh thu thật ở đây (out of scope task này) — reconcile CHỈ đổi Lo.status, trả về
// `eligibleForTransactionCreation` để 1 task SAU quyết định có tạo Transaction hay không (deliberate, không
// âm thầm).
import {
  checkLoNumberReuse,
  computeRevenue,
  checkLoNumberSequence,
  checkMaxAmountPerSwipe,
  checkMaxDailyTotalPerTid,
  checkMaxSwipesPerDayPerCard,
  checkMinGapBetweenSwipes,
  checkReceiptNumberSequence,
  checkRepeatedAmountNearby,
  checkRoundAmount,
  detectDuplicateBills,
  isSameLocalDay,
  triangulateMismatch,
  type LoBillFingerprint,
  type LoNumberReuseResult,
  type LoSequenceWarning,
  type TriangulationResult
} from '@sigma/business-rules';
import type { Db } from '@sigma/database';
import { createTransactionSystem, createTransactionSystemMultiCard } from '@sigma/services';
import { quoteRow, isValidAmount, type QuoteRowInput, type QuoteRowResult } from './fee-quote.js';

// ── Tạo Lô ─────────────────────────────────────────────────────────────────────────────────────────────
export type CreateLoError =
  | { ok: false; error: 'VALIDATION'; message: string }
  | { ok: false; error: 'TID_NOT_IN_AGENT_SCOPE'; message: string }
  | { ok: false; error: 'NOT_FOUND'; message: string }
  | { ok: false; error: 'NO_PARTNER'; message: string }
  | { ok: false; error: 'CARD_BANK_MISMATCH'; message: string }
  | { ok: false; error: 'NO_SELL_QUOTE'; message: string }
  // TID đã giao nhưng chưa set giá bán thực tế (chỉ có niêm yết — đại lý không mượn) → chặn tạo Lô, báo đi set giá bán.
  | { ok: false; error: 'NO_ACTUAL_SELL_FEE'; message: string }
  // [B273 24/11] SỬA bill xong nhưng GIAO DỊCH kèm theo chưa đồng bộ được — lô đã đổi, GD thì chưa.
  | { ok: false; error: 'DONG_BO_GD_LOI'; message: string };

export interface CreateLoResult {
  id: number;
  agentId: number;
  bankReportedLoNumber: number | null;
  expectedTotalAmount: string; // BigInt → string qua JSON (khớp cách Prisma/Express serialize BigInt)
  status: string;
  createdAt: Date;
  rows: {
    id: number;
    tidId: number;
    cardTypeId: number;
    feeTypeId: number;
    amountBeforeFee: string;
    feeApplied: string;
    amountAfterFee: string;
  }[];
}

/**
 * Tạo Lô (PENDING) từ rows[] — CÙNG shape request `/quote` (tidId, cardTypeId?, feeTypeId?, amountBeforeFee).
 * Gọi THẲNG quoteRow (fee-quote.ts) cho từng dòng — KHÔNG tính lại công thức. ABORT toàn phiếu nếu 1 dòng
 * sai (khớp quy ước /quote — xem routes/agents.ts).
 */
export async function createLo(db: Db, agentId: number, rows: QuoteRowInput[], at: Date = new Date()): Promise<{ ok: true; data: CreateLoResult } | CreateLoError> {
  const quoted: { tidId: number; cardTypeId: number; feeTypeId: number; amountBeforeFee: number; feeApplied: number; amountAfterFee: number }[] = [];
  for (const row of rows) {
    // CRITICAL-1 (4/9): báo giá tại NGÀY GD `at` (ngày bill) → phí Lô KHỚP phí Transaction (weekend cùng chỗ gốc).
    const r = await quoteRow(db, agentId, row, at);
    if (!r.ok) return r;
    quoted.push(r.data);
  }
  const expectedTotalAmount = quoted.reduce((sum, r) => sum + BigInt(r.amountAfterFee), 0n);

  const lo = await db.lo.create({ data: { agentId, expectedTotalAmount, status: 'PENDING' } });
  const rowsData = quoted.map((r) => ({
    loId: lo.id,
    tidId: r.tidId,
    cardTypeId: r.cardTypeId,
    feeTypeId: r.feeTypeId,
    amountBeforeFee: BigInt(r.amountBeforeFee),
    feeApplied: BigInt(r.feeApplied),
    amountAfterFee: BigInt(r.amountAfterFee)
  }));
  await db.loRow.createMany({ data: rowsData });
  const createdRows = await db.loRow.findMany({ where: { loId: lo.id }, orderBy: { id: 'asc' } });

  await db.auditLog.create({
    data: {
      actorUserId: null,
      action: 'SIGMA_LO_CREATED',
      targetType: 'Lo',
      targetId: String(lo.id),
      afterJson: JSON.stringify({ agentId, expectedTotalAmount: expectedTotalAmount.toString(), rowCount: rowsData.length }),
      ipAddress: 'sigma-bot-api',
      deviceInfo: 'apps/bot-api'
    }
  });

  return {
    ok: true,
    data: {
      id: lo.id,
      agentId: lo.agentId,
      bankReportedLoNumber: lo.bankReportedLoNumber,
      expectedTotalAmount: lo.expectedTotalAmount.toString(),
      status: lo.status,
      createdAt: lo.createdAt,
      rows: createdRows.map((r) => ({
        id: r.id,
        tidId: r.tidId,
        cardTypeId: r.cardTypeId,
        feeTypeId: r.feeTypeId,
        amountBeforeFee: r.amountBeforeFee.toString(),
        feeApplied: r.feeApplied.toString(),
        amountAfterFee: r.amountAfterFee.toString()
      }))
    }
  };
}

/**
 * NỐI BILL → DOANH SỐ (Admin Demo 21/8 "gửi bill phải ghi nhận doanh số"): tạo Lô 1-dòng từ 1 bill đã gửi trong
 * nhóm chat. Bill mang TID dạng CHUỖI (OCR) + số tiền + loại thẻ đã chọn → resolve TID chuỗi ra id rồi gọi
 * createLo (TÁI DÙNG — quoteRow tự kiểm scope khách qua nhóm chat + giá bán thực tế + loại phí mặc định). TID
 * chưa cấu hình giá bán → NO_ACTUAL_SELL_FEE (bill vẫn gửi, chỉ KHÔNG ghi doanh số — báo đại lý đi set giá).
 */
/** Dựng CreateLoResult từ 1 Lô đã có (đọc lại Lô + rows) — dùng cho nhánh UPSERT (gửi-lại/sửa cùng bill). */
async function loToResult(db: Db, loId: number): Promise<CreateLoResult> {
  const lo = await db.lo.findUniqueOrThrow({ where: { id: loId } });
  const rows = await db.loRow.findMany({ where: { loId }, orderBy: { id: 'asc' } });
  return {
    id: lo.id,
    agentId: lo.agentId,
    bankReportedLoNumber: lo.bankReportedLoNumber,
    expectedTotalAmount: lo.expectedTotalAmount.toString(),
    status: lo.status,
    createdAt: lo.createdAt,
    rows: rows.map((r) => ({
      id: r.id,
      tidId: r.tidId,
      cardTypeId: r.cardTypeId,
      feeTypeId: r.feeTypeId,
      amountBeforeFee: r.amountBeforeFee.toString(),
      feeApplied: r.feeApplied.toString(),
      amountAfterFee: r.amountAfterFee.toString()
    }))
  };
}

/** Lỗi RIÊNG của createLoFromBillTid: "nghi trùng giao dịch" (tầng 3) — cùng đại lý+TID+số tiền TRONG NGÀY nhưng
 * KHÔNG khớp khóa bill (ảnh khác/bill chụp lại) → KHÔNG tự ghi lần 2 (sợ đếm trùng), trả về cho client cảnh báo
 * đại lý XÁC NHẬN; nếu đúng là giao dịch KHÁC, client gọi lại với allowDuplicate=true để ghi. */
export interface DupSuspectError {
  ok: false;
  error: 'DUP_SUSPECT';
  message: string;
  existingLoId: number;
  existingAt: Date;
}

/** ĐẢM BẢO cột los.bill_txn_date tồn tại (additive, idempotent — cùng khuôn ensureOcrBillSentTable). Chạy lúc boot
 *  bot-api. `ADD COLUMN IF NOT EXISTS` an toàn chạy lặp, KHÔNG đổi data. Có cột này thì persistLoBillTxnDate mới ghi
 *  được ngày bill (nếu chưa có, persist nuốt lỗi + reconcile fallback created_at). */
export async function ensureLoBillTxnDateColumn(db: Db): Promise<void> {
  await db.$executeRawUnsafe('ALTER TABLE los ADD COLUMN IF NOT EXISTS bill_txn_date timestamptz(3)');
  // [Admin Demo 7/9 — MƯỢN TID] cột đại lý MƯỢN TID: khi đại lý A quẹt nhờ TID của B, doanh số lô về A (người quẹt),
  // KHÔNG về chủ TID B. null = không mượn (về chủ TID như thường). Additive idempotent, ngoài prisma client (raw).
  await db.$executeRawUnsafe('ALTER TABLE los ADD COLUMN IF NOT EXISTS borrowed_by_customer_id integer');
}

/** BACKFILL bill_txn_date cho lô ĐÃ có GD nhưng chưa lưu ngày bill (lô ghi TRƯỚC khi thêm cột) — đặt = txn_date của
 *  GD (nguồn ngày bill CHUẨN đã chốt lúc bridge). Idempotent (chỉ điền dòng NULL). Để đại lý report (dùng
 *  bill_txn_date) ĐỒNG NHẤT ngày với NĐT/GD. Trả số dòng đã điền. */
export async function backfillBillTxnDateFromTransactions(db: Db): Promise<number> {
  return db.$executeRawUnsafe(
    `UPDATE los SET bill_txn_date = t.txn_date
     FROM transactions t
     WHERE los.transaction_id = t.id AND los.bill_txn_date IS NULL AND t.txn_date IS NOT NULL`
  );
}

/** Lưu NGÀY BILL THẬT (giờ quẹt OCR) lên cột los.bill_txn_date — nguồn ngày TIN CẬY cho reconcile/redate (thay
 *  created_at = giờ ghi). Raw SQL vì cột nằm NGOÀI prisma client (tránh prisma generate cây chung phá server).
 *  BEST-EFFORT: cột chưa tồn tại / txnDate rỗng → nuốt lỗi im, KHÔNG chặn luồng ghi bill. */
async function persistLoBillTxnDate(db: Db, loId: number, txnDate?: Date): Promise<void> {
  if (!txnDate || isNaN(txnDate.getTime())) return;
  try {
    // [Admin Demo 7/9 FIX GỐC −7h] Session TZ = Asia/Bangkok → bind Date object qua $1::timestamptz bị Postgres đọc
    // wall-clock UTC của Date thành giờ LOCAL Bangkok (−7h) → bill_txn_date lệch, bill quẹt trước 07:00 rơi sai NGÀY.
    // FIX: bind CHUỖI ISO có 'Z' (toISOString) + ::timestamptz → Postgres parse UTC đúng (đã test: A/C=02:17 SAI, B=09:17 ĐÚNG).
    await db.$executeRawUnsafe('UPDATE los SET bill_txn_date = $1::timestamptz WHERE id = $2', txnDate.toISOString(), loId);
  } catch {
    /* cột chưa migrate hoặc lỗi phụ — bỏ qua, ngày bill vẫn ở GD nếu bridge thành công */
  }
}

/** [Admin Demo 7/9 — MƯỢN TID] Lưu đại lý MƯỢN TID lên lô (raw, cột ngoài prisma). null/undefined → set NULL (không mượn
 *  / gỡ mượn). Doanh số + phí lô này về đại-lý-mượn thay chủ TID (getRoomRevenueReport dùng cột này). BEST-EFFORT. */
async function persistLoBorrowedBy(db: Db, loId: number, borrowedByCustomerId?: number | null): Promise<void> {
  try {
    if (borrowedByCustomerId != null && Number.isInteger(borrowedByCustomerId)) {
      await db.$executeRawUnsafe('UPDATE los SET borrowed_by_customer_id = $1 WHERE id = $2', borrowedByCustomerId, loId);
    } else {
      await db.$executeRawUnsafe('UPDATE los SET borrowed_by_customer_id = NULL WHERE id = $1', loId);
    }
  } catch { /* cột chưa migrate — bỏ qua, lô về chủ TID như thường */ }
}

/** Đọc NGÀY BILL THẬT đã lưu (bill_txn_date) — dùng làm mốc ngày cho reconcile/redate. Null nếu chưa có/cột chưa
 *  migrate → caller fallback created_at. Raw SQL (cột ngoài prisma client). */
async function readLoBillTxnDate(db: Db, loId: number): Promise<Date | null> {
  try {
    const rows = await db.$queryRawUnsafe<{ bill_txn_date: Date | null }[]>('SELECT bill_txn_date FROM los WHERE id = $1', loId);
    const v = rows?.[0]?.bill_txn_date;
    return v ? new Date(v) : null;
  } catch {
    return null;
  }
}

export async function createLoFromBillTid(
  db: Db,
  agentId: number,
  input: {
    tidString: string;
    cardTypeId?: number;
    amountBeforeFee: number;
    // PHƯƠNG ÁN C (Admin Demo 1/9) — TÁCH NHIỀU LOẠI THẺ: mỗi dòng {cardTypeId, amountBeforeFee=phần tiền của thẻ đó}.
    // Không truyền (hoặc rỗng) → dùng {cardTypeId, amountBeforeFee} như đường 1-thẻ CŨ (chạy y hệt). Σ lines PHẢI
    // = amountBeforeFee (tổng bill) — fail-closed nếu lệch. 1 Lô sẽ có N LoRow (đại lý tách thẻ), NHƯNG bridge chỉ
    // 1 Transaction TỔNG (amount = Σ) cho NĐT (giữ bất biến 1 Lô ↔ 1 GD, KHÔNG sửa schema).
    lines?: { cardTypeId: number; amountBeforeFee: number }[];
    billKey?: string | null;
    allowDuplicate?: boolean;
    txnDate?: Date;
    // [Audit 3/9 #5] Cho phép GIẢM tổng lô đã ghi (chỉ EDIT cố ý qua editBillParams). Re-send tự động (allowShrink falsy)
    // KHÔNG được thu nhỏ tổng → chống SALE thành phần đè SETTLEMENT cùng lô = mất doanh số.
    allowShrink?: boolean;
    // [Admin Demo 7/9 — MƯỢN TID] đại lý MƯỢN TID (customerId) — đại lý A quẹt nhờ TID của B → doanh số lô về A. undefined
    // = giữ nguyên (không đụng cột khi UPSERT sửa bill); null = gỡ mượn (về chủ TID); số = gán mượn cho customerId đó.
    borrowedByCustomerId?: number | null;
    /** [Admin Demo 16/9 khuya] MÃ ĐÓNG LÔ đọc từ bill ("95"…) — lưu lên lô để mọi nơi hiện "84(95)" theo dõi được. */
    settlementCode?: string | null;
    /** [B190 19/11] LOẠI PHÍ người nhập chọn. TRƯỚC ĐÂY hàm này KHÔNG nhận ⇒ `quoteRow` rơi về loại phí mặc
     *  định (FeeType id nhỏ nhất) ⇒ người dùng chọn "Tiền chờ" mà sổ ghi "Đối ứng", PHÍ BÁN SAI ⇒ tiền về
     *  đại lý sai. Không truyền = giữ nguyên hành vi cũ (lấy mặc định). */
    feeTypeId?: number;
    /** [B201 19/11] Nhân viên nhập tay ở màn "Thêm bill" — bỏ bước kiểm phạm vi đại lý theo NHÓM CHAT
     *  (xem giải thích đầy đủ ở QuoteRowInput.nhanVienNhapTay). Luồng BOT KHÔNG truyền cờ này. */
    nhanVienNhapTay?: boolean;
  }
): Promise<{ ok: true; data: CreateLoResult; bridgeError?: string } | CreateLoError | DupSuspectError> {
  const tidTrimmed = (input.tidString ?? '').trim();
  if (!tidTrimmed) return { ok: false, error: 'NOT_FOUND', message: 'Bill chưa đọc được TID nên không ghi được doanh số.' };
  if (!isValidAmount(input.amountBeforeFee)) return { ok: false, error: 'VALIDATION', message: 'Số tiền bill không hợp lệ (phải là số nguyên ≥ 0).' };
  // Chuẩn hoá danh sách dòng thẻ: đa thẻ (lines) hoặc 1 dòng mặc định (đường cũ). Validate từng dòng + tổng khớp bill.
  const lines: { cardTypeId?: number; amountBeforeFee: number }[] =
    input.lines && input.lines.length > 0 ? input.lines : [{ cardTypeId: input.cardTypeId, amountBeforeFee: input.amountBeforeFee }];
  if (input.lines && input.lines.length > 0) {
    for (const l of input.lines)
      if (!Number.isInteger(l.cardTypeId) || !isValidAmount(l.amountBeforeFee))
        return { ok: false, error: 'VALIDATION', message: 'Dòng tách thẻ không hợp lệ (cardTypeId nguyên; số tiền nguyên ≥ 0).' };
    const sum = input.lines.reduce((s, l) => s + l.amountBeforeFee, 0);
    if (sum !== input.amountBeforeFee)
      return { ok: false, error: 'VALIDATION', message: `Tổng tiền các loại thẻ (${sum}đ) không khớp tổng bill (${input.amountBeforeFee}đ) — không ghi doanh số lệch.` };
  }
  const tid = await db.tid.findFirst({ where: { tid: tidTrimmed, deletedAt: null }, select: { id: true } });
  if (!tid) return { ok: false, error: 'NOT_FOUND', message: `Không tìm thấy TID "${tidTrimmed}" trong hệ thống để ghi doanh số.` };
  const billKey = input.billKey?.trim() || null;

  // UPSERT theo khóa bill (chống Lô trùng khi gửi lại + cập nhật khi SỬA bill). Chỉ khi có billKey đủ định danh
  // (route tự quyết — cần ≥1 trong số lô/số HĐ, hoặc hash ảnh). Lô đã CANCELLED không chặn (bỏ qua). Lô đã đối
  // soát (≠PENDING) → KHÔNG sửa số đã chốt, trả nguyên trạng (idempotent, không tạo trùng).
  if (billKey) {
    const existing = await db.lo.findFirst({ where: { agentId, billKey, status: { not: 'CANCELLED' } }, orderBy: { id: 'desc' } });
    if (existing) {
      if (existing.status !== 'PENDING') return { ok: true, data: await loToResult(db, existing.id) };
      // [B194 19/11 — agent audit] LÔ ĐÃ ĐỐI SOÁT / ĐÃ HOÀN TIỀN thì CẤM ghi đè. Cờ đối soát nằm ở bảng
      // `pos_lot_recon` và KHÔNG BAO GIỜ đổi `los.status`, nên gác "status !== PENDING" ở trên không thấy.
      // Tái hiện thật: lô đã đối soát + đã hoàn, ghi lại số lớn hơn ⇒ tiền về đại lý +4.948.504đ trong khi lô
      // vẫn mang cờ "đã hoàn" ⇒ không ai còn phải trả phần chênh (hoặc đã trả thừa mà không ai đòi).
      // CỘT LÀ `lot_id` (không phải `lo_id`) — viết sai tên cột thì câu này NÉM LỖI, mà bắt lỗi rồi coi như
      // "không có gì" là nuốt im: chốt chặn trông như đang chạy nhưng thực tế không chặn ai (R198). Nay sai
      // câu lệnh thì PHẢI nổ ra để sửa, không âm thầm bỏ qua.
      const daChot = await db.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM pos_lot_recon WHERE lot_id = $1 AND (ds IS TRUE OR refund_done IS TRUE)`,
        existing.id
      );
      if ((daChot[0]?.n ?? 0) > 0) {
        console.error(`[lo-service B194] CHẶN ghi đè lô ${existing.id}: đã đối soát/đã hoàn tiền.`);
        try {
          await db.auditLog.create({ data: { actorUserId: null, action: 'SIGMA_LO_OVERWRITE_BLOCKED_RECONCILED', targetType: 'Lo', targetId: String(existing.id) } });
        } catch { /* best-effort */ }
        return {
          ok: false, error: 'VALIDATION',
          message: `Bill này đã ĐỐI SOÁT/ĐÃ HOÀN TIỀN (lô #${existing.id}) — không ghi đè được. Hãy gửi yêu cầu hủy rồi nhập lại nếu cần sửa.`
        };
      }
      // ĐẠI LÝ HIỆU LỰC cho báo giá: caller khai mượn → nhà mượn; không khai → giữ nhà đang gắn trên lô (đọc raw,
      // cột borrowed_by_customer_id không có trong Prisma); không có nữa → chủ máy (undefined = fee-quote tự lấy).
      const muonCu = await db.$queryRawUnsafe<Array<{ borrowed_by_customer_id: number | null }>>(
        `SELECT borrowed_by_customer_id FROM los WHERE id = $1`, existing.id);
      const daiLyHieuLuc = input.borrowedByCustomerId !== undefined
        ? input.borrowedByCustomerId
        : (muonCu[0]?.borrowed_by_customer_id ?? undefined);
      // Báo giá LẠI MỌI dòng thẻ (fail-closed từng dòng: thiếu giá bán 1 loại → NO_ACTUAL_SELL_FEE, KHÔNG ghi lệch).
      const quoted: QuoteRowResult[] = [];
      for (const l of lines) {
        // [Admin Demo 25/9 — GIÁ BÁN THEO ĐẠI LÝ] báo giá theo ĐẠI LÝ ĐANG CẦM máy: mượn thì là nhà mượn (giá riêng
        // của nhà đó nếu đã đặt), không khai mượn thì giữ nhà đang gắn trên lô, cuối cùng mới về chủ máy.
        const q = await quoteRow(db, agentId, { tidId: tid.id, cardTypeId: l.cardTypeId, feeTypeId: input.feeTypeId, amountBeforeFee: l.amountBeforeFee, dealerCustomerId: daiLyHieuLuc, nhanVienNhapTay: input.nhanVienNhapTay }, input.txnDate);
        if (!q.ok) return q;
        quoted.push(q.data);
      }
      const totalAfter = quoted.reduce((s, q) => s + BigInt(q.amountAfterFee), 0n);
      // [Audit 3/9 #5] CHỐNG GHI ĐÈ THU NHỎ: bill mới có tổng NHỎ HƠN Lô đang có (nghi SALE thành phần đè SETTLEMENT
      // cùng lô, hoặc OCR đọc lệch nhỏ hơn) → KHÔNG ghi đè (giữ tổng lớn) + cảnh báo/audit. Chỉ EDIT cố ý (allowShrink)
      // mới được giảm. Trước đây UPSERT thay thẳng → mất doanh số câm.
      if (!input.allowShrink && totalAfter < existing.expectedTotalAmount) {
        console.warn(`[lo-service #5] CHẶN thu nhỏ Lô ${existing.id}: mới ${totalAfter} < đang ${existing.expectedTotalAmount} (nghi sale đè settlement / OCR lệch) — GIỮ tổng cũ.`);
        try { await db.auditLog.create({ data: { actorUserId: null, action: 'SIGMA_LO_SHRINK_BLOCKED', targetType: 'Lo', targetId: String(existing.id) } }); } catch { /* best-effort */ }
        return { ok: true, data: await loToResult(db, existing.id) };
      }
      // [B283 24/11 — audit đa-agent] CHỤP cơ cấu dòng thẻ CŨ trước khi thay, để so biết "đổi cấu trúc"
      // (1 thẻ ↔ nhiều thẻ, đổi mức tiền từng thẻ). Thiếu phép so này thì sửa lô 2-thẻ về 1-thẻ CÙNG TỔNG
      // là cả 4 cờ đồng bộ đều câm ⇒ GD giữ biên phí TRỘN vĩnh viễn (đo thật: lệch 70.000đ/bill 50tr;
      // sổ thật lô 3775 NĐT thiếu 2.742đ).
      const dongCu = await db.loRow.findMany({ where: { loId: existing.id }, select: { cardTypeId: true, feeTypeId: true, amountBeforeFee: true } });
      const rowsData = quoted.map((q) => ({
        loId: existing.id,
        tidId: q.tidId,
        cardTypeId: q.cardTypeId,
        feeTypeId: q.feeTypeId,
        amountBeforeFee: BigInt(q.amountBeforeFee),
        feeApplied: BigInt(q.feeApplied),
        amountAfterFee: BigInt(q.amountAfterFee)
      }));
      // THAY TOÀN BỘ dòng (đa thẻ: số dòng có thể đổi khi người sửa tách thẻ) — xoá cũ + ghi mới trong 1 tx. Đường
      // 1-thẻ: xoá 1 + ghi 1 (tương đương update). expectedTotalAmount = Σ amountAfterFee (khớp tổng lô).
      // [B192 19/11 — agent audit tái hiện] KHOÁ THEO LÔ trước khi xoá+ghi lại dòng thẻ. TRƯỚC ĐÂY khối này
      // chạy không khoá: 2 lệnh ghi SONG SONG cùng khoá bill (người dùng bấm 2 máy, hoặc re-send trùng lúc)
      // thì `deleteMany` của lệnh thứ 2 xoá 0 dòng (chưa thấy bản ghi của lệnh 1 do READ COMMITTED) rồi chèn
      // thêm bản của nó ⇒ LÔ CÓ 2 BỘ DÒNG THẺ ⇒ bảng Doanh Số cộng `SUM(amount_before_fee)` ra GẤP ĐÔI
      // (đo thật: bill 61.000.029đ hiện 122.000.058đ) mà không cờ nào kêu. `lo_rows` cũng không có ràng buộc
      // duy nhất nào chặn hộ. `pg_advisory_xact_lock` tự nhả khi giao dịch kết thúc (kể cả khi lỗi).
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock($1::bigint)', existing.id);
        await tx.loRow.deleteMany({ where: { loId: existing.id } });
        await tx.loRow.createMany({ data: rowsData });
        await tx.lo.update({ where: { id: existing.id }, data: { expectedTotalAmount: totalAfter } });
      });
      // KHẲNG ĐỊNH SAU GHI: tổng dòng thẻ phải khớp tổng lô. Lệch = có bàn tay thứ hai chen vào ⇒ nói to,
      // tuyệt đối không để lô tự mâu thuẫn mà im (R198).
      const soLai = await db.loRow.aggregate({ where: { loId: existing.id }, _sum: { amountAfterFee: true }, _count: true });
      if ((soLai._sum.amountAfterFee ?? 0n) !== totalAfter) {
        console.error(`[lo-service B192] LÔ ${existing.id} LỆCH sau khi ghi: Σ dòng ${soLai._sum.amountAfterFee} ≠ tổng lô ${totalAfter} (${soLai._count} dòng)`);
        try {
          await db.auditLog.create({ data: { actorUserId: null, action: 'SIGMA_LO_ROWS_MISMATCH', targetType: 'Lo', targetId: String(existing.id) } });
        } catch { /* best-effort */ }
      }
      await persistLoBillTxnDate(db, existing.id, input.txnDate); // giữ ngày bill thật khi gửi lại (best-effort)
      // [MƯỢN TID] chỉ đụng cột khi caller khai tường minh (undefined = giữ nguyên khi gửi lại/sửa không đổi mượn).
      if (input.borrowedByCustomerId !== undefined) await persistLoBorrowedBy(db, existing.id, input.borrowedByCustomerId);
      // Fix audit #1 (25/8, NGHIÊM TRỌNG): SỬA số tiền bill → Lô cập nhật số MỚI nhưng Transaction đã bridge là
      // CHỨNG TỪ BẤT BIẾN giữ số CŨ (Admin Demo chốt "không tự đổi GD, admin tự xử"). Trước đây LỆCH ÂM THẦM (los vs
      // transactions) → SigMa ôm số sai không hay biết. Nay: nếu Lô có GD đã bridge + số tiền GD ≠ số mới
      // → GẮN CẢNH BÁO vào note GD (admin thấy ở màn doanh thu) + audit, để admin đối soát/hủy-tạo lại. KHÔNG tự
      // đổi số GD (tôn trọng bất biến + quyết định của Admin Demo). Best-effort — lỗi ghi cảnh báo KHÔNG chặn luồng.
      // [B273 24/11 — audit doanh số] Mọi thất bại ở bước ĐỒNG BỘ GIAO DỊCH gom vào đây. Trước đây chỉ
      // `console.error` + audit rồi vẫn trả `ok:true` ⇒ màn hình báo "ghi thành công" trong khi GD cũ đã bị
      // xoá mềm còn GD mới KHÔNG tạo được ⇒ lô mất giao dịch, báo cáo NĐT/doanh thu hụt tiền mà không ai biết.
      const loiDongBo: string[] = [];
      if (existing.transactionId != null) {
        try {
          const txn = await db.transaction.findUnique({ where: { id: existing.transactionId }, select: { id: true, amount: true, status: true, tidId: true, txnDate: true, partnerMarginMilli: true, sellMarginMilli: true, cardTypeId: true, feeTypeId: true, phiCaiMayMilli: true } });
          const newAmount = BigInt(input.amountBeforeFee); // GD TỔNG giữ số gross cả bill (Σ dòng) — so với số cũ đã bridge
          // [Audit 3/9 #2/#4] BẮT CẢ ĐỔI MÁY (TID), không chỉ đổi tiền. Đổi TID → doanh số đại lý (los/lo_rows) chuyển
          // máy MỚI nhưng GD (transactions.tid_id) giữ máy CŨ → NĐT/SigMa đọc transactions thấy SAI máy, lệch
          // CÂM (trước đây chỉ so amount nên đổi-TID-giữ-tiền lọt). GD = chứng từ bất biến (không tự đổi, Admin Demo chốt)
          // → GẮN CẢNH BÁO + audit để admin hủy-tạo lại GD đúng máy. KHÔNG nuốt câm (R198).
          if (txn && txn.status !== 'CANCELLED') {
            const amountDiverged = txn.amount !== newAmount;
            // [B196 19/11 — agent audit] LÔ TÁCH NHIỀU THẺ mà ĐỔI SỐ TIỀN: cột `install_fee_amount` (Σ phí cài
            // máy per-thẻ) do `createTransactionSystemMultiCard` ghi raw, nhánh cập nhật bên dưới KHÔNG đụng tới
            // ⇒ giữ số CŨ ⇒ tiền về NĐT sai (đo thật: lô 2 thẻ sửa 10tr→20tr vẫn để install_fee 99.000 thay vì
            // 198.000 ⇒ NĐT nhận THỪA 99.000đ/bill; sửa giảm thì NĐT bị trả THIẾU).
            // Tính lại cho đúng cần phí cài máy từng thẻ — `quoteRow` không trả ra, nên THÀ TỪ CHỐI còn hơn ghi
            // số sai: chặn tại đây, chỉ rõ cách làm thay thế. Lô 1 thẻ và re-send không đổi tiền chạy như cũ.
            const tidDiverged = txn.tidId != null && txn.tidId !== tid.id;
            // [B283 24/11 — thay khối chặn B196] LÔ dính NHIỀU THẺ (trước hoặc sau sửa) mà đổi cơ cấu/tiền/máy
            // ⇒ KHÔNG vá GD tại chỗ (margin trộn + install_fee per-thẻ không vá tay được), mà HỦY GD cũ và
            // DỰNG LẠI qua đường canonical (bridge → createTransactionSystemMultiCard tính per-thẻ chuẩn,
            // lô về 1 thẻ thì bridge tạo GD 1 thẻ thường). GIỮ NGÀY GD gốc trừ khi người sửa đổi ngày.
            const khoaDong = (r: { cardTypeId: number; feeTypeId: number; amountBeforeFee: bigint | number }): string =>
              r.cardTypeId + ':' + r.feeTypeId + ':' + String(r.amountBeforeFee);
            const cauTrucDoi = dongCu.length !== quoted.length
              || dongCu.map(khoaDong).sort().join('|') !== quoted.map((q) => khoaDong(q as { cardTypeId: number; feeTypeId: number; amountBeforeFee: number })).sort().join('|');
            const ifaCu = await db.$queryRawUnsafe<Array<{ v: string | null }>>(
              'SELECT install_fee_amount::text AS v FROM transactions WHERE id = $1', txn.id);
            const dinhMulti = quoted.length > 1 || dongCu.length > 1 || Number(ifaCu[0]?.v ?? 0) > 0;
            // [B310/F3 24/11 — agent đào vét] ĐỔI TID (dù 1 thẻ) cũng phải DỰNG LẠI GD: vá-tại-chỗ cũ giữ
            // margin + customer_id MÁY CŨ ⇒ doanh thu thừa 8.400đ/bill 12tr + tiền gán NHẦM NHÀ (lớp 25/9).
            let daDungLai = false;
            if ((dinhMulti && (cauTrucDoi || amountDiverged || tidDiverged)) || tidDiverged) {
              daDungLai = true;
              console.error(`[lo-service B283/B310] lô ${existing.id} đổi cơ cấu/tiền/máy — HỦY GD ${txn.id} và dựng lại.`);
              await db.$transaction(async (tx2) => {
                await tx2.transaction.update({
                  where: { id: txn.id },
                  data: { deletedAt: new Date(), status: 'CANCELLED', cancelReason: 'B283: dựng lại GD theo cơ cấu thẻ mới của bill sửa', cancelledAt: new Date() }
                });
                await tx2.lo.update({ where: { id: existing.id }, data: { transactionId: null } });
                await tx2.auditLog.create({ data: { actorUserId: null, action: 'SIGMA_LO_MULTICARD_TXN_REBUILT', targetType: 'Lo', targetId: String(existing.id) } });
              });
              const dongDau = await db.loRow.findFirst({ where: { loId: existing.id }, orderBy: { id: 'asc' } });
              const rowArg = dongDau
                ? { id: dongDau.id, tidId: dongDau.tidId, cardTypeId: dongDau.cardTypeId, feeTypeId: dongDau.feeTypeId,
                    amountBeforeFee: dongDau.amountBeforeFee.toString(), feeApplied: dongDau.feeApplied.toString(), amountAfterFee: dongDau.amountAfterFee.toString() }
                : undefined;
              const b2 = await bridgeBillLoToTransaction(db, existing.id, tid.id, rowArg, input.txnDate ?? txn.txnDate ?? undefined);
              if (!b2.ok) loiDongBo.push(`dựng lại giao dịch theo cơ cấu thẻ mới thất bại (${b2.error} — ${b2.message})`);
            } else if (!dinhMulti && !tidDiverged) {
            // [B190 19/11 — agent audit tái hiện] ĐỔI LOẠI THẺ / LOẠI PHÍ cũng phải đồng bộ. TRƯỚC ĐÂY điều kiện
            // chỉ xét tiền + máy ⇒ sửa bill đổi thẻ thì LÔ ghi thẻ mới còn GIAO DỊCH giữ thẻ cũ VÀ biên phí cũ
            // (đo thật: doanh thu thừa 203.000đ/bill, tiền về NĐT lệch 192.500đ/bill 70tr) — câm hoàn toàn.
            const theMoi = quoted[0]?.cardTypeId;
            const phiMoi = quoted[0]?.feeTypeId;
            const cardDiverged = quoted.length === 1 && theMoi != null && txn.cardTypeId != null && txn.cardTypeId !== theMoi;
            const feeTypeDiverged = quoted.length === 1 && phiMoi != null && txn.feeTypeId != null && txn.feeTypeId !== phiMoi;
            if (amountDiverged || cardDiverged || feeTypeDiverged) { // [B310] tidDiverged đã đi đường dựng lại
              // [Admin Demo 17/9 DUYỆT "gật làm đi" — ĐẢO chính sách 25/8 "GD bất biến, chỉ cảnh báo"]
              // Chính sách cũ chỉ ghi cảnh báo vào note ⇒ sửa bill xong LÔ đổi mà GIAO DỊCH giữ số cũ, trong khi
              // doanh số NĐT/SigMa đọc bảng GIAO DỊCH ⇒ Admin Demo sửa tay cả loạt bill hủy ABB mà doanh số
              // KHÔNG nhúc nhích (rà 17/9: 23 lô lệch, ca lớn nhất 8.000.000đ). NAY ĐỒNG BỘ THẬT:
              //   • amount ← số mới · tid_id ← máy mới
              //   • revenue* TÍNH LẠI bằng computeRevenue với ĐÚNG margin đã chốt trên GD (không tự chế công thức)
              // Vẫn ghi note + audit để giữ DẤU VẾT ai sửa, sửa từ số nào sang số nào.
              const parts: string[] = [];
              if (amountDiverged) parts.push(`đổi tiền ${txn.amount.toString()}đ → ${newAmount.toString()}đ`);
              if (cardDiverged) parts.push(`đổi loại thẻ (${txn.cardTypeId} → ${theMoi})`);
              if (feeTypeDiverged) parts.push(`đổi loại phí (${txn.feeTypeId} → ${phiMoi})`);
              const rev = computeRevenue(Number(newAmount), txn.partnerMarginMilli, txn.sellMarginMilli);
              await db.transaction.update({
                where: { id: txn.id },
                data: {
                  amount: newAmount,
                  revenuePartner: rev.revenuePartner, revenueSell: rev.revenueSell, revenueAmount: rev.revenueAmount,
                  note: `⚠ ĐÃ ĐỒNG BỘ theo bill sửa: ${parts.join(' + ')} (${new Date().toISOString()})`
                }
              });
              // [B190] ĐỔI LOẠI THẺ / LOẠI PHÍ: biên phí của GD phải tính LẠI theo thẻ mới. KHÔNG tự chế công
              // thức ở đây — gọi ĐÚNG đường canonical `correctLoCardType`: huỷ GD cũ, báo giá lại, ghi GD mới,
              // GIỮ NGUYÊN ngày GD gốc. Lô tách nhiều thẻ thì hàm đó từ chối (MULTI_ROW_LO) ⇒ ghi log + audit
              // để admin xử tay, tuyệt đối không nuốt im (R198).
              if ((cardDiverged || feeTypeDiverged) && theMoi != null) {
                const sua = await correctLoCardType(db, { loId: existing.id, cardTypeId: theMoi, actorUserId: null, nhanVienNhapTay: input.nhanVienNhapTay });
                if (!sua.ok) {
                  console.error(`[lo-service B190] KHÔNG đồng bộ được GD theo thẻ mới cho lô ${existing.id}: ${sua.error} — ${sua.message}`);
                  loiDongBo.push(`không đổi được loại thẻ trên giao dịch (${sua.message})`);
                  try {
                    await db.auditLog.create({ data: { actorUserId: null, action: 'SIGMA_BILL_EDIT_CARD_SYNC_FAILED', targetType: 'Lo', targetId: String(existing.id) } });
                  } catch { /* best-effort */ }
                } else if (sua.bridgeError) {
                  console.error(`[lo-service B273] lô ${existing.id} đổi thẻ xong nhưng KHÔNG ghi được GD mới: ${sua.bridgeError}`);
                  loiDongBo.push(`đổi thẻ xong nhưng chưa ghi được giao dịch mới (${sua.bridgeError})`);
                } else {
                  console.error(`[lo-service B190] ĐÃ ghi lại GD theo thẻ mới cho lô ${existing.id}: GD ${sua.oldTransactionId} → ${sua.newTransactionId}`);
                }
              }
              await db.auditLog.create({ data: { actorUserId: null, action: 'SIGMA_BILL_EDIT_TXN_SYNCED', targetType: 'Transaction', targetId: String(txn.id) } });
              console.error(`[lo-service] ĐỒNG BỘ GD #${txn.id} theo bill sửa: ${parts.join(' + ')} → doanh thu tính lại ${rev.revenueAmount}`);
            }
            } // [B283] đóng nhánh 1-thẻ
            // [B311/F2 24/11 — agent đào vét, CHẶN SHIP] ĐỔI NGÀY phải đồng bộ cho MỌI trường hợp — kể cả
            // "chỉ đổi ngày, không đổi gì khác" (trước đây khối B191 nằm TRONG if-diverge nên đổi-ngày-thuần
            // không bao giờ chạy ⇒ GD kẹt kỳ cũ: cutoff NĐT, recalc, phí cuối tuần đều đọc nhầm kỳ) và cả
            // lô NHIỀU THẺ. Vừa dựng lại GD (daDungLai) thì bridge đã mang ngày mới — khỏi dời nữa.
            if (!daDungLai) {
            // [B191 19/11 — agent audit] ĐỔI NGÀY bill: trước đây chỉ ghi `los.bill_txn_date`, còn
            // `transactions.txn_date` GIỮ NGUYÊN ⇒ báo cáo đại lý (đọc bill_txn_date) sang kỳ mới mà báo cáo
            // NĐT/doanh thu (đọc txn_date) ở lại kỳ cũ — lệch kỳ câm. Dời bằng đường canonical.
            if (input.txnDate) {
              const txCu = await db.transaction.findUnique({ where: { id: txn.id }, select: { txnDate: true } });
              const cu = txCu?.txnDate ? new Date(txCu.txnDate).getTime() : null;
              if (cu != null && Math.abs(cu - input.txnDate.getTime()) > 60_000) {
                const rd = await redateLoTransaction(db, { loId: existing.id, txnDate: input.txnDate, actorUserId: null });
                if (!rd.ok) {
                  console.error(`[lo-service B191] KHÔNG dời được ngày GD của lô ${existing.id}: ${rd.error} — ${rd.message}`);
                  loiDongBo.push(`không dời được ngày giao dịch (${rd.message})`);
                  try {
                    await db.auditLog.create({ data: { actorUserId: null, action: 'SIGMA_BILL_EDIT_REDATE_FAILED', targetType: 'Lo', targetId: String(existing.id) } });
                  } catch { /* best-effort */ }
                } else if (rd.bridgeError) {
                  // [B273] `ok:true` nhưng GD MỚI chưa ghi được — lỗi nằm ở `bridgeError`, trước đây không ai đọc.
                  console.error(`[lo-service B273] lô ${existing.id} dời ngày xong nhưng KHÔNG ghi được GD mới: ${rd.bridgeError}`);
                  loiDongBo.push(`dời ngày xong nhưng chưa ghi được giao dịch mới (${rd.bridgeError})`);
                }
              }
            }
            }
          }
        } catch (err) {
          console.error(`[lo-service] gắn cảnh báo GD lệch cho Lô ${existing.id} lỗi:`, err);
          // [B273] CẤM nuốt im (R198): khối này có thể đã xoá GD cũ rồi mới ném, bỏ qua là lô mất giao dịch.
          loiDongBo.push('lỗi khi đồng bộ giao dịch: ' + String(err).slice(0, 180));
        }
      }
      // [B273] FAIL-CLOSED: lô đã cập nhật nhưng GIAO DỊCH chưa khớp ⇒ nói thẳng, KHÔNG trả "thành công".
      if (loiDongBo.length > 0) {
        return {
          ok: false, error: 'DONG_BO_GD_LOI',
          message: `Bill #${existing.id} đã cập nhật nhưng GIAO DỊCH kèm theo chưa đồng bộ được: `
            + loiDongBo.join(' · ')
            + '. Doanh số của bill có thể chưa vào báo cáo. CÁCH SỬA: báo kỹ thuật kèm mã lô này; '
            + 'trong lúc chờ, đừng ghi lại bill lần nữa (tránh đếm hai lần).'
        };
      }
      return { ok: true, data: await loToResult(db, existing.id) };
    }
  }

  // TẦNG 3 — không khớp khóa bill nào (billKey null HOẶC có key nhưng chưa từng ghi). Trước khi tạo MỚI, dò "nghi
  // trùng": Lô SỐNG cùng đại lý+TID+SỐ TIỀN, tạo TRONG CÙNG NGÀY (local). Trùng chính xác tới đồng + cùng ngày =
  // rất nhiều khả năng cùng 1 giao dịch (bill chụp lại/ảnh khác nên khóa tầng 2 hụt). KHÔNG tự ghi lần 2 — trả
  // DUP_SUSPECT để đại lý xác nhận; đúng giao dịch KHÁC thì gọi lại allowDuplicate=true. Bỏ qua khi đã allowDuplicate.
  if (!input.allowDuplicate) {
    const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // cửa sổ hẹp 48h để không quét cả bảng loRow
    const candidateRows = await db.loRow.findMany({
      where: { tidId: tid.id, amountBeforeFee: BigInt(input.amountBeforeFee), createdAt: { gte: since } },
      orderBy: { id: 'desc' },
      take: 20,
      select: { loId: true }
    });
    const loIds = [...new Set(candidateRows.map((r) => r.loId))];
    if (loIds.length) {
      const los = await db.lo.findMany({ where: { id: { in: loIds }, agentId, status: { not: 'CANCELLED' } }, orderBy: { id: 'desc' } });
      // Fix audit #3 (25/8): dùng CỬA SỔ LĂN 24h thay vì "cùng NGÀY local" — bill gửi lại qua NỬA ĐÊM (vd 23:59
      // và 00:01) là 2 ngày local khác nhau nên isSameLocalDay BỎ SÓT → tạo Lô trùng. 24h cuốn theo thời điểm.
      const cutoff24hMs = Date.now() - 24 * 60 * 60 * 1000;
      // [Admin Demo 6/9 — BUG THẬT lô 116 SÓT doanh số] TRÙNG TIỀN + TID + ngày NHƯNG KHÁC SỐ LÔ = giao dịch KHÁC (lô cycle
      // tuần tự, 2 lô khác nhau CÓ THỂ cùng số tiền — vd THÀNH NAM 2 lô 111 & 116 đều 5.504.000). Trước đây tầng-3 chỉ
      // xét tiền+TID+ngày → chặn NHẦM lô 116 = "nghi trùng" → SÓT doanh số. NAY: nếu ĐỌC ĐƯỢC số lô CẢ HAI và KHÁC nhau
      // → KHÔNG nghi trùng (vẫn ghi). Chỉ nghi trùng khi cùng số lô, HOẶC 1 trong 2 không đọc được lô (mù → giữ an toàn
      // theo tiền+ngày). billKey = `nat|tid|LÔ|hđ` — số lô ở đoạn 3.
      const loNumOf = (bk: string | null | undefined): string | null => { const p = String(bk ?? '').split('|'); return p.length >= 3 && /^\d+$/.test(p[2]) ? p[2] : null; };
      const newLoNum = loNumOf(billKey);
      const suspect = los.find((l) => {
        if (l.createdAt.getTime() < cutoff24hMs) return false;
        const sLoNum = loNumOf(l.billKey);
        if (newLoNum && sLoNum && newLoNum !== sLoNum) return false; // đọc được lô cả 2 + KHÁC → giao dịch khác → không chặn
        return true;
      });
      if (suspect) {
        return {
          ok: false,
          error: 'DUP_SUSPECT',
          existingLoId: suspect.id,
          existingAt: suspect.createdAt,
          message: 'Bill này giống doanh số đã ghi trong 24h qua (cùng máy + cùng số tiền). Nếu là giao dịch khác, xác nhận để ghi thêm.'
        };
      }
    }
  }

  // Tạo mới (TÁI DÙNG createLo → quoteRow từng dòng: scope khách + giá bán thực tế + loại phí mặc định; ABORT cả
  // phiếu nếu 1 dòng thiếu giá bán = NO_ACTUAL_SELL_FEE). N dòng thẻ → N LoRow trong 1 Lô (đại lý tách thẻ).
  // [Admin Demo 25/9] Lô TẠO MỚI cũng phải báo giá theo ĐẠI LÝ MƯỢN (nếu khai) — nếu không, lô mới của nhà mượn
  // vẫn ăn giá chung của máy rồi mới gán mượn sau, thành ra ghi sai giá ngay từ đầu.
  // [B201] Cờ "nhân viên nhập tay" phải đi CẢ nhánh TẠO MỚI này, không chỉ nhánh sửa bill — đo 19/11: quên
  // chỗ này thì bill MỚI vẫn bị chặn y như cũ trong khi bill SỬA lại qua được (nửa vời, khó lần ra).
  const created = await createLo(db, agentId, lines.map((l) => ({ tidId: tid.id, cardTypeId: l.cardTypeId, feeTypeId: input.feeTypeId, amountBeforeFee: l.amountBeforeFee, dealerCustomerId: input.borrowedByCustomerId ?? undefined, nhanVienNhapTay: input.nhanVienNhapTay })), input.txnDate);
  if (!created.ok) return created;

  // Fix audit #2 (25/8): CHỐNG ĐẾM ĐÔI khi 2 request /from-bill CÙNG billKey chạy song song. billKey được set qua
  // UPDATE (sau createLo) — có UNIQUE 1-phần (agent_id, bill_key) WHERE NOT NULL ở DB. Request THUA race sẽ dính
  // lỗi unique ở đây → HỦY Lô thừa vừa tạo (KHÔNG bridge → không tạo GD trùng) + trả Lô THẮNG. Chỉ áp khi có billKey.
  if (billKey) {
    try {
      await db.lo.update({ where: { id: created.data.id }, data: { billKey } });
      // [16/9] ghi MÃ ĐÓNG LÔ lên lô (chỉ khi bill có mã) — raw vì cột thêm bằng schema-ensure, chưa có trong Prisma model.
      if (input.settlementCode) {
        await db.$executeRawUnsafe(`UPDATE los SET settlement_code = $2 WHERE id = $1`, created.data.id, String(input.settlementCode));
      }
    } catch (err) {
      if (isUniqueViolation(err)) {
        await db.lo.update({
          where: { id: created.data.id },
          data: { status: 'CANCELLED', cancelReason: 'Trùng billKey (race) — đã có Lô khác ghi cùng bill', cancelledAt: new Date() }
        });
        const winner = await db.lo.findFirst({ where: { agentId, billKey, status: { not: 'CANCELLED' } }, orderBy: { id: 'desc' } });
        // Trả Lô thắng (Lô thua đã hủy + KHÔNG bridge GD). Edge hiếm không thấy winner → trả Lô vừa tạo (đã hủy).
        return { ok: true, data: await loToResult(db, winner?.id ?? created.data.id) };
      }
      throw err;
    }
  }

  // LƯU NGÀY BILL THẬT lên lô (Admin Demo 31/8 "lưu ngày bill lên lô") — để reconcile/redate luôn dùng ĐÚNG ngày
  // bill kể cả khi bridge gốc fail (chống "lộn xộn hôm qua/hôm nay"). Best-effort trước khi bridge.
  await persistLoBillTxnDate(db, created.data.id, input.txnDate);
  // [MƯỢN TID] gán đại lý mượn lên lô mới (nếu khai). Doanh số lô này về đại-lý-mượn (getRoomRevenueReport dùng cột).
  if (input.borrowedByCustomerId !== undefined) await persistLoBorrowedBy(db, created.data.id, input.borrowedByCustomerId);
  // BRIDGE bill→doanh số SigMa (Admin Demo 24/8): Lô ghi từ bill TỰ tạo 1 Transaction (chứng từ admin) để
  // báo cáo SigMa (đọc bảng transactions) thấy doanh số. CHỈ ở nhánh TẠO MỚI THẮNG race (gửi-lại = UPSERT
  // nhánh trên KHÔNG tạo GD → link 1-1 chống trùng). BEST-EFFORT: thiếu FeeRate/lỗi → log rõ (R198) + KHÔNG chặn bill.
  const bridgeMoi = await bridgeBillLoToTransaction(db, created.data.id, tid.id, created.data.rows[0], input.txnDate);
  if (!bridgeMoi.ok) {
    // [B284/S2 24/11 — audit R198, SỬA LẦN 2 theo me.test] Bridge hỏng thì KHÔNG nuốt im, nhưng cũng
    // KHÔNG được chặn cả lô: đường ĐẠI LÝ (Zalo/me) cố ý best-effort — bill thiếu biểu phí vẫn vào sổ,
    // reconcileUnbridgedLos hàn GD sau (hợp đồng đã có test khoá; chặn hẳn là doanh số đại lý RƠI).
    // Trả `ok:true` + `bridgeError` để TỪNG CALLER tự quyết: màn nhập tay (quanly-api) fail-loud,
    // đường đại lý giữ 200 — hết cảnh "vứt kết quả" như sự cố Huy Daklak 31/8.
    console.error(`[lo-service B284] lô ${created.data.id} ghi xong nhưng KHÔNG tạo được giao dịch: ${bridgeMoi.error} — ${bridgeMoi.message}`);
    return { ...created, bridgeError: `${bridgeMoi.error} — ${bridgeMoi.message}` };
  }
  return created;
}

/** Prisma unique-constraint violation (P2002) — dùng bắt race billKey (audit #2). Không phụ thuộc class cụ thể
 *  (tránh import Prisma.PrismaClientKnownRequestError): chỉ đọc `.code`. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}

/** Tạo GD (Transaction) TỰ ĐỘNG từ 1 Lô vừa ghi từ bill + link los.transactionId (idempotent chống trùng). CÙNG
 * công thức phí/doanh thu (createTransactionSystem @sigma/services — KHÔNG tự tính). actorUserId=null (GD hệ thống).
 * txnDate = now (mốc ghi doanh số; bill datetime OCR không đủ tin để làm mốc tài chính). BEST-EFFORT: mọi lỗi
 * (thiếu FeeRate/giá bán/khách khóa/exception) → log rõ, KHÔNG chặn/không ném ra luồng bill. Nếu Lô đã có
 * transactionId (đã bridge) → bỏ qua (không tạo GD thứ 2). */
async function bridgeBillLoToTransaction(
  db: Db,
  loId: number,
  tidId: number,
  row: CreateLoResult['rows'][number] | undefined,
  billTxnDate?: Date
): Promise<{ ok: boolean; error?: string; message?: string }> {
  try {
    if (!row) return { ok: false, error: 'NO_ROW', message: 'Lô không có dòng (lo_row) để tạo GD.' };
    const existing = await db.lo.findUnique({ where: { id: loId }, select: { transactionId: true } });
    if (existing?.transactionId != null) return { ok: true }; // đã có GD (idempotent)
    // [Admin Demo 25/9 "doanh số TID đi mượn không chuyển về đúng phòng chat"] MƯỢN TID: TIN BILL đã về đúng phòng
    // đại lý mượn, nhưng GIAO DỊCH thì KHÔNG — 2 lời gọi dưới KHÔNG truyền customerId nên rơi về mặc định
    // "lấy theo TID" = CHỦ MÁY. Mọi màn đọc bảng transactions (Doanh số, SigMa, báo cáo) vì thế ghi tiền
    // cho CHỦ TID thay vì NHÀ MƯỢN — sai người, câm. Ca thật hôm nay: lô 2981 TID DEMO-TID-01 (chủ Đại lý A) do
    // Oanh SG quẹt nhờ → GD vẫn ghi Đại lý A. Nay truyền ĐÚNG nhà mượn; không mượn thì giữ nguyên mặc định.
    // borrowed_by_customer_id thêm bằng SQL thô (không có trong schema Prisma) ⇒ đọc bằng raw.
    const mua = await db.$queryRawUnsafe<{ borrowed_by_customer_id: number | null }[]>(
      `SELECT borrowed_by_customer_id FROM los WHERE id = $1`, loId);
    const khachGd = mua[0]?.borrowed_by_customer_id ?? undefined;
    if (khachGd != null) console.error(`[lo-service] lô ${loId} MƯỢN TID → GD ghi cho khách ${khachGd} (nhà mượn), không phải chủ máy.`);
    // PHƯƠNG ÁN C — 1 GD TỔNG cho cả Lô: amount = Σ amountBeforeFee MỌI LoRow (đại lý tách thẻ nhiều dòng, NĐT/
    // SigMa nhận 1 GD tổng). Đường 1-thẻ: Σ = số dòng duy nhất (y hệt cũ). cardType/feeType = dòng ĐẠI DIỆN
    // (row truyền vào = dòng đầu/primary khi tạo, hoặc dòng vừa sửa ở correctLoCardType) → phí cài máy theo TID
    // (resolveFeeForTxn của thẻ đại diện). Fallback row.amountBeforeFee nếu (hiếm) không đọc được dòng nào.
    const allRows = await db.loRow.findMany({ where: { loId }, select: { cardTypeId: true, amountBeforeFee: true } });
    const grossSum = allRows.reduce((s, r) => s + r.amountBeforeFee, 0n);
    const amount = grossSum > 0n ? Number(grossSum) : Number(row.amountBeforeFee);
    const txnDate = billTxnDate ?? new Date(); // Admin Demo 27/8: GIỜ THẬT trên bill nếu có — bỏ giờ-lúc-xử-lý
    // MULTI-CARD (Admin Demo 1/9 "đúng từng đồng"): ≥2 loại thẻ → phí BÌNH QUÂN GIA QUYỀN + doanh thu Σ per-thẻ ĐÚNG
    // (không dùng phí thẻ đại diện cho cả tổng — gốc lệch tới ~5k). 1 thẻ → đường createTransactionSystem cũ.
    const multi = allRows.filter((rr) => rr.cardTypeId && Number(rr.amountBeforeFee) > 0);
    const r = multi.length > 1
      ? await createTransactionSystemMultiCard(db, { tidId, feeTypeId: row.feeTypeId, txnDate, actorUserId: null, customerId: khachGd, lines: multi.map((rr) => ({ cardTypeId: rr.cardTypeId as number, amountBeforeFee: Number(rr.amountBeforeFee) })) })
      : await createTransactionSystem(db, { tidId, cardTypeId: row.cardTypeId, feeTypeId: row.feeTypeId, amount, txnDate, actorUserId: null, customerId: khachGd });
    if (r.ok) {
      await db.lo.update({ where: { id: loId }, data: { transactionId: r.id } });
      return { ok: true };
    }
    // R198 — KHÔNG nuốt câm: bill VẪN ghi doanh số (Lô), chỉ chưa lên SigMa; admin thấy log để cấu hình.
    console.error(`[lo→transaction] Lô ${loId} chưa tạo được GD SigMa (best-effort): ${r.error} — ${r.message}`);
    return { ok: false, error: r.error, message: r.message };
  } catch (err) {
    console.error(`[lo→transaction] Lô ${loId} bridge GD lỗi ngoài dự kiến (best-effort, KHÔNG chặn bill):`, err);
    return { ok: false, error: 'EXCEPTION', message: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * SELF-HEAL (Admin Demo 31/8 "điều tra fix sâu, cấm tái diễn TUYỆT ĐỐI"; R198 — check PHẢI chạy + SURFACE, cấm nuốt
 * câm): bridge lô→GD là best-effort (không chặn bill), nên khi thiếu/lệch cấu hình (giá bán thực tế chưa floor về
 * nửa đêm, thiếu FeeRate…) lô GHI vào `los` mà KHÔNG có Transaction → đại lý (đọc los) thấy nhưng NĐT + Quản Lý
 * SigMa (đọc transactions) SÓT → doanh số LỆCH ÂM THẦM (đúng bug Huy Daklak/NĐT Trung 31/8). Hàm dò MỌI lô SỐNG
 * chưa bridge, THỬ bridge lại bằng công thức CHUẨN (createTransactionSystem — KHÔNG raw-SQL tính tiền), trả về số
 * đã hàn + danh sách CÒN fail kèm LÝ DO để bot log rõ + admin xử. Idempotent, an toàn chạy lặp. */
export interface ReconcileUnbridgedResult {
  scanned: number;
  bridged: number;
  stillFailed: { loId: number; agentId: number; amount: string; reason: string }[];
}
export async function reconcileUnbridgedLos(db: Db, opts?: { limit?: number }): Promise<ReconcileUnbridgedResult> {
  const limit = opts?.limit ?? 1000;
  const orphans = await db.lo.findMany({
    where: { status: { not: 'CANCELLED' }, transactionId: null },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true, agentId: true, createdAt: true }
  });
  let bridged = 0;
  const stillFailed: ReconcileUnbridgedResult['stillFailed'] = [];
  for (const lo of orphans) {
    const row = await db.loRow.findFirst({ where: { loId: lo.id }, orderBy: { id: 'asc' } });
    if (!row) {
      stillFailed.push({ loId: lo.id, agentId: lo.agentId, amount: '0', reason: 'NO_ROW — lô không có dòng' });
      continue;
    }
    const rowArg: CreateLoResult['rows'][number] = {
      id: row.id, tidId: row.tidId, cardTypeId: row.cardTypeId, feeTypeId: row.feeTypeId,
      amountBeforeFee: row.amountBeforeFee.toString(), feeApplied: row.feeApplied.toString(), amountAfterFee: row.amountAfterFee.toString()
    };
    // txnDate = NGÀY BILL THẬT đã lưu (bill_txn_date) → doanh số rơi ĐÚNG NGÀY bill kể cả khi bridge gốc fail rồi
    // hàn sau (Admin Demo 31/8 "lưu ngày bill lên lô"). Chưa lưu (lô cũ) → fallback created_at (giờ ghi). Idempotent.
    const billDate = await readLoBillTxnDate(db, lo.id);
    const res = await bridgeBillLoToTransaction(db, lo.id, row.tidId, rowArg, billDate ?? lo.createdAt);
    if (res.ok) bridged++;
    else stillFailed.push({ loId: lo.id, agentId: lo.agentId, amount: row.amountBeforeFee.toString(), reason: `${res.error} — ${res.message}` });
  }
  return { scanned: orphans.length, bridged, stillFailed };
}

/**
 * SỬA THẺ đã ghi (Admin Demo 31/8 "chưa có nút sửa biểu phí chọn lại thẻ khi chọn nhầm và gửi vào nhóm rồi → doanh
 * số sai không sửa được"): đổi LOẠI THẺ của 1 Lô ĐÃ GHI (kể cả đã lên GD) → tính LẠI phí bán/cài bằng quoteRow
 * CANONICAL (giá bán thực tế + đúng ngân hàng) + HỦY GD cũ (soft-delete + audit — GD BẤT BIẾN nên KHÔNG sửa tại
 * chỗ) rồi GHI LẠI GD mới đúng thẻ, GIỮ NGUYÊN ngày GD gốc (không lệch kỳ doanh số). Đồng bộ CẢ đại lý (los/
 * lo_rows) LẪN NĐT + SigMa (transactions). KHÔNG raw-SQL tính tiền (cấm suy luận money). */
export type CorrectLoCardResult =
  | { ok: true; loId: number; oldTransactionId: number | null; newTransactionId: number | null; cardTypeId: number; feeApplied: number; amountAfterFee: number; phiBanMilli: number; bridgeError?: string }
  | { ok: false; error: string; message: string };

export async function correctLoCardType(
  db: Db,
  input: { loId: number; cardTypeId: number; actorUserId?: number | null; nhanVienNhapTay?: boolean }
): Promise<CorrectLoCardResult> {
  if (!Number.isInteger(input.loId) || !Number.isInteger(input.cardTypeId))
    return { ok: false, error: 'VALIDATION', message: 'loId và cardTypeId phải là số nguyên.' };
  // KHÔNG lọc theo agentId người GỌI: lô OCR-send ghi dưới agent "Support SigMa" (không phải người xem); route
  // đã authorize theo phạm vi TID của phòng. Dùng agentId CỦA CHÍNH LÔ cho quoteRow (đúng scope khách đã ghi).
  const lo = await db.lo.findFirst({ where: { id: input.loId }, select: { id: true, agentId: true, status: true, transactionId: true } });
  if (!lo) return { ok: false, error: 'NOT_FOUND', message: `Không tìm thấy Lô id=${input.loId}.` };
  if (lo.status === 'CANCELLED') return { ok: false, error: 'VALIDATION', message: 'Lô đã hủy — không sửa thẻ được.' };
  const row = await db.loRow.findFirst({ where: { loId: lo.id }, orderBy: { id: 'asc' } });
  if (!row) return { ok: false, error: 'VALIDATION', message: 'Lô không có dòng (lo_row) để sửa.' };
  // PHƯƠNG ÁN C — CHẶN AN TOÀN Lô nhiều loại thẻ (đa dòng): correctLoCardType chỉ sửa 1 dòng + đặt
  // expectedTotalAmount = số của DÒNG ĐÓ → sẽ LÀM SAI tổng lô đa dòng. Chưa hỗ trợ sửa từng dòng cho lô tách thẻ →
  // trả lỗi rõ (KHÔNG crash, KHÔNG đổi sai tiền). Lô 1-thẻ chạy như cũ. (Báo LEAD nếu cần picker sửa-theo-dòng.)
  const rowCount = await db.loRow.count({ where: { loId: lo.id } });
  if (rowCount > 1)
    return { ok: false, error: 'MULTI_ROW_LO', message: 'Lô này có nhiều loại thẻ (tách thẻ) — chức năng sửa thẻ theo từng dòng chưa hỗ trợ, vui lòng liên hệ admin.' };
  // Trùng thẻ = ÁP LẠI giá hiện tại (dùng khi giá bán thẻ đổi mà lô đã ghi vẫn giữ snapshot cũ — Admin Demo 31/8
  // "sửa lại giá bán thẻ MB 1.1"). quoteRow tính lại phí theo giá MỚI → cập nhật lô + GD. KHÔNG chặn.
  // Tính LẠI theo thẻ mới (quoteRow kiểm bank-match + giá bán thực tế + scope khách). Lỗi → trả nguyên (vd
  // CARD_BANK_MISMATCH / NO_ACTUAL_SELL_FEE) để client hiện rõ, KHÔNG đụng dữ liệu.
  // Giữ NGÀY GD gốc để không lệch kỳ (bridge dùng lại). Lấy TRƯỚC khi báo giá — chính ngày này là mốc
  // tra biểu phí. [B272 24/11 — audit doanh số]
  const oldTxnId = lo.transactionId ?? null;
  let origTxnDate: Date | undefined;
  if (oldTxnId != null) {
    const oldTxn = await db.transaction.findUnique({ where: { id: oldTxnId }, select: { txnDate: true, deletedAt: true } });
    if (oldTxn && oldTxn.deletedAt == null) origTxnDate = oldTxn.txnDate ?? undefined;
  }
  // [B272 24/11 — audit doanh số] Lời gọi này TRƯỚC ĐÂY thiếu tham số thứ 4 `at` ⇒ mặc định `new Date()`
  // ⇒ sửa thẻ của bill CŨ là áp BIỂU PHÍ HÔM NAY. Tái hiện: bill 25/8 10tr, sửa thẻ ⇒ phí 110.000đ (giá hôm
  // nay 1,10%) thay vì 105.000đ (giá ngày bill 1,05%) ⇒ tiền về đại lý thiếu 0,05% doanh số. Nhánh UPSERT
  // (ghi/sửa bill thường) vốn đã truyền `input.txnDate` — hai đường sửa cùng một lô mà ra hai con số.
  // Muốn áp giá mới cho lô cũ thì SỬA BIỂU PHÍ có ngày hiệu lực ≤ ngày bill, không phải lấy giá hôm nay.
  // Kèm theo: giữ LOẠI PHÍ của chính dòng (thiếu ⇒ tụt về loại phí mặc định) và ĐẠI LÝ ĐANG CẦM máy
  // (lô mượn TID có giá riêng của nhà mượn).
  const muonCuSuaThe = await db.$queryRawUnsafe<Array<{ borrowed_by_customer_id: number | null }>>(
    `SELECT borrowed_by_customer_id FROM los WHERE id = $1`, lo.id);
  const q = await quoteRow(
    db, lo.agentId,
    {
      tidId: row.tidId, cardTypeId: input.cardTypeId, feeTypeId: row.feeTypeId ?? undefined,
      amountBeforeFee: Number(row.amountBeforeFee),
      dealerCustomerId: muonCuSuaThe[0]?.borrowed_by_customer_id ?? undefined,
      nhanVienNhapTay: input.nhanVienNhapTay
    },
    origTxnDate
  );
  if (!q.ok) return q;
  // ATOMIC: cập nhật lo_row + lô + hủy GD cũ + audit. Đặt transactionId=null để bridge tạo GD mới sau đó.
  await db.$transaction(async (tx) => {
    await tx.loRow.update({
      where: { id: row.id },
      data: { cardTypeId: q.data.cardTypeId, feeTypeId: q.data.feeTypeId, feeApplied: BigInt(q.data.feeApplied), amountAfterFee: BigInt(q.data.amountAfterFee) }
    });
    await tx.lo.update({ where: { id: lo.id }, data: { expectedTotalAmount: BigInt(q.data.amountAfterFee), transactionId: null } });
    if (oldTxnId != null) {
      // [B285/F5 24/11] Hủy GD phải set CẢ status='CANCELLED' — trước đây chỉ xoá mềm, sổ thật tồn 27 GD
      // "POSTED mà deleted" (1,35 tỷ): báo cáo nào lọc theo status là cộng nhầm ngay.
      await tx.transaction.update({ where: { id: oldTxnId }, data: { deletedAt: new Date(), deletedBy: input.actorUserId ?? null, status: 'CANCELLED', cancelReason: 'Sửa thẻ bill — GD ghi lại theo thẻ mới', cancelledAt: new Date() } });
      await tx.auditLog.create({ data: { actorUserId: input.actorUserId ?? null, action: 'SIGMA_LO_CARD_CORRECTED_CANCEL_TXN', targetType: 'Transaction', targetId: String(oldTxnId) } });
    }
    await tx.auditLog.create({ data: { actorUserId: input.actorUserId ?? null, action: 'SIGMA_LO_CARD_CORRECTED', targetType: 'Lo', targetId: String(lo.id) } });
  });
  // GHI LẠI GD mới đúng thẻ (canonical) — GIỮ ngày GD gốc. Best-effort như bridge thường; fail → reconcile hàn sau.
  const newRow: CreateLoResult['rows'][number] = {
    id: row.id, tidId: row.tidId, cardTypeId: q.data.cardTypeId, feeTypeId: q.data.feeTypeId,
    amountBeforeFee: String(q.data.amountBeforeFee), feeApplied: String(q.data.feeApplied), amountAfterFee: String(q.data.amountAfterFee)
  };
  const bridge = await bridgeBillLoToTransaction(db, lo.id, row.tidId, newRow, origTxnDate);
  const after = await db.lo.findUnique({ where: { id: lo.id }, select: { transactionId: true } });
  return {
    ok: true, loId: lo.id, oldTransactionId: oldTxnId, newTransactionId: after?.transactionId ?? null,
    cardTypeId: q.data.cardTypeId, feeApplied: q.data.feeApplied, amountAfterFee: q.data.amountAfterFee, phiBanMilli: q.data.phiBanMilli,
    bridgeError: bridge.ok ? undefined : `${bridge.error} — ${bridge.message}`
  };
}

/** SỬA NGÀY giao dịch của 1 Lô đã ghi (admin) — khi ngày GD lệch ngày bill THẬT (vd bridge fallback dùng giờ GHI
 *  thay vì giờ quẹt OCR trên bill → doanh số rơi nhầm ngày). Đổi về ngày đúng = hủy GD cũ (soft-delete + audit, GD
 *  bất biến nên không sửa tại chỗ) + ghi lại GD ĐÚNG NGÀY bằng công thức CHUẨN (createTransactionSystem, giữ nguyên
 *  thẻ/phí của lô). Yêu cầu giá bán thực tế HIỆU LỰC tại ngày mới (nếu chưa có kỳ đó, set giá bán cho đúng kỳ trước
 *  khi gọi). KHÔNG raw-SQL tính tiền. Đồng bộ đại lý + NĐT + SigMa. */
export async function redateLoTransaction(
  db: Db, input: { loId: number; txnDate: Date; actorUserId?: number | null }
): Promise<{ ok: true; loId: number; oldTransactionId: number | null; newTransactionId: number | null; bridgeError?: string } | { ok: false; error: string; message: string }> {
  if (!Number.isInteger(input.loId) || !(input.txnDate instanceof Date) || isNaN(input.txnDate.getTime()))
    return { ok: false, error: 'VALIDATION', message: 'loId/txnDate không hợp lệ.' };
  const lo = await db.lo.findFirst({ where: { id: input.loId }, select: { id: true, status: true, transactionId: true } });
  if (!lo) return { ok: false, error: 'NOT_FOUND', message: `Không tìm thấy Lô id=${input.loId}.` };
  if (lo.status === 'CANCELLED') return { ok: false, error: 'VALIDATION', message: 'Lô đã hủy — không sửa ngày được.' };
  const row = await db.loRow.findFirst({ where: { loId: lo.id }, orderBy: { id: 'asc' } });
  if (!row) return { ok: false, error: 'VALIDATION', message: 'Lô không có dòng (lo_row).' };
  const oldTxnId = lo.transactionId ?? null;
  if (oldTxnId != null) {
    await db.$transaction(async (tx) => {
      await tx.transaction.update({ where: { id: oldTxnId }, data: { deletedAt: new Date(), deletedBy: input.actorUserId ?? null, status: 'CANCELLED', cancelReason: 'Dời ngày bill — GD ghi lại đúng ngày', cancelledAt: new Date() } }); // [B285/F5]
      await tx.lo.update({ where: { id: lo.id }, data: { transactionId: null } });
      await tx.auditLog.create({ data: { actorUserId: input.actorUserId ?? null, action: 'SIGMA_LO_REDATED_CANCEL_TXN', targetType: 'Transaction', targetId: String(oldTxnId) } });
    });
  }
  const rowArg: CreateLoResult['rows'][number] = {
    id: row.id, tidId: row.tidId, cardTypeId: row.cardTypeId, feeTypeId: row.feeTypeId,
    amountBeforeFee: row.amountBeforeFee.toString(), feeApplied: row.feeApplied.toString(), amountAfterFee: row.amountAfterFee.toString()
  };
  const bridge = await bridgeBillLoToTransaction(db, lo.id, row.tidId, rowArg, input.txnDate);
  const after = await db.lo.findUnique({ where: { id: lo.id }, select: { transactionId: true } });
  return { ok: true, loId: lo.id, oldTransactionId: oldTxnId, newTransactionId: after?.transactionId ?? null, bridgeError: bridge.ok ? undefined : `${bridge.error} — ${bridge.message}` };
}

/** Liệt kê các LOẠI THẺ hợp lệ (đúng ngân hàng của TID) cho picker "Sửa thẻ" của 1 Lô, kèm phí bán % thực tế
 *  (quoteRow) để user thấy rõ mỗi thẻ ra phí nào. Thẻ chưa cấu hình giá bán thực tế → available=false + lý do. */
export interface LoCardOption { cardTypeId: number; name: string; isCurrent: boolean; available: boolean; phiBanMilli?: number; feeApplied?: number; amountAfterFee?: number; reason?: string; }
export async function listCardOptionsForLo(
  db: Db, loId: number
): Promise<{ ok: true; loId: number; tidId: number; currentCardTypeId: number; amountBeforeFee: string; options: LoCardOption[] } | { ok: false; error: string; message: string }> {
  const lo = await db.lo.findFirst({ where: { id: loId }, select: { id: true, agentId: true } });
  if (!lo) return { ok: false, error: 'NOT_FOUND', message: `Không tìm thấy Lô id=${loId}.` };
  const row = await db.loRow.findFirst({ where: { loId }, orderBy: { id: 'asc' } });
  if (!row) return { ok: false, error: 'VALIDATION', message: 'Lô không có dòng (lo_row).' };
  const tid = await db.tid.findUnique({ where: { id: row.tidId }, select: { bankId: true } });
  const cards = await db.cardType.findMany({ where: { bankId: tid?.bankId ?? undefined, deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true, name: true } });
  const options: LoCardOption[] = [];
  for (const c of cards) {
    const q = await quoteRow(db, lo.agentId, { tidId: row.tidId, cardTypeId: c.id, amountBeforeFee: Number(row.amountBeforeFee) });
    if (q.ok) options.push({ cardTypeId: c.id, name: c.name, isCurrent: c.id === row.cardTypeId, available: true, phiBanMilli: q.data.phiBanMilli, feeApplied: q.data.feeApplied, amountAfterFee: q.data.amountAfterFee });
    else options.push({ cardTypeId: c.id, name: c.name, isCurrent: c.id === row.cardTypeId, available: false, reason: q.message });
  }
  return { ok: true, loId: lo.id, tidId: row.tidId, currentCardTypeId: row.cardTypeId, amountBeforeFee: row.amountBeforeFee.toString(), options };
}

/** Khóa BILL từ các trường OCR (KHÔNG gồm số tiền — để SỬA số tiền vẫn khớp Lô cũ). Chống Lô trùng khi CÙNG 1
 * giao dịch bị gửi/ghi 2 lần. KHÓA NHIỀU TẦNG (Admin Demo 21/8 "kiểm tra tận gốc" — bill MB không đọc được số lô/HĐ
 * → khóa cũ NULL → dedup tắt → tách 2 doanh số, verify bằng cặp Lô 22/23 trùng thật trong DB):
 *  • Tầng 1 — có số lô HOẶC số HĐ → khóa TỰ NHIÊN = tid+lô+HĐ. **BỎ "ngày giờ" ra khỏi khóa** (OCR đọc giờ hay
 *    lệch từng giây giữa 2 lần → chính nó gây tách nhầm). Prefix "nat|" để không đụng khóa ảnh.
 *  • Tầng 2 — THIẾU cả 2 số → khóa DỰ PHÒNG theo HASH ẢNH bill (sha256 file, KHÔNG phụ thuộc OCR): gửi lại ĐÚNG
 *    file ảnh đó (forward Zalo) → cùng hash → UPSERT cùng Lô. Prefix "img|". Đây là tầng cứu case bill 22/23.
 *  • Không có gì → null → route rơi sang kiểm "nghi trùng" (tầng 3, cùng tid+tiền+ngày → cảnh báo, xem createLoFromBillTid). */
/** Ngày HCM 'YYYY-MM-DD' từ Date (deterministic, en-CA). Dùng cho khóa bill theo lô (lô ngân hàng RESET mỗi ngày). */
export function hcmDayKey(d: Date): string {
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }); // YYYY-MM-DD
}

/** [Admin Demo 16/9 khuya] SỐ LÔ HIỂN THỊ: lô có mã đóng lô → "84(95)"; không có → "84". Dùng chung mọi nơi
 *  (caption bill, bảng doanh số, Excel, ảnh báo cáo) để theo dõi lô bị đóng 95. */
export function loHienThi(batchNumber: string | number | null | undefined, settlementCode?: string | null): string {
  const lo = String(batchNumber ?? '').trim();
  const sc = String(settlementCode ?? '').replace(/[^0-9]/g, '');
  if (!lo) return '';
  return sc ? `${lo}(${sc})` : lo;
}

export function buildBillKey(fields: {
  tid: string;
  batchNumber?: string | null;
  invoiceNumber?: string | null;
  imageHash?: string | null;
  // [Admin Demo 6/9] NGÀY bill (nếu có) — SỐ LÔ NGÂN HÀNG RESET MỖI NGÀY: lô 1 ngày 1/9 ≠ lô 1 ngày 5/9. Khóa cũ
  // `nat|tid|lô|` BỎ QUA ngày → 2 bill khác ngày cùng lô GỘP nhầm (đè doanh số CÂM + lệch ngày). Kèm ngày → tách.
  // CHỈ áp cho khóa `nat|` (theo lô). Khóa `img|tid|hash` đã unique-theo-ảnh (không đụng lô-reset) → GIỮ NGUYÊN.
  // billDate KHÔNG có (bill thiếu ngày / manual) → GIỮ format cũ 4-đoạn (tương thích ngược; tầng-3 dedup theo tiền đỡ).
  billDate?: Date | null;
  /** [Admin Demo 16/9 khuya] MÃ ĐÓNG LÔ ("95"…) — máy POS sau khi ĐÓNG LÔ có thể quay vòng SỐ LÔ, nên cùng ngày
   *  cùng TID vẫn có 2 lô mang số 84: một lô thường và một lô "84(95)". Khóa cũ (tid|lô|ngày) coi 2 lô này là
   *  MỘT ⇒ bill thứ hai bị dedup ⇒ MẤT DOANH SỐ (ca thật 16/9 TID 20281024: mất 18.643.000đ). Đưa mã vào khóa
   *  → tách lô, và số lô hiển thị thành "84(95)" để theo dõi. */
  settlementCode?: string | null;
}): string | null {
  const norm = (s: string | null | undefined): string => (s ?? '').trim().toLowerCase();
  const tid = norm(fields.tid);
  const batchRaw = norm(fields.batchNumber);
  const sc = String(fields.settlementCode ?? '').replace(/[^0-9]/g, '');
  const batch = batchRaw && sc ? `${batchRaw}(${sc})` : batchRaw;
  const invoice = norm(fields.invoiceNumber);
  if (batch || invoice) {
    const base = ['nat', tid, batch, invoice].join('|');
    return fields.billDate ? `${base}|${hcmDayKey(fields.billDate)}` : base;
  }
  const hash = norm(fields.imageHash);
  if (hash) return ['img', tid, hash].join('|');
  return null;
}

// ── Reconcile ──────────────────────────────────────────────────────────────────────────────────────────
export interface ReconcileSummaryOcrInput {
  amount: number;
  receiptNumber?: number | null;
  bankReportedLoNumber?: number | null;
}
export interface ReconcileIndividualBillInput {
  amount: number;
  receiptNumber?: number | null;
  cardLast4?: string | null;
  swipeAt: string; // ISO
}
export interface ReconcileBody {
  summaryOcr: ReconcileSummaryOcrInput;
  individualBills: ReconcileIndividualBillInput[];
}

export interface RuleViolationEntry {
  rule: 'A_MAX_AMOUNT' | 'B_MAX_SWIPES_PER_DAY' | 'C_ROUND_AMOUNT' | 'D_MIN_GAP' | 'E_REPEATED_AMOUNT_NEARBY' | 'F_DAILY_TOTAL_PER_TID';
  billIndex?: number; // có mặt cho Rule A/C (đánh giá TỪNG bill); Rule B/D/E đánh giá THEO NHÓM thẻ (không gắn 1 bill cụ thể)
  cardLast4?: string | null;
  tidId?: number; // có mặt cho Rule F (đánh giá THEO TID, không phải theo thẻ)
  message: string;
}

export interface ReconcileResult {
  loId: number;
  status: 'CONFIRMED' | 'MISMATCH';
  eligibleForTransactionCreation: boolean; // CHỈ true khi CONFIRMED — task SAU tự quyết định có tạo Transaction thật hay không
  triangulation: TriangulationResult;
  loNumberReuse: LoNumberReuseResult;
  violations: RuleViolationEntry[];
  // Rule G (2026-08-12) — CẢNH BÁO thứ tự/nhảy cóc/trùng số hóa đơn + số lô. CHỈ CẢNH BÁO, KHÔNG ảnh hưởng
  // `status` (không chặn CONFIRMED) — người dùng tự đối chiếu. Tách RIÊNG khỏi `violations` (violations mới
  // chặn CONFIRMED, sequenceWarnings thì KHÔNG).
  sequenceWarnings: LoSequenceWarning[];
}

export type ReconcileError =
  | { ok: false; error: 'NOT_FOUND'; message: string }
  | { ok: false; error: 'LO_NOT_RECONCILABLE'; message: string }
  | { ok: false; error: 'VALIDATION'; message: string };

/** Validate cardLast4: CHỈ chấp nhận ≤4 chữ số (bỏ qua khoảng trắng/gạch ngang phân tách phổ biến trong OCR).
 * TỪ CHỐI (không âm thầm cắt) nếu trông như số thẻ đầy đủ — hard requirement PCI-DSS-style, KHÔNG BAO GIỜ
 * tin caller mù quáng (yêu cầu LEAD, xem sigma-fraud-rules.ts/maskCardLast4 cho bản "cắt" dùng nội bộ). */
function validateCardLast4(input: unknown): { ok: true; value: string | null } | { ok: false } {
  if (input === undefined || input === null) return { ok: true, value: null };
  if (typeof input !== 'string') return { ok: false };
  const digits = input.replace(/[\s-]/g, '');
  if (!/^\d{0,4}$/.test(digits)) return { ok: false };
  return { ok: true, value: digits.length > 0 ? digits : null };
}

/** Ngân hàng áp dụng cho lô = ngân hàng của TID thuộc LoRow ĐẦU TIÊN (id asc) của lô đó — ASSUMPTION (build
 * 22/7, chưa LEAD chốt riêng): nghiệp vụ kết toán thực tế 1 lô luôn thuộc 1 TID/1 ngân hàng duy nhất; nếu lô
 * (hiếm) có nhiều TID thuộc NHIỀU ngân hàng khác nhau, dùng ngân hàng của dòng đầu — KHÔNG chặn/lỗi, chỉ áp
 * 1 bộ rule duy nhất cho toàn lô. */
async function resolveLoBankId(db: Db, loId: number): Promise<number | null> {
  const firstRow = await db.loRow.findFirst({ where: { loId }, orderBy: { id: 'asc' } });
  if (!firstRow) return null;
  const tid = await db.tid.findUnique({ where: { id: firstRow.tidId } });
  return tid?.bankId ?? null;
}

/** Mã ngân hàng của lô (để BỎ QUA nhóm cảnh báo số lô cho MBV — MBV không có số lô, xem Rule G). */
async function resolveBankCode(db: Db, bankId: number | null): Promise<string | null> {
  if (bankId == null) return null;
  const bank = await db.bank.findUnique({ where: { id: bankId } });
  return bank?.code ?? null;
}

interface FraudRuleConfig {
  maxAmountPerSwipe: number | null;
  maxSwipesPerDayPerCard: number | null;
  minGapMinutesBetweenSwipes: number | null;
  disallowRoundAmounts: boolean;
  disallowRepeatedAmountNearby: boolean;
  repeatedAmountWindowMinutes: number | null;
  maxDailyTotalPerTid: number | null; // Rule F (build 22/7, LEAD chốt)
}
const NO_LIMIT_CONFIG: FraudRuleConfig = {
  maxAmountPerSwipe: null,
  maxSwipesPerDayPerCard: null,
  minGapMinutesBetweenSwipes: null,
  disallowRoundAmounts: false,
  disallowRepeatedAmountNearby: false,
  repeatedAmountWindowMinutes: null,
  maxDailyTotalPerTid: null
};

async function resolveBankFraudRuleConfig(db: Db, bankId: number | null): Promise<FraudRuleConfig> {
  if (bankId == null) return NO_LIMIT_CONFIG;
  // "Cấu hình đang sống" = deletedAt null, mới nhất (id desc) — CÙNG khuôn lookup override TidSellFee/fee-quote.ts.
  const cfg = await db.bankFraudRule.findFirst({ where: { bankId, deletedAt: null }, orderBy: { id: 'desc' } });
  if (!cfg) return NO_LIMIT_CONFIG;
  return {
    maxAmountPerSwipe: cfg.maxAmountPerSwipe != null ? Number(cfg.maxAmountPerSwipe) : null,
    maxSwipesPerDayPerCard: cfg.maxSwipesPerDayPerCard,
    minGapMinutesBetweenSwipes: cfg.minGapMinutesBetweenSwipes,
    disallowRoundAmounts: cfg.disallowRoundAmounts,
    disallowRepeatedAmountNearby: cfg.disallowRepeatedAmountNearby,
    repeatedAmountWindowMinutes: cfg.repeatedAmountWindowMinutes,
    maxDailyTotalPerTid: cfg.maxDailyTotalPerTid != null ? Number(cfg.maxDailyTotalPerTid) : null
  };
}

/** Lịch sử quẹt CÙNG đại lý + CÙNG 4-số-cuối-thẻ (đã persist ở các lô TRƯỚC — join scalar loId→agentId ở
 * service layer, khuôn "asset tables" đã có). Scope THEO ĐẠI LÝ (không phải toàn hệ thống) — ASSUMPTION build
 * 22/7: cardLast4 chỉ 4 số nên CÓ THỂ trùng ngẫu nhiên giữa các đại lý/thẻ khác nhau; scope theo đại lý giảm
 * false-positive xuyên-đại-lý mà đề bài không yêu cầu rõ. */
async function fetchCardHistoryForAgent(db: Db, agentId: number, cardLast4: string, excludeLoId: number): Promise<{ ocrAmount: number; swipeAt: Date }[]> {
  const agentLoIds = (await db.lo.findMany({ where: { agentId, id: { not: excludeLoId } }, select: { id: true } })).map((l) => l.id);
  if (agentLoIds.length === 0) return [];
  const bills = await db.loBill.findMany({ where: { loId: { in: agentLoIds }, cardLast4 } });
  return bills.map((b) => ({ ocrAmount: Number(b.ocrAmount), swipeAt: b.swipeAt }));
}

/** TID áp dụng cho Rule F (tổng tiền/ngày/TID) = TID của LoRow ĐẦU TIÊN (id asc) của lô — CÙNG assumption/lý
 * do với resolveLoBankId phía trên (1 lô thực tế luôn thuộc 1 TID/1 ngân hàng; config Rule F đến từ CÙNG
 * bankFraudRule đã resolve qua TID này, nên dùng thống nhất 1 TID cho cả bank-config lẫn Rule F, KHÔNG tách
 * theo từng LoRow — xem ghi chú "ambiguous" trong báo cáo build 22/7 nếu lô hiếm khi có nhiều TID). Trả null
 * nếu lô chưa có dòng nào.
 */
async function resolveLoFirstRowTidId(db: Db, loId: number): Promise<number | null> {
  const firstRow = await db.loRow.findFirst({ where: { loId }, orderBy: { id: 'asc' } });
  return firstRow?.tidId ?? null;
}

/** Lịch sử quẹt CÙNG đại lý + CÙNG TID (đã persist ở các lô TRƯỚC). LoBill KHÔNG có cột tidId trực tiếp (bill
 * lẻ không gắn 1 dòng/TID cụ thể trong lô) — nên join scalar qua LoRow: "lô nào có ÍT NHẤT 1 LoRow thuộc TID
 * này" → TÍNH TOÀN BỘ bill của lô đó vào tổng TID đó (mirror 2 bước của fetchCardHistoryForAgent, keyed theo
 * tidId thay vì cardLast4). Scope THEO ĐẠI LÝ, CÙNG lý do fetchCardHistoryForAgent (giảm false-positive
 * xuyên-đại-lý).
 */
interface TidHistoryBill {
  ocrAmount: number;
  swipeAt: Date;
  receiptNumber: number | null; // Rule G — thứ tự/nhảy cóc/trùng số hóa đơn
  cardLast4: string | null;
}
async function fetchTidBillsForAgent(db: Db, agentId: number, tidId: number, excludeLoId: number): Promise<TidHistoryBill[]> {
  const agentLoIds = (await db.lo.findMany({ where: { agentId, id: { not: excludeLoId } }, select: { id: true } })).map((l) => l.id);
  if (agentLoIds.length === 0) return [];
  const matchingLoIds = [
    ...new Set((await db.loRow.findMany({ where: { loId: { in: agentLoIds }, tidId }, select: { loId: true } })).map((r) => r.loId))
  ];
  if (matchingLoIds.length === 0) return [];
  const bills = await db.loBill.findMany({ where: { loId: { in: matchingLoIds } } });
  return bills.map((b) => ({ ocrAmount: Number(b.ocrAmount), swipeAt: b.swipeAt, receiptNumber: b.receiptNumber, cardLast4: b.cardLast4 }));
}

/**
 * Đối soát 1 lô: chạy Rule A-F + tam giác đối soát + cảnh báo trùng số lô + Rule G (cảnh báo thứ tự/nhảy cóc/
 * trùng số hóa đơn + số lô — 2026-08-12), ghi AuditLog cho MỌI phát hiện, cập nhật status (CONFIRMED chỉ khi
 * tam giác khớp TUYỆT ĐỐI + không rule A-F nào vi phạm). lô-số-trùng + Rule G CHỈ cảnh báo/log, KHÔNG chặn
 * CONFIRMED (LEAD xác nhận nhiều lần "cảnh báo, không chặn cứng").
 */
export async function reconcileLo(db: Db, loId: number, body: ReconcileBody): Promise<{ ok: true; data: ReconcileResult } | ReconcileError> {
  const lo = await db.lo.findUnique({ where: { id: loId } });
  if (!lo) return { ok: false, error: 'NOT_FOUND', message: `Lô id=${loId} không tồn tại.` };
  if (lo.status === 'CANCELLED' || lo.status === 'CONFIRMED') {
    return {
      ok: false,
      error: 'LO_NOT_RECONCILABLE',
      message: `Lô đang ở trạng thái ${lo.status} — không thể đối soát lại (CONFIRMED/CANCELLED là chung cục qua endpoint này).`
    };
  }
  if (!body || !body.summaryOcr || !Array.isArray(body.individualBills)) {
    return { ok: false, error: 'VALIDATION', message: 'Thiếu summaryOcr hoặc individualBills[].' };
  }
  // BOT-5: DÙNG CHUNG isValidAmount (số nguyên ≥ 0) với createLo/quoteRow. Trước đây chỉ kiểm Number.isFinite →
  // chấp nhận số ÂM/thập phân, kẻ gian có thể gửi individualBills[].amount âm để ép tam giác đối soát khớp giả.
  if (!isValidAmount(body.summaryOcr.amount)) {
    return { ok: false, error: 'VALIDATION', message: 'summaryOcr.amount phải là số nguyên ≥ 0.' };
  }
  // [B306/F8 24/11 — agent quyền, cùng lớp B270] Số lô/số HĐ ghi vào cột INTEGER: không kiểm thì số lẻ/
  // tràn int4 làm lệnh ghi NÉM SAU KHI loBill.createMany đã chèn ⇒ ghi nửa vời + 500. Fail-closed tại cửa.
  const soLoOcr = body.summaryOcr.bankReportedLoNumber;
  if (soLoOcr != null && (!Number.isInteger(soLoOcr) || soLoOcr < 0 || soLoOcr > 2147483647)) {
    return { ok: false, error: 'VALIDATION', message: 'Số lô "' + soLoOcr + '" không hợp lệ (số nguyên 0 → 2.147.483.647).' };
  }
  for (const [i, ib] of body.individualBills.entries()) {
    const rn = ib.receiptNumber;
    if (rn != null && (!Number.isInteger(rn) || rn < 0 || rn > 2147483647)) {
      return { ok: false, error: 'VALIDATION', message: 'Số hóa đơn của bill thứ ' + (i + 1) + ' ("' + rn + '") không hợp lệ (số nguyên 0 → 2.147.483.647).' };
    }
  }
  for (const [i, b] of body.individualBills.entries()) {
    if (!isValidAmount(b.amount)) {
      return { ok: false, error: 'VALIDATION', message: `individualBills[${i}].amount phải là số nguyên ≥ 0.` };
    }
    if (!b.swipeAt || Number.isNaN(new Date(b.swipeAt).getTime())) {
      return { ok: false, error: 'VALIDATION', message: `individualBills[${i}].swipeAt phải là thời điểm hợp lệ.` };
    }
    if (!validateCardLast4(b.cardLast4).ok) {
      return { ok: false, error: 'VALIDATION', message: `individualBills[${i}].cardLast4 phải ≤4 chữ số (KHÔNG được gửi số thẻ đầy đủ).` };
    }
  }

  const bankId = await resolveLoBankId(db, loId);
  const config = await resolveBankFraudRuleConfig(db, bankId);

  const violations: RuleViolationEntry[] = [];

  // Rule A + C — theo TỪNG bill.
  body.individualBills.forEach((b, idx) => {
    const a = checkMaxAmountPerSwipe(b.amount, config.maxAmountPerSwipe);
    if (a.violated) violations.push({ rule: 'A_MAX_AMOUNT', billIndex: idx, cardLast4: b.cardLast4 ?? null, message: a.message });
    const c = checkRoundAmount(b.amount, config.disallowRoundAmounts);
    if (c.violated) violations.push({ rule: 'C_ROUND_AMOUNT', billIndex: idx, cardLast4: b.cardLast4 ?? null, message: c.message });
  });

  // Rule B + D + E — MỘT LẦN cho mỗi nhóm cardLast4 xuất hiện trong batch (tránh báo trùng khi 1 thẻ có
  // nhiều bill trong cùng lô) — gộp lịch sử ĐÃ persist (lô khác, cùng đại lý) + bill batch hiện tại.
  const cardGroups = new Map<string, { ocrAmount: number; swipeAt: Date }[]>();
  for (const b of body.individualBills) {
    const norm = validateCardLast4(b.cardLast4);
    const card = norm.ok ? norm.value : null;
    if (!card) continue; // không có thẻ → không nhóm được theo thẻ, Rule B/D/E không áp dụng cho bill này
    const entry = { ocrAmount: b.amount, swipeAt: new Date(b.swipeAt) };
    if (!cardGroups.has(card)) cardGroups.set(card, []);
    cardGroups.get(card)!.push(entry);
  }
  for (const [card, batchSwipes] of cardGroups) {
    const history = await fetchCardHistoryForAgent(db, lo.agentId, card, loId);
    const combined = [...history, ...batchSwipes];

    // Rule B: đếm theo NGÀY LOCAL của mỗi mốc quẹt trong batch (mỗi mốc trong batch có thể rơi vào ngày
    // khác nhau về lý thuyết — kiểm TỪNG ngày xuất hiện trong batch, tránh bỏ sót).
    const daysChecked = new Set<string>();
    for (const s of batchSwipes) {
      const dayKey = `${s.swipeAt.getFullYear()}-${s.swipeAt.getMonth()}-${s.swipeAt.getDate()}`;
      if (daysChecked.has(dayKey)) continue;
      daysChecked.add(dayKey);
      const sameDay = combined.filter((x) => isSameLocalDay(x.swipeAt, s.swipeAt)).map((x) => x.swipeAt);
      const b = checkMaxSwipesPerDayPerCard(sameDay, config.maxSwipesPerDayPerCard);
      if (b.violated) violations.push({ rule: 'B_MAX_SWIPES_PER_DAY', cardLast4: card, message: b.message });
    }

    const d = checkMinGapBetweenSwipes(
      combined.map((x) => x.swipeAt),
      config.minGapMinutesBetweenSwipes
    );
    if (d.violated) violations.push({ rule: 'D_MIN_GAP', cardLast4: card, message: d.message });

    const e = checkRepeatedAmountNearby(combined, config.disallowRepeatedAmountNearby, config.repeatedAmountWindowMinutes);
    if (e.violated) violations.push({ rule: 'E_REPEATED_AMOUNT_NEARBY', cardLast4: card, message: e.message });
  }

  // Rule F — tổng số tiền quẹt/ngày cho TID của lô này (khác dimension với A/B/D/E: TID, không phải thẻ,
  // không phải từng lệnh đơn). CÙNG TID đã dùng để resolve bankId/config phía trên (resolveLoFirstRowTidId) —
  // nhất quán 1 TID cho cả bank-config lẫn Rule F. Chạy giống khuôn Rule B: kiểm TỪNG ngày local xuất hiện
  // trong batch (tránh bỏ sót nếu batch trải nhiều ngày).
  // Rule G (2026-08-12) — CẢNH BÁO thứ tự/nhảy cóc/trùng số hóa đơn + số lô (chỉ cảnh báo, KHÔNG chặn). Dùng
  // CHUNG lịch sử bill cùng TID với Rule F (fetch 1 lần) — bổ sung receiptNumber/cardLast4 cho Rule G.
  const sequenceWarnings: LoSequenceWarning[] = [];
  const tidIdForRuleF = await resolveLoFirstRowTidId(db, loId);
  if (tidIdForRuleF != null && body.individualBills.length > 0) {
    const tidHistory = await fetchTidBillsForAgent(db, lo.agentId, tidIdForRuleF, loId);
    const tidBatchSwipes = body.individualBills.map((b) => ({ ocrAmount: b.amount, swipeAt: new Date(b.swipeAt) }));
    const tidCombined = [...tidHistory, ...tidBatchSwipes];

    const tidDaysChecked = new Set<string>();
    for (const s of tidBatchSwipes) {
      const dayKey = `${s.swipeAt.getFullYear()}-${s.swipeAt.getMonth()}-${s.swipeAt.getDate()}`;
      if (tidDaysChecked.has(dayKey)) continue;
      tidDaysChecked.add(dayKey);
      const sameDayAmounts = tidCombined.filter((x) => isSameLocalDay(x.swipeAt, s.swipeAt)).map((x) => x.ocrAmount);
      const f = checkMaxDailyTotalPerTid(sameDayAmounts, config.maxDailyTotalPerTid);
      if (f.violated) violations.push({ rule: 'F_DAILY_TOTAL_PER_TID', tidId: tidIdForRuleF, message: f.message });
    }

    // Rule G — số hóa đơn: trùng toàn bộ OCR + nghịch thứ tự/reset/nhảy cóc, scope THEO TID.
    const historyFingerprints: LoBillFingerprint[] = tidHistory.map((b) => ({
      receiptNumber: b.receiptNumber,
      ocrAmount: b.ocrAmount,
      swipeAt: b.swipeAt,
      cardLast4: b.cardLast4,
      isNew: false
    }));
    const batchFingerprints: LoBillFingerprint[] = body.individualBills.map((b) => {
      const norm = validateCardLast4(b.cardLast4);
      return {
        receiptNumber: b.receiptNumber ?? null,
        ocrAmount: b.amount,
        swipeAt: new Date(b.swipeAt),
        cardLast4: norm.ok ? norm.value : null,
        isNew: true
      };
    });
    const combinedFingerprints = [...historyFingerprints, ...batchFingerprints];
    sequenceWarnings.push(...detectDuplicateBills(combinedFingerprints));
    sequenceWarnings.push(...checkReceiptNumberSequence(combinedFingerprints));
  }

  const sumOfIndividualBillsOcrTotal = body.individualBills.reduce((sum, b) => sum + b.amount, 0);
  const triangulation = triangulateMismatch(Number(lo.expectedTotalAmount), body.summaryOcr.amount, sumOfIndividualBillsOcrTotal);

  // Trùng "số lô" — SCOPE THEO TID, KHÔNG PHẢI THEO ĐẠI LÝ (LEAD chỉnh lại 23/7: mỗi TID có bộ đếm kết toán
  // riêng độc lập ở ngân hàng — 2 TID khác nhau, DÙ CÙNG đại lý hay khác đại lý, báo TRÙNG số lô là BÌNH
  // THƯỜNG/không đáng ngờ; chỉ đáng ngờ khi CÙNG 1 TID báo trùng số). TID của lô = tidIdForRuleF đã resolve
  // ở trên qua resolveLoFirstRowTidId — TÁI DÙNG NGUYÊN precedent Rule F/bank-config cho CÙNG sự mơ hồ "lô
  // thuộc TID nào", KHÔNG phát minh cách resolve khác. Lô chưa có LoRow (tidId chưa xác định được) → bỏ qua
  // kiểm tra (không đủ căn cứ scope, giống cách Rule F/bank-config bỏ qua khi bankId/tidId null).
  let pastLoNumbersForSameTid: (number | null)[] = [];
  if (tidIdForRuleF != null) {
    const sameTidLoIds = [
      ...new Set((await db.loRow.findMany({ where: { tidId: tidIdForRuleF, loId: { not: loId } }, select: { loId: true } })).map((r) => r.loId))
    ];
    if (sameTidLoIds.length > 0) {
      pastLoNumbersForSameTid = (await db.lo.findMany({ where: { id: { in: sameTidLoIds } }, select: { bankReportedLoNumber: true } })).map(
        (l) => l.bankReportedLoNumber
      );
    }
  }
  const loNumberReuse = checkLoNumberReuse(body.summaryOcr.bankReportedLoNumber ?? null, pastLoNumbersForSameTid);

  // Rule G — số lô: nhảy cóc (thiếu số ở giữa) / lùi số. BỎ QUA cho MBV (MBV KHÔNG có số lô — LEAD chốt).
  const bankCode = await resolveBankCode(db, bankId);
  const isMbvBank = (bankCode ?? '').trim().toUpperCase() === 'MBV';
  if (!isMbvBank && tidIdForRuleF != null) {
    sequenceWarnings.push(...checkLoNumberSequence(body.summaryOcr.bankReportedLoNumber ?? null, pastLoNumbersForSameTid));
  }

  // sequenceWarnings CHỈ CẢNH BÁO — KHÔNG tham gia quyết định status (không chặn CONFIRMED). Status vẫn CHỈ từ
  // tam giác đối soát + violations (Rule A-F) như cũ.
  const status: 'CONFIRMED' | 'MISMATCH' = triangulation.blame === 'NONE' && violations.length === 0 ? 'CONFIRMED' : 'MISMATCH';

  // Persist bill lẻ (lịch sử cho các lần đối soát SAU + bằng chứng tra cứu) — LUÔN lưu dù kết quả gì.
  if (body.individualBills.length > 0) {
    await db.loBill.createMany({
      data: body.individualBills.map((b) => {
        const norm = validateCardLast4(b.cardLast4); // đã validate .ok=true ở vòng kiểm input phía trên
        return {
          loId,
          receiptNumber: b.receiptNumber ?? null,
          ocrAmount: BigInt(Math.round(b.amount)),
          swipeAt: new Date(b.swipeAt),
          cardLast4: norm.ok ? norm.value : null
        };
      })
    });
  }

  await db.lo.update({
    where: { id: loId },
    data: {
      status,
      bankReportedLoNumber: body.summaryOcr.bankReportedLoNumber ?? lo.bankReportedLoNumber
    }
  });

  // AuditLog — MỌI phát hiện (vi phạm rule / lệch tam giác / trùng số lô) PHẢI log (yêu cầu LEAD).
  const auditRows: {
    action:
      | 'SIGMA_LO_RULE_VIOLATION'
      | 'SIGMA_LO_TRIANGULATION_MISMATCH'
      | 'SIGMA_LO_NUMBER_REUSE'
      | 'SIGMA_LO_SEQUENCE_WARNING'
      | 'SIGMA_LO_CONFIRMED';
    after: unknown;
  }[] = [];
  for (const v of violations) auditRows.push({ action: 'SIGMA_LO_RULE_VIOLATION', after: v });
  if (triangulation.blame !== 'NONE') auditRows.push({ action: 'SIGMA_LO_TRIANGULATION_MISMATCH', after: triangulation });
  if (loNumberReuse.violated) auditRows.push({ action: 'SIGMA_LO_NUMBER_REUSE', after: loNumberReuse });
  for (const w of sequenceWarnings) auditRows.push({ action: 'SIGMA_LO_SEQUENCE_WARNING', after: w });
  if (status === 'CONFIRMED') auditRows.push({ action: 'SIGMA_LO_CONFIRMED', after: { loId, agentId: lo.agentId } });

  if (auditRows.length > 0) {
    await db.auditLog.createMany({
      data: auditRows.map((r) => ({
        actorUserId: null,
        action: r.action,
        targetType: 'Lo',
        targetId: String(loId),
        afterJson: JSON.stringify({ agentId: lo.agentId, ...(r.after as Record<string, unknown>) }),
        ipAddress: 'sigma-bot-api',
        deviceInfo: 'apps/bot-api'
      }))
    });
  }

  return {
    ok: true,
    data: { loId, status, eligibleForTransactionCreation: status === 'CONFIRMED', triangulation, loNumberReuse, violations, sequenceWarnings }
  };
}

// ── Cancel ─────────────────────────────────────────────────────────────────────────────────────────────
export type CancelLoError =
  | { ok: false; error: 'NOT_FOUND'; message: string }
  | { ok: false; error: 'ALREADY_CANCELLED'; message: string }
  | { ok: false; error: 'ALREADY_CONFIRMED'; message: string }
  | { ok: false; error: 'VALIDATION'; message: string };

/**
 * Hủy 1 lô đơn giản (PENDING/MISMATCH → CANCELLED, mirror cancelReason/cancelledAt của Transaction). TỪ CHỐI
 * nếu đã CANCELLED (idempotent-safe, KHÔNG hủy 2 lần) hoặc đã CONFIRMED (cần luồng duyệt-hủy như
 * Transaction.cancelRequestId/ApprovalRequest — CHƯA wiring ở task này, xem báo cáo build).
 */
export async function cancelLo(db: Db, loId: number, reason: string): Promise<{ ok: true; data: { id: number; status: string } } | CancelLoError> {
  if (!reason || typeof reason !== 'string' || reason.trim().length === 0) {
    return { ok: false, error: 'VALIDATION', message: 'reason (lý do hủy) là bắt buộc.' };
  }
  const lo = await db.lo.findUnique({ where: { id: loId } });
  if (!lo) return { ok: false, error: 'NOT_FOUND', message: `Lô id=${loId} không tồn tại.` };
  if (lo.status === 'CANCELLED') return { ok: false, error: 'ALREADY_CANCELLED', message: 'Lô này đã bị hủy trước đó.' };
  if (lo.status === 'CONFIRMED') {
    return {
      ok: false,
      error: 'ALREADY_CONFIRMED',
      message: 'Lô đã CONFIRMED — không hủy qua endpoint đơn giản này (cần luồng duyệt-hủy như Transaction, chưa wiring ở đây).'
    };
  }
  // [B334/FINDING-2 24/11 — agent nhồi] HỦY LÔ phải hủy CẢ GIAO DỊCH đã bridge, cùng bất biến B285/B309
  // ("hủy ⇒ CANCELLED + xoá mềm"). Trước đây chỉ đổi los.status ⇒ GD giữ POSTED+revenue (zombie, 2 sổ
  // lệch đúng tiền 1 bill). cancelLo hiện CHƯA wiring route nào — vá trước để lúc cắm dây không đẻ bom.
  const updated = await db.$transaction(async (tx) => {
    const u = await tx.lo.update({ where: { id: loId }, data: { status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date() } });
    if (lo.transactionId != null) {
      await tx.transaction.updateMany({
        where: { id: lo.transactionId, status: { not: 'CANCELLED' } },
        data: { deletedAt: new Date(), status: 'CANCELLED', cancelledAt: new Date(), cancelReason: 'Hủy lô: ' + reason }
      });
    }
    await tx.auditLog.create({
      data: { actorUserId: null, action: 'SIGMA_LO_CANCELLED', targetType: 'Lo', targetId: String(loId),
        afterJson: JSON.stringify({ reason, txnCancelled: lo.transactionId ?? null }), ipAddress: 'sigma-bot-api', deviceInfo: 'apps/bot-api' }
    });
    return u;
  });
  return { ok: true, data: { id: updated.id, status: updated.status } };
}

// ── Số lô gần đây (sanity hint, KHÔNG sinh số) ────────────────────────────────────────────────────────
export async function getRecentLoNumbers(db: Db, agentId: number, limit = 5): Promise<{ loId: number; bankReportedLoNumber: number | null; createdAt: Date }[]> {
  const rows = await db.lo.findMany({
    where: { agentId, bankReportedLoNumber: { not: null } },
    select: { id: true, bankReportedLoNumber: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: limit
  });
  return rows.map((r) => ({ loId: r.id, bankReportedLoNumber: r.bankReportedLoNumber, createdAt: r.createdAt }));
}
