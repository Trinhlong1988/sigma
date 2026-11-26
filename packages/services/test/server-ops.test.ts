// Test LÕI THUẦN 3 domain SERVER-OPS (@sigma/services): storage / health / backup. ASSERT quyền (FORBIDDEN đúng
// permission), nghiệp vụ (cleanup NOTHING_SELECTED, healthScan rollup, createBackup pg_dump → zip). pg_dump/
// pg_restore ĐƯỢC MOCK (vi.mock node:child_process) — KHÔNG chạy backup THẬT; fs ghi vào thư mục tạm.
import { mkdtempSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';

// MOCK pg_dump/pg_restore (compiler-hoisted). pg_dump (-f <path>) → ghi 1 dump giả ≥512 bytes; pg_restore
// --list → exit 0. Không mock fs → zip ghi thật vào SIGMA_BACKUP_DIR (thư mục tạm).
vi.mock('node:child_process', async () => {
  const { writeFileSync: wf } = await import('node:fs');
  return {
    spawnSync: (_bin: string, args: string[]) => {
      const fi = args.indexOf('-f');
      if (fi >= 0) { wf(args[fi + 1], Buffer.alloc(2048, 7)); return { status: 0, stdout: '', stderr: '', error: undefined }; }
      return { status: 0, stdout: 'toc', stderr: '', error: undefined }; // pg_restore --list
    }
  };
});

let BK_DIR: string;
beforeAll(() => {
  BK_DIR = mkdtempSync(join(tmpdir(), 'alpha-bk-'));
  process.env['SIGMA_BACKUP_DIR'] = BK_DIR;
  process.env['DATABASE_URL'] = 'postgresql://u:p@localhost:5432/testdb';
});

// Import SAU khi mock đăng ký (vitest hoist vi.mock nên thứ tự import an toàn; để rõ ràng import tĩnh ở đây).
import {
  getStorageStatus, runCleanup, updateStorageConfig,
  healthScan, listHealthRuns, runHealthScan,
  createBackup, listBackups, getBackupMirrorConfig, setBackupMirrorConfig
} from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 1, username: 'admin', fullName: 'Admin', status: 'ACTIVE', forceChangePassword: false, roles: ['ADMIN'], permissions };
}

/** Fake db: mỗi model có count/findMany/deleteMany/create... mặc định rỗng; ghi lại create để assert. */
function makeFakeDb() {
  const backupLogs: Record<string, unknown>[] = [];
  const maintenanceRuns: Record<string, unknown>[] = [];
  const audits: Record<string, unknown>[] = [];
  const settings = new Map<string, string>();

  const model = () => ({
    count: async () => 0,
    findMany: async () => [] as unknown[],
    deleteMany: async () => ({ count: 0 }),
    create: async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data }),
    update: async ({ data }: { data: Record<string, unknown> }) => ({ id: 1, ...data })
  });

  const fake: Record<string, unknown> = {
    // health collectFindings models
    tid: model(), cardType: model(), customer: model(), partner: model(), bank: model(),
    transaction: model(), statusOption: model(), posDevice: model(), feeRate: model(),
    dossier: model(), receiveAccount: model(), user: { ...model(), findMany: async () => [] as unknown[] },
    // storage trashModels (còn thiếu tên nào → thêm)
    agent: model(), supplier: model(), posModel: model(), posIntakeStatus: model(), posIntake: model(),
    feeType: model(), feeSellQuote: model(), receiveAccountSource: model(), dossierSource: model(),
    tidConfigStatus: model(),
    // audit + changeToken
    auditLog: { ...model(), count: async () => 0, create: async ({ data }: { data: Record<string, unknown> }) => { audits.push(data); return { id: 1, ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'X', version: 1 }) },
    // maintenance runs
    maintenanceRun: {
      findMany: async () => maintenanceRuns.map((r, i) => ({ id: i + 1, triggeredBy: null, startedAt: new Date(), finishedAt: new Date(), kind: 'MANUAL', status: 'OK', checksTotal: 0, issuesFound: 0, errorCount: 0, warnCount: 0, autoFixed: 0, vacuumed: false, auditDeleted: 0, trashDeleted: 0, durationMs: 1, reportJson: '[]', ...r })),
      create: async ({ data }: { data: Record<string, unknown> }) => { maintenanceRuns.push(data); return { id: maintenanceRuns.length, ...data }; }
    },
    // backup logs
    backupLog: {
      findMany: async () => backupLogs.map((r, i) => ({ id: i + 1, filePath: '', fileSize: 0, checksum: '', createdBy: null, createdAt: new Date(), note: null, ...r })),
      create: async ({ data }: { data: Record<string, unknown> }) => { backupLogs.push(data); return { id: backupLogs.length, createdAt: new Date(), ...data }; }
    },
    // messages (mirror notify — không dùng khi mirror tắt)
    message: { createMany: async () => ({ count: 0 }) },
    // app settings
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) => (settings.has(where.key) ? { key: where.key, value: settings.get(where.key) } : null),
      upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
        settings.set(where.key, update?.value ?? create.value); return { key: where.key, value: settings.get(where.key) };
      }
    },
    // raw queries: pg_database_size + SHOW data_directory
    $queryRawUnsafe: async (sql: string) => {
      if (sql.includes('pg_database_size')) return [{ size: 123456n }];
      if (sql.includes('data_directory')) return []; // → diskInfo null (không statfs ổ thật trong test)
      return [];
    }
  };
  return { db: fake as unknown as Db, backupLogs, maintenanceRuns, audits, settings };
}

describe('storage core', () => {
  it('getStorageStatus: thiếu STORAGE_VIEW → FORBIDDEN', async () => {
    const r = await getStorageStatus({ db: makeFakeDb().db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('getStorageStatus: có quyền → dbBytes + diskUsedPct null (không đo được)', async () => {
    const r = await getStorageStatus({ db: makeFakeDb().db, user: authUser(['STORAGE_VIEW']) });
    expect(r.ok).toBe(true);
    expect(r.data!.dbBytes).toBe(123456);
    expect(r.data!.diskUsedPct).toBeNull();
    expect(r.data!.thresholdPct).toBe(80);
  });

  it('runCleanup: không chọn mục → NOTHING_SELECTED (không backup)', async () => {
    const r = await runCleanup({ db: makeFakeDb().db, user: authUser(['STORAGE_CLEANUP']) }, {});
    expect(r.error).toBe('NOTHING_SELECTED');
  });

  it('runCleanup: clearHistory → backup an toàn (pg_dump mock) rồi xóa; trả backupFile', async () => {
    const { db } = makeFakeDb();
    const r = await runCleanup({ db, user: authUser(['STORAGE_CLEANUP']) }, { clearHistory: true });
    expect(r.ok).toBe(true);
    expect(r.backupFile).toMatch(/_ims_backup\.zip$/);
    expect(existsSync(r.backupFile!)).toBe(true);
  });

  it('updateStorageConfig: hạn lưu nhật ký < 7 ngày → VALIDATION (sàn an toàn)', async () => {
    const r = await updateStorageConfig({ db: makeFakeDb().db, user: authUser(['STORAGE_CLEANUP']) }, { auditRetentionDays: 3 });
    expect(r.error).toBe('VALIDATION');
  });
});

describe('health core', () => {
  it('healthScan: thiếu STORAGE_VIEW → FORBIDDEN', async () => {
    const r = await healthScan({ db: makeFakeDb().db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('healthScan: DB rỗng → OK, checksTotal động > 0, không persist', async () => {
    const { db, maintenanceRuns } = makeFakeDb();
    const r = await healthScan({ db, user: authUser(['STORAGE_VIEW']) });
    expect(r.ok).toBe(true);
    expect(r.data!.status).toBe('ERROR'); // NO_ACTIVE_ADMIN (user.count=0) → có 1 lỗi
    expect(r.data!.checksTotal).toBeGreaterThan(0);
    expect(maintenanceRuns.length).toBe(0); // READ-ONLY: không ghi run
  });

  it('runHealthScan: persist 1 MaintenanceRun', async () => {
    const { db, maintenanceRuns } = makeFakeDb();
    const r = await runHealthScan({ db, user: authUser(['STORAGE_VIEW']) }, {});
    expect(r.ok).toBe(true);
    expect(r.data!.runId).toBeGreaterThan(0);
    expect(maintenanceRuns.length).toBe(1);
  });

  it('runHealthScan(autoFix): thiếu STORAGE_CLEANUP → FORBIDDEN', async () => {
    const r = await runHealthScan({ db: makeFakeDb().db, user: authUser(['STORAGE_VIEW']) }, { autoFix: true });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('listHealthRuns: STORAGE_VIEW → data mảng', async () => {
    const r = await listHealthRuns({ db: makeFakeDb().db, user: authUser(['STORAGE_VIEW']) });
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
  });
});

describe('backup core', () => {
  it('createBackup: thiếu BACKUP_CREATE → FORBIDDEN', async () => {
    const r = await createBackup({ db: makeFakeDb().db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
  });

  it('createBackup: pg_dump mock → zip ghi ra SIGMA_BACKUP_DIR + backup_logs + audit', async () => {
    const { db, backupLogs, audits } = makeFakeDb();
    const r = await createBackup({ db, user: authUser(['BACKUP_CREATE']) }, 'test note');
    expect(r.ok).toBe(true);
    expect(r.filePath).toMatch(/_ims_backup\.zip$/);
    expect(existsSync(r.filePath!)).toBe(true);
    expect(backupLogs.length).toBe(1);
    expect(audits.some((a) => a.action === 'BACKUP_CREATED')).toBe(true);
  });

  it('listBackups: BACKUP_CREATE → data mảng', async () => {
    const r = await listBackups({ db: makeFakeDb().db, user: authUser(['BACKUP_CREATE']) });
    expect(r.ok).toBe(true);
    expect(Array.isArray(r.data)).toBe(true);
  });

  it('mirror config: get (BACKUP_CREATE) + set (BACKUP_RESTORE) lưu đường dẫn', async () => {
    const { db, settings } = makeFakeDb();
    const dir = mkdtempSync(join(tmpdir(), 'alpha-mirror-'));
    const setR = await setBackupMirrorConfig({ db, user: authUser(['BACKUP_RESTORE']) }, { mirrorDir: dir, keep: 5 });
    expect(setR.ok).toBe(true);
    expect(settings.get('backup.mirrorDir')).toBe(dir);
    const getR = await getBackupMirrorConfig({ db, user: authUser(['BACKUP_CREATE']) });
    expect(getR.ok).toBe(true);
    expect(getR.data!.mirrorDir).toBe(dir);
    expect(getR.data!.keep).toBe(5);
  });

  it('setBackupMirrorConfig: thiếu BACKUP_RESTORE → FORBIDDEN', async () => {
    const r = await setBackupMirrorConfig({ db: makeFakeDb().db, user: authUser(['BACKUP_CREATE']) }, { mirrorDir: null });
    expect(r.error).toBe('FORBIDDEN');
  });
});
