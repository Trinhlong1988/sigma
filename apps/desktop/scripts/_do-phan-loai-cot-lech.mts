// PHÂN LOẠI cột mốc thời gian: cột nào LỆCH −7h, cột nào ĐÚNG. Chạy trên DB THỬ, CHỈ ĐỌC + ghi bản ghi thử
// rồi xoá. Không đụng dữ liệu thật.
//
// Ba cơ chế ghi trong kho này:
//   (1) Postgres tự điền (DEFAULT now()) ................. ĐÚNG
//   (2) app gửi Date qua Prisma (adapter-pg) ............. LỆCH −7h
//   (3) app ghi raw chuỗi ISO ($1::timestamptz) .......... ĐÚNG
// Script đo TỪNG cơ chế bằng bản ghi thật rồi so với now() của máy chủ.
import { getDb } from '../../quanly-api/src/db.js';

const urlDb = process.env.DATABASE_URL ?? '';
if (!/thu|test/i.test(urlDb)) { console.error('[phan-loai] DỪNG: không phải DB thử.'); process.exit(3); }
const d = getDb() as unknown as {
  $queryRawUnsafe: <T>(sql: string, ...a: unknown[]) => Promise<T>;
  $executeRawUnsafe: (sql: string, ...a: unknown[]) => Promise<number>;
  loginSession: { create: (a: unknown) => Promise<unknown>; delete: (a: unknown) => Promise<unknown> };
};
const gio = (h: number): string => (h >= 0 ? '+' : '') + h.toFixed(2) + 'h';
const uid = (await d.$queryRawUnsafe<Array<{ id: number }>>(`SELECT id FROM users ORDER BY id LIMIT 1`))[0].id;

async function lechSoVoiNow(id: string): Promise<number> {
  const r = await d.$queryRawUnsafe<Array<{ h: string }>>(
    `SELECT EXTRACT(EPOCH FROM (created_at - now()))/3600 AS h FROM login_sessions WHERE id = $1`, id);
  return Number(r[0].h);
}

console.log('── Đo 3 cơ chế ghi, so với now() của máy chủ (lệch ≈ 0 là ĐÚNG, ≈ −7h là LỆCH) ──');

// (1) Postgres tự điền
const id1 = 'pl-default-' + Date.now();
await d.$executeRawUnsafe(
  `INSERT INTO login_sessions (id,user_id,expires_at,last_seen_at,device_info)
   VALUES ($1,$2,now(),now(),'phan-loai')`, id1, uid);
console.log('  (1) Postgres tự điền DEFAULT now() :', gio(await lechSoVoiNow(id1)));
await d.$executeRawUnsafe(`DELETE FROM login_sessions WHERE id=$1`, id1);

// (2) app gửi Date qua Prisma — KHÔNG truyền createdAt (để Prisma/DB tự quyết)
const id2 = 'pl-prisma-auto-' + Date.now();
await d.loginSession.create({ data: { id: id2, userId: uid, expiresAt: new Date(), lastSeenAt: new Date(), deviceInfo: 'phan-loai' } });
console.log('  (2) Prisma create, KHÔNG truyền mốc:', gio(await lechSoVoiNow(id2)));
await d.$executeRawUnsafe(`DELETE FROM login_sessions WHERE id=$1`, id2);

// (2b) app gửi Date TƯỜNG MINH qua Prisma
const id3 = 'pl-prisma-date-' + Date.now();
await d.loginSession.create({ data: { id: id3, userId: uid, createdAt: new Date(), expiresAt: new Date(), lastSeenAt: new Date(), deviceInfo: 'phan-loai' } });
console.log('  (2b) Prisma create, TRUYỀN Date   :', gio(await lechSoVoiNow(id3)));
await d.$executeRawUnsafe(`DELETE FROM login_sessions WHERE id=$1`, id3);

// (3) app ghi raw chuỗi ISO
const id4 = 'pl-raw-iso-' + Date.now();
await d.$executeRawUnsafe(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,$2,$3::timestamptz,now(),now(),'phan-loai')`, id4, uid, new Date().toISOString());
console.log('  (3) raw chuỗi ISO ::timestamptz   :', gio(await lechSoVoiNow(id4)));
await d.$executeRawUnsafe(`DELETE FROM login_sessions WHERE id=$1`, id4);

// Thống kê: cột nào có DEFAULT do Postgres sinh
const dn = await d.$queryRawUnsafe<Array<{ co_default: string; n: string }>>(
  `SELECT CASE WHEN column_default ILIKE '%now()%' OR column_default ILIKE '%CURRENT_TIMESTAMP%'
               THEN 'CÓ default now()' ELSE 'KHÔNG có default' END AS co_default, count(*)::text n
     FROM information_schema.columns
    WHERE table_schema='public' AND data_type LIKE 'timestamp%'
    GROUP BY 1`);
console.log('\n── 312 cột mốc thời gian chia theo DEFAULT ──');
for (const x of dn) console.log('  ' + x.co_default.padEnd(20), x.n, 'cột');
process.exit(0);
