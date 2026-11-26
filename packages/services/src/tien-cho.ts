// DOANH SỐ TIỀN CHỜ / CÔNG NỢ PHẢI THU ỦY QUYỀN (Admin Demo 24/11) — nghiệp vụ THUẦN (ctx-based), 1 NGUỒN công
// thức cho route /v1/tien-cho. TÁCH HẲN bảng Doanh Số (lô theo ngày, Đối ứng): đây là chế độ NHẬP TỔNG THEO
// THÁNG per (TID × loại thẻ × loại phí ∈ {Tiền chờ=8, Uỷ quyền=9}) → CẤM lẫn vào Doanh Số chung (chống đếm đúp).
//
// CÔNG THỨC TIỀN (reuse luật tiền SigMa — CẤM tự chế):
//   phải_thu/dòng = marginToAmount(doanh_so_truoc_phi, phi_ban_milli − phi_cai_may_milli)
//                 = round(doanhSo × (phíBán − phíCài) / 100000).
//   Tổng/TID = Σ theo từng loại thẻ. Tổng màn = Σ mọi TID. (@sigma/business-rules.marginToAmount — cùng khuôn
//   "chênh = (phí bán − phí cài máy) × doanh số".)
//
// NGUỒN PHÍ (snapshot lúc nhập — chốt công nợ, đổi phí sau KHÔNG lùi số đã ghi):
//   • phí bán  = tid_sell_fees.phi_ban  của (tid × thẻ × loại phí), ưu tiên giá RIÊNG của đại lý cầm máy
//                (customer_id = tids.customer_id) rồi tới giá CHUNG (customer_id NULL) — mirror resolveActualSellFee.
//   • phí cài máy = fee_rates.phi_cai_may của (đối tác của TID × thẻ) — CÙNG nguồn phí cài máy bill Đối ứng.
//   • MỐC hiệu lực = kỳ mới nhất bắt đầu ≤ CUỐI THÁNG (giờ VN). [CẦN Admin Demo/LEAD CHỐT: mốc cuối-tháng vs
//     đầu-tháng — xem README cuối file; nếu phí đổi GIỮA tháng thì 1 dòng tổng/tháng chỉ mang 1 mức phí.]
//   • Thiếu phí bán HOẶC phí cài máy tại tháng đó ⇒ FAIL-CLOSED (NO_SELL_FEE / NO_INSTALL_FEE), KHÔNG bịa 0
//     (L8/R198: cấm xanh rỗng / nuốt lỗi).
//
// CHỈ ĐỌC khi báo cáo; GHI chỉ bảng uy_quyen_thang (schema-ensure, raw SQL ngoài Prisma client). Gác quyền ở route.
import { hasPermission } from '@sigma/shared';
import { marginToAmount } from '@sigma/business-rules';
import type { Db } from '@sigma/database';
import type { ServiceCtx } from './customer.js';
import { writeAudit } from './audit.js';

/** Loại phí được phép ở màn này: 8 = Tiền chờ, 9 = Uỷ quyền. */
export const FEE_TYPES_TIEN_CHO = [8, 9] as const;

const RE_THANG = /^\d{4}-(0[1-9]|1[0-2])$/;

/** 'YYYY-MM' → 'YYYY-MM-01' của THÁNG SAU (biên trên nửa-mở, dùng làm mốc resolve phí "cuối tháng" + lọc kỳ). */
function dauThangSau(thang: string): string {
  const y = Number(thang.slice(0, 4));
  const m = Number(thang.slice(5, 7));
  const ny = m === 12 ? y + 1 : y;
  const nm = m === 12 ? 1 : m + 1;
  return `${ny}-${String(nm).padStart(2, '0')}-01`;
}

// ── DTO ──────────────────────────────────────────────────────────────────────────────────────────────
export interface TienChoDongNhap {
  cardTypeId: number;
  doanhSoTruocPhi: number; // VND nguyên ≥ 0
  ghiChu?: string | null;
}
export interface NhapTienChoInput {
  thang: string; // 'YYYY-MM'
  tidId: number;
  feeTypeId: number; // 8 | 9
  dong: TienChoDongNhap[];
}
export interface TienChoDongKetQua {
  id: number;
  cardTypeId: number;
  cardTypeName: string | null;
  doanhSo: number;
  phiBanMilli: number;
  phiCaiMayMilli: number;
  phiBanPct: number;
  phiCaiPct: number;
  phaiThu: number;
}
export interface NhapTienChoResult {
  ok: true;
  data: { thang: string; tidId: number; feeTypeId: number; rows: TienChoDongKetQua[]; tongPhaiThu: number; tongDoanhSo: number };
}
export type NhapResult = NhapTienChoResult | { ok: false; error: string; message?: string };

export interface TienChoChiTietDto {
  id: number;
  thang: string;
  tid: string;
  tidId: number;
  hkd: string | null;
  card: string | null;
  cardTypeId: number;
  loaiPhi: string | null;
  feeTypeId: number;
  daiLy: string | null;
  daiLyId: number | null;
  doiTac: string | null;
  doiTacId: number | null;
  bank: string | null;
  bankId: number | null;
  phiBanPct: number;
  phiCaiPct: number;
  doanhSo: number;
  phaiThu: number;
  ghiChu: string | null;
}
export interface TienChoBaoCaoDto {
  tuThang: string;
  denThang: string;
  theoThang: { thang: string; phaiThu: number; doanhSo: number; soDong: number }[];
  chiTiet: TienChoChiTietDto[];
  tong: { phaiThu: number; doanhSo: number; soDong: number };
  deNghi: {
    theoChuKy: { thang: string; phaiThu: number }[];
    theoDaiLy: { daiLyId: number | null; ten: string; phaiThu: number }[];
  };
}
export type BaoCaoResult = { ok: true; data: TienChoBaoCaoDto } | { ok: false; error: string; message?: string };

export interface TienChoFilter {
  tuThang: string;
  denThang: string;
  tids?: number[];
  cards?: number[];
  daiLy?: number[]; // customer_id (chủ máy / đại lý cầm)
  doiTac?: number[]; // partner_id
  banks?: number[]; // bank_id
  hkd?: string[]; // tids.hkd_name
}

// ── RESOLVE PHÍ (snapshot) ─────────────────────────────────────────────────────────────────────────────
interface SnapshotResult {
  ok: boolean;
  phiBanMilli?: number;
  phiCaiMayMilli?: number;
  error?: 'TID_NOT_FOUND' | 'NO_PARTNER' | 'NO_SELL_FEE' | 'NO_INSTALL_FEE';
  tidPartnerId?: number | null;
  tidCustomerId?: number | null;
}

/**
 * Resolve phí bán + phí cài máy CHỐT lúc nhập cho 1 (tid × thẻ × loại phí) tại THÁNG `thang`.
 * Mốc = kỳ mới nhất bắt đầu < đầu tháng SAU (tức ≤ cuối tháng), giờ VN — mirror biên kỳ nửa-mở kpi/bill.
 */
export async function resolveSnapshotFee(
  db: Db,
  input: { tidId: number; cardTypeId: number; feeTypeId: number; thang: string }
): Promise<SnapshotResult> {
  const bienTren = dauThangSau(input.thang); // 'YYYY-MM-01' tháng sau

  const tidRows = await db.$queryRawUnsafe<Array<{ partner_id: number | null; customer_id: number | null }>>(
    `SELECT partner_id, customer_id FROM tids WHERE id = $1 AND deleted_at IS NULL`,
    input.tidId
  );
  if (tidRows.length === 0) return { ok: false, error: 'TID_NOT_FOUND' };
  const partnerId = tidRows[0]!.partner_id;
  const customerId = tidRows[0]!.customer_id;
  if (partnerId == null) return { ok: false, error: 'NO_PARTNER', tidPartnerId: partnerId, tidCustomerId: customerId };

  // Phí BÁN — ưu tiên giá RIÊNG của đại lý cầm máy, rồi giá CHUNG. effective_from < đầu tháng sau (giờ VN).
  const sellRows = await db.$queryRawUnsafe<Array<{ phi_ban: number }>>(
    `SELECT phi_ban
       FROM tid_sell_fees
      WHERE tid_id = $1 AND card_type_id = $2 AND fee_type_id = $3 AND deleted_at IS NULL
        AND (customer_id IS NULL OR customer_id = $4)
        AND effective_from < ($5::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
      ORDER BY (customer_id IS NOT NULL) DESC, effective_from DESC, id DESC
      LIMIT 1`,
    input.tidId,
    input.cardTypeId,
    input.feeTypeId,
    customerId,
    bienTren
  );
  if (sellRows.length === 0) return { ok: false, error: 'NO_SELL_FEE', tidPartnerId: partnerId, tidCustomerId: customerId };
  const phiBanMilli = Number(sellRows[0]!.phi_ban);

  // Phí CÀI MÁY — fee_rates (đối tác của TID × thẻ), kỳ ≤ cuối tháng.
  const feeRows = await db.$queryRawUnsafe<Array<{ phi_cai_may: number }>>(
    `SELECT phi_cai_may
       FROM fee_rates
      WHERE partner_id = $1 AND card_type_id = $2 AND deleted_at IS NULL
        AND effective_from < ($3::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
      ORDER BY effective_from DESC, id DESC
      LIMIT 1`,
    partnerId,
    input.cardTypeId,
    bienTren
  );
  if (feeRows.length === 0) return { ok: false, error: 'NO_INSTALL_FEE', tidPartnerId: partnerId, tidCustomerId: customerId };
  const phiCaiMayMilli = Number(feeRows[0]!.phi_cai_may);

  return { ok: true, phiBanMilli, phiCaiMayMilli, tidPartnerId: partnerId, tidCustomerId: customerId };
}

/** milli (×1000) → % với tối đa 3 số lẻ (để hiển thị / Excel). */
function milliToPct(milli: number): number {
  return Number((milli / 1000).toFixed(3));
}

// ── NHẬP / SỬA (upsert theo khoá chống trùng) ───────────────────────────────────────────────────────────
/**
 * Ghi 1 "bill tổng tháng" uỷ quyền: với MỖI dòng (loại thẻ) → resolve snapshot phí → tính phải thu → UPSERT
 * vào uy_quyen_thang (1 dòng sống / tid×thẻ×loại phí×tháng). Gác REVENUE_MANAGE (route cũng gác — 2 lớp).
 */
export async function nhapTienCho(ctx: ServiceCtx, input: NhapTienChoInput): Promise<NhapResult> {
  if (!hasPermission(ctx.user, 'REVENUE_MANAGE')) {
    return { ok: false, error: 'FORBIDDEN', message: 'Tài khoản không có quyền ghi doanh số tiền chờ.' };
  }
  const thang = (input.thang ?? '').trim();
  if (!RE_THANG.test(thang)) return { ok: false, error: 'VALIDATION', message: 'Tháng phải có dạng YYYY-MM.' };
  if (!Number.isInteger(input.tidId) || input.tidId <= 0) return { ok: false, error: 'VALIDATION', message: 'Thiếu TID.' };
  if (!FEE_TYPES_TIEN_CHO.includes(input.feeTypeId as 8 | 9)) {
    return { ok: false, error: 'VALIDATION', message: 'Loại phí màn này chỉ nhận Tiền chờ (8) hoặc Uỷ quyền (9).' };
  }
  const dong = Array.isArray(input.dong) ? input.dong : [];
  if (dong.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa có dòng loại thẻ nào để ghi.' };
  // Chống 2 dòng CÙNG loại thẻ trong 1 lần ghi (sẽ đụng khoá unique + gây nhầm tổng).
  const seen = new Set<number>();
  for (const d of dong) {
    if (!Number.isInteger(d.cardTypeId) || d.cardTypeId <= 0) return { ok: false, error: 'VALIDATION', message: 'Dòng thiếu loại thẻ.' };
    if (seen.has(d.cardTypeId)) return { ok: false, error: 'VALIDATION', message: 'Trùng loại thẻ trong cùng một lần ghi — gộp lại thành 1 dòng.' };
    seen.add(d.cardTypeId);
    if (!Number.isFinite(d.doanhSoTruocPhi) || d.doanhSoTruocPhi < 0 || !Number.isInteger(d.doanhSoTruocPhi)) {
      return { ok: false, error: 'VALIDATION', message: 'Doanh số trước phí phải là số nguyên ≥ 0.' };
    }
  }

  const db = ctx.db;
  const userId = ctx.user.id;

  // [vá audit F1+F2] PHA 1 — resolve phí + validate HẾT mọi dòng TRƯỚC khi ghi (chưa đụng DB). Nếu 1 dòng hỏng thì
  // KHÔNG dòng nào được ghi (chống tiền-mồ-côi do partial-write giữa chừng). F2: margin ÂM (phí bán < phí cài) →
  // FAIL-CLOSED, cấm ghi số phải-thu âm (nếu không sẽ net làm tụt tổng công nợ + "đề nghị thanh toán" âm, câm).
  const chuanBi: Array<{ d: (typeof dong)[number]; phiBanMilli: number; phiCaiMayMilli: number; phaiThu: number; cardName: string | null; ghiChu: string | null }> = [];
  for (const d of dong) {
    const snap = await resolveSnapshotFee(db, { tidId: input.tidId, cardTypeId: d.cardTypeId, feeTypeId: input.feeTypeId, thang });
    if (!snap.ok) {
      const msg =
        snap.error === 'TID_NOT_FOUND' ? 'Không tìm thấy TID.'
        : snap.error === 'NO_PARTNER' ? 'TID chưa gán đối tác → không tra được phí cài máy.'
        : snap.error === 'NO_SELL_FEE' ? `TID chưa khai phí bán (loại phí ${input.feeTypeId}) cho loại thẻ ${d.cardTypeId} tại tháng ${thang}.`
        : `Đối tác của TID chưa khai phí cài máy cho loại thẻ ${d.cardTypeId} tại tháng ${thang}.`;
      return { ok: false, error: snap.error === 'TID_NOT_FOUND' ? 'NOT_FOUND' : 'VALIDATION', message: msg };
    }
    const phiBanMilli = snap.phiBanMilli!;
    const phiCaiMayMilli = snap.phiCaiMayMilli!;
    if (phiBanMilli - phiCaiMayMilli < 0) {
      return { ok: false, error: 'NEGATIVE_MARGIN',
        message: `Loại thẻ ${d.cardTypeId}: phí bán (${milliToPct(phiBanMilli)}%) NHỎ HƠN phí cài máy (${milliToPct(phiCaiMayMilli)}%) → số phải thu sẽ ÂM. Kiểm lại biểu phí trước khi ghi (không ghi số âm).` };
    }
    const cardRow = await db.$queryRawUnsafe<Array<{ name: string }>>(`SELECT name FROM card_types WHERE id = $1`, d.cardTypeId);
    chuanBi.push({
      d, phiBanMilli, phiCaiMayMilli,
      phaiThu: marginToAmount(d.doanhSoTruocPhi, phiBanMilli - phiCaiMayMilli),
      cardName: cardRow[0]?.name ?? null,
      ghiChu: (d.ghiChu ?? '').toString().trim() || null
    });
  }

  // PHA 2 — ghi TẤT CẢ trong 1 $transaction (nguyên tử: trọn bộ hoặc không gì) + audit cùng tx.
  const rows: TienChoDongKetQua[] = [];
  let tongPhaiThu = 0;
  let tongDoanhSo = 0;
  await db.$transaction(async (tx) => {
    const txDb = tx as typeof db;
    for (const c of chuanBi) {
      // UPSERT nguyên tử theo khoá sống (tid, thẻ, loại phí, tháng). ON CONFLICT trỏ đúng partial-unique index.
      const up = await txDb.$queryRawUnsafe<Array<{ id: number }>>(
        `INSERT INTO uy_quyen_thang
           (tid_id, card_type_id, fee_type_id, thang, doanh_so_truoc_phi, phi_ban_milli, phi_cai_may_milli, ghi_chu, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
         ON CONFLICT (tid_id, card_type_id, fee_type_id, thang) WHERE deleted_at IS NULL
         DO UPDATE SET doanh_so_truoc_phi = EXCLUDED.doanh_so_truoc_phi,
                       phi_ban_milli = EXCLUDED.phi_ban_milli,
                       phi_cai_may_milli = EXCLUDED.phi_cai_may_milli,
                       ghi_chu = EXCLUDED.ghi_chu,
                       updated_by = $9, updated_at = now()
         RETURNING id`,
        input.tidId, c.d.cardTypeId, input.feeTypeId, thang, c.d.doanhSoTruocPhi,
        c.phiBanMilli, c.phiCaiMayMilli, c.ghiChu, userId
      );
      rows.push({
        id: Number(up[0]?.id ?? 0),
        cardTypeId: c.d.cardTypeId,
        cardTypeName: c.cardName,
        doanhSo: c.d.doanhSoTruocPhi,
        phiBanMilli: c.phiBanMilli,
        phiCaiMayMilli: c.phiCaiMayMilli,
        phiBanPct: milliToPct(c.phiBanMilli),
        phiCaiPct: milliToPct(c.phiCaiMayMilli),
        phaiThu: c.phaiThu
      });
      tongPhaiThu += c.phaiThu;
      tongDoanhSo += c.d.doanhSoTruocPhi;
    }
    await writeAudit(txDb, {
      actorUserId: userId,
      action: 'UY_QUYEN_THANG_SET',
      targetType: 'UyQuyenThang',
      targetId: `${input.tidId}:${input.feeTypeId}:${thang}`,
      after: { thang, tidId: input.tidId, feeTypeId: input.feeTypeId, soDong: rows.length, tongPhaiThu, tongDoanhSo }
    });
  });

  return { ok: true, data: { thang, tidId: input.tidId, feeTypeId: input.feeTypeId, rows, tongPhaiThu, tongDoanhSo } };
}

// ── XOÁ MỀM 1 dòng ──────────────────────────────────────────────────────────────────────────────────────
export async function xoaTienCho(ctx: ServiceCtx, id: number): Promise<{ ok: true } | { ok: false; error: string; message?: string }> {
  if (!hasPermission(ctx.user, 'REVENUE_MANAGE')) {
    return { ok: false, error: 'FORBIDDEN', message: 'Tài khoản không có quyền xoá doanh số tiền chờ.' };
  }
  if (!Number.isInteger(id) || id <= 0) return { ok: false, error: 'VALIDATION', message: 'Thiếu mã dòng cần xoá.' };
  const res = await ctx.db.$executeRawUnsafe(
    `UPDATE uy_quyen_thang SET deleted_at = now(), updated_by = $2, updated_at = now() WHERE id = $1 AND deleted_at IS NULL`,
    id,
    ctx.user.id
  );
  if (Number(res) === 0) return { ok: false, error: 'NOT_FOUND', message: 'Dòng không tồn tại hoặc đã xoá.' };
  await writeAudit(ctx.db, { actorUserId: ctx.user.id, action: 'UY_QUYEN_THANG_DELETED', targetType: 'UyQuyenThang', targetId: String(id) });
  return { ok: true };
}

// ── BÁO CÁO ──────────────────────────────────────────────────────────────────────────────────────────────
const KHONG_GAN = 'Chưa gán đại lý';

/**
 * Báo cáo gom theo filter (HKD / TID / loại thẻ / đại lý / đối tác / ngân hàng / chu kỳ tháng).
 * phải_thu tính TỪ SNAPSHOT đã chốt (phi_ban_milli − phi_cai_may_milli) × doanh số, qua marginToAmount.
 * Gác REVENUE_VIEW (route cũng gác). CHỈ ĐỌC.
 */
export async function baoCaoTienCho(ctx: ServiceCtx, filter: TienChoFilter): Promise<BaoCaoResult> {
  if (!hasPermission(ctx.user, 'REVENUE_VIEW') && !hasPermission(ctx.user, 'REVENUE_MANAGE')) {
    return { ok: false, error: 'FORBIDDEN', message: 'Tài khoản không có quyền xem doanh số tiền chờ.' };
  }
  const tuThang = (filter.tuThang ?? '').trim();
  const denThang = (filter.denThang ?? '').trim();
  if (!RE_THANG.test(tuThang) || !RE_THANG.test(denThang)) {
    return { ok: false, error: 'VALIDATION', message: 'Chu kỳ phải có dạng YYYY-MM.' };
  }
  if (tuThang > denThang) return { ok: false, error: 'VALIDATION', message: 'Tháng "từ" phải ≤ tháng "đến".' };

  const db = ctx.db;
  const params: unknown[] = [tuThang, denThang];
  const conds: string[] = ['u.deleted_at IS NULL', 'u.thang >= $1', 'u.thang <= $2'];
  const addArr = (ids: number[] | undefined, col: string, cast: 'int' | 'text'): void => {
    if (!ids || ids.length === 0) return;
    params.push(ids);
    conds.push(`${col} = ANY($${params.length}::${cast}[])`);
  };
  addArr(filter.tids, 'u.tid_id', 'int');
  addArr(filter.cards, 'u.card_type_id', 'int');
  addArr(filter.daiLy, 't.customer_id', 'int');
  addArr(filter.doiTac, 't.partner_id', 'int');
  addArr(filter.banks, 't.bank_id', 'int');
  if (filter.hkd && filter.hkd.length > 0) {
    params.push(filter.hkd);
    conds.push(`t.hkd_name = ANY($${params.length}::text[])`);
  }

  const rawRows = await db.$queryRawUnsafe<
    Array<{
      id: number;
      thang: string;
      doanh_so: string;
      phi_ban_milli: number;
      phi_cai_may_milli: number;
      fee_type_id: number;
      tid: string | null;
      tid_id: number;
      hkd: string | null;
      dai_ly_id: number | null;
      dai_ly: string | null;
      doi_tac_id: number | null;
      doi_tac: string | null;
      bank_id: number | null;
      bank: string | null;
      card: string | null;
      card_type_id: number;
      loai_phi: string | null;
      ghi_chu: string | null;
    }>
  >(
    `SELECT u.id, u.thang, u.doanh_so_truoc_phi::text AS doanh_so, u.phi_ban_milli, u.phi_cai_may_milli,
            u.fee_type_id, u.card_type_id, u.ghi_chu,
            t.id AS tid_id, t.tid, t.hkd_name AS hkd,
            t.customer_id AS dai_ly_id, t.partner_id AS doi_tac_id, t.bank_id,
            COALESCE(NULLIF(TRIM(c.nickname), ''), c.full_name) AS dai_ly,
            p.name AS doi_tac,
            COALESCE(NULLIF(b.code, ''), b.name) AS bank,
            ct.name AS card,
            ft.name AS loai_phi
       FROM uy_quyen_thang u
       LEFT JOIN tids t       ON t.id = u.tid_id
       LEFT JOIN customers c  ON c.id = t.customer_id
       LEFT JOIN partners p   ON p.id = t.partner_id
       LEFT JOIN banks b      ON b.id = t.bank_id
       LEFT JOIN card_types ct ON ct.id = u.card_type_id
       LEFT JOIN fee_types ft  ON ft.id = u.fee_type_id
      WHERE ${conds.join(' AND ')}
      ORDER BY u.thang ASC, t.tid ASC, ct.name ASC, u.id ASC`,
    ...params
  );

  const chiTiet: TienChoChiTietDto[] = [];
  const theoThangMap = new Map<string, { phaiThu: number; doanhSo: number; soDong: number }>();
  const daiLyMap = new Map<number, { ten: string; phaiThu: number }>();
  let tongPhaiThu = 0;
  let tongDoanhSo = 0;

  for (const r of rawRows) {
    const doanhSo = Number(r.doanh_so);
    const phiBanMilli = Number(r.phi_ban_milli);
    const phiCaiMilli = Number(r.phi_cai_may_milli);
    const phaiThu = marginToAmount(doanhSo, phiBanMilli - phiCaiMilli);
    chiTiet.push({
      id: Number(r.id), // bigint → string qua driver; ép Number để DTO.id là number thật (nút Xoá dùng)
      thang: r.thang,
      tid: r.tid ?? '',
      tidId: r.tid_id,
      hkd: r.hkd,
      card: r.card,
      cardTypeId: r.card_type_id,
      loaiPhi: r.loai_phi,
      feeTypeId: r.fee_type_id,
      daiLy: r.dai_ly,
      daiLyId: r.dai_ly_id,
      doiTac: r.doi_tac,
      doiTacId: r.doi_tac_id,
      bank: r.bank,
      bankId: r.bank_id,
      phiBanPct: milliToPct(phiBanMilli),
      phiCaiPct: milliToPct(phiCaiMilli),
      doanhSo,
      phaiThu,
      ghiChu: r.ghi_chu
    });
    tongPhaiThu += phaiThu;
    tongDoanhSo += doanhSo;

    const tm = theoThangMap.get(r.thang) ?? { phaiThu: 0, doanhSo: 0, soDong: 0 };
    tm.phaiThu += phaiThu;
    tm.doanhSo += doanhSo;
    tm.soDong += 1;
    theoThangMap.set(r.thang, tm);

    const key = r.dai_ly_id ?? -1;
    const ten = r.dai_ly_id != null ? r.dai_ly ?? '#' + r.dai_ly_id : KHONG_GAN;
    const dl = daiLyMap.get(key) ?? { ten, phaiThu: 0 };
    dl.phaiThu += phaiThu;
    daiLyMap.set(key, dl);
  }

  const theoThang = [...theoThangMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([thang, v]) => ({ thang, phaiThu: v.phaiThu, doanhSo: v.doanhSo, soDong: v.soDong }));
  const deNghiTheoDaiLy = [...daiLyMap.entries()]
    .map(([key, v]) => ({ daiLyId: key === -1 ? null : key, ten: v.ten, phaiThu: v.phaiThu }))
    .sort((a, b) => {
      if ((a.daiLyId == null) !== (b.daiLyId == null)) return a.daiLyId == null ? 1 : -1;
      return b.phaiThu - a.phaiThu;
    });

  return {
    ok: true,
    data: {
      tuThang,
      denThang,
      theoThang,
      chiTiet,
      tong: { phaiThu: tongPhaiThu, doanhSo: tongDoanhSo, soDong: chiTiet.length },
      deNghi: {
        theoChuKy: theoThang.map((t) => ({ thang: t.thang, phaiThu: t.phaiThu })),
        theoDaiLy: deNghiTheoDaiLy
      }
    }
  };
}

// ── README QUYẾT ĐỊNH CẦN QUAN TRI/LEAD CHỐT (flag để duyệt khi nhìn ảnh) ─────────────────────────────────
//  (A) NGUỒN PHÍ CÀI MÁY: fee_rates.phi_cai_may theo (đối tác của TID × loại thẻ × kỳ) — CÙNG nguồn bill Đối
//      ứng (xem kpi-doanh-so.ts / investor-report.ts). Nếu Admin Demo muốn nguồn khác → đổi resolveSnapshotFee.
//  (B) MỐC HIỆU LỰC PHÍ cho 1 bill tổng-THÁNG: dùng kỳ mới nhất bắt đầu ≤ CUỐI tháng (giờ VN). Nếu phí đổi
//      GIỮA tháng, 1 dòng tổng/tháng chỉ mang 1 mức phí (snapshot) — cần Admin Demo xác nhận có cần tách nửa tháng.
//  (C) CÔNG NỢ: phase này là BÁO CÁO standalone (KHÔNG sinh bút toán / cash-entry / công nợ đại lý). Nối hệ
//      công nợ (transactions.settled / CashEntry DEBT_*) để SAU, khi Admin Demo duyệt.
