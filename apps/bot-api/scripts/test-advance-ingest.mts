import 'dotenv/config';
import { getBotDb } from '../src/db.js';
import { ingestInvestorAdvance, isAlphaReceiver, normalizeName } from '../src/investor-advance-ingest.js';

const db = getBotDb();

// unit: nhận diện TK SigMa
console.log('isAlphaReceiver("NGUYEN VAN A"):', isAlphaReceiver('NGUYEN VAN A'));
console.log('isAlphaReceiver("Ke Toan Demo"):', isAlphaReceiver('Ke Toan Demo'));
console.log('isAlphaReceiver("KHACH HANG 25"):', isAlphaReceiver('KHACH HANG 25'));

// demo: Khach Demo A chuyển Nguoi Dung Demo (dữ liệu mẫu).
const r1 = await ingestInvestorAdvance(db, {
  zaloGroupId: 'gDEMOGROUP0000000006',
  receiverName: 'NGUYEN VAN A', receiverAccountNumber: '81331', receiverBank: 'ACB',
  senderName: 'KHACH HANG 02', amount: 400000000,
  advanceDateIso: '2026-08-26T09:42:38', ref: '2800', rawDate: '26/08/2026', rawTime: '09:42:38'
});
console.log('LẦN 1:', JSON.stringify(r1));

// chạy lại → phải là duplicate (dedup theo mã GD)
const r2 = await ingestInvestorAdvance(db, {
  zaloGroupId: 'gDEMOGROUP0000000006',
  receiverName: 'NGUYEN VAN A', amount: 400000000, advanceDateIso: '2026-08-26T09:42:38', ref: '2800'
});
console.log('LẦN 2 (dedup):', JSON.stringify(r2));

// bill KHÔNG phải tạm ứng (người nhận đại lý) → skip_not_advance
const r3 = await ingestInvestorAdvance(db, {
  zaloGroupId: 'gDEMOGROUP0000000006',
  receiverName: 'KHACH HANG 25', amount: 200000000, advanceDateIso: '2026-08-26T08:19:02', ref: '2515'
});
console.log('LẦN 3 (không phải tạm ứng):', JSON.stringify(r3));

// verify DB
const rows = await db.$queryRawUnsafe<any[]>(`SELECT id, investor_id, amount, advance_date, source, sender_name, receiver_name, ref_number FROM investor_advances WHERE source='OCR' ORDER BY id DESC LIMIT 3`);
console.log('DB investor_advances (OCR):', JSON.stringify(rows.map((r) => ({ ...r, amount: String(r.amount) }))));
process.exit(0);
