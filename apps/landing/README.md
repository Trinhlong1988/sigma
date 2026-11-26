# SigMa — Landing (trang giới thiệu)

Trang giới thiệu (marketing) + khu tải về cho sản phẩm **SigMa**. Đây **KHÔNG** phải app chat thật —
chỉ là "link giới thiệu" dự án: showcase thương hiệu, tính năng và cho tải bản cài.

Cùng stack với `apps/web-demo` (Vite + React 19 + TypeScript + Tailwind v4) và **dùng lại brand token +
logo THẬT** (`src/assets/alpha-logo.webp` copy nguyên từ web-demo, màu `#0579cc → #13b7c3`, font Be Vietnam Pro).

## Chạy

```bash
cd apps/landing
npm install
npm run dev        # http://localhost:5273
```

Các lệnh khác:

```bash
npm run typecheck  # kiểm tra kiểu
npm run build      # typecheck + build ra dist/
npm run preview    # xem thử bản build (port 4173)
```

## Các section

1. **Nav** — thanh điều hướng dính, kính mờ, có chuyển sáng/tối.
2. **Hero** — thông điệp chính + logo thật + mockup điện thoại chat.
3. **Bảo mật** (`#bao-mat`) — thông điệp lõi: bảo mật khách hàng & thông tin.
4. **Tính năng** (`#tinh-nang`) — nhắn tin 1-1 & nhóm, gọi thoại/video, gửi ảnh/file, tin nhắn thoại,
   danh bạ, kết bạn, chia sẻ vị trí, thông báo.
5. **Nghiệp vụ đại lý** (`#nghiep-vu`) — quét bill OCR + tính phí bán TID, đối chiếu hoàn tiền.
6. **Tải về** (`#tai-ve`) — 4 nền tảng (iOS / Android / PC / Web).
7. **Footer**.

## Chỗ gắn link/bản cài THẬT sau (placeholder)

Sửa mảng `PLATFORMS` trong `src/components/Download.tsx`:

| Nền tảng | Trạng thái hiện tại | Việc cần làm |
|---|---|---|
| **iOS** | Nút "Sắp có", disabled (không phải link chết) | Khi có App Store: bỏ `comingSoon`, thêm `href` + `external: true`. |
| **Android** | `href: /downloads/sigma-latest.apk` (download) | Đặt file APK thật vào `public/downloads/sigma-latest.apk`. |
| **PC (Windows)** | `href: /downloads/sigma-setup.exe` (download) | Đặt installer thật vào `public/downloads/sigma-setup.exe`. |
| **Web** | `href: '#'` (mở tab mới) | Đổi `href` thành URL bản web chính thức. |

> File trong `public/downloads/` sẽ được phục vụ ở đường dẫn gốc (vd `/downloads/sigma-latest.apk`).
> Thư mục hiện chỉ có `.gitkeep` — chưa có bản cài thật (Admin Demo gắn sau khi build xong).

## Ràng buộc thương hiệu (đã tuân thủ)

- Nhúng **chính file logo thật** `alpha-logo.webp` (không vẽ lại vector khác).
- Màu/gradient/glow/font copy nguyên từ `apps/web-demo/src/styles.css` — cùng một thương hiệu với app.
- Thương hiệu RIÊNG "SigMa", không nhái logo/màu Zalo.
