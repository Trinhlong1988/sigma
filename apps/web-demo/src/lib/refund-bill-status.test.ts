// SIGMA LANE B Vòng 2 (#1, 3/8) — BÙ TEST cho refund-bill-status.ts (trước đây 0 test). Kiểm 4 trạng thái
// + ngưỡng ±3.000đ + nhãn/màu (Hoàn thừa ĐỎ) + describe kèm số tiền chênh + PARITY client↔server (cùng thuật
// toán computeRefundAggregate với apps/bot-api/src/refund-service.ts — mirror THỦ CÔNG, dễ lệch nếu 1 bên đổi).
import { describe, expect, it } from 'vitest';
import {
  computeRefundAggregate,
  describeRefundAggregate,
  describeRefundLineProgress,
  REFUND_MATCH_TOLERANCE_VND,
  REFUND_STATUS_COLOR_CLASS,
  REFUND_STATUS_LABEL_VI
} from './refund-bill-status';

describe('computeRefundAggregate — 4 trạng thái + ngưỡng ±3.000đ (đúng biên)', () => {
  it('totalConfirmed=0 → none (diff = -required)', () => {
    const r = computeRefundAggregate(1_000_000, 0);
    expect(r.status).toBe('none');
    expect(r.diff).toBe(-1_000_000);
  });

  it('trong ngưỡng ±3.000đ kể cả ĐÚNG biên → matched', () => {
    expect(computeRefundAggregate(1_000_000, 1_000_000).status).toBe('matched');
    expect(computeRefundAggregate(1_000_000, 1_000_000 + REFUND_MATCH_TOLERANCE_VND).status).toBe('matched');
    expect(computeRefundAggregate(1_000_000, 1_000_000 - REFUND_MATCH_TOLERANCE_VND).status).toBe('matched');
  });

  it('vượt ngưỡng chiều DƯƠNG (>3.000đ) → over (Hoàn thừa)', () => {
    const r = computeRefundAggregate(1_000_000, 1_003_001);
    expect(r.status).toBe('over');
    expect(r.diff).toBe(3_001);
  });

  it('vượt ngưỡng chiều ÂM (>3.000đ, còn >0) → partial (Hoàn thiếu)', () => {
    const r = computeRefundAggregate(1_000_000, 996_999);
    expect(r.status).toBe('partial');
    expect(r.diff).toBe(-3_001);
  });
});

describe('nhãn + màu 4 trạng thái (Hoàn thừa = ĐỎ/danger)', () => {
  it('nhãn tiếng Việt đúng 4 tên đã chốt', () => {
    expect(REFUND_STATUS_LABEL_VI).toEqual({ none: 'Chưa hoàn', partial: 'Hoàn thiếu', matched: 'Hoàn đủ', over: 'Hoàn thừa' });
  });
  it('Hoàn thừa (over) dùng màu danger (ĐỎ) — cảnh báo rủi ro tài chính cao nhất', () => {
    expect(REFUND_STATUS_COLOR_CLASS.over).toContain('danger');
    expect(REFUND_STATUS_COLOR_CLASS.matched).toContain('success');
    expect(REFUND_STATUS_COLOR_CLASS.partial).toContain('amber');
  });
});

describe('describeRefundAggregate — Hoàn thừa/thiếu KÈM số tiền chênh chính xác', () => {
  it('matched → chỉ nhãn "Hoàn đủ"', () => {
    expect(describeRefundAggregate(computeRefundAggregate(1_000_000, 1_000_000))).toBe('Hoàn đủ');
  });
  it('none → "Chưa hoàn"', () => {
    expect(describeRefundAggregate(computeRefundAggregate(1_000_000, 0))).toBe('Chưa hoàn');
  });
  it('over → "Hoàn thừa <số>đ" (số tiền thừa chính xác)', () => {
    expect(describeRefundAggregate(computeRefundAggregate(1_000_000, 1_005_000))).toBe('Hoàn thừa 5.000đ');
  });
  it('partial → "Hoàn thiếu <số>đ" (số tiền thiếu chính xác)', () => {
    expect(describeRefundAggregate(computeRefundAggregate(1_000_000, 940_000))).toBe('Hoàn thiếu 60.000đ');
  });
});

describe('describeRefundLineProgress — "Đã hoàn: X/Y (lần này: Z)"', () => {
  it('định dạng nhóm nghìn đúng', () => {
    expect(describeRefundLineProgress(1_500_000, 2_000_000, 500_000)).toBe('Đã hoàn: 1.500.000đ/2.000.000đ (lần này: 500.000đ)');
  });
});

// PARITY client↔server — computeRefundAggregate của web-demo PHẢI cho CÙNG status như apps/bot-api (cùng ngưỡng
// 3000, cùng quy ước diff). Các ca biên dưới đây tính TRƯỚC theo spec chung; nếu 1 bên đổi công thức → test này
// (và test tương ứng bot-api) lệch ngay. Đồng thời khẳng định REFUND_MATCH_TOLERANCE_VND = 3000 hai bên.
describe('PARITY client↔server (cùng ca biên)', () => {
  it('hằng số ngưỡng = 3000', () => {
    expect(REFUND_MATCH_TOLERANCE_VND).toBe(3000);
  });
  const cases: Array<[number, number, string]> = [
    [1_000_000, 0, 'none'],
    [1_000_000, 1_000_000, 'matched'],
    [1_000_000, 1_003_000, 'matched'], // đúng biên +3000 → vẫn matched.
    [1_000_000, 1_003_001, 'over'], // vượt 1đ → over.
    [1_000_000, 997_000, 'matched'], // đúng biên -3000 → matched.
    [1_000_000, 996_999, 'partial'] // thiếu quá 3000 → partial.
  ];
  it.each(cases)('required=%d confirmed=%d → %s', (required, confirmed, expected) => {
    expect(computeRefundAggregate(required, confirmed).status).toBe(expected);
  });
});
