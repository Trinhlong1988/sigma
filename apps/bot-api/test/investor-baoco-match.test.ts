// [Admin Demo 13/9] Matcher check báo có NĐT — chốt theo ĐO THẬT TK MB Thông 12-13/9:
// MB "KET CHUYEN SO DU" GỘP nhiều lô 1 khoản + lệch vài đồng làm tròn (9.385.341 vs lô 9.385.332 = +9đ).
// Test thuần trên doiChieuBaocoNdt là DB-bound — đây test LÔ-GIC qua ca thật đã verify sống (số thật ở dưới).
import { describe, it, expect } from 'vitest';

// Mirror thuSubarray + tol (module không export riêng — giữ 1 nguồn bằng cách assert HÀNH VI qua số thật đã đo;
// nếu đổi tol/logic trong investor-baoco-check.ts thì các ca dưới phải đổi theo có chủ đích).
const tol = (n: number): number => 100 + 20 * n;
function thuSubarray(arr: number[], amount: number): number[] | null {
  for (let i = 0; i < arr.length; i++) {
    let sum = 0;
    for (let j = i; j < arr.length; j++) {
      sum += arr[j];
      const n = j - i + 1;
      if (Math.abs(sum - amount) <= tol(n)) return arr.slice(i, j + 1);
      if (sum > amount + tol(n)) break;
    }
  }
  return null;
}

describe('matcher báo có kết chuyển gộp (số thật 12-13/9)', () => {
  it('CA THẬT 1 lô, lệch +9đ làm tròn: 9.385.341 ↔ lô 9.385.332', () => {
    expect(thuSubarray([9_385_332], 9_385_341)).toEqual([9_385_332]);
  });
  it('CA THẬT lô tối hôm trước: 29.648.566 ↔ lô 29.648.557 (pool lùi 1 ngày)', () => {
    expect(thuSubarray([9_879_557, 29_648_557], 29_648_566)).toEqual([29_648_557]);
  });
  it('GỘP nhiều lô liên tiếp: khoản = Σ 3 lô ± vài đồng', () => {
    const lo = [11_367_175, 8_001_502, 6_929_034];
    expect(thuSubarray(lo, 26_297_720)).toEqual(lo); // Σ=26.297.711, lệch +9 ≤ tol(3)=160
  });
  it('KHÔNG khớp bừa: lệch vượt dung sai → null (cờ soi tay, không nuốt)', () => {
    expect(thuSubarray([9_385_332], 9_390_000)).toBeNull();
    expect(thuSubarray([11_367_175, 24_709_273, 9_879_557], 45_980_760)).toBeNull(); // ca thật chưa khớp 12/9 — phải ra cờ vàng
  });
});
