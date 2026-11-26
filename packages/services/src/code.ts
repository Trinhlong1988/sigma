// Identifier-code generator (§D). Atomic per-prefix counter in `code_counters`. PORT từ
// apps/desktop/src/main/code-service.ts nhưng `db` là PARAM BẮT BUỘC (đầu tiên) — KHÔNG default getDb() Electron.
// nextCode() là cách DUY NHẤT sinh mã — không suy từ autoincrement id (id có thể nhảy khoảng). Zero-pad ≥2 chữ số.
import { formatCode, isValidCodePrefix } from '@sigma/business-rules';
import type { Db } from '@sigma/database';

/** Prisma client ĐẦY ĐỦ HOẶC transaction handle — cả hai đều expose codeCounter. */
type Client = Db | Parameters<Parameters<Db['$transaction']>[0]>[0];

/**
 * Mint mã kế tiếp cho `prefix` một cách nguyên tử. Truyền transaction client để bump counter nằm chung transaction
 * lớn hơn (ví dụ tạo khách hàng). Giá trị đầu tiên là 1 → `${prefix}01`.
 * @param client Prisma client hoặc tx handle — BẮT BUỘC (không default Electron getDb()).
 */
export async function nextCode(client: Client, prefix: string): Promise<string> {
  if (!isValidCodePrefix(prefix)) throw new Error(`Prefix mã không hợp lệ: ${prefix}`);
  // upsert increments (or creates at 1) and returns the resulting row atomically.
  const row = await client.codeCounter.upsert({
    where: { prefix },
    create: { prefix, lastValue: 1 },
    update: { lastValue: { increment: 1 } }
  });
  return formatCode(prefix, row.lastValue);
}
