// Audit helper (IMS_SPEC §16). PORT từ apps/desktop/src/main/audit.ts (THUẦN, nhận db PARAM) — BỎ os.hostname()
// vì @sigma/services chạy CẢ trong API đa-client (deviceInfo/ip phải lấy từ request, truyền qua param, mặc định null).
// Mỗi thao tác quan trọng ghi 1 dòng. Best-effort: audit KHÔNG BAO GIỜ được làm hỏng thao tác nghiệp vụ → try/catch
// + console.error (KHÔNG nuốt im lặng theo R198: lỗi LUÔN hiện ra console phía server để chẩn đoán).
import './bigint-json.js'; // SIDE-EFFECT: dạy JSON.stringify serialize BigInt (cột tiền int8) — PHẢI trước mọi JSON.stringify audit
import type { Db } from '@sigma/database';
import type { AuditAction } from '@sigma/shared';

export interface AuditInput {
  actorUserId: number | null;
  action: AuditAction;
  targetType?: string | null;
  targetId?: string | null;
  before?: unknown;
  after?: unknown;
  /** IP thật của client (adapter truyền vào — desktop để null; API đọc X-Forwarded-For). */
  ip?: string | null;
  /** Nhãn thiết bị / User-Agent (adapter truyền vào — desktop để null). */
  deviceInfo?: string | null;
}

// Nhận CẢ Db đầy đủ LẪN client trong $transaction (chỉ cần .auditLog + .changeToken).
type AuditDb = Pick<Db, 'auditLog' | 'changeToken'>;

function auditData(input: AuditInput): Parameters<AuditDb['auditLog']['create']>[0]['data'] {
  return {
    actorUserId: input.actorUserId ?? undefined,
    action: input.action,
    targetType: input.targetType ?? undefined,
    targetId: input.targetId ?? undefined,
    beforeJson: input.before === undefined ? undefined : JSON.stringify(input.before),
    afterJson: input.after === undefined ? undefined : JSON.stringify(input.after),
    ipAddress: input.ip ?? undefined,
    deviceInfo: input.deviceInfo ?? undefined
  };
}

export async function writeAudit(db: AuditDb, input: AuditInput): Promise<void> {
  try {
    await db.auditLog.create({ data: auditData(input) });
    const domain = input.targetType ?? 'GLOBAL';
    await db.changeToken.upsert({ where: { domain }, create: { domain, version: 1 }, update: { version: { increment: 1 } } });
  } catch (err) {
    // Audit must never crash the operation; log to console for diagnosis (R198: KHÔNG nuốt im).
    // eslint-disable-next-line no-console
    console.error('[audit] failed to write', input.action, err);
  }
}

/**
 * G1 (PING) — AUDIT NGHIÊM (tier-1: tiền/kho/approval-hủy/khóa-user/đổi-quyền). PORT từ desktop audit.ts.
 * KHÔNG nuốt lỗi: ghi audit thất bại → NÉM → `$transaction` bao ngoài ROLLBACK cả mutation. Đảm bảo invariant
 * #5: không mutation quan trọng nào commit mà thiếu dấu vết audit. PHẢI gọi TRONG `$transaction` (txc); KHÔNG
 * bump changeToken ở đây (tách riêng best-effort — dùng bumpChangeToken sau commit). `SIGMA_AUDIT_FAULT=1` =
 * chốt fault-injection cho selftest (ép audit ném để chứng minh rollback).
 */
export async function writeAuditStrict(txc: AuditDb, input: AuditInput): Promise<void> {
  if (process.env['SIGMA_AUDIT_FAULT'] === '1') throw new Error('[audit] injected fault (SIGMA_AUDIT_FAULT=1)');
  await txc.auditLog.create({ data: auditData(input) }); // KHÔNG try/catch → lỗi lan ra → rollback tx
}

/**
 * Best-effort realtime "đồng hồ thay đổi" (R48 Pha 4). TÁCH khỏi audit: lỗi bump KHÔNG được làm rollback nghiệp
 * vụ. Gọi NGOÀI transaction nghiệp vụ (sau commit) để một lỗi realtime không đầu độc tx tiền/kho/approval.
 */
export async function bumpChangeToken(db: AuditDb, targetType?: string | null): Promise<void> {
  try {
    const domain = targetType ?? 'GLOBAL';
    await db.changeToken.upsert({ where: { domain }, create: { domain, version: 1 }, update: { version: { increment: 1 } } });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[changeToken] bump failed', targetType, err);
  }
}
