// GUARD chống DRIFT schema.prisma ↔ migrations (codify bài học B113 — xem BUGS_FIXED.md / memory
// feedback_no_prisma_migrate_dev_on_real_db). B113 THẬT: `prisma migrate dev` trên DB `sigma` production tự
// diff schema.prisma với DB rồi XÓA NHẦM 4 thứ (2 FK chat_room_tids CASCADE, index pos_devices.warehouse_id, 2
// DEFAULT now() updated_at) vì schema.prisma THIẾU các khai báo đó (drift có sẵn). Guard này biến "schema PHẢI
// khớp migrations" từ 1 dòng comment mong manh thành 1 test BỀN chạy mỗi lần:
//   `prisma migrate diff --from-migrations <migrations> --to-schema <schema> --exit-code`  PHẢI = 0.
// Exit 2 = có drift (migrations dựng ra 1 DB KHÁC schema.prisma) → FAIL kèm diff người-đọc-được chỉ rõ khác ở đâu.
//
// KHÔNG đụng DB `sigma` production: tự tạo 1 shadow DB throwaway (random theo timestamp) để prisma replay
// migrations vào đó rồi tự huỷ — CÙNG khuôn PG env (PGHOST/PGPORT/...) với global-setup.ts. Prisma 7 yêu cầu
// `datasource.shadowDatabaseUrl` cho `--from-migrations`, ta truyền qua ENV SHADOW_DATABASE_URL (prisma.config.ts
// đọc env này — KHÔNG hardcode credential).
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const dbPkg = join(repoRoot, 'packages', 'database');

const HOST = process.env.PGHOST || 'localhost';
const PORT = process.env.PGPORT || '5432';
const USER = process.env.PGUSER || 'postgres';
const PASSWORD = process.env.PGPASSWORD || 'postgres';
const PGBIN = process.env.SIGMA_PG_BIN || '<PG_BIN>/pgsql/bin';
const exe = (t: string): string => (process.platform === 'win32' ? `${t}.exe` : t);
const tool = (t: string): string => join(PGBIN, exe(t));

function shadowUrl(dbName: string): string {
  return `postgresql://${encodeURIComponent(USER)}:${encodeURIComponent(PASSWORD)}@${HOST}:${PORT}/${dbName}`;
}

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): ReturnType<typeof spawnSync> {
  return spawnSync(cmd, args, {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
    env: { ...process.env, PGPASSWORD: PASSWORD, ...((opts.env as Record<string, string>) || {}) }
  });
}

describe('GUARD: schema.prisma PHẢI khớp migrations (chống B113 drift)', () => {
  it('prisma migrate diff --from-migrations --to-schema --exit-code = 0 (không drift)', async () => {
    const shadowDb = `alpha_drift_guard_${Date.now()}`;
    const url = shadowUrl(shadowDb);

    const created = run(tool('createdb'), ['-h', HOST, '-p', PORT, '-U', USER, shadowDb]);
    expect(created.status, `createdb shadow THẤT BẠI: ${created.stderr || created.stdout}`).toBe(0);

    try {
      const diffArgs = [
        'prisma',
        'migrate',
        'diff',
        '--from-migrations',
        './prisma/migrations',
        '--to-schema',
        './prisma/schema.prisma',
        '--exit-code'
      ];
      const env = { SHADOW_DATABASE_URL: url };
      const diff = run('npx', diffArgs, { cwd: dbPkg, shell: true, env });

      // exit 0 = khớp; exit 2 = drift; exit 1 = lỗi chạy (KHÔNG được nuốt — R198: check ném lỗi PHẢI thành finding).
      if (diff.status !== 0) {
        // Chạy lại KHÔNG --exit-code để lấy diff người-đọc-được, nhét vào message fail cho biết drift ở ĐÂU.
        const human = run('npx', ['prisma', 'migrate', 'diff', '--from-migrations', './prisma/migrations', '--to-schema', './prisma/schema.prisma'], {
          cwd: dbPkg,
          shell: true,
          env
        });
        const detail = `${String(human.stdout ?? '')}${String(human.stderr ?? '')}${String(diff.stderr ?? '')}`;
        throw new Error(
          `DRIFT schema.prisma ↔ migrations (exit ${diff.status}). ` +
            `schema.prisma PHẢI khai đủ FK/index/default mà migrations dựng ra (bài học B113 — CẤM để migrate dev tự xoá). Diff:\n${detail}`
        );
      }
      expect(diff.status).toBe(0);
    } finally {
      const dropped = run(tool('dropdb'), ['-h', HOST, '-p', PORT, '-U', USER, shadowDb]);
      if (dropped.status !== 0) {
        // eslint-disable-next-line no-console
        console.error(`[drift-guard] dropdb CẢNH BÁO (${shadowDb}): ${dropped.stderr || dropped.stdout}`);
      }
    }
  }, 120_000);
});
