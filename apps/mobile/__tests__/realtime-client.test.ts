// Unit test THUẦN LOGIC cho computeReconnectDelayMs() (src/lib/realtime-client.ts) — hàm PURE tách riêng khỏi
// state machine WebSocket để test được KHÔNG cần mock native WebSocket/AppState. Mock Math.random() để loại
// jitter ngẫu nhiên ra khỏi phép so sánh chính xác.
import { computeReconnectDelayMs, BASE_DELAY_MS, MAX_DELAY_MS, JITTER_MAX_MS } from '../src/lib/realtime-client';

describe('computeReconnectDelayMs — backoff exponential 1s→2s→4s→...→trần 30s + jitter nhỏ', () => {
  const originalRandom = Math.random;
  afterEach(() => {
    Math.random = originalRandom;
  });

  it('jitter=0 (Math.random=0): tăng gấp đôi mỗi lần thử, đúng bậc thang 1s/2s/4s/8s/16s', () => {
    Math.random = () => 0;
    expect(computeReconnectDelayMs(1)).toBe(BASE_DELAY_MS); // 1000
    expect(computeReconnectDelayMs(2)).toBe(BASE_DELAY_MS * 2); // 2000
    expect(computeReconnectDelayMs(3)).toBe(BASE_DELAY_MS * 4); // 4000
    expect(computeReconnectDelayMs(4)).toBe(BASE_DELAY_MS * 8); // 8000
    expect(computeReconnectDelayMs(5)).toBe(BASE_DELAY_MS * 16); // 16000
  });

  it('bị chặn (clamp) ở trần MAX_DELAY_MS=30000 khi attempt lớn (không tăng vô hạn)', () => {
    Math.random = () => 0;
    expect(computeReconnectDelayMs(6)).toBe(MAX_DELAY_MS); // 2^5*1000=32000 > 30000 → clamp 30000
    expect(computeReconnectDelayMs(10)).toBe(MAX_DELAY_MS);
    expect(computeReconnectDelayMs(1000)).toBe(MAX_DELAY_MS);
  });

  it('jitter nằm trong khoảng [0, JITTER_MAX_MS) — cộng thêm vào delay cơ bản, không vượt trần quá jitter tối đa', () => {
    Math.random = () => 0.9999;
    const delay = computeReconnectDelayMs(1);
    expect(delay).toBeGreaterThanOrEqual(BASE_DELAY_MS);
    expect(delay).toBeLessThan(BASE_DELAY_MS + JITTER_MAX_MS);
  });

  it('attempt không hợp lệ (0, âm, NaN) coi như lần thử đầu tiên (an toàn, không NaN/Infinity lọt ra)', () => {
    Math.random = () => 0;
    expect(computeReconnectDelayMs(0)).toBe(BASE_DELAY_MS);
    expect(computeReconnectDelayMs(-5)).toBe(BASE_DELAY_MS);
    expect(computeReconnectDelayMs(NaN)).toBe(BASE_DELAY_MS);
  });
});
