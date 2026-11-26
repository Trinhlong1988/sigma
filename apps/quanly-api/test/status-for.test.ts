// Unit test THUẦN cho statusFor (_ctx.ts) — map mã lỗi nghiệp vụ core → HTTP status. KHÔNG cần Db/Postgres.
// Đóng lỗ B (dọn nợ): nhiều mã conflict (đang-dùng/trùng/khóa/đã-xử-lý) TRƯỚC ĐÂY rơi default 400 → nay 409.
// Bảng dưới đây là HỢP ĐỒNG: mọi mã `error: '...'` mà packages/services + business-rules trả về PHẢI có đúng status.
import { describe, it, expect } from 'vitest';
import { statusFor } from '../src/routes/_ctx.js';

describe('statusFor — mapping mã lỗi nghiệp vụ → HTTP status', () => {
  it('ok=true → 200 (bất kể error)', () => {
    expect(statusFor({ ok: true })).toBe(200);
  });

  const cases: Array<[string, number]> = [
    // 403 — thiếu quyền / cấm hành động
    ['FORBIDDEN', 403],
    ['FORBIDDEN_ENTITY', 403],
    ['SELF_APPROVAL_FORBIDDEN', 403],
    ['MANAGER_SCOPE', 403],
    ['GRANT_ESCALATION', 403],
    ['SELF_ESCALATION', 403],
    ['SELF_DELETE', 403],
    ['NEED_ELEVATED', 403],
    // 401 — chưa xác thực
    ['NOT_AUTHENTICATED', 401],
    // 404 — không tìm thấy
    ['NOT_FOUND', 404],
    // 400 — validation
    ['VALIDATION', 400],
    // 409 — đã có sẵn (regression)
    ['STALE_WRITE', 409],
    ['IN_USE', 409],
    ['DUPLICATE', 409],
    ['DUPLICATE_TRASH', 409],
    ['PNL_FLAG_FORBIDDEN', 409],
    ['SYSTEM_LOCKED', 409],
    ['BUILTIN_LOCKED', 409],
    ['WRONG_PASSWORD', 409],
    ['WRONG_LEVEL2', 409],
    ['LEVEL2_NOT_SET', 409],
    // 409 — MỚI bổ sung (đây là phần dọn nợ chính)
    ['CONFLICT', 409],
    ['INVALID_STATE', 409],
    ['DEVICE_HAS_TID', 409],
    ['TID_ON_DEVICE', 409],
    ['ALREADY_DELIVERED', 409],
    ['ALREADY_DECIDED', 409],
    ['ALREADY_PENDING', 409],
    ['ALREADY_SETTLED', 409],
    ['ALREADY_WRITTEN_OFF', 409],
    ['LAST_ADMIN', 409],
    ['TXN_CANCELLED', 409],
    ['NOT_DELETED', 409],
    ['NOT_BAD_DEBT', 409],
    ['CUSTOMER_INACTIVE', 409],
    ['SOURCE_LOCKED', 409],
    ['BILL_IMMUTABLE', 409],
    ['DEBT_FULLY_PAID', 409],
    ['ROLE_ALREADY_ACTIVE', 409],
    ['ROLE_ALREADY_LOCKED', 409],
    ['ROLE_HAS_USERS', 409],
    ['ROLE_IS_SYSTEM_ADMIN', 409]
  ];

  it.each(cases)('error=%s → %i', (error, status) => {
    expect(statusFor({ ok: false, error })).toBe(status);
  });

  // Lỗi input client thật → default 400.
  const defaults400 = [
    'BANK_MISMATCH', 'CARD_BANK_MISMATCH', 'PARTNER_MISMATCH', 'BAD_ENTITY', 'MACHINE_BLANK',
    'DEBT_SIDE_CATEGORY_MISMATCH', 'WAREHOUSE_NO_ADDRESS', 'NO_WAREHOUSE', 'USE_SALE_FLOW',
    'PARTNER_SOURCE_CONFLICT', 'TOO_MANY_ROWS', 'PAYER_REQUIRED', 'NO_RECIPIENT', 'NO_PARTNER',
    'NO_FILE', 'NO_FEE_RATE', 'NO_SELL_QUOTE', 'NOT_LINKED', 'NOTHING_SELECTED', 'EMPTY',
    'EMPTY_BODY', 'EMPTY_SUBJECT', 'BAD_PATH', 'BAD_CONTENT', 'DEBT_RECEIPT_DEFERRED',
    'DEBT_SETTLE_DISABLED', 'CONFIG', 'BAD_DEBT_CATEGORY_MISSING', 'UNKNOWN_EVENT',
    'MÃ_LẠ_KHÔNG_TỒN_TẠI'
  ];
  it.each(defaults400)('error=%s → 400 (default)', (error) => {
    expect(statusFor({ ok: false, error })).toBe(400);
  });

  // 500 — lỗi HẠ TẦNG server-side (không phải lỗi input client) → phải 5xx để giám sát bắt được (audit 20/8).
  const infra500 = ['BACKUP_FAILED', 'MIRROR_UNWRITABLE', 'EXCEPTION', 'SEARCH_FAILED'];
  it.each(infra500)('error=%s → 500 (hạ tầng)', (error) => {
    expect(statusFor({ ok: false, error })).toBe(500);
  });

  it('error undefined → 400 (default)', () => {
    expect(statusFor({ ok: false })).toBe(400);
  });
});
