// NHẬP BILL LẺ THỦ CÔNG — đường GHI của màn "DOANH SỐ" (Admin Demo chốt 7/11, phương án B).
//
// NGUYÊN TẮC SỐ 1: ĐI CHUNG MỘT NGUỒN VỚI BILL OCR. Route này KHÔNG tự tính tiền, KHÔNG tự dựng lô —
// nó gọi đúng `createLoFromBillTid` của `apps/bot-api/src/lo-service.ts`, cùng hàm mà luồng OCR dùng.
// Nhờ vậy mọi luật đã tôi luyện ở đó áp dụng y nguyên: khoá bill chống doanh số x2, báo giá theo đại lý
// đang cầm máy, chặn thu nhỏ tổng, tách nhiều loại thẻ, mượn TID, mã đóng lô.
//
// NHẬP TRỰC TIẾP (không copy) là CỐ Ý: copy logic tiền sang đây là sớm muộn 2 bên lệch nhau — đúng lớp
// lỗi đã trả giá ở `brand.css` và ở công thức phí client (lệch 1đ ở 713.261 mức tiền).
//
// SAU KHI GHI: route ĐỌC LẠI từ DB và so với số màn hình gửi lên. Lệch → báo đỏ, nói rõ số nào lệch.
// "Ghi xong coi như xong" là cách mất tiền mà không ai biết.
import { Router, type Request, type Response } from 'express';
import { PERMISSIONS } from '@sigma/shared';
// [KẾ TOÁN NĐT 24/11] DATA-SCOPE CỨNG: user khóa phạm vi 1 NĐT CHỈ thấy/ghi bill của TID thuộc NĐT đó.
import { resolveScopeInvestorId } from '@sigma/services';
// [B235] Dùng CHÍNH 2 hàm của báo cáo NĐT — 1 nguồn công thức duy nhất cho tiền nhà đầu tư.
import { marginToAmount } from '@sigma/business-rules';

// [B235 22/11 — Admin Demo chốt] Ngưỡng phân biệt hai kiểu tính lãi NĐT: từ 0,5% trở xuống là TỶ LỆ LÃI,
// trên 0,5% là GIÁ SIGMA MUA của NĐT. Hiện trạng sổ thật: Nam 0,1% · Trung 0,1% · Huy 1,24%.
const NGUONG_TY_LE_LAI_MILLI = 500;
import { asyncHandler } from '../async-handler.js';
import { requireQlSession } from './auth.js';
import { ctxFromReq, num, str } from './_ctx.js';
import { getDb } from '../db.js';
import { writeAudit } from '../audit.js';
import { createLoFromBillTid } from '../../../bot-api/src/lo-service.js';
import { ensureSupportAlphaAgent } from '../../../bot-api/src/zalo-bill-support.js';

export const billManualRouter = Router();

/** Quyền cần có để ghi doanh số bằng tay.
 *  LẤY TỪ DANH MỤC CHUẨN (`packages/shared/src/permissions.ts`), KHÔNG gõ chuỗi theo trí nhớ: mã sai thì
 *  không vai trò nào có → route từ chối MỌI NGƯỜI kể cả admin, mà thông báo vẫn là "không có quyền"
 *  (đã suýt lọt 7/11: gõ 'TXN_MANAGE', mã thật là 'REVENUE_MANAGE'). */
const QUYEN_GHI = 'REVENUE_MANAGE';
const QUYEN_XEM = 'REVENUE_VIEW';
// CHẶN NGAY LÚC NẠP MODULE nếu mã quyền không có trong danh mục — thà app không lên còn hơn chạy với một
// route từ chối tất cả mọi người trong im lặng.
for (const ma of [QUYEN_GHI, QUYEN_XEM]) {
  if (!PERMISSIONS.some((x) => x.code === ma)) {
    throw new Error(`[bill-manual] Mã quyền "${ma}" KHÔNG có trong danh mục permissions — sửa lại trước khi chạy.`);
  }
}


/**
 * DANH SÁCH BILL THEO KỲ — nguồn cho bảng màn Doanh Số.
 * Đọc THẲNG từ sổ (bảng `los` + `lo_rows`), KHÔNG dựng lại số ở client.
 * Mốc ngày dùng `bill_txn_date` (giờ quẹt thật trên bill); thiếu thì mới lấy `created_at`.
 */
billManualRouter.get(
  '/v1/bills/manual',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    if (!ctx.user.permissions.includes(QUYEN_XEM) && !ctx.user.permissions.includes(QUYEN_GHI)) {
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Tài khoản không có quyền xem doanh số.' });
      return;
    }
    const tu = (str(req.query['from']) ?? '').trim();
    const den = (str(req.query['to']) ?? '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(tu) || !/^\d{4}-\d{2}-\d{2}$/.test(den)) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Kỳ xem phải có dạng YYYY-MM-DD.' });
      return;
    }
    // [DOANH SỐ TIỀN CHỜ 24/11 — Admin Demo "clone ra màn Doanh Số, chỉ khác lọc loại phí"] TÁCH DATA 2 màn:
    //   nhomPhi='tiencho' ⇒ CHỈ bill loại phí Tiền chờ(8) + Uỷ quyền(9).
    //   mặc định / 'thuong' ⇒ CHỈ bill KHÁC 8,9 (gồm cả bill chưa gắn loại phí = NULL) — màn Doanh Số thường
    //     KHÔNG còn thấy bill tiền chờ/uỷ quyền nữa.
    // Điều kiện là HẰNG SỐ 8/9 (KHÔNG dùng tham số $n) nên không dời chỉ số của scopeWhere ($3). Áp cho CẢ
    // query chính LẪN query đếm tổng (demTong) để cờ biCat không so lệch hai tập khác nhau.
    const nhomPhi = (str(req.query['nhomPhi']) ?? '').trim();
    const phiWhere =
      nhomPhi === 'tiencho'
        ? ' AND r.fee_type_id IN (8,9)'
        : ' AND (r.fee_type_id NOT IN (8,9) OR r.fee_type_id IS NULL)';
    const db = getDb();
    // [KẾ TOÁN NĐT 24/11] PHẠM VI KHÓA: user bị khóa NĐT CHỈ thấy bill có TID thuộc NĐT đó (tids.receive_account_id
    // → receive_accounts.investor_id = scope). Lọc Ở SQL (không lọc ở JS — thà không trả còn hơn trả thừa rồi cắt).
    // scopeId null = staff full (không thêm điều kiện gì — hành vi cũ giữ nguyên).
    const scopeId = await resolveScopeInvestorId(ctx);
    const scopeWhere = scopeId != null ? ' AND ra.investor_id = $3' : '';
    const scopeParams = scopeId != null ? [tu, den, scopeId] : [tu, den];
    // Biên kỳ NỬA MỞ theo giờ TP.HCM: [tu 00:00, den+1 00:00) — tránh lọt/đếm đúp bill lúc nửa đêm.
    const rows = await db.$queryRawUnsafe<
      Array<{
        lo_id: number;
        ngay_hcm: string;
        gio_hcm: string;
        moc: Date;
        tid: string | null;
        hkd: string | null;
        dai_ly: string | null;
        ndt: string | null;
        bank: string | null;
        the: string | null;
        card_type_id: number | null;
        bank_id: number | null;
        loai_phi: string | null;
        fee_type_id: number | null;
        dong_the_chi_tiet: Array<{ truoc: string; phi: string; pcm: number | null; mua: number | null; muaNdt: number | null }> | null;
        so_lo: number | null;
        settlement_code: string | null;
        truoc_phi: string;
        sau_phi: string;
        phi: string;
        so_dong: number;
        so_the: number;
        phi_cai_may_milli: number | null;
        sell_margin_milli: number | null;
        invest_fee_milli: number | null;
        phi_mua_ndt_milli: number | null;
        phi_mua_milli: number | null;
        nguoi_nhap: string | null;
        tien_huy: string | null;
        so_hoa_don: string | null;
        ghi_chu: string | null;
        da_hoan: string | null;
        nguoi_hoan: string | null;
        nguoi_hoan_id: number | null;
        transaction_id: number | null;
      }>
    >(
      `SELECT l.id                                   AS lo_id,
              -- [B184 19/11] NGÀY/GIỜ ĐỊNH DẠNG NGAY TRONG SQL. TRƯỚC ĐÂY trả cột thời gian thô rồi để
              -- JavaScript quy đổi bằng Intl: driver đọc timestamptz qua $queryRaw ĐÃ cộng +7h (giờ treo
              -- tường dán "Z"), Intl lại quy sang Asia/Ho_Chi_Minh ⇒ CỘNG 7h LẦN HAI. Đo trên SỔ THẬT 19/11:
              -- lô 3588 giờ thật 14:56 mà màn hiện 21:56; lô 3587 06:00 hiện 13:00. Bill quẹt từ 17:00 trở đi
              -- còn bị đẩy sang NGÀY HÔM SAU ⇒ khoá bill màn dựng ra lệch khoá trong sổ ⇒ bấm Sửa rồi lưu là
              -- sinh LÔ MỚI, doanh số đếm 2 lần. Không cho giá trị thời gian đi qua Date của JS nữa.
              to_char(COALESCE(l.bill_txn_date, l.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD') AS ngay_hcm,
              to_char(COALESCE(l.bill_txn_date, l.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh', 'HH24:MI')    AS gio_hcm,
              COALESCE(l.bill_txn_date, l.created_at) AS moc,
              t.tid                                   AS tid,
              t.hkd_name                              AS hkd,
              -- [B175 16/11 Admin Demo] TÊN ĐẠI LÝ = TÊN ĐẶT (customers.nickname), KHÔNG phải họ tên khai sinh.
              -- Trước đây lấy thẳng full_name nên cột Đại lý in "Đại lý F" trong khi cả hệ thống gọi
              -- khách đó bằng tên đặt. Khuôn nickname||full_name là luật sẵn có ở tid-config.ts:277 — đây là chỗ
              -- DUY NHẤT còn lệch. Lồng CASE để lô MƯỢN TID vẫn ưu tiên khách mượn (cm) rồi mới tới chủ máy (c).
              COALESCE(
                CASE WHEN cm.id IS NOT NULL THEN COALESCE(NULLIF(TRIM(cm.nickname), ''), cm.full_name) END,
                COALESCE(NULLIF(TRIM(c.nickname), ''), c.full_name)
              )                                       AS dai_ly,
              -- [B187 19/11] NHÀ ĐẦU TƯ của máy: trước đây trả CỨNG NULL nên cột NĐT trên bảng Doanh Số
              -- LUÔN TRỐNG sau khi tải lại (dòng app tự chèn thì có tên) — cùng lớp lỗi B172/B176/B177.
              -- Lấy qua TK nhận tiền của TID (tids.receive_account_id → receive_accounts.investor_id).
              MIN(COALESCE(NULLIF(TRIM(iv.nickname), ''), iv.full_name)) AS ndt,
              -- [B235 22/11 — Admin Demo "thêm blog báo cáo lãi NĐT và tiền thu về của SigMa"] PHÍ ĐẦU TƯ
              -- hiệu lực của máy: override theo TID THẮNG mặc định của NĐT — ĐÚNG như investor-report.ts.
              MIN(COALESCE(t.invest_fee_milli, iv.invest_fee_milli)) AS invest_fee_milli,
              COALESCE(NULLIF(b.code, ''), b.name)    AS bank,  -- [16/11] HIỂN THỊ mã viết tắt (MBV), không phải tên pháp nhân dài
              MIN(ct.name)                            AS the,
              -- [B187 19/11] MÃ loại thẻ + MÃ ngân hàng: form SỬA cần nạp lại ĐÚNG thẻ của bill. Trước đây
              -- danh sách chỉ trả TÊN thẻ nên mở Sửa là ô "Loại thẻ" trống, màn báo "chưa có giá bán thực tế",
              -- người dùng phải tự chọn lại — chọn nhầm là ĐỔI % phí bán ⇒ đổi tiền về đại lý mà không ai biết.
              MIN(ct.id)                              AS card_type_id,
              MIN(t.bank_id)                          AS bank_id,
              MIN(ft.name)                            AS loai_phi,
              -- [B268 24/11 — audit doanh so, CHAN SHIP] MA loai phi: man Sua phai nap lai DUNG loai phi
              -- cua bill. Truoc day chi tra TEN nen mo Sua xong ghi lai la roi ve loai phi mac dinh.
              MIN(r.fee_type_id)                      AS fee_type_id,
              COUNT(DISTINCT r.card_type_id)::int     AS so_the,
              l.bank_reported_lo_number               AS so_lo,
              l.settlement_code                       AS settlement_code,
              SUM(r.amount_before_fee)::text          AS truoc_phi,
              SUM(r.amount_after_fee)::text           AS sau_phi,
              SUM(r.fee_applied)::text                AS phi,
              COUNT(r.id)::int                        AS so_dong,
              -- [B274 24/11 — audit doanh số] CHI TIẾT TỪNG DÒNG THẺ. Lô tách nhiều thẻ trước đây lấy
              -- MAX(%) của MỘT thẻ nhân cho CẢ lô ⇒ lãi NĐT / SigMa bán / Sau mua NĐT / Sau phí cài máy đều
              -- sai (đo sổ thật: 5 lô, lãi NĐT thừa 729.542đ, có lô SigMa bán ra ÂM −231.505đ mà vẫn vào
              -- Excel). Trả chi tiết về để tính THEO TỪNG DÒNG rồi cộng, đúng như engine ghi giao dịch.
              json_agg(json_build_object(
                'truoc',  r.amount_before_fee::text,
                'phi',    r.fee_applied::text,
                'pcm',    fm.phi_cai_may,
                'mua',    fm.phi_mua,
                'muaNdt', sfn.phi_mua_ndt
              ))                                      AS dong_the_chi_tiet,
              -- [B172] TIỀN ĐÃ HOÀN + AI HOÀN (cột phụ trên bảng los, schema-ensure). Trước đây trả CỨNG 0 và rỗng
              -- nên 2 ô người dùng gõ ở màn Thêm bill biến mất sau khi tải lại.
              -- [B176 16/11] % PHÍ CÀI MÁY: trước đây map trả CỨNG null nên cột "% CM" của danh sách bill nhập
              -- LUÔN TRỐNG, dù sổ có số (đo lô 3587: phi_cai_may_milli = 1100 ⇒ 1,1%). Cùng lớp lỗi B172.
              -- Lấy từ chính giao dịch của lô (los.transaction_id ↔ transactions), đơn vị milli-phần-trăm.
              MAX(tx.phi_cai_may_milli)               AS phi_cai_may_milli,
              -- [B224 21/11] % BÁN phải lấy ẢNH CHỤP tỷ lệ trên chính giao dịch, không suy ngược từ tiền.
              MAX(tx.sell_margin_milli)               AS sell_margin_milli,
              -- [B177 16/11] NGƯỜI NHẬP + GHI CHÚ: trước đây map trả CỨNG '' nên 2 cột cuối bảng LUÔN trống.
              MAX(un.full_name)                       AS nguoi_nhap,
              MAX(tx.note)                            AS ghi_chu,
              -- [B178 16/11] TIỀN HỦY + SỐ HÓA ĐƠN (cột phụ trên los, schema-ensure). Trước đây map trả CỨNG
              -- BẪY: chú thích trong câu SQL này nằm trong template literal ⇒ CẤM dấu huyền (backtick),
              -- nó kết thúc chuỗi sớm và vỡ cả file. Trước đây map trả CỨNG tienHuy=0 và soHoaDon rỗng
              -- nên 2 ô người nhập gõ biến mất sau khi tải lại.
              l.void_amount::text                     AS tien_huy,
              l.invoice_no                            AS so_hoa_don,
              l.refunded_amount::text                 AS da_hoan,
              uh.full_name                            AS nguoi_hoan,
              l.refunded_by_user_id                   AS nguoi_hoan_id,
              -- [B186 19/11] MÃ GIAO DỊCH của lô — màn Doanh Số cần nó để GỬI YÊU CẦU HỦY bill.
              -- Trước đây danh sách không trả trường này nên nút "Xóa bill" chỉ bỏ dòng khỏi màn hình,
              -- không gọi máy chủ: đổi màn là bill quay lại nguyên vẹn, doanh số vẫn tính.
              l.transaction_id                        AS transaction_id,
              -- [B211 19/11 — Admin Demo "thêm cột phí mua vào sau % bán"] % PHÍ MUA của loại thẻ trên bill.
              -- KHÔNG lấy cột biên đối tác trên giao dịch (partner_margin_milli) — đo thật nó chỉ ra 0% hoặc
              -- −0,02%), không phải phí mua. Phí mua nằm ở biểu phí đối tác (fee_rates), và phải lấy kỳ
              -- HIỆU LỰC TẠI NGÀY BILL chứ không phải kỳ mới nhất — lô cũ phải giữ đúng phí mua thời điểm đó.
              MAX(fm.phi_mua)                         AS phi_mua_milli,
              MAX(sfn.phi_mua_ndt)                    AS phi_mua_ndt_milli
         FROM los l
         JOIN lo_rows r       ON r.lo_id = l.id
         LEFT JOIN tids t     ON t.id = r.tid_id
         LEFT JOIN customers c  ON c.id = t.customer_id
         LEFT JOIN customers cm ON cm.id = l.borrowed_by_customer_id
         LEFT JOIN banks b    ON b.id = t.bank_id
         LEFT JOIN card_types ct ON ct.id = r.card_type_id
         LEFT JOIN fee_types ft  ON ft.id = r.fee_type_id
         LEFT JOIN users uh      ON uh.id = l.refunded_by_user_id
         LEFT JOIN transactions tx ON tx.id = l.transaction_id
         LEFT JOIN users un      ON un.id = l.created_by
         LEFT JOIN receive_accounts ra ON ra.id = t.receive_account_id
         LEFT JOIN investors iv  ON iv.id = ra.investor_id
         LEFT JOIN LATERAL (
           SELECT fr.phi_mua, fr.phi_cai_may
             FROM fee_rates fr
            WHERE fr.partner_id = t.partner_id
              AND fr.card_type_id = r.card_type_id
              AND fr.deleted_at IS NULL
              AND fr.effective_from <= COALESCE(l.bill_txn_date, l.created_at)
            ORDER BY fr.effective_from DESC
            LIMIT 1
         ) fm ON TRUE
         -- [B236 22/11 — Admin Demo] PHÍ MUA CỦA NĐT hiệu lực TẠI NGÀY BILL (TID × thẻ). Cùng khuôn với phí mua
         -- đối tác ở trên: lấy kỳ mới nhất có mốc ≤ ngày bill ⇒ bill cũ giữ đúng giá lúc đó, không bị giá
         -- hôm nay đè lên. NULL = TID chưa khai ⇒ báo cáo để trống, KHÔNG bịa số.
         LEFT JOIN LATERAL (
           SELECT sf.phi_mua_ndt
             FROM tid_sell_fees sf
            WHERE sf.tid_id = r.tid_id
              AND sf.card_type_id = r.card_type_id
              AND sf.deleted_at IS NULL
              AND sf.phi_mua_ndt IS NOT NULL
              AND sf.effective_from <= COALESCE(l.bill_txn_date, l.created_at)
            ORDER BY sf.effective_from DESC, sf.id DESC
            LIMIT 1
         ) sfn ON TRUE
        WHERE l.status <> 'CANCELLED'
          -- [B257 23/11] BẮT BUỘC ::timestamp TRƯỚC AT TIME ZONE. Dạng "date AT TIME ZONE z" bị Postgres
          -- hiểu là "đổi timestamptz sang giờ treo tường ở z" — kết quả PHỤ THUỘC múi giờ PHIÊN: phiên
          -- Asia/Bangkok thì đúng, phiên UTC thì cửa sổ ngày trượt +7h (đo: 00:00 → 07:00) ⇒ MẤT bill
          -- quẹt trước 14:00. Thêm ::timestamp là chốt nghĩa "00:00 giờ VN của ngày đó", đúng với MỌI phiên.
          AND COALESCE(l.bill_txn_date, l.created_at) >= ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
          AND COALESCE(l.bill_txn_date, l.created_at) <  ((($2::date) + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')${scopeWhere}${phiWhere}
        GROUP BY l.id, l.bill_txn_date, l.created_at, l.void_amount, l.invoice_no, l.transaction_id, t.tid, t.hkd_name,
                 cm.id, cm.nickname, cm.full_name, c.nickname, c.full_name,
                 b.name, b.code, l.bank_reported_lo_number, l.settlement_code,
                 l.refunded_amount, uh.full_name, l.refunded_by_user_id
        ORDER BY COALESCE(l.bill_txn_date, l.created_at) DESC, l.id DESC
        LIMIT 2000`,
      ...scopeParams
    );
    // [B195 19/11 — agent audit] ĐẾM TỔNG để biết có bị CẮT không. Trước đây câu trên `LIMIT 2000` mà không
    // trả cờ gì: kỳ nào quá 2000 lô là bảng Doanh Số THIẾU TIỀN mà không ai biết (tái hiện: 2050 lô ⇒ hiện
    // 2000, thiếu 50 lô = 50.000.000đ, không một lời cảnh báo). Phần bị cắt là các lô CŨ NHẤT trong kỳ.
    // [KẾ TOÁN NĐT 24/11] Khi khóa phạm vi: THÊM join TID→TK-nhận để đếm tổng cũng chỉ trong phạm vi NĐT
    // (nếu không, cờ "biCat" so lệ số đếm TOÀN kỳ với số dòng ĐÃ LỌC ⇒ cảnh báo cắt sai). Khớp đúng bộ lọc trên.
    const scopeJoinDem = scopeId != null
      ? ' JOIN tids t ON t.id = r.tid_id JOIN receive_accounts ra ON ra.id = t.receive_account_id'
      : '';
    const demTong = await db.$queryRawUnsafe<Array<{ n: number }>>(
      `SELECT count(DISTINCT l.id)::int AS n
         FROM los l JOIN lo_rows r ON r.lo_id = l.id${scopeJoinDem}
        WHERE l.status <> 'CANCELLED'
          AND COALESCE(l.bill_txn_date, l.created_at) >= ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
          AND COALESCE(l.bill_txn_date, l.created_at) <  ((($2::date) + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh')${scopeWhere}${phiWhere}`,
      ...scopeParams
    );
    const tongTrongKy = Number(demTong[0]?.n ?? rows.length);

    res.json({
      ok: true,
      // [B195] Nói rõ có bị cắt hay không để màn hình CẢNH BÁO, thay vì âm thầm thiếu tiền.
      total: tongTrongKy,
      biCat: tongTrongKy > rows.length,
      data: rows.map((x) => {
        // [B184] lấy THẲNG chuỗi Postgres đã quy sẵn giờ TP.HCM — không quy đổi lại ở JS.
        const ngay = x.ngay_hcm;
        const gio = x.gio_hcm;
        const truoc = Number(x.truoc_phi);
        const huy = x.tien_huy != null ? Number(x.tien_huy) : 0;
        const sau = Number(x.sau_phi);
        return {
          id: 'lo' + x.lo_id,
          loId: x.lo_id,
          ngay,
          gio,
          tid: x.tid ?? '',
          hkd: x.hkd ?? '',
          daiLy: x.dai_ly ?? '',
          ndt: x.ndt ?? '',
          bank: x.bank ?? '',
          loaiThe: x.so_the > 1 ? 'nhiều thẻ' : x.the ?? '',
          cardTypeId: x.so_the > 1 ? null : x.card_type_id ?? null, // lô tách thẻ thì không có 1 thẻ duy nhất
          bankId: x.bank_id ?? null,
          loaiPhi: x.loai_phi ?? '',
          // [B268] lo tach NHIEU the thi moi dong mot loai phi -> khong co mot ma duy nhat de nap lai.
          feeTypeId: x.so_the > 1 ? null : x.fee_type_id ?? null,
          lo: (x.so_lo != null ? String(x.so_lo) : '') + (x.settlement_code ? '(' + x.settlement_code + ')' : ''),
          soHoaDon: x.so_hoa_don ?? '',
          // [B178] Sổ lưu `amountBeforeFee` = TỔNG QUẸT − TIỀN HỦY (màn hình trừ trước khi gửi). Nên:
          //   tienLo  = đúng số đã vào sổ (số tính tiền)  ·  tongQuet = tienLo + tienHuy (để đối chiếu sao kê).
          tongQuet: truoc + huy,
          tienHuy: huy,
          tienLo: truoc,
          // [B224 21/11 — Admin Demo "sao phí lung tung thế? 1.2545?"] % BÁN lấy ẢNH CHỤP tỷ lệ đã ghi trên
          // chính giao dịch (phí bán = margin bán + phí cài máy), KHÔNG suy ngược từ tiền.
          // Vì sao: suy ngược = tiền ĐÃ LÀM TRÒN chia cho tiền gốc ⇒ bill nhỏ ra số lẻ vô nghĩa. Đo lô 3684:
          // quẹt 11.000đ, giá 1,25% ⇒ phí 137,5 làm tròn 138 ⇒ 138/11.000 = 1,2545% hiện lên màn. Đo sổ thật:
          // 7/117 bill hiện số lẻ kiểu này. Ảnh chụp là số LỊCH SỬ của chính bill đó nên
          // KHÔNG vướng lo ngại cũ "lấy biểu phí hôm nay áp cho bill cũ".
          // Lô TÁCH NHIỀU THẺ thì mỗi dòng một tỷ lệ, không có một con số đúng ⇒ giữ cách suy từ tiền (là
          // bình quân thật) thay vì bịa ra tỷ lệ của một thẻ.
          phiPct:
            x.so_the <= 1 && x.sell_margin_milli != null && x.phi_cai_may_milli != null
              // Cộng SỐ NGUYÊN milli RỒI MỚI chia. Chia trước rồi cộng là sai số thập phân nhị phân:
              // 0,225 + 1,155 = 1,3800000000000001 ⇒ màn hình hiện "1,380000000000000..." tràn đè cột bên
              // (nhìn ảnh mới thấy, số đo không bắt được). Cộng nguyên: (225+1155)/1000 = 1,38 chuẩn.
              ? (Number(x.sell_margin_milli) + Number(x.phi_cai_may_milli)) / 1000
              : truoc > 0
                ? Number((((truoc - sau) / truoc) * 100).toFixed(4))
                : null,
          // milli-phần-trăm → phần trăm (1100 ⇒ 1,1%). Không có số thì để trống, KHÔNG bịa 0.
          // [B296/CS2 24/11 — agent phản biện] LÔ NHIỀU THẺ: mỗi dòng một mức % ⇒ KHÔNG có một con số
          // đúng; MAX(%) của một thẻ in cạnh TIỀN tính từng dòng là hai số chửi nhau trên cùng một dòng
          // (đo lô 3726: cột in 1,155% nhưng tiền ngụ ý 0,8804% — lệch 233.750đ nếu người dùng nhân tay).
          // Trả null để màn/Excel hiện "—" (phiPct ở trên đã là bình quân suy từ tiền thật nên giữ).
          caiMayPct: x.so_the > 1 ? null : x.phi_cai_may_milli != null ? Number(x.phi_cai_may_milli) / 1000 : null,
          // [B211] % phí mua — đơn vị milli-phần-trăm y như các cột phí khác.
          muaPct: x.so_the > 1 ? null : x.phi_mua_milli != null ? Number(x.phi_mua_milli) / 1000 : null,
          // [B236 22/11 — Admin Demo chốt] MÔ HÌNH TIỀN KHÉP KÍN, CẤM đổi nếu không có lệnh:
          //     lãi NĐT          = (phí mua NĐT    − phí cài máy)   × doanh số
          //     SigMa thu phía bán = (phí bán khách − phí mua NĐT)  × doanh số
          //     SigMa thu phía ĐT  = (phí mua đối tác − phí cài máy) × doanh số
          // Cộng lãi NĐT + SigMa phía bán = (phí bán − phí cài máy) × doanh số = đúng phần chênh hệ thống ghi.
          // TID CHƯA KHAI phí mua NĐT ⇒ trả null, màn hình/Excel để trống và nói rõ "chưa khai" — KHÔNG bịa 0.
          phiMuaNdtPct: x.so_the > 1 ? null : x.phi_mua_ndt_milli != null ? Number(x.phi_mua_ndt_milli) / 1000 : null, // [B296] nt.
          // [B237 22/11 — Admin Demo "thêm cột sau phí cài máy, phí mua NĐT và sau phí mua NĐT"]
          // Tính Ở MÁY CHỦ để màn hình và Excel dùng CHUNG một con số, không ai tự nhân lại.
          ...(() => {
            // [B274 24/11] LÔ TÁCH NHIỀU THẺ: mỗi dòng một mức phí ⇒ PHẢI tính từng dòng rồi cộng. Lấy
            // MAX(%) × tổng lô (cách cũ) là bịa ra một mức phí chưa từng tồn tại. Lô 1 thẻ giữ NGUYÊN đường
            // cũ không đụng tới (mô hình tiền B236 Admin Demo đã chốt, cấm đổi).
            if (x.so_the > 1 && Array.isArray(x.dong_the_chi_tiet) && x.dong_the_chi_tiet.length > 0) {
              const d = x.dong_the_chi_tiet;
              const thieuPcm = d.some((y) => y.pcm == null);
              const thieuNdt = d.some((y) => y.muaNdt == null);
              const thieuDt = d.some((y) => y.mua == null);
              const cong = (f: (y: typeof d[number], tr: number) => number): number =>
                d.reduce((acc, y) => acc + f(y, Number(y.truoc)), 0);
              const tienCaiMay = thieuPcm ? null : cong((y, tr) => marginToAmount(tr, Number(y.pcm)));
              const tienMuaNdt = thieuNdt ? null : cong((y, tr) => marginToAmount(tr, Number(y.muaNdt)));
              const alphaDoiTac = thieuPcm || thieuDt
                ? null
                : cong((y, tr) => marginToAmount(tr, Number(y.mua) - Number(y.pcm)));
              // [B281/F4+F7] CÙNG MỘT QUY ƯỚC với nhánh 1 thẻ: chênh từng dòng = fee_applied (SỐ TIỀN
              // THẬT đã vào sổ) − tiền cài máy dòng đó; lãi NĐT làm tròn chuẩn; SigMa bán = chênh − lãi
              // ⇒ bất biến đúng tuyệt đối từng dòng lẫn tổng, hai nhánh không còn hai định nghĩa.
              const laiNdt = thieuPcm || thieuNdt
                ? null
                : cong((y, tr) => marginToAmount(tr, Number(y.muaNdt) - Number(y.pcm)));
              const alphaBan = thieuPcm || thieuNdt
                ? null
                : cong((y, tr) => Number(y.phi) - marginToAmount(tr, Number(y.pcm))
                    - marginToAmount(tr, Number(y.muaNdt) - Number(y.pcm)));
              return {
                sauPhiCaiMay: tienCaiMay == null ? null : truoc - tienCaiMay,
                sauMuaNdt: tienMuaNdt == null ? null : truoc - tienMuaNdt,
                laiNdt, alphaBan, alphaDoiTac,
                alphaThu: alphaBan == null ? null : alphaBan + (alphaDoiTac ?? 0)
              };
            }
            const sauPhiCaiMay = x.phi_cai_may_milli != null ? truoc - marginToAmount(truoc, Number(x.phi_cai_may_milli)) : null;
            const sauMuaNdt = x.phi_mua_ndt_milli != null ? truoc - marginToAmount(truoc, Number(x.phi_mua_ndt_milli)) : null;
            const pcm = x.phi_cai_may_milli != null ? Number(x.phi_cai_may_milli) : null;
            const sm = x.sell_margin_milli != null ? Number(x.sell_margin_milli) : null;
            const mua = x.phi_mua_ndt_milli != null ? Number(x.phi_mua_ndt_milli) : null;
            const muaDt = x.phi_mua_milli != null ? Number(x.phi_mua_milli) : null;
            const alphaDoiTac = pcm != null && muaDt != null ? marginToAmount(truoc, muaDt - pcm) : null;
            if (pcm == null || sm == null || mua == null) {
              return { sauPhiCaiMay, sauMuaNdt, laiNdt: null, alphaBan: null, alphaDoiTac, alphaThu: null };
            }
            // [B281 + B313/F5 24/11] CHÊNH lấy từ PHÍ THẬT đã vào sổ (trước − sau) trừ tiền cài máy —
            // CÙNG định nghĩa với nhánh nhiều thẻ (fee_applied thật). Suy từ margin vẫn lệch 1đ ở số tiền
            // đuôi ≡750 (đo bill 10.000.750đ: 22.002 ≠ 22.001). Lãi NĐT làm tròn chuẩn; SigMa bán = chênh
            // − lãi ⇒ bất biến `laiNdt + alphaBan = sauPhiCaiMay − nhanVe` đúng TUYỆT ĐỐI mọi dòng.
            const chenh = (truoc - sau) - marginToAmount(truoc, pcm);
            const lai = marginToAmount(truoc, mua - pcm);
            const aBan = chenh - lai;
            return { sauPhiCaiMay, sauMuaNdt, laiNdt: lai, alphaBan: aBan, alphaDoiTac, alphaThu: aBan + (alphaDoiTac ?? 0) };
          })(),
          nhanVe: sau,
          daHoan: x.da_hoan != null ? Number(x.da_hoan) : 0,
          nguoiHoan: x.nguoi_hoan ?? '',
          nguoiHoanId: x.nguoi_hoan_id ?? null,
          transactionId: x.transaction_id ?? null,
          ghiChu: x.ghi_chu ?? '',
          nguoiNhap: x.nguoi_nhap ?? ''
        };
      })
    });
  })
);

/**
 * [DOANH SỐ TIỀN CHỜ 24/11 — Admin Demo "TID picker màn tiền chờ CHỈ hiện TID đã khai giá bán loại phí Uỷ quyền(9)
 * hoặc Tiền chờ(8)"] Trả về DANH SÁCH tid_id có ÍT NHẤT 1 dòng giá bán thực tế cho loại phí 8/9 còn hiệu lực
 * (tid_sell_fees.fee_type_id IN (8,9) AND deleted_at IS NULL). Màn tiền chờ lọc picker theo tập này — TID chưa
 * khai giá UQ/Tiền chờ thì KHÔNG hiện (tránh chọn vào rồi mới báo NO_SELL_FEE). Gác cùng quyền xem/ghi doanh số.
 */
billManualRouter.get(
  '/v1/bills/manual/tids-tiencho',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    if (!ctx.user.permissions.includes(QUYEN_XEM) && !ctx.user.permissions.includes(QUYEN_GHI)) {
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Tài khoản không có quyền xem doanh số.' });
      return;
    }
    const rows = await getDb().$queryRawUnsafe<Array<{ tid_id: number }>>(
      `SELECT DISTINCT tid_id
         FROM tid_sell_fees
        WHERE fee_type_id IN (8,9)
          AND deleted_at IS NULL
          AND tid_id IS NOT NULL`
    );
    res.json({ ok: true, data: rows.map((r) => Number(r.tid_id)) });
  })
);

/**
 * [KẾ TOÁN NĐT 24/11 — phương án A người hoàn] Route HẸP: danh sách NGƯỜI ĐƯỢC ĐỨNG TÊN HOÀN TIỀN cho ô
 * "Người hoàn" ở màn nhập bill. TRẢ CHỈ {id, fullName} — KHÔNG lộ username/phone/email/vai trò (vai Kế toán NĐT
 * KHÔNG có USER_READ, không được xem danh mục nhân sự đầy đủ). Nguồn CHÍNH XÁC như cũ: cột `users.can_refund`
 * (ô tích "Được hoàn tiền" ở màn Nhân sự, B206) — KHÔNG theo vai trò. Gác quyền REVENUE_MANAGE (quyền nhập bill).
 * Thêm vào SCOPE_ALLOW_EXACT trong auth.ts để user Kế toán NĐT (deny-by-default) gọi được.
 */
billManualRouter.get(
  '/v1/refund-people',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    if (!ctx.user.permissions.includes(QUYEN_GHI)) {
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Tài khoản không có quyền nhập bill.' });
      return;
    }
    const rows = await getDb().$queryRawUnsafe<Array<{ id: number; fullName: string }>>(
      `SELECT id, full_name AS "fullName"
         FROM users
        WHERE deleted_at IS NULL AND status = 'ACTIVE' AND can_refund = true
        ORDER BY full_name`
    );
    res.json({ ok: true, data: rows.map((r) => ({ id: Number(r.id), fullName: r.fullName })) });
  })
);

billManualRouter.post(
  '/v1/bills/manual',
  asyncHandler(requireQlSession),
  asyncHandler(async (req: Request, res: Response) => {
    const ctx = await ctxFromReq(req);
    if (!ctx.user.permissions.includes(QUYEN_GHI)) {
      res.status(403).json({ ok: false, error: 'FORBIDDEN', message: 'Tài khoản không có quyền ghi doanh số.' });
      return;
    }

    const b = (req.body ?? {}) as Record<string, unknown>;
    const tidString = (str(b['tidString']) ?? '').replace(/\0/g, '').trim(); // [B291] lọc NUL
    const amountBeforeFee = num(b['amountBeforeFee']);
    const cardTypeId = num(b['cardTypeId']);
    const billKey = (str(b['billKey']) ?? '').trim() || null;
    // [B291/F1 24/11 — agent quyền] LỌC KÝ TỰ NUL — Postgres từ chối trong cột text, mà lỗi ném ở
    // createLoFromBillTid nằm NGOÀI khối dọn B193 ⇒ trước đây NUL trong mã đóng lô tạo LÔ MỒ CÔI
    // (vào sổ, không GD, không người nhập) rồi trả 500 — người dùng gõ lại là doanh số x2.
    const settlementCode = (str(b['settlementCode']) ?? '').replace(/\0/g, '').trim() || null;
    const borrowedByCustomerId = num(b['borrowedByCustomerId']);
    const soLo = num(b['bankReportedLoNumber']);
    // [B270 24/11 — audit doanh số] Cột `bank_reported_lo_number` kiểu INTEGER: gõ số > 2.147.483.647
    // là lệnh ghi NÉM LỖI giữa chừng (tái hiện: số lô 3000000000 ⇒ API 500). Chặn ngay, nói rõ.
    // [B290/F4 24/11 — agent quyền] Kiểm CẢ KIỂU: số lẻ ("1.5") / có khoảng trắng trước đây lọt qua rồi
    // lệnh ghi bỏ im (sổ lưu NULL mà API vẫn 200). Số nguyên ngoài dải thì nói rõ, không mâu thuẫn
    // ("tối đa 10 chữ số" từng chặn oan số 10 chữ số hợp lệ ≤ 2.147.483.647).
    if (soLo !== undefined && (!Number.isInteger(soLo) || soLo < 0 || soLo > 2147483647)) {
      res.status(400).json({
        ok: false, error: 'SO_LO_QUA_LON',
        message: 'Số lô "' + soLo + '" không ghi được vào sổ (phải là số nguyên 0 → 2.147.483.647). '
          + 'CÁCH SỬA: gõ lại đúng số lô in trên bill, chỉ gồm chữ số, không dấu chấm/phẩy/khoảng trắng.'
      });
      return;
    }
    const txnDateRaw = str(b['txnDate']);
    const allowDuplicate = b['allowDuplicate'] === true;
    // [B172] TIỀN ĐÃ HOÀN + NGƯỜI HOÀN — ghi vết trên lô. Kiểm FAIL-CLOSED ngay tại đây, không tin màn hình.
    // [B177] GHI CHÚ người nhập gõ — trước đây màn hình KHÔNG gửi và API KHÔNG nhận ⇒ gõ xong mất sạch
    // (đúng lớp lỗi B172). Là chữ thuần, KHÔNG đụng con số nào của lô.
    // [B188 19/11 — Admin Demo "sửa bill phải sửa được số tiền, người hoàn, số tiền hoàn, số lô, số hóa đơn"]
    // MÃ LÔ ĐANG SỬA. Máy chủ nhận ra "sửa" hay "bill mới" CHỈ qua khoá bill (TID|lô|số HĐ|ngày); đổi số lô
    // là đổi khoá ⇒ trước đây đẻ LÔ MỚI còn lô cũ nằm nguyên ⇒ doanh số đếm 2 lần. Nay màn gửi kèm mã lô
    // đang sửa, máy chủ ĐỔI KHOÁ CỦA CHÍNH LÔ ĐÓ rồi mới ghi ⇒ vẫn đúng MỘT lô.
    const suaLoId = num(b['editingLoId']);
    // [B190 19/11] LOẠI PHÍ người nhập chọn — màn hình gửi lên từ lâu nhưng route KHÔNG đọc, nên máy chủ
    // tính phí bằng loại phí MẶC ĐỊNH ⇒ chọn "Tiền chờ" mà sổ ghi "Đối ứng", phí bán sai, tiền về đại lý sai.
    const loaiPhiNhap = num(b['feeTypeId']);
    // [B193] Bỏ ký tự NUL — Postgres không nhận trong cột text, lọt vào là lệnh ghi ném lỗi giữa chừng.
    const ghiChuNhap = (str(b['ghiChu']) ?? '').replace(/\0/g, '').trim();
    // [B178] TIỀN HỦY + SỐ HÓA ĐƠN. `voidAmount` KHÔNG tham gia tính tiền — `amountBeforeFee` màn hình gửi
    // lên ĐÃ trừ hủy. Nhận thêm `totalAmount` (tổng quẹt) CHỈ để KHẲNG ĐỊNH bất biến, không để ghi.
    const tienHuyNhap = num(b['voidAmount']);
    const tongQuetNhap = num(b['totalAmount']);
    const soHoaDonNhap = (str(b['soHoaDon']) ?? '').replace(/\0/g, '').trim();
    const daHoan = num(b['refundedAmount']);
    const nguoiHoanId = num(b['refundedByUserId']);

    // ── Kiểm đầu vào FAIL-CLOSED: thà từ chối còn hơn ghi một con số đoán được ──
    if (!tidString) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Thiếu TID.' });
      return;
    }
    // [KẾ TOÁN NĐT 24/11] PHẠM VI KHÓA: chỉ được GHI bill cho TID thuộc NĐT mình. TID resolve bằng CHUỖI đã trim —
    // ĐÚNG như createLoFromBillTid (db.tid.findFirst where tid = tidTrimmed, deletedAt null) để không lệch khóa.
    // FAIL-CLOSED: TID không tồn tại / không gắn NĐT / gắn NĐT khác ⇒ 403 (không rò bill vào sổ NĐT khác).
    {
      const scopeId = await resolveScopeInvestorId(ctx);
      if (scopeId != null) {
        const row = (await getDb().$queryRawUnsafe<Array<{ investor_id: number | null }>>(
          `SELECT ra.investor_id FROM tids t
             LEFT JOIN receive_accounts ra ON ra.id = t.receive_account_id
            WHERE t.tid = $1 AND t.deleted_at IS NULL
            LIMIT 1`,
          tidString
        ))[0];
        if (!row || row.investor_id == null || Number(row.investor_id) !== scopeId) {
          res.status(403).json({
            ok: false, error: 'FORBIDDEN',
            message: 'TID "' + tidString + '" không thuộc nhà đầu tư trong phạm vi của bạn — '
              + 'kế toán NĐT chỉ được ghi bill cho TID của nhà đầu tư mình phụ trách.'
          });
          return;
        }
        // [KẾ TOÁN NĐT 24/11 — vá audit C1 CRITICAL] CHẶN HIJACK khi SỬA: scope trên CHỈ kiểm TID MỚI; nếu không
        // kiểm LÔ ĐANG SỬA thuộc ai thì Kế toán A gửi editingLoId = lô của NĐT B + tidString của A ⇒ KÉO doanh số
        // của B sang A (repro audit: lô #B đổi tid_id → A, 200). FAIL-CLOSED: mọi TID của lô đang sửa phải thuộc scope.
        if (suaLoId !== undefined) {
          const chuLo = await getDb().$queryRawUnsafe<Array<{ investor_id: number | null }>>(
            `SELECT DISTINCT ra.investor_id
               FROM lo_rows r JOIN tids t ON t.id = r.tid_id
               LEFT JOIN receive_accounts ra ON ra.id = t.receive_account_id
              WHERE r.lo_id = $1`,
            suaLoId
          );
          const ngoaiScope = chuLo.length === 0 || chuLo.some((x) => x.investor_id == null || Number(x.investor_id) !== scopeId);
          if (ngoaiScope) {
            res.status(403).json({
              ok: false, error: 'FORBIDDEN',
              message: 'Bill #' + suaLoId + ' không thuộc nhà đầu tư trong phạm vi của bạn — '
                + 'kế toán NĐT chỉ được sửa bill của nhà đầu tư mình phụ trách.'
            });
            return;
          }
        }
      }
    }
    if (amountBeforeFee === undefined || !Number.isSafeInteger(amountBeforeFee) || amountBeforeFee <= 0) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Số tiền không hợp lệ (phải là số nguyên dương trong ngưỡng an toàn).' });
      return;
    }
    const TRAN_TIEN = 100_000_000_000; // 100 tỉ/bill — trên mức này gần như chắc chắn gõ sai
    if (amountBeforeFee > TRAN_TIEN) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Số tiền vượt trần cho phép (100 tỉ/bill).' });
      return;
    }
    if (daHoan !== undefined && (!Number.isSafeInteger(daHoan) || daHoan < 0 || daHoan > TRAN_TIEN)) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Số tiền đã hoàn không hợp lệ.' });
      return;
    }
    // Kiểm FAIL-CLOSED cho 2 trường mới — thà từ chối còn hơn ghi một con số mâu thuẫn với số đã tính tiền.
    if (tienHuyNhap !== undefined && (!Number.isSafeInteger(tienHuyNhap) || tienHuyNhap < 0 || tienHuyNhap > TRAN_TIEN)) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Tiền hủy không hợp lệ.' });
      return;
    }
    // BẤT BIẾN: tổng quẹt − tiền hủy PHẢI bằng đúng số đem đi tính tiền. Lệch = màn hình và máy chủ hiểu khác
    // nhau về doanh số ⇒ TỪ CHỐI, không đoán bên nào đúng.
    // [B191 19/11 — agent audit] BẮT BUỘC ĐI CẶP: trước đây chỉ cần BỎ `totalAmount` là bất biến không chạy,
    // mà `voidAmount` vẫn được ghi ⇒ cột TỔNG QUẸT (số dùng đối soát sao kê) nhận giá trị bất kỳ, 90 tỉ cũng lọt.
    if ((tienHuyNhap !== undefined) !== (tongQuetNhap !== undefined)) {
      res.status(400).json({
        ok: false, error: 'VALIDATION',
        message: 'Tiền hủy và tổng quẹt phải gửi CÙNG NHAU (thiếu một trong hai thì không kiểm được số liệu có khớp không).'
      });
      return;
    }
    if (tienHuyNhap !== undefined && tongQuetNhap !== undefined && tienHuyNhap > tongQuetNhap) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Tiền hủy không thể lớn hơn tổng quẹt.' });
      return;
    }
    if (tongQuetNhap !== undefined && tienHuyNhap !== undefined
        && tongQuetNhap - tienHuyNhap !== amountBeforeFee) {
      res.status(400).json({
        ok: false, error: 'VALIDATION',
        message: `Số liệu mâu thuẫn: tổng quẹt ${tongQuetNhap} − tiền hủy ${tienHuyNhap} ≠ số ghi doanh số ${amountBeforeFee}.`
      });
      return;
    }
    // [B191] Ghi chú quá dài: TỪ CHỐI thay vì cắt câm 500 ký tự (người dùng mất chữ mà không biết).
    if (ghiChuNhap.length > 500) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: `Ghi chú quá dài (${ghiChuNhap.length}/500 ký tự) — hãy rút gọn.` });
      return;
    }
    if (soHoaDonNhap.length > 50) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Số hóa đơn quá dài (tối đa 50 ký tự).' });
      return;
    }
    // [B191 — agent audit] ĐẠI LÝ MƯỢN MÁY phải TỒN TẠI. Trước đây nhận thẳng rồi ghi: gửi id 999999 vẫn 200,
    // doanh số quy về "đại lý ma" — biến mất khỏi cả chủ máy lẫn nhà mượn, mà bảng Doanh Số vẫn hiện tên chủ máy
    // nên nhìn không thấy gì bất thường. `los` KHÔNG có khoá ngoại nào nên không ai chặn hộ.
    if (borrowedByCustomerId !== undefined && borrowedByCustomerId !== null) {
      const kh = await getDb().customer.findUnique({ where: { id: borrowedByCustomerId }, select: { id: true, deletedAt: true } });
      if (!kh || kh.deletedAt) {
        res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Đại lý mượn máy không tồn tại (hoặc đã bị xóa).' });
        return;
      }
    }
    if ((daHoan ?? 0) > 0 && !nguoiHoanId) {
      res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Có tiền đã hoàn thì phải cho biết NGƯỜI HOÀN.' });
      return;
    }
    if (nguoiHoanId !== undefined && nguoiHoanId !== null) {
      // `db` của handler này khai ở dưới (sau phần kiểm đầu vào) — lấy riêng ở đây, cùng 1 nguồn getDb().
      const nh = await getDb().user.findUnique({ where: { id: nguoiHoanId }, select: { id: true, deletedAt: true } });
      if (!nh || nh.deletedAt) {
        res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Người hoàn không tồn tại (hoặc đã bị xoá).' });
        return;
      }
    }
    let txnDate: Date | undefined;
    if (txnDateRaw) {
      const d = new Date(txnDateRaw);
      if (Number.isNaN(d.getTime())) {
        res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Ngày/giờ bill không hợp lệ.' });
        return;
      }
      txnDate = d;
    }
    // Tách nhiều loại thẻ
    let lines: { cardTypeId: number; amountBeforeFee: number }[] | undefined;
    const rawLines = b['lines'];
    if (Array.isArray(rawLines) && rawLines.length > 0) {
      lines = [];
      for (const l of rawLines as Record<string, unknown>[]) {
        const c = num(l['cardTypeId']);
        const a = num(l['amountBeforeFee']);
        if (c === undefined || a === undefined || !Number.isSafeInteger(a) || a <= 0) {
          res.status(400).json({ ok: false, error: 'VALIDATION', message: 'Dòng tách loại thẻ không hợp lệ.' });
          return;
        }
        lines.push({ cardTypeId: c, amountBeforeFee: a });
      }
      const tong = lines.reduce((s, l) => s + l.amountBeforeFee, 0);
      if (tong !== amountBeforeFee) {
        res.status(400).json({
          ok: false,
          error: 'VALIDATION',
          message: `Tổng các dòng thẻ (${tong}) không khớp tổng bill (${amountBeforeFee}) — không ghi doanh số lệch.`
        });
        return;
      }
    }

    const db = getDb();
    const bot = await ensureSupportAlphaAgent(db);

    // [B188] ĐANG SỬA: gắn khoá bill MỚI lên chính lô đang sửa, để bước ghi bên dưới CẬP NHẬT lô đó thay vì
    // tạo lô mới. Fail-closed từng bước — thà từ chối còn hơn đẻ thêm một lô tiền.
    let khoaCuDaDoi: string | null | undefined; // [B314] khoá cũ của lô đang sửa, chỉ set khi đã ghi đè
    if (suaLoId !== undefined) {
      const loCu = (await db.$queryRawUnsafe<Array<{ id: number; status: string; bill_key: string | null; agent_id: number }>>(
        'SELECT id, status, bill_key, agent_id FROM los WHERE id = $1', suaLoId
      ))[0];
      if (!loCu) {
        res.status(404).json({ ok: false, error: 'NOT_FOUND', message: 'Bill cần sửa không còn trong sổ (có thể vừa bị hủy) — hãy tải lại danh sách.' });
        return;
      }
      if (loCu.status === 'CANCELLED') {
        res.status(409).json({ ok: false, error: 'CONFLICT', message: 'Bill này đã bị hủy — không sửa được nữa.' });
        return;
      }
      if (loCu.status !== 'PENDING') {
        res.status(409).json({ ok: false, error: 'CONFLICT', message: `Bill đã chốt (trạng thái ${loCu.status}) — không sửa được. Hãy gửi yêu cầu hủy rồi nhập lại.` });
        return;
      }
      // Lô đã ĐỐI SOÁT hoặc đã HOÀN TIỀN thì cấm sửa: số đã dùng để trả tiền cho đại lý.
      // Cột là `lot_id` — tên sai thì câu lệnh ném lỗi; KHÔNG bắt rồi coi như 0 (nuốt im = chốt chặn giả).
      const daChot = (await db.$queryRawUnsafe<Array<{ n: number }>>(
        `SELECT count(*)::int AS n FROM pos_lot_recon WHERE lot_id = $1 AND (ds IS TRUE OR refund_done IS TRUE)`, suaLoId
      ))[0];
      if ((daChot?.n ?? 0) > 0) {
        res.status(409).json({ ok: false, error: 'CONFLICT', message: 'Bill đã đối soát/đã hoàn tiền — không sửa được. Hãy gửi yêu cầu hủy rồi nhập lại.' });
        return;
      }
      // [B271 24/11 — audit doanh số] KHÔNG CÓ KHOÁ BILL thì `createLoFromBillTid` bỏ qua nhánh UPSERT và
      // ĐẺ LÔ MỚI, lô cũ vẫn sống ⇒ DOANH SỐ ĐẾM 2 LẦN (tái hiện: lô 7528 20tr + sửa → lô 7529 15tr, cả hai
      // PENDING, bảng cộng 35tr). Khoá rỗng hay gặp nhất khi số lô gõ là "0" (chuẩn hoá bỏ 0 dẫn đầu ra chuỗi
      // rỗng) và không có số hóa đơn. Fail-closed: thà từ chối còn hơn nhân đôi tiền.
      if (!billKey) {
        res.status(400).json({
          ok: false, error: 'SUA_BILL_THIEU_KHOA',
          message: `Bill #${suaLoId} không có số lô/số hóa đơn để nhận dạng (số lô chỉ gồm số 0 được coi là `
            + 'trống) — sửa tiếp sẽ đẻ ra bill thứ hai và doanh số bị cộng hai lần. '
            + 'CÁCH SỬA: điền SỐ LÔ thật (khác 0) hoặc SỐ HÓA ĐƠN in trên bill rồi ghi lại.'
        });
        return;
      }
      if (billKey && loCu.bill_key !== billKey) {
        // Khoá mới đã thuộc bill KHÁC ⇒ từ chối, nếu không hai bill sẽ bị gộp làm một (mất doanh số).
        const dungRoi = (await db.$queryRawUnsafe<Array<{ id: number }>>(
          `SELECT id FROM los WHERE bill_key = $1 AND id <> $2 AND status <> 'CANCELLED' LIMIT 1`, billKey, suaLoId
        ))[0];
        if (dungRoi) {
          res.status(409).json({
            ok: false, error: 'CONFLICT',
            message: `Số lô/số hóa đơn/ngày vừa sửa đã thuộc bill khác (lô #${dungRoi.id}) — sửa tiếp sẽ gộp nhầm 2 bill. Hãy kiểm tra lại.`
          });
          return;
        }
        await db.$executeRawUnsafe('UPDATE los SET bill_key = $1 WHERE id = $2', billKey, suaLoId);
        // [B314/N1 24/11] Khoá mới đã dính lên lô TRƯỚC khi engine duyệt — engine từ chối ở bước sau thì
        // phải TRẢ LẠI khoá cũ, kẻo lô mang khoá của lần sửa hụt (lần sửa sau dò theo khoá cũ là trượt).
        khoaCuDaDoi = loCu.bill_key;
      }
    }
    const r = await createLoFromBillTid(db, bot.id, {
      // [B201 19/11 — Admin Demo "bỏ hết lỗi báo chưa liên kết đại lý nhóm chat đi"] Đây là màn NHÂN VIÊN nhập
      // tay, không phải đại lý gửi bill qua Zalo ⇒ không áp bước kiểm "phải cùng nhóm chat với đại lý".
      nhanVienNhapTay: true,
      // [B188] ĐANG SỬA ⇒ cho phép GIẢM tổng lô (sửa 10tr xuống 8tr) và cho ghi đè chính nó. Không có 2 cờ
      // này thì engine coi là "re-send thu nhỏ" ⇒ GIỮ số cũ nhưng vẫn trả ok ⇒ màn báo lệch số rất khó hiểu.
      allowShrink: suaLoId !== undefined,
      feeTypeId: loaiPhiNhap,
      tidString,
      cardTypeId,
      amountBeforeFee,
      lines,
      billKey,
      allowDuplicate,
      txnDate,
      borrowedByCustomerId: borrowedByCustomerId ?? undefined,
      settlementCode
    });

    // [B305/F10 24/11 — agent phản biện] DONG_BO_GD_LOI khi ĐANG SỬA: lô ĐÃ đổi số nhưng GD chưa đồng
    // bộ. Bản B273 đầu tiên thoát NGAY tại đây ⇒ 5 lệnh ghi phụ bên dưới (số lô · ghi chú · tiền hủy/số
    // HĐ · tiền hoàn) bị BỎ — các ô người dùng vừa gõ biến mất không một lời (đúng lớp B172/B177/B178).
    // Nay: vẫn chạy TRỌN khối ghi phụ cho lô đang sửa, rồi mới trả lỗi đồng bộ (câu báo nói rõ phụ ĐÃ lưu).
    // [B284 lần 2] GHI MỚI mà bridge hỏng: service nay trả ok:true + bridgeError (đường đại lý cần
    // best-effort). Màn NHẬP TAY thì fail-loud: coi như lỗi đồng bộ — vẫn lưu ô phụ rồi báo rõ.
    const loiDongBoGd =
      (!r.ok && r.error === 'DONG_BO_GD_LOI' && suaLoId !== undefined ? (r.message ?? 'GD chưa đồng bộ') : null)
      ?? (r.ok && (r as { bridgeError?: string }).bridgeError
        ? 'chưa tạo được giao dịch kèm theo (' + (r as { bridgeError?: string }).bridgeError + ')'
        : null);
    if (!r.ok && loiDongBoGd == null) {
      // [B314/N1] Engine TỪ CHỐI mà khoá bill đã bị ghi đè ở bước trên → trả lại khoá CŨ cho lô.
      if (khoaCuDaDoi !== undefined && suaLoId !== undefined) {
        await db.$executeRawUnsafe('UPDATE los SET bill_key = $1 WHERE id = $2', khoaCuDaDoi, suaLoId).catch((e: unknown) => {
          console.error('[bill-manual B314] KHONG tra lai duoc khoa cu cho lo ' + suaLoId + ':', e);
        });
      }
      // DUP_SUSPECT = nghi trùng doanh số: màn hình phải hỏi lại người dùng rồi gửi allowDuplicate.
      const ma = r.error === 'DUP_SUSPECT' ? 409 : r.error === 'NOT_FOUND' ? 404 : 422;
      res.status(ma).json({ ok: false, error: r.error, message: r.message });
      return;
    }

    const loId = r.ok ? r.data.id : suaLoId!; // ghi mới + bridge hỏng: loId vẫn là lô mới (r.ok=true)
    // [B193 19/11 — agent audit] 5 lệnh ghi phụ bên dưới (số lô · người nhập · ghi chú · tiền hủy/số HĐ ·
    // tiền hoàn) nằm NGOÀI giao dịch tạo lô. Trước đây một lệnh ném lỗi là API trả 500 TRONG KHI LÔ + GIAO
    // DỊCH ĐÃ NẰM TRONG SỔ và đã hiện trên bảng Doanh Số (tái hiện: ghi chú chứa ký tự NUL ⇒ 500, mà
    // 45.019.425đ vẫn vào sổ) ⇒ người dùng nhập lại, đổi số lô là ghi thêm lô thứ hai = doanh số x2.
    // Nay: bọc cả khối, lỗi thì HỦY lô vừa tạo rồi mới báo — không để trạng thái nửa vời câm (R198).
    try {
    // SỐ LÔ NGÂN HÀNG: `createLoFromBillTid` KHÔNG nhận trường này (nó chỉ nằm trong khoá bill), nên cột
    // `bank_reported_lo_number` để trống → cột "Lô" trên bảng Doanh Số rỗng. Người nhập tay thì GÕ RÕ số lô,
    // phải lưu lại. CHỈ ghi khi cột đang TRỐNG — không bao giờ đè số đã có (vd lô đã đối soát).
    if (soLo !== undefined && Number.isInteger(soLo) && soLo > 0) {
      // [B188 19/11] ĐANG SỬA thì ghi THẲNG (Admin Demo: "sửa bill phải sửa được … số lô"). Khi ghi MỚI thì giữ
      // nếp cũ: chỉ điền khi đang trống, không đè số lô đã có (vd lô đã đối soát).
      await db.$executeRawUnsafe(
        suaLoId !== undefined
          ? 'UPDATE los SET bank_reported_lo_number = $1 WHERE id = $2'
          : 'UPDATE los SET bank_reported_lo_number = $1 WHERE id = $2 AND bank_reported_lo_number IS NULL',
        soLo,
        loId
      );
    }

    // [B177] NGƯỜI NHẬP: `createLoFromBillTid` tạo lô dưới danh nghĩa tài khoản bot nên `created_by` để
    // trống ⇒ cột "Người nhập" rỗng, không truy được ai gõ bill. Ghi CHÍNH người đang đăng nhập, và CHỈ khi
    // cột đang trống — không bao giờ đè vết cũ.
    await db.$executeRawUnsafe(
      'UPDATE los SET created_by = $1 WHERE id = $2 AND created_by IS NULL',
      ctx.user.id,
      loId
    );
    // [B177] GHI CHÚ: lưu vào chính giao dịch của lô, chỉ khi đang trống (không đè ghi chú có sẵn).
    // [B188] ĐANG SỬA: ghi chú ghi THẲNG (kể cả xoá trắng). Ghi MỚI: chỉ điền khi đang trống.
    if (suaLoId !== undefined) {
      await db.$executeRawUnsafe(
        'UPDATE transactions SET note = $1 WHERE id = (SELECT transaction_id FROM los WHERE id = $2)',
        ghiChuNhap ? ghiChuNhap.slice(0, 500) : null,
        loId
      );
    } else if (ghiChuNhap) {
      await db.$executeRawUnsafe(
        `UPDATE transactions SET note = $1
          WHERE id = (SELECT transaction_id FROM los WHERE id = $2) AND COALESCE(note, '') = ''`,
        ghiChuNhap.slice(0, 500),
        loId
      );
    }

    // [B178] Ghi TIỀN HỦY + SỐ HÓA ĐƠN lên lô. Là VẾT GHI CHÉP (để đối soát sao kê — sao kê in TỔNG QUẸT),
    // KHÔNG sinh bút toán và KHÔNG đụng `amount_before_fee`/`amount_after_fee` đã tính.
    if (tienHuyNhap !== undefined || soHoaDonNhap) {
      await db.$executeRawUnsafe(
        `UPDATE los SET void_amount = COALESCE($1::bigint, void_amount),
                        invoice_no  = COALESCE(NULLIF($2::text, ''), invoice_no)
          WHERE id = $3`,
        tienHuyNhap ?? null,
        soHoaDonNhap,
        loId
      );
    }

    // [B172] Ghi TIỀN HOÀN + NGƯỜI HOÀN lên lô. Gửi 2 trường rỗng ⇒ KHÔNG đụng (không xoá vết cũ).
    // `refunded_at` chỉ đặt khi THỰC SỰ có tiền hoàn; dùng now() của MÁY CHỦ (không nhận giờ từ màn hình).
    // [B278 24/11 — audit doanh số] TỪNG TRƯỜNG chỉ đụng khi ĐƯỢC GỬI. Bản cũ điều kiện HOẶC + gán thẳng:
    // caller chỉ gửi `refundedByUserId` (không gửi tiền) là `refunded_amount` bị GHI ĐÈ NULL — xoá sạch
    // 5.000.000đ tiền hoàn mà API vẫn trả 200 (tái hiện ở mức API; màn desktop luôn gửi cả hai nên chưa lọt
    // qua UI, nhưng bản web/app khác gọi thẳng là mất). COALESCE với giá trị hiện có khi trường vắng mặt.
    if (daHoan !== undefined || nguoiHoanId !== undefined) {
      await db.$executeRawUnsafe(
        `UPDATE los SET refunded_amount     = CASE WHEN $4::boolean THEN $1::bigint ELSE refunded_amount END,
                        refunded_by_user_id = CASE WHEN $5::boolean THEN $2::int    ELSE refunded_by_user_id END,
                        refunded_at = CASE WHEN COALESCE(CASE WHEN $4::boolean THEN $1::bigint ELSE refunded_amount END, 0) > 0
                                           THEN COALESCE(refunded_at, now()) ELSE NULL END
          WHERE id = $3`,
        daHoan ?? null,
        nguoiHoanId ?? null,
        loId,
        daHoan !== undefined,
        nguoiHoanId !== undefined
      );
    }

    } catch (eGhiPhu) {
      // [B269 24/11 — audit doanh số, CHẶN SHIP] ĐANG SỬA thì `loId` LÀ LÔ GỐC ĐANG SỐNG, không phải lô
      // vừa đẻ ra. Khối dọn B193 bên dưới không phân biệt 2 cảnh này ⇒ một lỗi ghi phụ (tái hiện: gõ số lô
      // 3.000.000.000) là HỦY TRẮNG lô cũ + xoá mềm giao dịch ⇒ MẤT 10.000.000đ doanh số chỉ vì một ô số lô.
      // Khi sửa: KHÔNG hủy gì cả, chỉ báo lỗi và nói rõ lô vẫn còn nguyên.
      if (suaLoId !== undefined) {
        console.error('[bill-manual B269] ghi phụ lỗi khi ĐANG SỬA lô ' + loId + ' — giữ nguyên lô:', eGhiPhu);
        res.status(500).json({
          ok: false, error: 'SUA_BILL_LOI_GHI_PHU', loId,
          message: `Sửa bill thất bại ở bước lưu thông tin phụ. Lô #${loId} VẪN CÒN NGUYÊN trong sổ `
            + '(doanh số không mất, không bị hủy). CÁCH SỬA: kiểm lại các ô vừa đổi — hay gặp nhất là '
            + 'SỐ LÔ / SỐ HÓA ĐƠN gõ quá dài — rồi bấm ghi lại.'
        });
        return;
      }
      // [B193] Dọn sạch: lô vừa TẠO MỚI chưa hoàn chỉnh ⇒ HỦY nó (giữ vết lý do) để sổ không ôm bill nửa
      // vời, rồi báo lỗi NÓI RÕ lô nào đã bị hủy — người dùng biết chắc là nhập lại được, không ghi 2 lần.
      try {
        await db.$executeRawUnsafe(
          `UPDATE los SET status = 'CANCELLED', cancel_reason = $1, cancelled_at = now() WHERE id = $2`,
          'Ghi phụ lỗi sau khi tạo lô — hủy để không để lại bill nửa vời: ' + String(eGhiPhu).slice(0, 180),
          loId
        );
        await db.$executeRawUnsafe(
          // [B285/F5] hủy GD = CANCELLED + cancelled_at, không chỉ xoá mềm (bất biến "hủy ⇒ CANCELLED").
          `UPDATE transactions SET deleted_at = now(), status = 'CANCELLED', cancelled_at = now(),
                  cancel_reason = 'B193: lô bị hủy vì ghi phụ lỗi'
            WHERE id = (SELECT transaction_id FROM los WHERE id = $1)`,
          loId
        );
      } catch (eDon) {
        // [B286/S8 24/11 — audit R198] Lệnh DỌN hỏng mà vẫn nói "lô ĐÃ BỊ HỦY. Hãy nhập lại" là LỜI NÓI
        // DỐI: lô nửa vời còn nguyên, nhập lại là doanh số đếm 2 lần. Nói đúng sự thật + chặn nhập lại.
        console.error('[bill-manual B193] KHÔNG hủy được lô ' + loId + ' sau khi ghi phụ lỗi:', eDon);
        res.status(500).json({
          ok: false, error: 'INTERNAL_ERROR', loId,
          message: `Ghi bill lỗi ở bước lưu thông tin phụ VÀ không hủy được lô #${loId} — lô này CÓ THỂ VẪN `
            + 'NẰM TRONG SỔ. ĐỪNG nhập lại ngay (dễ đếm hai lần). CÁCH SỬA: bấm Làm mới xem lô còn không, '
            + 'rồi báo kỹ thuật kèm mã lô.'
        });
        return;
      }
      console.error('[bill-manual B193] ghi phụ lỗi, đã hủy lô ' + loId + ':', eGhiPhu);
      res.status(500).json({
        ok: false, error: 'INTERNAL_ERROR',
        message: `Ghi bill thất bại ở bước lưu thông tin phụ — lô #${loId} ĐÃ BỊ HỦY, sổ không giữ bill nửa vời. Hãy nhập lại.`
      });
      return;
    }

    if (loiDongBoGd != null) {
      // [B305] Phụ đã lưu xong — giờ mới báo lỗi đồng bộ GD, nói rõ cái gì ĐÃ vào sổ.
      res.status(409).json({
        ok: false, error: 'DONG_BO_GD_LOI', loId,
        message: `Bill #${loId}: SỐ TIỀN/THẺ/NGÀY và các ô phụ (số lô, ghi chú, tiền hủy, tiền hoàn) ĐÃ LƯU, `
          + 'nhưng GIAO DỊCH kèm theo chưa đồng bộ được: ' + loiDongBoGd
          + ' ĐỪNG ghi lại bill (sẽ đếm hai lần) — báo kỹ thuật kèm mã lô để hàn giao dịch.'
      });
      return;
    }

    // ── ĐỌC LẠI TỪ DB rồi SO với số màn hình gửi lên (R196: ghi xong chưa phải là đúng) ──
    const dongThe = await db.loRow.findMany({ where: { loId } });
    const tongTruocPhi = dongThe.reduce((s, x) => s + Number(x.amountBeforeFee), 0);
    const tongSauPhi = dongThe.reduce((s, x) => s + Number(x.amountAfterFee), 0);
    const lech: string[] = [];
    if (tongTruocPhi !== amountBeforeFee) lech.push(`tiền trước phí trong sổ ${tongTruocPhi} ≠ số đã nhập ${amountBeforeFee}`);
    if (lines && dongThe.length !== lines.length) lech.push(`số dòng thẻ trong sổ ${dongThe.length} ≠ số dòng đã nhập ${lines.length}`);
    if ((daHoan ?? 0) > 0) {
      const ktra = await db.$queryRawUnsafe<Array<{ n: string | null; u: number | null }>>(
        'SELECT refunded_amount::text AS n, refunded_by_user_id AS u FROM los WHERE id = $1', loId);
      const ghiDuoc = ktra[0] ? Number(ktra[0].n ?? 0) : 0;
      if (ghiDuoc !== daHoan) lech.push(`tiền đã hoàn trong sổ ${ghiDuoc} ≠ số đã nhập ${daHoan}`);
      if ((ktra[0]?.u ?? null) !== (nguoiHoanId ?? null)) lech.push('người hoàn trong sổ khác người đã chọn');
    }
    const sauPhiTrenMan = num(b['expectedAmountAfterFee']);
    if (sauPhiTrenMan !== undefined && sauPhiTrenMan !== tongSauPhi) {
      lech.push(`tiền về đại lý trong sổ ${tongSauPhi} ≠ số hiện trên màn ${sauPhiTrenMan}`);
    }

    await writeAudit(db, {
      actorUserId: ctx.user.id,
      // Dùng ĐÚNG mã audit đã khai cho lô SigMa — không tự đặt mã mới (mã lạ không hiện ở màn Nhật ký).
      action: 'SIGMA_LO_CREATED',
      targetType: 'Lo',
      targetId: String(loId),
      after: { tidString, amountBeforeFee, tongSauPhi, billKey, borrowedByCustomerId: borrowedByCustomerId ?? null, lech },
      ip: req.ip ?? null,
      userAgent: req.get('user-agent') ?? null
    });

    if (lech.length) {
      // KHÔNG im lặng: số đã vào sổ nhưng KHÁC số người ký duyệt — phải nói ngay, kèm mã lô để tra.
      res.status(409).json({
        ok: false,
        error: 'SO_LECH_SAU_GHI',
        loId,
        message: 'ĐÃ ghi vào sổ nhưng số đọc lại KHÔNG khớp số trên màn: ' + lech.join(' · ') + `. Mã lô ${loId} — kiểm tra ngay.`
      });
      return;
    }

    res.json({
      ok: true,
      data: { loId, amountBeforeFee: tongTruocPhi, amountAfterFee: tongSauPhi, soDongThe: dongThe.length }
    });
  })
);
