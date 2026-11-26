// Thu–Chi: Phiếu thu/chi (CashEntry §2.3/D+E) + Thu công nợ + hủy phiếu + báo cáo dòng tiền — LÕI THUẦN ctx-based.
// PORT nghiệp vụ từ apps/desktop/src/main/cash-entry-service.ts. Thay requirePermission bằng ctx = { db, user };
// hasPermission(ctx.user, CASHENTRY_VIEW/CREATE/CANCEL). Tiền = VND nguyên > 0. kind=CHI bắt buộc payerUserId.
// Mã PT/PC atomic trong $transaction (nextCode(@sigma/services) nhận (client, prefix) — KHÁC desktop). Thu công nợ
// theo NET-OF-SETTLEMENT + khóa GD FOR UPDATE (chống over-settlement). Hủy POSTED→CANCELLED nguyên tử + gỡ
// settlement/deviceSaleSettlement + tính lại settled. XÁC NHẬN MẬT KHẨU (§14, hủy) do ADAPTER kiểm TRƯỚC khi gọi
// lõi — lõi KHÔNG kiểm password (khớp customer.ts). MutationResult/ServiceCtx từ customer.js.
import { auditSnapshot } from '@sigma/business-rules';
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { nextCode } from './code.js';
import { type ServiceCtx, type MutationResult } from './customer.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';
const KINDS = new Set(['THU', 'CHI']);
const METHODS = new Set(['CK', 'CASH']);
/** sourceKind công nợ — create THƯỜNG CHẶN (DEBT_RECEIPT_DEFERRED); thu công nợ đi qua createDebtReceipt. */
const DEBT_SOURCE = new Set(['DEBT_CUSTOMER', 'DEBT_PARTNER']);
/**
 * ALLOWLIST danh mục ĐƯỢC LẬP PHIẾU TAY (Money-F3, Admin Demo). CHỈ MANUAL (doanh thu/chi phí thường) + SALARY (chi
 * lương) là nghiệp vụ nhập tay thật. Mọi sourceKind còn lại do NGHIỆP VỤ KHÁC sinh tự động:
 *   SALE_POS/SALE_TID/SALE_COLLECT (bán máy/TID) · RENT (giao thuê) · DEPOSIT/DEPOSIT_REFUND/DEVICE_DEPOSIT (cọc) ·
 *   ADVANCE (tạm ứng/hoàn ứng) · FUND_TRANSFER (chuyển quỹ) · BAD_DEBT (ghi giảm nợ xấu) · DEBT_* (thu công nợ).
 * Cho lập tay các loại này sẽ PHỒNG/GIẢM lợi nhuận (double-count) hoặc lệch quỹ. Chặn ở createCashEntry (server —
 * lớp thực thi thật, kể cả danh mục do user tự tạo với sourceKind hệ thống). DEBT_* trả riêng DEBT_RECEIPT_DEFERRED.
 */
const MANUAL_POSTABLE_SOURCE = new Set(['MANUAL', 'SALARY']);
/** Khoản nợ của 1 GD: PARTNER (CL_NCC — chênh đối tác) | SELL (CL_KH — chênh bán). */
const SIDES = new Set(['PARTNER', 'SELL']);
/** Trần an toàn số tiền (R5 — chống tràn Number). */
const AMOUNT_MAX = 1e15;

/** Chuyển trạng thái nguyên tử THUA (updateMany count===0) → ném ra ngoài $transaction (mẫu approval-service). */
class TxGuardError extends Error {
  constructor(public readonly code: string, public readonly userMessage: string) {
    super(code);
    this.name = 'TxGuardError';
  }
}

/** MONEY-2 (audit 21/8) — True nếu lỗi Postgres deadlock (40P01)/serialization (40001) hoặc Prisma write-conflict
 *  (P2034) → nên retry. Mirror isRetryablePgError (pos.ts)/isRetryableTidTxError (tid.ts). */
function isRetryableTxError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === '40P01' || code === '40001' || code === 'P2034';
}
/** MONEY-2 — chạy 1 transaction, retry tối đa `attempts` lần khi deadlock/serialization. Lỗi NGHIỆP VỤ
 *  (TxGuardError…) KHÔNG có code retry → ném ra ngay cho caller map. Mirror runWithRetry (pos.ts). createDebtReceipt
 *  khóa txn id ASC — có thể ABBA với recalc; retry để deadlock 40P01 không thoát thành 500. */
async function runCashTxWithRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); }
    catch (e) { if (isRetryableTxError(e)) { lastErr = e; continue; } throw e; }
  }
  throw lastErr;
}

export interface CashEntryDto {
  id: number;
  code: string | null;
  kind: string; // THU | CHI
  categoryId: number;
  categoryName: string | null;
  sourceKind: string | null;
  sourceType: string | null;
  fundId: number | null;
  fundCode: string | null;
  fundName: string | null;
  amount: number;
  method: string; // CK | CASH
  entryDate: string; // ISO
  customerId: number | null;
  customerName: string | null;
  partnerId: number | null;
  partnerName: string | null;
  partnerText: string | null;
  payerUserId: number | null;
  payerUserName: string | null;
  receiverUserId: number | null;
  receiverUserName: string | null;
  note: string | null;
  status: string; // DRAFT | POSTED | CANCELLED
  cancelReason: string | null;
  cancelledAt: string | null;
  createdBy: number | null;
  createdByName: string | null;
  createdAt: string;
}

export interface CashEntryFilter {
  kind?: string;
  categoryId?: number;
  fundId?: number;
  customerId?: number;
  partnerId?: number;
  status?: string;
  fromDate?: string; // YYYY-MM-DD (local)
  toDate?: string;
  // FIX-PERF (audit 20/8) — phân trang sổ tiền (khuôn listCustomers B132). Client KHÔNG gửi → trang 1, pageSize
  // mặc định 100 (max 500) — chặn kéo full-bảng CashEntry (sổ cái lớn nhất). `summary` LUÔN tính trên TOÀN bộ tập
  // lọc (không chỉ trang) — xem summarizeDb. Trả kèm {total,page,pageSize}.
  page?: number;
  pageSize?: number;
}

export interface CreateCashEntryInput {
  kind: string;
  categoryId: number;
  fundId: number;
  amount: number;
  method: string;
  entryDate: string;
  customerId?: number | null;
  partnerId?: number | null;
  partnerText?: string | null;
  payerUserId?: number | null;
  receiverUserId?: number | null;
  note?: string | null;
}

export interface CashflowSummary {
  count: number;
  totalThu: number;
  totalChi: number;
  net: number;
}

/** 1 dòng tất toán: áp `amount` vào 1 side (PARTNER|SELL) của 1 Transaction (§2.4). */
export interface DebtReceiptLine {
  transactionId: number;
  side: string; // PARTNER | SELL
  amount: number; // VND > 0
}

/** Input Thu công nợ (createDebtReceipt): 1 phiếu THU (category DEBT_*) tất toán ≥1 GD qua các line. */
export interface CreateDebtReceiptInput {
  categoryId: number;
  fundId: number;
  method: string;
  entryDate: string;
  customerId?: number | null;
  partnerId?: number | null;
  note?: string | null;
  docPath?: string | null;
  docName?: string | null;
  lines: DebtReceiptLine[];
}

export interface CashflowReportResult {
  ok: boolean;
  error?: string;
  message?: string;
  data?: CashEntryDto[];
  summary?: CashflowSummary;
  // FIX-PERF (audit 20/8) — phân trang listCashEntries. `data` = 1 trang; `summary`/`total` phủ TOÀN tập lọc.
  total?: number;
  page?: number;
  pageSize?: number;
}

// FIX-PERF (audit 20/8) — trần phân trang sổ tiền (khuôn CUSTOMER_PAGE_SIZE_* ở customer.ts).
const CASH_ENTRY_PAGE_SIZE_DEFAULT = 100;
const CASH_ENTRY_PAGE_SIZE_MAX = 500;

/** Ngày VND local (B16): 'YYYY-MM-DD' → nửa đêm LOCAL; ISO → nguyên. null nếu không parse được. */
function parseLocalDate(v: unknown): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(s + 'T00:00:00') : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}
function dayStart(v?: string): Date | undefined {
  if (!v) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T00:00:00') : new Date(v);
}
function dayEnd(v?: string): Date | undefined {
  if (!v) return undefined;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T23:59:59.999') : new Date(v);
}
/** Số tiền VND: số nguyên > 0, không tràn (I#4/R5). null nếu sai. */
function parseAmount(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > AMOUNT_MAX) return null;
  return n;
}

async function resolveUserNames(db: Db, ids: (number | null | undefined)[]): Promise<Map<number, string>> {
  const uniq = [...new Set(ids.filter((x): x is number => typeof x === 'number'))];
  const map = new Map<number, string>();
  if (uniq.length === 0) return map;
  const users = await db.user.findMany({ where: { id: { in: uniq } }, select: { id: true, fullName: true, username: true } });
  for (const u of users) map.set(u.id, u.fullName || u.username);
  return map;
}

/** Build where cho list/report từ filter (dùng chung). */
function buildWhere(filter: CashEntryFilter): Record<string, unknown> {
  const start = dayStart(filter.fromDate);
  const end = dayEnd(filter.toDate);
  return {
    deletedAt: null,
    kind: filter.kind && KINDS.has(filter.kind) ? filter.kind : undefined,
    categoryId: filter.categoryId ?? undefined,
    fundId: filter.fundId ?? undefined,
    customerId: filter.customerId ?? undefined,
    partnerId: filter.partnerId ?? undefined,
    status: filter.status ?? undefined,
    entryDate: start || end ? { gte: start, lte: end } : undefined
  };
}

/** Ánh xạ rows → DTO + join tên (category/fund/customer/partner/user). */
async function toDtos(db: Db, rows: Awaited<ReturnType<Db['cashEntry']['findMany']>>): Promise<CashEntryDto[]> {
  const catIds = [...new Set(rows.map((r) => r.categoryId))];
  const fundIds = [...new Set(rows.map((r) => r.fundId).filter((x): x is number => x != null))];
  const custIds = [...new Set(rows.map((r) => r.customerId).filter((x): x is number => x != null))];
  const partIds = [...new Set(rows.map((r) => r.partnerId).filter((x): x is number => x != null))];
  const [cats, funds, custs, parts] = await Promise.all([
    catIds.length ? db.cashCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true, sourceKind: true } }) : Promise.resolve([]),
    fundIds.length ? db.fund.findMany({ where: { id: { in: fundIds } }, select: { id: true, code: true, name: true } }) : Promise.resolve([]),
    custIds.length ? db.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, nickname: true, fullName: true } }) : Promise.resolve([]),
    partIds.length ? db.partner.findMany({ where: { id: { in: partIds } }, select: { id: true, name: true } }) : Promise.resolve([])
  ]);
  const catMap = new Map(cats.map((c) => [c.id, c]));
  const fundMap = new Map(funds.map((f) => [f.id, f]));
  const custMap = new Map(custs.map((c) => [c.id, c.nickname || c.fullName]));
  const partMap = new Map(parts.map((p) => [p.id, p.name]));
  const userNames = await resolveUserNames(db, rows.flatMap((r) => [r.payerUserId, r.receiverUserId, r.createdBy]));
  return rows.map((r) => {
    const cat = catMap.get(r.categoryId);
    const fund = r.fundId != null ? fundMap.get(r.fundId) : undefined;
    return {
      id: r.id,
      code: r.code,
      kind: r.kind,
      categoryId: r.categoryId,
      categoryName: cat?.name ?? null,
      sourceKind: cat?.sourceKind ?? null,
      sourceType: r.sourceType,
      fundId: r.fundId,
      fundCode: fund?.code ?? null,
      fundName: fund?.name ?? null,
      amount: Number(r.amount),
      method: r.method,
      entryDate: r.entryDate.toISOString(),
      customerId: r.customerId,
      customerName: r.customerId != null ? custMap.get(r.customerId) ?? null : null,
      partnerId: r.partnerId,
      partnerName: r.partnerId != null ? partMap.get(r.partnerId) ?? null : null,
      partnerText: r.partnerText,
      payerUserId: r.payerUserId,
      payerUserName: r.payerUserId != null ? userNames.get(r.payerUserId) ?? null : null,
      receiverUserId: r.receiverUserId,
      receiverUserName: r.receiverUserId != null ? userNames.get(r.receiverUserId) ?? null : null,
      note: r.note,
      status: r.status,
      cancelReason: r.cancelReason,
      cancelledAt: r.cancelledAt ? r.cancelledAt.toISOString() : null,
      createdBy: r.createdBy,
      createdByName: r.createdBy != null ? userNames.get(r.createdBy) ?? null : null,
      createdAt: r.createdAt.toISOString()
    };
  });
}

/**
 * Tổng THU/CHI (POSTED) từ danh sách DTO — DÒNG TIỀN thực vào/ra quỹ. LOẠI bút toán PHI TIỀN MẶT (fundId=null,
 * vd write-off nợ xấu): không đồng nào rời quỹ → KHÔNG cộng vào totalChi (nếu cộng → net lệch số dư quỹ).
 */
function summarize(dtos: CashEntryDto[]): CashflowSummary {
  let totalThu = 0, totalChi = 0, count = 0;
  for (const d of dtos) {
    if (d.status !== 'POSTED') continue;
    if (d.fundId == null) continue; // phi tiền mặt — không tính vào dòng tiền
    count++;
    if (d.kind === 'THU') totalThu += d.amount; else totalChi += d.amount;
  }
  return { count, totalThu, totalChi, net: totalThu - totalChi };
}

/**
 * Tổng THU/CHI (POSTED, có quỹ) trên TOÀN tập lọc — tính TẠI DB (groupBy) để summary KHÔNG lệ thuộc trang hiện tại
 * (sau khi phân trang, `data` chỉ là 1 trang). Semantics KHỚP `summarize`: chỉ POSTED + fundId != null; THU cộng,
 * CHI trừ. Dùng AND(where, {status:POSTED, fundId!=null}) để GIỮ ĐÚNG filter.status của caller (vd status=CANCELLED
 * mâu thuẫn POSTED → 0, y như summarize lọc rows cũ).
 */
async function summarizeDb(db: Db, where: Record<string, unknown>): Promise<CashflowSummary> {
  const summaryWhere = { AND: [where, { status: 'POSTED', fundId: { not: null } }] };
  const [count, grouped] = await Promise.all([
    db.cashEntry.count({ where: summaryWhere }),
    db.cashEntry.groupBy({ by: ['kind'], where: summaryWhere, _sum: { amount: true } })
  ]);
  let totalThu = 0, totalChi = 0;
  for (const g of grouped) {
    const sum = Number(g._sum.amount ?? 0);
    if (g.kind === 'THU') totalThu += sum; else totalChi += sum;
  }
  return { count, totalThu, totalChi, net: totalThu - totalChi };
}

/** CASHENTRY_VIEW — liệt kê phiếu thu/chi (mọi trạng thái, loại đã xóa mềm) + tổng THU/CHI (POSTED). Phân trang
 *  (mặc định 100, max 500) để chặn kéo full-bảng; `summary`/`total` phủ TOÀN tập lọc (không chỉ trang). */
export async function listCashEntries(ctx: ServiceCtx, filter: CashEntryFilter = {}): Promise<CashflowReportResult> {
  if (!hasPermission(ctx.user, 'CASHENTRY_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const where = buildWhere(filter);
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(CASH_ENTRY_PAGE_SIZE_MAX, Math.max(1, filter.pageSize ?? CASH_ENTRY_PAGE_SIZE_DEFAULT));
  const [total, rows, summary] = await Promise.all([
    db.cashEntry.count({ where }),
    db.cashEntry.findMany({ where, orderBy: [{ entryDate: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
    summarizeDb(db, where)
  ]);
  const data = await toDtos(db, rows);
  return { ok: true, data, summary, total, page, pageSize };
}

/** CASHENTRY_VIEW — báo cáo dòng tiền (§F): CHỈ phiếu POSTED trong khoảng ngày + danh mục/quỹ/đối tượng.
 * LOẠI bút toán PHI TIỀN MẶT (fundId=null): báo cáo DÒNG TIỀN = tiền THỰC vào/ra quỹ. */
export async function cashflowReport(ctx: ServiceCtx, filter: CashEntryFilter = {}): Promise<CashflowReportResult> {
  if (!hasPermission(ctx.user, 'CASHENTRY_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const where: Record<string, unknown> = { ...buildWhere(filter), status: 'POSTED' };
  if (where['fundId'] == null) where['fundId'] = { not: null };
  const rows = await db.cashEntry.findMany({ where, orderBy: [{ entryDate: 'asc' }, { id: 'asc' }] });
  const data = await toDtos(db, rows);
  return { ok: true, data, summary: summarize(data) };
}

/** CASHENTRY_VIEW — danh mục thu/chi gọn (active) để chọn khi lập phiếu. `postable` (Money-F3) = danh mục ĐƯỢC lập
 *  phiếu TAY (MANUAL/SALARY). KHÔNG lọc bỏ DEBT/hệ thống ở đây vì DebtPage đọc CÙNG endpoint này để lấy danh mục
 *  công nợ (DEBT_*) khi Thu công nợ → form phiếu tay lọc client theo `postable`; server chặn cứng ở createCashEntry. */
export async function listEntryCategoriesLite(ctx: ServiceCtx): Promise<{ ok: boolean; data?: { id: number; kind: string; name: string; sourceKind: string; affectsPnl: boolean; postable: boolean }[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'CASHENTRY_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const rows = await ctx.db.cashCategory.findMany({ where: { deletedAt: null, active: true }, select: { id: true, kind: true, name: true, sourceKind: true, affectsPnl: true }, orderBy: [{ kind: 'asc' }, { id: 'asc' }] });
  return { ok: true, data: rows.map((r) => ({ ...r, postable: MANUAL_POSTABLE_SOURCE.has(r.sourceKind) })) };
}

/** CASHENTRY_VIEW — danh sách đối tác gọn (id + tên) để chọn "của ai" khi lập phiếu. */
export async function listPartnersLite(ctx: ServiceCtx): Promise<{ ok: boolean; data?: { id: number; name: string }[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'CASHENTRY_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const rows = await ctx.db.partner.findMany({ where: { deletedAt: null }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] });
  return { ok: true, data: rows };
}

/** CASHENTRY_CREATE — lập phiếu thu/chi (POSTED thẳng). Mã PT/PC atomic trong $transaction. */
export async function createCashEntry(ctx: ServiceCtx, input: CreateCashEntryInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'CASHENTRY_CREATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  if (input.fundId == null) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn quỹ.' };

  const kind = (input.kind ?? '').trim().toUpperCase();
  if (!KINDS.has(kind)) return { ok: false, error: 'VALIDATION', message: 'Loại phiếu phải là THU hoặc CHI.' };

  const amount = parseAmount(input.amount);
  if (amount === null) return { ok: false, error: 'VALIDATION', message: 'Số tiền phải là số nguyên dương (VND).' };

  const method = (input.method ?? '').trim().toUpperCase();
  if (!METHODS.has(method)) return { ok: false, error: 'VALIDATION', message: 'Hình thức phải là Chuyển khoản (CK) hoặc Tiền mặt (CASH).' };

  const entryDate = parseLocalDate(input.entryDate);
  if (!entryDate) return { ok: false, error: 'VALIDATION', message: 'Ngày thu/chi không hợp lệ.' };

  const fund = await db.fund.findUnique({ where: { id: input.fundId }, select: { id: true, deletedAt: true } });
  if (!fund || fund.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Quỹ không hợp lệ.' };

  const cat = await db.cashCategory.findUnique({ where: { id: input.categoryId }, select: { id: true, kind: true, active: true, deletedAt: true, sourceKind: true } });
  if (!cat || cat.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Danh mục không hợp lệ.' };
  if (!cat.active) return { ok: false, error: 'VALIDATION', message: 'Danh mục đã ngừng dùng, không lập phiếu được.' };
  if (cat.kind !== kind) return { ok: false, error: 'VALIDATION', message: `Danh mục thuộc nhóm ${cat.kind === 'THU' ? 'thu' : 'chi'}, không dùng cho phiếu ${kind === 'THU' ? 'thu' : 'chi'}.` };
  if (DEBT_SOURCE.has(cat.sourceKind)) {
    return { ok: false, error: 'DEBT_RECEIPT_DEFERRED', message: 'Thu công nợ dùng chức năng Thu công nợ (pha sau), không lập phiếu thu thường ở đây.' };
  }
  // Money-F3 — chỉ MANUAL/SALARY lập tay được; danh mục nghiệp vụ khác (bán máy/cọc/tạm ứng/chuyển quỹ/nợ xấu…)
  // sinh tự động → lập tay sẽ phồng/giảm lợi nhuận. Chặn ở đây (server) kể cả khi danh mục do user tự tạo.
  if (!MANUAL_POSTABLE_SOURCE.has(cat.sourceKind)) {
    return { ok: false, error: 'CATEGORY_NOT_MANUAL', message: 'Danh mục này do nghiệp vụ khác sinh tự động (bán máy/cọc/tạm ứng/chuyển quỹ/nợ xấu…). Hãy lập ở nghiệp vụ gốc, không lập phiếu tay tại đây.' };
  }

  if (kind === 'CHI' && input.payerUserId == null) {
    return { ok: false, error: 'PAYER_REQUIRED', message: 'Phiếu chi bắt buộc chọn người chi.' };
  }

  for (const [uid, label] of [[input.payerUserId, 'Người chi'], [input.receiverUserId, 'Người nhận']] as [number | null | undefined, string][]) {
    if (uid != null) {
      const u = await db.user.findUnique({ where: { id: uid }, select: { id: true, deletedAt: true } });
      if (!u || u.deletedAt) return { ok: false, error: 'VALIDATION', message: `${label} không hợp lệ.` };
    }
  }
  if (input.customerId != null) {
    const c = await db.customer.findUnique({ where: { id: input.customerId }, select: { id: true, deletedAt: true } });
    if (!c || c.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Khách hàng không hợp lệ.' };
  }
  if (input.partnerId != null) {
    const p = await db.partner.findUnique({ where: { id: input.partnerId }, select: { id: true, deletedAt: true } });
    if (!p || p.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Đối tác không hợp lệ.' };
  }

  const partnerText = input.partnerText?.trim() || null;
  if (input.partnerId != null && partnerText) {
    return { ok: false, error: 'PARTNER_SOURCE_CONFLICT', message: 'Chỉ chọn đối tác từ danh sách HOẶC nhập tay, không dùng cả hai.' };
  }

  const prefix = kind === 'THU' ? 'PT' : 'PC';
  const created = await db.$transaction(async (tx) => {
    const code = await nextCode(tx, prefix);
    const c = await tx.cashEntry.create({
      data: {
        code, kind, categoryId: input.categoryId, fundId: input.fundId, amount, method, entryDate,
        customerId: input.customerId ?? null, partnerId: input.partnerId ?? null, partnerText,
        payerUserId: input.payerUserId ?? null, receiverUserId: input.receiverUserId ?? null,
        note: input.note?.trim() || null, status: 'POSTED', createdBy: user.id
      }
    });
    await writeAudit(tx, {
      actorUserId: user.id,
      action: 'CASH_ENTRY_CREATED',
      targetType: 'CashEntry',
      targetId: String(c.id),
      after: auditSnapshot({ code: c.code, kind, categoryId: input.categoryId, fundId: input.fundId, amount, method, entryDate: entryDate.toISOString(), status: 'POSTED' })
    });
    return c;
  });
  return { ok: true, id: created.id };
}

/**
 * CASHENTRY_CREATE — Thu công nợ (H2-debt §2.4): 1 phiếu THU (category DEBT_*) TẤT TOÁN ≥1 Transaction qua các
 * CashDebtSettlement, theo NET-OF-SETTLEMENT. Khóa GD cha FOR UPDATE (chống over-settlement). GD nào net cả 2 side
 * =0 → settled=true. Audit CASH_DEBT_RECEIPT_CREATED.
 */
export async function createDebtReceipt(ctx: ServiceCtx, input: CreateDebtReceiptInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'CASHENTRY_CREATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  if (input.fundId == null) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn quỹ.' };

  const method = (input.method ?? '').trim().toUpperCase();
  if (!METHODS.has(method)) return { ok: false, error: 'VALIDATION', message: 'Hình thức phải là Chuyển khoản (CK) hoặc Tiền mặt (CASH).' };

  const entryDate = parseLocalDate(input.entryDate);
  if (!entryDate) return { ok: false, error: 'VALIDATION', message: 'Ngày thu không hợp lệ.' };

  const fund = await db.fund.findUnique({ where: { id: input.fundId }, select: { id: true, deletedAt: true } });
  if (!fund || fund.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Quỹ không hợp lệ.' };

  const cat = await db.cashCategory.findUnique({ where: { id: input.categoryId }, select: { id: true, kind: true, active: true, deletedAt: true, sourceKind: true } });
  if (!cat || cat.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Danh mục không hợp lệ.' };
  if (!cat.active) return { ok: false, error: 'VALIDATION', message: 'Danh mục đã ngừng dùng, không lập phiếu được.' };
  if (cat.kind !== 'THU' || !DEBT_SOURCE.has(cat.sourceKind)) {
    return { ok: false, error: 'VALIDATION', message: 'Thu công nợ phải dùng danh mục Công nợ (khách hàng / đối tác).' };
  }

  if (input.customerId == null && input.partnerId == null) {
    return { ok: false, error: 'VALIDATION', message: 'Chọn đối tượng thu (khách hàng hoặc đối tác).' };
  }
  if (cat.sourceKind === 'DEBT_CUSTOMER' && input.customerId == null) {
    return { ok: false, error: 'DEBT_SIDE_CATEGORY_MISMATCH', message: 'Thu công nợ theo danh mục Công nợ khách hàng cần chọn khách hàng.' };
  }
  if (cat.sourceKind === 'DEBT_PARTNER' && input.partnerId == null) {
    return { ok: false, error: 'DEBT_SIDE_CATEGORY_MISMATCH', message: 'Thu công nợ theo danh mục Công nợ đối tác cần chọn đối tác.' };
  }
  if (input.customerId != null) {
    const c = await db.customer.findUnique({ where: { id: input.customerId }, select: { id: true, deletedAt: true } });
    if (!c || c.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Khách hàng không hợp lệ.' };
  }
  if (input.partnerId != null) {
    const p = await db.partner.findUnique({ where: { id: input.partnerId }, select: { id: true, deletedAt: true } });
    if (!p || p.deletedAt) return { ok: false, error: 'VALIDATION', message: 'Đối tác không hợp lệ.' };
  }

  const lines = input.lines ?? [];
  if (!Array.isArray(lines) || lines.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa nhập khoản thu nào.' };
  const addBySide = new Map<string, number>();
  const wantSide = cat.sourceKind === 'DEBT_CUSTOMER' ? 'SELL' : 'PARTNER';
  let total = 0;
  for (const ln of lines) {
    const side = (ln.side ?? '').trim().toUpperCase();
    if (!SIDES.has(side)) return { ok: false, error: 'VALIDATION', message: 'Khoản nợ phải là đối tác (PARTNER) hoặc khách/bán (SELL).' };
    if (side !== wantSide) {
      return { ok: false, error: 'DEBT_SIDE_CATEGORY_MISMATCH', message: `Danh mục ${cat.sourceKind === 'DEBT_CUSTOMER' ? 'Công nợ khách hàng' : 'Công nợ đối tác'} chỉ tất toán khoản ${wantSide === 'SELL' ? 'khách/bán (SELL)' : 'đối tác (PARTNER)'}, không dùng cho khoản ${side === 'SELL' ? 'khách/bán' : 'đối tác'}.` };
    }
    const amt = parseAmount(ln.amount);
    if (amt === null) return { ok: false, error: 'VALIDATION', message: 'Số tiền thu mỗi khoản phải là số nguyên dương (VND).' };
    if (!Number.isInteger(ln.transactionId) || ln.transactionId <= 0) return { ok: false, error: 'VALIDATION', message: 'Giao dịch không hợp lệ.' };
    const key = `${ln.transactionId}:${side}`;
    addBySide.set(key, (addBySide.get(key) ?? 0) + amt);
    total += amt;
  }
  if (total <= 0 || total > AMOUNT_MAX) return { ok: false, error: 'VALIDATION', message: 'Tổng tiền thu không hợp lệ.' };
  const txnIds = [...new Set(lines.map((l) => l.transactionId))];
  const lockIds = [...txnIds].sort((a, b) => a - b);

  let created;
  try {
    created = await runCashTxWithRetry(() => db.$transaction(async (tx) => {
      // KHÓA HÀNG Transaction cha TRƯỚC khi đọc settlement/tính remaining (chống TOCTOU over-settlement).
      const lockPlaceholders = lockIds.map((_, i) => `$${i + 1}`).join(', ');
      await tx.$queryRawUnsafe(`SELECT id FROM transactions WHERE id IN (${lockPlaceholders}) FOR UPDATE`, ...lockIds);

      const txnRows = await tx.transaction.findMany({
        where: { id: { in: txnIds } },
        select: { id: true, revenuePartner: true, revenueSell: true, customerId: true, tidId: true, status: true, deletedAt: true, settled: true, writtenOffAt: true }
      });
      const txnMap = new Map(txnRows.map((t) => [t.id, t]));
      let tidPartnerMap = new Map<number, number | null>();
      if (input.partnerId != null) {
        const tidIds = [...new Set(txnRows.map((t) => t.tidId))];
        const tidRows = await tx.tid.findMany({ where: { id: { in: tidIds } }, select: { id: true, partnerId: true } });
        tidPartnerMap = new Map(tidRows.map((t) => [t.id, t.partnerId]));
      }
      const prevAgg = await tx.cashDebtSettlement.groupBy({ by: ['transactionId', 'side'], where: { transactionId: { in: txnIds } }, _sum: { amount: true } });
      const paidBySide = new Map<string, number>();
      for (const p of prevAgg) paidBySide.set(`${p.transactionId}:${p.side}`, Number(p._sum.amount ?? 0));

      for (const txnId of txnIds) {
        const t = txnMap.get(txnId);
        if (!t || t.deletedAt) throw new TxGuardError('TXN_INVALID', `Giao dịch #${txnId} không tồn tại.`);
        if (t.status === 'CANCELLED') throw new TxGuardError('TXN_INVALID', `Giao dịch #${txnId} đã hủy, không thu công nợ được.`);
        // [B324/SV1 24/11 — agent soát] Chặn cả CANCEL_PENDING: thu công nợ cho GD đang chờ duyệt hủy, rồi
        // nếu duyệt hủy (B323 nay chặn) hoặc bị hủy đường khác thì phiếu thu mồ côi. Fail-closed từ đầu.
        if (t.status === 'CANCEL_PENDING') throw new TxGuardError('TXN_INVALID', `Giao dịch #${txnId} đang CHỜ DUYỆT HỦY — không thu công nợ. Chờ xử lý yêu cầu hủy xong rồi mới thu.`);
        if (t.writtenOffAt != null) throw new TxGuardError('TXN_WRITTEN_OFF', `Giao dịch #${txnId} đã ghi giảm nợ xấu — không thu công nợ.`);
        if (input.customerId != null && t.customerId !== input.customerId) throw new TxGuardError('TXN_OBJECT_MISMATCH', `Giao dịch #${txnId} không thuộc khách hàng đã chọn.`);
        if (input.partnerId != null) {
          const tp = tidPartnerMap.get(t.tidId);
          if (tp == null || tp !== input.partnerId) throw new TxGuardError('TXN_OBJECT_MISMATCH', `Giao dịch #${txnId} không thuộc đối tác đã chọn.`);
        }
        const revBySide: Record<string, number> = { PARTNER: Number(t.revenuePartner), SELL: Number(t.revenueSell) };
        for (const side of ['PARTNER', 'SELL']) {
          const adding = addBySide.get(`${txnId}:${side}`) ?? 0;
          if (adding <= 0) continue;
          const remaining = revBySide[side] - (paidBySide.get(`${txnId}:${side}`) ?? 0);
          if (adding > remaining) {
            const label = side === 'PARTNER' ? 'đối tác' : 'khách/bán';
            throw new TxGuardError('DEBT_OVERPAY', `Số thu khoản ${label} của GD #${txnId} vượt công nợ còn lại (còn ${Math.max(0, remaining)} đ).`);
          }
        }
      }

      const code = await nextCode(tx, 'PT');
      const entry = await tx.cashEntry.create({
        data: {
          code, kind: 'THU', categoryId: input.categoryId, fundId: input.fundId, amount: total, method, entryDate,
          customerId: input.customerId ?? null, partnerId: input.partnerId ?? null,
          docPath: input.docPath?.trim() || null, docName: input.docName?.trim() || null,
          sourceType: null, note: input.note?.trim() || null, status: 'POSTED', createdBy: user.id
        }
      });
      for (const ln of lines) {
        await tx.cashDebtSettlement.create({ data: { cashEntryId: entry.id, transactionId: ln.transactionId, side: (ln.side ?? '').trim().toUpperCase(), amount: parseAmount(ln.amount)! } });
      }

      const postAgg = await tx.cashDebtSettlement.groupBy({ by: ['transactionId', 'side'], where: { transactionId: { in: txnIds } }, _sum: { amount: true } });
      const paidPost = new Map<string, number>();
      for (const a of postAgg) paidPost.set(`${a.transactionId}:${a.side}`, Number(a._sum.amount ?? 0));
      for (const txnId of txnIds) {
        const t = txnMap.get(txnId);
        if (!t) continue;
        const remainingPartner = Number(t.revenuePartner) - (paidPost.get(`${txnId}:PARTNER`) ?? 0);
        const remainingSell = Number(t.revenueSell) - (paidPost.get(`${txnId}:SELL`) ?? 0);
        const fullySettled = remainingPartner <= 0 && remainingSell <= 0;
        if (fullySettled !== t.settled) {
          await tx.transaction.update({ where: { id: txnId }, data: { settled: fullySettled, settledAt: fullySettled ? new Date() : null, updatedBy: user.id } });
        }
      }
      await writeAudit(tx, {
        actorUserId: user.id,
        action: 'CASH_DEBT_RECEIPT_CREATED',
        targetType: 'CashEntry',
        targetId: String(entry.id),
        after: auditSnapshot({ code: entry.code, amount: total, categoryId: input.categoryId, fundId: input.fundId, method, entryDate: entryDate.toISOString(), customerId: input.customerId ?? null, partnerId: input.partnerId ?? null, lines: lines.length, transactions: txnIds })
      });
      return entry;
    }));
  } catch (e) {
    if (e instanceof TxGuardError) return { ok: false, error: e.code, message: e.userMessage };
    throw e;
  }
  return { ok: true, id: created.id };
}

/**
 * CASHENTRY_CANCEL — hủy phiếu (POSTED→CANCELLED) nguyên tử + lý do. Conditional updateMany trong $transaction
 * (chống hủy 2 lần / race). Từ chối SOURCE_LOCKED cũng ghi audit. M3 — phiếu THU công nợ: gỡ settlement + tính
 * lại settled. M3b — phiếu THU bán thiết bị: gỡ deviceSaleSettlement. XÁC NHẬN MẬT KHẨU (§14) do ADAPTER kiểm
 * TRƯỚC khi gọi lõi (khớp customer.ts) — lõi KHÔNG kiểm password.
 */
export async function cancelCashEntry(ctx: ServiceCtx, id: number, reason: string): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'CASHENTRY_CANCEL')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const r = (reason ?? '').trim();
  if (!r) return { ok: false, error: 'VALIDATION', message: 'Vui lòng nhập lý do hủy phiếu.' };

  const row = await db.cashEntry.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Phiếu không tồn tại.' };

  // CHỈ phiếu thủ công (sourceType=null) và thu tiền bán máy (SALE_COLLECT) mới hủy TRỰC TIẾP được — hai loại
  // này có đường hoàn đối soát (M3/M3b) bên dưới. Phiếu hệ thống khác hủy tại đây sẽ làm quỹ lệch + mồ côi.
  if (row.sourceType !== null && row.sourceType !== 'SALE_COLLECT') {
    await writeAudit(db, { actorUserId: user.id, action: 'CASH_ENTRY_CANCELLED', targetType: 'CashEntry', targetId: String(id), after: { denied: true, reason: 'SOURCE_LOCKED', sourceType: row.sourceType } });
    return { ok: false, error: 'SOURCE_LOCKED', message: 'Phiếu này sinh tự động từ nghiệp vụ khác (cọc/thuê/bán máy/ghi giảm nợ xấu). Hãy hủy ở nghiệp vụ gốc, không hủy trực tiếp tại đây.' };
  }

  const cancelledAt = new Date();
  try {
    await db.$transaction(async (txc) => {
      const moved = await txc.cashEntry.updateMany({
        where: { id, status: 'POSTED', deletedAt: null },
        data: { status: 'CANCELLED', cancelReason: r, cancelledAt, updatedBy: user.id }
      });
      if (moved.count === 0) throw new TxGuardError('INVALID_STATE', 'Chỉ phiếu đang hiệu lực (đã ghi) mới hủy được.');

      // M3 — phiếu THU công nợ: gỡ settlement + TÍNH LẠI settled (net > 0 → settled=false).
      const settlements = await txc.cashDebtSettlement.findMany({ where: { cashEntryId: id }, select: { transactionId: true } });
      if (settlements.length > 0) {
        const affected = [...new Set(settlements.map((s) => s.transactionId))];
        // GD đã ghi giảm nợ xấu (write-off) là ĐÃ ĐÓNG → CHẶN hủy (write-off sẽ bị hụt số).
        const woRows = await txc.transaction.findMany({ where: { id: { in: affected }, writtenOffAt: { not: null } }, select: { id: true } });
        if (woRows.length > 0) {
          throw new TxGuardError('TXN_WRITTEN_OFF', `Không thể hủy: phiếu thu này tất toán giao dịch đã ghi giảm nợ xấu (GD #${woRows.map((w) => w.id).join(', #')}).`);
        }
        await txc.cashDebtSettlement.deleteMany({ where: { cashEntryId: id } });
        for (const txnId of affected) {
          const t = await txc.transaction.findUnique({ where: { id: txnId }, select: { revenuePartner: true, revenueSell: true, settled: true } });
          if (!t) continue;
          const agg = await txc.cashDebtSettlement.groupBy({ by: ['side'], where: { transactionId: txnId }, _sum: { amount: true } });
          const paid = new Map<string, number>();
          for (const a of agg) paid.set(a.side, Number(a._sum.amount ?? 0));
          const fullySettled = Number(t.revenuePartner) - (paid.get('PARTNER') ?? 0) <= 0 && Number(t.revenueSell) - (paid.get('SELL') ?? 0) <= 0;
          if (fullySettled !== t.settled) {
            await txc.transaction.update({ where: { id: txnId }, data: { settled: fullySettled, settledAt: fullySettled ? new Date() : null, updatedBy: user.id } });
          }
        }
      }
      // M3b — phiếu THU tiền BÁN THIẾT BỊ (SALE_COLLECT): gỡ dòng deviceSaleSettlement (remaining tính LIVE).
      await txc.deviceSaleSettlement.deleteMany({ where: { cashEntryId: id } });
      await writeAudit(txc, {
        actorUserId: user.id,
        action: 'CASH_ENTRY_CANCELLED',
        targetType: 'CashEntry',
        targetId: String(id),
        before: auditSnapshot({ code: row.code, kind: row.kind, amount: row.amount, status: row.status }),
        after: auditSnapshot({ status: 'CANCELLED', cancelReason: r })
      });
    });
  } catch (e) {
    if (e instanceof TxGuardError) return { ok: false, error: e.code, message: e.userMessage };
    throw e;
  }
  return { ok: true, id };
}
