// AUDIT-VÁ #5 (MEDIUM) — ghi audit LOGIN_SUCCESS / LOGIN_FAILED (+ USER_AUTO_LOCKED/USER_AUTO_UNLOCKED khi
// tự khóa/mở). writeAudit của desktop (apps/desktop/src/main/audit.ts) phụ thuộc os.hostname()/deviceInfo cục
// bộ máy — ở API nhiều client nên IP/user-agent phải lấy TỪ REQUEST (X-Forwarded-For qua Cloudflare + UA).
// Vì thế viết insert AuditLog trực tiếp qua Prisma CÙNG SHAPE bảng audit_logs (actorUserId/action/targetType/
// targetId/beforeJson/afterJson/ipAddress/deviceInfo) thay vì gọi writeAudit Electron.
//
// Best-effort: audit KHÔNG BAO GIỜ được làm hỏng luồng đăng nhập → try/catch + console.error (KHÔNG nuốt im,
// R198: lỗi LUÔN hiện ra console phía server để chẩn đoán).
import type { Db } from '@sigma/database';
import type { AuditAction } from '@sigma/shared';

export interface ApiAuditInput {
  actorUserId: number | null;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  after?: unknown;
  /** IP thật của client (req.ip — đã đọc X-Forwarded-For nhờ `trust proxy` set ở index.ts). */
  ip?: string | null;
  /** User-Agent của client (nhãn thiết bị — có thể giả mạo, chỉ để tra vết). */
  userAgent?: string | null;
}

export async function writeAudit(db: Db, input: ApiAuditInput): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        actorUserId: input.actorUserId ?? undefined,
        action: input.action,
        targetType: input.targetType ?? undefined,
        targetId: input.targetId ?? undefined,
        afterJson: input.after === undefined ? undefined : JSON.stringify(input.after),
        ipAddress: input.ip ?? undefined,
        deviceInfo: input.userAgent ?? undefined
      }
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[quanly-api audit] ghi audit thất bại', input.action, err);
  }
}
