// B280 — [Admin Demo 24/11 "tất cả lỗi khi nhập bill, sửa bill, thêm máy, giao máy, lỗi vận hành app
// phải hiển thị rõ và có hướng dẫn xử lý, cấm lỗi câm, cấm chung chung khó hiểu"]
//
// Cổng khoá 3 tầng (TĨNH — đọc mã nguồn, vì hành vi bấm thật đã có cổng riêng từng màn):
//  (A) MỌI mã lỗi mà dịch vụ POS/TID/khách có thể trả về đều phải có hướng dẫn trong bảng dùng chung
//      `lib/bao-loi.ts` (hoặc bảng riêng màn Doanh Số). Máy chủ thêm mã mới mà quên hướng dẫn ⇒ ĐỎ.
//  (B) CẤM lỗi câm kiểu `else if (res.message) toast.alert(res.message)` — ok:false không message là
//      im lặng tuyệt đối. Mẫu này đã quét sạch 24/11, mọc lại ⇒ ĐỎ.
//  (C) CẤM câu chung chung trần trụi `toast.alert(res.message ?? 'X thất bại')` ở các màn máy/TID —
//      phải đi qua baoLoi() để luôn có CÁCH SỬA + mã lỗi.
// L3 — đối chứng âm cài sẵn: MAU_CO_Y_SAI dưới đây phải bị chính regex của cổng bắt được, không bắt
// được nghĩa là regex hỏng ⇒ ĐỎ. Đếm phép kiểm ĐỘNG (R198).
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const GOC = resolve(import.meta.dirname, '../../..');
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const doc = (f) => readFileSync(resolve(GOC, f), 'utf8');

// ── (A) mã lỗi dịch vụ ↔ bảng hướng dẫn ──
const bangChung = doc('apps/desktop/src/renderer/src/lib/bao-loi.ts');
const coChung = new Set([...bangChung.matchAll(/^\s{2}([A-Z_]+):\s*\{/gm)].map((m) => m[1]));
const trangBill = doc('apps/desktop/src/renderer/src/pages/BillManualEntryPage.tsx');
const khoiBill = /const HUONG_DAN_LOI[^=]*=\s*\{([\s\S]*?)\n\};/.exec(trangBill);
const coBill = new Set(khoiBill ? [...khoiBill[1].matchAll(/^\s{2}([A-Z_]+):/gm)].map((m) => m[1]) : []);
const NGUON_DV = [
  'packages/services/src/pos-supply.ts', 'packages/services/src/pos.ts',
  'packages/services/src/tid.ts', 'packages/services/src/tid-config.ts',
  'packages/services/src/customer.ts'
];
const maDv = new Set();
for (const f of NGUON_DV) for (const m of doc(f).matchAll(/error:\s*'([A-Z_]+)'/g)) maDv.add(m[1]);
const thieu = [...maDv].filter((x) => !coChung.has(x) && !coBill.has(x)).sort();
console.log('      mã lỗi dịch vụ POS/TID/khách:', maDv.size, '· bảng chung:', coChung.size, '· bảng bill:', coBill.size);
if (thieu.length) console.log('      THIẾU hướng dẫn cho:', thieu.join(' · '));
chot(maDv.size >= 10, 'quét được mã lỗi từ dịch vụ (đếm ' + maDv.size + ' — 0 là cổng hỏng, L8 cấm xanh rỗng)');
chot(thieu.length === 0, 'MỌI mã lỗi POS/TID/khách có hướng dẫn sửa');

// ── (B)+(C) quét mẫu lỗi câm / chung chung ở TẤT CẢ trang ──
const THU_MUC = 'apps/desktop/src/renderer/src/pages';
const trang = readdirSync(resolve(GOC, THU_MUC)).filter((f) => f.endsWith('.tsx'));
const MAU_CAM = /else if \(\w+\.message\) toast\.alert\(\w+\.message\);/;
// Màn ĐÃ dọn 24/11 — cấm mọc lại. (Các màn khác dọn dần, chưa chặn để cổng không đỏ oan hàng loạt.)
const DA_DON = new Set(['PosSupplyPage.tsx', 'PosPage.tsx', 'TidPage.tsx', 'TidConfigPage.tsx', 'BillManualEntryPage.tsx']);
const MAU_TRAN = /toast\.alert\(\w+\.message \?\? '[^']*thất bại'/;
const viPhamCam = [], viPhamTran = [];
for (const f of trang) {
  const s = doc(THU_MUC + '/' + f);
  if (DA_DON.has(f)) {
    if (MAU_CAM.test(s)) viPhamCam.push(f);
    if (MAU_TRAN.test(s)) viPhamTran.push(f);
  }
}
chot(viPhamCam.length === 0, 'màn máy/TID/bill KHÔNG còn lỗi câm (ok:false không message = im lặng)'
  + (viPhamCam.length ? ' — tái phát: ' + viPhamCam.join(', ') : ''));
chot(viPhamTran.length === 0, 'màn máy/TID/bill KHÔNG còn câu "…thất bại" trần trụi thiếu CÁCH SỬA'
  + (viPhamTran.length ? ' — tái phát: ' + viPhamTran.join(', ') : ''));

// ── L3: đối chứng âm cài sẵn — regex PHẢI bắt được mẫu cố ý sai ──
const MAU_CO_Y_SAI = "else if (res.message) toast.alert(res.message);";
const MAU_CO_Y_SAI_2 = "toast.alert(res.message ?? 'Lưu thất bại', 'x')";
chot(MAU_CAM.test(MAU_CO_Y_SAI) && MAU_TRAN.test(MAU_CO_Y_SAI_2),
  'đối chứng âm: regex của cổng BẮT ĐƯỢC mẫu cố ý sai (không bắt được = cổng mù)');

// ── baoLoi phải được CẮM DÂY thật (tool built ≠ wired) ──
const soCam = ['PosSupplyPage.tsx', 'PosPage.tsx', 'TidPage.tsx', 'TidConfigPage.tsx']
  .map((f) => (doc(THU_MUC + '/' + f).match(/baoLoi\(toast\.alert/g) ?? []).length);
console.log('      số chỗ gọi baoLoi theo màn (Supply/Pos/Tid/TidConfig):', soCam.join(' / '));
chot(soCam.every((n) => n >= 3), '4 màn máy/TID đều GỌI baoLoi ≥3 chỗ (không phải chỉ import suông)');

const CAN = 6;
console.log('\n[loi-ro-rang] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[loi-ro-rang] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[loi-ro-rang] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
