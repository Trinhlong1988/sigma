// LUẬT CHẠY ĐƯỢC — chặn lỗi BIÊN KỲ: đổi mốc `to` của khoảng NỬA MỞ thành CHUỖI NGÀY mà quên lùi 1ms.
//
// VÌ SAO (Admin Demo 27/9 "chọn ngày hôm qua ra vẫn sai", "sao cứ bị từ hôm qua thế?", "fix triệt để cấm tái diễn"):
// Client gửi khoảng NỬA MỞ [from, to) — "Hôm qua" = [00:00 ngày 26, 00:00 ngày 27). Backend đổi sang chuỗi ngày
// rồi gọi hàm nhận kỳ BAO GỒM CẢ HAI ĐẦU. Lấy thẳng `localDateStr(to)` ⇒ toDay = "2026-09-27" ⇒ bảng "hôm qua"
// GỘP LUÔN hôm nay. Đo thật phòng NĐT NĐT 1: 11 bill (26+27) thay vì 8 bill của riêng ngày 26 — và người dùng
// thấy "lô ngày 27 nhảy vào bảng ngày 26".
// Đây là LỚP lỗi đã tái diễn nhiều lần (xem memory feedback_period_bound_timezone_consistency_11_7).
//
// LUẬT: khi đổi mốc CUỐI của khoảng nửa mở sang chuỗi ngày, PHẢI lùi 1ms:
//     localDateStr(new Date(to.getTime() - 1))      // ✓
//     localDateStr(to)                              // ✗ gộp thừa 1 ngày
// Nếu hàm đích nhận kỳ NỬA MỞ (so sánh `< toDay`) thì không sao — khai
//     // BIEN-KY-BO-QUA: <lý do>
// ở dòng ngay trên.
//
// Chạy: node scripts/kiem-luat-bien-ky.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** [Admin Demo 29/9 "TẠI SAO CỨ ĐỂ LỖI LỌT?"] TỰ QUÉT tên hàm đổi Date → chuỗi ngày, KHÔNG liệt kê tay.
 *  VÌ SAO: bản đầu (27/9) hard-code danh sách theo trí nhớ và BỎ SÓT `fmtDayHcm` ⇒ đúng 2 ngày sau lọt tiếp
 *  một ca cùng lớp (đối soát hoàn đại lý mất sạch bill hôm nay). Cổng dựng bằng danh sách thủ công chỉ bắt
 *  được thứ người viết đã nghĩ ra — nên danh sách phải SINH TỪ MÃ NGUỒN. */
function quetHamNgay(files) {
  const ten = new Set(['localToday']);   // hàm không nhận tham số nhưng cùng họ, giữ để không hụt
  // Dấu hiệu "hàm trả chuỗi ngày": thân có to_char/'YYYY-MM-DD', hoặc getUTCFullYear/getFullYear + padStart,
  // hoặc toISOString().slice(0,10) — quét trong 12 dòng kể từ chỗ khai báo hàm.
  const dauHieu = /YYYY-MM-DD|toISOString\(\)\.slice\(\s*0\s*,\s*10\s*\)|get(UTC)?FullYear\(\)[\s\S]{0,160}padStart/;
  for (const f of files) {
    let src;
    try { src = readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    const dong = src.split('\n');
    for (let i = 0; i < dong.length; i++) {
      const m = /(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(|const\s+(\w+)\s*(?::[^=]+)?=\s*(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/.exec(dong[i]);
      const nhan = m ? (m[1] || m[2]) : null;
      if (!nhan) continue;
      // LOẠI hàm trả về Date/mốc chứ không phải CHUỖI NGÀY: parse*(…) dựng Date từ chuỗi, next*(…) trả mốc
      // ngày kế tiếp (chính là cách ĐÚNG để lấy biên loại-trừ). Đưa vào sẽ báo oan hàng loạt.
      if (/^(parse|next|start|end|hcmMidnight)/i.test(nhan)) continue;
      if (dauHieu.test(dong.slice(i, i + 12).join('\n'))) ten.add(nhan);
    }
  }
  return [...ten];
}
/** Tên biến thường là MỐC CUỐI của khoảng nửa mở. */
const BIEN_CUOI = ['to', 'den', 'end', 'cuoiKy', 'toDate', 'dauHomNay'];

function dsFile() {
  const out = execFileSync('git', ['ls-files', '*.ts'], { cwd: ROOT, encoding: 'utf8' });
  return out.split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((f) => !/(^|\/)(test|tests)\//.test(f) && !/\.test\.ts$/.test(f) && !/\/dist\//.test(f));
}

export function kiemLuatBienKy() {
  const viPham = [];
  const files = dsFile();
  const HAM_NGAY = quetHamNgay(files);
  for (const f of files) {
    let src;
    try { src = readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    const dong = src.split('\n');
    for (let i = 0; i < dong.length; i++) {
      const d = dong[i];
      // Khai báo bỏ qua có thể nằm trong khối chú thích vài dòng ngay trên → xét 3 dòng.
      if ([1, 2, 3].some((k) => /BIEN-KY-BO-QUA/.test(dong[i - k] ?? ''))) continue;
      // Bỏ qua DÒNG CHÚ THÍCH — chính chú thích giải thích lỗi cũng chứa "localDateStr(to)" và sẽ
      // làm luật đỏ oan (đã xảy ra ngay lần chạy đầu).
      if (/^\s*(\/\/|\*|\/\*)/.test(d)) continue;
      for (const h of HAM_NGAY) {
        for (const b of BIEN_CUOI) {
          // localDateStr(to) / ngayHcm(to) — mốc cuối đưa thẳng vào hàm ngày, KHÔNG lùi 1ms
          const re = new RegExp(`\\b${h}\\s*\\(\\s*${b}\\s*\\)`);
          if (!re.test(d)) continue;
          viPham.push({ f, dong: i + 1, ma: d.trim().slice(0, 110), goi: `${h}(${b})` });
        }
      }
      // toISOString().slice(0,10) áp thẳng lên mốc cuối
      for (const b of BIEN_CUOI) {
        const re = new RegExp(`\\b${b}\\.toISOString\\(\\)\\.slice\\(\\s*0\\s*,\\s*10\\s*\\)`);
        if (re.test(d)) viPham.push({ f, dong: i + 1, ma: d.trim().slice(0, 110), goi: `${b}.toISOString().slice(0,10)` });
      }
    }
  }
  if (viPham.length === 0) { console.log(`[bien-ky] ✓ không chỗ nào đổi mốc CUỐI nửa-mở thành chuỗi ngày mà quên lùi 1ms (đã soi ${HAM_NGAY.length} hàm ngày TỰ QUÉT: ${HAM_NGAY.join(', ')})`); return true; }
  console.error(`\n[bien-ky] ✗ ${viPham.length} chỗ nghi GỘP THỪA 1 NGÀY:`);
  for (const v of viPham) console.error(`  ${v.f}:${v.dong}  ${v.goi}  →  ${v.ma}`);
  console.error(`\n  Sửa: dùng mốc ngay TRƯỚC \`to\`, ví dụ localDateStr(new Date(to.getTime() - 1))`);
  console.error(`  Hoặc khai lý do: // BIEN-KY-BO-QUA: hàm đích nhận kỳ nửa mở (so sánh < toDay)`);
  return false;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(kiemLuatBienKy() ? 0 : 1);
}
