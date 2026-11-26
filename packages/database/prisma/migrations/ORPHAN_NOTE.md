# Ghi chú migration lệch (12/8) — KHÔNG phải lỗi, đọc trước khi dọn

Sau sự cố data-loss 12/8, DB production `sigma` có migration **`20260812110000_export_request_approve_elevated`**
đã applied (quyền EXPORT_REQUEST_APPROVE_ELEVATED + grant ADMIN có thật trong DB) NHƯNG **file local bị mất**
(chưa từng commit → không khôi phục được đúng bytes/checksum). Bản local hiện tại **`20260812120000_export_approve_elevated`**
làm CÙNG tác dụng (idempotent `ON CONFLICT DO NOTHING`), đang PENDING trên sigma.

**Trạng thái:** feature CHẠY ĐÚNG (permission + grant có trong DB). `migrate deploy` tương lai VẪN chạy (áp pending
120000 = no-op idempotent; migration 110000 "in DB not local" được deploy BỎ QUA — chỉ `migrate status`/`migrate dev`
báo thông tin). **KHÔNG** tự recreate 110000 (checksum prisma-normalized không tái tạo tay được → gây "modified after
applied") **KHÔNG** xoá 120000 (còn phủ DB mới). Để yên = an toàn nhất; muốn dọn triệt để phải purge/update record
`_prisma_migrations` production (thao tác DB thủ công, cần Admin Demo duyệt cửa sổ bảo trì).

Bài học: migration cho DB dùng-chung nên commit NGAY sau khi tạo (đừng để untracked → mất trong data-loss).
