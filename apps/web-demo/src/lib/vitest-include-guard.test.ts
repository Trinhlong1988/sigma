// AUDIT-6 (3/8) — GUARD chống "test mồ côi" web-demo (flush rule từ regression thành test bền).
//
// BỐI CẢNH LỖI QUY TRÌNH (bằng chứng thật, KHÔNG suy đoán): apps/web-demo KHÔNG có vitest.config riêng và
// KHÔNG có script "test" trong package.json → mọi test web-demo chỉ chạy nếu được LIỆT KÊ TỪNG FILE trong
// mảng `test.include` của vitest.config.ts ở gốc repo (allowlist thủ công, KHÔNG glob). Tại commit 5d141c3 có
// 12 file *.test.ts (146 test) TỒN TẠI + PASS nhưng KHÔNG nằm trong allowlist → `npm test` KHÔNG BAO GIỜ chạy
// chúng (false-coverage). Lý do allowlist thay vì glob: repo CHƯA có jsdom/@testing-library nên KHÔNG thể
// glob-chạy mọi test web-demo (test cần DOM sẽ vỡ) — nhưng hệ quả là mỗi test THUẦN mới phải nhớ thêm tay,
// và người ta QUÊN.
//
// Guard này biến quy ước "mọi test web-demo THUẦN phải được wire vào include" thành BẤT BIẾN TỰ KIỂM: quét
// mọi *.test.ts dưới apps/web-demo/src và assert từng đường dẫn có mặt trong text vitest.config.ts. Thêm 1
// test web-demo mới mà quên wire → guard FAIL ngay với tên file thiếu, KHÔNG lọt âm thầm nữa.
//
// Nếu CỐ Ý loại 1 test khỏi include (vd test cần DOM chưa có jsdom), thêm tên file vào ALLOWED_UNWIRED bên
// dưới KÈM lý do — buộc quyết định loại trừ phải TƯỜNG MINH, không im lặng.
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// Test cố ý KHÔNG wire (phải kèm lý do). Hiện tại: rỗng — mọi test web-demo đều là hàm thuần chạy ở env node.
const ALLOWED_UNWIRED = new Set<string>([
  // ví dụ tương lai: 'some-dom-heavy.test.ts' — cần jsdom, repo chưa có (xem comment đầu file test đó)
  // QA prefetch OCR (Admin Demo 1/9): là SCRIPT tsx THUẦN (node:assert + console.log, chạy `npx tsx ...`), KHÔNG
  // phải suite vitest (không describe/it/expect) → cố ý KHÔNG wire vào include; chạy độc lập trong QA prefetch.
  'ocr-prefetch-pool.test.ts'
]);

const WEB_DEMO_SRC = join(process.cwd(), 'apps', 'web-demo', 'src');
const VITEST_CONFIG = join(process.cwd(), 'vitest.config.ts');

function listTestFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) listTestFiles(full, acc);
    else if (entry.name.endsWith('.test.ts') || entry.name.endsWith('.test.tsx')) acc.push(full);
  }
  return acc;
}

describe('vitest include guard — chống test mồ côi web-demo', () => {
  it('mọi *.test.ts trong apps/web-demo/src PHẢI được liệt kê trong vitest.config.ts include (hoặc khai báo loại trừ tường minh)', () => {
    const configText = readFileSync(VITEST_CONFIG, 'utf8');
    const testFiles = listTestFiles(WEB_DEMO_SRC);

    // Sanity: chắc chắn quét ra được test (nếu 0 → đường dẫn sai, guard vô nghĩa — bắt luôn).
    expect(testFiles.length).toBeGreaterThan(10);

    const orphans: string[] = [];
    for (const abs of testFiles) {
      // đường dẫn dạng POSIX tương đối repo-root (khớp cách viết trong include, vd 'apps/web-demo/src/lib/x.test.ts')
      const rel = abs.slice(process.cwd().length + 1).replace(/\\/g, '/');
      const base = rel.split('/').pop()!;
      if (ALLOWED_UNWIRED.has(base)) continue;
      if (!configText.includes(rel)) orphans.push(rel);
    }

    expect(orphans, `Test web-demo TỒN TẠI nhưng KHÔNG được wire vào vitest.config.ts include (sẽ KHÔNG chạy trong npm test):\n${orphans.join('\n')}`).toEqual([]);
  });
});
