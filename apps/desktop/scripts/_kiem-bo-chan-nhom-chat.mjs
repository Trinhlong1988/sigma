// B201 — [Admin Demo 19/11 "bỏ hết lỗi báo chưa liên kết đại lý nhóm chat đi"]
//
// GỐC THẬT của ca "THANH TÙNG 06-2 thêm bill báo không gán đại lý": màn "Thêm bill" của NHÂN VIÊN phải mượn
// danh nghĩa tài khoản bot, mà engine báo giá lại đòi "TID thuộc khách CÙNG NHÓM CHAT với tài khoản gọi".
// Điều kiện đó đúng cho luồng BOT (đại lý tự gửi bill Zalo — không được ghi doanh số cho nhà khác) nhưng vô
// nghĩa với người nhập tay. Đo sổ thật 19/11: 12/27 đại lý ngoài phạm vi ⇒ 16 TID đang chạy không nhập tay
// được (Mi Gin SG 6 máy · Đại lý B 3 · Dũng YN HN 2 = THANH TÙNG 06-2).
//
// Cổng khoá 3 điều:
//   (1) TID đã giao khách NHƯNG khách KHÔNG cùng nhóm chat ⇒ NHẬP TAY ghi được (trước đây 422);
//   (2) ĐỐI CHỨNG: CÙNG TID đó, luồng BOT vẫn bị chặn — chỉ nới cho nhập tay, không nới cho đại lý;
//   (3) VẪN chặn khi TID CHƯA giao khách (không nới quá tay).
import { execFileSync } from 'node:child_process';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[bo-chan-nhom-chat] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const CHUOI_DB = u.toString();
const db = new pg.Client({ connectionString: CHUOI_DB });
await db.connect();

let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 10;
const daTao = new Set();

// Tài khoản bot mà màn "Thêm bill" mượn danh nghĩa.
const bot = (await db.query(
  "SELECT id, name FROM agents WHERE code IN ('SUPPORT_ALPHA','SIGMA_BOT') AND deleted_at IS NULL ORDER BY id DESC LIMIT 1"
)).rows[0];
chot(!!bot, 'DB thử có tài khoản bot mà màn Thêm bill mượn danh nghĩa (' + (bot?.name ?? 'không có') + ')');

// Tập khách NẰM TRONG phạm vi nhóm chat của bot đó.
const trongPhamVi = (await db.query(
  `SELECT DISTINCT g.customer_id FROM chat_room_members m
     JOIN chat_rooms r ON r.id = m.room_id AND r.type='GROUP' AND r.deleted_at IS NULL
     JOIN customer_chat_groups g ON g.room_id = r.id AND g.unassigned_at IS NULL
    WHERE m.agent_id = $1 AND m.left_at IS NULL`, [bot.id]
)).rows.map((x) => x.customer_id);

// TỰ DỰNG CẢNH — DB thử không chắc có sẵn: tạo ĐẠI LÝ MỚI (chưa nhóm chat nào) rồi giao cho nó một TID
// đủ điều kiện (sao chép ngân hàng/đối tác/giá bán từ một TID đang chạy). Dọn sạch ở cuối.
const MAU = (await db.query(
  `SELECT t.id, t.bank_id, t.partner_id, s.card_type_id, s.fee_type_id, s.phi_ban
     FROM tids t JOIN tid_sell_fees s ON s.tid_id = t.id AND s.deleted_at IS NULL
    WHERE t.deleted_at IS NULL AND t.status='ACTIVE' AND t.partner_id IS NOT NULL
    ORDER BY t.id DESC LIMIT 1`
)).rows[0];
chot(!!MAU, 'DB thử có TID mẫu (đủ ngân hàng/đối tác/giá bán) để sao chép dựng cảnh');

const TEN_KHACH = 'KIEM DAI LY NGOAI NHOM B201';
const TEN_TID = 'KIEM BO CHAN NHOM CHAT B201';
await db.query('DELETE FROM tid_sell_fees WHERE tid_id IN (SELECT id FROM tids WHERE hkd_name LIKE $1)', [TEN_TID + '%']);
await db.query('DELETE FROM tids WHERE hkd_name LIKE $1', [TEN_TID + '%']);
await db.query('DELETE FROM customers WHERE nickname = $1', [TEN_KHACH]);
const khachMoi = (await db.query(
  `INSERT INTO customers (code, nickname, full_name, status, created_at, updated_at)
   VALUES ($2,$1,$1,'ACTIVE',now(),now()) RETURNING id`, [TEN_KHACH, 'KIEMB201' + String(Date.now()).slice(-6)]
)).rows[0];
const SO_TID_MOI = '96' + String(Date.now()).slice(-6);
const tMoi = (await db.query(
  `INSERT INTO tids (tid, hkd_name, bank_id, partner_id, customer_id, status, delivered_at, created_at, updated_at)
   VALUES ($1,$2,$3,$4,$5,'ACTIVE',now(),now(),now()) RETURNING id, tid`,
  [SO_TID_MOI, TEN_TID, MAU.bank_id, MAU.partner_id, khachMoi.id]
)).rows[0];
await db.query(
  `INSERT INTO tid_sell_fees (tid_id, card_type_id, fee_type_id, phi_ban, effective_from, created_at, updated_at)
   VALUES ($1,$2,$3,$4, now() - interval '30 days', now(), now())`,
  [tMoi.id, MAU.card_type_id, MAU.fee_type_id, MAU.phi_ban]
);
const tidNgoai = { id: tMoi.id, tid: tMoi.tid, khach: TEN_KHACH, card_type_id: MAU.card_type_id, fee_type_id: MAU.fee_type_id };
chot(!trongPhamVi.includes(khachMoi.id),
  'đại lý vừa dựng NẰM NGOÀI nhóm chat của bot (đúng cảnh Admin Demo gặp) — TID ' + tidNgoai.tid);

const tho = randomUUID();
const NHAN = 'kiem-b201';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };
// [20/11] KHÔNG neo ngày CỨNG trong bài kiểm: giá bán của TID có KỲ HIỆU LỰC, ngày cứng trôi vào quá khứ
// là rơi ra ngoài kỳ ⇒ ghi bill trả 422 và cổng đỏ vì lý do chẳng liên quan tới thứ nó đang kiểm.
const NGAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
async function ghi(body) {
  const r = await fetch(API + '/v1/bills/manual', { method: 'POST', headers: H, body: JSON.stringify(body) });
  const j = await r.json();
  if (j?.data?.loId) daTao.add(j.data.loId);
  return { ma: r.status, j };
}

try {
  // ── (1) NHẬP TAY: phải ghi được ──
  const a = await ghi({
    tidString: tidNgoai.tid, cardTypeId: tidNgoai.card_type_id, feeTypeId: tidNgoai.fee_type_id,
    amountBeforeFee: 2_000_000,
    billKey: ['nat', String(tidNgoai.tid).toLowerCase(), '9901', '9901', NGAY].join('|'), bankReportedLoNumber: 9901,
    txnDate: new Date(`${NGAY}T10:00:00+07:00`).toISOString()
  });
  console.log('      [nhập tay] ' + a.ma + ' · ' + JSON.stringify(a.j).slice(0, 160));
  chot(a.ma === 200 && a.j.ok === true,
    'NHÂN VIÊN nhập tay ghi được bill cho TID ngoài nhóm chat (' + a.ma + ') — trước bản vá là 422');
  chot(!/nhóm chat|đại lý đang gọi|không thuộc/i.test(String(a.j.message ?? '')),
    'không còn câu "không thuộc đại lý đang gọi"');

  // ── (2) ĐỐI CHỨNG: cùng TID, luồng BOT vẫn bị chặn ──
  let doiChung = null;
  try {
    // Gọi THẲNG node + tsx cli (không qua npx.cmd): đường dẫn kho có DẤU CÁCH ("<REPO>") nên shell nối
    // chuỗi làm tsx nhận "D:\TT"; còn execFile vào .cmd trên Windows thì EINVAL. Hai bẫy đã cắn liên tiếp.
    const tsxCli = resolve(GOC, 'node_modules/tsx/dist/cli.mjs');
    const ra = execFileSync(process.execPath, [tsxCli, resolve(import.meta.dirname, '_phu-kiem-pham-vi-nhom-chat.mts'),
      String(tidNgoai.id), String(bot.id), String(tidNgoai.card_type_id)],
      { cwd: GOC, encoding: 'utf8', env: { ...process.env, DATABASE_URL: CHUOI_DB } });
    doiChung = JSON.parse(String(ra).trim().split('\n').pop());
  } catch (e) {
    // R198 — không chạy được phép ĐỐI CHỨNG thì phải ĐỎ, không im lặng bỏ qua.
    console.error('      [đối chứng] KHÔNG CHẠY ĐƯỢC: ' + String(e.message).slice(0, 200));
  }
  console.log('      [đối chứng 2 luồng] ' + JSON.stringify(doiChung));
  chot(!!doiChung, 'chạy được phép ĐỐI CHỨNG so 2 luồng trên cùng engine');
  chot(!!doiChung && doiChung.bot?.ok === false && doiChung.bot?.error === 'TID_NOT_IN_AGENT_SCOPE',
    'luồng BOT VẪN bị chặn (' + (doiChung?.bot?.error ?? '?') + ') — không nới nhầm cho đại lý');
  chot(!!doiChung && doiChung.tay?.ok === true,
    'luồng NHÂN VIÊN nhập tay qua được trên CÙNG TID đó');

  // ── (3) VẪN chặn khi TID CHƯA giao khách ──
  const TEN_KIEM = 'KIEM BO CHAN B201';
  const SO_TID = '97' + String(Date.now()).slice(-6);
  await db.query('DELETE FROM tids WHERE hkd_name = $1', [TEN_KIEM]);
  const bankId = (await db.query('SELECT bank_id FROM tids WHERE id=$1', [tidNgoai.id])).rows[0].bank_id;
  await db.query(
    `INSERT INTO tids (tid, hkd_name, bank_id, status, created_at, updated_at)
     VALUES ($1,$2,$3,'UNASSIGNED',now(),now())`, [SO_TID, TEN_KIEM, bankId]
  );
  const c = await ghi({
    tidString: SO_TID, cardTypeId: tidNgoai.card_type_id, amountBeforeFee: 2_000_000,
    billKey: ['nat', SO_TID, '9902', '9902', NGAY].join('|'), bankReportedLoNumber: 9902,
    txnDate: new Date(`${NGAY}T10:00:00+07:00`).toISOString()
  });
  console.log('      [chưa giao khách] ' + c.ma + ' · ' + (c.j.message ?? ''));
  chot(c.ma >= 400 && !c.j.ok, 'VẪN chặn TID chưa giao khách (' + c.ma + ') — không nới quá tay');
  chot(/chưa giao cho khách/i.test(String(c.j.message ?? '')), 'và vẫn nói rõ lý do "chưa giao cho khách"');
  await db.query('DELETE FROM tids WHERE hkd_name = $1', [TEN_KIEM]);
} finally {
  for (const id of daTao) {
    const tx = (await db.query('SELECT transaction_id FROM los WHERE id=$1', [id])).rows[0]?.transaction_id;
    await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [id]);
    await db.query('DELETE FROM los WHERE id=$1', [id]);
    if (tx) await db.query('DELETE FROM transactions WHERE id=$1', [tx]);
  }
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  await db.query('DELETE FROM tid_sell_fees WHERE tid_id IN (SELECT id FROM tids WHERE hkd_name LIKE $1)', [TEN_TID + '%']);
  await db.query('DELETE FROM tids WHERE hkd_name LIKE $1', [TEN_TID + '%']);
  await db.query('DELETE FROM customers WHERE nickname = $1', [TEN_KHACH]);
  console.log('      đã dọn', daTao.size, 'lô kiểm + đại lý/TID dựng cảnh');
}

console.log('\n[bo-chan-nhom-chat] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[bo-chan-nhom-chat] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[bo-chan-nhom-chat] KHÔNG phép kiểm nào đỏ');
await db.end();
if (loi.length) process.exitCode = 1;
