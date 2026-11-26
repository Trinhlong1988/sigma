// Bóc zaloGroupId + lọc file ảnh bill từ cây thư mục ZaloData. THUẦN để test. Zalo có 2 cấu trúc (kiểm chứng 25/8):
//   (CŨ)    <media>/<acct>/ZaloDownloads/picture/<N>_group/<file z…>.jxl
//   (ACTIVE)<media>/<acct>/ZaloDownloads/resource/g<N>/picture/<ts>_<sender>_g<N>_<hash>.jxl   ← bill MỚI về ở đây
// groupId CANONICAL = `g<N>` (khớp key LevelDB → resolve tên được). Lấy từ TÊN FILE token `_g<digits>_` (active)
// hoặc folder `g<N>` (active), hoặc folder `<N>_group` (cũ, chuẩn hoá thành g<N>).
import fs from 'node:fs';
import path from 'node:path';

export const IMG_EXT = ['.jxl', '.jpg', '.jpeg', '.png', '.webp'];

/** Chuẩn hoá groupId về canonical `g<digits>`. Nhận `g123` / `123` / `123_group` → `g123`. Không phải dạng nhóm
 *  → trả nguyên (đã trim). '' → null. */
export function canonicalGroupId(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return null;
  const m = t.match(/^g?(\d+)(?:_group)?$/i);
  return m ? `g${m[1]}` : t;
}

/** Bóc groupId canonical `g<N>` từ đường dẫn 1 file ảnh Zalo (cả 2 cấu trúc). null nếu không nhận ra. */
export function deriveZaloGroupId(filePath) {
  const s = String(filePath);
  const base = path.basename(s);
  // 1) Tên file active: `<ts>_<sender>_g<groupId>_<hash>.ext` → token g<digits>.
  const fromName = base.match(/_g(\d+)_/);
  if (fromName) return `g${fromName[1]}`;
  // 2) Segment thư mục.
  const parts = s.split(/[\\/]+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    if (/^g\d+$/i.test(seg)) return `g${seg.replace(/^g/i, '')}`; // resource/g<N>
    const oldFolder = seg.match(/^(\d+)_group$/i);
    if (oldFolder) return `g${oldFolder[1]}`; // picture/<N>_group
  }
  return null;
}

/** File có phải ảnh bill ứng viên không: nằm trong ZaloDownloads, dưới 1 thư mục `picture` (cả picture/<N>_group
 *  lẫn resource/g<N>/picture), ext ảnh. Loại thumbnail (thumb/richThumb/fileThumb). */
export function isBillCandidateFile(filePath) {
  const p = String(filePath).replace(/\\/g, '/').toLowerCase();
  if (!p.includes('/zalodownloads/')) return false;
  if (!/\/picture\//.test(p)) return false; // phải nằm dưới 1 thư mục picture (cả 2 cấu trúc)
  if (/\/(thumb|thumbnail|richthumb|filethumb)\//.test(p)) return false;
  return IMG_EXT.includes(path.extname(p));
}

/** Duyệt đệ quy mediaRoot, trả về mảng {path, mtimeMs} của mọi ảnh ứng viên bill. Bỏ qua thư mục rác Zalo. */
export function walkBillImages(mediaRoot) {
  const out = [];
  const SKIP_DIR = /^(action|cache|filethumb|richthumb|thumb|thumbnail|sticker|voice|notify|log|crash|qos|temp|update)$/i;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIR.test(ent.name)) continue;
        walk(full);
      } else if (ent.isFile() && isBillCandidateFile(full)) {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(full).mtimeMs;
        } catch {
          continue;
        }
        out.push({ path: full, mtimeMs });
      }
    }
  };
  walk(mediaRoot);
  return out;
}
