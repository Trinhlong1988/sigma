import type { LoRecord, ReconcileLine } from './types';

export const LO_RECORDS: LoRecord[] = [
  { id: 'lo1', code: 'LO-2607-001', date: '23/07/2026 08:12', totalAmount: 45_800_000, status: 'CO_CANH_BAO', flagCount: 5 },
  { id: 'lo2', code: 'LO-2607-002', date: '23/07/2026 09:40', totalAmount: 12_300_000, status: 'DA_DOI_SOAT', flagCount: 0 },
  { id: 'lo3', code: 'LO-2607-003', date: '22/07/2026 17:05', totalAmount: 88_450_000, status: 'DA_DOI_SOAT', flagCount: 0 },
  { id: 'lo4', code: 'LO-2607-004', date: '22/07/2026 14:22', totalAmount: 6_200_000, status: 'DANG_XU_LY', flagCount: 2 },
  { id: 'lo5', code: 'LO-2607-005', date: '21/07/2026 11:03', totalAmount: 31_000_000, status: 'DA_DOI_SOAT', flagCount: 0 }
];

// Nhãn Rule A-F khớp SEMANTICS THẬT của packages/business-rules/src/sigma-fraud-rules.ts (sửa
// theo finding CMD_AUDIT 23/7 — bản đầu bịa nhãn "OCR/bill trễ/trùng ảnh" sai nghiệp vụ):
//   A = checkMaxAmountPerSwipe      — số tiền 1 lệnh quẹt chạm/vượt mức tối đa (>=)
//   B = checkMaxSwipesPerDayPerCard — số lệnh quẹt/ngày/thẻ vượt trần (>)
//   C = checkRoundAmount            — số tiền TRÒN (bội 1.000.000đ) — nghi vấn
//   D = checkMinGapBetweenSwipes    — 2 lệnh quẹt liên tiếp cùng thẻ dưới khoảng cách tối thiểu
//   E = checkRepeatedAmountNearby   — trùng số tiền trên cùng thẻ trong cửa sổ thời gian
//   F = checkMaxDailyTotalPerTid    — tổng tiền quẹt/ngày/TID vượt trần (>)
//   TRI = triangulateMismatch       — đối chiếu tam giác (dự kiến vs bill tổng kết vs Σ bill lẻ) lệch
export const FRAUD_RULE_LABEL: Record<string, string> = {
  A: 'Quy tắc A — Vượt hạn mức 1 lệnh quẹt',
  B: 'Quy tắc B — Vượt số lệnh quẹt/ngày/thẻ',
  C: 'Quy tắc C — Số tiền tròn bất thường',
  D: 'Quy tắc D — 2 lệnh quẹt quá sát nhau',
  E: 'Quy tắc E — Trùng số tiền gần nhau',
  F: 'Quy tắc F — Vượt tổng tiền/ngày/TID',
  TRI: 'Đối chiếu tam giác lệch'
};

// Chi tiết đối soát mẫu — description mô phỏng sát format message thật của từng hàm rule (vnd + câu chữ).
export const RECONCILE_DETAIL: Record<string, ReconcileLine[]> = {
  lo1: [
    {
      id: 'r1',
      tid: 'TID00123456',
      amount: 15_000_000,
      billMatched: true,
      flags: [
        {
          rule: 'A',
          severity: 'nghiem_trong',
          description: 'Số tiền 15.000.000 đ ĐÃ CHẠM/VƯỢT mức tối đa cho phép mỗi lệnh quẹt (15.000.000 đ).'
        },
        {
          rule: 'C',
          severity: 'nhe',
          description: 'Số tiền 15.000.000 đ là số TRÒN (bội số 1.000.000 đ) — nghi vấn, cần kiểm tay.'
        }
      ]
    },
    {
      id: 'r2',
      tid: 'TID00124012',
      amount: 30_800_000,
      billMatched: false,
      flags: [
        {
          rule: 'E',
          severity: 'nghiem_trong',
          description: '2 lệnh quẹt cùng số tiền 15.400.000 đ của thẻ •••• 4512 cách nhau 9,5 phút (trong ngưỡng 30 phút) — nghi vấn trùng lặp.'
        },
        {
          rule: 'D',
          severity: 'nhe',
          description: '2 lệnh quẹt liên tiếp của thẻ •••• 4512 cách nhau 2,0 phút, DƯỚI mức tối thiểu yêu cầu (5 phút).'
        },
        {
          rule: 'TRI',
          severity: 'nghiem_trong',
          description:
            'Bill tổng kết khớp (30.800.000 đ) nhưng tổng các bill lẻ (29.300.000 đ) LỆCH so với dự kiến (30.800.000 đ) — cần kiểm tay các bill lẻ (không xác định được bill nào sai cụ thể).'
        }
      ]
    }
  ],
  lo4: [
    {
      id: 'r3',
      tid: 'TID00124455',
      amount: 6_200_000,
      billMatched: true,
      flags: [
        {
          rule: 'B',
          severity: 'nhe',
          description: 'Thẻ •••• 8821 đã quẹt 9 lệnh trong ngày, VƯỢT mức tối đa cho phép (8 lệnh/ngày).'
        },
        {
          rule: 'F',
          severity: 'nghiem_trong',
          description: 'Tổng số tiền quẹt trong ngày của TID này là 108.400.000 đ, VƯỢT mức tối đa cho phép (100.000.000 đ/ngày).'
        }
      ]
    }
  ]
};
