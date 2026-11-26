// XOÁ TOÀN BỘ TID + LỊCH SỬ TIỀN — phương án A, Admin Demo duyệt 12/11 ("đúng vậy, chạy đi").
//
// GIỮ LẠI (phải y nguyên số dòng): người dùng/vai trò/quyền · khách hàng · đại lý · nhà đầu tư ·
//   tạm ứng NĐT · chìa khoá ngân hàng (qr_paysmart_cred / qr_digistore_cred / qr_fee_rates) ·
//   sao kê ngân hàng (statement_txn + override) · mọi danh mục (ngân hàng, loại thẻ, biểu phí, ngành…).
//
// 3 TẦNG (R202): sao lưu trước · chỉ đụng bảng đã duyệt · cổng kiểm sau khi ghi.
// Mặc định CHẠY THỬ; `--that` mới xoá. `DB_DICH` chọn sổ.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '..');
const THAT = process.argv.includes('--that');
const DB = process.env.DB_DICH || 'sigma';

// ── Danh sách Admin Demo đã duyệt ────────────────────────────────────────────────────────────────
const XOA = [
  'tids', 'transactions', 'los', 'lo_rows', 'lo_bills', 'pos_lot_recon', 'tid_sell_fees',
  'revenue_recalc_logs', 'ocr_bill_sent', 'qr_bill_sent',
  'refund_request_lot', 'refund_request', 'ndt_refund_request_bill', 'ndt_refund_request',
  'qr_refund_batch', 'qr_baoco_recon', 'digistore_baoco', 'asset_events', 'bill_explains',
  'chat_room_tids'
];
const GIU = [
  'users', 'roles', 'permissions', 'role_permissions', 'user_roles',
  'customers', 'agents', 'investors', 'investor_advances', 'investor_bank_accounts',
  'qr_paysmart_cred', 'qr_digistore_cred', 'qr_fee_rates',
  'statement_txn', 'statement_txn_override', 'statement_account_balance',
  'banks', 'card_types', 'fee_types', 'fee_rates', 'industries', 'status_options',
  'pos_models', 'suppliers', 'warehouses', 'partners', 'partner_banks', 'cash_categories',
  'cash_entries', 'funds', 'dossiers', 'dossier_sources', 'receive_accounts', 'products',
  'promo_sell_adjust', 'qr_dealer_sell_fee', 'app_settings', 'audit_logs'
];

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

const dem = async (ds) => {
  const r = {};
  for (const b of ds) {
    try { r[b] = (await db.query('SELECT count(*)::int n FROM ' + b)).rows[0].n; }
    catch { r[b] = null; } // bảng không tồn tại → đánh dấu rõ, KHÔNG nuốt im (R198)
  }
  return r;
};

const moc = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const THU_MUC = `<BACKUP_DIR>\\xoa-lich-su-tien\\${DB}-${moc}`;
console.log('SỔ ĐÍCH : ' + DB + (DB === 'sigma' ? '   *** SỔ THẬT ***' : '   (bản sao)'));
console.log('CHẾ ĐỘ  : ' + (THAT ? '*** XOÁ THẬT ***' : 'chạy thử — thêm --that để xoá thật'));
console.log('SAO LƯU : ' + THU_MUC);

const truocXoa = await dem(XOA);
const truocGiu = await dem(GIU);
const thieu = XOA.filter((b) => truocXoa[b] === null);
if (thieu.length) {
  console.error('\n*** KHÔNG ĐỌC ĐƯỢC BẢNG: ' + thieu.join(', ') + ' — DỪNG ***');
  await db.end();
  process.exit(1);
}
console.log('\n— SỐ DÒNG TRƯỚC (sẽ xoá) —');
let tong = 0;
for (const b of XOA) { tong += truocXoa[b]; console.log('  ' + String(truocXoa[b]).padStart(7) + '  ' + b); }
console.log('  ' + String(tong).padStart(7) + '  TỔNG');

// ── TẦNG 1: SAO LƯU ────────────────────────────────────────────────────────────────────────────
mkdirSync(THU_MUC, { recursive: true });
let luu = 0;
for (const b of XOA) {
  const r = await db.query('SELECT * FROM ' + b);
  writeFileSync(resolve(THU_MUC, b + '.json'), JSON.stringify(r.rows, null, 1), 'utf8');
  const cot = r.fields.map((f) => '"' + f.name + '"').join(',');
  const dong = r.rows.map((x) => '(' + r.fields.map((f) => {
    const v = x[f.name];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number' || typeof v === 'bigint') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v instanceof Date) return "'" + v.toISOString() + "'";
    if (typeof v === 'object') return "'" + JSON.stringify(v).replace(/'/g, "''") + "'";
    return "'" + String(v).replace(/'/g, "''") + "'";
  }).join(',') + ')');
  // Chia lô 500 dòng/câu lệnh để psql không nghẹn câu INSERT khổng lồ.
  let sql = `-- khôi phục ${b} (${dong.length} dòng) — sao lưu ${moc}\n`;
  for (let i = 0; i < dong.length; i += 500) {
    sql += `INSERT INTO ${b} (${cot}) VALUES\n` + dong.slice(i, i + 500).join(',\n') + ';\n';
  }
  writeFileSync(resolve(THU_MUC, b + '.sql'), sql, 'utf8');
  luu += r.rowCount;
  console.log('  đã lưu ' + String(r.rowCount).padStart(7) + '  ' + b);
}
if (luu !== tong) {
  console.error(`\n*** SAO LƯU ${luu} ≠ ${tong} DÒNG — DỪNG, KHÔNG XOÁ ***`);
  await db.end();
  process.exit(1);
}
console.log('Đã sao lưu đủ ' + luu + ' dòng.');

if (!THAT) {
  console.log('\n[chạy thử] ĐÃ SAO LƯU, CHƯA XOÁ GÌ. Chạy lại kèm --that để xoá thật.');
  await db.end();
  process.exit(0);
}

// ── TẦNG 2: XOÁ — tự xếp thứ tự CON TRƯỚC CHA theo khoá ngoại thật trong DB ────────────────────
const canh = await db.query(`
  SELECT src.relname AS con, tgt.relname AS cha
  FROM pg_constraint c
  JOIN pg_class src ON src.oid = c.conrelid
  JOIN pg_class tgt ON tgt.oid = c.confrelid
  WHERE c.contype = 'f' AND src.relname = ANY($1) AND tgt.relname = ANY($1) AND src.relname <> tgt.relname`,
  [XOA]);
const thuTu = [];
const daXong = new Set();
const phuThuoc = new Map(XOA.map((b) => [b, new Set()]));
for (const e of canh.rows) phuThuoc.get(e.cha)?.add(e.con); // xoá CON xong mới tới CHA
let vong = 0;
while (thuTu.length < XOA.length && vong++ < 50) {
  for (const b of XOA) {
    if (daXong.has(b)) continue;
    const con = [...(phuThuoc.get(b) || [])];
    if (con.every((x) => daXong.has(x))) { thuTu.push(b); daXong.add(b); }
  }
}
for (const b of XOA) if (!daXong.has(b)) thuTu.push(b); // vòng lặp khoá ngoại (nếu có) — vẫn phải xoá
console.log('\nThứ tự xoá (con trước cha): ' + thuTu.join(' → '));

await db.query('BEGIN');
const daXoa = {};
try {
  for (const b of thuTu) daXoa[b] = (await db.query('DELETE FROM ' + b)).rowCount;
  await db.query('COMMIT');
} catch (e) {
  await db.query('ROLLBACK');
  console.error('\n*** XOÁ HỎNG — ĐÃ LÙI TOÀN BỘ:', e.message, '\n    Backup: ' + THU_MUC);
  await db.end();
  process.exit(1);
}

// ── TẦNG 3: CỔNG KIỂM SAU KHI GHI ──────────────────────────────────────────────────────────────
const sauXoa = await dem(XOA);
const sauGiu = await dem(GIU);
let soKiem = 0;
const loi = [];
const chot = (ok, ten) => { soKiem++; if (!ok) loi.push(ten); };
console.log('\n— KIỂM SAU KHI XOÁ —');
for (const b of XOA) {
  chot(sauXoa[b] === 0, `${b}: còn ${sauXoa[b]} dòng (phải 0)`);
  console.log(`  ${sauXoa[b] === 0 ? 'ĐẠT ' : 'ĐỎ  '} ${b}: ${truocXoa[b]} → ${sauXoa[b]}`);
}
for (const b of GIU) {
  if (truocGiu[b] === null) { chot(false, `${b}: KHÔNG ĐỌC ĐƯỢC — không kiểm được`); continue; }
  chot(sauGiu[b] === truocGiu[b], `${b} BỊ ĐỔI: ${truocGiu[b]} → ${sauGiu[b]} — NGOÀI PHẠM VI DUYỆT`);
}
for (const [b, c] of [['qr_paysmart_cred', 'tid_id'], ['qr_digistore_cred', 'tid_id'], ['qr_fee_rates', 'tid_id']]) {
  const n = (await db.query(`SELECT count(*)::int n FROM ${b} WHERE ${c} IS NOT NULL`)).rows[0].n;
  console.log(`  (ghi nhận) ${b}.${c}: còn ${n} dòng trỏ vào TID đã xoá — GIỮ theo quyết định của Admin Demo`);
}
console.log(`\n  đã chạy ${soKiem} phép kiểm (đếm động)`);
if (loi.length) {
  console.error(`  *** ${loi.length} PHÉP KIỂM ĐỎ ***`);
  for (const x of loi.slice(0, 20)) console.error('   - ' + x);
  console.error('  Khôi phục: các file .sql trong ' + THU_MUC);
  await db.end();
  process.exit(1);
}
console.log('  ĐẠT — xoá đúng ' + Object.values(daXoa).reduce((a, b) => a + b, 0) + ' dòng, '
  + GIU.length + ' bảng ngoài phạm vi giữ nguyên số dòng.');
console.log('  Khôi phục nếu cần: chạy lần lượt các file .sql trong ' + THU_MUC);
await db.end();
