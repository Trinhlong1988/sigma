# SigMa — Nền tảng quản lý vận hành + chat nội bộ (bản DEMO white-label)

> SigMa là hệ quản lý doanh số/vận hành cho mô hình bán **mã kích hoạt máy POS (TID)** cho đại lý: tính phí,
> nhận tiền QR, đối soát bill bằng OCR, chống gian lận, báo cáo nhà đầu tư. Gồm app quản lý (desktop Electron),
> các API thuần-server, và phần chat nội bộ. **Đây là bản trắng data để chạy thử/giao ra ngoài** — không chứa
> dữ liệu khách/tiền thật. Mọi bí mật trong repo đều là placeholder `<DIEN_VAO>`.

## 5 luật cốt lõi — ÁP MỖI PHIÊN
1. **CẤM báo cáo láo** — "xong/PASS" phải có bằng chứng chạy thật (exit-code / số đếm / ảnh), không claim từ lời.
2. **CẤM suy luận** value/spec — không chắc thì dừng lại, hỏi, đánh dấu TENTATIVE.
3. **Rebuild TRƯỚC selftest**; đổi hạ tầng/DB → chạy lại FULL suite sạch; KHÔNG test trên DB production.
4. **Bug mới = lỗi quy trình test** → thêm regression + ghi `BUGS_FIXED.md` + đề xuất đổi quy trình.
5. **Engineering PASS ≠ Production PASS** — chưa cài thật + người nghiệm thu thì chưa "done"; đổi UI phải chụp ảnh verify.

Chi tiết các luật: `docs/LUAT-LAM-VIEC.md` (L1–L15 + R196/R198/R200/R201/R202). Điểm vào cho AI: `docs/AI-ONBOARD.md`.

## Kiến trúc (monorepo npm workspaces)

```
renderer (desktop/web)  →  httpCall('/v1/...')  →  API server  →  service core  →  Prisma  →  Postgres
```

Lớp **LIVE** là API server (`apps/quanly-api`, cổng 8790) + service trong `packages/services`. App desktop gọi
API qua HTTP; **không** sửa nghiệp vụ ở lớp `apps/desktop/src/main` rồi tưởng đã tới app (xem R201).

### apps/
- `desktop` — Electron + React + TypeScript + Tailwind v4 + Prisma. App quản lý chính. Dev: `electron-vite dev`.
- `quanly-api` — REST thuần-server (Express), cổng **8790**, bind 127.0.0.1. Lớp nghiệp vụ LIVE cho desktop.
- `bot-api` — Express + Prisma. Chat nội bộ + ingest bill OCR + đăng ký/OTP + push. Cổng mặc định 8788.
- `web-demo` — Vite + React (giao diện chat/mobile-web) + dự án Capacitor Android (`android/`).
- `mobile` — React Native (vỏ app di động).
- `sigma-pc` — vỏ Electron bọc web chat cho Windows.
- `landing` — trang tải/giới thiệu.
- `mb-feed`, `ocr-service`, `zalo-watcher` — dịch vụ phụ (feed sao kê, OCR, theo dõi tin nhắn ingest bill).

### packages/
- `shared` — hằng số dùng chung: `PERMISSIONS`, `ROLES`, `DEFAULT_ROLE_PERMISSIONS`. Phân quyền theo **permission**, không theo tên role.
- `business-rules` — luật nghiệp vụ: băm mật khẩu (bcrypt), luật chống gian lận (`sigma-fraud-rules.ts`), tính Lô/TID.
- `database` — Prisma schema + migrations + seed (`prisma/seed.ts`). Postgres.
- `services` — lõi nghiệp vụ dày (service), API chỉ là lớp mỏng gọi vào đây.

## Lệnh thường dùng
```bash
npm install                       # cài workspaces
cp apps/bot-api/.env.example apps/bot-api/.env   # rồi điền <DIEN_VAO>
npm run db:setup                  # generate + migrate deploy + seed (bản trắng + admin demo)
npm run dev                       # chạy desktop (electron-vite)
npm test                          # vitest toàn repo
node scripts/gate-test.mjs        # cổng gate trước ship (gọi các kiem-luat-*)
node scripts/kiem-scrub.mjs       # cổng kiểm scrub white-label (bí mật/PII)
```
Đăng nhập demo sau seed: **admin / admin123** (đổi ngay ở production).

## Quy ước
- Phân quyền bằng **permission**, không bằng tên role. Soft-delete. Không xóa/khóa Admin cuối cùng. Không tự nâng quyền mình.
- Verdict = exit-code / bằng chứng chạy thật, không phải lời văn.
- Tiền lưu dạng **Int** (phần trăm × 1000; số tiền nguyên đồng) — không dùng float. Chú ý BigInt khi gom tổng.
- Mốc thời gian: cẩn thận lệch múi giờ ±7h khi đọc/ghi `timestamptz` qua Prisma `$queryRaw` (xem AI-ONBOARD bẫy #1).
- Cổng tự kiểm: `scripts/kiem-*.mjs` + `scripts/gate-test.mjs` — giữ nguyên, chạy trước ship.

## Bí mật / cấu hình
- Tất cả secret nằm ngoài git. Copy `.env.example` → `.env` và điền `<DIEN_VAO>`. KHÔNG commit `.env` thật.
- Người dùng tự dựng hạ tầng feed cập nhật / tunnel / tên miền của mình (repo không chứa cấu hình thật).
