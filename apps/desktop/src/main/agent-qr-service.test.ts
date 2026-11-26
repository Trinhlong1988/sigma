// SIGMA Tier 2 (23/7) — vitest thuần cho phần validate-được-mà-không-cần-DB/Electron của agent-qr-service
// (khuôn file-store.test.ts: test hàm THUẦN, không mock Prisma/Electron). setAgentQrImage/getAgentQrImage cần
// requirePermission → phiên đăng nhập thật + Postgres → PHỦ bởi selftest DB (Electron+PG), KHÔNG chạy được
// trong vitest headless ở môi trường này — xem báo cáo build, KHÔNG có số ST sẵn có nào phù hợp cho Agent
// (Agent trước nay không có CRUD/selftest slice riêng) nên KHÔNG tự gán số mới ở đây.
import { describe, it, expect } from 'vitest';
import { validateQrImageBytes } from './agent-qr-service.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7 — hợp lệ ở file-store nhưng KHÔNG hợp lệ cho QR (chỉ nhận ảnh)
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ (.exe đổi đuôi)
const TXT = Buffer.from('hello world nothing', 'utf8');

describe('validateQrImageBytes — magic-bytes + size cap cho ảnh QR', () => {
  it('nhận PNG/JPG hợp lệ, trả mime đúng', () => {
    const png = validateQrImageBytes(PNG);
    expect(png.ok).toBe(true);
    if (png.ok) expect(png.mime).toBe('image/png');
    const jpg = validateQrImageBytes(JPG);
    expect(jpg.ok).toBe(true);
    if (jpg.ok) expect(jpg.mime).toBe('image/jpeg');
  });

  it('TỪ CHỐI PDF — QR chỉ nhận ảnh (khác file-store.ts vốn nhận cả PDF cho CCCD/ĐKKD)', () => {
    const r = validateQrImageBytes(PDF);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('BAD_CONTENT');
  });

  it('TỪ CHỐI .exe đổi đuôi / text — không tin đuôi file, xác thực nội dung', () => {
    expect(validateQrImageBytes(EXE).ok).toBe(false);
    expect(validateQrImageBytes(TXT).ok).toBe(false);
  });

  it('TỪ CHỐI buffer rỗng', () => {
    const r = validateQrImageBytes(Buffer.alloc(0));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NO_FILE');
  });

  it('TỪ CHỐI ảnh vượt cap ~2MB (PNG hợp lệ nhưng quá cỡ)', () => {
    const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2 * 1024 * 1024 + 1)]);
    const r = validateQrImageBytes(big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('TOO_LARGE');
  });

  it('ảnh PNG đúng cap (2MB chẵn) vẫn được nhận (biên không lệch off-by-one)', () => {
    const exact = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2 * 1024 * 1024 - 8)]);
    expect(exact.length).toBe(2 * 1024 * 1024);
    expect(validateQrImageBytes(exact).ok).toBe(true);
  });
});
