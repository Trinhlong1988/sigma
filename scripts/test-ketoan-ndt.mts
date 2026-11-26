// THROWAWAY-DB test — vai trò "Kế toán NĐT" (Admin Demo 24/11). Chứng minh BACKEND LỌC theo phạm vi 1 NĐT.
// Quy trình: createdb sigma_ketoanndt_thu → prisma migrate deploy → ensureAlphaExtraSchema (thêm cột
// scope_investor_id) → seed perms/roles → nhồi 2 NĐT (A,B) mỗi NĐT TID/POS/bill/giao dịch → dựng app THẬT
// (createApp + __setDbForTest) → gọi ROUTE THẬT qua HTTP với phiên user Kế toán NĐT (scope A) → assert +
// in SỐ THẬT → dropdb. Chạy: npx tsx scripts/test-ketoan-ndt.mts
//
// L14 — DB thử có TÊN RIÊNG, drop sau khi xong. CHỈ chạm DB thử (KHÔNG đụng sigma thật).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createPrisma, type Db } from '@sigma/database';
import { PERMISSIONS, ROLES, DEFAULT_ROLE_PERMISSIONS } from '@sigma/shared';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { createApp } from '../apps/quanly-api/src/app.js';
import { __setDbForTest } from '../apps/quanly-api/src/db.js';

const HOST = process.env.PGHOST || 'localhost';
const PORT = process.env.PGPORT || '5432';
const USER = process.env.PGUSER || 'postgres';
const PASSWORD = process.env.PGPASSWORD || '<DIEN_VAO>';
const PGBIN = process.env.SIGMA_PG_BIN || '<PG_BIN>/pgsql/bin';
const exe = (t: string) => (process.platform === 'win32' ? `${t}.exe` : t);
const tool = (t: string) => `${PGBIN}/${exe(t)}`;
const DB = process.env.SIGMA_DB_KETOAN || 'sigma_ketoanndt_thu';
const URL = `postgresql://${encodeURIComponent(USER)}:${encodeURIComponent(PASSWORD)}@${HOST}:${PORT}/${DB}`;

function run(cmd: string, args: string[], opts: Record<string, unknown> = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PGPASSWORD: PASSWORD }, ...opts });
}

let pass = 0, fail = 0;
const lines: string[] = [];
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) { pass++; lines.push(`  PASS  ${name}  ${extra}`); }
  else { fail++; lines.push(`  FAIL  ${name}  ${extra}`); }
}
const bam = (s: string) => createHash('sha256').update(s).digest('hex');

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

async function makeUser(db: Db, username: string, roleCode: string): Promise<number> {
  const u = await db.user.create({ data: { username, fullName: username, passwordHash: 'x', status: 'ACTIVE' } });
  const role = await db.role.findUniqueOrThrow({ where: { code: roleCode } });
  await db.userRole.create({ data: { userId: u.id, roleId: role.id } });
  return u.id;
}
async function session(db: Db, userId: number): Promise<string> {
  const raw = `sess-${userId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Ghi mốc thời gian bằng now() CỦA SERVER (raw SQL) — KHÔNG để Prisma ghi timestamptz (lệch 7h làm phiên bị
  // coi là "ngồi không quá 60 phút" ngay lập tức; đúng lớp lỗi prisma write timestamptz đã ghi trong sổ tay).
  await db.$executeRawUnsafe(
    `INSERT INTO login_sessions (id, user_id, created_at, expires_at, last_seen_at)
     VALUES ($1, $2, now(), now() + interval '12 hours', now())`,
    bam(raw), userId
  );
  return raw; // cookie THÔ; requireQlSession tự băm để tra
}

/** Nhồi 1 NĐT: investor + receiveAccount + N TID + N POS + bills (los+lo_rows) + transactions. Trả id TID đầu. */
async function seedInvestor(db: Db, code: string, nTid: number, nBill: number, nTxn: number, amount: bigint) {
  const inv = await db.investor.create({ data: { code, fullName: `NĐT ${code}`, nickname: `NĐT ${code}`, investFeeMilli: 100 } });
  const ra = await db.receiveAccount.create({ data: { sourceId: 1, accountName: `TK ${code}`, accountNumber: `0${code}`, bankId: 1, investorId: inv.id } });
  const tidIds: number[] = [];
  const tidStrings: string[] = [];
  for (let i = 0; i < nTid; i++) {
    const s = `TID_${code}_${i}`;
    const t = await db.tid.create({ data: { tid: s, status: 'ACTIVE', receiveAccountId: ra.id, hkdName: `HKD ${code}` } });
    tidIds.push(t.id); tidStrings.push(s);
    await db.posDevice.create({ data: { serial: `POS_${code}_${i}`, status: 'DEPLOYED', currentTid: s } });
  }
  // Bills (los + lo_rows) trên TID[0] — bill_txn_date trong kỳ 2026-11.
  for (let b = 0; b < nBill; b++) {
    const lo = await db.lo.create({ data: { agentId: 1, status: 'PENDING', expectedTotalAmount: amount, billTxnDate: new Date(`2026-11-2${b % 9}T10:00:00+07:00`) } });
    await db.loRow.create({ data: { loId: lo.id, tidId: tidIds[0]!, cardTypeId: 1, feeTypeId: 1, amountBeforeFee: amount, feeApplied: 0n, amountAfterFee: amount } });
  }
  // Transactions POSTED (cho báo cáo lãi NĐT).
  for (let x = 0; x < nTxn; x++) {
    await db.transaction.create({ data: { tidId: tidIds[0]!, amount, status: 'POSTED', phiCaiMayMilli: 0, txnDate: new Date(`2026-11-2${x % 9}T10:00:00+07:00`) } });
  }
  return { invId: inv.id, raId: ra.id, tidIds, tidStrings };
}

async function main(): Promise<void> {
  process.env['SIGMA_SELFTEST'] = '1';
  console.log(`createdb ${DB}`);
  run(tool('dropdb'), ['-h', HOST, '-p', PORT, '-U', USER, '--if-exists', DB]);
  const cdb = run(tool('createdb'), ['-h', HOST, '-p', PORT, '-U', USER, DB]);
  if (cdb.status !== 0) { console.error('createdb FAILED', cdb.stderr || cdb.stdout); process.exit(2); }

  let db: Db | null = null;
  let server: ReturnType<ReturnType<typeof createApp>['listen']> | null = null;
  try {
    const mig = run('npx', ['prisma', 'migrate', 'deploy'], { cwd: 'packages/database', shell: true, env: { ...process.env, DATABASE_URL: URL } });
    if (mig.status !== 0) { console.error('migrate deploy FAILED', mig.stderr || mig.stdout); process.exit(2); }

    process.env['DATABASE_URL'] = URL;
    db = createPrisma(URL);
    __setDbForTest(db);
    await ensureAlphaExtraSchema(db);

    // CỔNG: cột scope_investor_id ĐÃ CÓ chưa?
    const col = await db.$queryRawUnsafe<Array<{ c: string }>>(
      `SELECT column_name AS c FROM information_schema.columns WHERE table_name='users' AND column_name='scope_investor_id'`);
    check('schema-ensure thêm cột users.scope_investor_id', col.length === 1, `(tìm thấy ${col.length} cột)`);

    await seed(db);
    const A = await seedInvestor(db, 'INVA', 2, 3, 2, 1_000_000n);
    const B = await seedInvestor(db, 'INVB', 1, 2, 1, 2_000_000n);

    // User Kế toán NĐT gán NĐT A + user admin (staff full, không scope).
    const uKtA = await makeUser(db, 'ketoan_inva_thu', 'R_KETOAN_NDT');
    await db.$executeRawUnsafe('UPDATE users SET scope_investor_id = $1 WHERE id = $2', A.invId, uKtA);
    const uAdmin = await makeUser(db, 'admin_thu', 'ADMIN');
    // Vai R_KETOAN_NDT NHƯNG CHƯA gán NĐT (scope null) — phải bị chặn SẠCH (fail-closed, chống lọc-rỗng-thấy-tất).
    const uKtNoScope = await makeUser(db, 'ketoan_chuagan_thu', 'R_KETOAN_NDT');
    const ckKtA = await session(db, uKtA);
    const ckAdmin = await session(db, uAdmin);
    const ckKtNoScope = await session(db, uKtNoScope);

    server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((r) => server!.once('listening', () => r()));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const call = async (ck: string, method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, {
        method,
        headers: { cookie: `ql_session=${ck}`, 'content-type': 'application/json', 'x-alpha-client': '1' },
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
      const j = await res.json().catch(() => ({}));
      return { status: res.status, body: j as any };
    };

    const period = '?from=2026-11-01&to=2026-11-30';

    // 1) /v1/auth/me — scopeInvestorName cho banner.
    const me = await call(ckKtA, 'GET', '/v1/auth/me');
    check('me trả scopeInvestorId = A', me.body?.user?.scopeInvestorId === A.invId, `(scopeInvestorId=${me.body?.user?.scopeInvestorId}, name=${me.body?.user?.scopeInvestorName})`);

    // 2) GET bills — Kế toán NĐT A CHỈ thấy bill của A (3), KHÔNG thấy B (2).
    const billsA = await call(ckKtA, 'GET', '/v1/bills/manual' + period);
    const dsA = Array.isArray(billsA.body?.data) ? billsA.body.data : [];
    const ndtSet = new Set(dsA.map((x: any) => x.ndt));
    check('GET bills: Kế toán A thấy đúng 3 bill của A', dsA.length === 3, `(trả ${dsA.length} bill; total=${billsA.body?.total})`);
    check('GET bills: MỌI bill đều của NĐT A (không lẫn B)', dsA.length > 0 && [...ndtSet].every((n) => String(n).includes('INVA')), `(ndt thấy: ${[...ndtSet].join('|')})`);

    // 3) GET bills — admin (staff) thấy CẢ A lẫn B (3+2=5) → chứng minh scope CHỈ ảnh hưởng user khóa.
    const billsAdmin = await call(ckAdmin, 'GET', '/v1/bills/manual' + period);
    const dsAll = Array.isArray(billsAdmin.body?.data) ? billsAdmin.body.data : [];
    check('GET bills: admin (không scope) thấy cả A+B = 5 bill', dsAll.length === 5, `(trả ${dsAll.length} bill)`);

    // 4) POST bill TID của B (ngoài phạm vi) → 403 fail-closed.
    const postB = await call(ckKtA, 'POST', '/v1/bills/manual', { tidString: B.tidStrings[0], amountBeforeFee: 500000, cardTypeId: 1 });
    check('POST bill TID của B → 403 FORBIDDEN (chặn ngoài phạm vi)', postB.status === 403 && postB.body?.error === 'FORBIDDEN', `(status=${postB.status}, error=${postB.body?.error})`);

    // 5) POST bill TID của A → QUA được cổng scope (không phải 403 scope; engine có thể lỗi fee khác — chấp nhận).
    const postA = await call(ckKtA, 'POST', '/v1/bills/manual', { tidString: A.tidStrings[0], amountBeforeFee: 500000, cardTypeId: 1 });
    const laChanScopeA = postA.status === 403 && typeof postA.body?.message === 'string' && postA.body.message.includes('phạm vi');
    check('POST bill TID của A → KHÔNG bị chặn phạm vi (qua cổng scope)', !laChanScopeA, `(status=${postA.status}, error=${postA.body?.error}, msg=${String(postA.body?.message).slice(0, 60)})`);

    // 6) Danh mục TID — Kế toán A chỉ thấy TID của A (2), không thấy TID của B (1).
    const tidsA = await call(ckKtA, 'GET', '/v1/tid-configs');
    const tdA = Array.isArray(tidsA.body?.data) ? tidsA.body.data : [];
    check('GET tid-configs: Kế toán A thấy đúng 2 TID của A', tdA.length === 2 && tdA.every((t: any) => String(t.tid).includes('INVA')), `(trả ${tdA.length}: ${tdA.map((t: any) => t.tid).join(',')})`);

    // 7) Danh mục POS — chỉ POS gắn TID của A (2).
    const posA = await call(ckKtA, 'GET', '/v1/pos-devices');
    const pdA = Array.isArray(posA.body?.data) ? posA.body.data : [];
    check('GET pos-devices: Kế toán A thấy đúng 2 POS của A', pdA.length === 2 && pdA.every((p: any) => String(p.currentTid).includes('INVA')), `(trả ${pdA.length}: ${pdA.map((p: any) => p.currentTid).join(',')})`);

    // 8) Danh mục TK nhận tiền — chỉ của A (1).
    const raList = await call(ckKtA, 'GET', '/v1/receive-accounts');
    const raA = Array.isArray(raList.body?.data) ? raList.body.data : [];
    check('GET receive-accounts: Kế toán A thấy đúng 1 TK của A', raA.length === 1 && raA.every((a: any) => a.investorId === A.invId), `(trả ${raA.length})`);

    // 9) Đọc giá bán TID của B → 403; TID của A → KHÔNG 403.
    const sellB = await call(ckKtA, 'GET', `/v1/tids/${B.tidIds[0]}/sell-fees?feeTypeId=1`);
    check('GET sell-fees TID của B → 403 (ngoài phạm vi)', sellB.status === 403, `(status=${sellB.status})`);
    const sellA = await call(ckKtA, 'GET', `/v1/tids/${A.tidIds[0]}/sell-fees?feeTypeId=1`);
    check('GET sell-fees TID của A → KHÔNG 403', sellA.status !== 403, `(status=${sellA.status})`);

    // 10) SET giá bán (PUT) → 403 vì thiếu TID_MANAGE (Kế toán NĐT KHÔNG set giá).
    const setFee = await call(ckKtA, 'PUT', `/v1/tids/${A.tidIds[0]}/sell-fees`, { feeTypeId: 1, entries: [{ cardTypeId: 1, phiBan: 2000 }] });
    check('PUT sell-fees (set giá) → 403 (không có TID_MANAGE)', setFee.status === 403, `(status=${setFee.status}, error=${setFee.body?.error})`);

    // 11) Báo cáo NĐT — Kế toán A CHỈ ra NĐT A, dù gửi investorId của B (bị ép về A).
    const repSpoof = await call(ckKtA, 'GET', `/v1/investors/report?investorId=${B.invId}&from=2026-11-01&to=2026-11-30`);
    const rep = Array.isArray(repSpoof.body?.data) ? repSpoof.body.data : [];
    check('GET investors/report: gửi investorId=B vẫn CHỈ ra NĐT A (ép scope)', rep.length === 1 && rep[0]?.investorId === A.invId, `(trả ${rep.length} NĐT: ${rep.map((r: any) => r.code).join(',')}; doanhThu=${rep[0]?.doanhThu})`);

    // 12) Admin báo cáo investorId=B → thấy B (chứng minh route không tự chặn admin).
    const repAdminB = await call(ckAdmin, 'GET', `/v1/investors/report?investorId=${B.invId}&from=2026-11-01&to=2026-11-30`);
    const repAB = Array.isArray(repAdminB.body?.data) ? repAdminB.body.data : [];
    check('GET investors/report: admin xem được NĐT B', repAB.length === 1 && repAB[0]?.investorId === B.invId, `(trả ${repAB.length}: ${repAB.map((r: any) => r.code).join(',')})`);

    // ───── GATE DENY-BY-DEFAULT (LEAD vá keystone — chứng minh LỖ RÒ qua route KHÔNG lọc scope đã BỊT) ─────
    // 13) /v1/deposits/held (gác REVENUE_VIEW ở service, KHÔNG lọc scope) — TRƯỚC vá: trả cọc MỌI NĐT; SAU vá: 403.
    const depHeld = await call(ckKtA, 'GET', '/v1/deposits/held');
    check('GATE: Kế toán A gọi /v1/deposits/held → 403 SCOPE_FORBIDDEN (chống rò cọc NĐT khác)',
      depHeld.status === 403 && depHeld.body?.error === 'SCOPE_FORBIDDEN', `(status=${depHeld.status}, error=${depHeld.body?.error})`);
    // 14) /v1/tids/revenue-ranking (gác REVENUE_VIEW, xếp hạng doanh số MỌI TID) — SAU vá: 403.
    const rank = await call(ckKtA, 'GET', '/v1/tids/revenue-ranking');
    check('GATE: Kế toán A gọi /v1/tids/revenue-ranking → 403 (chống rò doanh số NĐT khác)',
      rank.status === 403 && rank.body?.error === 'SCOPE_FORBIDDEN', `(status=${rank.status}, error=${rank.body?.error})`);
    // 15) Admin (staff) gọi /v1/deposits/held → KHÔNG 403 (gate chỉ trói user khóa phạm vi, không đụng staff).
    const depAdmin = await call(ckAdmin, 'GET', '/v1/deposits/held');
    check('GATE: admin gọi /v1/deposits/held → KHÔNG 403 (staff không bị trói)', depAdmin.status !== 403, `(status=${depAdmin.status})`);
    // 16) Vai NĐT CHƯA gán phạm vi → chặn SẠCH mọi route (kể cả whitelist) với SCOPE_UNSET.
    const unsetBills = await call(ckKtNoScope, 'GET', '/v1/bills/manual' + period);
    check('GATE: vai NĐT chưa gán NĐT → 403 SCOPE_UNSET (fail-closed, không lọc-rỗng-thấy-tất)',
      unsetBills.status === 403 && unsetBills.body?.error === 'SCOPE_UNSET', `(status=${unsetBills.status}, error=${unsetBills.body?.error})`);

    // ── VIỆC 1+2 (phương án A người hoàn + UI gán NĐT) ──
    // Seed 1 người ĐƯỢC HOÀN TIỀN (bật can_refund cho admin) để refund-people có dữ liệu.
    await db.$executeRawUnsafe('UPDATE users SET can_refund = true WHERE id = $1', uAdmin);

    // 16) refund-people — Kế toán A (không USER_READ) vẫn gọi được, CHỈ trả id+fullName.
    const rp = await call(ckKtA, 'GET', '/v1/refund-people');
    const rpData = Array.isArray(rp.body?.data) ? rp.body.data : [];
    const keysOk = rpData.length > 0 && rpData.every((p: any) => Object.keys(p).sort().join(',') === 'fullName,id');
    check('refund-people: Kế toán A gọi được 200 + ≥1 người', rp.status === 200 && rpData.length >= 1, `(status=${rp.status}, n=${rpData.length})`);
    check('refund-people: CHỈ field id+fullName (không lộ username/phone/vai trò)', keysOk, `(keys=${rpData[0] ? Object.keys(rpData[0]).join('|') : '—'})`);

    // 17) Gán NĐT qua route user (admin tạo user Kế toán NĐT scope=A) → users.scope_investor_id ghi đúng.
    const createKt = await call(ckAdmin, 'POST', '/v1/users', { fullName: 'KT Moi', username: 'ktmoithu24', password: 'MatKhau@123', roleCodes: ['R_KETOAN_NDT'], scopeInvestorId: A.invId });
    let scopeGhi: unknown = null;
    if (createKt.body?.id != null) {
      const rr = await db.$queryRawUnsafe<Array<{ scope_investor_id: number | null }>>('SELECT scope_investor_id FROM users WHERE id=$1', createKt.body.id);
      scopeGhi = rr[0]?.scope_investor_id ?? null;
    }
    check('tạo user Kế toán NĐT qua route → scope_investor_id = A', createKt.status === 200 && Number(scopeGhi) === A.invId, `(status=${createKt.status}, id=${createKt.body?.id}, scope=${scopeGhi})`);

    // 18) Tạo Kế toán NĐT mà KHÔNG gán NĐT → 400 SCOPE_REQUIRED (fail-closed, không đẻ user kẹt).
    const createNoScope = await call(ckAdmin, 'POST', '/v1/users', { fullName: 'KT Thieu', username: 'ktthieuthu24', password: 'MatKhau@123', roleCodes: ['R_KETOAN_NDT'] });
    check('tạo Kế toán NĐT KHÔNG gán NĐT → 400 SCOPE_REQUIRED', createNoScope.status === 400 && createNoScope.body?.error === 'SCOPE_REQUIRED', `(status=${createNoScope.status}, error=${createNoScope.body?.error})`);
    // Xác nhận user "KT Thieu" KHÔNG được tạo (chặn TRƯỚC createUser).
    const thieu = await db.$queryRawUnsafe<Array<{ n: number }>>(`SELECT count(*)::int AS n FROM users WHERE username='ktthieuthu24'`);
    check('user Kế toán NĐT thiếu NĐT → KHÔNG được tạo trong sổ', Number(thieu[0]?.n) === 0, `(đếm=${thieu[0]?.n})`);

    // ───── VÁ AUDIT ĐỐI KHÁNG (LEAD 24/11) ─────
    // C1 [CRITICAL]: Kế toán A gửi editingLoId = LÔ CỦA B + tidString của A → phải 403, lô B KHÔNG đổi chủ.
    const loB = (await db.$queryRawUnsafe<Array<{ id: number; tid_id: number }>>(
      `SELECT l.id, lr.tid_id FROM los l JOIN lo_rows lr ON lr.lo_id=l.id JOIN tids t ON t.id=lr.tid_id
         JOIN receive_accounts ra ON ra.id=t.receive_account_id WHERE ra.investor_id=$1 ORDER BY l.id LIMIT 1`, B.invId))[0];
    const hijack = await call(ckKtA, 'POST', '/v1/bills/manual',
      { tidString: A.tidStrings[0], editingLoId: loB?.id, billKey: 'nat|HIJACK|1|2026', amountBeforeFee: 9000000, cardTypeId: 1 });
    const tidSau = (await db.$queryRawUnsafe<Array<{ tid_id: number }>>(
      `SELECT lr.tid_id FROM lo_rows lr WHERE lr.lo_id=$1 ORDER BY lr.id LIMIT 1`, loB?.id))[0];
    check('C1: Kế toán A sửa lô của B (editingLoId) → 403 FORBIDDEN',
      hijack.status === 403 && hijack.body?.error === 'FORBIDDEN', `(status=${hijack.status}, error=${hijack.body?.error})`);
    check('C1: lô của B KHÔNG bị đổi chủ sau cú hijack',
      tidSau?.tid_id === loB?.tid_id, `(tid_id trước=${loB?.tid_id} sau=${tidSau?.tid_id})`);

    // C2 [HIGH] — ĐỂ CUỐI vì đổi state: xóa mềm NĐT A → Kế toán A phải bị chặn SẠCH (SCOPE_UNSET), KHÔNG thành staff-full.
    await db.$executeRawUnsafe('UPDATE investors SET deleted_at = now() WHERE id = $1', A.invId);
    const billsSauXoa = await call(ckKtA, 'GET', '/v1/bills/manual' + period);
    check('C2: NĐT scope xóa mềm → GET bills 403 SCOPE_UNSET (KHÔNG thấy NĐT khác)',
      billsSauXoa.status === 403 && billsSauXoa.body?.error === 'SCOPE_UNSET',
      `(status=${billsSauXoa.status}, error=${billsSauXoa.body?.error})`);
    const repSauXoa = await call(ckKtA, 'GET', `/v1/investors/report?investorId=${B.invId}&from=2026-11-01&to=2026-11-30`);
    check('C2: NĐT scope xóa mềm → report?investorId=B cũng 403 (không rơi staff-full)',
      repSauXoa.status === 403, `(status=${repSauXoa.status}, error=${repSauXoa.body?.error})`);

    console.log('\n===== KẾT QUẢ KIỂM CHỨNG KẾ TOÁN NĐT =====');
    console.log(lines.join('\n'));
    console.log(`\nTỔNG: PASS ${pass} · FAIL ${fail}`);
  } finally {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    __setDbForTest(null);
    if (db) await db.$disconnect();
    console.log(`dropdb ${DB}`);
    run(tool('dropdb'), ['-h', HOST, '-p', PORT, '-U', USER, '--if-exists', DB]);
  }
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error('LỖI HARNESS:', e); process.exit(3); });
