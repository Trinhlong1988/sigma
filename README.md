# SigMa

SigMa là nền tảng **quản lý vận hành + chat nội bộ** cho mô hình phân phối mã kích hoạt máy POS (TID) tới đại
lý: quản lý TID/đại lý/nhà đầu tư, tính phí, nhận tiền QR, đối soát hóa đơn (bill) bằng OCR, chống gian lận và
báo cáo doanh số. Đây là **bản DEMO trắng data** (white-label) — không chứa dữ liệu khách hàng/tiền thật; mọi
bí mật là placeholder `<DIEN_VAO>`.

## Kiến trúc tóm tắt

Monorepo npm workspaces. Luồng dữ liệu chuẩn:

```
giao diện (Electron/Web)  →  HTTP /v1/...  →  API server  →  service core (packages/services)  →  Prisma  →  PostgreSQL
```

- `apps/desktop` — app quản lý (Electron + React + TypeScript + Tailwind v4).
- `apps/quanly-api` — REST thuần-server (cổng 8790) = **lớp nghiệp vụ LIVE** cho desktop.
- `apps/bot-api` — API chat nội bộ + ingest bill OCR + đăng ký/OTP + push (cổng 8788).
- `apps/web-demo` — web chat + dự án Capacitor Android.
- `packages/` — `shared` (permission/role), `business-rules` (luật nghiệp vụ, băm mật khẩu, chống gian lận),
  `database` (Prisma schema/migrations/seed), `services` (lõi service dày).

Chi tiết cho người phát triển và cho AI: xem `CLAUDE.md` và `docs/AI-ONBOARD.md`.

## Yêu cầu
- Node.js ≥ 20
- PostgreSQL ≥ 14 (khuyến nghị 16)
- npm (dùng workspaces)

## Các bước chạy (bản demo trắng data)

```bash
# 1) Lấy mã nguồn
git clone <REPO-URL> sigma && cd sigma

# 2) Cài phụ thuộc (toàn monorepo)
npm install

# 3) Cấu hình môi trường — copy file mẫu rồi điền giá trị <DIEN_VAO>
cp apps/bot-api/.env.example apps/bot-api/.env
cp apps/web-demo/.env.example apps/web-demo/.env
#   Bắt buộc sửa DATABASE_URL trong apps/bot-api/.env:
#   DATABASE_URL=postgresql://postgres:<MAT_KHAU>@localhost:5432/sigma

# 4) Tạo DB trống + bảng + dữ liệu mẫu
createdb sigma                     # hoặc tạo DB tên "sigma" bằng công cụ của bạn
npm run db:setup                   # = db:generate + db:migrate (migrate deploy) + db:seed

# 5) Chạy
npm run dev                        # app desktop (electron-vite dev)
# (API/web chạy riêng: npm run dev --workspace @sigma/quanly-api, v.v.)
```

Sau khi seed xong, đăng nhập bằng tài khoản quản trị **DEMO**:

```
username: admin
password: admin123
```

> Đây là mật khẩu DEMO ghi công khai cho bản trắng. **Đổi ngay** khi dùng thật.

## Build + kiểm thử + cổng

```bash
npm run build          # build desktop
npm test               # vitest toàn repo
node scripts/gate-test.mjs     # cổng gate tổng hợp trước ship (chạy kiem-luat-* + các suite)
node scripts/kiem-scrub.mjs    # cổng kiểm white-label (không còn bí mật/PII/dấu vết nội bộ)
```

## Ghi chú về bản white-label
- Lịch sử lỗi/phiên bản nội bộ của dự án gốc đã được loại bỏ; `BUGS_FIXED.md` / `VERSION.md` bắt đầu mới.
- Cấu hình feed cập nhật / tunnel / tên miền thật đã bị gỡ — bạn tự dựng hạ tầng của mình.
- Dữ liệu mẫu (bank, loại phí, loại thẻ) chỉ để minh hoạ; TID/khách/bill thật không được seed.
