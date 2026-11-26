// Test LÕI THUẦN trash-service (@sigma/services) — Db GIẢ in-memory. ASSERT error code + message tiếng Việt + phục hồi/
// xóa cứng/dọn sạch + audit. §14 mật khẩu (cấp 1) + cấp 2 ở ADAPTER (lõi KHÔNG kiểm).
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { listTrash, linkSummary, restoreItem, purgeItem, emptyTrash, isTrashEntity, type ServiceCtx } from '../src/index.js';

function authUser(id: number, permissions: string[]): AuthUser {
  return { id, username: `u${id}`, fullName: `User ${id}`, status: 'ACTIVE', forceChangePassword: false, roles: ['R'], permissions };
}

// 18 model key thùng rác + phụ (posDevice/partnerBank/feeSellQuote/user) cho linkSummary/clearDeleted.
const TRASH_KEYS = ['customer', 'agent', 'bank', 'cardType', 'partner', 'supplier', 'posModel', 'posIntakeStatus', 'posIntake', 'feeType', 'feeRate', 'receiveAccountSource', 'receiveAccount', 'dossierSource', 'dossier', 'tidConfigStatus', 'tid', 'transaction'];

function makeTable(rows: Record<string, unknown>[]) {
  return {
    rows,
    findMany: async ({ where }: { where?: Record<string, unknown> } = {}) => rows.filter((r) => {
      if (!where) return true;
      if ('deletedAt' in where) {
        const w = where['deletedAt'];
        const del = w !== null && typeof w === 'object' && 'not' in (w as object); // { not: null } = đã xóa
        if (del && r['deletedAt'] == null) return false;
        if (!del && r['deletedAt'] !== (w ?? null)) return false;
      }
      if ('deletedBy' in where && r['deletedBy'] !== where['deletedBy']) return false;
      return true;
    }).map((r) => ({ ...r })),
    findUnique: async ({ where }: { where: { id: number } }) => rows.find((r) => r['id'] === where.id) ?? null,
    update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => { const r = rows.find((x) => x['id'] === where.id)!; Object.assign(r, data); return { ...r }; },
    delete: async ({ where }: { where: { id: number } }) => { const i = rows.findIndex((x) => x['id'] === where.id); const [r] = rows.splice(i, 1); return r; },
    deleteMany: async ({ where }: { where?: Record<string, unknown> } = {}) => {
      const before = rows.length;
      const keep = rows.filter((r) => !(where && 'deletedAt' in where ? r['deletedAt'] != null : true));
      const removed = before - keep.length;
      rows.length = 0; rows.push(...keep);
      return { count: removed };
    },
    count: async () => 0
  };
}

function makeDb(seed: Record<string, Record<string, unknown>[]> = {}) {
  const audits: Record<string, unknown>[] = [];
  const tables: Record<string, ReturnType<typeof makeTable>> = {};
  for (const k of [...TRASH_KEYS, 'posDevice', 'partnerBank', 'feeSellQuote']) tables[k] = makeTable(seed[k] ?? []);
  const db: Record<string, unknown> = { ...tables };
  db['user'] = { findMany: async ({ where }: { where: { id: { in: number[] } } }) => (seed['user'] ?? []).filter((u) => where.id.in.includes(u['id'] as number)).map((u) => ({ id: u['id'], fullName: u['fullName'] })) };
  db['auditLog'] = { create: async ({ data }: { data: Record<string, unknown> }) => { audits.push({ ...data }); return { ...data }; } };
  db['changeToken'] = { upsert: async () => ({}) };
  // [B317 24/11] purge TID kiểm dòng tiền + emptyTrash xoá TID-không-tiền qua raw SQL. Mock: TID sạch
  // (0 lo_rows/transactions) ⇒ purge không bị chặn; emptyTrash raw trả số TID đã-xoá-mềm xoá được.
  db['$queryRawUnsafe'] = async (sql: string) => {
    if (sql.includes('lo_rows')) return [{ lo: 0, gd: 0 }]; // TID test không dính tiền
    return [];
  };
  db['$executeRawUnsafe'] = async (sql: string) => {
    if (sql.includes('DELETE FROM tids')) {
      const t = tables['tid']; if (!t) return 0;
      const toDel = t.rows.filter((x) => x['deletedAt'] != null);
      for (const r of toDel) { const i = t.rows.indexOf(r); if (i >= 0) t.rows.splice(i, 1); }
      return toDel.length;
    }
    return 0;
  };
  return { db: db as unknown as Db, tables, audits };
}
const ctx = (db: Db, user: AuthUser): ServiceCtx => ({ db, user });

describe('trash-service — isTrashEntity', () => {
  it('nhận loại hợp lệ, loại lạ trả false', () => {
    expect(isTrashEntity('Customer')).toBe(true);
    expect(isTrashEntity('Fund')).toBe(false);
  });
});

describe('trash-service — listTrash', () => {
  it('thiếu quyền TRASH_VIEW → FORBIDDEN', async () => {
    const { db } = makeDb();
    const r = await listTrash(ctx(db, authUser(1, [])));
    expect(r.error).toBe('FORBIDDEN');
  });

  it('liệt kê bản ghi đã xóa + resolve tên người xóa', async () => {
    const { db } = makeDb({
      customer: [{ id: 1, code: 'KH01', nickname: 'A', fullName: 'Khách A', deletedAt: new Date('2026-01-02'), deletedBy: 7 }],
      user: [{ id: 7, fullName: 'Người Xóa' }]
    });
    const r = await listTrash(ctx(db, authUser(9, ['TRASH_VIEW', 'TRASH_VIEW_ALL'])));
    expect(r.ok).toBe(true);
    expect(r.data!.length).toBe(1);
    expect(r.data![0]!.entityType).toBe('Customer');
    expect(r.data![0]!.entityLabel).toBe('Khách hàng');
    expect(r.data![0]!.deletedByName).toBe('Người Xóa');
  });
});

describe('trash-service — linkSummary', () => {
  it('loại lạ → BAD_ENTITY', async () => {
    const { db } = makeDb();
    const r = await linkSummary(ctx(db, authUser(1, ['TRASH_VIEW'])), 'Fund', 1);
    expect(r.error).toBe('BAD_ENTITY');
  });
});

describe('trash-service — restoreItem', () => {
  it('chưa xóa → NOT_DELETED', async () => {
    const { db } = makeDb({ customer: [{ id: 1, code: 'KH01', deletedAt: null }] });
    const r = await restoreItem(ctx(db, authUser(1, ['TRASH_RESTORE'])), 'Customer', 1);
    expect(r.error).toBe('NOT_DELETED');
  });

  it('đã xóa → phục hồi (clear deletedAt) + audit RESTORE_EXECUTED', async () => {
    // Bản ghi do user 3 xóa; actor 1 có TRASH_VIEW_ALL → được phục hồi đồ người khác (đường Admin/Manager).
    const { db, tables, audits } = makeDb({ customer: [{ id: 1, code: 'KH01', deletedAt: new Date(), deletedBy: 3 }] });
    const r = await restoreItem(ctx(db, authUser(1, ['TRASH_RESTORE', 'TRASH_VIEW_ALL'])), 'Customer', 1);
    expect(r.ok).toBe(true);
    expect(tables['customer']!.rows[0]!['deletedAt']).toBeNull();
    expect(audits.some((a) => a['action'] === 'RESTORE_EXECUTED')).toBe(true);
  });

  it('phục hồi ĐỒ MÌNH xóa KHÔNG cần TRASH_VIEW_ALL', async () => {
    const { db } = makeDb({ customer: [{ id: 1, code: 'KH01', deletedAt: new Date(), deletedBy: 5 }] });
    const r = await restoreItem(ctx(db, authUser(5, ['TRASH_RESTORE'])), 'Customer', 1);
    expect(r.ok).toBe(true);
  });

  it('IDOR: phục hồi ĐỒ NGƯỜI KHÁC mà KHÔNG có TRASH_VIEW_ALL → FORBIDDEN', async () => {
    const { db, tables } = makeDb({ customer: [{ id: 1, code: 'KH01', deletedAt: new Date(), deletedBy: 3 }] });
    const r = await restoreItem(ctx(db, authUser(1, ['TRASH_RESTORE'])), 'Customer', 1);
    expect(r.error).toBe('FORBIDDEN');
    expect(tables['customer']!.rows[0]!['deletedAt']).not.toBeNull(); // KHÔNG đụng dữ liệu
  });
});

describe('trash-service — purgeItem (mật khẩu ở ADAPTER)', () => {
  it('bản ghi chưa xóa → NOT_DELETED', async () => {
    const { db } = makeDb({ customer: [{ id: 1, code: 'KH01', deletedAt: null }] });
    const r = await purgeItem(ctx(db, authUser(1, ['TRASH_PURGE'])), 'Customer', 1);
    expect(r.error).toBe('NOT_DELETED');
  });

  it('bản ghi trong thùng rác → xóa cứng + audit TRASH_PURGED', async () => {
    // deletedBy trùng actor (1) → xóa vĩnh viễn đồ mình, không cần TRASH_VIEW_ALL.
    const { db, tables, audits } = makeDb({ customer: [{ id: 1, code: 'KH01', deletedAt: new Date(), deletedBy: 1 }] });
    const r = await purgeItem(ctx(db, authUser(1, ['TRASH_PURGE'])), 'Customer', 1);
    expect(r.ok).toBe(true);
    expect(tables['customer']!.rows.length).toBe(0);
    expect(audits.some((a) => a['action'] === 'TRASH_PURGED')).toBe(true);
  });

  it('IDOR: xóa vĩnh viễn ĐỒ NGƯỜI KHÁC mà KHÔNG có TRASH_VIEW_ALL → FORBIDDEN (giữ nguyên bản ghi)', async () => {
    const { db, tables } = makeDb({ customer: [{ id: 1, code: 'KH01', deletedAt: new Date(), deletedBy: 3 }] });
    const r = await purgeItem(ctx(db, authUser(1, ['TRASH_PURGE'])), 'Customer', 1);
    expect(r.error).toBe('FORBIDDEN');
    expect(tables['customer']!.rows.length).toBe(1);
  });

  it('Admin TRASH_VIEW_ALL xóa vĩnh viễn đồ người khác → OK', async () => {
    const { db, tables } = makeDb({ customer: [{ id: 1, code: 'KH01', deletedAt: new Date(), deletedBy: 3 }] });
    const r = await purgeItem(ctx(db, authUser(1, ['TRASH_PURGE', 'TRASH_VIEW_ALL'])), 'Customer', 1);
    expect(r.ok).toBe(true);
    expect(tables['customer']!.rows.length).toBe(0);
  });
});

describe('trash-service — emptyTrash (level2 ở ADAPTER)', () => {
  it('thiếu quyền → FORBIDDEN', async () => {
    const { db } = makeDb();
    const r = await emptyTrash(ctx(db, authUser(1, [])));
    expect(r.error).toBe('FORBIDDEN');
  });

  it('dọn sạch → xóa cứng mọi bản ghi đã xóa mềm + đếm purged + audit TRASH_EMPTIED', async () => {
    const { db, tables, audits } = makeDb({
      customer: [{ id: 1, deletedAt: new Date() }, { id: 2, deletedAt: null }],
      supplier: [{ id: 5, deletedAt: new Date() }]
    });
    const r = await emptyTrash(ctx(db, authUser(1, ['TRASH_PURGE'])));
    expect(r.ok).toBe(true);
    expect(r.purged).toBe(2); // 1 customer + 1 supplier đã xóa mềm
    expect(tables['customer']!.rows.length).toBe(1); // giữ bản chưa xóa
    expect(audits.some((a) => a['action'] === 'TRASH_EMPTIED')).toBe(true);
  });
});
