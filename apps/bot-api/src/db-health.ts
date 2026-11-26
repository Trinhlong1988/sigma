// SỨC KHỎE DATABASE (30/9 — Admin Demo duyệt sau sự cố "app báo Lỗi kết nối mạng" tối 30/9).
//
// GỐC SỰ CỐ: máy tắt đột ngột 19:06 → boot lại 19:49 → PostgreSQL phải crash-recovery → mọi truy vấn Prisma
// ném `57P03: the database system is starting up`. Hai điểm hở lộ ra:
//   (1) `/health` của bot-api CHỈ trả {ok:true} TĨNH, KHÔNG chạm DB → watchdog ghi "OK health 200" đều đặn
//       trong khi app người dùng đang chết vì DB. Đúng mẫu bug "check không thật sự chạy = false PASS"
//       (R198 + memory feedback_silent_swallow_false_pass_engine_migration).
//   (2) Lỗi 57P03 rơi vào nhánh 500 INTERNAL_ERROR chung → client dịch thành "Lỗi kết nối mạng, vui lòng
//       kiểm tra đường truyền" → SAI BẢN CHẤT (mạng vẫn tốt, chỉ DB đang dậy) → Admin Demo tưởng mất mạng.
//
// File TÁCH RIÊNG (không nhét vào app.ts) để test đơn vị gọi thẳng `phanLoaiLoiDb()` với từng hình dạng lỗi
// THẬT của Prisma 7 + @prisma/adapter-pg mà KHÔNG cần dựng app/DB — xem test/db-health.test.ts.
import type { Db } from '@sigma/database';

/** Trạng thái DB nhìn từ bot-api. `up` = truy vấn được; `starting` = đang khởi động/recovery (SẼ tự lành,
 * KHÔNG được restart bot-api vì restart không giúp gì); `down` = không kết nối được (cần người xử lý). */
export type TrangThaiDb = 'up' | 'starting' | 'down';

// SQLSTATE PostgreSQL. 57P03 = "cannot_connect_now" — postmaster còn đang khởi động/recovery, sẽ nhận kết nối
// sau vài giây/phút. 57P01/57P02 = admin shutdown/crash shutdown. 08xxx = nhóm lỗi kết nối.
const MA_DANG_KHOI_DONG = new Set(['57P03']);
const MA_KHONG_KET_NOI = new Set(['57P01', '57P02', '08006', '08001', '08004', '08003', 'P1001', 'P1002', 'P1017']);
const MA_MANG = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'ETIMEDOUT', 'EHOSTUNREACH']);

/** Prisma 7 bọc lỗi driver nhiều tầng (`err.meta.driverAdapterError.cause.code`, `err.cause.code`...) nên
 * KHÔNG thể chỉ đọc `err.code` — vụ 30/9 lỗi ngoài cùng là `P2039`, mã thật `57P03` nằm sâu bên trong.
 * Hàm này duyệt CÓ GIỚI HẠN ĐỘ SÂU (chống vòng lặp/đối tượng tự trỏ) thu mọi `code` dạng chuỗi gặp được. */
function thuThapMa(err: unknown, doSau = 0, daGap = new Set<unknown>()): string[] {
  if (doSau > 6 || err === null || typeof err !== 'object' || daGap.has(err)) return [];
  daGap.add(err);
  const o = err as Record<string, unknown>;
  const ma: string[] = [];
  if (typeof o.code === 'string') ma.push(o.code);
  for (const khoa of ['cause', 'meta', 'driverAdapterError', 'originalError'] as const) {
    if (o[khoa] !== undefined) ma.push(...thuThapMa(o[khoa], doSau + 1, daGap));
  }
  return ma;
}

/** Gom toàn bộ text của lỗi (message lồng nhau) — dự phòng cho trường hợp driver KHÔNG kèm `code` mà chỉ có
 * câu "the database system is starting up" (đã thấy thật trong log bot-api tối 30/9). */
function gomText(err: unknown, doSau = 0, daGap = new Set<unknown>()): string {
  // Chặn vòng lặp GIỐNG thuThapMa: lỗi có `cause` tự trỏ về chính nó (hoặc trỏ vòng qua nhau) sẽ đệ quy vô
  // tận → RangeError "Maximum call stack size exceeded" NGAY TRONG errorHandler, tức là sập đúng lúc đang xử
  // lý một lỗi khác. Bản đầu tiên của hàm này THIẾU chốt đó và bị test `đối tượng lỗi TỰ TRỎ VÒNG` bắt được.
  if (doSau > 6 || err === null || err === undefined) return '';
  if (typeof err === 'string') return err;
  if (typeof err !== 'object') return '';
  if (daGap.has(err)) return '';
  daGap.add(err);
  if (err instanceof Error) return `${err.message} ${gomText((err as { cause?: unknown }).cause, doSau + 1, daGap)}`;
  const o = err as Record<string, unknown>;
  return [o.message, o.cause, o.meta].map((v) => (typeof v === 'string' ? v : gomText(v, doSau + 1, daGap))).join(' ');
}

/** Phân loại 1 lỗi bất kỳ ném ra từ Prisma. Trả `null` nghĩa là KHÔNG phải lỗi hạ tầng DB (lỗi nghiệp vụ,
 * validation, lỗi code...) — caller phải giữ nguyên đường xử lý cũ, TUYỆT ĐỐI không nuốt thành lỗi DB. */
export function phanLoaiLoiDb(err: unknown): 'starting' | 'down' | null {
  const ma = thuThapMa(err);
  const text = gomText(err).toLowerCase();
  if (ma.some((m) => MA_DANG_KHOI_DONG.has(m))) return 'starting';
  // Câu nguyên văn của PostgreSQL cho 57P03 (2 biến thể: đang lên / đang tắt).
  if (text.includes('the database system is starting up')) return 'starting';
  if (text.includes('the database system is shutting down')) return 'down';
  if (ma.some((m) => MA_KHONG_KET_NOI.has(m) || MA_MANG.has(m))) return 'down';
  if (text.includes("can't reach database server") || text.includes('connection refused')) return 'down';
  return null;
}

/** Truy vấn THẬT vào DB (`SELECT 1`) để biết bot-api có dùng được DB hay không — dùng cho /health/deep.
 * KHÔNG bao giờ throw: mọi lỗi được phân loại thành `starting`/`down` (lỗi lạ không nhận ra → `down`, tức
 * fail-closed, KHÔNG báo xanh khi không chắc — đúng R198). */
export async function kiemTraDb(db: Pick<Db, '$queryRaw'>): Promise<TrangThaiDb> {
  try {
    await db.$queryRaw`SELECT 1`;
    return 'up';
  } catch (err) {
    return phanLoaiLoiDb(err) === 'starting' ? 'starting' : 'down';
  }
}
