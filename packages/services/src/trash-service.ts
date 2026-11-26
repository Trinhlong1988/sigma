// Thùng rác + phục hồi (R_TRASH_RESTORE) — LÕI THUẦN ctx-based. PORT nghiệp vụ từ apps/desktop/src/main/trash-service.ts.
// Soft-delete toàn hệ thống: xóa = set deletedAt (KHÔNG xóa vật lý). Phục hồi = clear deletedAt. Xóa VĨNH VIỄN 1 bản
// ghi cần MẬT KHẨU (cấp 1); DỌN SẠCH toàn bộ cần MẬT KHẨU CẤP 2 — cả hai do ADAPTER route verify TRƯỚC khi gọi lõi
// (khuôn customer.ts: lõi KHÔNG kiểm password/level2). KHUÔN (pos-supply): ctx = { db, user }; mỗi hàm tự hasPermission.
// ServiceCtx/MutationResult từ customer.js. writeAudit từ audit.js. PosDevice/Tid vòng đời trạng thái không ở đây.
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import type { ServiceCtx, MutationResult } from './customer.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

/** Các thực thể có soft-delete → vào thùng rác. */
export type TrashEntity =
  | 'Customer'
  | 'Agent'
  | 'Bank'
  | 'CardType'
  | 'Partner'
  | 'Supplier'
  | 'PosModel'
  | 'PosIntakeStatus'
  | 'PosIntake'
  | 'FeeType'
  | 'FeeRate'
  | 'ReceiveAccountSource'
  | 'ReceiveAccount'
  | 'DossierSource'
  | 'Dossier'
  | 'TidConfigStatus'
  | 'Tid'
  | 'Transaction';

const LABEL: Record<TrashEntity, string> = {
  Customer: 'Khách hàng',
  Agent: 'Đại lý',
  Bank: 'Ngân hàng',
  CardType: 'Loại thẻ',
  Partner: 'Đối tác',
  Supplier: 'Nhà cung cấp',
  PosModel: 'Chủng loại máy POS',
  PosIntakeStatus: 'Trạng thái nhập máy',
  PosIntake: 'Máy POS nhập kho',
  FeeType: 'Loại phí',
  FeeRate: 'Biểu phí',
  ReceiveAccountSource: 'Nguồn TK nhận tiền',
  ReceiveAccount: 'TK nhận tiền',
  DossierSource: 'Nguồn hồ sơ',
  Dossier: 'Hồ sơ HKD',
  TidConfigStatus: 'Trạng thái TID',
  Tid: 'TID (cấu hình)',
  Transaction: 'Giao dịch doanh thu'
};

export function isTrashEntity(v: string): v is TrashEntity {
  return v in LABEL;
}

export interface TrashRow {
  entityType: TrashEntity;
  entityLabel: string;
  id: number;
  code: string | null;
  label: string;
  deletedAt: string;
  deletedBy: number | null;
  deletedByName: string | null;
}

export interface LinkRef {
  label: string;
  count: number;
}

/**
 * TRASH_VIEW — liệt kê bản ghi đã xóa mềm, mới xóa lên trước. Per-user (Nhóm A #4): user thường chỉ thấy đồ MÌNH xóa;
 * ai có TRASH_VIEW_ALL (Admin/Manager) thấy thùng rác TỔNG của mọi người + hiển thị tên người xóa.
 */
export async function listTrash(ctx: ServiceCtx): Promise<{ ok: boolean; data?: TrashRow[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'TRASH_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const viewAll = hasPermission(user, 'TRASH_VIEW_ALL');
  const del = viewAll ? { deletedAt: { not: null } } : { deletedAt: { not: null }, deletedBy: user.id };
  const [customers, agents, banks, cardTypes, partners, suppliers, posModels, intakeStatuses, posIntakes, feeTypes, feeRates, rcvSources, rcvAccounts, dossierSources, dossiers, tidStatuses, tids, transactions] = await Promise.all([
    db.customer.findMany({ where: del }),
    db.agent.findMany({ where: del }),
    db.bank.findMany({ where: del }),
    db.cardType.findMany({ where: del }),
    db.partner.findMany({ where: del }),
    db.supplier.findMany({ where: del }),
    db.posModel.findMany({ where: del }),
    db.posIntakeStatus.findMany({ where: del }),
    db.posIntake.findMany({ where: del }),
    db.feeType.findMany({ where: del }),
    db.feeRate.findMany({ where: del }),
    db.receiveAccountSource.findMany({ where: del }),
    db.receiveAccount.findMany({ where: del }),
    db.dossierSource.findMany({ where: del }),
    db.dossier.findMany({ where: del }),
    db.tidConfigStatus.findMany({ where: del }),
    db.tid.findMany({ where: del }),
    db.transaction.findMany({ where: del })
  ]);
  const rows: TrashRow[] = [
    ...customers.map((c) => row('Customer', c.id, c.code, `${c.nickname} (${c.fullName})`, c.deletedAt, c.deletedBy)),
    ...agents.map((a) => row('Agent', a.id, a.code, a.name, a.deletedAt, a.deletedBy)),
    ...banks.map((b) => row('Bank', b.id, b.code, b.name, b.deletedAt, b.deletedBy)),
    ...cardTypes.map((ct) => row('CardType', ct.id, ct.code, ct.name, ct.deletedAt, ct.deletedBy)),
    ...partners.map((p) => row('Partner', p.id, p.code, p.name, p.deletedAt, p.deletedBy)),
    ...suppliers.map((s) => row('Supplier', s.id, s.code, s.name, s.deletedAt, s.deletedBy)),
    ...posModels.map((m) => row('PosModel', m.id, m.code, m.name, m.deletedAt, m.deletedBy)),
    ...intakeStatuses.map((st) => row('PosIntakeStatus', st.id, null, st.name, st.deletedAt, st.deletedBy)),
    ...posIntakes.map((pi) => row('PosIntake', pi.id, pi.serial, pi.serial, pi.deletedAt, pi.deletedBy)),
    ...feeTypes.map((ft) => row('FeeType', ft.id, null, ft.name, ft.deletedAt, ft.deletedBy)),
    ...feeRates.map((fr) => row('FeeRate', fr.id, null, `Biểu phí #${fr.id}`, fr.deletedAt, fr.deletedBy)),
    ...rcvSources.map((s) => row('ReceiveAccountSource', s.id, null, s.name, s.deletedAt, s.deletedBy)),
    ...rcvAccounts.map((a) => row('ReceiveAccount', a.id, a.accountNumber, `${a.accountName} · ${a.accountNumber}`, a.deletedAt, a.deletedBy)),
    ...dossierSources.map((s) => row('DossierSource', s.id, s.code, s.code, s.deletedAt, s.deletedBy)),
    ...dossiers.map((d) => row('Dossier', d.id, null, `${d.hkdName} · ${d.ownerName}`, d.deletedAt, d.deletedBy)),
    ...tidStatuses.map((s) => row('TidConfigStatus', s.id, null, s.name, s.deletedAt, s.deletedBy)),
    ...tids.map((t) => row('Tid', t.id, t.tid, t.hkdName ? `${t.tid} · ${t.hkdName}` : t.tid, t.deletedAt, t.deletedBy)),
    ...transactions.map((tx) => row('Transaction', tx.id, tx.code, tx.code ? `${tx.code} · ${tx.amount}đ` : `Giao dịch #${tx.id}`, tx.deletedAt, tx.deletedBy))
  ].sort((x, y) => (x.deletedAt < y.deletedAt ? 1 : -1));

  // Resolve tên người xóa (1 lượt) — chỉ ý nghĩa khi xem thùng rác tổng.
  const deleterIds = [...new Set(rows.map((r) => r.deletedBy).filter((x): x is number => x !== null))];
  if (deleterIds.length) {
    const users = await db.user.findMany({ where: { id: { in: deleterIds } }, select: { id: true, fullName: true } });
    const nameById = new Map(users.map((u) => [u.id, u.fullName]));
    for (const r of rows) r.deletedByName = r.deletedBy !== null ? (nameById.get(r.deletedBy) ?? null) : null;
  }
  return { ok: true, data: rows };
}

function row(entityType: TrashEntity, id: number, code: string | null, label: string, deletedAt: Date | null, deletedBy: number | null): TrashRow {
  return { entityType, entityLabel: LABEL[entityType], id, code, label, deletedAt: (deletedAt ?? new Date(0)).toISOString(), deletedBy: deletedBy ?? null, deletedByName: null };
}

/**
 * Đếm dữ liệu ĐANG liên kết tới thực thể (để cảnh báo TRƯỚC khi xóa — R_TRASH_RESTORE). Không chặn xóa; chỉ cho biết
 * ảnh hưởng. Liên kết bằng scalar-id → không cascade.
 */
export async function linkSummary(ctx: ServiceCtx, entityType: string, id: number): Promise<{ ok: boolean; data?: LinkRef[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'TRASH_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  if (!isTrashEntity(entityType)) return { ok: false, error: 'BAD_ENTITY', message: `Loại dữ liệu không hợp lệ: ${entityType}` };
  const db = ctx.db;
  const refs: LinkRef[] = [];
  const alive = { deletedAt: null } as const;
  if (entityType === 'Agent') {
    const [cus, pos, tid] = await Promise.all([
      db.customer.count({ where: { agentId: id, ...alive } }),
      db.posDevice.count({ where: { currentAgentId: id } }),
      db.tid.count({ where: { agentId: id } })
    ]);
    if (cus) refs.push({ label: 'Khách hàng thuộc đại lý', count: cus });
    if (pos) refs.push({ label: 'Máy POS đang ở đại lý', count: pos });
    if (tid) refs.push({ label: 'TID gắn đại lý', count: tid });
  } else if (entityType === 'Customer') {
    const [pos, tid] = await Promise.all([
      db.posDevice.count({ where: { currentCustomerId: id } }),
      db.tid.count({ where: { customerId: id } })
    ]);
    if (pos) refs.push({ label: 'Máy POS đang ở khách', count: pos });
    if (tid) refs.push({ label: 'TID của khách', count: tid });
  } else if (entityType === 'Bank') {
    const [ct, pb] = await Promise.all([
      db.cardType.count({ where: { bankId: id, ...alive } }),
      db.partnerBank.count({ where: { bankId: id, ...alive } })
    ]);
    if (ct) refs.push({ label: 'Loại thẻ thuộc ngân hàng', count: ct });
    if (pb) refs.push({ label: 'Liên kết đối tác–ngân hàng', count: pb });
  } else if (entityType === 'Partner') {
    const pb = await db.partnerBank.count({ where: { partnerId: id, ...alive } });
    if (pb) refs.push({ label: 'Ngân hàng liên kết đối tác', count: pb });
  }
  return { ok: true, data: refs };
}

/** TRASH_RESTORE (Admin) — phục hồi 1 bản ghi đã xóa. Audit RESTORE_EXECUTED. */
export async function restoreItem(ctx: ServiceCtx, entityType: string, id: number): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'TRASH_RESTORE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!isTrashEntity(entityType)) return { ok: false, error: 'BAD_ENTITY', message: `Loại dữ liệu không hợp lệ: ${entityType}` };

  const current = await findOne(db, entityType, id);
  if (!current) return { ok: false, error: 'NOT_FOUND', message: 'Bản ghi không tồn tại.' };
  if (current.deletedAt === null) return { ok: false, error: 'NOT_DELETED', message: 'Bản ghi này chưa bị xóa nên không cần phục hồi.' };
  // IDOR guard (đối xứng listTrash): user KHÔNG có TRASH_VIEW_ALL chỉ được phục hồi ĐỒ MÌNH xóa. Vá kịch bản
  // role tùy biến tách TRASH_RESTORE khỏi TRASH_VIEW_ALL → tránh phục hồi chéo bản ghi người khác đã xóa.
  if (!hasPermission(user, 'TRASH_VIEW_ALL') && current.deletedBy !== user.id) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };

  await clearDeleted(db, entityType, id);
  await writeAudit(db, { actorUserId: user.id, action: 'RESTORE_EXECUTED', targetType: entityType, targetId: String(id), after: { restored: true, entity: entityType } });
  return { ok: true, id };
}

async function findOne(db: Db, entityType: TrashEntity, id: number): Promise<{ deletedAt: Date | null; deletedBy: number | null } | null> {
  switch (entityType) {
    case 'Customer': return db.customer.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'Agent': return db.agent.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'Bank': return db.bank.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'CardType': return db.cardType.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'Partner': return db.partner.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'Supplier': return db.supplier.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'PosModel': return db.posModel.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'PosIntakeStatus': return db.posIntakeStatus.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'PosIntake': return db.posIntake.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'FeeType': return db.feeType.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'FeeRate': return db.feeRate.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'ReceiveAccountSource': return db.receiveAccountSource.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'ReceiveAccount': return db.receiveAccount.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'DossierSource': return db.dossierSource.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'Dossier': return db.dossier.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'TidConfigStatus': return db.tidConfigStatus.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'Tid': return db.tid.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
    case 'Transaction': return db.transaction.findUnique({ where: { id }, select: { deletedAt: true, deletedBy: true } });
  }
}

async function clearDeleted(db: Db, entityType: TrashEntity, id: number): Promise<void> {
  const data = { deletedAt: null, deletedBy: null } as const;
  switch (entityType) {
    case 'Customer': await db.customer.update({ where: { id }, data }); return;
    case 'Agent': await db.agent.update({ where: { id }, data }); return;
    case 'Bank': await db.bank.update({ where: { id }, data }); return;
    case 'CardType': await db.cardType.update({ where: { id }, data }); return;
    case 'Partner': await db.partner.update({ where: { id }, data }); return;
    case 'Supplier': await db.supplier.update({ where: { id }, data }); return;
    case 'PosModel': await db.posModel.update({ where: { id }, data }); return;
    case 'PosIntakeStatus': await db.posIntakeStatus.update({ where: { id }, data }); return;
    case 'PosIntake': {
      // [B319/F6 24/11] B267 xoá phiếu KÈM MÁY — khôi phục phải HỒI SINH MÁY cùng seri (bị xoá cùng
      // đợt), kẻo phiếu sống lại mà máy vô hình vĩnh viễn (không TrashEntity nào cứu được máy).
      const phieu = await db.posIntake.findUnique({ where: { id }, select: { serial: true } });
      await db.posIntake.update({ where: { id }, data });
      if (phieu?.serial) {
        await db.$executeRawUnsafe(
          'UPDATE pos_devices SET deleted_at = NULL, deleted_by = NULL WHERE serial = $1 AND deleted_at IS NOT NULL',
          phieu.serial);
      }
      return;
    }
    case 'FeeType': await db.feeType.update({ where: { id }, data }); return;
    case 'FeeRate': {
      const rate = await db.feeRate.findUnique({ where: { id }, select: { partnerId: true, cardTypeId: true, effectiveFrom: true } });
      await db.feeRate.update({ where: { id }, data });
      // FEE_MODEL — khôi phục biểu phí cũng khôi phục phí bán niêm yết CÙNG KỲ đã xóa mềm kèm (đối xứng deleteFeeRates).
      if (rate) await db.feeSellQuote.updateMany({ where: { partnerId: rate.partnerId, cardTypeId: rate.cardTypeId, effectiveFrom: rate.effectiveFrom, deletedAt: { not: null } }, data });
      return;
    }
    case 'ReceiveAccountSource': await db.receiveAccountSource.update({ where: { id }, data }); return;
    case 'ReceiveAccount': await db.receiveAccount.update({ where: { id }, data }); return;
    case 'DossierSource': await db.dossierSource.update({ where: { id }, data }); return;
    case 'Dossier': await db.dossier.update({ where: { id }, data }); return;
    case 'TidConfigStatus': await db.tidConfigStatus.update({ where: { id }, data }); return;
    case 'Tid': await db.tid.update({ where: { id }, data }); return;
    case 'Transaction': await db.transaction.update({ where: { id }, data }); return;
  }
}

/** [B317/F3 24/11 — agent đào vét] Lỗi nghiệp vụ trong hardDeleteOne — ném để caller trả MutationResult. */
export class TrashGuardError extends Error {
  constructor(public readonly userMessage: string) { super(userMessage); }
}

/** Xóa CỨNG vĩnh viễn 1 bản ghi (không thể phục hồi). Liên kết bằng scalar-id → không cascade. */
async function hardDeleteOne(db: Db, entityType: TrashEntity, id: number): Promise<void> {
  // [B317/F3] TID còn DÒNG TIỀN (lo_rows/transactions trỏ scalar-id, DB không FK) mà xoá vĩnh viễn là
  // tiền thành MỒ CÔI CÂM: màn Doanh Số join LEFT ra cột TID/HKD trống (tái hiện: 1tr mồ côi). Từ chối
  // nêu rõ số dòng. Áp cho cả purgeItem lẫn emptyTrash (cùng đi qua đây).
  if (entityType === 'Tid') {
    const dinh = await db.$queryRawUnsafe<Array<{ lo: number; gd: number }>>(
      'SELECT (SELECT count(*) FROM lo_rows WHERE tid_id=$1)::int AS lo, (SELECT count(*) FROM transactions WHERE tid_id=$1)::int AS gd', id);
    const { lo, gd } = dinh[0] ?? { lo: 0, gd: 0 };
    if (lo > 0 || gd > 0) {
      throw new TrashGuardError(
        `TID này còn ${lo} dòng bill + ${gd} giao dịch trong sổ — xoá vĩnh viễn là tiền thành mồ côi. `
        + 'CÁCH SỬA: giữ TID trong thùng rác (không chiếm chỗ), hoặc nhờ kỹ thuật xử lý dòng tiền trước.');
    }
  }
  switch (entityType) {
    case 'Customer': await db.customer.delete({ where: { id } }); return;
    case 'Agent': await db.agent.delete({ where: { id } }); return;
    case 'Bank': await db.bank.delete({ where: { id } }); return;
    case 'CardType': await db.cardType.delete({ where: { id } }); return;
    case 'Partner': await db.partner.delete({ where: { id } }); return;
    case 'Supplier': await db.supplier.delete({ where: { id } }); return;
    case 'PosModel': await db.posModel.delete({ where: { id } }); return;
    case 'PosIntakeStatus': await db.posIntakeStatus.delete({ where: { id } }); return;
    case 'PosIntake': await db.posIntake.delete({ where: { id } }); return;
    case 'FeeType': await db.feeType.delete({ where: { id } }); return;
    case 'FeeRate': await db.feeRate.delete({ where: { id } }); return;
    case 'ReceiveAccountSource': await db.receiveAccountSource.delete({ where: { id } }); return;
    case 'ReceiveAccount': await db.receiveAccount.delete({ where: { id } }); return;
    case 'DossierSource': await db.dossierSource.delete({ where: { id } }); return;
    case 'Dossier': await db.dossier.delete({ where: { id } }); return;
    case 'TidConfigStatus': await db.tidConfigStatus.delete({ where: { id } }); return;
    case 'Tid': await db.tid.delete({ where: { id } }); return;
    case 'Transaction': await db.transaction.delete({ where: { id } }); return;
  }
}

/**
 * TRASH_PURGE — XÓA VĨNH VIỄN 1 bản ghi trong thùng rác (Nhóm A #3). MẬT KHẨU (cấp 1) do ADAPTER route verify TRƯỚC
 * (lõi KHÔNG kiểm password). Bản ghi PHẢI đang ở thùng rác (đã xóa mềm). Không thể phục hồi sau bước này.
 */
export async function purgeItem(ctx: ServiceCtx, entityType: string, id: number): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'TRASH_PURGE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!isTrashEntity(entityType)) return { ok: false, error: 'BAD_ENTITY', message: `Loại dữ liệu không hợp lệ: ${entityType}` };
  const current = await findOne(db, entityType, id);
  if (!current) return { ok: false, error: 'NOT_FOUND', message: 'Bản ghi không tồn tại.' };
  if (current.deletedAt === null) return { ok: false, error: 'NOT_DELETED', message: 'Chỉ được xóa vĩnh viễn bản ghi đã nằm trong thùng rác.' };
  // IDOR guard (đối xứng listTrash): user KHÔNG có TRASH_VIEW_ALL chỉ được xóa vĩnh viễn ĐỒ MÌNH xóa. Vá kịch bản
  // role tùy biến tách TRASH_PURGE khỏi TRASH_VIEW_ALL → tránh xóa vĩnh viễn chéo bản ghi người khác.
  if (!hasPermission(user, 'TRASH_VIEW_ALL') && current.deletedBy !== user.id) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };

  try {
    await hardDeleteOne(db, entityType, id);
  } catch (e) {
    if (e instanceof TrashGuardError) return { ok: false, error: 'IN_USE', message: e.userMessage };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'TRASH_PURGED', targetType: entityType, targetId: String(id), after: { purged: true, entity: entityType, by: user.username } });
  return { ok: true, id };
}

/**
 * TRASH_PURGE — DỌN SẠCH TOÀN BỘ thùng rác (xóa cứng MỌI bản ghi đã xóa mềm — Nhóm A #3, quyết định 1a). MẬT KHẨU
 * CẤP 2 do ADAPTER route verify TRƯỚC (gồm gate LEVEL2_NOT_SET nếu người thực hiện chưa đặt level2). Không thể phục hồi.
 */
export async function emptyTrash(ctx: ServiceCtx): Promise<MutationResult & { purged?: number }> {
  if (!hasPermission(ctx.user, 'TRASH_PURGE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const del = { where: { deletedAt: { not: null } } } as const;
  const [customers, agents, banks, cardTypes, partners, suppliers, posModels, intakeStatuses, posIntakes, feeTypes, feeRates, rcvSources, rcvAccounts, dossierSources, dossiers, tidStatuses, tids, transactions] = await Promise.all([
    db.customer.deleteMany(del), db.agent.deleteMany(del), db.bank.deleteMany(del), db.cardType.deleteMany(del),
    db.partner.deleteMany(del), db.supplier.deleteMany(del), db.posModel.deleteMany(del), db.posIntakeStatus.deleteMany(del),
    db.posIntake.deleteMany(del), db.feeType.deleteMany(del), db.feeRate.deleteMany(del), db.receiveAccountSource.deleteMany(del),
    db.receiveAccount.deleteMany(del), db.dossierSource.deleteMany(del), db.dossier.deleteMany(del),
    db.tidConfigStatus.deleteMany(del),
    // [B317/F3] emptyTrash KHÔNG đi qua hardDeleteOne từng dòng — chỉ xoá TID KHÔNG còn dòng tiền
    // (TID còn lo_rows/transactions nằm lại thùng rác, không mất tiền mồ côi câm).
    db.$executeRawUnsafe(
      `DELETE FROM tids t WHERE t.deleted_at IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM lo_rows r WHERE r.tid_id = t.id)
         AND NOT EXISTS (SELECT 1 FROM transactions x WHERE x.tid_id = t.id)`
    ).then((n) => ({ count: Number(n) })),
    db.transaction.deleteMany(del)
  ]);
  const purged = [customers, agents, banks, cardTypes, partners, suppliers, posModels, intakeStatuses, posIntakes, feeTypes, feeRates, rcvSources, rcvAccounts, dossierSources, dossiers, tidStatuses, tids, transactions].reduce((s, r) => s + r.count, 0);

  await writeAudit(db, { actorUserId: user.id, action: 'TRASH_EMPTIED', targetType: 'System', targetId: null, after: { purged, by: user.username } });
  return { ok: true, purged };
}
