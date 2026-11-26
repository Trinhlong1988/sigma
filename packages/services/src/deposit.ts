// LOẠI GIAO MÁY — CỌC + áp mô hình tiền khi giao (applyHandoverTx) + báo cáo cọc/doanh-thu — LÕI THUẦN.
// PORT nghiệp vụ từ apps/desktop/src/main/deposit-service.ts (helper tx GHI) + resolveHandoverInput/
// buildHandoverContext từ apps/desktop/src/main/handover-service.ts (VALIDATE trước tx). Kế toán khóa:
//   • CHO THUÊ (RENT): thu 1 lần lúc giao = CashEntry THU danh mục RENT (affectsPnl=true) → DOANH THU.
//   • CỌC (DEPOSIT): NỢ PHẢI TRẢ → DeviceDeposit(OPEN) + CashEntry THU DEPOSIT (affectsPnl=false,
//     sourceType='DEVICE_DEPOSIT'), KHÔNG doanh thu. recall → HOÀN phần CÒN GIỮ (FOR UPDATE, chống hoàn quá).
//   • MƯỢN (NONE): 0đ. BÁN (SALE): KHÔNG qua đây (luồng device-sale) — caller định tuyến.
// Helper tx (openDepositTx/depositRemainingTx/refundOpenDepositsForSerialTx/applyHandoverTx) NHẬN db/tx — dùng
// bởi pos.ts (deploy/recall) & device-sale.ts. nextCode(@sigma/services) nhận (client, prefix) — KHÁC desktop.
// Báo cáo (depositsHeld/revenueByHandoverType) ctx-based (REVENUE_VIEW). ServiceCtx từ customer.js.
import { Prisma, type Db } from '@sigma/database';
import { hasPermission } from '@sigma/shared';
import { bumpChangeToken } from './audit.js';
import { nextCode } from './code.js';
import { type ServiceCtx, type MutationResult } from './customer.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

// COUNTERPART (Đối ứng, Admin Demo 9/8): phí lấy từ biểu phí niêm yết (không sinh tiền tự động ở applyHandover); cọc
// theo cờ hasDeposit độc lập.
export type MoneyKind = 'SALE' | 'RENT' | 'DEPOSIT' | 'NONE' | 'COUNTERPART';

/** Ngữ cảnh áp mô hình tiền khi giao (đã validate ở resolveHandoverInput). */
export interface HandoverContext {
  moneyKind: MoneyKind;
  handoverTypeId: number | null;
  amount: bigint; // ≥ 0 — khoản CHÍNH theo moneyKind
  fundId: number | null; // ≠ null khi amount>0 (RENT/DEPOSIT)
  // Admin Demo 9/8 — CỌC ĐỘC LẬP (loại giao hasDeposit, moneyKind≠DEPOSIT): khoản RIÊNG song song amount. 0=không cọc.
  depositAmount?: bigint;
  depositFundId?: number | null;
  method: string; // CK | CASH
  deviceSerial: string | null;
  tid: string | null;
  customerId: number | null;
  occurredAt: Date;
  actorId: number;
}

type PrismaTx = Prisma.TransactionClient;

/** id danh mục thu/chi theo sourceKind hệ thống (RENT/DEPOSIT/DEPOSIT_REFUND). Ném nếu thiếu seed. */
async function catIdBySourceKind(tx: PrismaTx, sourceKind: string): Promise<number> {
  const c = await tx.cashCategory.findFirst({ where: { sourceKind, deletedAt: null }, select: { id: true } });
  if (!c) throw new Error(`Thiếu danh mục thu/chi (${sourceKind}) — kiểm tra seed hệ thống.`);
  return c.id;
}

/**
 * Mở 1 chứng từ cọc trong CÙNG $transaction: DeviceDeposit(OPEN) + CashEntry THU danh mục DEPOSIT
 * (affectsPnl=false, sourceType='DEVICE_DEPOSIT', sourceId=depositId) vào quỹ. Trả depositId.
 */
export async function openDepositTx(
  tx: PrismaTx,
  a: { customerId: number; deviceSerial: string | null; tid: string | null; handoverTypeId: number | null; amount: bigint; fundId: number; method: string; occurredAt: Date; actorId: number; note?: string | null }
): Promise<number> {
  const code = await nextCode(tx, 'CO');
  const deposit = await tx.deviceDeposit.create({
    data: {
      code, customerId: a.customerId, deviceSerial: a.deviceSerial, tid: a.tid, handoverTypeId: a.handoverTypeId,
      amount: a.amount, status: 'OPEN', occurredAt: a.occurredAt, note: a.note ?? null, createdBy: a.actorId
    }
  });
  const catId = await catIdBySourceKind(tx, 'DEPOSIT');
  const payCode = await nextCode(tx, 'PT');
  await tx.cashEntry.create({
    data: {
      code: payCode, kind: 'THU', categoryId: catId, fundId: a.fundId, amount: a.amount, method: a.method,
      entryDate: a.occurredAt, customerId: a.customerId, sourceType: 'DEVICE_DEPOSIT', sourceId: deposit.id,
      note: 'Thu cọc máy (giao cọc)', status: 'POSTED', createdBy: a.actorId
    }
  });
  return deposit.id;
}

/** Cọc CÒN GIỮ của 1 chứng từ (LIVE) = amount − Σ DeviceDepositRefund.amount. */
export async function depositRemainingTx(tx: PrismaTx, depositId: number): Promise<bigint> {
  const dep = await tx.deviceDeposit.findUnique({ where: { id: depositId }, select: { amount: true } });
  if (!dep) return 0n;
  const agg = await tx.deviceDepositRefund.aggregate({ where: { deviceDepositId: depositId }, _sum: { amount: true } });
  return dep.amount - (agg._sum.amount ?? 0n);
}

/**
 * Thu máy về (recall) → HOÀN phần cọc CÒN GIỮ của MỌI chứng từ cọc OPEN gắn máy `serial`, trong CÙNG
 * $transaction. Mỗi chứng từ: FOR UPDATE, tính remaining, nếu > 0 tạo CashEntry CHI DEPOSIT_REFUND
 * (sourceType='DEVICE_DEPOSIT') + DeviceDepositRefund, set status=REFUNDED. Quỹ hoàn = fundIdOverride nếu có,
 * ngược lại QUỸ của CashEntry cọc GỐC (đối xứng). Trả tổng đã hoàn.
 */
export async function refundOpenDepositsForSerialTx(
  tx: PrismaTx,
  a: { serial: string; fundIdOverride: number | null; method: string; occurredAt: Date; actorId: number }
): Promise<bigint> {
  const opens = await tx.deviceDeposit.findMany({ where: { deviceSerial: a.serial, status: 'OPEN' }, select: { id: true } });
  if (opens.length === 0) return 0n;
  const catId = await catIdBySourceKind(tx, 'DEPOSIT_REFUND');
  let refundedTotal = 0n;
  for (const o of opens) {
    await tx.$queryRaw`SELECT id FROM device_deposits WHERE id = ${o.id} FOR UPDATE`;
    const dep = await tx.deviceDeposit.findUnique({ where: { id: o.id } });
    if (!dep || dep.status !== 'OPEN') continue;
    const remaining = await depositRemainingTx(tx, o.id);
    if (remaining <= 0n) {
      await tx.deviceDeposit.update({ where: { id: o.id }, data: { status: 'REFUNDED' } });
      continue;
    }
    let fundId = a.fundIdOverride;
    if (fundId == null) {
      const orig = await tx.cashEntry.findFirst({ where: { sourceType: 'DEVICE_DEPOSIT', sourceId: o.id, kind: 'THU', status: 'POSTED' }, orderBy: { id: 'asc' }, select: { fundId: true } });
      fundId = orig?.fundId ?? null;
    }
    if (fundId == null) continue; // không xác định được quỹ hoàn → BỎ QUA (giữ OPEN) để không tạo bút toán mồ côi.
    const payCode = await nextCode(tx, 'PC');
    const entry = await tx.cashEntry.create({
      data: {
        code: payCode, kind: 'CHI', categoryId: catId, fundId, amount: remaining, method: a.method,
        entryDate: a.occurredAt, customerId: dep.customerId, sourceType: 'DEVICE_DEPOSIT', sourceId: o.id,
        note: 'Hoàn cọc máy (thu máy về)', status: 'POSTED', createdBy: a.actorId
      }
    });
    await tx.deviceDepositRefund.create({ data: { deviceDepositId: o.id, cashEntryId: entry.id, amount: remaining } });
    await tx.deviceDeposit.update({ where: { id: o.id }, data: { status: 'REFUNDED' } });
    refundedTotal += remaining;
  }
  return refundedTotal;
}

/**
 * CỌC KẸT (Admin Demo 11/8) — khi BÁN/THANH LÝ 1 máy đang giao mà máy còn cọc OPEN, cọc KHÔNG tự hoàn (chờ bill
 * chuyển khoản → hoàn tay) và máy rời DEPLOYED nên recall KHÔNG còn gọi được → cọc mất đường về. Helper này
 * KHÔNG hoàn tiền, KHÔNG chặn thao tác — chỉ GHI 1 breadcrumb AssetEvent 'DEPOSIT_UNREFUNDED' (không mất dấu) cho
 * MỌI cọc OPEN còn giữ (remaining>0) gắn `serial`, để timeline máy + báo cáo (depositsNeedingManualRefund) NHẮC
 * kế toán hoàn tay. Gọi TRONG $transaction bán/thanh lý. Mỗi lần sell/retire ghi 1 breadcrumb cho mỗi cọc kẹt.
 */
export async function flagStrandedDepositsTx(
  tx: PrismaTx,
  a: { serial: string; reason: string; actorId: number; occurredAt: Date }
): Promise<number> {
  const opens = await tx.deviceDeposit.findMany({ where: { deviceSerial: a.serial, status: 'OPEN' }, select: { id: true, customerId: true, tid: true } });
  let flagged = 0;
  for (const o of opens) {
    const remaining = await depositRemainingTx(tx, o.id);
    if (remaining <= 0n) continue; // hết cọc còn giữ → không phải cọc kẹt
    await tx.assetEvent.create({
      data: {
        deviceSerial: a.serial, tid: o.tid, eventType: 'DEPOSIT_UNREFUNDED',
        customerId: o.customerId, actorUserId: a.actorId, occurredAt: a.occurredAt,
        note: `Cọc chưa hoàn (${a.reason}) — còn giữ ${remaining} VND, cần hoàn TAY khi có bill chuyển khoản.`,
        afterJson: JSON.stringify({ depositId: o.id, remaining: remaining.toString(), reason: a.reason })
      }
    });
    flagged++;
  }
  return flagged;
}

/**
 * Áp MÔ HÌNH TIỀN khi giao (deploy / gán-TID kèm máy) trong CÙNG $transaction — dùng chung cho pos & tid.
 *   RENT → amount>0 tạo CashEntry THU RENT (doanh thu). amount=0 → bỏ qua tiền.
 *   DEPOSIT → openDepositTx. NONE → 0đ. SALE → no-op (caller định tuyến sang luồng Bán).
 * (Validate số tiền/quỹ đã làm ở resolveHandoverInput → đây chỉ GHI.)
 */
export async function applyHandoverTx(tx: PrismaTx, ctx: HandoverContext): Promise<void> {
  // CỌC ĐỘC LẬP (Admin Demo 9/8) — loại giao hasDeposit + moneyKind≠DEPOSIT (Cho thuê/Mượn/Đối ứng): cọc là khoản
  // RIÊNG song song khoản chính. moneyKind===DEPOSIT thì cọc = amount chính (nhánh DEPOSIT dưới) → KHÔNG double.
  const depositAmount = ctx.depositAmount ?? 0n;
  if (depositAmount > 0n && ctx.moneyKind !== 'DEPOSIT') {
    if (ctx.depositFundId == null || ctx.customerId == null) throw new Error('Cọc độc lập thiếu quỹ/khách (lỗi logic — đã validate trước tx).');
    await openDepositTx(tx, {
      customerId: ctx.customerId, deviceSerial: ctx.deviceSerial, tid: ctx.tid, handoverTypeId: ctx.handoverTypeId,
      amount: depositAmount, fundId: ctx.depositFundId, method: ctx.method, occurredAt: ctx.occurredAt, actorId: ctx.actorId
    });
  }
  // COUNTERPART (Đối ứng): phí từ biểu phí niêm yết (logic TID sẵn có) — không thu qua applyHandover.
  if (ctx.moneyKind === 'SALE' || ctx.moneyKind === 'NONE' || ctx.moneyKind === 'COUNTERPART') return;
  if (ctx.moneyKind === 'RENT') {
    if (ctx.amount <= 0n) return; // thuê 0đ (miễn phí kỳ đầu) — không ghi tiền
    if (ctx.fundId == null) throw new Error('RENT amount>0 thiếu quỹ (lỗi logic — đã validate trước tx).');
    const catId = await catIdBySourceKind(tx, 'RENT');
    const code = await nextCode(tx, 'PT');
    await tx.cashEntry.create({
      data: {
        code, kind: 'THU', categoryId: catId, fundId: ctx.fundId, amount: ctx.amount, method: ctx.method,
        entryDate: ctx.occurredAt, customerId: ctx.customerId, sourceType: 'RENT', sourceId: null,
        note: 'Doanh thu cho thuê máy (giao thuê)', status: 'POSTED', createdBy: ctx.actorId
      }
    });
    return;
  }
  // DEPOSIT
  if (ctx.fundId == null || ctx.customerId == null) throw new Error('DEPOSIT thiếu quỹ/khách (lỗi logic — đã validate trước tx).');
  await openDepositTx(tx, {
    customerId: ctx.customerId, deviceSerial: ctx.deviceSerial, tid: ctx.tid, handoverTypeId: ctx.handoverTypeId,
    amount: ctx.amount, fundId: ctx.fundId, method: ctx.method, occurredAt: ctx.occurredAt, actorId: ctx.actorId
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// resolveHandoverInput — VALIDATE (trước $transaction) loại giao + số tiền + quỹ cho deploy / assign-TID.
// Trả HandoverContext đã kiểm (applyHandoverTx chỉ GHI). moneyKind SALE trả cờ để CALLER chặn/định tuyến.
// PORT từ handover-service.ts nhưng nhận `db` PARAM (KHÔNG Electron global) — helper THUẦN dùng bởi pos/tid.
// ─────────────────────────────────────────────────────────────────────────────
export interface ResolveHandoverInput {
  handoverTypeId?: number | null; // null = giao nội bộ (mượn/không loại giao) → NONE
  amount?: number | null; // số tiền giao (VND); mặc định 0
  fundId?: number | null; // quỹ nhận (bắt buộc khi amount>0 với RENT/DEPOSIT)
  depositAmount?: number | null; // Admin Demo 9/8 — CỌC ĐỘC LẬP (chỉ loại giao hasDeposit, moneyKind≠DEPOSIT); 0=không
  depositFundId?: number | null; // quỹ nhận cọc (bắt buộc khi depositAmount>0)
  method?: string | null; // CK | CASH (mặc định CASH)
}
export type ResolveHandoverResult =
  | { ok: true; moneyKind: MoneyKind; handoverTypeId: number | null; amount: bigint; fundId: number | null; depositAmount: bigint; depositFundId: number | null; method: string }
  | { ok: false; error: string; message: string };

function parseVndAmount(v: unknown): bigint | null {
  const n = typeof v === 'number' ? v : Number(v ?? 0);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return BigInt(n);
}

export async function resolveHandoverInput(db: Db, input: ResolveHandoverInput): Promise<ResolveHandoverResult> {
  const method = input.method === 'CK' ? 'CK' : 'CASH';
  const amount = parseVndAmount(input.amount ?? 0);
  if (amount === null) return { ok: false, error: 'VALIDATION', message: 'Số tiền giao phải là số nguyên ≥ 0 (VND).' };

  const depositAmountRaw = parseVndAmount(input.depositAmount ?? 0);
  if (depositAmountRaw === null) return { ok: false, error: 'VALIDATION', message: 'Tiền cọc phải là số nguyên ≥ 0 (VND).' };

  // Không chọn loại giao → coi như MƯỢN (NONE, 0đ). Không cọc.
  if (input.handoverTypeId == null) {
    if (amount > 0n) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn loại giao thì không nhập số tiền (mặc định Mượn 0đ).' };
    if (depositAmountRaw > 0n) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn loại giao thì không nhập tiền cọc.' };
    return { ok: true, moneyKind: 'NONE', handoverTypeId: null, amount: 0n, fundId: null, depositAmount: 0n, depositFundId: null, method };
  }
  const ht = await db.handoverType.findUnique({ where: { id: input.handoverTypeId } });
  if (!ht || ht.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại giao đã chọn không tồn tại.' };
  const moneyKind = ht.moneyKind as MoneyKind;

  // CỌC ĐỘC LẬP (Admin Demo 9/8) — chỉ khi loại giao hasDeposit VÀ moneyKind ≠ DEPOSIT (loại "Cọc" nhập ở ô chính).
  let depositAmount = 0n;
  let depositFundId: number | null = null;
  if (depositAmountRaw > 0n) {
    if (moneyKind === 'DEPOSIT') return { ok: false, error: 'VALIDATION', message: 'Loại "Cọc" nhập tiền cọc ở ô số tiền chính, không dùng ô cọc riêng.' };
    if (!ht.hasDeposit) return { ok: false, error: 'VALIDATION', message: `Loại giao "${ht.name}" không cho phép đặt cọc.` };
    if (!input.depositFundId) return { ok: false, error: 'VALIDATION', message: 'Có đặt cọc thì phải chọn quỹ nhận cọc.' };
    const dfund = await db.fund.findFirst({ where: { id: input.depositFundId, deletedAt: null }, select: { id: true } });
    if (!dfund) return { ok: false, error: 'NOT_FOUND', message: 'Quỹ nhận cọc không tồn tại.' };
    depositAmount = depositAmountRaw;
    depositFundId = input.depositFundId;
  }

  if (moneyKind === 'SALE') {
    return { ok: true, moneyKind, handoverTypeId: ht.id, amount, fundId: input.fundId ?? null, depositAmount, depositFundId, method };
  }
  if (moneyKind === 'NONE' || moneyKind === 'COUNTERPART') {
    if (amount > 0n) return { ok: false, error: 'VALIDATION', message: `Giao hình thức "${ht.name}" không thu qua ô số tiền — dùng ô đặt cọc / phí niêm yết.` };
    return { ok: true, moneyKind, handoverTypeId: ht.id, amount: 0n, fundId: null, depositAmount, depositFundId, method };
  }
  // RENT (amount≥0) | DEPOSIT (amount>0 = tiền cọc chính).
  if (moneyKind === 'DEPOSIT' && amount <= 0n) {
    return { ok: false, error: 'VALIDATION', message: 'Giao hình thức "Cọc" phải nhập số tiền cọc (> 0).' };
  }
  let fundId: number | null = null;
  if (amount > 0n) {
    if (!input.fundId) return { ok: false, error: 'VALIDATION', message: 'Có thu tiền thì phải chọn quỹ nhận.' };
    const fund = await db.fund.findFirst({ where: { id: input.fundId, deletedAt: null }, select: { id: true } });
    if (!fund) return { ok: false, error: 'NOT_FOUND', message: 'Quỹ nhận tiền không tồn tại.' };
    fundId = input.fundId;
  }
  return { ok: true, moneyKind, handoverTypeId: ht.id, amount, fundId, depositAmount, depositFundId, method };
}

/** Ghép HandoverContext để đưa vào applyHandoverTx. */
export function buildHandoverContext(
  r: Extract<ResolveHandoverResult, { ok: true }>,
  ctx: { deviceSerial: string | null; tid: string | null; customerId: number | null; occurredAt: Date; actorId: number }
): HandoverContext {
  return {
    moneyKind: r.moneyKind,
    handoverTypeId: r.handoverTypeId,
    amount: r.amount,
    fundId: r.fundId,
    depositAmount: r.depositAmount,
    depositFundId: r.depositFundId,
    method: r.method,
    deviceSerial: ctx.deviceSerial,
    tid: ctx.tid,
    customerId: ctx.customerId,
    occurredAt: ctx.occurredAt,
    actorId: ctx.actorId
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Báo cáo: cọc ĐANG GIỮ (nợ phải trả) — KHÔNG tính vào doanh thu. Gộp theo khách.
// ─────────────────────────────────────────────────────────────────────────────
export interface DepositHeldRow {
  customerId: number;
  customerName: string | null;
  totalDeposit: number; // Σ amount các chứng từ OPEN
  totalRefunded: number; // Σ đã hoàn (một phần) trên các chứng từ đó
  remaining: number; // đang giữ = totalDeposit − totalRefunded
  depositCount: number;
}
/** REVENUE_VIEW — cọc đang giữ (còn remaining>0) gộp theo khách. */
export async function depositsHeld(ctx: ServiceCtx, customerId?: number): Promise<{ ok: boolean; data?: DepositHeldRow[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'REVENUE_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.deviceDeposit.findMany({ where: { status: 'OPEN', customerId: customerId ?? undefined }, select: { id: true, customerId: true, amount: true } });
  const ids = rows.map((r) => r.id);
  const refs = ids.length ? await db.deviceDepositRefund.groupBy({ by: ['deviceDepositId'], where: { deviceDepositId: { in: ids } }, _sum: { amount: true } }) : [];
  const refundMap = new Map(refs.map((r) => [r.deviceDepositId, r._sum.amount ?? 0n]));
  const agg = new Map<number, { dep: bigint; ref: bigint; count: number }>();
  for (const r of rows) {
    const cur = agg.get(r.customerId) ?? { dep: 0n, ref: 0n, count: 0 };
    cur.dep += r.amount;
    cur.ref += refundMap.get(r.id) ?? 0n;
    cur.count += 1;
    agg.set(r.customerId, cur);
  }
  const custs = await db.customer.findMany({ where: { id: { in: [...agg.keys()] } }, select: { id: true, nickname: true, fullName: true } });
  const custMap = new Map(custs.map((c) => [c.id, c.nickname || c.fullName]));
  const data = [...agg.entries()]
    .map(([cid, v]) => ({ customerId: cid, customerName: custMap.get(cid) ?? null, totalDeposit: Number(v.dep), totalRefunded: Number(v.ref), remaining: Number(v.dep - v.ref), depositCount: v.count }))
    .filter((d) => d.remaining > 0)
    .sort((a, b) => b.remaining - a.remaining);
  return { ok: true, data };
}

// ─────────────────────────────────────────────────────────────────────────────
// CỌC KẸT (Admin Demo 11/8) — cọc OPEN gắn máy đã BÁN/THANH LÝ (SOLD/RETIRED). Máy rời DEPLOYED → recall (đường hoàn
// tự động) không gọi được nữa. KHÔNG tự hoàn, KHÔNG chặn bán: đây là DANH SÁCH CẢNH BÁO để kế toán hoàn TAY khi có
// bill chuyển khoản (refundDepositManual). Query THUẦN (join cọc OPEN × trạng thái máy), không đổi dữ liệu.
// ─────────────────────────────────────────────────────────────────────────────
export interface DepositManualRefundRow {
  depositId: number;
  code: string | null;
  customerId: number;
  customerName: string | null;
  deviceSerial: string | null;
  tid: string | null;
  amount: number;
  refunded: number;
  remaining: number;
  deviceStatus: string | null; // SOLD | RETIRED | (null = máy đã xóa/không tìm thấy)
  occurredAt: string;
  note: string | null;
}
/** REVENUE_VIEW — cọc OPEN còn giữ (remaining>0) mà máy đã SOLD/RETIRED → CẦN HOÀN TAY. */
export async function depositsNeedingManualRefund(ctx: ServiceCtx): Promise<{ ok: boolean; data?: DepositManualRefundRow[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'REVENUE_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  // [B327/SV2 24/11 — agent soát] BỎ lọc `deviceSerial: { not: null }`: cọc cấp-phiếu-xuất-kho có
  // serial=null (hợp lệ) trước đây bị loại khỏi worklist hoàn tay NÊN tiền cọc KẸT không có đường hoàn
  // trên giao diện (recall cũng tìm theo serial → không với tới). Nay gom cả cọc không-serial còn mở.
  const opens = await db.deviceDeposit.findMany({ where: { status: 'OPEN' } });
  if (opens.length === 0) return { ok: true, data: [] };
  const serials = [...new Set(opens.map((d) => d.deviceSerial).filter((s): s is string => s != null))];
  const devices = await db.posDevice.findMany({ where: { serial: { in: serials } }, select: { serial: true, status: true } });
  const devStatus = new Map(devices.map((d) => [d.serial, d.status]));
  const ids = opens.map((d) => d.id);
  const refs = await db.deviceDepositRefund.groupBy({ by: ['deviceDepositId'], where: { deviceDepositId: { in: ids } }, _sum: { amount: true } });
  const refundMap = new Map(refs.map((r) => [r.deviceDepositId, r._sum.amount ?? 0n]));
  const custIds = [...new Set(opens.map((d) => d.customerId))];
  const custs = await db.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, nickname: true, fullName: true } });
  const custMap = new Map(custs.map((c) => [c.id, c.nickname || c.fullName]));

  const data: DepositManualRefundRow[] = [];
  for (const d of opens) {
    // Máy KHÔNG tìm thấy (serial trỏ máy đã xóa cứng) HOẶC máy đã SOLD/RETIRED → cọc kẹt. Máy còn DEPLOYED/IN_STOCK…
    // vẫn có đường hoàn qua recall → KHÔNG liệt kê ở đây (tránh nhiễu).
    const st = d.deviceSerial != null ? devStatus.get(d.deviceSerial) ?? null : null;
    // [B327] cọc KHÔNG gắn serial (phiếu xuất kho) = luôn cần hoàn tay (không máy nào để recall).
    const stranded = d.deviceSerial == null || st === 'SOLD' || st === 'RETIRED' || !devStatus.has(d.deviceSerial);
    if (!stranded) continue;
    const refunded = refundMap.get(d.id) ?? 0n;
    const remaining = d.amount - refunded;
    if (remaining <= 0n) continue;
    data.push({
      depositId: d.id, code: d.code, customerId: d.customerId, customerName: custMap.get(d.customerId) ?? null,
      deviceSerial: d.deviceSerial, tid: d.tid, amount: Number(d.amount), refunded: Number(refunded), remaining: Number(remaining),
      deviceStatus: st, occurredAt: d.occurredAt.toISOString(), note: d.note
    });
  }
  data.sort((a, b) => b.remaining - a.remaining);
  return { ok: true, data };
}

export interface RefundDepositManualInput {
  depositId: number;
  fundId: number; // quỹ CHI hoàn (bill chuyển khoản → BẮT BUỘC, không suy quỹ gốc)
  method?: string | null; // CK (mặc định) | CASH
  occurredAt?: string | null;
  note?: string | null;
}
/**
 * POS_MANAGE — HOÀN CỌC TAY 1 chứng từ cọc, ĐỘC LẬP trạng thái máy (dùng khi máy đã SOLD/RETIRED không recall được).
 * Cùng bút toán như recall: CashEntry CHI DEPOSIT_REFUND (quỹ = fundId bill) + DeviceDepositRefund + status=REFUNDED,
 * FOR UPDATE chống hoàn 2 lần. Gate POS_MANAGE cho ĐỒNG BỘ với recall (đường hoàn tự động cũng gate POS_MANAGE).
 * Mật khẩu (§14) nếu cần do ADAPTER kiểm TRƯỚC (lõi không kiểm password).
 */
export async function refundDepositManual(ctx: ServiceCtx, input: RefundDepositManualInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'POS_MANAGE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const method = input.method === 'CASH' ? 'CASH' : 'CK';
  const parsed = input.occurredAt ? new Date(input.occurredAt) : new Date();
  const when = isNaN(parsed.getTime()) ? new Date() : parsed;
  if (!input.fundId) return { ok: false, error: 'VALIDATION', message: 'Phải chọn quỹ CHI để hoàn cọc (theo bill chuyển khoản).' };

  try {
    const result = await db.$transaction(async (tx) => {
      const fund = await tx.fund.findFirst({ where: { id: input.fundId, deletedAt: null }, select: { id: true } });
      if (!fund) throw new DepositRefundAbort({ ok: false, error: 'NOT_FOUND', message: 'Quỹ hoàn cọc không tồn tại.' });
      await tx.$queryRaw`SELECT id FROM device_deposits WHERE id = ${input.depositId} FOR UPDATE`;
      const dep = await tx.deviceDeposit.findUnique({ where: { id: input.depositId } });
      if (!dep) throw new DepositRefundAbort({ ok: false, error: 'NOT_FOUND', message: 'Chứng từ cọc không tồn tại.' });
      if (dep.status !== 'OPEN') throw new DepositRefundAbort({ ok: false, error: 'ALREADY_REFUNDED', message: 'Chứng từ cọc này đã hoàn/hủy — không hoàn lại được.' });
      const remaining = await depositRemainingTx(tx, dep.id);
      if (remaining <= 0n) {
        // Hết cọc còn giữ (đã hoàn từng phần đủ) → đóng OPEN, không tạo bút toán rỗng.
        await tx.deviceDeposit.update({ where: { id: dep.id }, data: { status: 'REFUNDED' } });
        throw new DepositRefundAbort({ ok: false, error: 'NOTHING_TO_REFUND', message: 'Cọc đã hoàn đủ trước đó (không còn tiền để hoàn).' });
      }
      const catId = await catIdBySourceKind(tx, 'DEPOSIT_REFUND');
      const payCode = await nextCode(tx, 'PC');
      const entry = await tx.cashEntry.create({
        data: {
          code: payCode, kind: 'CHI', categoryId: catId, fundId: input.fundId, amount: remaining, method,
          entryDate: when, customerId: dep.customerId, sourceType: 'DEVICE_DEPOSIT', sourceId: dep.id,
          note: input.note?.trim() || 'Hoàn cọc máy (hoàn tay sau bán/thanh lý)', status: 'POSTED', createdBy: user.id
        }
      });
      await tx.deviceDepositRefund.create({ data: { deviceDepositId: dep.id, cashEntryId: entry.id, amount: remaining } });
      await tx.deviceDeposit.update({ where: { id: dep.id }, data: { status: 'REFUNDED' } });
      // Trace TIMELINE (không mất dấu). Recall-refund KHÔNG có AuditAction riêng (bằng chứng = CashEntry +
      // DeviceDepositRefund); hoàn TAY dùng thêm 1 breadcrumb AssetEvent (eventType free-string, KHÔNG đụng union
      // AuditAction ở @sigma/shared — xem đề xuất LEAD thêm 'DEVICE_DEPOSIT_REFUND_MANUAL' để audit chặt hơn).
      if (dep.deviceSerial) {
        await tx.assetEvent.create({
          data: {
            deviceSerial: dep.deviceSerial, tid: dep.tid, eventType: 'DEPOSIT_REFUND_MANUAL', customerId: dep.customerId,
            actorUserId: user.id, occurredAt: when, note: input.note?.trim() || `Hoàn cọc tay ${remaining} VND (${payCode}).`,
            afterJson: JSON.stringify({ depositId: dep.id, receipt: payCode, amount: remaining.toString(), fundId: input.fundId, method })
          }
        });
      }
      return { depositId: dep.id, remaining };
    });
    await bumpChangeToken(db, 'DeviceDeposit');
    return { ok: true, id: result.depositId, message: `Đã hoàn cọc ${result.remaining} VND.` };
  } catch (e) {
    if (e instanceof DepositRefundAbort) return e.result;
    throw e;
  }
}

/** Sentinel hủy $transaction hoàn cọc tay với MutationResult thân thiện. */
class DepositRefundAbort extends Error {
  constructor(public readonly result: MutationResult) {
    super(result.message ?? result.error ?? 'ABORT');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Báo cáo DOANH THU theo LOẠI GIAO — BÁN = Σ DeviceSale.salePrice (POSTED); CHO THUÊ = Σ CashEntry THU RENT;
// CỌC = KHÔNG vào doanh thu (báo cáo riêng qua depositsHeld).
// ─────────────────────────────────────────────────────────────────────────────
export interface RevenueByHandoverFilter {
  from?: string; // YYYY-MM-DD (local)
  to?: string;
}
export interface RevenueByHandoverRow {
  handoverTypeId: number | null;
  handoverName: string;
  moneyKind: string;
  revenue: number;
  docCount: number;
}
/**
 * Parse 'YYYY-MM-DD' → nửa đêm LOCAL của (ngày + addDays). RE-VALIDATE thành phần NGÀY GỐC (khuôn parseLocalDay ở
 * investor-report.ts) để chặn JS cuộn âm thầm: TRƯỚC đây chỉ `isNaN` → '2026-02-31' biến thành 03/03 (sai kỳ báo
 * cáo). `addDays` (chặn trên nửa-mở) ĐƯỢC PHÉP tràn sang tháng kế (vd 2026-01-31 +1 = 01/02) — chỉ validate ngày GỐC.
 * Trả Date, hoặc null nếu ngày GỐC không hợp lệ (định dạng sai / ngày không tồn tại).
 */
function parseLocalDayBound(s: string, addDays: number): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const base = new Date(y, mo - 1, d);
  if (base.getFullYear() !== y || base.getMonth() + 1 !== mo || base.getDate() !== d) return null;
  return new Date(y, mo - 1, d + addDays);
}
/**
 * Bounds nửa-mở [gte, lt) theo NGÀY local. Phân biệt "không truyền" với "truyền SAI": ngày sai → { ok:false }
 * (caller PHẢI trả VALIDATION, KHÔNG âm thầm coi như không lọc → tránh báo cáo sai phạm vi).
 */
function localDayBounds(from?: string, to?: string): { ok: true; bounds?: { gte?: Date; lt?: Date } } | { ok: false } {
  const b: { gte?: Date; lt?: Date } = {};
  if (from) {
    const gte = parseLocalDayBound(from, 0);
    if (!gte) return { ok: false };
    b.gte = gte;
  }
  if (to) {
    const lt = parseLocalDayBound(to, 1);
    if (!lt) return { ok: false };
    b.lt = lt;
  }
  return { ok: true, bounds: b.gte || b.lt ? b : undefined };
}

export async function revenueByHandoverType(ctx: ServiceCtx, filter: RevenueByHandoverFilter = {}): Promise<{ ok: boolean; data?: RevenueByHandoverRow[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'REVENUE_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  // FIX (audit 20/8) — ngày sai (vd 2026-02-31) → VALIDATION, KHÔNG cuộn âm thầm sang kỳ khác. 1 tập bounds dùng
  // chung cho BÁN (occurredAt) và CHO THUÊ (entryDate) — cùng khoảng [from,to).
  const boundsRes = localDayBounds(filter.from, filter.to);
  if (!boundsRes.ok) return { ok: false, error: 'VALIDATION', message: 'Khoảng ngày lọc không hợp lệ (định dạng YYYY-MM-DD, ngày phải có thật).' };
  const bounds = boundsRes.bounds;

  // BÁN — Σ DeviceSale.salePrice (POSTED, alive) trong kỳ (occurredAt).
  const sales = await db.deviceSale.findMany({ where: { deletedAt: null, status: 'POSTED', occurredAt: bounds }, select: { salePrice: true, handoverTypeId: true } });
  // CHO THUÊ — Σ CashEntry THU danh mục RENT (POSTED, alive) trong kỳ (entryDate).
  const rentCat = await db.cashCategory.findFirst({ where: { sourceKind: 'RENT', deletedAt: null }, select: { id: true } });
  let rentSum = 0n;
  let rentCount = 0;
  if (rentCat) {
    const rentAgg = await db.cashEntry.aggregate({ where: { status: 'POSTED', kind: 'THU', categoryId: rentCat.id, deletedAt: null, entryDate: bounds }, _sum: { amount: true }, _count: true });
    rentSum = rentAgg._sum.amount ?? 0n;
    rentCount = rentAgg._count;
  }

  const builtins = await db.handoverType.findMany({ where: { deletedAt: null }, select: { id: true, name: true, moneyKind: true } });
  const saleType = builtins.find((h) => h.moneyKind === 'SALE');
  const rentType = builtins.find((h) => h.moneyKind === 'RENT');
  const typeById = new Map(builtins.map((h) => [h.id, h]));

  const saleAgg = new Map<number | null, { rev: bigint; count: number }>();
  for (const s of sales) {
    const key = s.handoverTypeId != null && typeById.get(s.handoverTypeId)?.moneyKind === 'SALE' ? s.handoverTypeId : (saleType?.id ?? null);
    const cur = saleAgg.get(key) ?? { rev: 0n, count: 0 };
    cur.rev += s.salePrice;
    cur.count += 1;
    saleAgg.set(key, cur);
  }

  const data: RevenueByHandoverRow[] = [];
  for (const [key, v] of saleAgg) {
    const name = key != null ? typeById.get(key)?.name ?? 'Bán' : 'Bán';
    data.push({ handoverTypeId: key, handoverName: name, moneyKind: 'SALE', revenue: Number(v.rev), docCount: v.count });
  }
  if (rentSum > 0n || rentCount > 0) {
    data.push({ handoverTypeId: rentType?.id ?? null, handoverName: rentType?.name ?? 'Cho thuê', moneyKind: 'RENT', revenue: Number(rentSum), docCount: rentCount });
  }
  data.sort((a, b) => b.revenue - a.revenue);
  return { ok: true, data };
}
