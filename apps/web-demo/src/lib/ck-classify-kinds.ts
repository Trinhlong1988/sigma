// DANH SÁCH PHÂN LOẠI BILL CHUYỂN KHOẢN (màn "Quét bill gửi" → thẻ bill CK → "Chưa phân loại được — CHỌN TAY").
//
// `key`       = mục người dùng CHỌN trên giao diện.
// `direction` = hướng GỬI LÊN SERVER (enum của sendTransferByDirection, bot-api/src/ocr-send-service.ts) — quyết
//               định TIỀN ghi thế nào. NHIỀU mục giao diện được phép dùng CHUNG 1 hướng.
// `party`     = phía lấy tên/STK để HỌC ALIAS (lần sau tự nhận): 'sender' = người gửi, 'receiver' = người nhận.
//
// [Admin Demo 10/9] "chọn phân loại bill CK thêm trường ĐẠI LÝ HOÀN BILL CK THỪA": engine ĐÃ có sẵn hướng này —
// `DEALER_TO_ALPHA` ghi số ÂM và đăng caption "↩️ ĐẠI LÝ HOÀN THỪA VỀ SIGMA" — nhưng danh sách chọn chỉ ghi mỗi
// "Đại lý hoàn ứng" nên không ai chọn đúng việc. Nay tách 2 mục CHỮ khác nhau, ĐI CHUNG 1 hướng ⇒ tiền ghi Y HỆT
// (cùng ÂM, cùng pool đối soát hoàn/ứng). Muốn BÁO CÁO TÁCH RIÊNG 2 loại này thì phải thêm hướng mới ở server +
// cột trong DB — CHƯA làm, không tự ý đụng tiền.
export type HuongGuiCk = 'SIGMA_TO_DEALER' | 'SIGMA_TO_DEALER_ADVANCE' | 'DEALER_TO_ALPHA' | 'INVESTOR_TO_ALPHA' | 'SIGMA_TO_INVESTOR';

/** Đúng 5 hướng server xử lý (mirror THỦ CÔNG của switch trong sendTransferByDirection — test khoá). */
export const HUONG_SERVER_HOP_LE: readonly HuongGuiCk[] = ['SIGMA_TO_DEALER', 'SIGMA_TO_DEALER_ADVANCE', 'DEALER_TO_ALPHA', 'INVESTOR_TO_ALPHA', 'SIGMA_TO_INVESTOR'];

export interface MucPhanLoaiCk {
  key: string;
  direction: HuongGuiCk;
  label: string;
  entityType: 'DEALER' | 'INVESTOR';
  party: 'sender' | 'receiver';
}

export const KINDS_CK: readonly MucPhanLoaiCk[] = [
  { key: 'SIGMA_TO_DEALER', direction: 'SIGMA_TO_DEALER', label: 'Hoàn tiền đại lý', entityType: 'DEALER', party: 'receiver' },
  { key: 'SIGMA_TO_DEALER_ADVANCE', direction: 'SIGMA_TO_DEALER_ADVANCE', label: 'Đại lý ứng trước (SigMa → đại lý)', entityType: 'DEALER', party: 'receiver' },
  { key: 'DEALER_TO_ALPHA', direction: 'DEALER_TO_ALPHA', label: 'Đại lý hoàn ứng (đại lý → SigMa)', entityType: 'DEALER', party: 'sender' },
  { key: 'DEALER_TO_SIGMA_EXCESS', direction: 'DEALER_TO_ALPHA', label: 'Đại lý hoàn bill CK THỪA (đại lý → SigMa)', entityType: 'DEALER', party: 'sender' },
  { key: 'INVESTOR_TO_ALPHA', direction: 'INVESTOR_TO_ALPHA', label: 'Tạm ứng NĐT', entityType: 'INVESTOR', party: 'sender' },
  { key: 'SIGMA_TO_INVESTOR', direction: 'SIGMA_TO_INVESTOR', label: 'Hoàn thừa tạm ứng (SigMa → NĐT)', entityType: 'INVESTOR', party: 'receiver' }
];
