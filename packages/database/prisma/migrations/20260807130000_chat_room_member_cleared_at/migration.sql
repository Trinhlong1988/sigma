-- XÓA HỘI THOẠI kiểu Zalo (7/8, Admin Demo) — cột clearedAt: mọi tin có createdAt <= cleared_at bị ẨN nội dung khỏi
-- CHÍNH agent này (list message lọc, unread đếm từ cleared_at). Nullable timestamptz(3), khớp schema.prisma
-- ChatRoomMember.clearedAt @db.Timestamptz(3).
--
-- BỐI CẢNH (R198 chống drift): cột này TRƯỚC ĐÂY được áp TAY thẳng lên DB production `sigma` mà KHÔNG có file
-- migration → DB mới/throwaway/CI thiếu cột (chat-room-service.test fail 38/43). File này bù lại để `migrate
-- deploy` dựng đúng schema ở mọi môi trường. Production đã có cột → đánh dấu `migrate resolve --applied` (KHÔNG
-- chạy lại câu lệnh này, tránh lỗi "column already exists").
ALTER TABLE "chat_room_members" ADD COLUMN "cleared_at" TIMESTAMPTZ(3);
