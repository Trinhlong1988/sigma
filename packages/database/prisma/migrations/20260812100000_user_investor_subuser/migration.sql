-- TÀI KHOẢN CON của Nhà đầu tư (Admin Demo 12/8) — user role R_INVESTOR do 1 NĐT tạo để chia sẻ quyền xem báo cáo
-- CỦA NĐT ĐÓ. Cột users.investor_id (scalar → investors.id, KHÔNG hard FK) + index. Quyền INVESTOR_SUBUSER_MANAGE
-- (nhóm INVESTOR) cho phép quản lý tài khoản con; grant ADMIN + MANAGER. TẤT CẢ idempotent (IF NOT EXISTS / ON
-- CONFLICT DO NOTHING) — chạy an toàn nhiều lần trên DB dùng chung. LEAD chạy `prisma migrate deploy` trên máy chủ.

-- 1) Cột + index tài khoản con.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "investor_id" INTEGER;
CREATE INDEX IF NOT EXISTS "users_investor_id_idx" ON "users" ("investor_id");

-- 2) Quyền quản lý tài khoản con (nhóm INVESTOR). code UNIQUE → ON CONFLICT DO NOTHING idempotent.
INSERT INTO "permissions" ("code", "name", "group")
VALUES ('INVESTOR_SUBUSER_MANAGE', 'Quản lý tài khoản xem của nhà đầu tư', 'INVESTOR')
ON CONFLICT ("code") DO NOTHING;

-- 3) Grant cho ADMIN + MANAGER (PK (role_id, permission_id) → ON CONFLICT DO NOTHING idempotent). ADMIN cũng được
--    superuser-sync mỗi boot, nhưng grant tường minh ở đây để migrate deploy trên máy chủ đủ ngay không chờ boot.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" IN ('ADMIN', 'MANAGER') AND p."code" = 'INVESTOR_SUBUSER_MANAGE'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
