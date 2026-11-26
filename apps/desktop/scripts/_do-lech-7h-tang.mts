// ĐO TẦNG NÀO gây lệch 7h — so 3 cách ghi CÙNG một mốc, trên DB THỬ. Không sửa gì.
//   A) Prisma model (adapter-pg)        B) $executeRaw truyền Date      C) $executeRaw truyền CHUỖI ISO
// Và thử lại toàn bộ khi ÉP múi giờ phiên = UTC, để biết cách sửa nào ăn.
import { getDb } from '../../quanly-api/src/db.js';

const urlDb = process.env.DATABASE_URL ?? '';
if (!/thu|test/i.test(urlDb)) { console.error('[do-tang] DỪNG: không phải DB thử.'); process.exit(3); }
const d = getDb() as unknown as {
  $queryRawUnsafe: <T>(sql: string, ...a: unknown[]) => Promise<T>;
  $executeRawUnsafe: (sql: string, ...a: unknown[]) => Promise<number>;
};

const MOC = new Date('2026-06-15T03:04:05.000Z');
const gio = (ms: number): string => (ms / 3600000).toFixed(3) + 'h';

async function doMot(nhan: string, ghi: (id: string) => Promise<void>): Promise<void> {
  const id = 'do-tang-' + Math.abs(Number(process.hrtime.bigint() % 100000000n));
  await ghi(id);
  const r = await d.$queryRawUnsafe<Array<{ utc: string }>>(
    `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') utc FROM login_sessions WHERE id=$1`, id);
  console.log('  ' + nhan.padEnd(34), r[0].utc, '→ lệch', gio(Date.parse(r[0].utc) - MOC.getTime()));
  await d.$executeRawUnsafe(`DELETE FROM login_sessions WHERE id=$1`, id);
}

const uid = (await d.$queryRawUnsafe<Array<{ id: number }>>(`SELECT id FROM users ORDER BY id LIMIT 1`))[0].id;
const chen = (id: string, val: unknown, kieu = ''): Promise<number> => d.$executeRawUnsafe(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,$2,$3${kieu},$3${kieu},$3${kieu},'do-tang')`, id, uid, val);

console.log('Mốc đem ghi:', MOC.toISOString(), '· múi giờ phiên PG hiện tại:',
  (await d.$queryRawUnsafe<Array<{ tz: string }>>(`SELECT current_setting('TimeZone') tz`))[0].tz);

console.log('\n── GHI bằng 3 cách (múi giờ phiên như hiện tại) ──');
await doMot('$executeRaw truyền Date', (id) => chen(id, MOC).then(() => undefined));
await doMot('$executeRaw truyền CHUỖI ISO', (id) => chen(id, MOC.toISOString(), '::timestamptz').then(() => undefined));

console.log('\n── GHI lại sau khi ÉP múi giờ phiên = UTC ──');
await d.$executeRawUnsafe(`SET TIME ZONE 'UTC'`);
await doMot('$executeRaw truyền Date (TZ=UTC)', (id) => chen(id, MOC).then(() => undefined));
await doMot('$executeRaw CHUỖI ISO (TZ=UTC)', (id) => chen(id, MOC.toISOString(), '::timestamptz').then(() => undefined));
process.exit(0);
