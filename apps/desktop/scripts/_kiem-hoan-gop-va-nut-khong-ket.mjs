// B182 — [Admin Demo 19/11] 3 lỗi ở tab Doanh Số, kiểm bằng ĐIỀU KHIỂN THẬT (không suy luận):
//   (1) Chọn NGƯỜI HOÀN rồi lưu mà cột "Người hoàn" vẫn trống — vì ô chỉ hiện tên KHI tiền hoàn > 0,
//       trong khi chính ô nhập ghi "chọn được cả khi hoàn 0đ — dùng khi hoàn gộp nhiều bill".
//   (2) Bấm "Ghi nhận bill" mà máy chủ từ chối ⇒ nút KẸT LOADING vĩnh viễn (thiếu tắt trạng thái đang ghi).
//   (3) Không nhập được TIỀN HOÀN GỘP ở bill cuối: báo "số tiền hoàn nhiều hơn số tiền đại lý được nhận".
//
// Cách kiểm: (1) ghi bill qua ĐÚNG API màn dùng rồi ĐỌC Ô trên bảng thật; (2) chặn lời gọi ghi bằng
// Playwright route để máy chủ "từ chối", rồi soi nút còn quay không; (3) đọc luật chặn trên chính màn.
import { chromium } from 'playwright';
import { dongHopThoaiChe, gacHopThoai , docVaDongHopBaoLoi } from './kiem-chung.mjs';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/hoan-gop-19-11');
mkdirSync(RA, { recursive: true });
const WEB = process.env.WEB_THU || 'http://127.0.0.1:57915';
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[hoan-gop] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

let so = 0; const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 12;

const nguoi = (await db.query("SELECT id, full_name FROM users WHERE username='adminroot' AND deleted_at IS NULL")).rows[0];
const sf = (await db.query(
  `SELECT s.tid_id, s.card_type_id, t.tid FROM tid_sell_fees s JOIN tids t ON t.id = s.tid_id
    WHERE s.deleted_at IS NULL AND t.status='ACTIVE' ORDER BY s.id DESC LIMIT 1`
)).rows[0];
chot(!!sf && !!nguoi, 'DB thử có TID đã đặt giá bán + tài khoản để đóng vai người hoàn');

const tho = randomUUID();
const NHAN = 'kiem-b182';
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,$2,now(),now()+interval '20 minutes',now(),$3)`,
  [createHash('sha256').update(tho).digest('hex'), nguoi.id, NHAN]
);
const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };

// ── Bill ĐỐI CHỨNG: hoàn 0đ NHƯNG CÓ người hoàn (đúng cảnh hoàn gộp: bill này chờ bill cuối hoàn thay) ──
const hn = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' });
const r1 = await fetch(API + '/v1/bills/manual', {
  method: 'POST', headers: H,
  body: JSON.stringify({
    tidString: sf.tid, cardTypeId: sf.card_type_id, amountBeforeFee: 4_321_000,
    billKey: 'kiem-b182-' + randomUUID().slice(0, 8), txnDate: new Date().toISOString(),
    refundedAmount: 0, refundedByUserId: nguoi.id
  })
});
const j1 = await r1.json();
console.log('      ghi bill hoàn 0đ + CÓ người hoàn:', r1.status, JSON.stringify(j1).slice(0, 110));
chot(r1.status === 200 && j1.ok, 'ghi được bill hoàn 0đ mà vẫn ghi người hoàn (' + r1.status + ')');
const loId = j1?.data?.loId;

const dbRow = loId ? (await db.query('SELECT refunded_amount::text AS t, refunded_by_user_id AS u FROM los WHERE id=$1', [loId])).rows[0] : null;
console.log('      sổ lưu:', JSON.stringify(dbRow));
chot(!!dbRow && dbRow.u === nguoi.id, 'SỔ có lưu người hoàn dù tiền hoàn = 0 (' + dbRow?.u + ')');

const bankId = (await db.query('SELECT bank_id FROM tids WHERE id=$1', [sf.tid_id])).rows[0]?.bank_id;
const feeTypeId = (await db.query('SELECT id FROM fee_types WHERE deleted_at IS NULL ORDER BY id LIMIT 1')).rows[0]?.id;
console.log('      TID kiểm:', sf.tid, '· bank', bankId, '· thẻ', sf.card_type_id, '· loại phí', feeTypeId);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1920, height: 1040 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
const loiTrang = [];
p.on('pageerror', (e) => loiTrang.push(String(e.message).slice(0, 120)));

try {
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
  if (await menu.count()) { await menu.click(); await p.waitForTimeout(4000); }
  // kỳ xem = hôm nay (bill vừa ghi)
  const oTu = p.locator('input[aria-label="Từ ngày"]').first();
  const oDen = p.locator('input[aria-label="Đến ngày"]').first();
  if (await oTu.count()) { await oTu.fill(hn); await p.waitForTimeout(300); await oDen.fill(hn); await p.waitForTimeout(3500); }

  // ── (1) Ô "Người hoàn" trên bảng THẬT, neo theo TIÊU ĐỀ cột ──
  const oNH = await p.evaluate(() => {
    for (const tb of document.querySelectorAll('table')) {
      const th = [...tb.querySelectorAll('thead th')].map((x) => (x.textContent ?? '').trim());
      const i = th.indexOf('Người hoàn');
      const iHoan = th.indexOf('Đã hoàn');
      if (i < 0) continue;
      const ra = [];
      for (const tr of tb.querySelectorAll('tbody tr')) {
        const td = tr.querySelectorAll('td');
        if (td.length !== th.length) continue;
        ra.push({ nguoiHoan: (td[i].textContent ?? '').trim(), daHoan: iHoan >= 0 ? (td[iHoan].textContent ?? '').trim() : '' });
      }
      if (ra.length) return ra;
    }
    return [];
  });
  console.log('      cột (Đã hoàn · Người hoàn) trên bảng:', JSON.stringify(oNH.slice(0, 4)));
  const coTen = oNH.some((x) => x.nguoiHoan === nguoi.full_name);
  chot(coTen, 'BẢNG hiện ĐÚNG tên người hoàn dù bill hoàn 0đ (trước đây luôn hiện "—")');

  // ── (2) NÚT "Ghi nhận bill" KHÔNG ĐƯỢC KẸT khi máy chủ từ chối ──
  // Chặn lời gọi ghi và trả lỗi — dựng lại đúng cảnh "sửa bill ⇒ nghi trùng ⇒ nút quay mãi".
  await p.route('**/v1/bills/manual', async (route) => {
    if (route.request().method() === 'POST') {
      await route.fulfill({ status: 400, contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: 'DUP_SUSPECT', message: 'Nghi trùng giao dịch (bài kiểm dựng).' }) });
    } else await route.continue();
  });
  const nutThem = p.locator('[data-nut="them"]').first();
  chot((await nutThem.count()) > 0, 'thấy nút "Thêm bill mới"');
  await nutThem.click();
  await p.waitForTimeout(3000);

  // ── DỰNG FORM ĐẦY ĐỦ bằng chính TÍNH NĂNG GIỮ BẢN NHÁP của app (localStorage 'alpha.bill-nhap-do').
  // Điền tay từng ô qua Playwright rất dễ bắt nhầm ô (đã cắn 2 lần: trúng ô TID đang khoá, trúng ô "Ca"
  // chỉ-đọc) — dùng đường app tự khôi phục thì đúng luồng thật mà không phụ thuộc selector mong manh.
  const nhapSan = {
    cheDo: 'nhap', thuNho: false,
    bankChon: String(bankId), tidId: String(sf.tid_id), cardTypeId: String(sf.card_type_id),
    feeTypeId: String(feeTypeId), soTien: '3000000', tienHuy: '', daHoan: '', nguoiHoanId: '',
    soLo: '777', soHoaDon: '', maDongLo: '', ghiChu: '',
    ngay: hn, gio: '10:30', gioDaDat: true,
    muonTid: false, daiLyMuonId: '', xacNhanMuon: false,
    tachThe: false, dongThe: [], dangSuaId: null
  };
  await p.evaluate((o) => window.localStorage.setItem('alpha.bill-nhap-do', JSON.stringify(o)), nhapSan);
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(5000);
  const dangOForm = await p.locator('[data-nut="ghibill"]').count();
  chot(dangOForm > 0, 'app khôi phục BẢN NHÁP và mở thẳng form nhập bill');

  // ── (2) BẤM GHI trong lúc máy chủ TỪ CHỐI ⇒ nút phải NHẢ, không quay mãi ──
  const nutGhi = p.locator('[data-nut="ghibill"]').first();
  const conThieu = await p.evaluate(() => {
    const e = [...document.querySelectorAll('p')].find((x) => (x.textContent ?? '').includes('Chưa ghi được vì'));
    return e ? (e.textContent ?? '').trim() : '(không còn thiếu gì)';
  });
  const moKhoa = !(await nutGhi.isDisabled());
  console.log('      nút "Ghi nhận bill" mở khoá:', moKhoa, '·', conThieu);
  chot(moKhoa, 'form đủ dữ liệu ⇒ nút "Ghi nhận bill" MỞ KHOÁ (' + conThieu + ')');
  if (!moKhoa) throw new Error('form chưa đủ — không dựng được cảnh kẹt nút');
  await nutGhi.click();
  await p.waitForTimeout(3500);
  const conKet = await nutGhi.isDisabled();
  const conQuay = await p.locator('[data-nut="ghibill"] .animate-spin').count();
  console.log('      sau khi máy chủ từ chối — nút còn khoá:', conKet, '· còn biểu tượng quay:', conQuay);
  chot(conQuay === 0 && !conKet, 'máy chủ TỪ CHỐI ⇒ nút "Ghi nhận bill" NHẢ RA, hết kẹt loading');

  // ── (3) HOÀN GỘP: tiền hoàn LỚN HƠN tiền về của bill này ⇒ phải CHO GHI sau khi tích xác nhận ──
  // Dựng lại form qua bản nháp (neo ô "Đã hoàn" bằng xpath từng bắt nhầm ô ở panel "SẼ GHI NHẬN").
  await p.evaluate((o) => window.localStorage.setItem('alpha.bill-nhap-do', JSON.stringify(o)),
    { ...nhapSan, daHoan: '99000000', nguoiHoanId: String(nguoi.id) });
  await p.reload({ waitUntil: 'networkidle' });
  await p.waitForTimeout(5000);

  const coO = await p.locator('[data-kiem="xac-nhan-hoan-gop"]').count();
  const nutGhi2 = p.locator('[data-nut="ghibill"]').first();
  // [B258 23/11] Nút không còn mờ câm. "Chưa cho ghi" nay chứng minh bằng HÀNH VI: bấm vào thì bị
  // chặn kèm lý do, và KHÔNG có bill nào được ghi.
  await nutGhi2.click({ timeout: 10000 }).catch(() => {});
  await p.waitForTimeout(800);
  const hopChan = await docVaDongHopBaoLoi(p); // đọc XONG phải ĐÓNG, kẻo chắn cú bấm sau
  const khoaKhiChuaTich = hopChan.length > 0;
  console.log('      bấm ghi khi CHƯA tích xác nhận →', JSON.stringify(hopChan.slice(0, 110)));
  const lyDo = await p.evaluate(() => {
    const e = [...document.querySelectorAll('p')].find((x) => (x.textContent ?? '').includes('Chưa ghi được vì'));
    return e ? (e.textContent ?? '').trim() : '(không còn thiếu gì)';
  });
  console.log('      tiền hoàn 99tr > tiền về ⇒ ô xác nhận hiện:', coO, '· nút khoá:', khoaKhiChuaTich, '·', lyDo);
  chot(coO > 0, 'hoàn GỘP: hiện Ô XÁC NHẬN thay vì chặn cứng như trước');
  chot(khoaKhiChuaTich && /xác nhận|CÁCH SỬA|thiếu|chưa/i.test(hopChan),
    'chưa tích xác nhận thì vẫn CHƯA cho ghi — và NÓI RÕ vì sao (chống gõ thừa số 0)');

  if (coO > 0) {
    await p.locator('[data-kiem="xac-nhan-hoan-gop"]').first().check();
    await p.waitForTimeout(1200);
    const moSauTich = !(await nutGhi2.isDisabled());
    const lyDo2 = await p.evaluate(() => {
      const e = [...document.querySelectorAll('p')].find((x) => (x.textContent ?? '').includes('Chưa ghi được vì'));
      return e ? (e.textContent ?? '').trim() : '(không còn thiếu gì)';
    });
    console.log('      sau khi tích xác nhận — nút mở khoá:', moSauTich, '·', lyDo2);
    chot(moSauTich, 'TÍCH xác nhận ⇒ GHI ĐƯỢC bill hoàn gộp (' + lyDo2 + ')');
  }

  const cdp = await ctx.newCDPSession(p);
  const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(resolve(RA, '01-doanh-so.png'), Buffer.from(data, 'base64'));
  chot(loiTrang.length === 0, 'không có lỗi trang (' + (loiTrang[0] ?? 'sạch') + ')');
} finally {
  await b.close().catch(() => {});
  if (loId) {
    const tx = (await db.query('SELECT transaction_id FROM los WHERE id=$1', [loId])).rows[0]?.transaction_id;
    await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [loId]);
    await db.query('DELETE FROM los WHERE id=$1', [loId]);
    if (tx) await db.query('DELETE FROM transactions WHERE id=$1', [tx]);
    console.log('      đã dọn lô kiểm', loId);
  }
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
}

console.log('\n[hoan-gop] ẢNH: ' + RA);
console.log('[hoan-gop] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[hoan-gop] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[hoan-gop] KHÔNG phép kiểm nào đỏ');
await db.end();
if (loi.length) process.exitCode = 1;
