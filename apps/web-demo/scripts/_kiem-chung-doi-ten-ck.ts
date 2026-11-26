// KIỂM CHỨNG THẬT TRÊN ĐĨA (Admin Demo 8/9 "kiểm chứng đúng sai 50 50 bằng chứng tường minh"):
// mô phỏng quét folder CK theo thứ tự file LỘN XỘN so với giờ trên bill, chạy ĐÚNG 2 mảnh code production
//   · danhSoCkTheoGio()  (web-demo/src/lib/bill-file-name.ts)
//   · renameBillFile()   (sigma-pc/src/rename-bill-file.js — chính hàm app PC gọi)
// rồi in tên file THẬT sau khi sắp theo tên. Chạy: node --import tsx scripts/_kiem-chung-doi-ten-ck.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { danhSoCkTheoGio, ckBillFileName, type CkBillDaDoc } from '../src/lib/bill-file-name';

const require_ = createRequire(import.meta.url);
const { renameBillFile } = require_(path.resolve(process.cwd(), '..', 'sigma-pc', 'src', 'rename-bill-file.js')) as {
  renameBillFile: (p: string, ten: string) => { ok: boolean; path?: string; name?: string; error?: string };
};

// 3 bill CK của KT Demo trong CÙNG ngày, nhưng THỨ TỰ FILE trong folder KHÔNG theo giờ (đây là ca dễ sai).
const BILLS: (CkBillDaDoc & { file: string })[] = [
  { idx: 0, nguoi: 'KETOAN', ngay: '08/09/2026', gio: '15:20:11', file: 'zalo_aaa.jpg' },
  { idx: 1, nguoi: 'KETOAN', ngay: '08/09/2026', gio: '09:05:02', file: 'zalo_bbb.jpg' },
  { idx: 2, nguoi: 'KETOAN', ngay: '08/09/2026', gio: '11:47:33', file: 'zalo_ccc.jpg' },
  { idx: 3, nguoi: 'LONG', ngay: '08/09/2026', gio: '10:00:00', file: 'zalo_ddd.jpg' }
];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-rename-'));
const duongDan = new Map<number, string>();
for (const b of BILLS) {
  const p = path.join(dir, b.file);
  fs.writeFileSync(p, 'anh-gia');
  duongDan.set(b.idx, p);
}
console.log('Thư mục thử:', dir);
console.log('Thứ tự QUÉT (theo tên file):', BILLS.map((b) => `${b.file}=${b.gio}`).join(' | '));

const so = danhSoCkTheoGio(BILLS);
for (const b of BILLS) {
  const ten = ckBillFileName({ senderName: b.nguoi }, so.get(b.idx))!;
  const r = renameBillFile(duongDan.get(b.idx)!, ten);
  if (!r.ok) { console.log('  ❌ đổi tên hỏng:', r.error); process.exit(1); }
  duongDan.set(b.idx, r.path!);
}

const sauKhiSap = fs.readdirSync(dir).sort();
console.log('\nTÊN FILE THẬT sau khi đổi + SẮP THEO TÊN:');
for (const f of sauKhiSap) console.log('   ' + f);

// Khẳng định: sắp theo tên = đúng trình tự GIỜ (09:05 → 11:47 → 15:20), Long đếm riêng từ 1.
const mongDoi = ['CK - NGUOIDUNG - 1.jpg', 'CK - KETOAN - 1.jpg', 'CK - KETOAN - 2.jpg', 'CK - KETOAN - 3.jpg'];
const dung = JSON.stringify(sauKhiSap) === JSON.stringify(mongDoi);
console.log(dung ? '\n✅ ĐÚNG: KETOAN 1=09:05 · 2=11:47 · 3=15:20 (dù file quét lộn xộn); NGUOIDUNG đếm riêng từ 1'
                 : `\n❌ SAI — mong đợi ${JSON.stringify(mongDoi)}`);
if (!dung) process.exitCode = 1;
