// Khôi phục kho tiền từ backup — CHỈ đẩy lại bộ đếm cho bảng THỰC SỰ có cột id tự tăng.
// (Lần trước đẩy mù: 4 bảng dùng khoá ghép, KHÔNG có cột id → setval ném lỗi → huỷ luôn cả INSERT.)
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
const GOC = resolve(import.meta.dirname, '..');
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + (process.env.DB_DICH || 'sigma_thu');
const dir = process.argv[2];
const THU_TU = ['tids', 'transactions', 'los', 'lo_rows', 'lo_bills', 'pos_lot_recon', 'tid_sell_fees',
  'revenue_recalc_logs', 'ocr_bill_sent', 'qr_bill_sent', 'refund_request', 'refund_request_lot',
  'ndt_refund_request', 'ndt_refund_request_bill', 'qr_refund_batch', 'qr_baoco_recon',
  'digistore_baoco', 'asset_events', 'bill_explains', 'chat_room_tids'];
const MONG = JSON.parse(readFileSync(resolve(dir, '_mong-doi.json'), 'utf8'));
const c = new pg.Client({ connectionString: u.toString() });
await c.connect();
for (const b of THU_TU) {
  const n = (await c.query('SELECT count(*)::int n FROM ' + b)).rows[0].n;
  if (n > 0) continue; // đã có dữ liệu thì bỏ qua, không nhân đôi
  const sql = readFileSync(resolve(dir, b + '.sql'), 'utf8');
  if (!/INSERT/.test(sql)) continue;
  try {
    await c.query('BEGIN');
    await c.query(sql);
    const coId = (await c.query(
      `SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='id'`, [b])).rowCount;
    if (coId) {
      await c.query(`SELECT setval(pg_get_serial_sequence('${b}','id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${b}),1),1))`);
    }
    await c.query('COMMIT');
    console.log('  khôi phục xong  ' + b);
  } catch (e) {
    await c.query('ROLLBACK');
    console.log('  ĐỎ  ' + b + ' → ' + e.message.slice(0, 140));
  }
}
let do_ = 0;
for (const [b, n] of Object.entries(MONG)) {
  const m = (await c.query('SELECT count(*)::int n FROM ' + b)).rows[0].n;
  const ok = m === n; if (!ok) do_++;
  if (!ok) console.log('  ĐỎ   ' + b.padEnd(26) + m + ' / mong ' + n);
}
console.log(do_ ? '=> KHÔI PHỤC THIẾU ' + do_ + ' bảng' : '=> KHÔI PHỤC ĐỦ 100% CẢ ' + Object.keys(MONG).length + ' BẢNG');
await c.end();
process.exit(do_ ? 1 : 0);
