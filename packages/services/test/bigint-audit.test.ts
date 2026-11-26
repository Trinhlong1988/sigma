// REGRESSION (B132 CRITICAL A4-1) — cột tiền int8/BigInt: writeAudit + writeAuditStrict phải serialize được
// khi input.after/before chứa BigInt (JSON.stringify vốn NÉM). Trước shim bigint-json.ts test này FAIL (throw);
// sau shim PASS (Number). Chặn tái diễn class "quên BigInt.toJSON khi port service tiền sang entry mới".
// Nối feedback_bigint_shim_mock_shape_audit_regression.
import { describe, it, expect } from 'vitest';
import { writeAudit, writeAuditStrict } from '../src/audit.js';

function fakeDb() {
  const rows: any[] = [];
  return { rows, db: { auditLog: { create: async ({ data }: any) => { rows.push(data); return data; } }, changeToken: { upsert: async () => ({}) } } as any };
}

describe('BigInt audit serialization (regression A4-1)', () => {
  it('writeAudit với after chứa BigInt (cột tiền) KHÔNG throw + ghi afterJson = số', async () => {
    const { db, rows } = fakeDb();
    await writeAudit(db, { actorUserId: 1, action: 'TRANSACTION_CREATED', targetType: 'Transaction', targetId: '1',
      after: { amount: 1000n, revenueAmount: 5000000000000n } });
    expect(rows.length).toBe(1); // audit GHI ĐƯỢC (trước shim: mất im vì throw bị nuốt)
    expect(rows[0].afterJson).toContain('"amount":1000');
    expect(rows[0].afterJson).toContain('5000000000000');
  });

  it('writeAuditStrict (in-transaction) với BigInt KHÔNG throw → không rollback', async () => {
    const { db } = fakeDb();
    await expect(writeAuditStrict(db, { actorUserId: 1, action: 'CUSTOMER_UPDATED', targetType: 'Transaction',
      targetId: '1', before: { revenueAmount: 999999999999n } })).resolves.toBeUndefined();
  });
});
