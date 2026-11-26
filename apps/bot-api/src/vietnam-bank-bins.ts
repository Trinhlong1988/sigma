// SIGMA (21/8, Admin Demo "xây thật kỹ thư viện BIN ngân hàng Việt Nam, nghiên cứu sâu") — THƯ VIỆN BIN thẻ
// nội địa Napas (6 số đầu PAN, tiền tố 9704xx do NHNN/Napas cấp). Dùng để nhận diện thẻ trên bill quẹt: BIN →
// ngân hàng phát hành → so với ngân hàng của POS để tách on-us / ngoài-Napas (card-classify.ts).
//
// NGUỒN (đối chiếu, tra 21/8): danh sách BIN thẻ Napas công bố — VPBank "Danh sách đầu số thẻ ngân hàng"
//   https://www.vpbank.com.vn/bi-kip-va-chia-se/retail-story-and-tips/credit-card-category/so-the-ngan-hang
//   (57 tổ chức, khớp bảng Napas indovinabank/banks_napas_card). LƯU Ý BẢO TRÌ: (1) danh sách Napas đổi theo
//   thời gian (bank mới/đổi tên/sáp nhập) → RÀ SOÁT LẠI ĐỊNH KỲ từ napas.com.vn. (2) MỘT SỐ ngân hàng có NHIỀU
//   BIN (sản phẩm thẻ khác nhau) — bảng này giữ BIN thẻ chip nội địa CHÍNH; nếu gặp BIN 9704xx lạ không có ở đây
//   vẫn coi là "Napas nội địa" (isNapasBin) dù chưa map được tên. (3) MONEY: nhận diện BIN chỉ để PRE-CHỌN loại
//   thẻ (đại lý sửa được) — KHÔNG tự ghi tiền theo BIN.

export interface BankBinEntry {
  bin: string;   // 6 số
  short: string; // mã ngắn thông dụng
  name: string;  // tên đầy đủ
}

// Bảng BIN → ngân hàng (thẻ nội địa Napas). Sắp theo BIN.
export const VIETNAM_NAPAS_BINS: readonly BankBinEntry[] = [
  { bin: '970400', short: 'SGB', name: 'Ngân hàng TMCP Sài Gòn Công Thương (SaigonBank)' },
  { bin: '970403', short: 'STB', name: 'Ngân hàng TMCP Sài Gòn Thương Tín (Sacombank)' },
  { bin: '970405', short: 'AGRIBANK', name: 'Ngân hàng Nông nghiệp và Phát triển Nông thôn (Agribank)' },
  { bin: '970406', short: 'DAB', name: 'Ngân hàng TMCP Đông Á (DongA Bank)' },
  { bin: '970407', short: 'TCB', name: 'Ngân hàng TMCP Kỹ Thương (Techcombank)' },
  { bin: '970408', short: 'GPB', name: 'Ngân hàng Dầu Khí Toàn Cầu (GPBank)' },
  { bin: '970409', short: 'BAB', name: 'Ngân hàng TMCP Bắc Á (BacABank)' },
  { bin: '970410', short: 'SCVN', name: 'Standard Chartered Việt Nam' },
  { bin: '970412', short: 'PVCB', name: 'Ngân hàng TMCP Đại Chúng (PVcomBank)' },
  { bin: '970414', short: 'MBV', name: 'Ngân hàng Việt Nam Hiện Đại (MBV — OceanBank/Đại Dương cũ, đổi tên 18/12/2024, MB sở hữu 100%)' },
  { bin: '970415', short: 'CTG', name: 'Ngân hàng TMCP Công Thương (VietinBank)' },
  { bin: '970416', short: 'ACB', name: 'Ngân hàng TMCP Á Châu (ACB)' },
  { bin: '970418', short: 'BIDV', name: 'Ngân hàng Đầu tư và Phát triển (BIDV)' },
  { bin: '970419', short: 'NCB', name: 'Ngân hàng TMCP Quốc Dân (NCB)' },
  { bin: '970421', short: 'VRB', name: 'Ngân hàng Liên doanh Việt Nga (VRB)' },
  { bin: '970422', short: 'MB', name: 'Ngân hàng TMCP Quân Đội (MB / MBBank)' },
  { bin: '970423', short: 'TPB', name: 'Ngân hàng TMCP Tiên Phong (TPBank)' },
  { bin: '970424', short: 'SHBVN', name: 'Ngân hàng Shinhan Việt Nam' },
  { bin: '970425', short: 'ABB', name: 'Ngân hàng TMCP An Bình (ABBANK)' },
  { bin: '970426', short: 'MSB', name: 'Ngân hàng TMCP Hàng Hải (MSB)' },
  { bin: '970427', short: 'VAB', name: 'Ngân hàng TMCP Việt Á (VietABank)' },
  { bin: '970428', short: 'NAB', name: 'Ngân hàng TMCP Nam Á (Nam A Bank)' },
  { bin: '970429', short: 'SCB', name: 'Ngân hàng TMCP Sài Gòn (SCB)' },
  { bin: '970430', short: 'PGB', name: 'Ngân hàng Xăng dầu Petrolimex (PGBank)' },
  { bin: '970431', short: 'EIB', name: 'Ngân hàng TMCP Xuất Nhập khẩu (Eximbank)' },
  { bin: '970432', short: 'VPB', name: 'Ngân hàng TMCP Việt Nam Thịnh Vượng (VPBank)' },
  { bin: '970433', short: 'VBB', name: 'Ngân hàng TMCP Việt Nam Thương Tín (VietBank)' },
  { bin: '970434', short: 'IVB', name: 'Ngân hàng TNHH Indovina (IVB)' },
  { bin: '970436', short: 'VCB', name: 'Ngân hàng TMCP Ngoại thương (Vietcombank)' },
  { bin: '970437', short: 'HDB', name: 'Ngân hàng TMCP Phát triển TP.HCM (HDBank)' },
  { bin: '970438', short: 'BVBANK_BAOVIET', name: 'Ngân hàng TMCP Bảo Việt (BaoVietBank)' },
  { bin: '970439', short: 'PBVN', name: 'Ngân hàng Public Bank Việt Nam' },
  { bin: '970440', short: 'SEAB', name: 'Ngân hàng TMCP Đông Nam Á (SeABank)' },
  { bin: '970441', short: 'VIB', name: 'Ngân hàng TMCP Quốc Tế (VIB)' },
  { bin: '970442', short: 'HLB', name: 'Ngân hàng Hong Leong Việt Nam' },
  { bin: '970443', short: 'SHB', name: 'Ngân hàng TMCP Sài Gòn – Hà Nội (SHB)' },
  { bin: '970444', short: 'CBB', name: 'Ngân hàng Xây Dựng (CBBank)' },
  { bin: '970446', short: 'COOPBANK', name: 'Ngân hàng Hợp Tác Xã Việt Nam (Co-opBank)' },
  { bin: '970448', short: 'OCB', name: 'Ngân hàng TMCP Phương Đông (OCB)' },
  { bin: '970449', short: 'LPB', name: 'Ngân hàng Bưu Điện Liên Việt (LPBank)' },
  { bin: '970452', short: 'KLB', name: 'Ngân hàng TMCP Kiên Long (KienlongBank)' },
  { bin: '970454', short: 'BVB', name: 'Ngân hàng TMCP Bản Việt (BVBank / Viet Capital)' },
  { bin: '970455', short: 'IBK-HN', name: 'Industrial Bank of Korea - CN Hà Nội' },
  { bin: '970456', short: 'IBK-HCM', name: 'Industrial Bank of Korea - CN Hồ Chí Minh' },
  { bin: '970457', short: 'WOORI', name: 'Ngân hàng Woori Việt Nam' },
  { bin: '970458', short: 'UOB', name: 'Ngân hàng UOB Việt Nam' },
  { bin: '970459', short: 'CIMB', name: 'Ngân hàng CIMB Việt Nam' },
  { bin: '970460', short: 'CFC', name: 'Công ty Tài chính cổ phần Xi Măng' },
  { bin: '970462', short: 'KB-HN', name: 'Ngân hàng Kookmin - CN Hà Nội' },
  { bin: '970463', short: 'KB-HCM', name: 'Ngân hàng Kookmin - CN Hồ Chí Minh' },
  { bin: '970464', short: 'CCF', name: 'Công ty Tài chính TNHH MTV Cộng Đồng' },
  { bin: '970465', short: 'SINOPAC', name: 'Ngân hàng SINOPAC - CN Hồ Chí Minh' },
  { bin: '970466', short: 'KEBHANA-HCM', name: 'Ngân hàng KEB Hana - CN Hồ Chí Minh' },
  { bin: '970467', short: 'KEBHANA-HN', name: 'Ngân hàng KEB Hana - CN Hà Nội' },
  { bin: '970468', short: 'MIRAEASSET', name: 'Công ty Tài chính Mirae Asset (Việt Nam)' },
  { bin: '970469', short: 'EVNFC', name: 'Công ty Cổ phần Tài chính Điện lực (EVNFinance)' },
  { bin: '970470', short: 'MCREDIT', name: 'Công ty Tài chính TNHH MB SHINSEI (Mcredit)' }
];

const BIN_INDEX: ReadonlyMap<string, BankBinEntry> = new Map(VIETNAM_NAPAS_BINS.map((e) => [e.bin, e]));

/** Tra ngân hàng theo BIN 6 số. null nếu BIN không có trong thư viện (vẫn có thể là Napas 9704xx mới chưa map). */
export function lookupBankByBin(bin6: string | null | undefined): BankBinEntry | null {
  if (!bin6 || bin6.length < 6) return null;
  return BIN_INDEX.get(bin6.slice(0, 6)) ?? null;
}

/** BIN có thuộc dải thẻ nội địa Napas không (tiền tố 9704) — kể cả bank mới chưa có trong bảng tên. */
export function isNapasBin(bin6: string | null | undefined): boolean {
  return !!bin6 && /^9704\d{2}$/.test(bin6.slice(0, 6));
}
