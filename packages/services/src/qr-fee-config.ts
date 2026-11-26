// [Admin Demo 4/9] Cấu hình PHÍ QR bán hàng + GIẢM phí bán cuối tuần — LÕI THUẦN ctx-based (mirror fee-config.ts).
// Engine phí THUẦN (resolveQrFee/isWeekendHCM/resolveActualSellFee) + DDL 3 bảng phụ ĐÃ có sẵn — module này CHỈ:
//   • CRUD 3 loại cấu hình qua RAW SQL (3 bảng KHÔNG nằm trong Prisma client — cố ý tránh `prisma generate` phá
//     server 24/24; đồng bộ cách repo dùng los.bill_txn_date / ocr_bill_sent): weekend_sell_adjust, qr_partner_fee,
//     qr_fee_rates. Truy cập ONLY qua $queryRawUnsafe/$executeRawUnsafe (KHÔNG có db.qrFeeRate delegate).
//   • RESOLVER resolveQrFeeForTid — giá THỰC TẾ theo MÃ (qr_fee_rates) ĐÈ giá ĐỐI TÁC (qr_partner_fee), song song
//     POS (TidSellFee đè FeeSellQuote). Áp resolveQrFee THUẦN (chọn kỳ + giá mua theo thứ) — KHÔNG viết lại math.
// Phí lưu Int = % ×1000 (milli, ≤3 thập phân). Cuối tuần CHỈ đổi giá MUA (phi_ban không đổi cuối tuần).
import { auditSnapshot, resolveQrFee, type QrFeeRateRow } from '@sigma/business-rules';
import { maxPromoDeltaTheoLich } from './transaction.js';
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { type ServiceCtx, type MutationResult } from './customer.js';
import type { AuditTrail } from './industry.js';
import { nhanBank } from './nhan-bank.js';

const VIEW = 'CONFIG_FEE_VIEW';
const MANAGE = 'CONFIG_FEE_MANAGE';
const SCALE = 1000; // phần trăm × 1000
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';
// FIX-PERF — hard-cap chống kéo full-bảng (bảng cấu hình UI cần toàn bộ; không phân trang, chỉ chặn bộ nhớ). Mirror fee-config.
const LIST_MAX = 500;
const NO_QR_FEE_MSG = 'Chưa cấu hình phí QR cho mã này (chưa có giá theo mã lẫn giá đối tác hiệu lực).';

// ── helper THUẦN (copy nguyên từ fee-config.ts — giữ ĐỒNG NHẤT floor HCM + validate %) ──────────────────────
/** Phần trăm (số, ≤3 thập phân, 0–100) → Int ×1000. null nếu không hợp lệ. */
function pctToMilli(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
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
 * Chuẩn hóa về nửa đêm 00:00:00.000 LOCAL Asia/Ho_Chi_Minh (UTC+7, KHÔNG DST) của NGÀY (P1.1: "1 kỳ / 1 mốc
 * effectiveFrom-ngày"). COPY nguyên từ fee-config.ts (BUGS_FIXED B141) — KHÔNG theo TZ tiến trình.
 */
function startOfDayLocal(d: Date): Date {
  const HCM = 7 * 60 * 60 * 1000;
  const w = new Date(d.getTime() + HCM);
  return new Date(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate()) - HCM);
}
function toISO(v: Date | string): string {
  return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
}

async function resolveUserNames(db: Db, ids: (number | null | undefined)[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids.filter((x): x is number => typeof x === 'number'))];
  const map = new Map<number, string>();
  if (uniq.length === 0) return map;
  const users = await db.user.findMany({ where: { id: { in: uniq } }, select: { id: true, fullName: true, username: true } });
  for (const u of users) map.set(u.id, u.fullName || u.username);
  return map;
}
/** Dựng AuditTrail từ 1 dòng RAW snake_case (bảng phụ) — song song `trail()` của fee-config (camelCase Prisma). */
function rawTrail(
  r: { created_by: number | null; created_at: Date | string; updated_by: number | null; updated_at: Date | string },
  names: Map<number, string>
): AuditTrail {
  return {
    createdBy: r.created_by,
    createdByName: r.created_by != null ? names.get(r.created_by) ?? null : null,
    createdAt: toISO(r.created_at),
    updatedBy: r.updated_by,
    updatedByName: r.updated_by != null ? names.get(r.updated_by) ?? null : null,
    updatedAt: toISO(r.updated_at)
  };
}

// Dòng thô kèm audit/soft-delete dùng chung cho 3 bảng.
interface RawAuditCols {
  id: bigint | number;
  effective_from: Date | string;
  created_by: number | null;
  created_at: Date | string;
  updated_by: number | null;
  updated_at: Date | string;
}

// ═════════════════════════════════════════════════════════════════════════════
// §1 — GIẢM PHÍ BÁN CUỐI TUẦN (POS) theo LOẠI THẺ (global). delta_milli = %×1000.
// ═════════════════════════════════════════════════════════════════════════════
export interface WeekendSellAdjustDto extends AuditTrail {
  id: number;
  cardTypeId: number;
  cardTypeCode: string | null;
  cardTypeName: string | null;
  deltaPct: number; // % GIẢM phí bán cuối tuần (không phải milli)
  effectiveFrom: string; // ISO
}
export interface SetWeekendSellAdjustInput {
  cardTypeId: number;
  deltaPct: number;
  effectiveFrom?: string; // ISO — không truyền = HÔM NAY (startOfDayLocal)
}

export async function listWeekendSellAdjust(
  ctx: ServiceCtx
): Promise<{ ok: boolean; data?: WeekendSellAdjustDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.$queryRawUnsafe<Array<RawAuditCols & { card_type_id: number; delta_milli: number }>>(
    `SELECT id, card_type_id, delta_milli, effective_from, created_by, created_at, updated_by, updated_at ` +
      `FROM weekend_sell_adjust WHERE deleted_at IS NULL ORDER BY card_type_id ASC, effective_from DESC, id DESC LIMIT ${LIST_MAX}`
  );
  const cardIds = [...new Set(rows.map((r) => r.card_type_id))];
  const cards = new Map(
    (await db.cardType.findMany({ where: { id: { in: cardIds } }, select: { id: true, code: true, name: true } })).map((c) => [c.id, c])
  );
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.created_by, r.updated_by]));
  return {
    ok: true,
    data: rows.map((r) => ({
      id: Number(r.id),
      cardTypeId: r.card_type_id,
      cardTypeCode: cards.get(r.card_type_id)?.code ?? null,
      cardTypeName: cards.get(r.card_type_id)?.name ?? null,
      deltaPct: milliToPct(r.delta_milli),
      effectiveFrom: toISO(r.effective_from),
      ...rawTrail(r, names)
    }))
  };
}

/** Set 1 KỲ giảm phí bán cuối tuần cho 1 loại thẻ. Same-day (cùng card_type_id) → soft-delete kỳ cũ + insert mới (nguyên tử). */
export async function setWeekendSellAdjust(ctx: ServiceCtx, input: SetWeekendSellAdjustInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!input.cardTypeId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn loại thẻ.' };
  const deltaMilli = pctToMilli(input.deltaPct);
  if (deltaMilli === null) return { ok: false, error: 'VALIDATION', message: 'Mức giảm không hợp lệ (0–100, tối đa 3 số thập phân).' };
  const effRaw = input.effectiveFrom !== undefined ? parseDate(input.effectiveFrom) : new Date();
  if (!effRaw) return { ok: false, error: 'VALIDATION', message: 'Ngày hiệu lực không hợp lệ.' };
  const effectiveFrom = startOfDayLocal(effRaw);
  // MED-4 (phản biện 4/9): CẤM lùi ngày. Giảm-phí-cuối-tuần là quy tắc theo-thứ, KHÔNG kích hoạt recalc như setFeeRate
  // → nếu cho effectiveFrom quá khứ, các GD cuối tuần ĐÃ CHỐT giữ snapshot phí CŨ (cao hơn) = lệch doanh số câm.
  // Chỉ cho áp từ HÔM NAY trở đi (forward-only) → snapshot tương lai đúng, quá khứ không bị đụng.
  if (effectiveFrom.getTime() < startOfDayLocal(new Date()).getTime())
    return { ok: false, error: 'VALIDATION', message: 'Giảm phí bán cuối tuần chỉ áp từ HÔM NAY trở đi (không lùi ngày — tránh lệch doanh số đã chốt).' };
  const card = await db.cardType.findUnique({ where: { id: input.cardTypeId } });
  if (!card || card.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại thẻ không tồn tại.' };
  const dayEnd = new Date(effectiveFrom.getTime() + 86_400_000);
  const now = new Date();
  const id = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE weekend_sell_adjust SET deleted_at = $1, deleted_by = $2, updated_by = $2, updated_at = $1 ` +
        `WHERE card_type_id = $3 AND deleted_at IS NULL AND effective_from >= $4 AND effective_from < $5`,
      now,
      user.id,
      input.cardTypeId,
      effectiveFrom,
      dayEnd
    );
    const ins = await tx.$queryRawUnsafe<Array<{ id: bigint | number }>>(
      `INSERT INTO weekend_sell_adjust (card_type_id, delta_milli, effective_from, created_by, updated_by) ` +
        `VALUES ($1, $2, $3, $4, $4) RETURNING id`,
      input.cardTypeId,
      deltaMilli,
      effectiveFrom,
      user.id
    );
    return Number(ins[0].id);
  });
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'FEE_RATE_SET',
    targetType: 'WeekendSellAdjust',
    targetId: String(id),
    after: auditSnapshot({ cardTypeId: input.cardTypeId, deltaMilli, effectiveFrom: effectiveFrom.toISOString() })
  });
  return { ok: true, id };
}

export async function deleteWeekendSellAdjust(ctx: ServiceCtx, id: number): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!id) return { ok: false, error: 'VALIDATION', message: 'Thiếu mã cấu hình để xóa.' };
  const rows = await db.$queryRawUnsafe<Array<{ card_type_id: number }>>(
    `SELECT card_type_id FROM weekend_sell_adjust WHERE id = $1 AND deleted_at IS NULL`,
    id
  );
  if (rows.length === 0) return { ok: false, error: 'NOT_FOUND', message: 'Cấu hình không tồn tại.' };
  const now = new Date();
  await db.$executeRawUnsafe(
    `UPDATE weekend_sell_adjust SET deleted_at = $1, deleted_by = $2, updated_by = $2, updated_at = $1 WHERE id = $3`,
    now,
    user.id,
    id
  );
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'FEE_RATE_DELETED',
    targetType: 'WeekendSellAdjust',
    targetId: String(id),
    before: auditSnapshot({ cardTypeId: rows[0].card_type_id })
  });
  return { ok: true, id };
}

// ═════════════════════════════════════════════════════════════════════════════
// §2 — PHÍ QR theo ĐỐI TÁC (TẦNG 1 — giá cung cấp GỐC/mặc định).
// ═════════════════════════════════════════════════════════════════════════════
export interface QrPartnerFeeDto extends AuditTrail {
  id: number;
  partnerId: number;
  partnerCode: string | null;
  partnerName: string | null;
  phiMuaThuongPct: number;
  phiMuaCuoiTuanPct: number;
  phiBanPct: number;
  effectiveFrom: string; // ISO
}
export interface SetQrPartnerFeeInput {
  partnerId: number;
  phiMuaThuongPct: number;
  phiMuaCuoiTuanPct: number;
  phiBanPct: number;
  effectiveFrom?: string;
}

export async function listQrPartnerFee(
  ctx: ServiceCtx,
  partnerId?: number
): Promise<{ ok: boolean; data?: QrPartnerFeeDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = partnerId
    ? await db.$queryRawUnsafe<Array<RawAuditCols & QrRateCols & { partner_id: number }>>(
        `SELECT id, partner_id, phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, effective_from, created_by, created_at, updated_by, updated_at ` +
          `FROM qr_partner_fee WHERE deleted_at IS NULL AND partner_id = $1 ORDER BY partner_id ASC, effective_from DESC, id DESC LIMIT ${LIST_MAX}`,
        partnerId
      )
    : await db.$queryRawUnsafe<Array<RawAuditCols & QrRateCols & { partner_id: number }>>(
        `SELECT id, partner_id, phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, effective_from, created_by, created_at, updated_by, updated_at ` +
          `FROM qr_partner_fee WHERE deleted_at IS NULL ORDER BY partner_id ASC, effective_from DESC, id DESC LIMIT ${LIST_MAX}`
      );
  const partnerIds = [...new Set(rows.map((r) => r.partner_id))];
  const partners = new Map(
    (await db.partner.findMany({ where: { id: { in: partnerIds } }, select: { id: true, code: true, name: true } })).map((p) => [p.id, p])
  );
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.created_by, r.updated_by]));
  return {
    ok: true,
    data: rows.map((r) => ({
      id: Number(r.id),
      partnerId: r.partner_id,
      partnerCode: partners.get(r.partner_id)?.code ?? null,
      partnerName: partners.get(r.partner_id)?.name ?? null,
      phiMuaThuongPct: milliToPct(r.phi_mua_thuong),
      phiMuaCuoiTuanPct: milliToPct(r.phi_mua_cuoi_tuan),
      phiBanPct: milliToPct(r.phi_ban),
      effectiveFrom: toISO(r.effective_from),
      ...rawTrail(r, names)
    }))
  };
}

export async function setQrPartnerFee(ctx: ServiceCtx, input: SetQrPartnerFeeInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!input.partnerId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn đối tác.' };
  const fees = normalizeQrFees(input);
  if (!fees.ok) return fees.err;
  const effRaw = input.effectiveFrom !== undefined ? parseDate(input.effectiveFrom) : new Date();
  if (!effRaw) return { ok: false, error: 'VALIDATION', message: 'Ngày hiệu lực không hợp lệ.' };
  const effectiveFrom = startOfDayLocal(effRaw);
  const partner = await db.partner.findUnique({ where: { id: input.partnerId } });
  if (!partner || partner.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Đối tác không tồn tại.' };
  const dayEnd = new Date(effectiveFrom.getTime() + 86_400_000);
  const now = new Date();
  const id = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE qr_partner_fee SET deleted_at = $1, deleted_by = $2, updated_by = $2, updated_at = $1 ` +
        `WHERE partner_id = $3 AND deleted_at IS NULL AND effective_from >= $4 AND effective_from < $5`,
      now,
      user.id,
      input.partnerId,
      effectiveFrom,
      dayEnd
    );
    const ins = await tx.$queryRawUnsafe<Array<{ id: bigint | number }>>(
      `INSERT INTO qr_partner_fee (partner_id, phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, effective_from, created_by, updated_by) ` +
        `VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
      input.partnerId,
      fees.phiMuaThuong,
      fees.phiMuaCuoiTuan,
      fees.phiBan,
      effectiveFrom,
      user.id
    );
    return Number(ins[0].id);
  });
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'FEE_RATE_SET',
    targetType: 'QrPartnerFee',
    targetId: String(id),
    after: auditSnapshot({
      partnerId: input.partnerId,
      phiMuaThuong: fees.phiMuaThuong,
      phiMuaCuoiTuan: fees.phiMuaCuoiTuan,
      phiBan: fees.phiBan,
      effectiveFrom: effectiveFrom.toISOString()
    })
  });
  return { ok: true, id };
}

// ═════════════════════════════════════════════════════════════════════════════
// §3 — PHÍ QR theo TỪNG MÃ QR (TẦNG 2 — giá THỰC TẾ, đè giá đối tác). tid_id = dòng tids kind='QR'.
// ═════════════════════════════════════════════════════════════════════════════
export interface QrFeeRateDto extends AuditTrail {
  id: number;
  tidId: number;
  tidCode: string | null;
  phiMuaThuongPct: number;
  phiMuaCuoiTuanPct: number;
  phiBanPct: number;
  effectiveFrom: string; // ISO
}
export interface SetQrFeeRateInput {
  tidId: number;
  phiMuaThuongPct: number;
  phiMuaCuoiTuanPct: number;
  phiBanPct: number;
  effectiveFrom?: string;
}
interface QrRateCols {
  phi_mua_thuong: number;
  phi_mua_cuoi_tuan: number;
  phi_ban: number;
}

/** Validate + chuyển 3 % → milli. Trả lỗi VALIDATION rõ nếu bất kỳ % không hợp lệ. */
function normalizeQrFees(
  input: { phiMuaThuongPct: unknown; phiMuaCuoiTuanPct: unknown; phiBanPct: unknown }
): { ok: true; phiMuaThuong: number; phiMuaCuoiTuan: number; phiBan: number } | { ok: false; err: MutationResult } {
  const phiMuaThuong = pctToMilli(input.phiMuaThuongPct);
  const phiMuaCuoiTuan = pctToMilli(input.phiMuaCuoiTuanPct);
  const phiBan = pctToMilli(input.phiBanPct);
  if (phiMuaThuong === null) return { ok: false, err: { ok: false, error: 'VALIDATION', message: 'Phí mua ngày thường không hợp lệ (0–100, tối đa 3 số thập phân).' } };
  if (phiMuaCuoiTuan === null) return { ok: false, err: { ok: false, error: 'VALIDATION', message: 'Phí mua cuối tuần không hợp lệ (0–100, tối đa 3 số thập phân).' } };
  if (phiBan === null) return { ok: false, err: { ok: false, error: 'VALIDATION', message: 'Phí bán không hợp lệ (0–100, tối đa 3 số thập phân).' } };
  return { ok: true, phiMuaThuong, phiMuaCuoiTuan, phiBan };
}

export async function listQrFeeRate(
  ctx: ServiceCtx,
  tidId?: number
): Promise<{ ok: boolean; data?: QrFeeRateDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = tidId
    ? await db.$queryRawUnsafe<Array<RawAuditCols & QrRateCols & { tid_id: number }>>(
        `SELECT id, tid_id, phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, effective_from, created_by, created_at, updated_by, updated_at ` +
          `FROM qr_fee_rates WHERE deleted_at IS NULL AND tid_id = $1 ORDER BY tid_id ASC, effective_from DESC, id DESC LIMIT ${LIST_MAX}`,
        tidId
      )
    : await db.$queryRawUnsafe<Array<RawAuditCols & QrRateCols & { tid_id: number }>>(
        `SELECT id, tid_id, phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, effective_from, created_by, created_at, updated_by, updated_at ` +
          `FROM qr_fee_rates WHERE deleted_at IS NULL ORDER BY tid_id ASC, effective_from DESC, id DESC LIMIT ${LIST_MAX}`
      );
  const tidIds = [...new Set(rows.map((r) => r.tid_id))];
  const tids = new Map(
    (await db.tid.findMany({ where: { id: { in: tidIds } }, select: { id: true, tid: true } })).map((t) => [t.id, t.tid])
  );
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.created_by, r.updated_by]));
  return {
    ok: true,
    data: rows.map((r) => ({
      id: Number(r.id),
      tidId: r.tid_id,
      tidCode: tids.get(r.tid_id) ?? null,
      phiMuaThuongPct: milliToPct(r.phi_mua_thuong),
      phiMuaCuoiTuanPct: milliToPct(r.phi_mua_cuoi_tuan),
      phiBanPct: milliToPct(r.phi_ban),
      effectiveFrom: toISO(r.effective_from),
      ...rawTrail(r, names)
    }))
  };
}

export async function setQrFeeRate(ctx: ServiceCtx, input: SetQrFeeRateInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!input.tidId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn mã QR.' };
  const fees = normalizeQrFees(input);
  if (!fees.ok) return fees.err;
  const effRaw = input.effectiveFrom !== undefined ? parseDate(input.effectiveFrom) : new Date();
  if (!effRaw) return { ok: false, error: 'VALIDATION', message: 'Ngày hiệu lực không hợp lệ.' };
  const effectiveFrom = startOfDayLocal(effRaw);
  // TID phải tồn tại (chưa xóa) VÀ là mã QR (kind='QR'). kind là cột RAW (không có trong Prisma client) → SELECT raw.
  const tid = await db.tid.findUnique({ where: { id: input.tidId } });
  if (!tid || tid.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Mã QR không tồn tại.' };
  const kindRows = await db.$queryRawUnsafe<Array<{ kind: string }>>(`SELECT kind FROM tids WHERE id = $1`, input.tidId);
  const kind = kindRows[0]?.kind ?? 'POS';
  if (kind !== 'QR')
    return { ok: false, error: 'VALIDATION', message: 'TID này không phải mã QR (kind ≠ QR). Chỉ cấu hình giá QR cho mã QR.' };
  const dayEnd = new Date(effectiveFrom.getTime() + 86_400_000);
  const now = new Date();
  const id = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE qr_fee_rates SET deleted_at = $1, deleted_by = $2, updated_by = $2, updated_at = $1 ` +
        `WHERE tid_id = $3 AND deleted_at IS NULL AND effective_from >= $4 AND effective_from < $5`,
      now,
      user.id,
      input.tidId,
      effectiveFrom,
      dayEnd
    );
    const ins = await tx.$queryRawUnsafe<Array<{ id: bigint | number }>>(
      `INSERT INTO qr_fee_rates (tid_id, phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, effective_from, created_by, updated_by) ` +
        `VALUES ($1, $2, $3, $4, $5, $6, $6) RETURNING id`,
      input.tidId,
      fees.phiMuaThuong,
      fees.phiMuaCuoiTuan,
      fees.phiBan,
      effectiveFrom,
      user.id
    );
    return Number(ins[0].id);
  });
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'FEE_RATE_SET',
    targetType: 'QrFeeRate',
    targetId: String(id),
    after: auditSnapshot({
      tidId: input.tidId,
      phiMuaThuong: fees.phiMuaThuong,
      phiMuaCuoiTuan: fees.phiMuaCuoiTuan,
      phiBan: fees.phiBan,
      effectiveFrom: effectiveFrom.toISOString()
    })
  });
  return { ok: true, id };
}

// ═════════════════════════════════════════════════════════════════════════════
// §4 — RESOLVER — giá QR THỰC TẾ cho 1 mã tại NGÀY GD `at`. Giá theo MÃ (qr_fee_rates) ĐÈ giá ĐỐI TÁC
// (qr_partner_fee) — song song POS (TidSellFee đè FeeSellQuote). Áp resolveQrFee THUẦN (chọn kỳ + giá mua theo thứ).
// THUẦN đọc — chỉ cần $queryRawUnsafe. Caller (bot-api/transaction-service) fetch qua ĐÂY để 1 nơi cài công thức.
// ═════════════════════════════════════════════════════════════════════════════
export type ResolveQrFeeForTidResult =
  | { ok: true; phiMuaMilli: number; phiBanMilli: number; phiBanNhanhMilli: number | null; isWeekend: boolean; source: 'MERCHANT' | 'PARTNER' }
  | { ok: false; error: 'NO_QR_FEE'; message: string };

/** Map dòng RAW (snake_case) → QrFeeRateRow (camelCase) cho engine THUẦN resolveQrFee. */
function toQrRow(r: QrRateCols & { effective_from: Date | string }): QrFeeRateRow {
  return { phiMuaThuong: r.phi_mua_thuong, phiMuaCuoiTuan: r.phi_mua_cuoi_tuan, phiBan: r.phi_ban, effectiveFrom: r.effective_from };
}
/** [Admin Demo 11/9] Giá bán TIỀN NHANH (phi_ban_nhanh) của kỳ hiệu lực — NULL = mã không có lựa chọn nhanh. Lấy theo
 *  CÙNG kỳ mà resolveQrFee đã chọn (dòng đầu có effective_from ≤ at, cùng thứ tự sort). */
function phiBanNhanhCuaKy(rows: Array<{ phi_ban_nhanh?: number | null; effective_from: Date | string }>, at: Date): number | null {
  for (const r of rows) {
    if (new Date(r.effective_from).getTime() <= at.getTime()) {
      const v = r.phi_ban_nhanh;
      return typeof v === 'number' && v > 0 ? v : null;
    }
  }
  return null;
}

/** [Admin Demo 12/9] Delta KM kênh QR cho 1 mã tại `at`: dòng promo_sell_adjust kenh='QR' enabled, cửa sổ chứa at,
 *  scope (bank_id NULL = mọi bank, hoặc = bank của mã), lịch RANGE/WEEKEND/DATES (maxPromoDeltaTheoLich dùng chung
 *  với POS — cấm 2 công thức). Fail-safe 0 + log (không giết đường ghi doanh số QR). */
async function promoDeltaQr(db: Pick<Db, '$queryRawUnsafe'>, tidId: number, at: Date): Promise<number> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ delta_milli: number; lich: string; ngay_cu_the: string | null }>>(
      `SELECT p.delta_milli, p.lich, p.ngay_cu_the FROM promo_sell_adjust p
        WHERE p.kenh = 'QR' AND p.enabled AND p.deleted_at IS NULL
          AND p.from_date <= $2 AND p.to_date > $2
          AND (p.bank_id IS NULL OR p.bank_id = (SELECT bank_id FROM tids WHERE id = $1))`,
      tidId, at);
    return maxPromoDeltaTheoLich(rows, at);
  } catch (e) {
    console.error('[promo-qr] KHÔNG đọc được KM QR (dùng giá thường) — kiểm promo_sell_adjust:', e instanceof Error ? e.message : e);
    return 0;
  }
}

export async function resolveQrFeeForTid(
  db: Pick<Db, '$queryRawUnsafe'>,
  params: { tidId: number; partnerId: number | null },
  at: Date
): Promise<ResolveQrFeeForTidResult> {
  // TẦNG 2 — giá THỰC TẾ theo MÃ, ĐÈ giá đối tác NẾU có kỳ hiệu lực tại `at`. Nếu mã CHƯA có kỳ nào hiệu lực tại
  // `at` (chưa cấu hình, hoặc kỳ mới bắt đầu SAU ngày GD) → RƠI VỀ giá ĐỐI TÁC — song song POS (resolveActualSellFee:
  // override chưa hiệu lực → niêm yết). GD trước ngày mã có giá riêng dùng đúng giá đối tác đang áp lúc đó, KHÔNG chặn oan.
  const merchantRows = await db.$queryRawUnsafe<Array<QrRateCols & { effective_from: Date | string; phi_ban_nhanh: number | null }>>(
    `SELECT phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, phi_ban_nhanh, to_char(effective_from AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00' AS effective_from FROM qr_fee_rates ` +
      `WHERE tid_id = $1 AND deleted_at IS NULL ORDER BY effective_from DESC, id DESC`,
    params.tidId
  );
  // [Admin Demo 12/9 KM] Delta khuyến mại kênh QR (enabled, cửa sổ + lịch, scope bank của mã hoặc mọi bank) — trừ
  // vào GIÁ BÁN (cả bậc chờ lẫn nhanh), floor 0. Fail-safe 0 (không giết đường tiền — khuôn HIGH-3).
  const kmQr = await promoDeltaQr(db, params.tidId, at);
  const apKm = (r: { phiMuaMilli: number; phiBanMilli: number; isWeekend: boolean }, nhanh: number | null, source: 'MERCHANT' | 'PARTNER'): ResolveQrFeeForTidResult => ({
    ok: true, phiMuaMilli: r.phiMuaMilli, phiBanMilli: Math.max(0, r.phiBanMilli - kmQr),
    phiBanNhanhMilli: nhanh == null ? null : Math.max(0, nhanh - kmQr), isWeekend: r.isWeekend, source
  });
  const m = resolveQrFee(merchantRows.map(toQrRow), at);
  if (m.ok) return apKm(m, phiBanNhanhCuaKy(merchantRows, at), 'MERCHANT');
  // TẦNG 1 — giá ĐỐI TÁC (mặc định).
  if (params.partnerId != null) {
    const partnerRows = await db.$queryRawUnsafe<Array<QrRateCols & { effective_from: Date | string; phi_ban_nhanh: number | null }>>(
      `SELECT phi_mua_thuong, phi_mua_cuoi_tuan, phi_ban, phi_ban_nhanh, to_char(effective_from AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00' AS effective_from FROM qr_partner_fee ` +
        `WHERE partner_id = $1 AND deleted_at IS NULL ORDER BY effective_from DESC, id DESC`,
      params.partnerId
    );
    const p = resolveQrFee(partnerRows.map(toQrRow), at);
    if (p.ok) return apKm(p, phiBanNhanhCuaKy(partnerRows, at), 'PARTNER');
  }
  return { ok: false, error: 'NO_QR_FEE', message: NO_QR_FEE_MSG };
}

// ═════════════════════════════════════════════════════════════════════════════
// §5 — GIÁ BÁN QR THEO ĐẠI LÝ (Admin Demo 5/9 "phí bán tùy khách") — lớp ĐÈ per-đại-lý trên giá bán MẶC ĐỊNH của mã/đối
// tác (qr_fee_rates/qr_partner_fee.phi_ban). Khóa theo customer_id (đại lý=khách=1). Chưa set → caller rơi về giá mặc
// định mã (resolveQrFeeForTid.phiBanMilli — hiện 1.05% cho tất cả). KHÔNG đổi cuối tuần. Song song POS TidSellFee đè FeeSellQuote.
// ═════════════════════════════════════════════════════════════════════════════
export interface QrDealerSellFeeDto extends AuditTrail {
  id: number;
  customerId: number;
  customerName: string | null;
  phiBanPct: number; // % (không phải milli)
  effectiveFrom: string; // ISO
}
export interface SetQrDealerSellFeeInput {
  customerId: number;
  phiBanPct: number;
  effectiveFrom?: string;
}

/** GIÁ BÁN QR ĐÈ của 1 đại lý (customer) tại NGÀY `at` — milli (×1000), hoặc null nếu CHƯA cấu hình (caller fallback
 *  giá bán mặc định mã). Pick kỳ hiệu lực effectiveFrom ≤ at MỚI NHẤT (rows đã ORDER effective_from DESC, id DESC). */
export async function resolveQrDealerSellFee(db: Pick<Db, '$queryRawUnsafe'>, customerId: number, at: Date): Promise<number | null> {
  if (!Number.isInteger(customerId)) return null;
  // [deep-audit C1] FAIL-SAFE bất đối xứng (như resolveWeekendSellDeltaMilli/HIGH-3): bảng qr_dealer_sell_fee thiếu
  // (boot-race / deploy dở) → KHÔNG được để NÉM (sẽ làm reviewQr ném → /send-qr 500 → CHẶN TOÀN BỘ ghi doanh số QR).
  // Lỗi → trả null (caller rơi về GIÁ BÁN MẶC ĐỊNH của mã) + log RÕ (R198, không nuốt câm).
  try {
    const rows = await db.$queryRawUnsafe<Array<{ phi_ban: number; effective_from: Date | string }>>(
      `SELECT phi_ban, to_char(effective_from AT TIME ZONE 'Asia/Ho_Chi_Minh', 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '+07:00' AS effective_from FROM qr_dealer_sell_fee WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY effective_from DESC, id DESC`,
      customerId
    );
    const atMs = at.getTime();
    for (const r of rows) if (new Date(r.effective_from).getTime() <= atMs) return r.phi_ban;
    return null;
  } catch (e) {
    console.error(`[resolveQrDealerSellFee] KHÔNG đọc được qr_dealer_sell_fee (customer=${customerId}) → dùng giá bán mặc định mã:`, e);
    return null;
  }
}

export async function listQrDealerSellFee(
  ctx: ServiceCtx,
  customerId?: number
): Promise<{ ok: boolean; data?: QrDealerSellFeeDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = customerId
    ? await db.$queryRawUnsafe<Array<RawAuditCols & { customer_id: number; phi_ban: number }>>(
        `SELECT id, customer_id, phi_ban, effective_from, created_by, created_at, updated_by, updated_at ` +
          `FROM qr_dealer_sell_fee WHERE deleted_at IS NULL AND customer_id = $1 ORDER BY customer_id ASC, effective_from DESC, id DESC LIMIT ${LIST_MAX}`,
        customerId
      )
    : await db.$queryRawUnsafe<Array<RawAuditCols & { customer_id: number; phi_ban: number }>>(
        `SELECT id, customer_id, phi_ban, effective_from, created_by, created_at, updated_by, updated_at ` +
          `FROM qr_dealer_sell_fee WHERE deleted_at IS NULL ORDER BY customer_id ASC, effective_from DESC, id DESC LIMIT ${LIST_MAX}`
      );
  const custIds = [...new Set(rows.map((r) => r.customer_id))];
  const custs = new Map(
    (await db.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, fullName: true, nickname: true } })).map((c) => [c.id, c.nickname || c.fullName])
  );
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.created_by, r.updated_by]));
  return {
    ok: true,
    data: rows.map((r) => ({
      id: Number(r.id),
      customerId: r.customer_id,
      customerName: custs.get(r.customer_id) ?? null,
      phiBanPct: milliToPct(r.phi_ban),
      effectiveFrom: toISO(r.effective_from),
      ...rawTrail(r, names)
    }))
  };
}

/** Set 1 KỲ giá bán QR cho 1 đại lý (customer). Same-day (cùng customer) → soft-delete kỳ cũ + insert mới (nguyên tử). */
export async function setQrDealerSellFee(ctx: ServiceCtx, input: SetQrDealerSellFeeInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!Number.isInteger(input.customerId)) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn đại lý (khách).' };
  const phiBan = pctToMilli(input.phiBanPct);
  if (phiBan === null) return { ok: false, error: 'VALIDATION', message: 'Phí bán không hợp lệ (0–100, tối đa 3 số thập phân).' };
  const effRaw = input.effectiveFrom !== undefined ? parseDate(input.effectiveFrom) : new Date();
  if (!effRaw) return { ok: false, error: 'VALIDATION', message: 'Ngày hiệu lực không hợp lệ.' };
  const effectiveFrom = startOfDayLocal(effRaw);
  const cust = await db.customer.findUnique({ where: { id: input.customerId } });
  if (!cust || cust.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Đại lý (khách) không tồn tại.' };
  const dayEnd = new Date(effectiveFrom.getTime() + 86_400_000);
  const now = new Date();
  const id = await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `UPDATE qr_dealer_sell_fee SET deleted_at = $1, deleted_by = $2, updated_by = $2, updated_at = $1 ` +
        `WHERE customer_id = $3 AND deleted_at IS NULL AND effective_from >= $4 AND effective_from < $5`,
      now,
      user.id,
      input.customerId,
      effectiveFrom,
      dayEnd
    );
    const ins = await tx.$queryRawUnsafe<Array<{ id: bigint | number }>>(
      `INSERT INTO qr_dealer_sell_fee (customer_id, phi_ban, effective_from, created_by, updated_by) ` +
        `VALUES ($1, $2, $3, $4, $4) RETURNING id`,
      input.customerId,
      phiBan,
      effectiveFrom,
      user.id
    );
    // [Admin Demo 25/9] VÁ LỆCH −7h của Prisma driver-adapter — CÙNG lớp bug đã vá ở tid_sell_fees (suaEffRaw 24/9).
    // Ca thật: đặt giá 0,95% cho Lâm QN ngày 25/9, startOfDayLocal ra 25/9 00:00 nhưng DB lưu 24/9 17:00 (sớm 7 giờ)
    // ⇒ giá ăn sang chiều hôm TRƯỚC. Ghi đè lại bằng ::timestamptz tường minh thì đúng mốc.
    await tx.$executeRawUnsafe(
      `UPDATE qr_dealer_sell_fee SET effective_from = $1::timestamptz WHERE id = $2`,
      effectiveFrom.toISOString(), Number(ins[0].id));
    return Number(ins[0].id);
  });
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'FEE_RATE_SET',
    targetType: 'QrDealerSellFee',
    targetId: String(id),
    after: auditSnapshot({ customerId: input.customerId, phiBan, effectiveFrom: effectiveFrom.toISOString() })
  });
  return { ok: true, id };
}

export async function deleteQrDealerSellFee(ctx: ServiceCtx, id: number): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!id) return { ok: false, error: 'VALIDATION', message: 'Thiếu mã cấu hình để xóa.' };
  const rows = await db.$queryRawUnsafe<Array<{ customer_id: number }>>(
    `SELECT customer_id FROM qr_dealer_sell_fee WHERE id = $1 AND deleted_at IS NULL`,
    id
  );
  if (rows.length === 0) return { ok: false, error: 'NOT_FOUND', message: 'Cấu hình không tồn tại.' };
  const now = new Date();
  await db.$executeRawUnsafe(
    `UPDATE qr_dealer_sell_fee SET deleted_at = $1, deleted_by = $2, updated_by = $2, updated_at = $1 WHERE id = $3`,
    now,
    user.id,
    id
  );
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'FEE_RATE_DELETED',
    targetType: 'QrDealerSellFee',
    targetId: String(id),
    before: auditSnapshot({ customerId: rows[0].customer_id })
  });
  return { ok: true, id };
}


// ═════════════════════════════════════════════════════════════════════════════
// §KM — CHƯƠNG TRÌNH KHUYẾN MẠI GIẢM GIÁ BÁN (Admin Demo 12/9) — kênh POS (theo loại thẻ) / QR (theo bank hoặc mọi
// bank), cửa sổ từ-đến, lịch RANGE (mọi ngày) / WEEKEND (T7+CN) / DATES (ngày cụ thể), bật/tắt. CHỈ NGƯỜI SIGMA
// (quyền FEE của SigMa — không lộ sang app đại lý). LƯU Ý: set/tắt hồi tố KHÔNG tự recalc GD đã chốt —
// chạy recalc + retro lo_rows riêng (khuôn _recalc-km-t9 / _retro-lorows-km-t9) khi Admin Demo duyệt hồi tố.
// ═════════════════════════════════════════════════════════════════════════════
export interface PromoProgramDto extends AuditTrail {
  id: number;
  kenh: 'POS' | 'QR';
  cardTypeId: number | null;
  cardTypeName: string | null;
  bankId: number | null;
  bankName: string | null;
  deltaPct: number;
  fromDate: string; // ISO
  toDate: string; // ISO (loại trừ — 00:00 HCM ngày sau "đến ngày")
  lich: 'RANGE' | 'WEEKEND' | 'DATES';
  ngayCuThe: string[] | null;
  enabled: boolean;
  note: string | null;
}
export interface SetPromoProgramInput {
  id?: number; // có id = SỬA (kể cả bật/tắt); không id = TẠO MỚI
  kenh: 'POS' | 'QR';
  cardTypeId?: number | null;
  bankId?: number | null;
  deltaPct: number;
  fromDate: string; // ISO/YYYY-MM-DD (nửa đêm HCM)
  toDate: string; // ISO/YYYY-MM-DD — hiểu là HẾT ngày này (lưu to_date = 00:00 hôm sau HCM)
  lich?: 'RANGE' | 'WEEKEND' | 'DATES';
  ngayCuThe?: string[];
  enabled?: boolean;
  note?: string | null;
}

export async function listPromoPrograms(
  ctx: ServiceCtx
): Promise<{ ok: boolean; data?: PromoProgramDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.$queryRawUnsafe<Array<RawAuditCols & {
    kenh: string; card_type_id: number | null; bank_id: number | null; delta_milli: number;
    from_date: Date | string; to_date: Date | string; lich: string; ngay_cu_the: string | null; enabled: boolean; note: string | null;
  }>>(
    `SELECT id, kenh, card_type_id, bank_id, delta_milli, from_date, to_date, lich, ngay_cu_the, enabled, note,
            created_by, created_at, updated_by, updated_at
       FROM promo_sell_adjust WHERE deleted_at IS NULL ORDER BY from_date DESC, id DESC LIMIT ${LIST_MAX}`
  );
  const cardIds = [...new Set(rows.map((r) => r.card_type_id).filter((x): x is number => x != null))];
  const bankIds = [...new Set(rows.map((r) => r.bank_id).filter((x): x is number => x != null))];
  const cards = new Map((await db.cardType.findMany({ where: { id: { in: cardIds } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]));
  const banks = new Map((await db.bank.findMany({ where: { id: { in: bankIds } }, select: { id: true, code: true, name: true } })).map((b) => [b.id, nhanBank(b)]));
  const names = await resolveUserNames(db, rows.flatMap((r) => [r.created_by, r.updated_by]));
  return {
    ok: true,
    data: rows.map((r) => ({
      id: Number(r.id),
      kenh: r.kenh === 'QR' ? 'QR' as const : 'POS' as const,
      cardTypeId: r.card_type_id,
      cardTypeName: r.card_type_id != null ? (cards.get(r.card_type_id) ?? null) : null,
      bankId: r.bank_id,
      bankName: r.bank_id != null ? (banks.get(r.bank_id) ?? null) : null,
      deltaPct: milliToPct(r.delta_milli),
      fromDate: toISO(r.from_date),
      toDate: toISO(r.to_date),
      lich: r.lich === 'WEEKEND' || r.lich === 'DATES' ? r.lich as 'WEEKEND' | 'DATES' : 'RANGE' as const,
      ngayCuThe: (() => { try { const v = JSON.parse(r.ngay_cu_the ?? 'null') as unknown; return Array.isArray(v) ? (v as string[]) : null; } catch { return null; } })(),
      enabled: !!r.enabled,
      note: r.note ?? null,
      ...rawTrail(r, names)
    }))
  };
}

export async function setPromoProgram(ctx: ServiceCtx, input: SetPromoProgramInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const kenh = input.kenh === 'QR' ? 'QR' : 'POS';
  // [Admin Demo 12/9] POS chọn NGÂN HÀNG (áp mọi loại thẻ của bank) HOẶC loại thẻ cụ thể — cần ít nhất 1.
  if (kenh === 'POS' && !input.cardTypeId && input.bankId == null) return { ok: false, error: 'VALIDATION', message: 'KM kênh POS phải chọn NGÂN HÀNG (áp mọi loại thẻ) hoặc 1 loại thẻ cụ thể.' };
  const deltaMilli = pctToMilli(input.deltaPct);
  if (deltaMilli === null || deltaMilli <= 0) return { ok: false, error: 'VALIDATION', message: 'Mức giảm không hợp lệ (>0, tối đa 3 số thập phân).' };
  const fromRaw = parseDate(input.fromDate);
  const toRaw = parseDate(input.toDate);
  if (!fromRaw || !toRaw) return { ok: false, error: 'VALIDATION', message: 'Từ ngày / đến ngày không hợp lệ.' };
  const fromDate = startOfDayLocal(fromRaw);
  const toDate = new Date(startOfDayLocal(toRaw).getTime() + 86_400_000); // HẾT ngày `toDate` (nửa-mở)
  if (toDate.getTime() <= fromDate.getTime()) return { ok: false, error: 'VALIDATION', message: '"Đến ngày" phải ≥ "từ ngày".' };
  const lich = input.lich === 'WEEKEND' || input.lich === 'DATES' ? input.lich : 'RANGE';
  let ngayJson: string | null = null;
  if (lich === 'DATES') {
    const ds = (input.ngayCuThe ?? []).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    if (ds.length === 0) return { ok: false, error: 'VALIDATION', message: 'Lịch "ngày cụ thể" phải liệt kê ≥1 ngày (YYYY-MM-DD).' };
    ngayJson = JSON.stringify([...new Set(ds)].sort());
  }
  const enabled = input.enabled !== false;
  if (kenh === 'POS' && input.cardTypeId) {
    const card = await db.cardType.findUnique({ where: { id: input.cardTypeId } });
    if (!card || card.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại thẻ không tồn tại.' };
  }
  if (input.bankId != null) {
    const bank = await db.bank.findUnique({ where: { id: input.bankId } });
    if (!bank) return { ok: false, error: 'NOT_FOUND', message: 'Ngân hàng không tồn tại.' };
  }
  let id: number;
  if (input.id != null) {
    const cur = await db.$queryRawUnsafe<Array<{ id: number }>>(`SELECT id FROM promo_sell_adjust WHERE id = $1 AND deleted_at IS NULL`, input.id);
    if (cur.length === 0) return { ok: false, error: 'NOT_FOUND', message: 'Chương trình KM không tồn tại.' };
    await db.$executeRawUnsafe(
      `UPDATE promo_sell_adjust SET kenh=$1, card_type_id=$2, bank_id=$3, delta_milli=$4, from_date=$5, to_date=$6,
              lich=$7, ngay_cu_the=$8, enabled=$9, note=$10, updated_by=$11, updated_at=now() WHERE id=$12`,
      kenh, kenh === 'POS' ? input.cardTypeId : null, input.bankId ?? null, deltaMilli, fromDate, toDate,
      lich, ngayJson, enabled, input.note ?? null, user.id, input.id);
    id = input.id;
  } else {
    const ins = await db.$queryRawUnsafe<Array<{ id: bigint | number }>>(
      `INSERT INTO promo_sell_adjust (kenh, card_type_id, bank_id, delta_milli, from_date, to_date, lich, ngay_cu_the, enabled, note, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11) RETURNING id`,
      kenh, kenh === 'POS' ? (input.cardTypeId ?? null) : null, input.bankId ?? null, deltaMilli, fromDate, toDate,
      lich, ngayJson, enabled, input.note ?? null, user.id);
    id = Number(ins[0].id);
  }
  await writeAudit(db, {
    actorUserId: user.id, action: 'FEE_RATE_SET', targetType: 'PromoProgram', targetId: String(id),
    after: auditSnapshot({ kenh, cardTypeId: input.cardTypeId ?? null, bankId: input.bankId ?? null, deltaMilli, fromDate: fromDate.toISOString(), toDate: toDate.toISOString(), lich, ngayJson, enabled })
  });
  return { ok: true, id };
}

export async function deletePromoProgram(ctx: ServiceCtx, id: number): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!id) return { ok: false, error: 'VALIDATION', message: 'Thiếu mã chương trình để xóa.' };
  const rows = await db.$queryRawUnsafe<Array<{ id: number }>>(`SELECT id FROM promo_sell_adjust WHERE id = $1 AND deleted_at IS NULL`, id);
  if (rows.length === 0) return { ok: false, error: 'NOT_FOUND', message: 'Chương trình KM không tồn tại.' };
  const now = new Date();
  await db.$executeRawUnsafe(`UPDATE promo_sell_adjust SET deleted_at=$1, deleted_by=$2, updated_by=$2, updated_at=$1 WHERE id=$3`, now, user.id, id);
  await writeAudit(db, { actorUserId: user.id, action: 'FEE_RATE_DELETED', targetType: 'PromoProgram', targetId: String(id) });
  return { ok: true, id };
}
