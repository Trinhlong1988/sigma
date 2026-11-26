// R201 (dead-IPC 21/8) — LÕI THUẦN: getAgentQrImage (đọc QR đại lý) + pushUndeliveredZalo (đẩy nhắc TID chưa giao,
// server-side) + composeUndeliveredMessage. Db GIẢ in-memory + ServiceCtx.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { getAgentQrImage, pushUndeliveredZalo, composeUndeliveredMessage, type ServiceCtx } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 7, username: 't', fullName: 'T', status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}
const ctx = (db: Db, perms: string[]): ServiceCtx => ({ db, user: authUser(perms) });

describe('getAgentQrImage — QR đại lý (CONFIG_RCV_ACCT_VIEW)', () => {
  const qrBytes = Uint8Array.from([1, 2, 3, 4]);
  function fake(agent: Record<string, unknown> | null) {
    return { agent: { findUnique: async ({ where }: { where: { id: number } }) => (agent && (agent.id === where.id) ? { ...agent } : null) } } as unknown as Db;
  }

  it('thiếu quyền → FORBIDDEN', async () => {
    const r = await getAgentQrImage(ctx(fake(null), []), 1);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('agentId không nguyên → VALIDATION', async () => {
    const r = await getAgentQrImage(ctx(fake(null), ['CONFIG_RCV_ACCT_VIEW']), 1.5);
    expect(r.error).toBe('VALIDATION');
  });

  it('đại lý không tồn tại → NOT_FOUND', async () => {
    const r = await getAgentQrImage(ctx(fake(null), ['CONFIG_RCV_ACCT_VIEW']), 1);
    expect(r.error).toBe('NOT_FOUND');
  });

  it('có QR → dataUrl base64 đúng + hasQr true', async () => {
    const db = fake({ id: 1, code: 'DL01', name: 'Đại lý 1', qrImage: qrBytes, qrImageMime: 'image/png', bankAccountLabel: 'VCB - 0123', qrUpdatedAt: new Date('2026-08-01T00:00:00.000Z'), deletedAt: null });
    const r = await getAgentQrImage(ctx(db, ['CONFIG_RCV_ACCT_VIEW']), 1);
    expect(r.ok).toBe(true);
    expect(r.data!.hasQr).toBe(true);
    expect(r.data!.dataUrl).toBe(`data:image/png;base64,${Buffer.from(qrBytes).toString('base64')}`);
    expect(r.data!.bankAccountLabel).toBe('VCB - 0123');
    expect(r.data!.qrUpdatedAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('chưa có QR → hasQr false + dataUrl null', async () => {
    const db = fake({ id: 1, code: 'DL01', name: 'Đại lý 1', qrImage: null, qrImageMime: null, bankAccountLabel: null, qrUpdatedAt: null, deletedAt: null });
    const r = await getAgentQrImage(ctx(db, ['CONFIG_RCV_ACCT_VIEW']), 1);
    expect(r.ok).toBe(true);
    expect(r.data!.hasQr).toBe(false);
    expect(r.data!.dataUrl).toBeNull();
  });

  it('đại lý đã xóa mềm → NOT_FOUND', async () => {
    const db = fake({ id: 1, code: 'DL01', name: 'Đại lý 1', qrImage: null, deletedAt: new Date() });
    const r = await getAgentQrImage(ctx(db, ['CONFIG_RCV_ACCT_VIEW']), 1);
    expect(r.error).toBe('NOT_FOUND');
  });
});

describe('composeUndeliveredMessage — thuần', () => {
  it('count 0 → lời chúc', () => {
    expect(composeUndeliveredMessage({ count: 0, totalAgingDays: 0, topAgingDays: 0, topTid: null })).toContain('KHÔNG có TID');
  });
  it('count>0 → nhắc kèm TID lâu nhất', () => {
    const s = composeUndeliveredMessage({ count: 2, totalAgingDays: 9, topAgingDays: 7, topTid: 'TID9' });
    expect(s).toContain('2 TID chưa giao');
    expect(s).toContain('TID9');
  });
});

describe('pushUndeliveredZalo — server-side action (TID_VIEW)', () => {
  // Fake rỗng: mọi bảng listUndeliveredTids + buildTidMaps đụng đều trả [].
  function emptyTidDb(): Db {
    const none = { findMany: async () => [] };
    return {
      tid: none, receiveAccount: none, customer: none, investor: none, customerChatGroup: none,
      tidSellFee: none, bank: none, partner: none, tidConfigStatus: none, dossierSource: none,
      agent: none, industry: none
    } as unknown as Db;
  }

  it('thiếu TID_VIEW → FORBIDDEN (stub)', async () => {
    const r = await pushUndeliveredZalo(ctx(emptyTidDb(), []));
    expect(r.ok).toBe(false);
    expect(r.stub).toBe(true);
    expect(r.error).toBe('FORBIDDEN');
  });

  it('có TID_VIEW + không TID chưa giao → ok stub + message lời chúc', async () => {
    const r = await pushUndeliveredZalo(ctx(emptyTidDb(), ['TID_VIEW']));
    expect(r.ok).toBe(true);
    expect(r.stub).toBe(true);
    expect(r.message).toContain('KHÔNG có TID');
  });
});
