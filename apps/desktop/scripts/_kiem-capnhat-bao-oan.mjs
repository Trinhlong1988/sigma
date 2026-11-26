// B249 — [Admin Demo 22/11 "sao vẫn cứ có feed báo cập nhật thất bại thế"] CHẶN BÁO ĐỎ OAN.
//
// Luồng cập nhật nằm trong Electron (import 'electron' ⇒ node trần không nạp được), nên cổng này
// chạy phần LOGIC THUẦN qua `npx tsx`: đánh giá marker sau khi khởi động lại + so số phiên bản +
// nhật ký cập nhật. Đây đúng chỗ đã báo oan: marker không có số bản đích, hoặc bản đang chạy MỚI HƠN
// bản đích, đều bị kết luận "Cập nhật thất bại".
//
// Cổng này được `_chay-cong-giao-dien.mjs` tự nhặt (tiền tố `_kiem-`) nên nằm TRONG cổng ship —
// không lặp lại lỗi "viết cổng xong quên cắm dây".
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const THUMUC = import.meta.dirname;
try {
  // shell:true nối thẳng tham số KHÔNG escape ⇒ đường dẫn có dấu cách ("<REPO>\...") bị cắt
  // thành "D:/TT" và báo ERR_MODULE_NOT_FOUND. Bọc dấu nháy kép là xong.
  execFileSync('npx', ['tsx', '"' + resolve(THUMUC, 'kiem-capnhat-logic.mts') + '"'], {
    cwd: resolve(THUMUC, '..'),
    stdio: 'inherit',
    shell: true
  });
} catch {
  process.exitCode = 1;
}
