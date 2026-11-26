import { describe, it, expect, beforeEach } from 'vitest';
import {
  verifyBillEditPassword,
  setBillEditPassword,
  isBillEditPasswordSet
} from '../src/bill-edit-password-service';

// Fake app_settings in-memory (mô phỏng prisma appSetting findUnique/upsert theo key).
function makeDb() {
  const store = new Map<string, string>();
  return {
    _store: store,
    appSetting: {
      findUnique: async ({ where }: { where: { key: string } }) =>
        store.has(where.key) ? { value: store.get(where.key)! } : null,
      upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: { key: string; value: string } }) => {
        store.set(where.key, store.has(where.key) ? update.value : create.value);
        return {};
      }
    }
  };
}

describe('bill-edit-password-service', () => {
  let db: ReturnType<typeof makeDb>;
  beforeEach(() => { db = makeDb(); });

  it('CHƯA set: chỉ mật khẩu mặc định 1111 đúng', async () => {
    expect(await isBillEditPasswordSet(db)).toBe(false);
    expect(await verifyBillEditPassword(db, '1111')).toBe(true);
    expect(await verifyBillEditPassword(db, '0000')).toBe(false);
    expect(await verifyBillEditPassword(db, '')).toBe(false);
  });

  it('đổi mật khẩu: KHÔNG allowlist (kể cả agent "long trịnh" user4) → FORBIDDEN (không ghi gì)', async () => {
    expect(await setBillEditPassword(db, 'hainam@sigma.com.vn', '1111', '2468')).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(await setBillEditPassword(db, 'user4@example.com', '1111', '2468')).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(await setBillEditPassword(db, null, '1111', '2468')).toEqual({ ok: false, error: 'FORBIDDEN' });
    expect(await isBillEditPasswordSet(db)).toBe(false);
    expect(await verifyBillEditPassword(db, '1111')).toBe(true); // vẫn mặc định
  });

  it('đổi mật khẩu: allowlist nhưng SAI mật khẩu hiện tại → CURRENT_PASSWORD_WRONG', async () => {
    const r = await setBillEditPassword(db, 'user1@example.com', '9999', '246810'); // new ≥6 để qua length, tới current-check
    expect(r).toEqual({ ok: false, error: 'CURRENT_PASSWORD_WRONG' });
    expect(await isBillEditPasswordSet(db)).toBe(false);
  });

  it('đổi mật khẩu: mật khẩu mới quá ngắn (<6, SEC-HIGH 1/9) → PASSWORD_TOO_SHORT', async () => {
    expect(await setBillEditPassword(db, '<DIEN_VAO>', '1111', '12')).toEqual({ ok: false, error: 'PASSWORD_TOO_SHORT' });
    expect(await setBillEditPassword(db, '<DIEN_VAO>', '1111', '12345')).toEqual({ ok: false, error: 'PASSWORD_TOO_SHORT' }); // 5 ký tự vẫn quá ngắn
  });

  it('allowlist khớp email KHÔNG phân biệt hoa/thường', async () => {
    const r = await setBillEditPassword(db, 'user5@example.com', '1111', '246810');
    expect(r).toEqual({ ok: true });
  });

  it('setup từ mặc định: Nguoi Dung Demo (demo) đổi 1111 → mật khẩu mới, cũ hết hiệu lực', async () => {
    const r = await setBillEditPassword(db, '<DIEN_VAO>', '1111', '246810');
    expect(r).toEqual({ ok: true });
    expect(await isBillEditPasswordSet(db)).toBe(true);
    expect(await verifyBillEditPassword(db, '246810')).toBe(true);
    expect(await verifyBillEditPassword(db, '1111')).toBe(false); // mặc định hết hiệu lực sau khi set
  });

  it('đổi lần 2: Nhân viên B phải nhập ĐÚNG mật khẩu hiện tại (không phải 1111) mới đổi được', async () => {
    await setBillEditPassword(db, '<DIEN_VAO>', '1111', 'firstpw');
    // dùng lại 1111 làm current → phải fail
    expect(await setBillEditPassword(db, 'user1@example.com', '1111', 'secondpw')).toEqual({ ok: false, error: 'CURRENT_PASSWORD_WRONG' });
    // dùng đúng current 'firstpw' → ok
    expect(await setBillEditPassword(db, 'user1@example.com', 'firstpw', 'secondpw')).toEqual({ ok: true });
    expect(await verifyBillEditPassword(db, 'secondpw')).toBe(true);
    expect(await verifyBillEditPassword(db, 'firstpw')).toBe(false);
  });
});
