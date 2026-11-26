// LIỆT KÊ ẢNH BILL TRONG 1 THƯ MỤC (Admin Demo 8/9) — tách THUẦN khỏi main.js để test được bằng node:test.
//
// GỐC bug "chọn thủ công thì có ảnh mà quét folder báo không có file": bản cũ chỉ đọc 1 CẤP. Thư mục ngày hay
// chia con (bill\8.9\QR, bill\8.9\POS) → cấp ngoài 0 ảnh → báo trống dù bên trong đầy.
// Quy tắc: có ảnh ở cấp ngoài → dùng luôn (không vơ thêm thư mục con, tránh trộn ngày). Cấp ngoài TRỐNG → lấy ảnh
// trong các thư mục con 1 CẤP (không đệ quy sâu), tên hiển thị "<thư mục con>/<file>", trần 300 ảnh.
const fs = require('fs');
const path = require('path');

const LA_ANH = (n) => /\.(jpe?g|png|webp|jxl)$/i.test(n);
const TRAN_ANH = 300;

function listFolderImages(dirPath) {
  try {
    if (!dirPath || !fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
      return { ok: false, error: 'Folder không tồn tại hoặc đã bị xoá/đổi tên.' };
    }
    const names = fs.readdirSync(dirPath).filter(LA_ANH).sort();
    if (names.length > 0) {
      return { ok: true, files: names.slice(0, TRAN_ANH).map((n) => ({ name: n, path: path.join(dirPath, n) })) };
    }
    const subs = fs.readdirSync(dirPath, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const files = [];
    const fromSubDirs = [];
    for (const sub of subs) {
      const subDir = path.join(dirPath, sub);
      let subNames = [];
      try { subNames = fs.readdirSync(subDir).filter(LA_ANH).sort(); } catch { continue; }
      if (!subNames.length) continue;
      fromSubDirs.push(`${sub} (${subNames.length})`);
      for (const n of subNames) {
        if (files.length >= TRAN_ANH) break;
        files.push({ name: `${sub}/${n}`, path: path.join(subDir, n) });
      }
      if (files.length >= TRAN_ANH) break;
    }
    if (!files.length) return { ok: false, error: `Thư mục "${path.basename(dirPath)}" không có ảnh bill (cả trong các thư mục con).` };
    return { ok: true, files, fromSubDirs };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
}

module.exports = { listFolderImages };
