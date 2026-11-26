# BUGS_FIXED — SigMa

> Sổ đăng ký lỗi đã sửa cho dự án SigMa. Đây là bản DEMO white-label: lịch sử lỗi nội bộ của dự án gốc
> đã được loại bỏ vì chứa dữ liệu thật (tiền/tên/HKD/TID). Bắt đầu ghi mới từ đây.

## Quy ước (RULE CỨNG — kế thừa quy trình gốc)

Mỗi lần phát hiện bug mới = **thất bại của quy trình kiểm thử**, không chỉ của module. Sau khi sửa:

1. Ghi 1 mục vào file này TRƯỚC khi commit: mã lỗi, mô tả, nguyên nhân gốc, cách vá, test hồi quy đã thêm.
2. **Bắt buộc thêm regression test** để lớp lỗi đó không lọt lại (ưu tiên mở rộng bug-class, không chỉ vá 1 ca).
3. Nếu lỗi do quy trình, đề xuất đổi quy trình / thêm cổng kiểm (`scripts/kiem-*.mjs`).
4. Cập nhật `VERSION.md` nếu có bump phiên bản artifact.

## Mẫu một mục

```
### Bxxx (YYYY-MM-DD) — <tiêu đề ngắn>
- Hiện tượng: ...
- Nguyên nhân gốc: ...
- Cách vá: <file:dòng> ...
- Regression test: <đường dẫn test> ...
- Cổng/kiểm bổ sung: ...
```

<!-- Thêm mục mới bên dưới, mới nhất ở trên. -->
