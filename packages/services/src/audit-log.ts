// Nhật ký kiểm toán — LÕI THUẦN ctx-based (CHỈ ĐỌC). PORT từ apps/desktop/src/main/audit-service.ts (IMS_SPEC §16,
// R_AUDIT_001/004). UI chỉ đọc (không có endpoint xóa — R_AUDIT_001). Thay requirePermission bằng ctx = { db, user };
// tự kiểm quyền AUDIT_LOG_VIEW. Tên file `audit-log.ts` để tránh trùng `audit.ts` (helper writeAudit).
import { hasPermission } from '@sigma/shared';
import type { ServiceCtx } from './customer.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật trên sổ thật: ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

export interface AuditRowDto {
  id: number;
  actorUserId: number | null;
  actorUsername: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  beforeJson: string | null;
  afterJson: string | null;
  ipAddress: string | null;
  deviceInfo: string | null;
  createdAt: string;
}

export interface AuditQuery {
  action?: string;
  search?: string;
  limit?: number;
}

/** AUDIT_LOG_VIEW — liệt kê nhật ký (mới nhất trước), lọc theo action/tìm kiếm, giới hạn ≤1000. */
export async function listAudit(
  ctx: ServiceCtx,
  query: AuditQuery = {}
): Promise<{ ok: boolean; data?: AuditRowDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'AUDIT_LOG_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const rows = await ctx.db.auditLog.findMany({
    where: {
      action: query.action ? query.action : undefined,
      // Tìm kiếm hành động/đối tượng — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts).
      AND: await dieuKienTimKiem(ctx.db, 'audit_logs', { action: 'action', targetType: 'target_type', targetId: 'target_id' }, query.search)
    },
    orderBy: { id: 'desc' },
    take: Math.min(query.limit ?? 200, 1000),
    include: { actor: { select: { username: true } } }
  });
  const data: AuditRowDto[] = rows.map((r) => ({
    id: r.id,
    actorUserId: r.actorUserId,
    actorUsername: r.actor?.username ?? null,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    beforeJson: r.beforeJson,
    afterJson: r.afterJson,
    ipAddress: r.ipAddress,
    deviceInfo: r.deviceInfo,
    createdAt: r.createdAt.toISOString()
  }));
  return { ok: true, data };
}
