// LƯỚI AN TOÀN list DoS (audit 20/8, Admin Demo duyệt 3/9) — HÀM THUẦN của Prisma findMany extension. Verify:
// (a) query tự-giới-hạn (take/cursor) KHÔNG bị áp cap; (b) query không giới hạn vượt cap → CẮT về cap + truncated=true
// (để warn, chống cắt CÂM R198); (c) đúng/dưới cap → giữ nguyên, truncated=false.
import { describe, it, expect } from 'vitest';
import { isBoundedFind, applyListCap, LIST_HARD_CAP } from '@sigma/database';

describe('isBoundedFind — query đã tự giới hạn?', () => {
  it('có take → bounded', () => { expect(isBoundedFind({ take: 10 })).toBe(true); });
  it('có cursor → bounded', () => { expect(isBoundedFind({ cursor: { id: 5 } })).toBe(true); });
  it('take=0 (khai rõ) → bounded', () => { expect(isBoundedFind({ take: 0 })).toBe(true); });
  it('không take/cursor → KHÔNG bounded (sẽ áp cap)', () => { expect(isBoundedFind({ where: {} })).toBe(false); });
  it('args undefined → KHÔNG bounded', () => { expect(isBoundedFind(undefined)).toBe(false); });
});

describe('applyListCap — cắt về cap khi vượt (chỉ query không tự giới hạn)', () => {
  const CAP = 5;
  const mk = (n: number) => Array.from({ length: n }, (_, i) => i);
  it('không bounded + vượt cap → CẮT về cap + truncated=true', () => {
    const r = applyListCap(mk(CAP + 3), false, CAP);
    expect(r.rows.length).toBe(CAP);
    expect(r.truncated).toBe(true);
  });
  it('không bounded + ĐÚNG cap → giữ nguyên, truncated=false', () => {
    const r = applyListCap(mk(CAP), false, CAP);
    expect(r.rows.length).toBe(CAP);
    expect(r.truncated).toBe(false);
  });
  it('không bounded + dưới cap → giữ nguyên', () => {
    const r = applyListCap(mk(2), false, CAP);
    expect(r.rows.length).toBe(2);
    expect(r.truncated).toBe(false);
  });
  it('BOUNDED (query tự take) + vượt cap → KHÔNG cắt (tôn trọng take của caller)', () => {
    const r = applyListCap(mk(CAP + 100), true, CAP);
    expect(r.rows.length).toBe(CAP + 100);
    expect(r.truncated).toBe(false);
  });
  it('kết quả không phải mảng (findUnique-shape) → trả nguyên', () => {
    const obj = { id: 1 };
    const r = applyListCap(obj, false, CAP);
    expect(r.rows).toBe(obj);
    expect(r.truncated).toBe(false);
  });
});

describe('LIST_HARD_CAP', () => {
  it('cao (50k) — trên mọi list thật của SigMa, là lưới an toàn không phải phân trang', () => {
    expect(LIST_HARD_CAP).toBe(50_000);
  });
});
