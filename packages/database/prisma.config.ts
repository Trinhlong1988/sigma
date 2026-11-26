import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: process.env.DATABASE_URL,
    // shadowDatabaseUrl: BẮT BUỘC cho `prisma migrate diff --from-migrations` trên Prisma 7 (replay migrations
    // vào 1 DB tạm để so với schema). Đọc từ ENV — KHÔNG hardcode credential/DB thật. Guard chống drift
    // (test/schema-drift-guard.test.ts) + CI tự tạo 1 DB throwaway rồi set SHADOW_DATABASE_URL trước khi diff.
    shadowDatabaseUrl: process.env.SHADOW_DATABASE_URL,
  },
});
