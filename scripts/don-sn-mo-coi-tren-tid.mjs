// DỌN SỐ SERIAL MỒ CÔI TRÊN BẢNG tids — Admin Demo duyệt 12/11 ("dọn luôn SN mồ côi đi").
//
// Bối cảnh: `tids.pos_serial` / `tids.customer_device_serial` nối với máy bằng CHUỖI, KHÔNG có khoá ngoại.
// Sau khi xoá danh mục máy (pos_devices → 0), các TID vẫn giữ SN của máy đã biến mất ⇒ màn TID báo
// "38 Máy công ty" trong khi màn Máy POS báo "0 máy". Không có ràng buộc nào vỡ nên KHÔNG có lỗi bật lên.
//
// PHẠM VI: CHỈ 2 CỘT đó, CHỈ trên những dòng mà SN không còn máy nào khớp. Không đụng cột nào khác,
// không xoá dòng nào.
//
// 3 TẦNG (luật R202): sao lưu trước · chỉ đụng đúng ô đã duyệt · cổng kiểm đối chiếu từng ô sau khi ghi.
// Mặc định CHẠY THỬ; thêm --that mới ghi thật. DB_DICH chọn sổ (mặc định sigma).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '..');
const THAT = process.argv.includes('--that');
const DB = process.env.DB_DICH || 'sigma';
// Dọn HẾT serial không còn máy khớp. Để --tat-ca thì dọn mọi serial kể cả còn máy (dùng khi format sạch).
const TAT_CA = process.argv.includes('--tat-ca');

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

const moc = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const THU_MUC = `<BACKUP_DIR>\\don-sn-mo-coi\\${DB}-${moc}`;
console.log('SỔ ĐÍCH : ' + DB + (DB === 'sigma' ? '  (SỔ THẬT)' : '  (bản sao)'));
console.log('CHẾ ĐỘ  : ' + (THAT ? '*** GHI THẬT ***' : 'chạy thử — thêm --that để ghi thật')
  + (TAT_CA ? '  · dọn MỌI serial' : '  · chỉ dọn serial KHÔNG còn máy khớp'));
console.log('SAO LƯU : ' + THU_MUC);

// Điều kiện "mồ côi": có serial nhưng không còn máy nào mang serial đó.
const DK_POS = TAT_CA
  ? `pos_serial IS NOT NULL AND pos_serial <> ''`
  : `pos_serial IS NOT NULL AND pos_serial <> '' AND NOT EXISTS (SELECT 1 FROM pos_devices d WHERE d.serial = t.pos_serial)`;
const DK_KH = TAT_CA
  ? `customer_device_serial IS NOT NULL AND customer_device_serial <> ''`
  : `customer_device_serial IS NOT NULL AND customer_device_serial <> '' AND NOT EXISTS (SELECT 1 FROM pos_devices d WHERE d.serial = t.customer_device_serial)`;

const idPos = (await db.query(`SELECT id FROM tids t WHERE ${DK_POS} ORDER BY id`)).rows.map((x) => x.id);
const idKh = (await db.query(`SELECT id FROM tids t WHERE ${DK_KH} ORDER BY id`)).rows.map((x) => x.id);
const soDong = (await db.query('SELECT count(*)::int n FROM tids')).rows[0].n;
console.log(`\nSẼ DỌN: pos_serial trên ${idPos.length} TID · customer_device_serial trên ${idKh.length} TID`);
console.log(`Bảng tids có ${soDong} dòng — SỐ DÒNG PHẢI GIỮ NGUYÊN (chỉ xoá nội dung 2 ô, không xoá dòng).`);
if (!idPos.length && !idKh.length) {
  console.log('Không có gì để dọn.');
  await db.end();
  process.exit(0);
}

// ── TẦNG 1: SAO LƯU TOÀN BỘ BẢNG tids ──────────────────────────────────────────────────────────
mkdirSync(THU_MUC, { recursive: true });
const truoc = await db.query('SELECT * FROM tids ORDER BY id');
writeFileSync(resolve(THU_MUC, 'tids-truoc.json'), JSON.stringify(truoc.rows, null, 1), 'utf8');
// Câu lệnh HOÀN TÁC: trả đúng giá trị cũ cho đúng dòng cũ.
const hoanTac = truoc.rows
  .filter((r) => idPos.includes(r.id) || idKh.includes(r.id))
  .map((r) => {
    const v = (x) => (x === null || x === undefined ? 'NULL' : "'" + String(x).replace(/'/g, "''") + "'");
    return `UPDATE tids SET pos_serial=${v(r.pos_serial)}, customer_device_serial=${v(r.customer_device_serial)} WHERE id=${r.id};`;
  });
writeFileSync(resolve(THU_MUC, 'hoan-tac.sql'),
  `-- Hoàn tác dọn SN mồ côi — sao lưu ${moc} (${hoanTac.length} dòng)\n` + hoanTac.join('\n') + '\n', 'utf8');
console.log(`Đã lưu ${truoc.rowCount} dòng tids + ${hoanTac.length} câu lệnh hoàn tác.`);

if (!THAT) {
  console.log('\n[chạy thử] ĐÃ SAO LƯU, CHƯA GHI GÌ. Chạy lại kèm --that để ghi thật.');
  await db.end();
  process.exit(0);
}

// ── TẦNG 2: GHI — chỉ 2 cột, chỉ các dòng đã liệt kê ───────────────────────────────────────────
await db.query('BEGIN');
let n1 = 0;
let n2 = 0;
try {
  if (idPos.length) n1 = (await db.query('UPDATE tids SET pos_serial = NULL WHERE id = ANY($1)', [idPos])).rowCount;
  if (idKh.length) n2 = (await db.query('UPDATE tids SET customer_device_serial = NULL WHERE id = ANY($1)', [idKh])).rowCount;
  await db.query('COMMIT');
} catch (e) {
  await db.query('ROLLBACK');
  console.error('\n*** GHI HỎNG — ĐÃ LÙI TOÀN BỘ:', e.message, '\n    Backup: ' + THU_MUC);
  await db.end();
  process.exit(1);
}

// ── TẦNG 3: CỔNG KIỂM — ĐỐI CHIẾU TỪNG Ô trước/sau ─────────────────────────────────────────────
const sau = await db.query('SELECT * FROM tids ORDER BY id');
writeFileSync(resolve(THU_MUC, 'tids-sau.json'), JSON.stringify(sau.rows, null, 1), 'utf8');
let soKiem = 0;
const loi = [];
const chot = (ok, ten) => { soKiem++; if (!ok) loi.push(ten); };

chot(sau.rowCount === truoc.rowCount, `SỐ DÒNG tids đổi: ${truoc.rowCount} → ${sau.rowCount}`);
const mapTruoc = new Map(truoc.rows.map((r) => [r.id, r]));
const cot = truoc.fields.map((f) => f.name);
for (const r of sau.rows) {
  const t0 = mapTruoc.get(r.id);
  chot(!!t0, `TID id=${r.id} XUẤT HIỆN THÊM sau khi ghi`);
  if (!t0) continue;
  for (const c of cot) {
    const duocPhepDoi =
      (c === 'pos_serial' && idPos.includes(r.id)) ||
      (c === 'customer_device_serial' && idKh.includes(r.id)) ||
      c === 'updated_at';
    const cu = t0[c] instanceof Date ? t0[c].toISOString() : t0[c];
    const moi = r[c] instanceof Date ? r[c].toISOString() : r[c];
    if (duocPhepDoi) {
      if (c !== 'updated_at') chot(moi === null, `TID id=${r.id}: ô ${c} đáng lẽ phải RỖNG, đang là "${moi}"`);
    } else {
      chot(cu === moi, `TID id=${r.id}: ô ${c} BỊ ĐỔI NGOÀI PHẠM VI ("${cu}" → "${moi}")`);
    }
  }
}
const conMoCoi = (await db.query(`SELECT count(*)::int n FROM tids t WHERE ${DK_POS} OR ${DK_KH}`)).rows[0].n;
chot(conMoCoi === 0, `VẪN CÒN ${conMoCoi} TID mang SN mồ côi`);

console.log(`\n— KIỂM SAU KHI GHI — (đếm động ${soKiem} phép kiểm trên ${sau.rowCount} dòng × ${cot.length} cột)`);
console.log(`  đã xoá nội dung: pos_serial ${n1} ô · customer_device_serial ${n2} ô`);
if (loi.length) {
  console.error(`  *** ${loi.length} PHÉP KIỂM ĐỎ ***`);
  for (const x of loi.slice(0, 20)) console.error('   - ' + x);
  console.error('  HOÀN TÁC: psql -d ' + DB + ' -f "' + THU_MUC + '\\hoan-tac.sql"');
  await db.end();
  process.exit(1);
}
console.log('  ĐẠT — không ô nào ngoài phạm vi bị đụng, không còn SN mồ côi.');
console.log('  Hoàn tác nếu cần: psql -d ' + DB + ' -f "' + THU_MUC + '\\hoan-tac.sql"');
await db.end();
