// Storage-Guard — LÕI THUẦN ctx-based (SERVER-OPS). PORT phần CHẠY ĐƯỢC SERVER-SIDE từ
// apps/desktop/src/main/storage-service.ts (Nhóm E). Đo dung lượng DB + ổ đĩa MÁY CHỦ, dọn dẹp an toàn
// (LUÔN backup trước khi xóa), cập nhật cấu hình bảo trì. Thay requirePermission(current-user global) bằng
// ctx = { db, user } do adapter (route API) dựng; mỗi hàm tự kiểm quyền qua hasPermission(ctx.user, ...).
//
// KHÁC desktop (GHI RÕ):
//  • BỎ gate isServerRole() ở diskInfo — quanly-api LUÔN chạy TRÊN MÁY CHỦ (nơi đặt Postgres), nên statfs
//    vào data_directory luôn hợp lệ (không còn cảnh báo ổ đầy vô nghĩa của máy trạm). Máy trạm giờ gọi API,
//    không tự statfs.
//  • Xác thực MẬT KHẨU thao tác (dọn dẹp) do ADAPTER kiểm TRƯỚC khi gọi lõi (khuôn customer.ts): lõi KHÔNG
//    nhận password.
//  • KHÔNG port scheduler (systemBackupIfDue/backupWatchdog/systemStorageCheck/weeklyMaintenance +
//    reportBackupFailure) — đó là tiến trình NỀN, giữ ở tiến-trình-nền/desktop, KHÔNG expose route.
import { statfsSync } from 'node:fs';
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { systemBackup } from './backup.js';
import type { ServiceCtx } from './customer.js';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

const K = {
  thresholdPct: 'storage.thresholdPct',
  auditRetentionDays: 'storage.auditRetentionDays',
  trashRetentionDays: 'storage.trashRetentionDays',
  backupIntervalHours: 'backup.intervalHours',
  lastBackupAt: 'backup.lastAt',
  lastAlertAt: 'storage.lastAlertAt',
  maintenanceEnabled: 'maintenance.enabled', // '1' bật / '0' tắt tự động
  maintenanceDayOfWeek: 'maintenance.dayOfWeek', // 0=Chủ nhật … 6=Thứ bảy
  maintenanceHour: 'maintenance.hour', // 0..23
  autoPurgeWeekly: 'maintenance.autoPurge', // '1' = tự dọn dữ liệu quá hạn khi bảo trì tuần
  lastMaintenanceAt: 'maintenance.lastAt'
} as const;

const DEFAULTS = {
  thresholdPct: 80,
  auditRetentionDays: 180,
  trashRetentionDays: 90,
  backupIntervalHours: 24,
  maintenanceDayOfWeek: 0, // Chủ nhật
  maintenanceHour: 2 // 02:00
};

// SÀN AN TOÀN (audit Nhóm E): chống retention=0/rỗng xóa sạch dữ liệu vừa tạo. Đọc & ghi đều kẹp.
const MIN_AUDIT_DAYS = 7;
const MIN_TRASH_DAYS = 1;
const MIN_BACKUP_HOURS = 1;

async function getNum(db: Db, key: string, def: number): Promise<number> {
  const row = await db.appSetting.findUnique({ where: { key } });
  const n = row?.value != null ? Number(row.value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : def;
}
async function getStr(db: Db, key: string): Promise<string | null> {
  const row = await db.appSetting.findUnique({ where: { key } });
  return row?.value ?? null;
}
async function setStr(db: Db, key: string, value: string): Promise<void> {
  await db.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
}
// Retention/interval ĐÃ KẸP SÀN — dùng ở MỌI nơi tính cutoff/purge để 0/rỗng không xóa sạch.
const auditRetention = async (db: Db): Promise<number> => Math.max(MIN_AUDIT_DAYS, await getNum(db, K.auditRetentionDays, DEFAULTS.auditRetentionDays));
const trashRetention = async (db: Db): Promise<number> => Math.max(MIN_TRASH_DAYS, await getNum(db, K.trashRetentionDays, DEFAULTS.trashRetentionDays));
const backupInterval = async (db: Db): Promise<number> => Math.max(MIN_BACKUP_HOURS, await getNum(db, K.backupIntervalHours, DEFAULTS.backupIntervalHours));

/** Tổng dung lượng DB PostgreSQL (bytes) qua pg_database_size(). */
async function dbBytes(db: Db): Promise<number> {
  const rows = await db.$queryRawUnsafe<Array<{ size: bigint | number | string }>>(
    'SELECT pg_database_size(current_database()) AS size'
  );
  const raw = rows?.[0]?.size ?? 0;
  const n = typeof raw === 'bigint' ? Number(raw) : Number(raw);
  return Number.isFinite(n) ? n : 0;
}

/** Thư mục dữ liệu của máy chủ PostgreSQL (dùng làm nhãn + để đo ổ đĩa trên máy chủ). */
async function pgDataDirectory(db: Db): Promise<string | null> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ data_directory: string }>>('SHOW data_directory');
    return rows?.[0]?.data_directory ?? null;
  } catch {
    return null;
  }
}

/**
 * Dung lượng ổ đĩa chứa DB. quanly-api LUÔN chạy TRÊN MÁY CHỦ (cùng máy Postgres) → statfs vào data_directory
 * cho số thật. KHÁC desktop: BỎ gate isServerRole() (không còn nhánh máy-trạm-đo-nhầm; máy trạm nay gọi API,
 * không tự statfs). Nếu SHOW data_directory không trả (VD Postgres remote khác máy) → trả null (thành thật
 * "không đo được", KHÔNG báo bừa).
 */
async function diskInfo(db: Db): Promise<{ total: number; free: number } | null> {
  const dir = await pgDataDirectory(db);
  if (!dir) return null;
  try {
    const s = statfsSync(dir);
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    if (total > 0) return { total, free };
    return null;
  } catch {
    return null;
  }
}

export interface StorageStatus {
  dbBytes: number;
  dbPath: string;
  diskTotalBytes: number | null;
  diskFreeBytes: number | null;
  diskUsedPct: number | null; // % ổ đĩa đã dùng
  thresholdPct: number;
  over: boolean; // đã vượt ngưỡng chưa
  lastBackupAt: string | null;
  lastAlertAt: string | null;
  lastMaintenanceAt: string | null;
  backupIntervalHours: number;
  maintenanceEnabled: boolean;
  maintenanceDayOfWeek: number; // 0=CN..6=T7
  maintenanceHour: number; // 0..23
  autoPurgeWeekly: boolean;
  cleanable: {
    auditOld: number; // số dòng nhật ký cũ hơn hạn lưu
    trashOld: number; // số bản ghi trong thùng rác cũ hơn hạn lưu
    auditRetentionDays: number;
    trashRetentionDays: number;
  };
}

/** Danh sách thực thể có thùng rác (khớp trash-service) để dọn bản ghi cũ. */
type Purger = { deleteMany: (a: { where: { deletedAt: { lt: Date } } }) => Promise<{ count: number }>; count: (a: { where: { deletedAt: { lt: Date } } }) => Promise<number> };
function trashModels(db: Db): Purger[] {
  const d = db as unknown as Record<string, Purger>;
  return [
    d.customer, d.agent, d.bank, d.cardType, d.partner, d.supplier, d.posModel, d.posIntakeStatus,
    d.posIntake, d.feeType, d.feeRate, d.feeSellQuote, d.receiveAccountSource, d.receiveAccount, d.dossierSource,
    d.dossier, d.tidConfigStatus, d.tid, d.transaction
  ];
}

async function computeStatus(db: Db): Promise<StorageStatus> {
  const thresholdPct = await getNum(db, K.thresholdPct, DEFAULTS.thresholdPct);
  const auditRetentionDays = await auditRetention(db);
  const trashRetentionDays = await trashRetention(db);
  const backupIntervalHours = await backupInterval(db);
  const disk = await diskInfo(db);
  const diskUsedPct = disk ? Math.round(((disk.total - disk.free) / disk.total) * 1000) / 10 : null;

  const auditCutoff = new Date(Date.now() - auditRetentionDays * 86400_000);
  const trashCutoff = new Date(Date.now() - trashRetentionDays * 86400_000);
  const auditOld = await db.auditLog.count({ where: { createdAt: { lt: auditCutoff } } });
  let trashOld = 0;
  for (const m of trashModels(db)) {
    try { trashOld += await m.count({ where: { deletedAt: { lt: trashCutoff } } }); } catch { /* model thiếu deletedAt → bỏ */ }
  }

  return {
    dbBytes: await dbBytes(db),
    dbPath: (await pgDataDirectory(db)) ?? 'postgresql',
    diskTotalBytes: disk?.total ?? null,
    diskFreeBytes: disk?.free ?? null,
    diskUsedPct,
    thresholdPct,
    over: diskUsedPct != null && diskUsedPct >= thresholdPct,
    lastBackupAt: await getStr(db, K.lastBackupAt),
    lastAlertAt: await getStr(db, K.lastAlertAt),
    lastMaintenanceAt: await getStr(db, K.lastMaintenanceAt),
    backupIntervalHours,
    maintenanceEnabled: (await getStr(db, K.maintenanceEnabled)) !== '0', // mặc định bật
    maintenanceDayOfWeek: await getNum(db, K.maintenanceDayOfWeek, DEFAULTS.maintenanceDayOfWeek),
    maintenanceHour: await getNum(db, K.maintenanceHour, DEFAULTS.maintenanceHour),
    autoPurgeWeekly: (await getStr(db, K.autoPurgeWeekly)) !== '0', // mặc định bật
    cleanable: { auditOld, trashOld, auditRetentionDays, trashRetentionDays }
  };
}

/** STORAGE_VIEW — tình trạng bộ nhớ cho UI (bảng bảo trì + dialog cảnh báo). */
export async function getStorageStatus(ctx: ServiceCtx): Promise<{ ok: boolean; data?: StorageStatus; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'STORAGE_VIEW')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  return { ok: true, data: await computeStatus(ctx.db) };
}

export interface CleanupOptions {
  clearHistory?: boolean; // xóa nhật ký cũ hơn hạn lưu
  purgeTrash?: boolean; // xóa vĩnh viễn bản ghi thùng rác cũ hơn hạn lưu
}

/**
 * STORAGE_CLEANUP — dọn dẹp AN TOÀN. Trình tự bắt buộc: (adapter đã xác thực mật khẩu) → BACKUP → xóa.
 * Chỉ xóa dữ liệu CŨ HƠN hạn lưu (audit/thùng rác), không đụng dữ liệu trong hạn. Xác thực MẬT KHẨU thao tác
 * do ADAPTER kiểm TRƯỚC (khuôn customer.ts) — lõi KHÔNG nhận password.
 */
export async function runCleanup(ctx: ServiceCtx, opts: CleanupOptions): Promise<{ ok: boolean; error?: string; message?: string; backupFile?: string; auditDeleted?: number; trashDeleted?: number }> {
  if (!hasPermission(ctx.user, 'STORAGE_CLEANUP')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!opts.clearHistory && !opts.purgeTrash) return { ok: false, error: 'NOTHING_SELECTED', message: 'Hãy chọn ít nhất một mục để dọn dẹp.' };

  // R_SAFE_CLEANUP: LUÔN backup trước khi xóa để đảm bảo dữ liệu luôn khôi phục được.
  const bk = await systemBackup(db, 'pre-cleanup snapshot (Storage-Guard)');
  if (!bk.ok) return { ok: false, error: 'BACKUP_FAILED', message: `Không tạo được backup an toàn trước khi dọn — HỦY dọn dẹp: ${bk.error}` };

  const auditRetentionDays = await auditRetention(db);
  const trashRetentionDays = await trashRetention(db);
  let auditDeleted = 0;
  let trashDeleted = 0;

  if (opts.clearHistory) {
    const cutoff = new Date(Date.now() - auditRetentionDays * 86400_000);
    const r = await db.auditLog.deleteMany({ where: { createdAt: { lt: cutoff } } });
    auditDeleted = r.count;
  }
  if (opts.purgeTrash) {
    const cutoff = new Date(Date.now() - trashRetentionDays * 86400_000);
    for (const m of trashModels(db)) {
      try { trashDeleted += (await m.deleteMany({ where: { deletedAt: { lt: cutoff } } })).count; } catch { /* bỏ model thiếu cột */ }
    }
  }

  await writeAudit(db, {
    actorUserId: user.id,
    action: 'STORAGE_CLEANUP',
    targetType: 'System',
    after: { backupFile: bk.filePath, auditDeleted, trashDeleted, auditRetentionDays, trashRetentionDays }
  });
  return { ok: true, backupFile: bk.filePath, auditDeleted, trashDeleted };
}

/** STORAGE_CLEANUP — cập nhật cấu hình bảo trì (ngưỡng/hạn lưu/chu kỳ/lịch). */
export async function updateStorageConfig(ctx: ServiceCtx, cfg: {
  thresholdPct?: number;
  auditRetentionDays?: number;
  trashRetentionDays?: number;
  backupIntervalHours?: number;
  maintenanceDayOfWeek?: number;
  maintenanceHour?: number;
  maintenanceEnabled?: boolean;
  autoPurgeWeekly?: boolean;
}): Promise<{ ok: boolean; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'STORAGE_CLEANUP')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  const pairs: [string, number | undefined][] = [
    [K.thresholdPct, cfg.thresholdPct],
    [K.auditRetentionDays, cfg.auditRetentionDays],
    [K.trashRetentionDays, cfg.trashRetentionDays],
    [K.backupIntervalHours, cfg.backupIntervalHours],
    [K.maintenanceDayOfWeek, cfg.maintenanceDayOfWeek],
    [K.maintenanceHour, cfg.maintenanceHour]
  ];
  for (const [key, val] of pairs) {
    if (val === undefined) continue;
    if (!Number.isFinite(val) || val < 0) return { ok: false, error: 'VALIDATION', message: 'Giá trị cấu hình phải là số ≥ 0.' };
    if (key === K.thresholdPct && (val < 1 || val > 100)) return { ok: false, error: 'VALIDATION', message: 'Ngưỡng cảnh báo phải trong khoảng 1–100%.' };
    if (key === K.maintenanceDayOfWeek && val > 6) return { ok: false, error: 'VALIDATION', message: 'Thứ trong tuần phải từ 0 (Chủ nhật) đến 6 (Thứ bảy).' };
    if (key === K.maintenanceHour && val > 23) return { ok: false, error: 'VALIDATION', message: 'Giờ phải từ 0 đến 23.' };
    // Sàn an toàn chống xóa sạch: hạn lưu nhật ký ≥ 7 ngày, thùng rác ≥ 1 ngày, chu kỳ backup ≥ 1 giờ.
    if (key === K.auditRetentionDays && val < MIN_AUDIT_DAYS) return { ok: false, error: 'VALIDATION', message: `Hạn lưu nhật ký tối thiểu ${MIN_AUDIT_DAYS} ngày (chống xóa nhầm dữ liệu).` };
    if (key === K.trashRetentionDays && val < MIN_TRASH_DAYS) return { ok: false, error: 'VALIDATION', message: `Hạn lưu thùng rác tối thiểu ${MIN_TRASH_DAYS} ngày.` };
    if (key === K.backupIntervalHours && val < MIN_BACKUP_HOURS) return { ok: false, error: 'VALIDATION', message: `Chu kỳ backup tối thiểu ${MIN_BACKUP_HOURS} giờ.` };
    await setStr(db, key, String(val));
  }
  if (cfg.maintenanceEnabled !== undefined) await setStr(db, K.maintenanceEnabled, cfg.maintenanceEnabled ? '1' : '0');
  if (cfg.autoPurgeWeekly !== undefined) await setStr(db, K.autoPurgeWeekly, cfg.autoPurgeWeekly ? '1' : '0');
  await writeAudit(db, { actorUserId: user.id, action: 'SETTING_UPDATED', targetType: 'System', targetId: 'storage.config', after: cfg });
  return { ok: true };
}
