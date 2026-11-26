// SigMa Tier 1 — báo giá phí bán cho 1 dòng (tid × loại thẻ × loại phí × số tiền trước phí).
// DB access (fetch override/quotes) sống Ở ĐÂY (caller); công thức "override đè niêm yết" gọi THẲNG
// `resolveActualSellFee` trong @sigma/business-rules — CÙNG hàm mà apps/desktop/src/main/transaction-service.ts
// (resolveFeeForTxn) gọi, để không có 2 cài đặt công thức lệch nhau (yêu cầu LEAD).
import { marginToAmount, resolveActualSellFee } from '@sigma/business-rules';
import { resolveWeekendSellDeltaMilli } from '@sigma/services';
import type { Db } from '@sigma/database';
import { agentScopeCustomerIds } from './agent-tid-scope.js';
import { classifyCardType, pickDefaultCardTypeId, resolveDetectedCardTypeId, type CardKlass, type CardDetection } from './card-classify.js';

export interface QuoteRowInput {
  tidId: number;
  // [Admin Demo 25/9 — GIÁ BÁN THEO ĐẠI LÝ] đại lý ĐANG CẦM máy cho dòng này (mượn TID → NHÀ MƯỢN). Có giá riêng của
  // nhà đó thì XEM TRƯỚC phải hiện giá riêng, nếu không màn review báo một đằng, ghi doanh số một nẻo.
  dealerCustomerId?: number | null;
  // cardTypeId/feeTypeId TÙY CHỌN — LEAD đã chốt rule mặc định bằng trích dẫn source code (không đoán ngầm):
  // - feeTypeId mặc định = FeeType đầu tiên theo `orderBy: { id: 'asc' }` — ĐÚNG query
  //   apps/desktop/src/main/fee-config-service.ts:97 (listFeeTypes) đã dùng. Rule là "đầu theo id", KHÔNG
  //   match theo tên (hiện tại DB thường là "Tiền nhanh" nhưng đó là DỮ LIỆU, không phải RULE).
  // - cardTypeId mặc định = CardType đầu tiên của bank TID theo `orderBy: { id: 'asc' }` — ĐÚNG query
  //   apps/desktop/src/main/tid-sell-fee-service.ts:62 đã dùng. Rule là "đầu theo id", KHÔNG match theo tên
  //   (hiện tại DB thường là "Visa" nhưng đó là DỮ LIỆU, không phải RULE).
  // Khi TID chưa có card type nào active cho bank của nó → NOT_FOUND (không có gì để mặc định).
  cardTypeId?: number;
  feeTypeId?: number;
  amountBeforeFee: number;
  /**
   * [B201 19/11 — Admin Demo "bỏ hết lỗi báo chưa liên kết đại lý nhóm chat đi"] NHÂN VIÊN NHẬP TAY.
   *
   * Phạm vi đại lý dưới đây suy từ NHÓM CHAT: TID thuộc khách mà tài khoản gọi phải là thành viên nhóm chat
   * còn sống. Điều đó ĐÚNG cho luồng BOT (đại lý tự gửi bill qua Zalo — không được ghi doanh số cho nhà khác),
   * nhưng SAI cho màn "Thêm bill": người nhập là NHÂN VIÊN công ty, vốn có quyền ghi doanh số mọi TID, mà lại
   * phải mượn danh nghĩa tài khoản bot ⇒ TID nào thuộc khách chưa có bot trong nhóm chat đều bị từ chối.
   * Đo trên sổ thật 19/11: 12/27 đại lý nằm ngoài phạm vi ⇒ 16 TID đang chạy KHÔNG nhập tay được
   * (Mi Gin SG 6 máy, Đại lý B 3, Dũng YN HN 2 — chính là ca "THANH TÙNG 06-2" Admin Demo báo sáng nay).
   *
   * Bật cờ này CHỈ bỏ bước kiểm nhóm chat. Vẫn giữ nguyên: TID phải ĐÃ GIAO KHÁCH (không có khách thì không
   * biết doanh số về đại lý nào) + phải có đối tác + phải có giá bán thực tế.
   */
  nhanVienNhapTay?: boolean;
}

export interface QuoteRowResult {
  tidId: number;
  // cardTypeId/feeTypeId THỰC TẾ ĐÃ DÙNG để tính (khớp giá trị truyền vào NẾU CÓ, hoặc giá trị mặc định đã
  // resolve khi input bỏ trống — xem logic mặc định "đầu theo id" ở trên). Thêm 2 trường này (build
  // SIGMA 22/7, CMD_BUILD) để: (1) bot hiển thị được đã báo giá theo loại thẻ/loại phí nào ngay cả khi
  // caller bỏ trống; (2) POST /lo tái dùng NGUYÊN hàm này mà KHÔNG phải resolve lại lần 2 (tránh trùng logic)
  // để lưu LoRow (cần cardTypeId/feeTypeId NOT NULL). Thuần ADDITIVE — không đổi 4 field cũ.
  cardTypeId: number;
  feeTypeId: number;
  amountBeforeFee: number;
  feeApplied: number;
  amountAfterFee: number;
  // Tỷ lệ phí bán THỰC TẾ đã áp (milli-%, tức % × 1000 — 1500 = 1.5%) = `resolved.phiBanMilli` từ
  // resolveActualSellFee. Thuần ADDITIVE (build fee-preview 21/8). Lý do: client "Hoàn tiền" TRƯỚC ĐÂY tự
  // suy % = feeApplied/amount → lệch khi làm tròn/phí bậc thang; nay hiện ĐÚNG tỷ lệ backend đã cấu hình,
  // KHÔNG suy ngược. KHÔNG đổi field cũ.
  phiBanMilli: number;
}

export type QuoteRowError =
  | { ok: false; error: 'VALIDATION'; message: string }
  | { ok: false; error: 'TID_NOT_IN_AGENT_SCOPE'; message: string }
  | { ok: false; error: 'NOT_FOUND'; message: string }
  | { ok: false; error: 'NO_PARTNER'; message: string }
  | { ok: false; error: 'CARD_BANK_MISMATCH'; message: string }
  | { ok: false; error: 'NO_SELL_QUOTE'; message: string }
  // Admin Demo 20/8: niêm yết CHỈ để tham khảo của công ty — bill/giao dịch ĐẠI LÝ KHÔNG được mượn % niêm yết. TID
  // đã giao khách nhưng CHƯA set giá bán thực tế (override tid_sell_fees) → "chưa cấu hình giá bán", KHÔNG áp niêm yết.
  | { ok: false; error: 'NO_ACTUAL_SELL_FEE'; message: string };

/** Số tiền VND: số nguyên ≥ 0 (khớp parseAmount của transaction-service.ts). EXPORT để lo-service.reconcileLo
 * dùng CHUNG một định nghĩa "số tiền hợp lệ" với createLo/quoteRow (BOT-5: reconcileLo trước đây chỉ kiểm
 * Number.isFinite → chấp nhận số âm/thập phân, có thể ép khớp tam giác gian lận). */
export function isValidAmount(v: unknown): v is number {
  // [B191 19/11 — agent audit] TRẦN TIỀN đặt Ở ĐÂY (gốc dùng chung), không để mỗi route tự đặt: đường
  // `/v1/me/lo/from-bill` không có trần nên số trên MAX_SAFE_INTEGER lọt vào, mất chính xác (9.007.199.254.740.993
  // thành ...992) rồi lô nằm mãi không tạo được giao dịch, tiến trình vá lại cứ fail 6 giờ một lần.
  if (!Number.isSafeInteger(v as number)) return false;
  if ((v as number) > 100_000_000_000) return false; // 100 tỉ/bill — trên mức này gần như chắc chắn gõ sai

  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

/**
 * Tính báo giá 1 dòng cho TID đã xác nhận thuộc đúng đại lý (agentId khớp — kiểm ở caller/route TRƯỚC khi
 * gọi hàm này, đây là ranh giới bảo mật, không phải tiện ích UX — xem routes/agents.ts). Trả lỗi tường minh
 * theo từng nhánh, KHÔNG bao giờ đoán ngầm.
 */
export async function quoteRow(db: Db, agentId: number, row: QuoteRowInput, at: Date = new Date()): Promise<{ ok: true; data: QuoteRowResult } | QuoteRowError> {
  if (
    !Number.isInteger(row.tidId) ||
    (row.cardTypeId !== undefined && !Number.isInteger(row.cardTypeId)) ||
    (row.feeTypeId !== undefined && !Number.isInteger(row.feeTypeId))
  )
    return { ok: false, error: 'VALIDATION', message: 'tidId phải là số nguyên; cardTypeId/feeTypeId nếu có mặt cũng phải là số nguyên.' };
  if (!isValidAmount(row.amountBeforeFee))
    return { ok: false, error: 'VALIDATION', message: 'amountBeforeFee phải là số nguyên ≥ 0.' };

  const tid = await db.tid.findUnique({ where: { id: row.tidId } });
  if (!tid || tid.deletedAt) return { ok: false, error: 'NOT_FOUND', message: `TID id=${row.tidId} không tồn tại.` };
  // PHẠM VI ĐẠI LÝ qua nhóm chat (audit 20/8 I1) — CÙNG helper với listAgentTidsWithCardTypeOptions. THAY gate cũ
  // `tid.agentId !== agentId` (agentId trên tid LUÔN null → chặn mọi báo giá → "phí 0%" trên bill). Nay: TID thuộc
  // khách mà đại lý là thành viên nhóm chat active thì mới báo giá được.
  const scopeCustomerIds = row.nhanVienNhapTay ? [] : await agentScopeCustomerIds(db, agentId);
  // [B200 19/11 — Admin Demo "phải báo rõ lỗi khi không thêm được bill"] TÁCH 2 TRƯỜNG HỢP + NÓI RÕ VIỆC PHẢI LÀM.
  // Câu cũ ("TID id=208 không thuộc đại lý đang gọi") viết cho luồng BOT (đại lý gửi bill qua Zalo), nhưng màn
  // "Thêm bill" của nhân viên dùng CHUNG engine này ⇒ người nhập tay đọc được một câu nói về "đại lý đang gọi"
  // kèm mã nội bộ, không hiểu gì và không biết sửa ở đâu.
  if (tid.customerId == null)
    return {
      ok: false,
      error: 'TID_NOT_IN_AGENT_SCOPE',
      message: `TID ${tid.tid} chưa giao cho khách nên chưa biết doanh số thuộc về đại lý nào. Vào màn "TID" → bấm "Giao cho khách" → đặt giá bán, rồi ghi bill lại.`
    };
  // [B315/F2 24/11 — agent đào vét, CHẶN SHIP] TID ĐÃ THU HỒI/ĐÓNG/BÁN vẫn báo giá được (recallTid cố ý
  // giữ customerId để truy vết) ⇒ máy đã thu về mà gõ nhầm TID này là bill 200 OK, doanh số đổ về KHÁCH
  // CŨ không một cảnh báo (tái hiện: lô 1tr mọc trên TID RECALLED). Chặn rõ, nói việc phải làm.
  if (tid.status !== 'ACTIVE')
    return {
      ok: false,
      error: 'VALIDATION',
      message: `TID ${tid.tid} đang ở trạng thái ${tid.status} (đã thu hồi/đóng/bán) — không ghi doanh số được. `
        + 'CÁCH SỬA: kiểm lại chuỗi TID in trên bill; nếu máy đã giao lại thì vào màn TID → Giao cho khách trước.'
    };
  if (!row.nhanVienNhapTay && !scopeCustomerIds.includes(tid.customerId)) {
    const khach = await db.customer.findUnique({ where: { id: tid.customerId } }).catch(() => null);
    const tenKhach = khach ? (khach.nickname?.trim() || khach.fullName) : `khách #${tid.customerId}`;
    return {
      ok: false,
      error: 'TID_NOT_IN_AGENT_SCOPE',
      message: `TID ${tid.tid} đang thuộc đại lý "${tenKhach}", không nằm trong phạm vi của bên đang ghi bill. Nếu đây là bill MƯỢN MÁY thì bật ô "Bill này đại lý khác MƯỢN máy" rồi chọn đúng đại lý.`
    };
  }
  if (tid.partnerId == null)
    return {
      ok: false,
      error: 'NO_PARTNER',
      message: `TID ${tid.tid} chưa gán Đối tác nên không tra được biểu phí. Vào màn "TID" → sửa TID → chọn Đối tác, rồi ghi bill lại.`
    };

  let cardTypeId: number;
  if (row.cardTypeId !== undefined) {
    const card = await db.cardType.findUnique({ where: { id: row.cardTypeId } });
    if (!card || card.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại thẻ không tồn tại.' };
    // [B209 19/11 — Admin Demo "kể cả thẻ khác bank khác"] Bỏ chặn thẻ-khác-ngân-hàng: máy POS vẫn quẹt thẻ
    // ngoài hệ thống. Phí vẫn tra theo ĐÚNG biểu giá của thẻ được chọn nên tiền không sai; chỉ ghi lại để soi.
    if (tid.bankId != null && card.bankId !== tid.bankId) {
      console.warn(`[quoteRow] TID ${tid.tid}: ghi bill với thẻ "${card.name}" KHÁC ngân hàng của TID (cho phép theo lệnh Admin Demo 19/11).`);
    }
    cardTypeId = row.cardTypeId;
  } else {
    // KHÔNG truyền cardTypeId → mặc định = CardType đầu tiên (id asc) của bank TID — ĐÚNG query
    // apps/desktop/src/main/tid-sell-fee-service.ts:62 (rule "đầu theo id", không match theo tên).
    const cards =
      tid.bankId != null ? await db.cardType.findMany({ where: { bankId: tid.bankId, deletedAt: null }, orderBy: { id: 'asc' } }) : [];
    if (cards.length === 0)
      return {
        ok: false,
        error: 'NOT_FOUND',
        message: 'TID này chưa có loại thẻ nào khả dụng để mặc định (thiếu ngân hàng, hoặc ngân hàng chưa có loại thẻ active).'
      };
    cardTypeId = cards[0].id;
  }

  let feeTypeId: number;
  if (row.feeTypeId !== undefined) {
    const feeType = await db.feeType.findUnique({ where: { id: row.feeTypeId } });
    if (!feeType || feeType.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại phí không tồn tại.' };
    feeTypeId = row.feeTypeId;
  } else {
    // KHÔNG truyền feeTypeId → mặc định = FeeType đầu tiên (id asc) — ĐÚNG query
    // apps/desktop/src/main/fee-config-service.ts:97 (listFeeTypes; rule "đầu theo id", không match theo tên).
    const feeTypes = await db.feeType.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' } });
    if (feeTypes.length === 0) return { ok: false, error: 'NOT_FOUND', message: 'Chưa có loại phí nào để mặc định.' };
    feeTypeId = feeTypes[0].id;
  }

  // P1 (nhiều KỲ override) — CÙNG khuôn resolveFeeForTxn: fetch TẤT CẢ kỳ override còn sống + TẤT CẢ kỳ niêm
  // yết; resolveActualSellFee chọn kỳ hiệu lực tại `at`. KỲ override tương lai không hiệu lực tại `at` phải rơi
  // về niêm yết → LUÔN cần quotes (bỏ tối ưu "có override thì bỏ quotes").
  // Đọc RAW để lấy cả customer_id (cột do schema-ensure thêm, cố ý không đưa vào Prisma client).
  const overridesRaw = await db.$queryRawUnsafe<Array<{ phi_ban: number; effective_from: string; customer_id: number | null }>>(
    `SELECT phi_ban, customer_id,
            -- BẮT BUỘC ::text + offset: driver Prisma đọc timestamptz qua $queryRaw LỆCH +7h (0h VN hoá 7h VN)
            -- ⇒ bill trước 7h sáng trượt override, báo "chưa cấu hình giá bán". Xem test gia-ban-hieu-luc-0h.test.ts.
            to_char(effective_from AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00' AS effective_from
       FROM tid_sell_fees
      WHERE tid_id = $1 AND card_type_id = $2 AND fee_type_id = $3 AND deleted_at IS NULL`,
    tid.id, cardTypeId, feeTypeId);
  const overrides = overridesRaw.map((r) => ({ phiBan: Number(r.phi_ban), effectiveFrom: r.effective_from, customerId: r.customer_id }));
  const quotes = await db.feeSellQuote.findMany({
    where: { partnerId: tid.partnerId, cardTypeId, feeTypeId, deletedAt: null }
  });
  // CRITICAL-1 (phản biện 4/9): tính phí bán tại NGÀY GD `at` (ngày trên bill), KHÔNG phải hôm nay — để phí Lô
  // (los.amountAfterFee) KHỚP phí Transaction (createTransactionSystem cũng tính ở txnDate). Trừ giảm-phí-cuối-tuần
  // MB/MBV ở CÙNG chỗ gốc resolveActualSellFee (weekend arg) → hết lệch hiển-thị/Lô vs doanh-thu-ghi.
  const weekendDelta = await resolveWeekendSellDeltaMilli(db, cardTypeId, at);
  const resolved = resolveActualSellFee(overrides, quotes, at, { deltaMilli: weekendDelta, dealerCustomerId: row.dealerCustomerId ?? tid.customerId ?? null });
  // [B200] Tên thẻ/loại phí để câu báo lỗi gọi đúng thứ người dùng đang nhìn trên màn (chỉ tra ở nhánh LỖI).
  const tenCuaThe = async (): Promise<string> =>
    (await db.cardType.findUnique({ where: { id: cardTypeId } }).catch(() => null))?.name ?? `thẻ #${cardTypeId}`;
  const tenLoaiPhi = async (): Promise<string> =>
    (await db.feeType.findUnique({ where: { id: feeTypeId } }).catch(() => null))?.name ?? `loại phí #${feeTypeId}`;
  const ngayVN = new Intl.DateTimeFormat('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', day: '2-digit', month: '2-digit', year: 'numeric' }).format(at);

  if (!resolved.ok)
    return {
      ok: false,
      error: 'NO_SELL_QUOTE',
      message: `TID ${tid.tid} · thẻ ${await tenCuaThe()} · ${await tenLoaiPhi()}: chưa có giá bán nào hiệu lực ngày ${ngayVN} (cả giá niêm yết lẫn giá bán riêng của TID). Vào màn "TID" → đặt giá bán cho loại thẻ này, rồi ghi bill lại.`
    };
  // Admin Demo 20/8 (chốt "chưa cấu hình giá bán"): ĐẠI LÝ chỉ dùng giá bán THỰC TẾ (override tid_sell_fees). Nếu
  // resolveActualSellFee rơi về niêm yết (source='QUOTE', chưa có override) → KHÔNG áp cho đại lý; báo chưa cấu
  // hình giá bán để đi set (Giao TID / sửa sau). resolveActualSellFee GIỮ NGUYÊN (desktop/doanh thu công ty vẫn
  // dùng fallback niêm yết) — chỉ lớp bot đại lý chặn ở đây.
  if (resolved.source !== 'OVERRIDE')
    return {
      ok: false,
      error: 'NO_ACTUAL_SELL_FEE',
      message: `TID ${tid.tid} · thẻ ${await tenCuaThe()} · ${await tenLoaiPhi()}: chưa cấu hình giá bán thực tế cho khách (mới chỉ có giá NIÊM YẾT, mà giá niêm yết KHÔNG được dùng thay giá bán — luật Admin Demo chốt 20/8). Vào màn "TID" → đặt giá bán cho TID này, hoặc ở màn Thêm bill bấm "Lấy giá niêm yết làm giá bán", rồi ghi bill lại.`
    };

  // Đã Admin Demo XÁC NHẬN 22/7 bằng ví dụ số thật (rút 100tr, phí 1% → sau phí 99tr — khớp chính xác):
  // feeApplied = số tiền trước phí × phí bán% (dùng LẠI marginToAmount, cùng công thức quy đổi milli%→VND
  // mà computeRevenue/resolveFeeForTxn đang dùng); amountAfterFee = amountBeforeFee − feeApplied.
  const feeApplied = marginToAmount(row.amountBeforeFee, resolved.phiBanMilli);
  const amountAfterFee = row.amountBeforeFee - feeApplied;
  return { ok: true, data: { tidId: row.tidId, cardTypeId, feeTypeId, amountBeforeFee: row.amountBeforeFee, feeApplied, amountAfterFee, phiBanMilli: resolved.phiBanMilli } };
}

// B107-tiếp (2/8, Admin Demo yêu cầu trực tiếp) — "Hoàn tiền sau phí" hiển thị NGAY trong bảng kết quả quét OCR
// bill (bill-table-image.ts), TRƯỚC KHI tạo Lô thật. KHÁC quoteRow() ở trên (dùng cho luồng "Bán TID" TẠO LÔ
// THẬT — giữ NGUYÊN báo lỗi rõ ràng khi thiếu cấu hình phí, đúng vì đó là giao dịch tiền thật): đây CHỈ LÀ
// XEM TRƯỚC/ước tính, TID đọc từ OCR (chuỗi text, có thể sai/chưa khớp TID thật nào, hoặc TID CHƯA có phí bán
// cấu hình) — Admin Demo xác nhận trực tiếp "% phí bán nếu đang rỗng thì để = 0% (chưa thiết lập)" thay vì báo
// lỗi/để trống. `resolved:false` cho UI biết đây là số ƯỚC TÍNH (TID không khớp/chưa có phí) để hiện chú
// thích phù hợp, KHÔNG lộ ra ngoài route response as lỗi.
export interface FeePreviewResult {
  feeApplied: number;
  amountAfterFee: number;
  /** true = tìm ĐÚNG TID của agent này + có giá bán THỰC TẾ (override tid_sell_fees) đã áp dụng.
   * false = KHÔNG khớp TID / TID chưa có giá bán thực tế → mặc định 0% (feeApplied=0, amountAfterFee=amountBeforeFee). */
  resolved: boolean;
  /** true = TID KHỚP đúng đại lý nhưng CHƯA cấu hình giá bán thực tế (chỉ có niêm yết — không mượn) → UI hiện
   * "chưa cấu hình giá bán" thay vì "phí 0%". Phân biệt với resolved:false do TID không khớp/không thuộc đại lý. */
  noActualFee?: boolean;
  /** Tỷ lệ phí bán THỰC TẾ đã áp (milli-%, % × 1000 — 1100 = 1.1%) — CHỉ có khi resolved:true. Client "Hoàn
   * tiền" hiển thị ĐÚNG tỷ lệ backend cấu hình (KHÔNG suy ngược feeApplied/amount → tránh lệch làm tròn). */
  phiBanMilli?: number;
  /** Loại thẻ THỰC TẾ đã dùng để tính (client đã chọn, hoặc mặc định Visa-Master đã resolve). Cho UI biết ô
   * "Loại thẻ" nên hiện gì (đồng bộ khi mặc định khác lựa chọn cũ). CHỈ có khi tìm được TID + bank có thẻ. */
  cardTypeId?: number;
}

/** Xem trước "Hoàn tiền sau phí" cho 1 TID (dạng CHUỖI, từ OCR — có thể không khớp TID thật nào) — KHÔNG BAO
 * GIỜ báo lỗi vì thiếu cấu hình (khác quoteRow() dành cho luồng tạo Lô thật): mọi nhánh "không tìm được phí
 * bán" (TID không khớp/không thuộc agent này/chưa gán đối tác/chưa có loại thẻ active/chưa có phí bán niêm
 * yết hay override) đều gộp về CÙNG 1 kết quả `resolved:false` + phí 0%, TÁI DÙNG NGUYÊN `quoteRow()` làm
 * nguồn tính (KHÔNG cài lại công thức lần 2) — chỉ khác ở CHỖ XỬ LÝ lỗi trả về từ đó. */
export async function previewSellFeeForTid(
  db: Db,
  agentId: number,
  tidString: string,
  amountBeforeFee: number,
  // Loại thẻ client CHỌN (ô "Loại thẻ" trên bill). Bỏ trống → mặc định Visa-Master (INTERNATIONAL) của bank TID
  // (Admin Demo 21/8: bill không tự nhận diện thẻ; MB mặc định Visa-Master). KHÁC quoteRow (mặc định "thẻ đầu id").
  cardTypeId?: number
): Promise<{ ok: true; data: FeePreviewResult } | { ok: false; error: 'VALIDATION'; message: string }> {
  if (!isValidAmount(amountBeforeFee)) {
    return { ok: false, error: 'VALIDATION', message: 'amountBeforeFee phải là số nguyên ≥ 0.' };
  }
  const fallback = (): { ok: true; data: FeePreviewResult } => ({
    ok: true,
    data: { feeApplied: 0, amountAfterFee: amountBeforeFee, resolved: false }
  });

  const tidTrimmed = tidString.trim();
  if (!tidTrimmed) return fallback();

  // Tìm TID theo chuỗi (KHÔNG gate agentId ở đây nữa — scope do quoteRow kiểm qua nhóm chat, audit 20/8 I1);
  // ngoài-scope → quoteRow trả TID_NOT_IN_AGENT_SCOPE → fallback 0% (resolved:false), GIỮ nguyên hành vi cũ.
  const tid = await db.tid.findFirst({ where: { tid: tidTrimmed, deletedAt: null } });
  if (!tid) return fallback();

  // Loại thẻ dùng để tính: client chọn > mặc định Visa-Master của bank. Không tính được mặc định (bank chưa có
  // thẻ) → để undefined → quoteRow tự dùng "thẻ đầu id" (giữ tương thích, không vỡ).
  const usedCardTypeId = cardTypeId ?? (await defaultBillCardTypeId(db, tid.bankId));

  const result = await quoteRow(db, agentId, { tidId: tid.id, cardTypeId: usedCardTypeId, amountBeforeFee });
  if (!result.ok) {
    // NO_ACTUAL_SELL_FEE = TID khớp đúng đại lý nhưng chưa set giá bán thực tế → cờ noActualFee để UI hiện "chưa
    // cấu hình giá bán" (KHÔNG mượn niêm yết). Các lỗi khác (không khớp/không thuộc/chưa gán đối tác…) → 0% như cũ.
    if (result.error === 'NO_ACTUAL_SELL_FEE')
      return { ok: true, data: { feeApplied: 0, amountAfterFee: amountBeforeFee, resolved: false, noActualFee: true, cardTypeId: usedCardTypeId } };
    return fallback();
  }

  return { ok: true, data: { feeApplied: result.data.feeApplied, amountAfterFee: result.data.amountAfterFee, resolved: true, phiBanMilli: result.data.phiBanMilli, cardTypeId: result.data.cardTypeId } };
}

/** Loại thẻ MẶC ĐỊNH cho bill của 1 bank = Visa-Master (INTERNATIONAL) — Admin Demo 21/8. null nếu bank rỗng/chưa
 * có thẻ (caller để quoteRow tự dùng "thẻ đầu id"). */
async function defaultBillCardTypeId(db: Db, bankId: number | null): Promise<number | undefined> {
  if (bankId == null) return undefined;
  const cards = await db.cardType.findMany({ where: { bankId, deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true, name: true } });
  const def = pickDefaultCardTypeId(cards.map((c) => ({ id: c.id, name: c.name, klass: classifyCardType(c.name) })));
  return def ?? undefined;
}

// ── Bill: danh sách LOẠI THẺ + GIÁ BÁN cho ô chọn (Admin Demo 21/8 "thêm tùy chọn thẻ kèm giá bán khi quét") ──────
export interface BillCardOption {
  cardTypeId: number;
  code: string | null;
  name: string;
  klass: CardKlass;
  /** Giá bán THỰC TẾ (milli-%, ×1000) cho LOẠI PHÍ mặc định (Đối ứng/tiền nhanh = feeType đầu id) của thẻ này —
   * null = chưa cấu hình (đại lý sẽ thấy "chưa cấu hình giá bán" nếu chọn thẻ này). CHỈ giá override, KHÔNG niêm yết. */
  phiBanMilli: number | null;
}
export interface TidCardOptionsResult {
  bankId: number | null;
  bankCode: string | null;
  defaultCardTypeId: number | null;
  /** Loại thẻ NHẬN DIỆN từ bill (scheme/BIN) — null nếu không đủ tin; UI pre-chọn nếu có, else defaultCardTypeId. */
  detectedCardTypeId: number | null;
  cards: BillCardOption[];
}

/** Danh sách loại thẻ khả dụng của TID (theo bank) + GIÁ BÁN thực tế mỗi thẻ (loại phí mặc định) + thẻ mặc định
 * (Visa-Master) + thẻ nhận-diện-từ-bill. TID không thuộc scope đại lý / không tồn tại → rỗng (KHÔNG lỗi, cùng
 * triết lý previewSellFeeForTid). `detection` (scheme/BIN từ OCR) tùy chọn để pre-chọn. */
export async function tidCardOptionsForBill(
  db: Db,
  agentId: number,
  tidString: string,
  detection?: CardDetection
): Promise<TidCardOptionsResult> {
  const empty: TidCardOptionsResult = { bankId: null, bankCode: null, defaultCardTypeId: null, detectedCardTypeId: null, cards: [] };
  const tidTrimmed = tidString.trim();
  if (!tidTrimmed) return empty;
  const tid = await db.tid.findFirst({ where: { tid: tidTrimmed, deletedAt: null } });
  if (!tid || tid.bankId == null) return empty;
  // Scope: chỉ TID của khách mà đại lý là thành viên nhóm chat (cùng nguồn quoteRow) — ngoài scope → rỗng.
  const scope = await agentScopeCustomerIds(db, agentId);
  if (tid.customerId == null || !scope.includes(tid.customerId)) return empty;

  const [bank, cardTypes, feeTypes] = await Promise.all([
    db.bank.findUnique({ where: { id: tid.bankId }, select: { code: true } }),
    db.cardType.findMany({ where: { bankId: tid.bankId, deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true, code: true, name: true } }),
    db.feeType.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true } })
  ]);
  const defaultFeeTypeId = feeTypes[0]?.id; // Đối ứng/tiền nhanh (đầu id) — cùng mặc định quoteRow.
  const cardOptions = cardTypes.map((c) => ({ id: c.id, name: c.name, klass: classifyCardType(c.name) }));

  // Giá bán thực tế (override) từng thẻ cho loại phí mặc định — CHỈ override (đại lý không mượn niêm yết).
  const cards: BillCardOption[] = [];
  const now = new Date(); // danh sách thẻ = giá HIỆN TẠI (endpoint không có ngày bill) → weekend theo HÔM NAY.
  for (const c of cardTypes) {
    let phiBanMilli: number | null = null;
    if (defaultFeeTypeId != null && tid.partnerId != null) {
      const overrides = await db.tidSellFee.findMany({ where: { tidId: tid.id, cardTypeId: c.id, feeTypeId: defaultFeeTypeId, deletedAt: null } });
      const quotes = await db.feeSellQuote.findMany({ where: { partnerId: tid.partnerId, cardTypeId: c.id, feeTypeId: defaultFeeTypeId, deletedAt: null } });
      // CRITICAL-1 (4/9): trừ giảm-phí-cuối-tuần để danh sách giá thẻ khớp phí thực khi quét cuối tuần.
      const weekendDelta = await resolveWeekendSellDeltaMilli(db, c.id, now);
      const resolved = resolveActualSellFee(overrides, quotes, now, { deltaMilli: weekendDelta });
      if (resolved.ok && resolved.source === 'OVERRIDE') phiBanMilli = resolved.phiBanMilli;
    }
    cards.push({ cardTypeId: c.id, code: c.code ?? null, name: c.name, klass: classifyCardType(c.name), phiBanMilli });
  }

  const defaultCardTypeId = pickDefaultCardTypeId(cardOptions);
  const detectedCardTypeId = detection ? resolveDetectedCardTypeId(cardOptions, bank?.code ?? null, detection) : null;
  return { bankId: tid.bankId, bankCode: bank?.code ?? null, defaultCardTypeId, detectedCardTypeId, cards };
}

// SIGMA Phase 3 (24/7) — gói vòng lặp "báo giá TỪNG dòng, ABORT cả phiếu nếu 1 dòng lỗi" thành 1 hàm dùng
// CHUNG cho routes/agents.ts (POST /v1/agents/:agentCode/quote, Bearer cũ) VÀ routes/me.ts (POST /v1/me/quote,
// RC-auth mới) — trước đây vòng lặp này sống lặp/inline trong route handler; tách ra đây để 2 route KHÔNG cài
// 2 bản giống hệt nhau (rule "tránh trùng logic" của LEAD, xem lo-service.ts createLo cũng gọi quoteRow tương tự).
export async function quoteRows(
  db: Db,
  agentId: number,
  rows: QuoteRowInput[]
): Promise<{ ok: true; data: QuoteRowResult[] } | { ok: false; error: string; message: string }> {
  const results: QuoteRowResult[] = [];
  for (const row of rows) {
    const r = await quoteRow(db, agentId, row);
    if (!r.ok) return { ok: false, error: r.error, message: r.message };
    results.push(r.data);
  }
  return { ok: true, data: results };
}
