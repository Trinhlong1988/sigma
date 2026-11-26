// KHO FILE SERVER (thuần server, KHÔNG Electron) — Admin Demo chốt: ảnh hồ sơ ĐKKD/CCCD (dossier), ảnh CCCD
// (receive-account), ảnh QR đại lý (agent) lưu vào 1 KHO FILE RIÊNG trên máy chủ; DB CHỈ giữ path tương đối +
// tên gốc. KHÔNG nhét BLOB vào DB (khác agent-qr-service cũ — xem báo cáo LEAD). App gọi API upload/download
// thay vì đọc file cục bộ.
//
// PORT logic magic-bytes (sniffFileType) từ apps/desktop/src/main/file-store.ts sang bản THUẦN: nhận BUFFER,
// KHÔNG đọc đĩa nguồn, KHÔNG phụ thuộc `electron.app`. Thư mục gốc = process.env.SIGMA_FILE_STORE || 'D:/alpha-files'
// (self-test bơm tmp qua SIGMA_FILE_STORE để KHÔNG ghi vào kho thật). Chia theo entity: dossiers/<id>/,
// receive-accounts/<id>/, agents/<id>/. Tên file NGẪU NHIÊN (randomUUID) + đuôi theo magic-bytes (KHÔNG tin
// đuôi/mime client gửi). Chống path traversal TRIỆT ĐỂ khi đọc (resolve tuyệt đối phải nằm TRONG root).
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';

export type FileFamily = 'png' | 'jpg' | 'pdf';

const EXT_BY_FAMILY: Record<FileFamily, string> = { png: '.png', jpg: '.jpg', pdf: '.pdf' };
const MIME_BY_FAMILY: Record<FileFamily, string> = { png: 'image/png', jpg: 'image/jpeg', pdf: 'application/pdf' };
const MIME_BY_EXT: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf' };

/** Chỉ ẢNH (QR/CCCD chụp) — dùng cho route "chỉ image/*". */
export const IMAGE_FAMILIES: FileFamily[] = ['png', 'jpg'];
/** Ảnh + PDF — hồ sơ ĐKKD/CCCD desktop vốn nhận cả PDF scan (ALLOWED_EXT desktop file-store.ts). */
export const DOC_FAMILIES: FileFamily[] = ['png', 'jpg', 'pdf'];

// P2-02 (hardening 16/7): xác thực NỘI DUNG bằng magic-bytes, KHÔNG tin đuôi file — chống đổi tên .exe→.png.
// Trả họ định dạng thật ('png'|'jpg'|'pdf') hay null nếu không khớp chữ ký nào. PORT Y HỆT desktop file-store.ts.
export function sniffFileType(buf: Buffer): FileFamily | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d) return 'pdf'; // %PDF-
  return null;
}

/** MIME suy từ đuôi file đã lưu (kho tự đặt đuôi theo magic-bytes nên tin được). */
export function mimeForRelPath(relPath: string): string {
  const dot = relPath.lastIndexOf('.');
  const ext = dot >= 0 ? relPath.slice(dot).toLowerCase() : '';
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

/** Thư mục gốc kho file. SIGMA_FILE_STORE override cho self-test/dev; mặc định D:/alpha-files. Tự tạo nếu thiếu. */
export function fileStoreRoot(): string {
  const root = process.env['SIGMA_FILE_STORE'] || 'D:/alpha-files';
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  return root;
}

export interface StoredFile {
  relPath: string; // path tương đối lưu DB (dùng '/'), vd 'dossiers/12/ab12...de.png'
  mime: string;
  checksum: string; // sha256 hex (tiện đối soát trùng/toàn vẹn)
  size: number;
}
export type StoreFileResult = { ok: true; file: StoredFile } | { ok: false; error: string; message: string };

/**
 * Ghi 1 buffer vào kho dưới <root>/<entity>/<id>/<uuid><ext>. `allowed` = tập họ định dạng chấp nhận (ảnh, hoặc
 * ảnh+PDF cho hồ sơ). Xác thực magic-bytes TRƯỚC KHI ghi (không tin mime/đuôi client). KHÔNG throw cho lỗi
 * nghiệp vụ — trả discriminated union để route map status. Tên NGẪU NHIÊN → không lộ tên gốc/không đụng độ khi
 * thay ảnh (bản cũ do caller tự trash qua trashFile(oldPath) sau khi update DB).
 */
export function storeFile(entity: string, id: number, buffer: Buffer, allowed: FileFamily[]): StoreFileResult {
  if (!buffer || buffer.length === 0) return { ok: false, error: 'NO_FILE', message: 'Không có dữ liệu ảnh.' };
  const fam = sniffFileType(buffer);
  if (fam === null || !allowed.includes(fam)) {
    const label = allowed.includes('pdf') ? 'PNG/JPG/PDF' : 'PNG/JPG';
    return { ok: false, error: 'BAD_CONTENT', message: `Nội dung file không đúng định dạng ${label} (đổi tên đuôi không qua mặt được).` };
  }
  const ext = EXT_BY_FAMILY[fam];
  const dir = join(fileStoreRoot(), entity, String(id));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const fileName = `${randomUUID()}${ext}`;
  const abs = join(dir, fileName);
  writeFileSync(abs, buffer);
  const checksum = createHash('sha256').update(buffer).digest('hex');
  const relPath = join(entity, String(id), fileName).replace(/\\/g, '/');
  return { ok: true, file: { relPath, mime: MIME_BY_FAMILY[fam], checksum, size: buffer.length } };
}

/** Giải path tương đối về tuyệt đối, BẮT BUỘC nằm trong root (chống traversal '..'/tuyệt đối/mã hoá lạ). null nếu sai. */
function resolveInsideRoot(relPath: string): string | null {
  if (!relPath) return null;
  // BUG-FIX (prod, env SIGMA_FILE_STORE unset): fileStoreRoot() trả 'D:/alpha-files' (dấu '/'), nhưng resolve()
  // trên win32 sinh path dấu '\' → so `abs.startsWith('D:/alpha-files' + '\\')` KHÔNG BAO GIỜ khớp → BAD_PATH cho
  // MỌI path thật (tải ảnh hồ sơ/CCCD hỏng toàn bộ). resolve(fileStoreRoot()) chuẩn hóa root về separator nền tảng
  // TRƯỚC khi so, khớp với `abs` (cũng do resolve sinh ra). Test cũ chỉ bơm SIGMA_FILE_STORE=tmp (đã chuẩn hóa) nên
  // không lộ (R198/R200: xanh test ≠ đúng prod).
  const root = resolve(fileStoreRoot());
  const abs = resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  return abs;
}

export type ReadFileResult = { ok: true; buffer: Buffer; mime: string } | { ok: false; error: string; message: string };

/** Đọc bytes 1 file trong kho theo path tương đối (đã qua guard traversal). */
export function readFileFromStore(relPath: string): ReadFileResult {
  const abs = resolveInsideRoot(relPath);
  if (!abs) return { ok: false, error: 'BAD_PATH', message: 'Đường dẫn không hợp lệ.' };
  if (!existsSync(abs)) return { ok: false, error: 'NOT_FOUND', message: 'File không còn tồn tại.' };
  return { ok: true, buffer: readFileSync(abs), mime: mimeForRelPath(relPath) };
}

/** Chuyển 1 file trong kho vào _trash/<entity>/<id> (không xóa cứng — R_AUDIT_TRAIL). No-op nếu path rỗng/không tồn tại/sai. */
export function trashFileFromStore(relPath: string): void {
  const abs = resolveInsideRoot(relPath);
  if (!abs || !existsSync(abs)) return;
  const root = fileStoreRoot();
  // Giữ cấu trúc entity/id dưới _trash để truy vết (relPath dạng 'dossiers/12/uuid.png').
  const trashDir = join(root, '_trash', dirname(relPath));
  if (!existsSync(trashDir)) mkdirSync(trashDir, { recursive: true });
  renameSync(abs, join(trashDir, `${Date.now()}_${basename(abs)}`));
}

/** Kích thước file (byte) — tiện kiểm thử. 0 nếu không có/sai path. */
export function fileSizeInStore(relPath: string): number {
  const abs = resolveInsideRoot(relPath);
  return abs && existsSync(abs) ? statSync(abs).size : 0;
}

// ── DTO dùng chung cho tầng service (dossier/receive-account/agent) ─────────────────────────────────────
/** Đầu vào upload 1 ảnh đính kèm: bytes + tên gốc (client gửi, dùng để hiển thị — KHÔNG dùng đặt tên kho). */
export interface AttachmentUpload {
  buffer: Buffer;
  originalName?: string | null;
}
/** Kết quả tải 1 ảnh đính kèm về (route tự set Content-Type = mime rồi res.send(buffer)). */
export interface AttachmentDownload {
  ok: boolean;
  buffer?: Buffer;
  mime?: string;
  fileName?: string | null;
  error?: string;
  message?: string;
}
