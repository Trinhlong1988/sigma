// [B197 19/11] LUẬT: Ô CHỌN KHÔNG ĐƯỢC ẨN IM BẢN GHI.
//
// Ca thật: Admin Demo khai báo TID mới ("KHACH HANG 58") rồi vào Thêm bill KHÔNG thấy nó đâu. Gốc: ô chọn TID lọc
// thẳng `status === 'ACTIVE'`; TID vừa khai báo đứng ở UNASSIGNED nên BỊ XOÁ KHỎI DANH SÁCH, không một lời.
// Luật nghiệp vụ (chưa giao khách thì chưa nhập bill được) là ĐÚNG — nhưng phải NÓI RA, không được ẩn.
// Ẩn im ở lớp giao diện cùng họ với nuốt lỗi ở lớp dữ liệu (R198): người dùng không biết mình thiếu bước nào.
//
// Cổng này CHẶN việc lọc cứng đó quay lại, và khẳng định cơ chế "nói ra" còn nguyên:
//   1. hai ô chọn (ngân hàng, TID) phải đi qua `tidHienDuoc`, KHÔNG được lọc `status === 'ACTIVE'`;
//   2. phải còn hàm nêu lý do `lyDoTidChuaDung` và lý do đó phải được HIỂN THỊ trong JSX;
//   3. phải còn chặn ghi (nút "Ghi nhận bill" mờ + chặn trong hàm ghi) — nói ra nhưng vẫn fail-closed.
// Đếm ĐỘNG số phép kiểm (R198) — thiếu phép kiểm nào là đỏ, không im lặng bỏ qua.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const F = 'apps/desktop/src/renderer/src/pages/BillManualEntryPage.tsx';
const CAN = 7;

let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };

let src;
try {
  src = readFileSync(resolve(ROOT, F), 'utf8');
} catch (e) {
  // R198 — không đọc được = KHÔNG CHẠY ĐƯỢC KIỂM TRA, phải đỏ chứ không "không thấy lỗi".
  console.error('[khong-an-im] ✗ KHÔNG đọc được ' + F + ' — ' + e.message);
  process.exit(3);
}

/** Cắt đoạn mã của một khối `const <ten> = ...` cho tới dòng trống kế tiếp ở cột 0 của khối. */
function khoi(ten) {
  const i = src.indexOf('const ' + ten + ' =');
  if (i < 0) return null;
  return src.slice(i, i + 900);
}

const kBank = khoi('bankOptions');
const kTid = khoi('tidOptions');
chot(!!kBank && !!kTid, 'tìm thấy cả hai ô chọn bankOptions/tidOptions trong màn Thêm bill');
chot(!!kBank && !/status === 'ACTIVE'/.test(kBank),
  'ô chọn NGÂN HÀNG không lọc cứng status===ACTIVE (lọc cứng = ngân hàng chỉ có TID mới sẽ biến mất)');
chot(!!kTid && !/status === 'ACTIVE'/.test(kTid),
  'ô chọn TID không lọc cứng status===ACTIVE (đúng lỗi Admin Demo gặp với TID Tiến Dũng)');
chot(!!kTid && /tidHienDuoc/.test(kTid) && !!kBank && /tidHienDuoc/.test(kBank),
  'cả hai ô đi qua tidHienDuoc — một chỗ duy nhất quyết định TID nào được hiện');
chot(/function lyDoTidChuaDung|const lyDoTidChuaDung/.test(src) && /CHƯA giao cho khách/.test(src),
  'còn hàm nêu LÝ DO TID chưa dùng được, nói rõ phải giao khách');
chot(/\{tidChuaDung && \(/.test(src) && /Chưa nhập bill được cho TID này/.test(src),
  'lý do được HIỆN RA trên màn (không chỉ tính trong bộ nhớ)');
// [B258 23/11 — Admin Demo "chặn thêm phải show rõ lý do và hướng dẫn fix"] LUẬT ĐỔI, KHÔNG NỚI:
// trước đây đòi nút phải `disabled` khi TID chưa đủ điều kiện — nhưng nút MỜ CÂM chính là thứ làm
// người nhập đứng hình (bấm không ra gì, không biết thiếu gì). Nay luật là:
//   · nút CHỈ khoá khi ĐANG GHI (busy) — còn lại bấm được để nghe lý do;
//   · HÀM GHI vẫn chặn đủ 3 cửa (thiếu thông tin · TID chưa đủ điều kiện · chưa có giá bán thực tế),
//     mỗi cửa đều `return toast.alert(...)` KÈM dòng "CÁCH SỬA" ⇒ fail-closed mà KHÔNG câm.
chot(/disabled=\{busy\}/.test(src), 'nút Ghi nhận bill chỉ khoá khi ĐANG GHI (không khoá câm)');
chot(/if \(thieuGi\.length > 0\)/.test(src) && /if \(tidChuaDung\)/.test(src)
  && /if \(thieuGiaBanThucTe\)/.test(src)
  && (src.match(/return toast\.alert/g) ?? []).length >= 3,
  'FAIL-CLOSED ở HÀM GHI: chặn đủ 3 cửa (thiếu thông tin · TID chưa đủ điều kiện · chưa có giá bán)');
chot((src.match(/CÁCH SỬA/g) ?? []).length >= 3,
  'mỗi cửa chặn đều kèm dòng "CÁCH SỬA" (nói chỗ sửa, không bắt đoán)');

console.log('\n[khong-an-im] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
if (loi.length) {
  console.error('[khong-an-im] ' + loi.length + ' ĐỎ: ' + loi.join(' | '));
  process.exit(1);
}
console.log('[khong-an-im] KHÔNG phép kiểm nào đỏ');
