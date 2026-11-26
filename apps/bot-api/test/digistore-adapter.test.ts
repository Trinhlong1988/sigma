// DIGISTORE ADAPTER — test PHÂN LOẠI LỖI (R198, Admin Demo "log báo lỗi tất cả trường hợp") + shape, bằng MOCK global
// fetch (KHÔNG gọi bank thật). Ca: NO_CRED / AUTH_FAILED (login 401) / NETWORK (fetch ném) / BAD_SHAPE (data lạ) +
// success (parse + phân trang). Token cache theo email → reset giữa test, dùng email khác nhau.
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { fetchBaoCo, DigistoreError, _resetTokenCacheForTest, type DigistoreCreds } from '../src/digistore-adapter.js';

const FROM = Date.parse('2026-09-05T00:00:00+07:00');
const TO = Date.parse('2026-09-05T23:59:59+07:00');

function creds(over: Partial<DigistoreCreds> = {}): DigistoreCreds {
  return { tidId: over.tidId ?? 1, base: over.base ?? 'https://mock-digistore.test', email: over.email ?? `m${Math.random().toString(36).slice(2)}@x`, password: over.password ?? 'pw', label: over.label ?? 'QR-TEST' };
}

/** Mock fetch định tuyến theo URL: /user/login vs /transaction/va. */
function mockFetch(handlers: { login?: () => unknown; txn?: () => unknown }): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const s = String(url);
    if (s.includes('/user/login')) return handlers.login ? handlers.login() : jsonRes({ data: { access_token: 'tok.tok.tok' } });
    if (s.includes('/transaction/va')) return handlers.txn ? handlers.txn() : jsonRes({ data: [] });
    throw new Error('unexpected url ' + s);
  }));
}
function jsonRes(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

beforeEach(() => { _resetTokenCacheForTest(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('fetchBaoCo — phân loại lỗi (DigistoreError.code)', () => {
  it('NO_CRED: creds thiếu email/password → NO_CRED (không gọi mạng)', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    await expect(fetchBaoCo({ email: '', password: '', base: 'https://x' }, FROM, TO)).rejects.toMatchObject({ code: 'NO_CRED' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('AUTH_FAILED: login HTTP 401 → AUTH_FAILED (kèm mã trong message)', async () => {
    mockFetch({ login: () => jsonRes({ msg: 'sai mat khau' }, 401) });
    try {
      await fetchBaoCo(creds({ label: 'QR-ABC' }), FROM, TO);
      throw new Error('LẼ RA ném');
    } catch (e) {
      expect(e).toBeInstanceOf(DigistoreError);
      expect((e as DigistoreError).code).toBe('AUTH_FAILED');
      expect((e as DigistoreError).message).toContain('QR-ABC');
    }
  });

  it('AUTH_FAILED: login 200 nhưng KHÔNG có access_token → AUTH_FAILED', async () => {
    mockFetch({ login: () => jsonRes({ data: {} }) });
    await expect(fetchBaoCo(creds(), FROM, TO)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('NETWORK: login fetch NÉM (timeout/DNS) → NETWORK', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ETIMEDOUT'); }));
    await expect(fetchBaoCo(creds(), FROM, TO)).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('NETWORK: login HTTP 500 → NETWORK (lỗi máy chủ, không phải sai mật khẩu)', async () => {
    mockFetch({ login: () => jsonRes({ msg: 'server error' }, 500) });
    await expect(fetchBaoCo(creds(), FROM, TO)).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('NETWORK: transaction/va HTTP 502 → NETWORK', async () => {
    mockFetch({ txn: () => jsonRes({}, 502) });
    await expect(fetchBaoCo(creds(), FROM, TO)).rejects.toMatchObject({ code: 'NETWORK' });
  });

  it('AUTH_FAILED: transaction/va 401 → re-login → vẫn 401 → AUTH_FAILED', async () => {
    mockFetch({ txn: () => jsonRes({}, 401) }); // login luôn OK, txn luôn 401
    await expect(fetchBaoCo(creds(), FROM, TO)).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('BAD_SHAPE: transaction/va 200 nhưng data là object lạ (không mảng) → BAD_SHAPE', async () => {
    mockFetch({ txn: () => jsonRes({ data: { unexpected: 'weird', foo: 1 } }) });
    await expect(fetchBaoCo(creds(), FROM, TO)).rejects.toMatchObject({ code: 'BAD_SHAPE' });
  });

  it('BAD_SHAPE: transaction/va body KHÔNG phải JSON → BAD_SHAPE', async () => {
    mockFetch({ txn: () => ({ ok: true, status: 200, json: async () => { throw new Error('invalid json'); } } as unknown as Response) });
    await expect(fetchBaoCo(creds(), FROM, TO)).rejects.toMatchObject({ code: 'BAD_SHAPE' });
  });
});

describe('fetchBaoCo — success + parse', () => {
  it('data mảng rỗng ([]) là HỢP LỆ (không ném) → trả []', async () => {
    mockFetch({ txn: () => jsonRes({ data: [] }) });
    expect(await fetchBaoCo(creds(), FROM, TO)).toEqual([]);
  });

  it('parse record + gắn sourceTidId từ creds.tidId + external_ref_no', async () => {
    mockFetch({
      txn: () => jsonRes({
        data: [{
          bill_id: 'BILL-1', va_account_receiver: '99MPC001', store_name: 'HKD DEMO 40', amount: 9198000,
          description: 'KHACH HANG 08 thanh toan QR - 99MPC001', external_ref_no: '6248VNIB024EN', created_at: '2026-09-05 14:30:00', status: 'success'
        }]
      })
    });
    const out = await fetchBaoCo(creds({ tidId: 42 }), FROM, TO);
    expect(out).toHaveLength(1);
    expect(out[0].billId).toBe('BILL-1');
    expect(out[0].amount).toBe(9198000);
    expect(out[0].externalRefNo).toBe('6248VNIB024EN');
    expect(out[0].payerName).toBe('KHACH HANG 08');
    expect(out[0].sourceTidId).toBe(42);
  });

  it('data lồng {records:[...]} vẫn tách được (shape bền)', async () => {
    mockFetch({ txn: () => jsonRes({ data: { records: [{ bill_id: 'B2', amount: 5000 }] } }) });
    const out = await fetchBaoCo(creds(), FROM, TO);
    expect(out).toHaveLength(1);
    expect(out[0].billId).toBe('B2');
  });
});
