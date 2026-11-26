// Unit test THUẦN LOGIC (không mock AsyncStorage) cho việc tách giá trị cookie khỏi header `set-cookie` thô —
// extractCookieValue() tách riêng khỏi persistSetCookieHeader() (xem src/lib/cookie-jar.ts) đúng mục đích
// test được độc lập với native module.
import { extractCookieValue } from '../src/lib/cookie-jar';

describe('extractCookieValue', () => {
  it('tách đúng giá trị khỏi header set-cookie đầy đủ attribute (giống bot-api thật trả về)', () => {
    const raw = 'sigma_ws=abc123def456; Max-Age=2592000; Path=/; Expires=Wed, 26 Aug 2026 00:00:00 GMT; HttpOnly; Secure; SameSite=None';
    expect(extractCookieValue(raw, 'sigma_ws')).toBe('abc123def456');
  });

  it('trả null nếu tên cookie không khớp', () => {
    const raw = 'other_cookie=xyz; Path=/';
    expect(extractCookieValue(raw, 'sigma_ws')).toBeNull();
  });

  it('trả null nếu header rỗng/không có dấu =', () => {
    expect(extractCookieValue('', 'sigma_ws')).toBeNull();
  });

  it('không nhầm cookie khác có tên chứa cùng tiền tố (đòi hỏi đúng dấu "=" ngay sau tên)', () => {
    const raw = 'sigma_ws_v2=should_not_match; sigma_ws=correct_value; Path=/';
    expect(extractCookieValue(raw, 'sigma_ws')).toBe('correct_value');
  });

  // Audit độc lập 26/7 (finding MEDIUM, xem BUGS_FIXED.md): TRƯỚC ĐÂY regex KHÔNG neo đầu tên cookie — khớp
  // theo substring bất kỳ vị trí, nên tên cookie KHÁC kết thúc bằng đúng chuỗi tên đang tìm sẽ bị đọc NHẦM
  // giá trị (khác test tiền-tố ở trên — đây là trường hợp tên lạ CHỨA tên thật ở PHÍA CUỐI). Đã sửa neo
  // `(?:^|;\s*)` — chỉ khớp khi tên cookie đứng ở đầu chuỗi hoặc ngay sau ranh giới `;`.
  it('không nhầm cookie khác có tên KẾT THÚC bằng đúng chuỗi tên đang tìm (regex phải neo đầu)', () => {
    const raw = 'xsigma_ws=SAI; sigma_ws=dung; Path=/';
    expect(extractCookieValue(raw, 'sigma_ws')).toBe('dung');
  });

  it('cookie cần tìm nằm NGAY ĐẦU header (không có gì đứng trước) → vẫn khớp đúng', () => {
    expect(extractCookieValue('sigma_ws=abc; Path=/', 'sigma_ws')).toBe('abc');
  });
});
