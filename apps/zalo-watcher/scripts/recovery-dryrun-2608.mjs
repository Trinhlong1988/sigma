// RECOVERY DRY-RUN 26/8 (Admin Demo 27/8) — đọc LẠI bill 26/8 bằng VISION (tách multi-bill + giờ thật), tính doanh số
// THU HỒI ĐƯỢC cho từng NĐT, so với DB hiện tại. KHÔNG GHI GÌ (chỉ đọc + tính). Chạy nền (vision ~15s/bill, pool 4).
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
dotenv.config({ path: '<REPO>/apps/bot-api/.env' }); // DATABASE_URL nằm ở bot-api/.env (watcher không có)
import { fileToPng } from '../src/image-normalize.mjs';
import { readBillVision } from '../src/vision-ocr.mjs';

const RES = '<REPO>/AppData/Roaming/ZaloData/media/698874761290101038/ZaloDownloads/resource';
const GROUPS = ['gDEMOGROUP0000000008', 'gDEMOGROUP0000000007', 'gDEMOGROUP0000000005', 'gDEMOGROUP0000000004', 'gDEMOGROUP0000000010', 'gDEMOGROUP0000000002'];
const SINCE = new Date('2026-08-26T00:00:00'), UNTIL = new Date('2026-08-27T00:00:00');
const POOL = 4;

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
// map tid(string) → {investorId, name}
const tmap = new Map();
const tr = await c.query(`SELECT td.tid, ra.investor_id, COALESCE(i.nickname,i.full_name) nm FROM tids td
  JOIN receive_accounts ra ON ra.id=td.receive_account_id AND ra.deleted_at IS NULL
  JOIN investors i ON i.id=ra.investor_id WHERE ra.investor_id IS NOT NULL`);
for (const r of tr.rows) tmap.set(String(r.tid).trim(), { investorId: r.investor_id, name: r.nm });
// DB hiện tại 26/8 theo NĐT
const cur = await c.query(`SELECT ra.investor_id, COUNT(*) n, COALESCE(SUM(t.amount),0) s FROM transactions t
  JOIN tids td ON td.id=t.tid_id JOIN receive_accounts ra ON ra.id=td.receive_account_id AND ra.investor_id IS NOT NULL
  WHERE t.status='POSTED' AND t.deleted_at IS NULL AND t.txn_date>='2026-08-26' AND t.txn_date<'2026-08-27' GROUP BY ra.investor_id`);
await c.end();
console.log('=== DB HIỆN TẠI 26/8 (sai) ===');
for (const r of cur.rows) console.log(`  inv${r.investor_id}: ${r.n} bill, ${(Number(r.s) / 1e6).toFixed(1)}tr`);

// gom ảnh 26/8
const files = [];
for (const g of GROUPS) {
  const pic = path.join(RES, g, 'picture'); if (!fs.existsSync(pic)) continue;
  for (const f of fs.readdirSync(pic)) {
    if (!/\.(jxl|jpg|jpeg|png)$/i.test(f)) continue;
    const p = path.join(pic, f); const t = fs.statSync(p).mtime;
    if (t >= SINCE && t < UNTIL) files.push({ g, p, f });
  }
}
console.log(`\nVISION đọc lại ${files.length} ảnh 26/8 (pool ${POOL}, ~15s/ảnh)...`);

// aggregate: investorId → {n, sum, tids:Set}
const agg = new Map();
let done = 0, saleTotal = 0;
async function worker(items) {
  for (const x of items) {
    let png; try { png = await fileToPng(x.p); } catch { done++; continue; }
    let bills = []; try { ({ bills } = await readBillVision(png, { noCache: true })); } catch { done++; continue; }
    for (const b of bills) {
      if (b.type !== 'SALE' || !b.tid || !(b.totalAmount > 0)) continue;
      const m = tmap.get(String(b.tid).trim()); if (!m) continue; // chỉ TID nhà đầu tư
      saleTotal++;
      const a = agg.get(m.investorId) ?? { name: m.name, n: 0, sum: 0, tids: new Set() };
      a.n++; a.sum += b.totalAmount; a.tids.add(String(b.tid).trim()); agg.set(m.investorId, a);
    }
    done++;
    if (done % 25 === 0) console.log(`  ...${done}/${files.length} ảnh`);
  }
}
// chia đều cho POOL worker
const chunks = Array.from({ length: POOL }, () => []);
files.forEach((f, i) => chunks[i % POOL].push(f));
await Promise.all(chunks.map((ch) => worker(ch)));

console.log(`\n=== VISION THU HỒI ĐƯỢC 26/8 (dry-run, chưa ghi) — ${saleTotal} bill SALE thuộc NĐT ===`);
for (const [inv, a] of agg) console.log(`  inv${inv} ${a.name}: ${a.n} bill / ${(a.sum / 1e6).toFixed(1)}tr / ${a.tids.size} TID`);
console.log('\nSO SÁNH: DB hiện tại vs vision thu hồi — nếu vision >> DB thì recovery sẽ bù đúng.');
process.exit(0);
