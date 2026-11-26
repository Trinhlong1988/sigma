// THÊM alpha-quanly.example.com → http://localhost:57913 vào đường hầm f4575709 (cùng đường với API).
//
// CHỈ chạy khi Admin Demo đã tạo xong Cloudflare Access app cho tên miền này — vì trang này bày TOÀN BỘ
// màn hình tiền. Thiếu cờ `--da-tao-access` là script TỪ CHỐI chạy.
//
// Mặc định CHẠY THỬ (in ra bản sẽ ghi, không đụng file). Thêm `--that` mới ghi thật.
import { readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';

const CAU_HINH = '<REPO>\\.cloudflared\\config.yml';
const TEN_MIEN = process.env.TEN_MIEN || 'alpha-quanly.example.com';
const DICH = process.env.DICH || 'http://localhost:57913';
const THAT = process.argv.includes('--that');
const DA_ACCESS = process.argv.includes('--da-tao-access');

if (!DA_ACCESS) {
  console.error('*** TỪ CHỐI CHẠY ***');
  console.error('Trang này bày toàn bộ màn hình tiền. Phải tạo Cloudflare Access app cho ' + TEN_MIEN);
  console.error('(xem MO-WEB-QUANLY-RA-NGOAI.md mục 3) rồi chạy lại kèm cờ --da-tao-access.');
  process.exit(2);
}
if (!existsSync(CAU_HINH)) {
  console.error('*** KHÔNG THẤY ' + CAU_HINH + ' — DỪNG ***');
  process.exit(1);
}

const goc = readFileSync(CAU_HINH, 'utf8');

// Đã có rồi thì thôi — chạy lại nhiều lần KHÔNG được nhân đôi dòng.
if (goc.includes(TEN_MIEN)) {
  console.log('Đã có sẵn ' + TEN_MIEN + ' trong cấu hình — không thêm nữa.');
  process.exit(0);
}

// Chèn NGAY TRƯỚC dòng bắt-tất-cả `- service: http_status:404`. Nếu chèn sau, cloudflared sẽ rơi vào
// luật bắt-tất-cả trước khi tới luật mới ⇒ tên miền trả 404 mà không ai hiểu vì sao.
const BAT_TAT_CA = /^\s*- service: http_status:404\s*$/m;
const m = BAT_TAT_CA.exec(goc);
if (!m) {
  console.error('*** KHÔNG THẤY dòng "- service: http_status:404" để chèn trước — DỪNG, không đoán vị trí ***');
  process.exit(1);
}
const them =
  '  # SIGMA WEB QUẢN LÝ (13/11) — bản web nội bộ ở 127.0.0.1:57913, GÁC BẰNG CLOUDFLARE ACCESS.\n' +
  '  # Máy chủ tĩnh VẪN chỉ nghe 127.0.0.1: chỉ cloudflared trên chính máy này vào được, KHÔNG mở cổng\n' +
  '  # tường lửa, KHÔNG dùng LAN. Gỡ dòng này là tắt đường ra ngoài ngay.\n' +
  '  - hostname: ' + TEN_MIEN + '\n' +
  '    service: ' + DICH + '\n';
const moi = goc.slice(0, m.index) + them + goc.slice(m.index);

// Kiểm thô: số dòng hostname phải tăng đúng 1, và vẫn còn đúng 1 luật bắt-tất-cả.
const demHost = (s) => (s.match(/^\s*- hostname:/gm) || []).length;
const dem404 = (s) => (s.match(/^\s*- service: http_status:404/gm) || []).length;
const ok = demHost(moi) === demHost(goc) + 1 && dem404(moi) === 1 && dem404(goc) === 1;
console.log('Tên miền  : ' + TEN_MIEN + '  →  ' + DICH);
console.log('hostname  : ' + demHost(goc) + ' → ' + demHost(moi) + ' (phải +1)');
console.log('bắt-tất-cả: ' + dem404(moi) + ' (phải = 1)');
if (!ok) {
  console.error('*** BẢN MỚI KHÔNG ĐẠT KIỂM CÚ PHÁP THÔ — DỪNG, KHÔNG GHI ***');
  process.exit(1);
}

if (!THAT) {
  console.log('\n--- ĐOẠN SẼ CHÈN ---\n' + them);
  console.log('[chạy thử] CHƯA ghi gì. Chạy lại kèm --that để ghi thật.');
  process.exit(0);
}

const moc = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const sao = CAU_HINH + '.bak-' + moc;
copyFileSync(CAU_HINH, sao);
writeFileSync(CAU_HINH, moi, 'utf8');
console.log('\nĐã sao lưu: ' + sao);
console.log('Đã ghi    : ' + CAU_HINH);
console.log('\nCÒN 2 BƯỚC TAY (script này KHÔNG tự làm, để Admin Demo nắm quyền bật/tắt):');
console.log('  1) Tạo DNS (1 lần):');
console.log('     "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe" tunnel route dns f4575709-b0cf-41ff-b4f5-666181779a1e ' + TEN_MIEN);
console.log('  2) Khởi động lại cloudflared để nạp cấu hình mới:');
console.log('     powershell -Command "Restart-Service Cloudflared"');
console.log('\nSau đó chạy bài kiểm: node apps/desktop/scripts/kiem-web-cong-khai.mjs');
