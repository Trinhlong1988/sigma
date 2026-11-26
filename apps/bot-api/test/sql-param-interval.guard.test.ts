// [Admin Demo 11/9 — bill "Nhân viên B hoàn ứng Khach Demo A" 499.999.000 báo "xảy ra lỗi hệ thống"] GỐC: raw SQL
// viết `$3 - interval '2 min'` mà KHÔNG ép kiểu → Postgres suy tham số thành INTERVAL → so `timestamptz >= interval`
// → ném lỗi → route 500. Chỉ nổ ở nhánh hiếm (bill không đọc được số GD) nên lọt mọi test.
//
// GUARD: quét toàn bộ raw SQL trong bot-api — hễ có `$N ± interval` mà thiếu `::timestamptz`/`::date` là ĐỎ.
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const GOC = path.resolve(__dirname, '..', 'src');

function moiFileTs(dir: string): string[] {
  return readdirSync(dir).flatMap((ten) => {
    const p = path.join(dir, ten);
    if (statSync(p).isDirectory()) return moiFileTs(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

describe('raw SQL: tham số cạnh interval PHẢI ép kiểu', () => {
  it('không file nào còn `$N ± interval` thiếu ::timestamptz/::date', () => {
    const xau: string[] = [];
    for (const f of moiFileTs(GOC)) {
      const noiDung = readFileSync(f, 'utf8').split('\n');
      noiDung.forEach((dong, i) => {
        const t = dong.trim();
        if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return; // dòng GHI CHÚ (được phép trích lại mẫu sai)
        // bắt: $3 - interval  |  $3 + interval   (không có ::kiểu ngay sau $N)
        if (/\$\d+\s*[-+]\s*interval\s/i.test(dong) && !/\$\d+::(timestamptz|timestamp|date)\s*[-+]\s*interval/i.test(dong)) {
          xau.push(`${path.relative(GOC, f)}:${i + 1} → ${dong.trim().slice(0, 120)}`);
        }
      });
    }
    expect(xau, `Thiếu ép kiểu (Postgres sẽ suy tham số thành INTERVAL rồi ném lỗi):\n${xau.join('\n')}`).toEqual([]);
  });
});
