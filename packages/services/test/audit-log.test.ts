// Test LÕI THUẦN audit-log core (@sigma/services, CHỈ ĐỌC). ASSERT: FORBIDDEN nguyên văn khi thiếu AUDIT_LOG_VIEW,
// và map đúng actorUsername + trường JSON khi có quyền.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { listAudit } from '../src/index.js';

function makeFakeDb() {
  const rows = [
    { id: 2, actorUserId: 7, action: 'USER_CREATED', targetType: 'User', targetId: '10', beforeJson: null, afterJson: '{"a":1}', ipAddress: null, deviceInfo: null, createdAt: new Date('2026-02-02'), actor: { username: 'admin' } },
    { id: 1, actorUserId: null, action: 'LOGIN', targetType: null, targetId: null, beforeJson: null, afterJson: null, ipAddress: null, deviceInfo: null, createdAt: new Date('2026-02-01'), actor: null }
  ];
  const fake = { auditLog: { findMany: async () => rows.map((r) => ({ ...r })) } };
  return { db: fake as unknown as Db };
}

function authUser(permissions: string[]): AuthUser {
  return { id: 7, username: 'admin', fullName: 'Admin', status: 'ACTIVE', forceChangePassword: false, roles: ['ADMIN'], permissions };
}

describe('listAudit', () => {
  it('thiếu quyền AUDIT_LOG_VIEW → FORBIDDEN nguyên văn', async () => {
    const r = await listAudit({ db: makeFakeDb().db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('có quyền → data + actorUsername (null khi actor null)', async () => {
    const r = await listAudit({ db: makeFakeDb().db, user: authUser(['AUDIT_LOG_VIEW']) });
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(2);
    expect(r.data![0]!.actorUsername).toBe('admin');
    expect(r.data![0]!.afterJson).toBe('{"a":1}');
    expect(r.data![1]!.actorUsername).toBeNull();
  });
});
