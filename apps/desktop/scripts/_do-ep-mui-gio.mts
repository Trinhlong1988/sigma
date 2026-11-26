// Kiểm chứng cách ép múi giờ ở tầng kết nối CÓ ĂN không — chạy trên DB THỬ (múi giờ DB vẫn Asia/Bangkok).
import { getDb } from '../../quanly-api/src/db.js';
const urlDb = process.env.DATABASE_URL ?? '';
if (!/thu|test/i.test(urlDb)) { console.error('DỪNG: không phải DB thử.'); process.exit(3); }
const d = getDb() as unknown as { $queryRawUnsafe: <T>(s: string) => Promise<T> };
const r = await d.$queryRawUnsafe<Array<{ tz: string }>>(`SELECT current_setting('TimeZone') AS tz`);
console.log('Múi giờ phiên khi kết nối qua lớp đã vá:', r[0].tz, r[0].tz === 'UTC' ? '→ ĂN' : '→ KHÔNG ăn');
process.exit(0);
