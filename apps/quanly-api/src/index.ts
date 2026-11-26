// SigMa — REST API bootstrap. App desktop (máy TRONG + NGOÀI như nhau) gọi HTTPS thay vì nối Postgres
// trực tiếp. Deploy qua Cloudflare: alpha-quanly-api.example.com → localhost:PORT. App factory ở app.ts.
import 'dotenv/config';
import { ensureAlphaExtraSchema } from '@sigma/services';
import { createApp } from './app.js';
import { getDb } from './db.js';

// [B325/F3-1 24/11 — agent soát] GHIM + ASSERT múi giờ (khuôn bot-api từ 30/8). quanly-api là lớp LIVE
// phục vụ MỌI báo cáo (dashboard, xếp hạng TID, cashflow, tất toán NĐT) — nhiều chỗ dựng biên kỳ bằng
// new Date(y,m,d) = giờ PROCESS. Host không phải ICT (VM/Docker/cloud UTC) ⇒ cửa sổ ngày trượt 7h →
// MẤT bill (đỏ THẬT số 1 trong LUAT-VIET-CONG §1). Trước đây quanly-api KHÔNG có assert này.
{
  const offsetMin = -new Date().getTimezoneOffset();
  const tzName = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (offsetMin !== 420) {
    // eslint-disable-next-line no-console
    console.error(`[TZ] ⛔ CẢNH BÁO NGHIÊM TRỌNG: offset múi giờ process = UTC+${offsetMin / 60}h (tz="${tzName}") KHÁC VN (UTC+7). Biên ngày BÁO CÁO sẽ LỆCH → đếm thiếu/nhầm. PHẢI đặt TZ=Asia/Ho_Chi_Minh cho tiến trình (run-quanly-api.cmd).`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[TZ] OK — múi giờ process = UTC+7 (${tzName}). Biên ngày báo cáo chuẩn VN.`);
  }
}

const app = createApp();

const PORT = Number(process.env['PORT'] ?? 8790);
// AUDIT-VÁ #2b (MED bind, B132) — mặc định bind 127.0.0.1 (loopback), KHÔNG 0.0.0.0. cloudflared chạy CÙNG host
// và nối tới localhost:PORT nên không cần lộ cổng ra LAN. Bind 0.0.0.0 khiến bất kỳ máy nào trong LAN gọi thẳng
// API, BỎ QUA Cloudflare — mà trust proxy=1 chỉ AN TOÀN khi traffic CHỈ đến qua tunnel local (nếu client LAN tự
// đặt X-Forwarded-For, req.ip bị giả mạo, rate-limit theo IP vô hiệu). Cho override qua SIGMA_BIND khi cần.
// [Admin Demo 4/9] Lược đồ phụ QR/giá-cuối-tuần — AWAIT TRƯỚC listen: resolveFeeForTxn (đường ghi GD) tra bảng
// weekend_sell_adjust trong transaction; bảng chưa có lúc request đầu → 42P01 POISON tx. Bảo đảm có trước khi phục vụ.
await ensureAlphaExtraSchema(getDb())
  // eslint-disable-next-line no-console
  .then(() => console.log('[quanly-api] ✓ schema phụ QR/giá-cuối-tuần sẵn sàng (trước listen).'))
  // eslint-disable-next-line no-console
  .catch((e: unknown) => console.error('[quanly-api] ⚠ không tạo được schema phụ QR/giá-cuối-tuần:', (e as Error)?.message));
app.listen(PORT, process.env['SIGMA_BIND'] ?? '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[quanly-api] listening on :${PORT}`);
});
