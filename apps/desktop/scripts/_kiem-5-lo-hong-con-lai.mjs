// B192–B196 — 5 lỗ hổng cuối do 3 agent audit chứng minh (19/11). Mỗi phép kiểm TÁI HIỆN đúng kịch bản
// agent đã dùng, rồi khẳng định nay không còn xảy ra.
//
//  B192 — 2 lệnh ghi SONG SONG cùng khoá bill ⇒ `lo_rows` nhân đôi trong 1 lô (bill 61tr hiện 122tr).
//  B193 — 1 lệnh ghi phụ lỗi ⇒ API trả 500 NHƯNG lô + giao dịch ĐÃ nằm trong sổ và đã tính doanh số.
//  B194 — ghi đè được lô ĐÃ ĐỐI SOÁT / ĐÃ HOÀN TIỀN (cờ nằm bảng khác, không đổi `los.status`).
//  B195 — bảng Doanh Số cắt ở 2000 dòng, KHÔNG báo ⇒ dòng TỔNG thiếu tiền câm.
//  B196 — sửa SỐ TIỀN lô TÁCH NHIỀU THẺ ⇒ `install_fee_amount` giữ số cũ ⇒ tiền về NĐT sai.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[5-lo-hong] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 14; // [B283] +2 phép (GD dựng lại + GD cũ hủy chuẩn)
const daTao = new Set();

const the = (await db.query(
  `SELECT s.tid_id, t.tid, array_agg(DISTINCT s.card_type_id) AS cards
     FROM tid_sell_fees s JOIN tids t ON t.id = s.tid_id
    WHERE s.deleted_at IS NULL AND t.status='ACTIVE'
    GROUP BY s.tid_id, t.tid HAVING count(DISTINCT s.card_type_id) >= 2
    ORDER BY s.tid_id DESC LIMIT 1`
)).rows[0];
chot(!!the, 'DB thử có TID đặt giá bán cho ≥2 loại thẻ');
const [cA, cB] = the.cards;

const tho = randomUUID();
const NHAN = 'kiem-5-lo';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };
// [20/11] KHÔNG neo ngày CỨNG trong bài kiểm: giá bán của TID có KỲ HIỆU LỰC, ngày cứng trôi vào quá khứ
// là rơi ra ngoài kỳ ⇒ ghi bill trả 422 và cổng đỏ vì lý do chẳng liên quan tới thứ nó đang kiểm.
const NGAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
const khoa = (lo) => ['nat', String(the.tid).toLowerCase(), String(lo), String(lo), NGAY].join('|');
const ghi = async (body) => {
  const r = await fetch(API + '/v1/bills/manual', { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json();
  if (j?.data?.loId) daTao.add(j.data.loId);
  return { ma: r.status, j };
};
const demLo = async () => Number((await db.query("SELECT count(*) n FROM los WHERE status <> 'CANCELLED'")).rows[0].n);

try {
  // ── B192: hai lệnh ghi SONG SONG cùng khoá bill ──
  const K = khoa(9601);
  const chung = { tidString: the.tid, cardTypeId: cA, amountBeforeFee: 61_000_029, billKey: K,
    bankReportedLoNumber: 9601, txnDate: new Date(`${NGAY}T10:00:00+07:00`).toISOString() };
  const dau = await ghi(chung);
  chot(dau.ma === 200 && dau.j.ok, 'B192 — ghi được bill gốc 61.000.029đ');
  const loId = dau.j?.data?.loId;
  // 2 lệnh SỬA chạy cùng lúc (đúng kịch bản agent dùng)
  await Promise.all([
    ghi({ ...chung, amountBeforeFee: 61_000_029, allowDuplicate: true, editingLoId: loId }),
    ghi({ ...chung, amountBeforeFee: 61_000_029, allowDuplicate: true, editingLoId: loId })
  ]);
  const sauRace = (await db.query(
    `SELECT count(*)::int AS so_dong, COALESCE(SUM(amount_before_fee),0)::text AS tong FROM lo_rows WHERE lo_id=$1`, [loId]
  )).rows[0];
  console.log('      B192 sau 2 lệnh song song:', JSON.stringify(sauRace));
  chot(sauRace.so_dong === 1, 'B192 — lô vẫn ĐÚNG 1 dòng thẻ sau 2 lệnh ghi song song (' + sauRace.so_dong + ')');
  chot(Number(sauRace.tong) === 61_000_029, 'B192 — tổng tiền KHÔNG nhân đôi (' + sauRace.tong + ')');

  // Chống race dựa vào KHOÁ THEO LÔ, KHÔNG dùng ràng buộc duy nhất (lô × thẻ) — lô hợp lệ vẫn có thể có
  // nhiều dòng cùng loại thẻ; cổng ship đã bắt lỗi đó khi thử thêm ràng buộc.
  const khongConRangBuocSai = (await db.query(
    "SELECT indexname FROM pg_indexes WHERE tablename='lo_rows' AND indexname='uq_lo_rows_lo_card'"
  )).rowCount;
  chot(khongConRangBuocSai === 0, 'B192 — KHÔNG còn ràng buộc duy nhất sai nghiệp vụ trên lo_rows');
  const coKhoa = /pg_advisory_xact_lock/.test(
    (await import('node:fs')).readFileSync(resolve(GOC, 'apps/bot-api/src/lo-service.ts'), 'utf8')
  );
  chot(coKhoa, 'B192 — engine CÓ khoá theo lô khi ghi lại dòng thẻ');

  // ── B193: ghi chú chứa ký tự NUL (trước đây làm lệnh ghi phụ ném lỗi) ──
  const demTruoc = await demLo();
  const nul = await ghi({
    tidString: the.tid, cardTypeId: cA, amountBeforeFee: 45_019_425,
    billKey: khoa(9602), bankReportedLoNumber: 9602,
    ghiChu: 'loi\0nul', txnDate: new Date(`${NGAY}T11:00:00+07:00`).toISOString()
  });
  const demSau = await demLo();
  console.log('      B193 ghi bill có ký tự NUL →', nul.ma, '· số lô:', demTruoc, '→', demSau);
  chot(nul.ma === 200 && nul.j.ok, 'B193 — ký tự NUL bị lọc, bill ghi được bình thường (' + nul.ma + ')');
  chot(demSau === demTruoc + 1, 'B193 — sổ tăng đúng 1 lô, không còn cảnh "API lỗi mà tiền vẫn vào sổ"');

  // ── B194: lô ĐÃ ĐỐI SOÁT thì cấm ghi đè ──
  const loDoiSoat = dau.j?.data?.loId;
  // Cột khoá của bảng đối soát là `lot_id` (KHÔNG phải `lo_id`) — viết sai là câu lệnh nổ.
  await db.query(
    `INSERT INTO pos_lot_recon (lot_id, ds, refund_done, updated_at) VALUES ($1, TRUE, FALSE, now())
     ON CONFLICT (lot_id) DO UPDATE SET ds = TRUE`, [loDoiSoat]
  );
  const deLen = await ghi({ ...chung, amountBeforeFee: 85_000_041, allowDuplicate: true, editingLoId: loDoiSoat });
  console.log('      B194 ghi đè lô đã đối soát →', deLen.ma, (deLen.j?.message ?? '').slice(0, 80));
  chot(deLen.ma >= 400 && !deLen.j.ok, 'B194 — CHẶN ghi đè lô đã đối soát/đã hoàn (' + deLen.ma + ')');
  const conSo = (await db.query('SELECT SUM(amount_before_fee)::text t FROM lo_rows WHERE lo_id=$1', [loDoiSoat])).rows[0].t;
  chot(Number(conSo) === 61_000_029, 'B194 — số tiền lô GIỮ NGUYÊN sau khi bị chặn (' + conSo + ')');
  await db.query('DELETE FROM pos_lot_recon WHERE lot_id=$1', [loDoiSoat]);

  // ── B195: danh sách trả cờ "bị cắt" ──
  const ds = await (await fetch(`${API}/v1/bills/manual?from=${NGAY}&to=${NGAY}`, { headers: H })).json();
  console.log('      B195 danh sách trả về:', JSON.stringify({ total: ds.total, biCat: ds.biCat, soDong: (ds.data ?? []).length }));
  chot(typeof ds.total === 'number', 'B195 — API trả TỔNG số bill trong kỳ (' + ds.total + ')');
  chot(ds.biCat === false, 'B195 — có cờ báo bị cắt, kỳ này không cắt nên = false');

  // ── B196: đổi TIỀN lô TÁCH THẺ phải bị chặn ──
  const daThe = await ghi({
    tidString: the.tid, amountBeforeFee: 10_000_000,
    lines: [{ cardTypeId: cA, amountBeforeFee: 6_000_000 }, { cardTypeId: cB, amountBeforeFee: 4_000_000 }],
    billKey: khoa(9603), bankReportedLoNumber: 9603,
    txnDate: new Date(`${NGAY}T12:00:00+07:00`).toISOString()
  });
  chot(daThe.ma === 200 && daThe.j.ok, 'B196 — ghi được bill TÁCH 2 THẺ (' + daThe.ma + ')');
  const loDa = daThe.j?.data?.loId;
  const doiTien = await ghi({
    tidString: the.tid, amountBeforeFee: 20_000_000,
    lines: [{ cardTypeId: cA, amountBeforeFee: 12_000_000 }, { cardTypeId: cB, amountBeforeFee: 8_000_000 }],
    billKey: khoa(9603), bankReportedLoNumber: 9603,
    txnDate: new Date(`${NGAY}T12:00:00+07:00`).toISOString(), allowDuplicate: true, editingLoId: loDa
  });
  console.log('      B196 đổi tiền lô tách thẻ →', doiTien.ma, (doiTien.j?.message ?? '').slice(0, 90));
  // [B283 24/11 — ĐẢO CHIỀU theo L6] Bệnh B196 nay chữa bằng cách TỐT HƠN chặn: đổi tiền lô tách thẻ
  // PHẢI 200 và GIAO DỊCH ĐƯỢC DỰNG LẠI per-thẻ (GD cũ CANCELLED+xoá mềm, GD mới install_fee đúng tiền
  // MỚI). Thấy lại 4xx "chặn tách thẻ" hoặc install_fee giữ số CŨ = tái phát → sửa app, cấm sửa cổng.
  chot(doiTien.ma === 200 && doiTien.j.ok, 'B196→B283 — đổi tiền lô tách thẻ ĐƯỢC nhận (' + doiTien.ma + ')');
  const gdMoi = (await db.query(
    `SELECT t.id, t.status, t.install_fee_amount::text AS install, t.amount::text AS amount
       FROM transactions t JOIN los l ON l.transaction_id = t.id WHERE l.id=$1`, [loDa])).rows[0];
  const gdCuGia = (await db.query(
    `SELECT count(*)::int AS n FROM transactions
      WHERE deleted_at IS NOT NULL AND status='CANCELLED' AND cancel_reason LIKE 'B283%' AND id <> $1
        AND tid_id = (SELECT tid_id FROM lo_rows WHERE lo_id=$2 LIMIT 1)`, [gdMoi?.id ?? 0, loDa])).rows[0];
  // install_fee per-thẻ của TIỀN MỚI: Σ round(tr × pcm) từng dòng — đọc pcm từ fee_rates theo partner.
  const dongMoi = (await db.query('SELECT amount_before_fee::text AS tr, card_type_id FROM lo_rows WHERE lo_id=$1', [loDa])).rows;
  const tongTrMoi = dongMoi.reduce((a, r) => a + Number(r.tr), 0);
  console.log('      B283 GD mới:', JSON.stringify(gdMoi), '· GD cũ CANCELLED-B283:', gdCuGia.n, '· Σ dòng mới:', tongTrMoi);
  chot(gdMoi != null && Number(gdMoi.amount) === 20_000_000 && Number(gdMoi.install ?? 0) > 0,
    'B283 — GD ĐƯỢC DỰNG LẠI: amount = tiền MỚI (20tr) + install_fee per-thẻ > 0 (' + (gdMoi?.install ?? '∅') + ')');
  chot(gdCuGia.n >= 1, 'B283 — GD cũ bị hủy đúng chuẩn (CANCELLED + xoá mềm, lý do B283)');
} finally {
  for (const id of daTao) {
    await db.query('DELETE FROM pos_lot_recon WHERE lot_id=$1', [id]).catch(() => undefined);
    const tx = (await db.query('SELECT transaction_id FROM los WHERE id=$1', [id])).rows[0]?.transaction_id;
    await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [id]);
    await db.query('DELETE FROM los WHERE id=$1', [id]);
    if (tx) await db.query('DELETE FROM transactions WHERE id=$1', [tx]);
  }
  // [B283] GD cũ của lô kiểm đã bị detach (los.transaction_id trỏ GD mới) — dọn nốt theo dấu B283 trong phiên này.
  await db.query("DELETE FROM transactions WHERE cancel_reason LIKE 'B283%' AND deleted_at IS NOT NULL AND created_at > now() - interval '30 minutes' AND note IS NULL").catch(() => undefined);
  console.log('      đã dọn', daTao.size, 'lô kiểm');
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
}

console.log('\n[5-lo-hong] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[5-lo-hong] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[5-lo-hong] KHÔNG phép kiểm nào đỏ');
await db.end();
if (loi.length) process.exitCode = 1;
