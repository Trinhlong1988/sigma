// B176 — [Admin Demo 16/11 "phí cm đâu?"] Cột "% CM" của DANH SÁCH BILL NHẬP luôn trống vì API map trả CỨNG
// `caiMayPct: null`, trong khi sổ CÓ số (`transactions.phi_cai_may_milli`, đo lô 3587 = 1100 ⇒ 1,1%).
// Cùng lớp lỗi B172 (trả cứng 0/'' cho ô người dùng gõ).
//
// Kiểm: gọi ĐÚNG API màn hình gọi, so TỪNG DÒNG với kỳ vọng tính ĐỘC LẬP bằng SQL riêng (không chép câu SQL
// của route). Có ĐỐI CHỨNG: lô KHÔNG có phí cài máy phải trả null, KHÔNG được bịa 0.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 11;

// Kỳ xem chọn ĐỘNG: ngày có nhiều lô CÓ phí cài máy nhất (không có thì phép kiểm vô nghĩa).
const ngay = (await db.query(
  `SELECT to_char(COALESCE(l.bill_txn_date, l.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') AS ngay,
          count(*) AS n
     FROM los l JOIN transactions tx ON tx.id = l.transaction_id
    WHERE l.status <> 'CANCELLED' AND tx.phi_cai_may_milli IS NOT NULL AND tx.phi_cai_may_milli > 0
    GROUP BY 1 ORDER BY 2 DESC LIMIT 1`
)).rows[0];
chot(!!ngay, 'DB thử CÓ lô mang phí cài máy để kiểm (không có thì bài kiểm vô nghĩa)');
const TU = ngay.ngay;
const DEN = new Date(Date.parse(TU + 'T00:00:00Z') + 2 * 86400000).toISOString().slice(0, 10);
console.log('      kỳ xem:', TU, '→', DEN, '· lô có phí cài máy trong ngày đầu:', ngay.n);

// KỲ VỌNG độc lập: lô → phí cài máy (milli) của chính giao dịch gắn lô.
const kv = await db.query(
  `SELECT l.id AS lo_id, tx.phi_cai_may_milli AS pcm,
          (SELECT count(DISTINCT r2.card_type_id) FROM lo_rows r2 WHERE r2.lo_id = l.id)::int AS so_the
     FROM los l
     LEFT JOIN transactions tx ON tx.id = l.transaction_id
    WHERE l.status <> 'CANCELLED'
      AND COALESCE(l.bill_txn_date, l.created_at) >= ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
      AND COALESCE(l.bill_txn_date, l.created_at) <  (($2::date) + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`,
  [TU, DEN]
);
// [B296 24/11 — ĐẢO CHIỀU theo L6] Lô NHIỀU THẺ nay API CỐ Ý trả null cho %CM (mỗi dòng một mức —
// MAX% in cạnh tiền tính-từng-dòng là hai số chửi nhau, đo lệch 233.750đ). Kỳ vọng với lô >1 thẻ = null.
const mapKv = new Map(kv.rows.map((r) => [Number(r.lo_id), Number(r.so_the) > 1 ? null : r.pcm == null ? null : Number(r.pcm)]));
const coPcm = [...mapKv.values()].filter((v) => v != null && v > 0).length;
const khongPcm = [...mapKv.values()].filter((v) => v == null).length;
console.log('      lô trong kỳ:', mapKv.size, '· có phí cài máy:', coPcm, '· KHÔNG có:', khongPcm);
chot(coPcm > 0, 'kỳ xem CÓ lô mang phí cài máy (' + coPcm + ')');

const tho = randomUUID();
const NHAN = 'kiem-phi-cm';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1' };
const r = await fetch(`${API}/v1/bills/manual?from=${TU}&to=${DEN}`, { headers: H });
const j = await r.json();
chot(r.status === 200 && j.ok, 'API /v1/bills/manual trả 200 ok (' + r.status + ')');
const ds = j.data ?? [];
chot(ds.length > 0, 'API trả về dòng bill (' + ds.length + ')');

let soSanh = 0, lech = 0, soCoSo = 0, biaSo = 0;
const viDu = [];
for (const b of ds) {
  if (!mapKv.has(Number(b.loId))) continue;
  const pcm = mapKv.get(Number(b.loId));
  const mong = pcm == null ? null : pcm / 1000;
  soSanh++;
  if ((b.caiMayPct ?? null) !== mong) { lech++; if (viDu.length < 3) viDu.push('lô ' + b.loId + ': API ' + b.caiMayPct + ' ≠ sổ ' + mong); }
  if (mong != null) { if (b.caiMayPct != null) soCoSo++; }
  else if (b.caiMayPct != null) biaSo++; // lô không có phí mà API vẫn ra số = BỊA
}
console.log('      so', soSanh, 'dòng · lệch:', lech, '· dòng hiện đúng % CM:', soCoSo, '· bịa số khi sổ trống:', biaSo);
if (viDu.length) console.log('      ví dụ lệch: ' + viDu.join(' | '));
chot(soSanh >= 5, 'so được ít nhất 5 dòng (' + soSanh + ')');
chot(lech === 0, 'MỌI dòng API trả đúng % phí cài máy của sổ (' + lech + ' lệch)');
chot(soCoSo > 0, 'CÓ dòng hiện ra số % CM — không còn trống trơn (' + soCoSo + ')');
chot(biaSo === 0, 'ĐỐI CHỨNG: lô KHÔNG có phí cài máy thì để TRỐNG, không bịa 0 (' + biaSo + ')');

// Nhánh ĐỐI CHỨNG ở trên chỉ có nghĩa khi kỳ xem THẬT SỰ chứa lô trống phí. Đo 16/11: kỳ đông lô nhất có
// 469/469 lô ĐỀU có phí ⇒ nhánh "bịa số" KHÔNG chạy mà vẫn in ĐẠT (đúng lớp R198). Nên lấy thêm kỳ RIÊNG
// chứa lô trống phí và kiểm thật trên đó.
const ngayTrong = (await db.query(
  `SELECT to_char(COALESCE(l.bill_txn_date, l.created_at) AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') AS ngay,
          count(*) AS n
     FROM los l LEFT JOIN transactions tx ON tx.id = l.transaction_id
    WHERE l.status <> 'CANCELLED' AND tx.phi_cai_may_milli IS NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 1`
)).rows[0];
chot(!!ngayTrong, 'DB thử CÓ ngày chứa lô TRỐNG phí cài máy để chạy thật nhánh đối chứng');
if (ngayTrong) {
  const r2 = await fetch(`${API}/v1/bills/manual?from=${ngayTrong.ngay}&to=${ngayTrong.ngay}`, { headers: H });
  const j2 = await r2.json();
  const kv2 = await db.query(
    `SELECT l.id AS lo_id, tx.phi_cai_may_milli AS pcm
       FROM los l LEFT JOIN transactions tx ON tx.id = l.transaction_id
      WHERE l.status <> 'CANCELLED'
        AND COALESCE(l.bill_txn_date, l.created_at) >= ($1::date)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'
        AND COALESCE(l.bill_txn_date, l.created_at) <  (($1::date) + 1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'`,
    [ngayTrong.ngay]
  );
  const m2 = new Map(kv2.rows.map((x) => [Number(x.lo_id), x.pcm == null ? null : Number(x.pcm)]));
  let soTrong = 0, biaThat = 0;
  for (const b of (j2.data ?? [])) {
    if (!m2.has(Number(b.loId)) || m2.get(Number(b.loId)) != null) continue;
    soTrong++;
    if (b.caiMayPct != null) biaThat++;
  }
  console.log('      [kỳ đối chứng ' + ngayTrong.ngay + '] lô trống phí soi được:', soTrong, '· API bịa số:', biaThat);
  chot(soTrong > 0, 'nhánh đối chứng CHẠY THẬT trên ' + soTrong + ' lô trống phí (không phải xanh suông)');
  chot(biaThat === 0, 'API để TRỐNG đúng ' + soTrong + ' lô đó, không bịa 0 (' + biaThat + ' bịa)');
}

console.log('\n[phi-cm] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[phi-cm] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[phi-cm] KHÔNG phép kiểm nào đỏ');
await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
await db.end();
if (loi.length) process.exitCode = 1;
