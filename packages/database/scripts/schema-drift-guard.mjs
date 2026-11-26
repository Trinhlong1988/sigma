// SCHEMA-DRIFT-GUARD (deep-audit 1/9 — Agent-3: migration comment nhắc "schema-drift-guard" mà repo CHƯA có).
// Bắt lớp lỗi "cột khai trong schema.prisma nhưng THIẾU trong DB" (raw-ALTER quên/ migration chưa chạy). Đọc
// schema.prisma → mọi model @@map(table) + field→cột (@map else tên field, bỏ field quan hệ) → so information_schema.
// Dùng: DATABASE_URL=... node packages/database/scripts/schema-drift-guard.mjs   (exit 1 nếu có drift).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import pg from 'pg';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = readFileSync(path.join(HERE, '..', 'prisma', 'schema.prisma'), 'utf8');
const DB_URL = process.env.DATABASE_URL;
if (!DB_URL) { console.error('[drift-guard] THIẾU DATABASE_URL env.'); process.exit(2); }

// 1) Gom tên MODEL (để phân biệt field-cột vs field-quan-hệ) + tên ENUM (enum = cột).
const modelNames = new Set([...SCHEMA.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]));
const enumNames = new Set([...SCHEMA.matchAll(/^enum\s+(\w+)\s*\{/gm)].map((m) => m[1]));

// 2) Với mỗi model có @@map, trích [cột] khai báo.
const blocks = [...SCHEMA.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
const tables = []; // { model, table, cols:Set }
for (const [, model, body] of blocks) {
  const mapM = /@@map\("([^"]+)"\)/.exec(body);
  if (!mapM) continue; // model không map bảng (hiếm) → bỏ
  const table = mapM[1];
  const cols = new Set();
  for (const line of body.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('@@')) continue;
    const fm = /^(\w+)\s+([A-Za-z0-9_]+)(\[\])?(\?)?/.exec(t);
    if (!fm) continue;
    const [, field, typeName, isArray] = fm;
    // Field QUAN HỆ (type là 1 model) → KHÔNG phải cột. Field cột = scalar/enum, HOẶC có @map (an toàn).
    const mapColM = /@map\("([^"]+)"\)/.exec(t);
    if (modelNames.has(typeName) && !mapColM) continue; // quan hệ, bỏ (array model hoặc object model không @map)
    if (isArray) continue; // list quan hệ
    cols.add(mapColM ? mapColM[1] : field);
  }
  tables.push({ model, table, cols });
}

// 3) So với DB.
const client = new pg.Client({ connectionString: DB_URL });
await client.connect();
let drift = 0;
for (const { model, table, cols } of tables) {
  const r = await client.query('SELECT column_name FROM information_schema.columns WHERE table_name=$1', [table]);
  const dbCols = new Set(r.rows.map((x) => x.column_name));
  if (dbCols.size === 0) { console.error(`[drift] BẢNG THIẾU: ${table} (model ${model}) không có trong DB.`); drift++; continue; }
  for (const c of cols) {
    if (!dbCols.has(c)) { console.error(`[drift] CỘT THIẾU: ${table}.${c} (model ${model}) khai trong schema nhưng KHÔNG có trong DB.`); drift++; }
  }
}
await client.end();
if (drift > 0) { console.error(`\n❌ schema-drift-guard: ${drift} lệch (cột/bảng schema thiếu trong DB). Chạy migration.`); process.exit(1); }
console.log(`✅ schema-drift-guard: ${tables.length} bảng khớp schema↔DB, không drift.`);
