import { describe, it, expect } from 'vitest';
import {
  checkLoNumberReuse,
  checkLoNumberSequence,
  checkMaxAmountPerSwipe,
  checkMaxDailyTotalPerTid,
  checkMaxSwipesPerDayPerCard,
  checkMinGapBetweenSwipes,
  checkReceiptNumberSequence,
  checkRepeatedAmountNearby,
  checkRoundAmount,
  detectDuplicateBills,
  isSameLocalDay,
  maskCardLast4,
  triangulateMismatch,
  type LoBillFingerprint
} from './sigma-fraud-rules.js';

// Helper dựng fingerprint bill cho test Rule G (mặc định isNew=true = bill batch hiện tại).
function fp(o: { receiptNumber?: number | null; ocrAmount?: number; swipeAt: Date; cardLast4?: string | null; isNew?: boolean }): LoBillFingerprint {
  return {
    receiptNumber: o.receiptNumber ?? null,
    ocrAmount: o.ocrAmount ?? 1_000_000,
    swipeAt: o.swipeAt,
    cardLast4: o.cardLast4 ?? null,
    isNew: o.isNew ?? true
  };
}

describe('checkMaxAmountPerSwipe (Rule A)', () => {
  it('không cấu hình max → không vi phạm', () => {
    expect(checkMaxAmountPerSwipe(50_000_000, null).violated).toBe(false);
  });
  it('vượt max → vi phạm', () => {
    const r = checkMaxAmountPerSwipe(20_000_001, 20_000_000);
    expect(r.violated).toBe(true);
    expect(r.message).toMatch(/CHẠM\/VƯỢT/);
  });
  it('ĐÚNG bằng max → vi phạm (>=, không phải >, LEAD chốt strict)', () => {
    expect(checkMaxAmountPerSwipe(20_000_000, 20_000_000).violated).toBe(true);
  });
  it('dưới max → không vi phạm', () => {
    expect(checkMaxAmountPerSwipe(19_999_999, 20_000_000).violated).toBe(false);
  });
});

describe('isSameLocalDay', () => {
  it('cùng ngày local (giờ khác nhau) → true', () => {
    expect(isSameLocalDay(new Date(2026, 6, 22, 0, 5), new Date(2026, 6, 22, 23, 55))).toBe(true);
  });
  it('khác ngày → false', () => {
    expect(isSameLocalDay(new Date(2026, 6, 22, 23, 59), new Date(2026, 6, 23, 0, 1))).toBe(false);
  });
});

describe('checkMaxSwipesPerDayPerCard (Rule B — scope THEO THẺ, ASSUMPTION build 22/7)', () => {
  it('không cấu hình → không vi phạm dù nhiều lệnh', () => {
    expect(checkMaxSwipesPerDayPerCard([new Date(), new Date(), new Date()], null).violated).toBe(false);
  });
  it('vượt số lệnh/ngày cho phép → vi phạm', () => {
    const swipes = [new Date(2026, 6, 22, 8), new Date(2026, 6, 22, 9), new Date(2026, 6, 22, 10)];
    const r = checkMaxSwipesPerDayPerCard(swipes, 2);
    expect(r.violated).toBe(true);
    expect(r.message).toMatch(/VƯỢT/);
  });
  it('đúng bằng hoặc dưới mức → không vi phạm', () => {
    const swipes = [new Date(2026, 6, 22, 8), new Date(2026, 6, 22, 9)];
    expect(checkMaxSwipesPerDayPerCard(swipes, 2).violated).toBe(false);
  });
});

describe('checkRoundAmount (Rule C — bội 1.000.000đ, ASSUMPTION build 22/7)', () => {
  it('không bật cờ → không vi phạm dù số tròn', () => {
    expect(checkRoundAmount(10_000_000, false).violated).toBe(false);
  });
  it('5.000.000 (ví dụ LEAD) → vi phạm', () => {
    expect(checkRoundAmount(5_000_000, true).violated).toBe(true);
  });
  it('10.000.000 (ví dụ LEAD) → vi phạm', () => {
    expect(checkRoundAmount(10_000_000, true).violated).toBe(true);
  });
  it('số không tròn (vd 4.530.000) → không vi phạm', () => {
    expect(checkRoundAmount(4_530_000, true).violated).toBe(false);
  });
});

describe('checkMinGapBetweenSwipes (Rule D — scope THEO THẺ, ASSUMPTION build 22/7)', () => {
  it('không cấu hình → không vi phạm', () => {
    expect(checkMinGapBetweenSwipes([new Date(), new Date()], null).violated).toBe(false);
  });
  it('2 lệnh cách nhau QUÁ GẦN (dưới min) → vi phạm', () => {
    const t0 = new Date(2026, 6, 22, 10, 0, 0);
    const t1 = new Date(2026, 6, 22, 10, 2, 0); // cách 2 phút
    const r = checkMinGapBetweenSwipes([t0, t1], 5);
    expect(r.violated).toBe(true);
    expect(r.message).toMatch(/DƯỚI/);
  });
  it('cách đủ xa (≥min) → không vi phạm', () => {
    const t0 = new Date(2026, 6, 22, 10, 0, 0);
    const t1 = new Date(2026, 6, 22, 10, 10, 0); // cách 10 phút
    expect(checkMinGapBetweenSwipes([t0, t1], 5).violated).toBe(false);
  });
  it('input KHÔNG sắp xếp vẫn phát hiện đúng (hàm tự sort)', () => {
    const t0 = new Date(2026, 6, 22, 10, 0, 0);
    const t1 = new Date(2026, 6, 22, 10, 2, 0);
    const r = checkMinGapBetweenSwipes([t1, t0], 5); // truyền NGƯỢC thứ tự
    expect(r.violated).toBe(true);
  });
});

describe('checkRepeatedAmountNearby (Rule E — scope THEO THẺ, ASSUMPTION build 22/7)', () => {
  it('không bật cờ → không vi phạm', () => {
    expect(checkRepeatedAmountNearby([], false, null).violated).toBe(false);
  });
  it('bật cờ nhưng thiếu window → throw (lỗi cấu hình, không đoán ngầm)', () => {
    expect(() => checkRepeatedAmountNearby([], true, null)).toThrow();
  });
  it('2 lệnh CÙNG số tiền trong cửa sổ → vi phạm', () => {
    const swipes = [
      { ocrAmount: 2_000_000, swipeAt: new Date(2026, 6, 22, 10, 0) },
      { ocrAmount: 2_000_000, swipeAt: new Date(2026, 6, 22, 10, 8) }
    ];
    const r = checkRepeatedAmountNearby(swipes, true, 15);
    expect(r.violated).toBe(true);
  });
  it('2 lệnh CÙNG số tiền nhưng NGOÀI cửa sổ → không vi phạm', () => {
    const swipes = [
      { ocrAmount: 2_000_000, swipeAt: new Date(2026, 6, 22, 10, 0) },
      { ocrAmount: 2_000_000, swipeAt: new Date(2026, 6, 22, 11, 0) } // cách 60 phút
    ];
    expect(checkRepeatedAmountNearby(swipes, true, 15).violated).toBe(false);
  });
  it('số tiền KHÁC nhau trong cửa sổ → không vi phạm', () => {
    const swipes = [
      { ocrAmount: 2_000_000, swipeAt: new Date(2026, 6, 22, 10, 0) },
      { ocrAmount: 3_000_000, swipeAt: new Date(2026, 6, 22, 10, 5) }
    ];
    expect(checkRepeatedAmountNearby(swipes, true, 15).violated).toBe(false);
  });
});

describe('checkMaxDailyTotalPerTid (Rule F — TỔNG TIỀN/ngày/TID, LEAD chốt build 22/7, khác chiều Rule A/B)', () => {
  it('không cấu hình → không vi phạm dù tổng lớn', () => {
    expect(checkMaxDailyTotalPerTid([5_000_000, 6_000_000], null).violated).toBe(false);
  });
  it('tổng VƯỢT mức tối đa → vi phạm', () => {
    const r = checkMaxDailyTotalPerTid([6_000_000, 6_000_000], 10_000_000);
    expect(r.violated).toBe(true);
    expect(r.message).toMatch(/VƯỢT/);
  });
  it('tổng ĐÚNG BẰNG mức tối đa → KHÔNG vi phạm (strict >, khác Rule A dùng >=)', () => {
    expect(checkMaxDailyTotalPerTid([5_000_000, 5_000_000], 10_000_000).violated).toBe(false);
  });
  it('tổng dưới mức (1 lệnh duy nhất) → không vi phạm', () => {
    expect(checkMaxDailyTotalPerTid([1_000_000], 10_000_000).violated).toBe(false);
  });
  it('mảng rỗng → tổng 0, không vi phạm, không crash', () => {
    expect(checkMaxDailyTotalPerTid([], 10_000_000).violated).toBe(false);
  });
});

describe('triangulateMismatch — 3 nhánh (SUMMARY sai / INDIVIDUALS sai / cả 2 nghi vấn)', () => {
  it('cả 2 khớp → NONE', () => {
    expect(triangulateMismatch(10_000_000, 10_000_000, 10_000_000).blame).toBe('NONE');
  });
  it('summary khớp, tổng bill lẻ LỆCH → INDIVIDUALS (không đoán bill cụ thể)', () => {
    const r = triangulateMismatch(10_000_000, 10_000_000, 9_500_000);
    expect(r.blame).toBe('INDIVIDUALS');
    expect(r.message).toMatch(/cần kiểm tay/);
  });
  it('tổng bill lẻ khớp, summary LỆCH → SUMMARY', () => {
    const r = triangulateMismatch(10_000_000, 9_800_000, 10_000_000);
    expect(r.blame).toBe('SUMMARY');
  });
  it('CẢ 2 đều lệch → BOTH_SUSPECT (không đoán bên nào tệ hơn)', () => {
    const r = triangulateMismatch(10_000_000, 9_000_000, 9_500_000);
    expect(r.blame).toBe('BOTH_SUSPECT');
  });
});

describe('checkLoNumberReuse — cảnh báo trùng số lô CÙNG TID (không chặn cứng)', () => {
  it('số lô null (chưa có) → không vi phạm', () => {
    expect(checkLoNumberReuse(null, [1, 2, 3]).violated).toBe(false);
  });
  it('số lô mới, chưa từng có → không vi phạm', () => {
    expect(checkLoNumberReuse(10, [1, 2, 3]).violated).toBe(false);
  });
  it('số lô TRÙNG lịch sử → vi phạm (cảnh báo)', () => {
    const r = checkLoNumberReuse(2, [1, 2, 3]);
    expect(r.violated).toBe(true);
    expect(r.message).toMatch(/ĐÃ từng/);
  });
  it('lịch sử có null xen kẽ (lô chưa có số) → vẫn so đúng, không crash', () => {
    expect(checkLoNumberReuse(5, [null, 1, null]).violated).toBe(false);
  });
});

describe('Rule G — detectDuplicateBills ("Bill đã gửi trước đó")', () => {
  const t = (h: number, m = 0) => new Date(2026, 7, 12, h, m);

  it('batch bình thường (không trùng lịch sử/không trùng nhau) → KHÔNG cảnh báo', () => {
    const bills = [
      fp({ receiptNumber: 100, ocrAmount: 2_000_000, swipeAt: t(9), cardLast4: '1111' }),
      fp({ receiptNumber: 101, ocrAmount: 3_000_000, swipeAt: t(10), cardLast4: '2222' })
    ];
    expect(detectDuplicateBills(bills)).toEqual([]);
  });

  it('bill mới TRÙNG TOÀN BỘ OCR với 1 bill LỊCH SỬ → cảnh báo "đã được gửi trước đó"', () => {
    const bills = [
      fp({ receiptNumber: 100, ocrAmount: 2_000_000, swipeAt: t(9), cardLast4: '1111', isNew: false }), // lịch sử
      fp({ receiptNumber: 100, ocrAmount: 2_000_000, swipeAt: t(9), cardLast4: '1111', isNew: true }) // gửi lại y hệt
    ];
    const w = detectDuplicateBills(bills);
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe('DUPLICATE_BILL');
    expect(w[0].message).toMatch(/ĐÃ được gửi trước đó/);
  });

  it('2 bill mới TRÙNG NHAU trong CÙNG batch (nhân đôi) → cảnh báo 1 lần', () => {
    const bills = [
      fp({ receiptNumber: 55, ocrAmount: 4_000_000, swipeAt: t(11), cardLast4: '9999' }),
      fp({ receiptNumber: 55, ocrAmount: 4_000_000, swipeAt: t(11), cardLast4: '9999' })
    ];
    const w = detectDuplicateBills(bills);
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe('DUPLICATE_BILL');
  });

  it('cùng số HĐ nhưng KHÁC số tiền → KHÔNG coi là trùng toàn bộ (không cảnh báo dup)', () => {
    const bills = [
      fp({ receiptNumber: 70, ocrAmount: 2_000_000, swipeAt: t(9), cardLast4: '1111', isNew: false }),
      fp({ receiptNumber: 70, ocrAmount: 5_000_000, swipeAt: t(9), cardLast4: '1111', isNew: true })
    ];
    expect(detectDuplicateBills(bills)).toEqual([]);
  });
});

describe('Rule G — checkReceiptNumberSequence (nghịch/reset/nhảy cóc số hóa đơn)', () => {
  const d1 = (h: number, m = 0) => new Date(2026, 7, 12, h, m); // 12/8
  const d2 = (h: number, m = 0) => new Date(2026, 7, 13, h, m); // 13/8

  it('thứ tự ĐÚNG (giờ tăng → số tăng liên tục) → KHÔNG cảnh báo', () => {
    const bills = [
      fp({ receiptNumber: 100, swipeAt: d1(9) }),
      fp({ receiptNumber: 101, swipeAt: d1(10) }),
      fp({ receiptNumber: 102, swipeAt: d1(11) })
    ];
    expect(checkReceiptNumberSequence(bills)).toEqual([]);
  });

  it('nghịch thứ tự cùng ngày (giờ muộn hơn nhưng số nhỏ hơn) → RECEIPT_INVERSION "kiểm tra lại"', () => {
    const bills = [
      fp({ receiptNumber: 105, swipeAt: d1(9) }), // sớm hơn nhưng số LỚN
      fp({ receiptNumber: 101, swipeAt: d1(10) }) // muộn hơn nhưng số NHỎ
    ];
    const w = checkReceiptNumberSequence(bills);
    expect(w.map((x) => x.kind)).toContain('RECEIPT_INVERSION');
    expect(w.find((x) => x.kind === 'RECEIPT_INVERSION')!.message).toMatch(/Kiểm tra lại/);
  });

  it('nhảy cóc CÙNG NGÀY (100 → 102, thiếu 101) → RECEIPT_GAP "gửi thiếu bill"', () => {
    const bills = [fp({ receiptNumber: 100, swipeAt: d1(9) }), fp({ receiptNumber: 102, swipeAt: d1(10) })];
    const w = checkReceiptNumberSequence(bills);
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe('RECEIPT_GAP');
    expect(w[0].message).toMatch(/THIẾU bill/);
  });

  it('reset SANG NGÀY MỚI (500 hôm nay → 1 hôm sau) → RECEIPT_RESET "kiểm tra lại", KHÔNG im lặng bỏ qua', () => {
    const bills = [fp({ receiptNumber: 500, swipeAt: d1(23) }), fp({ receiptNumber: 1, swipeAt: d2(8) })];
    const w = checkReceiptNumberSequence(bills);
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe('RECEIPT_RESET');
    expect(w[0].message).toMatch(/SANG NGÀY MỚI/);
  });

  it('tăng liên tục qua ngày KHÔNG reset (số đếm liên tục) + gap khác ngày → KHÔNG cảnh báo gap (chu kỳ khác)', () => {
    const bills = [fp({ receiptNumber: 500, swipeAt: d1(23) }), fp({ receiptNumber: 540, swipeAt: d2(8) })];
    expect(checkReceiptNumberSequence(bills)).toEqual([]);
  });

  it('cặp THUẦN LỊCH SỬ (không bill mới) → KHÔNG cảnh báo lại (tránh lặp lịch sử đã đối soát)', () => {
    const bills = [
      fp({ receiptNumber: 100, swipeAt: d1(9), isNew: false }),
      fp({ receiptNumber: 102, swipeAt: d1(10), isNew: false })
    ];
    expect(checkReceiptNumberSequence(bills)).toEqual([]);
  });

  it('gap giữa bill LỊCH SỬ và bill MỚI cùng ngày → vẫn cảnh báo (cặp có bill mới)', () => {
    const bills = [
      fp({ receiptNumber: 100, swipeAt: d1(9), isNew: false }),
      fp({ receiptNumber: 103, swipeAt: d1(10), isNew: true })
    ];
    const w = checkReceiptNumberSequence(bills);
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe('RECEIPT_GAP');
  });
});

describe('Rule G — checkLoNumberSequence (nhảy cóc/lùi số lô, MBV do caller bỏ qua)', () => {
  it('số lô null → không cảnh báo (MBV/chưa có số)', () => {
    expect(checkLoNumberSequence(null, [1, 2, 3])).toEqual([]);
  });
  it('không có lịch sử số lô → không cảnh báo', () => {
    expect(checkLoNumberSequence(5, [null, null])).toEqual([]);
  });
  it('số lô liền kề (predecessor+1) → không cảnh báo', () => {
    expect(checkLoNumberSequence(11, [8, 9, 10])).toEqual([]);
  });
  it('nhảy cóc số lô (10 → 13, thiếu 11,12) → LO_NUMBER_GAP "gửi thiếu"', () => {
    const w = checkLoNumberSequence(13, [8, 9, 10]);
    expect(w).toHaveLength(1);
    expect(w[0].kind).toBe('LO_NUMBER_GAP');
    expect(w[0].message).toMatch(/THIẾU lô/);
  });
  it('số lô LÙI (mới 5 < đã có 10) → LO_NUMBER_BACKWARD "kiểm tra lại"', () => {
    const w = checkLoNumberSequence(5, [9, 10]);
    expect(w.map((x) => x.kind)).toContain('LO_NUMBER_BACKWARD');
  });
  it('số lô TRÙNG (đã có) → KHÔNG backward (dành cho checkLoNumberReuse), KHÔNG gap', () => {
    expect(checkLoNumberSequence(10, [9, 10])).toEqual([]);
  });
});

describe('maskCardLast4 — PCI-DSS data minimization (hard requirement)', () => {
  it('input đã đúng 4 số → giữ nguyên', () => {
    expect(maskCardLast4('1234')).toBe('1234');
  });
  it('input là SỐ THẺ ĐẦY ĐỦ (vd 16 số) → CẮT về 4 số cuối, KHÔNG bao giờ giữ nguyên số đầy đủ', () => {
    expect(maskCardLast4('4111111111111234')).toBe('1234');
  });
  it('input có ký tự không phải số (vd che dạng ****1234) → chỉ giữ chữ số, lấy 4 cuối', () => {
    expect(maskCardLast4('**** **** **** 1234')).toBe('1234');
  });
  it('input rỗng/null → null', () => {
    expect(maskCardLast4(null)).toBeNull();
    expect(maskCardLast4('')).toBeNull();
    expect(maskCardLast4(undefined)).toBeNull();
  });
});
