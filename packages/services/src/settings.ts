// Cấu hình hệ thống (AppSetting) — LÕI THUẦN ctx-based. PORT nghiệp vụ từ apps/desktop/src/main/settings-service.ts
// (IMS_SPEC §16 SETTING_UPDATED audit; §13 permission gates). Thay `requirePermission` bằng ctx = { db, user } do
// adapter dựng; mỗi hàm tự kiểm quyền qua hasPermission(ctx.user, SYSTEM_SETTING_*). Upsert key/value + audit
// before/after. GIỮ NGUYÊN message tiếng Việt.
import { hasPermission } from '@sigma/shared';
import { writeAudit } from './audit.js';
import type { ServiceCtx } from './customer.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

export interface SettingDto {
  key: string;
  value: string | null;
}

/** SYSTEM_SETTING_VIEW — liệt kê toàn bộ cấu hình (key/value), sắp theo key. */
export async function listSettings(
  ctx: ServiceCtx
): Promise<{ ok: boolean; data?: SettingDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'SYSTEM_SETTING_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const rows = await ctx.db.appSetting.findMany({ orderBy: { key: 'asc' } });
  return { ok: true, data: rows.map((r) => ({ key: r.key, value: r.value })) };
}

/** SYSTEM_SETTING_UPDATE — upsert 1 cấu hình theo key + audit SETTING_UPDATED (before/after). */
export async function updateSetting(
  ctx: ServiceCtx,
  key: string,
  value: string
): Promise<{ ok: boolean; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'SYSTEM_SETTING_UPDATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const before = await db.appSetting.findUnique({ where: { key } });
  await db.appSetting.upsert({
    where: { key },
    update: { value },
    create: { key, value }
  });
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'SETTING_UPDATED',
    targetType: 'System',
    targetId: key,
    before: before ? { key, value: before.value } : null,
    after: { key, value }
  });
  return { ok: true };
}
