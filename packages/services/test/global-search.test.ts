// Test LÕI THUẦN global-search core (@sigma/services, CHỈ ĐỌC). ASSERT: <2 ký tự → rỗng; lọc theo quyền (chỉ
// CUSTOMER_VIEW → chỉ nhóm customer); lỗi unaccent → SEARCH_FAILED message tiếng Việt. me()/getDb() đã thay ctx.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { globalSearch } from '../src/index.js';

function makeFakeDb(queryRaw: (...args: unknown[]) => Promise<unknown[]>) {
  const fake = { $queryRaw: queryRaw };
  return { db: fake as unknown as Db };
}

function authUser(permissions: string[]): AuthUser {
  return { id: 1, username: 'u', fullName: 'U', status: 'ACTIVE', forceChangePassword: false, roles: ['STAFF'], permissions };
}

describe('globalSearch', () => {
  it('query < 2 ký tự → ok data rỗng (không phát truy vấn)', async () => {
    let called = 0;
    const { db } = makeFakeDb(async () => { called++; return []; });
    const r = await globalSearch({ db, user: authUser(['CUSTOMER_VIEW']) }, 'a');
    expect(r.ok).toBe(true);
    expect(r.data).toEqual([]);
    expect(called).toBe(0);
  });

  it('chỉ CUSTOMER_VIEW → chỉ trả nhóm customer', async () => {
    const { db } = makeFakeDb(async () => [{ id: 5, code: 'KH05', full_name: 'Nguyễn Đức Dũng', phone: '0900' }]);
    const r = await globalSearch({ db, user: authUser(['CUSTOMER_VIEW']) }, 'dung');
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.data![0]!.kind).toBe('customer');
    expect(r.data![0]!.code).toBe('KH05');
    expect(r.data![0]!.page).toBe('revdebt');
  });

  it('thiếu unaccent (DB ném) → SEARCH_FAILED message tiếng Việt', async () => {
    const { db } = makeFakeDb(async () => { throw new Error('function unaccent(text) does not exist'); });
    const r = await globalSearch({ db, user: authUser(['CUSTOMER_VIEW']) }, 'abc');
    expect(r.ok).toBe(false);
    expect(r.error).toBe('SEARCH_FAILED');
    expect(r.message).toContain('unaccent');
  });
});
