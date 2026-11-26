# Mở BẢN WEB SigMa ra ngoài — hồ sơ chuẩn bị (13/11/2026)

> Admin Demo: *"chuẩn bị đi"*. **CHƯA BẬT GÌ CẢ.** Hồ sơ này là bản vẽ + công cụ; bật hay không là quyết định của Admin Demo.

## 1. Hiện trạng đo thật

| Thứ | Hiện tại |
|---|---|
| Bản web SigMa | `http://127.0.0.1:57913` — **chỉ máy này** |
| Máy chủ tĩnh | `infra/web-static/serve-webapp-quanly.mjs`, `QLWEB_HOST=127.0.0.1` |
| **Cách đang chạy** | **tiến trình node chạy tay (PID rời), KHÔNG phải Scheduled Task** ⇒ **tắt máy là mất, không tự lên lại** |
| Tên miền công khai | **KHÔNG CÓ** (đường hầm chỉ có api/update/db/cqr…) |

Hai đường hầm trên máy:
- `ec9f3365` (task `SigMa_Tunnel`) — sigma-chat / sigma / sigma-api / alpha-update
- `f4575709` (service `Cloudflared`, `config.yml`) — vstk / skill / glb-update / glb-db / **alpha-db** / **alpha-quanly-api** / alpha-update / cqr

→ Web quản lý nên đi **cùng đường hầm với API** (`f4575709`), để web + api cùng một chỗ, dễ gác và dễ tắt.

*(Ghi nhận thêm: `alpha-update.example.com` đang khai Ở CẢ HAI config. Hiện vẫn chạy, nhưng là mập mờ — nên dọn về một chỗ khi rảnh.)*

## 2. Vì sao phải có Cloudflare Access, không chỉ mật khẩu app

Trang này bày **toàn bộ màn hình tiền**: doanh số, công nợ, lãi nhà đầu tư, hồ sơ HKD. Mở trần ra Internet thì:
- ai cũng chạm được **màn đăng nhập** ⇒ có chỗ để dò mật khẩu, dò lỗi;
- mọi lỗ hổng tương lai của app đều phơi thẳng ra ngoài.

Với Access: người lạ gõ đúng địa chỉ cũng **bị chặn ở cổng Cloudflare, chưa chạm tới máy mình**. Đăng nhập app trở thành **lớp thứ hai**, không phải lớp duy nhất.

Thêm một điểm tốt: máy chủ tĩnh **vẫn chỉ nghe 127.0.0.1**. Chỉ `cloudflared` (chạy trên chính máy này) vào được. **Không mở cổng tường lửa, không dùng LAN** — đúng ý "không dùng LAN nữa".

## 3. Việc của Admin Demo (tôi không làm thay được)

Trên Cloudflare Zero Trust:
1. **Access → Applications → Add → Self-hosted**
   - Application name: `SigMa Quản Lý (web)`
   - Session duration: **8 giờ** (hoặc ngắn hơn)
   - Public hostname: `alpha-quanly.example.com`
2. **Policy** — đặt tên `Chỉ người SigMa`, Action **Allow**, Include:
   - `Emails` → liệt kê đúng email của người được vào, **hoặc**
   - `Email domain` → `sigma.com.vn` (nếu muốn cả nhà)
   - Nên bật thêm **Require → Purpose justification** hoặc OTP qua email.
3. Thêm policy thứ hai: Action **Block**, Include `Everyone` — để mặc định là **chặn**, chỉ ai nằm trong policy Allow mới qua.

Xong 3 bước trên thì báo tôi.

## 4. Việc của tôi (đã viết sẵn, chạy khi Admin Demo gật)

```bat
:: 1) Tạo bản ghi DNS trỏ tên miền vào đường hầm (chạy 1 lần)
"C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel route dns f4575709-b0cf-41ff-b4f5-666181779a1e alpha-quanly.example.com

:: 2) Thêm ingress + khởi động lại cloudflared (có sao lưu, có kiểm cú pháp)
node "<REPO>\infra\sigma-tunnel\them-ingress-web-quanly.mjs" --da-tao-access

:: 3) Bài kiểm sau khi bật
node "<REPO>\apps\desktop\scripts\kiem-web-cong-khai.mjs"
```

`them-ingress-web-quanly.mjs` **từ chối chạy nếu thiếu cờ `--da-tao-access`** — để không ai vô tình mở trần màn hình tiền ra Internet.

## 5. Nợ phải trả TRƯỚC khi mở ra ngoài

**Máy chủ web chưa phải dịch vụ.** Nó đang là tiến trình chạy tay. Mở ra Internet mà nó chết lúc 2h sáng thì không ai dựng lại. Phải đăng ký Scheduled Task như các dịch vụ khác (`SigMa_QuanlyApi`, `SigMa_Tunnel`…):

```bat
schtasks /Create /TN "SigMa_WebQuanly" /TR "cmd /c \"<REPO>\infra\web-static\run-webapp-quanly.cmd\"" /SC ONSTART /RU SYSTEM /RL HIGHEST /F
```

`run-webapp-quanly.cmd` đã có sẵn vòng lặp tự dựng lại sau 5 giây và **đã đúng kiểu xuống dòng CRLF** (đã kiểm — sai chỗ này từng làm watcher Zalo chết câm).

## 6. Bài kiểm sau khi bật (gate `kiem-web-cong-khai.mjs`)

1. Khách lạ (không đăng nhập Access) **phải bị chặn** — nhận trang đăng nhập Access hoặc 403, **không** được thấy giao diện SigMa.
2. Tên miền phải **phân giải và đường hầm phải sống** (không 1033/530).
3. Máy chủ tĩnh **vẫn chỉ nghe 127.0.0.1** — kiểm bằng `Get-NetTCPConnection`, thấy `0.0.0.0` là ĐỎ.
4. Cookie phiên qua HTTPS phải **giữ cờ `Secure`** (`QLWEB_COOKIE_HTTP` KHÔNG được bật cho bản công khai).
5. Tiêu đề an ninh đủ: CSP, `X-Frame-Options`, `nosniff`, HSTS (chỉ khi HTTPS).

**Chưa chạy được bài kiểm này thì chưa coi là xong.**
