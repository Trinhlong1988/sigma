// Duyệt HỦY đa-entity (R34, Admin Demo 11/7) — LÕI THUẦN ctx-based. PORT nghiệp vụ từ
// apps/desktop/src/main/entity-cancel-service.ts. Duyệt HỦY (xóa mềm) TID / POS / Khách hàng / Nhân sự qua bảng
// ApprovalRequest (generic, action='CANCEL'). Phân vai GIỐNG duyệt hủy bill: người yêu cầu ≠ người duyệt; yêu cầu do
// Quản lý/Admin (có APPROVE) tạo → cần cấp Admin (ELEVATED); Admin (elevated) tự duyệt yêu cầu của mình (chốt = MẬT
// KHẨU khi duyệt). "Hủy" = soft-delete (Tid/PosDevice/Customer set deletedAt; User set status='DELETED'+deletedAt).
// KHUÔN (pos-supply/customer): ctx = { db, user } do adapter dựng; mỗi hàm tự hasPermission. MẬT KHẨU người DUYỆT
// (§14) do ADAPTER route verify TRƯỚC khi gọi lõi (lõi KHÔNG kiểm password). customerLiveRelationGuard tái dùng từ
// customer.js. ServiceCtx/MutationResult từ customer.js. writeAudit/writeAuditStrict/bumpChangeToken từ audit.js.
import { auditSnapshot } from '@sigma/business-rules';
import { hasPermission, type AuthUser, type AuditAction } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit, writeAuditStrict, bumpChangeToken } from './audit.js';
import { customerLiveRelationGuard, type ServiceCtx, type MutationResult } from './customer.js';

const ADMIN_ROLE_CODE = 'ADMIN';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

// Client bên trong interactive $transaction (thiếu các $-method quản lý kết nối) — dùng cho applyCancel + guard.
type TxClient = Omit<Db, '$connect' | '$disconnect' | '$on' | '$use' | '$transaction' | '$extends'>;

class TxGuardError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string
  ) {
    super(code);
    this.name = 'TxGuardError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY — mỗi entity: bộ 3 quyền + nhãn + precheck (lúc tạo yêu cầu) + applyCancel (lúc duyệt).
// ─────────────────────────────────────────────────────────────────────────────
interface EntityConfig {
  entityType: string; // 'Tid' | 'PosDevice' | 'Customer' | 'User'
  label: string;
  perms: { request: string; approve: string; elevated: string };
  auditRequested: AuditAction;
  auditApproved: AuditAction;
  auditRejected: AuditAction;
  display: (db: Db, id: number) => Promise<string | null>;
  precheck: (db: Db, id: number, requester: AuthUser) => Promise<{ ok: true } | { ok: false; error: string; message: string }>;
  applyCancel: (txc: TxClient, id: number, approver: AuthUser, reason: string) => Promise<void>;
}

async function userIsAdmin(db: TxClient, id: number): Promise<boolean> {
  const u = await db.user.findUnique({ where: { id }, include: { roles: { include: { role: true } } } });
  return !!u && u.roles.some((ur) => ur.role.code === ADMIN_ROLE_CODE);
}
/** Số Admin CÒN SỐNG + ACTIVE, KHÔNG tính user `excludeId`. */
async function countOtherActiveAdmins(db: TxClient, excludeId: number): Promise<number> {
  const users = await db.user.findMany({ where: { deletedAt: null, status: 'ACTIVE' }, include: { roles: { include: { role: true } } } });
  return users.filter((u) => u.id !== excludeId && u.roles.some((ur) => ur.role.code === ADMIN_ROLE_CODE)).length;
}

const REGISTRY: Record<string, EntityConfig> = {
  Tid: {
    entityType: 'Tid',
    label: 'TID',
    perms: { request: 'TID_CANCEL_REQUEST', approve: 'TID_CANCEL_APPROVE', elevated: 'TID_CANCEL_APPROVE_ELEVATED' },
    auditRequested: 'TID_CANCEL_REQUESTED',
    auditApproved: 'TID_CANCEL_APPROVED',
    auditRejected: 'TID_CANCEL_REJECTED',
    display: async (db, id) => {
      const t = await db.tid.findUnique({ where: { id } });
      return t ? t.tid : null;
    },
    precheck: async (db, id) => {
      const t = await db.tid.findUnique({ where: { id } });
      if (!t || t.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'TID không tồn tại hoặc đã xóa.' };
      // P1-08 (invariant #7): chặn xóa TID còn quan hệ SỐNG → tránh mồ côi dữ liệu.
      if (t.posSerial != null) return { ok: false, error: 'IN_USE', message: `TID đang gắn máy POS ${t.posSerial}. Thu hồi TID khỏi máy trước khi hủy.` };
      const openDep = await db.deviceDeposit.count({ where: { tid: t.tid, status: 'OPEN' } });
      if (openDep > 0) return { ok: false, error: 'IN_USE', message: `TID còn ${openDep} khoản cọc chưa tất toán. Xử lý cọc trước khi hủy.` };
      // BUG-2: XÓA guard "TID nằm trong yêu cầu xuất kho PENDING" — đó là CODE CHẾT. ExportRequestLine (dòng
      // gán TID cụ thể) CHỈ được tạo lúc DUYỆT phiếu (status→APPROVED); phiếu còn PENDING KHÔNG có dòng nào →
      // count luôn = 0 → guard không bao giờ kích. Phiếu xuất kho tạo lúc PENDING là phiếu N-đơn-vị CHƯA seri
      // (không tham chiếu TID cụ thể) nên KHÔNG có ràng buộc TID↔phiếu-PENDING thật để thay thế. Bỏ hẳn.
      return { ok: true };
    },
    applyCancel: async (txc, id, approver) => {
      // P1-08: re-guard TRONG tx lúc DUYỆT (quan hệ có thể phát sinh giữa yêu cầu→duyệt).
      const t = await txc.tid.findUnique({ where: { id }, select: { tid: true, posSerial: true } });
      if (t?.posSerial != null) throw new TxGuardError('IN_USE', `TID đang gắn máy POS ${t.posSerial}. Thu hồi trước khi hủy.`);
      if (t && (await txc.deviceDeposit.count({ where: { tid: t.tid, status: 'OPEN' } })) > 0) throw new TxGuardError('IN_USE', 'TID còn cọc chưa tất toán.');
      const moved = await txc.tid.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: approver.id, updatedBy: approver.id } });
      if (moved.count === 0) throw new TxGuardError('INVALID_STATE', 'TID đã bị xóa hoặc đổi trạng thái.');
    }
  },
  PosDevice: {
    entityType: 'PosDevice',
    label: 'Máy POS',
    perms: { request: 'POS_CANCEL_REQUEST', approve: 'POS_CANCEL_APPROVE', elevated: 'POS_CANCEL_APPROVE_ELEVATED' },
    auditRequested: 'POS_CANCEL_REQUESTED',
    auditApproved: 'POS_CANCEL_APPROVED',
    auditRejected: 'POS_CANCEL_REJECTED',
    display: async (db, id) => {
      const p = await db.posDevice.findUnique({ where: { id } });
      return p ? p.serial : null;
    },
    precheck: async (db, id) => {
      const p = await db.posDevice.findUnique({ where: { id } });
      if (!p || p.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Máy POS không tồn tại hoặc đã xóa.' };
      if (p.currentTid != null) return { ok: false, error: 'DEVICE_HAS_TID', message: `Máy đang gắn TID ${p.currentTid}. Thu hồi TID khỏi máy trước khi hủy máy.` };
      // BUG-4 (invariant #7): chặn xóa máy còn QUAN HỆ SỐNG → tránh mồ côi. Máy đang giao khách (DEPLOYED hoặc
      // đang giữ khách currentCustomerId) hoặc còn cọc OPEN gắn theo serial máy → phải xử lý trước khi hủy.
      if (p.status === 'DEPLOYED' || p.currentCustomerId != null) return { ok: false, error: 'IN_USE', message: `Máy đang giao khách (trạng thái ${p.status}). Thu hồi máy trước khi hủy.` };
      const openDep = await db.deviceDeposit.count({ where: { deviceSerial: p.serial, status: 'OPEN' } });
      if (openDep > 0) return { ok: false, error: 'IN_USE', message: `Máy còn ${openDep} khoản cọc chưa tất toán. Xử lý cọc trước khi hủy máy.` };
      return { ok: true };
    },
    applyCancel: async (txc, id, approver) => {
      // BUG-4: re-guard TRONG tx lúc DUYỆT — chặn mồ côi nếu máy phát sinh gắn TID / giao khách / cọc sau khi
      // tạo yêu cầu (TOCTOU). updateMany dưới đã kèm currentTid:null; bổ sung kiểm DEPLOYED/giữ-khách + cọc.
      const p = await txc.posDevice.findUnique({ where: { id }, select: { serial: true, status: true, currentTid: true, currentCustomerId: true } });
      if (p?.currentTid != null) throw new TxGuardError('DEVICE_HAS_TID', `Máy đang gắn TID ${p.currentTid}. Thu hồi trước khi hủy.`);
      if (p && (p.status === 'DEPLOYED' || p.currentCustomerId != null)) throw new TxGuardError('IN_USE', `Máy đang giao khách (trạng thái ${p.status}). Thu hồi trước khi hủy.`);
      if (p && (await txc.deviceDeposit.count({ where: { deviceSerial: p.serial, status: 'OPEN' } })) > 0) throw new TxGuardError('IN_USE', 'Máy còn cọc chưa tất toán.');
      const moved = await txc.posDevice.updateMany({ where: { id, deletedAt: null, currentTid: null }, data: { deletedAt: new Date(), deletedBy: approver.id, updatedBy: approver.id } });
      if (moved.count === 0) throw new TxGuardError('INVALID_STATE', 'Máy POS đã bị xóa hoặc đang gắn TID.');
    }
  },
  Customer: {
    entityType: 'Customer',
    label: 'Khách hàng',
    perms: { request: 'CUSTOMER_CANCEL_REQUEST', approve: 'CUSTOMER_CANCEL_APPROVE', elevated: 'CUSTOMER_CANCEL_APPROVE_ELEVATED' },
    auditRequested: 'CUSTOMER_CANCEL_REQUESTED',
    auditApproved: 'CUSTOMER_CANCEL_APPROVED',
    auditRejected: 'CUSTOMER_CANCEL_REJECTED',
    display: async (db, id) => {
      const c = await db.customer.findUnique({ where: { id } });
      return c ? `${c.code} · ${c.fullName}` : null;
    },
    precheck: async (db, id) => {
      const c = await db.customer.findUnique({ where: { id } });
      if (!c || c.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Khách hàng không tồn tại hoặc đã xóa.' };
      // P1-08 (invariant #7): chặn xóa khách còn quan hệ SỐNG (giữ máy/TID/cọc) → tránh mồ côi tham chiếu.
      const g = await customerLiveRelationGuard(db, id);
      if (g) return { ok: false, error: g.error ?? 'IN_USE', message: g.message ?? 'Khách còn quan hệ sống, không thể hủy.' };
      return { ok: true };
    },
    applyCancel: async (txc, id, approver) => {
      // P1-08 / BUG-1: re-guard TRONG tx lúc DUYỆT — chặn mồ côi nếu khách phát sinh QUAN HỆ SỐNG giữa
      // yêu cầu→duyệt. TRƯỚC ĐÂY inline chỉ kiểm 3/5 (máy POS / TID đã giao / cọc OPEN) → BỎ SÓT phiếu xuất
      // kho PENDING + nợ mua thiết bị (device-sale) → TOCTOU: tạo yêu cầu lúc khách sạch, phát sinh phiếu/nợ
      // trong lúc chờ, duyệt vẫn xóa → mồ côi. Dùng CHUNG customerLiveRelationGuard (đủ 5 quan hệ) — cùng nguồn
      // sự thật với precheck. Guard chỉ dùng count/findMany/aggregate → chạy được trên tx client (cast Db).
      const rel = await customerLiveRelationGuard(txc as unknown as Db, id);
      if (rel) throw new TxGuardError(rel.error ?? 'IN_USE', rel.message ?? 'Khách còn quan hệ sống, không thể hủy.');
      const moved = await txc.customer.updateMany({ where: { id, deletedAt: null }, data: { deletedAt: new Date(), deletedBy: approver.id } });
      if (moved.count === 0) throw new TxGuardError('INVALID_STATE', 'Khách hàng đã bị xóa.');
    }
  },
  User: {
    entityType: 'User',
    label: 'Nhân sự',
    perms: { request: 'USER_CANCEL_REQUEST', approve: 'USER_CANCEL_APPROVE', elevated: 'USER_CANCEL_APPROVE_ELEVATED' },
    auditRequested: 'USER_CANCEL_REQUESTED',
    auditApproved: 'USER_CANCEL_APPROVED',
    auditRejected: 'USER_CANCEL_REJECTED',
    display: async (db, id) => {
      const u = await db.user.findUnique({ where: { id } });
      return u ? u.username : null;
    },
    precheck: async (db, id, requester) => {
      const u = await db.user.findUnique({ where: { id } });
      if (!u || u.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Nhân sự không tồn tại hoặc đã xóa.' };
      if (id === requester.id) return { ok: false, error: 'SELF_DELETE', message: 'Không thể tạo yêu cầu xóa chính mình.' };
      if ((await userIsAdmin(db, id)) && (await countOtherActiveAdmins(db, id)) === 0) return { ok: false, error: 'LAST_ADMIN', message: 'Không thể xóa Admin cuối cùng.' };
      return { ok: true };
    },
    applyCancel: async (txc, id, approver) => {
      // Guard tại lúc DUYỆT (người thực thi = approver): không tự xóa mình, không xóa Admin cuối, Manager không xóa Admin.
      if (id === approver.id) throw new TxGuardError('SELF_DELETE', 'Không thể tự xóa chính mình.');
      // Serialize MỌI luồng duyệt-xóa User (advisory xact lock chung) — chống TOCTOU LAST_ADMIN. $executeRawUnsafe
      // (KHÔNG $queryRaw): pg_advisory_xact_lock trả void → queryCompiler wasm không deserialize được cột void.
      await txc.$executeRawUnsafe('SELECT pg_advisory_xact_lock(748301)');
      const targetAdmin = await userIsAdmin(txc, id);
      if (targetAdmin && (await countOtherActiveAdmins(txc, id)) === 0) throw new TxGuardError('LAST_ADMIN', 'Không thể xóa Admin cuối cùng.');
      if (targetAdmin && !approver.roles.includes(ADMIN_ROLE_CODE)) throw new TxGuardError('MANAGER_SCOPE', 'Bạn không được xóa tài khoản Admin.');
      const moved = await txc.user.updateMany({ where: { id, deletedAt: null }, data: { status: 'DELETED', deletedAt: new Date() } });
      if (moved.count === 0) throw new TxGuardError('INVALID_STATE', 'Nhân sự đã bị xóa.');
    }
  }
};

export const CANCELABLE_ENTITY_TYPES = Object.keys(REGISTRY);

/** Tập quyền hiệu lực của 1 user (theo id). */
async function userPermSet(db: Db, userId: number): Promise<Set<string>> {
  const u = await db.user.findUnique({ where: { id: userId }, include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } } });
  const s = new Set<string>();
  if (u) for (const ur of u.roles) for (const rp of ur.role.permissions) s.add(rp.permission.code);
  return s;
}
/** Người ĐƯỢC duyệt (khớp phân vai) — báo thông báo hệ thống. */
async function approverRecipients(db: Db, cfg: EntityConfig, requestedBy: number): Promise<number[]> {
  const reqPerms = await userPermSet(db, requestedBy);
  const needCode = reqPerms.has(cfg.perms.approve) ? cfg.perms.elevated : cfg.perms.approve;
  const users = await db.user.findMany({ where: { deletedAt: null, status: 'ACTIVE' }, include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } } });
  const ids: number[] = [];
  for (const u of users) {
    if (u.id === requestedBy) continue;
    if (u.roles.some((ur) => ur.role.permissions.some((rp) => rp.permission.code === needCode))) ids.push(u.id);
  }
  return ids;
}
async function pushSystemNotice(db: Db, recipientIds: number[], category: string, subject: string, body: string): Promise<void> {
  const ids = [...new Set(recipientIds)];
  if (ids.length === 0) return;
  try {
    await db.message.createMany({ data: ids.map((rid) => ({ kind: 'SYSTEM', category, subject, body, senderId: null, recipientId: rid })) });
  } catch {
    // Thông báo phụ trợ — không chặn luồng chính.
  }
}

function cfgOf(entityType: string): EntityConfig | null {
  return REGISTRY[entityType] ?? null;
}

// ═════════════════════════════════════════════════════════════════════════════
// TẠO YÊU CẦU HỦY
// ═════════════════════════════════════════════════════════════════════════════
export async function requestEntityCancel(ctx: ServiceCtx, entityType: string, entityId: number, reason: string): Promise<MutationResult> {
  const cfg = cfgOf(entityType);
  if (!cfg) return { ok: false, error: 'VALIDATION', message: 'Loại dữ liệu không hỗ trợ duyệt hủy.' };
  if (!hasPermission(ctx.user, cfg.perms.request)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const r = (reason ?? '').trim();
  if (!r) return { ok: false, error: 'VALIDATION', message: 'Vui lòng nhập lý do hủy.' };
  const pre = await cfg.precheck(db, entityId, user);
  if (!pre.ok) return pre;
  // Chống trùng: đã có 1 yêu cầu PENDING cho thực thể này → không tạo cái thứ 2.
  const existing = await db.approvalRequest.findFirst({ where: { entityType, entityId, action: 'CANCEL', status: 'PENDING' } });
  if (existing) return { ok: false, error: 'ALREADY_PENDING', message: 'Đã có yêu cầu hủy đang chờ duyệt cho mục này.' };

  let req: { id: number };
  try {
    req = await db.$transaction(async (txc) => {
      const dup = await txc.approvalRequest.findFirst({ where: { entityType, entityId, action: 'CANCEL', status: 'PENDING' } });
      if (dup) throw new TxGuardError('ALREADY_PENDING', 'Đã có yêu cầu hủy đang chờ duyệt cho mục này.');
      return txc.approvalRequest.create({ data: { entityType, entityId, action: 'CANCEL', reason: r, requestedBy: user.id } });
    });
  } catch (e) {
    if (e instanceof TxGuardError) return { ok: false, error: e.code, message: e.userMessage };
    // Backstop cấp DB: partial unique `approval_requests_pending_cancel_uq` bắn P2002 nếu 2 luồng race → ALREADY_PENDING.
    if (e && typeof e === 'object' && (e as { code?: string }).code === 'P2002') return { ok: false, error: 'ALREADY_PENDING', message: 'Đã có yêu cầu hủy đang chờ duyệt cho mục này.' };
    throw e;
  }
  const label = (await cfg.display(db, entityId)) ?? String(entityId);
  await writeAudit(db, { actorUserId: user.id, action: cfg.auditRequested, targetType: entityType, targetId: String(entityId), after: auditSnapshot({ requestId: req.id, label, reason: r }) });
  try {
    const recipients = await approverRecipients(db, cfg, user.id);
    await pushSystemNotice(db, recipients, cfg.auditRequested, `Yêu cầu hủy ${cfg.label} ${label}`, `${user.fullName} đề nghị hủy ${cfg.label} ${label}. Lý do: ${r}. Vào mục Duyệt Hủy để xử lý.`);
  } catch {
    // phụ trợ
  }
  return { ok: true, id: req.id };
}

// ═════════════════════════════════════════════════════════════════════════════
// DUYỆT / TỪ CHỐI — mật khẩu người duyệt do ADAPTER route verify TRƯỚC khi gọi lõi.
// ═════════════════════════════════════════════════════════════════════════════
type OneResult = { ok: true; id: number } | { ok: false; error: string; message: string };

async function approveOne(db: Db, cfg: EntityConfig, user: AuthUser, requestId: number, decisionNote?: string): Promise<OneResult> {
  const req = await db.approvalRequest.findUnique({ where: { id: requestId } });
  if (!req || req.action !== 'CANCEL' || req.entityType !== cfg.entityType) return { ok: false, error: 'NOT_FOUND', message: 'Yêu cầu hủy không tồn tại.' };
  const requesterPerms = await userPermSet(db, req.requestedBy);
  const requesterIsApprover = requesterPerms.has(cfg.perms.approve);
  const approverElevated = hasPermission(user, cfg.perms.elevated);
  const isSelf = user.id === req.requestedBy;
  let selfNote: string | null = null;

  if (isSelf) {
    // Admin Demo 13/7: ADMIN (elevated) ĐƯỢC tự duyệt yêu cầu của mình (chốt = mật khẩu khi duyệt ở route).
    if (approverElevated) selfNote = 'Admin tự duyệt (đã nhập mật khẩu)';
    else {
      await writeAudit(db, { actorUserId: user.id, action: cfg.auditApproved, targetType: 'ApprovalRequest', targetId: String(req.id), after: { denied: true, reason: 'SELF_APPROVAL_FORBIDDEN' } });
      return { ok: false, error: 'SELF_APPROVAL_FORBIDDEN', message: 'Chỉ Admin mới được tự duyệt yêu cầu của chính mình (cần nhập mật khẩu).' };
    }
  } else if (requesterIsApprover && !approverElevated) {
    await writeAudit(db, { actorUserId: user.id, action: cfg.auditApproved, targetType: 'ApprovalRequest', targetId: String(req.id), after: { denied: true, reason: 'NEED_ELEVATED', requestedBy: req.requestedBy } });
    return { ok: false, error: 'NEED_ELEVATED', message: 'Yêu cầu do Quản lý/Admin tạo — cần cấp Admin duyệt.' };
  }

  const label = (await cfg.display(db, req.entityId)) ?? String(req.entityId);
  const note = [decisionNote?.trim() || null, selfNote].filter(Boolean).join(' · ') || null;
  const decidedAt = new Date();
  try {
    await db.$transaction(async (txc) => {
      const reqMoved = await txc.approvalRequest.updateMany({ where: { id: req.id, status: 'PENDING' }, data: { status: 'APPROVED', decidedBy: user.id, decidedAt, decisionNote: note } });
      if (reqMoved.count === 0) throw new TxGuardError('ALREADY_DECIDED', 'Yêu cầu đã được xử lý (không còn chờ duyệt).');
      await cfg.applyCancel(txc, req.entityId, user, req.reason);
      // G1: audit NGHIÊM trong tx (tier-1 approval/hủy) — audit fail → rollback cả việc xóa mềm entity.
      await writeAuditStrict(txc, { actorUserId: user.id, action: cfg.auditApproved, targetType: cfg.entityType, targetId: String(req.entityId), after: auditSnapshot({ requestId: req.id, label, note }) });
    });
  } catch (e) {
    if (e instanceof TxGuardError) return { ok: false, error: e.code, message: e.userMessage };
    throw e;
  }
  await bumpChangeToken(db, cfg.entityType);
  try {
    await pushSystemNotice(db, [req.requestedBy], cfg.auditApproved, `Yêu cầu hủy ${cfg.label} ${label} đã được DUYỆT`, `Yêu cầu hủy ${cfg.label} ${label} của bạn đã được duyệt.${note ? ' Ghi chú: ' + note + '.' : ''}`);
  } catch {
    // phụ trợ
  }
  return { ok: true, id: req.id };
}

async function rejectOne(db: Db, cfg: EntityConfig, user: AuthUser, requestId: number, decisionNote: string): Promise<OneResult> {
  const req = await db.approvalRequest.findUnique({ where: { id: requestId } });
  if (!req || req.action !== 'CANCEL' || req.entityType !== cfg.entityType) return { ok: false, error: 'NOT_FOUND', message: 'Yêu cầu hủy không tồn tại.' };
  const note = (decisionNote ?? '').trim();
  if (!note) return { ok: false, error: 'VALIDATION', message: 'Vui lòng nhập lý do từ chối.' };
  const decidedAt = new Date();
  try {
    await db.$transaction(async (txc) => {
      const reqMoved = await txc.approvalRequest.updateMany({ where: { id: req.id, status: 'PENDING' }, data: { status: 'REJECTED', decidedBy: user.id, decidedAt, decisionNote: note } });
      if (reqMoved.count === 0) throw new TxGuardError('INVALID_STATE', 'Yêu cầu đã được xử lý.');
    });
  } catch (e) {
    if (e instanceof TxGuardError) return { ok: false, error: e.code, message: e.userMessage };
    throw e;
  }
  const label = (await cfg.display(db, req.entityId)) ?? String(req.entityId);
  await writeAudit(db, { actorUserId: user.id, action: cfg.auditRejected, targetType: cfg.entityType, targetId: String(req.entityId), after: auditSnapshot({ requestId: req.id, label, note }) });
  try {
    await pushSystemNotice(db, [req.requestedBy], cfg.auditRejected, `Yêu cầu hủy ${cfg.label} ${label} bị TỪ CHỐI`, `Yêu cầu hủy ${cfg.label} ${label} của bạn đã bị từ chối. Lý do: ${note}.`);
  } catch {
    // phụ trợ
  }
  return { ok: true, id: req.id };
}

/** Duyệt 1 yêu cầu hủy entity — mật khẩu người duyệt do ADAPTER route verify TRƯỚC (lõi KHÔNG kiểm password). */
export async function approveEntityCancel(ctx: ServiceCtx, entityType: string, requestId: number, decisionNote?: string): Promise<MutationResult> {
  const cfg = cfgOf(entityType);
  if (!cfg) return { ok: false, error: 'VALIDATION', message: 'Loại dữ liệu không hỗ trợ duyệt hủy.' };
  if (!hasPermission(ctx.user, cfg.perms.approve)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const r = await approveOne(ctx.db, cfg, ctx.user, requestId, decisionNote);
  return r.ok ? { ok: true, id: r.id } : { ok: false, error: r.error, message: r.message };
}

/** 1 phiếu trong lô duyệt gộp — phải kèm LOẠI vì mã phiếu chỉ duy nhất TRONG TỪNG loại (mỗi loại 1 bảng riêng). */
export interface EntityCancelBulkItem {
  entityType: string;
  id: number;
}

export interface EntityCancelBulkResult {
  ok: boolean;
  error?: string;
  message?: string;
  done: number;
  skipped: { id: number; reason: string; message?: string }[];
}

/**
 * Duyệt HÀNG LOẠT yêu cầu hủy entity — mật khẩu người duyệt do ADAPTER route verify ĐÚNG MỘT LẦN cho cả lô
 * (khuôn approveCancelBills của phiếu bill). Trước 13/11 màn Duyệt hủy gọi 1 request/phiếu nên quá 5 phiếu/phút
 * là dính trần chống dò mật khẩu (B152) — và mạng rớt giữa chừng thì duyệt DỞ DANG mà người dùng không biết.
 *
 * Lô có thể TRỘN nhiều loại (TID/máy POS/khách/nhân sự). Không-đủ-quyền hay loại lạ thì BỎ QUA TỪNG PHIẾU
 * (ghi vào `skipped`) chứ KHÔNG đánh đổ cả lô — người duyệt vẫn chạy được phần mình có quyền, và nhìn rõ phần
 * bị bỏ. Duyệt TỪNG phiếu một (không gộp transaction) y như đường 1-phiếu: mỗi phiếu tự ghi nhật ký + báo tin.
 */
export async function approveEntityCancelBulk(ctx: ServiceCtx, items: EntityCancelBulkItem[], decisionNote?: string): Promise<EntityCancelBulkResult> {
  if (!items || items.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn yêu cầu.', done: 0, skipped: [] };
  let done = 0;
  const skipped: EntityCancelBulkResult['skipped'] = [];
  for (const it of items) {
    const cfg = cfgOf(it.entityType);
    if (!cfg) { skipped.push({ id: it.id, reason: 'VALIDATION', message: 'Loại dữ liệu không hỗ trợ duyệt hủy.' }); continue; }
    if (!hasPermission(ctx.user, cfg.perms.approve)) { skipped.push({ id: it.id, reason: 'FORBIDDEN', message: FORBIDDEN_MESSAGE }); continue; }
    const r = await approveOne(ctx.db, cfg, ctx.user, it.id, decisionNote);
    if (r.ok) done++;
    else skipped.push({ id: it.id, reason: r.error ?? 'ERROR', message: r.message });
  }
  return { ok: true, done, skipped };
}

export async function rejectEntityCancel(ctx: ServiceCtx, entityType: string, requestId: number, decisionNote: string): Promise<MutationResult> {
  const cfg = cfgOf(entityType);
  if (!cfg) return { ok: false, error: 'VALIDATION', message: 'Loại dữ liệu không hỗ trợ duyệt hủy.' };
  if (!hasPermission(ctx.user, cfg.perms.approve)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const r = await rejectOne(ctx.db, cfg, ctx.user, requestId, decisionNote);
  return r.ok ? { ok: true, id: r.id } : { ok: false, error: r.error, message: r.message };
}

// ═════════════════════════════════════════════════════════════════════════════
// DANH SÁCH yêu cầu hủy entity — gộp mọi loại user ĐƯỢC duyệt.
// ═════════════════════════════════════════════════════════════════════════════
export interface EntityCancelRequestDto {
  id: number;
  entityType: string;
  entityTypeLabel: string;
  entityId: number;
  entityLabel: string | null;
  reason: string;
  status: string;
  requestedBy: number;
  requestedByName: string | null;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  canApprove: boolean;
  isSelf: boolean;
}

/**
 * Liệt kê yêu cầu hủy của 4 entity theo `status`. Chỉ trả loại mà user hiện tại có quyền APPROVE; `canApprove` áp
 * phân vai (loại self + yêu cầu-của-approver-cần-elevated). `entityTypeFilter` optional.
 */
export async function listEntityCancelRequests(ctx: ServiceCtx, status = 'PENDING', entityTypeFilter?: string): Promise<{ ok: boolean; error?: string; message?: string; data?: EntityCancelRequestDto[] }> {
  const { db, user } = ctx;
  const types = entityTypeFilter ? [entityTypeFilter].filter((t) => REGISTRY[t]) : CANCELABLE_ENTITY_TYPES;
  const allowed = types.filter((t) => hasPermission(user, REGISTRY[t]!.perms.approve));
  if (allowed.length === 0) return { ok: false, error: 'FORBIDDEN', message: 'Bạn không có quyền duyệt hủy.' };

  const rows = await db.approvalRequest.findMany({ where: { entityType: { in: allowed }, action: 'CANCEL', status }, orderBy: { requestedAt: 'desc' } });
  const reqUserIds = [...new Set(rows.map((r) => r.requestedBy))];
  const nameIds = [...new Set([...reqUserIds, ...rows.map((r) => r.decidedBy).filter((x): x is number => x != null)])];
  const names = new Map((await db.user.findMany({ where: { id: { in: nameIds } }, select: { id: true, fullName: true, username: true } })).map((u) => [u.id, u.fullName || u.username]));
  // Perf: nạp permSet 1 LẦN cho mỗi người-yêu-cầu (tránh N+1).
  const permMap = new Map<number, Set<string>>();
  for (const uid of reqUserIds) permMap.set(uid, await userPermSet(db, uid));

  const data: EntityCancelRequestDto[] = [];
  for (const r of rows) {
    const cfg = REGISTRY[r.entityType];
    if (!cfg) continue;
    const requesterPerms = permMap.get(r.requestedBy) ?? new Set<string>();
    const requesterIsApprover = requesterPerms.has(cfg.perms.approve);
    const approverElevated = hasPermission(user, cfg.perms.elevated);
    const isSelf = user.id === r.requestedBy;
    let canApprove = true;
    if (isSelf) canApprove = approverElevated;
    else if (requesterIsApprover && !approverElevated) canApprove = false;
    data.push({
      id: r.id,
      entityType: r.entityType,
      entityTypeLabel: cfg.label,
      entityId: r.entityId,
      entityLabel: await cfg.display(db, r.entityId),
      reason: r.reason,
      status: r.status,
      requestedBy: r.requestedBy,
      requestedByName: names.get(r.requestedBy) ?? null,
      requestedAt: r.requestedAt.toISOString(),
      decidedByName: r.decidedBy != null ? names.get(r.decidedBy) ?? null : null,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      decisionNote: r.decisionNote ?? null,
      canApprove,
      isSelf
    });
  }
  return { ok: true, data };
}
