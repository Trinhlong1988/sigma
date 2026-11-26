// Guard cho shared fake-db factory. Hai bảo đảm:
//  1) MODELS khớp CHÍNH XÁC danh sách model trong schema.prisma (thiếu 1 model = class bug "service thêm
//     join → test 500"). Nếu schema thêm/bớt model mà quên cập nhật MODELS → test này ĐỎ (không lặng lẽ lệch).
//  2) makeFakeDb() stub SẴN mọi model + deep-merge override giữ nguyên method không đề cập.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { MODELS, makeFakeDb } from './_fake-db.js';

const here = dirname(fileURLToPath(import.meta.url));
const SCHEMA = resolve(here, '../../../packages/database/prisma/schema.prisma');

function schemaModelKeys(): string[] {
  const src = readFileSync(SCHEMA, 'utf8');
  const names = [...src.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]!);
  return names.map((n) => n.charAt(0).toLowerCase() + n.slice(1)).sort();
}

describe('_fake-db factory', () => {
  it('MODELS khớp CHÍNH XÁC schema.prisma (thiếu model = class bug)', () => {
    const fromSchema = schemaModelKeys();
    const declared: string[] = [...MODELS].sort();
    // Sai lệch 2 chiều để thấy rõ model nào thiếu / thừa.
    const missing = fromSchema.filter((m) => !declared.includes(m));
    const extra = declared.filter((m) => !fromSchema.includes(m));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('stub SẴN mọi model với findMany/findFirst/count/... an toàn', async () => {
    const db = makeFakeDb() as unknown as Record<string, Record<string, () => Promise<unknown>>>;
    for (const m of MODELS) {
      expect(await db[m]!['findMany']!()).toEqual([]);
      expect(await db[m]!['findFirst']!()).toBeNull();
      expect(await db[m]!['findUnique']!()).toBeNull();
      expect(await db[m]!['count']!()).toBe(0);
      expect(await db[m]!['deleteMany']!()).toEqual({ count: 0 });
    }
  });

  it('override deep-merge THEO MODEL: giữ method không đề cập', async () => {
    const seeded = [{ id: 9 }];
    const db = makeFakeDb({ customer: { findMany: async () => seeded } }) as unknown as Record<string, Record<string, () => Promise<unknown>>>;
    // Method override thắng...
    expect(await db['customer']!['findMany']!()).toBe(seeded);
    // ...method KHÔNG đề cập vẫn còn stub mặc định (điểm chặn bug: service gọi count sau này không undefined).
    expect(await db['customer']!['count']!()).toBe(0);
    expect(await db['customer']!['findUnique']!()).toBeNull();
    // Model khác hoàn toàn vẫn stub.
    expect(await db['tidSellFee']!['findMany']!()).toEqual([]);
  });

  it('$transaction(fn) chạy fn với chính db giả (thấy override bên trong tx)', async () => {
    const db = makeFakeDb({ transaction: { findMany: async () => [{ id: 1 }] } }) as unknown as {
      $transaction: (fn: (tx: Record<string, Record<string, () => Promise<unknown>>>) => Promise<unknown>) => Promise<unknown>;
    };
    const out = await db.$transaction(async (tx) => tx['transaction']!['findMany']!());
    expect(out).toEqual([{ id: 1 }]);
  });
});
