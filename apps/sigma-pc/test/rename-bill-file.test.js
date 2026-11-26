// Test ĐỔI TÊN ẢNH BILL SAU OCR — chạy trên thư mục tạm THẬT (không mock fs): đúng tên, chống trùng, chống thoát
// thư mục, và các ca "chưa thành công". Đây là đường CHÍNH main.js gọi (require cùng module) — không phải bản sao.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { renameBillFile, sanitizeBaseName } = require('../src/rename-bill-file.js');

function tmpDirWithFile(name = 'bill.jpg') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renametest-'));
  const f = path.join(dir, name);
  fs.writeFileSync(f, 'x');
  return { dir, f };
}

test('QR đọc được → "1 - Đã thành công - HKD ..." giữ nguyên đuôi + thư mục', () => {
  const { dir, f } = tmpDirWithFile();
  const r = renameBillFile(f, '1 - Đã thành công - HKD DEMO 40 Ha Noi');
  assert.equal(r.ok, true);
  assert.equal(r.name, '1 - Đã thành công - HKD DEMO 40 Ha Noi.jpg');
  assert.equal(path.dirname(r.path), dir);
  assert.equal(fs.existsSync(f), false);
  assert.equal(fs.existsSync(r.path), true);
});

test('không đọc được → "3 - Chưa thành công"', () => {
  const { f } = tmpDirWithFile('anh.png');
  const r = renameBillFile(f, '3 - Chưa thành công');
  assert.equal(r.ok, true);
  assert.equal(r.name, '3 - Chưa thành công.png');
});

test('TRÙNG tên → tự thêm " (2)", KHÔNG đè file cũ', () => {
  const { dir, f } = tmpDirWithFile('a.jpg');
  fs.writeFileSync(path.join(dir, '1 - Đã thành công - TID 20281008.jpg'), 'cu');
  const r = renameBillFile(f, '1 - Đã thành công - TID 20281008');
  assert.equal(r.ok, true);
  assert.equal(r.name, '1 - Đã thành công - TID 20281008 (2).jpg');
  assert.equal(fs.readFileSync(path.join(dir, '1 - Đã thành công - TID 20281008.jpg'), 'utf8'), 'cu'); // file cũ nguyên vẹn
});

test('CHỐNG THOÁT THƯ MỤC: tên chứa ../ hoặc ..\ bị lọc, file ở lại đúng thư mục', () => {
  const { dir, f } = tmpDirWithFile();
  const r = renameBillFile(f, '../../hack');
  assert.equal(r.ok, true);
  assert.equal(path.dirname(path.resolve(r.path)), path.resolve(dir)); // KHÔNG ra ngoài
  assert.equal(r.name.includes('..'), false);
  const r2 = renameBillFile(r.path, '..' + String.fromCharCode(92) + 'windows' + String.fromCharCode(92) + 'evil');
  assert.equal(r2.ok, true);
  assert.equal(path.dirname(path.resolve(r2.path)), path.resolve(dir));
});

test('tên rỗng / toàn ký tự cấm → TỪ CHỐI, file giữ nguyên', () => {
  const { f } = tmpDirWithFile();
  const r = renameBillFile(f, '   ');
  assert.equal(r.ok, false);
  assert.equal(fs.existsSync(f), true);
  const r2 = renameBillFile(f, '///:::');
  assert.equal(r2.ok, false);
  assert.equal(fs.existsSync(f), true);
});

test('file không tồn tại / không phải ảnh → báo lỗi rõ, không ném', () => {
  assert.equal(renameBillFile(path.join(os.tmpdir(), 'khong-co-that-12345.jpg'), 'x').ok, false);
  const { dir } = tmpDirWithFile();
  const txt = path.join(dir, 'note.txt'); fs.writeFileSync(txt, 'x');
  const r = renameBillFile(txt, 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /không hợp lệ/);
});

test('đổi đúng tên nó đang có → unchanged, không đụng đĩa', () => {
  const { f } = tmpDirWithFile('2 - Đã thành công - TID 111.jpg');
  const r = renameBillFile(f, '2 - Đã thành công - TID 111');
  assert.equal(r.ok, true);
  assert.equal(r.unchanged, true);
});

test('sanitizeBaseName: cắt 120 ký tự, bỏ chấm đầu/cuối, gộp khoảng trắng', () => {
  assert.equal(sanitizeBaseName('  a   b  '), 'a b');
  assert.equal(sanitizeBaseName('...ten...'), 'ten');
  assert.equal(sanitizeBaseName('x'.repeat(200)).length, 120);
});
