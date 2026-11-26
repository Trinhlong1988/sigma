// [Admin Demo 10/9 — bản clone "SigMa TN"] Khoá 2 điều để bản CHÍNH không bị đổi hành vi khi thêm bản clone:
//   1. Không có resources/instance.json (bản SigMa chính) → thư mục cấu hình VẪN là 'AlphaQuanLy', tên bản = rỗng.
//   2. Có instance.json (bản TN) → 'AlphaTN' + tên "SigMa TN" ⇒ 2 bản trên cùng máy không dẫm cấu hình nhau.
// Test chạy ở env node (không Electron thật) nên giả lập `app` qua mock module electron.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = { packaged: false, resourcesPath: '', appDataPath: 'C:/Users/x/AppData/Roaming' };
vi.mock('electron', () => ({
  app: {
    get isPackaged() { return state.packaged; },
    getPath: (k: string) => (k === 'appData' ? state.appDataPath : 'C:/tmp')
  },
  safeStorage: { isEncryptionAvailable: () => false }
}));

const { instanceConfigDir, instanceName } = await import('./db.js');

beforeEach(() => {
  state.packaged = false;
  delete process.env['SIGMA_INSTANCE_DIR'];
  delete process.env['SIGMA_INSTANCE_NAME'];
});

describe('bản cài (instance) — clone không dẫm bản chính', () => {
  it('bản CHÍNH (không có instance.json, không env) → AlphaQuanLy + tên rỗng', () => {
    expect(instanceConfigDir()).toBe('AlphaQuanLy');
    expect(instanceName()).toBe('');
  });

  it('dev đặt env → dùng đúng thư mục/tên của bản clone', () => {
    process.env['SIGMA_INSTANCE_DIR'] = 'AlphaTN';
    process.env['SIGMA_INSTANCE_NAME'] = 'SigMa TN';
    expect(instanceConfigDir()).toBe('AlphaTN');
    expect(instanceName()).toBe('SigMa TN');
  });

  it('env rỗng/space → vẫn về mặc định (không tạo thư mục tên rỗng)', () => {
    process.env['SIGMA_INSTANCE_DIR'] = '   ';
    expect(instanceConfigDir()).toBe('AlphaQuanLy');
  });
});
