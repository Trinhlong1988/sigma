// DOANH SỐ THEO LÔ KẾT TOÁN (Admin Demo 27/8 — "kiểm chứng sâu để fix, cấm lạm dụng bảng tay, cấm đếm đôi").
//
// MODEL ĐÃ CHỨNG MINH TỪ BILL THẬT (không suy luận): mỗi ảnh POS trong nhóm Zalo chứa 1 bill KẾT TOÁN (settlement
// = tổng của 1 LÔ/batch) + CÁC bill LẺ (sale) tạo nên lô đó. Cộng bill lẻ trong lô = ĐÚNG số kết toán:
//   • lô16: 42.358.000 + 47.361.000 = 89.719.000 = SETTLEMENT lô16 ✓
//   • lô20: 23.168.000 + 20.814.000 + 32.208.000 = 76.190.000 = SETTLEMENT lô20 ✓
//   • lô22: 29.413.000 + 15.556.000 + 9.143.000 = 54.112.000 = SETTLEMENT lô22 ✓
// → DOANH SỐ 1 lô = SỐ KẾT TOÁN (nếu đọc được) HOẶC tổng bill lẻ của lô (nếu thiếu kết toán). ĐẾM CẢ HAI = ĐẾM
//   ĐÔI (bug pipeline cũ: cộng riêng bill lẻ + không nhận settlement). Đơn vị doanh số = 1 LÔ, không phải 1 bill.
//
// Bảng tay Admin Demo đếm theo LÔ (81 lô/ngày) khớp CHÍNH XÁC số kết toán per-lô — xác nhận model, KHÔNG import bảng tay.

/** 1 bill vision đọc được từ 1 ảnh (readBillVision). */
export interface VisionBill {
  /** TID chuẩn hoá (đã bỏ hậu tố "-N" biến thể terminal). */
  tid: string;
  /** Số lô/batch (chuỗi, đã bỏ 0 đầu). null nếu bill không in số lô (một số bill MB). */
  batchNumber: string | null;
  type: 'SALE' | 'SETTLEMENT';
  /** Số tiền VND nguyên (gross, trước phí). */
  totalAmount: number;
  /** "dd/mm/yyyy HH:mm[:ss]" giờ THẬT trên bill (để xếp ca + làm txnDate). null nếu không đọc được. */
  dateTime?: string | null;
}

/** 1 lô đã gộp = 1 đơn vị doanh số. */
export interface LotRevenue {
  tid: string;
  /** Số lô; với bill thiếu số lô gộp theo tiền → key tổng hợp "amt:<tiền>". */
  batchNumber: string;
  amount: number;
  /** Nguồn số: 'settlement' (số kết toán) | 'sales' (cộng bill lẻ vì thiếu kết toán). */
  source: 'settlement' | 'sales';
  /** Giờ đại diện của lô (settlement nếu có, else bill lẻ mới nhất) — để xếp ca. null nếu không bill nào có giờ. */
  dateTime: string | null;
  /** Số bill lẻ gộp (0 nếu chỉ có kết toán) — cho QA/đối soát. */
  saleCount: number;
  /** true nếu lô CÓ bill kết toán (dù cũng có lẻ) — QA: lô thiếu kết toán là điểm rủi ro recall. */
  hasSettlement: boolean;
  /** QA CHECKSUM (OCR-03): true khi settlement (đọc được) ≠ tổng bill lẻ → nghi OCR nhầm digit → CẦN ĐỌC LẠI hires.
   *  Caller (reconcile gate / re-OCR driver) dùng cờ này để đọc lại đúng ảnh lệch, KHÔNG đọc lại tất cả (tiết kiệm quota). */
  needsRecheck: boolean;
  /** FIX #4 audit (30/8): lô KHÔNG kết toán mà có ≥2 bill lẻ CÙNG mệnh giá → dedup theo tiền GỘP còn 1 → có thể
   *  ĐẾM THIẾU (nếu là 2 giao dịch THẬT cùng tiền, không phải ảnh forward). Cờ này bật để NGƯỜI SOÁT kiểm tay
   *  (KHÔNG tự cộng thêm — cần SEQ/TRACE mới chắc). `mergedAwayAmount` = số tiền NGHI bị gộp (Σ (count−1)×mệnh giá).
   *  Optional: aggregateLotRevenue LUÔN set; để optional cho fixture/caller cũ khỏi vỡ. */
  suspectDuplicateAmount?: boolean;
  mergedAwayAmount?: number;
}

export interface LotAggregateResult {
  lots: LotRevenue[];
  total: number;
  /** Số lô có kết toán / tổng lô — chỉ số phủ (QA). */
  settlementCoverage: { withSettlement: number; total: number };
}

/**
 * Gộp bill vision → doanh số theo LÔ (model đã chứng minh). KHÔNG đụng DB — hàm THUẦN (test được, golden fixture).
 *
 * Quy tắc:
 *  1. Nhóm theo (tid, batchNumber). Bill thiếu số lô → nhóm dự phòng theo (tid, "amt:<tiền>") để mỗi mệnh giá
 *     riêng là 1 lô (best-effort — không có số lô thì không gộp được nhiều bill khác tiền vào 1 lô; QA sẽ cờ).
 *  2. Trong 1 lô: nếu có ≥1 SETTLEMENT → LẤY số kết toán LỚN NHẤT (authoritative batch total; nhiều ảnh cùng lô
 *     → cùng số). KHÔNG cộng thêm bill lẻ (chống đếm đôi).
 *  3. Không có SETTLEMENT → CỘNG các bill lẻ, DEDUP theo mệnh giá (cùng số tiền trong 1 lô = ảnh lặp/forward,
 *     đếm 1 lần) — khớp cách bảng tay: 1 giao dịch 1 lần.
 *
 * @param bills tất cả bill vision của 1 NGÀY + 1 phạm vi TID (caller tự lọc TID hợp lệ trước).
 */
export function aggregateLotRevenue(bills: VisionBill[]): LotAggregateResult {
  interface Group {
    tid: string;
    batchNumber: string;
    settlement: number; // 0 nếu chưa gặp kết toán
    settlementDateTime: string | null;
    saleByAmount: Map<number, { dateTime: string | null; count: number }>; // mệnh giá → {dateTime, SỐ bill cùng giá}
    absorbedCrossBatch: boolean; // đã HÚT bill lẻ có SỐ LÔ KHÁC settlement (MBV đổi máy: lẻ lô1, settlement lô2/26/28)
  }
  const groups = new Map<string, Group>();
  const batchOf = (b: VisionBill): string => {
    const hasBatch = b.batchNumber != null && String(b.batchNumber).trim() !== '' && String(b.batchNumber) !== '?';
    return hasBatch ? String(b.batchNumber).trim() : `amt:${b.totalAmount}`;
  };
  const getGroup = (tid: string, batch: string): Group => {
    const key = `${tid}|${batch}`;
    let g = groups.get(key);
    if (!g) { g = { tid, batchNumber: batch, settlement: 0, settlementDateTime: null, saleByAmount: new Map(), absorbedCrossBatch: false }; groups.set(key, g); }
    return g;
  };

  // [Admin Demo 6/9 — GỐC "lô trùng khác ngày/lô-1 ma"] GHÉP THEO ẢNH + TID, SETTLEMENT THẮNG. reviewBills gọi PER-ẢNH
  // (1 ảnh 1 lần), nên trong 1 lần gọi = 1 ảnh. MBV: khi đổi TID sang máy khác, SỐ LÔ trên bill LẺ nhảy về 1, KHÁC
  // SỐ LÔ trên phiếu TỔNG KẾT (2/26/28...). Nhóm-theo-(tid,batch) cũ → SALE(lô1) & SETTLEMENT(lô2) TÁCH nhóm → SALE
  // thành "lô-1 ma" tự ghi doanh số (và mọi bill nhỏ dồn vào lô-1 → đè nhau). Nay: PASS-1 dựng lô SETTLEMENT (số lô
  // THẬT); PASS-2 SALE — nếu TID có settlement thì HÚT sale vào settlement (settlement = authority), KHÔNG tạo lô-sale.

  // PASS 1 — SETTLEMENT trước (mỗi số lô kết toán = 1 lô authority; nhiều settlement/TID vẫn tách đúng).
  for (const b of bills) {
    if (b.type !== 'SETTLEMENT') continue;
    const tid = (b.tid ?? '').trim();
    if (!tid || !(b.totalAmount > 0)) continue;
    const g = getGroup(tid, batchOf(b));
    if (b.totalAmount > g.settlement) { g.settlement = b.totalAmount; g.settlementDateTime = b.dateTime ?? g.settlementDateTime; }
  }
  const settlementGroupsByTid = new Map<string, Group[]>();
  for (const g of groups.values()) if (g.settlement > 0) {
    const arr = settlementGroupsByTid.get(g.tid) ?? []; arr.push(g); settlementGroupsByTid.set(g.tid, arr);
  }

  // PASS 2 — SALE. Ghép theo TID: settlement thắng (bất kể số lô lẻ).
  for (const b of bills) {
    if (b.type === 'SETTLEMENT') continue;
    const tid = (b.tid ?? '').trim();
    if (!tid || !(b.totalAmount > 0)) continue;
    const batch = batchOf(b);
    const selfKey = `${tid}|${batch}`;
    const settleGroups = settlementGroupsByTid.get(tid);
    const selfSettle = groups.get(selfKey);
    let target: Group;
    if (selfSettle && selfSettle.settlement > 0) {
      target = selfSettle; // sale CÙNG số lô settlement → nhóm đó (golden cũ: lô22/16/19...)
    } else if (settleGroups && settleGroups.length >= 1) {
      // TID có settlement nhưng sale KHÁC số lô (đổi máy: lẻ lô1 vs settlement lô2) → HÚT vào settlement.
      // Nhiều settlement/TID + sale không khớp lô nào → hút tạm vào settlement đầu (số lô nhỏ nhất) + cờ (mơ hồ, người soát).
      target = settleGroups.length === 1 ? settleGroups[0] : [...settleGroups].sort((a, c) => a.batchNumber.localeCompare(c.batchNumber, undefined, { numeric: true }))[0];
      if (target.batchNumber !== batch) target.absorbedCrossBatch = true;
    } else {
      target = getGroup(tid, batch); // TID KHÔNG có settlement → lô sale riêng (hành vi cũ)
    }
    const ex = target.saleByAmount.get(b.totalAmount);
    if (!ex) target.saleByAmount.set(b.totalAmount, { dateTime: b.dateTime ?? null, count: 1 });
    else { ex.count++; if (ex.dateTime == null && b.dateTime) ex.dateTime = b.dateTime; }
  }

  const lots: LotRevenue[] = [];
  let withSettlement = 0;
  for (const g of groups.values()) {
    const saleAmounts = [...g.saleByAmount.keys()];
    const saleSum = saleAmounts.reduce((s, a) => s + a, 0);

    // CHECKSUM OCR-03: phát hiện phiếu TỔNG bị gán nhầm SALE — nếu 1 mệnh giá SALE == tổng CÁC mệnh giá SALE khác
    // → chính nó là settlement (bị gán nhầm type), LOẠI khỏi tổng (chống cộng đôi: total + các thành phần).
    // BUG 1/9 (Agent-A + LEAD repro): điều kiện `maxSale === saleSum - maxSale` = "max bằng ĐÚNG NỬA tổng" — KHÔNG
    // hiếm với số tròn nghiệp vụ (10+20+30: 30=10+20) → HALVE doanh số THẬT, im lặng. 2 chốt an toàn:
    //  (1) CHỈ suy khi lô KHÔNG có settlement THẬT (g.settlement===0). Có settlement thật thì settlement là AUTHORITY,
    //      TUYỆT ĐỐI không để phép-cộng số học ghi đè (trước đây lô có settlement đúng 60 vẫn bị kéo về 30).
    //  (2) Khi suy-số-học kích hoạt → LUÔN cắm needsRecheck (ambiguous: có thể 3 sale thật, có thể 1 phiếu tổng nhầm)
    //      để cổng reconcile buộc người kiểm tay — KHÔNG bao giờ nuốt câm. Admin Demo: cấm suy luận tiền, phải cờ.
    let hiddenTotal = 0;
    if (saleAmounts.length >= 3 && g.settlement === 0) {
      const maxSale = Math.max(...saleAmounts);
      if (maxSale > 0 && maxSale === saleSum - maxSale) hiddenTotal = maxSale;
    }
    const arithmeticInferredSettlement = hiddenTotal > 0; // suy settlement từ SỐ HỌC (không phải type thật) → phải cờ
    const realSaleSum = hiddenTotal > 0 ? saleSum - hiddenTotal : saleSum; // tổng bill lẻ THẬT (đã loại phiếu tổng nhầm)

    const hasSettlement = g.settlement > 0 || hiddenTotal > 0;
    const settlementVal = Math.max(g.settlement, hiddenTotal);

    let amount: number;
    let source: 'settlement' | 'sales';
    let needsRecheck = false;

    if (settlementVal > 0 && realSaleSum > 0) {
      // Có CẢ settlement lẫn bill lẻ → đối soát. Khớp → dùng settlement (tin cậy). Lệch → nghi OCR nhầm digit.
      if (settlementVal === realSaleSum) {
        amount = settlementVal;
      } else if (g.absorbedCrossBatch) {
        // Bill lẻ HÚT cross-batch (số lô lẻ khác settlement — đổi máy) → SETTLEMENT là AUTHORITY (Admin Demo "settlement
        // thắng"), KHÔNG lấy tổng lẻ (tổng lẻ có thể trộn lô khác trong cùng ảnh). Cờ để người soát.
        amount = settlementVal;
        needsRecheck = true;
      } else {
        // Same-batch: tổng BILL LẺ tin cậy hơn 1 số tổng (nhiều số rõ, ít nhầm) — OCR-03b. + CỜ đọc lại hires.
        amount = realSaleSum;
        needsRecheck = true;
      }
      source = 'settlement';
    } else if (settlementVal > 0) {
      amount = settlementVal; // chỉ có settlement (không đọc được bill lẻ)
      source = 'settlement';
    } else {
      amount = realSaleSum; // chỉ có bill lẻ
      source = 'sales';
    }
    // Suy settlement từ SỐ HỌC (không có phiếu tổng type thật) → LUÔN cờ kiểm tay (ambiguous, chống nuốt câm halve).
    if (arithmeticInferredSettlement) needsRecheck = true;
    if (hasSettlement) withSettlement++;
    if (amount <= 0) continue;
    // FIX #4 — lô KHÔNG kết toán mà có mệnh giá lặp ≥2 → NGHI đếm thiếu (dedup gộp 2 GD thật cùng tiền còn 1).
    const dupEntries = [...g.saleByAmount.entries()].filter(([, v]) => v.count >= 2);
    const suspectDuplicateAmount = settlementVal <= 0 && dupEntries.length > 0;
    const mergedAwayAmount = suspectDuplicateAmount ? dupEntries.reduce((s, [amt, v]) => s + amt * (v.count - 1), 0) : 0;
    lots.push({
      tid: g.tid,
      batchNumber: g.batchNumber,
      amount,
      source,
      dateTime: g.settlementDateTime ?? latestDateTime([...g.saleByAmount.values()].map((v) => v.dateTime)),
      saleCount: g.saleByAmount.size,
      hasSettlement,
      needsRecheck,
      suspectDuplicateAmount,
      mergedAwayAmount
    });
  }
  const total = lots.reduce((s, l) => s + l.amount, 0);
  return { lots, total, settlementCoverage: { withSettlement, total: lots.length } };
}

/** Giờ "mới nhất" trong danh sách chuỗi "dd/mm/yyyy HH:mm[:ss]" (so sánh theo mốc thời gian; null bỏ qua). */
function latestDateTime(list: (string | null)[]): string | null {
  let best: string | null = null;
  let bestMs = -Infinity;
  for (const s of list) {
    const ms = parseBillDateTimeMs(s);
    if (ms != null && ms > bestMs) {
      bestMs = ms;
      best = s;
    }
  }
  // nếu không parse được cái nào nhưng có chuỗi → trả chuỗi đầu tiên không rỗng (giữ thông tin).
  if (best == null) return list.find((s) => s && s.trim() !== '') ?? null;
  return best;
}

/** "dd/mm/yyyy HH:mm[:ss]" → epoch ms (local). null nếu không hợp lệ. Export để caller xếp ca dùng chung. */
export function parseBillDateTimeMs(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(s).trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh, mi, ss] = m;
  const t = new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(mi), Number(ss ?? '0')).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Chuẩn hoá TID: bỏ hậu tố "-N" (biến thể terminal, vd "20280822-1" → "20280822") + trim. */
export function normalizeTid(tid: string | null | undefined): string {
  return String(tid ?? '').trim().replace(/-\d+$/, '');
}
