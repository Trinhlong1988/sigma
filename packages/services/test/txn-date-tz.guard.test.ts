// [GÓI TZ 11/9 — RÀO CHỐNG TÁI NHIỄM] txn_date trong DB là INSTANT THẬT (đường ghi raw-ISO + data đã chuẩn hoá).
// Adapter Prisma vẫn bệnh (ghi −7h / đọc +7h) → 2 pattern sau trên txn_date là BUG NGỦ, cấm mọc lại ở lớp LIVE
// (packages/services + apps/bot-api + apps/quanly-api):
//   (1) Prisma BOUND: `txnDate: { gte: ...}` / `where.txnDate =` / `where['txnDate']` → phải qua idsTheoTxnDate.
//   (2) ORM-READ làm giá trị: `txnDate as Date` / `.txnDate.toISOString()` TRẦN (không phải fallback `??` sau
//       txnIsoMap, không phải đường ghi raw `$executeRawUnsafe`).
// desktop/src/main (local-mode, KHÔNG phải lớp live API-mode — R201) chưa quét; kích hoạt lại local-mode phải sửa
// dashboard-service/tid-service/transaction-service trước.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const DIRS = ['packages/services/src', 'apps/bot-api/src', 'apps/quanly-api/src'];

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) tsFiles(p, acc);
    else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) acc.push(p);
  }
  return acc;
}

describe('txn-date TZ guard — cấm pattern bẩn mọc lại trên lớp live', () => {
  const files = DIRS.flatMap((d) => { try { return tsFiles(join(ROOT, d)); } catch { return []; } });
  it('quét được nguồn (chống guard câm — R198)', () => { expect(files.length).toBeGreaterThan(30); });

  it('(1) không còn Prisma-bound trên txnDate', () => {
    const viPham: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        if (line.trimStart().startsWith('//')) return; // dòng comment nhắc bẫy cũ — không phải code
        // type-decl `txnDate: { gte?:` hợp lệ (dấu ?); bound thật là `gte:` không dấu hỏi.
        if (/txnDate:\s*\{\s*gte:/.test(line) || /where\.txnDate\s*=/.test(line) || /where\[['"]txnDate['"]\]/.test(line)) {
          viPham.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
        }
      });
    }
    expect(viPham, viPham.join('\n')).toEqual([]);
  });

  it('(2) không còn ORM-read trần trên txnDate (chỉ cho fallback `??` sau iso-map hoặc đường ghi raw)', () => {
    const viPham: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      src.split('\n').forEach((line, i) => {
        const coPattern = /txnDate as Date/.test(line) || /\.txnDate\.toISOString\(\)/.test(line);
        if (!coPattern) return;
        const hopLe = line.includes('??') /* fallback sau txnIsoMap (fake-db test không có raw) */
          || line.includes('$executeRawUnsafe') /* đường ghi raw-ISO */
          || line.includes('input.txnDate.toISOString'); /* ghi từ input Date thật */
        if (!hopLe) viPham.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(viPham, viPham.join('\n')).toEqual([]);
  });
});
