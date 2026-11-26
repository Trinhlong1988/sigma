// NHÃN NGÂN HÀNG DÙNG CHUNG (Admin Demo 16/11: "tất cả hiển thị viết tắt của bank ở tất cả các trường,
// không full tên").
//
// Trên sổ, `banks.name` là TÊN PHÁP NHÂN dài ("NH TNHH MTV Việt Nam Hiện đại MBV") còn `banks.code` là MÃ
// VIẾT TẮT đúng cái người làm việc đọc hằng ngày (MBV · MB · ABB · VP…). Mọi chỗ HIỂN THỊ phải dùng mã;
// tên dài làm vỡ cột bảng và che mất thông tin bên cạnh.
//
// CÓ MỘT CHỖ DÙNG ĐÚNG — không phải chỉ cho đẹp: `ca-tien.ts` tra bảng mốc ca tiền về theo khoá MB/ABB/MBV.
// Đo thật 16/11: đưa TÊN DÀI vào `khoaBankCa` ⇒ trả `null` cho CẢ BA ngân hàng ⇒ ca không xếp được.
// Đưa MÃ vào thì khớp ngay. Vì vậy mã viết tắt là nguồn hiển thị VÀ là nguồn tra ca.
export function nhanBank(b: { code?: string | null; name?: string | null } | null | undefined): string | null {
  if (!b) return null;
  const ma = (b.code ?? '').trim();
  if (ma) return ma;
  const ten = (b.name ?? '').trim();
  return ten || null;
}
