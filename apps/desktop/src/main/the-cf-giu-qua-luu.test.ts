// CHỐNG TÁI DIỄN: bấm "Lưu" ở màn Cấu hình máy chủ KHÔNG được XOÁ thẻ Cloudflare Access đã đặt.
//
// Lỗi gốc (phát hiện 7/11 khi làm ô nhập thẻ): `saveServerConfig` dựng object MỚI rồi ghi đè file, nên
// mọi trường ngoài danh sách bị xoá sạch. Hậu quả nếu lọt: máy đó rớt NGAY khi cổng API bật gác, mà
// người dùng chỉ thấy "không kết nối được máy chủ" — không ai lần ra được nguyên nhân.
//
// Đặt trong src/main để nằm trong `include` của vitest gốc (apps/desktop/src/main/**/*.test.ts) → chạy
// cùng `npm run verify`, không phải bộ test mồ côi.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let thuMuc = '';

vi.mock('electron', () => ({
  app: { getPath: (): string => thuMuc, isPackaged: false },
  safeStorage: {
    // Giả lập máy KHÔNG có mã hoá OS để test chạy được ở mọi nơi → đi nhánh ghi thô.
    isEncryptionAvailable: (): boolean => false,
    encryptString: (s: string): Buffer => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer): string => b.toString('utf8')
  }
}));

// [15/11] TRẦN THỜI GIAN 30s cho từng ca: mỗi ca `await import('./db.js')` — nạp nguyên lớp main (kèm Prisma),
// đo thật ~3,2-3,5s/ca khi chạy RIÊNG. Chạy CẢ BỘ (song song + ưu tiên thấp theo cổng ship) thì vượt trần mặc
// định 5s ⇒ ĐỎ CHẬP CHỜN, chặn publish oan dù assertion không sai. Nới trần, KHÔNG bỏ ca nào.
describe('Thẻ Cloudflare Access sống sót qua lần Lưu cấu hình', () => {
  beforeEach(() => {
    thuMuc = mkdtempSync(join(tmpdir(), 'alpha-cfg-'));
    mkdirSync(join(thuMuc, 'AlphaQuanLy'), { recursive: true });
  });
  afterEach(() => {
    try {
      rmSync(thuMuc, { recursive: true, force: true });
    } catch {
      /* bỏ qua */
    }
  });

  it('Lưu cấu hình mà KHÔNG đụng ô thẻ → thẻ cũ còn nguyên', async () => {
    const { serverConfigPath, saveServerConfig, readCfAccessToken } = await import('./db.js');
    writeFileSync(
      serverConfigPath(),
      JSON.stringify({
        host: '127.0.0.1',
        port: 5432,
        database: 'sigma',
        user: 'postgres',
        password: 'mk',
        apiBaseUrl: 'http://localhost:8790',
        cfAccessClientId: 'the-id-cu',
        cfAccessClientSecret: 'the-secret-cu-0123456789'
      }),
      'utf8'
    );
    expect(readCfAccessToken()?.id).toBe('the-id-cu');

    const r = await saveServerConfig({
      host: '127.0.0.1',
      port: 5432,
      database: 'sigma',
      user: 'postgres',
      password: 'mk',
      apiBaseUrl: 'http://localhost:8790'
    });
    // ok=false ở đây là BÌNH THƯỜNG: hàm ghi file xong mới thử nối DB, mà test không có DB thật.
    // Bất biến cần giữ là NỘI DUNG FILE — khẳng định vào đó, không vào cờ ok.
    expect(r, 'phải trả về kết quả có cờ ok').toHaveProperty('ok');

    const sau = JSON.parse(readFileSync(serverConfigPath(), 'utf8')) as Record<string, unknown>;
    expect(sau.cfAccessClientId, 'ID thẻ phải còn nguyên sau khi Lưu').toBe('the-id-cu');
    expect(readCfAccessToken()?.secret, 'secret thẻ phải còn dùng được sau khi Lưu').toBe('the-secret-cu-0123456789');
  }, 30_000);

  it('Nhập thẻ MỚI → ghi đúng thẻ mới', async () => {
    const { serverConfigPath, saveServerConfig, readCfAccessToken } = await import('./db.js');
    writeFileSync(
      serverConfigPath(),
      JSON.stringify({ host: '127.0.0.1', port: 5432, database: 'sigma', user: 'postgres', password: 'mk' }),
      'utf8'
    );
    const r = await saveServerConfig({
      host: '127.0.0.1',
      port: 5432,
      database: 'sigma',
      user: 'postgres',
      password: 'mk',
      cfAccessClientId: 'id-moi',
      cfAccessClientSecret: 'secret-moi-0123456789'
    } as never);
    expect(r).toHaveProperty('ok');
    expect(readCfAccessToken()).toEqual({ id: 'id-moi', secret: 'secret-moi-0123456789' });
  }, 30_000);

  it('Xoá trắng ô Client ID = CỐ Ý gỡ thẻ', async () => {
    const { serverConfigPath, saveServerConfig, readCfAccessToken } = await import('./db.js');
    writeFileSync(
      serverConfigPath(),
      JSON.stringify({
        host: '127.0.0.1', port: 5432, database: 'sigma', user: 'postgres', password: 'mk',
        cfAccessClientId: 'id-cu', cfAccessClientSecret: 'secret-cu-0123456789'
      }),
      'utf8'
    );
    const r = await saveServerConfig({
      host: '127.0.0.1', port: 5432, database: 'sigma', user: 'postgres', password: 'mk',
      cfAccessClientId: '', cfAccessClientSecret: ''
    } as never);
    expect(r).toHaveProperty('ok');
    expect(readCfAccessToken(), 'gỡ thẻ thì đọc ra null').toBeNull();
  }, 30_000);
});
