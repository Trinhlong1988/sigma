// KIỂM MẪU EXCEL RỖNG có ô CHỌN (data-validation) — đọc LẠI file bằng ExcelJS, không tin lời build.
// Chạy: node apps/desktop/scripts/_kiem-mau-excel-chon.mjs
import { buildTemplateWorkbook } from '../out/kiem-mau/export-service.js';
import ExcelJS from 'exceljs';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HEADERS = ['Chuỗi TID', 'Chuỗi MID', 'Tên HKD', 'Đối tác', 'Ngân hàng', 'Ngành nghề', 'Số tài khoản', 'Tên tài khoản', 'Ghi chú'];
// Danh sách DÀI cố ý (> 255 ký tự) để chắc chắn không rơi vào bẫy giới hạn ô validation của Excel.
const NGANH = Array.from({ length: 40 }, (_, i) => `Ngành nghề thử nghiệm số ${i + 1} — tên dài cho đủ ký tự`);
const NGAN_HANG = ['Ngân hàng Quân đội', 'Ngân hàng Bản Việt', 'Ngân hàng An Bình'];

let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };

const buf = await buildTemplateWorkbook({
  title: 'Mẫu nhập TID', headers: HEADERS,
  hints: HEADERS.map((h) => ({ header: h, required: false, hint: '' })),
  chon: { 'Ngành nghề': NGANH, 'Ngân hàng': NGAN_HANG }
});
const ra = resolve(import.meta.dirname, '../screenshots/pos-tid-16-11/_mau-tid-co-chon.xlsx');
writeFileSync(ra, buf);

const wb = new ExcelJS.Workbook();
await wb.xlsx.readFile(ra); // đọc lại = chứng minh file KHÔNG hỏng
const ws = wb.getWorksheet('Mẫu nhập');
chot(!!ws, 'mở lại được file, có sheet "Mẫu nhập"');
chot(ws.getRow(1).getCell(6).value === 'Ngành nghề', 'cột 6 vẫn là "Ngành nghề" (header không đổi, nhập lại vẫn khớp)');
const dvNganh = ws.getCell('F2').dataValidation;
chot(!!dvNganh && dvNganh.type === 'list', 'ô F2 (Ngành nghề) là ô CHỌN kiểu list');
chot(!!dvNganh && /Danh m/.test(String(dvNganh.formulae?.[0] ?? '')), 'trỏ vào DẢI Ô sheet "Danh mục" (không nhét chuỗi 255 ký tự)');
chot(!!ws.getCell('F501').dataValidation, 'ô chọn phủ tới dòng 501');
chot(!ws.getCell('F502').dataValidation, 'dòng 502 trở đi KHÔNG còn ô chọn (đúng phạm vi khai báo)');
chot(!!ws.getCell('E2').dataValidation, 'cột Ngân hàng cũng là ô chọn');
chot(!ws.getCell('A2').dataValidation, 'cột tự do (Chuỗi TID) KHÔNG bị ép chọn');
const dm = wb.getWorksheet('Danh mục');
chot(!!dm, 'có sheet "Danh mục"');
chot(dm && dm.state === 'veryHidden', 'sheet "Danh mục" bị ẩn hẳn');
chot(dm && dm.getCell(2, 1).value === NGANH[0], 'giá trị đầu danh mục ngành nghề đúng');
chot(dm && dm.getCell(1 + NGANH.length, 1).value === NGANH[NGANH.length - 1], 'giá trị CUỐI danh mục ngành nghề đúng (không cắt cụt)');
// ĐỐI CHỨNG: không truyền `chon` thì KHÔNG được tự sinh ô chọn.
const wb2 = new ExcelJS.Workbook();
await wb2.xlsx.load(await buildTemplateWorkbook({ title: 'x', headers: HEADERS }));
chot(!wb2.getWorksheet('Mẫu nhập').getCell('F2').dataValidation, 'ĐỐI CHỨNG: không có danh mục ⇒ không ô chọn nào');
chot(!wb2.getWorksheet('Danh mục'), 'ĐỐI CHỨNG: không có danh mục ⇒ không sinh sheet thừa');

console.log('\n[kiem-mau-excel] SỐ PHÉP KIỂM (đếm động) = ' + so);
console.log('[kiem-mau-excel] file: ' + ra);
console.log(loi.length ? '[kiem-mau-excel] ' + loi.length + ' ĐỎ' : '[kiem-mau-excel] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
