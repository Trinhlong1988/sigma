// [Admin Demo 8/9 — GUARD "đào sâu fix sạch", chống tái diễn +7h] GỐC: getRoomRevenueReport SELECT
// `COALESCE(bill_txn_date, created_at) AS "effDate"` (timestamptz thô) → driver-adapter Prisma đọc "16:40+07" thành
// Date 16:40**Z** (bỏ +07) → effDateIso lệch +7 → web hiện giờ +7 (16:47→23:47) VÀ ngày bill tối bị đẩy sang hôm sau.
// FIX SẠCH: trả effIso dưới dạng UTC ISO **TEXT** (AT TIME ZONE 'UTC' + to_char) → JS new Date() dựng đúng instant.
//
// Fake-db KHÔNG tái hiện được lỗi parse của adapter (R198) → guard này ĐỌC SOURCE, khẳng định query KHÔNG quay lại
// pattern trả timestamptz thô cho cột Giờ (đồng khuôn investor-advance-tz.guard).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'services', 'chat-room-tid-service.ts'), 'utf8');

describe('GUARD getRoomRevenueReport — giờ/ngày bill KHÔNG lệch +7 (Prisma timestamptz read)', () => {
  it('query trả effIso dạng UTC ISO TEXT (to_char AT TIME ZONE UTC), KHÔNG trả timestamptz Date thô', () => {
    // phải có to_char ... AT TIME ZONE 'UTC' ... AS "effIso"
    expect(src).toMatch(/to_char\(\s*COALESCE\([^)]*bill_txn_date[^)]*\)\s*AT TIME ZONE 'UTC'/);
    expect(src).toMatch(/AS "effIso"/);
    // CẤM quay lại trả Date thô cho cột Giờ (đây là gốc +7)
    expect(src).not.toMatch(/COALESCE\([^)]*bill_txn_date[^)]*\)\s+AS "effDate"/);
  });
  it('effDateIso lấy TRỰC TIẾP từ text UTC (không new Date(r.effDate).toISOString() trên Date Prisma)', () => {
    expect(src).not.toMatch(/new Date\(r\.effDate\)\.toISOString\(\)/);
    expect(src).toMatch(/effDateIso = r\.effIso/);
  });
});
