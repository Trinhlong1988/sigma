# VERSION — SigMa

> Trạng thái phiên bản các artifact của SigMa. Bản DEMO white-label — lịch sử phiên bản nội bộ của dự án gốc
> đã được loại bỏ. Bắt đầu đánh mốc mới từ đây.

| Artifact            | Phiên bản | Ghi chú                          |
|---------------------|-----------|----------------------------------|
| monorepo (root)     | 0.1.0     | Bản white-label khởi tạo          |
| apps/desktop        | 0.1.0     | Electron quản lý                  |
| apps/bot-api        | 0.1.0     | API chat/ingest                   |
| apps/quanly-api     | 0.1.0     | REST quản lý (lớp LIVE)           |
| apps/web-demo       | 0.1.0     | Web + Capacitor Android           |

## Quy ước (session start protocol)

1. Đọc `CLAUDE.md` (gốc repo) + `docs/AI-ONBOARD.md`.
2. Đọc `VERSION.md` (file này) — so `last_known_version`, lệch → đọc lại artifact đã đổi.
3. Đọc `BUGS_FIXED.md` trước khi chạm code.
4. Mọi bump phiên bản artifact PHẢI cập nhật bảng trên.
5. Mọi fix bug PHẢI lưu `BUGS_FIXED.md` + thêm regression test trước commit.
