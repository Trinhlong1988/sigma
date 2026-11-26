// Test NGUỒN DUY NHẤT màu avatar fallback server (fallback-avatar.ts) — chốt bằng MÃ HEX CỤ THỂ để phát hiện
// lệch với web (apps/web-demo/src/lib/avatar-color.ts). Nếu web đổi palette/hash mà quên đổi server → test đỏ.
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  AVATAR_PALETTE,
  hashString,
  avatarColorForAgent,
  avatarColorForKey,
  initialForName,
  renderFallbackAvatarPng,
  renderCircleLetterPng
} from '../src/fallback-avatar.js';

// ORACLE — sao chép NGUYÊN thuật toán web (avatar-color.ts) làm chuẩn độc lập, KHÔNG gọi hàm server, để so khớp.
const WEB_PALETTE = ['#16a34a', '#0579cc', '#f59e0b', '#dc2626', '#0891b2', '#7c3aed', '#db2777', '#65a30d'];
function webHash(key: string): number {
  let h = 0;
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h;
}
const webAgentColor = (id: number): string => WEB_PALETTE[webHash(String(id)) % 8];
const webKeyColor = (k: string): string => WEB_PALETTE[webHash(k) % 8];

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

describe('fallback-avatar — palette + hash KHỚP web BYTE-FOR-BYTE', () => {
  it('palette server == palette web (đúng thứ tự 8 mã hex)', () => {
    expect([...AVATAR_PALETTE]).toEqual(WEB_PALETTE);
  });

  it('hashString khớp công thức polynomial-31 unsigned của web', () => {
    for (const k of ['270', '384', 'abc', 'room_XYZ', 'Đông', '']) {
      expect(hashString(k)).toBe(webHash(k));
    }
  });

  it('avatarColorForAgent trả ĐÚNG mã hex cụ thể (270→#dc2626, 381→#0891b2, 384→#65a30d)', () => {
    expect(avatarColorForAgent(270)).toBe('#dc2626');
    expect(avatarColorForAgent(381)).toBe('#0891b2');
    expect(avatarColorForAgent(384)).toBe('#65a30d');
    // parity rộng với oracle web cho nhiều id
    for (const id of [1, 2, 7, 42, 100, 255, 270, 381, 384, 999, 12345]) {
      expect(avatarColorForAgent(id)).toBe(webAgentColor(id));
    }
  });

  it('avatarColorForKey (nhóm theo roomId) khớp oracle web', () => {
    for (const k of ['abc123', 'room_XYZ', 'cuidroom0001', 'nhom-alpha']) {
      expect(avatarColorForKey(k)).toBe(webKeyColor(k));
    }
    expect(avatarColorForKey('abc123')).toBe('#16a34a');
    expect(avatarColorForKey('room_XYZ')).toBe('#7c3aed');
  });
});

describe('fallback-avatar — chữ cái đầu KHỚP web (giữ dấu tiếng Việt, viết hoa)', () => {
  it('lấy 1 ký tự đầu sau trim, HOA, GIỮ dấu', () => {
    expect(initialForName('Đông Nguyễn')).toBe('Đ');
    expect(initialForName('ánh Dương')).toBe('Á');
    expect(initialForName('  quang  ')).toBe('Q');
    expect(initialForName('nam')).toBe('N');
  });
  it('tên rỗng/space → "?"', () => {
    expect(initialForName('')).toBe('?');
    expect(initialForName('   ')).toBe('?');
  });
});

describe('fallback-avatar — render PNG hợp lệ, đúng màu nền, có chữ trắng', () => {
  it('renderFallbackAvatarPng(agent) → PNG 192px, nền = màu agent, có pixel trắng (chữ)', async () => {
    const png = await renderFallbackAvatarPng('270', 270, 'Đông'); // màu #dc2626 = (220,38,38)
    // magic bytes PNG
    expect(png.subarray(0, 4).toString('latin1')).toBe('\x89PNG');

    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect(info.width).toBe(192);
    expect(info.height).toBe(192);
    const px = (x: number, y: number): number[] => {
      const i = (y * info.width + x) * info.channels;
      return [data[i], data[i + 1], data[i + 2]];
    };
    const [er, eg, eb] = hexToRgb('#dc2626');
    // Pixel gần đỉnh (trong vòng tròn, TRÊN chữ) = màu nền agent.
    const [br, bg, bb] = px(96, 14);
    expect(Math.abs(br - er) + Math.abs(bg - eg) + Math.abs(bb - eb)).toBeLessThan(12);
    // Có pixel trắng ở vùng giữa (chữ 'Đ' đã render).
    let white = 0;
    for (let y = 50; y < 142; y += 1) for (let x = 50; x < 142; x += 1) {
      const [r, g, b] = px(x, y);
      if (r > 220 && g > 220 && b > 220) white += 1;
    }
    expect(white).toBeGreaterThan(200);
  });

  it('nhóm (agentIdOrNull=null) dùng màu theo roomId', async () => {
    const png = await renderFallbackAvatarPng('abc123', null, 'Nhóm SigMa'); // #16a34a = (22,163,74)
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    const i = (14 * info.width + 96) * info.channels;
    const [er, eg, eb] = hexToRgb('#16a34a');
    expect(Math.abs(data[i] - er) + Math.abs(data[i + 1] - eg) + Math.abs(data[i + 2] - eb)).toBeLessThan(12);
  });

  it('cache: gọi lại cùng (màu,chữ) trả cùng buffer', async () => {
    const a = await renderCircleLetterPng('#0579cc', 'A');
    const b = await renderCircleLetterPng('#0579cc', 'A');
    expect(a).toBe(b); // cùng tham chiếu (cache hit)
  });
});
