// Duyệt HỦY BILL (P1.2 Approval Engine) — LÕI THUẦN ctx-based. PORT nghiệp vụ từ apps/desktop/src/main/approval-service.ts.
// LEAD chốt 10/7: ghi bill tính ngay; CHỈ HỦY cần duyệt. Phân vai (②B): người tạo yêu cầu ≠ người duyệt; requester
// cấp Manager/Admin (có BILL_CANCEL_APPROVE) cần approver cấp Admin (BILL_CANCEL_APPROVE_ELEVATED); fallback: Admin
// (elevated) tự duyệt yêu cầu của mình (chốt = nhập MẬT KHẨU khi duyệt). Kiểm quyền bằng PERMISSION, KHÔNG bằng role.
// KHUÔN (pos-supply/customer): ctx = { db, user } do adapter dựng; mỗi hàm tự hasPermission. XÁC NHẬN MẬT KHẨU (§14)
// khi DUYỆT do ADAPTER route verify TRƯỚC khi gọi lõi (lõi KHÔNG kiểm password). ServiceCtx/MutationResult từ
// customer.js. writeAudit/writeAuditStrict/bumpChangeToken từ audit.js. actor = ctx.user.id.
import { auditSnapshot } from '@sigma/business-rules';
import { hasPermission, type AuthUser } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit, writeAuditStrict, bumpChangeToken } from './audit.js';
import type { ServiceCtx, MutationResult } from './customer.js';

const REQUEST = 'BILL_CANCEL_REQUEST';
const APPROVE = 'BILL_CANCEL_APPROVE';
const ELEVATED = 'BILL_CANCEL_APPROVE_ELEVATED';
const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

/**
 * G10.C — gia cố tương tranh. Ném BÊN TRONG `db.$transaction` để (a) rollback nguyên tử khi conditional transition
 * THUA (updateMany count===0), (b) mang mã lỗi ra ngoài trả về client. KHÔNG audit/notify ở nhánh thua.
 */
class TxGuardError extends Error {
  constructor(
    public readonly code: string,
    public readonly userMessage: string
  ) {
    super(code);
    this.name = 'TxGuardError';
  }
}

export interface BulkResult {
  ok: boolean;
  error?: string;
  message?: string;
  done: number; // số approve/reject thành công
  skipped: { id: number; reason: string; message?: string }[];
}

/** Tập quyền hiệu lực của 1 user (theo id) — user → roles → role.permissions. */
async function userPermSet(db: Db, userId: number): Promise<Set<string>> {
  const u = await db.user.findUnique({
    where: { id: userId },
    include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } }
  });
  const s = new Set<string>();
  if (u) for (const ur of u.roles) for (const rp of ur.role.permissions) s.add(rp.permission.code);
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// THÔNG BÁO HỆ THỐNG (F-NOTIF) — đẩy sự kiện hủy bill vào hòm thư (messages, kind=SYSTEM, senderId=null).
// Phụ trợ tuyệt đối: nuốt lỗi — KHÔNG bao giờ làm hỏng luồng hủy/duyệt/từ chối.
// ─────────────────────────────────────────────────────────────────────────────

/** Người ĐƯỢC duyệt 1 yêu cầu hủy — khớp phân vai: loại chính người tạo; yêu cầu do Quản lý/Admin (có APPROVE)
 *  tạo → chỉ cấp ELEVATED; ngược lại mọi người có APPROVE. Chỉ user còn sống + ACTIVE. */
async function cancelApproverRecipients(db: Db, requestedBy: number): Promise<number[]> {
  const requesterPerms = await userPermSet(db, requestedBy);
  const needCode = requesterPerms.has(APPROVE) ? ELEVATED : APPROVE;
  const users = await db.user.findMany({
    where: { deletedAt: null, status: 'ACTIVE' },
    include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } }
  });
  const ids: number[] = [];
  for (const u of users) {
    if (u.id === requestedBy) continue; // loại chính người tạo (§②a)
    if (u.roles.some((ur) => ur.role.permissions.some((rp) => rp.permission.code === needCode))) ids.push(u.id);
  }
  return ids;
}

/** Chèn thông báo hệ thống tới danh sách người nhận. */
async function pushSystemNotice(db: Db, recipientIds: number[], category: string, subject: string, body: string): Promise<void> {
  const ids = [...new Set(recipientIds)];
  if (ids.length === 0) return;
  try {
    await db.message.createMany({ data: ids.map((rid) => ({ kind: 'SYSTEM', category, subject, body, senderId: null, recipientId: rid })) });
  } catch {
    // Thông báo phụ trợ — không được làm hỏng luồng chính (hủy/duyệt/từ chối bill).
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// TẠO YÊU CẦU HỦY
// ═════════════════════════════════════════════════════════════════════════════
export async function requestCancelBill(ctx: ServiceCtx, transactionId: number, reason: string): Promise<MutationResult> {
  if (!hasPermission(ctx.user, REQUEST)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const r = (reason ?? '').trim();
  if (!r) return { ok: false, error: 'VALIDATION', message: 'Vui lòng nhập lý do hủy bill.' };
  const tx = await db.transaction.findUnique({ where: { id: transactionId } });
  if (!tx || tx.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Giao dịch không tồn tại.' };
  if (tx.status !== 'POSTED') return { ok: false, error: 'INVALID_STATE', message: 'Chỉ bill đang hiệu lực mới tạo được yêu cầu hủy (đang chờ duyệt hoặc đã hủy).' };
  // [B323/SV1 24/11 — agent soát vùng, NẶNG] Twin-path của deleteTransactions (nút Xóa GD) đã có guard
  // B-M5 "GD đã thu công nợ thì không xoá" — đường DUYỆT HỦY thì KHÔNG, nên GD đã thu công nợ (tiền đã
  // vào quỹ) vẫn hủy được ⇒ phiếu THU + cashDebtSettlement MỒ CÔI, quỹ giữ tiền ảo, công nợ lệch câm.
  // Chặn tại cửa yêu cầu (và lặp ở bước duyệt chống TOCTOU).
  const soPhieuThu = await db.cashDebtSettlement.count({ where: { transactionId } });
  if (soPhieuThu > 0) return { ok: false, error: 'TXN_HAS_SETTLEMENT', message: `Bill ${tx.code ?? transactionId} đã có ${soPhieuThu} phiếu thu công nợ (tiền đã vào quỹ) — không hủy được. CÁCH SỬA: gỡ/hủy phiếu thu công nợ của bill này trước rồi mới gửi yêu cầu hủy.` };
  // CRITICAL-A: bọc chuyển-trạng-thái + tạo yêu cầu trong 1 interactive $transaction với conditional transition
  // (chống TOCTOU). 2 client cùng lúc → chỉ 1 chuyển POSTED→CANCEL_PENDING; client thua count===0 → INVALID_STATE.
  let req: { id: number };
  try {
    req = await db.$transaction(async (txc) => {
      const moved = await txc.transaction.updateMany({
        where: { id: transactionId, status: 'POSTED', deletedAt: null },
        data: { status: 'CANCEL_PENDING', updatedBy: user.id }
      });
      if (moved.count === 0) throw new TxGuardError('INVALID_STATE', 'Chỉ bill đang hiệu lực mới tạo được yêu cầu hủy (đang chờ duyệt hoặc đã hủy).');
      return txc.approvalRequest.create({ data: { entityType: 'Transaction', entityId: transactionId, action: 'CANCEL', reason: r, requestedBy: user.id } });
    });
  } catch (e) {
    if (e instanceof TxGuardError) return { ok: false, error: e.code, message: e.userMessage };
    throw e;
  }
  await writeAudit(db, { actorUserId: user.id, action: 'BILL_CANCEL_REQUESTED', targetType: 'Transaction', targetId: String(tx.id), after: auditSnapshot({ requestId: req.id, code: tx.code, reason: r }) });
  try {
    const recipients = await cancelApproverRecipients(db, user.id);
    await pushSystemNotice(db, recipients, 'BILL_CANCEL_REQUEST', `Yêu cầu hủy bill ${tx.code}`, `${user.fullName} đề nghị hủy bill ${tx.code}. Lý do: ${r}. Vào mục Duyệt hủy bill để xử lý.`);
  } catch {
    // Thông báo phụ trợ — không chặn việc tạo yêu cầu.
  }
  return { ok: true, id: req.id };
}

// ═════════════════════════════════════════════════════════════════════════════
// DUYỆT / TỪ CHỐI (single) — phân vai. Mật khẩu người duyệt do ADAPTER route verify TRƯỚC khi gọi lõi.
// ═════════════════════════════════════════════════════════════════════════════
type OneResult = { ok: true; id: number; message?: string } | { ok: false; error: string; message: string };

/** Lõi duyệt 1 yêu cầu (đã có db + approver). Áp phân vai, ghi audit cả nhánh từ chối chính sách. */
async function approveOne(db: Db, user: AuthUser, requestId: number, decisionNote?: string): Promise<OneResult> {
  const req = await db.approvalRequest.findUnique({ where: { id: requestId } });
  if (!req || req.action !== 'CANCEL' || req.entityType !== 'Transaction') return { ok: false, error: 'NOT_FOUND', message: 'Yêu cầu hủy không tồn tại.' };
  // Quyền người-yêu-cầu tính LÚC DUYỆT (đọc live) — Admin Demo 16/7 (P1-09), KHÔNG snapshot lúc tạo.
  const requesterPerms = await userPermSet(db, req.requestedBy);
  const requesterIsApprover = requesterPerms.has(APPROVE);
  const approverElevated = hasPermission(user, ELEVATED);
  const isSelf = user.id === req.requestedBy;
  let selfNote: string | null = null;

  if (isSelf) {
    // Admin Demo 13/7: ADMIN (elevated) ĐƯỢC tự duyệt yêu cầu của mình (chốt = mật khẩu khi duyệt ở route).
    if (approverElevated) selfNote = 'Admin tự duyệt (đã nhập mật khẩu)';
    else {
      await writeAudit(db, { actorUserId: user.id, action: 'BILL_CANCEL_APPROVED', targetType: 'ApprovalRequest', targetId: String(req.id), after: { denied: true, reason: 'SELF_APPROVAL_FORBIDDEN' } });
      return { ok: false, error: 'SELF_APPROVAL_FORBIDDEN', message: 'Chỉ Admin mới được tự duyệt yêu cầu của chính mình.' };
    }
  } else if (requesterIsApprover && !approverElevated) {
    await writeAudit(db, { actorUserId: user.id, action: 'BILL_CANCEL_APPROVED', targetType: 'ApprovalRequest', targetId: String(req.id), after: { denied: true, reason: 'NEED_ELEVATED', requestedBy: req.requestedBy } });
    return { ok: false, error: 'NEED_ELEVATED', message: 'Yêu cầu do Quản lý/Admin tạo — cần cấp Admin duyệt.' };
  }

  const tx = await db.transaction.findUnique({ where: { id: req.entityId } });
  if (!tx) return { ok: false, error: 'NOT_FOUND', message: 'Giao dịch gốc của yêu cầu này không còn trong hệ thống.' };
  // [25/11 incident GD04426 — Admin Demo] Bill đã bị HỦY/XÓA trước đó bằng THAO TÁC KHÁC (xóa bill trực tiếp / hủy
  // đường khác) sau khi đã gửi yêu cầu hủy ⇒ MỤC TIÊU của yêu cầu (hủy bill) ĐÃ ĐẠT. Trước đây báo "Bill không
  // tồn tại" (khó hiểu) + để yêu cầu TREO PENDING không duyệt/từ-chối được (vì bill không còn CANCEL_PENDING).
  // Nay: ĐÓNG yêu cầu cho gọn + báo RÕ bill đã hủy sẵn. KHÔNG hủy lại.
  if (tx.deletedAt != null || tx.status === 'CANCELLED') {
    const moved = await db.approvalRequest.updateMany({ where: { id: req.id, status: 'PENDING' }, data: { status: 'APPROVED', decidedBy: user.id, decidedAt: new Date(), decisionNote: 'Bill đã được hủy/xóa trước đó bằng thao tác khác — yêu cầu tự đóng.' } });
    if (moved.count === 0) return { ok: false, error: 'ALREADY_DECIDED', message: 'Yêu cầu đã được xử lý (không còn chờ duyệt).' };
    await writeAudit(db, { actorUserId: user.id, action: 'BILL_CANCEL_APPROVED', targetType: 'ApprovalRequest', targetId: String(req.id), after: auditSnapshot({ closedBecauseAlreadyCancelled: true, txId: tx.id, txStatus: tx.status }) });
    await bumpChangeToken(db, 'Transaction');
    return { ok: true, id: req.id, message: `Bill "${tx.code}" đã được hủy trước đó bằng thao tác khác — yêu cầu hủy này đã được ĐÓNG (không cần duyệt lại).` };
  }
  const note = [decisionNote?.trim() || null, selfNote].filter(Boolean).join(' · ') || null;
  const decidedAt = new Date();
  // CRITICAL-A: conditional transition trong 1 interactive $transaction (chống TOCTOU / duyệt 2 lần).
  try {
    await db.$transaction(async (txc) => {
      const reqMoved = await txc.approvalRequest.updateMany({ where: { id: req.id, status: 'PENDING' }, data: { status: 'APPROVED', decidedBy: user.id, decidedAt, decisionNote: note } });
      if (reqMoved.count === 0) throw new TxGuardError('ALREADY_DECIDED', 'Yêu cầu đã được xử lý (không còn chờ duyệt).');
      // [B323] re-check settlement TRONG tx duyệt (phiếu thu có thể vừa tạo giữa yêu cầu và duyệt).
      const phieuThuLuc = await txc.cashDebtSettlement.count({ where: { transactionId: tx.id } });
      if (phieuThuLuc > 0) throw new TxGuardError('TXN_HAS_SETTLEMENT', `Bill đã có ${phieuThuLuc} phiếu thu công nợ — gỡ phiếu thu trước rồi mới duyệt hủy. Yêu cầu hủy vẫn giữ nguyên.`);
      const billMoved = await txc.transaction.updateMany({ where: { id: tx.id, status: 'CANCEL_PENDING', deletedAt: null }, data: { status: 'CANCELLED', cancelledAt: decidedAt, cancelReason: req.reason, cancelRequestId: req.id, updatedBy: user.id } });
      if (billMoved.count === 0) throw new TxGuardError('INVALID_STATE', 'Bill không ở trạng thái chờ hủy (có thể đã đổi trạng thái).');
      // [B309/F1 24/11 — agent đào vét, CHẶN SHIP] HỦY CẢ LÔ đi kèm. Trước đây chỉ hủy GIAO DỊCH ⇒ màn
      // Doanh Số (đọc `los`, lọc status <> CANCELLED) giữ bill ZOMBIE 10tr vĩnh viễn trong khi báo cáo
      // NĐT/doanh thu (đọc transactions POSTED) đã rút — hai sổ lệch nhau đúng bằng tiền bill, và ghi lại
      // cùng khoá bill thì UPSERT trúng lô zombie gắn GD CANCELLED nên không bao giờ hồi. Hủy lô (giữ
      // bill_key) ⇒ nhập lại tự ra lô MỚI + GD mới đúng khuôn (UPSERT bỏ qua lô CANCELLED).
      await txc.$executeRawUnsafe(
        `UPDATE los SET status = 'CANCELLED', cancel_reason = $1, cancelled_at = now()
          WHERE transaction_id = $2 AND status <> 'CANCELLED'`,
        'Duyệt hủy bill (yêu cầu #' + req.id + ')', tx.id
      );
      // G1: audit NGHIÊM trong tx (tier-1 approval/hủy) → audit fail thì rollback cả việc hủy bill.
      await writeAuditStrict(txc, { actorUserId: user.id, action: 'BILL_CANCEL_APPROVED', targetType: 'Transaction', targetId: String(tx.id), before: auditSnapshot({ status: tx.status, revenueAmount: tx.revenueAmount }), after: auditSnapshot({ status: 'CANCELLED', requestId: req.id, note }) });
    });
  } catch (e) {
    if (e instanceof TxGuardError) return { ok: false, error: e.code, message: e.userMessage };
    throw e;
  }
  await bumpChangeToken(db, 'Transaction');
  try {
    await pushSystemNotice(db, [req.requestedBy], 'BILL_CANCEL_APPROVED', `Yêu cầu hủy bill ${tx.code} đã được DUYỆT`, `Yêu cầu hủy bill ${tx.code} của bạn đã được duyệt.${note ? ' Ghi chú: ' + note + '.' : ''}`);
  } catch {
    // Thông báo phụ trợ.
  }
  return { ok: true, id: req.id };
}

async function rejectOne(db: Db, user: AuthUser, requestId: number, decisionNote: string): Promise<OneResult> {
  const req = await db.approvalRequest.findUnique({ where: { id: requestId } });
  if (!req || req.action !== 'CANCEL' || req.entityType !== 'Transaction') return { ok: false, error: 'NOT_FOUND', message: 'Yêu cầu hủy không tồn tại.' };
  const note = (decisionNote ?? '').trim();
  if (!note) return { ok: false, error: 'VALIDATION', message: 'Vui lòng nhập lý do từ chối.' };
  const decidedAt = new Date();
  // CRITICAL-A: PENDING→REJECTED + HOÀN bill CANCEL_PENDING→POSTED trong 1 interactive $transaction (chống 2 lần).
  try {
    await db.$transaction(async (txc) => {
      const reqMoved = await txc.approvalRequest.updateMany({ where: { id: req.id, status: 'PENDING' }, data: { status: 'REJECTED', decidedBy: user.id, decidedAt, decisionNote: note } });
      if (reqMoved.count === 0) throw new TxGuardError('INVALID_STATE', 'Yêu cầu đã được xử lý.');
      // P0-04: HOÀN bill PHẢI count===1 (đối xứng approve) — lệch → rollback cả REJECTED (giữ PENDING).
      const billMoved = await txc.transaction.updateMany({ where: { id: req.entityId, status: 'CANCEL_PENDING' }, data: { status: 'POSTED', updatedBy: user.id } });
      if (billMoved.count !== 1) throw new TxGuardError('INVALID_STATE', 'Bill không còn ở trạng thái chờ hủy — không thể hoàn về đã ghi.');
      await writeAuditStrict(txc, { actorUserId: user.id, action: 'BILL_CANCEL_REJECTED', targetType: 'Transaction', targetId: String(req.entityId), after: auditSnapshot({ requestId: req.id, note }) });
    });
  } catch (e) {
    if (e instanceof TxGuardError) return { ok: false, error: e.code, message: e.userMessage };
    throw e;
  }
  await bumpChangeToken(db, 'Transaction');
  try {
    const txForNotice = await db.transaction.findUnique({ where: { id: req.entityId }, select: { code: true } });
    const code = txForNotice?.code ?? String(req.entityId);
    await pushSystemNotice(db, [req.requestedBy], 'BILL_CANCEL_REJECTED', `Yêu cầu hủy bill ${code} bị TỪ CHỐI`, `Yêu cầu hủy bill ${code} của bạn đã bị từ chối. Lý do: ${note}.`);
  } catch {
    // Thông báo phụ trợ.
  }
  return { ok: true, id: req.id };
}

/** DUYỆT hủy bill — mật khẩu người duyệt do ADAPTER route verify TRƯỚC (lõi KHÔNG kiểm password, khuôn customer.ts). */
export async function approveCancelBill(ctx: ServiceCtx, requestId: number, decisionNote?: string): Promise<MutationResult> {
  if (!hasPermission(ctx.user, APPROVE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const r = await approveOne(ctx.db, ctx.user, requestId, decisionNote);
  return r.ok ? { ok: true, id: r.id, message: r.message } : { ok: false, error: r.error, message: r.message };
}

export async function rejectCancelBill(ctx: ServiceCtx, requestId: number, decisionNote: string): Promise<MutationResult> {
  if (!hasPermission(ctx.user, APPROVE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const r = await rejectOne(ctx.db, ctx.user, requestId, decisionNote);
  return r.ok ? { ok: true, id: r.id } : { ok: false, error: r.error, message: r.message };
}

// ═════════════════════════════════════════════════════════════════════════════
// DUYỆT / TỪ CHỐI HÀNG LOẠT (§4.4b) — mỗi cái áp phân vai riêng; cái không được phép thì SKIP.
// ═════════════════════════════════════════════════════════════════════════════
export async function approveCancelBills(ctx: ServiceCtx, requestIds: number[], decisionNote?: string): Promise<BulkResult> {
  if (!hasPermission(ctx.user, APPROVE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE, done: 0, skipped: [] };
  if (!requestIds || requestIds.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn yêu cầu.', done: 0, skipped: [] };
  let done = 0;
  const skipped: BulkResult['skipped'] = [];
  for (const id of requestIds) {
    const r = await approveOne(ctx.db, ctx.user, id, decisionNote);
    if (r.ok) done++;
    else skipped.push({ id, reason: r.error, message: r.message });
  }
  return { ok: true, done, skipped };
}

export async function rejectCancelBills(ctx: ServiceCtx, requestIds: number[], decisionNote: string): Promise<BulkResult> {
  if (!hasPermission(ctx.user, APPROVE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE, done: 0, skipped: [] };
  if (!requestIds || requestIds.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn yêu cầu.', done: 0, skipped: [] };
  let done = 0;
  const skipped: BulkResult['skipped'] = [];
  for (const id of requestIds) {
    const r = await rejectOne(ctx.db, ctx.user, id, decisionNote);
    if (r.ok) done++;
    else skipped.push({ id, reason: r.error, message: r.message });
  }
  return { ok: true, done, skipped };
}

// ═════════════════════════════════════════════════════════════════════════════
// DANH SÁCH yêu cầu (cho UI Duyệt hủy) — lọc theo phân vai (canApprove).
// ═════════════════════════════════════════════════════════════════════════════
export interface CancelRequestDto {
  id: number;
  transactionId: number;
  billCode: string | null;
  amount: number;
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

export async function listCancelRequests(ctx: ServiceCtx, status = 'PENDING'): Promise<{ ok: boolean; error?: string; message?: string; data?: CancelRequestDto[] }> {
  if (!hasPermission(ctx.user, APPROVE)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const approverElevated = hasPermission(user, ELEVATED);
  const rows = await db.approvalRequest.findMany({ where: { entityType: 'Transaction', action: 'CANCEL', status }, orderBy: { requestedAt: 'desc' } });
  const txIds = [...new Set(rows.map((r) => r.entityId))];
  const txs = new Map((await db.transaction.findMany({ where: { id: { in: txIds } }, select: { id: true, code: true, amount: true } })).map((t) => [t.id, t]));
  const reqUserIds = [...new Set(rows.map((r) => r.requestedBy))];
  const nameIds = [...new Set([...reqUserIds, ...rows.map((r) => r.decidedBy).filter((x): x is number => x != null)])];
  const names = new Map((await db.user.findMany({ where: { id: { in: nameIds } }, select: { id: true, fullName: true, username: true } })).map((u) => [u.id, u.fullName || u.username]));
  // P2-01: nạp quyền requester 1 LẦN cho mỗi user PHÂN BIỆT (không N+1 theo từng phiếu).
  const approverMap = new Map<number, boolean>();
  for (const rid of reqUserIds) approverMap.set(rid, (await userPermSet(db, rid)).has(APPROVE));
  const data: CancelRequestDto[] = [];
  for (const r of rows) {
    const requesterIsApprover = approverMap.get(r.requestedBy) ?? false;
    const isSelf = user.id === r.requestedBy;
    let canApprove = true;
    if (isSelf) canApprove = approverElevated;
    else if (requesterIsApprover && !approverElevated) canApprove = false;
    const t = txs.get(r.entityId);
    data.push({
      id: r.id,
      transactionId: r.entityId,
      billCode: t?.code ?? null,
      amount: Number(t?.amount ?? 0),
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
