// Backup service — LÕI THUẦN ctx-based (SERVER-OPS). PORT phần CHẠY ĐƯỢC SERVER-SIDE từ
// apps/desktop/src/main/backup-service.ts (IMS_SPEC §17, G10 PostgreSQL). Server TỰ pg_dump vào ổ máy chủ.
// Thay requirePermission(current-user global) bằng ctx = { db, user }; tự kiểm quyền qua hasPermission.
//
// MIGRATE: createBackup (pg_dump custom format → zip + manifest + checksum) + listBackups + mirrorConfigGet/Set.
// KHÔNG MIGRATE (giữ IPC ở desktop): restoreBackup (nhận file từ ĐĨA CLIENT, cần chọn file local + pg_restore
// vào DB thật — hành động phá hủy, giữ tay ở máy chủ), futureSyncService (no-op G1).
//
// KHÁC desktop (GHI RÕ):
//  • BỎ gate isServerRole() — quanly-api LUÔN chạy TRÊN MÁY CHỦ (nơi cài PostgreSQL/pg_dump). Fail-closed
//    "BACKUP_SERVER_ONLY" của desktop không còn cần (không có nhánh máy trạm).
//  • app.getPath('userData')/cwd (Electron) → THAY bằng hằng số/env máy chủ: process.env.SIGMA_BACKUP_DIR
//    || '<BACKUP_DIR>' (TENTATIVE — chờ Admin Demo chốt thư mục sao lưu trên máy chủ 127.0.0.1).
//  • resolveDatabaseUrl() (Electron db.ts) → process.env.SIGMA_DB_URL || process.env.DATABASE_URL (chuỗi
//    kết nối Postgres của quanly-api).
//  • Xác thực MẬT KHẨU (đổi cấu hình mirror) do ADAPTER kiểm TRƯỚC (khuôn customer.ts) — lõi KHÔNG nhận password.
//  • zipStore + crc32 nhúng SẴN trong file (dependency-free, chỉ cần cho create) thay vì import desktop zip.ts.
//  • notifyAdmins nhúng riêng (best-effort) — @sigma/services/message.ts KHÔNG export helper này.
// NGUYÊN TẮC (CRITICAL-B): KHÔNG chết-lặng. pg_dump thiếu/lỗi → trả lỗi rõ ràng tiếng Việt.
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, copyFileSync, statSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
import { sha256Hex, buildBackupManifest, backupFileName } from '@sigma/business-rules';
import { hasPermission } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import type { ServiceCtx, MutationResult } from './customer.js';

const MANIFEST_NAME = 'backup_manifest.json';
const DUMP_ENTRY = 'glb.dump';

// ── R48 Pha 5 — Sao lưu TẦNG 2 (nhân bản ra nơi khác: ổ ngoài/NAS) ──
const BACKUP_MIRROR_DIR_KEY = 'backup.mirrorDir';
const BACKUP_MIRROR_KEEP_KEY = 'backup.mirrorKeep';
const BACKUP_MIRROR_KEEP_DEFAULT = 30;
const BACKUP_FILE_SUFFIX = '_ims_backup.zip'; // theo backupFileName() §17

export interface BackupMirrorConfig {
  mirrorDir: string | null;
  keep: number;
  lastMirrorAt: string | null;
  lastMirrorOk: boolean | null;
  lastMirrorError: string | null;
}

/** Kết quả createBackup — MutationResult (customer) KHÔNG có filePath nên khai riêng (đường dẫn file .zip vừa tạo). */
export interface BackupResult {
  ok: boolean;
  error?: string;
  message?: string;
  filePath?: string;
}

export interface BackupDto {
  id: number;
  filePath: string;
  fileName: string;
  fileSize: number | null;
  checksum: string | null;
  createdBy: number | null;
  createdAt: string;
  note: string | null;
  exists: boolean;
}

interface PgConn {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
}

/** Chuỗi kết nối Postgres của quanly-api (TENTATIVE: SIGMA_DB_URL để selftest trỏ DB throwaway). */
function resolveDatabaseUrl(): string {
  const url = process.env['SIGMA_DB_URL'] || process.env['DATABASE_URL'];
  if (!url) throw new Error('Thiếu DATABASE_URL cho quanly-api — không xác định được cơ sở dữ liệu để sao lưu.');
  return url;
}

/** Phân rã postgresql:// → tham số kết nối (URL-decode user/password). */
function pgConn(): PgConn {
  const u = new URL(resolveDatabaseUrl());
  if (u.protocol !== 'postgresql:' && u.protocol !== 'postgres:') {
    throw new Error(`Chuỗi kết nối không phải PostgreSQL: ${u.protocol}`);
  }
  return {
    host: u.hostname || 'localhost',
    port: u.port || '5432',
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '')
  };
}

/** Định vị binary pg_dump/pg_restore: env SIGMA_PG_BIN → cài đặt mặc định máy chủ → PATH. */
function pgToolPath(tool: 'pg_dump' | 'pg_restore'): string {
  const exe = process.platform === 'win32' ? `${tool}.exe` : tool;
  const override = process.env['SIGMA_PG_BIN'];
  const candidates: string[] = [];
  if (override) candidates.push(join(override, exe));
  candidates.push(join('<PG_BIN>/pgsql/bin', exe));
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return exe; // fallback: dựa vào PATH (spawnSync sẽ báo lỗi rõ nếu không thấy)
}

/** Thư mục lưu backup TRÊN MÁY CHỦ. TENTATIVE: env SIGMA_BACKUP_DIR || '<BACKUP_DIR>' (chờ Admin Demo chốt). */
export function backupsDir(): string {
  const dir = process.env['SIGMA_BACKUP_DIR'] || '<BACKUP_DIR>';
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

// ── zipStore (STORE, không nén) nhúng sẵn — chỉ cần cho createBackup (restore KHÔNG migrate) ──
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
interface ZipEntry { name: string; data: Buffer; }
function zipStore(entries: ZipEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const crc = crc32(e.data);
    const size = e.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, e.data);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);
    cd.writeUInt16LE(0, 12);
    cd.writeUInt16LE(0, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(size, 20);
    cd.writeUInt32LE(size, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);
    cd.writeUInt16LE(0, 32);
    cd.writeUInt16LE(0, 34);
    cd.writeUInt16LE(0, 36);
    cd.writeUInt32LE(0, 38);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBuf);
    offset += local.length + nameBuf.length + e.data.length;
  }
  const centralBuf = Buffer.concat(central);
  const centralOffset = offset;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuf, eocd]);
}

/**
 * Gửi thông báo hệ thống tới MỌI quản trị (user ACTIVE có quyền AUDIT_LOG_VIEW). Best-effort, KHÔNG ném lỗi ra
 * ngoài (không được làm hỏng luồng backup gốc). Nhúng riêng vì @sigma/services/message.ts không export helper này.
 */
async function notifyAdmins(db: Db, input: { category: string; subject: string; body: string }): Promise<number> {
  try {
    const admins = await db.user.findMany({
      where: {
        deletedAt: null,
        status: 'ACTIVE',
        roles: { some: { role: { status: 'ACTIVE', permissions: { some: { permission: { code: 'AUDIT_LOG_VIEW' } } } } } }
      },
      select: { id: true }
    });
    if (admins.length === 0) return 0;
    await db.message.createMany({
      data: admins.map((a) => ({ kind: 'SYSTEM', category: input.category, subject: input.subject, body: input.body, senderId: null, recipientId: a.id }))
    });
    return admins.length;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[backup] notifyAdmins failed', err);
    return 0;
  }
}

/** Đọc đường dẫn mirror + số bản giữ (best-effort; lỗi DB → coi như tắt). */
async function readMirrorSettings(db: Db): Promise<{ dir: string | null; keep: number }> {
  try {
    const [d, k] = await Promise.all([
      db.appSetting.findUnique({ where: { key: BACKUP_MIRROR_DIR_KEY } }),
      db.appSetting.findUnique({ where: { key: BACKUP_MIRROR_KEEP_KEY } })
    ]);
    const dir = d?.value?.trim() ? d.value.trim() : null;
    const keepNum = Number(k?.value);
    const keep = Number.isInteger(keepNum) && keepNum > 0 ? keepNum : BACKUP_MIRROR_KEEP_DEFAULT;
    return { dir, keep };
  } catch {
    return { dir: null, keep: BACKUP_MIRROR_KEEP_DEFAULT };
  }
}

/** Giữ `keep` bản .zip mới nhất trong thư mục mirror (tên theo timestamp → sort chuỗi = theo thời gian). Best-effort. */
function rotateMirror(dir: string, keep: number): number {
  let removed = 0;
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith(BACKUP_FILE_SUFFIX)).sort(); // cũ → mới
    const excess = files.length - keep;
    for (let i = 0; i < excess; i++) {
      try { unlinkSync(join(dir, files[i])); removed++; } catch { /* bỏ qua 1 file lỗi, tiếp tục */ }
    }
  } catch { /* thư mục không đọc được — bỏ qua, đã báo ở copy */ }
  return removed;
}

/** Ghi trạng thái mirror lần cuối vào AppSetting (best-effort). */
async function setMirrorStatus(db: Db, s: { at: string; ok: boolean; error: string | null }): Promise<void> {
  const put = async (key: string, value: string): Promise<void> => {
    await db.appSetting.upsert({ where: { key }, update: { value }, create: { key, value } });
  };
  await put('backup.lastMirrorAt', s.at);
  await put('backup.lastMirrorOk', s.ok ? '1' : '0');
  await put('backup.lastMirrorError', s.error ?? '');
}

/**
 * R48 Pha 5 — nhân bản 1 archive sang thư mục mirror (nếu đã cấu hình). KHÔNG NÉM: mirror lỗi KHÔNG được làm
 * hỏng backup gốc. Ghi audit BACKUP_MIRRORED / BACKUP_MIRROR_FAILED + báo Admin khi lỗi.
 */
async function mirrorArchive(db: Db, filePath: string): Promise<{ mirrored: boolean; error?: string }> {
  const { dir, keep } = await readMirrorSettings(db);
  if (!dir) return { mirrored: false }; // mirror tắt — không phải lỗi
  const stamp = new Date().toISOString();
  try {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const dest = join(dir, basename(filePath));
    copyFileSync(filePath, dest);
    // Verify: bản sao phải cùng kích thước với gốc (chống copy cụt do đầy ổ/rút USB giữa chừng).
    const srcSize = statSync(filePath).size;
    const dstSize = statSync(dest).size;
    if (srcSize !== dstSize) throw new Error(`Kích thước bản nhân lệch (${dstSize}≠${srcSize} bytes) — nghi copy cụt.`);
    const removed = rotateMirror(dir, keep);
    await setMirrorStatus(db, { at: stamp, ok: true, error: null });
    await writeAudit(db, {
      actorUserId: null, action: 'BACKUP_MIRRORED', targetType: 'System', targetId: basename(filePath),
      after: { mirrorDir: dir, size: dstSize, rotatedRemoved: removed }
    });
    return { mirrored: true };
  } catch (err) {
    const msg = (err as Error).message;
    try {
      await setMirrorStatus(db, { at: stamp, ok: false, error: msg });
      await writeAudit(db, {
        actorUserId: null, action: 'BACKUP_MIRROR_FAILED', targetType: 'System', targetId: basename(filePath),
        after: { mirrorDir: dir, error: msg }
      });
      await notifyAdmins(db, {
        category: 'BACKUP_MIRROR_FAILED',
        subject: 'Nhân bản sao lưu (tầng 2) THẤT BẠI',
        body: `Không nhân được bản sao lưu "${basename(filePath)}" ra "${dir}": ${msg}. Kiểm tra ổ/đường dẫn mirror — dữ liệu vẫn còn bản gốc trên máy.`
      });
    } catch { /* audit/notify best-effort */ }
    return { mirrored: false, error: msg };
  }
}

/** BACKUP_CREATE — đọc cấu hình + trạng thái mirror (cho UI). */
export async function getBackupMirrorConfig(ctx: ServiceCtx): Promise<{ ok: boolean; data?: BackupMirrorConfig; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'BACKUP_CREATE')) return { ok: false, error: 'FORBIDDEN', message: 'Bạn không có quyền thực hiện thao tác này.' };
  const { db } = ctx;
  const { dir, keep } = await readMirrorSettings(db);
  const [at, okv, errv] = await Promise.all([
    db.appSetting.findUnique({ where: { key: 'backup.lastMirrorAt' } }),
    db.appSetting.findUnique({ where: { key: 'backup.lastMirrorOk' } }),
    db.appSetting.findUnique({ where: { key: 'backup.lastMirrorError' } })
  ]);
  return {
    ok: true,
    data: {
      mirrorDir: dir, keep,
      lastMirrorAt: at?.value || null,
      lastMirrorOk: okv?.value == null || okv.value === '' ? null : okv.value === '1',
      lastMirrorError: errv?.value ? errv.value : null
    }
  };
}

/**
 * BACKUP_RESTORE — đặt thư mục mirror + số bản giữ. Đổi cấu hình sao lưu = việc PRIVILEGED → gate BACKUP_RESTORE.
 * Xác nhận MẬT KHẨU do ADAPTER kiểm TRƯỚC (khuôn customer.ts) — lõi KHÔNG nhận password.
 */
export async function setBackupMirrorConfig(ctx: ServiceCtx, input: { mirrorDir: string | null; keep?: number }): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'BACKUP_RESTORE')) return { ok: false, error: 'FORBIDDEN', message: 'Bạn không có quyền thực hiện thao tác này.' };
  const { db, user } = ctx;
  const dir = input.mirrorDir?.trim() || '';
  const keep = input.keep != null ? Number(input.keep) : BACKUP_MIRROR_KEEP_DEFAULT;
  if (dir && !Number.isInteger(keep)) return { ok: false, error: 'VALIDATION', message: 'Số bản giữ phải là số nguyên.' };
  if (dir && (keep < 1 || keep > 999)) return { ok: false, error: 'VALIDATION', message: 'Số bản giữ phải trong khoảng 1–999.' };
  // Nếu bật mirror: thử tạo/kiểm ghi được thư mục ngay để báo lỗi sớm (không đợi tới backup kế).
  if (dir) {
    try {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      const probe = join(dir, `.alpha_mirror_probe_${Date.now()}`);
      writeFileSync(probe, 'ok'); unlinkSync(probe);
    } catch (err) {
      return { ok: false, error: 'MIRROR_UNWRITABLE', message: `Không ghi được vào thư mục mirror "${dir}": ${(err as Error).message}` };
    }
  }
  await db.appSetting.upsert({ where: { key: BACKUP_MIRROR_DIR_KEY }, update: { value: dir }, create: { key: BACKUP_MIRROR_DIR_KEY, value: dir } });
  await db.appSetting.upsert({ where: { key: BACKUP_MIRROR_KEEP_KEY }, update: { value: String(keep) }, create: { key: BACKUP_MIRROR_KEEP_KEY, value: String(keep) } });
  await writeAudit(db, { actorUserId: user.id, action: 'SETTING_UPDATED', targetType: 'System', after: { setting: 'backup.mirror', mirrorDir: dir || null, keep } });
  return { ok: true };
}

/** Metadata của 1 dòng backup_logs vừa ghi. */
interface BackupLogSnapshot {
  filePath: string;
  fileSize: number | null;
  checksum: string | null;
  createdBy: number | null;
  note: string | null;
  createdAt: Date;
}

/** Core archive writer. Records backup_logs. Server tự pg_dump vào ổ máy chủ. */
async function writeBackupArchive(
  db: Db,
  actorUsername: string,
  note?: string
): Promise<{ filePath: string; size: number; checksum: string; logRow: BackupLogSnapshot }> {
  const conn = pgConn();
  const bin = pgToolPath('pg_dump');
  const dumpTmp = join(backupsDir(), `.pgdump_${Date.now()}_${process.pid}.tmp`);
  const args = [
    '-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', conn.database,
    '--format=custom', '--no-owner', '--no-privileges', '-f', dumpTmp
  ];
  const res = spawnSync(bin, args, {
    env: { ...process.env, PGPASSWORD: conn.password },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024
  });
  if (res.error) throw new Error(`Không chạy được pg_dump (${bin}): ${res.error.message}`);
  if (res.status !== 0) throw new Error(`pg_dump lỗi (exit ${res.status}): ${(res.stderr || '').toString().trim()}`);
  if (!existsSync(dumpTmp)) throw new Error('pg_dump không tạo được file dump.');

  const dumpBytes = readFileSync(dumpTmp);
  // C3 (R48) — KIỂM TOÀN VẸN NGAY KHI TẠO: dump không được rỗng/cụt + `pg_restore --list` phải parse được TOC.
  if (dumpBytes.length < 512) {
    try { unlinkSync(dumpTmp); } catch { /* bỏ qua */ }
    throw new Error(`Bản dump quá nhỏ (${dumpBytes.length} bytes) — nghi cụt/rỗng, TỪ CHỐI ghi nhận.`);
  }
  const listRes = spawnSync(pgToolPath('pg_restore'), ['--list', dumpTmp], {
    env: { ...process.env, PGPASSWORD: conn.password }, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024
  });
  try { unlinkSync(dumpTmp); } catch { /* dọn tạm — bỏ qua nếu fail */ }
  if (listRes.error || listRes.status !== 0) {
    throw new Error(`Bản dump KHÔNG đọc được bằng pg_restore --list (nghi hỏng): ${(listRes.stderr || listRes.error?.message || '').toString().trim()}`);
  }

  const checksum = sha256Hex(dumpBytes);
  const manifest = buildBackupManifest({ createdBy: actorUsername, checksum, databaseFile: DUMP_ENTRY, note });
  const zip = zipStore([
    { name: DUMP_ENTRY, data: dumpBytes },
    { name: MANIFEST_NAME, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') }
  ]);
  const fileName = backupFileName();
  const filePath = join(backupsDir(), fileName);
  writeFileSync(filePath, zip);

  const logRow = await db.backupLog.create({
    data: { filePath, fileSize: zip.length, checksum, createdBy: null, note: note ?? null }
  });
  // R48 Pha 5 — nhân bản TẦNG 2 (best-effort, non-throwing) — 1 choke-point duy nhất.
  await mirrorArchive(db, filePath);
  return {
    filePath, size: zip.length, checksum,
    logRow: {
      filePath: logRow.filePath, fileSize: logRow.fileSize, checksum: logRow.checksum,
      createdBy: logRow.createdBy, note: logRow.note, createdAt: logRow.createdAt
    }
  };
}

/** BACKUP_CREATE — tạo bản sao lưu cục bộ (pg_dump custom format zipped + manifest). Server = máy chủ. */
export async function createBackup(ctx: ServiceCtx, note?: string): Promise<BackupResult> {
  if (!hasPermission(ctx.user, 'BACKUP_CREATE')) return { ok: false, error: 'FORBIDDEN', message: 'Bạn không có quyền thực hiện thao tác này.' };
  const { db, user } = ctx;
  try {
    const out = await writeBackupArchive(db, user.username, note);
    await writeAudit(db, {
      actorUserId: user.id, action: 'BACKUP_CREATED', targetType: 'System', targetId: basename(out.filePath),
      after: { file: basename(out.filePath), size: out.size, checksum: out.checksum }
    });
    return { ok: true, filePath: out.filePath };
  } catch (err) {
    return { ok: false, error: 'BACKUP_FAILED', message: `Tạo backup thất bại: ${(err as Error).message}` };
  }
}

/**
 * Backup do HỆ THỐNG khởi tạo (KHÔNG cần phiên đăng nhập) — dùng cho "backup trước khi xóa" của Storage-Guard
 * (runCleanup) và pre-autofix của Health-Scan. Nhận db PARAM. Trả về đường dẫn + size.
 */
export async function systemBackup(db: Db, note: string): Promise<{ ok: boolean; filePath?: string; size?: number; error?: string }> {
  try {
    const out = await writeBackupArchive(db, 'system', note);
    await writeAudit(db, {
      actorUserId: null, action: 'AUTO_BACKUP', targetType: 'System', targetId: basename(out.filePath),
      after: { file: basename(out.filePath), size: out.size, checksum: out.checksum, note }
    });
    return { ok: true, filePath: out.filePath, size: out.size };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

/** BACKUP_CREATE — liệt kê các bản sao lưu đã ghi nhận. */
export async function listBackups(ctx: ServiceCtx): Promise<{ ok: boolean; data?: BackupDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'BACKUP_CREATE')) return { ok: false, error: 'FORBIDDEN', message: 'Bạn không có quyền thực hiện thao tác này.' };
  const rows = await ctx.db.backupLog.findMany({ orderBy: { id: 'desc' } });
  const data: BackupDto[] = rows.map((r) => ({
    id: r.id, filePath: r.filePath, fileName: basename(r.filePath), fileSize: r.fileSize, checksum: r.checksum,
    createdBy: r.createdBy, createdAt: r.createdAt.toISOString(), note: r.note, exists: existsSync(r.filePath)
  }));
  return { ok: true, data };
}
