-- SIGMA (24/7, Admin Demo yeu cau mo rong buoc dang ky): them ho so co ban cho Agent - email (dinh danh
-- dang nhap chinh + tim kiem sau nay), gioi tinh, ngay sinh, so dien thoai (CHUA bat buoc luc dang ky).
-- Additive thuan: 4 cot moi nullable, KHONG dung bang/cot cu.

ALTER TABLE "agents" ADD COLUMN "email" TEXT;
ALTER TABLE "agents" ADD COLUMN "gender" TEXT;
ALTER TABLE "agents" ADD COLUMN "date_of_birth" DATE;
ALTER TABLE "agents" ADD COLUMN "phone" TEXT;

CREATE UNIQUE INDEX "agents_email_key" ON "agents"("email");
