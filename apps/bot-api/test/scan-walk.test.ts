// [Admin Demo 2/9 "cấm sót bill trong thư mục con"] TEST HÀNH VI walkFolderForBills — quét ĐỆ QUY folder bill.
// REGRESSION: trước đây scan 1 cấp (readdirSync) → bill trong subfolder SÓT CÂM. Nay đệ quy + đếm file đuôi lạ mọi cấp.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { walkFolderForBills } from '../src/routes/ocr-send.js';

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'scan-walk-'));
  // cấp 0
  writeFileSync(join(root, 'bill1.jpg'), 'x');
  writeFileSync(join(root, 'note.txt'), 'x');       // không phải ảnh, không suspect
  writeFileSync(join(root, 'scan.pdf'), 'x');        // suspect (nghi bill)
  // subfolder cấp 1 (bill hay để trong thư mục con theo ngày)
  mkdirSync(join(root, '30-08'));
  writeFileSync(join(root, '30-08', 'bill2.png'), 'x');
  writeFileSync(join(root, '30-08', 'bill3.jpeg'), 'x');
  writeFileSync(join(root, '30-08', 'iphone.heic'), 'x'); // suspect trong subfolder
  // subfolder cấp 2
  mkdirSync(join(root, '30-08', 'dai-ly-A'));
  writeFileSync(join(root, '30-08', 'dai-ly-A', 'bill4.webp'), 'x');
  // thư mục ẩn/hệ thống — BỎ QUA
  mkdirSync(join(root, '.hidden'));
  writeFileSync(join(root, '.hidden', 'skip.jpg'), 'x');
});
afterAll(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ } });

describe('walkFolderForBills — quét đệ quy, chống sót bill subfolder', () => {
  it('gom ẢNH mọi cấp (gồm subfolder cấp 1 + 2), bỏ thư mục ẩn', () => {
    const { images } = walkFolderForBills(root);
    const names = images.map((i) => i.name.replace(/\\/g, '/')).sort();
    expect(names).toEqual(['30-08/bill2.png', '30-08/bill3.jpeg', '30-08/dai-ly-A/bill4.webp', 'bill1.jpg']);
  });

  it('name = ĐƯỜNG DẪN TƯƠNG ĐỐI (hiện rõ subfolder), path = tuyệt đối', () => {
    const { images } = walkFolderForBills(root);
    const b4 = images.find((i) => i.name.replace(/\\/g, '/') === '30-08/dai-ly-A/bill4.webp');
    expect(b4).toBeTruthy();
    expect(b4!.path).toContain('bill4.webp');
    expect(b4!.path.length).toBeGreaterThan(b4!.name.length); // path tuyệt đối dài hơn
  });

  it('suspects = file đuôi lạ (pdf/heic) MỌI CẤP (chống lọt đếm câm)', () => {
    const { suspects } = walkFolderForBills(root);
    const s = suspects.map((x) => x.replace(/\\/g, '/')).sort();
    expect(s).toEqual(['30-08/iphone.heic', 'scan.pdf']);
  });

  it('bỏ thư mục ẩn (.hidden) — không gom ảnh trong đó', () => {
    const { images } = walkFolderForBills(root);
    expect(images.some((i) => i.name.includes('.hidden') || i.name.includes('skip'))).toBe(false);
  });

  it('maxDepth chặn quá sâu (đệ quy có trần)', () => {
    // cấp 0 root, 30-08 = cấp1, dai-ly-A = cấp2 — với maxDepth=1 chỉ tới cấp1, KHÔNG vào dai-ly-A.
    const { images } = walkFolderForBills(root, 1);
    expect(images.some((i) => i.name.includes('bill4'))).toBe(false); // cấp 2 bị chặn
    expect(images.some((i) => i.name.includes('bill2'))).toBe(true);  // cấp 1 vẫn có
  });
});
