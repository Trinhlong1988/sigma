// TRA SỔ & ĐỐI CHIẾU 1 BILL VỪA NHẬP (Admin Demo 7/11).
//
// Dùng sau khi nhập 1 bill trên màn Doanh Số: in ra MỌI thứ sổ đã ghi cho lô đó, để so với màn hình.
// CHỈ ĐỌC — không một câu lệnh ghi nào.
//
// Dùng:
//   node scripts/tra-so-doi-chieu.mjs --lo 3588
//   node scripts/tra-so-doi-chieu.mjs --tid 20130241 --ngay 2026-11-07
//   thêm --thu  → tra trên BẢN SAO (sigma_thu) thay vì sổ thật
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '..');
const arg = (t) => {
  const i = process.argv.indexOf(t);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const m = /^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t);
if (!m) {
  console.error('[tra-so] Không đọc được DATABASE_URL');
  process.exit(1);
}
const u = new URL(m[1].replace(/^["']|["']$/g, ''));
if (process.argv.includes('--thu')) u.pathname = '/sigma_thu';

const loId = arg('--lo');
const tid = arg('--tid');
const ngay = arg('--ngay');
if (!loId && !(tid && ngay)) {
  console.error('[tra-so] Cần --lo <id>  HOẶC  --tid <tid> --ngay <YYYY-MM-DD>');
  process.exit(1);
}

const tien = (n) => Number(n).toLocaleString('vi-VN');

const c = new pg.Client({ connectionString: u.toString() });
await c.connect();
console.log('[tra-so] Sổ đang tra:', u.pathname.replace('/', ''));

try {
  const dkLo = loId
    ? { sql: 'l.id = $1', tham: [Number(loId)] }
    : {
        sql: `t.tid = $1 AND COALESCE(l.bill_txn_date, l.created_at) >= ($2::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
                        AND COALESCE(l.bill_txn_date, l.created_at) <  (($2::date) + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`,
        tham: [tid, ngay]
      };

  const lo = await c.query(
    `SELECT DISTINCT l.id, l.agent_id, l.bank_reported_lo_number, l.settlement_code, l.status,
            l.expected_total_amount::text AS tong_du_kien, l.bill_key, l.transaction_id,
            l.bill_txn_date, l.created_at, l.borrowed_by_customer_id,
            cm.full_name AS nha_muon
       FROM los l
       JOIN lo_rows r ON r.lo_id = l.id
       LEFT JOIN tids t ON t.id = r.tid_id
       LEFT JOIN customers cm ON cm.id = l.borrowed_by_customer_id
      WHERE ${dkLo.sql}
      ORDER BY l.id DESC`,
    dkLo.tham
  );
  if (lo.rowCount === 0) {
    console.log('[tra-so] *** KHÔNG TÌM THẤY LÔ NÀO *** — bill chưa vào sổ, hoặc tra sai kỳ/TID.');
    process.exit(1);
  }

  for (const L of lo.rows) {
    const gio = new Intl.DateTimeFormat('vi-VN', {
      timeZone: 'Asia/Ho_Chi_Minh',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false
    }).format(new Date(L.bill_txn_date ?? L.created_at));

    console.log('\n══════════ LÔ ' + L.id + ' ══════════');
    console.log('  trạng thái      :', L.status);
    console.log('  mốc ngày/giờ    :', gio, L.bill_txn_date ? '(giờ quẹt trên bill)' : '(giờ GHI — bill không có giờ)');
    console.log('  số lô ngân hàng :', L.bank_reported_lo_number ?? '(trống)', L.settlement_code ? '· mã đóng ' + L.settlement_code : '');
    console.log('  khoá bill       :', L.bill_key ?? '(không có)');
    console.log('  tổng dự kiến    :', tien(L.tong_du_kien), 'đ');
    console.log('  mượn TID        :', L.borrowed_by_customer_id ? `CÓ → ${L.nha_muon} (id ${L.borrowed_by_customer_id})` : 'không');
    console.log('  chứng từ GD     :', L.transaction_id ?? '(chưa tạo)');

    const rows = await c.query(
      `SELECT r.id, t.tid, t.hkd_name, b.name AS bank, ct.name AS the, ft.name AS loai_phi,
              r.amount_before_fee::text AS truoc, r.fee_applied::text AS phi, r.amount_after_fee::text AS sau
         FROM lo_rows r
         LEFT JOIN tids t ON t.id = r.tid_id
         LEFT JOIN banks b ON b.id = t.bank_id
         LEFT JOIN card_types ct ON ct.id = r.card_type_id
         LEFT JOIN fee_types ft ON ft.id = r.fee_type_id
        WHERE r.lo_id = $1 ORDER BY r.id`,
      [L.id]
    );
    console.log('  ── dòng thẻ ──');
    let sTruoc = 0, sPhi = 0, sSau = 0;
    for (const r of rows.rows) {
      sTruoc += Number(r.truoc); sPhi += Number(r.phi); sSau += Number(r.sau);
      const pct = Number(r.truoc) > 0 ? ((Number(r.phi) / Number(r.truoc)) * 100).toFixed(4) : '—';
      console.log(`   · ${r.tid} ${r.hkd_name ?? ''} [${r.bank ?? '?'} · ${r.the ?? '?'} · ${r.loai_phi ?? '?'}] ` +
        `trước ${tien(r.truoc)} − phí ${tien(r.phi)} (${pct}%) = về ${tien(r.sau)}`);
    }
    console.log(`  ── TỔNG: trước ${tien(sTruoc)} − phí ${tien(sPhi)} = về ${tien(sSau)}`);
    // Bất biến: tổng dự kiến trên lô PHẢI bằng Σ tiền về của các dòng.
    const khop = String(sSau) === String(L.tong_du_kien);
    console.log('  ── KIỂM: tổng dự kiến trên lô', khop ? 'KHỚP Σ dòng' : `*** LỆCH *** (lô ${tien(L.tong_du_kien)} ≠ Σ ${tien(sSau)})`);

    if (L.transaction_id) {
      const tx = await c.query('SELECT id, amount::text AS so_tien, txn_date, status FROM transactions WHERE id = $1', [L.transaction_id]);
      for (const x of tx.rows) console.log('  ── chứng từ GD:', x.id, '·', tien(x.so_tien), 'đ ·', x.status, '·', String(x.txn_date).slice(0, 19));
    }

    const au = await c.query(
      `SELECT action, actor_user_id, ip_address, created_at FROM audit_logs
        WHERE target_type = 'Lo' AND target_id = $1 ORDER BY id DESC LIMIT 5`,
      [String(L.id)]
    );
    if (au.rowCount) {
      console.log('  ── vết kiểm toán ──');
      for (const a of au.rows) console.log(`   · ${a.action} · user ${a.actor_user_id ?? '?'} · ${a.ip_address ?? '?'} · ${String(a.created_at).slice(0, 19)}`);
    } else {
      console.log('  ── vết kiểm toán: (không có)');
    }
  }
} catch (e) {
  console.error('[tra-so] LỖI:', e?.message ?? e);
  process.exitCode = 1;
} finally {
  await c.end();
}
