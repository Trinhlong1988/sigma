// [Admin Demo 8/9 — "sao kê ACB đưa vào tra soát không được, lỗi đòi đọc MBV/MB" + "phân tích kỹ tránh nhầm người gửi
// người nhận, báo có và ghi nợ"] Regression dựng từ CHÍNH file thật `42227_SAOKE_TK_20260908-20260908.xlsx`
// (chủ TK NGUYEN VAN A · TK 42227 · ACB · 44 GD · tổng ra 3.215.148.999 / tổng vào 3.215.149.021 in trên file):
//   (1) ACB dùng nhãn cột KHÁC MB ("Số tiền rút ra"/"Số tiền gửi vào"/"Số GD") → parser cũ không thấy header ⇒ 0 GD.
//   (2) CHIỀU TIỀN: rút ra = NỢ (OUT) · gửi vào = CÓ (IN) — kiểm bằng chính số dư chạy trên file.
//   (3) NGƯỜI GỬI/NHẬN: ACB ghi ở NỘI DUNG tên NGƯỜI KHỞI TẠO (= chính chủ TK khi tiền RA) → CẤM dùng nội dung làm
//       "đối ứng"; nếu không, MỌI khoản hoàn đại lý ACB thành "Chuyển giữa TK" và biến mất khỏi tổng hoàn.
//   (4) "Số GD" của ACB chỉ là số đếm ngắn (3408) → phải gắn tiền tố bank+TK+ngày, nếu không sẽ ĐÈ giao dịch khác
//       trong cache (ref là khoá chính).
import { describe, it, expect } from 'vitest';
import { reconcileStatement, extractDescName, type ParsedStatement } from '../src/statement-recon.js';

function fakeDb() {
  return {
    // Đại lý Lộc SG nhận hoàn qua TK SHB 00281128 (đúng GD 08:15 trên file thật).
    chatMessage: { findMany: async () => [{ roomId: 'r1', metadataJson: '{"isDealerRefundCk":true,"receiverAcct":"00281128","receiverName":"KHACH HANG 27"}' }] },
    customerChatGroup: { findMany: async () => [{ roomId: 'r1', customerId: 99 }] },
    chatRoom: { findMany: async () => [{ id: 'r1', name: 'ĐL - Lộc SG' }] },
    // [14/10] Khách có NICKNAME = tên đại lý. Lớp chuẩn-hoá-tên 27/9 ("lại con 2 Đại lý C và ĐL Đại lý C") nay LUÔN
    // lấy tên chuẩn trong DB (nickname → fullName) khi đã có customerId, bất kể khớp bằng nguồn nào — để cùng 1
    // đại lý không tách 2 dòng trong sổ. Đời thật đại lý đều có nickname kiểu "ĐL- …", nên fixture phải giống.
    customer: { findMany: async () => [{ id: 99, fullName: 'Nguyen The Loc', nickname: 'ĐL - Lộc SG' }] },
    investor: { findMany: async () => [{ id: 15, fullName: 'Nguyen Van Thong', nickname: 'NĐT 2' }] },
    // TK uỷ của NĐT Thông mang tên KHACH HANG 02 (đúng dữ liệu thật).
    receiveAccount: { findMany: async () => [{ accountNumber: '50704397', accountName: 'KHACH HANG 02', investorId: 15 }] },
    $queryRawUnsafe: async () => []
  } as unknown as Parameters<typeof reconcileStatement>[0];
}

/** 3 GD thật của file ACB (đủ 3 tình huống): tiền vào từ NĐT · tiền ra hoàn đại lý · chuyển nội bộ cho KT Demo. */
function acbParsed(coCotDoiUng: boolean): ParsedStatement {
  const cp = (name: string, acct: string, bank: string) => coCotDoiUng ? { cpName: name, cpAccount: acct, cpBank: bank } : { cpName: null, cpAccount: null, cpBank: null };
  return {
    accountHolder: 'NGUYEN VAN A', accountNumber: '42227', accountBank: 'ACB',
    txns: [
      { rowIndex: 9, dateTime: '2026-09-08T08:14:00', ref: 'ACB-42227-2026-09-08-3408', debit: 0, credit: 500000001,
        desc: 'IB KHACH HANG 02 CHUYEN KHOAN', descName: extractDescName('IB KHACH HANG 02 CHUYEN KHOAN'), ...cp('KHACH HANG 02', '50704397', 'ACB - NH TMCP A CHAU') },
      { rowIndex: 10, dateTime: '2026-09-08T08:15:00', ref: 'ACB-42227-2026-09-08-3409', debit: 16155000, credit: 0,
        desc: 'NGUYEN VAN A CHUYEN KHOAN NHANH QUA ZALO-080926-08:15:22 6251ASCB024PZXB9', descName: extractDescName('NGUYEN VAN A CHUYEN KHOAN NHANH QUA ZALO-080926-08:15:22'), ...cp('KHACH HANG 27', '00281128', 'SHB - NH TMCP Sai Gon Ha Noi') },
      { rowIndex: 52, dateTime: '2026-09-08T11:12:00', ref: 'ACB-42227-2026-09-08-3451', debit: 1233000, credit: 0,
        desc: 'NGUYEN VAN A CHUYEN KHOAN-080926-11:12:36', descName: extractDescName('NGUYEN VAN A CHUYEN KHOAN-080926-11:12:36'), ...cp('KHACH HANG 01', 'VQRQAIUIF6322', 'MB Bank - NH TMCP Quan Doi') }
    ]
  };
}

describe('sao kê ACB — chiều tiền + người gửi/người nhận', () => {
  it('tiền VÀO từ TK uỷ NĐT (KHACH HANG 02) = TẠM ỨNG NĐT, KHÔNG phải hoàn đại lý', async () => {
    const r = await reconcileStatement(fakeDb(), acbParsed(true));
    expect(r.txns[0].direction).toBe('IN');
    expect(r.txns[0].kind).toBe('INVESTOR_ADVANCE');
    expect(r.txns[0].matchedName).toBe('NĐT 2');
  });

  it('tiền RA cho đại lý = HOÀN ĐẠI LÝ — dù nội dung ghi tên CHÍNH CHỦ ("NGUYEN VAN A")', async () => {
    const r = await reconcileStatement(fakeDb(), acbParsed(true));
    expect(r.txns[1].direction).toBe('OUT');
    expect(r.txns[1].kind).toBe('DEALER_REFUND'); // trước fix: TRANSFER (mất sạch khoản hoàn)
    // Tên hiển thị = TÊN CHUẨN của khách trong DB (nickname) — không phải tên trên bill ("KHACH HANG 27") cũng
    // không phải tên gõ tay: cùng 1 đại lý ⇒ đúng 1 tên trong sổ (luật chuẩn-hoá 27/9).
    expect(r.txns[1].matchedName).toBe('ĐL - Lộc SG');
    expect(r.totals.hoanDaiLy).toBe(16155000);
  });

  it('tiền RA cho TK SigMa (Nhân viên B) vẫn = CHUYỂN GIỮA TK, không tính vào hoàn đại lý', async () => {
    const r = await reconcileStatement(fakeDb(), acbParsed(true));
    expect(r.txns[2].kind).toBe('TRANSFER');
    expect(r.totals.hoanDaiLy).toBe(16155000);
  });

  it('THIẾU cột đối ứng: mọi lệnh RA rơi về "chuyển nội bộ" → phải phát hiện được (route chặn upload)', async () => {
    const r = await reconcileStatement(fakeDb(), acbParsed(false));
    expect(r.totals.hoanDaiLy).toBe(0); // đúng hiện trạng nguy hiểm → lý do vì sao route CHẶN file thiếu cột
    expect(r.txns[1].kind).toBe('TRANSFER');
    expect(r.txns[0].kind).toBe('INVESTOR_ADVANCE'); // tiền VÀO vẫn khớp được qua nội dung
  });

  it('tên trong nội dung ACB bỏ tiền tố kênh "IB" để khớp đúng NĐT', () => {
    expect(extractDescName('IB KHACH HANG 02 CHUYEN KHOAN')).toBe('KHACH HANG 02');
    expect(extractDescName('NGUYEN VAN A CHUYEN KHOAN NHANH QUA ZALO-080926-08:15:22')).toBe('NGUYEN VAN A');
  });
});
