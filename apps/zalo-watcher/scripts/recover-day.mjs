// ================================================================================================
// ⛔ KHOÁ AN TOÀN (LEAD 11/9 — nợ C2): script recovery MỘT LẦN, KHÔNG idempotent (re-run sẽ CANCEL cả
// GD tốt + cancelled Lô giữ billKey → UNIQUE chặn tạo lại → MẤT DATA — đã xảy ra 26/8, phải cứu bằng
// restore-trung-2608). Luồng gốc (watcher Zalo) đã TẮT HẲN theo chỉ đạo Admin Demo 11/9 → script này chỉ
// còn giá trị lịch sử. Muốn chạy THẬT phải hiểu rủi ro + sửa idempotency trước, rồi thêm cờ bên dưới.
if (!process.argv.includes('--toi-da-vaidx-idempotency-va-chiu-trach-nhiem')) {
  console.error('⛔ Script recovery cũ KHÔNG idempotent — đã KHOÁ (xem comment đầu file). Thoát.');
  process.exit(1);
}
// ================================================================================================
// RECOVERY DOANH SỐ 1 NGÀY (Admin Demo 28/8 "ghi, phải kiểm chứng") — huỷ GD sys sai + ghi lại theo LÔ (đúng, đã
// verify khớp bảng tay). CÓ VERIFY TRƯỚC (dry-run qua recordVisionLots thật) + SAU (đọc lại DB). Soft-delete giữ vết.
// Chạy: node scripts/recover-day.mjs <investorId> <YYYY-MM-DD> [--write]   (không --write = chỉ dry-run, KHÔNG ghi)
import fs from 'node:fs'; import path from 'node:path';
import dotenv from 'dotenv'; import { fileURLToPath } from 'node:url';
import { fileToPng } from '../src/image-normalize.mjs';
import { ocrCacheGet } from '../src/vision-ocr.mjs';
import { getBotDb } from '../../bot-api/src/db.ts';
import { recordVisionLots } from '../../bot-api/src/zalo-bill-ingest.ts';
import { aggregateLotRevenue, normalizeTid } from '../../../packages/services/src/lot-revenue.ts';
const __dir = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dir, '..', '..', 'bot-api', '.env') });

const investorId = Number(process.argv[2]);
const dayStr = process.argv[3];
const WRITE = process.argv.includes('--write');
if (!Number.isInteger(investorId) || !/^\d{4}-\d{2}-\d{2}$/.test(dayStr || '')) { console.error('Dùng: recover-day.mjs <investorId> <YYYY-MM-DD> [--write]'); process.exit(2); }
const RES = process.env.ZALO_MEDIA_RESOURCE || '<REPO>/AppData/Roaming/ZaloData/media/698874761290101038/ZaloDownloads/resource';
const SINCE = new Date(`${dayStr}T00:00:00`), UNTIL = new Date(SINCE.getTime() + 864e5);
// Cửa sổ ẢNH RỘNG (Admin Demo 28/8: bill kết toán tối có thể chụp/post sang hôm sau) — quét [ngày-1 .. ngày+2] mtime,
// nhưng CHỈ tính bill có GIỜ KẾT TOÁN = đúng dayStr (settlement in ngày rõ). Bắt bill post-muộn, không tính nhầm ngày.
// Cửa sổ ảnh: mặc định ngày+1 (nhanh, ổn). --wide = ngày+2 (bắt bill post-muộn, chậm hơn). NĐT không post muộn → dùng mặc định.
const WIDE = process.argv.includes('--wide');
const IMG_SINCE = SINCE, IMG_UNTIL = new Date(SINCE.getTime() + (WIDE ? 2 : 1) * 864e5);
const [yy, mm, dd] = dayStr.split('-');
const BILL_DATE = `${dd}/${mm}/${yy}`; // "dd/mm/yyyy" để khớp dateTime bill

const db = getBotDb();
// TID + hkd_name của NĐT + map hkd_name→TID (dự phòng khi TID in MỜ). Bill ở nhóm ĐẠI LÝ (đầy đủ, Admin Demo chốt).
const tidRows = await db.$queryRawUnsafe(`SELECT td.tid, td.hkd_name FROM tids td JOIN receive_accounts ra ON ra.id=td.receive_account_id AND ra.investor_id=$1 AND ra.deleted_at IS NULL`, investorId);
const tset = new Set(tidRows.map((r) => String(r.tid).trim()));
// TẤT CẢ TID hợp lệ trong hệ thống (mọi NĐT) — để phân biệt "TID đọc rõ của NĐT KHÁC" (bỏ, KHÔNG ép agency) với
// "TID misread/rỗng" (mới agency-resolve). FIX bug: "KHACH HANG 62 3" (DEMO-TID-07, A Thông) từng bị ép sang KHACH HANG 61 3.
const allTidRows = await db.$queryRawUnsafe(`SELECT DISTINCT td.tid FROM tids td WHERE td.deleted_at IS NULL`);
const allTidSet = new Set(allTidRows.map((r) => String(r.tid).trim()));
const grpRows = await db.$queryRawUnsafe(`SELECT DISTINCT zalo_group_id FROM customer_chat_groups WHERE zalo_group_id IS NOT NULL AND unassigned_at IS NULL`);
const groups = grpRows.map((r) => r.zalo_group_id);
// map hkd_name → tid (chuẩn hoá bỏ dấu; số cuối tên PHẢI khớp — phân biệt "KHACH HANG 61 2/3")
const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const abase = (s) => strip(s).replace(/\d+\s*$/, '').replace(/[^a-z]/g, '');
const anum = (s) => { const m = strip(s).match(/(\d+)\s*$/); return m ? m[1] : ''; };
function lev(a, b) { const m = a.length, n = b.length; const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]); for (let j = 0; j <= n; j++) d[0][j] = j; for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[m][n]; }
const hkmap = tidRows.filter((r) => r.hkd_name).map((r) => ({ tid: String(r.tid).trim(), abase: abase(r.hkd_name), anum: anum(r.hkd_name) }));
function resolveAgency(name) { const qb = abase(name), qn = anum(name); if (!qb) return null; let best = null, bd = 99; for (const h of hkmap) { if (h.anum !== qn) continue; const d = lev(qb, h.abase); if (d < bd) { bd = d; best = h.tid; } } return bd <= 3 ? best : null; }

// ── VERIFY TRƯỚC: GD SAI hiện tại (sẽ huỷ) — CHỈ GD CŨ (KHÔNG phải VL recovery). IDEMPOTENT: re-run KHÔNG huỷ GD
// VL đã ghi đúng (fix bug 29/8 làm hỏng Trung: re-run cancel cả GD tốt). GD cũ = Lo billKey không bắt đầu 'VL|'.
const cur = await db.$queryRawUnsafe(`SELECT t.id, t.amount FROM transactions t JOIN tids td ON td.id=t.tid_id JOIN receive_accounts ra ON ra.id=td.receive_account_id AND ra.investor_id=$1
  LEFT JOIN los l ON l.transaction_id=t.id
  WHERE t.status='POSTED' AND t.deleted_at IS NULL AND t.txn_date>=$2::timestamptz AND t.txn_date<$3::timestamptz
    AND (l.bill_key IS NULL OR l.bill_key NOT LIKE 'VL|%')`, investorId, SINCE.toISOString(), UNTIL.toISOString());
const oldIds = cur.map((r) => Number(r.id));
const oldTot = cur.reduce((s, r) => s + Number(r.amount), 0);
console.log(`[TRƯỚC] DB có ${oldIds.length} GD sys = ${(oldTot/1e6).toFixed(1)}tr (sẽ huỷ).`);

// LOGIC ĐÚNG (Admin Demo 28/8 "xem lại logic"): đơn vị doanh số = bill KẾT TOÁN (mỗi lô 1 lần, = cách SigMa đọc
// từng tờ). Nguồn = nhóm ĐẠI LÝ (đầy đủ). TID mờ → tên đại lý. Ngày = GIỜ KẾT TOÁN in trên bill (không theo giờ
// chụp). Lô chỉ-có-sale (kết toán chưa đọc được) → cộng sale CÓ số lô (fallback). Bill không gán được TID → CỜ.
const lotMap = new Map(); // tid|lô -> {settle, sales:Map, dt}
let flagged = 0;
// Gom path ảnh trong cửa sổ RỘNG (bắt bill post-muộn) rồi xử SONG SONG (fileToPng nặng → đơn-luồng quá chậm).
const imgPaths = [];
for (const g of groups) {
  const pic = path.join(RES, g, 'picture'); if (!fs.existsSync(pic)) continue;
  for (const f of fs.readdirSync(pic)) {
    if (!/\.(jxl|jpg|jpeg|png)$/i.test(f)) continue;
    const p = path.join(pic, f); let t; try { t = fs.statSync(p).mtime; } catch { continue; }
    if (t >= IMG_SINCE && t < IMG_UNTIL) imgPaths.push(p);
  }
}
console.log(`[thu-thập] ${imgPaths.length} ảnh (cửa sổ rộng), đọc cache song song...`);
let scanned = 0;
const rawBills = []; // {tidRaw, agency, lo, type, amt, dt} — thu thập trước, phân giải TID sau (2 pha)
async function scanWorker(items) {
  for (const p of items) {
    let png; try { png = await fileToPng(p); } catch { scanned++; continue; }
    const r = ocrCacheGet('bill', png);
    scanned++; if (scanned % 200 === 0) console.log(`   ...${scanned}/${imgPaths.length}`);
    if (r === undefined || !r.bills) continue;
    for (const b of r.bills) {
      if (b.dateTime && b.dateTime.length >= 10 && b.dateTime.slice(0, 10) !== BILL_DATE) continue; // loại bill ngày khác
      const lo = String(b.batchNumber || ''); if (!lo || lo === '0') continue;
      rawBills.push({ tidRaw: normalizeTid(b.tid), agency: b.agencyName || null, lo, type: b.type, amt: b.totalAmount, dt: b.dateTime });
    }
  }
}
const SPOOL = 3; const schunks = Array.from({ length: SPOOL }, () => []); imgPaths.forEach((f, i) => schunks[i % SPOOL].push(f));
await Promise.all(schunks.map(scanWorker));
// PHA 2: HỌC (tênHKD-base | lô) → tid TỪ bill đọc-RÕ-TID-hợp-lệ (anchor). Dùng phân biệt 2 máy cùng tên khác số lô
// (vd KHACH HANG 61 3=lô18-27 vs KHACH HANG 61 2=lô82-88): bill mờ cùng lô lấy theo anchor, KHÔNG lệ thuộc số-cuối-tên OCR nhầm.
const lotAnchor = new Map();
for (const b of rawBills) {
  if (allTidSet.has(b.tidRaw) && b.agency && tset.has(b.tidRaw)) lotAnchor.set(`${abase(b.agency)}|${b.lo}`, b.tidRaw);
}
for (const b of rawBills) {
  let tid = b.tidRaw;
  if (!allTidSet.has(tid)) { // TID rỗng/misread → anchor đúng-lô TRƯỚC, rồi agency-số
    const anc = b.agency ? lotAnchor.get(`${abase(b.agency)}|${b.lo}`) : null;
    if (anc) tid = anc; else if (b.agency) { const rt = resolveAgency(b.agency); if (rt) tid = rt; }
  }
  if (!tset.has(tid)) { if (b.type === 'SETTLEMENT' && b.agency && !allTidSet.has(b.tidRaw)) flagged++; continue; }
  const k = `${tid}|${b.lo}`; const e = lotMap.get(k) || { tid, batchNumber: b.lo, settle: 0, sales: new Map(), dt: b.dt };
  if (b.type === 'SETTLEMENT') e.settle = Math.max(e.settle, b.amt);
  else e.sales.set(b.amt, 1);
  lotMap.set(k, e);
}
// mỗi lô: settlement nếu có, else tổng sale (fallback). --settlement-only = CHỈ lô có kết toán (bỏ sale → chống lô-ma
// do batch đọc sai; dùng khi bill đầy đủ kết toán, vd data Haiku đọc tên-HKD tốt nhưng batch nhỏ hay sai).
const SETTLE_ONLY = process.argv.includes('--settlement-only');
const lotBills = [];
for (const e of lotMap.values()) {
  if (SETTLE_ONLY && e.settle <= 0) continue;
  const amt = e.settle > 0 ? e.settle : [...e.sales.keys()].reduce((s, a) => s + a, 0);
  if (amt > 0) lotBills.push({ tid: e.tid, batchNumber: e.batchNumber, type: 'SETTLEMENT', totalAmount: amt, dateTime: e.dt });
}
const dryTotal = lotBills.reduce((s, l) => s + l.totalAmount, 0);
console.log(`[VERIFY] ${lotBills.length} lô kết toán = ${(dryTotal/1e6).toFixed(1)}tr sẽ tạo. Bill kết-toán KHÔNG gán được TID (cờ): ${flagged}.`);
const perTid = {}; for (const l of lotBills) perTid[l.tid] = (perTid[l.tid] || 0) + l.totalAmount;
console.log('[VERIFY per-TID]'); for (const tid of Object.keys(perTid).sort()) console.log(`   ${tid}: ${(perTid[tid]/1e6).toFixed(1)}tr`);

if (!WRITE) { console.log('\n*** DRY-RUN (không --write) — CHƯA GHI GÌ. Thêm --write để thực thi. ***'); process.exit(0); }

// ── GHI THẬT ───────────────────────────────────────────────────────────────────
console.log('\n[GHI] Huỷ GD sys cũ (soft-delete) + Lô liên quan...');
if (oldIds.length) {
  await db.transaction.updateMany({ where: { id: { in: oldIds } }, data: { deletedAt: new Date(), status: 'CANCELLED', cancelReason: `Recovery ${dayStr}: thay bằng ghi-theo-lô đúng (OCR Sonnet verify khớp bảng tay)`, cancelledAt: new Date() } });
  await db.lo.updateMany({ where: { transactionId: { in: oldIds } }, data: { status: 'CANCELLED', cancelReason: `Recovery ${dayStr}`, cancelledAt: new Date() } });
  await db.auditLog.create({ data: { actorUserId: null, action: 'SIGMA_REVENUE_RECOVERY_CANCEL', targetType: 'Transaction', targetId: oldIds.join(','), afterJson: JSON.stringify({ investorId, dayStr, cancelledIds: oldIds, oldTotal: oldTot }), ipAddress: 'recover-day', deviceInfo: 'apps/zalo-watcher/scripts' } });
}
console.log('[GHI] Tạo GD theo LÔ (mỗi nhóm ghi TID của mình, billKey idempotent)...');
let recorded = 0, created = 0;
const doneKeys = new Set();
for (const g of groups) {
  const res = await recordVisionLots(db, { zaloGroupId: g, bills: lotBills, dryRun: false, allowDuplicate: true, forceDay: dayStr });
  for (const l of res.lots) if (l.ok) { const k = `${l.tid}|${l.batchNumber}|${l.day}`; if (!doneKeys.has(k)) { doneKeys.add(k); recorded++; created += l.amount; } }
}
const skipped = lotBills.length - recorded;
await db.auditLog.create({ data: { actorUserId: null, action: 'SIGMA_REVENUE_RECOVERY_WRITE', targetType: 'Investor', targetId: String(investorId), afterJson: JSON.stringify({ investorId, dayStr, recorded, skipped, createdTotal: created }), ipAddress: 'recover-day', deviceInfo: 'apps/zalo-watcher/scripts' } });
console.log(`[GHI] recorded ${recorded} lô, skipped ${skipped}.`);

// ── VERIFY SAU ──────────────────────────────────────────────────────────────────
const after = await db.$queryRawUnsafe(`SELECT COUNT(*)::int n, COALESCE(SUM(t.amount),0)::bigint s FROM transactions t JOIN tids td ON td.id=t.tid_id JOIN receive_accounts ra ON ra.id=td.receive_account_id AND ra.investor_id=$1
  WHERE t.status='POSTED' AND t.deleted_at IS NULL AND t.txn_date>=$2::timestamptz AND t.txn_date<$3::timestamptz`, investorId, SINCE.toISOString(), UNTIL.toISOString());
console.log(`\n[SAU] DB giờ: ${after[0].n} GD POSTED = ${(Number(after[0].s)/1e6).toFixed(1)}tr (kỳ vọng ~${(dryTotal/1e6).toFixed(1)}tr).`);
console.log(Math.abs(Number(after[0].s)-dryTotal)<1e6 ? '✅ VERIFY SAU KHỚP.' : '⚠️ LỆCH — kiểm lại!');
process.exit(0);
