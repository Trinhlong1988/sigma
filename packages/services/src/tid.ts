// TID — LÕI THUẦN ctx-based. PORT nghiệp vụ từ apps/desktop/src/main/tid-service.ts (IMS_SPEC §A). Event-sourced:
// assign/replace/recall/markDelivered mỗi lần ghi 1 asset_event + pos_tid_binding, project TID + POS state, audit.
// Thay `requirePermission(current-user global)` + `me()` bằng ctx = { db, user } do adapter (desktop IPC HOẶC route
// API) dựng; mỗi hàm tự kiểm quyền qua hasPermission(ctx.user, ...). GIỮ NGUYÊN TỪNG BƯỚC transaction/optimistic-
// lock/FOR UPDATE/công nợ. Helper phòng chat (chat-room-tid.js) + handover (tid-handover-tx.js) là LÕI THUẦN trong
// @sigma/services (KHÔNG phụ thuộc desktop). MutationResult/ServiceCtx từ customer.js (KHÔNG khai lại/không re-export).
import { decideTidTransition, auditSnapshot, type TidStatus } from '@sigma/business-rules';
import { hasPermission } from '@sigma/shared';
import { idsTheoTxnDate } from './transaction.js';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { dateRange, type ServiceCtx, type MutationResult } from './customer.js';
import { validateRefs as validateConfigRefs } from './tid-config.js';
import { deriveOwyType } from './receive-account.js';
// Reuse handover helper THUẦN đã port ở deposit.js (agent B2) — KHÔNG tự nhân bản (tránh trùng MoneyKind/
// HandoverContext + lệch logic). resolveHandoverInput/buildHandoverContext/applyHandoverTx nhận db/tx.
import { resolveHandoverInput, buildHandoverContext, applyHandoverTx, type HandoverContext } from './deposit.js';
import { listChatRoomsForCustomer, assertChatRoomExists, linkTidToRoomForDelivery, type ChatRoomOptionDto } from './chat-room-tid.js';
// PHA 2 (quyết định 2A) — chọn LOẠI PHÍ MẶC ĐỊNH theo TỪNG TID lúc GIAO + set phí bán thực tế qua ĐÚNG lõi
// setTidSellFees (KHÔNG nhân bản công thức/validate). tid.ts → tid-sell-fee.ts KHÔNG tạo vòng import (tid-sell-fee
// không import tid.ts).
import { setTidSellFees } from './tid-sell-fee.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật: hkd_name ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';
import { nhanBank } from './nhan-bank.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

// PHA 2 (2A) — phí bán thực tế theo loại phí mặc định, gửi kèm lúc giao TID (áp qua ĐÚNG lõi setTidSellFees SAU khi
// ghi TID — không lệch công thức). null phiBan = xóa override kỳ đó (dùng niêm yết).
export interface HandoverSellFeeEntry { cardTypeId: number; phiBan: number | null; }

/** Validate FeeType tồn tại + chưa xóa (loại phí mặc định lúc giao). Trả về lỗi hoặc null (OK). */
async function assertFeeTypeValid(db: Pick<Db, 'feeType'>, feeTypeId: number): Promise<MutationResult | null> {
  const ft = await db.feeType.findUnique({ where: { id: feeTypeId } });
  if (!ft || ft.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Loại phí mặc định đã chọn không tồn tại.' };
  return null;
}

/**
 * Áp phí bán thực tế lúc giao TID qua ĐÚNG lõi setTidSellFees (feeType = loại phí mặc định). GỌI SAU khi TID đã ghi
 * (setTidSellFees tự mở $transaction + khóa hàng TID + recalc). NON-FATAL: TID đã commit/giao rồi — giá bán là tùy
 * chọn lúc giao (sửa được sau, badge P4 đã cờ "chưa có giá bán"). Trả { warning } khi KHÔNG lưu được giá; null khi OK
 * hoặc không có gì để làm. KHÔNG suy luận công thức: mọi ràng buộc (bán ≥ mua, thẻ đúng bank, kỳ hiệu lực) do lõi
 * setTidSellFees kiểm.
 */
async function applyHandoverSellFees(
  ctx: ServiceCtx,
  tidId: number,
  defaultFeeTypeId: number | null | undefined,
  sellFees: HandoverSellFeeEntry[] | undefined,
  // GIÁ BÁN THỎA THUẬN GẮN VỚI NGÀY GIAO (Admin Demo) — KỲ hiệu lực override = ĐÚNG mốc giao (deliveredAt) mà handover
  // ghi, KHÔNG phải hôm nay. setTidSellFees floor về nửa đêm LOCAL của ngày này + so phí mua niêm yết hiệu lực TẠI
  // ngày đó (kỳ lùi so đúng phí mua kỳ đó). null/undefined = giữ hành vi cũ (hôm nay). TID vừa tạo/giao chưa có GD
  // POSTED nào nên recalc backdated không đụng giao dịch khác (xem setTidSellFees + recalcRevenueForFeeChange).
  effectiveFrom?: Date | null
): Promise<{ warning: string } | null> {
  if (!sellFees || sellFees.length === 0) return null;
  if (defaultFeeTypeId == null)
    return { warning: 'Chưa lưu giá bán thực tế: thiếu loại phí mặc định. Hãy đặt lại ở màn "Phí bán thực tế theo loại thẻ".' };
  const r = await setTidSellFees(ctx, { tidId, feeTypeId: defaultFeeTypeId, entries: sellFees, ...(effectiveFrom ? { effectiveFrom } : {}) });
  return r.ok ? null : { warning: `Giao thành công nhưng CHƯA lưu được giá bán thực tế: ${r.message ?? 'lỗi cấu hình phí'}. Hãy đặt lại ở màn "Phí bán thực tế theo loại thẻ".` };
}

/** tx client trong $transaction (đủ model delegate + $queryRaw). */
type Tx = Parameters<Parameters<Db['$transaction']>[0]>[0];

// PHASE K2 (Q-T1): TID có 2 CHIỀU ĐỘC LẬP, DERIVE (không cột bool):
//   • "Gán máy POS"    = deviceAssigned = posSerial != null
//   • "Giao cho khách" = delivered      = deliveredAt != null
export interface TidDto {
  id: number;
  tid: string;
  mid: string | null;
  bank: string | null; // legacy text (G-POS.1)
  status: string; // UNASSIGNED|ACTIVE|DEAD|CLOSED|RECALLED
  posSerial: string | null;
  customerId: number | null;
  agentId: number | null;
  openedAt: string | null;
  deliveredAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string; // optimistic-lock (Admin Demo 11/8) — client echo lại khi Lưu cấu hình TID để chống sửa đè
  deviceAssigned: boolean;
  delivered: boolean;
  customerDeviceSerial: string | null;
  dossierId: number | null;
  industryId: number | null;
  industryName: string | null;
  bankId: number | null;
  bankCode: string | null;
  bankName: string | null;
  partnerId: number | null;
  partnerCode: string | null;
  partnerName: string | null;
  hkdName: string | null;
  receiveAccountId: number | null;
  // Phase B — suy UỶ qua tài khoản nhận tiền (TID gắn TK) + %phí đầu tư override theo TID.
  receiveAccountLabel: string | null; // "STK · Tên tài khoản" (join receiveAccount)
  // [Admin Demo 15/11] tách 2 cột riêng trên bảng TID: TÊN TÀI KHOẢN rồi mới tới STK.
  receiveAccountName: string | null;
  receiveAccountNumber: string | null;
  owyType: string | null; // loại uỷ của TK nhận tiền: CUSTOMER|INVESTOR|INTERNAL
  owyName: string | null; // tên khách/NĐT của uỷ
  investFeeMilli: number | null; // %phí đầu tư override theo TID (×1000); null = dùng mặc định NĐT
  issuedAt: string | null;
  configStatusId: number | null;
  configStatusName: string | null;
  dossierSourceId: number | null;
  dossierSourceCode: string | null;
  note: string | null;
  customerName: string | null;
  agentName: string | null;
  holdingCustomerName: string | null;
  // P4 — CẢNH BÁO TID đã giao nhưng cấu hình DỞ (nhìn "đã liên kết" nhưng bill đại lý/doanh số sẽ hụt):
  //   • customerHasActiveChatGroup = khách của TID có ≥1 CustomerChatGroup còn hoạt động (roomId != null & unassignedAt null).
  //     false → bill đại lý báo "chưa liên kết đại lý" (đại lý = khách tự nhận qua nhóm chat).
  //   • hasActualSellFee = TID có ≥1 TidSellFee còn sống (deletedAt null) = đã set giá bán thực tế.
  //     false → bill & doanh số báo "chưa cấu hình giá bán". Chỉ CẢNH BÁO khi delivered (UI tự gate).
  customerHasActiveChatGroup: boolean;
  hasActualSellFee: boolean;
}

export interface UndeliveredTidDto extends TidDto {
  /** Days since openedAt (or createdAt) — the "waste" aging metric (§A5). */
  agingDays: number;
}

/** Sentinel ném trong $transaction để rollback + trả MutationResult lỗi nghiệp vụ cho caller. */
class TidTxAbort extends Error {
  constructor(public readonly result: MutationResult) {
    super(result.message ?? result.error ?? 'ABORT');
  }
}

/** True nếu lỗi là deadlock/serialization đáng retry: Postgres 40P01 (deadlock) / 40001 (serialization) hoặc
 *  Prisma P2034 (write-conflict/deadlock). Mirror isRetryablePgError ở pos.ts. */
function isRetryableTidTxError(e: unknown): boolean {
  const code = (e as { code?: string })?.code;
  return code === '40P01' || code === '40001' || code === 'P2034';
}

/** Chạy 1 transaction, retry tối đa `attempts` lần khi gặp deadlock/serialization. TidTxAbort (lỗi nghiệp vụ)
 *  KHÔNG retry — ném lại ngay để caller map thành MutationResult. Mirror runWithRetry ở pos.ts. */
async function runTidTxWithRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof TidTxAbort) throw e;
      if (isRetryableTidTxError(e)) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

export interface TidFilter {
  search?: string;
  bank?: string;
  status?: string;
  deviceAssigned?: boolean;
  delivered?: boolean;
  industryId?: number;
  fromDate?: string;
  toDate?: string;
  deliveredFrom?: string;
  deliveredTo?: string;
  holdingCustomerId?: number;
  dossierSourceId?: number;
  // FIX-PERF B132 — phân trang (khuôn listTransactions/listCustomers). Không gửi → trang 1 + take mặc định
  // (pageSize 100, max 500) chặn kéo full-bảng. Trả kèm {total,page,pageSize}.
  page?: number;
  pageSize?: number;
}

/** FIX-PERF B132 — kết quả list TID có phân trang. `data` GIỮ shape cũ (renderer đọc .data không vỡ). */
export interface ListTidsResult {
  ok: boolean;
  data?: TidDto[];
  total?: number;
  page?: number;
  pageSize?: number;
  error?: string;
  message?: string;
}

const TID_PAGE_SIZE_DEFAULT = 100;
const TID_PAGE_SIZE_MAX = 500;

interface TidRow {
  id: number;
  tid: string;
  mid: string | null;
  bank: string | null;
  status: string;
  posSerial: string | null;
  customerId: number | null;
  agentId: number | null;
  openedAt: Date | null;
  deliveredAt: Date | null;
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  customerDeviceSerial: string | null;
  dossierId: number | null;
  industryId: number | null;
  bankId: number | null;
  partnerId: number | null;
  hkdName: string | null;
  receiveAccountId: number | null;
  investFeeMilli: number | null;
  issuedAt: Date | null;
  configStatusId: number | null;
  dossierSourceId: number | null;
  note: string | null;
}
interface TidNameMaps {
  banks: Map<number, { code: string; name: string }>;
  partners: Map<number, { code: string; name: string }>;
  statuses: Map<number, string>;
  dsources: Map<number, string>;
  customers: Map<number, string>;
  agents: Map<number, string>;
  industries: Map<number, string>;
  // Phase B — TK nhận tiền của TID: nhãn hiển thị + loại uỷ + tên uỷ (join sẵn, không N+1).
  receiveAccounts: Map<number, { label: string; name: string | null; number: string | null; owyType: string | null; owyName: string | null }>;
  // P4 — tập khách CÓ nhóm chat còn hoạt động + tập TID CÓ giá bán thực tế (2 batch query/trang, không N+1).
  customersWithChatGroup: Set<number>;
  tidsWithSellFee: Set<number>;
}
function distinctIds(arr: (number | null)[]): number[] {
  return [...new Set(arr.filter((x): x is number => typeof x === 'number'))];
}
/** Phòng chat SigMa — dedup + bỏ rỗng/null/undefined trước khi pre-check tồn tại. */
function distinctChatRoomIds(arr: (string | null | undefined)[]): string[] {
  return [...new Set(arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 0))];
}
/** Resolve FK names (bank/partner/status/source/customer/agent/industry + TK nhận tiền/uỷ) cho 1 tập tids — join ở service layer. */
async function buildTidMaps(db: Db, rows: TidRow[]): Promise<TidNameMaps> {
  // Phase B — TK nhận tiền của TID + UỶ suy từ (customerId, investorId): 3 findMany distinct (receiveAccount → khách/NĐT), không N+1.
  const rcvRows = await db.receiveAccount.findMany({ where: { id: { in: distinctIds(rows.map((r) => r.receiveAccountId)) } }, select: { id: true, accountName: true, accountNumber: true, customerId: true, investorId: true } });
  const owyCusts = new Map((await db.customer.findMany({ where: { id: { in: distinctIds(rcvRows.map((r) => r.customerId)) } }, select: { id: true, nickname: true, fullName: true } })).map((c) => [c.id, c.nickname || c.fullName]));
  const owyInvs = new Map((await db.investor.findMany({ where: { id: { in: distinctIds(rcvRows.map((r) => r.investorId)) } }, select: { id: true, nickname: true, fullName: true } })).map((v) => [v.id, v.nickname || v.fullName]));
  const receiveAccounts = new Map(rcvRows.map((r) => {
    const owyType = deriveOwyType(r.customerId, r.investorId);
    const owyName = r.investorId != null ? owyInvs.get(r.investorId) ?? null : r.customerId != null ? owyCusts.get(r.customerId) ?? null : null;
    return [r.id, { label: `${r.accountNumber} · ${r.accountName}`, name: r.accountName ?? null, number: r.accountNumber ?? null, owyType, owyName }] as const;
  }));
  // P4 — 2 batch query cho cảnh báo TID giao-dở: khách có nhóm chat còn hoạt động + TID có giá bán thực tế.
  const customersWithChatGroup = new Set(
    (await db.customerChatGroup.findMany({ where: { customerId: { in: distinctIds(rows.map((r) => r.customerId)) }, roomId: { not: null }, unassignedAt: null }, select: { customerId: true } })).map((g) => g.customerId)
  );
  const tidsWithSellFee = new Set(
    (await db.tidSellFee.findMany({ where: { tidId: { in: rows.map((r) => r.id) }, deletedAt: null }, select: { tidId: true } })).map((f) => f.tidId)
  );
  return {
    banks: new Map((await db.bank.findMany({ where: { id: { in: distinctIds(rows.map((r) => r.bankId)) } }, select: { id: true, code: true, name: true } })).map((b) => [b.id, { code: b.code, name: b.name }])),
    partners: new Map((await db.partner.findMany({ where: { id: { in: distinctIds(rows.map((r) => r.partnerId)) } }, select: { id: true, code: true, name: true } })).map((p) => [p.id, { code: p.code, name: p.name }])),
    statuses: new Map((await db.tidConfigStatus.findMany({ where: { id: { in: distinctIds(rows.map((r) => r.configStatusId)) } }, select: { id: true, name: true } })).map((s) => [s.id, s.name])),
    dsources: new Map((await db.dossierSource.findMany({ where: { id: { in: distinctIds(rows.map((r) => r.dossierSourceId)) } }, select: { id: true, code: true } })).map((s) => [s.id, s.code])),
    customers: new Map((await db.customer.findMany({ where: { id: { in: distinctIds(rows.map((r) => r.customerId)) } }, select: { id: true, nickname: true, fullName: true } })).map((c) => [c.id, c.nickname || c.fullName])),
    agents: new Map((await db.agent.findMany({ where: { id: { in: distinctIds(rows.map((r) => r.agentId)) } }, select: { id: true, name: true } })).map((a) => [a.id, a.name])),
    industries: new Map((await db.industry.findMany({ where: { id: { in: distinctIds(rows.map((r) => r.industryId)) } }, select: { id: true, name: true } })).map((i) => [i.id, i.name])),
    receiveAccounts,
    customersWithChatGroup,
    tidsWithSellFee
  };
}
function toDto(t: TidRow, maps: TidNameMaps): TidDto {
  const bank = t.bankId != null ? maps.banks.get(t.bankId) : undefined;
  const partner = t.partnerId != null ? maps.partners.get(t.partnerId) : undefined;
  return {
    id: t.id,
    tid: t.tid,
    mid: t.mid,
    bank: t.bank,
    status: t.status,
    posSerial: t.posSerial,
    customerId: t.customerId,
    agentId: t.agentId,
    openedAt: t.openedAt ? t.openedAt.toISOString() : null,
    deliveredAt: t.deliveredAt ? t.deliveredAt.toISOString() : null,
    closedAt: t.closedAt ? t.closedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
    deviceAssigned: t.posSerial != null,
    delivered: t.deliveredAt != null,
    customerDeviceSerial: t.customerDeviceSerial,
    dossierId: t.dossierId,
    industryId: t.industryId,
    industryName: t.industryId != null ? maps.industries.get(t.industryId) ?? null : null,
    bankId: t.bankId,
    bankCode: bank?.code ?? null,
    bankName: nhanBank(bank), // [16/11] mã viết tắt (bankCode vẫn giữ nguyên bên trên)
    partnerId: t.partnerId,
    partnerCode: partner?.code ?? null,
    partnerName: partner?.name ?? null,
    hkdName: t.hkdName,
    receiveAccountId: t.receiveAccountId,
    receiveAccountLabel: t.receiveAccountId != null ? maps.receiveAccounts.get(t.receiveAccountId)?.label ?? null : null,
    receiveAccountName: t.receiveAccountId != null ? maps.receiveAccounts.get(t.receiveAccountId)?.name ?? null : null,
    receiveAccountNumber: t.receiveAccountId != null ? maps.receiveAccounts.get(t.receiveAccountId)?.number ?? null : null,
    owyType: t.receiveAccountId != null ? maps.receiveAccounts.get(t.receiveAccountId)?.owyType ?? null : null,
    owyName: t.receiveAccountId != null ? maps.receiveAccounts.get(t.receiveAccountId)?.owyName ?? null : null,
    investFeeMilli: t.investFeeMilli,
    issuedAt: t.issuedAt ? t.issuedAt.toISOString() : null,
    configStatusId: t.configStatusId,
    configStatusName: t.configStatusId != null ? maps.statuses.get(t.configStatusId) ?? null : null,
    dossierSourceId: t.dossierSourceId,
    dossierSourceCode: t.dossierSourceId != null ? maps.dsources.get(t.dossierSourceId) ?? null : null,
    note: t.note,
    customerName: t.customerId != null ? maps.customers.get(t.customerId) ?? null : null,
    agentName: t.agentId != null ? maps.agents.get(t.agentId) ?? null : null,
    // #14: "đang giữ" = đã giao (deliveredAt != null) & CÒN SỐNG. TID-1 (audit 20/8): loại luôn DEAD/SOLD (không chỉ
    // CLOSED/RECALLED) — TID chết đã thay/đã bán vẫn còn cột deliveredAt+customerId (giữ lịch sử) nhưng KHÔNG còn là
    // khách "đang giữ" máy → không được hiện như đang giữ.
    holdingCustomerName:
      t.deliveredAt != null && t.status !== 'CLOSED' && t.status !== 'RECALLED' && t.status !== 'DEAD' && t.status !== 'SOLD'
        ? t.customerId != null
          ? maps.customers.get(t.customerId) ?? null
          : null
        : null,
    // P4 — null-safe: khách null → không có nhóm chat; TID luôn có id.
    customerHasActiveChatGroup: t.customerId != null && maps.customersWithChatGroup.has(t.customerId),
    hasActualSellFee: maps.tidsWithSellFee.has(t.id)
  };
}

/** Guard xem TID hợp nhất: chấp nhận TID_VIEW HOẶC CONFIG_TID_VIEW (Q-T4). */
function ensureTidView(ctx: ServiceCtx): MutationResult | null {
  if (hasPermission(ctx.user, 'TID_VIEW') || hasPermission(ctx.user, 'CONFIG_TID_VIEW')) return null;
  return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
}

/** TID_VIEW OR CONFIG_TID_VIEW — list TIDs (hợp nhất): search (tid/mid/HKD) + bank/status + 2 chiều derive. */
export async function listTids(ctx: ServiceCtx, filter: TidFilter = {}): Promise<ListTidsResult> {
  const forb = ensureTidView(ctx);
  if (forb) return forb;
  const db = ctx.db;
  // #14 "Kỳ giao": deliveredAt trong khoảng → ngầm "đã giao". "chưa giao" (delivered=false) THẮNG.
  // B24: Kỳ giao dùng localDayBounds (local half-open) — đồng nhất, tránh lệch ~7h ICT sát biên ngày.
  const delRange = localDayBounds(filter.deliveredFrom, filter.deliveredTo);
  let deliveredAtWhere: { gte?: Date; lt?: Date } | { not: null } | null | undefined;
  if (filter.delivered === false) deliveredAtWhere = null;
  else if (delRange) deliveredAtWhere = delRange;
  else if (filter.delivered === true) deliveredAtWhere = { not: null };
  else deliveredAtWhere = undefined;
  // "khách hàng giữ": chỉ TID ĐÃ GIAO & CÒN SỐNG (không CLOSED/RECALLED/DEAD/SOLD) của đúng khách đó.
  const holding = filter.holdingCustomerId != null;
  // Record<string, unknown> (khuôn buildWhere ở transaction.ts) — tách where ra biến để count + findMany DÙNG CHUNG.
  const where: Record<string, unknown> = {
    deletedAt: null,
    bank: filter.bank || undefined,
    openedAt: dateRange(filter.fromDate, filter.toDate),
    industryId: filter.industryId ?? undefined,
    dossierSourceId: filter.dossierSourceId ?? undefined,
    posSerial: filter.deviceAssigned === undefined ? undefined : filter.deviceAssigned ? { not: null } : null,
    ...(holding
      ? { customerId: filter.holdingCustomerId, deliveredAt: { not: null }, status: { notIn: ['CLOSED', 'RECALLED', 'DEAD', 'SOLD'] } }
      : { status: filter.status || undefined, deliveredAt: deliveredAtWhere }),
    // Tìm kiếm tid/mid/tên HKD — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts: collation "C"
    // làm ILIKE vô dụng với tiếng Việt). Không có từ khoá → trả undefined → Prisma bỏ qua, hành vi y như cũ.
    AND: await dieuKienTimKiem(db, 'tids', { tid: 'tid', mid: 'mid', hkdName: 'hkd_name' }, filter.search)
  };
  const page = Math.max(1, filter.page ?? 1);
  const pageSize = Math.min(TID_PAGE_SIZE_MAX, Math.max(1, filter.pageSize ?? TID_PAGE_SIZE_DEFAULT));
  const total = await db.tid.count({ where });
  // Sắp xếp (Admin Demo 12/8): NHÓM theo ngân hàng trước (gom TID cùng bank liền nhau cho dễ làm), trong nhóm ưu tiên
  // TÊN (hkdName), rồi tid. bankId null (chưa có NH) xuống cuối theo quy ước Postgres NULLS LAST của asc.
  const rows = await db.tid.findMany({ where, orderBy: [{ bankId: 'asc' }, { hkdName: 'asc' }, { tid: 'asc' }], skip: (page - 1) * pageSize, take: pageSize });
  const maps = await buildTidMaps(db, rows);
  return { ok: true, data: rows.map((r) => toDto(r, maps)), total, page, pageSize };
}

/** TID_VIEW OR CONFIG_TID_VIEW — "TID chưa giao" (§A5/§1): còn sống (notIn DEAD/CLOSED/RECALLED),
 *  CHƯA giao (deliveredAt=null), KHÔNG soft-deleted (deletedAt=null). */
export async function listUndeliveredTids(ctx: ServiceCtx): Promise<{ ok: boolean; data?: UndeliveredTidDto[]; error?: string; message?: string }> {
  const forb = ensureTidView(ctx);
  if (forb) return forb;
  const db = ctx.db;
  // MED-5 (phản biện 4/9): LOẠI mã QR (kind='QR') — QR không phải máy POS, không "giao máy", nếu không sẽ hiện MÃI
  // trong badge "TID chưa giao" (rác UX). kind là cột RAW (không trong Prisma client) → lấy id QR qua raw rồi notIn.
  // Degrade an toàn (KHÔNG money): thiếu $queryRawUnsafe (mock) / cột kind chưa có → qrIds=[] = không loại (hành vi POS cũ).
  let qrIds: number[] = [];
  try {
    if (typeof db.$queryRawUnsafe === 'function')
      qrIds = (await db.$queryRawUnsafe<Array<{ id: number }>>(`SELECT id FROM tids WHERE kind = 'QR'`)).map((r) => r.id);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[listUndeliveredTids] không loại được mã QR khỏi badge (dùng danh sách đầy đủ):', e instanceof Error ? e.message : e);
  }
  const rows = await db.tid.findMany({
    where: {
      deletedAt: null, // BUG soft-delete (§1): trước đây thiếu → TID đã xóa vẫn lọt badge.
      status: { notIn: ['DEAD', 'CLOSED', 'RECALLED'] },
      deliveredAt: null,
      ...(qrIds.length ? { id: { notIn: qrIds } } : {})
    },
    orderBy: { openedAt: 'asc' }
  });
  const maps = await buildTidMaps(db, rows);
  const now = Date.now();
  const data = rows.map((t) => {
    const base = (t.openedAt ?? t.createdAt).getTime();
    const agingDays = Math.max(0, Math.floor((now - base) / 86_400_000));
    return { ...toDto(t, maps), agingDays };
  });
  data.sort((a, b) => b.agingDays - a.agingDays);
  return { ok: true, data };
}

export interface CreateTidInput {
  tid: string;
  mid?: string | null;
  bank?: string | null;
  bankId?: number | null; // Cài APP — ngân hàng của TID (khớp app máy khi gán). Config đầy đủ set qua createTidUnified.
  openedAt?: string | null;
}

/** TID_MANAGE — register a TID (UNASSIGNED) + TID_CREATED audit. Helper nội bộ (D3), KHÔNG expose IPC/route. */
export async function createTid(ctx: ServiceCtx, input: CreateTidInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'TID_MANAGE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const tid = input.tid?.trim();
  if (!tid) return { ok: false, error: 'VALIDATION', message: 'Số TID bắt buộc.' };
  const dup = await db.tid.findUnique({ where: { tid } });
  if (dup) return { ok: false, error: 'DUPLICATE', message: `TID "${tid}" đã tồn tại.` };

  const created = await db.tid.create({
    data: {
      tid,
      mid: input.mid ?? null,
      bank: input.bank ?? null,
      bankId: input.bankId ?? null,
      status: 'UNASSIGNED',
      openedAt: input.openedAt ? parseWhen(input.openedAt) : new Date()
    }
  });
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'TID_CREATED',
    targetType: 'Tid',
    targetId: String(created.id),
    after: auditSnapshot({ tid, bank: created.bank, status: 'UNASSIGNED' })
  });
  return { ok: true, id: created.id };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE K2 (Q-T5 + Q-T3/T6) — createTidUnified: 1 form tạo TID ĐẦY ĐỦ. Cho phép CHƯA gán máy + CHƯA giao.
// Nếu có assign/deliver → cùng $transaction. Perm: CONFIG_TID_MANAGE (base) + TID_MANAGE (khi có assign/deliver).
// ─────────────────────────────────────────────────────────────────────────────
export interface CreateTidUnifiedInput {
  tid: string;
  // [Admin Demo 4/9] QR bán hàng: 'QR' = mã QR (không máy POS, không lô); mặc định/thiếu = 'POS' (máy POS như cũ).
  // QR vẫn dùng CHUNG bảng tids (kế thừa đường tiền POS) — chỉ khác: không gán/giao máy, phí tra qua qr_fee_rates.
  kind?: 'POS' | 'QR';
  mid?: string | null;
  dossierId?: number | null; // Q-T3 link HKD
  industryId: number; // #11 LANE A: ngành nghề — BẮT BUỘC khi tạo TID
  hkdName: string; // giữ text (hiển thị/backfill)
  partnerId: number;
  bankId: number;
  receiveAccountId?: number | null;
  investFeeMilli?: number | null; // Phase B — %phí đầu tư override theo TID (×1000); null = dùng mặc định NĐT
  issuedAt?: string | null;
  configStatusId?: number | null;
  dossierSourceId?: number | null;
  note?: string | null;
  customerDeviceSerial?: string | null; // Q-T6 máy của khách
  assign?: { posSerial: string; customerId: number; chatRoomId?: string | null };
  deliver?: { deliveredAt?: string | null; customerId: number; toAgentId?: number | null; chatRoomId?: string | null };
  // PHA 2 (2A) — LOẠI PHÍ MẶC ĐỊNH chọn theo TID lúc giao + (tùy chọn) phí bán thực tế theo loại phí đó.
  defaultFeeTypeId?: number | null;
  sellFees?: HandoverSellFeeEntry[];
}

/** [Admin Demo 4/9] Slug tên HKD cho mã QR tự sinh (bỏ dấu, chỉ chữ-số, HOA, ≤16). Chỉ để tạo định danh tid duy nhất. */
function qrSlug(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // bỏ dấu tổ hợp (Ế→E…)
    .replace(/[đĐ]/g, 'd')
    .replace(/[^a-zA-Z0-9]+/g, '')
    .toUpperCase()
    .slice(0, 16);
  return s || 'QR';
}

export async function createTidUnified(ctx: ServiceCtx, input: CreateTidUnifiedInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'CONFIG_TID_MANAGE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const wantsOps = !!input.assign || !!input.deliver;
  if (wantsOps && !hasPermission(user, 'TID_MANAGE')) {
    await writeAudit(db, { actorUserId: user.id, action: 'PERMISSION_DENIED', targetType: 'Tid', after: { deniedAction: 'TID_ASSIGN_OR_DELIVER', requiredPermission: 'TID_MANAGE', actor: user.username } });
    return { ok: false, error: 'FORBIDDEN', message: 'Cần quyền Quản lý TID (gán/giao) để gán máy hoặc giao khách ngay khi tạo.' };
  }

  const isQr = input.kind === 'QR';
  // QR dùng CHUNG mọi đại lý → chọn đại lý lúc quét bill, KHÔNG gán/giao máy khi tạo. Chặn tường minh.
  if (isQr && (input.assign || input.deliver))
    return { ok: false, error: 'VALIDATION', message: 'Mã QR không gắn máy POS / giao máy (QR dùng chung — chọn đại lý lúc quét bill).' };
  const hkdName = input.hkdName?.trim();
  // QR không có SỐ TID vật lý → dùng mã merchant admin nhập, thiếu thì tự sinh mã định danh (QR-<slug HKD>-<base36 thời điểm>).
  const tid = isQr
    ? input.tid?.trim() ||
      (hkdName ? `QR-${qrSlug(hkdName)}-${Date.now().toString(36)}${Math.floor(Math.random() * 46656).toString(36).padStart(3, '0')}` : '')
    : input.tid?.trim();
  if (!tid) return { ok: false, error: 'VALIDATION', message: isQr ? 'Không sinh được mã QR (thiếu tên HKD).' : 'Chuỗi TID bắt buộc.' };
  if (!input.bankId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn ngân hàng.' };
  if (!input.partnerId) return { ok: false, error: 'VALIDATION', message: 'Vui lòng chọn đối tác.' };
  if (!hkdName) return { ok: false, error: 'VALIDATION', message: 'Tên Hộ Kinh Doanh bắt buộc.' };
  const refErr = await validateConfigRefs(db, input);
  if (refErr) return refErr;
  if (input.dossierId != null) {
    const d = await db.dossier.findUnique({ where: { id: input.dossierId } });
    if (!d || d.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Hồ sơ HKD đã chọn không tồn tại.' };
  }
  // LANE A (#11): ngành nghề BẮT BUỘC + phải tồn tại + đang dùng (active).
  if (input.industryId == null) return { ok: false, error: 'VALIDATION', message: 'Phải chọn ngành nghề khi tạo TID.' };
  const ind = await db.industry.findUnique({ where: { id: input.industryId } });
  if (!ind || ind.deletedAt || !ind.active) return { ok: false, error: 'VALIDATION', message: 'Phải chọn ngành nghề khi tạo TID.' };
  // PHA 2 (2A) — loại phí mặc định (nếu chọn) phải tồn tại. Validate TRƯỚC tx.
  if (input.defaultFeeTypeId != null) {
    const ftErr = await assertFeeTypeValid(db, input.defaultFeeTypeId);
    if (ftErr) return ftErr;
  }

  // Kiểm chứng nhánh assign/deliver TRƯỚC transaction (tránh abort trong tx).
  let devAgentId: number | null = null;
  let assignSerial: string | null = null;
  if (input.assign) {
    assignSerial = input.assign.posSerial?.trim() || null;
    if (!assignSerial) return { ok: false, error: 'VALIDATION', message: 'Phải chọn máy POS để gán TID.' };
    if (input.assign.customerId == null) return { ok: false, error: 'VALIDATION', message: 'Phải chọn khách hàng nhận TID.' };
    const devPre = await db.posDevice.findUnique({ where: { serial: assignSerial } });
    if (!devPre) return { ok: false, error: 'NOT_FOUND', message: `Không tìm thấy máy POS serial "${assignSerial}".` };
    // FIX ASSET-1: CHỈ gán TID được lên máy đang IN_STOCK hoặc DEPLOYED. Chặn IN_REPAIR/DAMAGED/SOLD/RETIRED
    // (không để TID sống trên máy đã bán/hỏng/đang sửa/thanh lý).
    if (devPre.status !== 'IN_STOCK' && devPre.status !== 'DEPLOYED') {
      return { ok: false, error: 'INVALID_STATE', message: `Máy POS ${assignSerial} đang ở trạng thái ${devPre.status}, không gán được TID.` };
    }
    if (devPre.currentTid != null && devPre.currentTid !== tid) {
      return { ok: false, error: 'DEVICE_HAS_TID', message: `Máy ${assignSerial} đang gắn TID ${devPre.currentTid}. Thu hồi TID đó khỏi máy trước khi gán TID khác.` };
    }
  }
  if (input.deliver && input.deliver.customerId == null) {
    return { ok: false, error: 'VALIDATION', message: 'Phải chọn khách hàng để đánh dấu đã giao.' };
  }
  // TID-6 (audit 21/8) — gán + giao TRONG CÙNG lệnh tạo PHẢI cùng 1 khách. Khác nhau ⟹ máy về tay khách A (assign)
  // còn TID ghi đã-giao cho khách B (deliver) = split-brain (device holder ≠ TID holder). Chặn TRƯỚC transaction.
  if (input.assign && input.deliver && input.assign.customerId !== input.deliver.customerId) {
    return { ok: false, error: 'VALIDATION', message: 'Khách nhận máy (gán) và khách được giao TID phải là cùng một khách trong một lần gán + giao.' };
  }
  // FIX2: customerId/agentId là Int? (không FK) → validate tồn tại để không lưu id bừa.
  const custIds = distinctIds([input.assign?.customerId ?? null, input.deliver?.customerId ?? null]);
  for (const cid of custIds) {
    const c = await db.customer.findUnique({ where: { id: cid } });
    if (!c || c.deletedAt) return { ok: false, error: 'NOT_FOUND', message: `Khách hàng #${cid} không tồn tại.` };
  }
  if (input.deliver?.toAgentId != null) {
    const a = await db.agent.findUnique({ where: { id: input.deliver.toAgentId } });
    if (!a || a.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Đại lý đã chọn không tồn tại.' };
  }
  // Phòng chat SigMa — pre-check TỒN TẠI trước transaction.
  for (const roomId of distinctChatRoomIds([input.assign?.chatRoomId, input.deliver?.chatRoomId])) {
    if (!(await assertChatRoomExists(db, roomId))) return { ok: false, error: 'NOT_FOUND', message: 'Phòng chat đã chọn không còn tồn tại — chọn lại.' };
  }

  // tid @unique + soft-delete → phân biệt trùng đang dùng vs trùng trong thùng rác (B05).
  const dup = await db.tid.findFirst({ where: { tid } });
  if (dup) {
    return dup.deletedAt
      ? { ok: false, error: 'DUPLICATE_TRASH', message: `TID "${tid}" đang nằm trong Thùng rác. Hãy phục hồi hoặc chọn TID khác.` }
      : { ok: false, error: 'DUPLICATE', message: `TID "${tid}" đã tồn tại.` };
  }

  const now = new Date();
  let createdId = 0;
  let assignRoomLink: { roomId: string; moved: boolean } | null = null;
  let deliverRoomLink: { roomId: string; moved: boolean } | null = null;
  // GIÁ BÁN GẮN NGÀY GIAO — mốc giao THỰC (deliveredAt ghi vào TID) để làm KỲ hiệu lực giá bán. assign-only =
  // now (deliveredAt gán); deliver = delAt (đè). Không gán/không giao → null → applyHandoverSellFees mặc định hôm nay.
  let deliveredMoment: Date | null = null;
  try {
    await db.$transaction(async (tx) => {
      const createdTid = await tx.tid.create({
        data: {
          tid,
          mid: input.mid ?? null,
          status: 'UNASSIGNED',
          openedAt: now,
          bankId: input.bankId,
          partnerId: input.partnerId,
          hkdName,
          dossierId: input.dossierId ?? null,
          industryId: input.industryId,
          receiveAccountId: input.receiveAccountId ?? null,
          investFeeMilli: input.investFeeMilli ?? null, // Phase B — %phí đầu tư override theo TID
          issuedAt: parseDateOrNull(input.issuedAt),
          configStatusId: input.configStatusId ?? null,
          dossierSourceId: input.dossierSourceId ?? null,
          customerDeviceSerial: input.customerDeviceSerial?.trim() || null,
          note: input.note?.trim() || null,
          defaultFeeTypeId: input.defaultFeeTypeId ?? null, // PHA 2 (2A) — loại phí mặc định theo TID
          createdBy: user.id
        }
      });
      createdId = createdTid.id;
      // [Admin Demo 4/9] Đánh dấu dòng QR (cột kind là RAW, KHÔNG trong Prisma client → set qua raw trong CÙNG tx).
      if (isQr) await tx.$executeRawUnsafe(`UPDATE tids SET kind = 'QR' WHERE id = $1`, createdId);

      let custSet: number | null = null;
      let agentSet: number | null = null;

      if (input.assign && assignSerial) {
        await tx.$queryRaw`SELECT id FROM pos_devices WHERE serial = ${assignSerial} FOR UPDATE`;
        const dev = await tx.posDevice.findUnique({ where: { serial: assignSerial } });
        if (!dev) throw new TidTxAbort({ ok: false, error: 'NOT_FOUND', message: 'Máy POS không còn tồn tại.' });
        // FIX ASSET-1 (re-check trong tx): trạng thái máy có thể đổi giữa pre-check và khóa → abort nếu không còn gán được.
        if (dev.status !== 'IN_STOCK' && dev.status !== 'DEPLOYED') {
          throw new TidTxAbort({ ok: false, error: 'INVALID_STATE', message: `Máy POS ${assignSerial} đang ở trạng thái ${dev.status}, không gán được TID.` });
        }
        if (dev.currentTid != null && dev.currentTid !== tid) {
          throw new TidTxAbort({ ok: false, error: 'DEVICE_HAS_TID', message: `Máy ${assignSerial} đang gắn TID ${dev.currentTid}. Thu hồi TID đó khỏi máy trước khi gán TID khác.` });
        }
        if (dev.bankId == null)
          throw new TidTxAbort({ ok: false, error: 'MACHINE_BLANK', message: `Máy POS "${assignSerial}" là máy trắng (chưa cài app ngân hàng). Vào Sửa máy chọn app cùng bank với TID trước khi gán.` });
        if (dev.bankId !== input.bankId)
          throw new TidTxAbort({ ok: false, error: 'BANK_MISMATCH', message: `Bank của TID không khớp app ngân hàng đã cài trên máy "${assignSerial}". Chỉ gán được TID cùng ngân hàng.` });
        devAgentId = dev.currentAgentId ?? null;
        agentSet = devAgentId;
        custSet = input.assign.customerId;
        await tx.tid.update({ where: { id: createdId }, data: { status: 'ACTIVE', posSerial: assignSerial, customerId: custSet, agentId: agentSet, deliveredAt: now } });
        deliveredMoment = now; // gán máy cho khách = đã giao lúc `now` → KỲ giá bán khớp mốc này (deliver có thể đè bên dưới).
        const posPatch: Record<string, unknown> = { currentTid: tid, currentCustomerId: custSet, updatedBy: user.id };
        if (dev.status === 'IN_STOCK') posPatch.status = 'DEPLOYED';
        // BẤT BIẾN warehouseId≠null ⟺ IN_STOCK: máy nhận TID = ĐÃ GIAO (DEPLOYED) → rời kho.
        posPatch.warehouseId = null;
        posPatch.warehouseLoc = null;
        await tx.posDevice.update({ where: { id: dev.id }, data: posPatch });
        await tx.posTidBinding.create({ data: { posSerial: assignSerial, tid, boundAt: now } });
        await tx.assetEvent.create({
          data: {
            deviceSerial: assignSerial,
            tid,
            eventType: 'TID_ASSIGN',
            fromState: 'UNASSIGNED',
            toState: 'ACTIVE',
            customerId: custSet,
            toAgentId: agentSet,
            actorUserId: user.id,
            occurredAt: now,
            afterJson: JSON.stringify(auditSnapshot({ tid, posSerial: assignSerial, status: 'ACTIVE' }))
          }
        });
        if (input.assign.chatRoomId) {
          const r = await linkTidToRoomForDelivery(tx, createdId, input.assign.chatRoomId, input.assign.customerId);
          assignRoomLink = { roomId: input.assign.chatRoomId, moved: r.moved };
        }
      }

      if (input.deliver) {
        // FIX3: create có CẢ assign lẫn deliver → deliver.occurredAt = max(deliveredAt, assign now) để
        // TID_DELIVERED KHÔNG xếp trước TID_ASSIGN khi deliveredAt lùi ngày.
        const rawDelAt = parseWhen(input.deliver.deliveredAt);
        const delAt = input.assign && rawDelAt.getTime() < now.getTime() ? now : rawDelAt;
        const delCust = input.deliver.customerId;
        const delAgent = input.deliver.toAgentId ?? agentSet ?? null;
        await tx.tid.update({ where: { id: createdId }, data: { status: 'ACTIVE', deliveredAt: delAt, customerId: delCust, agentId: delAgent } });
        deliveredMoment = delAt; // giao khách tại `delAt` = mốc giao THỰC (đè assign nếu có) → KỲ giá bán khớp deliveredAt.
        await tx.assetEvent.create({
          data: {
            deviceSerial: assignSerial,
            tid,
            eventType: 'TID_DELIVERED',
            fromState: input.assign ? 'ACTIVE' : 'UNASSIGNED',
            toState: input.assign ? 'ACTIVE' : 'UNASSIGNED',
            customerId: delCust,
            toAgentId: delAgent,
            actorUserId: user.id,
            occurredAt: delAt,
            note: input.customerDeviceSerial ? `Máy khách: ${input.customerDeviceSerial}` : null
          }
        });
        if (input.deliver.chatRoomId) {
          const r = await linkTidToRoomForDelivery(tx, createdId, input.deliver.chatRoomId, input.deliver.customerId);
          deliverRoomLink = { roomId: input.deliver.chatRoomId, moved: r.moved };
        }
      }
    });
  } catch (e) {
    if (e instanceof TidTxAbort) return e.result;
    if (isUniqueViolation(e)) return { ok: false, error: 'DUPLICATE', message: `TID "${tid}" đã tồn tại.` };
    throw e;
  }

  await writeAudit(db, {
    actorUserId: user.id,
    action: 'TID_CONFIG_CREATED',
    targetType: 'Tid',
    targetId: String(createdId),
    after: auditSnapshot({ tid, bankId: input.bankId, partnerId: input.partnerId, hkdName, assigned: !!input.assign, delivered: !!input.deliver, defaultFeeTypeId: input.defaultFeeTypeId ?? null, assignRoomLink, deliverRoomLink })
  });
  // PHA 2 (2A) — set phí bán thực tế theo loại phí mặc định qua ĐÚNG lõi setTidSellFees (SAU khi TID đã ghi).
  // KỲ hiệu lực = mốc giao THỰC (deliveredMoment); chưa giao (null) → setTidSellFees mặc định hôm nay.
  const feeWarn = await applyHandoverSellFees(ctx, createdId, input.defaultFeeTypeId, input.sellFees, deliveredMoment);
  return { ok: true, id: createdId, ...(feeWarn ? { warning: feeWarn.warning } : {}) };
}

/** TID_MANAGE — danh sách phòng chat SigMa của đại lý phụ trách 1 khách hàng (dropdown form Gán/Giao TID). */
export async function chatRoomsForCustomer(ctx: ServiceCtx, customerId: number): Promise<{ ok: boolean; data?: ChatRoomOptionDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'TID_MANAGE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  if (!Number.isInteger(customerId) || customerId <= 0) return { ok: false, error: 'VALIDATION', message: 'customerId không hợp lệ.' };
  const data = await listChatRoomsForCustomer(ctx.db, customerId);
  return { ok: true, data };
}

/** CONFIG_TID_VIEW — endpoint lite (D1) cho form Thêm TID: HKD + đối tác + ngân hàng + map PartnerBank + ngành nghề. */
export interface TidRefs {
  dossiers: { id: number; hkdName: string; ownerName: string | null }[];
  partners: { id: number; code: string; name: string }[];
  banks: { id: number; code: string; name: string }[];
  partnerBanks: Record<number, number[]>;
  industries: { id: number; code: string; name: string }[];
  /** [B252 22/11 — Admin Demo "danh sách không show NĐT để chọn lọc"] Danh sách NHÀ ĐẦU TƯ cho ô lọc ở
   *  màn TID. Trả TỪ ĐÂY vì endpoint này chỉ cần quyền xem TID — không bắt màn TID phải có thêm
   *  quyền xem danh mục tài khoản nhận tiền, và KHÔNG phụ thuộc bảng đang lọc còn dòng nào hay không. */
  investors: { id: number; name: string }[];
}
export async function tidRefs(ctx: ServiceCtx): Promise<{ ok: boolean; data?: TidRefs; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'CONFIG_TID_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  // Đọc industries TRỰC TIẾP qua db (KHÔNG qua listIndustries) — tránh phụ thuộc quyền CONFIG_INDUSTRY_VIEW mà
  // WAREHOUSE không có (nhưng WAREHOUSE PHẢI tạo được TID). Nhất quán với dossier/partner/bank đọc trực tiếp.
  const [dossiers, partners, banks, links, industries] = await Promise.all([
    db.dossier.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true, hkdName: true, ownerName: true } }),
    db.partner.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true, code: true, name: true } }),
    db.bank.findMany({ where: { deletedAt: null }, orderBy: { id: 'asc' }, select: { id: true, code: true, name: true } }),
    db.partnerBank.findMany({ where: { deletedAt: null }, select: { partnerId: true, bankId: true } }),
    db.industry.findMany({ where: { deletedAt: null, active: true }, orderBy: { id: 'asc' }, select: { id: true, code: true, name: true } })
  ]);
  // [B252] Nhà đầu tư: đọc TRỰC TIẾP (như dossier/partner/bank ở trên) để không kéo theo quyền khác.
  const dsNdt = await db.investor.findMany({
    where: { deletedAt: null },
    orderBy: { id: 'asc' },
    select: { id: true, nickname: true, fullName: true }
  });
  const partnerBanks: Record<number, number[]> = {};
  for (const l of links) (partnerBanks[l.partnerId] ??= []).push(l.bankId);
  return {
    ok: true,
    data: {
      dossiers: dossiers.map((d) => ({ id: d.id, hkdName: d.hkdName, ownerName: d.ownerName ?? null })),
      partners,
      banks,
      partnerBanks,
      industries,
      investors: dsNdt
        .map((v) => ({ id: v.id, name: (v.nickname || v.fullName || '').trim() }))
        .filter((v) => v.name !== '')
    }
  };
}

function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}
function parseDateOrNull(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

export interface AssignTidInput {
  posSerial: string;
  customerId: number;
  occurredAt?: string | null;
  note?: string | null;
  // LOẠI GIAO MÁY — gán TID KÈM MÁY: loại giao + số tiền + quỹ. RENT/DEPOSIT/NONE áp tiền cùng $transaction;
  // SALE bị chặn (bán máy kèm TID dùng chức năng Bán máy). Rỗng = giao nội bộ (Mượn 0đ).
  handoverTypeId?: number | null;
  handoverAmount?: number | null;
  fundId?: number | null;
  handoverDepositAmount?: number | null; // Admin Demo 9/8 — cọc độc lập khi giao TID
  handoverDepositFundId?: number | null;
  method?: string | null; // CK | CASH
  chatRoomId?: string | null;
  // PHA 2 (2A) — LOẠI PHÍ MẶC ĐỊNH + (tùy chọn) phí bán thực tế theo loại phí đó, chọn lúc giao TID kèm máy.
  defaultFeeTypeId?: number | null;
  sellFees?: HandoverSellFeeEntry[];
}

/** TID_MANAGE — bind a UNASSIGNED TID to a POS + customer → ACTIVE (§A3). */
export async function assignTid(ctx: ServiceCtx, tid: string, input: AssignTidInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'TID_MANAGE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const row = await db.tid.findUnique({ where: { tid } });
  // [B264 24/11 — audit đa-agent, CHẶN SHIP] TID nằm trong THÙNG RÁC (deletedAt) vẫn gán/giao/thay được
  // ⇒ máy POS mang một TID VÔ HÌNH: màn TID tìm 0 dòng để sửa, còn mọi bill của máy đó bị từ chối
  // "TID chưa khai báo" (lo-service tra TID có deletedAt: null). Chặn tại đây, nói rõ cách sửa.
  if (!row || row.deletedAt) {
    return { ok: false, error: 'NOT_FOUND', message: row ? `TID "${tid}" đang nằm trong Thùng rác — phục hồi TID trước rồi mới gán máy.` : `Không tìm thấy TID "${tid}".` };
  }
  // [B265 24/11 — audit] Khách phải CÓ THẬT và còn sống: 3 hàm anh em đã kiểm (createTidUnified,
  // markTidDelivered, deployPos), riêng assignTid sót ⇒ ghi được customerId không tồn tại vào CẢ
  // tids.customer_id LẪN pos_devices.current_customer_id, rồi chảy tiếp xuống cọc/tiền thuê.
  if (input.customerId != null) {
    const kh = await db.customer.findFirst({ where: { id: input.customerId, deletedAt: null }, select: { id: true } });
    if (!kh) {
      return { ok: false, error: 'NOT_FOUND', message: `Khách hàng #${input.customerId} không tồn tại (hoặc đã bị xoá) — chọn lại khách rồi gán máy.` };
    }
  }
  const decision = decideTidTransition(row.status as TidStatus, 'assign');
  if (!decision.allowed) {
    return { ok: false, error: decision.reason, message: `Không thể gán TID đang ở trạng thái ${row.status} (đã chết/đóng/thu hồi).` };
  }
  // FIX 1 (K1): TID đang gắn trên 1 máy (posSerial!=null) PHẢI thu hồi khỏi máy đó trước khi lắp máy khác.
  if (row.posSerial != null) {
    return { ok: false, error: 'TID_ON_DEVICE', message: `TID "${tid}" đang gắn trên máy ${row.posSerial}. Thu hồi khỏi máy đó trước khi lắp máy khác.` };
  }
  if (!input.posSerial?.trim()) return { ok: false, error: 'VALIDATION', message: 'Phải chọn máy POS để gán TID.' };
  if (input.customerId == null) return { ok: false, error: 'VALIDATION', message: 'Phải chọn khách hàng nhận TID.' };
  // PHA 2 (2A) — loại phí mặc định (nếu chọn) phải tồn tại. Validate TRƯỚC tx.
  if (input.defaultFeeTypeId != null) {
    const ftErr = await assertFeeTypeValid(db, input.defaultFeeTypeId);
    if (ftErr) return ftErr;
  }

  const serial = input.posSerial.trim();
  const devPre = await db.posDevice.findUnique({ where: { serial } });
  if (!devPre) return { ok: false, error: 'NOT_FOUND', message: `Không tìm thấy máy POS serial "${input.posSerial}".` };
  // FIX ASSET-1: CHỈ gán TID được lên máy đang IN_STOCK hoặc DEPLOYED. Chặn IN_REPAIR/DAMAGED/SOLD/RETIRED
  // (không để TID sống trên máy đã bán/hỏng/đang sửa/thanh lý). Máy DEPLOYED đang giữ CHÍNH tid này = re-assign hợp lệ.
  if (devPre.status !== 'IN_STOCK' && devPre.status !== 'DEPLOYED') {
    return { ok: false, error: 'INVALID_STATE', message: `Máy POS ${serial} đang ở trạng thái ${devPre.status}, không gán được TID.` };
  }
  // Cài APP — gán TID CHỈ khi bank của TID TRÙNG app ngân hàng đã cài trên máy. Máy trắng chặn (re-check trong tx).
  if (devPre.bankId == null)
    return { ok: false, error: 'MACHINE_BLANK', message: `Máy POS "${serial}" là MÁY TRẮNG (chưa cài app ngân hàng). Vào Sửa máy chọn app ngân hàng cùng bank với TID trước khi gán.` };
  if (devPre.bankId !== row.bankId)
    return { ok: false, error: 'BANK_MISMATCH', message: `Bank của TID không khớp app ngân hàng đã cài trên máy "${serial}". Chỉ gán được TID cùng ngân hàng với app đã cài trên máy.` };

  const occurredAt = parseWhen(input.occurredAt);
  // GIÁ BÁN GẮN NGÀY GIAO — mốc giao THỰC ghi vào TID (đồng nhất với logic tx bên dưới): giữ mốc cũ CHỈ khi gán lại
  // CÙNG khách (deliveredAt cũ), ngược lại = occurredAt. Dùng làm KỲ hiệu lực giá bán qua applyHandoverSellFees.
  const deliveredMoment = (row.deliveredAt && row.customerId === input.customerId) ? row.deliveredAt : occurredAt;

  // LOẠI GIAO MÁY — giải mã loại giao + số tiền + quỹ TRƯỚC $transaction (validate). SALE kèm TID → CHẶN.
  const hr = await resolveHandoverInput(db, { handoverTypeId: input.handoverTypeId, amount: input.handoverAmount, fundId: input.fundId, depositAmount: input.handoverDepositAmount, depositFundId: input.handoverDepositFundId, method: input.method });
  if (!hr.ok) return { ok: false, error: hr.error, message: hr.message };
  if (hr.moneyKind === 'SALE') {
    return { ok: false, error: 'USE_SALE_FLOW', message: 'Bán máy kèm TID cần xác nhận mật khẩu — hãy dùng chức năng Bán máy.' };
  }
  const handover: HandoverContext = buildHandoverContext(hr, { deviceSerial: serial, tid, customerId: input.customerId, occurredAt, actorId: user.id });

  // Phòng chat SigMa — pre-check TỒN TẠI trước transaction.
  if (input.chatRoomId && !(await assertChatRoomExists(db, input.chatRoomId))) {
    return { ok: false, error: 'NOT_FOUND', message: 'Phòng chat đã chọn không còn tồn tại — chọn lại.' };
  }

  let devAgentId: number | null = null;
  let roomLink: { roomId: string; moved: boolean } | null = null;
  try {
    await db.$transaction(async (tx) => {
      // PHASE K1: khóa hàng tid + máy FOR UPDATE (TOCTOU) rồi re-đọc trong transaction.
      await tx.$queryRaw`SELECT id FROM tids WHERE tid = ${tid} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM pos_devices WHERE serial = ${serial} FOR UPDATE`;
      // [B320/F5 24/11 — agent đào vét] RE-ĐỌC hàng TID SAU khoá (khuôn recallTid TID-8): bản đọc ngoài
      // tx có thể đã bị phiên khác xoá mềm/đổi posSerial trong khe chờ khoá — chốt B264/B265 đặt ngoài
      // tx là chốt hở (tái hiện tất định: giữ khoá → xoá mềm → TID trong thùng rác vẫn ACTIVE+đã giao).
      const tidTuoi = await tx.tid.findUnique({ where: { id: row.id }, select: { deletedAt: true, posSerial: true, status: true } });
      if (!tidTuoi || tidTuoi.deletedAt)
        throw new TidTxAbort({ ok: false, error: 'NOT_FOUND', message: `TID "${tid}" vừa bị xoá bởi phiên khác — tải lại danh sách rồi thử lại.` });
      if (tidTuoi.posSerial != null && tidTuoi.posSerial !== serial)
        throw new TidTxAbort({ ok: false, error: 'CONFLICT', message: `TID "${tid}" vừa được gán vào máy ${tidTuoi.posSerial} bởi phiên khác — tải lại danh sách.` });
      const dev = await tx.posDevice.findUnique({ where: { serial } });
      if (!dev) throw new TidTxAbort({ ok: false, error: 'NOT_FOUND', message: 'Máy POS không còn tồn tại.' });
      // FIX ASSET-1 (re-check trong tx): trạng thái máy có thể đổi giữa pre-check và khóa FOR UPDATE → abort nếu không còn gán được.
      if (dev.status !== 'IN_STOCK' && dev.status !== 'DEPLOYED') {
        throw new TidTxAbort({ ok: false, error: 'INVALID_STATE', message: `Máy POS ${serial} đang ở trạng thái ${dev.status}, không gán được TID.` });
      }
      // FIX1 (K2 hardening): BẤT BIẾN 1 máy chỉ mang 1 TID.
      if (dev.currentTid != null && dev.currentTid !== tid) {
        throw new TidTxAbort({ ok: false, error: 'DEVICE_HAS_TID', message: `Máy ${serial} đang gắn TID ${dev.currentTid}. Thu hồi TID đó khỏi máy trước khi gán TID khác.` });
      }
      // Cài APP — re-check trong tx: máy trắng chặn + bank khớp.
      if (dev.bankId == null)
        throw new TidTxAbort({ ok: false, error: 'MACHINE_BLANK', message: `Máy POS "${serial}" là máy trắng (chưa cài app ngân hàng) — không gán được TID.` });
      if (dev.bankId !== row.bankId)
        throw new TidTxAbort({ ok: false, error: 'BANK_MISMATCH', message: `Bank của TID không khớp app ngân hàng đã cài trên máy "${serial}".` });
      devAgentId = dev.currentAgentId ?? null;
      await tx.tid.update({
        where: { id: row.id },
        data: {
          // closedAt: null — gán lại TID đã THU HỒI (RECALLED có closedAt) = kích hoạt lại, xoá mốc đóng (Admin Demo 1/9).
          status: 'ACTIVE', posSerial: serial, customerId: input.customerId, agentId: devAgentId, closedAt: null,
          // Gán TID vào máy POS cho khách = ĐÃ GIAO: set deliveredAt. Giữ mốc giao CŨ chỉ khi CÙNG khách
          // (đổi máy cho chính khách đó); đổi sang khách KHÁC (thu hồi→gán lại) → reset về thời điểm gán mới.
          deliveredAt: (row.deliveredAt && row.customerId === input.customerId) ? row.deliveredAt : occurredAt,
          // PHA 2 (2A) — ghi loại phí mặc định CHỈ khi caller gửi (undefined = giữ nguyên, không ghi đè null).
          ...(input.defaultFeeTypeId !== undefined ? { defaultFeeTypeId: input.defaultFeeTypeId } : {})
        }
      });
      // Q-P/§2.4: máy vừa nhập kho (IN_STOCK) → DEPLOYED; giữ nếu đã DEPLOYED.
      const posPatch: Record<string, unknown> = { currentTid: tid, currentCustomerId: input.customerId, updatedBy: user.id };
      if (dev.status === 'IN_STOCK') posPatch.status = 'DEPLOYED';
      // BẤT BIẾN warehouseId≠null ⟺ IN_STOCK: máy nhận TID = ĐÃ GIAO (DEPLOYED) → rời kho.
      posPatch.warehouseId = null;
      posPatch.warehouseLoc = null;
      await tx.posDevice.update({ where: { id: dev.id }, data: posPatch });
      await tx.posTidBinding.create({ data: { posSerial: serial, tid, boundAt: occurredAt } });
      await tx.assetEvent.create({
        data: {
          deviceSerial: serial,
          tid,
          eventType: decision.eventType!,
          fromState: row.status,
          toState: 'ACTIVE',
          customerId: input.customerId,
          toAgentId: devAgentId,
          // LOẠI GIAO MÁY — chỉ ghi khi gán TID kèm máy CÓ chọn loại giao.
          handoverTypeId: handover.handoverTypeId != null ? handover.handoverTypeId : null,
          handoverAmount: handover.handoverTypeId != null ? handover.amount : null,
          actorUserId: user.id,
          occurredAt,
          note: input.note ?? null,
          afterJson: JSON.stringify(auditSnapshot({ tid, posSerial: serial, status: 'ACTIVE' }))
        }
      });
      // LOẠI GIAO MÁY — áp mô hình tiền (RENT/DEPOSIT/NONE) trong CÙNG $transaction. SALE đã chặn ở trên.
      await applyHandoverTx(tx, handover);
      // Phòng chat SigMa — gắn NGAY khi TID có khách cụ thể, atomic cùng transaction giao TID.
      if (input.chatRoomId) {
        const r = await linkTidToRoomForDelivery(tx, row.id, input.chatRoomId, input.customerId);
        roomLink = { roomId: input.chatRoomId, moved: r.moved };
      }
    });
  } catch (e) {
    if (e instanceof TidTxAbort) return e.result;
    // [B320/F5] Kẻ thua cuộc đua vẫn có thể vấp unique `pos_tid_bindings_tid_open_uk` — index ĐÃ cứu
    // dữ liệu, nhưng trước đây P2002 ném thẳng ra 500 "lỗi hệ thống". Trả CONFLICT nói rõ (chuẩn B280).
    if (typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'P2002') {
      return { ok: false, error: 'CONFLICT', message: `TID "${tid}" vừa được máy khác gán xong trước — bấm Làm mới rồi kiểm tra lại.` };
    }
    throw e;
  }

  await writeAudit(db, {
    actorUserId: user.id,
    action: 'TID_ASSIGNED',
    targetType: 'Tid',
    targetId: String(row.id),
    before: { status: row.status },
    after: auditSnapshot({ status: 'ACTIVE', posSerial: serial, customerId: input.customerId, defaultFeeTypeId: input.defaultFeeTypeId ?? null, roomLink })
  });
  // PHA 2 (2A) — set phí bán thực tế theo loại phí mặc định qua ĐÚNG lõi setTidSellFees (SAU khi TID → ACTIVE).
  // KỲ hiệu lực = mốc giao THỰC (deliveredMoment) khớp deliveredAt ghi vào TID.
  const feeWarn = await applyHandoverSellFees(ctx, row.id, input.defaultFeeTypeId, input.sellFees, deliveredMoment);
  return { ok: true, id: row.id, ...(feeWarn ? { warning: feeWarn.warning } : {}) };
}

export interface ReplaceTidInput {
  newTid: string;
  occurredAt?: string | null;
  note?: string | null;
  unbindReason?: string | null;
}

/** TID_MANAGE — swap: old ACTIVE → DEAD + unbind; new UNASSIGNED → ACTIVE + bind to same POS/customer (§A3). */
export async function replaceTid(ctx: ServiceCtx, oldTid: string, input: ReplaceTidInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'TID_MANAGE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const newTidStr = input.newTid?.trim();
  if (!newTidStr) return { ok: false, error: 'VALIDATION', message: 'Phải nhập TID mới để thay thế.' };
  if (newTidStr === oldTid) return { ok: false, error: 'VALIDATION', message: 'TID mới phải khác TID cũ.' };

  const oldRow = await db.tid.findUnique({ where: { tid: oldTid } });
  if (!oldRow || oldRow.deletedAt) {
    return { ok: false, error: 'NOT_FOUND', message: oldRow ? `TID cũ "${oldTid}" đang trong Thùng rác — phục hồi trước khi thay máy.` : `Không tìm thấy TID cũ "${oldTid}".` };
  }
  const oldDecision = decideTidTransition(oldRow.status as TidStatus, 'markDead');
  if (!oldDecision.allowed) {
    return { ok: false, error: oldDecision.reason, message: `TID cũ đang ở trạng thái ${oldRow.status}, chỉ TID đang hoạt động mới thay được.` };
  }
  const newRow = await db.tid.findUnique({ where: { tid: newTidStr } });
  if (!newRow || newRow.deletedAt) {
    return { ok: false, error: 'NOT_FOUND', message: newRow ? `TID mới "${newTidStr}" đang trong Thùng rác — phục hồi trước khi dùng làm TID thay thế.` : `TID mới "${newTidStr}" chưa có trong hệ thống — hãy tạo trước.` };
  }
  const newDecision = decideTidTransition(newRow.status as TidStatus, 'activateReplacement');
  if (!newDecision.allowed) {
    return { ok: false, error: newDecision.reason, message: `TID mới "${newTidStr}" đang ở trạng thái ${newRow.status}, chỉ TID chưa gán mới dùng thay thế được.` };
  }

  const posSerial = oldRow.posSerial;
  const customerId = oldRow.customerId;
  // Cài APP — nếu TID cũ đang TRÊN máy (posSerial), TID thay thế phải CÙNG ngân hàng (= app đã cài trên máy).
  if (posSerial != null && newRow.bankId !== oldRow.bankId)
    return { ok: false, error: 'BANK_MISMATCH', message: `TID mới "${newTidStr}" khác ngân hàng với TID cũ (app đã cài trên máy). TID thay thế phải cùng ngân hàng.` };
  const occurredAt = parseWhen(input.occurredAt);
  // FIX ASSET-3: TID thay thế PHẢI mang mốc ĐÃ GIAO của TID cũ (bất biến "gán-cho-khách ⟹ đã giao").
  // Giữ deliveredAt cũ; nếu TID cũ chưa từng set (null) thì dùng occurredAt để không hiển thị "chưa giao".
  const carriedDeliveredAt = oldRow.deliveredAt ?? occurredAt;

  // FIX ASSET-2 (hardening review 20/8): khóa 2 TID theo THỨ TỰ TOÀN CỤC XÁC ĐỊNH (tid nhỏ hơn theo thứ tự chuỗi
  // TRƯỚC), KHÔNG theo thứ tự tham số (old,new) — nếu không, 2 lời gọi replaceTid với (A,B) và (B,A) sẽ giành khóa
  // ngược chiều → ABBA deadlock (40P01). oldTid !== newTidStr đã đảm bảo ở guard phía trên nên 2 khóa luôn khác hàng.
  const [lockFirstTid, lockSecondTid] = oldTid < newTidStr ? [oldTid, newTidStr] : [newTidStr, oldTid];

  try {
    // FIX ASSET-2 (hardening): retry deadlock/serialization như applyTransition/runWithRetry (pos.ts) — 40P01 dư
    // không thoát ra thành 500, mà retry hoặc map CONFLICT ở dưới.
    await runTidTxWithRetry(() => db.$transaction(async (tx) => {
      // FIX ASSET-2: khóa hàng TOCTOU giống assignTid — thứ tự TOÀN CỤC tids (đã sort) TRƯỚC pos_devices (chống ABBA).
      await tx.$queryRaw`SELECT id FROM tids WHERE tid = ${lockFirstTid} FOR UPDATE`;
      await tx.$queryRaw`SELECT id FROM tids WHERE tid = ${lockSecondTid} FOR UPDATE`;
      if (posSerial) await tx.$queryRaw`SELECT id FROM pos_devices WHERE serial = ${posSerial} FOR UPDATE`;

      // Old TID → DEAD + unbind. TID-1 (audit 20/8): TID chết đã bị thay KHÔNG còn giữ MÁY — phải NHẢ posSerial+agentId
      // (giống recallTid: tháo khỏi máy). Trước đây chỉ ghi {status:DEAD,closedAt} → hàng chết ÔM stale posSerial →
      // orphan serial (2 TID cùng nhận 1 serial vì TID mới cũng vừa nhận posSerial; vi phạm posSerial⟹ACTIVE +
      // posSerial⟹device-link). GIỮ customerId + deliveredAt (lịch sử giao) — KHỚP recallTid (deliveredAt/customerId
      // giữ nguyên) và KHÔNG xoá cột chặn re-giao gián tiếp; guard trạng-thái-terminal ('deliver') mới là hàng rào thật.
      await tx.tid.update({
        where: { id: oldRow.id },
        data: { status: 'DEAD', closedAt: occurredAt, posSerial: null, agentId: null }
      });
      if (posSerial) {
        await tx.posTidBinding.updateMany({
          where: { posSerial, tid: oldTid, unboundAt: null },
          data: { unboundAt: occurredAt, unbindReason: input.unbindReason ?? 'TID_REPLACE' }
        });
      }
      await tx.assetEvent.create({
        data: {
          deviceSerial: posSerial,
          tid: oldTid,
          eventType: oldDecision.eventType!, // TID_DEAD
          fromState: oldRow.status,
          toState: 'DEAD',
          customerId,
          actorUserId: user.id,
          occurredAt,
          note: input.note ?? null
        }
      });
      // New TID → ACTIVE + bind to the same POS/customer + carry deliveredAt (FIX ASSET-3).
      await tx.tid.update({
        where: { id: newRow.id },
        data: { status: 'ACTIVE', posSerial, customerId, agentId: oldRow.agentId, deliveredAt: carriedDeliveredAt }
      });
      if (posSerial) {
        // FIX ASSET-2: re-đọc máy TRONG tx (sau khóa) — chỉ ghi currentTid khi máy VẪN đang mang đúng TID cũ và
        // đang DEPLOYED; nếu đã đổi (thu hồi/gán TID khác/đổi trạng thái) giữa dirty-read và khóa → abort, không đè bừa.
        const dev = await tx.posDevice.findUnique({ where: { serial: posSerial } });
        if (!dev) throw new TidTxAbort({ ok: false, error: 'NOT_FOUND', message: `Máy POS "${posSerial}" không còn tồn tại — hãy tải lại và thử lại.` });
        if (dev.currentTid !== oldTid || dev.status !== 'DEPLOYED') {
          throw new TidTxAbort({ ok: false, error: 'CONFLICT', message: `Máy ${posSerial} đã thay đổi (không còn mang TID ${oldTid} ở trạng thái đã giao). Hãy tải lại và thử lại.` });
        }
        await tx.posTidBinding.create({ data: { posSerial, tid: newTidStr, boundAt: occurredAt } });
        await tx.posDevice.update({ where: { id: dev.id }, data: { currentTid: newTidStr } });
      }
      await tx.assetEvent.create({
        data: {
          deviceSerial: posSerial,
          tid: newTidStr,
          eventType: newDecision.eventType!, // TID_REPLACE
          fromState: newRow.status,
          toState: 'ACTIVE',
          customerId,
          actorUserId: user.id,
          occurredAt,
          note: input.note ?? null,
          afterJson: JSON.stringify(auditSnapshot({ tid: newTidStr, replaces: oldTid, posSerial }))
        }
      });
    }));
  } catch (e) {
    if (e instanceof TidTxAbort) return e.result;
    // FIX ASSET-2 (hardening): deadlock/serialization còn sót sau retry → trả CONFLICT nhẹ nhàng (không phải 500).
    if (isRetryableTidTxError(e)) return { ok: false, error: 'CONFLICT', message: 'Hệ thống đang bận (tranh chấp khóa) — vui lòng tải lại và thử lại.' };
    throw e;
  }

  await writeAudit(db, {
    actorUserId: user.id,
    action: 'TID_REPLACED',
    targetType: 'Tid',
    targetId: String(oldRow.id),
    before: auditSnapshot({ oldTid, oldStatus: oldRow.status }),
    after: auditSnapshot({ oldTid, oldStatus: 'DEAD', newTid: newTidStr, newStatus: 'ACTIVE' })
  });
  return { ok: true, id: newRow.id };
}

export interface RecallTidInput {
  occurredAt?: string | null;
  note?: string | null;
}

/** TID_MANAGE — recall (thu hồi) an ACTIVE/DEAD/CLOSED TID → RECALLED + unbind. */
export async function recallTid(ctx: ServiceCtx, tid: string, input: RecallTidInput = {}): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'TID_MANAGE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const row = await db.tid.findUnique({ where: { tid } });
  if (!row) return { ok: false, error: 'NOT_FOUND', message: `Không tìm thấy TID "${tid}".` };
  // Pre-check NGOÀI tx cho lỗi thân thiện SỚM (chưa mở giao dịch); quyết định THẬT re-check TRONG tx bên dưới.
  const preDecision = decideTidTransition(row.status as TidStatus, 'recall');
  if (!preDecision.allowed) {
    return { ok: false, error: preDecision.reason, message: `Không thể thu hồi TID đang ở trạng thái ${row.status}.` };
  }

  const occurredAt = parseWhen(input.occurredAt);
  // TID-8 (audit 21/8) — TOCTOU: KHÓA hàng tid FOR UPDATE + RE-ĐỌC trong tx + RE-QUYẾT ĐỊNH trước khi ghi RECALLED
  // (khớp assignTid/replaceTid). Trước đây recall dùng SNAPSHOT `row` đọc NGOÀI tx → nếu giữa lúc đọc và ghi có
  // thao tác khác đổi posSerial/customerId/status thì RECALLED bị ghi với posSerial/khách CŨ (mồ côi + audit lệch).
  // Dùng bản TƯƠI (`cur`) cho MỌI trường ghi + audit; retry deadlock/serialization giống replaceTid.
  let recalledId = row.id;
  let recalledFrom = row.status;
  try {
    await runTidTxWithRetry(() => db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM tids WHERE tid = ${tid} FOR UPDATE`;
      const cur = await tx.tid.findUnique({ where: { tid } });
      if (!cur || cur.deletedAt) throw new TidTxAbort({ ok: false, error: 'NOT_FOUND', message: `Không tìm thấy TID "${tid}".` });
      const decision = decideTidTransition(cur.status as TidStatus, 'recall');
      if (!decision.allowed) throw new TidTxAbort({ ok: false, error: decision.reason, message: `Không thể thu hồi TID đang ở trạng thái ${cur.status}.` });
      recalledId = cur.id;
      recalledFrom = cur.status;
      // D4 (PHASE K2): thu hồi TID → clear posSerial + agentId (RECALLED = đã tháo khỏi máy). deliveredAt GIỮ nguyên.
      await tx.tid.update({ where: { id: cur.id }, data: { status: 'RECALLED', closedAt: occurredAt, posSerial: null, agentId: null } });
      if (cur.posSerial) {
        await tx.posTidBinding.updateMany({
          where: { posSerial: cur.posSerial, tid, unboundAt: null },
          data: { unboundAt: occurredAt, unbindReason: input.note ?? 'TID_RECALL' }
        });
        await tx.posDevice.updateMany({ where: { serial: cur.posSerial, currentTid: tid }, data: { currentTid: null } });
      }
      await tx.assetEvent.create({
        data: {
          deviceSerial: cur.posSerial,
          tid,
          eventType: decision.eventType!,
          fromState: cur.status,
          toState: 'RECALLED',
          customerId: cur.customerId,
          actorUserId: user.id,
          occurredAt,
          note: input.note ?? null
        }
      });
    }));
  } catch (e) {
    if (e instanceof TidTxAbort) return e.result;
    if (isRetryableTidTxError(e)) return { ok: false, error: 'CONFLICT', message: 'Hệ thống đang bận (tranh chấp khóa) — vui lòng tải lại và thử lại.' };
    throw e;
  }

  await writeAudit(db, {
    actorUserId: user.id,
    action: 'TID_RECALLED',
    targetType: 'Tid',
    targetId: String(recalledId),
    before: { status: recalledFrom },
    after: auditSnapshot({ status: 'RECALLED' })
  });
  return { ok: true, id: recalledId };
}

export interface MarkDeliveredInput {
  deliveredAt?: string | null;
  /** Q-TL1 — bắt buộc khách (nếu row chưa có), tùy chọn đại lý. Cho "Giao khi chưa gán" (máy khách). */
  customerId?: number | null;
  toAgentId?: number | null;
  note?: string | null;
  chatRoomId?: string | null;
  // PHA 2 (2A) — LOẠI PHÍ MẶC ĐỊNH + (tùy chọn) phí bán thực tế theo loại phí đó, chọn lúc GIAO khách.
  defaultFeeTypeId?: number | null;
  sellFees?: HandoverSellFeeEntry[];
}

/** tx client trong $transaction — có đủ model delegate + $queryRaw (deliverTidWithinTx). */
interface LockedTidRow { delivered_at: Date | null; status: string }
type DeliverTidTxResult =
  | { ok: true; roomLink: { roomId: string; moved: boolean } | null }
  | { ok: false; error: 'ALREADY_DELIVERED' | 'NOT_FOUND'; message: string };

/**
 * Vòng 2.5 (3/8) — LÕI GIAO DỊCH giao TID cho khách, GỌI BÊN TRONG $transaction của caller. ATOMIC guard chống
 * double-delivery: khóa hàng tids FOR UPDATE + re-check delivered_at TRƯỚC khi ghi (bên thua thấy đã giao →
 * ALREADY_DELIVERED, rollback). KHÔNG kiểm quyền/không audit ở đây (markTidDelivered đã đòi TID_MANAGE + writeAudit).
 */
async function deliverTidWithinTx(
  tx: Tx,
  params: { tidId: number; tid: string; deviceSerial: string | null; fromState: string; customerId: number; toAgentId: number | null; actorUserId: number; deliveredAt: Date; note: string | null; chatRoomId?: string | null }
): Promise<DeliverTidTxResult> {
  const locked = await tx.$queryRaw<LockedTidRow[]>`SELECT delivered_at, status FROM tids WHERE id = ${params.tidId} FOR UPDATE`;
  if (locked.length === 0) {
    return { ok: false, error: 'NOT_FOUND', message: `TID id=${params.tidId} không còn tồn tại.` };
  }
  // Admin Demo 1/9: TID đã THU HỒI (RECALLED) tái dùng — recall GIỮ deliveredAt (lịch sử) nên KHÔNG chặn theo
  // deliveredAt khi status=RECALLED; giao lại = kích hoạt ACTIVE + clear closedAt + đặt deliveredAt/khách MỚI. Khác
  // trạng thái vẫn chặn double-delivery theo deliveredAt (race).
  const reactivate = locked[0]!.status === 'RECALLED';
  if (locked[0]!.delivered_at != null && !reactivate) {
    return { ok: false, error: 'ALREADY_DELIVERED', message: `TID id=${params.tidId} đã được đánh dấu đã giao (thao tác đồng thời khác đã giao trước).` };
  }

  // UNASSIGNED giao xong → ACTIVE; RECALLED giao lại → ACTIVE + xoá closedAt (giữ bất biến delivered⟹ACTIVE).
  await tx.tid.update({ where: { id: params.tidId }, data: { status: (params.fromState === 'UNASSIGNED' || reactivate) ? 'ACTIVE' : undefined, ...(reactivate ? { closedAt: null } : {}), deliveredAt: params.deliveredAt, customerId: params.customerId, agentId: params.toAgentId } });
  await tx.assetEvent.create({
    data: {
      deviceSerial: params.deviceSerial,
      tid: params.tid,
      eventType: 'TID_DELIVERED',
      fromState: params.fromState,
      toState: reactivate ? 'ACTIVE' : params.fromState,
      customerId: params.customerId,
      toAgentId: params.toAgentId,
      actorUserId: params.actorUserId,
      occurredAt: params.deliveredAt,
      note: params.note
    }
  });

  let roomLink: { roomId: string; moved: boolean } | null = null;
  if (params.chatRoomId) {
    const r = await linkTidToRoomForDelivery(tx, params.tidId, params.chatRoomId, params.customerId);
    roomLink = { roomId: params.chatRoomId, moved: r.moved };
  }
  return { ok: true, roomLink };
}

/** TID_MANAGE — mark a TID physically delivered (sets deliveredAt + customer + đại lý; §A5/Q-TL1). */
export async function markTidDelivered(ctx: ServiceCtx, tid: string, input: MarkDeliveredInput = {}): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'TID_MANAGE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const row = await db.tid.findUnique({ where: { tid } });
  if (!row || row.deletedAt) {
    return { ok: false, error: 'NOT_FOUND', message: row ? `TID "${tid}" đang nằm trong Thùng rác — phục hồi TID trước rồi mới giao cho khách.` : `Không tìm thấy TID "${tid}".` };
  }
  // Admin Demo 1/9: TID đã THU HỒI (RECALLED) tái dùng được — recall giữ deliveredAt (lịch sử) nên KHÔNG fast-fail
  // theo deliveredAt khi status=RECALLED (giao LẠI cho khách khác). Guard atomic + set ACTIVE trong deliverTidWithinTx.
  if (row.deliveredAt && row.status !== 'RECALLED') return { ok: false, error: 'ALREADY_DELIVERED', message: `TID "${tid}" đã được đánh dấu đã giao.` };
  // TID-1 (audit 20/8) — GUARD TRẠNG THÁI (không chỉ dựa deliveredAt): DEAD/CLOSED/SOLD KHÔNG giao lại (chống TID
  // chết đã thay bị re-giao). RECALLED giờ CHO giao lại (Admin Demo 1/9) — asset.rules deliver.from +RECALLED → ACTIVE.
  const delDecision = decideTidTransition(row.status as TidStatus, 'deliver');
  if (!delDecision.allowed) return { ok: false, error: delDecision.reason, message: `Không thể giao TID "${tid}" đang ở trạng thái ${row.status}.` };

  const customerId = input.customerId ?? row.customerId;
  if (customerId == null) return { ok: false, error: 'VALIDATION', message: 'Phải chọn khách hàng nhận (TID chưa gán máy nên chưa có khách).' };
  if (input.customerId != null) {
    const c = await db.customer.findUnique({ where: { id: input.customerId } });
    if (!c || c.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Khách hàng đã chọn không tồn tại.' };
  }
  const toAgentId = input.toAgentId ?? row.agentId ?? null;
  if (input.toAgentId != null) {
    const a = await db.agent.findUnique({ where: { id: input.toAgentId } });
    if (!a || a.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Đại lý đã chọn không tồn tại.' };
  }
  // PHA 2 (2A) — loại phí mặc định (nếu chọn) phải tồn tại. Validate TRƯỚC tx.
  if (input.defaultFeeTypeId != null) {
    const ftErr = await assertFeeTypeValid(db, input.defaultFeeTypeId);
    if (ftErr) return ftErr;
  }

  // Phòng chat SigMa — pre-check TỒN TẠI trước transaction.
  if (input.chatRoomId && !(await assertChatRoomExists(db, input.chatRoomId))) {
    return { ok: false, error: 'NOT_FOUND', message: 'Phòng chat đã chọn không còn tồn tại — chọn lại.' };
  }

  const deliveredAt = parseWhen(input.deliveredAt);
  let roomLink: { roomId: string; moved: boolean } | null = null;
  // Vòng 2.5 — FIX RACE double-delivery: lõi ghi tách ra deliverTidWithinTx() có khóa hàng FOR UPDATE + re-check.
  // Guard `if(row.deliveredAt)` đọc ngoài tx GIỮ LẠI làm fast-fail UX; guard atomic thật nằm trong tx.
  try {
    await db.$transaction(async (tx) => {
      const r = await deliverTidWithinTx(tx, {
        tidId: row.id,
        tid,
        deviceSerial: row.posSerial,
        fromState: row.status,
        customerId,
        toAgentId,
        actorUserId: user.id,
        deliveredAt,
        note: input.note ?? null,
        chatRoomId: input.chatRoomId
      });
      if (!r.ok) throw new TidTxAbort({ ok: false, error: r.error, message: r.message });
      roomLink = r.roomLink;
      // PHA 2 (2A) — ghi loại phí mặc định CHỈ khi caller gửi (undefined = giữ nguyên), atomic cùng tx giao.
      if (input.defaultFeeTypeId !== undefined) {
        await tx.tid.update({ where: { id: row.id }, data: { defaultFeeTypeId: input.defaultFeeTypeId } });
      }
    });
  } catch (e) {
    if (e instanceof TidTxAbort) return e.result;
    throw e;
  }

  await writeAudit(db, {
    actorUserId: user.id,
    action: 'TID_DELIVERED',
    targetType: 'Tid',
    targetId: String(row.id),
    after: auditSnapshot({ tid, deliveredAt: deliveredAt.toISOString(), customerId, toAgentId, defaultFeeTypeId: input.defaultFeeTypeId ?? null, roomLink })
  });
  // PHA 2 (2A) — set phí bán thực tế theo loại phí mặc định qua ĐÚNG lõi setTidSellFees (SAU khi TID đã giao).
  // KỲ hiệu lực = ĐÚNG mốc giao (deliveredAt) vừa ghi vào TID.
  const feeWarn = await applyHandoverSellFees(ctx, row.id, input.defaultFeeTypeId, input.sellFees, deliveredAt);
  return { ok: true, id: row.id, ...(feeWarn ? { warning: feeWarn.warning } : {}) };
}

// ─────────────────────────────────────────────────────────────────────────────
// PHASE K2 §4 (Q-TL1/TL2) — Timeline cấp TID. Đọc AssetEvent theo chuỗi `tid`. Guard TID_VIEW OR CONFIG_TID_VIEW.
// ─────────────────────────────────────────────────────────────────────────────
// Tên riêng (KHÔNG TimelineEventDto) — pos.ts (agent B2) đã export TimelineEventDto cho getDeviceTimeline; đổi
// tên tránh đụng barrel (giao thoa index). Shape TID-timeline giữ nguyên nghiệp vụ desktop.
export interface TidTimelineEventDto {
  id: number;
  eventType: string;
  fromState: string | null;
  toState: string | null;
  fromAgentId: number | null;
  toAgentId: number | null;
  customerId: number | null;
  customerName: string | null;
  actorUserId: number | null;
  actorName: string | null;
  occurredAt: string;
  note: string | null;
  warehouseName: string | null;
  deliveryAddress: string | null;
  handoverTypeId: number | null;
  handoverName: string | null;
  handoverAmount: number | null;
}

export async function tidTimeline(ctx: ServiceCtx, tid: string): Promise<{ ok: boolean; data?: TidTimelineEventDto[]; error?: string; message?: string }> {
  const forb = ensureTidView(ctx);
  if (forb) return forb;
  const db = ctx.db;
  const row = await db.tid.findUnique({ where: { tid } });
  if (!row) return { ok: false, error: 'NOT_FOUND', message: `Không tìm thấy TID "${tid}".` };
  const events = await db.assetEvent.findMany({
    where: { tid },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }]
  });
  const custIds = [...new Set(events.map((e) => e.customerId).filter((x): x is number => x != null))];
  const custMap = new Map(
    (await db.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, nickname: true, fullName: true } })).map((c) => [c.id, c.nickname || c.fullName])
  );
  const actorIds = [...new Set(events.map((e) => e.actorUserId).filter((x): x is number => x != null))];
  const actorMap = new Map(
    (await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true, username: true } })).map((u) => [u.id, u.fullName || u.username])
  );
  const whIds = [...new Set(events.map((e) => e.fromWarehouseId).filter((x): x is number => x != null))];
  const whMap = new Map(
    (await db.warehouse.findMany({ where: { id: { in: whIds } }, select: { id: true, code: true, name: true } })).map((w) => [w.id, `${w.code} · ${w.name}`])
  );
  const htIds = [...new Set(events.map((e) => e.handoverTypeId).filter((x): x is number => x != null))];
  const htMap = new Map(
    (await db.handoverType.findMany({ where: { id: { in: htIds } }, select: { id: true, name: true } })).map((h) => [h.id, h.name])
  );
  return {
    ok: true,
    data: events.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      fromState: e.fromState,
      toState: e.toState,
      fromAgentId: e.fromAgentId,
      toAgentId: e.toAgentId,
      customerId: e.customerId,
      customerName: e.customerId != null ? custMap.get(e.customerId) ?? null : null,
      actorUserId: e.actorUserId,
      actorName: e.actorUserId != null ? actorMap.get(e.actorUserId) ?? null : null,
      occurredAt: e.occurredAt.toISOString(),
      note: e.note,
      warehouseName: e.fromWarehouseId != null ? whMap.get(e.fromWarehouseId) ?? null : null,
      deliveryAddress: e.deliveryAddress,
      handoverTypeId: e.handoverTypeId,
      handoverName: e.handoverTypeId != null ? htMap.get(e.handoverTypeId) ?? null : null,
      handoverAmount: e.handoverAmount != null ? Number(e.handoverAmount) : null
    }))
  };
}

function parseWhen(iso?: string | null): Date {
  if (!iso) return new Date();
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date() : d;
}

// ─────────────────────────────────────────────────────────────────────────────
// #13 — Xếp hạng doanh số theo TID. Doanh số 1 TID = Σ revenueAmount các Transaction cùng tidId, txnDate ∈ kỳ,
// status='POSTED', writtenOffAt IS NULL, deletedAt IS NULL. Kỳ mặc định = THÁNG HIỆN TẠI. GATE = REVENUE_VIEW.
// ─────────────────────────────────────────────────────────────────────────────
export interface TidRevenueRankFilter {
  from?: string;
  to?: string;
}
export interface TidRevenueRankRow {
  rank: number;
  tidId: number;
  tid: string;
  hkdName: string | null;
  customerName: string | null;
  industryName: string | null;
  revenue: number;
  active: boolean;
}

// B24: bound kỳ theo LOCAL-day, half-open [gte, lt) — ĐỒNG NHẤT với đường mặc định + dashboard. KHÔNG dùng
// dateRange() ở đây (nó parse theo UTC → lệch ~7h trên máy ICT). Một endpoint tiền tệ chỉ có MỘT quy ước biên.
function localDayBounds(from?: string, to?: string): { gte?: Date; lt?: Date } | undefined {
  const parseLocal = (s: string, addDays: number): Date | null => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + addDays);
    return isNaN(d.getTime()) ? null : d;
  };
  const b: { gte?: Date; lt?: Date } = {};
  const gte = from ? parseLocal(from, 0) : null;
  const lt = to ? parseLocal(to, 1) : null;
  if (gte) b.gte = gte;
  if (lt) b.lt = lt;
  return b.gte || b.lt ? b : undefined;
}

export async function tidRevenueRanking(ctx: ServiceCtx, filter: TidRevenueRankFilter = {}): Promise<{ ok: boolean; data?: TidRevenueRankRow[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'REVENUE_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;

  let txnDate: { gte?: Date; lt?: Date } | undefined;
  if (!filter.from && !filter.to) {
    const now = new Date();
    txnDate = { gte: new Date(now.getFullYear(), now.getMonth(), 1), lt: new Date(now.getFullYear(), now.getMonth() + 1, 1) };
  } else {
    txnDate = localDayBounds(filter.from, filter.to);
  }

  // [GÓI TZ 11/9] groupBy giữ nguyên nhưng bound ngày qua prefilter id raw-ISO (Prisma bound Date lệch −7h).
  const idsKy = await idsTheoTxnDate(db, txnDate ?? {});
  const grouped = await db.transaction.groupBy({
    by: ['tidId'],
    where: { status: 'POSTED', deletedAt: null, writtenOffAt: null, ...(txnDate ? { id: { in: idsKy } } : {}) },
    _sum: { revenueAmount: true }
  });
  const withRev = grouped
    .map((r) => ({ tidId: r.tidId, revenue: Number(r._sum.revenueAmount ?? 0) }))
    .filter((r) => r.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue);

  const tidIds = withRev.map((r) => r.tidId);
  // S-1: lọc deletedAt:null — TID đã soft-delete KHÔNG hiện trong bảng xếp hạng.
  const tids = await db.tid.findMany({ where: { id: { in: tidIds }, deletedAt: null }, select: { id: true, tid: true, hkdName: true, status: true, customerId: true, industryId: true } });
  const tidMap = new Map(tids.map((t) => [t.id, t]));
  const custMap = new Map((await db.customer.findMany({ where: { id: { in: distinctIds(tids.map((t) => t.customerId)) } }, select: { id: true, nickname: true, fullName: true } })).map((c) => [c.id, c.nickname || c.fullName]));
  const indMap = new Map((await db.industry.findMany({ where: { id: { in: distinctIds(tids.map((t) => t.industryId)) } }, select: { id: true, name: true } })).map((i) => [i.id, i.name]));

  const data: TidRevenueRankRow[] = withRev.filter((r) => tidMap.has(r.tidId)).map((r, idx) => {
    const t = tidMap.get(r.tidId);
    return {
      rank: idx + 1,
      tidId: r.tidId,
      tid: t?.tid ?? String(r.tidId),
      hkdName: t?.hkdName ?? null,
      customerName: t && t.customerId != null ? custMap.get(t.customerId) ?? null : null,
      industryName: t && t.industryId != null ? indMap.get(t.industryId) ?? null : null,
      revenue: r.revenue,
      active: t?.status === 'ACTIVE'
    };
  });
  return { ok: true, data };
}
