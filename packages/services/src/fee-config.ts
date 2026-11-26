// Cấu hình phí — LÕI THUẦN ctx-based. PORT nghiệp vụ từ apps/desktop/src/main/fee-config-service.ts
// (IMS_SPEC §C5). Thay `requirePermission(current-user global)` bằng ctx = { db, user } do adapter dựng; mỗi hàm
// tự kiểm quyền qua hasPermission(ctx.user, CONFIG_FEE_VIEW/MANAGE). GIỮ NGUYÊN business: phí lưu Int = % ×1000
// (≤3 số thập phân, KHÔNG float); biểu phí theo KỲ effectiveFrom (P1.1 startOfDayLocal); ràng buộc phí bán ≥
// phí mua; upsert kỳ nguyên tử ($transaction); audit; soft-delete. §14 xác nhận MẬT KHẨU do ADAPTER kiểm TRƯỚC
// khi gọi lõi (khuôn customer.ts) — lõi KHÔNG kiểm password.
import { auditSnapshot, pickEffectiveRate } from '@sigma/business-rules';
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { recalcRevenueForFeeChange, RecalcAbortError, type RecalcClient, type RecalcOverpay, type RecalcFailure } from './revenue-recalc.js';
import { staleGuard } from './optimistic-lock.js';
import { type ServiceCtx, type MutationResult } from './customer.js';
import type { AuditTrail } from './industry.js';
import { nhanBank } from './nhan-bank.js';

const VIEW = 'CONFIG_FEE_VIEW';
const MANAGE = 'CONFIG_FEE_MANAGE';
const SCALE = 1000; // phần trăm × 1000
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';
// FIX-PERF — hard-cap chống kéo full-bảng (bảng cấu hình UI cần toàn bộ; không phân trang, chỉ chặn bộ nhớ).
const FEE_CONFIG_LIST_MAX = 500;

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}
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
async function resolveUserNames(db: Db, ids: (number | null | undefined)[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids.filter((x): x is number => typeof x === 'number'))];
  const map = new Map<number, string>();
  if (uniq.length === 0) return map;
  const users = await db.user.findMany({ where: { id: { in: uniq } }, select: { id: true, fullName: true, username: true } });
  for (const u of users) map.set(u.id, u.fullName || u.username);
  return map;
}
function trail(row: { createdBy: number | null; createdAt: Date; updatedBy: number | null; updatedAt: Date }, names: Map<number, string>): AuditTrail {
  return {
    createdBy: row.createdBy,
    createdByName: row.createdBy != null ? names.get(row.createdBy) ?? null : null,
    createdAt: row.createdAt.toISOString(),
    updatedBy: row.updatedBy,
    updatedByName: row.updatedBy != null ? names.get(row.updatedBy) ?? null : null,
    updatedAt: row.updatedAt.toISOString()
  };
}

/** Phần trăm (số, ≤3 thập phân, 0–100) → Int ×1000. null nếu không hợp lệ. */
function pctToMilli(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  // L2 (đối kháng 12/8): chặn TRẦN 100% — đồng bộ với tid-sell-fee.ts (kẹp 0–100). TRƯỚC: chỉ kiểm ≥0 → phí
  // niêm yết 150% lọt → marginToAmount cho amountAfterFee ÂM → lo-service cộng số âm. Phí >100% vô nghĩa.
  if (!Number.isFinite(n) || n < 0 || n > 100) return null;
  const milli = Math.round(n * SCALE);
  if (Math.abs(n * SCALE - milli) > 1e-6) return null; // quá 3 số thập phân
  return milli;
}
const milliToPct = (m: number): number => m / SCALE;

/** ISO string / Date → Date hợp lệ, hoặc null. */
function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}
/**
 * Chuẩn hóa về nửa đêm 00:00:00.000 LOCAL của NGÀY (P1.1: "1 kỳ / 1 mốc effectiveFrom-ngày").
 * B16/F1: PHẢI floor theo LOCAL-day — đối xứng với `fmtDate` (getter local) và `txnDate` (UI gửi
 * `new Date(d+'T00:00:00').toISOString()` = nửa đêm local). Floor theo UTC-day lệch +7h trên máy
 * UTC+7 (production) → user nhập 01/07 nhưng lưu/hiển thị 30/06. Không dùng UTC getters ở đây.
 */
function startOfDayLocal(d: Date): Date {
  // FIX GỐC (Admin Demo 31/8 "cấm tái diễn tuyệt đối"): floor nửa đêm Asia/Ho_Chi_Minh (UTC+7, KHÔNG DST) TƯỜNG
  // MINH, KHÔNG theo TZ tiến trình (MIRROR tid-sell-fee/revenue-recalc). Xem BUGS_FIXED B141.
  const HCM = 7 * 60 * 60 * 1000;
  const w = new Date(d.getTime() + HCM);
  return new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - HCM);
}

// ═════════════════════════════════════════════════════════════════════════════
// §C5a — LOẠI PHÍ BÁN
// ═════════════════════════════════════════════════════════════════════════════
export interface FeeTypeDto extends AuditTrail {
  id: number;
  name: string;
}
export interface CreateFeeTypeInput {
  name: string;
}
export interface UpdateFeeTypeInput {
  name?: string;
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form
}

export async function listFeeTypes(ctx: ServiceCtx): Promise<{ ok: boolean; data?: FeeTypeDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.feeType.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' }, take: FEE_CONFIG_LIST_MAX });
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.createdBy, r.updatedBy]));
  return { ok: true, data: rows.map((r) => ({ id: r.id, name: r.name, ...trail(r, names) })) };
}

export async function createFeeType(ctx: ServiceCtx, input: CreateFeeTypeInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const name = input.name?.trim();
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên loại phí bắt buộc.' };
  const dup = await db.feeType.findFirst({ where: { name } });
  if (dup) {
    return dup.deletedAt
      ? { ok: false, error: 'DUPLICATE_TRASH', message: `Loại phí "${name}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn tên khác.` }
      : { ok: false, error: 'DUPLICATE', message: `Loại phí "${name}" đã tồn tại.` };
  }
  let created;
  try {
    created = await db.feeType.create({ data: { name, createdBy: user.id } });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `Loại phí "${name}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'FEE_TYPE_CREATED', targetType: 'FeeType', targetId: String(created.id), after: auditSnapshot({ name }) });
  return { ok: true, id: created.id };
}

export async function updateFeeType(ctx: ServiceCtx, id: number, input: UpdateFeeTypeInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.feeType.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại phí không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;
  const name = input.name !== undefined ? input.name.trim() : row.name;
  if (!name) return { ok: false, error: 'VALIDATION', message: 'Tên loại phí không được để trống.' };
  if (name !== row.name) {
    const dup = await db.feeType.findFirst({ where: { name, NOT: { id } } });
    if (dup) {
      return dup.deletedAt
        ? { ok: false, error: 'DUPLICATE_TRASH', message: `Loại phí "${name}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn tên khác.` }
        : { ok: false, error: 'DUPLICATE', message: `Loại phí "${name}" đã tồn tại.` };
    }
  }
  const before = auditSnapshot({ name: row.name });
  let updated;
  try {
    updated = await db.feeType.update({ where: { id }, data: { name, updatedBy: user.id } });
  } catch (e) {
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `Loại phí "${name}" đã tồn tại.` };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'FEE_TYPE_UPDATED', targetType: 'FeeType', targetId: String(id), before, after: auditSnapshot({ name: updated.name }) });
  return { ok: true, id };
}

/** Xóa mềm 1..n loại phí. §14 xác nhận MẬT KHẨU do ADAPTER kiểm TRƯỚC khi gọi. */
export async function deleteFeeTypes(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn loại phí để xóa.' };
  let deleted = 0;
  for (const id of ids) {
    const row = await db.feeType.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    await db.feeType.update({ where: { id }, data: { deletedAt: new Date(), updatedBy: user.id, deletedBy: user.id } });
    await writeAudit(db, { actorUserId: user.id, action: 'FEE_TYPE_DELETED', targetType: 'FeeType', targetId: String(id), before: auditSnapshot({ name: row.name }) });
    deleted++;
  }
  return { ok: true, deleted };
}

// ═════════════════════════════════════════════════════════════════════════════
// §C5b — BIỂU PHÍ % theo Đối tác × Loại thẻ
// ═════════════════════════════════════════════════════════════════════════════
// FEE_MODEL — 1 % phí bán niêm yết của 1 LOẠI PHÍ trong biểu phí (Đối tác × Loại thẻ × kỳ).
export interface FeeSellQuoteDto {
  feeTypeId: number; // LOẠI PHÍ (Ủy quyền/Tiền chờ/Tiền nhanh…)
  feeTypeName: string | null;
  phiBan: number; // % niêm yết của loại phí này
  clKh: number; // % = phiBan − phiCaiMay (chênh bán của loại phí này)
}
export interface FeeRateDto extends AuditTrail {
  id: number;
  partnerId: number;
  partnerCode: string | null;
  partnerName: string | null;
  cardTypeId: number;
  cardTypeCode: string | null;
  cardTypeName: string | null;
  bankId: number | null;
  bankCode: string | null;
  bankName: string | null;
  phiMua: number; // % — CỐ ĐỊNH (không theo loại phí)
  phiCaiMay: number; // % — CỐ ĐỊNH (không theo loại phí)
  clNcc: number; // % = phiMua − phiCaiMay (giống nhau mọi loại phí)
  effectiveFrom: string; // ISO — ngày bắt đầu hiệu lực của kỳ giá (P1.1)
  isCurrent: boolean; // kỳ đang hiệu lực HÔM NAY của tổ hợp (đối tác × loại thẻ)
  sellQuotes: FeeSellQuoteDto[]; // phí bán niêm yết theo TỪNG loại phí (cùng kỳ effectiveFrom)
}
export interface FeeRateFilter {
  partnerId?: number;
  bankId?: number;
  cardTypeId?: number;
}
export interface SetFeeRateInput {
  partnerId: number;
  cardTypeId: number;
  phiMua: number; // % — CỐ ĐỊNH
  phiCaiMay: number; // % — CỐ ĐỊNH
  effectiveFrom?: string; // ISO — không truyền = mặc định HÔM NAY (P1.1)
  // Phí bán NIÊM YẾT cho MỌI loại phí bán trong danh mục — mỗi loại phí 1 %.
  sellQuotes: { feeTypeId: number; phiBan: number }[];
}
// Phí bán niêm yết hiệu lực theo loại phí (listSellQuotes) — tham chiếu khi set phí bán TID / xem biểu phí.
export interface SellQuoteEffectiveDto {
  feeTypeId: number;
  feeTypeName: string | null;
  phiBan: number; // %
  effectiveFrom: string; // ISO
}

export async function listFeeRates(ctx: ServiceCtx, filter: FeeRateFilter = {}): Promise<{ ok: boolean; data?: FeeRateDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  // [B-L6 21/9] Lọc bankId Ở DB TRƯỚC take (trước đây filter JS SAU take:500 → cấu hình >500 dòng có thể thiếu
  // dòng của đúng bank được lọc, thiếu câm). bank → tập cardTypeId của bank đó → where in.
  let cardIdsTheoBank: number[] | null = null;
  if (filter.bankId && !filter.cardTypeId) {
    cardIdsTheoBank = (await db.cardType.findMany({ where: { bankId: filter.bankId }, select: { id: true } })).map((c) => c.id);
    if (cardIdsTheoBank.length === 0) return { ok: true, data: [] };
  }
  const rows = await db.feeRate.findMany({
    where: {
      deletedAt: null, partnerId: filter.partnerId ?? undefined,
      cardTypeId: filter.cardTypeId ?? (cardIdsTheoBank ? { in: cardIdsTheoBank } : undefined)
    },
    orderBy: [{ partnerId: 'asc' }, { cardTypeId: 'asc' }, { effectiveFrom: 'desc' }],
    take: FEE_CONFIG_LIST_MAX
  });
  // P1.1: kỳ ĐANG HIỆU LỰC hôm nay của MỖI tổ hợp (đối tác × loại thẻ) — pickEffectiveRate(now).
  const now = new Date();
  const currentIdByCombo = new Map<string, number>();
  {
    const byCombo = new Map<string, typeof rows>();
    for (const r of rows) {
      const key = `${r.partnerId}:${r.cardTypeId}`;
      const arr = byCombo.get(key) ?? [];
      arr.push(r);
      byCombo.set(key, arr);
    }
    for (const [key, arr] of byCombo) {
      const cur = pickEffectiveRate(arr, now);
      if (cur) currentIdByCombo.set(key, cur.id);
    }
  }
  // FEE_MODEL — phí bán niêm yết theo TỪNG loại phí (FeeSellQuote), khớp mỗi kỳ FeeRate theo
  // (partnerId, cardTypeId, effectiveFrom) — cùng mốc thời gian (startOfDayLocal khi set).
  const comboCards = [...new Set(rows.map((r) => r.cardTypeId))];
  const comboPartners = [...new Set(rows.map((r) => r.partnerId))];
  const quotes = rows.length
    ? await db.feeSellQuote.findMany({ where: { deletedAt: null, partnerId: { in: comboPartners }, cardTypeId: { in: comboCards } } })
    : [];
  const quotesByPeriod = new Map<string, typeof quotes>();
  for (const q of quotes) {
    const key = `${q.partnerId}:${q.cardTypeId}:${q.effectiveFrom.getTime()}`;
    const arr = quotesByPeriod.get(key) ?? [];
    arr.push(q);
    quotesByPeriod.set(key, arr);
  }
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.createdBy, r.updatedBy]));
  const partners = new Map((await db.partner.findMany({ where: { id: { in: comboPartners } }, select: { id: true, code: true, name: true } })).map((p) => [p.id, p]));
  const cards = new Map((await db.cardType.findMany({ where: { id: { in: comboCards } }, select: { id: true, code: true, name: true, bankId: true } })).map((c) => [c.id, c]));
  const banks = new Map((await db.bank.findMany({ where: { id: { in: [...new Set([...cards.values()].map((c) => c.bankId))] } }, select: { id: true, code: true, name: true } })).map((b) => [b.id, b]));
  const feeTypes = new Map((await db.feeType.findMany({ where: { id: { in: [...new Set(quotes.map((q) => q.feeTypeId))] } }, select: { id: true, name: true } })).map((f) => [f.id, f.name]));
  let data = rows.map((r) => {
    const card = cards.get(r.cardTypeId);
    const bank = card ? banks.get(card.bankId) : undefined;
    const periodQuotes = (quotesByPeriod.get(`${r.partnerId}:${r.cardTypeId}:${r.effectiveFrom.getTime()}`) ?? [])
      .slice()
      .sort((a, b) => a.feeTypeId - b.feeTypeId);
    const sellQuotes: FeeSellQuoteDto[] = periodQuotes.map((q) => ({
      feeTypeId: q.feeTypeId,
      feeTypeName: feeTypes.get(q.feeTypeId) ?? null,
      phiBan: milliToPct(q.phiBan),
      clKh: milliToPct(q.phiBan - r.phiCaiMay)
    }));
    return {
      id: r.id,
      partnerId: r.partnerId,
      partnerCode: partners.get(r.partnerId)?.code ?? null,
      partnerName: partners.get(r.partnerId)?.name ?? null,
      cardTypeId: r.cardTypeId,
      cardTypeCode: card?.code ?? null,
      cardTypeName: card?.name ?? null,
      bankId: card?.bankId ?? null,
      bankCode: bank?.code ?? null,
      bankName: nhanBank(bank), // [16/11] mã viết tắt
      phiMua: milliToPct(r.phiMua),
      phiCaiMay: milliToPct(r.phiCaiMay),
      clNcc: milliToPct(r.phiMua - r.phiCaiMay),
      effectiveFrom: r.effectiveFrom.toISOString(),
      isCurrent: currentIdByCombo.get(`${r.partnerId}:${r.cardTypeId}`) === r.id,
      sellQuotes,
      ...trail(r, names)
    };
  });
  if (filter.bankId) data = data.filter((d) => d.bankId === filter.bankId);
  return { ok: true, data };
}

/**
 * Set biểu phí cho 1 KỲ của tổ hợp (Đối tác × Loại thẻ) tại mốc `effectiveFrom` (P1.1). FEE_MODEL:
 *   • phí MUA + phí CÀI MÁY = 1 giá CỐ ĐỊNH (FeeRate) — KHÔNG theo loại phí.
 *   • phí BÁN NIÊM YẾT theo TỪNG loại phí (FeeSellQuote) — mỗi loại phí 1 %.
 * UPSERT theo (partnerId, cardTypeId, effectiveFrom-NGÀY) cho FeeRate + theo thêm chiều feeTypeId cho mỗi
 * FeeSellQuote. Đã có kỳ CÙNG mốc (kể cả xóa mềm→bật lại) → cập nhật; khác mốc → TẠO KỲ MỚI. Toàn bộ trong
 * 1 $transaction (nguyên tử). Không truyền effectiveFrom → mặc định HÔM NAY.
 */
export async function setFeeRate(ctx: ServiceCtx, input: SetFeeRateInput): Promise<MutationResult & { overpaid?: RecalcOverpay[]; grandfathered?: RecalcFailure[] }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  let overpaidRows: RecalcOverpay[] = []; // surface recalc trả-dư ra UI để nhắc hoàn tay (Admin Demo 12/8)
  let grandfatheredRows: RecalcFailure[] = []; // P5: GD cũ dùng niêm yết bị BỎ QUA khi recalc — surface cảnh báo (không nuốt).
  if (!input.partnerId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn đối tác.' };
  if (!input.cardTypeId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn loại thẻ.' };
  const phiMua = pctToMilli(input.phiMua);
  const phiCaiMay = pctToMilli(input.phiCaiMay);
  if (phiMua === null) return { ok: false, error: 'VALIDATION', message: 'Phí mua không hợp lệ (≥0, tối đa 3 số thập phân).' };
  if (phiCaiMay === null) return { ok: false, error: 'VALIDATION', message: 'Phí cài máy không hợp lệ (≥0, tối đa 3 số thập phân).' };
  // Phí bán niêm yết BẮT BUỘC cấu hình cho ≥1 loại phí (danh mục ≥3 loại — UI gửi hết loại phí active).
  if (!Array.isArray(input.sellQuotes) || input.sellQuotes.length === 0)
    return { ok: false, error: 'VALIDATION', message: 'Vui lòng nhập phí bán niêm yết cho ít nhất một loại phí.' };
  // B86 + Admin Demo 9/8: phí cài máy KHÔNG ràng buộc phí mua/bán. Phí bán NIÊM YẾT theo loại phí (tiền chờ/uỷ
  // quyền…) ĐƯỢC để = 0 hoặc GIÁ TRỊ BẤT KỲ (≥0) — KHÔNG ràng buộc ≥ phí mua, không phụ thuộc phí cài máy. Bỏ
  // chặn cũ "phí bán ≥ phí mua" (khiến không điều chỉnh được). Chỉ kiểm hợp lệ ≥0, ≤3 thập phân.
  const quotesMilli: { feeTypeId: number; phiBan: number }[] = [];
  const seenFeeType = new Set<number>();
  for (const q of input.sellQuotes) {
    if (!q.feeTypeId) return { ok: false, error: 'VALIDATION', message: 'Thiếu loại phí cho phí bán niêm yết.' };
    if (seenFeeType.has(q.feeTypeId)) return { ok: false, error: 'VALIDATION', message: 'Trùng loại phí trong danh sách phí bán niêm yết.' };
    seenFeeType.add(q.feeTypeId);
    const phiBan = pctToMilli(q.phiBan);
    if (phiBan === null) return { ok: false, error: 'VALIDATION', message: 'Phí bán niêm yết không hợp lệ (≥0, tối đa 3 số thập phân).' };
    quotesMilli.push({ feeTypeId: q.feeTypeId, phiBan });
  }
  const effRaw = input.effectiveFrom !== undefined ? parseDate(input.effectiveFrom) : new Date();
  if (!effRaw) return { ok: false, error: 'VALIDATION', message: 'Ngày hiệu lực không hợp lệ.' };
  const effectiveFrom = startOfDayLocal(effRaw);

  const partner = await db.partner.findUnique({ where: { id: input.partnerId } });
  if (!partner || partner.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Đối tác không tồn tại.' };
  const card = await db.cardType.findUnique({ where: { id: input.cardTypeId } });
  if (!card || card.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại thẻ không tồn tại.' };
  // Mỗi loại phí niêm yết phải tồn tại + chưa xóa.
  for (const q of quotesMilli) {
    const feeType = await db.feeType.findUnique({ where: { id: q.feeTypeId } });
    if (!feeType || feeType.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại phí không tồn tại.' };
  }
  // Loại thẻ thuộc ngân hàng — ngân hàng đó phải liên kết với đối tác (§C5b: chọn NH liên kết đối tác).
  const link = await db.partnerBank.findFirst({ where: { partnerId: input.partnerId, bankId: card.bankId, deletedAt: null } });
  if (!link) return { ok: false, error: 'NOT_LINKED', message: 'Ngân hàng của loại thẻ này chưa liên kết với đối tác. Hãy liên kết ở mục Đối tác trước.' };

  // Upsert theo KỲ (cùng NGÀY effectiveFrom, kể cả bản xóa mềm) — FeeRate + mỗi FeeSellQuote — nguyên tử.
  const dayEnd = new Date(effectiveFrom.getTime() + 86_400_000);
  let rateId: number;
  try {
    rateId = await runFeeTxWithRetry(() => db.$transaction(async (tx) => {
      // TOCTOU FIX (khóa tư vấn cấp-giao-dịch) — LẤY KHÓA NGAY ĐẦU tx, TRƯỚC mọi read (findFirst existing +
      // recalc). READ COMMITTED cho 2 lời setFeeRate song song CÙNG (partnerId, cardTypeId) cùng thấy "chưa có
      // kỳ" → cùng create → 2 dòng FeeRate/FeeSellQuote CÙNG kỳ (FeeRate KHÔNG có @@unique DB — bài học B05 giữ
      // soft-delete → không có backstop cấp DB) + recalc doanh thu chồng chéo (lost update / tiền sai bất định).
      // pg_advisory_xact_lock serialize theo TỔ HỢP; TỰ NHẢ khi tx commit/rollback (khuôn user.ts 748301, dùng
      // $executeRawUnsafe vì lock trả void → queryCompiler wasm không deserialize $queryRaw được).
      // Dạng 2-int4 pg_advisory_xact_lock(classid, objid): classid = namespace RIÊNG 910000001 (TÁCH khỏi
      // 748301 của user/last-admin, và khỏi 910000002 của tid-sell-fee) → không va khóa nhầm miền. objid = băm
      // ổn định (partnerId, cardTypeId) vào 1 int4: 16-bit mỗi vế; phép `<<16 |` của JS luôn cho int4 signed hợp
      // lệ [-2^31, 2^31-1]. GIỚI HẠN: id > 65535 bị truncate 16-bit → CÓ THỂ va chạm với tổ hợp khác → chỉ
      // serialize DƯ (chậm nhẹ), KHÔNG mất update — vì CÙNG (partnerId, cardTypeId) LUÔN băm ra CÙNG objid nên
      // bất biến chống-trùng-kỳ vẫn đúng tuyệt đối. IMS nội bộ id nhỏ (<<65535); nếu tương lai id vượt ngưỡng,
      // đổi sang dạng 1-int8 pg_advisory_xact_lock(bigint) băm rộng hơn.
      const lockObjId = ((input.partnerId & 0xffff) << 16) | (input.cardTypeId & 0xffff);
      await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(910000001, $1)', lockObjId);
      const existing = await tx.feeRate.findFirst({
        where: { partnerId: input.partnerId, cardTypeId: input.cardTypeId, effectiveFrom: { gte: effectiveFrom, lt: dayEnd } }
      });
      let id: number;
      if (existing) {
        await tx.feeRate.update({ where: { id: existing.id }, data: { phiMua, phiCaiMay, effectiveFrom, deletedAt: null, deletedBy: null, updatedBy: user.id } });
        id = existing.id;
      } else {
        const created = await tx.feeRate.create({ data: { partnerId: input.partnerId, cardTypeId: input.cardTypeId, phiMua, phiCaiMay, effectiveFrom, createdBy: user.id } });
        id = created.id;
      }
      for (const q of quotesMilli) {
        const exQ = await tx.feeSellQuote.findFirst({
          where: { partnerId: input.partnerId, cardTypeId: input.cardTypeId, feeTypeId: q.feeTypeId, effectiveFrom: { gte: effectiveFrom, lt: dayEnd } }
        });
        if (exQ) {
          await tx.feeSellQuote.update({ where: { id: exQ.id }, data: { phiBan: q.phiBan, effectiveFrom, deletedAt: null, deletedBy: null, updatedBy: user.id } });
        } else {
          await tx.feeSellQuote.create({ data: { partnerId: input.partnerId, cardTypeId: input.cardTypeId, feeTypeId: q.feeTypeId, phiBan: q.phiBan, effectiveFrom, createdBy: user.id } });
        }
      }
      // PHA 2 (quyết định 1A) — RECALC doanh thu MỌI GD POSTED của (đối tác × loại thẻ) từ mốc hiệu lực này trở đi,
      // ATOMIC trong CÙNG tx đổi phí (đổi phí + recalc + log commit/rollback cùng nhau — không có cửa sổ doanh thu
      // cũ sai). to=null (+∞): idempotent nên GD sau kỳ kế tra ra phí y hệt → 0 đổi (không cần tự tính ranh giới kỳ kế).
      const recalc = await recalcRevenueForFeeChange(tx as unknown as RecalcClient, {
        partnerId: input.partnerId, cardTypeId: input.cardTypeId, from: effectiveFrom, to: null,
        reason: 'FEE_RATE_SET', actorUserId: user.id
      });
      if (!recalc.ok) throw new RecalcAbortError(recalc.failed); // R198 — KHÔNG nuốt lỗi: rollback + báo rõ.
      overpaidRows = recalc.overpaid; // GD khách trả dư sau khi hạ phí — UI nhắc hoàn tay (không tự chuyển tiền)
      grandfatheredRows = recalc.grandfathered; // P5: GD cũ (niêm yết, chưa có giá thực tế) đã bỏ qua — báo lên UI.
      return id;
    }));
  } catch (e) {
    if (e instanceof RecalcAbortError)
      return { ok: false, error: 'REVENUE_RECALC_FAILED', message: `Không thể tính lại doanh thu cho ${e.failures.length} giao dịch bị ảnh hưởng (thiếu biểu phí hiệu lực tại ngày giao dịch của chúng). Đã HỦY đổi phí. Kiểm tra biểu phí rồi thử lại. GD: ${e.failures.slice(0, 5).map((f) => '#' + f.transactionId).join(', ')}` };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'FEE_RATE_SET', targetType: 'FeeRate', targetId: String(rateId), after: auditSnapshot({ partnerId: input.partnerId, cardTypeId: input.cardTypeId, phiMua, phiCaiMay, effectiveFrom: effectiveFrom.toISOString(), sellQuotes: quotesMilli }) });
  return { ok: true, id: rateId, overpaid: overpaidRows, grandfathered: grandfatheredRows };
}

/**
 * FEE_MODEL — phí bán NIÊM YẾT hiệu lực theo TỪNG loại phí của (Đối tác × Loại thẻ) tại `at` (mặc định HÔM
 * NAY). Mỗi loại phí lấy KỲ FeeSellQuote hiệu lực (pickEffectiveRate). Dùng cho form phí bán TID (tham chiếu).
 */
export async function listSellQuotes(ctx: ServiceCtx, partnerId: number, cardTypeId: number, at?: string): Promise<{ ok: boolean; data?: SellQuoteEffectiveDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  if (!partnerId || !cardTypeId) return { ok: false, error: 'VALIDATION', message: 'Thiếu đối tác hoặc loại thẻ.' };
  const when = at ? parseDate(at) ?? new Date() : new Date();
  const quotes = await db.feeSellQuote.findMany({ where: { partnerId, cardTypeId, deletedAt: null } });
  const byFeeType = new Map<number, typeof quotes>();
  for (const q of quotes) {
    const arr = byFeeType.get(q.feeTypeId) ?? [];
    arr.push(q);
    byFeeType.set(q.feeTypeId, arr);
  }
  const feeTypeNames = new Map((await db.feeType.findMany({ where: { id: { in: [...byFeeType.keys()] } }, select: { id: true, name: true } })).map((f) => [f.id, f.name]));
  const data: SellQuoteEffectiveDto[] = [];
  for (const [feeTypeId, arr] of byFeeType) {
    const eff = pickEffectiveRate(arr, when);
    if (!eff) continue;
    data.push({ feeTypeId, feeTypeName: feeTypeNames.get(feeTypeId) ?? null, phiBan: milliToPct(eff.phiBan), effectiveFrom: eff.effectiveFrom.toISOString() });
  }
  data.sort((a, b) => a.feeTypeId - b.feeTypeId);
  return { ok: true, data };
}

/** Xóa mềm 1..n kỳ biểu phí + phí bán niêm yết CÙNG KỲ. §14 xác nhận MẬT KHẨU do ADAPTER kiểm TRƯỚC khi gọi. */
export async function deleteFeeRates(ctx: ServiceCtx, ids: number[]): Promise<MutationResult & { deleted?: number }> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn biểu phí để xóa.' };
  let deleted = 0;
  for (const id of ids) {
    const row = await db.feeRate.findUnique({ where: { id } });
    if (!row || row.deletedAt) continue;
    // [B-M4 21/9] CHẶN xoá kỳ biểu phí còn GD PHỤ THUỘC: GD không FK tới feeRate (chốt phí per-txn) nhưng
    // revenue-recalc tra lại pickEffectiveRate theo txn_date — xoá kỳ đang phủ GD thì lần recalc sau phí RƠI VỀ
    // KỲ TRƯỚC (rate khác) → tiền lịch sử đổi CÂM. Đếm GD sống trong [effectiveFrom, kỳ-kế) của đúng
    // (partner × loại thẻ); >0 → chặn với thông báo rõ (R198).
    {
      const kyKe = await db.feeRate.findFirst({
        where: { partnerId: row.partnerId, cardTypeId: row.cardTypeId, deletedAt: null, id: { not: id }, effectiveFrom: { gt: row.effectiveFrom } },
        orderBy: { effectiveFrom: 'asc' }, select: { effectiveFrom: true }
      });
      const denIso = kyKe ? kyKe.effectiveFrom.toISOString() : null;
      const dem = await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM transactions t JOIN tids td ON td.id = t.tid_id
          WHERE td.partner_id = $1 AND t.card_type_id = $2 AND t.status <> 'CANCELLED'
            AND t.txn_date >= $3::timestamptz${denIso ? ' AND t.txn_date < $4::timestamptz' : ''}`,
        ...(denIso ? [row.partnerId, row.cardTypeId, row.effectiveFrom.toISOString(), denIso] : [row.partnerId, row.cardTypeId, row.effectiveFrom.toISOString()]));
      const n = Number(dem[0]?.n ?? 0);
      if (n > 0) {
        return { ok: false, error: 'FEE_RATE_IN_USE', deleted, message: `Kỳ biểu phí này đang PHỦ ${n} giao dịch (từ ${row.effectiveFrom.toISOString().slice(0, 10)}${denIso ? ` đến ${denIso.slice(0, 10)}` : ' đến nay'}) — xoá sẽ làm recalc rơi về kỳ cũ, tiền lịch sử đổi câm. Muốn đổi phí: tạo KỲ MỚI thay vì xoá kỳ đang dùng.` };
      }
    }
    const now = new Date();
    // FEE_MODEL — xóa 1 kỳ biểu phí cũng xóa mềm các phí bán niêm yết CÙNG KỲ (partner × card × effectiveFrom).
    await db.$transaction(async (tx) => {
      await tx.feeRate.update({ where: { id }, data: { deletedAt: now, updatedBy: user.id, deletedBy: user.id } });
      await tx.feeSellQuote.updateMany({ where: { partnerId: row.partnerId, cardTypeId: row.cardTypeId, effectiveFrom: row.effectiveFrom, deletedAt: null }, data: { deletedAt: now, updatedBy: user.id, deletedBy: user.id } });
    });
    await writeAudit(db, { actorUserId: user.id, action: 'FEE_RATE_DELETED', targetType: 'FeeRate', targetId: String(id), before: auditSnapshot({ partnerId: row.partnerId, cardTypeId: row.cardTypeId }) });
    deleted++;
  }
  return { ok: true, deleted };
}
