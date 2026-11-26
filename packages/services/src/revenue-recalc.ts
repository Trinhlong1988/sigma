// PHA 2 — ENGINE RECALC DOANH SỐ THEO KỲ (quyết định 1A + 3a). Khi biểu phí (FeeRate/FeeSellQuote) hoặc KỲ override
// (TidSellFee) đổi — nhất là sửa LÙI (backdate) cắt vào kỳ đã có GD — doanh thu SNAPSHOT trên GD cũ không còn khớp
// biểu phí hiệu lực tại txnDate. Engine này tra LẠI phí cho MỌI GD POSTED bị ảnh hưởng (dùng ĐÚNG resolveFeeForTxn —
// KHÔNG nhân bản công thức), so với snapshot, và nếu KHÁC thì cập nhật cột doanh thu/margin + ghi 1 hàng
// RevenueRecalcLog (before→after) để soi lịch sử.
//
// QUYẾT ĐỊNH 3a (Admin Demo): recalc MỌI GD POSTED bị ảnh hưởng — KỂ CẢ đã đối soát/tất toán (settled) — nhưng:
//   • CHỈ status POSTED, deletedAt null, writtenOffAt null (GD hủy / nợ-xấu-đã-ghi-giảm ĐÓNG BĂNG — không đụng).
//   • KHÔNG đụng amount / mã GD (chỉ margin + revenue*).
//   • IDEMPOTENT: chạy lại trên dữ liệu đã đúng → 0 thay đổi, 0 log (so khớp trước khi ghi).
//   • KHÔNG NUỐT LỖI (R198): GD nào không tra lại được phí (resolveFeeForTxn fail) → GOM vào `failed[]` để CALLER
//     surface (fail-closed) — TUYỆT ĐỐI không âm thầm bỏ qua để lại doanh thu cũ sai.
//
// BOUND KỲ nửa-mở [from, to): GD có txnDate ĐÚNG mốc 0h00 local của kỳ mới thuộc KỲ MỚI (gte). from được floor về
// nửa đêm LOCAL (startOfDayLocal — ĐỐI XỨNG fee-config/tid-sell-fee) nên GD tại đúng mốc rơi vào kỳ mới. to = mốc
// bắt đầu kỳ KẾ (exclusive) HOẶC null = +∞. Recompute tới +∞ luôn ĐÚNG nhờ idempotent (GD sau kỳ kế tra ra phí y
// hệt snapshot → 0 đổi), nên caller mặc định truyền to=null cho an toàn (không phải tự tính ranh giới kỳ kế — dễ sót).
// Nối feedback_period_bound_timezone_consistency.
import { computeRevenue, marginToAmount } from '@sigma/business-rules';
import type { Db } from '@sigma/database';
import { resolveFeeForTxn, idsTheoTxnDate, txnIsoMap, type FeeResolveClient } from './transaction.js';

/** Client tối thiểu engine cần — CẢ Db LẪN tx-client ($transaction) đều thỏa (chạy recalc TRONG cùng tx đổi phí = atomic). */
export type RecalcClient = FeeResolveClient &
  Pick<Db, 'tid' | 'transaction' | 'revenueRecalcLog' | 'cashDebtSettlement'> &
  // [B223 20/11 — Admin Demo duyệt "a"] Cần đụng LÔ để số trên màn Doanh Số khớp giao dịch (xem dongBoLo).
  Partial<Pick<Db, '$queryRawUnsafe' | '$executeRawUnsafe'>>;

/**
 * [B223 20/11] ĐỒNG BỘ SỐ TIỀN CỦA LÔ theo giao dịch vừa được tính lại.
 *
 * Vì sao cần: `recalcRevenueForFeeChange` xưa nay CHỈ sửa `transactions` (tiền công ty / nhà đầu tư), KHÔNG
 * đụng `lo_rows`. Đo thật 20/11: đổi giá bán 1,2% → 0,7% áp dụng lùi ngày, giao dịch được tính lại (báo trả dư
 * 45.500đ) nhưng LÔ vẫn 9.880.000 thay vì 9.930.000 ⇒ **màn Doanh Số và sổ giao dịch lệch nhau**.
 *
 * GIỚI HẠN AN TOÀN — cố ý hẹp, thà bỏ sót còn hơn sửa nhầm tiền:
 *   · chỉ lô có ĐÚNG MỘT dòng thẻ (lô tách nhiều thẻ có margin riêng từng dòng, không suy từ 1 margin của GD);
 *   · KHÔNG đụng lô đã đối soát / đã hoàn tiền (cờ ở `pos_lot_recon`) — giống luật chặn ghi đè B194;
 *   · lô bị bỏ qua được TRẢ VỀ để chỗ gọi còn báo cho người dùng, không im lặng (R198).
 */
async function dongBoLo(
  client: RecalcClient,
  txnId: number,
  phiBanMilli: number,
  actorUserId: number | null
): Promise<{ daSua: boolean; boQua?: string }> {
  const q = client.$queryRawUnsafe;
  const e = client.$executeRawUnsafe;
  if (!q || !e) return { daSua: false, boQua: 'không có quyền truy cập lô' };
  const lo = (await q.call(client,
    `SELECT l.id, COUNT(r.id)::int AS so_dong, MIN(r.id) AS row_id, SUM(r.amount_before_fee)::text AS truoc
       FROM los l JOIN lo_rows r ON r.lo_id = l.id
      WHERE l.transaction_id = $1 AND l.status <> 'CANCELLED'
      GROUP BY l.id`, txnId)) as Array<{ id: number; so_dong: number; row_id: number; truoc: string }>;
  if (!lo.length) return { daSua: false };
  const L = lo[0];
  if (L.so_dong !== 1) return { daSua: false, boQua: 'lô #' + L.id + ' tách nhiều loại thẻ' };
  const chot = (await q.call(client,
    `SELECT 1 FROM pos_lot_recon WHERE lot_id = $1 AND (ds IS TRUE OR refund_done IS TRUE) LIMIT 1`, L.id)) as unknown[];
  if (chot.length) return { daSua: false, boQua: 'lô #' + L.id + ' đã đối soát/đã hoàn tiền' };

  // Dùng ĐÚNG công thức của lúc ghi bill (fee-quote.ts dùng marginToAmount với `phiBanMilli`), KHÔNG tự chia
  // tay — tự chia là lệch đồng lẻ với số đã hiện trên màn, và CẤM dùng margin (= phí bán − phí cài máy) vì
  // tiền khách trả tính theo PHÍ BÁN. Đo 20/11: nhầm margin ra 10.095.500đ > cả tiền gốc.
  const truoc = Number(L.truoc);
  const phi = marginToAmount(truoc, phiBanMilli);
  const sau = truoc - phi;
  const cu = (await q.call(client,
    `SELECT fee_applied::text AS phi, amount_after_fee::text AS sau FROM lo_rows WHERE id = $1`,
    L.row_id)) as Array<{ phi: string; sau: string }>;
  if (cu.length && Number(cu[0].sau) === sau) return { daSua: false }; // đã đúng — không đụng, không ghi vết
  await e.call(client, `UPDATE lo_rows SET fee_applied = $1, amount_after_fee = $2 WHERE id = $3`, phi, sau, L.row_id);
  await e.call(client, `UPDATE los SET expected_total_amount = $1 WHERE id = $2`, sau, L.id);
  // GHI VẾT (Admin Demo duyệt "a" kèm ghi vết đầy đủ): tiền của bill đổi mà không có vết thì sau này không ai
  // dò lại được vì sao số khác hôm qua.
  await e.call(client,
    `INSERT INTO audit_logs (actor_user_id, action, target_type, target_id, before_json, after_json, created_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())`,
    actorUserId, 'LO_AMOUNT_RECALC', 'Lo', String(L.id),
    JSON.stringify({ feeApplied: cu[0]?.phi ?? null, amountAfterFee: cu[0]?.sau ?? null }),
    JSON.stringify({ feeApplied: phi, amountAfterFee: sau, phiBanMilli, transactionId: txnId })
  );
  return { daSua: true };
}

export interface RecalcScope {
  /** Phạm vi phí đổi. setTidSellFees → tidId (+feeTypeId); setFeeRate → partnerId (+cardTypeId). */
  tidId?: number;
  partnerId?: number;
  cardTypeId?: number; // undefined = MỌI loại thẻ trong phạm vi
  feeTypeId?: number; // undefined = MỌI loại phí trong phạm vi
  /** Mốc bắt đầu kỳ phí đổi (gte). Sẽ floor nửa đêm LOCAL. */
  from: Date;
  /** Mốc kết thúc (exclusive, lt). null/undefined = +∞. */
  to?: Date | null;
  reason?: string; // 'FEE_RATE_SET' | 'TID_SELL_FEE_SET' | ...
  actorUserId?: number | null;
}

export interface RecalcFailure {
  transactionId: number;
  error: string;
  message: string;
}

/**
 * CẢNH BÁO TRẢ DƯ (Admin Demo 11/8) — sau khi recalc HẠ doanh thu 1 side dưới mức khách/đối tác ĐÃ THU (settlement),
 * khách trả DƯ = Σsettlement(side) − revenue(side) > 0. QUYẾT ĐỊNH: KHÔNG chặn, KHÔNG tự tạo bút toán hoàn — chỉ
 * SINH cờ để UI nhắc kế toán hoàn TAY khi có bill. `overpaidTotal` = dư cả 2 side.
 */
export interface RecalcOverpay {
  transactionId: number;
  overpaidPartner: number; // VND trả dư side ĐỐI TÁC (≥ 0)
  overpaidSell: number; // VND trả dư side BÁN/KHÁCH (≥ 0)
  overpaidTotal: number; // = overpaidPartner + overpaidSell (> 0)
}

export interface RecalcResult {
  ok: boolean; // false nếu có failed[] CỨNG (fail-closed — caller rollback). grandfathered KHÔNG làm ok=false.
  scanned: number; // số GD POSTED trong phạm vi đã xét
  changed: number; // số GD đã cập nhật doanh thu (= số RevenueRecalcLog ghi)
  failed: RecalcFailure[];
  // P5 (Admin Demo 20/8): GD CŨ ghi bằng niêm yết TRƯỚC khi bắt buộc giá bán thực tế (NO_ACTUAL_SELL_FEE) → SOFT/
  // grandfathered: BỎ QUA khi recalc (giữ snapshot cũ), KHÔNG rollback thao tác đổi phí. Tách khỏi failed[] để 1
  // GD cũ không chặn cả lệnh đổi biểu phí. Vẫn TRẢ RA (R198 không nuốt) — caller surface làm cảnh báo.
  grandfathered: RecalcFailure[];
  overpaid: RecalcOverpay[]; // GD sau recalc có Σthu > doanh thu mới (khách trả dư — cần hoàn TAY)
  settledFlagFixed: number; // số GD được đồng bộ lại cờ settled/settledAt cho khớp net sau recalc
  /** [B223 20/11] Số LÔ đã đồng bộ số tiền theo giá mới (để màn Doanh Số khớp sổ giao dịch). */
  loDaSua?: number;
  /** [B223] Lô KHÔNG đồng bộ được, kèm lý do — trả ra để caller còn báo, cấm im lặng (R198). */
  loBoQua?: string[];
}

/** Nửa đêm 00:00:00.000 LOCAL của NGÀY (MIRROR fee-config/tid-sell-fee startOfDayLocal). */
function startOfDayLocal(d: Date): Date {
  // FIX GỐC (Admin Demo 31/8 "cấm tái diễn tuyệt đối"): floor nửa đêm Asia/Ho_Chi_Minh (UTC+7, KHÔNG DST) TƯỜNG
  // MINH, KHÔNG theo TZ tiến trình (MIRROR fee-config/tid-sell-fee). Xem BUGS_FIXED B141.
  const HCM = 7 * 60 * 60 * 1000;
  const w = new Date(d.getTime() + HCM);
  return new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - HCM);
}

/**
 * Tính LẠI doanh thu cho mọi GD POSTED bị ảnh hưởng bởi 1 lần đổi phí. Xem chi tiết ở đầu file.
 * Trả về thống kê; KHÔNG throw cho GD lỗi tra phí (gom `failed[]` — caller quyết định fail-closed).
 */
export async function recalcRevenueForFeeChange(client: RecalcClient, scope: RecalcScope): Promise<RecalcResult> {
  let loDaSua = 0;
  const loBoQua: string[] = [];
  const from = startOfDayLocal(scope.from);
  const toMs = scope.to != null ? scope.to.getTime() : Number.POSITIVE_INFINITY;
  const fromMs = from.getTime();

  // ── Xác định tập tidId trong phạm vi ──
  // partnerId: mọi TID của đối tác (KHÔNG lọc deletedAt — GD của TID đã xóa mềm vẫn phải recalc, khớp
  //   buildWhere transaction.ts cố ý không lọc deletedAt của TID để tổng doanh thu không lệch).
  let tidIdFilter: number[] | undefined;
  if (scope.partnerId != null) {
    const tids = await client.tid.findMany({ where: { partnerId: scope.partnerId }, select: { id: true } });
    tidIdFilter = tids.map((t) => t.id);
    if (tidIdFilter.length === 0) return { ok: true, scanned: 0, changed: 0, failed: [], grandfathered: [], overpaid: [], settledFlagFixed: 0 };
  }

  // ── Lấy GD POSTED trong [from, to) khớp phạm vi (3a: KHÔNG lọc settled) ──
  const where: Record<string, unknown> = {
    status: 'POSTED',
    deletedAt: null,
    writtenOffAt: null
  };
  if (scope.tidId != null) where['tidId'] = scope.tidId;
  else if (tidIdFilter) where['tidId'] = { in: tidIdFilter };
  if (scope.cardTypeId != null) where['cardTypeId'] = scope.cardTypeId;
  if (scope.feeTypeId != null) where['feeTypeId'] = scope.feeTypeId;
  // [GÓI TZ 11/9] txnDate ∈ [from, to) bound bằng raw-ISO qua prefilter id (Prisma bound Date lệch −7h).
  // [B333/FINDING-1 24/11] LỌC id theo tập TID của scope NGAY trong SQL (ANY array) ⇒ idsKy nhỏ (chỉ GD
  // của partner/tid đang đổi phí), không còn kéo cả triệu id của toàn sổ rồi vỡ stack ở findMany IN.
  const tidScope = scope.tidId != null ? [scope.tidId] : tidIdFilter;
  const idsKy = await idsTheoTxnDate(client as Db, { gte: from, ...(Number.isFinite(toMs) ? { lt: new Date(toMs) } : {}) }, tidScope ? { tidIds: tidScope } : undefined);

  const selectCols = {
    id: true, tidId: true, cardTypeId: true, feeTypeId: true, amount: true, txnDate: true, customerId: true,
    partnerMarginMilli: true, sellMarginMilli: true, revenuePartner: true, revenueSell: true, revenueAmount: true,
    phiCaiMayMilli: true, settled: true, settledAt: true
  } as const;
  // [B333/FINDING-1 24/11 — agent nhồi] CHUNK `id IN (...)` theo lô ≤20.000: Prisma dựng `id IN ($1..$n)`,
  // n > ~32.767 là `RangeError: Maximum call stack` (bom hẹn giờ). B333 đã lọc scope nên idsKy thường nhỏ,
  // nhưng 1 partner tích đủ >32k GD vẫn vỡ ⇒ chia lô cho CHẮC. orderBy id ASC giữ thứ tự khóa (chống ABBA).
  const CHUNK = 20000;
  const layLo = (ids: number[]) =>
    client.transaction.findMany({ where: { ...where, id: { in: ids } }, orderBy: { id: 'asc' as const }, select: selectCols });
  type TxnRow = Awaited<ReturnType<typeof layLo>>[number];
  let txns: TxnRow[];
  if (idsKy.length <= CHUNK) {
    txns = await layLo(idsKy);
  } else {
    const gom: TxnRow[] = [];
    for (let i = 0; i < idsKy.length; i += CHUNK) gom.push(...await layLo(idsKy.slice(i, i + CHUNK)));
    gom.sort((a, b) => a.id - b.id); // gộp nhiều lô ⇒ sắp lại id ASC (giữ thứ tự khóa)
    txns = gom;
  }

  // [GÓI TZ 11/9] Ranh giới đã do prefilter raw quyết; giữ danh sách nguyên vẹn (ORM-read txnDate +7h — KHÔNG
  // dùng để so ms nữa). Instant thật per-txn lấy từ txnIsoMap cho resolveFee/weekend.
  const inRange = txns;
  void fromMs;
  const isoRecalc = await txnIsoMap(client as Db, inRange.map((t) => t.id));

  // Nạp tidRow (partnerId/bankId) cho các TID liên quan — resolveFeeForTxn cần.
  const tidIds = [...new Set(inRange.map((t) => t.tidId))];
  const tidRows = new Map<number, { id: number; partnerId: number | null; bankId: number | null }>();
  if (tidIds.length > 0) {
    const rows = await client.tid.findMany({ where: { id: { in: tidIds } }, select: { id: true, partnerId: true, bankId: true } });
    for (const r of rows) tidRows.set(r.id, r);
  }

  const failed: RecalcFailure[] = [];
  const grandfathered: RecalcFailure[] = []; // P5: GD cũ dùng niêm yết (NO_ACTUAL_SELL_FEE) → skip, không rollback.
  let changed = 0;
  // GD có doanh thu ĐỔI → cần đối chiếu lại với settlement (trả dư + đồng bộ cờ settled). Gom để 1 groupBy sau vòng.
  const changedTxns: { id: number; revenuePartner: number; revenueSell: number; settled: boolean }[] = [];

  // [B312/F4 24/11 — agent đào vét, CHẶN SHIP] GD MULTI-CARD (lô tách nhiều thẻ): doanh thu đang lưu là
  // Σ per-thẻ CHÍNH XÁC, margin là BÌNH QUÂN. Vòng dưới tra phí theo MỘT thẻ đại diện rồi computeRevenue
  // đè lên ⇒ chỉ cần BẤM LƯU LẠI GIÁ Y CŨ là mất 7.920đ/bill 11tr (đo thật). Nhận diện 1 lần cho cả lô
  // GD trong phạm vi, NÉ TRƯỚC khi đè (fail-closed, trả ra loBoQua — cấm "báo mà không chặn").
  const idsMultiRc = new Set<number>(
    inRange.length > 0
      ? (await client.$queryRawUnsafe<Array<{ id: number }>>(
          `SELECT t2.id FROM transactions t2
            WHERE t2.id = ANY($1::int[])
              AND (COALESCE(t2.install_fee_amount, 0) > 0
                   OR (SELECT count(DISTINCT r2.card_type_id) FROM los l2 JOIN lo_rows r2 ON r2.lo_id = l2.id
                        WHERE l2.transaction_id = t2.id) > 1)`,
          inRange.map((t) => t.id)
        )).map((r) => Number(r.id))
      : []
  );

  for (const t of inRange) {
    if (idsMultiRc.has(t.id)) {
      // [B312] cấm công thức 1-thẻ đè GD multi-card — giữ nguyên, báo rõ để xử per-thẻ khi cần.
      loBoQua.push(`GD #${t.id}: lô tách nhiều loại thẻ — recalc 1-thẻ không áp được, giữ nguyên doanh thu per-thẻ.`);
      continue;
    }
    // GD cũ thiếu loại thẻ / loại phí (nullable, lịch sử) → không tra được biểu phí theo kỳ → BỎ QUA (không phải
    // phạm vi phí-theo-kỳ; không âm thầm mất tiền vì snapshot cũ giữ nguyên, và health REVENUE_MISMATCH vẫn soi công thức).
    if (t.cardTypeId == null || t.feeTypeId == null) continue;
    const tidRow = tidRows.get(t.tidId);
    if (!tidRow) {
      failed.push({ transactionId: t.id, error: 'TXN_ORPHAN_TID', message: `GD #${t.id} trỏ TID không tồn tại — không tra lại được phí.` });
      continue;
    }
    // [GÓI TZ 11/9] instant THẬT từ txnIsoMap (ORM-read +7h) — biểu phí/weekend theo đúng ngày-giờ bill.
    const at = new Date(isoRecalc.get(t.id) ?? (t.txnDate as Date).toISOString());
    // [Admin Demo 25/9] tính lại phải dùng ĐÚNG đại lý của GD (lô mượn → nhà mượn), nếu không recalc sẽ kéo GD về
    // giá chung của máy và xoá mất giá riêng đã áp cho nhà mượn.
    const resolved = await resolveFeeForTxn(client, tidRow, t.cardTypeId, t.feeTypeId, at, t.customerId ?? null);
    if (!resolved.ok) {
      const rec = { transactionId: t.id, error: resolved.error, message: `GD #${t.id} (${at.toISOString()}): ${resolved.message}` };
      // P5 (audit 20/8 A): NO_ACTUAL_SELL_FEE = GD CŨ ghi bằng niêm yết trước khi bắt buộc giá bán thực tế → SOFT/
      // grandfathered: BỎ QUA (giữ snapshot cũ), KHÔNG đưa vào failed[] (tránh 1 GD cũ rollback cả lệnh đổi phí).
      // Lỗi CỨNG khác (NO_FEE_RATE/NO_SELL_QUOTE/CARD_BANK_MISMATCH/orphan) vẫn fail-closed. Cả 2 đều trả ra (R198).
      if (resolved.error === 'NO_ACTUAL_SELL_FEE') grandfathered.push(rec);
      else failed.push(rec);
      continue;
    }
    const newPartnerMargin = resolved.fee.partnerMarginMilli;
    const newSellMargin = resolved.fee.sellMarginMilli;
    const rev = computeRevenue(Number(t.amount), newPartnerMargin, newSellMargin);

    const same =
      t.partnerMarginMilli === newPartnerMargin &&
      t.sellMarginMilli === newSellMargin &&
      Number(t.revenuePartner) === rev.revenuePartner &&
      Number(t.revenueSell) === rev.revenueSell &&
      Number(t.revenueAmount) === rev.revenueAmount &&
      // MONEY-1 (audit 20/8): phiCaiMay-only drift PHẢI ép update. Trước đây `same` chỉ so margin+revenue* nên
      // biểu phí đổi phiCaiMay mà GIỮ NGUYÊN 2 margin (vd phiMua 1%→1.5% + phiCaiMay 3%→3.5% + phiBan +0.5% để
      // CL_NCC/CL_KH không đổi) khiến snapshot phiCaiMayMilli cũ đóng băng → tất toán NĐT tính SAI tiền về.
      Number(t.phiCaiMayMilli) === resolved.fee.phiCaiMayMilli;
    if (same) continue; // IDEMPOTENT — đã đúng, không đụng, không log.

    await client.transaction.update({
      where: { id: t.id },
      data: {
        partnerMarginMilli: newPartnerMargin,
        sellMarginMilli: newSellMargin,
        // Đồng bộ snapshot phí cài máy (tất toán NĐT theo TID, Admin Demo 11/8): khi tra lại phí đổi margin thì
        // phí cài máy hiệu lực cũng có thể đổi → cập nhật cùng lúc để tiền về tất toán không lệch margin đã ghi.
        phiCaiMayMilli: resolved.fee.phiCaiMayMilli,
        revenuePartner: rev.revenuePartner,
        revenueSell: rev.revenueSell,
        revenueAmount: rev.revenueAmount
      }
    });
    // RevenueRecalcLog: cột tiền int8/BigInt → dùng BigInt() (before đọc từ DB đã là bigint; after là number → BigInt()).
    await client.revenueRecalcLog.create({
      data: {
        transactionId: t.id,
        feeEffectiveFrom: from,
        beforePartnerMargin: t.partnerMarginMilli,
        beforeSellMargin: t.sellMarginMilli,
        beforeRevenueAmount: BigInt(t.revenueAmount as unknown as bigint | number),
        afterPartnerMargin: newPartnerMargin,
        afterSellMargin: newSellMargin,
        afterRevenueAmount: BigInt(rev.revenueAmount),
        reason: scope.reason ?? null,
        actorUserId: scope.actorUserId ?? null
      }
    });
    changed++;
    changedTxns.push({ id: t.id, revenuePartner: rev.revenuePartner, revenueSell: rev.revenueSell, settled: t.settled });
    // [B223 20/11] Đồng bộ LÔ theo giá mới — nếu không, màn Doanh Số giữ số cũ trong khi sổ giao dịch đã đổi.
    const db = await dongBoLo(client, t.id, newSellMargin + resolved.fee.phiCaiMayMilli, scope.actorUserId ?? null);
    if (db.daSua) loDaSua++;
    else if (db.boQua) loBoQua.push(db.boQua);
  }

  // ── ĐỐI CHIẾU SETTLEMENT sau recalc (Admin Demo 11/8) ──
  // Doanh thu đổi có thể khiến: (1) khách/đối tác đã TRẢ DƯ (Σthu > doanh thu mới) → cờ cảnh báo hoàn TAY; (2) cờ
  // `settled` lệch net (giảm phí → net về 0 = phải settled; tăng phí → net > 0 = phải bỏ settled). KHÔNG tự tạo/gỡ
  // bút toán, KHÔNG chuyển tiền — chỉ cảnh báo + đồng bộ cờ trạng thái cho khớp con số.
  const overpaid: RecalcOverpay[] = [];
  let settledFlagFixed = 0;
  if (changedTxns.length > 0) {
    const ids = changedTxns.map((t) => t.id);
    const setts = await client.cashDebtSettlement.groupBy({ by: ['transactionId', 'side'], where: { transactionId: { in: ids } }, _sum: { amount: true } });
    const paid = new Map<string, number>();
    for (const s of setts) paid.set(`${s.transactionId}:${s.side}`, Number(s._sum.amount ?? 0));
    for (const t of changedTxns) {
      const paidPartner = paid.get(`${t.id}:PARTNER`) ?? 0;
      const paidSell = paid.get(`${t.id}:SELL`) ?? 0;
      const overPartner = Math.max(0, paidPartner - t.revenuePartner);
      const overSell = Math.max(0, paidSell - t.revenueSell);
      if (overPartner > 0 || overSell > 0) {
        overpaid.push({ transactionId: t.id, overpaidPartner: overPartner, overpaidSell: overSell, overpaidTotal: overPartner + overSell });
      }
      // Đồng bộ cờ settled với NET mới (khớp cash-entry.ts: fullySettled = remaining ≤ 0 cả 2 side).
      const fullySettled = paidPartner - t.revenuePartner >= 0 && paidSell - t.revenueSell >= 0;
      if (fullySettled !== t.settled) {
        await client.transaction.update({ where: { id: t.id }, data: { settled: fullySettled, settledAt: fullySettled ? new Date() : null } });
        settledFlagFixed++;
      }
    }
  }

  return { ok: failed.length === 0, scanned: inRange.length, changed, failed, grandfathered, overpaid, settledFlagFixed, loDaSua, loBoQua };
}

/** Lỗi để CALLER (setFeeRate/setTidSellFees) rollback tx đổi phí khi recalc có GD không tra lại được (fail-closed). */
export class RecalcAbortError extends Error {
  constructor(public readonly failures: RecalcFailure[]) {
    super('REVENUE_RECALC_FAILED');
    this.name = 'RecalcAbortError';
  }
}
