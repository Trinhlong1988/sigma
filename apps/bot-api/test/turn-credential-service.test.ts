// SIGMA Phase 4 (30/7) — test turn-credential-service.ts. HMAC thuần, KHÔNG cần DB/network — verify ĐÚNG
// giao thức TURN REST API (draft-uberti-behave-turn-rest-00): username = "<expiry>:<agentId>", credential =
// base64(HMAC-SHA1(secret, username)) — tự tính lại bằng crypto Node thuần để so khớp, KHÔNG suy đoán.
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateTurnCredentials, TurnConfigError } from '../src/turn-credential-service.js';

const ENV_KEYS = ['TURN_SHARED_SECRET', 'TURN_SERVER_URIS', 'TURN_CREDENTIAL_TTL_SECONDS'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

describe('turn-credential-service — generateTurnCredentials', () => {
  it('username = "<expiry>:<agentId>", credential = base64(HMAC-SHA1(secret, username)) — verify lại bằng crypto thuần', () => {
    process.env.TURN_SHARED_SECRET = 'secret-test-123';
    process.env.TURN_SERVER_URIS = 'turn:127.0.0.1:3478,turns:127.0.0.1:5349';
    process.env.TURN_CREDENTIAL_TTL_SECONDS = '600';

    const now = 1_800_000_000_000; // mốc cố định — test KHÔNG phụ thuộc đồng hồ máy chạy thật.
    const creds = generateTurnCredentials(42, now);

    const expectedExpiry = Math.floor(now / 1000) + 600;
    expect(creds.username).toBe(`${expectedExpiry}:42`);
    const expectedCredential = createHmac('sha1', 'secret-test-123').update(creds.username).digest('base64');
    expect(creds.credential).toBe(expectedCredential);
    expect(creds.ttl).toBe(600);
    expect(creds.uris).toEqual(['turn:127.0.0.1:3478', 'turns:127.0.0.1:5349']);
  });

  it('TTL mặc định 600s khi KHÔNG cấu hình TURN_CREDENTIAL_TTL_SECONDS', () => {
    process.env.TURN_SHARED_SECRET = 'secret-default-ttl';
    process.env.TURN_SERVER_URIS = 'turn:127.0.0.1:3478';
    delete process.env.TURN_CREDENTIAL_TTL_SECONDS;

    const creds = generateTurnCredentials(1, 1_000_000_000_000);
    expect(creds.ttl).toBe(600);
  });

  it('2 agentId khác nhau → username/credential khác nhau (KHÔNG dùng chung 1 vé cho mọi người)', () => {
    process.env.TURN_SHARED_SECRET = 'secret-distinct';
    process.env.TURN_SERVER_URIS = 'turn:127.0.0.1:3478';

    const now = 1_800_000_000_000;
    const credsA = generateTurnCredentials(1, now);
    const credsB = generateTurnCredentials(2, now);
    expect(credsA.username).not.toBe(credsB.username);
    expect(credsA.credential).not.toBe(credsB.credential);
  });

  it('thiếu TURN_SHARED_SECRET → TurnConfigError TURN_SHARED_SECRET_NOT_CONFIGURED', () => {
    delete process.env.TURN_SHARED_SECRET;
    process.env.TURN_SERVER_URIS = 'turn:127.0.0.1:3478';
    expect(() => generateTurnCredentials(1)).toThrow(TurnConfigError);
    try {
      generateTurnCredentials(1);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(TurnConfigError);
      expect((err as TurnConfigError).code).toBe('TURN_SHARED_SECRET_NOT_CONFIGURED');
    }
  });

  it('thiếu TURN_SERVER_URIS → TurnConfigError TURN_SERVER_URIS_NOT_CONFIGURED', () => {
    process.env.TURN_SHARED_SECRET = 'secret-x';
    delete process.env.TURN_SERVER_URIS;
    expect(() => generateTurnCredentials(1)).toThrow(TurnConfigError);
  });

  it('TURN_SERVER_URIS chỉ toàn khoảng trắng/dấu phẩy rỗng → TurnConfigError (parse ra rỗng)', () => {
    process.env.TURN_SHARED_SECRET = 'secret-y';
    process.env.TURN_SERVER_URIS = ' , , ';
    expect(() => generateTurnCredentials(1)).toThrow(TurnConfigError);
  });

  it('TURN_CREDENTIAL_TTL_SECONDS không phải số hợp lệ → TurnConfigError', () => {
    process.env.TURN_SHARED_SECRET = 'secret-z';
    process.env.TURN_SERVER_URIS = 'turn:127.0.0.1:3478';
    process.env.TURN_CREDENTIAL_TTL_SECONDS = 'khong-phai-so';
    expect(() => generateTurnCredentials(1)).toThrow(TurnConfigError);
  });

  it('env đọc LÚC GỌI (không cache lúc import) — đổi secret giữa 2 lần gọi cho ra credential khác nhau', () => {
    process.env.TURN_SHARED_SECRET = 'secret-first';
    process.env.TURN_SERVER_URIS = 'turn:127.0.0.1:3478';
    const now = 1_800_000_000_000;
    const first = generateTurnCredentials(9, now);

    process.env.TURN_SHARED_SECRET = 'secret-second';
    const second = generateTurnCredentials(9, now);

    expect(first.username).toBe(second.username); // username không phụ thuộc secret
    expect(first.credential).not.toBe(second.credential); // nhưng credential (HMAC) phải đổi theo secret mới
  });
});
