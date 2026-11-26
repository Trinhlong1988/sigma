// MÃ HOÁ MẬT KHẨU DIGISTORE PER-MÃ — test THUẦN (không DB/mạng): round-trip encrypt/decrypt, SAI khoá → ném,
// THIẾU khoá → ném, ciphertext hỏng → ném. Khoá đọc env LÚC GỌI → set/xoá process.env.DIGISTORE_ENC_KEY trong test.
import { describe, expect, it, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptSecret, decryptSecret, DigistoreSecretError } from '../src/digistore-secret.js';

const KEY_A = randomBytes(32).toString('base64');
const KEY_B = randomBytes(32).toString('base64');

afterEach(() => { delete process.env.DIGISTORE_ENC_KEY; });

describe('encryptSecret/decryptSecret — AES-256-GCM per-mã', () => {
  it('round-trip: giải mã trả đúng plaintext (kể cả tiếng Việt/ký tự đặc biệt)', () => {
    process.env.DIGISTORE_ENC_KEY = KEY_A;
    const secret = 'M@tKh@u#Bản Việt 2026!';
    const enc = encryptSecret(secret);
    expect(enc).not.toContain(secret); // KHÔNG lộ plaintext trong chuỗi lưu
    expect(enc.split('.')).toHaveLength(3); // iv.tag.cipher
    expect(decryptSecret(enc)).toBe(secret);
  });

  it('IV ngẫu nhiên: 2 lần mã hoá cùng plaintext ra ciphertext KHÁC nhau', () => {
    process.env.DIGISTORE_ENC_KEY = KEY_A;
    expect(encryptSecret('same')).not.toBe(encryptSecret('same'));
  });

  it('SAI khoá → decrypt NÉM DECRYPT_FAILED (GCM authTag lệch), KHÔNG trả rác', () => {
    process.env.DIGISTORE_ENC_KEY = KEY_A;
    const enc = encryptSecret('bemat');
    process.env.DIGISTORE_ENC_KEY = KEY_B;
    try {
      decryptSecret(enc);
      throw new Error('LẼ RA phải ném');
    } catch (e) {
      expect(e).toBeInstanceOf(DigistoreSecretError);
      expect((e as DigistoreSecretError).code).toBe('DECRYPT_FAILED');
    }
  });

  it('THIẾU khoá → encrypt/decrypt NÉM NO_ENC_KEY (KHÔNG lưu plaintext lén)', () => {
    delete process.env.DIGISTORE_ENC_KEY;
    expect(() => encryptSecret('x')).toThrow(DigistoreSecretError);
    try { encryptSecret('x'); } catch (e) { expect((e as DigistoreSecretError).code).toBe('NO_ENC_KEY'); }
  });

  it('khoá SAI ĐỘ DÀI (không 32 byte) → NÉM BAD_ENC_KEY', () => {
    process.env.DIGISTORE_ENC_KEY = Buffer.alloc(16, 7).toString('base64');
    try { encryptSecret('x'); } catch (e) { expect((e as DigistoreSecretError).code).toBe('BAD_ENC_KEY'); }
  });

  it('ciphertext SAI ĐỊNH DẠNG (không đủ 3 phần) → NÉM BAD_CIPHERTEXT', () => {
    process.env.DIGISTORE_ENC_KEY = KEY_A;
    try { decryptSecret('khong-hop-le'); } catch (e) { expect((e as DigistoreSecretError).code).toBe('BAD_CIPHERTEXT'); }
  });
});
