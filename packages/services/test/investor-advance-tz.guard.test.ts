// GUARD chống tái diễn CRITICAL-1 (deep-audit 1/9, LEAD repro xác nhận lệch 1,2 tỷ/ngày): lọc kỳ tạm ứng/hoàn PHẢI
// dùng raw SQL `::timestamptz` — KHÔNG dùng Prisma `{gte/lt: Date}` (adapter-pg serialize Date bound KHÔNG kèm TZ →
// Postgres đọc theo session TZ +7 → lệch 7h → GD tối rơi sai ngày → settlement.tamUng lệch detail.daNhan).
// Fake in-memory DB KHÔNG tái hiện bug adapter (R198 "test PASS ≠ check chạy trên engine thật") → dùng guard đọc SOURCE.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(HERE, '..', 'src', 'investor-advance.ts'), 'utf8');

describe('investor-advance TZ guard — lọc kỳ raw ::timestamptz, cấm Prisma {gte,lt: Date}', () => {
  it('CÓ dùng raw ::timestamptz cho advance_date (đúng cửa sổ TZ HCM)', () => {
    expect(src).toMatch(/advance_date >= \$[^\s]*::timestamptz/);
    expect(src).toMatch(/advance_date < \$[^\s]*::timestamptz/);
  });
  it('CẤM Prisma window {gte/lt: Date} cho advanceDate (mầm bug lệch 7h)', () => {
    // KHÔNG được gán where.advanceDate = range (Prisma Date bound) — đó là cách CŨ gây lệch.
    expect(src).not.toMatch(/where\.advanceDate\s*=\s*range/);
    expect(src).not.toMatch(/advanceDate:\s*\{\s*gte/);
  });
});
