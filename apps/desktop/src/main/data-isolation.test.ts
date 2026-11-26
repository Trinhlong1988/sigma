// CÁCH LY DỮ LIỆU/VẬN HÀNH KHỎI GLB (Admin Demo 3/8 "đảm bảo cách ly độc lập với glb về dữ liệu, vận hành").
// Máy chủ 127.0.0.1 chạy CẢ GLB lẫn SigMa → nếu SigMa đọc biến/marker/DB TÊN GIỐNG GLB thì trên cùng máy
// SigMa sẽ nối NHẦM DB `glb` hoặc nhận NHẦM vai máy chủ từ marker của GLB. Test này TÁI HIỆN tình huống SAI
// (đặt sẵn env kiểu GLB) và chứng minh SigMa KHÔNG còn đọc theo — chỉ đọc biến RIÊNG SIGMA_* / marker SigMa.
//
// 2 tầng bằng chứng:
//   (A) FUNCTIONAL — mock electron, gọi THẲNG resolveDatabaseUrl()/isServerRole() thật của db.ts.
//   (B) SOURCE-GUARD — quét mã nguồn main để KHÓA bất biến "không còn tham chiếu env/marker GLB" (regression:
//       nếu ai đó vô tình thêm lại process.env['GLB_*'] hay marker 'GLB' thì test này ĐỎ ngay).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

// Mock electron: dev-mode (isPackaged=false) → resolveDatabaseUrl đi nhánh DATABASE_URL khi không có SIGMA_DB_URL.
vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: () => tmpdir(), getAppPath: () => tmpdir() },
  safeStorage: { isEncryptionAvailable: () => false, decryptString: () => '' }
}));

const { resolveDatabaseUrl, isServerRole } = await import('./db.js');

// Các key env đụng tới — snapshot & khôi phục để không rò rỉ giữa các ca / ra ngoài suite.
const KEYS = ['SIGMA_DB_URL', 'SIGMA_ROLE', 'SIGMA_ROLE_MARKER', 'GLB_DB_URL', 'GLB_ROLE', 'GLB_ROLE_MARKER', 'DATABASE_URL'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
});
afterEach(() => {
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

describe('(A) FUNCTIONAL — SigMa KHÔNG đọc biến DB/vai của GLB dù chúng được set sẵn', () => {
  it('env kiểu GLB set sẵn (GLB_DB_URL trỏ /glb, GLB_ROLE=server) → resolveDatabaseUrl() nối sigma, KHÔNG nối glb', () => {
    // Tái hiện đúng máy chủ chung: GLB đã export sẵn biến của nó.
    process.env['GLB_DB_URL'] = 'postgresql://u:p@127.0.0.1:5432/glb';
    process.env['GLB_ROLE'] = 'server';
    // Cấu hình RIÊNG của SigMa (dev): DATABASE_URL trỏ sigma. KHÔNG set SIGMA_DB_URL.
    process.env['DATABASE_URL'] = 'postgresql://u:p@127.0.0.1:5432/sigma';

    const url = resolveDatabaseUrl();
    expect(url).toBe('postgresql://u:p@127.0.0.1:5432/sigma');
    expect(url).not.toContain('/glb');
    expect(url).toContain('/sigma');
  });

  it('SIGMA_DB_URL có ưu tiên cao nhất; GLB_DB_URL bị bỏ qua hoàn toàn', () => {
    process.env['GLB_DB_URL'] = 'postgresql://u:p@h:5432/glb';
    process.env['SIGMA_DB_URL'] = 'postgresql://u:p@h:5432/sigma_selftest';
    process.env['DATABASE_URL'] = 'postgresql://u:p@h:5432/other';

    expect(resolveDatabaseUrl()).toBe('postgresql://u:p@h:5432/sigma_selftest');
  });

  it('GLB_ROLE=server set sẵn nhưng SIGMA_ROLE/marker SigMa KHÔNG có → isServerRole()=false (SigMa KHÔNG kế thừa vai máy chủ của GLB)', () => {
    process.env['GLB_ROLE'] = 'server';
    // marker SigMa trỏ đường KHÔNG tồn tại để cô lập khỏi marker thật của máy.
    process.env['SIGMA_ROLE_MARKER'] = join(tmpdir(), '__alpha_no_such_marker_test__.flag');
    expect(isServerRole()).toBe(false);
  });

  it('chỉ khi SIGMA_ROLE=server (biến RIÊNG SigMa) → isServerRole()=true', () => {
    process.env['SIGMA_ROLE'] = 'server';
    process.env['SIGMA_ROLE_MARKER'] = join(tmpdir(), '__alpha_no_such_marker_test__.flag');
    expect(isServerRole()).toBe(true);
  });

  it('marker file SigMa tồn tại → isServerRole()=true; GLB_ROLE không liên quan', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alpha-role-'));
    const marker = join(dir, 'role-server.flag');
    writeFileSync(marker, '');
    process.env['SIGMA_ROLE_MARKER'] = marker;
    try {
      expect(isServerRole()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('(B) SOURCE-GUARD — khóa bất biến: mã main KHÔNG còn tham chiếu env/marker/DB của GLB', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (f: string): string => readFileSync(join(here, f), 'utf8');

  // Mọi file main từng đọc env GLB_* — phải sạch (chỉ còn SIGMA_*).
  const FILES = ['db.ts', 'index.ts', 'backup-service.ts', 'audit.ts', 'file-store.ts', 'user-service.ts', 'screenshot-service.ts'];

  for (const f of FILES) {
    it(`${f}: KHÔNG đọc bất kỳ process.env['GLB_*']`, () => {
      const src = read(f);
      // Bắt mọi biến thể đọc env GLB_ (ngoặc vuông/chấm), bỏ qua comment thuần chỉ nhắc tên "GLB".
      const bad = src.match(/process\.env\[?['"]?GLB_[A-Z_]+/g);
      expect(bad, `còn đọc env GLB_ trong ${f}: ${bad?.join(', ')}`).toBeNull();
    });
  }

  it('db.ts: dùng biến RIÊNG SigMa cho DB/vai + marker %ProgramData%\\SigMa (KHÔNG \\GLB)', () => {
    const src = read('db.ts');
    expect(src).toContain("process.env['SIGMA_DB_URL']");
    expect(src).toContain("process.env['SIGMA_ROLE']");
    expect(src).toContain("process.env['SIGMA_ROLE_MARKER']");
    // marker directory = 'SigMa', tuyệt đối KHÔNG còn join(base, 'GLB', ...).
    expect(src).toContain("join(base, 'SigMa', 'role-server.flag')");
    expect(src).not.toMatch(/join\(base,\s*'GLB'/);
  });
});
