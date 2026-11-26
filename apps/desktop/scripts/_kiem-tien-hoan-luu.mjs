// B172 — KIỂM "Đã hoàn / Người hoàn" ĐƯỢC LƯU THẬT: gọi đúng API mà màn hình gọi, rồi ĐỌC LẠI bằng
// danh sách bill (API) + soi thẳng DB. Có ĐỐI CHỨNG: không gửi 2 trường ⇒ không có vết nào mọc ra.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/sigma_thu';
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();
let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };

const tho = randomUUID();
await db.query(`INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
  VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '10 minutes',now(),'kiem-tien-hoan')`,
  [createHash('sha256').update(tho).digest('hex')]);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };

// TID + loại thẻ CÓ giá bán thực tế (nếu không sẽ rớt NO_ACTUAL_SELL_FEE, không tạo được lô để kiểm).
const sf = (await db.query(`SELECT s.tid_id, s.card_type_id, t.tid FROM tid_sell_fees s JOIN tids t ON t.id = s.tid_id
  WHERE s.deleted_at IS NULL AND t.status='ACTIVE' ORDER BY s.id DESC LIMIT 1`)).rows[0];
chot(!!sf, 'DB thử có TID đã đặt giá bán thực tế để ghi bill');
const nguoi = (await db.query("SELECT id, full_name FROM users WHERE deleted_at IS NULL ORDER BY id LIMIT 1")).rows[0];
const TIEN = 5_000_000;
const HOAN = 1_234_000;

async function ghiBill(themTruong, tien = TIEN) {
  const r = await fetch(API + '/v1/bills/manual', {
    method: 'POST', headers: H,
    body: JSON.stringify({
      tidString: sf.tid, cardTypeId: sf.card_type_id, amountBeforeFee: tien,
      billKey: 'kiem-hoan-' + randomUUID().slice(0, 8),
      txnDate: new Date().toISOString(), ...themTruong
    })
  });
  return { ma: r.status, j: await r.json() };
}

// (1) CÓ gửi tiền hoàn + người hoàn
const a = await ghiBill({ refundedAmount: HOAN, refundedByUserId: nguoi.id });
console.log('      ghi bill (có hoàn):', a.ma, JSON.stringify(a.j).slice(0, 200));
chot(a.ma === 200 && a.j.ok, 'ghi được bill có tiền hoàn');
const loId = a.j?.data?.loId;
if (loId) {
  const d = (await db.query('SELECT refunded_amount::text AS n, refunded_by_user_id AS u, refunded_at FROM los WHERE id=$1', [loId])).rows[0];
  console.log('      DB:', JSON.stringify(d));
  chot(Number(d.n) === HOAN, 'DB lưu ĐÚNG số tiền đã hoàn (' + d.n + ')');
  chot(d.u === nguoi.id, 'DB lưu ĐÚNG người hoàn');
  chot(d.refunded_at != null, 'DB có mốc thời gian hoàn');
  const hn = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
  const ds = await (await fetch(`${API}/v1/bills/manual?from=${hn}&to=${hn}`, { headers: H })).json();
  const dong = (ds.data ?? []).find((x) => x.loId === loId);
  console.log('      API danh sách trả về:', JSON.stringify(dong ? { daHoan: dong.daHoan, nguoiHoan: dong.nguoiHoan } : null));
  chot(!!dong && dong.daHoan === HOAN, 'API danh sách TRẢ LẠI đúng số đã hoàn (không còn cứng 0)');
  chot(!!dong && dong.nguoiHoan === nguoi.full_name, 'API danh sách trả đúng TÊN người hoàn');
}
// (2) ĐỐI CHỨNG: không gửi gì ⇒ không có vết.
// [16/11] Số tiền phải KHÁC lượt (1) — cùng TID + cùng tiền trong cùng phút bị gác "trùng" chặn, trước đây
// lô không tạo được thì nhánh `if (lo2)` LẶNG IM bỏ qua phép đối chứng (đếm 9 thay vì 10 mà vẫn xanh — R198).
const b2 = await ghiBill({}, TIEN + 777_000);
console.log('      ghi bill (ĐỐI CHỨNG, không gửi hoàn):', b2.ma, JSON.stringify(b2.j).slice(0, 200));
chot(b2.ma === 200 && b2.j.ok, 'ĐỐI CHỨNG: ghi được bill KHÔNG gửi tiền hoàn');
const lo2 = b2.j?.data?.loId;
chot(!!lo2, 'ĐỐI CHỨNG: có loId để soi sổ (không có là phép đối chứng KHÔNG CHẠY)');
if (lo2) {
  const d2 = (await db.query('SELECT refunded_amount, refunded_by_user_id, refunded_at FROM los WHERE id=$1', [lo2])).rows[0];
  chot(d2.refunded_amount === null && d2.refunded_by_user_id === null && d2.refunded_at === null,
    'ĐỐI CHỨNG: không gửi tiền hoàn ⇒ sổ KHÔNG mọc vết (' + JSON.stringify(d2) + ')');
}
// (3) Gác fail-closed: có tiền mà không có người ⇒ PHẢI từ chối
const c3 = await ghiBill({ refundedAmount: HOAN }, TIEN + 111_000);
console.log('      có tiền, thiếu người:', c3.ma, c3.j?.message);
chot(c3.ma === 400 && /NGƯỜI HOÀN/i.test(String(c3.j?.message ?? '')), 'CHẶN: có tiền hoàn mà không chọn người hoàn');
// (4) người hoàn không tồn tại ⇒ từ chối
const c4 = await ghiBill({ refundedAmount: HOAN, refundedByUserId: 999999 }, TIEN + 222_000);
chot(c4.ma === 400, 'CHẶN: người hoàn không tồn tại');

// dọn: xoá các lô vừa tạo để không bẩn sổ thử
for (const id of [loId, lo2].filter(Boolean)) {
  await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [id]);
  await db.query('DELETE FROM transactions WHERE id = (SELECT transaction_id FROM los WHERE id=$1)', [id]).catch(() => {});
  await db.query('UPDATE los SET transaction_id = NULL WHERE id=$1', [id]);
  await db.query('DELETE FROM los WHERE id=$1', [id]);
}
console.log("\n[tien-hoan] SO PHEP KIEM (dem dong) = " + so);
console.log(loi.length ? '[tien-hoan] ' + loi.length + ' ĐỎ' : '[tien-hoan] KHÔNG phép kiểm nào đỏ');
await db.query("DELETE FROM login_sessions WHERE device_info='kiem-tien-hoan'");
await db.end();
if (loi.length) process.exitCode = 1;
