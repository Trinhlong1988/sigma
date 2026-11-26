-- NHA DAU TU Phase E — "Nhom chat rieng cua NDT" (NHAN BAN customer_chat_groups nhung theo investor_id, KHONG
-- khoa theo loai phi). 1 NDT co NHIEU nhom chat TU DO; moi nhom = 1 phong NOI BO SigMa (room_id -> chat_rooms),
-- luu kem name/link/qr/note de hien thi. Additive thuan, bang MOI + 1 cot nullable tren receive_accounts.
--
-- MO HINH KY (nhu customer_chat_groups): moi hang = 1 KY gan; assigned_from = moc bat dau (default now);
-- unassigned_at = moc ket thuc (NULL = dang gan / active). Xoa = set unassigned_at = now (dong ky, GIU lich su).
-- KHONG partial-unique theo investor_id (nhieu nhom active/NDT duoc phep). Idempotent (IF NOT EXISTS) — khop
-- self-heal apps/desktop/src/main/db.ts (client .exe khong co migrate engine).
--
-- CHUA AP LEN DB `sigma` luc tao file nay — LEAD (Admin Demo) tu chay `prisma migrate deploy` + `prisma generate`
-- khi san sang (migrate TRUOC, generate SAU). Test tu dong (vitest) chay tren fake db in-memory — KHONG dung DB that.

-- CreateTable
CREATE TABLE IF NOT EXISTS "investor_chat_groups" (
    "id" SERIAL NOT NULL,
    "investor_id" INTEGER NOT NULL,
    "room_id" TEXT,
    "name" TEXT,
    "link" TEXT,
    "qr" TEXT,
    "note" TEXT,
    "assigned_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassigned_at" TIMESTAMPTZ(3),
    "created_by" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "investor_chat_groups_pkey" PRIMARY KEY ("id")
);

-- Loc nhanh theo NDT (list nhom chat cua 1 NDT).
CREATE INDEX IF NOT EXISTS "investor_chat_groups_investor_id_idx" ON "investor_chat_groups"("investor_id");

-- receive_accounts: gan nhom chat cua NDT vao TK nhan tien khi uy=NDT ("o uy nhu khach"). Nullable, additive.
ALTER TABLE "receive_accounts" ADD COLUMN IF NOT EXISTS "investor_chat_group_id" INTEGER;
