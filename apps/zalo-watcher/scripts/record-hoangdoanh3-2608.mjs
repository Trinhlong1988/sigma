// Ghi doanh số 53550081 (KHACH HANG 60 3, Phạm Tuyên/Tuyên SG) 26/8 = 273.3tr TRỰC TIẾP (customer 219 đã ở room
// "ĐL - Tuyên SG" nhưng room chưa dán mã Zalo → recordVisionLots không quét; ghi qua createLoFromBillTid + bot làm
// member room = có scope). Số lô lấy từ FILE bảng tay (OCR TID mờ). dry-run: kiểm quoteRow (scope). --write: ghi thật.
import dotenv from 'dotenv';
import { getBotDb } from '../../bot-api/src/db.ts';
import { ensureSupportAlphaAgent } from '../../bot-api/src/zalo-bill-support.ts';
import { createLoFromBillTid } from '../../bot-api/src/lo-service.ts';
import { quoteRow } from '../../bot-api/src/fee-quote.ts';
dotenv.config({ path: '<REPO>/apps/bot-api/.env' });
const WRITE = process.argv.includes('--write');
const ROOM = 'cmtdw7g1500fub8gl8qd5qmvp'; // ĐL - Tuyên SG
const TID = '53550081', DAY = '2026-08-26';
const LOTS = [{ lo: '113', amt: 31589000 }, { lo: '112', amt: 32050000 }, { lo: '111', amt: 42910000 }, { lo: '110', amt: 19747000 }, { lo: '109', amt: 47342000 }, { lo: '108', amt: 45167000 }, { lo: '107', amt: 35597000 }, { lo: '106', amt: 18900000 }];
const db = getBotDb();
const bot = await ensureSupportAlphaAgent(db);
console.log(`bot #${bot.id}. Room Tuyên SG ${ROOM}. TID ${TID}, ${LOTS.length} lô = ${(LOTS.reduce((s, l) => s + l.amt, 0) / 1e6).toFixed(1)}tr`);
// bot làm member room (để có scope khách 219)
await db.chatRoomMember.upsert({ where: { roomId_agentId: { roomId: ROOM, agentId: bot.id } }, update: { leftAt: null, role: 'ADMIN' }, create: { roomId: ROOM, agentId: bot.id, role: 'ADMIN' } });
// tid_id
const tidRow = await db.tid.findFirst({ where: { tid: TID, deletedAt: null }, select: { id: true } });
// DRY: quoteRow kiểm scope 1 lô
const q = await quoteRow(db, bot.id, { tidId: tidRow.id, amountBeforeFee: LOTS[0].amt });
console.log('[quoteRow lô đầu]', q.ok ? `OK phí=${q.data.feeApplied} sau=${q.data.amountAfterFee}` : `LỖI ${q.error}: ${q.message}`);
if (!q.ok) { console.log('\n⚠️ Scope/giá bán chưa đủ — không ghi được. Kiểm cấu hình.'); process.exit(1); }
if (!WRITE) { console.log('\n*** DRY-RUN — quoteRow OK, sẵn sàng ghi. --write để thực thi. ***'); process.exit(0); }
// GHI
let ok = 0, tot = 0; const errs = {};
for (const l of LOTS) {
  const billKey = `VL|${TID}|${l.lo}|${DAY}`;
  const r = await createLoFromBillTid(db, bot.id, { tidString: TID, amountBeforeFee: l.amt, billKey, txnDate: new Date(`${DAY}T12:00:00`), allowDuplicate: true });
  if (r.ok) { ok++; tot += l.amt; } else { errs[r.error] = (errs[r.error] || 0) + 1; }
}
console.log(`[GHI] ok ${ok}/${LOTS.length} = ${(tot / 1e6).toFixed(1)}tr. Lỗi:`, JSON.stringify(errs));
const after = await db.$queryRawUnsafe(`SELECT COALESCE(SUM(t.amount),0)::bigint s, COUNT(*)::int n FROM transactions t JOIN tids td ON td.id=t.tid_id WHERE td.tid=$1 AND t.status='POSTED' AND t.deleted_at IS NULL AND t.txn_date>='2026-08-26'::timestamptz AND t.txn_date<'2026-08-27'::timestamptz`, TID);
console.log(`[SAU] 53550081 = ${after[0].n} GD / ${(Number(after[0].s) / 1e6).toFixed(1)}tr (kỳ vọng 273.3)`);
process.exit(0);
