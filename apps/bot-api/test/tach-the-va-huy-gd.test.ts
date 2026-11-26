// [Admin Demo 18/9 — ca THẬT] "Lỗi: Phí bán: tổng tách thẻ (79.993.000) ≠ tổng bill (80.004.000) … điền tiền hủy
// nhưng phí và số tiền OCR chưa thay đổi, chưa được ghi nhận lại" + làm rõ: "nó là hủy gd KHÁC với ghi nhận tách
// thẻ trong 1 lô".
//
// Chênh đúng 11.000 = tiền hủy. Sai ở CHỖ NGHĨ: bản 17/9 bắt người review tự trừ tiền hủy vào một thẻ khi tách
// (Σ dòng phải = tổng quẹt − hủy) → gửi bill bị CHẶN OAN. Nhưng người review khai tách thẻ theo SỐ IN TRÊN BILL;
// giao dịch hủy là khoản riêng của tờ tổng kết, không thuộc việc chia thẻ.
//
// Luật đúng: nhận cả hai cách khai, server tự trừ hủy khỏi dòng lớn nhất, và PHÍ tính trên số ghi nhận.
import { describe, expect, it } from 'vitest';
import { chuanHoaSplitsTruHuy, tienGhiNhan } from '../src/ocr-send-service.js';

const QUET = 80_004_000;
const HUY = 11_000;
const GHI = 79_993_000;
const bill = { totalAmount: QUET, voidAmount: HUY };

describe('tách thẻ + giao dịch hủy (ca 80.004.000 / 79.993.000)', () => {
  it('tiền ghi nhận = quẹt − hủy', () => {
    expect(tienGhiNhan(bill)).toBe(GHI);
  });

  it('khai theo BILL (Σ = tổng quẹt) → KHÔNG chặn, hệ tự trừ hủy khỏi dòng LỚN NHẤT', () => {
    const r = chuanHoaSplitsTruHuy([{ cardTypeId: 15, amount: 50_004_000 }, { cardTypeId: 16, amount: 30_000_000 }], bill);
    expect(r).not.toBeNull();
    const tong = r!.splits!.reduce((a, p) => a + p.amount, 0);
    expect(tong).toBe(GHI);
    expect(r!.splits![0].amount).toBe(50_004_000 - HUY); // dòng lớn nhất chịu phần hủy
    expect(r!.splits![1].amount).toBe(30_000_000);       // dòng còn lại GIỮ NGUYÊN
    expect(r!.ghiChu).toContain('11.000');
  });

  it('dòng lớn nhất không phải dòng đầu → vẫn trừ đúng dòng lớn nhất', () => {
    const r = chuanHoaSplitsTruHuy([{ cardTypeId: 15, amount: 20_000_000 }, { cardTypeId: 16, amount: 60_004_000 }], bill);
    expect(r!.splits![0].amount).toBe(20_000_000);
    expect(r!.splits![1].amount).toBe(60_004_000 - HUY);
  });

  it('người dùng ĐÃ tự trừ (Σ = số ghi nhận) → giữ nguyên, không trừ hai lần', () => {
    const r = chuanHoaSplitsTruHuy([{ cardTypeId: 15, amount: 49_993_000 }, { cardTypeId: 16, amount: 30_000_000 }], bill);
    expect(r!.splits!.reduce((a, p) => a + p.amount, 0)).toBe(GHI);
    expect(r!.ghiChu).toBeNull();
  });

  it('bill KHÔNG hủy → không đụng gì vào các dòng', () => {
    const b0 = { totalAmount: QUET, voidAmount: 0 };
    const sp = [{ cardTypeId: 15, amount: 50_004_000 }, { cardTypeId: 16, amount: 30_000_000 }];
    const r = chuanHoaSplitsTruHuy(sp, b0);
    expect(r!.splits).toEqual(sp);
    expect(r!.ghiChu).toBeNull();
  });

  it('khai LỆCH thật (không bằng quẹt, cũng không bằng ghi nhận) → trả null để chặn', () => {
    expect(chuanHoaSplitsTruHuy([{ cardTypeId: 15, amount: 10_000_000 }], bill)).toBeNull();
  });

  it('tiền hủy lớn hơn cả dòng lớn nhất → trả null (số vô lý, không ghi bừa)', () => {
    const b = { totalAmount: 100_000, voidAmount: 90_000 };
    expect(chuanHoaSplitsTruHuy([{ cardTypeId: 15, amount: 60_000 }, { cardTypeId: 16, amount: 40_000 }], b)).toBeNull();
  });

  it('không tách thẻ → trả về nguyên trạng (nhánh thường không bị ảnh hưởng)', () => {
    expect(chuanHoaSplitsTruHuy(undefined, bill)).toEqual({ splits: undefined, ghiChu: null });
  });
});
