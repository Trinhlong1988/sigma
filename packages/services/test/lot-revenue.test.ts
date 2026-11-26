// GOLDEN TEST doanh số theo lô (Admin Demo 27/8) — fixture = BILL THẬT 26/8 inv15 (đã dump vision + xác nhận cộng
// bill lẻ = số kết toán). Chống tái diễn: nếu ai đổi hàm gộp về "đếm đôi" hay "bỏ settlement" → test ĐỎ, chặn ship.
import { describe, it, expect } from 'vitest';
import { aggregateLotRevenue, normalizeTid, parseBillDateTimeMs, type VisionBill } from '../src/lot-revenue.js';

describe('aggregateLotRevenue — model lô kết toán (proven từ bill thật 26/8)', () => {
  it('SETTLEMENT = tổng bill lẻ cùng lô → chỉ đếm 1 lần (KHÔNG đếm đôi)', () => {
    // Ca thật lô22 TID 20280825: 3 bill lẻ + 1 kết toán, kết toán = tổng 3 lẻ = 54.112.000.
    const bills: VisionBill[] = [
      { tid: '20280825', batchNumber: '22', type: 'SALE', totalAmount: 29413000 },
      { tid: '20280825', batchNumber: '22', type: 'SALE', totalAmount: 15556000 },
      { tid: '20280825', batchNumber: '22', type: 'SALE', totalAmount: 9143000 },
      { tid: '20280825', batchNumber: '22', type: 'SETTLEMENT', totalAmount: 54112000 }
    ];
    const r = aggregateLotRevenue(bills);
    expect(r.lots).toHaveLength(1);
    expect(r.lots[0].amount).toBe(54112000); // KHÔNG phải 54112000+54112000, KHÔNG phải 108M
    expect(r.lots[0].source).toBe('settlement');
    expect(r.total).toBe(54112000);
  });

  it('lô16: 2 bill lẻ 42.358.000 + 47.361.000 = 89.719.000 = kết toán (verify cộng đúng)', () => {
    const bills: VisionBill[] = [
      { tid: '20280825', batchNumber: '16', type: 'SALE', totalAmount: 42358000 },
      { tid: '20280825', batchNumber: '16', type: 'SALE', totalAmount: 47361000 },
      { tid: '20280825', batchNumber: '16', type: 'SETTLEMENT', totalAmount: 89719000 }
    ];
    expect(aggregateLotRevenue(bills).total).toBe(89719000);
    expect(42358000 + 47361000).toBe(89719000); // bất biến toán học của model
  });

  it('THIẾU kết toán → CỘNG bill lẻ (ca 53550077 lô133: 6 lẻ = 97.284.000)', () => {
    const bills: VisionBill[] = [
      { tid: '53550077', batchNumber: '133', type: 'SALE', totalAmount: 9536000 },
      { tid: '53550077', batchNumber: '133', type: 'SALE', totalAmount: 34927000 },
      { tid: '53550077', batchNumber: '133', type: 'SALE', totalAmount: 9875000 },
      { tid: '53550077', batchNumber: '133', type: 'SALE', totalAmount: 9310000 },
      { tid: '53550077', batchNumber: '133', type: 'SALE', totalAmount: 26073000 },
      { tid: '53550077', batchNumber: '133', type: 'SALE', totalAmount: 7563000 }
    ];
    const r = aggregateLotRevenue(bills);
    expect(r.lots).toHaveLength(1);
    expect(r.lots[0].amount).toBe(97284000);
    expect(r.lots[0].source).toBe('sales');
    expect(r.lots[0].saleCount).toBe(6);
  });

  it('DEDUP bill lẻ trùng mệnh giá trong 1 lô (ảnh forward/lặp) → đếm 1 lần + CỜ nghi gộp (FIX #4)', () => {
    const bills: VisionBill[] = [
      { tid: 'DEMO-TID-07', batchNumber: '64', type: 'SALE', totalAmount: 20000000 },
      { tid: 'DEMO-TID-07', batchNumber: '64', type: 'SALE', totalAmount: 20000000 }, // lặp
      { tid: 'DEMO-TID-07', batchNumber: '64', type: 'SALE', totalAmount: 5000000 }
    ];
    const r = aggregateLotRevenue(bills);
    expect(r.lots[0].amount).toBe(25000000); // 20tr đếm 1 lần + 5tr — SỐ KHÔNG đổi (an toàn)
    // FIX #4: lô không settlement + 2 bill 20tr cùng giá → NGHI đếm thiếu → cờ bật để soát tay (KHÔNG tự cộng).
    expect(r.lots[0].suspectDuplicateAmount).toBe(true);
    expect(r.lots[0].mergedAwayAmount).toBe(20000000); // (2−1)×20tr = số NGHI bị gộp
  });

  it('FIX #4: lô CÓ SETTLEMENT + mệnh giá lặp → KHÔNG cờ (settlement authoritative, dedup không ảnh hưởng)', () => {
    const bills: VisionBill[] = [
      { tid: 'DEMO-TID-07', batchNumber: '70', type: 'SALE', totalAmount: 20000000 },
      { tid: 'DEMO-TID-07', batchNumber: '70', type: 'SALE', totalAmount: 20000000 },
      { tid: 'DEMO-TID-07', batchNumber: '70', type: 'SETTLEMENT', totalAmount: 20000000 }
    ];
    const r = aggregateLotRevenue(bills);
    expect(r.lots[0].suspectDuplicateAmount).toBe(false);
    expect(r.lots[0].mergedAwayAmount).toBe(0);
  });

  it('FIX #4: lô không settlement, các mệnh giá KHÁC nhau → KHÔNG cờ', () => {
    const bills: VisionBill[] = [
      { tid: 'DEMO-TID-07', batchNumber: '71', type: 'SALE', totalAmount: 20000000 },
      { tid: 'DEMO-TID-07', batchNumber: '71', type: 'SALE', totalAmount: 5000000 }
    ];
    const r = aggregateLotRevenue(bills);
    expect(r.lots[0].suspectDuplicateAmount).toBe(false);
    expect(r.lots[0].mergedAwayAmount).toBe(0);
  });

  it('nhiều lô nhiều TID → mỗi lô 1 đơn vị; coverage đúng', () => {
    const bills: VisionBill[] = [
      { tid: '20280825', batchNumber: '22', type: 'SETTLEMENT', totalAmount: 54112000 },
      { tid: '20280825', batchNumber: '21', type: 'SETTLEMENT', totalAmount: 64551000 },
      { tid: '53550077', batchNumber: '133', type: 'SALE', totalAmount: 97284000 } // không settlement
    ];
    const r = aggregateLotRevenue(bills);
    expect(r.lots).toHaveLength(3);
    expect(r.total).toBe(54112000 + 64551000 + 97284000);
    expect(r.settlementCoverage).toEqual({ withSettlement: 2, total: 3 });
  });

  it('OCR-03a: phiếu TỔNG bị gán nhầm SALE (=Σ các phiếu khác) → KHÔNG cộng đôi (ca thật lô19 20280822)', () => {
    // 5 phiếu lẻ (Σ=107.321.000) + phiếu TỔNG KẾT bị vision gán SALE với đúng số 107.321.000.
    const bills: VisionBill[] = [
      { tid: '20280822', batchNumber: '19', type: 'SALE', totalAmount: 25587000 },
      { tid: '20280822', batchNumber: '19', type: 'SALE', totalAmount: 22435000 },
      { tid: '20280822', batchNumber: '19', type: 'SALE', totalAmount: 19655000 },
      { tid: '20280822', batchNumber: '19', type: 'SALE', totalAmount: 21916000 },
      { tid: '20280822', batchNumber: '19', type: 'SALE', totalAmount: 17728000 },
      { tid: '20280822', batchNumber: '19', type: 'SALE', totalAmount: 107321000 } // tổng bị gán nhầm SALE
    ];
    const r = aggregateLotRevenue(bills);
    expect(r.lots).toHaveLength(1);
    expect(r.lots[0].amount).toBe(107321000); // KHÔNG phải 214.642.000
    expect(r.lots[0].hasSettlement).toBe(true);
  });

  it('OCR-03b: settlement đọc nhầm digit (101 thay 107) ≠ Σ bill lẻ → dùng Σ lẻ + CỜ đọc lại', () => {
    const bills: VisionBill[] = [
      { tid: '20280822', batchNumber: '19', type: 'SALE', totalAmount: 25587000 },
      { tid: '20280822', batchNumber: '19', type: 'SALE', totalAmount: 22435000 },
      { tid: '20280822', batchNumber: '19', type: 'SALE', totalAmount: 19655000 },
      { tid: '20280822', batchNumber: '19', type: 'SALE', totalAmount: 21916000 },
      { tid: '20280822', batchNumber: '19', type: 'SALE', totalAmount: 17728000 },
      { tid: '20280822', batchNumber: '19', type: 'SETTLEMENT', totalAmount: 101321000 } // nhầm 7→1
    ];
    const r = aggregateLotRevenue(bills);
    expect(r.lots[0].amount).toBe(107321000); // Σ bill lẻ (tin cậy hơn), KHÔNG lấy 101.321.000
    expect(r.lots[0].needsRecheck).toBe(true); // CỜ đọc lại hires
  });

  it('KHÔNG false-positive: 2 sale thật + 1 sale = tổng chỉ khi ≥3 phiếu & là max (guard)', () => {
    // chỉ 2 phiếu, 1 = phiếu kia*? → length<3 → không coi là hidden total.
    const bills: VisionBill[] = [
      { tid: 'DEMO-TID-07', batchNumber: '9', type: 'SALE', totalAmount: 10000000 },
      { tid: 'DEMO-TID-07', batchNumber: '9', type: 'SALE', totalAmount: 10000000 } // dedup → 1 mệnh giá
    ];
    // sau dedup còn 1 mệnh giá 10tr → tổng 10tr (không nhân đôi).
    expect(aggregateLotRevenue(bills).lots[0].amount).toBe(10000000);
  });

  // REGRESSION bug 1/9 (Agent-A + LEAD repro): checksum hiddenTotal `maxSale===saleSum-maxSale` (max = NỬA tổng) là
  // quan hệ cộng đơn giản, KHÔNG hiếm với số tròn → HALVE doanh số thật, im lặng. Fix: chỉ suy khi KHÔNG settlement
  // thật + LUÔN cờ needsRecheck khi suy-số-học.
  it('[FIX] lô có SETTLEMENT thật KHÔNG bị số học ghi đè: [10+20+30]+SET60 → 60 (trước fix ra 30)', () => {
    const bills: VisionBill[] = [
      { tid: 'S1', batchNumber: '7', type: 'SALE', totalAmount: 10_000_000 },
      { tid: 'S1', batchNumber: '7', type: 'SALE', totalAmount: 20_000_000 },
      { tid: 'S1', batchNumber: '7', type: 'SALE', totalAmount: 30_000_000 },
      { tid: 'S1', batchNumber: '7', type: 'SETTLEMENT', totalAmount: 60_000_000 }
    ];
    const r = aggregateLotRevenue(bills);
    expect(r.lots[0].amount).toBe(60_000_000); // settlement là AUTHORITY, KHÔNG kéo về 30
    expect(r.lots[0].needsRecheck).toBe(false); // khớp Σ lẻ → sạch
  });

  it('[FIX] no-settlement [10+20+30] (max=½ tổng) → KHÔNG nuốt câm: cắm cờ needsRecheck', () => {
    const bills: VisionBill[] = [
      { tid: 'S2', batchNumber: '7', type: 'SALE', totalAmount: 10_000_000 },
      { tid: 'S2', batchNumber: '7', type: 'SALE', totalAmount: 20_000_000 },
      { tid: 'S2', batchNumber: '7', type: 'SALE', totalAmount: 30_000_000 }
    ];
    const r = aggregateLotRevenue(bills);
    expect(r.lots[0].needsRecheck).toBe(true); // ambiguous → BUỘC kiểm tay (cổng reconcile), không nuốt câm
  });

  it('[FIX] phiếu tổng gán nhầm SALE (4 mệnh giá): [10+20+30+60SALE] → 60 + cờ', () => {
    const bills: VisionBill[] = [
      { tid: 'S3', batchNumber: '7', type: 'SALE', totalAmount: 10_000_000 },
      { tid: 'S3', batchNumber: '7', type: 'SALE', totalAmount: 20_000_000 },
      { tid: 'S3', batchNumber: '7', type: 'SALE', totalAmount: 30_000_000 },
      { tid: 'S3', batchNumber: '7', type: 'SALE', totalAmount: 60_000_000 } // OCR gán nhầm type
    ];
    const r = aggregateLotRevenue(bills);
    expect(r.lots[0].amount).toBe(60_000_000); // loại phiếu tổng nhầm, giữ ý định OCR-03
    expect(r.lots[0].needsRecheck).toBe(true);
  });

  // [Admin Demo 6/9 — GỐC bug "lô-1 ma" MBV] Bill LẺ có SỐ LÔ = 1 (đổi máy reset), phiếu TỔNG KẾT có số lô THẬT (2/26/28).
  // CÙNG TID, CÙNG ảnh → phải HÚT sale vào settlement (settlement thắng), ra 1 lô mang SỐ LÔ SETTLEMENT — KHÔNG đẻ lô-1 ma.
  it('[CROSS-BATCH] SALE lô1 + SETTLEMENT lô2 cùng TID/tiền → 1 lô số-lô-settlement, KHÔNG lô-1 ma', () => {
    const bills: VisionBill[] = [
      { tid: '20281008', batchNumber: '1', type: 'SALE', totalAmount: 20000, dateTime: '05/09/2026 09:56:29' },
      { tid: '20281008', batchNumber: '2', type: 'SETTLEMENT', totalAmount: 20000, dateTime: '05/09/2026 09:57:00' }
    ];
    const r = aggregateLotRevenue(bills);
    expect(r.lots).toHaveLength(1); // KHÔNG phải 2 (lô1 sale + lô2 settlement)
    expect(r.lots[0].batchNumber).toBe('2'); // số lô THẬT của settlement, KHÔNG phải '1'
    expect(r.lots[0].amount).toBe(20000);
    expect(r.lots[0].source).toBe('settlement');
    expect(r.total).toBe(20000); // KHÔNG đếm đôi 40k
  });

  it('[CROSS-BATCH] mismatch (SALE lô1 25k vs SETTLEMENT lô2 20k) → settlement THẮNG (20k) + cờ needsRecheck', () => {
    const bills: VisionBill[] = [
      { tid: '20281008', batchNumber: '1', type: 'SALE', totalAmount: 25000 },
      { tid: '20281008', batchNumber: '2', type: 'SETTLEMENT', totalAmount: 20000 }
    ];
    const r = aggregateLotRevenue(bills);
    expect(r.lots).toHaveLength(1);
    expect(r.lots[0].amount).toBe(20000); // cross-batch → settlement authority (KHÔNG lấy 25k)
    expect(r.lots[0].needsRecheck).toBe(true);
  });

  it('[CROSS-BATCH] 3 ảnh lô-1 khác nhau (mỗi ảnh 1 settlement) gộp phẳng vẫn tách đúng theo settlement', () => {
    // Mô phỏng nếu caller gộp nhiều ảnh: mỗi giao dịch = SALE lô1 + SETTLEMENT lô riêng (2/26/28) → 3 lô riêng.
    const bills: VisionBill[] = [
      { tid: '20281008', batchNumber: '1', type: 'SALE', totalAmount: 20000 },
      { tid: '20281008', batchNumber: '2', type: 'SETTLEMENT', totalAmount: 20000 },
      { tid: '20281008', batchNumber: '26', type: 'SETTLEMENT', totalAmount: 20000 },
      { tid: '20281008', batchNumber: '28', type: 'SETTLEMENT', totalAmount: 14000 }
    ];
    const r = aggregateLotRevenue(bills);
    // 3 settlement lô riêng (2/26/28). Sale lô1 hút vào settlement nhỏ nhất (2) — mơ hồ nhiều settlement → cờ.
    expect(r.lots.map((l) => l.batchNumber).sort()).toEqual(['2', '26', '28']);
    expect(r.total).toBe(20000 + 20000 + 14000);
  });

  it('bỏ bill tiền ≤0 / TID rỗng', () => {
    const bills: VisionBill[] = [
      { tid: '', batchNumber: '1', type: 'SALE', totalAmount: 100 },
      { tid: '20280825', batchNumber: '1', type: 'SALE', totalAmount: 0 }
    ];
    expect(aggregateLotRevenue(bills).total).toBe(0);
  });
});

describe('normalizeTid', () => {
  it('bỏ hậu tố -N biến thể terminal', () => {
    expect(normalizeTid('20280822-1')).toBe('20280822');
    expect(normalizeTid('53550071-1')).toBe('53550071');
    expect(normalizeTid('20280825')).toBe('20280825');
  });
});

describe('parseBillDateTimeMs', () => {
  it('parse dd/mm/yyyy HH:mm[:ss]', () => {
    expect(parseBillDateTimeMs('26/08/2026 17:29')).toBe(new Date(2026, 7, 26, 17, 29, 0).getTime());
    expect(parseBillDateTimeMs('26/08/2026 15:52:54')).toBe(new Date(2026, 7, 26, 15, 52, 54).getTime());
    expect(parseBillDateTimeMs('')).toBeNull();
    expect(parseBillDateTimeMs(null)).toBeNull();
  });
});
