// [B180 16/11] CỔNG CHẶN TÁI DIỄN LỖI "MẤT DỮ LIỆU CÂM DO PHÂN TRANG MẶC ĐỊNH".
//
// Chuyện đã xảy ra (B179): màn Quản Lý TID gọi `/v1/tids` không truyền phân trang ⇒ máy chủ trả 100 dòng
// mặc định, sổ có 114 ⇒ 14 TID biến mất, KHÔNG BÁO GÌ. Phát hiện ra chỉ vì Admin Demo nhớ thiếu "Xuân Đoàn".
//
// Cổng này khẳng định 3 điều, chạy trong gate-test:
//  1. MỌI service khai `*_PAGE_SIZE_DEFAULT` đều có đường dẫn tương ứng được KHAI trong `DUONG_DAN_CAT_TRANG`
//     (thêm service phân trang mới mà quên khai ⇒ ĐỎ, không lọt im).
//  2. MỌI đường dẫn đã khai đều được bọc `keoHetTrang` ở CẢ HAI lớp gọi API (preload Electron + web-shim) —
//     sửa 1 lớp quên lớp kia là lỗi tái diễn (bài học R201).
//  3. KHÔNG đường dẫn nào trong danh sách còn lời gọi TRẦN `httpCall('GET', '/v1/...')` sót lại.
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GOC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOP_API = [
  'apps/desktop/src/preload/index.ts',
  'apps/desktop/src/web-shim/api.ts'
];
const FILE_KHAI = 'apps/desktop/src/shared/keo-het-danh-sach.ts';

let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; if (!ok) loi.push(ten); console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); };

// ── (1) service khai cắt trang ──
const thuMucSv = resolve(GOC, 'packages/services/src');
const svCat = [];
for (const f of readdirSync(thuMucSv).filter((x) => x.endsWith('.ts'))) {
  const noi = readFileSync(resolve(thuMucSv, f), 'utf8');
  for (const m of noi.matchAll(/const\s+([A-Z_]+)_PAGE_SIZE_DEFAULT\s*=\s*(\d+)/g)) {
    svCat.push({ file: f, ten: m[1], bo: Number(m[2]) });
  }
}
console.log('      service có cắt trang mặc định:', svCat.map((x) => `${x.file}:${x.ten}=${x.bo}`).join(' · '));
chot(svCat.length > 0, 'tìm thấy service có cắt trang mặc định (nếu 0 thì cổng này vô nghĩa)');

// ── (2) danh sách đường dẫn đã khai ──
const khai = readFileSync(resolve(GOC, FILE_KHAI), 'utf8');
const duong = [...khai.matchAll(/'(\/v1\/[a-z0-9-]+)'/g)].map((m) => m[1]);
console.log('      đường dẫn đã khai kéo-hết:', duong.join(' · '));
chot(duong.length >= svCat.length,
  `số đường dẫn khai (${duong.length}) phải ≥ số service cắt trang (${svCat.length}) — thêm service phân trang mới thì PHẢI khai`);

// ── (3) mỗi đường dẫn phải được bọc ở CẢ HAI lớp, và không còn lời gọi trần ──
for (const lop of LOP_API) {
  const noi = readFileSync(resolve(GOC, lop), 'utf8');
  const ten = lop.split('/').pop();
  chot(noi.includes('keoHetTrang'), `${ten}: có dùng keoHetTrang`);
  for (const d of duong) {
    const boc = new RegExp(`keoHetTrang\\([^\\n]*${d.replace(/\//g, '\\/')}\\$\\{qs`).test(noi);
    chot(boc, `${ten}: đường dẫn ${d} ĐƯỢC BỌC kéo-hết`);
    const tran = new RegExp(`httpCall\\('GET', \`${d.replace(/\//g, '\\/')}\\$\\{qs\\(rec\\(filter\\)\\)\\}\``).test(noi);
    chot(!tran, `${ten}: đường dẫn ${d} KHÔNG còn lời gọi trần (chưa bọc)`);
  }
}

console.log('[phan-trang] SO PHEP KIEM (dem dong) = ' + so);
const CAN = 2 + LOP_API.length * (1 + duong.length * 2);
if (so !== CAN) { loi.push(`THIEU PHEP KIEM: chay ${so}/${CAN}`); console.log(`  ĐỎ  phải chạy đủ ${CAN} phép kiểm`); }
if (loi.length) {
  console.log('[phan-trang] ' + loi.length + ' ĐỎ: ' + loi.join(' | '));
  process.exit(1);
}
console.log('[phan-trang] ✓ mọi danh sách có cắt trang đều kéo hết ở cả 2 lớp gọi API');
