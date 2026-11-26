import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPasswordHash } from '../src/password-service.js';

describe('password-service', () => {
  it('hash rồi verify đúng mật khẩu → true', async () => {
    const hash = await hashPassword('MatKhauThat123!');
    expect(await verifyPasswordHash('MatKhauThat123!', hash)).toBe(true);
  });

  it('verify sai mật khẩu → false (không throw)', async () => {
    const hash = await hashPassword('MatKhauThat123!');
    expect(await verifyPasswordHash('SaiRoi', hash)).toBe(false);
  });

  it('verify với hash null/undefined/rỗng → false, không throw', async () => {
    expect(await verifyPasswordHash('bat-ky-gi', null)).toBe(false);
    expect(await verifyPasswordHash('bat-ky-gi', undefined)).toBe(false);
    expect(await verifyPasswordHash('bat-ky-gi', '')).toBe(false);
  });

  it('verify với hash hỏng (không phải bcrypt hợp lệ) → false, không throw', async () => {
    expect(await verifyPasswordHash('bat-ky-gi', 'khong-phai-bcrypt-hash')).toBe(false);
  });

  it('2 lần hash CÙNG 1 mật khẩu → giá trị hash KHÁC nhau (salt ngẫu nhiên), nhưng cả 2 đều verify đúng', async () => {
    const hash1 = await hashPassword('CungMatKhau789!');
    const hash2 = await hashPassword('CungMatKhau789!');
    expect(hash1).not.toBe(hash2);
    expect(await verifyPasswordHash('CungMatKhau789!', hash1)).toBe(true);
    expect(await verifyPasswordHash('CungMatKhau789!', hash2)).toBe(true);
  });
});
