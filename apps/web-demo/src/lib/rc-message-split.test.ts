// Test thuật toán tách tin nhắn dài (rc-realtime.ts splitMessageIntoChunks) — mục "Giới hạn ký tự 1 lần soạn
// tin + tự tách khi vượt" (B29-tiếp, 26/7). Hàm THUẦN (không gọi RC/DOM) — chạy qua ROOT vitest config
// (vitest.config.ts include đã thêm file này), CÙNG quy ước "pure-logic test" như lunar-calendar.test.ts.
//
// MAX_MESSAGE_CHARS=2000 là quyết định UX tự chọn (xem comment rc-realtime.ts) — RC thật giới hạn cứng 5000
// (đã tự verify qua GET /api/v1/settings/Message_MaxAllowedSize trên production, xem báo cáo cuối). Test ở
// đây dùng maxChars NHỎ (10/20) để dễ viết case xác định thay vì chờ chuỗi 2000 ký tự thật.
import { describe, expect, it } from 'vitest';
import { MAX_MESSAGE_CHARS, splitMessageIntoChunks } from './rc-realtime';

describe('splitMessageIntoChunks', () => {
  it('văn bản ngắn hơn ngưỡng → trả nguyên 1 đoạn, không tách', () => {
    expect(splitMessageIntoChunks('xin chào', 20)).toEqual(['xin chào']);
  });

  it('văn bản DÀI ĐÚNG BẰNG ngưỡng → vẫn 1 đoạn (không tách thừa)', () => {
    const text = 'a'.repeat(20);
    expect(splitMessageIntoChunks(text, 20)).toEqual([text]);
  });

  it('chuỗi rỗng/toàn khoảng trắng → mảng rỗng', () => {
    expect(splitMessageIntoChunks('', 20)).toEqual([]);
    expect(splitMessageIntoChunks('   \n  ', 20)).toEqual([]);
  });

  it('tách theo ranh giới TỪ, không cắt giữa 1 từ khi tránh được', () => {
    // "aaa bbb ccc ddd" (15 ký tự) với maxChars=8 — mỗi từ 3 ký tự + 1 dấu cách.
    const result = splitMessageIntoChunks('aaa bbb ccc ddd', 8);
    // Mọi từ gốc phải xuất hiện NGUYÊN VẸN (không bị cắt đôi) ở đúng 1 đoạn nào đó.
    const rejoined = result.join(' ');
    for (const word of ['aaa', 'bbb', 'ccc', 'ddd']) {
      expect(rejoined).toContain(word);
    }
    // Không đoạn nào vượt ngưỡng.
    for (const chunk of result) expect(chunk.length).toBeLessThanOrEqual(8);
    // Ghép lại đúng thứ tự nguyên văn nội dung (bỏ khoảng trắng thừa ở biên đoạn).
    expect(result.join(' ')).toBe('aaa bbb ccc ddd');
  });

  it('giữ đúng thứ tự nội dung qua nhiều đoạn dài hơn thực tế (100 từ, maxChars=50)', () => {
    const words = Array.from({ length: 100 }, (_, i) => `tu${i}`);
    const text = words.join(' ');
    const result = splitMessageIntoChunks(text, 50);
    expect(result.length).toBeGreaterThan(1);
    for (const chunk of result) expect(chunk.length).toBeLessThanOrEqual(50);
    // Nối lại toàn bộ các đoạn (bằng dấu cách) phải cho lại đúng chuỗi từ theo đúng thứ tự gốc.
    const rejoinedWords = result.join(' ').split(/\s+/).filter(Boolean);
    expect(rejoinedWords).toEqual(words);
  });

  it('1 từ đơn lẻ dài hơn cả ngưỡng (không có khoảng trắng) → cắt cứng theo maxChars', () => {
    const longWord = 'x'.repeat(25);
    const result = splitMessageIntoChunks(longWord, 10);
    expect(result).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx']);
    expect(result.join('')).toBe(longWord);
  });

  it('từ dài hơn ngưỡng nằm GIỮA các từ ngắn khác → các từ ngắn không bị ảnh hưởng, từ dài tự cắt cứng riêng', () => {
    const longWord = 'y'.repeat(15);
    const result = splitMessageIntoChunks(`ngan1 ${longWord} ngan2`, 10);
    expect(result[0]).toBe('ngan1');
    expect(result.at(-1)).toBe('ngan2');
    // Đoạn giữa (từ dài) phải được cắt thành các mẩu ≤10 ký tự, ghép lại đúng nguyên văn.
    const middleChunks = result.slice(1, -1);
    expect(middleChunks.join('')).toBe(longWord);
    for (const c of middleChunks) expect(c.length).toBeLessThanOrEqual(10);
  });

  it('giữ nguyên xuống dòng khi tách (không gộp nhiều dòng thành 1 dòng)', () => {
    const text = 'dong1\ndong2\ndong3';
    const result = splitMessageIntoChunks(text, 6);
    // Mỗi dòng gốc phải xuất hiện đâu đó trong kết quả, không bị dính liền mất newline.
    expect(result.join('\n')).toContain('dong1');
    expect(result.join('\n')).toContain('dong2');
    expect(result.join('\n')).toContain('dong3');
  });

  it('maxChars=0 hoặc âm → throw lỗi rõ ràng (không âm thầm trả kết quả sai)', () => {
    expect(() => splitMessageIntoChunks('abc', 0)).toThrow();
    expect(() => splitMessageIntoChunks('abc', -5)).toThrow();
  });

  it('MAX_MESSAGE_CHARS mặc định = 2000, luôn nhỏ hơn ngưỡng cứng RC production (5000, đã tự verify qua admin API)', () => {
    expect(MAX_MESSAGE_CHARS).toBe(2000);
    expect(MAX_MESSAGE_CHARS).toBeLessThan(5000);
  });

  it('văn bản tiếng Việt có dấu, nhiều đoạn — không làm hỏng ký tự Unicode khi tách', () => {
    const text = 'Xin chào các bạn, đây là một tin nhắn dài để kiểm tra việc tự động tách theo ranh giới từ khi vượt ngưỡng ký tự cho phép.';
    const result = splitMessageIntoChunks(text, 30);
    expect(result.length).toBeGreaterThan(1);
    expect(result.join(' ').replace(/\s+/g, ' ')).toBe(text.replace(/\s+/g, ' '));
  });

  // Audit độc lập 26/7 (finding MEDIUM, xem BUGS_FIXED.md) — ví dụ CHÍNH XÁC auditor nêu ra: chuỗi emoji liên
  // tiếp KHÔNG có khoảng trắng (1 "token" duy nhất) dài hơn maxChars → nhánh cắt cứng. Emoji 😀 nằm ngoài BMP,
  // chiếm 2 code unit UTF-16 (surrogate pair) — cắt thô theo `slice()` có thể rơi đúng giữa 1 cặp, tạo ký tự
  // mồ côi hỏng hiển thị. Test xác nhận KHÔNG còn xảy ra sau khi đổi sang `Array.from()` (duyệt theo code point).
  it('chuỗi emoji liên tiếp dài hơn ngưỡng (surrogate pair UTF-16) → cắt cứng KHÔNG làm vỡ ký tự', () => {
    const text = 'a' + '😀'.repeat(1001); // length = 2003 code unit UTF-16, đúng ví dụ auditor nêu.
    const result = splitMessageIntoChunks(text, 2000);
    expect(result.length).toBeGreaterThan(1);
    // Ghép lại toàn bộ các đoạn phải cho lại ĐÚNG NGUYÊN VĂN chuỗi gốc — nếu có ký tự mồ côi bị mất/hỏng,
    // phép so sánh nguyên văn này sẽ KHÔNG khớp.
    expect(result.join('')).toBe(text);
    // Mỗi đoạn phải là chuỗi UTF-16 HỢP LỆ Ở RANH GIỚI — không kết thúc bằng high surrogate mồ côi (0xD800-
    // 0xDBFF, nghĩa là nửa sau của cặp bị cắt sang đoạn kế tiếp) và không bắt đầu bằng low surrogate mồ côi
    // (0xDC00-0xDFFF, nghĩa là nửa đầu của cặp đã bị cắt ở đoạn trước) — đây chính xác là điều kiện gây hiển
    // thị ký tự vỡ khi 2 đoạn được gửi thành 2 TIN NHẮN RIÊNG (render độc lập, không nối lại chuỗi).
    for (const chunk of result) {
      const firstCode = chunk.charCodeAt(0);
      const lastCode = chunk.charCodeAt(chunk.length - 1);
      expect(firstCode >= 0xdc00 && firstCode <= 0xdfff).toBe(false);
      expect(lastCode >= 0xd800 && lastCode <= 0xdbff).toBe(false);
    }
  });
});
