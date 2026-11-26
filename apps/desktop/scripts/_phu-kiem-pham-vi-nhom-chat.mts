// Phụ trợ cho `_kiem-bo-chan-nhom-chat.mjs` — gọi THẲNG engine báo giá để so 2 luồng trên CÙNG một TID:
//   · luồng BOT (không cờ)      → PHẢI vẫn bị chặn TID_NOT_IN_AGENT_SCOPE
//   · luồng NHÂN VIÊN nhập tay  → PHẢI qua được
// Chạy bằng `npx tsx` vì engine viết bằng TypeScript. In ra JSON một dòng cho cổng .mjs đọc.
// Dùng ĐÚNG lớp tạo kết nối của API (Prisma 7 + adapter-pg) — import thẳng '@prisma/client' không ra
// PrismaClient ở bản này, và dựng kết nối kiểu khác thì không còn là "cùng engine" nữa.
import { getDb } from '../../quanly-api/src/db.js';
import { quoteRow } from '../../bot-api/src/fee-quote.js';

const tidId = Number(process.argv[2]);
const agentId = Number(process.argv[3]);
const cardTypeId = process.argv[4] ? Number(process.argv[4]) : undefined;
// CHẶN CỨNG: chỉ cho chạy trên DB THỬ. getDb() đọc DATABASE_URL từ biến môi trường, nên nếu máy nào đó
// đang xuất sẵn chuỗi nối SỔ THẬT thì phải dừng chứ không được đụng vào.
const urlDb = process.env.DATABASE_URL ?? '';
if (!/thu|test/i.test(urlDb)) {
  console.error('[phu-kiem] DỪNG: DATABASE_URL không trỏ DB thử.');
  process.exit(3);
}
const db = getDb() as never;

const bot = await quoteRow(db, agentId, { tidId, cardTypeId, amountBeforeFee: 1_000_000 });
const tay = await quoteRow(db, agentId, { tidId, cardTypeId, amountBeforeFee: 1_000_000, nhanVienNhapTay: true });
console.log(JSON.stringify({
  bot: bot.ok ? { ok: true } : { ok: false, error: bot.error },
  tay: tay.ok ? { ok: true } : { ok: false, error: tay.error }
}));
await (db as unknown as { $disconnect: () => Promise<void> }).$disconnect();
process.exit(0);
