// ─────────────────────────────────────────────────────────────────────────────
// FACTORY DÙNG CHUNG cho "Db GIẢ in-memory" — gom bản COPY-PASTE ở nhiều file test
// (investor-scope / investor-settlement / investor-report / investor-advance …).
//
// LÝ DO ra đời (bài học 27/8): investorDailyReport migrate fetch GD sang raw SQL
// ($queryRawUnsafe, chống lệch múi giờ Prisma) → 6 test investor-scope rơi
// "$queryRawUnsafe is not a function" vì MỖI file tự chế fake-Db, file này thiếu
// method file kia có. Gom về 1 nguồn → đổi engine/adapter chỉ sửa 1 chỗ, hết
// test-rot âm thầm. (R198: đổi engine/dialect PHẢI test lại từng path.)
//
// GIỮ CHÍNH XÁC hành vi các bản cũ — đây là SUPERSET không làm hụt file nào:
//  • matchWhere: hợp nhất mọi toán tử đang dùng (in / not / gte / lt / contains+mode),
//    có guard Date (v là Date → so eq, KHÔNG rơi nhầm nhánh toán tử). Toán tử không
//    xuất hiện ở một file = no-op cho file đó.
//  • table: findMany + findFirst (orderBy code-asc / id-asc tuỳ opt) — findFirst là
//    superset (file nào không gọi thì bỏ qua).
//  • rawStub: mô phỏng ĐÚNG raw query của investorDailyReport.
//
// BigInt: amount trong seed để literal `…n` (bài học mock bigint) — factory KHÔNG đụng
// kiểu, chỉ so sánh/khớp nên giữ nguyên shape gọi vào.
// ─────────────────────────────────────────────────────────────────────────────
export type Rec = Record<string, unknown>;

/**
 * So khớp 1 hàng với `where` theo shape Prisma mà service phát ra.
 * Hỗ trợ (SUPERSET mọi file đang dùng): eq (scalar, có guard Date) · in · not ·
 * gte · lt · contains (+ mode:'insensitive'). Nhiều toán tử trên cùng 1 key đều áp
 * (vd { gte, lt } = khoảng nửa-mở). Toán tử lạ → bỏ qua (không file nào dùng ở path này).
 */
export function matchWhere(row: Rec, where: Rec): boolean {
  for (const [k, v] of Object.entries(where)) {
    // AND / OR lồng nhau — service phát ra `AND: [...]` từ `dieuKienTimKiem` (tìm kiếm không phân biệt
    // hoa/thường, xem src/tim-kiem-hoa-thuong.ts). Thiếu nhánh này thì Db giả BỎ QUA bộ lọc mà vẫn "xanh".
    if (k === 'AND' || k === 'OR') {
      // Prisma coi `undefined` là "bỏ qua điều kiện" → Db giả phải cư xử y hệt, không được ném.
      if (v == null) continue;
      const ds = (Array.isArray(v) ? v : [v]).filter((w): w is Rec => w != null && typeof w === 'object');
      if (ds.length === 0) continue;
      if (k === 'AND' ? !ds.every((w) => matchWhere(row, w)) : !ds.some((w) => matchWhere(row, w))) return false;
      continue;
    }
    const cell = row[k];
    // v là OBJECT toán tử (không phải Date) → duyệt từng toán tử; ngược lại (scalar/Date) → so eq.
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const cond = v as Rec;
      if ('in' in cond) { if (!(cond['in'] as unknown[]).includes(cell)) return false; }
      if ('not' in cond) { if (cell === cond['not']) return false; } // vd { not: 'REPAYMENT' }
      if ('gte' in cond) { if (!(cell instanceof Date) || cell.getTime() < (cond['gte'] as Date).getTime()) return false; }
      if ('lt' in cond) { if (!(cell instanceof Date) || cell.getTime() >= (cond['lt'] as Date).getTime()) return false; }
      if ('contains' in cond) { // Prisma { contains, mode:'insensitive' } — lọc tên HKD chứa chuỗi
        const ins = cond['mode'] === 'insensitive';
        const needle = ins ? String(cond['contains']).toLowerCase() : String(cond['contains']);
        const hay = ins ? String(cell ?? '').toLowerCase() : String(cell ?? '');
        if (!hay.includes(needle)) return false;
      }
    } else {
      if (cell !== v) return false;
    }
  }
  return true;
}

/**
 * Mô phỏng 2 câu SQL thô mà `src/tim-kiem-hoa-thuong.ts` phát ra:
 *   1. `SELECT 1 AS co FROM pg_collation WHERE collname = $1` → dò collation ICU (giả lập CÓ).
 *   2. `SELECT "id" FROM "<bảng>" WHERE (lower(coalesce("<cột>",'') COLLATE …) LIKE …)` → id khớp từ khoá.
 *
 * `seedTimKiem` là map `tên bảng DB` → mảng bản ghi giả (field viết camelCase như Prisma).
 * Trả `null` khi SQL KHÔNG phải 2 câu trên (để người gọi route tiếp).
 *
 * R198 — nếu đúng là câu tìm kiếm mà test CHƯA khai seed cho bảng đó thì NÉM LỖI RÕ, tuyệt đối
 * không trả `[]` (trả rỗng = bộ lọc âm thầm quét sạch kết quả mà test vẫn "xanh").
 */
export function stubTimKiem(sql: string, params: unknown[], seedTimKiem: Record<string, Rec[]>): unknown[] | null {
  if (/FROM pg_collation/.test(sql)) return [{ co: 1 }];
  const m = /^SELECT "id" FROM "([a-z_][a-z0-9_]*)" WHERE \(/.exec(sql);
  if (!m) return null;
  const bang = m[1]!;
  if (!(bang in seedTimKiem))
    throw new Error(`[fake-db] truy vấn tìm kiếm trên bảng "${bang}" nhưng test chưa khai seedTimKiem cho bảng này — hãy truyền rawStub(txns, advances, { ${bang}: [...] }).`);
  const cot = [...sql.matchAll(/coalesce\("([a-z_][a-z0-9_]*)"/g)].map((x) => x[1]!);
  // Mẫu LIKE luôn có dạng `%<từ khoá đã thoát>%` → gỡ bao %, gỡ ký tự thoát `\` để lấy lại từ khoá gốc.
  const tuKhoa = String(params[0] ?? '').replace(/^%/, '').replace(/%$/, '').replace(/\\([\\%_])/g, '$1').toLowerCase();
  const camel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  return (seedTimKiem[bang] ?? [])
    .filter((r) => cot.some((c) => String(r[camel(c)] ?? '').toLowerCase().includes(tuKhoa)))
    .map((r) => ({ id: r['id'] }));
}

/** Tuỳ chọn cho {@link table}. */
export interface TableOpts {
  /** findMany sắp theo `code` tăng dần (localeCompare) — dùng cho danh sách NĐT. */
  orderByCodeAsc?: boolean;
}

/**
 * Bảng GIẢ READ-ONLY: findMany + findFirst hiểu shape where service phát ra.
 *  • findMany: lọc where → (tuỳ opt) sort code-asc.
 *  • findFirst: lọc where → (nếu orderBy.id='asc') sort id-asc → phần tử đầu hoặc null
 *    (resolveOwnInvestorId dùng). Là SUPERSET — file chỉ gọi findMany thì bỏ qua findFirst.
 *
 * Chữ ký giữ POSITIONAL `orderByCodeAsc` (khớp mọi call-site cũ `table(seed, true)`);
 * cũng nhận object `{ orderByCodeAsc }` cho gọi mới nếu muốn.
 */
export function table(seed: Rec[], orderByCodeAsc: boolean | TableOpts = false) {
  const codeAsc = typeof orderByCodeAsc === 'boolean' ? orderByCodeAsc : !!orderByCodeAsc.orderByCodeAsc;
  return {
    findMany: async (args?: { where?: Rec }) => {
      let out = seed.filter((r) => matchWhere(r, args?.where ?? {})).map((r) => ({ ...r }));
      if (codeAsc) out = out.sort((a, b) => String(a['code']).localeCompare(String(b['code'])));
      return out;
    },
    findFirst: async (args?: { where?: Rec; orderBy?: { id?: 'asc' | 'desc' } }) => {
      let out = seed.filter((r) => matchWhere(r, args?.where ?? {})).map((r) => ({ ...r }));
      if (args?.orderBy?.id === 'asc') out = out.sort((a, b) => Number(a['id']) - Number(b['id']));
      return out[0] ?? null;
    }
  };
}

/**
 * STUB `$queryRawUnsafe` mô phỏng ĐÚNG raw query fetch GD của investorDailyReport
 * (migrate 27/8 chống lệch múi giờ Prisma). Params: ($1 = mảng tid_id, $2 = biên dưới
 * ISO, $3 = biên trên ISO). Lọc transactions: status='POSTED' · còn sống (deletedAt null)
 * · tid_id ∈ $1 · txn_date ∈ [$2,$3) nửa-mở → trả shape {tidId, amount, settled, phiCaiMayMilli}.
 * `phiCaiMayMilli` coalesce ?? null (seed cũ có dòng không set — giữ đúng hành vi report).
 * KHÔNG stub → test rơi "$queryRawUnsafe is not a function".
 */
export function rawStub(transactions: Rec[], advances: Rec[] = [], seedTimKiem: Record<string, Rec[]> = {}) {
  return async (_sql: string, ...params: unknown[]) => {
    // [KẾ TOÁN NĐT 24/11 — L15] resolveScopeInvestorId đọc `SELECT scope_investor_id FROM users WHERE id=$1`.
    // Fake-db KHÔNG gán phạm vi ⇒ trả scope null = "không khóa" (staff) ⇒ hành vi báo cáo/tất toán GIỮ NGUYÊN
    // như trước. (Việc LỌC theo scope thật kiểm bằng harness DB thật scripts/test-ketoan-ndt.mts.) Route TRƯỚC
    // nhánh "fetch GD" để câu này không rơi vào đó rồi .includes trên number → nổ (R198: fake-db drift).
    if (_sql.includes('scope_investor_id')) return [{ scope_investor_id: null }];
    // NHÁNH TÌM KIẾM không phân biệt hoa/thường (src/tim-kiem-hoa-thuong.ts) — phải route TRƯỚC mọi nhánh khác,
    // nếu không câu SQL lạ sẽ rơi vào nhánh "fetch GD" và trả rác (R198: fake-db drift = test xanh giả).
    const kq = stubTimKiem(_sql, params, seedTimKiem);
    if (kq !== null) return kq;
    // NHÁNH investor_advances (Agent-6 1/9 raw ::timestamptz — queryAdvancesInWindow): `investor_id = ANY($1)` +
    // biên `advance_date >=/<` optional + source filter TRONG SQL. Route theo nội dung SQL (fake-db drift lesson R198).
    if (_sql.includes('investor_advances')) {
      // NHÁNH ISO hiển thị (TZ 11/9 Agent 4 — listAdvances đọc to_char UTC text theo id): trả {id, iso}.
      // fake-db không có bệnh adapter → iso = toISOString của Date seed (đúng ngữ nghĩa to_char trên instant lưu).
      if (_sql.includes('AS iso')) { // CHỈ query hiển thị (SELECT id, to_char(...) AS iso WHERE id=ANY) — window query nay CŨNG to_char nhưng alias advance_date
        const advIds = params[0] as number[];
        return advances
          .filter((a) => advIds.includes(a['id'] as number))
          .map((a) => ({ id: a['id'], iso: (a['advanceDate'] as Date).toISOString() }));
      }
      const ids = params[0] as number[];
      let pi = 1, start = -Infinity, end = Infinity;
      if (_sql.includes('advance_date >=')) start = new Date(params[pi++] as string).getTime();
      if (_sql.includes('advance_date <')) end = new Date(params[pi++] as string).getTime();
      const srcNot = /source <> 'REPAYMENT'/.test(_sql), srcEq = /source = 'REPAYMENT'/.test(_sql);
      return advances
        .filter((a) => ids.includes(a['investorId'] as number) && a['deletedAt'] == null
          && (a['advanceDate'] as Date).getTime() >= start && (a['advanceDate'] as Date).getTime() < end
          && (srcNot ? a['source'] !== 'REPAYMENT' : srcEq ? a['source'] === 'REPAYMENT' : true))
        // [GÓI TZ 11/9] window query đọc to_char UTC text → fake trả ISO string (fake không bệnh adapter).
        .map((a) => ({ id: a['id'], investor_id: a['investorId'], amount: a['amount'], advance_date: (a['advanceDate'] as Date).toISOString() }));
    }
    const tidIds = params[0] as number[];
    const start = new Date(params[1] as string).getTime();
    const end = new Date(params[2] as string).getTime();
    return transactions
      .filter((t) => t['status'] === 'POSTED' && t['deletedAt'] == null && tidIds.includes(t['tidId'] as number)
        && (t['txnDate'] as Date).getTime() >= start && (t['txnDate'] as Date).getTime() < end)
      .map((t) => ({
        tidId: t['tidId'], amount: t['amount'], settled: t['settled'],
        phiCaiMayMilli: (t['phiCaiMayMilli'] as number | undefined) ?? null,
        txnDate: t['txnDate'] ?? null, // giữ field cũ (test cũ bỏ qua)
        // [GÓI TZ 11/9] cutoff nay so bằng txnIso (to_char instant thật) — fake không bệnh adapter → toISOString.
        txnIso: t['txnDate'] instanceof Date ? (t['txnDate'] as Date).toISOString() : null
      }));
  };
}


// ─────────────────────────────────────────────────────────────────────────────
// [GÓI TZ 11/9] STUB raw-SQL txn_date dùng chung — mô phỏng ĐÚNG 4 câu raw mới của gói chuẩn hoá txn_date
// (idsTheoTxnDate / txnIsoMap / UPDATE-ép-txn_date / SUM dashboard) trên MẢNG transactions của fake. Fake không
// có bệnh adapter → row.txnDate là instant thật, so thẳng. Thiếu stub = "$queryRawUnsafe is not a function".
// ─────────────────────────────────────────────────────────────────────────────
export interface TxnRowTz { id: number; txnDate: Date; status?: string; deletedAt?: Date | null; revenueAmount?: bigint | number }

/** 1 kỳ GIÁ BÁN THỰC TẾ của TID (bảng `tid_sell_fees`) — engine đọc bằng SQL THÔ, xem chú thích dưới. */
export interface GiaBanThucTeRow {
  // 3 khoá để LỌC — fixture tối giản có thể bỏ trống, khi đó coi như khớp (test đó không phân biệt theo khoá).
  tidId?: number; cardTypeId?: number; feeTypeId?: number;
  phiBan: number; effectiveFrom: Date; deletedAt?: Date | null; customerId?: number | null;
}

/** [B223 20/11] 1 LÔ của fake — engine `dongBoLo` chỉnh tiền lô cho khớp giá mới bằng SQL THÔ. */
export interface LoRowFake {
  loId: number; rowId: number; txnId: number;
  soDong?: number; // số dòng thẻ trong lô (mặc định 1); >1 ⇒ engine PHẢI bỏ qua
  amountBeforeFee: number; feeApplied: number; amountAfterFee: number;
  daDoiSoat?: boolean; // cờ `pos_lot_recon` (ds / refund_done) ⇒ engine PHẢI bỏ qua
}

/** Đổi instant → đúng dạng chuỗi mà câu SQL thật trả về: giờ TƯỜNG Việt Nam + đuôi `+07:00`. */
function chuoiGioVN(d: Date): string {
  return new Date(d.getTime() + 7 * 3600_000).toISOString().replace('Z', '').replace(/$/, '+07:00');
}

export function txnTzRawStub(rows: () => TxnRowTz[], tuyChon?: { giaBanThucTe?: () => GiaBanThucTeRow[] | Promise<GiaBanThucTeRow[]>; giamPhiCuoiTuan?: () => unknown[] | Promise<unknown[]>; lo?: () => LoRowFake[] }): {
  $queryRawUnsafe: (sql: string, ...params: unknown[]) => Promise<unknown[]>;
  $executeRawUnsafe: (sql: string, ...params: unknown[]) => Promise<number>;
  /** Vết `LO_AMOUNT_RECALC` engine đã ghi — để test khẳng định có ghi vết thật. */
  vetLo: Array<{ loId: number; after: string }>;
} {
  const vetLo: Array<{ loId: number; after: string }> = [];
  return {
    $queryRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (sql.includes('to_char(txn_date')) {
        const ids = (params[0] as number[]) ?? [];
        return rows().filter((r) => ids.includes(r.id)).map((r) => ({ id: r.id, iso: r.txnDate.toISOString() }));
      }
      if (sql.includes('install_fee_amount')) {
        // [B312 24/11] recalc hỏi GD MULTI-CARD (install_fee>0 hoặc lô >1 thẻ) để NÉ. Các test recalc
        // đều GD 1 thẻ không install_fee ⇒ không GD nào là multi. Nếu test cấp lô fake >1 thẻ thì lọc.
        const ids = (params[0] as number[]) ?? [];
        const loFake = tuyChon?.lo?.() ?? [];
        const multi = new Set<number>();
        for (const r of rows()) {
          const dong = loFake.filter((l) => (l as { loId?: number; transactionId?: number }).transactionId === r.id);
          const theKhac = new Set(dong.map((l) => (l as { cardTypeId?: number }).cardTypeId));
          if (theKhac.size > 1) multi.add(r.id);
        }
        return ids.filter((id) => multi.has(id)).map((id) => ({ id }));
      }
      if (sql.includes('SELECT id FROM transactions')) {
        let list = rows();
        let i = 0;
        if (sql.includes('>=')) { const gte = new Date(String(params[i++])).getTime(); list = list.filter((r) => r.txnDate.getTime() >= gte); }
        if (sql.includes('txn_date <= ')) { const lte = new Date(String(params[i++])).getTime(); list = list.filter((r) => r.txnDate.getTime() <= lte); }
        else if (sql.includes('txn_date < ')) { const lt = new Date(String(params[i++])).getTime(); list = list.filter((r) => r.txnDate.getTime() < lt); }
        return list.map((r) => ({ id: r.id }));
      }
      if (sql.includes('SUM(revenue_amount)')) {
        const gte = new Date(String(params[0])).getTime(); const lt = new Date(String(params[1])).getTime();
        const sum = rows().filter((r) => (r.status ?? 'POSTED') === 'POSTED' && (r.deletedAt ?? null) === null && r.txnDate.getTime() >= gte && r.txnDate.getTime() < lt)
          .reduce((a, r) => a + BigInt(r.revenueAmount ?? 0), 0n);
        return [{ s: sum }];
      }
      // GIÁ BÁN THỰC TẾ (`tid_sell_fees`): từ 25/9 engine đọc bằng SQL THÔ để lấy cả cột `customer_id`
      // (cột thêm bằng schema-ensure, cố ý không có trong Prisma client). Mock `tidSellFee.findMany` từ đó
      // thành ĐỒ CHẾT — stub này trả [] ⇒ engine tưởng "chưa có giá thực tế" ⇒ NO_ACTUAL_SELL_FEE ⇒ KHÔNG
      // recalc ⇒ 14 case revenue-recalc đỏ CÂM suốt 7 tuần (cổng ship cũng mù nên không ai thấy).
      if (sql.includes('FROM tid_sell_fees')) {
        if (!tuyChon?.giaBanThucTe) {
          throw new Error(
            'txnTzRawStub: engine hỏi GIÁ BÁN THỰC TẾ (tid_sell_fees) nhưng stub CHƯA được cấp dữ liệu. ' +
            'Truyền txnTzRawStub(rows, { giaBanThucTe: () => [...] }) — dùng `() => []` nếu ca này CỐ Ý không có giá thực tế.'
          );
        }
        const [tidId, cardTypeId, feeTypeId] = params as [number, number, number];
        const ds = await tuyChon.giaBanThucTe();
        return ds
          .filter((o) => (o.tidId === undefined || o.tidId === tidId)
            && (o.cardTypeId === undefined || o.cardTypeId === cardTypeId)
            && (o.feeTypeId === undefined || o.feeTypeId === feeTypeId)
            && (o.deletedAt ?? null) === null)
          .map((o) => ({ phi_ban: o.phiBan, customer_id: o.customerId ?? null, effective_from: chuoiGioVN(o.effectiveFrom) }));
      }
      // GIẢM PHÍ CUỐI TUẦN / khuyến mãi (`promo_sell_adjust`): khác giá-bán-thực-tế ở chỗ **bảng rỗng là
      // trạng thái BÌNH THƯỜNG** (không có đợt giảm nào ⇒ delta 0), nên mặc định [] là ĐÚNG nghiệp vụ chứ không
      // phải nuốt lỗi. Ca nào cần đợt giảm thì truyền `giamPhiCuoiTuan`.
      if (sql.includes('FROM promo_sell_adjust') || sql.includes('FROM weekend_sell_adjust')) {
        return tuyChon?.giamPhiCuoiTuan ? await tuyChon.giamPhiCuoiTuan() : [];
      }
      // [B223] LÔ của giao dịch. Fake KHÔNG mô hình hoá lô sẵn: ca nào cần thì truyền `lo`. Trả [] khi không
      // truyền là ĐÚNG nghiệp vụ ("giao dịch này chưa có lô") chứ không phải nuốt lỗi — engine coi như không có
      // gì để chỉnh và đi tiếp, giống hệt GD nhập thẳng không qua bill.
      if (sql.includes('FROM los l JOIN lo_rows r')) {
        const ds = (tuyChon?.lo?.() ?? []).filter((l) => l.txnId === params[0]);
        return ds.map((l) => ({ id: l.loId, so_dong: l.soDong ?? 1, row_id: l.rowId, truoc: String(l.amountBeforeFee) }));
      }
      if (sql.includes('FROM pos_lot_recon')) {
        const l = (tuyChon?.lo?.() ?? []).find((x) => x.loId === params[0]);
        return l?.daDoiSoat ? [{ '?column?': 1 }] : [];
      }
      if (sql.includes('FROM lo_rows WHERE id')) {
        const l = (tuyChon?.lo?.() ?? []).find((x) => x.rowId === params[0]);
        return l ? [{ phi: String(l.feeApplied), sau: String(l.amountAfterFee) }] : [];
      }
      // CẤM nuốt im: câu SQL lạ mà trả [] thì engine hiểu nhầm là "không có dữ liệu" và test XANH SUÔNG —
      // đúng lớp lỗi đã làm hỏng 14 case tiền. Ném lỗi kèm nguyên văn để người viết test bổ sung.
      throw new Error('txnTzRawStub: CHƯA hỗ trợ câu SQL này, bổ sung đi (đừng để test xanh suông): ' + sql);
    },
    $executeRawUnsafe: async (sql: string, ...params: unknown[]) => {
      if (sql.includes('UPDATE transactions SET txn_date')) {
        const row = rows().find((r) => r.id === params[1]);
        if (row) row.txnDate = new Date(String(params[0]));
        return row ? 1 : 0;
      }
      // KHOÁ TƯ VẤN Postgres (`pg_advisory_xact_lock`): trong fake 1 tiến trình không có tranh chấp thật ⇒ no-op
      // là ĐÚNG, không phải nuốt lỗi. Vẫn liệt kê tường minh để không lọt câu khác.
      if (sql.includes('pg_advisory_xact_lock')) return 0;
      // [B223] engine chỉnh tiền lô + ghi vết — sửa THẲNG vào fixture để test đọc lại thấy số mới.
      if (sql.includes('UPDATE lo_rows SET fee_applied')) {
        const l = (tuyChon?.lo?.() ?? []).find((x) => x.rowId === params[2]);
        if (!l) return 0;
        l.feeApplied = Number(params[0]); l.amountAfterFee = Number(params[1]);
        return 1;
      }
      if (sql.includes('UPDATE los SET expected_total_amount')) return 1;
      if (sql.includes('INSERT INTO audit_logs')) {
        vetLo.push({ loId: Number(params[3]), after: String(params[5]) });
        return 1;
      }
      throw new Error('txnTzRawStub: CHƯA hỗ trợ câu SQL (execute) này, bổ sung đi: ' + sql);
    },
    vetLo
  };
}
