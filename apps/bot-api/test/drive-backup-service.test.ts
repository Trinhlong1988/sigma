// SIGMA (1/8, mục 32 "Sao lưu, đồng bộ") — unit test cho encryptRefreshToken/decryptRefreshToken
// (drive-backup-service.ts, AES-256-GCM). Đây là 1 crypto primitive MỚI (mã hoá refresh_token Google Drive) —
// ÁP DỤNG skill `adversarial-hardening-checklist` TRƯỚC khi coi là xong (đúng feedback
// feedback_adversarial_hardening_checklist.md): checklist "MAC/signatures/crypto" đòi hỏi test tường minh cho
// key-missing/fail-closed, tamper-detect, wrong-key, malformed-stored-value, IV-không-tái-dùng — KHÔNG chỉ test
// happy-path round-trip. CÁC TEST Ở FILE NÀY KHÔNG phụ thuộc DB/Prisma Client (chạy được NGAY, không cần LEAD
// migrate/generate trước — khác hẳn me-drive-backup.test.ts).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptRefreshToken, DriveBackupError, encryptRefreshToken } from '../src/drive-backup-service.js';

const VALID_KEY_A = Buffer.alloc(32, 7).toString('base64'); // 32 byte cố định, tái lập được giữa các lần chạy.
const VALID_KEY_B = Buffer.alloc(32, 9).toString('base64'); // Khoá KHÁC — dùng cho test "sai khoá".

describe('drive-backup-service — mã hoá refresh_token (AES-256-GCM)', () => {
  const originalEnv = process.env.DRIVE_TOKEN_ENC_KEY;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DRIVE_TOKEN_ENC_KEY;
    else process.env.DRIVE_TOKEN_ENC_KEY = originalEnv;
  });

  // ── Key location fail-closed (checklist "MAC/crypto" mục 1) ────────────────────────────────────────────
  it('THIẾU DRIVE_TOKEN_ENC_KEY → encryptRefreshToken throw DriveBackupError CONFIG_MISSING, KHÔNG BAO GIỜ lưu plaintext', () => {
    delete process.env.DRIVE_TOKEN_ENC_KEY;
    expect(() => encryptRefreshToken('refresh-token-thật')).toThrowError(DriveBackupError);
    try {
      encryptRefreshToken('refresh-token-thật');
      expect.fail('phải throw');
    } catch (err) {
      expect(err).toBeInstanceOf(DriveBackupError);
      expect((err as DriveBackupError).code).toBe('CONFIG_MISSING');
    }
  });

  it('THIẾU DRIVE_TOKEN_ENC_KEY → decryptRefreshToken CŨNG throw CONFIG_MISSING (fail-closed cả 2 chiều)', () => {
    delete process.env.DRIVE_TOKEN_ENC_KEY;
    expect(() => decryptRefreshToken('bat-ky.gia-tri.nao')).toThrowError(DriveBackupError);
  });

  it('DRIVE_TOKEN_ENC_KEY SAI ĐỘ DÀI (không phải 32 byte base64) → throw CONFIG_MISSING, KHÔNG âm thầm dùng khoá yếu', () => {
    process.env.DRIVE_TOKEN_ENC_KEY = Buffer.alloc(16, 1).toString('base64'); // 16 byte — SAI (AES-256 cần đúng 32 byte)
    expect(() => encryptRefreshToken('x')).toThrowError(DriveBackupError);
    try {
      encryptRefreshToken('x');
    } catch (err) {
      expect((err as DriveBackupError).code).toBe('CONFIG_MISSING');
    }
  });

  // ── Round-trip đúng ──────────────────────────────────────────────────────────────────────────────────────
  it('round-trip: encrypt rồi decrypt CÙNG khoá → ra ĐÚNG plaintext gốc', () => {
    process.env.DRIVE_TOKEN_ENC_KEY = VALID_KEY_A;
    const plain = '1//0gExampleGoogleRefreshTokenThật-abc123_XYZ';
    const stored = encryptRefreshToken(plain);
    expect(decryptRefreshToken(stored)).toBe(plain);
  });

  it('round-trip: ký tự Unicode/rỗng-gần-như (chuỗi ngắn 1 ký tự) vẫn đúng', () => {
    process.env.DRIVE_TOKEN_ENC_KEY = VALID_KEY_A;
    expect(decryptRefreshToken(encryptRefreshToken('a'))).toBe('a');
    expect(decryptRefreshToken(encryptRefreshToken('mã Unicode tiếng Việt 你好'))).toBe('mã Unicode tiếng Việt 你好');
  });

  // ── IV KHÔNG tái sử dụng (checklist "IV reuse" — GCM mất an toàn nếu tái dùng IV với CÙNG khoá) ───────────
  it('mã hoá CÙNG 1 plaintext 2 LẦN → ra 2 ciphertext KHÁC NHAU (IV ngẫu nhiên mỗi lần, không hardcode/cache)', () => {
    process.env.DRIVE_TOKEN_ENC_KEY = VALID_KEY_A;
    const plain = 'refresh-token-lap-lai';
    const stored1 = encryptRefreshToken(plain);
    const stored2 = encryptRefreshToken(plain);
    expect(stored1).not.toBe(stored2);
    const iv1 = stored1.split('.')[0];
    const iv2 = stored2.split('.')[0];
    expect(iv1).not.toBe(iv2);
    // Cả 2 vẫn giải mã đúng về CÙNG plaintext gốc — IV khác nhau không phá round-trip.
    expect(decryptRefreshToken(stored1)).toBe(plain);
    expect(decryptRefreshToken(stored2)).toBe(plain);
  });

  // ── Tamper test (checklist "MAC/crypto" mục 4) ──────────────────────────────────────────────────────────
  it('CIPHERTEXT bị sửa 1 byte (phần thứ 3) → decrypt THROW DriveBackupError (GCM tự phát hiện, KHÔNG trả về dữ liệu sai âm thầm)', () => {
    process.env.DRIVE_TOKEN_ENC_KEY = VALID_KEY_A;
    const stored = encryptRefreshToken('token-goc');
    const [iv, tag, data] = stored.split('.');
    const tamperedDataBuf = Buffer.from(data, 'base64');
    tamperedDataBuf[0] = tamperedDataBuf[0] ^ 0xff; // lật bit byte đầu — mô phỏng dữ liệu bị hỏng/tấn công.
    const tampered = [iv, tag, tamperedDataBuf.toString('base64')].join('.');

    expect(() => decryptRefreshToken(tampered)).toThrowError(DriveBackupError);
    try {
      decryptRefreshToken(tampered);
    } catch (err) {
      expect((err as DriveBackupError).code).toBe('DECRYPT_FAILED');
    }
  });

  it('AUTH TAG bị sửa → decrypt THROW DriveBackupError (không phải crash không bắt được)', () => {
    process.env.DRIVE_TOKEN_ENC_KEY = VALID_KEY_A;
    const stored = encryptRefreshToken('token-goc-2');
    const [iv, tag, data] = stored.split('.');
    const tamperedTagBuf = Buffer.from(tag, 'base64');
    tamperedTagBuf[0] = tamperedTagBuf[0] ^ 0xff;
    const tampered = [iv, tamperedTagBuf.toString('base64'), data].join('.');

    expect(() => decryptRefreshToken(tampered)).toThrowError(DriveBackupError);
  });

  // ── Wrong-key test (checklist "MAC/crypto" mục 4) ───────────────────────────────────────────────────────
  it('SAI KHOÁ (mã hoá bằng khoá A, giải mã bằng khoá B) → THROW DECRYPT_FAILED, KHÔNG trả plaintext sai lặng lẽ', () => {
    process.env.DRIVE_TOKEN_ENC_KEY = VALID_KEY_A;
    const stored = encryptRefreshToken('token-goc-3');

    process.env.DRIVE_TOKEN_ENC_KEY = VALID_KEY_B;
    expect(() => decryptRefreshToken(stored)).toThrowError(DriveBackupError);
    try {
      decryptRefreshToken(stored);
    } catch (err) {
      expect((err as DriveBackupError).code).toBe('DECRYPT_FAILED');
    }
  });

  // ── Malformed stored-value parsing (checklist "encoding edge cases") ────────────────────────────────────
  describe('dữ liệu lưu sai định dạng → luôn throw DriveBackupError DECRYPT_FAILED (KHÔNG crash unhandled)', () => {
    beforeEach(() => {
      process.env.DRIVE_TOKEN_ENC_KEY = VALID_KEY_A;
    });

    it('chuỗi rỗng', () => {
      expect(() => decryptRefreshToken('')).toThrowError(DriveBackupError);
    });

    it('thiếu dấu chấm phân cách (chỉ 1 phần)', () => {
      expect(() => decryptRefreshToken('khong-co-dau-cham')).toThrowError(DriveBackupError);
    });

    it('CHỈ 2 phần (thiếu ciphertext)', () => {
      expect(() => decryptRefreshToken('aXY=.aXY=')).toThrowError(DriveBackupError);
    });

    it('THỪA phần (4 phần thay vì 3)', () => {
      expect(() => decryptRefreshToken('aXY=.aXY=.aXY=.aXY=')).toThrowError(DriveBackupError);
    });

    it('base64 hợp lệ về CÚ PHÁP nhưng độ dài IV/tag SAI (không phải dữ liệu do encryptRefreshToken sinh ra)', () => {
      // "AA==" giải mã base64 ra 1 byte — IV GCM cần đúng 12 byte, authTag cần đúng 16 byte mặc định.
      expect(() => decryptRefreshToken('AA==.AA==.AA==')).toThrowError(DriveBackupError);
    });

    it('lỗi throw ra ĐÚNG code DECRYPT_FAILED (không lộ chi tiết lỗi crypto thô ra ngoài dạng khác)', () => {
      try {
        decryptRefreshToken('du-lieu-sai');
        expect.fail('phải throw');
      } catch (err) {
        expect(err).toBeInstanceOf(DriveBackupError);
        expect((err as DriveBackupError).code).toBe('DECRYPT_FAILED');
      }
    });
  });
});
