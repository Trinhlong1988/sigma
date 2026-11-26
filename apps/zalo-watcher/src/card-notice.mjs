// THÔNG BÁO GIAO DỊCH THẺ → hàng bill QR "chưa biết HKD" (Admin Demo 10/9).
//
// Ảnh loại này là email/SMS NGÂN HÀNG GỬI CHỦ THẺ (vd "Thông báo giao dịch VIB One Card"): có TIỀN + GIỜ + TÊN CHỦ
// THẺ + 4 số cuối thẻ, nhưng KHÔNG có tên HKD và KHÔNG có Số giao dịch. Vì bộ lọc bill QR đòi tiền + (tên HKD | số
// GD) nên ảnh này bị vứt CÂM ("gửi bill mà không OCR ra"). Cách xử lý ĐÚNG (Admin Demo chốt): nhận ảnh, để trống phần
// định danh cửa hàng, rồi ĐỐI SOÁT BÁO-CÓ (tiền đúng tuyệt đối + giờ ±cửa sổ + tên người quẹt) để suy ra mã QR /
// HKD / Số giao dịch — khớp DUY NHẤT mới nhận, còn lại bắt kiểm tay. Module THUẦN để test.

/** Gộp khoảng trắng + bỏ 2 đầu. '' → null. */
function gon(v) {
  const t = String(v ?? '').replace(/\s+/g, ' ').trim();
  return t || null;
}

/** "10,500,000 VND" → 10500000. Không có chữ số → 0. */
export function tienTuChuoi(v) {
  const so = String(v ?? '').replace(/[^0-9]/g, '');
  return so ? Number(so) : 0;
}

/** Mô tả thẻ khách để hiện ở ô "Từ": "VIB ••••9742" (thiếu phần nào bỏ phần đó). */
export function moTaThe(bank, last4) {
  const b = gon(bank);
  const l = String(last4 ?? '').replace(/[^0-9]/g, '').slice(-4);
  if (b && l) return `${b} ••••${l}`;
  if (l) return `••••${l}`;
  return b;
}

/**
 * Đổi danh sách `cardNotice` (OCR trả) sang hàng bill QR dùng chung đường review/gửi/ghi doanh số.
 * hkdName + ref để NULL — CHỈ báo-có mới được quyền điền (server), tuyệt đối không đoán ở đây.
 * Bỏ hàng không có tiền (>0) — không có tiền thì không đối soát được gì.
 */
export function mapThongBaoTheSangQr(rows) {
  return (Array.isArray(rows) ? rows : [])
    .map((n) => ({
      hkdName: null,
      amount: tienTuChuoi(n?.amount),
      date: gon(n?.date),
      time: gon(n?.time),
      ref: null,
      fromCard: moTaThe(n?.bank, n?.cardLast4),
      /** Tên CHỦ THẺ = tên người quẹt để khớp báo-có (payer_name của DigiStore cũng là tên không dấu). */
      payerName: gon(n?.cardHolder),
      /** Nơi quẹt in trên thông báo (vd "VIB QR PUSH") — chỉ để người duyệt đối chiếu, KHÔNG dùng khớp mã. */
      noticeMerchant: gon(n?.merchantHint),
      /** CỜ: bill đến từ THÔNG BÁO GIAO DỊCH THẺ → thiếu HKD/số GD là BÌNH THƯỜNG, phải khớp báo-có mới gửi được. */
      noticeOnly: true
    }))
    .filter((q) => q.amount > 0);
}
