// Test LÕI THUẦN settings core (@sigma/services) — Db GIẢ in-memory + ServiceCtx. ASSERT: quyền, upsert key/value,
// audit SETTING_UPDATED (before/after).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { listSettings, updateSetting } from '../src/index.js';

interface FakeSetting { key: string; value: string | null }

function makeFakeDb(seed: FakeSetting[]) {
  const settings = seed.map((s) => ({ ...s }));
  const audits: Record<string, unknown>[] = [];
  const appSetting = {
    findMany: async () => settings.map((s) => ({ ...s })).sort((a, b) => a.key.localeCompare(b.key)),
    findUnique: async ({ where }: { where: { key: string } }) => {
      const s = settings.find((x) => x.key === where.key);
      return s ? { ...s } : null;
    },
    upsert: async ({ where, update, create }: { where: { key: string }; update: { value: string }; create: FakeSetting }) => {
      const s = settings.find((x) => x.key === where.key);
      if (s) { s.value = update.value; return { ...s }; }
      const row = { ...create };
      settings.push(row);
      return { ...row };
    }
  };
  const fake = {
    appSetting,
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'System', version: 1 }) }
  };
  return { db: fake as unknown as Db, settings, audits };
}

function authUser(permissions: string[]): AuthUser {
  return { id: 42, username: 'tester', fullName: 'Người Kiểm Thử', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

describe('listSettings', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeFakeDb([{ key: 'a', value: '1' }]);
    const r = await listSettings({ db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });
  it('có quyền → data sắp theo key', async () => {
    const { db } = makeFakeDb([{ key: 'b', value: '2' }, { key: 'a', value: '1' }]);
    const r = await listSettings({ db, user: authUser(['SYSTEM_SETTING_VIEW']) });
    expect(r.ok).toBe(true);
    expect(r.data!.map((s) => s.key)).toEqual(['a', 'b']);
  });
});

describe('updateSetting', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeFakeDb([]);
    const r = await updateSetting({ db, user: authUser(['SYSTEM_SETTING_VIEW']) }, 'x', 'v');
    expect(r.error).toBe('FORBIDDEN');
  });

  it('upsert mới → ghi + audit SETTING_UPDATED (before null)', async () => {
    const { db, settings, audits } = makeFakeDb([]);
    const r = await updateSetting({ db, user: authUser(['SYSTEM_SETTING_UPDATE']) }, 'theme', 'dark');
    expect(r.ok).toBe(true);
    expect(settings.find((s) => s.key === 'theme')!.value).toBe('dark');
    const a = audits.find((x) => x['action'] === 'SETTING_UPDATED');
    expect(a).toBeTruthy();
    expect(String(a!['beforeJson'])).toBe('null');
    expect(String(a!['afterJson'])).toContain('dark');
  });

  it('cập nhật key cũ → before có giá trị cũ', async () => {
    const { db, settings, audits } = makeFakeDb([{ key: 'theme', value: 'light' }]);
    const r = await updateSetting({ db, user: authUser(['SYSTEM_SETTING_UPDATE']) }, 'theme', 'dark');
    expect(r.ok).toBe(true);
    expect(settings[0]!.value).toBe('dark');
    const a = audits.find((x) => x['action'] === 'SETTING_UPDATED');
    expect(String(a!['beforeJson'])).toContain('light');
  });
});
