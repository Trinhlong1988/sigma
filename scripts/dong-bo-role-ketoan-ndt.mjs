// ĐỒNG BỘ role R_KETOAN_NDT + quyền của nó lên sổ thật (idempotent, upsert từ NGUỒN shared — KHÔNG gõ tay literal).
// GỐC LỖI (25/11): vai Kế toán NĐT khai trong source nhưng chỉ vào DB qua seed.ts (chạy lúc init) → sổ thật đang
// chạy data cũ nên role CHƯA CÓ => user NgocLanKT có scope mà roles RỖNG => menu trống. R202: BACKUP trước + CHỈ-BỔ-SUNG.
import { createPrisma } from '@sigma/database';
import { PERMISSIONS, ROLES, DEFAULT_ROLE_PERMISSIONS } from '@sigma/shared';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const GOC = resolve(import.meta.dirname, '..');
const env = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const URL = (env.match(/DATABASE_URL\s*=\s*"?([^"\n\r]+)"?/) || [])[1];
if (!URL || !/\/sigma(\?|$)/.test(URL)) { console.error('Khong doc duoc DATABASE_URL sigma'); process.exit(2); }
const db = createPrisma(URL);
const CODE = 'R_KETOAN_NDT';
const ganUser = process.argv.includes('--gan-user') ? Number(process.argv[process.argv.indexOf('--gan-user') + 1]) : null;

try {
  // 1) BACKUP 3 bang quyen (timestamped) TRUOC khi ghi.
  const stamp = process.env.STAMP || 'manual';
  const dir = resolve(GOC, '_backup-role'); mkdirSync(dir, { recursive: true });
  const roles = await db.role.findMany();
  const rolePerms = await db.rolePermission.findMany();
  const userRoles = await db.userRole.findMany();
  writeFileSync(resolve(dir, `roles-${stamp}.json`), JSON.stringify({ roles, rolePerms, userRoles }, null, 2));
  console.log(`[backup] ${roles.length} roles . ${rolePerms.length} role_perms . ${userRoles.length} user_roles -> _backup-role/roles-${stamp}.json`);

  // 2) upsert MOI permission (dam bao quyen cua role ton tai) — idempotent.
  for (const p of PERMISSIONS) await db.permission.upsert({ where: { code: p.code }, update: { name: p.name, group: p.group }, create: { code: p.code, name: p.name, group: p.group } });

  // 3) upsert CHI role R_KETOAN_NDT (tu ROLES, khong literal).
  const def = ROLES.find((r) => r.code === CODE);
  if (!def) { console.error('ROLES thieu ' + CODE); process.exit(2); }
  const role = await db.role.upsert({ where: { code: CODE }, update: { name: def.name, description: def.description, isSystem: def.isSystem }, create: { code: CODE, name: def.name, description: def.description, isSystem: def.isSystem, status: 'ACTIVE' } });
  console.log(`[role] upsert ${CODE} id=${role.id}`);

  // 4) gan quyen tu DEFAULT_ROLE_PERMISSIONS[R_KETOAN_NDT] — CHI-BO-SUNG (upsert).
  const codes = DEFAULT_ROLE_PERMISSIONS[CODE] || [];
  let n = 0;
  for (const c of codes) {
    const perm = await db.permission.findUnique({ where: { code: c } });
    if (!perm) { console.warn('  thieu permission ' + c); continue; }
    await db.rolePermission.upsert({ where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } }, update: {}, create: { roleId: role.id, permissionId: perm.id } });
    n++;
  }
  console.log(`[perms] gan ${n}/${codes.length} quyen cho ${CODE}: ${codes.join(', ')}`);

  // 5) (tuy chon) gan vai cho 1 user cu the.
  if (ganUser != null && Number.isInteger(ganUser)) {
    // scope_investor_id QUẢN BẰNG RAW (bỏ khỏi Prisma client để chống drift) → đọc bằng $queryRawUnsafe.
    const urow = await db.$queryRawUnsafe(`SELECT id, username, scope_investor_id FROM users WHERE id=$1`, ganUser);
    const u = urow[0];
    if (!u) { console.error('Khong co user id=' + ganUser); process.exit(2); }
    await db.$executeRawUnsafe(`INSERT INTO user_roles (user_id, role_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, ganUser, role.id);
    console.log(`[gan-vai] user ${u.username} (id ${u.id}, scope_investor_id=${u.scope_investor_id}) -> ${CODE}`);
  }

  // 6) QA GATE SAU GHI.
  const after = await db.$queryRawUnsafe(`SELECT r.id, r.status, count(rp.permission_id)::int AS so_quyen FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id WHERE r.code=$1 GROUP BY r.id`, CODE);
  console.log('[verify] role sau ghi:', JSON.stringify(after[0]));
  if (ganUser != null) {
    const ur = await db.$queryRawUnsafe(`SELECT string_agg(r.code,',') AS roles FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE ur.user_id=$1`, ganUser);
    console.log('[verify] roles cua user:', ur[0]?.roles);
  }
  console.log('XONG');
} finally {
  await db.$disconnect();
}
