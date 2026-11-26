// CỔNG QA ĐỐI SOÁT DOANH SỐ 1 NGÀY (Admin Demo 27/8 "QA đâu, chống sai tái diễn").
// Chạy: node scripts/reconcile-day.mjs <investorId> <YYYY-MM-DD>
// Quét ĐỦ nhóm đại lý (customer_chat_groups.zalo_group_id — KHÔNG hardcode) → vision (CACHE, không đốt quota nếu
// đã đọc) → gộp lô (aggregateLotRevenue) → so DB → in CỜ ĐỎ (TID mất hẳn) / VÀNG (lệch) + gate ok.
// Chỉ ĐỌC. KHÔNG ghi DB. Ảnh OCR thất bại → đếm vào failedImages (ok=false, không tin số).
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { fileToPng } from '../src/image-normalize.mjs';
import { readBillVision, ocrCacheFlush } from '../src/vision-ocr.mjs';
import { aggregateLotRevenue, normalizeTid } from '../../../packages/services/src/lot-revenue.ts';
import { reconcileDayRevenue as reconcile } from '../../../packages/services/src/revenue-reconcile.ts';

const __dir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dir, '..', '..', 'bot-api', '.env') });

const investorId = Number(process.argv[2]);
const dayStr = process.argv[3]; // YYYY-MM-DD
if (!Number.isInteger(investorId) || !/^\d{4}-\d{2}-\d{2}$/.test(dayStr || '')) {
  console.error('Dùng: node scripts/reconcile-day.mjs <investorId> <YYYY-MM-DD>');
  process.exit(2);
}
const RES = process.env.ZALO_MEDIA_RESOURCE || '<REPO>/AppData/Roaming/ZaloData/media/698874761290101038/ZaloDownloads/resource';
const POOL = Number(process.env.RECONCILE_POOL || 5);
const SINCE = new Date(`${dayStr}T00:00:00`);
const UNTIL = new Date(SINCE.getTime() + 24 * 3600 * 1000);

const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
// TID của NĐT + doanh số DB trong ngày (gross, POSTED)
const tidRows = (await c.query(`SELECT td.tid FROM tids td JOIN receive_accounts ra ON ra.id=td.receive_account_id AND ra.investor_id=$1 AND ra.deleted_at IS NULL`, [investorId])).rows;
const tset = new Set(tidRows.map((r) => String(r.tid).trim()));
if (tset.size === 0) { console.error(`NĐT #${investorId} không có TID nào.`); process.exit(1); }
const dbRows = (await c.query(
  `SELECT td.tid, COUNT(*)::int n, COALESCE(SUM(t.amount),0)::bigint s FROM transactions t
   JOIN tids td ON td.id=t.tid_id JOIN receive_accounts ra ON ra.id=td.receive_account_id AND ra.investor_id=$1
   WHERE t.status='POSTED' AND t.deleted_at IS NULL AND t.txn_date>=$2::timestamptz AND t.txn_date<$3::timestamptz
   GROUP BY td.tid`,
  [investorId, SINCE.toISOString(), UNTIL.toISOString()]
)).rows;
const db = dbRows.map((r) => ({ tid: String(r.tid).trim(), amount: Number(r.s), count: r.n }));
// ĐỦ nhóm đại lý đã dán (KHÔNG hardcode — fix lỗi quét sót nhóm)
const groups = (await c.query(`SELECT DISTINCT zalo_group_id FROM customer_chat_groups WHERE zalo_group_id IS NOT NULL AND unassigned_at IS NULL`)).rows.map((r) => r.zalo_group_id);
await c.end();

// gom ảnh trong ngày
const files = [];
for (const g of groups) {
  const pic = path.join(RES, g, 'picture');
  if (!fs.existsSync(pic)) continue;
  for (const f of fs.readdirSync(pic)) {
    if (!/\.(jxl|jpg|jpeg|png)$/i.test(f)) continue;
    const p = path.join(pic, f);
    let t; try { t = fs.statSync(p).mtime; } catch { continue; }
    if (t >= SINCE && t < UNTIL) files.push(p);
  }
}
console.log(`NĐT #${investorId} ngày ${dayStr}: ${tset.size} TID · ${groups.length} nhóm · ${files.length} ảnh. Đang đọc (cache)...`);

const bills = [];
let failedImages = 0, done = 0;
async function worker(items) {
  for (const p of items) {
    let png; try { png = await fileToPng(p); } catch { done++; continue; }
    let r; try { r = await readBillVision(png); } catch { failedImages++; done++; continue; }
    if (r.failed) failedImages++;
    for (const b of (r.bills || [])) {
      const tid = normalizeTid(b.tid);
      if (!tset.has(tid)) continue;
      bills.push({ tid, batchNumber: b.batchNumber, type: b.type, totalAmount: b.totalAmount, dateTime: b.dateTime });
    }
    done++;
    if (done % 50 === 0) ocrCacheFlush();
  }
}
const chunks = Array.from({ length: POOL }, () => []);
files.forEach((f, i) => chunks[i % POOL].push(f));
await Promise.all(chunks.map(worker));
ocrCacheFlush();

const agg = aggregateLotRevenue(bills);
const report = reconcile(agg.lots, db, { failedImages });

console.log(`\n=== ĐỐI SOÁT NĐT #${investorId} — ${dayStr} ===`);
console.log(`Vision (bill): ${agg.lots.length} lô / ${fmtTr(report.visionTotal)}  ·  DB: ${fmtTr(report.dbTotal)}  ·  khớp ${(report.matchRatio * 100).toFixed(1)}%`);
console.log(`Lô cần đọc lại (settlement lệch): ${report.recheckLots} · Lô thiếu kết toán: ${report.lotsWithoutSettlement} · Ảnh OCR thất bại: ${report.failedImages}`);
if (report.flags.length === 0) console.log('KHÔNG có cờ — khớp trong ngưỡng.');
else {
  console.log(`\nCỜ (${report.flags.filter((f) => f.severity === 'red').length} đỏ, ${report.flags.filter((f) => f.severity === 'yellow').length} vàng):`);
  for (const f of report.flags) console.log(`  ${f.severity === 'red' ? '🔴' : '🟡'} ${f.message}`);
}
console.log(`\nGATE ok = ${report.ok ? '✅ XANH (không cờ đỏ, không ảnh lỗi)' : '❌ ĐỎ — số CHƯA đáng tin, kiểm cờ trên'}`);
process.exit(0);

function fmtTr(n) { return (n / 1e6).toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + 'tr'; }
