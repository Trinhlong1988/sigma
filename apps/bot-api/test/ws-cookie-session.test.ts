// SIGMA Phase 6 dọn RC-dead-code (30/7) — test ws-cookie-session.ts (`parseCookieHeader`, hàm THUẦN không
// I/O). Dời NGUYÊN VẸN từ test/rc-realtime-proxy.test.ts (file đó ĐÃ XÓA cùng src/rc-realtime-proxy.ts —
// `attachRcRealtimeProxy` xác nhận zero-caller thật, xem BUGS_FIXED.md mục dọn RC-dead-code) — `parseCookieHeader`
// bản thân VẪN LÀ CODE SỐNG THẬT (dùng bởi call-signaling-server.ts/chat-realtime-proxy.ts), chỉ đổi nơi ở.
import { describe, expect, it } from 'vitest';
import { parseCookieHeader } from '../src/ws-cookie-session.js';

describe('parseCookieHeader', () => {
  it('parse đúng 1 cookie đơn', () => {
    expect(parseCookieHeader('sigma_ws=abc123')).toEqual({ sigma_ws: 'abc123' });
  });

  it('parse đúng nhiều cookie phân cách bởi "; "', () => {
    expect(parseCookieHeader('a=1; sigma_ws=xyz; b=2')).toEqual({ a: '1', sigma_ws: 'xyz', b: '2' });
  });

  it('header undefined → object rỗng, KHÔNG throw', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
  });

  it('giá trị url-encoded → tự decode', () => {
    expect(parseCookieHeader('sigma_ws=a%3Db')).toEqual({ sigma_ws: 'a=b' });
  });

  it('phần tử không có dấu "=" → bỏ qua, KHÔNG throw', () => {
    expect(parseCookieHeader('garbage; sigma_ws=ok')).toEqual({ sigma_ws: 'ok' });
  });
});
