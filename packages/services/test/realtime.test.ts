// Test LÕI THUẦN realtime core (@sigma/services, CHỈ ĐỌC, poll-based). ASSERT: đọc ChangeToken → byDomain (BigInt→
// number ở biên), pendingCancels từ ApprovalRequest PENDING, và KHÔNG cần quyền riêng (chỉ cần phiên hợp lệ — user
// permission rỗng vẫn đọc được, khớp desktop chỉ validateCurrentSession).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { realtimeTokens } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 1, username: 'admin', fullName: 'Admin', status: 'ACTIVE', forceChangePassword: false, roles: ['ADMIN'], permissions };
}

describe('realtimeTokens', () => {
  it('đọc ChangeToken → byDomain (BigInt→number) + pendingCancels', async () => {
    const db = {
      changeToken: { findMany: async () => [{ domain: 'Customer', version: 5n }, { domain: 'Tid', version: 12n }] },
      approvalRequest: { count: async () => 3 }
    } as unknown as Db;
    const r = await realtimeTokens({ db, user: authUser([]) });
    expect(r.ok).toBe(true);
    expect(r.data!.byDomain).toEqual({ Customer: 5, Tid: 12 });
    // Ép BigInt→number ở biên đọc (nếu quên → là bigint, JSON.stringify sẽ throw).
    expect(typeof r.data!.byDomain['Customer']).toBe('number');
    expect(r.data!.pendingCancels).toBe(3);
    expect(typeof r.data!.serverNow).toBe('string');
  });

  it('KHÔNG cần quyền riêng — user permission rỗng vẫn đọc được (chỉ cần phiên hợp lệ)', async () => {
    const db = {
      changeToken: { findMany: async () => [] },
      approvalRequest: { count: async () => 0 }
    } as unknown as Db;
    const r = await realtimeTokens({ db, user: authUser([]) });
    expect(r.ok).toBe(true);
    expect(r.data!.byDomain).toEqual({});
    expect(r.data!.pendingCancels).toBe(0);
  });
});
