// Test cho computeContextMenuPosition() (context-menu-position.ts) — fix vị trí menu ngữ cảnh kiểu Zalo (1/8).
import { describe, expect, it } from 'vitest';
import { computeContextMenuPosition, type ContextMenuAnchorRect } from './context-menu-position';

const VIEWPORT_WIDTH = 400;
const VIEWPORT_HEIGHT = 800;
const MENU_WIDTH = 208;
const MENU_HEIGHT = 160;

function rect(overrides: Partial<ContextMenuAnchorRect>): ContextMenuAnchorRect {
  return { top: 100, bottom: 140, left: 20, right: 300, ...overrides };
}

describe('computeContextMenuPosition', () => {
  it('bubble ở NỬA TRÊN màn hình → menu mở XUỐNG DƯỚI bubble (top = bubble.bottom + gap)', () => {
    const pos = computeContextMenuPosition({
      bubbleRect: rect({ top: 100, bottom: 140 }),
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
      menuWidth: MENU_WIDTH,
      menuHeight: MENU_HEIGHT
    });
    expect(pos.top).toBeGreaterThan(140); // dưới mép bubble
    expect(pos.top).toBeLessThan(200); // sát bubble (gap nhỏ), không rơi xa
  });

  it('bubble ở NỬA DƯỚI màn hình → menu mở LÊN TRÊN bubble (top < bubble.top)', () => {
    const pos = computeContextMenuPosition({
      bubbleRect: rect({ top: 700, bottom: 740 }),
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
      menuWidth: MENU_WIDTH,
      menuHeight: MENU_HEIGHT
    });
    expect(pos.top).toBeLessThan(700);
    expect(pos.top + MENU_HEIGHT).toBeLessThanOrEqual(700); // không đè lên bubble
  });

  it('KHÔNG BAO GIỜ tràn mép TRÊN màn hình (bubble sát mép trên, mở lên vẫn clamp về margin)', () => {
    const pos = computeContextMenuPosition({
      bubbleRect: rect({ top: 780, bottom: 795 }), // gần đáy → openAbove=true nhưng menuHeight lớn hơn khoảng trống phía trên
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: 800,
      menuWidth: MENU_WIDTH,
      menuHeight: 700 // menu cao bất thường để ép trường hợp tràn
    });
    expect(pos.top).toBeGreaterThanOrEqual(8);
  });

  it('KHÔNG tràn mép DƯỚI màn hình (bubble ở nửa trên, menu mở xuống nhưng menu cao gần hết màn hình)', () => {
    const pos = computeContextMenuPosition({
      bubbleRect: rect({ top: 10, bottom: 40 }),
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
      menuWidth: MENU_WIDTH,
      menuHeight: 700
    });
    expect(pos.top + 700).toBeLessThanOrEqual(VIEWPORT_HEIGHT - 8 + 0.0001);
  });

  it('bubble sát mép TRÁI (mine=false, bubble.left nhỏ) → left clamp về margin, KHÔNG âm', () => {
    const pos = computeContextMenuPosition({
      bubbleRect: rect({ left: -50 }),
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
      menuWidth: MENU_WIDTH,
      menuHeight: MENU_HEIGHT
    });
    expect(pos.left).toBe(8);
  });

  it('bubble sát mép PHẢI (mine=true, bubble.left gần viewportWidth) → left clamp để menu KHÔNG tràn phải', () => {
    const pos = computeContextMenuPosition({
      bubbleRect: rect({ left: 380 }),
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
      menuWidth: MENU_WIDTH,
      menuHeight: MENU_HEIGHT
    });
    expect(pos.left + MENU_WIDTH).toBeLessThanOrEqual(VIEWPORT_WIDTH - 8 + 0.0001);
  });

  it('bubble nằm trong vùng an toàn (không sát mép nào) → left = bubble.left nguyên bản (không clamp thừa)', () => {
    const pos = computeContextMenuPosition({
      bubbleRect: rect({ left: 100 }),
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
      menuWidth: MENU_WIDTH,
      menuHeight: MENU_HEIGHT
    });
    expect(pos.left).toBe(100);
  });

  it('viewport nhỏ hơn menu (màn hình cực hẹp/thấp, hiếm) → KHÔNG throw, trả về margin thay vì NaN/vỡ layout', () => {
    const pos = computeContextMenuPosition({
      bubbleRect: rect({ top: 10, bottom: 20, left: 5 }),
      viewportWidth: 100, // nhỏ hơn menuWidth
      viewportHeight: 100, // nhỏ hơn menuHeight
      menuWidth: MENU_WIDTH,
      menuHeight: MENU_HEIGHT
    });
    expect(Number.isFinite(pos.left)).toBe(true);
    expect(Number.isFinite(pos.top)).toBe(true);
    expect(pos.left).toBe(8);
  });

  it('điểm giữa bubble ĐÚNG BẰNG viewportHeight/2 → coi là nửa TRÊN (mở xuống, không mở lên) — ranh giới nhất quán', () => {
    const pos = computeContextMenuPosition({
      bubbleRect: rect({ top: 380, bottom: 420 }), // mid = 400 = viewportHeight/2
      viewportWidth: VIEWPORT_WIDTH,
      viewportHeight: VIEWPORT_HEIGHT,
      menuWidth: MENU_WIDTH,
      menuHeight: MENU_HEIGHT
    });
    expect(pos.top).toBeGreaterThan(420); // mở xuống dưới bubble, không phải lên trên
  });
});
