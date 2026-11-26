// Bill tổng kết có dòng HỦY → doanh số ghi = tổng quẹt − hủy, và PHÍ tính trên số đã trừ.
//
// [CẬP NHẬT 18/9 — chính sách ĐÃ ĐỔI] Bản 17/9 của file này khẳng định "tách thẻ phải chia trên số ĐÃ TRỪ HỦY,
// khai theo tổng quẹt thì CHẶN". Admin Demo bác: "nó là hủy gd khác với ghi nhận tách thẻ trong 1 lô" — người review
// khai tách thẻ theo SỐ IN TRÊN BILL, tiền hủy là khoản riêng của tờ tổng kết. Luật cũ gây CHẶN GỬI OAN
// ("tổng tách thẻ 79.993.000 ≠ tổng bill 80.004.000"). Nay server tự trừ hủy khỏi dòng lớn nhất
// (chuanHoaSplitsTruHuy) — xem test/tach-the-va-huy-gd.test.ts.
//
// File này giữ phần KHÔNG đổi: công thức tiền ghi nhận. Bài học: test cũ tự định nghĩa lại logic trong chính nó
// nên vẫn xanh sau khi chính sách đảo — test phải gọi HÀM THẬT thì mới canh được code.
import { describe, expect, it } from 'vitest';
import { chuanHoaSplitsTruHuy, tienGhiNhan } from '../src/ocr-send-service.js';

const QUET = 109_613_000; // ca thật: lô 75, TID 67512805 (Nguyễn Duy Linh M2)
const HUY = 11_000;
const GHI = 109_602_000;

describe('tiền ghi nhận khi bill có GD hủy', () => {
  const bill = { totalAmount: QUET, voidAmount: HUY };

  it('tiền ghi nhận = tổng quẹt − hủy', () => {
    expect(tienGhiNhan(bill)).toBe(GHI);
  });

  it('bill KHÔNG hủy → ghi đúng tổng quẹt', () => {
    expect(tienGhiNhan({ totalAmount: QUET, voidAmount: 0 })).toBe(QUET);
    expect(tienGhiNhan({ totalAmount: QUET, voidAmount: null })).toBe(QUET);
  });

  it('hủy > tổng quẹt (OCR đọc lệch) → giữ nguyên tổng, KHÔNG ra số âm', () => {
    expect(tienGhiNhan({ totalAmount: 1_000_000, voidAmount: 5_000_000 })).toBe(1_000_000);
  });

  it('hủy âm / rác → bỏ qua', () => {
    expect(tienGhiNhan({ totalAmount: QUET, voidAmount: -5_000 })).toBe(QUET);
  });

  it('[luật MỚI] tách thẻ khai theo tổng quẹt được CHẤP NHẬN (không còn chặn oan)', () => {
    const r = chuanHoaSplitsTruHuy([{ cardTypeId: 21, amount: 100_000_000 }, { cardTypeId: 22, amount: 9_613_000 }], { totalAmount: QUET, voidAmount: HUY });
    expect(r).not.toBeNull();
    expect(r!.splits!.reduce((a, p) => a + p.amount, 0)).toBe(GHI);
  });
});
