// XOÁ DANH MỤC MÁY POS — phương án A, Admin Demo duyệt 12/11 ("A, sổ thật").
//
// PHẠM VI ĐÚNG 3 BẢNG: pos_devices · pos_intakes · pos_tid_bindings.
// GIỮ NGUYÊN: tids, transactions, los, lo_rows, pos_lot_recon, customers, agents, investors, users…
//
// 3 TẦNG BẮT BUỘC khi ghi vào dữ liệu người nhập tay (luật R202 của Admin Demo):
//   1. SAO LƯU toàn bộ vùng sắp đụng ra file có mốc thời gian TRƯỚC khi xoá — không sao lưu thì CẤM chạy.
//   2. Chỉ đụng đúng 3 bảng đã duyệt; mọi bảng khác phải GIỮ NGUYÊN SỐ DÒNG.
//   3. CỔNG KIỂM SAU KHI GHI: đếm lại từng bảng; bảng ngoài phạm vi mà đổi số ⇒ exit ≠ 0 + chỉ đường backup.
//
// Mặc định CHẠY THỬ (không xoá). Muốn xoá thật phải thêm --that.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '..');
const THAT = process.argv.includes('--that');
const DB = process.env.DB_DICH || 'sigma';
const XOA = ['pos_devices', 'pos_intakes', 'pos_tid_bindings'];
// Bảng PHẢI GIỮ NGUYÊN — đếm trước/sau, lệch 1 dòng là đỏ.
const GIU = ['tids', 'transactions', 'los', 'lo_rows', 'pos_lot_recon', 'tid_sell_fees', 'customers',
  'agents', 'investors', 'users', 'pos_models', 'suppliers', 'warehouses', 'pos_intake_statuses',
  'asset_events', 'statement_txn', 'device_sales', 'device_deposits'];

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

const dem = async (bang) => {
  const r = {};
  for (const b of bang) r[b] = (await db.query('SELECT count(*)::int n FROM ' + b)).rows[0].n;
  return r;
};

const now = new Date();
const moc = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const THU_MUC = `<BACKUP_DIR>\\xoa-danh-muc-may-pos\\${DB}-${moc}`;

console.log('SỔ ĐÍCH      : ' + DB + (DB === 'sigma' ? '  (SỔ THẬT)' : '  (bản sao)'));
console.log('CHẾ ĐỘ       : ' + (THAT ? '*** XOÁ THẬT ***' : 'chạy thử (không xoá) — thêm --that để xoá thật'));
console.log('THƯ MỤC SAO LƯU: ' + THU_MUC);

const truocXoa = await dem(XOA);
const truocGiu = await dem(GIU);
console.log('\n— SỐ DÒNG TRƯỚC —');
for (const b of XOA) console.log('  XOÁ   ' + String(truocXoa[b]).padStart(6) + '  ' + b);
for (const b of GIU) console.log('  giữ   ' + String(truocGiu[b]).padStart(6) + '  ' + b);

// ── TẦNG 1: SAO LƯU ────────────────────────────────────────────────────────────────────────────
mkdirSync(THU_MUC, { recursive: true });
let tongLuu = 0;
for (const b of XOA) {
  const r = await db.query('SELECT * FROM ' + b);
  writeFileSync(resolve(THU_MUC, b + '.json'), JSON.stringify(r.rows, null, 1), 'utf8');
  // Thêm bản .sql để khôi phục được bằng psql mà không cần viết thêm công cụ.
  const cot = r.fields.map((f) => '"' + f.name + '"');
  const dong = r.rows.map((x) => '(' + r.fields.map((f) => {
    const v = x[f.name];
    if (v === null || v === undefined) return 'NULL';
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (v instanceof Date) return "'" + v.toISOString() + "'";
    return "'" + String(v).replace(/'/g, "''") + "'";
  }).join(',') + ')');
  const sql = dong.length
    ? `-- khôi phục ${b} (${dong.length} dòng) — sao lưu ${moc}\nINSERT INTO ${b} (${cot.join(',')}) VALUES\n${dong.join(',\n')};\n`
    : `-- ${b}: 0 dòng lúc sao lưu\n`;
  writeFileSync(resolve(THU_MUC, b + '.sql'), sql, 'utf8');
  tongLuu += r.rowCount;
  console.log('  đã lưu ' + String(r.rowCount).padStart(6) + ' dòng  ' + b + '.json + .sql');
}
// Lưu thêm bản chụp cột SN trên tids — KHÔNG sửa, chỉ để sau này đối chiếu nếu cần.
const tidSn = await db.query('SELECT id, tid, pos_serial, customer_device_serial FROM tids ORDER BY id');
writeFileSync(resolve(THU_MUC, '_tids-sn-tham-khao.json'), JSON.stringify(tidSn.rows, null, 1), 'utf8');
console.log('  đã lưu ' + String(tidSn.rowCount).padStart(6) + ' dòng  _tids-sn-tham-khao.json (chỉ tham khảo, KHÔNG sửa tids)');

if (tongLuu !== truocXoa.pos_devices + truocXoa.pos_intakes + truocXoa.pos_tid_bindings) {
  console.error('\n*** SAO LƯU KHÔNG ĐỦ DÒNG — DỪNG, KHÔNG XOÁ ***');
  await db.end();
  process.exit(1);
}

if (!THAT) {
  console.log('\n[chạy thử] ĐÃ SAO LƯU XONG, CHƯA XOÁ GÌ. Chạy lại kèm --that để xoá thật.');
  await db.end();
  process.exit(0);
}

// ── TẦNG 2: XOÁ (một giao dịch, hỏng là lùi hết) ───────────────────────────────────────────────
await db.query('BEGIN');
const daXoa = {};
try {
  for (const b of XOA) {
    const r = await db.query('DELETE FROM ' + b);
    daXoa[b] = r.rowCount;
  }
  await db.query('COMMIT');
} catch (e) {
  await db.query('ROLLBACK');
  console.error('\n*** XOÁ HỎNG — ĐÃ LÙI TOÀN BỘ:', e.message);
  console.error('    Backup nằm ở: ' + THU_MUC);
  await db.end();
  process.exit(1);
}

// ── TẦNG 3: CỔNG KIỂM SAU KHI GHI ──────────────────────────────────────────────────────────────
const sauXoa = await dem(XOA);
const sauGiu = await dem(GIU);
let hong = 0;
console.log('\n— KIỂM SAU KHI XOÁ —');
for (const b of XOA) {
  const ok = sauXoa[b] === 0 && daXoa[b] === truocXoa[b];
  if (!ok) hong++;
  console.log(`  ${ok ? 'ĐẠT ' : 'ĐỎ  '} ${b}: ${truocXoa[b]} → ${sauXoa[b]} (xoá ${daXoa[b]})`);
}
for (const b of GIU) {
  const ok = sauGiu[b] === truocGiu[b];
  if (!ok) { hong++; console.log(`  ĐỎ   ${b} BỊ ĐỔI: ${truocGiu[b]} → ${sauGiu[b]} — NGOÀI PHẠM VI DUYỆT`); }
}
if (hong) {
  console.error(`\n*** ${hong} PHÉP KIỂM ĐỎ — khôi phục từ: ${THU_MUC} ***`);
  await db.end();
  process.exit(1);
}
console.log('  ĐẠT  ' + GIU.length + ' bảng ngoài phạm vi GIỮ NGUYÊN SỐ DÒNG');
console.log('\nXONG. Đã xoá ' + Object.values(daXoa).reduce((a, b) => a + b, 0) + ' dòng thuộc đúng 3 bảng đã duyệt.');
console.log('Khôi phục nếu cần: psql -d ' + DB + ' -f "' + THU_MUC + '\\pos_devices.sql" (và 2 file còn lại).');
await db.end();
