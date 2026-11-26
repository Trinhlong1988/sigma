// Nhân sự (User) CRUD — LÕI THUẦN ctx-based. PORT nghiệp vụ từ apps/desktop/src/main/user-service.ts (IMS_SPEC
// §9/§11/§12). Thay `requirePermission`/`me()`/`getDb()`/`validateCurrentSession()` (global Electron) bằng ctx =
// { db, user } do adapter dựng — mọi truy cập DB qua ctx.db, actor = ctx.user. GIỮ NGUYÊN business: guard quyền
// (§13), audit (R007/R_AUDIT_002), soft-delete (R_USER_STATUS_006), bảo vệ Admin cuối (R004/R005) qua advisory
// lock 748301, không tự-leo-quyền (R006), manager scope (R_MANAGER_001..006), mã NV auto (§D).
// XÁC NHẬN MẬT KHẨU (§14) do ADAPTER kiểm TRƯỚC khi gọi lõi (khuôn customer.ts) — lõi KHÔNG kiểm password.
// LƯU Ý: desktop ipc.ts KHÔNG expose xóa nhân sự trực tiếp (R34 — chỉ qua Duyệt Hủy); deleteUser/deleteUsers
// GIỮ nội bộ (selftest / luồng entity-cancel dựng sau), route API KHÔNG mở DELETE.
import {
  hashPassword,
  canCreateUserWithRoles,
  canRemoveOrLockAdmin,
  grantsExceedActor,
  isSelfPrivilegeEscalation,
  targetPrivilegeExceedsActor,
  auditSnapshot
} from '@sigma/business-rules';
import { hasPermission, validateUsername, validatePassword, isValidEmail, ADMIN_ROLE_CODE } from '@sigma/shared';
import type { AuthUser } from '@sigma/shared';
import type { Db } from '@sigma/database';
import { writeAudit } from './audit.js';
import { nextCode } from './code.js';
import { staleGuard } from './optimistic-lock.js';
import { createInvestorForUserTx } from './investor.js';
import type { ServiceCtx, MutationResult } from './customer.js';
// TÌM KIẾM hoa/thường: DB collation "C" → Prisma mode:'insensitive' (ILIKE) KHÔNG gập chữ tiếng Việt có dấu
// (đo thật trên sổ thật: ILIKE '%nguyễn%' = 0 dòng / ILIKE '%NGUYỄN%' = 10 dòng). Xem tim-kiem-hoa-thuong.ts.
import { dieuKienTimKiem } from './tim-kiem-hoa-thuong.js';

// Vai trò builtin của Nhà đầu tư (login xem báo cáo của mình). Tích "Nhà đầu tư" khi tạo user → tự thêm role này.
const INVESTOR_ROLE_CODE = 'R_INVESTOR';

const FORBIDDEN_MESSAGE = 'Bạn không có quyền thực hiện thao tác này.';

export interface UserDto {
  id: number;
  employeeCode: string | null;
  fullName: string;
  birthDate: string | null;
  gender: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  username: string;
  status: string;
  forceChangePassword: boolean;
  joinedAt: string | null;
  createdAt: string;
  updatedAt: string; // R48 #2 optimistic-lock — client echo lại khi Lưu để chống sửa đè
  roles: string[]; // role codes
  /** [B206] ĐƯỢC PHÉP ĐỨNG TÊN HOÀN TIỀN — ô tích riêng từng nhân sự (không theo vai trò). */
  canRefund?: boolean;
  /** [KẾ TOÁN NĐT 24/11] NĐT mà user bị khóa phạm vi (users.scope_investor_id) — màn Nhân sự prefill dropdown. */
  scopeInvestorId?: number | null;
}

export interface UserFilter {
  roleCode?: string;
  status?: string;
  search?: string;
}

function toDto(u: {
  id: number;
  employeeCode: string | null;
  fullName: string;
  birthDate: Date | null;
  gender: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  joinDate: Date | null;
  username: string;
  status: string;
  forceChangePassword: boolean;
  createdAt: Date;
  updatedAt: Date;
  roles: { role: { code: string } }[];
}): UserDto {
  return {
    id: u.id,
    employeeCode: u.employeeCode,
    fullName: u.fullName,
    birthDate: u.birthDate ? u.birthDate.toISOString() : null,
    gender: u.gender,
    phone: u.phone,
    email: u.email,
    address: u.address,
    username: u.username,
    status: u.status,
    forceChangePassword: u.forceChangePassword,
    joinedAt: u.joinDate ? u.joinDate.toISOString() : null,
    createdAt: u.createdAt.toISOString(),
    updatedAt: u.updatedAt.toISOString(),
    roles: u.roles.map((r) => r.role.code),
    // [B206 19/11] mặc định false; listUsers nạp giá trị THẬT bằng truy vấn thô (cột thêm bằng schema-ensure,
    // cố ý không đưa vào Prisma model để không phải `prisma generate` trên máy chủ đang chạy 24/24).
    canRefund: false,
    scopeInvestorId: null // [KẾ TOÁN NĐT] mặc định null; listUsers nạp giá trị THẬT bằng truy vấn thô bên dưới.
  };
}

/** USER_READ — liệt kê nhân sự, mặc định ẩn đã xóa mềm (R_USER_STATUS_005). */
export async function listUsers(
  ctx: ServiceCtx,
  filter: UserFilter = {}
): Promise<{ ok: boolean; data?: UserDto[]; error?: string; message?: string }> {
  if (!hasPermission(ctx.user, 'USER_READ')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const includeDeleted = filter.status === 'DELETED';
  const rows = await ctx.db.user.findMany({
    where: {
      deletedAt: includeDeleted ? undefined : null,
      status: filter.status ? filter.status : undefined,
      roles: filter.roleCode ? { some: { role: { code: filter.roleCode } } } : undefined,
      // Tìm kiếm tên/tài khoản/email/SĐT — KHÔNG phân biệt hoa/thường THẬT SỰ (xem tim-kiem-hoa-thuong.ts).
      AND: await dieuKienTimKiem(ctx.db, 'users', { fullName: 'full_name', username: 'username', email: 'email', phone: 'phone' }, filter.search)
    },
    orderBy: { id: 'asc' },
    include: { roles: { include: { role: true } } }
  });
  const ds = rows.map(toDto);
  // [B206] Nạp cờ "được hoàn tiền" (cột can_refund thêm bằng schema-ensure nên không có trong Prisma model).
  // Cột chưa tồn tại (DB cũ) → coi như chưa ai được bật, KHÔNG nuốt lỗi im mà ghi log để còn lần ra.
  try {
    // [KẾ TOÁN NĐT 24/11] Nạp KÈM scope_investor_id (cùng truy vấn thô, 2 cột raw ngoài Prisma model).
    const co = await ctx.db.$queryRawUnsafe<Array<{ id: number; can_refund: boolean; scope_investor_id: number | null }>>(
      'SELECT id, can_refund, scope_investor_id FROM users WHERE id = ANY($1::int[])', ds.map((x) => x.id));
    const bang = new Map(co.map((x) => [Number(x.id), x]));
    for (const x of ds) {
      const row = bang.get(x.id);
      x.canRefund = row ? !!row.can_refund : false;
      x.scopeInvestorId = row?.scope_investor_id ?? null;
    }
  } catch (e) {
    console.error('[listUsers] KHÔNG đọc được cột can_refund/scope_investor_id — tạm coi chưa bật/không khóa phạm vi:', (e as Error).message);
  }
  return { ok: true, data: ds };
}

// Kiểu client dùng chung cho cả PrismaClient lẫn transaction client (AUTH-05 advisory-lock tx).
type TxClient = Omit<Db, '$connect' | '$disconnect' | '$on' | '$use' | '$transaction' | '$extends'>;

/** How many ACTIVE admins remain (for R004/R005). */
async function countActiveAdmins(db: TxClient, excludeUserId?: number): Promise<number> {
  return db.user.count({
    where: {
      deletedAt: null,
      status: 'ACTIVE',
      id: excludeUserId ? { not: excludeUserId } : undefined,
      roles: { some: { role: { code: ADMIN_ROLE_CODE } } }
    }
  });
}

async function targetIsAdmin(db: TxClient, userId: number): Promise<boolean> {
  const n = await db.userRole.count({ where: { userId, role: { code: ADMIN_ROLE_CODE } } });
  return n > 0;
}

/** Flatten the ACTIVE-role permission codes carried by a set of role codes. */
async function permsForRoleCodes(db: Db, roleCodes: string[]): Promise<string[]> {
  const roles = await db.role.findMany({
    where: { code: { in: roleCodes } },
    include: { permissions: { include: { permission: true } } }
  });
  const set = new Set<string>();
  for (const r of roles) for (const p of r.permissions) set.add(p.permission.code);
  return [...set];
}

export interface CreateUserInput {
  fullName: string;
  birthDate?: string | null;
  gender?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  joinDate?: string | null;
  username: string;
  password: string;
  status?: string; // ACTIVE | PENDING
  roleCodes: string[];
  // HỢP NHẤT NĐT (Admin Demo 11/8): tích "Nhà đầu tư" khi tạo nhân sự → tự tạo hồ sơ Nhà đầu tư gắn user này + tự thêm
  // role R_INVESTOR. `investFeePct` = % phí đầu tư (0.1 hay tùy), sửa sau ở tab NĐT. Không tích = nhân sự thường.
  investor?: boolean;
  investFeePct?: number | null;
}

/** R_MANAGER_001..004 + validate username/email + audit USER_CREATED (R007). USER_CREATE (đủ) HOẶC
 *  USER_CREATE_LIMITED (manager) đều được vào; scope siết bên dưới. Session/forceChangePassword do adapter lo. */
export async function createUser(ctx: ServiceCtx, input: CreateUserInput): Promise<MutationResult> {
  const { db, user } = ctx;
  if (!hasPermission(user, 'USER_CREATE') && !hasPermission(user, 'USER_CREATE_LIMITED')) {
    return { ok: false, error: 'FORBIDDEN', message: 'Bạn không có quyền tạo nhân sự.' };
  }

  const roleCodes = [...new Set(input.roleCodes ?? [])];
  // Tích "Nhà đầu tư" → BẮT BUỘC có role R_INVESTOR để user đăng nhập xem báo cáo của mình (tự thêm nếu thiếu).
  if (input.investor && !roleCodes.includes(INVESTOR_ROLE_CODE)) roleCodes.push(INVESTOR_ROLE_CODE);
  if (roleCodes.length === 0) return { ok: false, error: 'VALIDATION', message: 'Phải chọn ít nhất 1 vai trò.' };

  // R_MANAGER_002/003 + role-scope
  if (!canCreateUserWithRoles(user, roleCodes)) {
    await auditDenied(db, user, 'USER_CREATED', 'MANAGER_SCOPE');
    return { ok: false, error: 'MANAGER_SCOPE', message: 'Bạn không được phép tạo user với vai trò này.' };
  }
  // R_MANAGER_004: cannot grant permissions above the actor's own.
  const grantPerms = await permsForRoleCodes(db, roleCodes);
  if (grantsExceedActor(user, grantPerms)) {
    await auditDenied(db, user, 'USER_CREATED', 'GRANT_ESCALATION');
    return { ok: false, error: 'GRANT_ESCALATION', message: 'Không thể cấp quyền cao hơn quyền của bạn.' };
  }

  const uname = validateUsername(input.username);
  if (!uname.valid) return { ok: false, error: 'VALIDATION', message: uname.error };
  const pwd = validatePassword(input.password);
  if (!pwd.valid) return { ok: false, error: 'VALIDATION', message: pwd.error };
  if (input.email && !isValidEmail(input.email)) {
    return { ok: false, error: 'VALIDATION', message: 'Email không hợp lệ.' };
  }
  if (await db.user.findFirst({ where: { username: input.username } })) {
    return { ok: false, error: 'DUPLICATE', message: `Tên đăng nhập "${input.username}" đã tồn tại.` };
  }
  if (input.email && (await db.user.findFirst({ where: { email: input.email } }))) {
    return { ok: false, error: 'DUPLICATE', message: `Email "${input.email}" đã được sử dụng.` };
  }

  const roles = await db.role.findMany({ where: { code: { in: roleCodes } } });
  // Atomic: mint mã NV (§D) + tạo user + (nếu tích "Nhà đầu tư") tạo luôn hồ sơ NĐT gắn user — MỘT transaction, để
  // lỗi tạo NĐT (vd %phí sai / user đã là NĐT) ROLLBACK cả user (không sinh user mồ côi không có NĐT như ý định).
  let created: { id: number; employeeCode: string | null; username: string; fullName: string; status: string };
  try {
    created = await db.$transaction(async (tx) => {
      const employeeCode = await nextCode(tx, 'NV');
      const u = await tx.user.create({
        data: {
          employeeCode,
          fullName: input.fullName.trim(),
          birthDate: input.birthDate ? new Date(input.birthDate) : null,
          gender: input.gender ?? null,
          phone: input.phone ?? null,
          email: input.email || null,
          address: input.address ?? null,
          joinDate: input.joinDate ? new Date(input.joinDate) : null,
          username: input.username,
          passwordHash: hashPassword(input.password),
          status: input.status === 'PENDING' ? 'PENDING' : 'ACTIVE',
          // Production: user mới BUỘC đổi mật khẩu lần đầu (guard R48 chặn thao tác tới khi đổi). Selftest: bỏ cờ
          // để test được thao tác/permission-gating của user tạo trong test (block đã test riêng ở selftest-session #11).
          forceChangePassword: !process.env['SIGMA_SELFTEST'],
          createdBy: user.id,
          roles: { create: roles.map((r) => ({ roleId: r.id })) }
        }
      });
      if (input.investor) {
        await createInvestorForUserTx(tx as unknown as Db, {
          userId: u.id,
          fullName: input.fullName,
          investFeePct: input.investFeePct ?? 0,
          createdBy: user.id
        });
      }
      return u;
    });
  } catch (e) {
    // Lỗi tạo NĐT (message tiếng Việt từ createInvestorForUserTx) → trả VALIDATION sạch, KHÔNG để lộ exception thô.
    return { ok: false, error: 'VALIDATION', message: e instanceof Error ? e.message : 'Không tạo được nhà đầu tư cho tài khoản này.' };
  }
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'USER_CREATED',
    targetType: 'User',
    targetId: String(created.id),
    after: auditSnapshot({ employeeCode: created.employeeCode, username: created.username, fullName: created.fullName, status: created.status, roles: roleCodes, investor: !!input.investor })
  });
  return { ok: true, id: created.id };
}

export interface UpdateUserInput {
  fullName?: string;
  birthDate?: string | null;
  gender?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  joinDate?: string | null;
  status?: string;
  roleCodes?: string[];
  expectedUpdatedAt?: string | null; // R48 #2 optimistic-lock — mốc updatedAt client giữ lúc mở form
  /** [B206 19/11] bật/tắt quyền ĐỨNG TÊN HOÀN TIỀN cho riêng nhân sự này. */
  canRefund?: boolean;
}

/** USER_UPDATE + R006 (no self privilege escalation) + audit before/after (R_AUDIT_002). */
export async function updateUser(ctx: ServiceCtx, id: number, input: UpdateUserInput): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'USER_UPDATE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  const row = await db.user.findUnique({ where: { id }, include: { roles: { include: { role: true } } } });
  if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Nhân sự không tồn tại.' };
  const stale = staleGuard(row.updatedAt, input.expectedUpdatedAt);
  if (stale) return stale;

  // Cờ đổi trạng thái / đổi vai trò — tính trước để gộp kiểm-bất-biến "Admin cuối" vào 1 transaction có lock.
  const changingStatus = input.status !== undefined && input.status !== row.status;
  const toInactive = changingStatus && input.status !== 'ACTIVE';
  const changingRoles = Array.isArray(input.roleCodes);
  const currentRoleCodes = row.roles.map((r) => r.role.code);
  const nextRoleCodes = changingRoles ? [...new Set(input.roleCodes!)] : currentRoleCodes;

  // B-audit follow-up (21/8) — CHẶN target-outranks-actor cho MỌI sửa (không chỉ đổi vai trò): trước đây guard
  // leo-thang CHỈ nằm trong nhánh `changingRoles` → một MANAGER có USER_UPDATE có thể sửa status/hồ sơ của ADMIN
  // (hay bất kỳ tài khoản giữ quyền cao hơn mình). Áp ĐÚNG predicate targetPrivilegeExceedsActor (khuôn admin-reset)
  // TRÊN QUYỀN HIỆN CÓ của target. Admin qua được với mọi target; tự-sửa (self) không bao giờ out-rank chính mình.
  const targetPerms = await permsForRoleCodes(db, currentRoleCodes);
  if (targetPrivilegeExceedsActor(user, { roles: currentRoleCodes, permissions: targetPerms })) {
    await auditDenied(db, user, 'USER_UPDATED', 'TARGET_OUTRANKS_ACTOR', String(id));
    return { ok: false, error: 'FORBIDDEN', message: 'Không thể sửa tài khoản có quyền cao hơn bạn.' };
  }

  // AUTH-02 (audit 15/7, Codex) — đổi TRẠNG THÁI qua form update phải chịu ĐÚNG guard như khóa/mở chuyên:
  // cần quyền USER_LOCK (→ không-hoạt-động) / USER_UNLOCK (→ ACTIVE). Không có guard này thì actor chỉ có
  // USER_UPDATE có thể khóa/vô-hiệu Admin, bỏ qua setUserLock. (Kiểm Admin-cuối gộp xuống transaction bên dưới.)
  if (changingStatus) {
    const needPerm = toInactive ? 'USER_LOCK' : 'USER_UNLOCK';
    if (!hasPermission(user, needPerm)) {
      await auditDenied(db, user, 'USER_UPDATED', 'STATUS_PERM_DENIED', String(id));
      return { ok: false, error: 'FORBIDDEN', message: `Đổi trạng thái nhân sự cần quyền ${needPerm}.` };
    }
  }

  // R006: a user cannot change their OWN roles (privilege escalation vector).
  if (
    isSelfPrivilegeEscalation(user.id, id, changingRoles) &&
    JSON.stringify([...currentRoleCodes].sort()) !== JSON.stringify([...nextRoleCodes].sort())
  ) {
    await auditDenied(db, user, 'USER_UPDATED', 'SELF_ESCALATION', String(id));
    return { ok: false, error: 'SELF_ESCALATION', message: 'Bạn không thể tự thay đổi vai trò của chính mình.' };
  }

  // Manager scope on any role change + KHÔNG cho về rỗng vai trò (giống createUser, R_USER §).
  if (changingRoles) {
    if (nextRoleCodes.length === 0) {
      return { ok: false, error: 'VALIDATION', message: 'Nhân sự phải giữ ít nhất 1 vai trò.' };
    }
    if (!canCreateUserWithRoles(user, nextRoleCodes)) {
      await auditDenied(db, user, 'USER_UPDATED', 'MANAGER_SCOPE', String(id));
      return { ok: false, error: 'MANAGER_SCOPE', message: 'Bạn không được gán vai trò này.' };
    }
    const grantPerms = await permsForRoleCodes(db, nextRoleCodes);
    if (grantsExceedActor(user, grantPerms)) {
      await auditDenied(db, user, 'USER_UPDATED', 'GRANT_ESCALATION', String(id));
      return { ok: false, error: 'GRANT_ESCALATION', message: 'Không thể cấp quyền cao hơn quyền của bạn.' };
    }
  }

  if (input.email && !isValidEmail(input.email)) {
    return { ok: false, error: 'VALIDATION', message: 'Email không hợp lệ.' };
  }
  if (input.email && input.email !== row.email) {
    const dup = await db.user.findFirst({ where: { email: input.email, id: { not: id } } });
    if (dup) return { ok: false, error: 'DUPLICATE', message: `Email "${input.email}" đã được sử dụng.` };
  }

  // H-1 + M-2 (audit 16/7, agent phản biện) — MỞ RỘNG bất biến "Admin cuối" (AUTH-05) sang updateUser:
  // gỡ vai trò ADMIN của Admin ACTIVE cuối (roleCodes bỏ ADMIN) mất toàn bộ khả năng quản trị — trước đây
  // nhánh đổi-role KHÔNG hề kiểm last-admin. Nay kiểm cả (đổi status→inactive) VÀ (gỡ role ADMIN), và
  // kiểm-CÙNG-ghi dưới CÙNG advisory lock 748301 (chống TOCTOU song song với lock/xóa Admin khác).
  const removingAdmin = changingRoles && row.status === 'ACTIVE'
    && currentRoleCodes.includes(ADMIN_ROLE_CODE) && !nextRoleCodes.includes(ADMIN_ROLE_CODE);

  const before = auditSnapshot({
    fullName: row.fullName,
    phone: row.phone,
    email: row.email,
    address: row.address,
    gender: row.gender,
    status: row.status,
    roles: currentRoleCodes
  });

  const guarded = await db.$transaction(async (txc) => {
    if (toInactive || removingAdmin) {
      await txc.$executeRawUnsafe('SELECT pg_advisory_xact_lock(748301)');
      const isAdmin = await targetIsAdmin(txc, id);
      const remaining = await countActiveAdmins(txc, id);
      if (!canRemoveOrLockAdmin(isAdmin, remaining + (isAdmin && row.status === 'ACTIVE' ? 1 : 0))) {
        return {
          ok: false as const,
          error: 'LAST_ADMIN',
          message: toInactive ? 'Không thể khóa/vô hiệu Admin cuối cùng.' : 'Không thể gỡ vai trò Admin của Admin cuối cùng.'
        };
      }
    }
    await txc.user.update({
      where: { id },
      data: {
        fullName: input.fullName?.trim() ?? row.fullName,
        birthDate: input.birthDate !== undefined ? (input.birthDate ? new Date(input.birthDate) : null) : row.birthDate,
        gender: input.gender !== undefined ? input.gender : row.gender,
        phone: input.phone !== undefined ? input.phone : row.phone,
        email: input.email !== undefined ? input.email || null : row.email,
        address: input.address !== undefined ? input.address : row.address,
        joinDate: input.joinDate !== undefined ? (input.joinDate ? new Date(input.joinDate) : null) : row.joinDate,
        status: input.status ?? row.status
      }
    });
    if (changingRoles) {
      const roles = await txc.role.findMany({ where: { code: { in: nextRoleCodes } } });
      await txc.userRole.deleteMany({ where: { userId: id } });
      await txc.userRole.createMany({ data: roles.map((r) => ({ userId: id, roleId: r.id })) });
    }
    return { ok: true as const };
  });
  if (!guarded.ok) return guarded;
  // L-4 (audit 16/7) — đổi vai trò làm quyền hiệu lực thay đổi. Adapter API dựng lại AuthUser mỗi request (không
  // có snapshot in-memory như Electron) → không cần invalidateAuthSnapshot ở đây.

  // [B206] Ghi cờ "được hoàn tiền" — cột thêm bằng schema-ensure nên phải ghi thô. KHÔNG nuốt lỗi:
  // ghi hỏng thì trả lỗi rõ chứ không báo "đã lưu" trong khi cờ vẫn như cũ.
  let truocCanRefund: boolean | null = null;
  if (input.canRefund !== undefined) {
    try {
      const cu = await db.$queryRawUnsafe<Array<{ can_refund: boolean }>>('SELECT can_refund FROM users WHERE id = $1', id);
      truocCanRefund = cu[0] ? !!cu[0].can_refund : null;
      await db.$executeRawUnsafe('UPDATE users SET can_refund = $1 WHERE id = $2', input.canRefund, id);
    } catch (e) {
      return { ok: false, error: 'EXCEPTION', message: 'Không lưu được quyền hoàn tiền: ' + (e as Error).message };
    }
  }

  const after = auditSnapshot({
    fullName: input.fullName?.trim() ?? row.fullName,
    phone: input.phone !== undefined ? input.phone : row.phone,
    email: input.email !== undefined ? input.email || null : row.email,
    address: input.address !== undefined ? input.address : row.address,
    gender: input.gender !== undefined ? input.gender : row.gender,
    status: input.status ?? row.status,
    roles: nextRoleCodes,
    canRefund: input.canRefund !== undefined ? input.canRefund : truocCanRefund
  });
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'USER_UPDATED',
    targetType: 'User',
    targetId: String(id),
    before,
    after
  });
  return { ok: true, id };
}

async function setUserLock(ctx: ServiceCtx, id: number, lock: boolean): Promise<MutationResult> {
  const perm = lock ? 'USER_LOCK' : 'USER_UNLOCK';
  const action = lock ? 'USER_LOCKED' : 'USER_UNLOCKED';
  if (!hasPermission(ctx.user, perm)) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  // B-audit follow-up (21/8) — CHẶN target-outranks-actor cho khóa/mở (path riêng khỏi updateUser). MANAGER giữ
  // USER_LOCK/UNLOCK KHÔNG được khóa/mở ADMIN (hay tài khoản giữ quyền cao hơn). Mirror updateUser + admin-reset.
  const target = await db.user.findUnique({ where: { id }, include: { roles: { include: { role: true } } } });
  if (!target || target.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Nhân sự không tồn tại.' };
  const targetRoleCodes = target.roles.map((r) => r.role.code);
  const targetPerms = await permsForRoleCodes(db, targetRoleCodes);
  if (targetPrivilegeExceedsActor(user, { roles: targetRoleCodes, permissions: targetPerms })) {
    await auditDenied(db, user, 'USER_UPDATED', 'TARGET_OUTRANKS_ACTOR', String(id));
    return { ok: false, error: 'FORBIDDEN', message: 'Không thể khóa/mở tài khoản có quyền cao hơn bạn.' };
  }

  // AUTH-05 (audit 15/7, Codex) — serialize kiểm-và-ghi invariant "Admin cuối" bằng advisory xact lock
  // CHUNG (748301, cùng entity-cancel-service) trong 1 transaction → chống TOCTOU: 2 client khóa 2 Admin
  // đồng thời cùng vượt kiểm tra last-admin rồi cùng ghi → 0 Admin.
  return await db.$transaction(async (txc) => {
    await txc.$executeRawUnsafe('SELECT pg_advisory_xact_lock(748301)');
    const row = await txc.user.findUnique({ where: { id } });
    if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Nhân sự không tồn tại.' };

    if (lock) {
      const isAdmin = await targetIsAdmin(txc, id);
      const remaining = await countActiveAdmins(txc, id); // admins remaining if we lock this one
      if (!canRemoveOrLockAdmin(isAdmin, remaining + (isAdmin && row.status === 'ACTIVE' ? 1 : 0))) {
        return { ok: false, error: 'LAST_ADMIN', message: 'Không thể khóa Admin cuối cùng.' };
      }
    }
    return await applyUserLock(txc, id, lock, row.status, user.id, action);
  });
}

/** Ghi trạng thái khóa/mở + audit trong CÙNG transaction (đã cầm advisory lock). */
async function applyUserLock(txc: TxClient, id: number, lock: boolean, prevStatus: string, actorId: number, action: 'USER_LOCKED' | 'USER_UNLOCKED'): Promise<MutationResult> {
  // P0-01: `lockedAt` LÀ MỎ NEO tự-mở-khóa của khóa-TẠM (auth failure). Khóa/mở TAY của Admin PHẢI
  // đặt lockedAt=null → login (auth-service #1) chỉ tự mở khi lockedAt!=null → khóa tay KHÔNG BAO GIỜ tự mở.
  // Nếu không clear, một lần auto-lock cũ để lại lockedAt=T1; admin mở rồi khóa lại → login thấy lockedAt cũ
  // >15′ → tự mở khóa tay của admin (bug lệch chính sách khóa). Mở tay cũng reset bộ đếm sai.
  await txc.user.update({
    where: { id },
    data: lock
      ? { status: 'LOCKED', lockedAt: null, lockReason: 'ADMIN_LOCK' } // khóa TAY → không có mỏ neo tự-mở
      : { status: 'ACTIVE', lockedAt: null, lockReason: null, failedAttempts: 0 }
  });
  await writeAudit(txc, {
    actorUserId: actorId,
    action,
    targetType: 'User',
    targetId: String(id),
    before: { status: prevStatus },
    after: { status: lock ? 'LOCKED' : 'ACTIVE', manual: true }
  });
  return { ok: true, id };
}

export const lockUser = (ctx: ServiceCtx, id: number): Promise<MutationResult> => setUserLock(ctx, id, true);
export const unlockUser = (ctx: ServiceCtx, id: number): Promise<MutationResult> => setUserLock(ctx, id, false);

/** USER_DELETE soft-delete (R_USER_STATUS_006) + last-admin (R004). XÁC NHẬN MẬT KHẨU (§14) do ADAPTER kiểm
 *  TRƯỚC khi gọi lõi (khuôn customer.ts) — lõi KHÔNG kiểm password. LƯU Ý: desktop ipc.ts KHÔNG expose xóa trực
 *  tiếp (R34 — chỉ qua Duyệt Hủy); hàm GIỮ nội bộ (selftest / entity-cancel dựng sau). */
export async function deleteUser(ctx: ServiceCtx, id: number): Promise<MutationResult> {
  if (!hasPermission(ctx.user, 'USER_DELETE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;

  // AUTH-05 (audit 15/7, Codex) — serialize invariant "Admin cuối" bằng advisory xact lock CHUNG (748301)
  // trong transaction → chống 2 client xóa 2 Admin đồng thời cùng vượt kiểm tra.
  return await db.$transaction(async (txc) => {
    await txc.$executeRawUnsafe('SELECT pg_advisory_xact_lock(748301)');
    const row = await txc.user.findUnique({ where: { id } });
    if (!row || row.deletedAt) return { ok: false, error: 'NOT_FOUND', message: 'Nhân sự không tồn tại.' };

    const isAdmin = await targetIsAdmin(txc, id);
    const remaining = await countActiveAdmins(txc, id);
    if (!canRemoveOrLockAdmin(isAdmin, remaining + (isAdmin && row.status === 'ACTIVE' ? 1 : 0))) {
      return { ok: false, error: 'LAST_ADMIN', message: 'Không thể xóa Admin cuối cùng.' };
    }
    // R_MANAGER_005: manager cannot delete an Admin.
    if (isAdmin && !user.roles.includes(ADMIN_ROLE_CODE)) {
      await auditDenied(txc, user, 'USER_DELETED', 'MANAGER_SCOPE', String(id));
      return { ok: false, error: 'MANAGER_SCOPE', message: 'Bạn không được xóa tài khoản Admin.' };
    }

    await txc.user.update({ where: { id }, data: { status: 'DELETED', deletedAt: new Date() } });
    await writeAudit(txc, {
      actorUserId: user.id,
      action: 'USER_DELETED',
      targetType: 'User',
      targetId: String(id),
      before: auditSnapshot({ username: row.username, fullName: row.fullName })
    });
    return { ok: true, id };
  });
}

export interface BulkDeleteUsersResult {
  ok: boolean;
  error?: string;
  message?: string;
  deleted?: number;
  skipped?: { id: number; reason: string; message?: string }[];
}

/**
 * XÓA HÀNG LOẠT nhân sự (LEAD 10/7, spec §5). XÁC NHẬN MẬT KHẨU (§14) do ADAPTER kiểm TRƯỚC (khuôn customer.ts)
 * — lõi lặp guard giống `deleteUser` cho TỪNG user: KHÔNG tự xóa mình, KHÔNG xóa Admin cuối còn hoạt động,
 * Manager không xóa được Admin. User vướng guard bị SKIP kèm lý do (không làm hỏng cả loạt) và ghi audit nhánh
 * từ chối (B14). Mỗi user xóa thành công ghi 1 audit USER_DELETED. Xóa mềm (R_USER_STATUS_006). Đếm Admin làm
 * mới mỗi vòng lặp → chọn nhiều Admin trong 1 loạt vẫn không thể xóa Admin cuối cùng.
 */
export async function deleteUsers(ctx: ServiceCtx, ids: number[]): Promise<BulkDeleteUsersResult> {
  if (!hasPermission(ctx.user, 'USER_DELETE')) return { ok: false, error: 'FORBIDDEN', message: FORBIDDEN_MESSAGE };
  const { db, user } = ctx;
  if (!ids || ids.length === 0) return { ok: false, error: 'VALIDATION', message: 'Chưa chọn nhân sự để xóa.' };

  // AUTH-05 (audit 15/7, Codex) — cả loạt xóa chạy trong 1 transaction cầm advisory lock CHUNG (748301):
  // đếm-Admin làm mới mỗi vòng dưới lock → không có 2 client song song cùng xóa Admin cuối. Skip-per-id giữ
  // nguyên (chỉ `continue`, không throw → không rollback cả loạt); mọi xóa thành công commit ở cuối tx.
  const skipped: { id: number; reason: string; message?: string }[] = [];
  const deleted = await db.$transaction(async (txc) => {
    await txc.$executeRawUnsafe('SELECT pg_advisory_xact_lock(748301)');
    let n = 0;
    for (const id of [...new Set(ids)]) {
      // KHÔNG tự xóa tài khoản của chính mình.
      if (id === user.id) {
        await auditDenied(txc, user, 'USER_DELETED', 'SELF_DELETE', String(id));
        skipped.push({ id, reason: 'SELF_DELETE', message: 'Không thể tự xóa tài khoản của chính mình.' });
        continue;
      }
      const row = await txc.user.findUnique({ where: { id } });
      if (!row || row.deletedAt) {
        skipped.push({ id, reason: 'NOT_FOUND', message: 'Nhân sự không tồn tại hoặc đã bị xóa.' });
        continue;
      }
      const isAdmin = await targetIsAdmin(txc, id);
      const remaining = await countActiveAdmins(txc, id);
      if (!canRemoveOrLockAdmin(isAdmin, remaining + (isAdmin && row.status === 'ACTIVE' ? 1 : 0))) {
        skipped.push({ id, reason: 'LAST_ADMIN', message: `Không thể xóa Admin cuối cùng (${row.username}).` });
        continue;
      }
      // R_MANAGER_005: manager không được xóa Admin.
      if (isAdmin && !user.roles.includes(ADMIN_ROLE_CODE)) {
        await auditDenied(txc, user, 'USER_DELETED', 'MANAGER_SCOPE', String(id));
        skipped.push({ id, reason: 'MANAGER_SCOPE', message: `Bạn không được xóa tài khoản Admin (${row.username}).` });
        continue;
      }
      await txc.user.update({ where: { id }, data: { status: 'DELETED', deletedAt: new Date() } });
      await writeAudit(txc, {
        actorUserId: user.id,
        action: 'USER_DELETED',
        targetType: 'User',
        targetId: String(id),
        before: auditSnapshot({ username: row.username, fullName: row.fullName })
      });
      n++;
    }
    return n;
  });
  return { ok: true, deleted, skipped };
}

// --- helpers -------------------------------------------------------------

async function auditDenied(db: TxClient, user: AuthUser, action: 'USER_CREATED' | 'USER_UPDATED' | 'USER_DELETED', reason: string, targetId?: string): Promise<void> {
  await writeAudit(db, {
    actorUserId: user.id,
    action: 'PERMISSION_DENIED',
    targetType: 'User',
    targetId: targetId ?? null,
    after: { deniedAction: action, reason, actor: user.username }
  });
}
