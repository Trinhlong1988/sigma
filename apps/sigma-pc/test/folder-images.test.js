// Test LIỆT KÊ ẢNH BILL trong thư mục (đường CHÍNH main.js gọi khi bấm "Quét folder").
// BUG THẬT 8/9 (Admin Demo): "chọn file thủ công thì có, tự động lại báo không có file trong thư mục này" —
// thư mục ngày (bill\8.9) chia con (QR/POS), cấp ngoài 0 ảnh, bản cũ chỉ đọc 1 CẤP nên báo trống.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { listFolderImages } = require('../src/folder-images.js');

function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'folderimg-')); }
function put(dir, name) { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), 'x'); }

test('ảnh nằm ngay cấp ngoài → lấy đúng, không đụng thư mục con', () => {
  const d = tmpDir();
  put(d, 'a.jpg'); put(d, 'b.png'); put(d, 'ghichu.txt');
  put(d, 'QR/khong-lay.jpg');
  const r = listFolderImages(d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map((f) => f.name), ['a.jpg', 'b.png']);
  assert.equal(r.fromSubDirs, undefined);
});

test('CẤP NGOÀI TRỐNG → lấy ảnh trong thư mục con (chính bug 8/9), tên kèm thư mục', () => {
  const d = tmpDir();
  put(d, 'QR/bill1.jpg'); put(d, 'QR/bill2.jpg'); put(d, 'POS/bill3.jpg');
  const r = listFolderImages(d);
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map((f) => f.name), ['POS/bill3.jpg', 'QR/bill1.jpg', 'QR/bill2.jpg']);
  assert.equal(fs.existsSync(r.files[0].path), true); // path THẬT dùng để OCR/đổi tên
  assert.deepEqual(r.fromSubDirs, ['POS (1)', 'QR (2)']);
});

test('KHÔNG đệ quy sâu quá 1 cấp con (tránh vơ cả tháng bill)', () => {
  const d = tmpDir();
  put(d, 'thang9/8.9/QR/bill.jpg');
  const r = listFolderImages(d);
  assert.equal(r.ok, false);
  assert.match(r.error, /không có ảnh bill/);
});

test('không có ảnh ở đâu cả → báo lỗi RÕ (nêu tên thư mục), không trả rỗng im', () => {
  const d = tmpDir();
  put(d, 'ghi-chu.txt'); put(d, 'con/khac.pdf');
  const r = listFolderImages(d);
  assert.equal(r.ok, false);
  assert.match(r.error, /không có ảnh bill \(cả trong các thư mục con\)/);
});

test('thư mục không tồn tại → lỗi rõ, không ném', () => {
  const r = listFolderImages(path.join(os.tmpdir(), 'khong-co-that-98765'));
  assert.equal(r.ok, false);
  assert.match(r.error, /không tồn tại/);
});

test('trần 300 ảnh vẫn giữ khi gom từ thư mục con', () => {
  const d = tmpDir();
  for (let i = 0; i < 320; i++) put(d, `QR/b${String(i).padStart(4, '0')}.jpg`);
  const r = listFolderImages(d);
  assert.equal(r.ok, true);
  assert.equal(r.files.length, 300);
});
