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
// RECOVERY TRUNG (inv16) 26/8 LAI: 3 TID (53550079/53550081/59930001) OCR-đúng + 2 máy KHACH HANG 61 (59930002/DEMO-TID-08)
// lấy lô từ FILE BẢNG TAY (OCR không tách nổi 2 máy cùng tên, TID mờ — Admin Demo duyệt 29/8). Dry-run mặc định; --write ghi.
import fs from 'node:fs'; import path from 'node:path'; import dotenv from 'dotenv';
import { fileToPng } from '../src/image-normalize.mjs'; import { ocrCacheGet } from '../src/vision-ocr.mjs';
import { normalizeTid } from '../../../packages/services/src/lot-revenue.ts';
import { getBotDb } from '../../bot-api/src/db.ts'; import { recordVisionLots } from '../../bot-api/src/zalo-bill-ingest.ts';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ExcelJS = require('exceljs');
dotenv.config({ path: '<REPO>/apps/bot-api/.env' });
const WRITE = process.argv.includes('--write');
const INV = 16, DAY = '2026-08-26';
const RES='<REPO>/AppData/Roaming/ZaloData/media/698874761290101038/ZaloDownloads/resource';
const GROUPS_WIN_S=new Date('2026-08-26T00:00:00'), WIN_E=new Date('2026-08-27T00:00:00');
const OCR_TIDS = new Set(['53550079','53550081','59930001']);
const FILE_TIDS = { '59930002':'HKD DEMO 50', 'DEMO-TID-08':'HKD DEMO 49' };
const db = getBotDb();
const groups=(await db.$queryRawUnsafe(`SELECT DISTINCT zalo_group_id FROM customer_chat_groups WHERE zalo_group_id IS NOT NULL AND unassigned_at IS NULL`)).map(r=>r.zalo_group_id);
const allTid=new Set((await db.$queryRawUnsafe(`SELECT DISTINCT tid FROM tids WHERE deleted_at IS NULL`)).map(r=>String(r.tid).trim()));
// GD cũ (huỷ)
const cur=await db.$queryRawUnsafe(`SELECT t.id, t.amount FROM transactions t JOIN tids td ON td.id=t.tid_id JOIN receive_accounts ra ON ra.id=td.receive_account_id AND ra.investor_id=$1
  WHERE t.status='POSTED' AND t.deleted_at IS NULL AND t.txn_date>=$2::timestamptz AND t.txn_date<$3::timestamptz`, INV, GROUPS_WIN_S.toISOString(), WIN_E.toISOString());
const oldIds=cur.map(r=>Number(r.id)); console.log(`[TRƯỚC] ${oldIds.length} GD sys = ${(cur.reduce((s,r)=>s+Number(r.amount),0)/1e6).toFixed(1)}tr sẽ huỷ.`);
// ── OCR lots cho 3 TID ──
const lotMap=new Map();
for(const g of groups){const pic=path.join(RES,g,'picture'); if(!fs.existsSync(pic))continue;
  for(const f of fs.readdirSync(pic)){ if(!/\.(jxl|jpg|jpeg|png)$/i.test(f))continue; const p=path.join(pic,f); const t=fs.statSync(p).mtime; if(t<GROUPS_WIN_S||t>=WIN_E)continue;
    let png;try{png=await fileToPng(p);}catch{continue;} const r=ocrCacheGet('bill',png); if(r===undefined||!r.bills)continue;
    for(const b of r.bills){ if(b.type!=='SETTLEMENT')continue; const tid=normalizeTid(b.tid); if(!OCR_TIDS.has(tid))continue;
      const lo=String(b.batchNumber||''); if(!lo||lo==='0')continue; const k=`${tid}|${lo}`; lotMap.set(k, Math.max(lotMap.get(k)||0, b.totalAmount)); }}}
const lotBills=[]; for(const [k,amt] of lotMap){ const [tid,lo]=k.split('|'); if(amt>0)lotBills.push({tid,batchNumber:lo,type:'SETTLEMENT',totalAmount:amt,dateTime:`26/08/2026 12:00`}); }
console.log(`[OCR] 3 TID: ${lotBills.length} lô = ${(lotBills.reduce((s,l)=>s+l.totalAmount,0)/1e6).toFixed(1)}tr`);
// ── FILE lots cho 2 KHACH HANG 61 ──
const wb=new ExcelJS.Workbook(); await wb.xlsx.readFile('<REPO>/Desktop/test zalo/BaoCao_20260826_trung.xlsx');
const ws=wb.getWorksheet('BaoCaoPOS'); let fileTot=0;
for(let r=2;r<=ws.rowCount;r++){ const tid=String(ws.getRow(r).getCell(5).value??'').trim().replace(/-\d+$/,''); if(!FILE_TIDS[tid])continue;
  const lo=String(ws.getRow(r).getCell(6).value??''); const amt=Number(ws.getRow(r).getCell(7).value)||0; if(!lo||!amt)continue;
  lotBills.push({tid,batchNumber:lo,type:'SETTLEMENT',totalAmount:amt,dateTime:`26/08/2026 12:00`}); fileTot+=amt; }
console.log(`[FILE] 2 KHACH HANG 61: = ${(fileTot/1e6).toFixed(1)}tr`);
const perTid={}; for(const l of lotBills) perTid[l.tid]=(perTid[l.tid]||0)+l.totalAmount;
console.log('[VERIFY per-TID]'); for(const t of Object.keys(perTid).sort()) console.log(`   ${t}: ${(perTid[t]/1e6).toFixed(1)}tr`);
console.log(`[TỔNG] ${(lotBills.reduce((s,l)=>s+l.totalAmount,0)/1e6).toFixed(1)}tr (file 1613.2tr)`);
if(!WRITE){ console.log('\n*** DRY-RUN — chưa ghi. --write để thực thi. ***'); process.exit(0); }
// ── GHI ──
if(oldIds.length){ await db.transaction.updateMany({where:{id:{in:oldIds}},data:{deletedAt:new Date(),status:'CANCELLED',cancelReason:`Recovery ${DAY} lai (3 OCR + 2 file KHACH HANG 61)`,cancelledAt:new Date()}});
  await db.lo.updateMany({where:{transactionId:{in:oldIds}},data:{status:'CANCELLED',cancelReason:`Recovery ${DAY}`,cancelledAt:new Date()}});
  await db.auditLog.create({data:{actorUserId:null,action:'SIGMA_REVENUE_RECOVERY_CANCEL',targetType:'Transaction',targetId:oldIds.join(','),afterJson:JSON.stringify({inv:INV,day:DAY,ids:oldIds}),ipAddress:'recover-trung-hybrid',deviceInfo:'scripts'}}); }
let recorded=0; const doneK=new Set(); const reasons={};
for(const g of groups){ const res=await recordVisionLots(db,{zaloGroupId:g,bills:lotBills,dryRun:false,allowDuplicate:true,forceDay:DAY});
  for(const l of res.lots){ if(l.ok){ const k=`${l.tid}|${l.batchNumber}`; if(!doneK.has(k)){doneK.add(k);recorded++;} }
    else if(l.reason!=='TID_NOT_IN_ROOM'){ reasons[`${l.tid}:${l.reason}`]=(reasons[`${l.tid}:${l.reason}`]||0)+1; } } }
console.log('[LỖI ghi]:', Object.keys(reasons).length?JSON.stringify(reasons):'không (chỉ TID_NOT_IN_ROOM = khách khác nhóm)');
const after=await db.$queryRawUnsafe(`SELECT COUNT(*)::int n, COALESCE(SUM(t.amount),0)::bigint s FROM transactions t JOIN tids td ON td.id=t.tid_id JOIN receive_accounts ra ON ra.id=td.receive_account_id AND ra.investor_id=$1 WHERE t.status='POSTED' AND t.deleted_at IS NULL AND t.txn_date>=$2::timestamptz AND t.txn_date<$3::timestamptz`, INV, GROUPS_WIN_S.toISOString(), WIN_E.toISOString());
console.log(`[GHI] recorded ${recorded}. [SAU] ${after[0].n} GD = ${(Number(after[0].s)/1e6).toFixed(1)}tr (kỳ vọng 1613.2)`);
console.log(Math.abs(Number(after[0].s)/1e6-1613.2)<3?'✅ KHỚP':'⚠️ lệch');
process.exit(0);
