// Bán máy / Bán TID + công nợ mua thiết bị — LÕI THUẦN ctx-based. PORT nghiệp vụ từ
// apps/desktop/src/main/device-sale-service.ts (IMS_SPEC POS_SALE_DEBT). Thay requirePermission bằng ctx = { db, user };
// hasPermission(ctx.user, DEVICE_SALE_MANAGE/VIEW). Kế toán khóa: doanh thu ghi ĐỦ NGAY (CashEntry THU SALE_POS/
// SALE_TID, fundId=null accrual) + tiền thu (SALE_COLLECT vào quỹ + DeviceSaleSettlement). Khóa hàng tids TRƯỚC
// pos_devices/device_sales FOR UPDATE + retry deadlock. XÁC NHẬN MẬT KHẨU (§14, bán) do ADAPTER kiểm TRƯỚC khi gọi
// lõi — lõi KHÔNG kiểm password (khớp customer.ts). nextCode(@sigma/services) nhận (client, prefix). MutationResult/
// ServiceCtx từ customer.js. bookSaleCashEntries = helper tx (nhận tx) tái dùng bởi xuất kho (không nhân bản tiền).
import { decidePosTransition, decideTidTransition, auditSnapshot, type PosStatus, type TidStatus } from '@sigma/business-rules';
import { Prisma, type Db } from '@sigma/database';
import { hasPermission } from '@sigma/shared';
import { writeAuditStrict, bumpChangeToken } from './audit.js';
import { nextCode } from './code.js';
import { flagStrandedDepositsTx } from './deposit.js';
import { type ServiceCtx, type MutationResult } from './customer.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

/** Sentinel: hủy $transaction với MutationResult thân thiện. */
class SaleAbort extends Error {
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
      if (e instanceof SaleAbort) throw e;
      if (isRetryablePg(e)) { last = e; continue; }
      throw e;
    }
  }
  throw last;
}

/** VND nguyên dương từ input number. Ném SaleAbort nếu không hợp lệ. */
function money(v: unknown, label: string, opts: { allowZero?: boolean } = {}): bigint {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || (!opts.allowZero && n === 0)) {
    throw new SaleAbort({ ok: false, error: 'VALIDATION', message: `${label} phải là số nguyên ${opts.allowZero ? '≥ 0' : '> 0'} (VND).` });
  }
  return BigInt(n);
}

async function catIdBySourceKind(tx: Prisma.TransactionClient, sourceKind: string): Promise<number> {
  const c = await tx.cashCategory.findFirst({ where: { sourceKind, deletedAt: null }, select: { id: true } });
  if (!c) throw new SaleAbort({ ok: false, error: 'CONFIG', message: `Thiếu danh mục thu (${sourceKind}). Liên hệ quản trị.` });
  return c.id;
}

export interface SellPosInput {
  customerId: number;
  salePrice: number;
  paidNow?: number; // thu ngay (0..salePrice); > 0 cần fundId + method
  fundId?: number | null;
  method?: string | null; // CK | CASH
  warehouseId?: number | null;
  occurredAt?: string | null;
  note?: string | null;
}
export interface SellTidInput {
  customerId: number;
  salePrice: number;
  paidNow?: number;
  fundId?: number | null;
  method?: string | null;
  occurredAt?: string | null;
  note?: string | null;
}

function parseWhen(iso?: string | null): Date {
  if (!iso) return new Date();
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date() : d;
}
function normMethod(m?: string | null): string {
  return m === 'CK' ? 'CK' : 'CASH';
}

/** Kiểm khách mua tồn tại + tiền hợp lệ + (nếu thu ngay) quỹ. Trả {salePrice, paid}. */
async function validateSaleMoney(
  db: Db,
  input: { customerId: number; salePrice: number; paidNow?: number; fundId?: number | null; method?: string | null }
): Promise<{ salePrice: bigint; paid: bigint }> {
  if (!input.customerId) throw new SaleAbort({ ok: false, error: 'VALIDATION', message: 'Phải chọn khách mua.' });
  const cust = await db.customer.findFirst({ where: { id: input.customerId, deletedAt: null }, select: { id: true } });
  if (!cust) throw new SaleAbort({ ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy khách mua (hoặc đã bị xóa).' });
  const salePrice = money(input.salePrice, 'Giá bán');
  const paid = money(input.paidNow ?? 0, 'Số tiền thu', { allowZero: true });
  if (paid > salePrice) throw new SaleAbort({ ok: false, error: 'VALIDATION', message: 'Số tiền thu không được lớn hơn giá bán.' });
  if (paid > 0n) {
    if (!input.fundId) throw new SaleAbort({ ok: false, error: 'VALIDATION', message: 'Có thu tiền thì phải chọn quỹ nhận.' });
    const fund = await db.fund.findFirst({ where: { id: input.fundId, deletedAt: null }, select: { id: true } });
    if (!fund) throw new SaleAbort({ ok: false, error: 'NOT_FOUND', message: 'Quỹ nhận tiền không tồn tại.' });
  }
  return { salePrice, paid };
}

/** DEVICE_SALE_MANAGE — bán đứt 1 máy POS (kèm TID nếu đang gắn). Mật khẩu xác nhận (§14) do ADAPTER kiểm TRƯỚC. */
export async function sellPos(ctx: ServiceCtx, serial: string, input: SellPosInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'DEVICE_SALE_MANAGE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const occurredAt = parseWhen(input.occurredAt);
  const method = normMethod(input.method);
  try {
    const money2 = await validateSaleMoney(db, input);
    const result = await withRetry(async () => {
      const dirty = await db.posDevice.findUnique({ where: { serial }, select: { currentTid: true } });
      const dirtyTid = dirty?.currentTid ?? null;
      return await db.$transaction(async (tx) => {
        if (dirtyTid) await tx.$queryRaw`SELECT id FROM tids WHERE tid = ${dirtyTid} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM pos_devices WHERE serial = ${serial} FOR UPDATE`;
        const dev = await tx.posDevice.findUnique({ where: { serial } });
        if (!dev || dev.deletedAt) throw new SaleAbort({ ok: false, error: 'NOT_FOUND', message: `Không tìm thấy máy POS serial "${serial}".` });
        if ((dev.currentTid ?? null) !== dirtyTid) throw new SaleAbort({ ok: false, error: 'CONFLICT', message: 'Máy vừa thay đổi, thử lại.' });
        const decision = decidePosTransition(dev.status as PosStatus, 'sell');
        if (!decision.allowed) throw new SaleAbort({ ok: false, error: decision.reason, message: `Không thể bán máy đang ở trạng thái ${dev.status}.` });

        const code = await nextCode(tx, 'BS');
        // ĐỒNG BỘ kho: máy bán XUẤT TỪ kho đang chứa nó (nguồn sự thật dev.warehouseId); legacy null → input.
        const soldFromWh = dev.warehouseId ?? input.warehouseId ?? null;
        const sale = await tx.deviceSale.create({
          data: {
            code, saleKind: 'POS', deviceSerial: serial, tid: dev.currentTid, customerId: input.customerId,
            salePrice: money2.salePrice, warehouseId: soldFromWh, soldByUserId: user.id,
            occurredAt, note: input.note?.trim() || null, status: 'POSTED', createdBy: user.id
          }
        });

        // TID bán kèm (nếu có): → SOLD, đóng binding, sang khách mua.
        if (dev.currentTid) {
          const trow = await tx.tid.findUnique({ where: { tid: dev.currentTid } });
          if (trow) {
            const td = decideTidTransition(trow.status as TidStatus, 'sell');
            const toTid = td.allowed ? td.to! : 'SOLD';
            await tx.tid.update({ where: { id: trow.id }, data: { status: toTid, posSerial: null, agentId: null, customerId: input.customerId } });
            await tx.posTidBinding.updateMany({ where: { posSerial: serial, tid: dev.currentTid, unboundAt: null }, data: { unboundAt: occurredAt, unbindReason: 'SOLD' } });
            await tx.assetEvent.create({
              data: { deviceSerial: serial, tid: dev.currentTid, eventType: 'TID_SELL', fromState: trow.status, toState: toTid, customerId: input.customerId, actorUserId: user.id, occurredAt, note: `Bán kèm máy (${code})`, afterJson: JSON.stringify(auditSnapshot({ tid: dev.currentTid, soldWith: serial, status: toTid })) }
            });
          }
        }

        // Máy → ĐÃ BÁN (RỜI tồn kho → warehouseId=null giữ bất biến), khách = người mua, gỡ TID, hết chờ-thu-hồi.
        const fromState = dev.status;
        await tx.posDevice.update({ where: { id: dev.id }, data: { status: 'SOLD', currentTid: null, currentCustomerId: input.customerId, currentAgentId: null, recallPending: false, warehouseId: null, warehouseLoc: null, updatedBy: user.id } });
        await tx.assetEvent.create({
          data: { deviceSerial: serial, tid: dev.currentTid, eventType: 'SELL', fromState, toState: 'SOLD', customerId: input.customerId, actorUserId: user.id, occurredAt, fromWarehouseId: soldFromWh, note: input.note?.trim() || null, afterJson: JSON.stringify(auditSnapshot({ sale: code, salePrice: money2.salePrice.toString(), customerId: input.customerId })) }
        });

        await bookSaleCashEntries(tx, { saleId: sale.id, saleKind: 'POS', salePrice: money2.salePrice, paid: money2.paid, fundId: input.fundId ?? null, method, entryDate: occurredAt, customerId: input.customerId, userId: user.id });
        // CỌC KẸT (Admin Demo 11/8): máy vừa rời DEPLOYED → recall không gọi được nữa. KHÔNG tự hoàn/chặn — chỉ ghi
        // breadcrumb để nhắc hoàn TAY (refundDepositManual) khi có bill. Cọc GIỮ nguyên OPEN (không mất dấu).
        await flagStrandedDepositsTx(tx, { serial, reason: 'SOLD', actorId: user.id, occurredAt });
        // G1 — audit NGHIÊM TRONG tx (tier-1 tiền): DEVICE_SOLD phải commit cùng bút toán, không best-effort ngoài tx.
        await writeAuditStrict(tx, { actorUserId: user.id, action: 'DEVICE_SOLD', targetType: 'DeviceSale', targetId: String(sale.id), after: auditSnapshot({ code, serial, salePrice: money2.salePrice.toString(), paidNow: money2.paid.toString(), customerId: input.customerId }) });
        return { ok: true, id: sale.id } as MutationResult;
      });
    });
    const meta = result as MutationResult;
    await bumpChangeToken(db, 'DeviceSale');
    return { ok: true, id: meta.id };
  } catch (e) {
    if (e instanceof SaleAbort) return e.result;
    throw e;
  }
}

/** DEVICE_SALE_MANAGE — bán 1 TID riêng lẻ (chưa trên máy, chưa giao). Mật khẩu do ADAPTER kiểm TRƯỚC. */
export async function sellTid(ctx: ServiceCtx, tid: string, input: SellTidInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'DEVICE_SALE_MANAGE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const occurredAt = parseWhen(input.occurredAt);
  const method = normMethod(input.method);
  try {
    const money2 = await validateSaleMoney(db, input);
    const result = await withRetry(async () => {
      return await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM tids WHERE tid = ${tid} FOR UPDATE`;
        const trow = await tx.tid.findUnique({ where: { tid } });
        if (!trow || trow.deletedAt) throw new SaleAbort({ ok: false, error: 'NOT_FOUND', message: `Không tìm thấy TID "${tid}".` });
        if (trow.posSerial != null) throw new SaleAbort({ ok: false, error: 'TID_ON_DEVICE', message: `TID "${tid}" đang gắn trên máy ${trow.posSerial}. Bán máy (kèm TID) thay vì bán TID riêng.` });
        const td = decideTidTransition(trow.status as TidStatus, 'sell');
        if (!td.allowed) throw new SaleAbort({ ok: false, error: td.reason, message: `Không thể bán TID đang ở trạng thái ${trow.status}.` });

        const code = await nextCode(tx, 'BS');
        const sale = await tx.deviceSale.create({
          data: { code, saleKind: 'TID', tid, customerId: input.customerId, salePrice: money2.salePrice, soldByUserId: user.id, occurredAt, note: input.note?.trim() || null, status: 'POSTED', createdBy: user.id }
        });
        await tx.tid.update({ where: { id: trow.id }, data: { status: 'SOLD', posSerial: null, agentId: null, customerId: input.customerId } });
        await tx.assetEvent.create({
          data: { tid, eventType: 'TID_SELL', fromState: trow.status, toState: 'SOLD', customerId: input.customerId, actorUserId: user.id, occurredAt, note: input.note?.trim() || null, afterJson: JSON.stringify(auditSnapshot({ sale: code, tid, salePrice: money2.salePrice.toString(), customerId: input.customerId })) }
        });
        await bookSaleCashEntries(tx, { saleId: sale.id, saleKind: 'TID', salePrice: money2.salePrice, paid: money2.paid, fundId: input.fundId ?? null, method, entryDate: occurredAt, customerId: input.customerId, userId: user.id });
        await writeAuditStrict(tx, { actorUserId: user.id, action: 'TID_SOLD', targetType: 'DeviceSale', targetId: String(sale.id), after: auditSnapshot({ code, tid, salePrice: money2.salePrice.toString(), paidNow: money2.paid.toString(), customerId: input.customerId }) });
        return { ok: true, id: sale.id } as MutationResult;
      });
    });
    const meta = result as MutationResult;
    await bumpChangeToken(db, 'DeviceSale');
    return { ok: true, id: meta.id };
  } catch (e) {
    if (e instanceof SaleAbort) return e.result;
    throw e;
  }
}

/** Ghi bút toán bán trong CÙNG transaction: doanh thu (SALE_POS/SALE_TID, fundId=null) + tiền thu ngay
 * (SALE_COLLECT vào quỹ) + settlement. Dùng chung cho sellPos/sellTid + tái dùng bởi xuất kho (không nhân bản). */
export async function bookSaleCashEntries(
  tx: Prisma.TransactionClient,
  a: { saleId: number; saleKind: 'POS' | 'TID'; salePrice: bigint; paid: bigint; fundId: number | null; method: string; entryDate: Date; customerId: number; userId: number }
): Promise<void> {
  const revenueSK = a.saleKind === 'POS' ? 'SALE_POS' : 'SALE_TID';
  const revenueCatId = await catIdBySourceKind(tx, revenueSK);
  // Doanh thu ghi nhận đủ ngay (accrual): fundId=null, KHÔNG đụng quỹ.
  const revCode = await nextCode(tx, 'PT');
  await tx.cashEntry.create({
    data: { code: revCode, kind: 'THU', categoryId: revenueCatId, fundId: null, amount: a.salePrice, method: a.method, entryDate: a.entryDate, customerId: a.customerId, sourceType: revenueSK, sourceId: a.saleId, note: 'Ghi nhận doanh thu bán thiết bị', status: 'POSTED', createdBy: a.userId }
  });
  // Tiền thu ngay (nếu có): SALE_COLLECT vào quỹ + settlement.
  if (a.paid > 0n) {
    const collectCatId = await catIdBySourceKind(tx, 'SALE_COLLECT');
    const payCode = await nextCode(tx, 'PT');
    const payEntry = await tx.cashEntry.create({
      data: { code: payCode, kind: 'THU', categoryId: collectCatId, fundId: a.fundId, amount: a.paid, method: a.method, entryDate: a.entryDate, customerId: a.customerId, sourceType: 'SALE_COLLECT', sourceId: a.saleId, note: 'Thu tiền bán thiết bị', status: 'POSTED', createdBy: a.userId }
    });
    await tx.deviceSaleSettlement.create({ data: { deviceSaleId: a.saleId, cashEntryId: payEntry.id, amount: a.paid } });
  }
}

export interface CollectInput {
  deviceSaleId: number;
  amount: number;
  fundId: number;
  method?: string | null;
  entryDate?: string | null;
}
/** DEVICE_SALE_MANAGE — thu thêm tiền vào 1 chứng từ bán (giảm công nợ). Không vượt còn-nợ. */
export async function collectDeviceSaleDebt(ctx: ServiceCtx, input: CollectInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'DEVICE_SALE_MANAGE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const entryDate = parseWhen(input.entryDate);
  const method = normMethod(input.method);
  try {
    const amount = money(input.amount, 'Số tiền thu');
    const result = await withRetry(async () => {
      return await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM device_sales WHERE id = ${input.deviceSaleId} FOR UPDATE`;
        const sale = await tx.deviceSale.findUnique({ where: { id: input.deviceSaleId } });
        if (!sale || sale.deletedAt || sale.status !== 'POSTED') throw new SaleAbort({ ok: false, error: 'NOT_FOUND', message: 'Chứng từ bán không tồn tại.' });
        const settled = await tx.deviceSaleSettlement.aggregate({ where: { deviceSaleId: sale.id }, _sum: { amount: true } });
        const remaining = sale.salePrice - (settled._sum.amount ?? 0n);
        if (remaining <= 0n) throw new SaleAbort({ ok: false, error: 'ALREADY_SETTLED', message: 'Chứng từ bán này đã thu đủ.' });
        if (amount > remaining) throw new SaleAbort({ ok: false, error: 'VALIDATION', message: `Số tiền thu (${amount}) vượt công nợ còn lại (${remaining}).` });
        // API-3 (audit 21/8): BẮT BUỘC chọn quỹ nhận (mirror validateSaleMoney). Prisma DROP `id: undefined` →
        // findFirst khớp quỹ ĐẦU TIÊN đang sống, qua guard `if(!fund)`, rồi CashEntry.fundId=undefined → NULL quỹ
        // = tiền vào KHÔNG ghi quỹ (thu công nợ mà không quỹ nào tăng). Chặn fundId thiếu/không nguyên-dương TRƯỚC.
        if (!input.fundId || !Number.isInteger(input.fundId) || input.fundId <= 0) {
          throw new SaleAbort({ ok: false, error: 'VALIDATION', message: 'Phải chọn quỹ nhận tiền.' });
        }
        const fund = await tx.fund.findFirst({ where: { id: input.fundId, deletedAt: null }, select: { id: true } });
        if (!fund) throw new SaleAbort({ ok: false, error: 'NOT_FOUND', message: 'Quỹ nhận tiền không tồn tại.' });
        const collectCatId = await catIdBySourceKind(tx, 'SALE_COLLECT');
        const payCode = await nextCode(tx, 'PT');
        const payEntry = await tx.cashEntry.create({
          data: { code: payCode, kind: 'THU', categoryId: collectCatId, fundId: input.fundId, amount, method, entryDate, customerId: sale.customerId, sourceType: 'SALE_COLLECT', sourceId: sale.id, note: 'Thu tiền bán thiết bị', status: 'POSTED', createdBy: user.id }
        });
        await tx.deviceSaleSettlement.create({ data: { deviceSaleId: sale.id, cashEntryId: payEntry.id, amount } });
        await writeAuditStrict(tx, { actorUserId: user.id, action: 'DEVICE_SALE_COLLECT', targetType: 'DeviceSale', targetId: String(input.deviceSaleId), after: auditSnapshot({ receipt: payCode, amount: amount.toString(), remaining: (remaining - amount).toString() }) });
        return { ok: true, id: sale.id } as MutationResult;
      });
    });
    const meta = result as MutationResult;
    await bumpChangeToken(db, 'DeviceSale');
    return { ok: true, id: meta.id };
  } catch (e) {
    if (e instanceof SaleAbort) return e.result;
    throw e;
  }
}

export interface DeviceSaleDto {
  id: number;
  code: string | null;
  saleKind: string;
  deviceSerial: string | null;
  tid: string | null;
  customerId: number;
  customerName: string | null;
  salePrice: number;
  paid: number;
  remaining: number;
  soldByName: string | null;
  occurredAt: string;
  note: string | null;
}
export interface DeviceSaleFilter {
  saleKind?: string;
  customerId?: number;
  onlyDebt?: boolean; // chỉ còn nợ
}
/** DEVICE_SALE_VIEW — danh sách chứng từ bán + còn nợ (cho màn Công nợ / Bán thiết bị). */
export async function listDeviceSales(ctx: ServiceCtx, filter: DeviceSaleFilter = {}): Promise<{ ok: boolean; data?: DeviceSaleDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'DEVICE_SALE_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.deviceSale.findMany({
    where: { deletedAt: null, status: 'POSTED', saleKind: filter.saleKind || undefined, customerId: filter.customerId ?? undefined },
    orderBy: { id: 'desc' }
  });
  const saleIds = rows.map((r) => r.id);
  const setts = saleIds.length ? await db.deviceSaleSettlement.groupBy({ by: ['deviceSaleId'], where: { deviceSaleId: { in: saleIds } }, _sum: { amount: true } }) : [];
  const paidMap = new Map(setts.map((s) => [s.deviceSaleId, s._sum.amount ?? 0n]));
  const custIds = [...new Set(rows.map((r) => r.customerId))];
  const custs = await db.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, nickname: true, fullName: true } });
  const custMap = new Map(custs.map((c) => [c.id, c.nickname || c.fullName]));
  const userIds = [...new Set(rows.map((r) => r.soldByUserId).filter((x): x is number => x != null))];
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true, username: true } });
  const userMap = new Map(users.map((u) => [u.id, u.fullName || u.username]));
  let data = rows.map((r) => {
    const paid = paidMap.get(r.id) ?? 0n;
    return {
      id: r.id, code: r.code, saleKind: r.saleKind, deviceSerial: r.deviceSerial, tid: r.tid,
      customerId: r.customerId, customerName: custMap.get(r.customerId) ?? null,
      salePrice: Number(r.salePrice), paid: Number(paid), remaining: Number(r.salePrice - paid),
      soldByName: r.soldByUserId != null ? userMap.get(r.soldByUserId) ?? null : null,
      occurredAt: r.occurredAt.toISOString(), note: r.note
    };
  });
  if (filter.onlyDebt) data = data.filter((d) => d.remaining > 0);
  return { ok: true, data };
}

export interface CustomerDeviceReceivable {
  customerId: number;
  customerName: string | null;
  totalSale: number;
  totalPaid: number;
  remaining: number;
  saleCount: number;
}
/** DEVICE_SALE_VIEW — công nợ mua thiết bị gộp theo khách (chỉ khách còn nợ). */
export async function customerDeviceReceivables(ctx: ServiceCtx): Promise<{ ok: boolean; data?: CustomerDeviceReceivable[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'DEVICE_SALE_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.deviceSale.findMany({ where: { deletedAt: null, status: 'POSTED' }, select: { id: true, customerId: true, salePrice: true } });
  const saleIds = rows.map((r) => r.id);
  const setts = saleIds.length ? await db.deviceSaleSettlement.groupBy({ by: ['deviceSaleId'], where: { deviceSaleId: { in: saleIds } }, _sum: { amount: true } }) : [];
  const paidMap = new Map(setts.map((s) => [s.deviceSaleId, s._sum.amount ?? 0n]));
  const agg = new Map<number, { sale: bigint; paid: bigint; count: number }>();
  for (const r of rows) {
    const cur = agg.get(r.customerId) ?? { sale: 0n, paid: 0n, count: 0 };
    cur.sale += r.salePrice;
    cur.paid += paidMap.get(r.id) ?? 0n;
    cur.count += 1;
    agg.set(r.customerId, cur);
  }
  const custs = await db.customer.findMany({ where: { id: { in: [...agg.keys()] } }, select: { id: true, nickname: true, fullName: true } });
  const custMap = new Map(custs.map((c) => [c.id, c.nickname || c.fullName]));
  const data = [...agg.entries()]
    .map(([customerId, v]) => ({ customerId, customerName: custMap.get(customerId) ?? null, totalSale: Number(v.sale), totalPaid: Number(v.paid), remaining: Number(v.sale - v.paid), saleCount: v.count }))
    .filter((d) => d.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining);
  return { ok: true, data };
}
