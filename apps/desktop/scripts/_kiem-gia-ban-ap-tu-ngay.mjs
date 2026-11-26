// B221 — [Admin Demo 20/11 "cho chọn thời gian áp dụng từ bao giờ"] ĐỔI GIÁ BÁN CÓ MỐC ÁP DỤNG.
//
// Gốc: hộp thoại "Phí bán thực tế" ở màn TID KHÔNG gửi `effectiveFrom` nên máy chủ luôn lấy HÔM NAY ⇒ giá mới
// không bao giờ áp được cho bill ĐÃ GHI. Máy chủ vốn đã nhận tham số này — chỉ màn hình chưa gửi.
//
// Cổng khoá 4 điều:
//   (1) màn hình CÓ ô chọn mốc và CÓ gửi `effectiveFrom` lên máy chủ;
//   (2) đặt giá với mốc LÙI VỀ QUÁ KHỨ ⇒ bill ghi SAU mốc đó được tính LẠI theo giá mới (số tiền sau phí đổi);
//   (3) ĐỐI CHỨNG: bill ghi TRƯỚC mốc KHÔNG bị đụng tới;
//   (4) máy chủ trả về phần nói rõ hệ quả (trả dư / giao dịch cũ giữ nguyên) để màn còn báo, không im lặng.
import { randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const GOC = resolve(import.meta.dirname, '../../..');
const API = process.env.API_THU || 'http://127.0.0.1:8795';
const DB_TEN = process.env.CHUP_DB || 'sigma_thu';
if (!/thu|test/i.test(DB_TEN)) {
  console.error('[gia-ban-moc] DỪNG: chỉ chạy trên DB THỬ, đang trỏ "' + DB_TEN + '".');
  process.exit(3);
}
let so = 0;
const loi = [];
const chot = (ok, ten) => { so++; console.log('  ' + (ok ? 'ĐẠT ' : 'ĐỎ  ') + ten); if (!ok) loi.push(ten); };
const CAN = 13;

// ── (1) Màn hình có ô chọn mốc và có gửi lên ──
const tid = readFileSync(resolve(GOC, 'apps/desktop/src/renderer/src/pages/TidPage.tsx'), 'utf8');
chot(/data-nut="apdungtu"/.test(tid), 'hộp thoại giá bán CÓ ô chọn "Áp dụng từ ngày"');
chot(/effectiveFrom: apDungTu \|\| undefined/.test(tid), 'màn hình CÓ gửi mốc áp dụng lên máy chủ');
chot(/giữ nguyên|GIỮ NGUYÊN/.test(tid) && /tính lại|tính LẠI/.test(tid),
  'có nói rõ hệ quả cho người dùng trước khi bấm (tính lại / giữ nguyên)');
// R198 — chỉnh được bao nhiêu bill, bỏ qua bill nào vì sao: PHẢI nói ra, không được im.
chot(/r\.loDaSua/.test(tid) && /Đã chỉnh tiền của/.test(tid), 'màn hình BÁO số bill đã chỉnh tiền theo giá mới');
chot(/r\.loBoQua/.test(tid) && /KHÔNG chỉnh được/.test(tid), 'màn hình BÁO bill KHÔNG chỉnh được kèm lý do (cấm im lặng)');

const t = readFileSync(resolve(GOC, 'apps/quanly-api/.env'), 'utf8');
const u = new URL(/^\s*DATABASE_URL\s*=\s*(.+)\s*$/m.exec(t)[1].replace(/^["']|["']$/g, ''));
u.pathname = '/' + DB_TEN;
const db = new pg.Client({ connectionString: u.toString() });
await db.connect();

const NHAN = 'kiem-b221';
const daTao = new Set();
let cu = null;
let chup = [];
// Mốc ngày phải có TRƯỚC khi chọn TID: TID chỉ dùng được nếu giá bán của nó đã hiệu lực từ TRƯỚC ngày bill cũ.
const ngay = (n) => {
  const d = new Date(Date.now() - n * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(d);
};
const NGAY_CU = ngay(6);   // bill TRƯỚC mốc — phải GIỮ NGUYÊN
const NGAY_MOI = ngay(2);  // bill SAU mốc — phải tính LẠI
const MOC = ngay(4);
try {
  // TID đủ điều kiện ghi bill, và giá bán đã HIỆU LỰC TỪ TRƯỚC ngày bill cũ.
  // Trước đây chỉ lấy "dòng giá bán mới nhất" (ORDER BY id DESC): chạy lẻ thì trúng dòng cũ nên qua, nhưng chạy
  // trong LÔ thì cổng khác vừa tạo giá hiệu lực HÔM NAY ⇒ trúng dòng đó ⇒ bill lùi 6 ngày không có giá ⇒ đỏ.
  // Nay ràng buộc đúng điều kiện nghiệp vụ cần, không phụ thuộc thứ tự chạy của các cổng khác.
  const m = (await db.query(
    `SELECT s.id, s.tid_id, t.tid, s.card_type_id, s.fee_type_id, s.phi_ban
       FROM tid_sell_fees s JOIN tids t ON t.id = s.tid_id
      WHERE s.deleted_at IS NULL AND t.status='ACTIVE' AND t.customer_id IS NOT NULL AND t.partner_id IS NOT NULL
        AND s.effective_from <= $1
      ORDER BY s.id DESC LIMIT 1`, [NGAY_CU + 'T00:00:00+07:00']
  )).rows[0];
  chot(!!m, 'DB thử có TID đang dùng giá bán để kiểm (' + (m?.tid ?? 'không có') + ')');
  if (!m) throw new Error('thiếu dữ liệu dựng cảnh');
  cu = m;
  // Chụp NGUYÊN TRẠNG mọi dòng giá bán của TID — lệnh đặt giá có thể SỬA ĐÈ kỳ đã có (không phải lúc nào cũng
  // đẻ dòng mới), nên xoá "dòng id lớn hơn" là chưa đủ để trả lại như cũ (đã cắn: 0,1% sót lại sang lần sau).
  chup = (await db.query('SELECT id, phi_ban, effective_from, deleted_at FROM tid_sell_fees WHERE tid_id=$1', [m.tid_id])).rows;

  const tho = randomUUID();
  await db.query(
    `INSERT INTO login_sessions (id,user_id,created_at,expires_at,last_seen_at,device_info)
     VALUES ($1,(SELECT id FROM users WHERE username='adminroot'),now(),now()+interval '20 minutes',now(),$2)`,
    [createHash('sha256').update(tho).digest('hex'), NHAN]
  );
  const H = { cookie: 'ql_session=' + tho, 'X-SigMa-Client': '1', 'content-type': 'application/json' };
  async function ghiBill(ngayBill, lo) {
    const r = await fetch(API + '/v1/bills/manual', {
      method: 'POST', headers: H,
      body: JSON.stringify({
        tidString: m.tid, cardTypeId: m.card_type_id, feeTypeId: m.fee_type_id, amountBeforeFee: 10_000_000,
        billKey: ['nat', String(m.tid).toLowerCase(), String(lo), String(lo), ngayBill].join('|'),
        bankReportedLoNumber: lo, txnDate: new Date(ngayBill + 'T10:00:00+07:00').toISOString()
      })
    });
    const j = await r.json();
    if (j?.data?.loId) daTao.add(j.data.loId);
    // R198 — ghi hỏng thì PHẢI nói rõ vì sao, không trả null im lặng rồi để phép kiểm sau đỏ vô cớ.
    if (!j?.data?.loId) console.log('      [ghi bill ' + ngayBill + '] HỎNG ' + r.status + ' · ' + (j.error ?? '') + ' · ' + String(j.message ?? '').slice(0, 150));
    return j?.data?.loId ?? null;
  }
  const sauPhi = async (id) => Number((await db.query(
    'SELECT SUM(amount_after_fee)::text s FROM lo_rows WHERE lo_id=$1', [id])).rows[0].s);

  const loCu = await ghiBill(NGAY_CU, 8801);
  const loMoi = await ghiBill(NGAY_MOI, 8802);
  chot(!!loCu && !!loMoi, 'ghi được 2 bill: một TRƯỚC mốc (' + NGAY_CU + '), một SAU mốc (' + NGAY_MOI + ')');
  // DỪNG NGAY nếu dựng cảnh hỏng. Không dừng thì `truocMoi` = 0 ⇒ "phí đang dùng 100%" ⇒ cổng tự đặt giá
  // 99,5% và ĐI SỬA TIỀN CÁC LÔ THẬT trên DB thử (đã xảy ra: loDaSua=3). Cảnh hỏng thì báo hỏng, cấm đi tiếp.
  if (!loCu || !loMoi) throw new Error('dựng cảnh hỏng: không ghi được bill — xem dòng HỎNG ở trên');
  const truocCu = await sauPhi(loCu);
  const truocMoi = await sauPhi(loMoi);

  // Đặt giá bán MỚI KHÁC HẲN giá đang áp cho bill (đọc giá THẬT từ chính bill vừa ghi, không đoán theo
  // `tid_sell_fees` — kỳ hiệu lực có thể khác). Chênh đủ lớn để thấy rõ tiền đổi.
  const phiDangDung = (10_000_000 - truocMoi) / 10_000_000 * 100;
  if (!(phiDangDung > 0 && phiDangDung < 20)) {
    throw new Error('phí đang dùng ra số vô lý (' + phiDangDung.toFixed(3) + '%) — dừng, KHÔNG đặt giá bậy lên DB thử');
  }
  // CHẮC CHẮN KHÁC giá đang áp: phí thấp thì tăng, phí cao thì giảm. (Bài học 20/11: trừ dần 0,5% chạm sàn
  // 0,1% ⇒ lần chạy sau "giá mới" TRÙNG giá cũ ⇒ không có gì để tính lại ⇒ phép kiểm ghi-vết đỏ oan.)
  const giaMoi = phiDangDung < 1 ? Math.round((phiDangDung + 0.5) * 1000) / 1000
                                 : Math.round((phiDangDung - 0.5) * 1000) / 1000;
  const mongDoi = 10_000_000 - Math.round(10_000_000 * giaMoi / 100);
  console.log('      bill sau mốc đang chịu phí', phiDangDung.toFixed(3) + '%', '→ đặt giá mới', giaMoi + '%',
    '· nếu tính lại thì tiền sau phí phải thành', mongDoi);
  const r = await fetch(API + '/v1/tids/' + m.tid_id + '/sell-fees', {
    method: 'PUT', headers: H,
    body: JSON.stringify({ feeTypeId: m.fee_type_id, effectiveFrom: MOC, entries: [{ cardTypeId: m.card_type_id, phiBan: giaMoi }] })
  });
  const j = await r.json();
  console.log('      đặt giá', giaMoi + '% áp dụng từ', MOC, '→', r.status, JSON.stringify(j).slice(0, 140));
  chot(r.status === 200 && j.ok === true, 'lưu được giá bán kèm mốc áp dụng (' + r.status + ')');

  const sauCu = await sauPhi(loCu);
  const sauMoi = await sauPhi(loMoi);
  console.log('      bill TRƯỚC mốc: ' + truocCu + ' → ' + sauCu + ' | bill SAU mốc: ' + truocMoi + ' → ' + sauMoi);
  chot(sauMoi === mongDoi,
    'bill ghi SAU mốc ĐÃ được tính lại theo giá mới (' + truocMoi + ' → ' + sauMoi + ', mong đợi ' + mongDoi + ')');
  chot(sauCu === truocCu, 'ĐỐI CHỨNG: bill ghi TRƯỚC mốc GIỮ NGUYÊN (' + truocCu + ' → ' + sauCu + ')');

  // Ghi vết: tiền của bill đổi thì PHẢI có dấu vết dò lại được.
  const vet = (await db.query(
    `SELECT after_json FROM audit_logs WHERE action='LO_AMOUNT_RECALC' AND target_id=$1 ORDER BY id DESC LIMIT 1`,
    [String(loMoi)])).rows[0];
  console.log('      vết chỉnh tiền bill:', vet ? String(vet.after_json).slice(0, 120) : 'KHÔNG CÓ');
  chot(!!vet, 'có GHI VẾT việc chỉnh tiền bill (audit_logs · LO_AMOUNT_RECALC)');

  // Chạy LẠI đúng lệnh đó: số không được nhảy tiếp (idempotent) và không đẻ thêm vết.
  const soVetTruoc = Number((await db.query(
    `SELECT count(*)::text c FROM audit_logs WHERE action='LO_AMOUNT_RECALC' AND target_id=$1`, [String(loMoi)])).rows[0].c);
  await fetch(API + '/v1/tids/' + m.tid_id + '/sell-fees', {
    method: 'PUT', headers: H,
    body: JSON.stringify({ feeTypeId: m.fee_type_id, effectiveFrom: MOC, entries: [{ cardTypeId: m.card_type_id, phiBan: giaMoi }] })
  });
  const lan2 = await sauPhi(loMoi);
  const soVetSau = Number((await db.query(
    `SELECT count(*)::text c FROM audit_logs WHERE action='LO_AMOUNT_RECALC' AND target_id=$1`, [String(loMoi)])).rows[0].c);
  console.log('      chạy lại cùng lệnh → tiền', lan2, '· số vết', soVetTruoc, '→', soVetSau);
  chot(lan2 === mongDoi && soVetSau === soVetTruoc,
    'chạy LẠI cùng lệnh KHÔNG đổi số lần nữa và không đẻ thêm vết (idempotent)');

  // ── [B230 22/11 — Admin Demo "đang nhập ra sửa phí báo lỗi hệ thống"] ĐẶT GIÁ NGÀY LIỀN SAU NGÀY ĐÃ CÓ GIÁ ──
  // Ca thật trên sổ thật: khoá duy nhất tính theo NGÀY GIỜ VIỆT NAM, mà lệnh chèn qua Prisma bị lùi 7 tiếng
  // ⇒ 00:00 ngày D rơi về 17:00 ngày D−1 ⇒ đụng dòng giá ngày hôm trước ⇒ 500 "lỗi hệ thống".
  // Vừa đặt giá ở mốc MOC xong, nay đặt tiếp cho NGÀY LIỀN SAU — phải 200, không được 500.
  const homSau = ngay(3); // MOC = ngay(4) nên đây là ngày liền sau mốc vừa đặt
  const rSau = await fetch(API + '/v1/tids/' + m.tid_id + '/sell-fees', {
    method: 'PUT', headers: H,
    body: JSON.stringify({ feeTypeId: m.fee_type_id, effectiveFrom: homSau, entries: [{ cardTypeId: m.card_type_id, phiBan: Math.max(0.1, giaMoi - 0.05) }] })
  });
  const jSau = await rSau.json().catch(() => ({}));
  console.log('      đặt giá cho NGÀY LIỀN SAU (' + homSau + ') →', rSau.status, String(jSau.error ?? jSau.message ?? '').slice(0, 90));
  chot(rSau.status === 200, 'đặt giá cho NGÀY LIỀN SAU ngày đã có giá: KHÔNG còn "lỗi hệ thống" (' + rSau.status + ')');
  const ngaySong = (await db.query(
    `SELECT to_char(effective_from AT TIME ZONE 'Asia/Ho_Chi_Minh','YYYY-MM-DD') d FROM tid_sell_fees
      WHERE tid_id=$1 AND card_type_id=$2 AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`,
    [m.tid_id, m.card_type_id])).rows[0]?.d;
  console.log('      kỳ vừa tạo nằm ở ngày', ngaySong, '(mong đợi ' + homSau + ')');
  chot(ngaySong === homSau, 'kỳ vừa tạo nằm ĐÚNG ngày đã chọn, không bị lùi về hôm trước');

} catch (e) {
  // Dựng cảnh hỏng thì vẫn phải chạy hết phần dọn dẹp rồi THOÁT SẠCH mã 1 — ném thẳng ra ngoài làm Node
  // chết với mã lạ (0xC0000409), bảng tổng kết của cổng ship đọc ra số vô nghĩa.
  console.log('  ĐỎ  không chạy được phép kiểm: ' + e.message);
  so++; loi.push('không chạy được phép kiểm: ' + e.message);
} finally {
  for (const id of daTao) {
    await db.query(`DELETE FROM audit_logs WHERE action='LO_AMOUNT_RECALC' AND target_id=$1`, [String(id)]);
    const tx = (await db.query('SELECT transaction_id FROM los WHERE id=$1', [id])).rows[0]?.transaction_id;
    await db.query('DELETE FROM lo_rows WHERE lo_id=$1', [id]);
    await db.query('DELETE FROM los WHERE id=$1', [id]);
    if (tx) await db.query('DELETE FROM transactions WHERE id=$1', [tx]);
  }
  if (cu) {
    // Trả giá bán về NGUYÊN TRẠNG: xoá kỳ vừa tạo + hồi sinh kỳ bị xoá mềm (bài học 20/11: dọn thiếu
    // trạng thái xoá làm hỏng DB thử cho mọi bài kiểm sau).
    // TỪNG BƯỚC một có lưới: một bước ném lỗi mà làm NGẮT cả khối trả-nguyên-trạng thì DB thử ở lại trạng thái
    // hỏng, và lần chạy sau sẽ "chụp" chính trạng thái hỏng đó làm chuẩn ⇒ hỏng vĩnh viễn, cổng đỏ không rõ vì sao.
    // (Đã xảy ra 20/11: một lỗi tên biến trong khối này làm 15 kỳ giá bán nằm lại trạng thái xoá mềm.)
    const buoc = async (ten, fn) => { try { await fn(); } catch (e) { console.log('      [TRẢ NGUYÊN TRẠNG] HỎNG ' + ten + ': ' + e.message); loi.push('trả nguyên trạng hỏng: ' + ten); } };
    const giu = chup.map((x) => x.id);
    if (giu.length) await buoc('xoá kỳ mới sinh', () => db.query('DELETE FROM tid_sell_fees WHERE tid_id=$1 AND NOT (id = ANY($2::int[]))', [cu.tid_id, giu]));
    for (const x of chup) {
      await buoc('kỳ #' + x.id, () => db.query('UPDATE tid_sell_fees SET phi_ban=$2, effective_from=$3, deleted_at=$4 WHERE id=$1',
        [x.id, x.phi_ban, x.effective_from, x.deleted_at]));
    }
    // KHẲNG ĐỊNH đã trả xong: số kỳ CÒN SỐNG phải đúng như lúc chụp. Không khẳng định thì "đã dọn" chỉ là lời nói.
    const song = Number((await db.query('SELECT count(*)::text c FROM tid_sell_fees WHERE tid_id=$1 AND deleted_at IS NULL', [cu.tid_id])).rows[0].c);
    const songChup = chup.filter((x) => x.deleted_at === null).length;
    so++;
    if (song === songChup) console.log('  ĐẠT trả NGUYÊN TRẠNG giá bán đúng ' + song + ' kỳ còn sống');
    else { console.log('  ĐỎ  trả nguyên trạng LỆCH: còn sống ' + song + ', lúc chụp ' + songChup); loi.push('trả nguyên trạng lệch'); }
  }
  await db.query('DELETE FROM login_sessions WHERE device_info=$1', [NHAN]);
  console.log('      đã dọn', daTao.size, 'lô kiểm + trả giá bán về nguyên trạng');
  await db.end();
}

console.log('\n[gia-ban-moc] SO PHEP KIEM (dem dong) = ' + so + '/' + CAN);
if (so < CAN) { loi.push('THIEU PHEP KIEM: ' + so + '/' + CAN); console.log('  ĐỎ  đủ ' + CAN + ' phép kiểm phải CHẠY'); }
console.log(loi.length ? '[gia-ban-moc] ' + loi.length + ' ĐỎ: ' + loi.join(' | ') : '[gia-ban-moc] KHÔNG phép kiểm nào đỏ');
if (loi.length) process.exitCode = 1;
