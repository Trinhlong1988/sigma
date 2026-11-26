// ĐỔI TÊN ẢNH BILL SAU OCR (Admin Demo 8/9) — tách THUẦN khỏi main.js để TEST được bằng node:test (main.js phải nạp
// electron nên không test trực tiếp). main.js require file này; KHÔNG có bản sao logic ở nơi khác.
//
// Quy tắc: chỉ đổi TÊN, GIỮ NGUYÊN thư mục + phần mở rộng. Trùng tên → thêm " (2)", " (3)"…
// BẢO MẬT (bài học path-traversal ở save-file): lọc sạch ký tự cấm Windows + dấu phân cách, bỏ dấu chấm đầu/cuối,
// và path đích PHẢI nằm ĐÚNG thư mục cũ (so sánh sau resolve) — sai thì TỪ CHỐI, không ghi.
const fs = require('fs');
const path = require('path');

// < > : " / | ? * và dấu chéo ngược (dựng bằng mã ký tự để khỏi phải escape trong mã nguồn).
const KY_TU_CAM = ['<', '>', ':', '"', '/', '|', '?', '*', String.fromCharCode(92)];

/** Làm sạch tên file người dùng/OCR đưa vào. Trả '' nếu không còn gì hợp lệ. */
function sanitizeBaseName(raw) {
  let s = String(raw == null ? '' : raw);
  for (const ch of KY_TU_CAM) s = s.split(ch).join(' ');
  return s
    .replace(/\.{2,}/g, ' ')          // "../.." → khoảng trắng: tên sạch, không còn hình dạng đường dẫn
    .replace(/\s+/g, ' ').trim()
    .replace(/^\.+/, '').replace(/\.+$/, '').trim()
    .slice(0, 120);
}

/** Đổi tên 1 ảnh bill trong CHÍNH thư mục của nó. Trả {ok, path?, name?, unchanged?, error?}. */
function renameBillFile(filePath, newBaseName) {
  try {
    if (!filePath || !/\.(jpe?g|png|webp|jxl)$/i.test(filePath)) return { ok: false, error: 'Đường dẫn ảnh không hợp lệ.' };
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return { ok: false, error: 'Ảnh không tồn tại (đã xoá/đổi tên?).' };
    const safe = sanitizeBaseName(newBaseName);
    if (!safe) return { ok: false, error: 'Tên mới không hợp lệ.' };
    const dir = path.dirname(filePath);
    const ext = path.extname(filePath);
    let target = path.join(dir, safe + ext);
    if (path.dirname(path.resolve(target)) !== path.resolve(dir)) return { ok: false, error: 'Tên mới không hợp lệ (thoát thư mục).' };
    if (path.resolve(target) === path.resolve(filePath)) return { ok: true, path: filePath, name: path.basename(filePath), unchanged: true };
    for (let i = 2; fs.existsSync(target) && i <= 50; i++) target = path.join(dir, `${safe} (${i})${ext}`);
    if (fs.existsSync(target)) return { ok: false, error: 'Trùng tên quá nhiều lần — bỏ đổi tên.' };
    fs.renameSync(filePath, target);
    return { ok: true, path: target, name: path.basename(target) };
  } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
}

module.exports = { renameBillFile, sanitizeBaseName };
