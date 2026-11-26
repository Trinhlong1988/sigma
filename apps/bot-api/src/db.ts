// SigMa Tier 1 — Prisma client cho bot-api. Nối CÙNG DATABASE_URL / DB Postgres `glb` mà apps/desktop
// dùng (quyết định Admin Demo: SigMa share DB, KHÔNG tách DB riêng ở giai đoạn này). Đọc thẳng process.env
// (không qua server-config.json của Electron — bot-api là service Node thuần, không có userData).
import { createPrisma, type Db } from '@sigma/database';

let prisma: Db | undefined;

/**
 * Lấy Prisma client dùng chung (lazy singleton — tạo lần gọi đầu, đọc DATABASE_URL LÚC GỌI chứ không lúc
 * import module, để test đổi env trước khi gọi vẫn ăn đúng DB throwaway).
 * TODO: tách role Postgres least-privilege riêng cho bot-api (chỉ SELECT các bảng cần + không có quyền ghi
 * ngoài phạm vi Tier 1) trước khi lên production thật — hiện dùng chung tài khoản DB với apps/desktop.
 */
export function getBotDb(): Db {
  if (!prisma) prisma = createPrisma(process.env.DATABASE_URL);
  return prisma;
}

/** Cho phép test/global-teardown reset singleton giữa các lần đổi throwaway DB. */
export async function resetBotDb(): Promise<void> {
  if (prisma) {
    await prisma.$disconnect();
    prisma = undefined;
  }
}
