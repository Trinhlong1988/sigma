// CỔNG CHỐNG "CSS RỤNG ÂM THẦM" (bài học 6/11).
// Đổi `root` của Vite làm Tailwind v4 mất nguồn quét class ⇒ CSS sinh ra rụng 80% mà `tsc` và
// `vite build` đều EXIT 0, KHÔNG một cảnh báo. Giao diện vỡ hoàn toàn nhưng mọi exit code đều xanh —
// đúng loại lỗi chỉ MẮT mới thấy (R200). Cổng này biến nó thành bài kiểm ĐỎ.
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const THU_MUC = 'dist-web/assets';
const NGUONG_TOI_THIEU = 55_000; // bản đo thật 6/11: 70.658 B. Rụng xuống dưới mốc này là mất nguồn quét.

let css = [];
try {
  css = readdirSync(THU_MUC)
    .filter((f) => f.endsWith('.css'))
    .map((f) => ({ ten: f, byte: statSync(join(THU_MUC, f)).size }));
} catch (e) {
  console.error('[kiem-css-web] KHÔNG ĐỌC ĐƯỢC', THU_MUC, '→', e.message);
  process.exit(1); // không đọc được = ĐỎ, cấm nuốt (R198)
}

if (css.length === 0) {
  console.error('[kiem-css-web] *** KHÔNG CÓ FILE .css NÀO trong', THU_MUC, '→ Tailwind không sinh ra gì ***');
  process.exit(1);
}

const tong = css.reduce((t, c) => t + c.byte, 0);
console.log('[kiem-css-web] CSS:', JSON.stringify(css), '· tổng', tong, 'B · ngưỡng', NGUONG_TOI_THIEU, 'B');
if (tong < NGUONG_TOI_THIEU) {
  console.error('[kiem-css-web] *** CSS QUÁ NHỎ — gần như chắc chắn Tailwind mất nguồn quét class.');
  console.error('    Kiểm lại khai `@source` trong src/web-shim/styles-web.css so với `root` của vite.config.web.ts. ***');
  process.exit(1);
}
// ── CỔNG 2: ĐỊA CHỈ API ĐÓNG TRONG BẢN BUILD (bài học 12/11) ────────────────────────────────────────
// Build mà quên `VITE_SIGMA_API_BASE` thì bản web gọi thẳng `<host>:8790` = SỔ THẬT, kể cả khi đang mở ở
// cổng dành cho BẢN SAO (57914). Tự tay dính 12/11. Nay mặc định là `same-origin`; cổng này canh để nếu
// ai đó đổi mặc định về rỗng thì bài kiểm ĐỎ chứ không lặng lẽ trỏ nhầm sổ.
// Đọc DẤU do chính lúc build ghi ra (dist-web/_api-base.txt) — KHÔNG dò chuỗi trong bundle: chuỗi
// 'same-origin' nằm sẵn trong câu so sánh của web-shim nên bản build SAI vẫn "có" chuỗi đó.
let baseDaBuild = null;
try {
  baseDaBuild = readFileSync('dist-web/_api-base.txt', 'utf8').trim();
} catch {
  baseDaBuild = null;
}
const CHO_PHEP_8790 = process.env.QLWEB_CHO_PHEP_8790 === '1';
if (baseDaBuild === null) {
  console.error('[kiem-css-web] *** KHÔNG CÓ dist-web/_api-base.txt — không biết bản build trỏ đi đâu ***');
  console.error('    Bản build cũ hoặc plugin ghi dấu đã bị gỡ. Build lại bằng npm run build:web.');
  process.exit(1); // không đo được = ĐỎ, cấm nuốt (R198)
}
if (baseDaBuild !== 'same-origin' && !CHO_PHEP_8790) {
  console.error('[kiem-css-web] *** API base của bản build = "' + baseDaBuild + '" (không phải same-origin) ***');
  console.error('    ⇒ trang sẽ gọi thẳng địa chỉ đó, kể cả khi mở ở cổng dành cho BẢN SAO.');
  console.error('    Cố ý thì đặt QLWEB_CHO_PHEP_8790=1 và nêu lý do khi báo cáo.');
  process.exit(1);
}
console.log('[kiem-css-web] API base của bản build = ' + baseDaBuild + (baseDaBuild === 'same-origin' ? ' (ĐẠT)' : ' (được cho phép tường minh)'));

console.log('[kiem-css-web] ĐẠT');
