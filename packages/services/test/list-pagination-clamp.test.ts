// FIX-PERF regression — chứng minh list TIER A (listProducts) CHẶN take ở max=500 dù client xin pageSize khổng lồ.
// Db giả in-memory HONOR count/skip/take (khác makeTable ở bill-explain.test.ts vốn bỏ qua take) để đo clamp THẬT
// trên >500 dòng. Chống DoS/kéo full-bảng lọt lại (loại bug này = thất bại quy trình test → khóa bằng test này).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { listProducts, type ServiceCtx } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

interface Row { id: number; deletedAt: Date | null; [k: string]: unknown }
/** Fake table HONORING where(deletedAt) + count + skip + take — đủ để đo clamp phân trang thật. */
function makePagedTable(seed: Row[]) {
  const rows = seed.map((r) => ({ ...r }));
  const matching = (w: Record<string, unknown> = {}) =>
    rows.filter((r) => (!('deletedAt' in w) || r.deletedAt === (w['deletedAt'] ?? null))).sort((a, b) => a.id - b.id);
  return {
    rows,
    count: async (args?: { where?: Record<string, unknown> }) => matching(args?.where ?? {}).length,
    findMany: async (args?: { where?: Record<string, unknown>; skip?: number; take?: number }) => {
      let out = matching(args?.where ?? {});
      const skip = args?.skip ?? 0;
      const take = args?.take;
      out = out.slice(skip, take === undefined ? undefined : skip + take);
      return out.map((r) => ({ ...r }));
    }
  };
}

const ctx = (fake: Record<string, unknown>, perms: string[]): ServiceCtx => ({ db: fake as unknown as Db, user: authUser(perms) });

describe('list pagination hard-cap (TIER A)', () => {
  it('listProducts: pageSize khổng lồ → kẹp về 500 + data.length ≤ 500 + total phản ánh toàn bảng', async () => {
    const seed: Row[] = [];
    for (let i = 1; i <= 600; i++) {
      seed.push({ id: i, industryId: 1, name: `SP${i}`, unit: 'cái', price: 1000, priority: 0, status: 'ACTIVE', deletedAt: null, createdBy: 42, updatedBy: null, createdAt: new Date(), updatedAt: new Date() } as Row);
    }
    const fake: Record<string, unknown> = {
      product: makePagedTable(seed),
      industry: { findMany: async () => [{ id: 1, name: 'Bán lẻ' }] },
      user: { findMany: async () => [{ id: 42, fullName: 'Người Kiểm Thử', username: 'tester' }] }
    };
    const r = await listProducts(ctx(fake, ['BILLEXPLAIN_VIEW']), { pageSize: 9999 });
    expect(r.ok).toBe(true);
    expect(r.pageSize).toBe(500); // kẹp về MAX
    expect(r.page).toBe(1);
    expect(r.total).toBe(600); // count toàn bộ, không bị take giới hạn
    expect(r.data!.length).toBe(500); // findMany bị take=500 chặn
    expect(r.data!.length).toBeLessThanOrEqual(500);
  });
});
