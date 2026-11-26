// Test LÕI THUẦN message core (@sigma/services). ASSERT: FORBIDDEN (MESSAGE_VIEW/MESSAGE_SEND), inbox chỉ của
// chính mình + senderName, markRead chặn thư người khác, sendMessage validate + audit MESSAGE_SENT.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { listInbox, unreadCount, markRead, sendMessage } from '../src/index.js';

interface FakeMsg {
  id: number; kind: string; category: string | null; subject: string; body: string; senderId: number | null;
  recipientId: number; readAt: Date | null; createdAt: Date; deletedAt: Date | null;
}

function makeFakeDb(seed: FakeMsg[]) {
  const msgs = seed.map((m) => ({ ...m }));
  const audits: Record<string, unknown>[] = [];
  let nextId = msgs.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  const fake = {
    message: {
      findMany: async ({ where }: { where: { recipientId: number } }) => msgs.filter((m) => m.recipientId === where.recipientId && m.deletedAt === null).map((m) => ({ ...m })),
      count: async ({ where }: { where: { recipientId: number } }) => msgs.filter((m) => m.recipientId === where.recipientId && m.deletedAt === null && m.readAt === null).length,
      findUnique: async ({ where }: { where: { id: number } }) => { const m = msgs.find((x) => x.id === where.id); return m ? { ...m } : null; },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const m = msgs.find((x) => x.id === where.id)!; Object.assign(m, data); return { ...m }; },
      updateMany: async () => ({ count: 0 }),
      create: async ({ data }: { data: Record<string, unknown> }) => { const m = { id: nextId++, readAt: null, createdAt: new Date(), deletedAt: null, category: null, ...data } as unknown as FakeMsg; msgs.push(m); return { ...m }; }
    },
    user: {
      findMany: async () => [{ id: 9, fullName: 'Người Gửi' }],
      findFirst: async ({ where }: { where: { id: number } }) => (where.id === 20 ? { id: 20 } : null)
    },
    auditLog: { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } },
    changeToken: { upsert: async () => ({ domain: 'User', version: 1 }) }
  };
  return { db: fake as unknown as Db, msgs, audits };
}

function authUser(permissions: string[], id = 7): AuthUser {
  return { id, username: 'u', fullName: 'U', status: 'ACTIVE', forceChangePassword: false, roles: ['STAFF'], permissions };
}

function seedMsg(over: Partial<FakeMsg> = {}): FakeMsg {
  return { id: 1, kind: 'USER', category: null, subject: 'Chào', body: 'Nội dung', senderId: 9, recipientId: 7, readAt: null, createdAt: new Date('2026-01-01'), deletedAt: null, ...over };
}

describe('listInbox / unreadCount', () => {
  it('thiếu quyền MESSAGE_VIEW → FORBIDDEN nguyên văn', async () => {
    const { db } = makeFakeDb([seedMsg()]);
    const r = await listInbox({ db, user: authUser([]) });
    expect(r.error).toBe('FORBIDDEN');
    expect(r.message).toBe('Bạn không có quyền thực hiện thao tác này.');
  });

  it('inbox chỉ của mình + senderName; unreadCount đếm đúng', async () => {
    const { db } = makeFakeDb([seedMsg(), seedMsg({ id: 2, recipientId: 99 })]);
    const ctx = { db, user: authUser(['MESSAGE_VIEW']) };
    const inbox = await listInbox(ctx);
    expect(inbox.data).toHaveLength(1);
    expect(inbox.data![0]!.senderName).toBe('Người Gửi');
    const n = await unreadCount(ctx);
    expect(n.data).toBe(1);
  });
});

describe('markRead / sendMessage', () => {
  it('markRead thư người khác → NOT_FOUND', async () => {
    const { db } = makeFakeDb([seedMsg({ id: 1, recipientId: 99 })]);
    const r = await markRead({ db, user: authUser(['MESSAGE_VIEW']) }, 1);
    expect(r.error).toBe('NOT_FOUND');
    expect(r.message).toBe('Không tìm thấy thư.');
  });

  it('sendMessage thiếu tiêu đề → EMPTY_SUBJECT', async () => {
    const { db } = makeFakeDb([]);
    const r = await sendMessage({ db, user: authUser(['MESSAGE_SEND']) }, { recipientId: 20, subject: '  ', body: 'x' });
    expect(r.error).toBe('EMPTY_SUBJECT');
    expect(r.message).toBe('Vui lòng nhập tiêu đề thư.');
  });

  it('sendMessage người nhận không tồn tại → NO_RECIPIENT', async () => {
    const { db } = makeFakeDb([]);
    const r = await sendMessage({ db, user: authUser(['MESSAGE_SEND']) }, { recipientId: 999, subject: 'Hi', body: 'x' });
    expect(r.error).toBe('NO_RECIPIENT');
  });

  it('sendMessage hợp lệ → tạo + audit MESSAGE_SENT', async () => {
    const { db, msgs, audits } = makeFakeDb([]);
    const r = await sendMessage({ db, user: authUser(['MESSAGE_SEND']) }, { recipientId: 20, subject: 'Hi', body: 'Xin chào' });
    expect(r.ok).toBe(true);
    expect(msgs.some((m) => m.subject === 'Hi')).toBe(true);
    expect(audits.some((a) => a['action'] === 'MESSAGE_SENT')).toBe(true);
  });
});
