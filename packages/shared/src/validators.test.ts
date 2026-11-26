import { describe, it, expect } from 'vitest';
import {
  isValidUsername,
  validateUsername,
  validatePassword,
  isValidEmail,
  validateServerConfig,
  DEFAULT_SERVER_PORT,
  DEFAULT_SERVER_DATABASE,
  DEFAULT_SERVER_USER
} from './validators.js';

describe('username validation (IMS_SPEC §10/§20)', () => {
  const PASS = ['nguyenvana', 'ketoan001', 'manager01', 'support01'];
  const FAIL = ['nguyen van a', 'admin@01', 'kt-001', 'abc123', 'kếtoan001'];

  it.each(PASS)('accepts valid username: %s', (u) => {
    expect(isValidUsername(u)).toBe(true);
    expect(validateUsername(u).valid).toBe(true);
  });

  it.each(FAIL)('rejects invalid username: %s', (u) => {
    expect(isValidUsername(u)).toBe(false);
    expect(validateUsername(u).valid).toBe(false);
  });

  it('rejects empty and whitespace', () => {
    expect(isValidUsername('')).toBe(false);
    expect(isValidUsername('   ')).toBe(false);
  });

  it('rejects a 7-char alnum (below min length)', () => {
    expect(isValidUsername('abc1234')).toBe(false);
  });

  it('accepts exactly 8 alnum chars', () => {
    expect(isValidUsername('abcd1234')).toBe(true);
  });
});

describe('password policy', () => {
  it('accepts the admin default password', () => {
    expect(validatePassword('Admin@123456').valid).toBe(true);
  });
  it('rejects too-short passwords', () => {
    expect(validatePassword('a1').valid).toBe(false);
  });
  it('rejects letters-only and digits-only', () => {
    expect(validatePassword('abcdefgh').valid).toBe(false);
    expect(validatePassword('12345678').valid).toBe(false);
  });
});

describe('email validation', () => {
  it('accepts a normal email', () => {
    expect(isValidEmail('a@b.com')).toBe(true);
  });
  it('rejects malformed email', () => {
    expect(isValidEmail('nope')).toBe(false);
    expect(isValidEmail('a@b')).toBe(false);
  });
});

describe('server config validation (G10.3 — cấu hình máy chủ)', () => {
  it('accepts a full valid config and normalizes it', () => {
    const r = validateServerConfig({
      host: '127.0.0.1',
      port: 5432,
      database: 'sigma',
      user: 'postgres',
      password: 'mat-khau-vi-du'
    });
    expect(r.valid).toBe(true);
    expect(r.config).toEqual({
      host: '127.0.0.1',
      port: 5432,
      database: 'sigma',
      user: 'postgres',
      password: 'mat-khau-vi-du'
    });
  });

  it('trims host and applies defaults for empty port/database/user', () => {
    const r = validateServerConfig({ host: '  127.0.0.1  ', password: 'x1' });
    expect(r.valid).toBe(true);
    expect(r.config?.host).toBe('127.0.0.1');
    expect(r.config?.port).toBe(DEFAULT_SERVER_PORT);
    expect(r.config?.database).toBe(DEFAULT_SERVER_DATABASE);
    expect(r.config?.user).toBe(DEFAULT_SERVER_USER);
  });

  it('accepts port passed as a numeric string', () => {
    const r = validateServerConfig({ host: 'db.lan', port: '6543', password: 'x1' });
    expect(r.valid).toBe(true);
    expect(r.config?.port).toBe(6543);
  });

  it('rejects a missing host', () => {
    expect(validateServerConfig({ password: 'x1' }).valid).toBe(false);
    expect(validateServerConfig({ host: '   ', password: 'x1' }).valid).toBe(false);
  });

  it('rejects a host containing whitespace', () => {
    expect(validateServerConfig({ host: '192.168 .1.6', password: 'x1' }).valid).toBe(false);
  });

  it('rejects a missing password', () => {
    expect(validateServerConfig({ host: '127.0.0.1' }).valid).toBe(false);
    expect(validateServerConfig({ host: '127.0.0.1', password: '' }).valid).toBe(false);
  });

  it('rejects out-of-range or non-integer ports', () => {
    expect(validateServerConfig({ host: 'db', port: 0, password: 'x1' }).valid).toBe(false);
    expect(validateServerConfig({ host: 'db', port: 70000, password: 'x1' }).valid).toBe(false);
    expect(validateServerConfig({ host: 'db', port: 'abc', password: 'x1' }).valid).toBe(false);
    expect(validateServerConfig({ host: 'db', port: 5432.5, password: 'x1' }).valid).toBe(false);
  });
});

describe('server config validation — chế độ API (4/8, máy ngoài không có Postgres)', () => {
  it('accepts API-only config: apiBaseUrl có, KHÔNG cần host/mật khẩu Postgres', () => {
    const r = validateServerConfig({ apiBaseUrl: 'https://alpha-quanly-api.example.com' });
    expect(r.valid).toBe(true);
    expect(r.config?.apiBaseUrl).toBe('https://alpha-quanly-api.example.com');
    // Postgres fields về mặc định (host rỗng, port/db/user default).
    expect(r.config?.host).toBe('');
    expect(r.config?.port).toBe(DEFAULT_SERVER_PORT);
    expect(r.config?.database).toBe(DEFAULT_SERVER_DATABASE);
    expect(r.config?.user).toBe(DEFAULT_SERVER_USER);
  });

  it('chuẩn hóa apiBaseUrl: trim + bỏ dấu / thừa cuối', () => {
    const r = validateServerConfig({ apiBaseUrl: '  http://127.0.0.1:8790///  ' });
    expect(r.valid).toBe(true);
    expect(r.config?.apiBaseUrl).toBe('http://127.0.0.1:8790');
  });

  it('rejects apiBaseUrl sai scheme (không http/https)', () => {
    expect(validateServerConfig({ apiBaseUrl: 'ftp://x' }).valid).toBe(false);
    expect(validateServerConfig({ apiBaseUrl: '127.0.0.1:8790' }).valid).toBe(false);
  });

  it('chế độ API vẫn giữ được cấu hình Postgres kèm theo nếu nhập đủ', () => {
    const r = validateServerConfig({ apiBaseUrl: 'https://api.x', host: '127.0.0.1', password: 'mat-khau-vi-du' });
    expect(r.valid).toBe(true);
    expect(r.config?.apiBaseUrl).toBe('https://api.x');
    expect(r.config?.host).toBe('127.0.0.1');
  });

  it('KHÔNG có apiBaseUrl → giữ ràng buộc Postgres như cũ (thiếu host/mật khẩu = invalid)', () => {
    expect(validateServerConfig({}).valid).toBe(false);
    expect(validateServerConfig({ host: '127.0.0.1' }).valid).toBe(false); // thiếu mật khẩu
    expect(validateServerConfig({ password: 'x1' }).valid).toBe(false); // thiếu host
  });
});
