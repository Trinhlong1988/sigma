// POLL BÁO-CÓ PaySmart cho MỌI mã QR có cred trong `qr_paysmart_cred` → đổ vào cache CHUNG digistore_baoco
// (source_tid_id = mã nguồn) để hệ đối soát QR sẵn có (reviewQr phân-mã theo báo-có + reconcile) tự nhặt.
//
// [Admin Demo 11/9] bản đầu: ĐÓNG CỨNG 1 mã (TID_ID=187 HKD DEMOMAY) — tên HKD viết thẳng trong code.
// [Admin Demo 14/10] mở ra NHIỀU mã (thêm merchant DEMO-MERCHANT-02 "001_HKD KHACH HANG 64"): mỗi dòng cred = 1 mã, tên HKD
//   LẤY TỪ DB (`tids.hkd_name`) — cấm hard-code tên vì sai tên = báo-có gán nhầm nhà. Mỗi mã login RIÊNG, chạy
//   LẦN LƯỢT (không song song: 2 browser login cùng lúc đúng là nguy cơ khoá tài khoản mà refreshGate sinh ra để chặn).
// [Admin Demo 14/10] GIỮ PHIÊN (cookie) để lượt sau khỏi đăng nhập lại — toàn bộ việc vào cổng nằm ở
//   `src/paysmart-phien.ts`, DÙNG CHUNG với script tra cứu. Không chép code login thành bản thứ hai (repo đã dính
//   bài học "bản copy ở nhiều nơi": sửa chỗ này quên chỗ kia, lớp đang chạy live lại là bản chưa sửa).
//
// Hợp lệ: merchant của chính HKD, chỉ ĐỌC báo-có để đối soát — song song DigiStore.
//
// R198 — CẤM nuốt lỗi: 1 mã chết KHÔNG được làm im cả lượt. Mỗi mã in 1 dòng kết quả; cuối in dòng `KETQUA`
// (naped/ok/tổng) + 1 dòng `LOIMA` cho TỪNG mã lỗi (route đọc để banner nói đúng TÊN mã nào thiếu dữ liệu);
// exit code 1 nếu CÓ mã lỗi (mã chạy được vẫn đã nạp xong, không roll back).
//
// Chạy 1 lượt mọi mã:      npx tsx scripts/paysmart-poll.mts
// Chạy riêng vài mã:       PAYSMART_TID_IDS=187,206 npx tsx scripts/paysmart-poll.mts
import 'dotenv/config';
import { chromium, type Browser } from 'playwright';
import { upsertBaoCoRows } from '../src/digistore-reconcile.js';
import { getBotDb } from '../src/db.js';
import {
  voiTrangDanhSach, bocDanhSach, laGdQr, laThanhCong, type CredPaySmart, type DuongVao
} from '../src/paysmart-phien.js';

type Db = ReturnType<typeof getBotDb>;

interface Cred extends CredPaySmart {
  hkd_name: string | null;
}

interface KetQuaMa {
  tidId: number;
  tenHkd: string;
  ok: boolean;
  naped: number;
  duong?: DuongVao;
  loi?: string;
}

/** "dd/MM/yyyy HH:mm:ss" (giờ HCM) → epoch ms. */
function parseHcm(s: string): number | null {
  const m = /(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/.exec(s ?? '');
  if (!m) return null;
  return Date.parse(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}+07:00`);
}

/**
 * CHỐNG GÁN NHẦM NHÀ: `digistore_baoco` khoá theo `bill_id` (ON CONFLICT bill_id DO UPDATE ... source_tid_id =
 * EXCLUDED). Một mã thứ hai trên CÙNG nền tảng PaySmart mà trùng `transId` với mã cũ sẽ ÂM THẦM kéo báo-có của
 * nhà kia sang nhà mình (đúng lớp sự cố "lô mượn TID ghi chủ máy"). Nên trước khi upsert: bill_id nào đã tồn tại
 * với source_tid_id KHÁC thì KHÔNG ghi + báo lỗi tường minh cho LEAD xử tay.
 */
async function locBillDaThuocMaKhac(
  db: Db, tidId: number, billIds: string[]
): Promise<{ dungMa: Set<string>; dungCuaMaKhac: Array<{ billId: string; cuaTid: number }> }> {
  const dungCuaMaKhac: Array<{ billId: string; cuaTid: number }> = [];
  const dungMa = new Set(billIds);
  if (!billIds.length) return { dungMa, dungCuaMaKhac };
  const rows = await db.$queryRawUnsafe<Array<{ bill_id: string; source_tid_id: number | null }>>(
    `SELECT bill_id, source_tid_id FROM digistore_baoco WHERE bill_id = ANY($1::text[])`, billIds);
  for (const r of rows) {
    if (r.source_tid_id != null && Number(r.source_tid_id) !== tidId) {
      dungCuaMaKhac.push({ billId: r.bill_id, cuaTid: Number(r.source_tid_id) });
      dungMa.delete(r.bill_id);
    }
  }
  return { dungMa, dungCuaMaKhac };
}

/** Kéo báo-có của MỘT mã. Không ném: mọi lỗi gói vào KetQuaMa để lượt còn lại vẫn chạy. */
async function keoMotMa(browser: Browser, db: Db, cred: Cred): Promise<KetQuaMa> {
  const tidId = cred.tid_id;
  const tenHkd = (cred.hkd_name ?? '').trim();
  const kq = (p: Partial<KetQuaMa>): KetQuaMa => ({ tidId, tenHkd, ok: false, naped: 0, ...p });
  // Tên HKD là thứ ĐI VÀO từng dòng báo-có (cột hkd_name) → thiếu tên thì DỪNG mã này, cấm ghi tên rỗng/đoán.
  if (!tenHkd) return kq({ loi: `mã ${tidId} chưa có tên HKD trong bảng tids — cấm ghi báo-có tên rỗng` });

  const mo = await voiTrangDanhSach(browser, db, cred, async (t) => t.rawDauTien);
  if (!mo.ok) return kq({ loi: mo.loi, duong: mo.duong });
  const duong = mo.duong;
  const baoCoRaw = mo.ketQua;
  if (!baoCoRaw) return kq({ duong, loi: 'không bắt được danh sách báo-có (API management-transaction/list không trả về)' });

  let list: Record<string, unknown>[];
  try {
    list = bocDanhSach(baoCoRaw);
  } catch (e) {
    return kq({ duong, loi: `không đọc được JSON danh sách báo-có: ${e instanceof Error ? e.message : String(e)}` });
  }

  // [14/10 — SỰ CỐ BẮT ĐƯỢC NGAY LƯỢT ĐẦU mã 206] Bản cũ nạp SẠCH mọi dòng cổng trả về. Sai 2 nước:
  //
  //  (1) TRẠNG THÁI: PaySmart trả `status` là SỐ kèm `statusName`. Đọc từ chính ô lọc của cổng: 3 = "Thành công"
  //      · 2 = "Thất bại" (còn "Đang xử lý" / "Hủy"). Mã DEMOMAY xưa nay 78/78 dòng đều status 3 nên lỗi nằm im;
  //      mã Minh Hằng có ngay 2 giao dịch THẤT BẠI 7.994.000đ ⇒ không lọc là đưa 15.988.000đ tiền KHÔNG VỀ vào
  //      cache báo-có như tiền thật. CHỈ nạp status = 3.
  //
  //  (2) LOẠI GIAO DỊCH: merchant PaySmart có thể vừa có QR vừa có MÁY POS.
  //      · `SCAN_TO_PAY*` = khách quét QR → ĐÚNG thứ cache `digistore_baoco` sinh ra để đối soát.
  //      · `CARD_PAYMENT_POS` = quẹt thẻ qua máy SmartPOS (TID máy riêng, vd R9982855) → doanh số POS đi đường
  //        TID; nhét vào cache QR là nguy cơ ĐẾM TIỀN HAI LẦN. [Admin Demo 14/10] "không đưa, chỉ để tra" ⇒ KHÔNG
  //        nạp, nhưng phải ĐẾM VÀ BÁO RÕ số bỏ qua (bỏ im = sau này thiếu tiền không ai biết vì sao). Cần xem
  //        thì dùng `scripts/tra-gd-paysmart.mts` (tra cứu, không ghi gì vào hệ).
  //      Đã kiểm chứng lọc này KHÔNG cắt nhầm mã cũ: 78/78 giao dịch DEMOMAY kỳ 9-25/9 đều SCAN_TO_PAY_PUSH status 3.
  //
  //  (3) TÊN NGƯỜI TRẢ nằm ở trường KHÁC NHAU theo loại: QR → `sofSubName`; POS → `cardHolderName`. Luật ghép
  //      bill↔báo-có dùng tên người quẹt nên thiếu tên là ghép hụt.
  const boPos = list.filter((t) => !laGdQr(t));
  const boHong = list.filter((t) => laGdQr(t) && !laThanhCong(t));
  const txns = list.filter((t) => laGdQr(t) && laThanhCong(t)).map((t) => ({
    billId: String(t['transId'] ?? t['partnerTransId'] ?? t['rrn'] ?? ''),
    qrCode: 'PAYSMART',
    hkdName: tenHkd,
    amount: Number(t['amount'] ?? 0),
    payerName: (t['sofSubName'] ?? t['sofSub'] ?? t['cardHolderName'] ?? null) as string | null,
    externalRefNo: String(t['transId'] ?? t['partnerTransId'] ?? ''),
    description: null,
    atMs: parseHcm(String(t['transDate'] ?? '')),
    status: String(t['statusName'] ?? t['status'] ?? 'success'),
    sourceTidId: tidId
  })).filter((t) => t.billId && t.amount > 0);
  if (boPos.length || boHong.length) {
    const tien = (ds: Record<string, unknown>[]): string => ds.reduce((x, t) => x + Number(t['amount'] ?? 0), 0).toLocaleString('vi-VN');
    console.log(`[paysmart] · mã ${tidId}: BỎ QUA ${boPos.length} giao dịch QUẸT THẺ POS (${tien(boPos)}đ — doanh số POS đi theo TID máy, không phải báo-có QR)` +
      (boHong.length ? ` · BỎ QUA ${boHong.length} giao dịch QR KHÔNG thành công (${tien(boHong)}đ)` : ''));
  }

  const { dungMa, dungCuaMaKhac } = await locBillDaThuocMaKhac(db, tidId, txns.map((t) => t.billId));
  const sach = txns.filter((t) => dungMa.has(t.billId));
  await upsertBaoCoRows(db, sach);
  if (dungCuaMaKhac.length) {
    return kq({
      naped: sach.length, duong,
      loi: `${dungCuaMaKhac.length} báo-có TRÙNG mã giao dịch với mã QR khác (${dungCuaMaKhac.slice(0, 3).map((x) => `${x.billId}→tid ${x.cuaTid}`).join(', ')}) — ĐÃ BỎ QUA để không gán nhầm nhà, cần LEAD kiểm tay`
    });
  }
  return kq({ ok: true, naped: sach.length, duong });
}

async function main(): Promise<void> {
  const db = getBotDb();
  const loc = (process.env['PAYSMART_TID_IDS'] ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
  const creds = await db.$queryRawUnsafe<Cred[]>(
    `SELECT c.tid_id, c.username, c.password_enc, c.totp_secret_enc, c.session_enc, t.hkd_name
       FROM qr_paysmart_cred c LEFT JOIN tids t ON t.id = c.tid_id
      ${loc.length ? `WHERE c.tid_id = ANY($1::int[])` : ''}
      ORDER BY c.tid_id`, ...(loc.length ? [loc] : []));
  if (!creds.length) {
    console.error(`[paysmart] ❌ không có mã nào có cred${loc.length ? ` trong danh sách ${loc.join(',')}` : ''}`);
    process.exit(1);
  }

  const browser = await chromium.launch();
  const ketQua: KetQuaMa[] = [];
  try {
    for (const c of creds) {
      const r = await keoMotMa(browser, db, c);
      ketQua.push(r);
      const nhanDuong = r.duong === 'phien' ? 'dùng lại phiên cũ'
        : r.duong === 'phien-het-login-lai' ? 'phiên cũ hết hạn → đăng nhập lại'
          : 'đăng nhập mới';
      console.log(r.ok
        ? `[paysmart] ✓ mã ${r.tidId} (${r.tenHkd}): nạp ${r.naped} báo-có · ${nhanDuong}`
        : `[paysmart] ✗ mã ${r.tidId} (${r.tenHkd || 'chưa có tên'}): ${r.loi}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }

  const loi = ketQua.filter((r) => !r.ok);
  const tong = ketQua.reduce((s, r) => s + r.naped, 0);
  // Dòng TỔNG giữ đúng khuôn chữ "nạp <N> báo-có" để tương thích cách đọc cũ của route.
  console.log(`[paysmart] ${loi.length ? '⚠' : '✅'} TỔNG nạp ${tong} báo-có (${ketQua.length - loi.length}/${ketQua.length} mã OK)`);
  console.log(`[paysmart] KETQUA naped=${tong} ok=${ketQua.length - loi.length}/${ketQua.length}`);
  for (const r of loi) console.log(`[paysmart] LOIMA tid=${r.tidId} ten=${r.tenHkd || '?'} ly=${(r.loi ?? 'lỗi không rõ').replace(/[\r\n]+/g, ' ')}`);
  process.exit(loi.length ? 1 : 0);
}
void main();
