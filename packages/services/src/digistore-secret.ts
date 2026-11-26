// MÃ HOÁ MẬT KHẨU DIGISTORE PER-MÃ (Admin Demo 5/9) — AES-256-GCM đối xứng, khoá từ env `DIGISTORE_ENC_KEY` (off-repo).
// CÙNG khuôn đã kiểm chứng ở drive-backup-service.ts (encryptRefreshToken) — KHÔNG viết lại thuật toán, chỉ tách helper
// riêng cho creds DigiStore để tái dùng ở adapter + resolver. Định dạng lưu: "ivBase64.authTagBase64.cipherBase64"
// (1 chuỗi cột TEXT). IV 12 byte sinh MỚI mỗi lần mã hoá (KHÔNG tái dùng IV — phá an toàn GCM).
//
// [MOVE 5/9 — Admin Demo] Đưa từ apps/bot-api/src → packages/services/src để CẢ bot-api LẪN quanly-api (desktop set-cred)
// dùng CHUNG 1 nguồn (KHÔNG copy thuật toán 2 nơi). bot-api re-export từ đây (apps/bot-api/src/digistore-secret.ts).
//
// R198 (không nuốt lỗi im): thiếu khoá / khoá sai định dạng / ciphertext hỏng → NÉM lỗi RÕ RÀNG (có code) để tầng gọi
// hiển thị finding, KHÔNG lưu/đọc plaintext lén. CẤM log plaintext hoặc khoá (không có console.* trong file này).
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class DigistoreSecretError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'DigistoreSecretError';
    this.code = code;
  }
}

/** Khoá 32 byte đọc từ env LÚC GỌI (không cache lúc import — để LEAD set .env rồi reload module là ăn). */
function secretKey(): Buffer {
  const raw = process.env.DIGISTORE_ENC_KEY;
  if (!raw) {
    throw new DigistoreSecretError(
      'NO_ENC_KEY',
      'Thiếu biến môi trường DIGISTORE_ENC_KEY (khoá 32 byte mã hoá base64) — LEAD phải set trong .env trước khi lưu/giải mã tài khoản DigiStore per-mã.'
    );
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw, 'base64');
  } catch {
    throw new DigistoreSecretError('BAD_ENC_KEY', 'DIGISTORE_ENC_KEY không đúng định dạng base64.');
  }
  if (key.length !== 32) {
    throw new DigistoreSecretError(
      'BAD_ENC_KEY',
      'DIGISTORE_ENC_KEY phải là khoá 32 byte mã hoá base64 (sinh: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))").'
    );
  }
  return key;
}

/** Mã hoá 1 chuỗi bí mật (mật khẩu DigiStore). Thiếu/khoá sai → NÉM DigistoreSecretError. KHÔNG log giá trị. */
export function encryptSecret(plain: string): string {
  const key = secretKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString('base64'), authTag.toString('base64'), encrypted.toString('base64')].join('.');
}

/** Giải mã chuỗi đã mã hoá. Sai khoá / dữ liệu hỏng → GCM phát hiện (authTag lệch) → NÉM DigistoreSecretError code
 *  DECRYPT_FAILED (KHÔNG trả plaintext rác, KHÔNG nuốt câm). KHÔNG log giá trị. */
export function decryptSecret(stored: string): string {
  const key = secretKey();
  const parts = (stored ?? '').split('.');
  if (parts.length !== 3) {
    throw new DigistoreSecretError('BAD_CIPHERTEXT', 'Chuỗi mật khẩu DigiStore lưu sai định dạng (không đủ 3 phần iv.tag.cipher).');
  }
  const [ivB64, tagB64, dataB64] = parts;
  try {
    const iv = Buffer.from(ivB64, 'base64');
    const authTag = Buffer.from(tagB64, 'base64');
    const data = Buffer.from(dataB64, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch (err) {
    throw new DigistoreSecretError(
      'DECRYPT_FAILED',
      `Giải mã mật khẩu DigiStore thất bại (khoá DIGISTORE_ENC_KEY sai hoặc dữ liệu hỏng): ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
