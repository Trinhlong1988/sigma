// Test LÕI THUẦN kho file server (@sigma/services/file-store) — magic-bytes sniff + store/read/trash + guard
// traversal. Ghi vào TMP DIR qua SIGMA_FILE_STORE (KHÔNG đụng D:/alpha-files thật). fileStoreRoot() đọc env ở
// MỖI lần gọi nên set env trong beforeEach là đủ (không phụ thuộc thứ tự import).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sniffFileType, storeFile, readFileFromStore, trashFileFromStore, fileSizeInStore, mimeForRelPath,
  IMAGE_FAMILIES, DOC_FAMILIES
} from '../src/file-store.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01, 0x02, 0x03]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x11, 0x12]);
const PDF = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // %PDF-1.7
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]); // MZ

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'alpha-fs-'));
  process.env['SIGMA_FILE_STORE'] = root;
});
afterEach(() => {
  delete process.env['SIGMA_FILE_STORE'];
  if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
});

describe('sniffFileType — magic-bytes', () => {
  it('nhận PNG/JPG/PDF, từ chối .exe & buffer ngắn', () => {
    expect(sniffFileType(PNG)).toBe('png');
    expect(sniffFileType(JPG)).toBe('jpg');
    expect(sniffFileType(PDF)).toBe('pdf');
    expect(sniffFileType(EXE)).toBeNull();
    expect(sniffFileType(Buffer.alloc(0))).toBeNull();
  });
});

describe('storeFile / readFileFromStore', () => {
  it('lưu ảnh PNG → relPath đúng entity/id + đuôi theo magic-bytes; đọc lại khớp bytes + mime', () => {
    const r = storeFile('dossiers', 12, PNG, DOC_FAMILIES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file.relPath.startsWith('dossiers/12/')).toBe(true);
    expect(r.file.relPath.endsWith('.png')).toBe(true);
    expect(r.file.size).toBe(PNG.length);
    expect(existsSync(join(root, r.file.relPath))).toBe(true);

    const back = readFileFromStore(r.file.relPath);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(Buffer.compare(back.buffer, PNG)).toBe(0);
    expect(back.mime).toBe('image/png');
  });

  it('PDF được chấp nhận với DOC_FAMILIES nhưng TỪ CHỐI với IMAGE_FAMILIES', () => {
    expect(storeFile('dossiers', 1, PDF, DOC_FAMILIES).ok).toBe(true);
    const img = storeFile('agents', 1, PDF, IMAGE_FAMILIES);
    expect(img.ok).toBe(false);
    if (!img.ok) expect(img.error).toBe('BAD_CONTENT');
  });

  it('nội dung .exe đổi đuôi → BAD_CONTENT (không tin đuôi/mime client)', () => {
    const r = storeFile('receive-accounts', 3, EXE, DOC_FAMILIES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('BAD_CONTENT');
  });

  it('buffer rỗng → NO_FILE', () => {
    const r = storeFile('dossiers', 1, Buffer.alloc(0), DOC_FAMILIES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NO_FILE');
  });
});

describe('guard path traversal', () => {
  it('đọc path thoát khỏi root → BAD_PATH (không đọc file ngoài kho)', () => {
    expect(readFileFromStore('../../etc/passwd').ok).toBe(false);
    const r = readFileFromStore('..\\..\\secret.txt');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('BAD_PATH');
  });
  it('đọc path hợp lệ nhưng file không tồn tại → NOT_FOUND', () => {
    const r = readFileFromStore('dossiers/99/khong-co.png');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('NOT_FOUND');
  });
});

describe('trashFileFromStore', () => {
  it('chuyển file khỏi vị trí gốc vào _trash (không xóa cứng)', () => {
    const r = storeFile('dossiers', 5, JPG, DOC_FAMILIES);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(fileSizeInStore(r.file.relPath)).toBe(JPG.length);
    trashFileFromStore(r.file.relPath);
    expect(existsSync(join(root, r.file.relPath))).toBe(false); // đã rời vị trí gốc
    expect(existsSync(join(root, '_trash'))).toBe(true); // vào thùng rác
  });
  it('path rỗng/sai → no-op (không throw)', () => {
    expect(() => trashFileFromStore('')).not.toThrow();
    expect(() => trashFileFromStore('../x')).not.toThrow();
  });
});

describe('mimeForRelPath', () => {
  it('suy mime theo đuôi kho tự đặt', () => {
    expect(mimeForRelPath('a/b/c.png')).toBe('image/png');
    expect(mimeForRelPath('a/b/c.jpg')).toBe('image/jpeg');
    expect(mimeForRelPath('a/b/c.pdf')).toBe('application/pdf');
    expect(mimeForRelPath('a/b/c.bin')).toBe('application/octet-stream');
  });
});

// R198/R200 — BUG PROD: khi SIGMA_FILE_STORE UNSET, fileStoreRoot()='D:/alpha-files' (dấu '/') còn resolve() trên
// win32 sinh path dấu '\' → guard `abs.startsWith(root + sep)` KHÔNG khớp → BAD_PATH cho MỌI path thật (tải ảnh
// hồ sơ/CCCD hỏng toàn bộ). Test cũ CHỈ bơm SIGMA_FILE_STORE=tmp (đã chuẩn hóa) → không bao giờ chạm nhánh prod.
// Nhánh này exercise ĐÚNG cấu hình prod (env unset + root dạng '/'), KHÔNG ghi vào D:/alpha-files thật.
describe('PROD default-root guard (SIGMA_FILE_STORE UNSET / root dạng "/")', () => {
  it('env UNSET: guard CHẤP NHẬN relPath hợp lệ dưới root mặc định (NOT_FOUND, KHÔNG phải BAD_PATH)', () => {
    delete process.env['SIGMA_FILE_STORE']; // ép nhánh prod (root mặc định 'D:/alpha-files')
    // relPath hợp lệ → qua guard (file chưa tồn tại) = NOT_FOUND. TRƯỚC FIX: slash-mismatch → BAD_PATH cho mọi path.
    const ok = readFileFromStore('dossiers/424242/regression-guard.png');
    expect(ok.ok).toBe(false);
    if (!ok.ok) expect(ok.error).toBe('NOT_FOUND'); // mấu chốt: KHÔNG phải 'BAD_PATH'
    // Traversal vẫn phải bị chặn dưới root mặc định.
    const bad = readFileFromStore('../../etc/passwd');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe('BAD_PATH');
  });

  it('root dạng dấu "/" (đúng định dạng prod): storeFile → readFileFromStore round-trip khớp bytes', () => {
    // Tái hiện AN TOÀN định dạng prod (root dấu '/') vào tmp — KHÔNG đụng D:/alpha-files thật.
    const fwdRoot = mkdtempSync(join(tmpdir(), 'alpha-fs-fwd-')).replace(/\\/g, '/');
    process.env['SIGMA_FILE_STORE'] = fwdRoot;
    try {
      const r = storeFile('dossiers', 7, PNG, DOC_FAMILIES);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const back = readFileFromStore(r.file.relPath); // TRƯỚC FIX: BAD_PATH; SAU FIX: đọc lại đúng bytes
      expect(back.ok).toBe(true);
      if (!back.ok) return;
      expect(Buffer.compare(back.buffer, PNG)).toBe(0);
      expect(fileSizeInStore(r.file.relPath)).toBe(PNG.length);
    } finally {
      delete process.env['SIGMA_FILE_STORE'];
      if (existsSync(fwdRoot)) rmSync(fwdRoot, { recursive: true, force: true });
    }
  });
});
