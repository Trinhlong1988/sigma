-- QUYỀN TỰ DUYỆT yêu cầu xuất kho của CHÍNH mình (Admin Demo 12/8) — EXPORT_REQUEST_APPROVE_ELEVATED (nhóm "Yêu cầu
-- xuất kho"). Phân vai tạo≠duyệt: MANAGER/WAREHOUSE có APPROVE thường nhưng KHÔNG được tự duyệt phiếu mình tạo;
-- CHỈ ADMIN có ELEVATED (chốt bằng mật khẩu lúc duyệt). TẤT CẢ idempotent (ON CONFLICT DO NOTHING) — chạy an toàn
-- nhiều lần trên DB dùng chung. LEAD chạy `prisma migrate deploy` trên máy chủ (sigma).

-- 1) Mã quyền. code UNIQUE → ON CONFLICT DO NOTHING idempotent.
INSERT INTO "permissions" ("code", "name", "group")
VALUES ('EXPORT_REQUEST_APPROVE_ELEVATED', 'Tự duyệt yêu cầu xuất kho của chính mình (chốt bằng mật khẩu)', 'Yêu cầu xuất kho')
ON CONFLICT ("code") DO NOTHING;

-- 2) Grant CHỈ cho ADMIN (elevated = admin-only). ADMIN cũng được superuser-sync mỗi boot ở app desktop, nhưng
--    grant tường minh ở đây để migrate deploy trên máy chủ (không chạy db.ts self-heal) đủ ngay không chờ boot.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r."id", p."id"
FROM "roles" r
CROSS JOIN "permissions" p
WHERE r."code" = 'ADMIN' AND p."code" = 'EXPORT_REQUEST_APPROVE_ELEVATED'
ON CONFLICT ("role_id", "permission_id") DO NOTHING;
