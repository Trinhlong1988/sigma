// [B-M1 21/9] GUARD wiring: createAdvance (MANUAL) PHẢI ghi advance_date bằng raw ::timestamptz trong cùng tx —
// Prisma driver-adapter ghi timestamptz lệch −7h (bản đồ TZ 11/9); mất dòng raw này là dòng MANUAL có giờ lưu sai.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

describe('createAdvance MANUAL — raw ::timestamptz trong tx', () => {
  const SRC = readFileSync(path.resolve(__dirname, '../src/investor-advance.ts'), 'utf8');
  it('có raw UPDATE advance_date ::timestamptz ngay sau create (cùng $transaction)', () => {
    expect(SRC).toMatch(/UPDATE investor_advances SET advance_date = \$1::timestamptz WHERE id = \$2/);
    const iTx = SRC.indexOf('const created = await db.$transaction');
    const iRaw = SRC.indexOf('UPDATE investor_advances SET advance_date');
    const iAudit = SRC.indexOf("action: 'INVESTOR_ADVANCE_CREATED'");
    expect(iTx).toBeGreaterThan(-1);
    expect(iRaw).toBeGreaterThan(iTx);      // nằm trong tx
    expect(iAudit).toBeGreaterThan(iRaw);   // trước audit → cùng tx, không có cửa sổ đọc lệch
  });
});
