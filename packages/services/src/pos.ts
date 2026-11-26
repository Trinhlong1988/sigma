// Máy POS — vòng đời event-sourced (state machine) — LÕI THUẦN ctx-based. PORT nghiệp vụ từ
// apps/desktop/src/main/pos-service.ts (IMS_SPEC §A). Thay requirePermission(current-user global) bằng ctx = { db, user }
// do adapter dựng; mỗi hàm tự kiểm quyền qua hasPermission(ctx.user, POS_VIEW/POS_MANAGE). GIỮ NGUYÊN business:
// mỗi transition ghi 1 asset_event bất biến (occurredAt = thời điểm thao tác) + chiếu status + audit governance;
// optimistic-lock (staleGuard) khi sửa hồ sơ; khóa hàng tids TRƯỚC pos_devices (chống ABBA) + retry deadlock;
// gỡ/đóng TID khi recall/retire; áp mô hình tiền LOẠI GIAO (deploy) + hoàn cọc (recall) trong CÙNG $transaction.
// XÁC NHẬN MẬT KHẨU (§14, retire) do ADAPTER kiểm TRƯỚC khi gọi lõi — lõi KHÔNG kiểm password (khớp customer.ts).
// MutationResult/ServiceCtx từ customer.js.
import { decidePosTransition, decideTidTransition, auditSnapshot, type PosEvent, type PosStatus, type TidStatus } from '@sigma/business-rules';
import { Prisma, type Db } from '@sigma/database';
import { hasPermission } from '@sigma/shared';
import { writeAudit } from './audit.js';
import { staleGuard } from './optimistic-lock.js';
import { dateRange, type ServiceCtx, type MutationResult } from './customer.js';
import { resolveHandoverInput, buildHandoverContext, applyHandoverTx, refundOpenDepositsForSerialTx, flagStrandedDepositsTx, type HandoverContext } from './deposit.js';
import { relinkTidRoomOnCustomerChange, unlinkActiveTidRoom, ChatRoomTidConflictError } from './chat-room-tid.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật trên sổ thật: ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';

const VIEW = 'POS_VIEW';
const MANAGE = 'POS_MANAGE';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

/**
 * FIX-FK (5/8, finding QA lớp lỗi "scalar-ref không validate FK"): `PosDevice.currentCustomerId` /
 * `currentAgentId` là scalar KHÔNG có FK cứng ở DB (triết lý schema "no hard FK, join tại service"). Các
 * transition deploy (ghi currentCustomerId + currentAgentId) và transferAgent (ghi currentAgentId) nhận
 * `input.customerId`/`input.agentId` từ client — nếu trỏ khách/đại lý KHÔNG tồn tại hoặc đã xóa mềm mà ghi
 * thẳng sẽ thành tham chiếu MỒ CÔI (không lỗi DB nào chặn; giá trị này còn chảy xuống deposit/handover). Vì
 * vậy PHẢI validate ở tầng service TRƯỚC $transaction (khuôn assertAgentValid ở customer.ts + nhánh
 * changeCustomer đã có sẵn bên dưới). null/undefined = "không gán" → hợp lệ, KHÔNG kiểm; chỉ kiểm khi là số thật.
 */
async function assertCustomerValid(db: Db, customerId: number | null | undefined): Promise<MutationResult | null> {
  if (customerId == null) return null;
  const c = await db.customer.findFirst({ where: { id: customerId, deletedAt: null }, select: { id: true } });
  if (!c) return { ok: false, error: 'VALIDATION', message: 'Khách hàng được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.' };
  return null;
}
async function assertAgentValid(db: Db, agentId: number | null | undefined): Promise<MutationResult | null> {
  if (agentId == null) return null;
  const a = await db.agent.findFirst({ where: { id: agentId, deletedAt: null }, select: { id: true } });
  if (!a) return { ok: false, error: 'VALIDATION', message: 'Đại lý được chọn không tồn tại (hoặc đã bị xóa). Vui lòng chọn lại.' };
  return null;
}

export interface PosDto {
  id: number;
  serial: string;
  model: string | null;
  bank: string | null;
  // Cài APP (Admin Demo 13/7) — app ngân hàng đã cài trên máy (FK Bank). null = MÁY TRẮNG (chưa cài app).
  bankId: number | null;
  bankCode: string | null; // mã ngân hàng app (AB/VP/MB…) để hiển thị cột "Cài APP"
  status: string;
  currentAgentId: number | null;
  currentCustomerId: number | null;
  currentTid: string | null;
  hkdName: string | null; // tên HKD của TID đang gắn (currentTid)
  warehouseLoc: string | null;
  warehouseId: number | null; // Model 1 — kho vật lý đang chứa máy (chỉ khi IN_STOCK)
  warehouseName: string | null; // "MÃ · Tên" kho hiện tại
  recallPending: boolean; // #6 — khách đã hủy, máy chưa thu về (còn ở khách)
  note: string | null;
  createdAt: string;
  updatedAt: string; // optimistic-lock token (Admin Demo 11/8) — renderer gửi lại để phát hiện máy đã đổi giữa chừng
  posModelId: number | null;
  posModelName: string | null; // "MÃ · Tên" chủng loại
  supplierId: number | null;
  supplierName: string | null;
  importPrice: number | null;
  importedAt: string | null;
  // [Admin Demo 15/11] GIÁ/NGÀY XUẤT — nhập tay y như giá nhập. Cột phụ `pos_devices.exported_at|export_price`
  // (schema-ensure, CỐ Ý ngoài Prisma client) ⇒ đọc/ghi bằng raw SQL.
  exportPrice: number | null;
  exportedAt: string | null;
  customerName: string | null; // tên khách đang giữ máy (currentCustomerId)
  agentName: string | null; // tên đại lý (currentAgentId)
}

export interface TimelineEventDto {
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
  tid: string | null;
  fromWarehouseId: number | null;
  warehouseName: string | null;
  deliveryAddress: string | null;
  handoverTypeId: number | null;
  handoverName: string | null;
  handoverAmount: number | null;
}

export interface PosFilter {
  search?: string;
  bank?: string;
  status?: string;
  agentId?: number;
  warehouseId?: number; // Model 1 — lọc theo kho vật lý đang chứa máy
  bankId?: number; // Cài APP — lọc máy đã cài app ngân hàng cụ thể
  bankBlank?: boolean; // Cài APP — lọc MÁY TRẮNG (bankId = null)
  fromDate?: string;
  toDate?: string;
}

interface PosDeviceRow {
  id: number;
  serial: string;
  model: string | null;
  bank: string | null;
  bankId: number | null;
  status: string;
  currentAgentId: number | null;
  currentCustomerId: number | null;
  currentTid: string | null;
  warehouseLoc: string | null;
  warehouseId: number | null;
  recallPending: boolean;
  note: string | null;
  createdAt: Date;
  updatedAt: Date;
  posModelId: number | null;
  supplierId: number | null;
  importPrice: number | null;
  importedAt: Date | null;
  exportPrice?: number | null;
  exportedAt?: Date | null;
}
interface PosNameMaps {
  models: Map<number, { code: string; name: string }>;
  suppliers: Map<number, { code: string; name: string }>;
  customers: Map<number, string>;
  agents: Map<number, string>;
  warehouses: Map<number, string>;
  banks: Map<number, string>; // Cài APP — mã ngân hàng (code)
  tidHkd: Map<string, string | null>; // currentTid → tên HKD của TID
}
function toDto(d: PosDeviceRow, maps: PosNameMaps): PosDto {
  const m = d.posModelId != null ? maps.models.get(d.posModelId) : undefined;
  const s = d.supplierId != null ? maps.suppliers.get(d.supplierId) : undefined;
  const tidHkdMap = maps.tidHkd;
  return {
    id: d.id,
    serial: d.serial,
    model: d.model,
    bank: d.bank,
    bankId: d.bankId,
    bankCode: d.bankId != null ? maps.banks.get(d.bankId) ?? null : null,
    status: d.status,
    currentAgentId: d.currentAgentId,
    currentCustomerId: d.currentCustomerId,
    currentTid: d.currentTid,
    hkdName: d.currentTid != null ? (tidHkdMap.get(d.currentTid) ?? null) : null,
    warehouseLoc: d.warehouseLoc,
    warehouseId: d.warehouseId,
    warehouseName: d.warehouseId != null ? maps.warehouses.get(d.warehouseId) ?? null : null,
    recallPending: d.recallPending,
    note: d.note,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
    posModelId: d.posModelId,
    posModelName: m ? (m.code === m.name ? m.name : `${m.code} · ${m.name}`) : d.model,
    supplierId: d.supplierId,
    supplierName: s ? `${s.code} · ${s.name}` : null,
    importPrice: d.importPrice,
    importedAt: d.importedAt ? d.importedAt.toISOString() : null,
    exportPrice: d.exportPrice ?? null,
    exportedAt: d.exportedAt ? new Date(d.exportedAt).toISOString() : null,
    customerName: d.currentCustomerId != null ? maps.customers.get(d.currentCustomerId) ?? null : null,
    agentName: d.currentAgentId != null ? maps.agents.get(d.currentAgentId) ?? null : null
  };
}

/** POS_VIEW — list devices with search (serial) + bank/status/agent filters. */
export async function listPosDevices(ctx: ServiceCtx, filter: PosFilter = {}): Promise<{ ok: boolean; data?: PosDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const rows = await db.posDevice.findMany({
    where: {
      deletedAt: null,
      bank: filter.bank || undefined,
      status: filter.status || undefined,
      currentAgentId: filter.agentId ?? undefined,
      warehouseId: filter.warehouseId ?? undefined,
      // Cài APP — lọc theo app ngân hàng: bankId cụ thể HOẶC máy trắng (bankId null). Không truyền cả 2.
      bankId: filter.bankBlank ? null : (filter.bankId ?? undefined),
      createdAt: dateRange(filter.fromDate, filter.toDate),
      // Tìm kiếm serial/TID đang gắn — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts).
      AND: await dieuKienTimKiem(db, 'pos_devices', { serial: 'serial', currentTid: 'current_tid' }, filter.search)
    },
    orderBy: { id: 'asc' }
  });
  // 2 cột phụ (ngoài Prisma client) — nạp 1 lượt theo đúng tập id vừa lấy, rồi gắn vào từng dòng.
  if (rows.length > 0) {
    const phu = await db.$queryRawUnsafe<Array<{ id: number; exported_at: Date | null; export_price: bigint | number | null }>>(
      'SELECT id, exported_at, export_price FROM pos_devices WHERE id = ANY($1)', rows.map((r) => r.id));
    const bang = new Map(phu.map((x) => [x.id, x]));
    for (const r of rows as unknown as PosDeviceRow[]) {
      const x = bang.get(r.id);
      r.exportedAt = x?.exported_at ?? null;
      r.exportPrice = x?.export_price == null ? null : Number(x.export_price);
    }
  }
  const modelIds = [...new Set(rows.map((r) => r.posModelId).filter((x): x is number => x != null))];
  const supplierIds = [...new Set(rows.map((r) => r.supplierId).filter((x): x is number => x != null))];
  const customerIds = [...new Set(rows.map((r) => r.currentCustomerId).filter((x): x is number => x != null))];
  const agentIds = [...new Set(rows.map((r) => r.currentAgentId).filter((x): x is number => x != null))];
  const whIds = [...new Set(rows.map((r) => r.warehouseId).filter((x): x is number => x != null))];
  const bankIds = [...new Set(rows.map((r) => r.bankId).filter((x): x is number => x != null))];
  const tids = [...new Set(rows.map((r) => r.currentTid).filter((x): x is string => x != null))];
  const maps: PosNameMaps = {
    models: new Map((await db.posModel.findMany({ where: { id: { in: modelIds } }, select: { id: true, code: true, name: true } })).map((x) => [x.id, { code: x.code, name: x.name }])),
    suppliers: new Map((await db.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, code: true, name: true } })).map((x) => [x.id, { code: x.code, name: x.name }])),
    customers: new Map((await db.customer.findMany({ where: { id: { in: customerIds } }, select: { id: true, nickname: true, fullName: true } })).map((x) => [x.id, x.nickname || x.fullName])),
    agents: new Map((await db.agent.findMany({ where: { id: { in: agentIds } }, select: { id: true, name: true } })).map((x) => [x.id, x.name])),
    warehouses: new Map((await db.warehouse.findMany({ where: { id: { in: whIds } }, select: { id: true, code: true, name: true } })).map((x) => [x.id, `${x.code} · ${x.name}`])),
    banks: new Map((await db.bank.findMany({ where: { id: { in: bankIds } }, select: { id: true, code: true } })).map((x) => [x.id, x.code])),
    tidHkd: new Map((await db.tid.findMany({ where: { tid: { in: tids } }, select: { tid: true, hkdName: true } })).map((x) => [x.tid, x.hkdName]))
  };
  return { ok: true, data: rows.map((r) => toDto(r, maps)) };
}

/** POS_VIEW — the immutable timeline for one device, oldest → newest (§A4). */
export async function getDeviceTimeline(ctx: ServiceCtx, serial: string): Promise<{ ok: boolean; data?: TimelineEventDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, VIEW)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const db = ctx.db;
  const dev = await db.posDevice.findUnique({ where: { serial } });
  if (!dev) return { ok: false, error: 'NOT_FOUND', message: `Không tìm thấy máy POS serial "${serial}".` };
  const events = await db.assetEvent.findMany({ where: { deviceSerial: serial }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
  const whIds = [...new Set(events.map((e) => e.fromWarehouseId).filter((x): x is number => x != null))];
  const whMap = new Map((await db.warehouse.findMany({ where: { id: { in: whIds } }, select: { id: true, code: true, name: true } })).map((w) => [w.id, `${w.code} · ${w.name}`]));
  const custIds = [...new Set(events.map((e) => e.customerId).filter((x): x is number => x != null))];
  const custMap = new Map((await db.customer.findMany({ where: { id: { in: custIds } }, select: { id: true, nickname: true, fullName: true } })).map((c) => [c.id, c.nickname || c.fullName]));
  const actorIds = [...new Set(events.map((e) => e.actorUserId).filter((x): x is number => x != null))];
  const actorMap = new Map((await db.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, fullName: true, username: true } })).map((u) => [u.id, u.fullName || u.username]));
  const htIds = [...new Set(events.map((e) => e.handoverTypeId).filter((x): x is number => x != null))];
  const htMap = new Map((await db.handoverType.findMany({ where: { id: { in: htIds } }, select: { id: true, name: true } })).map((h) => [h.id, h.name]));
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
      tid: e.tid,
      fromWarehouseId: e.fromWarehouseId,
      warehouseName: e.fromWarehouseId != null ? whMap.get(e.fromWarehouseId) ?? null : null,
      deliveryAddress: e.deliveryAddress,
      handoverTypeId: e.handoverTypeId,
      handoverName: e.handoverTypeId != null ? htMap.get(e.handoverTypeId) ?? null : null,
      handoverAmount: e.handoverAmount != null ? Number(e.handoverAmount) : null
    }))
  };
}

export interface CreatePosInput {
  serial: string;
  model?: string | null;
  bank?: string | null;
  warehouseLoc?: string | null;
  note?: string | null;
  occurredAt?: string | null;
}

/** P1-07: chuẩn hóa serial để so GẦN-TRÙNG (bỏ khoảng trắng + viết hoa) — dùng cho guard chống trùng, KHÔNG
 * đổi giá trị serial lưu trữ (serial thật giữ nguyên hoa/thường như người dùng nhập). */
export function normalizeSerial(s: string): string {
  return String(s ?? '').replace(/\s+/g, '').toUpperCase();
}

/** POS_MANAGE — register a new device (IN_STOCK) + STOCK_IN event + audit. */
export async function createPos(ctx: ServiceCtx, input: CreatePosInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const serial = input.serial?.trim();
  if (!serial) return { ok: false, error: 'VALIDATION', message: 'Serial máy POS bắt buộc.' };
  const dup = await db.posDevice.findUnique({ where: { serial } });
  if (dup) return { ok: false, error: 'DUPLICATE', message: `Serial POS "${serial}" đã tồn tại.` };
  // P1-07 (hardening 16/7): chặn serial GẦN TRÙNG — chỉ khác hoa/thường hoặc khoảng trắng → tránh 2 record cho
  // 1 thiết bị. Chỉ so chuẩn-hóa với máy ĐANG SỐNG (deleted_at IS NULL) để không chặn hồi sinh máy đã xóa mềm.
  const normalized = normalizeSerial(serial);
  const near = await db.$queryRaw<{ serial: string }[]>`
    SELECT serial FROM pos_devices
    WHERE deleted_at IS NULL AND upper(regexp_replace(serial, '[[:space:]]+', '', 'g')) = ${normalized}
    LIMIT 1`;
  if (Array.isArray(near) && near.length > 0) {
    return { ok: false, error: 'DUPLICATE', message: `Serial POS gần trùng đã tồn tại: "${near[0].serial}" (chỉ khác hoa/thường hoặc khoảng trắng).` };
  }

  const occurredAt = parseWhen(input.occurredAt);
  const created = await db.$transaction(async (tx) => {
    const dev = await tx.posDevice.create({
      data: { serial, model: input.model ?? null, bank: input.bank ?? null, status: 'IN_STOCK', warehouseLoc: input.warehouseLoc ?? null, note: input.note ?? null }
    });
    await tx.assetEvent.create({
      data: { deviceSerial: serial, eventType: 'STOCK_IN', toState: 'IN_STOCK', actorUserId: user.id, occurredAt, note: input.note ?? null, afterJson: JSON.stringify(auditSnapshot({ serial, bank: dev.bank, status: 'IN_STOCK' })) }
    });
    return dev;
  });

  await writeAudit(db, { actorUserId: user.id, action: 'POS_CREATED', targetType: 'PosDevice', targetId: String(created.id), after: auditSnapshot({ serial, bank: created.bank, status: 'IN_STOCK' }) });
  return { ok: true, id: created.id };
}

// ── Sửa THÔNG TIN HỒ SƠ máy POS (Nhóm 1, Admin Demo 12/7) — KHÔNG đụng trạng thái/gán (state machine đi qua luồng
// thao tác riêng). Serial (định danh, khóa join event-log) BẤT BIẾN — không sửa.
export interface UpdatePosInput {
  model?: string | null;
  bank?: string | null;
  bankId?: number | null; // Cài APP — app ngân hàng cài trên máy (null = máy trắng).
  posModelId?: number | null;
  supplierId?: number | null;
  importPrice?: number | null;
  importedAt?: string | null;
  exportPrice?: number | null; // [15/11] giá xuất — nhập tay
  exportedAt?: string | null;  // [15/11] ngày xuất — nhập tay
  warehouseId?: number | null; // Admin Demo 15/7 — đổi KHO đang chứa máy ngay trong form (chỉ khi IN_STOCK)
  warehouseLoc?: string | null;
  note?: string | null;
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form
}

/** POS_MANAGE — sửa hồ sơ máy (không đổi trạng thái/gán/kho vật lý/serial). Audit before/after + optlock. */
export async function updatePos(ctx: ServiceCtx, id: number, input: UpdatePosInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const row = await db.posDevice.findUnique({ where: { id } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy máy POS.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;

  if (input.posModelId != null) {
    const m = await db.posModel.findFirst({ where: { id: input.posModelId, deletedAt: null }, select: { id: true } });
    if (!m) return { ok: false, error: 'NOT_FOUND', message: 'Chủng loại POS đã chọn không tồn tại.' };
  }
  if (input.supplierId != null) {
    const s = await db.supplier.findFirst({ where: { id: input.supplierId, deletedAt: null }, select: { id: true } });
    if (!s) return { ok: false, error: 'NOT_FOUND', message: 'Nhà cung cấp đã chọn không tồn tại.' };
  }
  // Admin Demo 15/7 — đổi KHO trong form: chỉ khi máy đang IN_STOCK (giữ invariant warehouseId≠null⟺IN_STOCK).
  if (input.warehouseId !== undefined) {
    if (row.status !== 'IN_STOCK') return { ok: false, error: 'VALIDATION', message: 'Chỉ đổi kho được khi máy đang TRONG KHO. Máy đã giao/bán đổi kho qua nút Thao tác.' };
    if (input.warehouseId == null) return { ok: false, error: 'VALIDATION', message: 'Máy trong kho phải thuộc 1 kho — không để trống.' };
    const wh = await db.warehouse.findFirst({ where: { id: input.warehouseId, deletedAt: null }, select: { id: true, status: true } });
    if (!wh) return { ok: false, error: 'NOT_FOUND', message: 'Kho đã chọn không tồn tại.' };
    if (wh.status !== 'ACTIVE') return { ok: false, error: 'VALIDATION', message: 'Kho đã ngừng hoạt động — không thể chuyển máy vào.' };
  }
  // Cài APP — nếu chọn app ngân hàng (bankId>0) phải tồn tại + còn dùng (ACTIVE). bankId null/0 = máy trắng.
  if (input.bankId != null) {
    const bk = await db.bank.findFirst({ where: { id: input.bankId, deletedAt: null }, select: { id: true, status: true } });
    if (!bk) return { ok: false, error: 'NOT_FOUND', message: 'Ngân hàng (app) đã chọn không tồn tại.' };
    if (bk.status !== 'ACTIVE') return { ok: false, error: 'VALIDATION', message: 'Ngân hàng (app) đã ngừng sử dụng — không thể cài lên máy.' };
  }

  const before = auditSnapshot({ model: row.model, bank: row.bank, bankId: row.bankId, posModelId: row.posModelId, supplierId: row.supplierId, importPrice: row.importPrice, importedAt: row.importedAt ? row.importedAt.toISOString() : null, warehouseId: row.warehouseId, warehouseLoc: row.warehouseLoc, note: row.note });
  const importedAt = input.importedAt !== undefined ? (input.importedAt ? parseWhen(input.importedAt) : null) : row.importedAt;
  const updated = await db.posDevice.update({
    where: { id },
    data: {
      model: input.model !== undefined ? input.model?.trim() || null : row.model,
      bank: input.bank !== undefined ? input.bank?.trim() || null : row.bank,
      bankId: input.bankId !== undefined ? (input.bankId || null) : row.bankId,
      posModelId: input.posModelId !== undefined ? input.posModelId : row.posModelId,
      supplierId: input.supplierId !== undefined ? input.supplierId : row.supplierId,
      importPrice: input.importPrice !== undefined ? input.importPrice : row.importPrice,
      importedAt,
      warehouseId: input.warehouseId !== undefined ? input.warehouseId : row.warehouseId,
      warehouseLoc: input.warehouseLoc !== undefined ? input.warehouseLoc?.trim() || null : row.warehouseLoc,
      note: input.note !== undefined ? input.note?.trim() || null : row.note,
      updatedBy: user.id
    }
  });
  // 2 cột phụ: ghi raw (ngoài Prisma client). Chỉ đụng khi client CÓ GỬI khoá — `undefined` = giữ nguyên,
  // `null` = xoá trống (phân biệt đúng như bài học "null bị nuốt" 13/11).
  if (input.exportPrice !== undefined) {
    await db.$executeRawUnsafe('UPDATE pos_devices SET export_price = $1 WHERE id = $2', input.exportPrice, id);
  }
  if (input.exportedAt !== undefined) {
    await db.$executeRawUnsafe('UPDATE pos_devices SET exported_at = $1::timestamptz WHERE id = $2', input.exportedAt, id);
  }
  await writeAudit(db, { actorUserId: user.id, action: 'POS_UPDATED', targetType: 'PosDevice', targetId: String(id), before, after: auditSnapshot({ model: updated.model, bank: updated.bank, bankId: updated.bankId, posModelId: updated.posModelId, supplierId: updated.supplierId, importPrice: updated.importPrice, exportPrice: input.exportPrice, exportedAt: input.exportedAt, warehouseId: updated.warehouseId, warehouseLoc: updated.warehouseLoc, note: updated.note }) });
  return { ok: true, id };
}

export interface TransitionInput {
  occurredAt?: string | null;
  note?: string | null;
  agentId?: number | null; // deploy / transferAgent target
  customerId?: number | null; // deploy target
  fromWarehouseId?: number | null; // R27 (§4) — giao/đổi-khách: kho xuất
  toWarehouseId?: number | null; // Model 1 — thu hồi / nhận-sửa VỀ kho nào
  handoverTypeId?: number | null;
  handoverAmount?: number | null;
  fundId?: number | null;
  handoverDepositAmount?: number | null; // Admin Demo 9/8 — cọc độc lập khi giao
  handoverDepositFundId?: number | null;
  method?: string | null; // CK | CASH (khi có tiền)
}

/** Vietnamese label for a rejected transition reason (R_UX_WARN). */
function transitionDenyMessage(reason: string | undefined, from: string, event: PosEvent): string {
  if (reason === 'INVALID_STATE') {
    return `Không thể thực hiện "${POS_EVENT_LABELS[event]}" khi máy đang ở trạng thái ${from}.`;
  }
  return 'Chuyển trạng thái không hợp lệ.';
}

const POS_EVENT_LABELS: Record<PosEvent, string> = {
  deploy: 'Triển khai (giao khách)',
  recall: 'Thu hồi về kho',
  transferAgent: 'Chuyển đại lý',
  changeCustomer: 'Đổi khách giữ máy',
  cancelCustomer: 'Hủy khách giữ máy',
  sell: 'Bán máy',
  reportDamage: 'Báo hỏng',
  sendRepair: 'Gửi bảo trì',
  receiveRepaired: 'Nhận sửa xong',
  retire: 'Thanh lý'
};

/** Interactive-transaction client type (Prisma 7). */
type PrismaTx = Prisma.TransactionClient;

/** Sentinel thrown inside a $transaction to abort with a caller-facing MutationResult. */
class TransitionAbort extends Error {
  constructor(public readonly result: MutationResult) {
    super(result.message ?? result.error ?? 'ABORT');
  }
}

/** Sentinel: state raced between dirty-read và khóa (currentTid đổi) → chạy lại transaction sạch. */
class RetrySignal extends Error {}

/** True nếu lỗi Postgres là deadlock (40P01) hoặc serialization failure (40001) → nên retry. */
function isRetryablePgError(e: unknown): boolean {
  if (e instanceof RetrySignal) return true;
  const code = (e as { code?: string })?.code;
  return code === '40P01' || code === '40001';
}

/** Chạy 1 transaction, retry tối đa `attempts` lần khi gặp deadlock/serialization/RetrySignal. */
async function runWithRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof TransitionAbort) throw e;
      if (isRetryablePgError(e)) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/**
 * PHASE K1 (Q-P6, §2.5) — gỡ gán TID khỏi 1 máy trong CÙNG transaction (chống mồ côi):
 *  - mode 'recall'  (Thu hồi máy): máy về kho, TID về "Chưa gán máy" (clear posSerial/agentId, GIỮ
 *                   customerId/status). Event TID_UNBIND.
 *  - mode 'retire'  (Thanh lý máy): máy biến mất → ĐÓNG/THU HỒI TID (status → RECALLED nếu đang sống),
 *                   clear posSerial. Event TID_RECALL.
 * Khóa hàng tids FOR UPDATE trước khi đổi (TOCTOU). Không làm gì nếu máy không còn currentTid.
 */
async function unbindTidFromDevice(
  tx: PrismaTx,
  args: { serial: string; tid: string; mode: 'recall' | 'retire'; actorUserId: number; occurredAt: Date; note: string | null }
): Promise<void> {
  const { serial, tid, mode, actorUserId, occurredAt, note } = args;
  await tx.$queryRaw`SELECT id FROM tids WHERE tid = ${tid} FOR UPDATE`;
  const row = await tx.tid.findUnique({ where: { tid } });
  if (!row) return; // TID đã biến mất → không có gì để gỡ.
  const fromState = row.status;
  let toState = fromState;
  const data: Record<string, unknown> = { posSerial: null, agentId: null };
  let eventType = 'TID_UNBIND';
  if (mode === 'retire') {
    const decision = decideTidTransition(fromState as TidStatus, 'recall');
    if (decision.allowed) {
      toState = decision.to!;
      data.status = toState;
      data.closedAt = occurredAt;
      eventType = decision.eventType!; // TID_RECALL
    }
  } else if (mode === 'recall') {
    // OWNER DECISION (RESET, 20/8): THU HỒI MÁY về kho ⟹ TID reset hoàn toàn về "chưa gán máy, chưa giao, chưa có
    // khách" — ngoài posSerial/agentId còn xóa customerId + deliveredAt và đưa status về UNASSIGNED (không giữ ACTIVE).
    data.status = 'UNASSIGNED';
    data.customerId = null;
    data.deliveredAt = null;
    toState = 'UNASSIGNED';
  }
  await tx.tid.update({ where: { id: row.id }, data });
  // TID-5 (audit 21/8): THU HỒI MÁY reset TID về "chưa khách, chưa giao" → KHÔNG còn khách/phòng nào → soft-unlink
  // phòng chat đang gắn (nếu để active, doanh số về sau vẫn dồn nhầm về phòng khách cũ đã trả máy). Áp cho mode
  // 'recall' (reset không khách). 'retire' → TID RECALLED/đóng, tháo khỏi máy: cũng gỡ phòng để không còn liên kết sống.
  await unlinkActiveTidRoom(tx, row.id);
  await tx.posTidBinding.updateMany({
    where: { posSerial: serial, tid, unboundAt: null },
    data: { unboundAt: occurredAt, unbindReason: mode === 'retire' ? 'POS_RETIRE' : 'POS_RECALL' }
  });
  await tx.assetEvent.create({
    data: {
      deviceSerial: serial,
      tid,
      eventType,
      fromState,
      toState,
      customerId: row.customerId,
      actorUserId,
      occurredAt,
      note,
      afterJson: JSON.stringify(auditSnapshot({ tid, unboundFrom: serial, mode, status: toState }))
    }
  });
}

/** Core: validate + write asset_event + project new status + audit. Shared by all transitions.
 * PHASE K1 (FIX 2 — chống ABBA deadlock): THỨ TỰ KHÓA TOÀN CỤC = tids TRƯỚC pos_devices (khớp assignTid). */
async function applyTransition(ctx: ServiceCtx, serial: string, event: PosEvent, input: TransitionInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, MANAGE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const pre = await db.posDevice.findUnique({ where: { serial } });
  if (!pre) return { ok: false, error: 'NOT_FOUND', message: `Không tìm thấy máy POS serial "${serial}".` };
  if (event === 'deploy' && input.customerId == null) {
    return { ok: false, error: 'VALIDATION', message: 'Triển khai máy phải chọn khách hàng nhận máy.' };
  }
  if (event === 'transferAgent' && input.agentId == null) {
    return { ok: false, error: 'VALIDATION', message: 'Chuyển đại lý phải chọn đại lý đích.' };
  }
  if (event === 'changeCustomer') {
    if (input.customerId == null) {
      return { ok: false, error: 'VALIDATION', message: 'Đổi khách giữ máy phải chọn khách hàng mới.' };
    }
    if (input.customerId === pre.currentCustomerId) {
      return { ok: false, error: 'VALIDATION', message: 'Khách hàng mới trùng với khách đang giữ máy.' };
    }
    const cust = await db.customer.findFirst({ where: { id: input.customerId, deletedAt: null }, select: { id: true } });
    if (!cust) return { ok: false, error: 'NOT_FOUND', message: 'Không tìm thấy khách hàng mới (hoặc đã bị xóa).' };
  }
  if (event === 'cancelCustomer' && pre.currentCustomerId == null) {
    return { ok: false, error: 'VALIDATION', message: 'Máy này chưa gán khách nào để hủy.' };
  }
  // FIX-FK (5/8): deploy ghi currentCustomerId + currentAgentId; transferAgent ghi currentAgentId (scalar,
  // KHÔNG FK). Validate khách/đại lý tồn tại + chưa xóa mềm TRƯỚC $transaction để không ghi tham chiếu MỒ CÔI
  // (khuôn nhánh changeCustomer đã có sẵn + assertAgentValid ở customer.ts). deploy REQUIRES customerId (đã
  // chặn null ở trên); agentId optional với deploy (null → giữ agent hiện tại của máy, KHÔNG kiểm).
  if (event === 'deploy') {
    const badCust = await assertCustomerValid(db, input.customerId);
    if (badCust) return badCust;
  }
  if (event === 'deploy' || event === 'transferAgent') {
    const badAgent = await assertAgentValid(db, input.agentId);
    if (badAgent) return badAgent;
  }
  // Model 1 — thu hồi / nhận-sửa VỀ kho: BẮT BUỘC chọn kho + kho đích phải tồn tại. CHỈ bắt khi chuyển HỢP LỆ.
  if ((event === 'recall' || event === 'receiveRepaired') && decidePosTransition(pre.status as PosStatus, event).allowed) {
    if (input.toWarehouseId == null) {
      return { ok: false, error: 'VALIDATION', message: 'Phải chọn KHO nhận máy về (máy trong kho luôn phải thuộc 1 kho).' };
    }
    const wh = await db.warehouse.findFirst({ where: { id: input.toWarehouseId, deletedAt: null }, select: { id: true } });
    if (!wh) return { ok: false, error: 'NOT_FOUND', message: 'Kho nhận máy về không tồn tại (hoặc đã bị xóa).' };
  }
  const unbinds = event === 'recall' || event === 'retire';
  const touchesTid = unbinds || event === 'changeCustomer';

  const occurredAt = parseWhen(input.occurredAt);

  // LOẠI GIAO MÁY — deploy: giải mã loại giao + số tiền + quỹ TRƯỚC $transaction (validate đầy đủ ở đây →
  // applyHandoverTx chỉ GHI). Bán (SALE) → CHẶN, hướng dùng chức năng Bán máy.
  let handover: HandoverContext | null = null;
  if (event === 'deploy') {
    const r = await resolveHandoverInput(db, { handoverTypeId: input.handoverTypeId, amount: input.handoverAmount, fundId: input.fundId, depositAmount: input.handoverDepositAmount, depositFundId: input.handoverDepositFundId, method: input.method });
    if (!r.ok) return { ok: false, error: r.error, message: r.message };
    if (r.moneyKind === 'SALE') {
      return { ok: false, error: 'USE_SALE_FLOW', message: 'Giao hình thức "Bán" cần xác nhận mật khẩu — hãy dùng chức năng Bán máy.' };
    }
    handover = buildHandoverContext(r, { deviceSerial: serial, tid: pre.currentTid ?? null, customerId: input.customerId ?? null, occurredAt, actorId: user.id });
  }

  let result: MutationResult;
  try {
    result = await runWithRetry(async () => {
      const dirty = touchesTid ? await db.posDevice.findUnique({ where: { serial }, select: { currentTid: true } }) : null;
      const dirtyTid = dirty?.currentTid ?? null;
      return await db.$transaction(async (tx) => {
        if (dirtyTid) await tx.$queryRaw`SELECT id FROM tids WHERE tid = ${dirtyTid} FOR UPDATE`;
        await tx.$queryRaw`SELECT id FROM pos_devices WHERE serial = ${serial} FOR UPDATE`;
        const dev = await tx.posDevice.findUnique({ where: { serial } });
        if (!dev) throw new TransitionAbort({ ok: false, error: 'NOT_FOUND', message: `Không tìm thấy máy POS serial "${serial}".` });

        if (touchesTid && (dev.currentTid ?? null) !== dirtyTid) throw new RetrySignal();

        const decision = decidePosTransition(dev.status as PosStatus, event);
        if (!decision.allowed) {
          throw new TransitionAbort({ ok: false, error: decision.reason, message: transitionDenyMessage(decision.reason, dev.status, event) });
        }

        const fromState = dev.status;
        const toState = decision.to!;
        const before = auditSnapshot({ status: fromState, currentAgentId: dev.currentAgentId, currentCustomerId: dev.currentCustomerId, currentTid: dev.currentTid });

        const patch: Record<string, unknown> = { status: toState, updatedBy: user.id };
        let toAgentId: number | null = null;
        let customerId: number | null = null;
        let eventTid: string | null = null; // TID ghi kèm sự kiện (đổi-khách: TID đi theo máy)
        let eventWarehouseId: number | null = null; // R27 — kho xuất (giao/đổi-khách)
        let eventDeliveryAddress: string | null = null; // R27 — SNAPSHOT địa chỉ kho lúc giao
        if (event === 'deploy') {
          // [B321/F1 24/11 — agent đào vét, CHẶN SHIP] Máy về kho sau SỬA CHỮA vẫn ÔM TID của khách cũ
          // (đường sửa chữa giữ currentTid). Giao máy đó cho KHÁCH MỚI mà không gỡ TID ⇒ máy ghi khách
          // mới, TID vẫn trỏ khách CŨ ⇒ mọi bill sau quy doanh số NHẦM NHÀ (lớp sự cố 25/9). Fail-closed.
          if (dev.currentTid != null) {
            const tidCu = await db.tid.findFirst({ where: { tid: dev.currentTid, deletedAt: null }, select: { customerId: true } });
            if (tidCu && tidCu.customerId != null && input.customerId != null && tidCu.customerId !== input.customerId) {
              return {
                ok: false, error: 'CONFLICT',
                message: `Máy ${serial} còn gắn TID ${dev.currentTid} của khách khác (máy về từ sửa chữa?). `
                  + 'CÁCH SỬA: vào màn TID → Thu hồi TID khỏi máy trước, rồi giao máy cho khách mới.'
              };
            }
          }
          patch.currentCustomerId = input.customerId ?? null;
          patch.currentAgentId = input.agentId ?? dev.currentAgentId;
          patch.recallPending = false;
          customerId = input.customerId ?? null;
          toAgentId = (input.agentId ?? dev.currentAgentId) ?? null;
        } else if (event === 'cancelCustomer') {
          patch.recallPending = true;
          customerId = dev.currentCustomerId;
          toAgentId = dev.currentAgentId;
          eventTid = dev.currentTid;
        } else if (event === 'transferAgent') {
          patch.currentAgentId = input.agentId ?? null;
          toAgentId = input.agentId ?? null;
        } else if (event === 'changeCustomer') {
          patch.currentCustomerId = input.customerId ?? null;
          // [B287/F5 24/11 — agent phản biện] Máy đã GIAO KHÁCH MỚI thì cờ "chờ thu hồi" (đặt khi hủy
          // khách cũ) phải tắt — trước đây giữ nguyên ⇒ máy mới giao vẫn nằm trong ô "Cần thu hồi".
          patch.recallPending = false;
          customerId = input.customerId ?? null;
          toAgentId = dev.currentAgentId;
          eventTid = dev.currentTid;
          if (dev.currentTid) {
            await tx.tid.updateMany({ where: { tid: dev.currentTid }, data: { customerId: input.customerId } });
            // TID-5 (audit 21/8): TID theo khách MỚI → DI CHUYỂN phòng chat (soft-unlink phòng khách cũ + relink
            // phòng khách mới). Trước đây changeCustomer chỉ đổi customerId, chatRoomTid GIỮ phòng khách CŨ → doanh
            // số TID vẫn dồn về nhóm chat khách cũ ("cướp doanh số"). input.customerId đã validate tồn tại ở trên.
            const trow = await tx.tid.findUnique({ where: { tid: dev.currentTid }, select: { id: true } });
            if (trow && input.customerId != null) {
              await relinkTidRoomOnCustomerChange(tx, trow.id, input.customerId);
            }
          }
        } else if (event === 'recall') {
          patch.currentCustomerId = null;
          patch.currentAgentId = null;
          patch.recallPending = false;
          if (dev.currentTid) {
            patch.currentTid = null;
            await unbindTidFromDevice(tx, { serial, tid: dev.currentTid, mode: 'recall', actorUserId: user.id, occurredAt, note: input.note ?? null });
          }
        } else if (event === 'retire') {
          patch.currentCustomerId = null;
          patch.currentAgentId = null;
          if (dev.currentTid) {
            patch.currentTid = null;
            await unbindTidFromDevice(tx, { serial, tid: dev.currentTid, mode: 'retire', actorUserId: user.id, occurredAt, note: input.note ?? null });
          }
        }
        // reportDamage / sendRepair / receiveRepaired / transferAgent → GIỮ currentTid (không đụng).

        // R27 + Model 1 (§4): giao/đổi-khách ghi KHO XUẤT + SNAPSHOT địa chỉ kho.
        const srcWhId =
          event === 'deploy'
            ? (dev.warehouseId ?? input.fromWarehouseId ?? null)
            : event === 'changeCustomer'
              ? (input.fromWarehouseId ?? null)
              : null;
        if (event === 'deploy' && srcWhId == null) {
          throw new TransitionAbort({ ok: false, error: 'NO_WAREHOUSE', message: 'Máy phải ở kho có địa chỉ cụ thể mới giao cho khách được. Hãy chọn kho xuất (Từ kho).' });
        }
        if (srcWhId != null) {
          const wh = await tx.warehouse.findFirst({ where: { id: srcWhId, deletedAt: null }, select: { id: true, address: true, managerUserId: true } });
          if (!wh) throw new TransitionAbort({ ok: false, error: 'NOT_FOUND', message: 'Kho xuất đã chọn không tồn tại (hoặc đã bị xóa).' });
          const effAddr = await resolveWarehouseAddress(tx, wh);
          if (event === 'deploy' && !(effAddr && effAddr.trim())) {
            throw new TransitionAbort({ ok: false, error: 'WAREHOUSE_NO_ADDRESS', message: 'Máy phải ở kho có địa chỉ cụ thể mới giao cho khách được. Kho xuất chưa có địa chỉ (kiểm tra User quản lý kho).' });
          }
          eventWarehouseId = wh.id;
          eventDeliveryAddress = effAddr;
        }

        // Model 1 — ĐỒNG BỘ kho vật lý: bất biến warehouseId≠null ⟺ IN_STOCK.
        patch.warehouseId = toState === 'IN_STOCK' ? (input.toWarehouseId ?? null) : null;
        // warehouseLoc parity (invariant TID↔POS): máy RỜI kho (deploy/bán/thanh lý…) ⟹ xóa CẢ vị-trí-trong-kho,
        // khớp assignTid (tid.ts) + export-request đã clear cả hai. Tránh warehouseLoc mồ côi khi warehouseId=null.
        if (toState !== 'IN_STOCK') patch.warehouseLoc = null;

        await tx.posDevice.update({ where: { id: dev.id }, data: patch });
        await tx.assetEvent.create({
          data: {
            deviceSerial: serial,
            tid: eventTid,
            eventType: decision.eventType!,
            fromState,
            toState,
            fromAgentId: dev.currentAgentId,
            toAgentId,
            customerId,
            fromWarehouseId: eventWarehouseId,
            deliveryAddress: eventDeliveryAddress,
            handoverTypeId: handover && handover.handoverTypeId != null ? handover.handoverTypeId : null,
            handoverAmount: handover && handover.handoverTypeId != null ? handover.amount : null,
            actorUserId: user.id,
            occurredAt,
            note: input.note ?? null,
            beforeJson: JSON.stringify(before),
            afterJson: JSON.stringify(auditSnapshot({ status: toState, currentAgentId: patch.currentAgentId ?? dev.currentAgentId, currentCustomerId: patch.currentCustomerId ?? dev.currentCustomerId }))
          }
        });
        // LOẠI GIAO MÁY — áp mô hình tiền TRONG CÙNG $transaction.
        if (event === 'deploy' && handover) await applyHandoverTx(tx, handover);
        if (event === 'recall') {
          await refundOpenDepositsForSerialTx(tx, { serial, fundIdOverride: input.fundId ?? null, method: input.method === 'CK' ? 'CK' : 'CASH', occurredAt, actorId: user.id });
        }
        // CỌC KẸT (Admin Demo 11/8): THANH LÝ máy đang giao → máy rời DEPLOYED, recall (đường hoàn tự động) không gọi
        // được nữa. KHÔNG tự hoàn/chặn — ghi breadcrumb nhắc hoàn TAY (refundDepositManual). Cọc GIỮ nguyên OPEN.
        if (event === 'retire') {
          await flagStrandedDepositsTx(tx, { serial, reason: 'RETIRED', actorId: user.id, occurredAt });
        }
        return { ok: true, id: dev.id, _before: before, _eventType: decision.eventType, _toState: toState } as MutationResult & { _before: unknown; _eventType: string; _toState: string };
      });
    });
  } catch (e) {
    if (e instanceof TransitionAbort) return e.result;
    // changeCustomer di chuyển phòng chat TID: race partial-unique (P2002) đã throw ChatRoomTidConflictError bên
    // trong $transaction (đã rollback sạch) → trả CONFLICT "thử lại" thay vì để rơi generic 500 ở caller/route.
    if (e instanceof ChatRoomTidConflictError) return { ok: false, error: 'CONFLICT', message: e.message };
    throw e;
  }

  const meta = result as MutationResult & { _before?: unknown; _eventType?: string; _toState?: string };
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'POS_TRANSITION',
    targetType: 'PosDevice',
    targetId: String(pre.id),
    before: meta._before as Record<string, unknown> | undefined,
    after: auditSnapshot({ event: meta._eventType, status: meta._toState })
  });
  return { ok: true, id: pre.id };
}

export const deployPos = (ctx: ServiceCtx, serial: string, input: TransitionInput): Promise<MutationResult> => applyTransition(ctx, serial, 'deploy', input);
export const recallPos = (ctx: ServiceCtx, serial: string, input: TransitionInput): Promise<MutationResult> => applyTransition(ctx, serial, 'recall', input);
export const transferPosAgent = (ctx: ServiceCtx, serial: string, input: TransitionInput): Promise<MutationResult> => applyTransition(ctx, serial, 'transferAgent', input);
/** POS #2 — đổi khách giữ máy (giữ DEPLOYED + TID, TID theo khách mới), 1 bước atomic. */
export const changeCustomerPos = (ctx: ServiceCtx, serial: string, input: TransitionInput): Promise<MutationResult> => applyTransition(ctx, serial, 'changeCustomer', input);
/** #6 — hủy khách giữ máy: giữ khách + đánh dấu chờ thu hồi (máy chưa về kho). */
export const cancelCustomerPos = (ctx: ServiceCtx, serial: string, input: TransitionInput): Promise<MutationResult> => applyTransition(ctx, serial, 'cancelCustomer', input);
export const reportPosDamage = (ctx: ServiceCtx, serial: string, input: TransitionInput): Promise<MutationResult> => applyTransition(ctx, serial, 'reportDamage', input);
export const sendPosRepair = (ctx: ServiceCtx, serial: string, input: TransitionInput): Promise<MutationResult> => applyTransition(ctx, serial, 'sendRepair', input);
export const receivePosRepaired = (ctx: ServiceCtx, serial: string, input: TransitionInput): Promise<MutationResult> => applyTransition(ctx, serial, 'receiveRepaired', input);

/** Retire (thanh lý) is destructive → re-enter password (§14). MẬT KHẨU do ADAPTER kiểm TRƯỚC khi gọi lõi
 *  (lõi KHÔNG kiểm password — khớp customer.ts). */
export async function retirePos(ctx: ServiceCtx, serial: string, input: TransitionInput = {}): Promise<MutationResult> {
  return applyTransition(ctx, serial, 'retire', input);
}

/** §4 — Địa chỉ HIỆU LỰC của kho: nếu kho gán User quản lý (managerUserId) → lấy address hồ sơ user đó;
 *  ngược lại dùng address cột kho (dữ liệu kho cũ, tương thích ngược). */
async function resolveWarehouseAddress(tx: PrismaTx, wh: { address: string | null; managerUserId: number | null }): Promise<string | null> {
  if (wh.managerUserId != null) {
    const u = await tx.user.findUnique({ where: { id: wh.managerUserId }, select: { address: true } });
    return u?.address ?? null;
  }
  return wh.address;
}

/** Parse an optional ISO/date string; fall back to now. Invalid → now (never throws). */
function parseWhen(iso?: string | null): Date {
  if (!iso) return new Date();
  const d = new Date(iso);
  return isNaN(d.getTime()) ? new Date() : d;
}
