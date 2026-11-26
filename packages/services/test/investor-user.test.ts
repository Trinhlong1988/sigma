// Mục 2 — GÁN TÀI KHOẢN ĐĂNG NHẬP cho NĐT (bản tối giản: chọn user CÓ SẴN, KHÔNG tạo user mới). Kiểm ở LÕI:
//  (1) listInvestors join loginUsername đúng theo Investor.userId (user còn sống → username; userId null → null;
//      user đã xóa mềm → null — vì resolveLoginUsernames lọc deletedAt:null);
//  (2) KHÔNG N+1: dù nhiều NĐT có userId, users được nạp bằng ĐÚNG 1 findMany (đếm số lần gọi user.findMany
//      cho nhánh loginUsername = 1);
//  (3) updateInvestor set userId → lần list kế loginUsername phản ánh đúng; set userId=null → loginUsername null.
import { describe, it, expect } from 'vitest';
import type { Db } from '@sigma/database';
import type { AuthUser } from '@sigma/shared';
import { listInvestors, updateInvestor, type ServiceCtx } from '../src/index.js';

function authUser(permissions: string[]): AuthUser {
  return { id: 9, username: 'actor', fullName: 'Actor', status: 'ACTIVE', forceChangePassword: false, roles: ['ADMIN'], permissions };
}

interface FakeInvestor {
  id: number; code: string; fullName: string; nickname: string; status: string;
  phone: string | null; email: string | null; address: string | null; investFeeMilli: number;
  userId: number | null; note: string | null; createdBy: number | null;
  createdAt: Date; updatedAt: Date; deletedAt: Date | null;
}
interface FakeUser { id: number; username: string; fullName: string; deletedAt: Date | null }

function makeDb(investors: FakeInvestor[], users: FakeUser[]) {
  const now = new Date('2026-08-11T00:00:00.000Z');
  const inv = investors.map((r) => ({ ...r }));
  // Đếm riêng số lần gọi user.findMany theo có filter deletedAt:null (nhánh loginUsername) để bắt N+1.
  let loginFindManyCalls = 0;
  const db = {
    investor: {
      findMany: async ({ where }: { where?: { deletedAt?: null } } = {}) =>
        inv.filter((r) => (where?.deletedAt === null ? r.deletedAt === null : true)).sort((a, b) => b.id - a.id).map((r) => ({ ...r })),
      findUnique: async ({ where }: { where: { id: number } }) => {
        const r = inv.find((x) => x.id === where.id);
        return r ? { ...r } : null;
      },
      update: async ({ where, data }: { where: { id: number }; data: Record<string, unknown> }) => {
        const r = inv.find((x) => x.id === where.id)!;
        Object.assign(r, data);
        return { ...r };
      },
      // Money-F2 — validateInvestorUserId dup check (userId + deletedAt:null + NOT.id).
      findFirst: async ({ where }: { where: { userId?: number; NOT?: { id?: number } } }) => {
        const notId = where.NOT?.id;
        const r = inv.find((x) => x.userId === where.userId && x.deletedAt === null && (notId === undefined || x.id !== notId));
        return r ? { id: r.id } : null;
      }
    },
    user: {
      // Money-F2 — validateInvestorUserId tồn tại + còn sống.
      findUnique: async ({ where }: { where: { id: number } }) => { const u = users.find((x) => x.id === where.id); return u ? { id: u.id, deletedAt: u.deletedAt } : null; },
      findMany: async ({ where }: { where?: { id?: { in: number[] }; deletedAt?: null } } = {}) => {
        const ids = where?.id?.in ?? [];
        const filterDeleted = where?.deletedAt === null;
        if (filterDeleted) loginFindManyCalls++;
        return users
          .filter((u) => ids.includes(u.id) && (filterDeleted ? u.deletedAt === null : true))
          .map((u) => ({ id: u.id, username: u.username, fullName: u.fullName }));
      }
    },
    // Cột "Nhóm chat" (24/8) — resolveInvestorChatGroupNames đọc 2 model này; test này không gán nhóm nào → [].
    investorChatGroup: { findMany: async () => [] as unknown[] },
    chatRoom: { findMany: async () => [] as unknown[] },
    auditLog: { create: async () => ({}) },
    changeToken: { upsert: async () => ({}) },
    $executeRawUnsafe: async () => 0,
    // ATOMIC (audit 20/8) — create/updateInvestor bọc mutation+audit trong $transaction; fake chạy thẳng với chính nó.
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(db)
  };
  return { db: db as unknown as Db, get loginFindManyCalls() { return loginFindManyCalls; }, now };
}

function seed(now: Date): FakeInvestor[] {
  return [
    { id: 1, code: 'INV01', fullName: 'Nguyen A', nickname: 'A', status: 'ACTIVE', phone: null, email: null, address: null, investFeeMilli: 100, userId: 100, note: null, createdBy: null, createdAt: now, updatedAt: now, deletedAt: null },
    { id: 2, code: 'INV02', fullName: 'Tran B', nickname: 'B', status: 'ACTIVE', phone: null, email: null, address: null, investFeeMilli: 200, userId: null, note: null, createdBy: null, createdAt: now, updatedAt: now, deletedAt: null },
    { id: 3, code: 'INV03', fullName: 'Le C', nickname: 'C', status: 'ACTIVE', phone: null, email: null, address: null, investFeeMilli: 300, userId: 300, note: null, createdBy: null, createdAt: now, updatedAt: now, deletedAt: null }
  ];
}
const usersSeed = (): FakeUser[] => [
  { id: 100, username: 'ndtlogin01', fullName: 'Nguyen A', deletedAt: null },
  { id: 200, username: 'ndtlogin02', fullName: 'Pham D', deletedAt: null }, // user còn sống, CHƯA gắn NĐT nào
  { id: 300, username: 'ndtdeleted1', fullName: 'Le C', deletedAt: new Date('2026-08-01') } // user đã xóa mềm
];

describe('Mục 2 — loginUsername join (listInvestors)', () => {
  it('userId trỏ user còn sống → loginUsername = username; userId null → null; user đã xóa → null', async () => {
    const { db } = makeDb(seed(new Date('2026-08-11')), usersSeed());
    const r = await listInvestors({ db, user: authUser(['INVESTOR_VIEW']) });
    expect(r.ok).toBe(true);
    const byCode = Object.fromEntries(r.data!.map((x) => [x.code, x]));
    expect(byCode['INV01'].loginUsername).toBe('ndtlogin01'); // user còn sống
    expect(byCode['INV02'].loginUsername).toBeNull(); // chưa gắn
    expect(byCode['INV03'].loginUsername).toBeNull(); // user đã xóa mềm → không hiện
  });

  it('KHÔNG N+1: nhiều NĐT có userId nhưng chỉ 1 findMany cho loginUsername', async () => {
    const h = makeDb(seed(new Date('2026-08-11')), usersSeed());
    await listInvestors({ db: h.db, user: authUser(['INVESTOR_VIEW']) });
    expect(h.loginFindManyCalls).toBe(1);
  });

  it('updateInvestor set userId → list kế loginUsername phản ánh đúng; set null → null', async () => {
    const h = makeDb(seed(new Date('2026-08-11')), usersSeed());
    const ctx: ServiceCtx = { db: h.db, user: authUser(['INVESTOR_UPDATE', 'INVESTOR_VIEW']) };
    // Gắn user 200 (còn sống, chưa gắn NĐT nào) cho NĐT 2 (đang null). LƯU Ý (Money-F2): KHÔNG dùng user 100 vì
    // user 100 đã gắn NĐT 1 → nay bị chặn trùng (1 user = 1 NĐT).
    const u = await updateInvestor(ctx, 2, { userId: 200 });
    expect(u.ok).toBe(true);
    let r = await listInvestors(ctx);
    expect(r.data!.find((x) => x.code === 'INV02')!.loginUsername).toBe('ndtlogin02');
    // Gỡ gắn NĐT 1 → loginUsername null
    const u2 = await updateInvestor(ctx, 1, { userId: null });
    expect(u2.ok).toBe(true);
    r = await listInvestors(ctx);
    expect(r.data!.find((x) => x.code === 'INV01')!.loginUsername).toBeNull();
  });

  // FIX INV-2: NĐT 3 gắn user 300 (đã xóa mềm). Form SỬA luôn gửi lại userId=300 (link không đổi). Trước fix,
  // validateInvestorUserId chặn (user đã xóa) → không sửa được phí. Nay BỎ QUA re-validate khi userId KHÔNG đổi.
  it('updateInvestor với userId KHÔNG đổi (user đã xóa mềm) → vẫn sửa được phí (không bị chặn)', async () => {
    const h = makeDb(seed(new Date('2026-08-11')), usersSeed());
    const ctx: ServiceCtx = { db: h.db, user: authUser(['INVESTOR_UPDATE', 'INVESTOR_VIEW']) };
    const u = await updateInvestor(ctx, 3, { userId: 300, investFeePct: 0.5 });
    expect(u.ok).toBe(true);
    const r = await listInvestors(ctx);
    const inv3 = r.data!.find((x) => x.code === 'INV03')!;
    expect(inv3.investFeePct).toBe(0.5); // phí đã cập nhật dù user link đã xóa mềm
  });

  it('updateInvestor ĐỔI sang user đã xóa mềm KHÁC → vẫn bị chặn VALIDATION (chỉ bỏ qua khi KHÔNG đổi)', async () => {
    // NĐT 2 (userId null) đổi sang user 300 (đã xóa mềm) = userId THAY ĐỔI → phải validate và bị chặn.
    const h = makeDb(seed(new Date('2026-08-11')), usersSeed());
    const ctx: ServiceCtx = { db: h.db, user: authUser(['INVESTOR_UPDATE', 'INVESTOR_VIEW']) };
    const u = await updateInvestor(ctx, 2, { userId: 300 });
    expect(u.error).toBe('VALIDATION');
    expect(u.message).toContain('không tồn tại hoặc đã bị xóa');
  });
});
