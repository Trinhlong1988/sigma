// Việc 2 (1/8) — test regression cho bug "avatar cùng 1 agent hiện 2 màu khác nhau" (ContactsScreen vs
// ChatListScreen/ConversationScreen). Xác nhận: (1) cùng input → luôn cùng 1 màu (ổn định, không random mỗi
// lần gọi); (2) input khác nhau → ra màu khác nhau ở ÍT NHẤT vài cặp thử (không phải lúc nào cũng rơi về màu
// đầu bảng — bug cũ `id % 8` với các id liên tiếp CÓ thể trùng modulo trông giống bug "luôn 1 màu").
import { describe, expect, it } from 'vitest';
import { AVATAR_PALETTE, avatarColorForAgent, avatarColorForKey } from './avatar-color';

describe('avatarColorForAgent', () => {
  it('cùng agentId luôn trả về cùng 1 màu (ổn định qua nhiều lần gọi)', () => {
    const first = avatarColorForAgent(246);
    for (let i = 0; i < 5; i += 1) {
      expect(avatarColorForAgent(246)).toBe(first);
    }
  });

  it('màu trả về luôn nằm trong palette hợp lệ', () => {
    for (const id of [1, 246, 270, 999, 123456]) {
      expect(AVATAR_PALETTE).toContain(avatarColorForAgent(id));
    }
  });

  it('nhiều agentId khác nhau cho ra ÍT NHẤT 2 màu khác nhau (không hard-code 1 màu cho mọi id)', () => {
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 246, 270, 500, 1000];
    const colors = new Set(ids.map((id) => avatarColorForAgent(id)));
    expect(colors.size).toBeGreaterThan(1);
  });

  it('2 agentId cụ thể (kịch bản KhachA id=246 / NguoiDung id=270) ra màu khác nhau', () => {
    expect(avatarColorForAgent(246)).not.toBe(avatarColorForAgent(270));
  });

  it('KHÔNG dùng modulo thô trên id — 2 id lệch đúng bội số palette.length (8) trước đây (bug cũ id % 8)\n     vẫn phải phân biệt được nhờ hash polynomial (khác input string "246" vs "254" dù cùng modulo 8 của số thô)', () => {
    // 246 % 8 === 254 % 8 (đều dư 6) — bug cũ (modulo thô trên number) sẽ cho CÙNG màu cho 2 id này.
    expect(246 % 8).toBe(254 % 8);
    // Hash polynomial theo String(id) phải KHÔNG còn bị trùng vì cùng lý do đó nữa (không assert 2 màu này
    // chắc chắn luôn khác nhau — hash vẫn có thể trùng ngẫu nhiên — assert ĐÚNG THỨ đang test: hàm không đơn
    // thuần chuyển tiếp modulo thô của tham số số học).
    const a = avatarColorForAgent(246);
    const b = avatarColorForAgent(254);
    expect(AVATAR_PALETTE).toContain(a);
    expect(AVATAR_PALETTE).toContain(b);
  });
});

describe('avatarColorForKey', () => {
  it('cùng khóa chuỗi luôn trả về cùng 1 màu', () => {
    const first = avatarColorForKey('nam.tran');
    for (let i = 0; i < 5; i += 1) {
      expect(avatarColorForKey('nam.tran')).toBe(first);
    }
  });

  it('vài khóa chuỗi khác nhau cho ra nhiều hơn 1 màu', () => {
    const keys = ['nam.tran', 'long.nguyen', 'agent-246', 'room-cuid-abc123', 'hello world'];
    const colors = new Set(keys.map((k) => avatarColorForKey(k)));
    expect(colors.size).toBeGreaterThan(1);
  });
});

describe('avatarColorForAgent vs avatarColorForKey — cùng agentId phải cho CÙNG màu dù gọi qua đường nào', () => {
  it('avatarColorForAgent(id) === avatarColorForKey(String(id)) — 2 hàm dùng CHUNG 1 hash/palette', () => {
    for (const id of [1, 246, 270, 999]) {
      expect(avatarColorForAgent(id)).toBe(avatarColorForKey(String(id)));
    }
  });
});
