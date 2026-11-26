// FCM-ping-on-view (6/8) — test THUẦN pickDuePresenceCheckIds: dedupe trong lô + throttle 30s/id + bỏ id không
// hữu hạn. (requestPresenceCheck phần I/O proxyFetch không test ở đây — chỉ logic chọn id đến hạn.)
import { describe, it, expect } from 'vitest';
import { pickDuePresenceCheckIds, PRESENCE_CHECK_THROTTLE_MS } from './presence-check';

describe('pickDuePresenceCheckIds', () => {
  it('map rỗng → mọi id đều đến hạn, dedupe trùng trong lô', () => {
    const last = new Map<number, number>();
    expect(pickDuePresenceCheckIds([1, 2, 2, 3, 1], last, 1000)).toEqual([1, 2, 3]);
  });

  it('throttle: id vừa ping trong 30s → bỏ; quá 30s → lại đến hạn', () => {
    const now = 100_000;
    const last = new Map<number, number>([
      [1, now - 10_000], // 10s trước → còn throttle
      [2, now - PRESENCE_CHECK_THROTTLE_MS] // đúng 30s → đến hạn
    ]);
    expect(pickDuePresenceCheckIds([1, 2, 3], last, now)).toEqual([2, 3]);
  });

  it('bỏ id không hữu hạn (NaN/Infinity)', () => {
    const last = new Map<number, number>();
    expect(pickDuePresenceCheckIds([Number.NaN, Number.POSITIVE_INFINITY, 5], last, 0)).toEqual([5]);
  });

  it('mọi id đều còn throttle → rỗng (no-op, không gửi request)', () => {
    const now = 50_000;
    const last = new Map<number, number>([
      [1, now - 5_000],
      [2, now - 1_000]
    ]);
    expect(pickDuePresenceCheckIds([1, 2], last, now)).toEqual([]);
  });
});
