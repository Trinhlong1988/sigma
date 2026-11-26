// B197 — [Admin Demo 19/11 "THÊM TID MỚI TIẾN DŨNG LẠI KHÔNG CÓ KHI CHỌN TID THÊM BILL"]
//
// Đo trên SỔ THẬT 19/11: 3 TID "KHACH HANG 58" (50580458/59/60) vừa khai báo đều ở trạng thái UNASSIGNED,
// 0 dòng giá bán. Ô chọn TID ở màn Thêm bill lọc THẲNG `status === 'ACTIVE'` ⇒ TID mới BIẾN MẤT KHÔNG MỘT
// LỜI GIẢI THÍCH (sổ thật đang có 95 TID loại này). Người nhập tưởng app làm mất TID.
// Ẩn im ở lớp giao diện = nuốt lỗi (R198): luật "phải giao khách mới nhập bill" là ĐÚNG, nhưng phải NÓI RA.
//
// Bài kiểm ĐIỀU KHIỂN THẬT giao diện (R200(a): đổi hành vi thì ảnh tĩnh không đủ) + soi tận máy chủ:
//   (1) gõ tên TID mới trong ô TID  → PHẢI thấy, kèm dấu ⚠ chưa giao khách
//   (2) ĐỐI CHỨNG: TID đang chạy cùng ngân hàng KHÔNG mang dấu ⚠ (dấu có điều kiện, không dán bừa)
//   (3) chọn vào → cảnh báo đỏ chỉ rõ việc phải làm + nút "Ghi nhận bill" bị chặn
//   (4) máy chủ cũng fail-closed: ghi bill cho TID chưa giao khách phải bị từ chối, 0 lô mọc ra
//   (5) ĐỐI CHỨNG NGƯỢC: TID đang chạy vẫn ghi được bình thường (không chặn oan)
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai , docVaDongHopBaoLoi } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/tid-moi-19-11');
mkdirSync(RA, { recursive: true });
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[tid-moi] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 15;

// Ngân hàng phải có SẴN ≥1 TID đang chạy — để kiểm cả 2 phía (mới ⚠ / đang chạy không ⚠) trong CÙNG 1 ô.
const bank = (await db.query(
  `SELECT b.id, b.code, count(*) FILTER (WHERE t.status='ACTIVE' AND t.customer_id IS NOT NULL) dang_chay
     FROM banks b JOIN tids t ON t.bank_id=b.id AND t.deleted_at IS NULL
    GROUP BY b.id, b.code HAVING count(*) FILTER (WHERE t.status='ACTIVE' AND t.customer_id IS NOT NULL) > 0
    ORDER BY dang_chay DESC LIMIT 1`
)).rows[0];
const tidCu = (await db.query(
  `SELECT t.id, t.tid, t.hkd_name, s.card_type_id, s.fee_type_id
     FROM tids t JOIN tid_sell_fees s ON s.tid_id=t.id AND s.deleted_at IS NULL
    WHERE t.deleted_at IS NULL AND t.status='ACTIVE' AND t.customer_id IS NOT NULL AND t.bank_id=$1
    ORDER BY t.id DESC LIMIT 1`,
  [bank?.id ?? 0]
)).rows[0];
chot(!!bank && !!tidCu, 'DB thử có ngân hàng ' + (bank?.code ?? '?') + ' với TID đang chạy để làm đối chứng');

const TEN_KIEM = 'KIEM TID MOI B197';
const SO_TID = '99' + String(Date.now()).slice(-6);
await db.query('DELETE FROM tids WHERE hkd_name = $1', [TEN_KIEM]);
const tidMoi = (await db.query(
  `INSERT INTO tids (tid, hkd_name, bank_id, status, created_at, updated_at)
   VALUES ($1,$2,$3,'UNASSIGNED',now(),now()) RETURNING id, tid`,
  [SO_TID, TEN_KIEM, bank.id]
)).rows[0];
chot(!!tidMoi?.id, 'tạo được TID MỚI (' + SO_TID + ', chưa giao khách) y như lúc Admin Demo vừa khai báo');

const tho = randomUUID();
const NHAN = 'kiem-b197';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };
// [20/11] Ngày HÔM NAY (giờ VN) — không neo ngày cứng: giá bán có kỳ hiệu lực, ngày cứng trôi vào
// quá khứ là rơi ra ngoài kỳ ⇒ ghi bill 422 và cổng đỏ vì lý do không liên quan.
const NGAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(new Date());
const demLo = async () => Number((await db.query("SELECT count(*) n FROM los WHERE status <> 'CANCELLED'")).rows[0].n);
const daTao = new Set();

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1920, height: 1040 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push(String(e.message).slice(0, 160)));

try {
  // ── MÀN DOANH SỐ → FORM THÊM BILL ──
  await p.goto(WEB + '/', { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);
  await gacHopThoai(p); // [23/11] người gác: hộp thoại bật lúc nào cũng tự dẹp khi chắn cú bấm
  await dongHopThoaiChe(p); // dẹp ngay hộp đang mở sẵn
  const nm = p.locator("[data-kiem='nut-menu']");
  if (await nm.count()) {
    const hien = await p.locator('aside').first().isVisible().catch(() => false);
    if (!hien) { await nm.first().click(); await p.waitForTimeout(600); }
  }
  const menu = p.locator('aside button', { hasText: 'Doanh Số' }).first();
  chot((await menu.count()) > 0, 'vào được màn Doanh Số');
  await menu.click();
  await p.waitForTimeout(4000);
  const nutThem = p.locator('[data-nut="them"]').first();
  chot((await nutThem.count()) > 0, 'thấy nút "Thêm bill mới"');
  await nutThem.click();
  await p.waitForTimeout(2500);

  // ── Ô NGÂN HÀNG ──
  const oBank = p.locator('input[placeholder*="Chọn ngân hàng"]').first();
  chot((await oBank.count()) > 0, 'thấy ô chọn Ngân hàng');
  await oBank.click();
  await oBank.fill(bank.code);
  await p.waitForTimeout(500);
  await p.locator('ul li', { hasText: bank.code }).first().click();
  await p.waitForTimeout(900);

  // ── (1) Ô TID: GÕ ĐÚNG TÊN TID MỚI — trước bản vá, danh sách này KHÔNG có nó ──
  const oTid = p.locator('input[placeholder*="Gõ tên HKD hoặc số TID"]').first();
  chot((await oTid.count()) > 0, 'thấy ô chọn TID');
  await oTid.click();
  await oTid.fill('KIEM TID MOI');
  await p.waitForTimeout(600);
  const goiY = await p.locator('ul li').allInnerTexts();
  console.log('      gợi ý khi gõ "KIEM TID MOI":', JSON.stringify(goiY));
  const dongMoi = goiY.find((x) => x.includes(SO_TID));
  chot(!!dongMoi, 'TID MỚI CÓ trong gợi ý ô TID (' + (dongMoi ?? 'KHÔNG THẤY') + ')');
  chot(!!dongMoi && dongMoi.includes('⚠') && /chưa giao khách/i.test(dongMoi),
    'nhãn TID mới mang dấu ⚠ "chưa giao khách" — thấy TRƯỚC khi chọn');

  // ĐỐI CHỨNG: TID đang chạy KHÔNG bị dán dấu ⚠.
  await oTid.fill(String(tidCu.tid));
  await p.waitForTimeout(600);
  const goiYCu = await p.locator('ul li').allInnerTexts();
  const dongCu = goiYCu.find((x) => x.includes(String(tidCu.tid)));
  console.log('      gợi ý TID đang chạy:', JSON.stringify(dongCu));
  chot(!!dongCu && !dongCu.includes('⚠'),
    'ĐỐI CHỨNG: TID ĐANG CHẠY không mang dấu ⚠ (' + (dongCu ?? 'không thấy') + ') — dấu có điều kiện, không dán bừa');

  // ── (3) CHỌN TID mới → cảnh báo đỏ + nút ghi bị chặn ──
  await oTid.fill('KIEM TID MOI');
  await p.waitForTimeout(500);
  await p.locator('ul li', { hasText: SO_TID }).first().click();
  await p.waitForTimeout(1200);
  const chuTrang = await p.evaluate(() => document.body.innerText);
  const coCanhBao = /Chưa nhập bill được cho TID này/i.test(chuTrang) && /Giao cho khách/i.test(chuTrang);
  const doan = chuTrang.match(/Chưa nhập bill được cho TID này[^\n]*/);
  console.log('      đoạn cảnh báo:', (doan ? doan[0] : '(không có)').slice(0, 200));
  chot(coCanhBao, 'chọn vào thì màn NÓI RÕ: chưa nhập bill được + phải giao TID cho khách');
  // [B258 23/11] LUẬT MỚI: nút KHÔNG mờ câm nữa — bấm được, nhưng hàm ghi CHẶN và NÓI RÕ lý do.
  // Kiểm theo hành vi THẬT (bấm → hiện hộp báo nêu đúng lý do), mạnh hơn kiểm thuộc tính disabled.
  const nutGhi = p.locator('[data-nut="ghibill"]').first();
  await nutGhi.click({ timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(800);
  const hopBao = await docVaDongHopBaoLoi(p); // đọc XONG phải ĐÓNG, kẻo chắn cú bấm sau
  console.log('      bấm Ghi nhận bill →', JSON.stringify(hopBao.slice(0, 120)));
  chot(/giao|chưa|thiếu/i.test(hopBao) && /CÁCH SỬA/.test(hopBao),
    'bấm "Ghi nhận bill" khi TID chưa giao khách → CHẶN và nói rõ lý do + CÁCH SỬA');
  const anh = resolve(RA, 'tid-moi-canh-bao.png');
  await p.screenshot({ path: anh, fullPage: false });
  console.log('      ảnh →', anh);
  chot(loiTrang.length === 0, 'không lỗi JavaScript nào trên trang (' + loiTrang.join(' | ') + ')');

  // ── (4) MÁY CHỦ cũng phải fail-closed ──
  const demTruoc = await demLo();
  const r = await fetch(API + '/v1/bills/manual', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      tidString: SO_TID, cardTypeId: tidCu.card_type_id, amountBeforeFee: 5000000,
      billKey: ['nat', SO_TID, '9701', '9701', NGAY].join('|'), bankReportedLoNumber: 9701,
      txnDate: new Date(NGAY + 'T10:00:00+07:00').toISOString()
    })
  });
  const j = await r.json();
  if (j?.data?.loId) daTao.add(j.data.loId);
  const demSau = await demLo();
  console.log('      máy chủ ghi bill TID chưa giao khách →', r.status, JSON.stringify(j).slice(0, 200));
  chot(r.status >= 400 && !j.ok, 'MÁY CHỦ từ chối ghi bill cho TID chưa giao khách (' + r.status + ')');
  chot(demSau === demTruoc, 'không lô nào mọc ra (' + demTruoc + ' → ' + demSau + ')');

  // ── (5) ĐỐI CHỨNG NGƯỢC: TID đang chạy vẫn ghi được — chặn không được chặn oan ──
  const d2 = await demLo();
  const r2 = await fetch(API + '/v1/bills/manual', {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      tidString: tidCu.tid, cardTypeId: tidCu.card_type_id, feeTypeId: tidCu.fee_type_id,
      amountBeforeFee: 5000000,
      billKey: ['nat', String(tidCu.tid).toLowerCase(), '9702', '9702', NGAY].join('|'),
      bankReportedLoNumber: 9702, txnDate: new Date(NGAY + 'T10:00:00+07:00').toISOString()
    })
  });
  const j2 = await r2.json();
  if (j2?.data?.loId) daTao.add(j2.data.loId);
  console.log('      ĐỐI CHỨNG TID đang chạy →', r2.status, JSON.stringify(j2).slice(0, 160), '| số lô', d2, '→', await demLo());
  chot(r2.status === 200 && j2.ok === true, 'ĐỐI CHỨNG: TID đang chạy vẫn ghi bill bình thường (' + r2.status + ')');
} finally {
  await b.close().catch(() => {});
  for (const id of daTao) {
    const tx = (await db.query('SELECT transaction_id FROM los WHERE id=$1', [id])).rows[0]?.transaction_id;
    await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [id]);
    await db.query('DELETE FROM los WHERE id=$1', [id]);
    if (tx) await db.query('DELETE FROM transactions WHERE id=$1', [tx]);
  }
  await db.query('DELETE FROM tids WHERE hkd_name = $1', [TEN_KIEM]);
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  console.log('      đã dọn', daTao.size, 'lô kiểm + TID kiểm');
}

console.log('\n[tid-moi] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[tid-moi] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[tid-moi] KHÔNG phép kiểm nào đỏ');
await db.end();
if (loi.length) process.exitCode = 1;
