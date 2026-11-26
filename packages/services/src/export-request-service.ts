// Yêu cầu XUẤT KHO POS/TID → DUYỆT → đối trừ tồn kho + tiền (PHASE 1 ENGINE, Admin Demo 13/7) — LÕI THUẦN ctx-based.
// PORT nghiệp vụ từ apps/desktop/src/main/export-request-service.ts. Mô hình: user thường TẠO phiếu N đơn vị CHƯA seri
// (không động tiền/kho); người có quyền Kho DUYỆT → chọn N seri/TID + trừ tiền + tồn kho trong 1 $transaction. Money-model
// TÁI DÙNG NGUYÊN per-máy: bookSaleCashEntries (device-sale.js) cho SALE, applyHandoverTx (RENT) + openDepositTx (cọc)
// từ deposit.js — KHÔNG nhân bản semantics tiền. KHUÔN (pos-supply/customer): ctx = { db, user }; mỗi hàm tự hasPermission.
// MẬT KHẨU người DUYỆT (§14) do ADAPTER route verify TRƯỚC khi gọi lõi (lõi KHÔNG kiểm password). ServiceCtx/MutationResult
// từ customer.js. writeAudit/writeAuditStrict/bumpChangeToken từ audit.js. nextCode(@sigma/services) nhận (client, prefix).
import { decidePosTransition, decideTidTransition, auditSnapshot, type PosStatus, type TidStatus } from '@sigma/business-rules';
import { hasPermission, parseVndStrict, serializeVnd, MAX_VND } from '@sigma/shared';
import { Prisma } from '@sigma/database';
import { writeAudit, writeAuditStrict, bumpChangeToken } from './audit.js';
import { nextCode } from './code.js';
import { bookSaleCashEntries } from './device-sale.js';
import { applyHandoverTx, openDepositTx } from './deposit.js';
import type { ServiceCtx, MutationResult } from './customer.js';
import { nhanBank } from './nhan-bank.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

type PrismaTx = Prisma.TransactionClient;

/** Sentinel: hủy $transaction với MutationResult thân thiện (giống device-sale SaleAbort). */
class ReqAbort extends Error {
  constructor(public readonly result: MutationResult) {
    super(result.message ?? result.error ?? 'ABORT');
  }
}
function isRetryablePg(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === '40P01' || code === '40001';
}
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ReqAbort) throw e;
      if (isRetryablePg(e)) { last = e; continue; }
      throw e;
    }
  }
  throw last;
}

/** VND nguyên → bigint. allowZero=false → bắt buộc > 0. Ném ReqAbort nếu không hợp lệ (parse THẲNG qua parseVndStrict). */
function toVnd(v: unknown, label: string, opts: { allowZero?: boolean } = {}): bigint {
  const bad = (): never => {
    throw new ReqAbort({ ok: false, error: 'VALIDATION', message: `${label} phải là số nguyên ${opts.allowZero ? '≥ 0' : '> 0'} (VND ≤ int8), không chấp nhận thập phân/mũ.` });
  };
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || !Number.isInteger(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) bad();
  }
  const parsed = parseVndStrict(typeof v === 'number' ? String(v) : v);
  if (parsed === null) bad();
  const amount = parsed as bigint;
  if (!opts.allowZero && amount === 0n) bad();
  return amount;
}

const KINDS = new Set(['POS', 'TID']);
const HANDOVER_KINDS = new Set(['SALE', 'RENT']);
const PRICE_MODES = new Set(['LISTED', 'CUSTOM']);
const PAYMENT_METHODS = new Set(['CASH', 'CK']); // P0-05 allowlist hình thức thanh toán

// ═════════════════════════════════════════════════════════════════════════════
// TẠO YÊU CẦU (không động tiền/kho — chỉ ghi phiếu PENDING)
// ═════════════════════════════════════════════════════════════════════════════
export interface CreateExportRequestInput {
  kind: string; // POS | TID
  handoverKind: string; // SALE | RENT
  withTid?: boolean;
  bankId?: number | null;
  partnerId?: number | null;
  customerId: number;
  cardTypeId?: number | null;
  feeTypeId?: number | null;
  priceMode?: string; // LISTED | CUSTOM
  unitPrice: string | number; // đơn giá 1 đơn vị (VND) > 0
  quantity: number; // > 0
  depositAmount?: string | number | null;
  paidAmount?: string | number | null;
  fundId?: number | null;
  method?: string | null; // CASH | CK
  requestedAt?: string | null;
  note?: string | null;
}

/** EXPORT_REQUEST_CREATE — user thường tạo phiếu yêu cầu xuất kho (chưa seri). Validate + amount=đơn giá×SL. */
export async function createExportRequest(ctx: ServiceCtx, input: CreateExportRequestInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'EXPORT_REQUEST_CREATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  try {
    const kind = String(input.kind ?? '').toUpperCase();
    if (!KINDS.has(kind)) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: 'Loại yêu cầu phải là POS hoặc TID.' });
    const handoverKind = String(input.handoverKind ?? '').toUpperCase();
    if (!HANDOVER_KINDS.has(handoverKind)) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: 'Hình thức xuất kho chỉ có Bán (SALE) hoặc Cho thuê (RENT).' });
    const priceMode = input.priceMode ? String(input.priceMode).toUpperCase() : 'LISTED';
    if (!PRICE_MODES.has(priceMode)) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: 'Chế độ giá phải là LISTED hoặc CUSTOM.' });

    // kind TID: kèm-máy phải quay về phiếu POS → withTid luôn false.
    const withTid = kind === 'POS' ? !!input.withTid : false;

    if (!Number.isInteger(input.quantity) || input.quantity < 1) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: 'Số lượng phải là số nguyên ≥ 1.' });
    const quantity = input.quantity;
    const unitPrice = toVnd(input.unitPrice, 'Đơn giá');
    const amount = unitPrice * BigInt(quantity);
    // G2: CHẶN overflow phép nhân bằng lỗi DOMAIN (VALIDATION) — KHÔNG để Prisma/int8 tự ném.
    if (amount > MAX_VND) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: `Thành tiền (đơn giá × số lượng) vượt trần cho phép (≤ ${MAX_VND} đồng).` });
    const depositAmount = toVnd(input.depositAmount ?? 0, 'Tiền cọc', { allowZero: true });
    const paidAmount = toVnd(input.paidAmount ?? 0, 'Tiền thu khi duyệt', { allowZero: true });

    if (handoverKind === 'RENT' && paidAmount > 0n) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: 'Cho thuê thu tiền qua đơn giá thuê khi duyệt — không nhập "tiền thu khi duyệt".' });
    if (paidAmount > amount) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: 'Tiền thu khi duyệt không được lớn hơn thành tiền (đơn giá × số lượng).' });

    if (!input.customerId) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: 'Phải chọn khách hàng.' });
    const cust = await db.customer.findFirst({ where: { id: input.customerId, deletedAt: null }, select: { id: true } });
    if (!cust) throw new ReqAbort({ ok: false, error: 'NOT_FOUND', message: 'Khách hàng không tồn tại (hoặc đã bị xóa).' });

    if (kind === 'TID' && !input.bankId) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: 'Yêu cầu TID phải chọn ngân hàng (khớp TID khi duyệt).' });
    if (input.bankId) {
      const bank = await db.bank.findFirst({ where: { id: input.bankId, deletedAt: null }, select: { id: true } });
      if (!bank) throw new ReqAbort({ ok: false, error: 'NOT_FOUND', message: 'Ngân hàng không tồn tại.' });
    }
    if (kind === 'TID' && !input.partnerId) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: 'Yêu cầu TID phải chọn đối tác (khớp TID khi duyệt).' });
    if (input.partnerId) {
      const partner = await db.partner.findFirst({ where: { id: input.partnerId, deletedAt: null }, select: { id: true } });
      if (!partner) throw new ReqAbort({ ok: false, error: 'NOT_FOUND', message: 'Đối tác không tồn tại.' });
    }
    if (input.cardTypeId) {
      const ct = await db.cardType.findFirst({ where: { id: input.cardTypeId, deletedAt: null }, select: { id: true } });
      if (!ct) throw new ReqAbort({ ok: false, error: 'NOT_FOUND', message: 'Loại thẻ không tồn tại.' });
    }
    if (input.feeTypeId) {
      const ft = await db.feeType.findFirst({ where: { id: input.feeTypeId, deletedAt: null }, select: { id: true } });
      if (!ft) throw new ReqAbort({ ok: false, error: 'NOT_FOUND', message: 'Loại phí không tồn tại.' });
    }
    const needsFund = paidAmount > 0n || depositAmount > 0n || handoverKind === 'RENT';
    if (needsFund && !input.fundId) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: 'Có thu tiền (bán/thuê/cọc) thì phải chọn quỹ nhận.' });
    if (input.fundId) {
      const fund = await db.fund.findFirst({ where: { id: input.fundId, deletedAt: null }, select: { id: true } });
      if (!fund) throw new ReqAbort({ ok: false, error: 'NOT_FOUND', message: 'Quỹ nhận tiền không tồn tại.' });
    }

    // Hình thức thanh toán (P0-05 ALLOWLIST): CASH | CK; giá trị lạ → VALIDATION (KHÔNG âm thầm ép CASH).
    const method = String(input.method ?? 'CASH').trim().toUpperCase();
    if (!PAYMENT_METHODS.has(method)) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: 'Hình thức thanh toán chỉ có Tiền mặt (CASH) hoặc Chuyển khoản (CK).' });
    const code = await nextCode(db, 'YCXK');
    // FE-01: ngày/giờ yêu cầu cho sửa — mặc định giờ hiện tại; client gửi thì phải là mốc hợp lệ.
    let requestedAt: Date | undefined;
    if (input.requestedAt) {
      const d = new Date(input.requestedAt);
      if (isNaN(d.getTime())) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: 'Ngày/giờ yêu cầu không hợp lệ.' });
      requestedAt = d;
    }
    const created = await db.exportRequest.create({
      data: {
        code, kind, handoverKind, withTid, requesterUserId: user.id,
        bankId: input.bankId ?? null, partnerId: input.partnerId ?? null, customerId: input.customerId,
        cardTypeId: input.cardTypeId ?? null, feeTypeId: input.feeTypeId ?? null, priceMode,
        unitPrice, quantity, amount, depositAmount, paidAmount, fundId: input.fundId ?? null, method,
        ...(requestedAt ? { requestedAt } : {}),
        status: 'PENDING', note: input.note?.trim() || null
      }
    });
    await writeAudit(db, {
      actorUserId: user.id, action: 'EXPORT_REQUEST_CREATED', targetType: 'ExportRequest', targetId: String(created.id),
      after: auditSnapshot({ code, kind, handoverKind, withTid, quantity, unitPrice: unitPrice.toString(), amount: amount.toString(), customerId: input.customerId })
    });
    return { ok: true, id: created.id };
  } catch (e) {
    if (e instanceof ReqAbort) return e.result;
    throw e;
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// DANH SÁCH + KPI
// ═════════════════════════════════════════════════════════════════════════════
export interface ExportRequestDto {
  id: number;
  code: string | null;
  kind: string;
  handoverKind: string;
  withTid: boolean;
  method: string;
  status: string;
  priceMode: string;
  unitPrice: string;
  quantity: number;
  amount: string;
  depositAmount: string;
  paidAmount: string;
  customerId: number;
  customerName: string | null;
  requesterUserId: number;
  requesterName: string | null;
  bankId: number | null;
  bankName: string | null;
  partnerId: number | null;
  feeTypeId: number | null;
  feeTypeName: string | null;
  fundId: number | null;
  note: string | null;
  requestedAt: string;
  decidedBy: number | null;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  isMine: boolean;
}
export interface ExportRequestKpi {
  pending: number;
  approved: number;
  rejected: number;
  cancelled: number;
  total: number;
}
export interface ExportRequestFilter {
  status?: string;
  kind?: string;
  mine?: boolean;
}

/** EXPORT_REQUEST_VIEW — danh sách phiếu + KPI đếm theo trạng thái (KPI bỏ qua bộ lọc status, giữ mine/kind). */
export async function listExportRequests(ctx: ServiceCtx, filter: ExportRequestFilter = {}): Promise<{ ok: boolean; data?: ExportRequestDto[]; kpi?: ExportRequestKpi; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'EXPORT_REQUEST_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const baseWhere: Prisma.ExportRequestWhereInput = {
    kind: filter.kind || undefined,
    requesterUserId: filter.mine ? user.id : undefined
  };
  const rows = await db.exportRequest.findMany({ where: { ...baseWhere, status: filter.status || undefined }, orderBy: { id: 'desc' } });
  const kpiRows = await db.exportRequest.groupBy({ by: ['status'], where: baseWhere, _count: true });
  const kpi: ExportRequestKpi = { pending: 0, approved: 0, rejected: 0, cancelled: 0, total: 0 };
  for (const r of kpiRows) {
    const c = r._count;
    kpi.total += c;
    if (r.status === 'PENDING') kpi.pending = c;
    else if (r.status === 'APPROVED') kpi.approved = c;
    else if (r.status === 'REJECTED') kpi.rejected = c;
    else if (r.status === 'CANCELLED') kpi.cancelled = c;
  }

  const custIds = [...new Set(rows.map((r) => r.customerId))];
  const custMap = new Map((await db.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, nickname: true, fullName: true } })).map((c) => [c.id, c.nickname || c.fullName]));
  const userIds = [...new Set(rows.flatMap((r) => [r.requesterUserId, r.decidedBy].filter((x): x is number => x != null)))];
  const userMap = new Map((await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, username: true } })).map((u) => [u.id, u.fullName || u.username]));
  const bankIds = [...new Set(rows.map((r) => r.bankId).filter((x): x is number => x != null))];
  const bankMap = new Map((await db.bank.findMany({ where: { id: { in: bankIds } }, select: { id: true, code: true, name: true } })).map((b) => [b.id, nhanBank(b) ?? '']));
  const feeIds = [...new Set(rows.map((r) => r.feeTypeId).filter((x): x is number => x != null))];
  const feeMap = new Map((await db.feeType.findMany({ where: { id: { in: feeIds } }, select: { id: true, name: true } })).map((f) => [f.id, f.name]));

  const data: ExportRequestDto[] = rows.map((r) => ({
    id: r.id, code: r.code, kind: r.kind, handoverKind: r.handoverKind, withTid: r.withTid, method: r.method, status: r.status,
    priceMode: r.priceMode, unitPrice: serializeVnd(r.unitPrice), quantity: r.quantity, amount: serializeVnd(r.amount),
    depositAmount: serializeVnd(r.depositAmount), paidAmount: serializeVnd(r.paidAmount),
    customerId: r.customerId, customerName: custMap.get(r.customerId) ?? null,
    requesterUserId: r.requesterUserId, requesterName: userMap.get(r.requesterUserId) ?? null,
    bankId: r.bankId, bankName: r.bankId != null ? bankMap.get(r.bankId) ?? null : null,
    partnerId: r.partnerId, feeTypeId: r.feeTypeId, feeTypeName: r.feeTypeId != null ? feeMap.get(r.feeTypeId) ?? null : null,
    fundId: r.fundId, note: r.note,
    requestedAt: r.requestedAt.toISOString(),
    decidedBy: r.decidedBy, decidedByName: r.decidedBy != null ? userMap.get(r.decidedBy) ?? null : null,
    decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null, decisionNote: r.decisionNote,
    isMine: r.requesterUserId === user.id
  }));
  return { ok: true, data, kpi };
}

// ═════════════════════════════════════════════════════════════════════════════
// DUYỆT — chọn N seri/TID + trừ tiền + tồn kho trong 1 $transaction
// ═════════════════════════════════════════════════════════════════════════════
export interface ApproveLineInput {
  seq: number; // 1..N (khớp quantity, không trùng)
  posSerial?: string | null;
  tid?: string | null;
}

/** Địa chỉ HIỆU LỰC của kho trong tx (mirror pos): manager address ưu tiên, else address cột kho. */
async function warehouseEffAddressTx(tx: PrismaTx, warehouseId: number): Promise<string | null> {
  const wh = await tx.warehouse.findFirst({ where: { id: warehouseId, deletedAt: null }, select: { address: true, managerUserId: true } });
  if (!wh) return null;
  if (wh.managerUserId != null) {
    const u = await tx.user.findUnique({ where: { id: wh.managerUserId }, select: { address: true } });
    return u?.address ?? null;
  }
  return wh.address;
}

interface ReqRow {
  id: number; kind: string; handoverKind: string; withTid: boolean; bankId: number | null;
  partnerId: number | null; customerId: number; unitPrice: bigint; quantity: number;
  depositAmount: bigint; fundId: number | null; method: string;
}

/** Gán TID KÈM MÁY (mirror tid assign, KHÔNG money — tiền áp riêng ở caller). dev đã khóa FOR UPDATE. */
async function assignTidLineTx(tx: PrismaTx, a: { tid: string; serial: string; customerId: number; occurredAt: Date; actorId: number }): Promise<void> {
  await tx.$queryRaw`SELECT id FROM tids WHERE tid = ${a.tid} FOR UPDATE`;
  const row = await tx.tid.findUnique({ where: { tid: a.tid } });
  if (!row || row.deletedAt) throw new ReqAbort({ ok: false, error: 'NOT_FOUND', message: `Không tìm thấy TID "${a.tid}" (giao kèm máy).` });
  const decision = decideTidTransition(row.status as TidStatus, 'assign');
  if (!decision.allowed) throw new ReqAbort({ ok: false, error: 'INVALID_STATE', message: `TID "${a.tid}" ở trạng thái ${row.status} không gán được (đã chết/đóng/thu hồi).` });
  if (row.posSerial != null) throw new ReqAbort({ ok: false, error: 'TID_ON_DEVICE', message: `TID "${a.tid}" đang gắn trên máy ${row.posSerial}.` });
  const dev = await tx.posDevice.findUnique({ where: { serial: a.serial } });
  if (!dev) throw new ReqAbort({ ok: false, error: 'NOT_FOUND', message: `Không tìm thấy máy POS "${a.serial}".` });
  if (dev.currentTid != null && dev.currentTid !== a.tid) throw new ReqAbort({ ok: false, error: 'DEVICE_HAS_TID', message: `Máy ${a.serial} đang gắn TID ${dev.currentTid}.` });
  if (dev.bankId == null) throw new ReqAbort({ ok: false, error: 'MACHINE_BLANK', message: `Máy POS "${a.serial}" là máy trắng (chưa cài app ngân hàng).` });
  if (dev.bankId !== row.bankId) throw new ReqAbort({ ok: false, error: 'BANK_MISMATCH', message: `Bank của TID "${a.tid}" không khớp app ngân hàng trên máy "${a.serial}".` });
  const devAgentId = dev.currentAgentId ?? null;
  // TID-2 (audit 20/8): gán TID KÈM MÁY cho khách = ĐÃ GIAO → set deliveredAt (mirror assignTid tid.ts). Thiếu
  // mốc này khiến TID đang trên máy khách thuê vẫn hiện "chưa giao" (vi phạm gán-POS-khách⟹đã-giao).
  await tx.tid.update({ where: { id: row.id }, data: { status: 'ACTIVE', posSerial: a.serial, customerId: a.customerId, agentId: devAgentId, deliveredAt: a.occurredAt } });
  // FINDING #1 (harness invariant 21/8): máy giao khách = DEPLOYED, PHẢI clear kho (I5 warehouseId⟺IN_STOCK,
  // I8 máy-gán-khách⟹không-kho). Trước đây deploy mà KHÔNG clear warehouseId → máy ở khách vẫn "trong kho",
  // phồng tồn kho. Mirror processPosLineTx SALE/RENT + assignTid tid.ts.
  const posPatch: Record<string, unknown> = { currentTid: a.tid, currentCustomerId: a.customerId, warehouseId: null, warehouseLoc: null, updatedBy: a.actorId };
  if (dev.status === 'IN_STOCK') posPatch.status = 'DEPLOYED';
  await tx.posDevice.update({ where: { id: dev.id }, data: posPatch });
  await tx.posTidBinding.create({ data: { posSerial: a.serial, tid: a.tid, boundAt: a.occurredAt } });
  await tx.assetEvent.create({
    data: {
      deviceSerial: a.serial, tid: a.tid, eventType: decision.eventType!, fromState: row.status, toState: 'ACTIVE',
      customerId: a.customerId, toAgentId: devAgentId, actorUserId: a.actorId, occurredAt: a.occurredAt,
      note: 'Giao kèm TID (duyệt yêu cầu xuất kho)', afterJson: JSON.stringify(auditSnapshot({ tid: a.tid, posSerial: a.serial, status: 'ACTIVE' }))
    }
  });
}

/** Xử lý 1 dòng POS khi duyệt: validate máy IN_STOCK + kho có địa chỉ + bank khớp + currentTid null, rồi
 *  SALE (sell + bookSaleCashEntries) hoặc RENT (deploy + applyHandover RENT). withTid → gán TID trước. */
async function processPosLineTx(tx: PrismaTx, req: ReqRow, serial: string, tid: string | null, allocPaid: bigint, occurredAt: Date, actorId: number): Promise<void> {
  // TID-4 (audit 21/8) — THỨ TỰ KHÓA TOÀN CỤC = tids TRƯỚC pos_devices (khớp assignTid/replaceTid/device-sale/pos).
  // Dòng giao KÈM TID: khóa hàng TID TRƯỚC khi khóa máy, nếu không sẽ ABBA-deadlock với assignTid (khóa tid→pos).
  // assignTidLineTx bên dưới khóa lại CHÍNH hàng này (no-op trong cùng tx) nên không tốn thêm.
  if (req.withTid && tid) {
    await tx.$queryRaw`SELECT id FROM tids WHERE tid = ${tid} FOR UPDATE`;
  }
  await tx.$queryRaw`SELECT id FROM pos_devices WHERE serial = ${serial} FOR UPDATE`;
  let dev = await tx.posDevice.findUnique({ where: { serial } });
  if (!dev || dev.deletedAt) throw new ReqAbort({ ok: false, error: 'NOT_FOUND', message: `Không tìm thấy máy POS serial "${serial}".` });
  if (dev.status !== 'IN_STOCK') throw new ReqAbort({ ok: false, error: 'INVALID_STATE', message: `Máy POS "${serial}" đang ở trạng thái ${dev.status} — chỉ xuất kho máy đang TRONG KHO (IN_STOCK).` });
  if (dev.currentTid != null) throw new ReqAbort({ ok: false, error: 'DEVICE_HAS_TID', message: `Máy POS "${serial}" đang gắn TID ${dev.currentTid} — không xuất kho được.` });
  if (req.bankId != null && dev.bankId !== req.bankId) throw new ReqAbort({ ok: false, error: 'BANK_MISMATCH', message: `App ngân hàng trên máy "${serial}" không khớp ngân hàng của yêu cầu.` });
  if (dev.warehouseId == null) throw new ReqAbort({ ok: false, error: 'NO_WAREHOUSE', message: `Máy POS "${serial}" chưa thuộc kho nào — máy phải ở kho có địa chỉ mới xuất được.` });
  const effAddr = await warehouseEffAddressTx(tx, dev.warehouseId);
  if (!(effAddr && effAddr.trim())) throw new ReqAbort({ ok: false, error: 'WAREHOUSE_NO_ADDRESS', message: `Kho của máy "${serial}" chưa có địa chỉ cụ thể (kiểm tra User quản lý kho).` });

  if (req.withTid) {
    if (!tid) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: `Dòng máy "${serial}" giao kèm TID nhưng chưa nhập TID.` });
    await assignTidLineTx(tx, { tid, serial, customerId: req.customerId, occurredAt, actorId });
    dev = await tx.posDevice.findUnique({ where: { serial } });
    if (!dev) throw new ReqAbort({ ok: false, error: 'NOT_FOUND', message: `Máy POS "${serial}" biến mất sau khi gán TID.` });
  }
  const srcWhId = dev.warehouseId;

  if (req.handoverKind === 'SALE') {
    const decision = decidePosTransition(dev.status as PosStatus, 'sell');
    if (!decision.allowed) throw new ReqAbort({ ok: false, error: 'INVALID_STATE', message: `Không thể bán máy "${serial}" ở trạng thái ${dev.status}.` });
    const code = await nextCode(tx, 'BS');
    const sale = await tx.deviceSale.create({
      data: {
        code, saleKind: 'POS', deviceSerial: serial, tid: dev.currentTid, customerId: req.customerId,
        salePrice: req.unitPrice, warehouseId: srcWhId, soldByUserId: actorId, occurredAt,
        note: 'Xuất kho (duyệt yêu cầu)', status: 'POSTED', createdBy: actorId
      }
    });
    if (dev.currentTid) {
      const trow = await tx.tid.findUnique({ where: { tid: dev.currentTid } });
      if (trow) {
        const td = decideTidTransition(trow.status as TidStatus, 'sell');
        const toTid = td.allowed ? td.to! : 'SOLD';
        await tx.tid.update({ where: { id: trow.id }, data: { status: toTid, posSerial: null, agentId: null, customerId: req.customerId } });
        await tx.posTidBinding.updateMany({ where: { posSerial: serial, tid: dev.currentTid, unboundAt: null }, data: { unboundAt: occurredAt, unbindReason: 'SOLD' } });
        await tx.assetEvent.create({ data: { deviceSerial: serial, tid: dev.currentTid, eventType: 'TID_SELL', fromState: trow.status, toState: toTid, customerId: req.customerId, actorUserId: actorId, occurredAt, note: `Bán kèm máy (${code})`, afterJson: JSON.stringify(auditSnapshot({ tid: dev.currentTid, soldWith: serial, status: toTid })) } });
      }
    }
    const fromState = dev.status;
    await tx.posDevice.update({ where: { id: dev.id }, data: { status: 'SOLD', currentTid: null, currentCustomerId: req.customerId, currentAgentId: null, recallPending: false, warehouseId: null, warehouseLoc: null, updatedBy: actorId } });
    await tx.assetEvent.create({ data: { deviceSerial: serial, tid: null, eventType: decision.eventType!, fromState, toState: 'SOLD', customerId: req.customerId, actorUserId: actorId, occurredAt, fromWarehouseId: srcWhId, deliveryAddress: effAddr, note: 'Xuất kho bán (duyệt yêu cầu)', afterJson: JSON.stringify(auditSnapshot({ sale: code, salePrice: req.unitPrice.toString(), customerId: req.customerId })) } });
    await bookSaleCashEntries(tx, { saleId: sale.id, saleKind: 'POS', salePrice: req.unitPrice, paid: allocPaid, fundId: req.fundId ?? null, method: req.method, entryDate: occurredAt, customerId: req.customerId, userId: actorId });
    return;
  }

  // RENT — giao thuê. withTid=false → deploy (IN_STOCK→DEPLOYED); withTid=true → assign đã đưa về DEPLOYED.
  if (!req.withTid) {
    const decision = decidePosTransition(dev.status as PosStatus, 'deploy');
    if (!decision.allowed) throw new ReqAbort({ ok: false, error: 'INVALID_STATE', message: `Không thể giao thuê máy "${serial}" ở trạng thái ${dev.status}.` });
    const fromState = dev.status;
    await tx.posDevice.update({ where: { id: dev.id }, data: { status: 'DEPLOYED', currentCustomerId: req.customerId, recallPending: false, warehouseId: null, warehouseLoc: null, updatedBy: actorId } });
    await tx.assetEvent.create({ data: { deviceSerial: serial, tid: null, eventType: decision.eventType!, fromState, toState: 'DEPLOYED', customerId: req.customerId, actorUserId: actorId, occurredAt, fromWarehouseId: srcWhId, deliveryAddress: effAddr, note: 'Xuất kho cho thuê (duyệt yêu cầu)', afterJson: JSON.stringify(auditSnapshot({ status: 'DEPLOYED', customerId: req.customerId })) } });
  }
  await applyHandoverTx(tx, { moneyKind: 'RENT', handoverTypeId: null, amount: req.unitPrice, fundId: req.fundId ?? null, method: req.method, deviceSerial: serial, tid: dev.currentTid, customerId: req.customerId, occurredAt, actorId });
}

/** Xử lý 1 dòng TID (kind TID, withTid=false): validate TID chưa giao + bank khớp + đối tác khớp → markTidDelivered. */
async function processTidLineTx(tx: PrismaTx, req: ReqRow, tid: string, allocPaid: bigint, occurredAt: Date, actorId: number): Promise<void> {
  await tx.$queryRaw`SELECT id FROM tids WHERE tid = ${tid} FOR UPDATE`;
  const row = await tx.tid.findUnique({ where: { tid } });
  if (!row || row.deletedAt) throw new ReqAbort({ ok: false, error: 'NOT_FOUND', message: `Không tìm thấy TID "${tid}".` });
  // RECALLED-REUSE (Agent-3 1/9 F1): TID THU HỒI GIỮ `deliveredAt` (recall không xoá). markTidDelivered canonical
  // (tid.ts) 1/9 CHO giao lại TID RECALLED (delivered && status!=='RECALLED' mới chặn). Path duyệt-xuất-kho này TRƯỚC
  // ĐÂY chặn cứng `deliveredAt != null` → RECALLED không giao lại được (báo nhầm), LỆCH path TID-page. Mirror canonical.
  if (row.deliveredAt != null && row.status !== 'RECALLED') throw new ReqAbort({ ok: false, error: 'ALREADY_DELIVERED', message: `TID "${tid}" đã được giao trước đó.` });
  // REL-08: TID còn GẮN TRÊN MÁY (posSerial≠null) KHÔNG được xuất lẻ (POS_SALE_DEBT §31).
  if (row.posSerial != null) throw new ReqAbort({ ok: false, error: 'TID_ON_DEVICE', message: `TID "${tid}" đang gắn trên máy ${row.posSerial} — xuất/bán kèm máy, không xuất lẻ.` });
  if (req.bankId != null && row.bankId !== req.bankId) throw new ReqAbort({ ok: false, error: 'BANK_MISMATCH', message: `Ngân hàng của TID "${tid}" không khớp yêu cầu.` });
  if (req.partnerId != null && row.partnerId !== req.partnerId) throw new ReqAbort({ ok: false, error: 'PARTNER_MISMATCH', message: `Đối tác của TID "${tid}" không khớp yêu cầu.` });
  // TID-1 (audit 20/8) — GUARD TRẠNG THÁI terminal (không chỉ deliveredAt): DEAD/CLOSED/RECALLED/SOLD KHÔNG giao lại
  // được (chống re-giao TID chết đã thay → đặt lại delivered⟹ACTIVE). SALE nhánh dưới có 'sell' guard riêng.
  const delDecision = decideTidTransition(row.status as TidStatus, 'deliver');
  if (!delDecision.allowed) throw new ReqAbort({ ok: false, error: delDecision.reason ?? 'INVALID_STATE', message: `Không thể giao TID "${tid}" đang ở trạng thái ${row.status}.` });
  const customerId = req.customerId;
  const toAgentId = row.agentId ?? null;
  // TID-3 (audit 20/8): giao lẻ = phải kích hoạt. Promote UNASSIGNED→ACTIVE khi giao (mirror deliverTidWithinTx/
  // markTidDelivered — CHỈ nâng từ UNASSIGNED, không đụng trạng thái khác). Trước đây RENT chỉ set deliveredAt mà
  // không nâng status → TID đã-giao nhưng vẫn UNASSIGNED (vi phạm delivered⟹ACTIVE). SALE ghi đè status→SOLD ở dưới.
  // Reactivate: UNASSIGNED HOẶC RECALLED → ACTIVE (mirror deliverTidWithinTx). RECALLED phải clear `closedAt` (thu hồi
  // đã set) — nếu không TID giao lại vẫn còn closedAt → vi phạm bất biến. Trạng thái khác (ACTIVE...) giữ nguyên.
  const reactivate = row.status === 'RECALLED';
  await tx.tid.update({ where: { id: row.id }, data: { status: (row.status === 'UNASSIGNED' || reactivate) ? 'ACTIVE' : undefined, closedAt: reactivate ? null : undefined, deliveredAt: occurredAt, customerId, agentId: toAgentId } });
  await tx.assetEvent.create({
    data: { deviceSerial: row.posSerial, tid, eventType: 'TID_DELIVERED', fromState: row.status, toState: row.status, customerId, toAgentId, actorUserId: actorId, occurredAt, note: 'Giao TID (duyệt yêu cầu xuất kho)' }
  });
  // #2 (Bán TID có doanh thu) — SALE → chứng từ bán TID (SALE_TID) + doanh thu; RENT → doanh thu cho thuê 1 lần.
  if (req.handoverKind === 'SALE') {
    // REL-07/DATA-01: bán TID qua DUYỆT XUẤT KHO PHẢI đưa TID về SOLD (POS_SALE_DEBT §29-31).
    const td = decideTidTransition(row.status as TidStatus, 'sell');
    if (!td.allowed) throw new ReqAbort({ ok: false, error: td.reason ?? 'INVALID_STATE', message: `Không thể bán TID "${tid}" ở trạng thái ${row.status}.` });
    const code = await nextCode(tx, 'BS');
    const sale = await tx.deviceSale.create({
      data: {
        code, saleKind: 'TID', deviceSerial: row.posSerial, tid, customerId, salePrice: req.unitPrice,
        warehouseId: null, soldByUserId: actorId, occurredAt, note: 'Bán TID (duyệt yêu cầu xuất kho)', status: 'POSTED', createdBy: actorId
      }
    });
    await bookSaleCashEntries(tx, { saleId: sale.id, saleKind: 'TID', salePrice: req.unitPrice, paid: allocPaid, fundId: req.fundId ?? null, method: req.method, entryDate: occurredAt, customerId, userId: actorId });
    await tx.tid.update({ where: { id: row.id }, data: { status: td.to ?? 'SOLD', posSerial: null, agentId: null } });
    await tx.assetEvent.create({
      data: { deviceSerial: row.posSerial, tid, eventType: 'TID_SELL', fromState: row.status, toState: td.to ?? 'SOLD', customerId, actorUserId: actorId, occurredAt, note: `Bán TID sang SOLD (duyệt xuất kho, ${code})` }
    });
  } else {
    await applyHandoverTx(tx, { moneyKind: 'RENT', handoverTypeId: null, amount: req.unitPrice, fundId: req.fundId ?? null, method: req.method, deviceSerial: row.posSerial, tid, customerId, occurredAt, actorId });
  }
  // INVARIANT HARNESS (F2 deep-audit 1/9): path này REIMPLEMENT chuyển-trạng-thái TID (không gọi core) → dễ drift
  // (F1 đã là 1 ca). Khẳng định BẤT BIẾN TID-level SAU MỌI mutation → ném lỗi (rollback tx) nếu vỡ, thay vì âm thầm.
  await assertTidInvariants(tx, row.id);
}

/** Khẳng định bất biến TID-level (deep-audit 1/9) — gọi sau mutation trên path reimplement. posSerial⟹ACTIVE (gắn máy
 *  = đang chạy) · ACTIVE⟹closedAt null (đang chạy chưa đóng) · RECALLED/CLOSED/DEAD/SOLD KHÔNG posSerial. Vỡ → ném. */
async function assertTidInvariants(tx: PrismaTx, tidId: number): Promise<void> {
  const t = await tx.tid.findUnique({ where: { id: tidId }, select: { tid: true, status: true, posSerial: true, closedAt: true } });
  if (!t) return;
  if (t.posSerial != null && t.status !== 'ACTIVE') throw new ReqAbort({ ok: false, error: 'TID_INVARIANT', message: `Bất biến vỡ: TID ${t.tid} còn gắn máy (${t.posSerial}) nhưng status=${t.status} (phải ACTIVE).` });
  if (t.status === 'ACTIVE' && t.closedAt != null) throw new ReqAbort({ ok: false, error: 'TID_INVARIANT', message: `Bất biến vỡ: TID ${t.tid} ACTIVE nhưng còn closedAt.` });
}

/** EXPORT_REQUEST_APPROVE — duyệt phiếu: chọn N seri/TID + trừ tiền/tồn kho trong 1 $transaction guard PENDING.
 *  Self-duyệt CHỈ Admin (elevated) — chốt = MẬT KHẨU (route verify TRƯỚC). Dòng bất hợp lệ → ABORT toàn bộ. */
export async function approveExportRequest(ctx: ServiceCtx, requestId: number, lines: ApproveLineInput[], note?: string): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'EXPORT_REQUEST_APPROVE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const req = await db.exportRequest.findUnique({ where: { id: requestId } });
  if (!req) return { ok: false, error: 'NOT_FOUND', message: 'Yêu cầu xuất kho không tồn tại.' };
  if (req.status !== 'PENDING') return { ok: false, error: 'INVALID_STATE', message: 'Yêu cầu đã được xử lý (không còn chờ duyệt).' };

  // Phân vai: người TẠO ≠ người DUYỆT, trừ elevated (tự duyệt được, chốt = mật khẩu ở route).
  const isSelf = user.id === req.requesterUserId;
  // Kiểm PERMISSION (không so sánh tên role trực tiếp) — đồng quy ước approval-service/entity-cancel. Mã
  // EXPORT_REQUEST_APPROVE_ELEVATED nay đã có trong catalog (packages/shared permissions.ts): ADMIN auto nhận qua
  // [...PERMISSION_CODES] + R_ADMIN_SUPERUSER sync mỗi boot (db.ts) + migration seed cho DB server (sigma);
  // MANAGER/WAREHOUSE KHÔNG có → không tự duyệt phiếu của mình.
  const elevated = hasPermission(user, 'EXPORT_REQUEST_APPROVE_ELEVATED');
  let selfNote: string | null = null;
  if (isSelf) {
    if (elevated) selfNote = 'Admin tự duyệt (đã nhập mật khẩu)';
    else {
      await writeAudit(db, { actorUserId: user.id, action: 'EXPORT_REQUEST_APPROVED', targetType: 'ExportRequest', targetId: String(requestId), after: { denied: true, reason: 'SELF_APPROVAL_FORBIDDEN' } });
      return { ok: false, error: 'SELF_APPROVAL_FORBIDDEN', message: 'Chỉ Admin mới được tự duyệt yêu cầu của chính mình.' };
    }
  }

  // Validate SỐ DÒNG = số lượng + seq 1..N duy nhất.
  const arr = Array.isArray(lines) ? lines : [];
  if (arr.length !== req.quantity) return { ok: false, error: 'VALIDATION', message: `Phải chọn đúng ${req.quantity} đơn vị (đang có ${arr.length} dòng).` };
  const seqs = new Set<number>();
  for (const l of arr) {
    if (!Number.isInteger(l.seq) || l.seq < 1 || l.seq > req.quantity) return { ok: false, error: 'VALIDATION', message: `Số thứ tự dòng phải trong 1..${req.quantity}.` };
    if (seqs.has(l.seq)) return { ok: false, error: 'VALIDATION', message: `Số thứ tự dòng ${l.seq} bị trùng.` };
    seqs.add(l.seq);
    if (req.kind === 'POS' && !l.posSerial?.trim()) return { ok: false, error: 'VALIDATION', message: `Dòng ${l.seq}: phải chọn serial máy POS.` };
    if (req.kind === 'TID' && !l.tid?.trim()) return { ok: false, error: 'VALIDATION', message: `Dòng ${l.seq}: phải chọn TID.` };
    if (req.kind === 'POS' && req.withTid && !l.tid?.trim()) return { ok: false, error: 'VALIDATION', message: `Dòng ${l.seq}: giao kèm TID nhưng chưa chọn TID.` };
  }
  const posSerials = arr.map((l) => l.posSerial?.trim()).filter((x): x is string => !!x);
  if (new Set(posSerials).size !== posSerials.length) return { ok: false, error: 'VALIDATION', message: 'Có serial máy bị chọn trùng ở nhiều dòng.' };
  const tids = arr.map((l) => l.tid?.trim()).filter((x): x is string => !!x);
  if (new Set(tids).size !== tids.length) return { ok: false, error: 'VALIDATION', message: 'Có TID bị chọn trùng ở nhiều dòng.' };

  const sorted = [...arr].sort((a, b) => a.seq - b.seq);
  const reqRow: ReqRow = {
    id: req.id, kind: req.kind, handoverKind: req.handoverKind, withTid: req.withTid, bankId: req.bankId,
    partnerId: req.partnerId, customerId: req.customerId, unitPrice: req.unitPrice, quantity: req.quantity,
    depositAmount: req.depositAmount, fundId: req.fundId, method: req.method
  };
  // Phân bổ paidAmount xuống các dòng SALE — giữ Σ = paidAmount; mỗi dòng ≤ đơn giá.
  const allocPaid = new Map<number, bigint>();
  if (req.handoverKind === 'SALE') {
    let remaining = req.paidAmount;
    for (const l of sorted) {
      const a = remaining > req.unitPrice ? req.unitPrice : remaining;
      allocPaid.set(l.seq, a);
      remaining -= a;
    }
  }
  const occurredAt = new Date();
  const decidedNote = [note?.trim() || null, selfNote].filter(Boolean).join(' · ') || null;

  try {
    await withRetry(async () => {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM export_requests WHERE id = ${requestId} FOR UPDATE`;
        const fresh = await tx.exportRequest.findUnique({ where: { id: requestId }, select: { status: true } });
        if (!fresh || fresh.status !== 'PENDING') throw new ReqAbort({ ok: false, error: 'ALREADY_DECIDED', message: 'Yêu cầu đã được xử lý (không còn chờ duyệt).' });

        for (const l of sorted) {
          if (reqRow.kind === 'POS') await processPosLineTx(tx, reqRow, l.posSerial!.trim(), l.tid?.trim() ?? null, allocPaid.get(l.seq) ?? 0n, occurredAt, user.id);
          else await processTidLineTx(tx, reqRow, l.tid!.trim(), allocPaid.get(l.seq) ?? 0n, occurredAt, user.id);
        }

        if (reqRow.depositAmount > 0n) {
          if (reqRow.fundId == null) throw new ReqAbort({ ok: false, error: 'VALIDATION', message: 'Có tiền cọc thì phải có quỹ nhận.' });
          await openDepositTx(tx, { customerId: reqRow.customerId, deviceSerial: null, tid: null, handoverTypeId: null, amount: reqRow.depositAmount, fundId: reqRow.fundId, method: req.method, occurredAt, actorId: user.id, note: `Cọc kèm yêu cầu xuất kho ${req.code ?? req.id}` });
        }

        for (const l of sorted) {
          await tx.exportRequestLine.create({ data: { exportRequestId: req.id, seq: l.seq, posSerial: l.posSerial?.trim() || null, tid: l.tid?.trim() || null } });
        }
        const moved = await tx.exportRequest.updateMany({ where: { id: req.id, status: 'PENDING' }, data: { status: 'APPROVED', decidedBy: user.id, decidedAt: occurredAt, decisionNote: decidedNote } });
        if (moved.count === 0) throw new ReqAbort({ ok: false, error: 'ALREADY_DECIDED', message: 'Yêu cầu đã được xử lý.' });
        // G1: audit NGHIÊM trong $transaction với trừ tiền/tồn kho → audit fail thì rollback cả phiếu.
        await writeAuditStrict(tx, {
          actorUserId: user.id, action: 'EXPORT_REQUEST_APPROVED', targetType: 'ExportRequest', targetId: String(req.id),
          after: auditSnapshot({ code: req.code, kind: req.kind, handoverKind: req.handoverKind, quantity: req.quantity, lines: sorted.map((l) => ({ seq: l.seq, posSerial: l.posSerial ?? null, tid: l.tid ?? null })), note: decidedNote })
        });
      });
    });
  } catch (e) {
    if (e instanceof ReqAbort) return e.result;
    throw e;
  }
  await bumpChangeToken(db, 'ExportRequest');
  return { ok: true, id: req.id };
}

/** EXPORT_REQUEST_APPROVE — từ chối phiếu PENDING (bắt buộc lý do). Không động tiền/kho. */
export async function rejectExportRequest(ctx: ServiceCtx, requestId: number, note: string): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'EXPORT_REQUEST_APPROVE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const reason = (note ?? '').trim();
  if (!reason) return { ok: false, error: 'VALIDATION', message: 'Vui lòng nhập lý do từ chối.' };
  const req = await db.exportRequest.findUnique({ where: { id: requestId }, select: { id: true, status: true, code: true } });
  if (!req) return { ok: false, error: 'NOT_FOUND', message: 'Yêu cầu xuất kho không tồn tại.' };
  if (req.status !== 'PENDING') return { ok: false, error: 'INVALID_STATE', message: 'Yêu cầu đã được xử lý.' };
  const moved = await db.exportRequest.updateMany({ where: { id: requestId, status: 'PENDING' }, data: { status: 'REJECTED', decidedBy: user.id, decidedAt: new Date(), decisionNote: reason } });
  if (moved.count === 0) return { ok: false, error: 'INVALID_STATE', message: 'Yêu cầu đã được xử lý.' };
  await writeAudit(db, { actorUserId: user.id, action: 'EXPORT_REQUEST_REJECTED', targetType: 'ExportRequest', targetId: String(requestId), after: auditSnapshot({ code: req.code, note: reason }) });
  return { ok: true, id: requestId };
}

/** EXPORT_REQUEST_CREATE — người TẠO tự hủy phiếu PENDING của mình (hoặc người có quyền duyệt hủy giúp). */
export async function cancelExportRequest(ctx: ServiceCtx, requestId: number, note?: string): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'EXPORT_REQUEST_CREATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const req = await db.exportRequest.findUnique({ where: { id: requestId }, select: { id: true, status: true, code: true, requesterUserId: true } });
  if (!req) return { ok: false, error: 'NOT_FOUND', message: 'Yêu cầu xuất kho không tồn tại.' };
  if (req.requesterUserId !== user.id && !hasPermission(user, 'EXPORT_REQUEST_APPROVE')) {
    return { ok: false, error: 'FORBIDDEN', message: 'Chỉ người tạo phiếu (hoặc người có quyền duyệt) mới hủy được.' };
  }
  if (req.status !== 'PENDING') return { ok: false, error: 'INVALID_STATE', message: 'Chỉ hủy được phiếu đang chờ duyệt.' };
  const moved = await db.exportRequest.updateMany({ where: { id: requestId, status: 'PENDING' }, data: { status: 'CANCELLED', decidedBy: user.id, decidedAt: new Date(), decisionNote: note?.trim() || null } });
  if (moved.count === 0) return { ok: false, error: 'INVALID_STATE', message: 'Yêu cầu đã được xử lý.' };
  await writeAudit(db, { actorUserId: user.id, action: 'EXPORT_REQUEST_CANCELLED', targetType: 'ExportRequest', targetId: String(requestId), after: auditSnapshot({ code: req.code, note: note?.trim() || null }) });
  return { ok: true, id: requestId };
}
