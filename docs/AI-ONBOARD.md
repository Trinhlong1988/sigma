# AI-ONBOARD — điểm vào cho AI (và người mới) đọc hiểu SigMa NGAY

Mục tiêu: để một AI (Claude Code hoặc khác) hoặc người mới nắm được **ở đâu sửa gì**, **luồng dữ liệu**, và
**những cái bẫy đã biết** mà không phải dò cả repo.

## 1. Luồng dữ liệu (nhớ 1 câu)

```
Giao diện (Electron renderer / web)  →  httpCall('/v1/...')  →  API server  →  service core  →  Prisma  →  Postgres
```

- **Lớp LIVE** = `apps/quanly-api` (cổng 8790) + `packages/services`. Desktop gọi API qua HTTP.
- Ở app nhiều lớp có BẢN COPY service tại `apps/desktop/src/main/*-service.ts`. **Trước khi sửa nghiệp vụ,
  TRACE call-path thật từ UI** (preload gọi `httpCall('/v1/...')` → route ở `apps/quanly-api/src/routes/*`
  → service ở `packages/services/src/*`). CHỈ sửa lớp LIVE; sửa bản copy chết = typecheck xanh nhưng app không đổi (R201).

## 2. Các file điểm-vào quan trọng

| Chủ đề | File |
|---|---|
| Nhập bill thủ công (API) | `apps/quanly-api/src/routes/bill-manual.ts` |
| Giao dịch (route / service / luật) | `apps/quanly-api/src/routes/transaction.ts` · `packages/services/src/transaction.ts` · `packages/business-rules/src/transaction.rules.ts` |
| Biểu phí | `packages/services/src/fee-config.ts` · `apps/quanly-api/src/routes/fee-config.ts` |
| Lô / TID | `apps/bot-api/src/lo-service.ts` |
| Phân quyền (permission) | `packages/shared/src/permissions.ts` |
| Duyệt (approval) | `apps/desktop/src/main/approval-service.ts` |
| OCR bill | `apps/bot-api/src/ocr-bridge.ts` |
| Đối soát sao kê | `apps/bot-api/src/statement-recon.ts` |
| Luật chống gian lận | `packages/business-rules/src/sigma-fraud-rules.ts` |
| Seed DB (admin + danh mục mẫu) | `packages/database/prisma/seed.ts` |
| Prisma schema | `packages/database/prisma/schema.prisma` |

## 3. Chạy 1 vòng (smoke)

```bash
npm install
cp apps/bot-api/.env.example apps/bot-api/.env   # điền DATABASE_URL + <DIEN_VAO>
createdb sigma && npm run db:setup               # bản trắng + admin demo
npm test                                         # vitest
node scripts/gate-test.mjs                        # cổng gate (kiem-luat-* + suite)
```
Đăng nhập demo: `admin` / `admin123`.

## 4. DANH SÁCH BẪY ĐÃ BIẾT (đọc trước khi sửa code tiền/thời gian/DB)

1. **Múi giờ `timestamptz` ±7h.** Prisma `$queryRaw` ĐỌC cột `timestamptz` lệch **+7h**; GHI qua một số đường
   lệch **−7h**. Luôn bound theo múi giờ VN rõ ràng, test mốc 0h/giao ca. Đọc rồi-ghi-lại cùng cột mốc thời
   gian là bẫy cộng dồn +7h mỗi lần chạy.
2. **Tiền là Int + BigInt khi gom tổng.** Số tiền/`%×1000` lưu Int; tổng lớn có thể tràn 32-bit khi cộng ở SQL
   — cẩn thận shim BigInt trong mock test (mock phải đúng shape + đúng kiểu).
3. **Đổi RAW SQL / thêm method DB ⇒ cập nhật MOCK đúng shape CÙNG commit** (L15). Mock giả trả `[]` câm cho SQL
   thô làm hàng loạt bài kiểm "xanh rỗng" mà engine tiền vẫn có thể sai.
4. **Byte điều khiển / NUL trong file tiếng Việt** (L12): file chứa tiếng Việt/regex đặc biệt dễ dính byte NUL
   khi ghi bằng công cụ này rồi đọc bằng công cụ khác → vỡ câm. Ghi bằng công cụ A thì ĐỌC LẠI bằng công cụ B.
5. **`random()` trong LATERAL tính 1 lần** → mọi dòng ra giống nhau. Kiểm min/max/avg để phát hiện.
6. **Cổng bám CÁCH LÀM thay vì HÀNH VI** (L1): cổng phải khẳng định kết quả/hành vi quan sát được, không bám
   chuỗi hiển thị hay cấu trúc DOM — nếu không sẽ đỏ oan hoặc xanh rỗng.
7. **Clone/white-label phải TƯ DUY NGHIỆP VỤ**, không đổi tên máy móc: một token đổi ở 1 nơi phải sửa đủ các
   nơi ăn theo (L7) — tên biến, route, migration, test, cấu hình.
8. **`null ?? undefined` nuốt lệnh xóa-trống** và collation `C` làm `ILIKE`/`mode:insensitive` vô dụng — lỗi
   so chuỗi phải đo trên DB thật, typecheck xanh không chứng minh vá đúng.

## 5. Cổng tự kiểm (giữ nguyên, chạy trước ship)
- `scripts/gate-test.mjs` — gate tổng hợp (gọi `kiem-luat-manual-ops`, `kiem-luat-moc-thoi-gian-raw`, `kiem-luat-bien-ky`, rồi chạy các suite vitest).
- `scripts/kiem-*.mjs` — các cổng luật riêng (mốc thời gian raw, nút thắt, phân trang, byte điều khiển, biên kỳ...).
- `scripts/kiem-scrub.mjs` — cổng white-label: không còn bí mật/PII/dấu vết nội bộ.
