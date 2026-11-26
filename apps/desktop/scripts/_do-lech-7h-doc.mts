// Câu hỏi quyết định: chiều ĐỌC có bù lại 7h không? Nếu CÓ thì sửa chiều ghi mà không dịch dữ liệu cũ
// sẽ làm MỌI mốc CŨ hiển thị sai 7 giờ. Chạy trên DB THỬ, không sửa gì.
import { getDb } from '../../quanly-api/src/db.js';

const urlDb = process.env.DATABASE_URL ?? '';
if (!/thu|test/i.test(urlDb)) { console.error('[do-doc] DỪNG: không phải DB thử.'); process.exit(3); }
const d = getDb() as unknown as {
  $queryRawUnsafe: <T>(sql: string, ...a: unknown[]) => Promise<T>;
  $executeRawUnsafe: (sql: string, ...a: unknown[]) => Promise<number>;
  loginSession: { findUnique: (a: unknown) => Promise<{ createdAt: Date } | null> };
};

const MOC_SO = '2026-06-15T03:04:05.000Z'; // mốc THẬT muốn có trong sổ
const gio = (ms: number): string => (ms / 3600000).toFixed(3) + 'h';
const uid = (await d.$queryRawUnsafe<Array<{ id: number }>>(`SELECT id FROM users ORDER BY id LIMIT 1`))[0].id;

async function thu(nhan: string, tz: string): Promise<void> {
  await d.$executeRawUnsafe(`SET TIME ZONE '${tz}'`);
  const id = 'do-doc-' + Math.abs(Number(process.hrtime.bigint() % 100000000n));
  // Ghi bằng CHUỖI ISO (đường luôn đúng) để trong sổ chắc chắn là MOC_SO.
  await d.$executeRawUnsafe(
    `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
     VALUES ($1,$2,$3::timestamptz,$3::timestamptz,$3::timestamptz,'do-doc')`, id, uid, MOC_SO);
  const trongSo = (await d.$queryRawUnsafe<Array<{ utc: string }>>(
    `SELECT to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') utc FROM login_sessions WHERE id=$1`, id))[0].utc;
  const quaModel = await d.loginSession.findUnique({ where: { id } });
  console.log('  ' + nhan.padEnd(30),
    '| trong sổ:', trongSo,
    '| Prisma ĐỌC ra:', quaModel?.createdAt.toISOString(),
    '| lệch đọc:', gio((quaModel?.createdAt.getTime() ?? 0) - Date.parse(MOC_SO)));
  await d.$executeRawUnsafe(`DELETE FROM login_sessions WHERE id=$1`, id);
}

console.log('Mốc THẬT trong sổ:', MOC_SO, '\n── chiều ĐỌC ──');
await thu('múi giờ phiên Asia/Bangkok', 'Asia/Bangkok');
await thu('múi giờ phiên UTC', 'UTC');
process.exit(0);
