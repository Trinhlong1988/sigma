// KPI DOANH SỐ — tab full-view màn Doanh Số (Admin Demo 24/11).
// Nghiệp vụ THUẦN (ctx-based), 1 NGUỒN công thức cho route /v1/kpi/doanh-so. CHỈ ĐỌC (SELECT), không ghi.
//
// MỤC TIÊU & BẤT BIẾN (để LEAD đối chiếu):
//  • theoNgay: mỗi NGÀY có bill trong khoảng [from,to] = 1 cột (doanh số quẹt = Σ amount_before_fee).
//  • theoDaiLy: doanh số + lãi kỳ của TỪNG đại lý + đếm POS (đang cầm / không chạy / thấp / đạt hạn mức).
//  • Σ doanh số (theoNgay) == Σ doanh số (theoDaiLy) == tongDoanhSo == tổng bảng Doanh Số cùng kỳ.
//    (mỗi lô đếm ĐÚNG 1 lần — biên kỳ NỬA MỞ giờ VN y hệt /v1/bills/manual, status<>'CANCELLED').
//
// QUY ƯỚC ĐẠI LÝ (khác bảng Doanh Số 1 điểm, ĐÃ GHI cho LEAD duyệt):
//  • KPI gom theo CHỦ MÁY (tids.customer_id) để doanh số/lãi/POS của mỗi đại lý TỰ NHẤT QUÁN
//    (doanh số đại lý = Σ doanh số các POS của đại lý đó). Bảng Doanh Số gom lô MƯỢN theo người MƯỢN;
//    KPI gom theo chủ máy. TỔNG hai bên vẫn bằng nhau (mỗi lô đếm 1 lần). Lô không có TID/chủ máy
//    rơi vào nhóm "Chưa gán đại lý" (KHÔNG bỏ sót — luật "không nuốt dòng nào").
//
// LÃI KỲ: dùng ĐÚNG công thức "Chênh lệch sau bán (lãi kỳ)" đang hiện trên màn Doanh Số
//  = Σ doanh_số × (phí_bán − phí_mua_đối_tác). Bill thiếu % phí ⇒ KHÔNG cộng 0 câm mà đếm vào
//  `soBillChuaKhaiLai` (báo rõ, đúng L8). (Nếu Admin Demo muốn "Lãi SigMa thu" B236 thì đổi 1 chỗ — xem README.)
//
// NGƯỠNG POS (Admin Demo 24/11 — 1 ngưỡng CHUNG mọi bank):
//  • THẤP: doanh số QUY ĐỔI/tháng < 5 tỉ.   • ĐẠT HẠN MỨC: ≥ 13 tỉ/tháng.
//  • Quy đổi tháng = doanh_số_trong_kỳ ÷ số_ngày_kỳ × 30 (chuẩn hoá 30 ngày) — để so ngưỡng "tháng"
//    khi khoảng chọn ≠ 1 tháng. TRẢ VỀ CẢ số thật trong kỳ LẪN số quy đổi để UI ghi nhãn tường minh.
//  • POS "không chạy" = TID ĐANG hoạt động (đang cầm) nhưng 0 bill trong kỳ (mục riêng, KHÔNG tính vào THẤP).

import type { ServiceCtx } from './customer.js';

export interface KpiNgayDto {
  ngay: string; // YYYY-MM-DD (giờ VN)
  doanhSo: number;
  soBill: number;
}

export interface KpiPosDto {
  tid: string;
  doanhSoKy: number; // doanh số THẬT trong kỳ (VND)
  doanhSoThang: number; // quy đổi /tháng (chuẩn hoá 30 ngày) — số dùng để so ngưỡng
  soBill: number;
  // 'da_thu_hoi' [vá audit F1]: TID ĐÃ THU HỒI/đóng/xoá-mềm NHƯNG có doanh số trong kỳ (máy thu hồi giữa kỳ).
  // Phải hiện để header.doanhSo == Σ chiTietPos.doanhSoKy (không lệch câm); KHÔNG tính vào posCam (không còn cầm).
  // 'moi_giao' [vá audit F3]: POS GIAO TRONG KỲ (delivered_at ≥ đầu kỳ) → chạy ít là bình thường, KHÔNG báo
  // "thấp"/"không chạy" oan. Vẫn tính posCam; nếu đạt ≥13 tỉ thì vẫn 'dat_han_muc'.
  phanLoai: 'khong_chay' | 'thap' | 'dat_han_muc' | 'binh_thuong' | 'da_thu_hoi' | 'moi_giao';
}

export interface KpiDaiLyDto {
  daiLyId: number | null; // null = nhóm "Chưa gán đại lý"
  ten: string;
  doanhSo: number;
  lai: number; // lãi kỳ = Σ doanh số × (phí bán − phí mua đối tác)
  soBillChuaKhaiLai: number; // bill thiếu % phí ⇒ chưa tính được lãi (không cộng 0 câm)
  posCam: number; // số POS (TID ACTIVE) đang cầm
  posKhongChay: number; // POS 0 bill trong kỳ
  posThap: number; // POS quy đổi < 5 tỉ/tháng (và có chạy, KHÔNG phải mới giao)
  posDatHanMuc: number; // POS quy đổi ≥ 13 tỉ/tháng
  posMoiGiao: number; // POS giao TRONG kỳ — chạy ít là bình thường, không báo thấp/không-chạy oan
  chiTietPos: KpiPosDto[];
}

export interface KpiDoanhSoDto {
  from: string;
  to: string;
  ca: number | null; // null = mọi ca
  soNgayKy: number;
  heSoQuyDoiThang: number; // 30 / soNgayKy
  nguongThapThang: number; // 5 tỉ
  nguongHanMucThang: number; // 13 tỉ
  tongDoanhSo: number;
  tongLai: number;
  soBillChuaKhaiLai: number;
  soBill: number;
  theoNgay: KpiNgayDto[];
  theoDaiLy: KpiDaiLyDto[];
}

export type KpiResult =
  | { ok: true; data: KpiDoanhSoDto }
  | { ok: false; error: string; message?: string };

export const NGUONG_THAP_THANG = 5_000_000_000; // 5 tỉ/tháng
export const NGUONG_HAN_MUC_THANG = 13_000_000_000; // 13 tỉ/tháng
const NGAY_CHUAN = 30; // chuẩn hoá quy đổi tháng

const RE_NGAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * QUY ĐỔI doanh số trong kỳ → doanh số/tháng (chuẩn hoá 30 ngày) để so ngưỡng "tháng" khi kỳ ≠ 1 tháng.
 * doanhSoKy ÷ soNgayKy × 30. soNgayKy luôn ≥ 1. Làm tròn về đồng.
 */
export function quyDoiThang(doanhSoKy: number, soNgayKy: number): number {
  const n = soNgayKy >= 1 ? soNgayKy : 1;
  return Math.round((doanhSoKy / n) * NGAY_CHUAN);
}

/**
 * PHÂN LOẠI 1 POS theo doanh số TRONG KỲ + số bill + số ngày kỳ (Admin Demo 24/11, 1 ngưỡng CHUNG mọi bank):
 *  • 0 bill                     → 'khong_chay' (mục riêng, KHÔNG tính là thấp).
 *  • quy đổi/tháng ≥ 13 tỉ      → 'dat_han_muc'.
 *  • quy đổi/tháng < 5 tỉ        → 'thap'.
 *  • còn lại                    → 'binh_thuong'.
 * (ĐẠT HẠN MỨC kiểm TRƯỚC THẤP là vô hại vì 13 tỉ > 5 tỉ — nhưng giữ đúng thứ tự ngữ nghĩa.)
 */
export function phanLoaiPos(
  doanhSoKy: number,
  soBill: number,
  soNgayKy: number,
  moiGiao = false // [vá F3] POS giao trong kỳ → không gắn thấp/không-chạy oan
): KpiPosDto['phanLoai'] {
  const thang = quyDoiThang(doanhSoKy, soNgayKy);
  // ĐẠT HẠN MỨC kiểm trước: POS mới giao mà đã ≥13 tỉ thì vẫn phải cảnh báo đạt hạn mức.
  if (soBill > 0 && thang >= NGUONG_HAN_MUC_THANG) return 'dat_han_muc';
  if (moiGiao) return 'moi_giao'; // giao trong kỳ, chưa tới hạn mức → bình thường (không báo thấp/không-chạy)
  if (soBill <= 0) return 'khong_chay';
  if (thang < NGUONG_THAP_THANG) return 'thap';
  return 'binh_thuong';
}

/** Số ngày INCLUSIVE giữa 2 ngày YYYY-MM-DD (tính bằng UTC để không dính DST). ≥ 1. */
function soNgayInclusive(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  const d = Math.floor((b - a) / 86_400_000) + 1;
  return d >= 1 ? d : 1;
}

/** Phút-trong-ngày từ chuỗi giờ 'HH:MM' (giờ VN đã quy sẵn trong SQL). Đọc không ra → null. */
function phutCuaGio(gio: string | null | undefined): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec((gio ?? '').trim());
  if (!m) return null;
  const p = Number(m[1]) * 60 + Number(m[2]);
  return p >= 0 && p <= 1439 ? p : null;
}

// Mốc ca CỨNG (fallback) — ĐỒNG BỘ với packages/services/src/ca-tien.ts + màn Doanh Số (caCuaBill):
//   MB 09:40/16:40 · ABB 09:50/14:50 · MBV 11:50/17:50. Bank ngoài bảng → null (không xếp ca).
const MOC_CA_CUNG: Record<string, [number, number]> = {
  MB: [9 * 60 + 40, 16 * 60 + 40],
  MBB: [9 * 60 + 40, 16 * 60 + 40],
  ABB: [9 * 60 + 50, 14 * 60 + 50],
  MBV: [11 * 60 + 50, 17 * 60 + 50]
};
function khoaBankCa(bank: string | null | undefined): string | null {
  const b = (bank ?? '').trim().toUpperCase();
  if (!b) return null;
  if (b === 'MBV' || b.startsWith('MBV')) return 'MBV';
  if (b === 'ABB' || b.startsWith('ABB') || b === 'AB BANK' || b.startsWith('AB ')) return 'ABB';
  if (b === 'MB' || b === 'MBB' || b.startsWith('MB ') || b === 'MBBANK') return 'MB';
  return null;
}

/**
 * THỨ TỰ CA (1-based) của 1 bill. MIRROR `caCuaBill` màn Doanh Số: ưu tiên mốc ca KHAI ở màn Quản Lý
 * Ngân Hàng (bank_ca_tien của chính bank), bank chưa khai ca thì rơi về mốc CỨNG MB/ABB/MBV.
 * Không đọc được giờ / bank ngoài bảng và chưa khai ca → null (lọc ca bỏ qua, đúng hành vi cũ).
 */
function thuTuCa(
  bankCode: string | null | undefined,
  gio: string | null | undefined,
  dsCa: { tuPhut: number; denPhut: number }[] | undefined
): number | null {
  const phut = phutCuaGio(gio);
  if (phut == null) return null;
  if (dsCa && dsCa.length > 0) {
    const sx = [...dsCa].sort((a, b) => a.tuPhut - b.tuPhut);
    const i = sx.findIndex((c) => phut >= c.tuPhut && phut <= c.denPhut);
    return i >= 0 ? i + 1 : null;
  }
  const k = khoaBankCa(bankCode);
  if (!k) return null;
  const [c1, c2] = MOC_CA_CUNG[k];
  return phut <= c1 ? 1 : phut <= c2 ? 2 : 3;
}

interface LoRow {
  lo_id: number;
  ngay: string;
  gio: string | null;
  bank_id: number | null;
  bank: string | null;
  dai_ly_id: number | null;
  dai_ly: string | null;
  tid_id: number | null;
  tid: string | null;
  truoc: string;
  sau: string;
  so_the: number;
  sell_margin_milli: number | null;
  phi_cai_may_milli: number | null;
  phi_mua_milli: number | null;
}

const KHONG_GAN = 'Chưa gán đại lý';

/**
 * KPI DOANH SỐ theo kỳ [from,to] + (tuỳ chọn) ca. Gác quyền (REVENUE_VIEW) ở route — service THUẦN đọc sổ.
 */
export async function kpiDoanhSo(
  ctx: ServiceCtx,
  input: { from: string; to: string; ca?: number | null }
): Promise<KpiResult> {
  const from = (input.from ?? '').trim();
  const to = (input.to ?? '').trim();
  if (!RE_NGAY.test(from) || !RE_NGAY.test(to)) {
    return { ok: false, error: 'VALIDATION', message: 'Kỳ xem phải có dạng YYYY-MM-DD.' };
  }
  if (from > to) {
    return { ok: false, error: 'VALIDATION', message: 'Ngày "từ" phải ≤ ngày "đến".' };
  }
  const ca = input.ca != null && Number.isInteger(input.ca) && input.ca >= 1 && input.ca <= 9 ? input.ca : null;
  const db = ctx.db;

  const soNgayKy = soNgayInclusive(from, to);
  const heSo = NGAY_CHUAN / soNgayKy;

  // Mốc ca KHAI theo bank (bank_ca_tien) — để tính ca GIỐNG màn Doanh Số (custom shift trước, cứng sau).
  const caRows = await db.$queryRawUnsafe<Array<{ bank_id: number; tu_phut: number; den_phut: number }>>(
    `SELECT bank_id, tu_phut, den_phut FROM bank_ca_tien WHERE deleted_at IS NULL ORDER BY bank_id, thu_tu, tu_phut`
  );
  const caTheoBank = new Map<number, { tuPhut: number; denPhut: number }[]>();
  for (const r of caRows) {
    const arr = caTheoBank.get(r.bank_id) ?? [];
    arr.push({ tuPhut: r.tu_phut, denPhut: r.den_phut });
    caTheoBank.set(r.bank_id, arr);
  }

  // PER-LÔ: cùng biên kỳ + cùng nguồn phí (transactions + fee_rates theo ngày bill) với /v1/bills/manual.
  // Gom theo CHỦ MÁY (c = customers của tids.customer_id) — KHÔNG theo người mượn. TID của lô = r.tid_id.
  const rows = await db.$queryRawUnsafe<LoRow[]>(
    `SELECT l.id AS lo_id,
            to_char(COALESCE(l.bill_txn_date, l.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS ngay,
            to_char(COALESCE(l.bill_txn_date, l.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI')    AS gio,
            MIN(t.bank_id)                        AS bank_id,
            COALESCE(NULLIF(b.code, ''), b.name)  AS bank,
            t.customer_id                         AS dai_ly_id,
            COALESCE(NULLIF(TRIM(c.nickname), ''), c.full_name) AS dai_ly,
            t.id                                  AS tid_id,
            t.tid                                 AS tid,
            SUM(r.amount_before_fee)::text        AS truoc,
            SUM(r.amount_after_fee)::text         AS sau,
            COUNT(DISTINCT r.card_type_id)::int   AS so_the,
            MAX(tx.sell_margin_milli)             AS sell_margin_milli,
            MAX(tx.phi_cai_may_milli)             AS phi_cai_may_milli,
            MAX(fm.phi_mua)                       AS phi_mua_milli
       FROM los l
       JOIN lo_rows r      ON r.lo_id = l.id
       LEFT JOIN tids t    ON t.id = r.tid_id
       LEFT JOIN customers c ON c.id = t.customer_id
       LEFT JOIN banks b   ON b.id = t.bank_id
       LEFT JOIN transactions tx ON tx.id = l.transaction_id
       LEFT JOIN LATERAL (
         SELECT fr.phi_mua
           FROM fee_rates fr
          WHERE fr.partner_id = t.partner_id
            AND fr.card_type_id = r.card_type_id
            AND fr.deleted_at IS NULL
            AND fr.effective_from <= COALESCE(l.bill_txn_date, l.created_at)
          ORDER BY fr.effective_from DESC
          LIMIT 1
       ) fm ON TRUE
      WHERE l.status <> 'CANCELLED'
        AND COALESCE(l.bill_txn_date, l.created_at) >= ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
        AND COALESCE(l.bill_txn_date, l.created_at) <  ((($2::date) + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')
      GROUP BY l.id, l.bill_txn_date, l.created_at, t.id, t.tid, t.customer_id,
               c.nickname, c.full_name, b.code, b.name
      ORDER BY ngay ASC, l.id ASC`,
    from,
    to
  );

  // TID ĐANG CẦM (ACTIVE) theo chủ máy — universe của "POS đang cầm" (kể cả TID 0 bill trong kỳ).
  const tidRows = await db.$queryRawUnsafe<
    Array<{ tid_id: number; tid: string | null; dai_ly_id: number | null; dai_ly: string | null; giao_ngay: string | null }>
  >(
    `SELECT t.id AS tid_id, t.tid AS tid, t.customer_id AS dai_ly_id,
            COALESCE(NULLIF(TRIM(c.nickname), ''), c.full_name) AS dai_ly,
            to_char(t.delivered_at AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS giao_ngay
       FROM tids t
       LEFT JOIN customers c ON c.id = t.customer_id
      WHERE t.status = 'ACTIVE' AND t.deleted_at IS NULL`
  );

  // ── GOM ────────────────────────────────────────────────────────────────────────────────────────
  const theoNgayMap = new Map<string, { doanhSo: number; soBill: number }>();
  // per-đại-lý (khoá = dai_ly_id ?? -1 cho nhóm chưa gán)
  const dlMap = new Map<number, { ten: string; doanhSo: number; lai: number; chuaKhai: number }>();
  // per-TID doanh số trong kỳ (SAU lọc ca) — để phân loại POS
  const tidDoanhSo = new Map<number, { doanhSo: number; soBill: number }>();

  let tongDoanhSo = 0;
  let tongLai = 0;
  let tongChuaKhai = 0;
  let soBill = 0;

  for (const x of rows) {
    // Lọc ca (nếu có): bill không xác định được ca hoặc khác ca đang chọn → BỎ.
    if (ca != null) {
      const tc = thuTuCa(x.bank, x.gio, x.bank_id != null ? caTheoBank.get(x.bank_id) : undefined);
      if (tc !== ca) continue;
    }
    const truoc = Number(x.truoc);
    const sau = Number(x.sau);
    soBill += 1;
    tongDoanhSo += truoc;

    // theoNgay
    const n = theoNgayMap.get(x.ngay) ?? { doanhSo: 0, soBill: 0 };
    n.doanhSo += truoc;
    n.soBill += 1;
    theoNgayMap.set(x.ngay, n);

    // per-TID (chỉ gom khi có tid_id — lô không TID rơi vào nhóm chưa gán ở theoDaiLy nhưng không có POS)
    if (x.tid_id != null) {
      const td = tidDoanhSo.get(x.tid_id) ?? { doanhSo: 0, soBill: 0 };
      td.doanhSo += truoc;
      td.soBill += 1;
      tidDoanhSo.set(x.tid_id, td);
    }

    // LÃI KỲ — y hệt màn Doanh Số: phiPct (margin snapshot, else suy từ tiền), muaPct = phí mua đối tác.
    // Lô nhiều thẻ hoặc thiếu % phí mua ⇒ KHÔNG tính (đếm chưaKhai), không cộng 0 câm.
    const multi = x.so_the > 1;
    const muaMilli = x.phi_mua_milli;
    let phiPct: number | null = null;
    if (!multi) {
      if (x.sell_margin_milli != null && x.phi_cai_may_milli != null) {
        phiPct = (Number(x.sell_margin_milli) + Number(x.phi_cai_may_milli)) / 1000;
      } else if (truoc > 0) {
        phiPct = Number((((truoc - sau) / truoc) * 100).toFixed(4));
      }
    }
    const muaPct = !multi && muaMilli != null ? Number(muaMilli) / 1000 : null;

    const key = x.dai_ly_id ?? -1;
    const ten = x.dai_ly_id != null ? x.dai_ly ?? ('#' + x.dai_ly_id) : KHONG_GAN;
    const g = dlMap.get(key) ?? { ten, doanhSo: 0, lai: 0, chuaKhai: 0 };
    g.doanhSo += truoc;
    if (phiPct != null && muaPct != null) {
      g.lai += Math.round((truoc * (phiPct - muaPct) * 1000) / 100000);
    } else {
      g.chuaKhai += 1;
      tongChuaKhai += 1;
    }
    dlMap.set(key, g);
  }

  for (const g of dlMap.values()) tongLai += g.lai;

  // ── PHÂN LOẠI POS theo đại lý (chủ máy) ─────────────────────────────────────────────────────────
  interface PosAgg {
    cam: number;
    khongChay: number;
    thap: number;
    datHanMuc: number;
    moiGiao: number;
    chiTiet: KpiPosDto[];
  }
  const aggMoi = (): PosAgg => ({ cam: 0, khongChay: 0, thap: 0, datHanMuc: 0, moiGiao: 0, chiTiet: [] });
  const posTheoDl = new Map<number, PosAgg>();
  const tenTheoDl = new Map<number, string>();
  for (const t of tidRows) {
    const key = t.dai_ly_id ?? -1;
    if (t.dai_ly_id != null && t.dai_ly) tenTheoDl.set(key, t.dai_ly);
    const agg = posTheoDl.get(key) ?? aggMoi();
    const ds = t.tid_id != null ? tidDoanhSo.get(t.tid_id) : undefined;
    const doanhSoKy = ds?.doanhSo ?? 0;
    const soBillTid = ds?.soBill ?? 0;
    const doanhSoThang = quyDoiThang(doanhSoKy, soNgayKy);
    // [vá F3] POS giao TRONG kỳ (delivered_at ≥ ngày đầu kỳ) → chạy ít là bình thường, không báo thấp/không-chạy oan.
    const moiGiao = t.giao_ngay != null && t.giao_ngay >= from;
    const phanLoai = phanLoaiPos(doanhSoKy, soBillTid, soNgayKy, moiGiao);
    agg.cam += 1;
    if (phanLoai === 'khong_chay') agg.khongChay += 1;
    else if (phanLoai === 'dat_han_muc') agg.datHanMuc += 1;
    else if (phanLoai === 'thap') agg.thap += 1;
    else if (phanLoai === 'moi_giao') agg.moiGiao += 1;
    agg.chiTiet.push({ tid: t.tid ?? '', doanhSoKy, doanhSoThang, soBill: soBillTid, phanLoai });
    posTheoDl.set(key, agg);
  }

  // [vá audit F1 — CAO] TID ĐÃ THU HỒI/đóng/xoá-mềm nhưng CÓ doanh số trong kỳ KHÔNG nằm trong tidRows (ACTIVE),
  // nên doanh số của nó vào header (dlMap) mà MẤT khỏi chiTietPos ⇒ header > Σ chiTiet = LỆCH CÂM (máy thu hồi giữa
  // kỳ là kịch bản THẬT). Đưa các TID đó vào chiTiet dưới cờ 'da_thu_hoi' (KHÔNG tính posCam — không còn cầm máy),
  // lấy tid + đại lý từ chính rows doanh số ⇒ bất biến: header.doanhSo == Σ chiTietPos.doanhSoKy.
  const tidTrongUniverse = new Set<number>(tidRows.map((t) => t.tid_id));
  const tidInfo = new Map<number, { tid: string | null; dai_ly_id: number | null; dai_ly: string | null }>();
  for (const x of rows) {
    if (x.tid_id != null && !tidInfo.has(x.tid_id)) tidInfo.set(x.tid_id, { tid: x.tid, dai_ly_id: x.dai_ly_id, dai_ly: x.dai_ly });
  }
  for (const [tidId, ds] of tidDoanhSo) {
    if (tidTrongUniverse.has(tidId)) continue;
    const info = tidInfo.get(tidId);
    const key = info?.dai_ly_id ?? -1;
    if (info?.dai_ly_id != null && info.dai_ly) tenTheoDl.set(key, info.dai_ly);
    const agg = posTheoDl.get(key) ?? aggMoi();
    agg.chiTiet.push({ tid: info?.tid ?? '', doanhSoKy: ds.doanhSo, doanhSoThang: quyDoiThang(ds.doanhSo, soNgayKy), soBill: ds.soBill, phanLoai: 'da_thu_hoi' });
    posTheoDl.set(key, agg);
  }

  // ── HỢP NHẤT theoDaiLy = (đại lý có doanh số) ∪ (đại lý đang cầm POS) ────────────────────────────
  const tatCaKey = new Set<number>([...dlMap.keys(), ...posTheoDl.keys()]);
  const theoDaiLy: KpiDaiLyDto[] = [];
  for (const key of tatCaKey) {
    const g = dlMap.get(key);
    const p = posTheoDl.get(key);
    const ten = key === -1 ? KHONG_GAN : g?.ten ?? tenTheoDl.get(key) ?? ('#' + key);
    theoDaiLy.push({
      daiLyId: key === -1 ? null : key,
      ten,
      doanhSo: g?.doanhSo ?? 0,
      lai: g?.lai ?? 0,
      soBillChuaKhaiLai: g?.chuaKhai ?? 0,
      posCam: p?.cam ?? 0,
      posKhongChay: p?.khongChay ?? 0,
      posThap: p?.thap ?? 0,
      posDatHanMuc: p?.datHanMuc ?? 0,
      posMoiGiao: p?.moiGiao ?? 0,
      chiTietPos: (p?.chiTiet ?? []).sort((a, b) => b.doanhSoKy - a.doanhSoKy)
    });
  }
  // Sắp doanh số giảm dần; nhóm "Chưa gán đại lý" xuống cuối.
  theoDaiLy.sort((a, b) => {
    if ((a.daiLyId == null) !== (b.daiLyId == null)) return a.daiLyId == null ? 1 : -1;
    return b.doanhSo - a.doanhSo;
  });

  const theoNgay: KpiNgayDto[] = [...theoNgayMap.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([ngay, v]) => ({ ngay, doanhSo: v.doanhSo, soBill: v.soBill }));

  return {
    ok: true,
    data: {
      from,
      to,
      ca,
      soNgayKy,
      heSoQuyDoiThang: heSo,
      nguongThapThang: NGUONG_THAP_THANG,
      nguongHanMucThang: NGUONG_HAN_MUC_THANG,
      tongDoanhSo,
      tongLai,
      soBillChuaKhaiLai: tongChuaKhai,
      soBill,
      theoNgay,
      theoDaiLy
    }
  };
}
