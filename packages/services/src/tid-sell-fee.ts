// R30 (Admin Demo 11/7) — Phí BÁN THỰC TẾ theo từng TID × Loại thẻ — LÕI THUẦN ctx-based. PORT nghiệp vụ từ
// apps/desktop/src/main/tid-sell-fee-service.ts. Thay `requirePermission` bằng ctx = { db, user } do adapter dựng;
// mỗi hàm tự kiểm quyền qua hasPermission(ctx.user, TID_*). GIỮ NGUYÊN business: lưu Int = %×1000 (như FeeRate),
// override thay cho FeeRate.phiBan khi tính CL_KH; view = TID_VIEW, set = TID_MANAGE. Audit đầy đủ, soft-delete-aware
// upsert, khóa hàng TID FOR UPDATE chống race. MutationResult/ServiceCtx từ customer.js.
import { pickEffectiveRate } from '@sigma/business-rules';
import { hasPermission } from '@sigma/shared';
import { writeAudit } from './audit.js';
import { recalcRevenueForFeeChange, RecalcAbortError, type RecalcClient, type RecalcOverpay, type RecalcFailure } from './revenue-recalc.js';
import { type ServiceCtx, type MutationResult } from './customer.js';

const VIEW = 'TID_VIEW';
const MANAGE = 'TID_MANAGE';
const SCALE = 1000; // phần trăm × 1000
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

const milliToPct = (m: number): number => m / SCALE;
const pctToMilli = (p: number): number => Math.round(p * SCALE);

/** MONEY-2 (audit 21/8) — True nếu lỗi Postgres deadlock (40P01)/serialization (40001) hoặc Prisma write-conflict
 *  (P2034) → nên retry. Mirror isRetryablePgError (pos.ts)/isRetryableTidTxError (tid.ts). */
function isRetryableTxError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === '40P01' || code === '40001' || code === 'P2034';
}
/** MONEY-2 — chạy 1 transaction, retry tối đa `attempts` lần khi deadlock/serialization. Lỗi NGHIỆP VỤ
 *  (RecalcAbortError…) KHÔNG có code retry → ném ra ngay cho caller map. Mirror runWithRetry (pos.ts). */
async function runFeeTxWithRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { if (isRetryableTxError(e)) { lastErr = e; continue; } throw e; }
  }
  throw lastErr;
}

/** ISO string / Date → Date hợp lệ, hoặc null. (MIRROR fee-config.ts — giữ đồng nhất quy ước kỳ hiệu lực.) */
function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
/**
 * Chuẩn hóa về nửa đêm 00:00:00.000 LOCAL của NGÀY (P1: "1 KỲ override / 1 mốc effectiveFrom-ngày"). PHẢI floor
 * theo LOCAL-day — ĐỐI XỨNG với partial-unique DB ((effective_from AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) và
 * với fee-config startOfDayLocal; floor theo UTC lệch +7h ranh giới ngày trên máy chủ UTC. (MIRROR fee-config.ts.)
 */
function startOfDayLocal(d: Date): Date {
  // FIX GỐC (Admin Demo 31/8 "điều tra fix sâu, cấm tái diễn tuyệt đối"): floor về nửa đêm Asia/Ho_Chi_Minh
  // (UTC+7, KHÔNG DST) TƯỜNG MINH — KHÔNG phụ thuộc TZ tiến trình. Trước đây new Date(y,m,d) dùng TZ tiến trình:
  // chạy UTC / script thô → effective_from lệch giờ (07:00/17:00…) → resolveActualSellFee so mili-giây →
  // bill quẹt TRƯỚC giờ đó CÙNG ngày rớt NO_ACTUAL_SELL_FEE → không tạo Transaction → NĐT + SigMa SÓT
  // doanh số trong khi đại lý (đọc thẳng los) vẫn thấy → LỆCH. Xem BUGS_FIXED B141.
  const HCM = 7 * 60 * 60 * 1000;
  const w = new Date(d.getTime() + HCM); // dời sang "wall-clock HCM" để đọc bằng UTC-getter
  return new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - HCM);
}

export interface TidSellFeeRowDto {
  cardTypeId: number;
  cardTypeCode: string | null;
  cardTypeName: string;
  phiMuaNiemYet: number | null; // % — phí MUA niêm yết (FeeRate hiệu lực; tham chiếu chênh mua = mua − cài máy)
  phiBanNiemYet: number | null; // % — phí bán niêm yết (FeeSellQuote loại phí này, hiệu lực hôm nay), null nếu chưa cấu hình
  phiCaiMayNiemYet: number | null; // % — phí cài máy niêm yết (FeeRate hiệu lực; tham chiếu CL_KH = bán − cài máy)
  phiBanThucTe: number | null; // % — phí bán THỰC TẾ (override), null = dùng niêm yết
  /** [B236 22/11] % PHÍ MUA CỦA NĐT đang hiệu lực cho thẻ này. null = TID chưa khai. */
  phiMuaNdt: number | null;
  hasOverride: boolean; // có TidSellFee tùy chỉnh cho (tid × thẻ × loại phí) đang xem
}
export interface TidSellFeeListDto {
  tidId: number;
  tid: string;
  feeTypeId: number; // LOẠI PHÍ đang xem
  bankId: number | null;
  bankCode: string | null;
  partnerId: number | null;
  rows: TidSellFeeRowDto[];
}

/**
 * Resolve NIÊM YẾT (phí mua / bán / cài máy) cho 1 cặp (đối tác × loại thẻ) HIỆU LỰC TẠI `effectiveAt`.
 * DRY — DÙNG CHUNG bởi listTidSellFees (theo TID) và listSellFeeRowsForBankPartner (theo ngân hàng/đối tác lúc
 * TID CHƯA tồn tại). FEE_MODEL: phí mua + phí cài máy từ FeeRate (cố định, không loại phí); phí bán từ
 * FeeSellQuote theo LOẠI PHÍ (mỗi loại phí 1 % niêm yết). Đều resolve qua pickEffectiveRate(rows, effectiveAt)
 * — kỳ effectiveFrom ≤ effectiveAt, kỳ mới nhất thắng (khớp resolveFeeForTxn engine). partnerId=null → tất cả null.
 */
async function resolveCardNiemYet(
  db: ServiceCtx['db'],
  partnerId: number | null,
  cardTypeId: number,
  feeTypeId: number,
  effectiveAt: Date
): Promise<{ phiMuaNiemYet: number | null; phiBanNiemYet: number | null; phiCaiMayNiemYet: number | null }> {
  let phiMuaNiemYet: number | null = null;
  let phiBanNiemYet: number | null = null;
  let phiCaiMayNiemYet: number | null = null;
  if (partnerId != null) {
    const rates = await db.feeRate.findMany({ where: { partnerId, cardTypeId, deletedAt: null } });
    const rate = pickEffectiveRate(rates, effectiveAt);
    if (rate) { phiMuaNiemYet = milliToPct(rate.phiMua); phiCaiMayNiemYet = milliToPct(rate.phiCaiMay); }
    const quotes = await db.feeSellQuote.findMany({ where: { partnerId, cardTypeId, feeTypeId, deletedAt: null } });
    const quote = pickEffectiveRate(quotes, effectiveAt);
    if (quote) phiBanNiemYet = milliToPct(quote.phiBan);
  }
  return { phiMuaNiemYet, phiBanNiemYet, phiCaiMayNiemYet };
}

/**
 * Liệt kê phí bán theo TID: mỗi loại thẻ của NGÂN HÀNG của TID → phí bán niêm yết + phí bán thực tế (override)
 * HIỆU LỰC TẠI `at` (mặc định hôm nay). UI dùng để đối chiếu khi nhập.
 *
 * FIX B (Admin Demo 20/8) — `at` PHẢI khớp NGÀY GIAO DỊCH mà backend dùng khi ghi GD: engine resolveFeeForTxn tra
 * override/niêm-yết qua pickEffectiveRate(rows, txnDate) (chỉ kỳ effectiveFrom ≤ txnDate, kỳ mới nhất thắng).
 * Trước đây list dùng "BẤT KỲ dòng override còn sống, id lớn nhất" (date-agnostic) → override TƯƠNG LAI làm
 * hasOverride=true trong khi backend rơi về QUOTE tại txnDate hôm nay → CHẶN NO_ACTUAL_SELL_FEE sau submit; hoặc
 * override nhiều kỳ preview sai %. Nay MIRROR chính xác engine (cùng pickEffectiveRate, cùng orderBy tất định).
 */
export async function listTidSellFees(ctx: ServiceCtx, tidId: number, feeTypeId: number, at?: Date): Promise<{ ok: boolean; error?: string; message?: string; data?: TidSellFeeListDto }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  if (!feeTypeId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn loại phí.' };
  const tid = await db.tid.findUnique({ where: { id: tidId } });
  if (!tid || tid.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'TID không tồn tại.' };
  // FEE_TYPE — phí bán thực tế + niêm yết đều tra theo LOẠI PHÍ đã chọn.
  const feeType = await db.feeType.findUnique({ where: { id: feeTypeId } });
  if (!feeType || feeType.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại phí không tồn tại.' };

  const bank = tid.bankId != null ? await db.bank.findUnique({ where: { id: tid.bankId }, select: { code: true } }) : null;
  // Loại thẻ của ngân hàng TID (nếu TID chưa gán ngân hàng → rỗng, UI báo cấu hình TID trước).
  const cards = tid.bankId != null ? await db.cardType.findMany({ where: { bankId: tid.bankId, deletedAt: null }, orderBy: { id: 'asc' } }) : [];
  // FIX B — override CÓ NHIỀU KỲ (mỗi cardType nhiều dòng effectiveFrom). Gom theo cardType thành MẢNG (không
  // Map-1-dòng) rồi pickEffectiveRate(rows, at) như engine — orderBy tất định effectiveFrom desc + id desc (khớp
  // resolveFeeForTxn: tie chọn id lớn nhất). KHÔNG còn "id asc → giữ dòng cuối" (date-agnostic).
  // [B167 — Admin Demo 16/11] ĐỌC MỐC HIỆU LỰC GIỐNG HỆT ENGINE TÍNH TIỀN (transaction.ts), KHÔNG để Prisma parse:
  // driver-adapter đọc timestamptz theo GIỜ TREO TƯỜNG rồi dán "Z" ⇒ LỆCH +7h so với instant thật (đo 16/11 trên
  // sổ thật: SQL "16:47:54.773+07" ↔ Prisma "16:47:54.773Z"). Hậu quả ĐÃ GẶP: đặt giá bán xong, ENGINE chấp nhận
  // nhưng MÀN HÌNH vẫn báo "chưa đặt giá bán" và KHOÁ nút ghi bill — màn nói dối, người dùng tưởng chưa lưu.
  // Trả về ISO CÓ OFFSET +07 (y khuôn transaction.ts) rồi mới dựng Date ⇒ 2 bên so CÙNG một mốc.
  const ovRaw = await db.$queryRawUnsafe<Array<{ id: number; card_type_id: number; phi_ban: number; phi_mua_ndt: number | null; effective_from: string }>>(
    `SELECT id, card_type_id, phi_ban, phi_mua_ndt,
            to_char(effective_from AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00' AS effective_from
       FROM tid_sell_fees
      WHERE tid_id = $1 AND fee_type_id = $2 AND deleted_at IS NULL
      ORDER BY effective_from DESC, id DESC`,
    tidId, feeTypeId);
  const overrides = ovRaw.map((r) => ({
    id: Number(r.id),
    cardTypeId: Number(r.card_type_id),
    phiBan: Number(r.phi_ban),
    // [B236] NULL = TID chưa khai giá SigMa mua của NĐT ⇒ giữ null, màn hình để trống, KHÔNG bịa 0.
    phiMuaNdt: r.phi_mua_ndt == null ? null : Number(r.phi_mua_ndt),
    effectiveFrom: new Date(r.effective_from)
  }));
  const ovByCard = new Map<number, typeof overrides>();
  for (const o of overrides) { const arr = ovByCard.get(o.cardTypeId); if (arr) arr.push(o); else ovByCard.set(o.cardTypeId, [o]); }
  const effectiveAt = at ?? new Date(); // FIX B — mặc định hôm nay khi caller không truyền (giữ nguyên hành vi cũ).

  const rows: TidSellFeeRowDto[] = [];
  for (const c of cards) {
    // DRY — cùng công thức resolve niêm yết với listSellFeeRowsForBankPartner (không nhân bản pickEffectiveRate).
    const niemYet = await resolveCardNiemYet(db, tid.partnerId, c.id, feeTypeId, effectiveAt);
    // FIX B — override HIỆU LỰC TẠI `effectiveAt` (kỳ tương lai KHÔNG tính → hasOverride=false, khớp backend).
    const ov = pickEffectiveRate(ovByCard.get(c.id) ?? [], effectiveAt);
    rows.push({
      cardTypeId: c.id,
      cardTypeCode: c.code ?? null,
      cardTypeName: c.name,
      phiMuaNiemYet: niemYet.phiMuaNiemYet,
      phiBanNiemYet: niemYet.phiBanNiemYet,
      phiCaiMayNiemYet: niemYet.phiCaiMayNiemYet,
      phiBanThucTe: ov ? milliToPct(ov.phiBan) : null,
      phiMuaNdt: ov && ov.phiMuaNdt != null ? milliToPct(ov.phiMuaNdt) : null,
      hasOverride: ov != null
    });
  }
  return {
    ok: true,
    data: { tidId: tid.id, tid: tid.tid, feeTypeId, bankId: tid.bankId, bankCode: bank?.code ?? null, partnerId: tid.partnerId, rows }
  };
}

/**
 * PHA 2 (2A) — LIST phí bán niêm yết theo (NGÂN HÀNG × ĐỐI TÁC) khi TID CHƯA tồn tại (luồng "Thêm TID" giao ngay).
 * Trả 1 dòng / mỗi loại thẻ NON-DELETED của `bankId`, với niêm yết resolve từ FeeRate/FeeSellQuote của `partnerId`
 * tại `at` (mặc định hôm nay) — DÙNG CHUNG resolveCardNiemYet với listTidSellFees (DRY, KHÔNG nhân bản công thức).
 * Chưa có TID nên KHÔNG có override → phiBanThucTe=null, hasOverride=false (UI mặc định mọi thẻ = "Niêm yết").
 */
export async function listSellFeeRowsForBankPartner(
  ctx: ServiceCtx,
  bankId: number,
  partnerId: number,
  feeTypeId: number,
  at?: Date
): Promise<{ ok: boolean; error?: string; message?: string; data?: TidSellFeeRowDto[] }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  if (!bankId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn ngân hàng.' };
  if (!partnerId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn đối tác.' };
  if (!feeTypeId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn loại phí.' };
  const feeType = await db.feeType.findUnique({ where: { id: feeTypeId } });
  if (!feeType || feeType.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại phí không tồn tại.' };

  const cards = await db.cardType.findMany({ where: { bankId, deletedAt: null }, orderBy: { id: 'asc' } });
  const effectiveAt = at ?? new Date();
  const rows: TidSellFeeRowDto[] = [];
  for (const c of cards) {
    const niemYet = await resolveCardNiemYet(db, partnerId, c.id, feeTypeId, effectiveAt);
    rows.push({
      cardTypeId: c.id,
      cardTypeCode: c.code ?? null,
      cardTypeName: c.name,
      phiMuaNiemYet: niemYet.phiMuaNiemYet,
      phiBanNiemYet: niemYet.phiBanNiemYet,
      phiCaiMayNiemYet: niemYet.phiCaiMayNiemYet,
      phiBanThucTe: null, // chưa có TID → chưa có override
      phiMuaNdt: null,
      hasOverride: false
    });
  }
  return { ok: true, data: rows };
}

export interface SetTidSellFeesInput {
  tidId: number;
  feeTypeId: number; // LOẠI PHÍ (bắt buộc) — phí bán thực tế theo (tid × thẻ × loại phí)
  // P1 (nhiều KỲ override) — mốc bắt đầu hiệu lực của KỲ này (ISO string / Date). KHÔNG truyền = HÔM NAY
  // (startOfDayLocal). Cho phép LÙI (kỳ quá khứ) / TỚI (kỳ tương lai). Chuẩn hóa về nửa đêm LOCAL.
  effectiveFrom?: string | Date;
  // phiBan % — null = xóa override KỲ NÀY (dùng lại niêm yết).
  // [B236 22/11 — Admin Demo] phiMuaNdt % = GIÁ SIGMA MUA CỦA NĐT cho đúng thẻ này, khai CÙNG LÚC với giá bán.
  //   lãi NĐT = (phí mua NĐT − phí cài máy) × doanh số · SigMa thu = (phí bán − phí mua NĐT) × doanh số.
  //   undefined = KHÔNG đụng tới giá mua đang có · null = xoá khai báo (báo cáo để trống, KHÔNG bịa số).
  entries: { cardTypeId: number; phiBan: number | null; phiMuaNdt?: number | null }[];
  // [Admin Demo 25/9 "khi cho mượn thì được phép sửa giá bán ... từng đại lý, giá đã áp dụng ở đại lý khác giữ nguyên"]
  // GIÁ RIÊNG THEO ĐẠI LÝ: undefined/null = giá CHUNG của máy (hành vi cũ). Có số = chỉ áp khi ĐẠI LÝ ĐÓ cầm/mượn
  // máy này; nhà khác vẫn ăn giá chung. Mỗi (máy × thẻ × loại phí × đại lý × ngày) là 1 kỳ độc lập.
  customerId?: number | null;
}

/**
 * Đặt phí bán thực tế cho TID theo KỲ (P1). Upsert theo (tidId, cardTypeId, feeTypeId, NGÀY effectiveFrom):
 * tạo KỲ MỚI nếu chưa có KỲ cùng ngày, ngược lại cập nhật/hồi sinh KỲ đó (kể cả bản đã xóa mềm — CÙNG khuôn
 * fee-config setFeeRate). phiBan null → soft-delete KỲ cùng ngày (quay về niêm yết cho kỳ đó). Ràng buộc phí
 * bán ≥ phí mua NIÊM YẾT hiệu lực TẠI `effectiveFrom` (không phải hôm nay). Validate loại thẻ đúng ngân hàng TID.
 */
/** [Admin Demo 24/9 — BUG THẬT phát hiện khi set giá DEMO HX 1] Prisma driver-adapter GHI timestamptz LỆCH −7h
 *  (cùng lớp incident txn_date 11/9): `effectiveFrom` 00:00 giờ HCM bị lưu thành 17:00 HÔM TRƯỚC ⇒ giá mới có
 *  hiệu lực SỚM 7 TIẾNG, GD phát sinh 17h-24h hôm trước bị áp giá mới oan (đã dính thật: THAI BINH 2 thẻ
 *  Visa-Master, 3 lô tối 7/9 = 7,99 tỷ). Ghi lại bằng RAW `$1::timestamptz` với chuỗi ISO thật — raw không qua
 *  serializer của adapter nên đúng tuyệt đối. Quét kiểm: 56/141 dòng cũ lưu 17:00 = bằng chứng bệnh hệ thống.
 */
async function suaEffRaw(txc: { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number> }, id: number, eff: Date): Promise<void> {
  await txc.$executeRawUnsafe(`UPDATE tid_sell_fees SET effective_from = $1::timestamptz WHERE id = $2`, eff.toISOString(), id);
}

/** [B209 19/11] Dòng cảnh báo "đặt dưới giá vốn" — KHÔNG chặn, chỉ nói rõ lỗ bao nhiêu. */
export interface CanhBaoDuoiPhiMua {
  cardTypeId: number;
  phiBan: number;
  phiMua: number;
  loPct: number;
}

/**
 * [B236 22/11] Ghi PHÍ MUA CỦA NĐT cho đúng dòng giá bán vừa tạo/sửa. Dùng SQL thô vì cột `phi_mua_ndt`
 * thêm bằng schema-ensure (KHÔNG có trong Prisma client — máy chủ chạy 24/24, không chạy `prisma generate`).
 *   undefined = người dùng không đụng tới ⇒ GIỮ NGUYÊN giá mua đang có (cấm âm thầm xoá).
 *   null      = người dùng xoá trắng ô    ⇒ ghi NULL, báo cáo để trống chứ không bịa số.
 */
async function ghiPhiMuaNdt(txc: { $executeRawUnsafe: (sql: string, ...p: unknown[]) => Promise<number> },
  id: number, phiMuaNdt: number | null | undefined): Promise<void> {
  if (phiMuaNdt === undefined) return;
  const milli = phiMuaNdt === null ? null : pctToMilli(phiMuaNdt);
  await txc.$executeRawUnsafe(`UPDATE tid_sell_fees SET phi_mua_ndt = $2 WHERE id = $1`, id, milli);
}

export async function setTidSellFees(ctx: ServiceCtx, input: SetTidSellFeesInput): Promise<MutationResult & { overpaid?: RecalcOverpay[]; grandfathered?: RecalcFailure[]; duoiPhiMua?: CanhBaoDuoiPhiMua[]; loDaSua?: number; loBoQua?: string[] }> {
  // [B200 19/11 — Admin Demo bấm "Lấy giá niêm yết làm giá bán" và chỉ nhận được "Bạn không có quyền thực hiện
  // thao tác này."] Câu đó KHÔNG cho biết thao tác nào, thiếu quyền gì, nhờ ai mở. Đo thật: tài khoản Hatuan86
  // mang 8 vai trò nhưng không vai trò nào có TID_MANAGE, nên tạo được TID mà không đặt được giá bán.
  if (!hasPermission(ctx.user, MANAGE))
    return {
      ok: false,
      error: 'FORBIDDEN',
      message: 'Tài khoản của bạn không được phép ĐẶT GIÁ BÁN cho TID (thiếu quyền TID_MANAGE). Nhờ người có vai trò Admin mở quyền, hoặc nhờ họ đặt giá bán hộ.'
    };
  const { db, user } = ctx;
  const duoiPhiMuaRows: CanhBaoDuoiPhiMua[] = []; // [B209] các loại thẻ vừa đặt DƯỚI giá vốn — cảnh báo, không chặn
  let overpaidRows: RecalcOverpay[] = []; // surface recalc trả-dư ra UI để nhắc hoàn tay (Admin Demo 12/8)
  let grandfatheredRows: RecalcFailure[] = []; // P5: GD cũ dùng niêm yết bị BỎ QUA khi recalc — surface cảnh báo (không nuốt).
  let loDaSua = 0; // [B223] số LÔ đã chỉnh tiền theo giá mới (để màn Doanh Số khớp sổ giao dịch)
  let loBoQua: string[] = []; // [B223] lô KHÔNG chỉnh được + lý do — PHẢI báo, cấm im (R198)
  if (!input.feeTypeId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn loại phí.' };
  const tid = await db.tid.findUnique({ where: { id: input.tidId } });
  if (!tid || tid.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'TID không tồn tại.' };
  const feeType = await db.feeType.findUnique({ where: { id: input.feeTypeId } });
  if (!feeType || feeType.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại phí không tồn tại.' };
  if (!Array.isArray(input.entries) || input.entries.length === 0)
    return { ok: false, error: 'VALIDATION', message: 'Không có phí bán nào để lưu.' };

  // P1 — KỲ hiệu lực của lần set này (không truyền = hôm nay). Floor nửa đêm LOCAL (khớp partial-unique DB).
  const effRaw = input.effectiveFrom !== undefined ? parseDate(input.effectiveFrom) : new Date();
  if (!effRaw) return { ok: false, error: 'VALIDATION', message: 'Ngày hiệu lực không hợp lệ.' };
  const effectiveFrom = startOfDayLocal(effRaw);

  // Validate mọi loại thẻ thuộc đúng ngân hàng của TID + phí hợp lệ (0..100%).
  const cardIds = [...new Set(input.entries.map((e) => e.cardTypeId))];
  const cards = await db.cardType.findMany({ where: { id: { in: cardIds }, deletedAt: null } });
  const cardById = new Map(cards.map((c) => [c.id, c]));
  for (const e of input.entries) {
    const c = cardById.get(e.cardTypeId);
    if (!c) return { ok: false, error: 'NOT_FOUND', message: 'Loại thẻ không tồn tại.' };
    // [B209 19/11 — Admin Demo "kể cả thẻ khác bank khác"] TRƯỚC: CHẶN đặt giá bán cho loại thẻ không thuộc
    // ngân hàng của TID. Thực tế máy POS vẫn quẹt thẻ ngoài hệ thống, nên chặn cứng là sai. NAY cho phép,
    // chỉ ghi lại để còn soi. (Đường GHI BILL cũng đã bỏ chặn tương ứng — nếu chỉ bỏ một đầu thì đặt được
    // giá mà vẫn không ghi nổi bill: vá nửa vời, rất khó lần ra.)
    if (tid.bankId != null && c.bankId !== tid.bankId) {
      console.warn(`[setTidSellFees] TID ${tid.tid}: đặt giá bán cho thẻ "${c.name}" KHÁC ngân hàng của TID (cho phép theo lệnh Admin Demo 19/11).`);
    }
    if (e.phiBan != null && (!Number.isFinite(e.phiBan) || e.phiBan < 0 || e.phiBan > 100))
      return { ok: false, error: 'VALIDATION', message: 'Phí bán phải trong khoảng 0–100%.' };
    // B86 (đồng bộ từ GLB 0.2.63, sửa B45 suy luận sai) — phí bán thực tế KHÔNG ràng buộc với phí cài máy,
    // KHÔNG ràng buộc với phí bán niêm yết. Ràng buộc DUY NHẤT: phí bán thực tế KHÔNG được thấp hơn phí mua
    // niêm yết hiệu lực (bán thấp hơn mua là lỗ). FEE_MODEL — phí mua là CỐ ĐỊNH ở FeeRate (không theo loại phí).
    // B86-2 (audit fix — Admin Demo chốt: rule so sánh LUÔN LUÔN phải chạy, không ngoại lệ) — trước đây điều kiện
    // `tid.partnerId != null` làm cả khối validate bị BỎ QUA khi TID chưa gắn đối tác (cho lưu phí bán tự do
    // 0–100% không so sánh gì); và khi có partnerId nhưng KHÔNG có FeeRate hiệu lực cho cặp đối tác×thẻ, biến
    // `rate` undefined cũng ÂM THẦM bỏ qua check. Nay BẮT BUỘC phải xác định được phí mua trước khi cho lưu
    // phiBan — thiếu đối tác hoặc thiếu FeeRate đều CHẶN RÕ RÀNG (không im lặng cho qua).
    if (e.phiBan != null) {
      if (tid.partnerId == null)
        return { ok: false, error: 'VALIDATION', message: 'TID chưa gắn đối tác, không thể xác định phí mua để so sánh.' };
      const rates = await db.feeRate.findMany({ where: { partnerId: tid.partnerId, cardTypeId: e.cardTypeId, deletedAt: null } });
      // P1 — so với phí mua NIÊM YẾT hiệu lực TẠI `effectiveFrom` của KỲ này (không phải hôm nay) — để set KỲ
      // lùi/tới so đúng phí mua của kỳ đó.
      const rate = pickEffectiveRate(rates, effectiveFrom);
      if (!rate)
        return { ok: false, error: 'VALIDATION', message: 'Chưa cấu hình phí mua (FeeRate) cho loại thẻ này, không thể xác định phí mua để so sánh.' };
      const phiMuaPct = milliToPct(rate.phiMua);
      // [B209 19/11 — Admin Demo "giá bán được phép cao hoặc thấp hơn giá niêm yết"] TRƯỚC: CHẶN CỨNG phí bán
      // < phí MUA. Đo thật 19/11: đặt 1,4% (dưới niêm yết 1,5%) vốn đã chạy được; cái bị chặn là đặt DƯỚI
      // GIÁ VỐN (1,15% so với phí mua 1,35%). Admin Demo chốt cho phép đặt cả cao lẫn thấp.
      // NAY: KHÔNG chặn nữa — nhưng PHẢI nói rõ lỗ bao nhiêu, để không ai lỡ tay đặt lỗ mà không biết
      // (cùng tinh thần "chặn thì phải báo rõ": bỏ chặn thì càng phải báo rõ).
      if (e.phiBan < phiMuaPct) {
        duoiPhiMuaRows.push({
          cardTypeId: e.cardTypeId,
          phiBan: e.phiBan,
          phiMua: phiMuaPct,
          loPct: Math.round((phiMuaPct - e.phiBan) * 1000) / 1000
        });
      }
    }
  }

  const now = new Date();
  // P1 — cửa sổ NGÀY của KỲ (upsert theo NGÀY effectiveFrom, khớp partial-unique DB theo NGÀY-local).
  const dayEnd = new Date(effectiveFrom.getTime() + 86_400_000);
  const changed: { cardTypeId: number; phiBan: number | null }[] = [];
  try {
  await runFeeTxWithRetry(() => db.$transaction(async (txc) => {
    // TOCTOU FIX (khóa tư vấn cấp-giao-dịch) — LẤY KHÓA NGAY ĐẦU tx, TRƯỚC mọi read (findFirst existing +
    // recalc). 2 lệnh setTidSellFees song song CÙNG tid đọc READ COMMITTED cùng thấy "chưa có kỳ" → cùng create
    // → 2 dòng cùng KỲ + recalc doanh thu chồng chéo → resolveFeeForTxn chọn dòng bất định (tiền sai). Khóa theo
    // CHỈ tidId là ĐỦ: mọi entries của lần set này đều thuộc CÙNG tid (loại phí/thẻ nằm trong), nên serialize
    // theo tid bao trọn mọi ghi của 2 luồng cạnh tranh cho tid đó. classid = namespace RIÊNG 910000002 (TÁCH khỏi
    // 910000001 fee-config + 748301 user). objid = tid.id NGUYÊN (autoincrement luôn ≤ int4 max 2.1 tỷ → KHÔNG
    // cần băm, KHÔNG rủi ro va chạm). Khóa tự nhả khi tx commit/rollback (khuôn user.ts; $executeRawUnsafe vì
    // pg_advisory_xact_lock trả void → queryCompiler wasm không deserialize $queryRaw được).
    await txc.$executeRawUnsafe('SELECT pg_advisory_xact_lock(910000002, $1)', tid.id);
    // Backstop bổ sung: khóa HÀNG TID (FOR UPDATE) + partial-unique DB tid_sell_fees_active_uq (còn-sống) — phòng
    // thủ nhiều lớp; advisory lock ở trên là lớp serialize chính (bao cả nhánh recalc, không chỉ ghi tid_sell_fees).
    await txc.$queryRawUnsafe('SELECT id FROM tids WHERE id = $1 FOR UPDATE', tid.id);
    const khachRieng = input.customerId ?? null;   // null = giá CHUNG của máy
    for (const e of input.entries) {
      if (e.phiBan == null) {
        // Xóa override CỦA KỲ NÀY → quay về niêm yết cho kỳ đó. Chỉ đụng hàng CÒN SỐNG cùng NGÀY hiệu lực.
        const liveRaw = await txc.$queryRawUnsafe<{ id: number }[]>(
          `SELECT id FROM tid_sell_fees WHERE tid_id=$1 AND card_type_id=$2 AND fee_type_id=$3 AND deleted_at IS NULL
             AND effective_from >= $4::timestamptz AND effective_from < $5::timestamptz
             AND COALESCE(customer_id, 0) = $6 ORDER BY id DESC LIMIT 1`,
          tid.id, e.cardTypeId, input.feeTypeId, effectiveFrom.toISOString(), dayEnd.toISOString(), khachRieng ?? 0);
        const live = liveRaw[0] ?? null;
        if (live) {
          await txc.tidSellFee.update({ where: { id: live.id }, data: { deletedAt: now, deletedBy: user.id, updatedBy: user.id } });
          changed.push({ cardTypeId: e.cardTypeId, phiBan: null });
        }
        continue;
      }
      const milli = pctToMilli(e.phiBan);
      // Upsert theo KỲ (cùng NGÀY effectiveFrom, KỂ CẢ bản đã xóa mềm → hồi sinh) — CÙNG khuôn fee-config setFeeRate.
      const existingRaw = await txc.$queryRawUnsafe<Array<{ id: number; phi_ban: number; deleted_at: Date | null }>>(
        `SELECT id, phi_ban, deleted_at FROM tid_sell_fees WHERE tid_id=$1 AND card_type_id=$2 AND fee_type_id=$3
           AND effective_from >= $4::timestamptz AND effective_from < $5::timestamptz
           AND COALESCE(customer_id, 0) = $6 ORDER BY id DESC LIMIT 1`,
        tid.id, e.cardTypeId, input.feeTypeId, effectiveFrom.toISOString(), dayEnd.toISOString(), khachRieng ?? 0);
      const existing = existingRaw[0] ? { id: existingRaw[0].id, phiBan: Number(existingRaw[0].phi_ban), deletedAt: existingRaw[0].deleted_at } : null;
      if (existing) {
        // [B236 22/11] GHI PHÍ MUA NĐT trước, NGOÀI nhánh "giá bán có đổi". Đặt bên trong là: người dùng
        // chỉ sửa phí mua NĐT mà giữ nguyên giá bán ⇒ nhánh không chạy ⇒ API trả 200 mà SỔ KHÔNG ĐỔI —
        // đúng kiểu "báo thành công nhưng không ghi gì". Cổng B236 bắt được ngay lần chạy đầu.
        await ghiPhiMuaNdt(txc, existing.id, e.phiMuaNdt);
        if (existing.phiBan !== milli || existing.deletedAt != null) {
          await txc.tidSellFee.update({ where: { id: existing.id }, data: { phiBan: milli, effectiveFrom, deletedAt: null, deletedBy: null, updatedBy: user.id } });
          await suaEffRaw(txc, existing.id, effectiveFrom); // [24/9] vá lệch −7h của adapter
          changed.push({ cardTypeId: e.cardTypeId, phiBan: e.phiBan });
        }
      } else {
        if (khachRieng != null) {
          // GIÁ RIÊNG: phải INSERT KÈM customer_id NGAY — tạo bằng Prisma (customer_id NULL) rồi UPDATE sau thì
          // lúc chèn nó trùng khoá với dòng GIÁ CHUNG cùng ngày (COALESCE(customer_id,0)=0) → 23505. Raw + ::timestamptz
          // cũng vá luôn lệch −7h của adapter, khỏi gọi suaEffRaw.
          await txc.$executeRawUnsafe(
            `INSERT INTO tid_sell_fees (tid_id, card_type_id, fee_type_id, phi_ban, effective_from, customer_id, created_by, updated_by, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$7,$7, now(), now())`,
            tid.id, e.cardTypeId, input.feeTypeId, milli, effectiveFrom.toISOString(), khachRieng, user.id);
        } else {
          // [B230 22/11 — Admin Demo "đang nhập ra sửa phí báo lỗi hệ thống"] PHẢI chèn bằng SQL THÔ + ::timestamptz.
          // GỐC (đọc log máy chủ thật, không suy): khoá duy nhất `tid_sell_fees_active_uq` tính theo
          // (effective_from AT TIME ZONE 'Asia/Ho_Chi_Minh')::date. Ghi qua Prisma bị LÙI 7 TIẾNG ⇒ 00:00 ngày D
          // nằm thành 17:00 ngày D−1 ⇒ ĐỤNG đúng dòng giá của NGÀY HÔM TRƯỚC ⇒ UniqueConstraintViolation ⇒
          // route ném 500 "lỗi hệ thống". `suaEffRaw` chữa SAU khi chèn nên không cứu được — chèn đã nổ rồi.
          // Nhánh GIÁ RIÊNG ngay trên đã dùng SQL thô vì đúng lý do này; nhánh giá CHUNG bị bỏ sót.
          await txc.$executeRawUnsafe(
            `INSERT INTO tid_sell_fees (tid_id, card_type_id, fee_type_id, phi_ban, effective_from, created_by, updated_by, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5::timestamptz,$6,$6, now(), now())`,
            tid.id, e.cardTypeId, input.feeTypeId, milli, effectiveFrom.toISOString(), user.id);
          const moiRaw = await txc.$queryRawUnsafe<Array<{ id: number }>>(
            `SELECT id FROM tid_sell_fees WHERE tid_id=$1 AND card_type_id=$2 AND fee_type_id=$3
               AND effective_from >= $4::timestamptz AND effective_from < $5::timestamptz
               AND COALESCE(customer_id, 0) = 0 ORDER BY id DESC LIMIT 1`,
            tid.id, e.cardTypeId, input.feeTypeId, effectiveFrom.toISOString(), dayEnd.toISOString());
          if (moiRaw[0]) await ghiPhiMuaNdt(txc, moiRaw[0].id, e.phiMuaNdt);
        }
        changed.push({ cardTypeId: e.cardTypeId, phiBan: e.phiBan });
      }
    }
    // PHA 2 (quyết định 1A) — RECALC doanh thu MỌI GD POSTED của TID×loại-phí này từ mốc hiệu lực trở đi, ATOMIC
    // trong CÙNG tx đổi phí bán thực tế. cardTypeId=undefined (mọi thẻ; idempotent → thẻ không đổi ra 0 log). to=null
    // (+∞): idempotent → GD sau kỳ kế tra ra phí y hệt snapshot → 0 đổi. Chỉ recalc khi CÓ thay đổi phí (changed>0).
    if (changed.length > 0) {
      const recalc = await recalcRevenueForFeeChange(txc as unknown as RecalcClient, {
        tidId: tid.id, feeTypeId: input.feeTypeId, from: effectiveFrom, to: null,
        reason: 'TID_SELL_FEE_SET', actorUserId: user.id
      });
      if (!recalc.ok) throw new RecalcAbortError(recalc.failed); // R198 — KHÔNG nuốt lỗi: rollback + báo rõ.
      overpaidRows = recalc.overpaid; // GD khách trả dư sau khi hạ phí bán — UI nhắc hoàn tay
      grandfatheredRows = recalc.grandfathered; // P5: GD cũ (niêm yết) đã bỏ qua — báo lên UI.
      loDaSua = recalc.loDaSua ?? 0;
      loBoQua = recalc.loBoQua ?? [];
    }
  }));
  } catch (e) {
    if (e instanceof RecalcAbortError)
      return { ok: false, error: 'REVENUE_RECALC_FAILED', message: `Không thể tính lại doanh thu cho ${e.failures.length} giao dịch bị ảnh hưởng (thiếu biểu phí hiệu lực tại ngày giao dịch của chúng). Đã HỦY đổi phí bán. Kiểm tra biểu phí rồi thử lại. GD: ${e.failures.slice(0, 5).map((f) => '#' + f.transactionId).join(', ')}` };
    throw e;
  }

  if (changed.length > 0)
    await writeAudit(db, { actorUserId: user.id, action: 'TID_SELL_FEE_SET', targetType: 'Tid', targetId: String(tid.id), after: { tid: tid.tid, feeTypeId: input.feeTypeId, effectiveFrom: effectiveFrom.toISOString(), changed } });
  return { ok: true, id: tid.id, overpaid: overpaidRows, grandfathered: grandfatheredRows, duoiPhiMua: duoiPhiMuaRows, loDaSua, loBoQua };
}
