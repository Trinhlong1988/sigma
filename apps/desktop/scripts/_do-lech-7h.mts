// ĐO GỐC lệch 7 giờ — chạy trên DB THỬ. Không sửa gì, chỉ đo.
//   (1) Prisma GHI một mốc đã biết → đọc lại bằng SQL thô: lệch bao nhiêu?
//   (2) Prisma ĐỌC lại mốc đó qua model: lệch bao nhiêu?
//   (3) $queryRaw đọc cùng cột: lệch bao nhiêu?
//   (4) Múi giờ của phiên Postgres + của tiến trình Node.
import { getDb } from '../../quanly-api/src/db.js';

const urlDb = process.env.DATABASE_URL ?? '';
if (!/thu|test/i.test(urlDb)) {
  console.error('[do-lech] DỪNG: DATABASE_URL không trỏ DB thử.');
  process.exit(3);
}
const db = getDb() as never;
const d = db as unknown as {
  $queryRawUnsafe: <T>(sql: string, ...a: unknown[]) => Promise<T>;
  $executeRawUnsafe: (sql: string, ...a: unknown[]) => Promise<number>;
  loginSession: {
    create: (a: unknown) => Promise<{ id: string; createdAt: Date }>;
    findUnique: (a: unknown) => Promise<{ createdAt: Date } | null>;
    delete: (a: unknown) => Promise<unknown> };
};

const mocBiet = new Date('2026-06-15T03:04:05.000Z'); // 10:04:05 giờ VN
const id = 'do-lech-7h-' + Date.now();

const tz = await d.$queryRawUnsafe<Array<{ tz: string; now_utc: string }>>(
  `SELECT current_setting('TimeZone') AS tz, to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS') AS now_utc`);
console.log('Múi giờ phiên Postgres :', tz[0].tz, '| now() theo UTC:', tz[0].now_utc);
console.log('Múi giờ tiến trình Node:', Intl.DateTimeFormat().resolvedOptions().timeZone, '| lệch phút:', new Date().getTimezoneOffset());
console.log('Mốc đem ghi (UTC)      :', mocBiet.toISOString());

const uid = (await d.$queryRawUnsafe<Array<{ id: number }>>(`SELECT id FROM users ORDER BY id LIMIT 1`))[0].id;
await d.loginSession.create({ data: { id, userId: uid, createdAt: mocBiet, expiresAt: mocBiet, lastSeenAt: mocBiet, deviceInfo: 'do-lech-7h' } });

const tho = await d.$queryRawUnsafe<Array<{ utc: string }>>(
  `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS utc FROM login_sessions WHERE id = $1`, id);
const quaModel = await d.loginSession.findUnique({ where: { id } });
const quaRaw = await d.$queryRawUnsafe<Array<{ created_at: Date }>>(`SELECT created_at FROM login_sessions WHERE id = $1`, id);

const gio = (ms: number): string => (ms / 3600000).toFixed(3) + 'h';
console.log('\n── KẾT QUẢ ──');
console.log('Trong SỔ (đọc bằng to_char UTC) :', tho[0].utc,
  '→ lệch so với mốc ghi:', gio(Date.parse(tho[0].utc) - mocBiet.getTime()));
console.log('Prisma ĐỌC qua model            :', quaModel?.createdAt.toISOString(),
  '→ lệch:', gio((quaModel?.createdAt.getTime() ?? 0) - mocBiet.getTime()));
console.log('$queryRaw đọc cột               :', new Date(quaRaw[0].created_at).toISOString(),
  '→ lệch:', gio(new Date(quaRaw[0].created_at).getTime() - mocBiet.getTime()));

await d.loginSession.delete({ where: { id } });
console.log('\nđã dọn bản ghi đo');
process.exit(0);
