// ╔══════════════════════════════════════════════════════════════════════════════════════════════════════╗
// ║ BÀI KIỂM — SỬA HÀNG LOẠT TID THEO TÍCH CHỌN (Admin Demo 13/11)                                          ║
// ╚══════════════════════════════════════════════════════════════════════════════════════════════════════╝
//
// LÁI GIAO DIỆN THẬT bằng Playwright trên BẢN SAO:  web http://127.0.0.1:57914/  ·  API 8795  ·  DB sigma_thu.
// TUYỆT ĐỐI KHÔNG đụng sổ thật: có CỔNG NHẬN DẠNG DB ngay đầu bài, sai là DỪNG trước khi bấm bất cứ nút ghi nào.
//
// Kịch bản (mỗi vòng đều ĐỌC LẠI DB để đối chứng, không tin chữ trên màn hình):
//   V1  tích chọn 3 TID → "Đặt thành…" tài khoản nhận → chạy → DB: đúng 3 TID đổi, 65 TID còn lại KHÔNG đổi.
//   V2  chạy LẠI y hệt → phải ra 0 thành công / 3 BỎ QUA / 0 hỏng (chứng minh 3 con số tách bạch, không báo bừa).
//   V3  giả lập NGƯỜI KHÁC vừa sửa 1 TID (đụng updated_at) → chạy → 2 thành công / 1 HỎNG, tên TID hỏng hiện ra,
//       và 2 TID còn lại VẪN chạy tiếp (chịu được lỗi giữa chừng).
//   V4  "Xoá trống" tài khoản nhận cho 3 TID → DB: 3 ô thành NULL, các TID khác KHÔNG đổi.
//   V5  NGÀNH NGHỀ: "Đặt thành…" rồi "Xoá trống" (khoá khác receiveAccountId ⇒ phải kiểm RIÊNG, R198).
//   V6  ĐỐI TÁC + NGÂN HÀNG cùng một lượt chạy (2 trường trong 1 lần bấm).
//   V7  TRẢ TOÀN BỘ TID về giá trị ban đầu + đối chiếu từng ô với ảnh chụp đầu bài (4 cột).
//   V8  xoá phiên tạm + ĐẾM LẠI xem còn sót không.
//
// Chạy:  node apps/desktop/scripts/kiem-sua-hang-loat-tid.mjs
import { chromium } from 'playwright';
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const RA = resolve(import.meta.dirname, '../screenshots/sua-hang-loat-tid');
mkdirSync(RA, { recursive: true });

const WEB = process.env.WEB_THU || 'http://127.0.0.1:57914/';
const NHAN = 'kiem-sua-hang-loat-tid';
const TEN_DB_THU = 'sigma_thu';
const TID_THU = [121, 122, 123]; // 3 TID đem ra sửa
const TK_DICH_1 = 24; // vòng 1 + 2
const TK_DICH_2 = 25; // vòng 3
const NGANH_DICH = 7; // vòng 5 — NGH06 Tiệm Net - Game
const DOI_TAC_DICH = 14; // vòng 6 — ĐPT Đối tác A
const NGAN_HANG_DICH = 19; // vòng 6 — ABB AB Bank (có liên kết với đối tác 14)

// ── Đếm ĐỘNG số phép kiểm (R198: cấm hard-code) ───────────────────────────────────────────────────────
let soKiem = 0;
const loi = [];
const chot = (ok, ten, chiTiet = '') => {
  soKiem++;
  console.log(`  [${String(soKiem).padStart(2, '0')}] ${ok ? 'ĐẠT ' : 'ĐỎ  '} — ${ten}${chiTiet ? '  → ' + chiTiet : ''}`);
  if (!ok) loi.push(ten + (chiTiet ? ' → ' + chiTiet : ''));
};
const dung = (ly) => {
  console.error('\n*** DỪNG BÀI (fail-closed): ' + ly + '\n');
  process.exit(2);
};

// ── Nối DB BẢN SAO ────────────────────────────────────────────────────────────────────────────────────
const envTxt = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const urlThat = /^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(envTxt)[1].replace(/^["']|["']$/g, '');
const u = new URL(urlThat);
const TEN_DB_THAT = u.pathname.replace(/^\//, '');
if (TEN_DB_THAT === TEN_DB_THU) dung('Tên DB thật TRÙNG tên DB bản sao — không phân biệt được, cấm chạy.');
u.pathname = '/' + TEN_DB_THU;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

const tenDbDangNoi = (await db.query('select current_database() as d')).rows[0].d;
chot(tenDbDangNoi === TEN_DB_THU, 'CỔNG AN TOÀN: bài kiểm nối đúng BẢN SAO (không phải sổ thật)', `current_database()=${tenDbDangNoi}, sổ thật=${TEN_DB_THAT}`);
if (tenDbDangNoi !== TEN_DB_THU) dung('Nối nhầm DB.');

/** 4 cột mà chức năng sửa-hàng-loạt được phép đụng. Chụp CẢ 4 để chứng minh "TID khác KHÔNG đổi". */
const COT = ['receive_account_id', 'industry_id', 'partner_id', 'bank_id'];
const TEN_COT = { receive_account_id: 'TK nhận', industry_id: 'ngành', partner_id: 'đối tác', bank_id: 'ngân hàng' };
const chupSo = async () => {
  const r = await db.query(`select id, tid, ${COT.join(', ')} from tids where deleted_at is null order by id`);
  const m = new Map();
  for (const x of r.rows) m.set(x.id, x);
  return m;
};
/** So 2 ảnh chụp, bỏ qua các id trong `truId`. Trả danh sách ô LỆCH. */
const soSanh = (truoc, sau, truId = []) => {
  const tru = new Set(truId);
  const lech = [];
  for (const [id, a] of truoc) {
    if (tru.has(id)) continue;
    const b = sau.get(id);
    if (!b) { lech.push(`TID ${a.tid} BIẾN MẤT khỏi sổ`); continue; }
    for (const c of COT) if (a[c] !== b[c]) lech.push(`TID ${a.tid}: ${TEN_COT[c]} ${a[c]} → ${b[c]}`);
  }
  for (const id of sau.keys()) if (!truoc.has(id) && !tru.has(id)) lech.push(`TID id=${id} MỚI xuất hiện`);
  return lech;
};

const BAN_DAU = await chupSo();
const TONG_TID = BAN_DAU.size;
console.log(`\n[nền] BẢN SAO ${TEN_DB_THU}: ${TONG_TID} TID còn sống. 3 TID đem thử: ${TID_THU.join(', ')}`);
for (const id of TID_THU) {
  const x = BAN_DAU.get(id);
  if (!x) dung(`TID id=${id} không có trong bản sao — sửa hằng TID_THU trong script.`);
  console.log(`      · id=${id} tid=${x.tid} TK nhận ban đầu=${x.receive_account_id}`);
}

// ── Phiên tạm ─────────────────────────────────────────────────────────────────────────────────────────
const tho = randomUUID();
await db.query(
  `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
   VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '30 minutes',now(),$2)`,
  [createHash('sha256').update(tho).digest('hex'), NHAN]
);

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 950 } });
await ctx.addCookies([{ name: 'ql_session', value: tho, domain: '127.0.0.1', path: '/', httpOnly: true }]);
const p = await ctx.newPage();
const loiConsole = [];
p.on('console', (m) => { if (m.type() === 'error') loiConsole.push(m.text().slice(0, 200)); });

const anh = async (ten) => {
  const f = resolve(RA, ten + '.png');
  await p.screenshot({ path: f, timeout: 20000 });
  return f;
};

try {
  await p.goto(WEB, { waitUntil: 'networkidle' });
  await p.waitForTimeout(2500);

  // Vào màn Quản Lý TID
  const nutMenu = p.locator("[data-kiem='nut-menu']");
  if (await nutMenu.count()) {
    const hien = await p.locator('aside').first().isVisible().catch(() => false);
    if (!hien) { await nutMenu.first().click(); await p.waitForTimeout(700); }
  }
  const mucMenu = p.locator('aside button', { hasText: 'Quản Lý TID' }).first();
  if (!(await mucMenu.count())) dung('Không thấy mục menu "Quản Lý TID" — có thể cookie phiên không được nhận (sai DB/API?).');
  await mucMenu.click();
  await p.waitForTimeout(3000);

  // ── CỔNG NHẬN DẠNG DB QUA GIAO DIỆN: hàng TỔNG phải khớp số TID của BẢN SAO ────────────────────────
  const chuTong = (await p.locator('tfoot', { hasText: 'TỔNG' }).first().innerText().catch(() => '')).replace(/\s+/g, ' ');
  const khopTong = chuTong.includes(`TỔNG ${TONG_TID} TID`);
  chot(khopTong, `CỔNG AN TOÀN: giao diện đang hiển thị BẢN SAO (${TONG_TID} TID)`, `hàng TỔNG = "${chuTong}"`);
  if (!khopTong) dung(`Hàng TỔNG trên màn KHÔNG khớp bản sao (${TONG_TID} TID). Trang có thể đang nối SỔ THẬT — cấm bấm tiếp.`);

  // ── Hàm dùng chung ─────────────────────────────────────────────────────────────────────────────────
  const tichChon = async (ids) => {
    for (const id of ids) {
      const o = p.locator(`input[aria-label="Chọn dòng ${id}"]`);
      if (!(await o.count())) return `không thấy ô tích của TID id=${id}`;
      await o.scrollIntoViewIfNeeded();
      if (!(await o.isChecked())) await o.check();
    }
    return '';
  };
  const docBaConSo = async () => {
    await p.waitForSelector("[data-kiem='ket-qua-hang-loat']", { timeout: 120000 });
    const so = async (k) => Number((await p.locator(`[data-kiem='${k}']`).innerText()).trim());
    return { thanhCong: await so('so-thanh-cong'), boQua: await so('so-bo-qua'), hong: await so('so-hong') };
  };
  /** Hộp báo của app (toast.alert) nổi ĐÈ lên hộp kết quả khi có TID hỏng → phải bấm "Đã hiểu" trước. */
  const tatHopBao = async () => {
    const n = p.locator('button', { hasText: 'Đã hiểu' });
    if (await n.count()) { await n.first().click(); await p.waitForTimeout(500); }
  };
  const dongKetQua = async () => {
    await tatHopBao();
    await p.locator("[data-kiem='nut-dong-ket-qua']").click();
    await p.waitForTimeout(2500);
  };

  // ══ VÒNG 1 — ĐẶT THÀNH tài khoản nhận tiền ════════════════════════════════════════════════════════
  console.log('\n== VÒNG 1 — "Đặt thành…" tài khoản nhận tiền ==');
  let e = await tichChon(TID_THU);
  chot(e === '', `Tích chọn được ${TID_THU.length} TID`, e);
  if (e) dung(e);

  const chuThanh = await p.locator('text=/Đã chọn \\d+ TID/').first().innerText();
  chot(chuThanh.includes(`Đã chọn ${TID_THU.length} TID`), 'Thanh thao tác báo đúng số TID đã chọn', `"${chuThanh}"`);

  const nutHL = p.locator("[data-kiem='nut-sua-hang-loat']");
  chot(await nutHL.count() > 0, 'Có nút "Sửa hàng loạt" khi đã tích chọn');
  await nutHL.click();
  await p.waitForTimeout(1200);

  const tieuDe = await p.locator('text=/Sửa hàng loạt — \\d+ TID đã chọn/').first().innerText();
  chot(tieuDe.includes(`${TID_THU.length} TID đã chọn`), 'Hộp thoại báo RÕ sẽ sửa bao nhiêu TID TRƯỚC khi bấm', `"${tieuDe}"`);

  // 3 lựa chọn phải có đủ cho trường TK nhận tiền
  for (const k of ['tk-giu', 'tk-dat', 'tk-xoa']) {
    chot(await p.locator(`[data-kiem='${k}']`).count() > 0, `Trường "Tài khoản nhận tiền" có lựa chọn ${k.split('-')[1]}`);
  }
  chot(await p.locator("[data-kiem='nganh-xoa']").count() > 0, 'Trường "Ngành nghề" cũng có đủ 3 lựa chọn (có "Xoá trống")');
  chot(await p.locator("[data-kiem='nganhang-xoa']").isDisabled(), 'Ngân hàng: "Xoá trống" bị KHOÁ (trường bắt buộc, không thể để trống)');
  chot(await p.locator("[data-kiem='doitac-xoa']").isDisabled(), 'Đối tác: "Xoá trống" bị KHOÁ (trường bắt buộc, không thể để trống)');
  chot(await p.locator("[data-kiem='nut-chay-hang-loat']").isDisabled(), 'Mọi trường "Giữ nguyên" ⇒ nút chạy bị KHOÁ (không cho chạy rỗng)');

  await p.locator("[data-kiem='tk-dat']").click();
  await p.waitForTimeout(300);
  chot(await p.locator("[data-kiem='nut-chay-hang-loat']").isDisabled(), 'Chọn "Đặt thành…" mà CHƯA chọn giá trị ⇒ nút chạy vẫn KHOÁ');
  await p.locator("[data-kiem='chon-tk-nhan']").selectOption(String(TK_DICH_1));
  await p.waitForTimeout(300);
  const aHop = await anh('v1-hop-thoai');
  chot(!(await p.locator("[data-kiem='nut-chay-hang-loat']").isDisabled()), 'Chọn đủ giá trị ⇒ nút chạy MỞ');

  const truocV1 = await chupSo();
  await p.locator("[data-kiem='nut-chay-hang-loat']").click();
  const kq1 = await docBaConSo();
  const aKq1 = await anh('v1-ket-qua');
  chot(kq1.thanhCong === 3 && kq1.boQua === 0 && kq1.hong === 0, 'VÒNG 1 — 3 con số trên màn: 3 thành công / 0 bỏ qua / 0 hỏng', JSON.stringify(kq1));
  await dongKetQua();

  const sauV1 = await chupSo();
  const dungDich1 = TID_THU.every((id) => sauV1.get(id).receive_account_id === TK_DICH_1);
  chot(dungDich1, `ĐỌC LẠI DB — đúng 3 TID đổi sang TK nhận id=${TK_DICH_1}`, TID_THU.map((id) => `${sauV1.get(id).tid}=${sauV1.get(id).receive_account_id}`).join(', '));
  const lech1 = soSanh(truocV1, sauV1, TID_THU);
  chot(lech1.length === 0, `ĐỌC LẠI DB — ${TONG_TID - TID_THU.length} TID còn lại KHÔNG đổi`, lech1.slice(0, 5).join(' | '));

  // ══ VÒNG 2 — chạy LẠI y hệt ⇒ phải là "BỎ QUA" ════════════════════════════════════════════════════
  console.log('\n== VÒNG 2 — chạy lại y hệt (kỳ vọng BỎ QUA) ==');
  e = await tichChon(TID_THU);
  chot(e === '', 'Tích chọn lại 3 TID sau khi danh sách nạp lại', e);
  await p.locator("[data-kiem='nut-sua-hang-loat']").click();
  await p.waitForTimeout(1000);
  await p.locator("[data-kiem='tk-dat']").click();
  await p.locator("[data-kiem='chon-tk-nhan']").selectOption(String(TK_DICH_1));
  const truocV2 = await chupSo();
  await p.locator("[data-kiem='nut-chay-hang-loat']").click();
  const kq2 = await docBaConSo();
  const aKq2 = await anh('v2-ket-qua-bo-qua');
  chot(kq2.thanhCong === 0 && kq2.boQua === 3 && kq2.hong === 0, 'VÒNG 2 — 0 thành công / 3 BỎ QUA / 0 hỏng (không báo bừa "đã xong")', JSON.stringify(kq2));
  await dongKetQua();
  const lech2 = soSanh(truocV2, await chupSo(), []);
  chot(lech2.length === 0, 'ĐỌC LẠI DB — vòng BỎ QUA không ghi gì vào sổ', lech2.slice(0, 5).join(' | '));

  // ══ VÒNG 3 — chịu được lỗi giữa chừng (1 TID bị người khác sửa trước) ══════════════════════════════
  console.log('\n== VÒNG 3 — 1 TID hỏng, 2 TID còn lại vẫn chạy tiếp ==');
  e = await tichChon(TID_THU);
  chot(e === '', 'Tích chọn lại 3 TID', e);
  await p.locator("[data-kiem='nut-sua-hang-loat']").click();
  await p.waitForTimeout(1000);
  await p.locator("[data-kiem='tk-dat']").click();
  await p.locator("[data-kiem='chon-tk-nhan']").selectOption(String(TK_DICH_2));
  // Giả lập NGƯỜI KHÁC vừa lưu TID giữa (122) SAU khi màn hình đã nạp ⇒ khoá chống ghi đè phải chặn ĐÚNG 1 cái này.
  const idHong = TID_THU[1];
  await db.query('update tids set updated_at = now() + interval \'1 second\' where id = $1', [idHong]);
  const truocV3 = await chupSo();
  await p.locator("[data-kiem='nut-chay-hang-loat']").click();
  const kq3 = await docBaConSo();
  const aBao3 = await anh('v3-hop-bao-loi'); // app CHỦ ĐỘNG báo lỗi nổi lên, không im lặng
  await tatHopBao();
  const aKq3 = await anh('v3-ket-qua-co-hong');
  chot(kq3.hong === 1, 'VÒNG 3 — đúng 1 TID HỎNG được báo ra (không nuốt lỗi)', JSON.stringify(kq3));
  chot(kq3.thanhCong === 2, 'VÒNG 3 — 2 TID còn lại VẪN chạy tiếp sau khi 1 cái hỏng', JSON.stringify(kq3));
  const chuHong = await p.locator("[data-kiem='ket-qua-hang-loat'] ul").first().innerText();
  chot(chuHong.includes(BAN_DAU.get(idHong).tid), 'VÒNG 3 — tên TID hỏng hiện rõ trong danh sách', chuHong.split('\n')[0]);
  await dongKetQua();
  const sauV3 = await chupSo();
  chot(
    sauV3.get(TID_THU[0]).receive_account_id === TK_DICH_2 && sauV3.get(TID_THU[2]).receive_account_id === TK_DICH_2 && sauV3.get(idHong).receive_account_id === TK_DICH_1,
    `ĐỌC LẠI DB — 2 TID đổi sang ${TK_DICH_2}, TID hỏng GIỮ NGUYÊN ${TK_DICH_1}`,
    TID_THU.map((id) => `${sauV3.get(id).tid}=${sauV3.get(id).receive_account_id}`).join(', ')
  );
  const lech3 = soSanh(truocV3, sauV3, TID_THU);
  chot(lech3.length === 0, `ĐỌC LẠI DB — ${TONG_TID - TID_THU.length} TID ngoài vùng chọn KHÔNG đổi`, lech3.slice(0, 5).join(' | '));

  // ══ VÒNG 4 — XOÁ TRỐNG ════════════════════════════════════════════════════════════════════════════
  console.log('\n== VÒNG 4 — "Xoá trống" tài khoản nhận tiền ==');
  e = await tichChon(TID_THU);
  chot(e === '', 'Tích chọn lại 3 TID', e);
  await p.locator("[data-kiem='nut-sua-hang-loat']").click();
  await p.waitForTimeout(1000);
  await p.locator("[data-kiem='tk-xoa']").click();
  await p.waitForTimeout(300);
  const aXoa = await anh('v4-hop-thoai-xoa-trong');
  const truocV4 = await chupSo();
  await p.locator("[data-kiem='nut-chay-hang-loat']").click();
  const kq4 = await docBaConSo();
  const aKq4 = await anh('v4-ket-qua-xoa-trong');
  chot(kq4.thanhCong === 3 && kq4.hong === 0, 'VÒNG 4 — 3 thành công / 0 hỏng', JSON.stringify(kq4));
  await dongKetQua();
  const sauV4 = await chupSo();
  chot(TID_THU.every((id) => sauV4.get(id).receive_account_id === null), 'ĐỌC LẠI DB — 3 TID đã thành RỖNG (xoá trống ĂN THẬT, không bị nuốt)', TID_THU.map((id) => `${sauV4.get(id).tid}=${sauV4.get(id).receive_account_id}`).join(', '));
  const lech4 = soSanh(truocV4, sauV4, TID_THU);
  chot(lech4.length === 0, `ĐỌC LẠI DB — ${TONG_TID - TID_THU.length} TID còn lại KHÔNG bị xoá lây`, lech4.slice(0, 5).join(' | '));

  // ══ VÒNG 5 — NGÀNH NGHỀ: đặt thành → rồi xoá trống (khoá khác `receiveAccountId`, phải kiểm RIÊNG) ═══
  console.log('\n== VÒNG 5 — Ngành nghề: "Đặt thành…" rồi "Xoá trống" ==');
  for (const [buoc, cheDo, dich] of [['đặt thành', 'nganh-dat', NGANH_DICH], ['xoá trống', 'nganh-xoa', null]]) {
    e = await tichChon(TID_THU);
    chot(e === '', `Tích chọn lại 3 TID (ngành — ${buoc})`, e);
    await p.locator("[data-kiem='nut-sua-hang-loat']").click();
    await p.waitForTimeout(1000);
    await p.locator(`[data-kiem='${cheDo}']`).click();
    await p.waitForTimeout(300);
    if (dich !== null) await p.locator("[data-kiem='chon-nganh']").selectOption(String(dich));
    const truoc = await chupSo();
    await p.locator("[data-kiem='nut-chay-hang-loat']").click();
    const kq = await docBaConSo();
    await anh('v5-nganh-' + (dich === null ? 'xoa-trong' : 'dat-thanh'));
    chot(kq.thanhCong === 3 && kq.hong === 0, `VÒNG 5 — ngành nghề ${buoc}: 3 thành công / 0 hỏng`, JSON.stringify(kq));
    await dongKetQua();
    const sau = await chupSo();
    chot(TID_THU.every((id) => sau.get(id).industry_id === dich), `ĐỌC LẠI DB — ngành nghề 3 TID = ${dich === null ? 'RỖNG' : dich}`, TID_THU.map((id) => `${sau.get(id).tid}=${sau.get(id).industry_id}`).join(', '));
    const lech = soSanh(truoc, sau, TID_THU);
    chot(lech.length === 0, `ĐỌC LẠI DB — ${TONG_TID - TID_THU.length} TID còn lại KHÔNG đổi (ngành — ${buoc})`, lech.slice(0, 5).join(' | '));
  }

  // ══ VÒNG 6 — ĐỐI TÁC + NGÂN HÀNG cùng lúc (2 trường trong 1 lượt chạy) ════════════════════════════
  console.log('\n== VÒNG 6 — Đối tác + Ngân hàng cùng một lượt ==');
  e = await tichChon(TID_THU);
  chot(e === '', 'Tích chọn lại 3 TID (đối tác + ngân hàng)', e);
  await p.locator("[data-kiem='nut-sua-hang-loat']").click();
  await p.waitForTimeout(1000);
  await p.locator("[data-kiem='doitac-dat']").click();
  await p.locator("[data-kiem='chon-doi-tac']").selectOption(String(DOI_TAC_DICH));
  await p.locator("[data-kiem='nganhang-dat']").click();
  await p.waitForTimeout(300);
  const dsNganHang = await p.locator("[data-kiem='chon-ngan-hang'] option").allInnerTexts();
  chot(dsNganHang.length >= 2, 'Chọn đối tác xong, danh sách ngân hàng lọc theo liên kết đối tác', dsNganHang.join(' / '));
  await p.locator("[data-kiem='chon-ngan-hang']").selectOption(String(NGAN_HANG_DICH));
  const truocV6 = await chupSo();
  await p.locator("[data-kiem='nut-chay-hang-loat']").click();
  const kq6 = await docBaConSo();
  await anh('v6-ket-qua-doitac-nganhang');
  chot(kq6.thanhCong === 3 && kq6.hong === 0, 'VÒNG 6 — 3 thành công / 0 hỏng', JSON.stringify(kq6));
  await dongKetQua();
  const sauV6 = await chupSo();
  chot(
    TID_THU.every((id) => sauV6.get(id).partner_id === DOI_TAC_DICH && sauV6.get(id).bank_id === NGAN_HANG_DICH),
    `ĐỌC LẠI DB — 3 TID có đối tác=${DOI_TAC_DICH} và ngân hàng=${NGAN_HANG_DICH}`,
    TID_THU.map((id) => `${sauV6.get(id).tid}=(${sauV6.get(id).partner_id}/${sauV6.get(id).bank_id})`).join(', ')
  );
  const lechV6 = soSanh(truocV6, sauV6, TID_THU);
  chot(lechV6.length === 0, `ĐỌC LẠI DB — ${TONG_TID - TID_THU.length} TID còn lại KHÔNG đổi (đối tác + ngân hàng)`, lechV6.slice(0, 5).join(' | '));

  // Console trình duyệt: lượt 409 ở VÒNG 3 là CỐ Ý (ta tự đụng updated_at để ép khoá chống ghi đè bật).
  // Mọi lỗi đỏ KHÁC đều là bất thường ⇒ phải đỏ.
  const loi409 = loiConsole.filter((x) => x.includes('409'));
  const loiKhac = loiConsole.filter((x) => !x.includes('409'));
  chot(loiKhac.length === 0, 'Console trình duyệt: không có lỗi đỏ NGOÀI DỰ KIẾN', loiKhac.slice(0, 3).join(' | '));
  chot(loi409.length === 1, 'Console trình duyệt: đúng 1 lượt 409 (chính là TID bị khoá chống ghi đè ở vòng 3)', `có ${loi409.length} lượt 409`);

  // Liệt kê ĐỘNG mọi ảnh đã chụp (đếm từ đĩa, không hard-code danh sách ⇒ thêm vòng mới là tự hiện).
  const { readdirSync } = await import('node:fs');
  const dsAnh = readdirSync(RA).filter((x) => x.endsWith('.png')).sort();
  console.log(`\n[ảnh] ${dsAnh.length} tấm trong ${RA}`);
  for (const x of dsAnh) console.log('       · ' + x);
  void [aHop, aKq1, aKq2, aBao3, aKq3, aXoa, aKq4];
} catch (err) {
  // R198 — bài kiểm NỔ giữa chừng cũng phải thành 1 phép kiểm ĐỎ nhìn thấy được, không im lặng thoát.
  await anh('loi-giua-chung').catch(() => {});
  chot(false, 'BÀI KIỂM NỔ GIỮA CHỪNG (các phép kiểm sau KHÔNG chạy)', String(err?.message ?? err).split('\n')[0]);
} finally {
  await b.close().catch(() => {});

  // ══ VÒNG 5 — TRẢ TOÀN BỘ TID VỀ GIÁ TRỊ BAN ĐẦU ═══════════════════════════════════════════════════
  console.log('\n== VÒNG 7 — trả toàn bộ TID về giá trị ban đầu ==');
  let soKhoiPhuc = 0;
  for (const [id, x] of BAN_DAU) {
    const r = await db.query(
      `update tids set receive_account_id=$2, industry_id=$3, partner_id=$4, bank_id=$5 where id=$1
       and (receive_account_id is distinct from $2 or industry_id is distinct from $3
            or partner_id is distinct from $4 or bank_id is distinct from $5)`,
      [id, x.receive_account_id, x.industry_id, x.partner_id, x.bank_id]
    );
    soKhoiPhuc += r.rowCount;
  }
  const cuoiCung = await chupSo();
  const conLech = soSanh(BAN_DAU, cuoiCung, []);
  chot(conLech.length === 0, `ĐỐI CHIẾU CUỐI — toàn bộ ${TONG_TID} TID đã về ĐÚNG giá trị ban đầu (khôi phục ${soKhoiPhuc} dòng)`, conLech.slice(0, 5).join(' | '));

  // ══ VÒNG 6 — dọn phiên tạm + ĐẾM LẠI ══════════════════════════════════════════════════════════════
  await db.query('DELETE FROM login_sessions WHERE device_info = $1', [NHAN]);
  const con = (await db.query('SELECT count(*)::int n FROM login_sessions WHERE device_info = $1', [NHAN])).rows[0].n;
  chot(con === 0, 'DỌN SẠCH — không còn phiên tạm nào sót lại', `còn ${con} phiên nhãn "${NHAN}"`);
  await db.end();

  console.log('\n[sua-hang-loat-tid] SỐ PHÉP KIỂM (đếm ĐỘNG) = ' + soKiem);
  console.log('[sua-hang-loat-tid] ảnh: ' + RA);
  if (loi.length) {
    console.log('[sua-hang-loat-tid] KẾT LUẬN: ' + loi.length + ' ĐỎ');
    for (const x of loi) console.log('    ✗ ' + x);
    process.exitCode = 1;
  } else {
    console.log('[sua-hang-loat-tid] KẾT LUẬN: 0 phép kiểm ĐỎ / ' + soKiem);
  }
}
