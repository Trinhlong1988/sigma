// Bộ đếm sinh mã atomic DÙNG CHUNG (§D) — cùng bảng `code_counters` (model CodeCounter, schema.prisma) và
// cùng quy ước PREFIX + số thứ tự zero-pad ≥2 chữ số (NV01, KH01, NGH01... — xem formatCode/isValidCodePrefix
// ở @sigma/business-rules) mà apps/desktop/src/main/code-service.ts đã dùng từ trước cho NV/KH/NGH/BE/PT/PC/
// BS/CO/YCXK.
//
// TÁCH RA ĐÂY (packages/database — cả apps/desktop LẪN apps/bot-api đều đã phụ thuộc sẵn @sigma/business-rules
// + @sigma/database) để bot-api tái dùng ĐÚNG cơ chế atomic này cho Agent.code khi đại lý tự đăng ký
// (routes/auth.ts verify-otp + createAgentViaGoogle — trước đây Agent.code luôn null, khiến 2 đại lý tự đăng
// ký KHÔNG BAO GIỜ kết bạn được qua "thêm bạn qua mã đại lý" vì lookup đòi khớp code khác null tuyệt đối).
// KHÔNG viết lại 1 bản sao logic khác (prefix/padding/uniqueness khác) — bot-api KHÔNG import trực tiếp từ
// apps/desktop (đó là app Electron riêng, không phải package dùng chung, và là code thuộc governance riêng
// của dự án GLB IMS).
//
// QUYẾT ĐỊNH CÓ CHỦ ĐÍCH: apps/desktop/src/main/code-service.ts VẪN GIỮ NGUYÊN bản triển khai private của nó
// (KHÔNG refactor sang gọi hàm này trong lần sửa bug này) — tránh đụng vào code/test suite (ST1-44) của dự án
// GLB IMS ngoài phạm vi bug Agent.code đang sửa. Kết quả: 2 bản triển khai gần giống hệt nhau cùng tồn tại
// tạm thời (~15 dòng, đã có bằng chứng race-safe ở apps/desktop/src/main/selftest-concurrency.ts) — LEAD nên
// cân nhắc gộp lại (cho apps/desktop delegate sang đây) ở 1 lần sửa riêng, có chạy đủ ST1-44, không lẫn vào
// lần sửa bug Agent.code này.
import { formatCode, isValidCodePrefix } from '@sigma/business-rules';
import type { Db } from './client.js';

/** Prisma client HOẶC transaction handle bên trong $transaction — cả 2 đều có model `codeCounter`. */
type CodeCounterClient = Db | Parameters<Parameters<Db['$transaction']>[0]>[0];

/**
 * Mint mã tiếp theo cho `prefix`, atomic. `upsert` trên 1 hàng `code_counters` (create lastValue=1 nếu
 * prefix chưa từng dùng, ngược lại increment) là 1 câu lệnh Postgres DUY NHẤT (INSERT ... ON CONFLICT DO
 * UPDATE) — Postgres tự khóa hàng đó trong lúc ghi, nên N lệnh gọi `nextCode(cùng prefix)` song song (kể cả
 * từ N kết nối/PrismaClient độc lập) LUÔN được tuần tự hóa ở tầng DB và LUÔN trả N giá trị lastValue phân
 * biệt — KHÔNG có khoảng hở để 2 caller cùng đọc-rồi-ghi cùng 1 giá trị (khác lớp bug "check-then-act" không
 * khóa). Đây CHÍNH LÀ cơ chế đã dùng cho NV/KH/NGH/BE/PT/PC/BS/CO/YCXK ở apps/desktop, đã có bằng chứng
 * race-safe qua 20 PrismaClient độc lập hammer đồng thời 1 counter (xem
 * apps/desktop/src/main/selftest-concurrency.ts dòng ~181-223: 20/20 giá trị phân biệt, 0 lỗi P2002).
 *
 * Truyền `client` là transaction handle (`tx` bên trong `db.$transaction`) để việc tăng counter nằm CÙNG
 * transaction với việc tạo bản ghi dùng mã đó — nếu phần tạo bản ghi sau đó rollback (vd lỗi khác giữa
 * chừng), counter cũng rollback theo, không "đốt" số một cách không cần thiết. Giá trị đầu tiên = 1 →
 * `${prefix}01`.
 */
export async function nextCode(prefix: string, client: CodeCounterClient): Promise<string> {
  if (!isValidCodePrefix(prefix)) throw new Error(`Prefix mã không hợp lệ: ${prefix}`);
  const row = await client.codeCounter.upsert({
    where: { prefix },
    create: { prefix, lastValue: 1 },
    update: { lastValue: { increment: 1 } }
  });
  return formatCode(prefix, row.lastValue);
}
