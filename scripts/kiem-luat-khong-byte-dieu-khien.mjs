// [B199/B201 19/11] LUẬT: MÃ NGUỒN + SỔ TAY KHÔNG ĐƯỢC CHỨA BYTE ĐIỀU KHIỂN (NUL, …).
//
// Ca thật: bản vá B193 viết KÝ TỰ NUL THẬT vào biểu thức chính quy `/<NUL>/g` thay vì ký tự thoát `/\0/g`.
// Chạy vẫn đúng nên mọi bài kiểm đều xanh — nhưng `grep`/`ripgrep` coi file chứa NUL là **NHỊ PHÂN**, nên
// mọi lần tìm kiếm trong file đó về sau **TRƯỢT IM**. Một file 611 dòng ở lớp ghi tiền trở nên vô hình với
// mọi lần dò. Quét cả kho 19/11 còn thấy 2 chỗ nữa (một sentinel cũ trong web-demo, một dòng trong VERSION.md).
//
// Cổng này rẻ (quét byte), chạy mỗi lần ship. Dùng KÝ TỰ THOÁT (`\0`) thay vì byte thật — giá trị lúc chạy y hệt.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DUOI = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.md', '.json', '.css', '.html', '.yml', '.yaml']);
// Thư mục KẾT QUẢ DỰNG (không phải mã ta viết) — LICENSES.chromium.html của Electron vốn có byte điều khiển.
const BO_QUA = new Set(['node_modules', 'dist', 'dist-web', 'dist-web-thu', 'dist-tn', 'win-unpacked', 'build', '.git', 'screenshots', 'out', 'android', 'coverage', '_backup-thao-tac', '_anh-kiem', 'docs-de-xuat']);
// [B308] bỏ qua MỌI thư mục bắt đầu bằng dist (dist-web-a4… do agent build tạm) — JS rút gọn có byte điều khiển HỢP LỆ, quét vào là đỏ oan có hệ thống.
const BO_QUA_TIEN_TO = ['dist'];
// Byte điều khiển cấm: NUL + các mã điều khiển C0 khác (trừ tab 09, xuống dòng 0A, về đầu dòng 0D).
const CAM = (b) => b === 0 || (b < 32 && b !== 9 && b !== 10 && b !== 13) || b === 127;

let soFile = 0;
const xau = [];
function quet(thuMuc) {
  for (const ten of readdirSync(thuMuc)) {
    if (BO_QUA.has(ten)) continue;
    if (BO_QUA_TIEN_TO.some((t) => ten.startsWith(t))) continue; // [B308]
    const p = join(thuMuc, ten);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) { quet(p); continue; }
    if (!DUOI.has(extname(ten))) continue;
    soFile++;
    let d;
    try { d = readFileSync(p); } catch (e) {
      // R198 — đọc không được = KHÔNG kiểm được, phải lộ ra chứ không coi như sạch.
      xau.push({ p, n: -1, ghi: 'KHÔNG ĐỌC ĐƯỢC: ' + e.message });
      continue;
    }
    let n = 0;
    const dong = new Set();
    let sodong = 1;
    for (const b of d) {
      if (b === 10) sodong++;
      else if (CAM(b)) { n++; dong.add(sodong); }
    }
    if (n) xau.push({ p: p.slice(ROOT.length + 1), n, ghi: 'dòng ' + [...dong].slice(0, 5).join(', ') });
  }
}
quet(ROOT);

console.log('[byte-dieu-khien] đã quét ' + soFile + ' file văn bản');
if (soFile < 500) {
  // Quét được quá ít = chắc chắn đường dẫn/bộ lọc hỏng ⇒ đỏ, không được báo "sạch" hời hợt.
  console.error('[byte-dieu-khien] ✗ CHỈ quét được ' + soFile + ' file — bộ quét hỏng, KHÔNG kết luận sạch.');
  process.exit(3);
}
if (xau.length) {
  console.error('[byte-dieu-khien] ✗ ' + xau.length + ' file chứa BYTE ĐIỀU KHIỂN (grep sẽ coi là nhị phân → tìm kiếm trượt im):');
  for (const x of xau) console.error('   · ' + x.p + ' — ' + x.n + ' byte (' + x.ghi + ')');
  console.error('[byte-dieu-khien]   Sửa: dùng KÝ TỰ THOÁT (ví dụ \\0) thay cho byte thật — chạy y hệt.');
  process.exit(1);
}
console.log('[byte-dieu-khien] ✓ không file nào chứa byte điều khiển');
