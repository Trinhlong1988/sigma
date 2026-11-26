// Lane D vòng 2 (3/8, việc 2 — WS reconnect backoff) — regression test cho computeReconnectDelay() trong
// chat-realtime.ts. Hàm THUẦN (nhận `rng` để tất định, KHÔNG WebSocket/DOM) — cùng lớp "pure-logic test" của
// các test chat-realtime khác (parseChatNotifyPayload). Bảo vệ: nếu ai đó vô tình đưa lại 2000ms cố định
// (bug gốc — mọi client đập lại đồng loạt mỗi 2s khi server sập), test sẽ đỏ.
import { describe, expect, it } from 'vitest';
import { computeReconnectDelay } from './chat-realtime';

describe('computeReconnectDelay (WS reconnect backoff)', () => {
  // rng=()=>0 → jitter=0, đo đúng phần BASE luỹ thừa.
  const noJitter = (): number => 0;

  it('base luỹ thừa 2→4→8→16→30s (cap) khi không jitter', () => {
    expect(computeReconnectDelay(0, noJitter)).toBe(2000);
    expect(computeReconnectDelay(1, noJitter)).toBe(4000);
    expect(computeReconnectDelay(2, noJitter)).toBe(8000);
    expect(computeReconnectDelay(3, noJitter)).toBe(16000);
    expect(computeReconnectDelay(4, noJitter)).toBe(30000); // cap (2^4*2000=32000 → kẹp 30000)
    expect(computeReconnectDelay(5, noJitter)).toBe(30000);
    expect(computeReconnectDelay(50, noJitter)).toBe(30000);
  });

  it('KHÔNG phải hằng số cố định — delay tăng dần theo attempt (chống hồi quy về 2000ms cứng)', () => {
    const d0 = computeReconnectDelay(0, noJitter);
    const d1 = computeReconnectDelay(1, noJitter);
    const d2 = computeReconnectDelay(2, noJitter);
    expect(d1).toBeGreaterThan(d0);
    expect(d2).toBeGreaterThan(d1);
  });

  it('attempt âm được kẹp về 0 (không sinh delay < base hoặc số vô lý)', () => {
    expect(computeReconnectDelay(-1, noJitter)).toBe(2000);
    expect(computeReconnectDelay(-99, noJitter)).toBe(2000);
  });

  it('jitter nằm trong [base, base + 25%*base) — rải client, không vượt quá 1/4 base', () => {
    // rng cận trên (~1) → jitter lớn nhất < 25% base.
    const almostOne = (): number => 0.9999999;
    for (const attempt of [0, 1, 2, 3, 4, 10]) {
      const base = Math.min(2000 * 2 ** attempt, 30000);
      const withMaxJitter = computeReconnectDelay(attempt, almostOne);
      expect(withMaxJitter).toBeGreaterThanOrEqual(base);
      expect(withMaxJitter).toBeLessThan(base + base * 0.25);
    }
  });

  it('jitter tất định với rng cụ thể — 0.5 → base + floor(0.5*base*0.25)', () => {
    // attempt 0: base 2000, jitter = floor(0.5*2000*0.25)=250 → 2250.
    expect(computeReconnectDelay(0, () => 0.5)).toBe(2250);
    // attempt 4 (cap 30000): jitter = floor(0.5*30000*0.25)=3750 → 33750.
    expect(computeReconnectDelay(4, () => 0.5)).toBe(33750);
  });
});
