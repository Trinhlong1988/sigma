// Prisma client factory (Prisma 7 + @prisma/adapter-pg driver adapter).
// G10: FULL-SWITCH SQLite → PostgreSQL. pg is pure-JS → packages cleanly into
// Electron (.exe) with no native .node addon and no query-engine binary.
// Electron main passes a postgresql:// url built from the server-config file; dev uses .env.
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

// LƯỚI AN TOÀN chống query khổng lồ (audit 20/8 "list endpoints DoS", Admin Demo duyệt 3/9): findMany KHÔNG khai `take`
// bị cap ở LIST_HARD_CAP. Đặt CAO (50k — trên MỌI list thật của SigMa) nên KHÔNG bao giờ chạm dữ liệu thật; chỉ chặn
// quét bệnh lý/độc hại (bound bộ nhớ). Lấy cap+1 để PHÁT HIỆN chạm trần → warn (chống cắt CÂM R198: nếu 1 list thật
// vượt 50k thì log báo "cần phân trang thật", KHÔNG âm thầm mất dòng). Query CÓ khai take/cursor → giữ nguyên.
export const LIST_HARD_CAP = 50_000;

/** Query đã TỰ giới hạn (khai `take` hoặc `cursor`) → KHÔNG áp cap. Thuần, test được không cần DB. */
export function isBoundedFind(args: { take?: unknown; cursor?: unknown; [k: string]: unknown } | undefined): boolean {
  return args?.take !== undefined || args?.cursor !== undefined;
}
/** Cắt kết quả về cap nếu VƯỢT (chỉ khi query không tự giới hạn). Trả {rows, truncated}. truncated=true → caller warn
 *  (chống cắt CÂM R198). Đã lấy cap+1 ở tầng args nên rows.length>cap ⟺ thực sự còn nhiều hơn cap. */
export function applyListCap<T>(rows: T, bounded: boolean, cap = LIST_HARD_CAP): { rows: T; truncated: boolean } {
  if (!bounded && Array.isArray(rows) && rows.length > cap) return { rows: rows.slice(0, cap) as unknown as T, truncated: true };
  return { rows, truncated: false };
}

// GIỮ Db = PrismaClient (extension chỉ BỌC findMany ở runtime — KHÔNG đổi chữ ký kiểu; cast lại để không lan type
// extended ra toàn repo, vốn phá `Db`/`TransactionClient`). Extension áp CẢ trong $transaction (Prisma giữ extension
// cho interactive tx) nên cap phủ mọi findMany, kể cả trong giao dịch.
export type Db = PrismaClient;

export function createPrisma(databaseUrl?: string): PrismaClient {
  const connectionString = databaseUrl ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL không được cấu hình. Cần chuỗi postgresql:// (server-config hoặc .env)."
    );
  }
  // [B210 19/11 — Admin Demo "fix lỗi 7 tiếng"] ÉP MÚI GIỜ PHIÊN = UTC.
  //
  // GỐC (đo 3 lần, không suy luận): thư viện gửi mốc thời gian xuống dạng giờ UTC NHƯNG KHÔNG kèm múi giờ.
  // Máy chủ đang đặt TimeZone=Asia/Bangkok nên tự gán +07 vào chuỗi đó ⇒ GHI lệch −7h. Lúc ĐỌC thì sai
  // ngược lại +7h ⇒ hai cái BÙ NHAU nên app nhìn thấy đúng, lỗi sống nhiều tháng mà không ai thấy.
  // Nó chỉ lộ khi so với now() của máy chủ (vd đếm nhật ký trong 5 phút ra 0 dù vừa ghi 2 vết) hoặc khi
  // đọc bằng SQL thuần. Đo thật: giao TID lúc 17:13 → sổ lưu 10:13.
  //
  // Đặt múi giờ phiên = UTC thì CẢ GHI LẪN ĐỌC đều đúng tuyệt đối. Mọi câu đang viết
  // `AT TIME ZONE 'Asia/Ho_Chi_Minh'` KHÔNG đổi kết quả (timestamptz là mốc tuyệt đối).
  // ĐI KÈM: dữ liệu cũ đã được dịch +7h một lần (xem BUGS_FIXED B210) — thiếu bước đó thì mốc cũ hiển thị
  // sớm 7 tiếng.
  // CÔNG TẮC: mặc định TẮT. Bật bằng biến môi trường SIGMA_GIO_UTC=1 — và CHỈ được bật SAU KHI đã dịch
  // dữ liệu cũ +7h. Bật mà chưa dịch thì mọi mốc CŨ hiển thị SỚM 7 TIẾNG ngay lập tức (ngày bill, giờ quẹt,
  // báo cáo theo kỳ). Thứ tự bắt buộc: dừng app → dịch dữ liệu → bật cờ này → bật app.
  const epUtc = process.env['SIGMA_GIO_UTC'] === '1';
  const adapter = epUtc
    ? new PrismaPg({ connectionString, options: '-c timezone=UTC' })
    : new PrismaPg({ connectionString });
  const base = new PrismaClient({ adapter });
  const extended = base.$extends({
    query: {
      $allModels: {
        async findMany({ args, query, model }) {
          const bounded = isBoundedFind(args);
          if (!bounded) args.take = LIST_HARD_CAP + 1; // +1 để phân biệt "đúng bằng cap" vs "còn nữa"
          const raw = await query(args);
          const { rows, truncated } = applyListCap(raw, bounded);
          if (truncated) console.warn(`[list-cap] ${model}.findMany vượt LIST_HARD_CAP=${LIST_HARD_CAP} → CẮT còn ${LIST_HARD_CAP}. Bảng này CẦN phân trang thật.`);
          return rows;
        }
      }
    }
  });
  return extended as unknown as PrismaClient;
}
