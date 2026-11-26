// Item 2 (audit 20/8) — bulk-delete + audit PHẢI nguyên tử: lỗi giữa vòng lặp → ROLLBACK cả mẻ (không còn cảnh vài
// quỹ đã xóa+commit, phần còn lại chưa, rồi ném 500). Fake $transaction mô phỏng snapshot+restore để chứng minh
// rollback thật (khác fake fund.test.ts chạy thẳng fn — không rollback).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { deleteFunds } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

/** Fake DB có $transaction snapshot+restore + fund.update NÉM khi gặp id = failOnUpdateId (mô phỏng lỗi giữa mẻ). */
function makeRollbackFake(seedRows: Record<string, unknown>[], failOnUpdateId: number) {
  const rows = seedRows.map((r) => ({ ...r }));
  const audits: Record<string, unknown>[] = [];
  const fake = {
    fund: {
      findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r['id'] === where.id) ?? null,
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
        if (where.id === failOnUpdateId) throw new Error('boom mid-loop');
        const r = rows.find((x) => x['id'] === where.id)!;
        Object.assign(r, data);
        return { ...r };
      }
    },
    cashEntry: { count: async () => 0 },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'Fund', version: 1 }) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = rows.map((r) => ({ ...r }));
      try {
        return await fn(fake);
      } catch (e) {
        // ROLLBACK: khôi phục MỌI hàng về ảnh chụp trước tx (mô phỏng Postgres rollback).
        rows.forEach((r, i) => Object.assign(r, snapshot[i]));
        throw e;
      }
    }
  };
  return { db: fake as unknown as Db, rows, audits };
}

const fund = (id: number): Record<string, unknown> => ({ id, code: `QU0${id}`, name: `Quỹ ${id}`, type: 'CASH', keeperUserId: null, openingBalance: 0, active: true, note: null, deletedAt: null, createdBy: 42, updatedBy: null, deletedBy: null, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01') });

describe('deleteFunds — nguyên tử (rollback khi lỗi giữa mẻ)', () => {
  it('lỗi ở id thứ 2 → ROLLBACK: id thứ 1 KHÔNG bị soft-delete + throw ra ngoài', async () => {
    const { db, rows } = makeRollbackFake([fund(1), fund(2)], /* failOnUpdateId */ 2);
    await expect(deleteFunds({ db, user: authUser(['FUND_DELETE']) }, [1, 2])).rejects.toThrow('boom mid-loop');
    // Bằng chứng rollback: quỹ 1 (đã update trong tx trước khi quỹ 2 nổ) được KHÔI PHỤC → deletedAt vẫn null.
    expect(rows[0]!['deletedAt']).toBeNull();
    expect(rows[1]!['deletedAt']).toBeNull();
  });

  it('không lỗi → cả mẻ soft-delete bình thường (đối chứng)', async () => {
    const { db, rows } = makeRollbackFake([fund(1), fund(2)], /* failOnUpdateId */ -1);
    const r = await deleteFunds({ db, user: authUser(['FUND_DELETE']) }, [1, 2]);
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(2);
    expect(rows[0]!['deletedAt']).toBeInstanceOf(Date);
    expect(rows[1]!['deletedAt']).toBeInstanceOf(Date);
  });
});
