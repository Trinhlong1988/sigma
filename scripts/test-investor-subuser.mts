// THROWAWAY-DB test — Tài khoản CON của NĐT + hợp nhất checkbox "Nhà đầu tư" (Admin Demo 12/8).
// createdb → prisma migrate deploy (gồm 20260812100000_user_investor_subuser) → seed roles/perms → gọi service THẬT
// (createUser investor + investor-subuser + resolveOwnInvestorId) → assert → dropdb.
// Chạy: npx tsx scripts/test-investor-subuser.mts
import { spawnSync } from 'node:child_process';
import { createPrisma, type Db } from '@sigma/database';
import { PERMISSIONS, ROLES, DEFAULT_ROLE_PERMISSIONS, type AuthUser } from '@sigma/shared';
import {
  createUser,
  createInvestorSubUser, listInvestorSubUsers, lockInvestorSubUser, unlockInvestorSubUser, deleteInvestorSubUser,
  resolveOwnInvestorId
} from '@sigma/services';

const HOST = process.env.PGHOST || 'localhost';
const PORT = process.env.PGPORT || '5432';
const USER = process.env.PGUSER || 'postgres';
const PASSWORD = process.env.PGPASSWORD || '<DIEN_VAO>';
const PGBIN = process.env.SIGMA_PG_BIN || '<PG_BIN>/pgsql/bin';
const exe = (t: string) => (process.platform === 'win32' ? `${t}.exe` : t);
const tool = (t: string) => `${PGBIN}/${exe(t)}`;
const DB = `alpha_subuser_${Date.now()}`;
const URL = `postgresql://${encodeURIComponent(USER)}:${encodeURIComponent(PASSWORD)}@${HOST}:${PORT}/${DB}`;

function run(cmd: string, args: string[], opts: Record<string, unknown> = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PGPASSWORD: PASSWORD }, ...opts });
}

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}  ${extra}`); }
}

/** Seed tối thiểu (mirror seedIfEmpty): permissions upsert + roles upsert + DEFAULT_ROLE_PERMISSIONS cho role mới +
 *  ADMIN nhận đủ mọi quyền (superuser). Không dùng grant-flag (DB fresh → mọi role đều "vừa tạo"). */
async function seed(db: Db): Promise<void> {
  for (const p of PERMISSIONS) await db.permission.upsert({ where: { code: p.code }, update: { name: p.name, group: p.group }, create: { code: p.code, name: p.name, group: p.group } });
  for (const r of ROLES) await db.role.upsert({ where: { code: r.code }, update: {}, create: { name: r.name, code: r.code, description: r.description, isSystem: r.isSystem, status: 'ACTIVE' } });
  for (const [roleCode, permCodes] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const role = await db.role.findUnique({ where: { code: roleCode } });
    if (!role) continue;
    for (const code of permCodes) {
      const perm = await db.permission.findUnique({ where: { code } });
      if (!perm) continue;
      await db.rolePermission.upsert({ where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } }, update: {}, create: { roleId: role.id, permissionId: perm.id } });
    }
  }
  const admin = await db.role.findUnique({ where: { code: 'ADMIN' }, select: { id: true } });
  const allPerms = await db.permission.findMany({ select: { id: true } });
  for (const perm of allPerms) await db.rolePermission.upsert({ where: { roleId_permissionId: { roleId: admin!.id, permissionId: perm.id } }, update: {}, create: { roleId: admin!.id, permissionId: perm.id } });
}

async function authUserFor(db: Db, userId: number): Promise<AuthUser> {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, include: { roles: { include: { role: { include: { permissions: { include: { permission: true } } } } } } } });
  const roleCodes: string[] = []; const permSet = new Set<string>();
  for (const ur of u.roles) { if (ur.role.status !== 'ACTIVE') continue; roleCodes.push(ur.role.code); for (const rp of ur.role.permissions) permSet.add(rp.permission.code); }
  return { id: u.id, username: u.username, fullName: u.fullName, status: u.status as AuthUser['status'], forceChangePassword: u.forceChangePassword, roles: roleCodes, permissions: [...permSet] };
}

async function main(): Promise<void> {
  process.env['SIGMA_SELFTEST'] = '1'; // tránh forceChangePassword khi tạo user

  console.log(`createdb ${DB}`);
  const cdb = run(tool('createdb'), ['-h', HOST, '-p', PORT, '-U', USER, DB]);
  if (cdb.status !== 0) { console.error('createdb FAILED', cdb.stderr || cdb.stdout); process.exit(2); }

  try {
    const mig = run('npx', ['prisma', 'migrate', 'deploy'], { cwd: 'packages/database', shell: true, env: { ...process.env, DATABASE_URL: URL } });
    process.stdout.write(mig.stdout || '');
    if (mig.status !== 0) { console.error('migrate deploy FAILED', mig.stderr); process.exit(2); }

    const db = createPrisma(URL);
    try {
      await seed(db);

      // Bootstrap 1 ADMIN (nhân sự) làm actor tạo user.
      const adminRole = await db.role.findUniqueOrThrow({ where: { code: 'ADMIN' } });
      const adminUser = await db.user.create({ data: { fullName: 'Admin Goc', username: 'admingoc1', passwordHash: 'x', status: 'ACTIVE', roles: { create: [{ roleId: adminRole.id }] } } });
      const adminCtx = { db, user: await authUserFor(db, adminUser.id) };
      check('ADMIN có INVESTOR_SUBUSER_MANAGE (seed grant)', adminCtx.user.permissions.includes('INVESTOR_SUBUSER_MANAGE'));

      // MANAGER cũng phải có quyền (DEFAULT_ROLE_PERMISSIONS).
      const mgrRole = await db.role.findUniqueOrThrow({ where: { code: 'MANAGER' } });
      const mgrUser = await db.user.create({ data: { fullName: 'QL Test', username: 'managertest1', passwordHash: 'x', status: 'ACTIVE', roles: { create: [{ roleId: mgrRole.id }] } } });
      const mgrPerms = (await authUserFor(db, mgrUser.id)).permissions;
      check('MANAGER có INVESTOR_SUBUSER_MANAGE (DEFAULT_ROLE_PERMISSIONS)', mgrPerms.includes('INVESTOR_SUBUSER_MANAGE'));

      // === A. Hợp nhất — tạo nhân sự tích "Nhà đầu tư" → Investor + role R_INVESTOR ===
      const rA = await createUser(adminCtx, { fullName: 'Chu Dau Tu A', username: 'ownerinva1', password: 'Passw0rd1', roleCodes: [], investor: true, investFeePct: 0.1 });
      check('A1 createUser investor=true ok', rA.ok, JSON.stringify(rA));
      const ownerA = await db.user.findUniqueOrThrow({ where: { id: rA.id! }, include: { roles: { include: { role: true } } } });
      const invA = await db.investor.findFirstOrThrow({ where: { userId: ownerA.id, deletedAt: null } });
      check('A2 Investor A tạo, userId gắn owner A', invA.userId === ownerA.id);
      check('A3 investFeeMilli = 100 (0.1%)', invA.investFeeMilli === 100, `got ${invA.investFeeMilli}`);
      check('A4 owner A có role R_INVESTOR', ownerA.roles.some((r) => r.role.code === 'R_INVESTOR'));

      // Chủ NĐT B (để test cross-investor).
      const rB = await createUser(adminCtx, { fullName: 'Chu Dau Tu B', username: 'ownerinvb1', password: 'Passw0rd1', roleCodes: [], investor: true, investFeePct: 0.2 });
      const ownerB = await db.user.findUniqueOrThrow({ where: { id: rB.id! } });
      const invB = await db.investor.findFirstOrThrow({ where: { userId: ownerB.id, deletedAt: null } });

      // === B. Thêm tài khoản con — bởi NHÂN SỰ (admin) & bởi CHÍNH NĐT ===
      const cBad = await createInvestorSubUser(adminCtx, invA.id, { username: 'short', password: 'Passw0rd1' });
      check('B0 username <8 ký tự bị chặn VALIDATION', !cBad.ok && cBad.error === 'VALIDATION');

      const c1 = await createInvestorSubUser(adminCtx, invA.id, { username: 'subbystaff1', password: 'Passw0rd1', fullName: 'Con Do Staff' });
      check('B1 nhân sự (admin) thêm tài khoản con cho NĐT A ok', c1.ok, JSON.stringify(c1));

      const ownerACtx = { db, user: await authUserFor(db, ownerA.id) };
      check('B2a owner A KHÔNG có INVESTOR_SUBUSER_MANAGE', !ownerACtx.user.permissions.includes('INVESTOR_SUBUSER_MANAGE'));
      const c2 = await createInvestorSubUser(ownerACtx, invA.id, { username: 'subbyowner1', password: 'Passw0rd1', fullName: 'Con Do NDT' });
      check('B2b CHÍNH NĐT A tự thêm tài khoản con cho MÌNH ok', c2.ok, JSON.stringify(c2));

      const listA = await listInvestorSubUsers(adminCtx, invA.id);
      check('B3 list NĐT A có đúng 2 tài khoản con', listA.ok === true && listA.data!.length === 2, JSON.stringify(listA.data?.map((x) => x.username)));

      // === C. resolveOwnInvestorId của tài khoản con = đúng NĐT cha (không thấy NĐT khác) ===
      const subStaff = await db.user.findFirstOrThrow({ where: { username: 'subbystaff1' } });
      const subCtx = { db, user: await authUserFor(db, subStaff.id) };
      const own = await resolveOwnInvestorId(subCtx);
      check('C1 sub-user resolveOwnInvestorId = NĐT A', own === invA.id, `got ${own}, expect ${invA.id}`);
      check('C2 sub-user KHÔNG map sang NĐT B', own !== invB.id);
      // Chủ NĐT A cũng resolve về A (nhánh 1).
      check('C3 owner A resolveOwnInvestorId = NĐT A', (await resolveOwnInvestorId(ownerACtx)) === invA.id);
      check('C4 sub-user chỉ có INVESTOR_SELF_VIEW, KHÔNG SUBUSER_MANAGE', subCtx.user.permissions.includes('INVESTOR_SELF_VIEW') && !subCtx.user.permissions.includes('INVESTOR_SUBUSER_MANAGE'));

      // === D. Tài khoản con KHÔNG thêm được tài khoản con (FORBIDDEN) ===
      const dRes = await createInvestorSubUser(subCtx, invA.id, { username: 'subofsub01', password: 'Passw0rd1' });
      check('D1 sub-user thêm sub-user → FORBIDDEN', !dRes.ok && dRes.error === 'FORBIDDEN', JSON.stringify(dRes));

      // === E. NĐT A KHÔNG thêm cho NĐT B (cross-investor FORBIDDEN) ===
      const eRes = await createInvestorSubUser(ownerACtx, invB.id, { username: 'crossinv01', password: 'Passw0rd1' });
      check('E1 owner A thêm cho NĐT B → FORBIDDEN', !eRes.ok && eRes.error === 'FORBIDDEN', JSON.stringify(eRes));
      const eList = await listInvestorSubUsers(ownerACtx, invB.id);
      check('E2 owner A list tài khoản con NĐT B → FORBIDDEN', !eList.ok && eList.error === 'FORBIDDEN');

      // === F. Khóa / mở / xóa tài khoản con ===
      const lk = await lockInvestorSubUser(adminCtx, subStaff.id);
      check('F1 khóa tài khoản con ok', lk.ok);
      check('F1b status LOCKED', (await db.user.findUniqueOrThrow({ where: { id: subStaff.id } })).status === 'LOCKED');
      const uk = await unlockInvestorSubUser(adminCtx, subStaff.id);
      check('F2 mở khóa ok + ACTIVE', uk.ok && (await db.user.findUniqueOrThrow({ where: { id: subStaff.id } })).status === 'ACTIVE');
      const dl = await deleteInvestorSubUser(adminCtx, subStaff.id);
      check('F3 xóa mềm tài khoản con ok', dl.ok);
      const deleted = await db.user.findUniqueOrThrow({ where: { id: subStaff.id } });
      check('F3b status DELETED + deletedAt set', deleted.status === 'DELETED' && deleted.deletedAt != null);
      const listAfter = await listInvestorSubUsers(adminCtx, invA.id);
      check('F4 list sau xóa còn 1 (ẩn đã xóa)', listAfter.data!.length === 1);

      // === G. Khóa/xóa 1 user THƯỜNG qua API sub-user → NOT_FOUND (chỉ áp tài khoản con) ===
      const gRes = await lockInvestorSubUser(adminCtx, adminUser.id);
      check('G1 khóa user thường qua sub-user API → NOT_FOUND', !gRes.ok && gRes.error === 'NOT_FOUND', JSON.stringify(gRes));

      // audit ghi nhận
      const audits = await db.auditLog.findMany({ where: { action: { in: ['INVESTOR_SUBUSER_CREATED', 'INVESTOR_SUBUSER_LOCKED', 'INVESTOR_SUBUSER_UNLOCKED', 'INVESTOR_SUBUSER_DELETED'] } } });
      check('H1 audit sub-user ghi đủ (create×2, lock, unlock, delete)', audits.length === 5, `got ${audits.length}`);
    } finally {
      await db.$disconnect();
    }
  } finally {
    console.log(`dropdb ${DB}`);
    run(tool('dropdb'), ['-h', HOST, '-p', PORT, '-U', USER, '--force', DB]);
  }

  console.log(`\n=== KẾT QUẢ: ${pass} PASS / ${fail} FAIL ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(3); });
