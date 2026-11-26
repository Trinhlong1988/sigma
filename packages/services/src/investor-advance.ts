// NHÀ ĐẦU TƯ — SỔ TẠM ỨNG VỐN + TK CK "đi tiền tạm ứng" (Phase C-2a, Admin Demo 10/8). LÕI THUẦN ctx-based (như
// investor.ts). NĐT ứng tiền cho SigMa nhiều lần/ngày; mỗi lần = 1 dòng InvestorAdvance. Σ theo kỳ dùng cho C-2b
// (tất toán) sau. TK CK NĐT (InvestorBankAccount) = cấu hình STK để SAU OCR khớp bill (matching là phase sau).
//
// TIỀN = BigInt (int8) như Transaction.amount — cộng/lưu bằng BigInt (KHÔNG mất chữ số). Chỉ Number() ở BIÊN DTO
// (VND < 2^53 an toàn precision; parse chặn > MAX_SAFE để round-trip không mất số — khớp parseAmount transaction.ts).
// Permission: INVESTOR_VIEW (đọc) / INVESTOR_UPDATE (ghi). Audit INVESTOR_ADVANCE_CREATED/DELETED. Soft-delete.
// §14 XÁC THỰC MẬT KHẨU khi XÓA do ADAPTER (route) kiểm TRƯỚC khi gọi lõi (khuôn deleteInvestor — lõi KHÔNG kiểm).
import { auditSnapshot } from '@sigma/business-rules';
import { hasPermission, hasAnyPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { type ServiceCtx, type MutationResult } from './customer.js';
import { loadInvestorCutoffs, isBeforeCutoff } from './investor-clear.js';

const VIEW = 'INVESTOR_VIEW';
const UPDATE = 'INVESTOR_UPDATE';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';
const MAX_MONEY = BigInt(Number.MAX_SAFE_INTEGER); // chặn round-trip mất số ở BIÊN DTO (Number(amount)).

export interface InvestorAdvanceDto {
  id: number;
  investorId: number;
  investorName: string; // nickname || fullName
  amount: number; // VND (BIÊN DTO — lưu/cộng bằng BigInt bên trong)
  advanceDate: string; // ISO (kèm ngày + giờ — client tách cột Ngày | Giờ HH:mm)
  source: string; // MANUAL | OCR
  // Chi tiết CK (Admin Demo 11/8): người ứng + người nhận (STK/tên/NH). Nguồn OCR bill hoặc nhập tay. Đều nullable.
  senderAccountNumber: string | null;
  senderName: string | null;
  senderBank: string | null;
  receiverAccountNumber: string | null;
  receiverName: string | null;
  receiverBank: string | null;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
}
export interface InvestorBankAccountDto {
  id: number;
  investorId: number;
  bankName: string | null;
  accountNumber: string;
  accountHolder: string | null;
  note: string | null;
  createdAt: string;
}

export interface ListAdvancesInput { investorId: number; from?: string; to?: string }
export interface CreateAdvanceInput {
  investorId: number; amount: unknown; advanceDate: string; note?: string | null;
  // Chi tiết CK (nguồn OCR bill hoặc nhập tay) — đều tùy chọn; trim → null nếu rỗng.
  senderAccountNumber?: string | null; senderName?: string | null; senderBank?: string | null;
  receiverAccountNumber?: string | null; receiverName?: string | null; receiverBank?: string | null;
}
export interface SumAdvancesInput { investorId: number; from?: string; to?: string }

// ── Helpers thời gian (CÙNG quy ước với investor-report.ts/dashboard.ts) ─────────────────────────────────────
/** Parse 'YYYY-MM-DD' → nửa đêm LOCAL. null nếu sai (chống JS cuộn âm thầm vd 2026-02-31). Dùng cho bound kỳ. */
function parseLocalDay(s: string | undefined): Date | null {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() + 1 !== mo || dt.getDate() !== d) return null;
  return dt;
}
function nextLocalDay(day: Date): Date { return new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1); }
/** ISO string / 'YYYY-MM-DD' → Date hợp lệ (ngày CÓ THẬT), else null. Khuôn parseDate transaction.ts (ngày ứng). */
function parseAdvanceDate(v: unknown): Date | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(s);
  if (m) {
    const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
    const isUtc = s.length === 10 || /[zZ]$/.test(s) || !/T/.test(s);
    if (isUtc && (d.getUTCFullYear() !== y || d.getUTCMonth() + 1 !== mo || d.getUTCDate() !== da)) return null;
  }
  return d;
}
/** Tiền ứng VND → BigInt dương. Chấp number|string|bigint; số NGUYÊN > 0, ≤ MAX_SAFE. null nếu sai. */
function parseMoneyBigInt(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v > 0n && v <= MAX_MONEY ? v : null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v) || v <= 0 || v > Number.MAX_SAFE_INTEGER) return null;
    return BigInt(v);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (!/^\d+$/.test(s)) return null; // chỉ số nguyên dương thuần (client gửi digits, không dấu phân cách)
    let n: bigint;
    try { n = BigInt(s); } catch { return null; }
    return n > 0n && n <= MAX_MONEY ? n : null;
  }
  return null;
}
/** Chuỗi chi tiết CK → trim; rỗng/không-phải-string → null (khuôn note). Dùng cho 6 field người ứng/người nhận. */
function cleanStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}
async function resolveUserNames(db: Db, ids: (number | null)[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids.filter((x): x is number => typeof x === 'number'))];
  const map = new Map<number, string>();
  if (uniq.length === 0) return map;
  const users = await db.user.findMany({ where: { id: { in: uniq } }, select: { id: true, fullName: true, username: true } });
  for (const u of users) map.set(u.id, u.fullName || u.username);
  return map;
}

// ── SỔ TẠM ỨNG ───────────────────────────────────────────────────────────────────────────────────────────────
/** INVESTOR_VIEW — danh sách tạm ứng của 1 NĐT (ẩn soft-deleted). Kỳ [from,to] tùy chọn (local half-open như report).
 *  Join tên NĐT + người tạo bằng ĐÚNG 3 query (investor, users, advances) — KHÔNG N+1. */
export async function listAdvances(ctx: ServiceCtx, input: ListAdvancesInput): Promise<{ ok: boolean; error?: string; message?: string; data?: InvestorAdvanceDto[] }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  // CRITICAL FIX (Agent-6 1/9): lọc kỳ bằng raw ::timestamptz (chống lệch TZ 7h) → lấy id → findMany full-field cho DTO.
  const q = await queryAdvancesInWindow(db, [input.investorId], undefined, input.from, input.to);
  if (!q.ok) return { ok: false, error: 'VALIDATION', message: q.message };
  const winIds = q.rows.map((r) => r.id);
  const rows = winIds.length ? await db.investorAdvance.findMany({ where: { id: { in: winIds } }, orderBy: [{ advanceDate: 'desc' }, { id: 'desc' }] }) : [];
  // [TZ 11/9 — Agent 4] NGÀY HIỂN THỊ phải khớp NGÀY ATTRIBUTION (queryAdvancesInWindow lọc theo instant LƯU THẬT).
  // ORM đọc advanceDate qua driver-adapter lệch +7h so instant lưu → hàng có giờ tối (≥17:00 stored) hiển thị NGÀY
  // HÔM SAU trong khi tổng kỳ đếm ngày cũ (đã thấy prod: tạm ứng 25/8 23:59 hiện 26/8). Đọc ISO chuẩn qua to_char
  // UTC text (khuôn room-revenue-time-tz 8/9) — 1 query gộp, KHÔNG N+1.
  const isoById = new Map<number, string>();
  if (winIds.length) {
    const isoRows = await db.$queryRawUnsafe<{ id: number; iso: string }[]>(
      `SELECT id, to_char(advance_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS iso FROM investor_advances WHERE id = ANY($1)`, winIds);
    for (const r of isoRows) isoById.set(Number(r.id), r.iso);
  }
  const inv = await db.investor.findUnique({ where: { id: input.investorId }, select: { nickname: true, fullName: true } });
  const investorName = inv ? (inv.nickname || inv.fullName) : '';
  const names = await resolveUserNames(db, rows.map((r) => r.createdBy));
  const data: InvestorAdvanceDto[] = rows.map((r) => ({
    id: r.id,
    investorId: r.investorId,
    investorName,
    amount: Number(r.amount as unknown as bigint),
    advanceDate: isoById.get(r.id) ?? r.advanceDate.toISOString(), // ISO instant LƯU THẬT (to_char) — client tách Ngày | Giờ
    source: r.source,
    senderAccountNumber: r.senderAccountNumber ?? null,
    senderName: r.senderName ?? null,
    senderBank: r.senderBank ?? null,
    receiverAccountNumber: r.receiverAccountNumber ?? null,
    receiverName: r.receiverName ?? null,
    receiverBank: r.receiverBank ?? null,
    note: r.note,
    createdByName: r.createdBy != null ? names.get(r.createdBy) ?? null : null,
    createdAt: r.createdAt.toISOString()
  }));
  return { ok: true, data };
}

/** INVESTOR_UPDATE — thêm 1 dòng tạm ứng (source=MANUAL). Validate NĐT tồn tại (chưa xóa) + amount>0 + ngày hợp lệ. */
export async function createAdvance(ctx: ServiceCtx, input: CreateAdvanceInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, UPDATE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const amount = parseMoneyBigInt(input.amount);
  if (amount === null) return { ok: false, error: 'VALIDATION', message: 'Số tiền tạm ứng không hợp lệ (số nguyên dương).' };
  const advanceDate = parseAdvanceDate(input.advanceDate);
  if (!advanceDate) return { ok: false, error: 'VALIDATION', message: 'Ngày tạm ứng không hợp lệ.' };
  const investor = await db.investor.findUnique({ where: { id: input.investorId }, select: { id: true, deletedAt: true } });
  if (!investor || investor.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Nhà đầu tư không tồn tại.' };
  // ATOMIC (audit 20/8) — tạo tạm ứng + audit trong CÙNG $transaction (writeAudit(tx)) — không commit thiếu dấu vết.
  const created = await db.$transaction(async (tx) => {
    const c = await tx.investorAdvance.create({
      data: {
        investorId: input.investorId, amount, advanceDate, source: 'MANUAL',
        senderAccountNumber: cleanStr(input.senderAccountNumber),
        senderName: cleanStr(input.senderName),
        senderBank: cleanStr(input.senderBank),
        receiverAccountNumber: cleanStr(input.receiverAccountNumber),
        receiverName: cleanStr(input.receiverName),
        receiverBank: cleanStr(input.receiverBank),
        note: input.note?.toString().trim() || null, createdBy: user.id
      }
    });
    // [B-M1 21/9 — GÓI TZ] Prisma driver-adapter GHI timestamptz LỆCH −7h (incident prod đã lập bản đồ 11/9):
    // dòng MANUAL có GIỜ vừa create ở trên đang lưu instant sai. Ghi đè NGAY bằng raw ::timestamptz với ISO thật
    // (cùng khuôn ingest OCR) — cùng transaction, không có cửa sổ đọc số lệch.
    await tx.$executeRawUnsafe(
      `UPDATE investor_advances SET advance_date = $1::timestamptz WHERE id = $2`,
      advanceDate.toISOString(), c.id);
    await writeAudit(tx, {
      actorUserId: user.id,
      action: 'INVESTOR_ADVANCE_CREATED',
      targetType: 'InvestorAdvance',
      targetId: String(c.id),
      after: auditSnapshot({ investorId: input.investorId, amount: amount.toString(), advanceDate: advanceDate.toISOString(), source: 'MANUAL' })
    });
    return c;
  });
  return { ok: true, id: created.id };
}

/** INVESTOR_UPDATE — xóa mềm 1 dòng tạm ứng. §14 mật khẩu do ROUTE kiểm TRƯỚC khi gọi (khuôn deleteInvestor). */
export async function deleteAdvance(ctx: ServiceCtx, id: number): Promise<MutationResult> {
  if (!hasPermission(ctx.user, UPDATE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.investorAdvance.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Dòng tạm ứng không tồn tại.' };
  // ATOMIC (audit 20/8) — xóa mềm + audit trong CÙNG $transaction (writeAudit(tx)) — không commit thiếu dấu vết.
  await db.$transaction(async (tx) => {
    await tx.investorAdvance.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: user.id } });
    await writeAudit(tx, {
      actorUserId: user.id,
      action: 'INVESTOR_ADVANCE_DELETED',
      targetType: 'InvestorAdvance',
      targetId: String(id),
      before: auditSnapshot({ investorId: row.investorId, amount: (row.amount as unknown as bigint).toString(), advanceDate: row.advanceDate.toISOString() })
    });
  });
  return { ok: true, id };
}

/** LẤY dòng tạm ứng/hoàn của NĐT trong cửa sổ [from, to) bằng raw `::timestamptz` — chống lệch TZ 7h của adapter-pg
 *  (CRITICAL Agent-6 1/9, mirror bản vá transactions). `sourceCond`: {not:'REPAYMENT'} | 'REPAYMENT' | undefined.
 *  from/to = 'YYYY-MM-DD' (local HCM); nửa-mở [from, to+1). Trả rows chuẩn hoá {investorId, amount:bigint, advanceDate}. */
async function queryAdvancesInWindow(
  db: Db, ids: number[], sourceCond: { not: 'REPAYMENT' } | 'REPAYMENT' | undefined, from?: string, to?: string
): Promise<{ ok: true; rows: { id: number; investorId: number; amount: bigint; advanceDate: Date }[] } | { ok: false; message: string }> {
  const conds: string[] = ['investor_id = ANY($1::int[])', 'deleted_at IS NULL'];
  const params: unknown[] = [ids];
  if (sourceCond === 'REPAYMENT') conds.push(`source = 'REPAYMENT'`);
  else if (sourceCond && 'not' in sourceCond) conds.push(`source <> 'REPAYMENT'`);
  if (from !== undefined) {
    const f = parseLocalDay(from); if (!f) return { ok: false, message: 'Ngày "từ" không hợp lệ (YYYY-MM-DD).' };
    params.push(f.toISOString()); conds.push(`advance_date >= $${params.length}::timestamptz`);
  }
  if (to !== undefined) {
    const t = parseLocalDay(to); if (!t) return { ok: false, message: 'Ngày "đến" không hợp lệ (YYYY-MM-DD).' };
    params.push(nextLocalDay(t).toISOString()); conds.push(`advance_date < $${params.length}::timestamptz`);
  }
  // [GÓI TZ 11/9] advance_date đọc qua $queryRaw Date LỆCH +7h so instant lưu → isBeforeCutoff misclassify hàng có
  // giờ tối (≥17:00 stored trôi sang NGÀY SAU, vd 23:59 25/8 đọc thành 06:59 26/8 → cutoff 26/8 giữ OAN). Đọc to_char
  // UTC ISO text (khuôn isoById ngay trên) → new Date(text) = INSTANT THẬT.
  const raw = await db.$queryRawUnsafe<{ id: number; investor_id: number; amount: bigint; advance_date: string }[]>(
    `SELECT id, investor_id, amount, to_char(advance_date AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS advance_date FROM investor_advances WHERE ${conds.join(' AND ')}`, ...params);
  return { ok: true, rows: raw.map((r) => ({ id: Number(r.id), investorId: Number(r.investor_id), amount: BigInt(r.amount), advanceDate: new Date(r.advance_date) })) };
}

/** INVESTOR_VIEW — Σ tiền tạm ứng (BigInt) của 1 NĐT trong kỳ [from,to] (local half-open). Dùng cho C-2b tất toán.
 *  1 query findMany + cộng BigInt (KHÔNG mất chữ số). total giữ BigInt — Number() ở BIÊN khi cần hiển thị. */
export async function sumAdvances(ctx: ServiceCtx, input: SumAdvancesInput): Promise<{ ok: boolean; error?: string; message?: string; total?: bigint }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  // CRITICAL FIX (Agent-6 1/9): raw ::timestamptz thay Prisma {gte,lt: Date} — chống lệch TZ 7h. sourceCond=undefined
  // = cả tạm ứng + hoàn (sumAdvances 1-NĐT giữ nghĩa cũ "mọi advance"). Cutoff KHÔNG áp ở hàm này (giữ hành vi cũ).
  const rows = await queryAdvancesInWindow(db, [input.investorId], undefined, input.from, input.to);
  if (!rows.ok) return { ok: false, error: 'VALIDATION', message: rows.message };
  let total = 0n;
  for (const r of rows.rows) total += r.amount;
  return { ok: true, total };
}

export interface SumAdvancesByInvestorsInput { investorIds: number[]; from?: string; to?: string }
/** INVESTOR_VIEW — Σ tiền tạm ứng (BigInt) theo NHIỀU NĐT trong kỳ, GOM 1 query (KHÔNG N+1) → Map<investorId,total>.
 *  Dùng cho C-2b tất toán (batched thay cho lặp sumAdvances). Cùng bound local half-open + loại soft-deleted như sumAdvances;
 *  tái dùng parseLocalDay/nextLocalDay của file này (KHÔNG nhân bản). NĐT không có dòng ứng → total 0n (khung đầy đủ). */
export async function sumAdvancesByInvestors(ctx: ServiceCtx, input: SumAdvancesByInvestorsInput): Promise<{ ok: boolean; error?: string; message?: string; totals?: Map<number, bigint> }> {
  // Gate AGGREGATION (Phase D) — hàm CHỈ trả TỔNG tạm ứng theo investorIds do CALLER truyền (chỉ tất toán gọi;
  // settlement ĐÃ scope ids về NĐT hợp lệ của user). Nới cho: staff REVENUE_VIEW, user NĐT tự-xem INVESTOR_SELF_VIEW,
  // hoặc quản lý NĐT INVESTOR_VIEW. An toàn: KHÔNG tự liệt kê NĐT — chỉ cộng theo ids caller đưa (đã kiểm phạm vi).
  if (!hasAnyPermission(ctx.user, ['REVENUE_VIEW', 'INVESTOR_SELF_VIEW', 'INVESTOR_VIEW'])) {
    return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  }
  const db = ctx.db;
  const ids = [...new Set(input.investorIds)];
  const totals = new Map<number, bigint>();
  for (const id of ids) totals.set(id, 0n); // khung: NĐT không ứng gì → 0n
  if (ids.length === 0) return { ok: true, totals };
  // LOẠI source='REPAYMENT' (Admin Demo 31/8 phương án B): tạm ứng giữ GROSS — hoàn-thừa (REPAYMENT) tách riêng,
  // TRỪ vào phải-trả ở settlement (sumRepaymentsByInvestors). Advances cũ source OCR/MANUAL → không đổi số.
  // CRITICAL FIX (Agent-6 1/9, LEAD repro xác nhận lệch 1,2 tỷ): cửa sổ kỳ PHẢI dùng raw `::timestamptz` — Prisma
  // `{gte,lt: Date}` qua adapter-pg serialize KHÔNG kèm TZ → Postgres đọc theo session TZ (+7) → LỆCH 7h → GD tối
  // rơi sai ngày (settlement.tamUng lệch detail.daNhan). MIRROR bản vá transactions 27/8 (investor-report.ts raw SQL).
  const rows = await queryAdvancesInWindow(db, ids, { not: 'REPAYMENT' }, input.from, input.to);
  if (!rows.ok) return { ok: false, error: 'VALIDATION', message: rows.message };
  // MỐC CHỐT/CLEAR (Admin Demo 1/9): loại dòng tạm ứng phát sinh TRƯỚC ngày chốt của NĐT (đã tất toán, giữ lịch sử).
  const cutoffs = await loadInvestorCutoffs(db);
  for (const r of rows.rows) {
    if (isBeforeCutoff(cutoffs, r.investorId, r.advanceDate)) continue; // trước mốc chốt → không tính
    totals.set(r.investorId, (totals.get(r.investorId) ?? 0n) + r.amount);
  }
  return { ok: true, totals };
}

/** Σ ĐÃ HOÀN (source='REPAYMENT') theo NĐT trong kỳ — SigMa hoàn thừa tạm ứng về NĐT (Admin Demo 31/8 phương án B).
 *  TRỪ vào phải-trả ở settlement. CÙNG khuôn + gate + scope như sumAdvancesByInvestors. */
export async function sumRepaymentsByInvestors(ctx: ServiceCtx, input: SumAdvancesByInvestorsInput): Promise<{ ok: boolean; error?: string; message?: string; totals?: Map<number, bigint> }> {
  if (!hasAnyPermission(ctx.user, ['REVENUE_VIEW', 'INVESTOR_SELF_VIEW', 'INVESTOR_VIEW'])) {
    return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  }
  const db = ctx.db;
  const ids = [...new Set(input.investorIds)];
  const totals = new Map<number, bigint>();
  for (const id of ids) totals.set(id, 0n);
  if (ids.length === 0) return { ok: true, totals };
  // CRITICAL FIX (Agent-6 1/9): raw ::timestamptz thay Prisma {gte,lt} — chống lệch TZ 7h (đối xứng sumAdvancesByInvestors).
  const q = await queryAdvancesInWindow(db, ids, 'REPAYMENT', input.from, input.to);
  if (!q.ok) return { ok: false, error: 'VALIDATION', message: q.message };
  // MỐC CHỐT/CLEAR: loại dòng hoàn thừa phát sinh TRƯỚC ngày chốt (đối xứng với tạm ứng — cùng kỳ tính hiện tại).
  const cutoffs = await loadInvestorCutoffs(db);
  for (const r of q.rows) {
    if (isBeforeCutoff(cutoffs, r.investorId, r.advanceDate)) continue; // trước mốc chốt → không tính
    totals.set(r.investorId, (totals.get(r.investorId) ?? 0n) + r.amount);
  }
  return { ok: true, totals };
}

// ── TK CK "đi tiền tạm ứng" (cấu hình, matching OCR là phase sau) ──────────────────────────────────────────────
/** INVESTOR_VIEW — danh sách TK CK của 1 NĐT (ẩn soft-deleted). */
export async function listInvestorBankAccounts(ctx: ServiceCtx, investorId: number): Promise<{ ok: boolean; error?: string; message?: string; data?: InvestorBankAccountDto[] }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.investorBankAccount.findMany({ where: { investorId, deletedAt: null }, orderBy: { id: 'desc' } });
  const data: InvestorBankAccountDto[] = rows.map((r) => ({
    id: r.id,
    investorId: r.investorId,
    bankName: r.bankName,
    accountNumber: r.accountNumber,
    accountHolder: r.accountHolder,
    note: r.note,
    createdAt: r.createdAt.toISOString()
  }));
  return { ok: true, data };
}

export interface CreateInvestorBankAccountInput { investorId: number; accountNumber: string; bankName?: string | null; accountHolder?: string | null; note?: string | null }

/** INVESTOR_UPDATE — thêm 1 TK CK cho NĐT. Validate NĐT tồn tại + STK bắt buộc. */
export async function createInvestorBankAccount(ctx: ServiceCtx, input: CreateInvestorBankAccountInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, UPDATE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const accountNumber = input.accountNumber?.trim();
  if (!accountNumber) return { ok: false, error: 'VALIDATION', message: 'Số tài khoản bắt buộc.' };
  const investor = await db.investor.findUnique({ where: { id: input.investorId }, select: { id: true, deletedAt: true } });
  if (!investor || investor.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Nhà đầu tư không tồn tại.' };
  const created = await db.investorBankAccount.create({
    data: {
      investorId: input.investorId,
      accountNumber,
      bankName: input.bankName?.trim() || null,
      accountHolder: input.accountHolder?.trim() || null,
      note: input.note?.trim() || null,
      createdBy: user.id
    }
  });
  return { ok: true, id: created.id };
}

/** INVESTOR_UPDATE — xóa mềm 1 TK CK. §14 mật khẩu do ROUTE kiểm (khuôn deleteInvestor). `investorId` từ URL
 *  (`:investorId`) BẮT BUỘC khớp chủ TK — chặn xóa chéo TK của NĐT khác (URL /investors/X/bank-accounts/Y với
 *  Y thuộc NĐT Z≠X). Lệch → NOT_FOUND (không lộ TK tồn tại thuộc NĐT khác). */
export async function deleteInvestorBankAccount(ctx: ServiceCtx, investorId: number, id: number): Promise<MutationResult> {
  if (!hasPermission(ctx.user, UPDATE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const row = await db.investorBankAccount.findUnique({ where: { id } });
  if (!row || row.deletedAt || row.investorId !== investorId) return { ok: false, error: 'NOT_FOUND', message: 'Tài khoản CK không tồn tại.' };
  await db.investorBankAccount.update({ where: { id }, data: { deletedAt: new Date(), deletedBy: user.id } });
  return { ok: true, id };
}
