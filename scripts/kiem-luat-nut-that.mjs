// [B181 19/11] CỔNG CHẶN "NÚT GIẢ" — nút có mách nước hứa hẹn nhưng bấm xong KHÔNG làm gì.
//
// Ca thật: nút "Làm mới" của màn Doanh Số là `onClick={() => undefined}` với mách nước "Tải lại dữ liệu mới
// nhất". Người dùng bấm, tin là đã tải mới, thực tế màn giữ nguyên dữ liệu từ lúc mở app. Cộng với việc danh
// sách TID chỉ nạp 1 lần lúc dựng trang ⇒ app mở từ 16/11 vẫn hiện "CHƯA giao đại lý" cho máy đã giao 17/11.
//
// Cổng khẳng định: KHÔNG tệp giao diện nào còn trình xử lý rỗng (`() => undefined`, `() => {}`) gắn vào
// onClick/onSubmit/onChange. Muốn cố ý để trống thì phải nói rõ lý do bằng chú thích `// nut-khong-lam-gi:`
// ngay dòng trên — buộc người viết nêu lý do, thay vì để im.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THU_MUC = ['apps/desktop/src/renderer/src', 'apps/web-demo/src'];
// [B202 19/11] THÊM `onApply` — nút "Lọc" của thanh lọc nhận trình xử lý qua PROP này, nên mẫu cũ
// (chỉ soi onClick/onSubmit/onChange/onBlur) KHÔNG thấy: màn Doanh Số để onApply rỗng suốt, nút "Lọc"
// bấm không làm gì mà cổng vẫn báo "không có nút giả". Nút giả gắn qua PROP cũng là nút giả.
const MAU = /\b(onClick|onSubmit|onChange|onBlur|onApply)=\{\(\)\s*=>\s*(undefined|\{\s*\})\}/;
// Nhận cả chú thích JS (`// nut-khong-lam-gi:`) lẫn chú thích JSX (`{/* nut-khong-lam-gi: … */}`).
const MIEN = /nut-khong-lam-gi:/;

function quet(thu, ra) {
  let d;
  try { d = readdirSync(thu); } catch { return ra; }
  for (const x of d) {
    const p = resolve(thu, x);
    if (statSync(p).isDirectory()) quet(p, ra);
    else if (/\.(tsx|jsx)$/.test(x)) ra.push(p);
  }
  return ra;
}

let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; if (!ok) loi.push(ten); console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); };

const tep = THU_MUC.flatMap((t) => quet(resolve(GOC, t), []));
console.log('      quét', tep.length, 'tệp giao diện');
chot(tep.length > 0, 'tìm thấy tệp giao diện để quét (0 tệp thì cổng này vô nghĩa)');

const dinh = [];
for (const f of tep) {
  const dong = readFileSync(f, 'utf8').split('\n');
  for (let i = 0; i < dong.length; i++) {
    if (!MAU.test(dong[i])) continue;
    const truoc = (dong[i - 1] ?? '') + (dong[i - 2] ?? '');
    if (MIEN.test(truoc) || MIEN.test(dong[i])) continue; // đã nêu lý do tường minh
    dinh.push(`${relative(GOC, f)}:${i + 1}`);
  }
}
if (dinh.length) console.log('      nút giả tìm thấy:', dinh.join(' · '));
chot(dinh.length === 0, 'KHÔNG còn nút/ô nào gắn trình xử lý rỗng (' + dinh.length + ')');

// [B202 19/11] LUẬT RIÊNG CHO THANH LỌC: nút "Lọc" nhận trình xử lý qua PROP `onApply`, mẫu trên không
// thấy nếu có chú thích chen giữa. Ca thật: màn Doanh Số để `onApply={() => undefined /* ... */}` suốt nhiều
// tháng ⇒ nút "Lọc" bấm KHÔNG LÀM GÌ mà cổng vẫn xanh. Luật: màn nào truyền onApply RỖNG thì BẮT BUỘC phải
// truyền kèm `hideApply` (ẩn hẳn nút) — có nút mà không làm gì là lừa người dùng.
const RONG = /onApply=\{\(\)\s*=>\s*(undefined|\{\s*\})/;
const thieuAn = [];
for (const f of tep) {
  const noi = readFileSync(f, 'utf8');
  if (!RONG.test(noi)) continue;
  // Soi trong phạm vi 1200 ký tự quanh chỗ khai báo — đủ bao trọn một thẻ FilterBar.
  const i = noi.search(RONG);
  const quanh = noi.slice(Math.max(0, i - 1200), i + 1200);
  if (!/hideApply/.test(quanh)) thieuAn.push(relative(GOC, f));
}
if (thieuAn.length) console.log('      onApply rỗng mà KHÔNG ẩn nút Lọc:', thieuAn.join(' · '));
chot(thieuAn.length === 0, 'màn nào để onApply RỖNG đều đã ẩn nút "Lọc" (' + thieuAn.length + ' chỗ còn nút giả)');

console.log('[nut-that] SO PHEP KIEM (dem dong) = ' + so);
if (so !== 3) { loi.push('THIEU PHEP KIEM: ' + so + '/3'); console.log('  ĐỎ  phải chạy đủ 3 phép kiểm'); }
if (loi.length) {
  console.log('[nut-that] ' + loi.length + ' ĐỎ: ' + loi.join(' | '));
  console.log('[nut-that] Sửa: cho nút làm đúng việc nó hứa, HOẶC ghi chú `// nut-khong-lam-gi: <lý do>` ngay trên.');
  process.exit(1);
}
console.log('[nut-that] ✓ không có nút giả');
