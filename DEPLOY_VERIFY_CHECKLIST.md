# DEPLOY & VERIFY CHECKLIST — SigMa / SigMa

> Sinh ra sau phiên 5/8 (chuỗi lỗi "hết bước này sang bước khác"). **GATE CỨNG** — CẤM báo "xong/fixed"
> nếu chưa qua đủ. Gốc mọi lỗi phiên đó: **verify từ vantage MÁY CHỦ, không phải vantage NGƯỜI DÙNG.**

## 0. Nguyên tắc tối thượng
- **"Xong" = NGƯỜI DÙNG (hoặc harness tái hiện đúng đường người dùng) xác nhận** — KHÔNG phải curl máy chủ.
- Mỗi lỗi tìm ra trong lúc fix = **thất bại quy trình** → phải bổ sung gate, không chỉ vá.
- **CẤM** dùng làm bằng chứng cho người dùng: `curl localhost`, `curl` public TỪ MÁY CHỦ (đi tunnel/đường khác),
  `WebFetch` (bị Cloudflare chặn bot → 403 giả), Chromium trần (thiếu CSP của app thật).

## 1. Trước khi build
- [ ] Liệt kê ĐỦ mọi mặt user-facing bị ảnh hưởng (xem §4). Fix 1 mặt ≠ xong cả cụm.
- [ ] Đọc lại spec/plan doc nếu phiên dài (chống lệch hướng).

## 2. Engineering gate (máy chủ — điều kiện CẦN, chưa ĐỦ)
- [ ] `tsc --noEmit` = 0 mọi gói đụng tới.
- [ ] `vitest run` xanh — rerun SẠCH từ HEAD (rebuild trước, không tin build cũ).
- [ ] Regression test cho ĐÚNG bug vừa fix (đỏ→xanh).

## 3. Test TOOL/SCRIPT trước khi deploy nó
- [ ] Mọi script/watchdog/launcher: chạy thử ÍT NHẤT 1 lần ở cả nhánh OK lẫn nhánh lỗi TRƯỚC khi đăng ký task.
  (Bài học: watchdog regex `\bhkg` sai → restart oan cả 2 tunnel; .cmd em-dash/LF/paren → "'M' not recognized".)
- [ ] Launcher .cmd: **CRLF + thuần ASCII** (không em-dash/–), no ngoặc tròn trong khối `if()`. .ps1 có BOM UTF-8.

## 4. USER-FACING SURFACES — verify TỪNG cái từ vantage NGƯỜI DÙNG (harness/ảnh)
Mỗi lần release app desktop, kiểm ĐỦ 4 mặt cho CẢ SigMa LẪN SigMa (quy định Admin Demo 5/8):
- [ ] **(a) Feed auto-update**: `https://alpha-update.example.com/updates/latest.yml` đúng version + `setup.exe`
      range-req 206 — kiểm từ mạng ngoài / hoặc xác nhận DNS→tunnel SỐNG (connections>0).
- [ ] **(b) Trang tải-về**: `sigma.example.com/#tai-ve` hiện đúng version (bundle JS) + file `/downloads/<exe>` tải
      được 200/206. HTML phải `no-cache` (không kẹt bản cũ 300s).
- [ ] **(c) App KẾT NỐI**: mở **app ĐÓNG GÓI thật** (dist/win-unpacked HOẶC bản cài) + Playwright `connectOverCDP`
      (`--remote-debugging-port`), eval trong renderer `file://`:
      `fetch(apiBase+'/v1/health',{credentials:'include'})` → PHẢI `OK 200` (không "Failed to fetch").
      **CHỖ NÀY curl máy chủ + Chromium trần ĐỀU KHÔNG bắt được** (thiếu CSP/CORS layer của Electron thật).
- [ ] **(d) Đăng nhập thật**: một tài khoản thật đăng nhập được qua app (hoặc Admin Demo xác nhận + ảnh).

## 5. Hạ tầng public (Cloudflare Tunnel)
- [ ] Hostname mới: có ingress trong config.yml ĐÚNG (service uses `--config <REPO>\.cloudflared\config.yml`)
      + DNS `route dns --overwrite-dns <tunnel-SỐNG> <host>` (record cũ có thể trỏ tunnel CHẾT → 1033).
- [ ] Tunnel phục vụ host = tunnel có **connections>0** (`cloudflared tunnel info --output json` → `conns`).
      Tunnel "Running task" ≠ tunnel sống — canh bằng CONNECTION COUNT, không phải HTTP-từ-server (200 giả).
- [ ] Có task bền (boot + self-relaunch loop) cho MỌI process 24/24, không chạy lỏng từ session.

## 6. Sau deploy
- [ ] Cập nhật `VERSION.md` + `BUGS_FIXED.md` + memory project (R199: ngay sau mỗi bước verify thật).
- [ ] Commit + push. CHỈ báo Admin Demo "xong" sau khi §4 (c)+(d) PASS hoặc Admin Demo xác nhận máy ngoài.

## Phản biện (red-team chính checklist này)
- "Không với tới máy người dùng" → §4(c) harness CDP vào app đóng gói TÁI HIỆN đúng đường người dùng, chạy được
  ở máy dev (đã bắt đúng bug CSP mà curl/Chromium bỏ sót). Không phụ thuộc máy Admin Demo.
- "Có thể sót surface mới" → §4 là danh sách CỐ ĐỊNH; thêm surface mới phải thêm dòng vào đây (1 nguồn sự thật).
- "Harness nặng, tốn thời gian" → rẻ hơn NHIỀU so với ship hỏng cho 8 máy rồi Admin Demo báo lỗi từng vòng.
