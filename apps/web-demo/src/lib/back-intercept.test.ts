// REGRESSION (Admin Demo 18/8) — "back chỉ được lùi 1 bước; đang ở thông tin hội thoại bấm back phải về phòng chat,
// không nhảy thẳng danh sách phân loại". Stack chặn-back: overlay trên cùng đóng trước, nuốt sự kiện back.
import { describe, it, expect } from 'vitest';
import { pushBackHandler, runTopBackHandler, hasBackHandler, closeOverlayForNavigation } from './back-intercept';

describe('back-intercept — stack chặn back theo từng bước (LIFO)', () => {
  it('chưa có overlay → runTop trả false (caller tự xử route), hasBackHandler false', () => {
    expect(hasBackHandler()).toBe(false);
    expect(runTopBackHandler()).toBe(false);
  });

  it('1 overlay mở → back chạy handler CỦA NÓ + nuốt sự kiện (trả true)', () => {
    let closed = 0;
    const off = pushBackHandler(() => closed++);
    expect(hasBackHandler()).toBe(true);
    expect(runTopBackHandler()).toBe(true);
    expect(closed).toBe(1);
    off();
    expect(hasBackHandler()).toBe(false);
  });

  it('2 overlay chồng → back đóng cái TRÊN CÙNG trước (LIFO), lần back kế đóng cái dưới', () => {
    const order: string[] = [];
    const offA = pushBackHandler(() => order.push('A')); // panel
    const offB = pushBackHandler(() => order.push('B')); // dialog con mở sau (trên cùng)
    runTopBackHandler(); // đóng B trước
    offB();
    runTopBackHandler(); // rồi tới A
    offA();
    expect(order).toEqual(['B', 'A']);
    expect(hasBackHandler()).toBe(false);
  });

  it('gỡ handler (đóng overlay bằng nút X) → không còn bị nuốt back', () => {
    const off = pushBackHandler(() => {});
    off();
    expect(runTopBackHandler()).toBe(false);
  });

  it('gỡ handler giữa stack (không phải trên cùng) → chỉ gỡ đúng nó', () => {
    const calls: string[] = [];
    const offA = pushBackHandler(() => calls.push('A'));
    const offB = pushBackHandler(() => calls.push('B'));
    offA(); // gỡ A (ở giữa) — B vẫn trên cùng
    expect(runTopBackHandler()).toBe(true);
    offB();
    expect(calls).toEqual(['B']);
    expect(hasBackHandler()).toBe(false);
  });

  // BUG 1 (web) — closeOverlayForNavigation() báo "đóng vì điều hướng đi" để cleanup KHÔNG history.back gỡ sentinel.
  // NHÁNH history/popstate CẦN DOM+History thật (env 'node' này KHÔNG có → USE_HISTORY=false, hàm là no-op) nên
  // KHÔNG unit-test được vòng đời cờ ở đây — verify hành vi thật bằng Playwright/APK. Ở đây chỉ smoke-test: hàm
  // export gọi được, KHÔNG ném lỗi, và KHÔNG phá logic stack thuần (đăng ký/chạy/gỡ vẫn đúng sau khi gọi).
  it('closeOverlayForNavigation() gọi được, không ném lỗi, không phá stack', () => {
    expect(() => closeOverlayForNavigation()).not.toThrow();
    let closed = 0;
    const off = pushBackHandler(() => closed++);
    closeOverlayForNavigation(); // báo "sẽ điều hướng" — trên native/node là no-op an toàn.
    expect(runTopBackHandler()).toBe(true);
    expect(closed).toBe(1);
    off();
    expect(hasBackHandler()).toBe(false);
  });

  // BUG 3 (web, wedge-recovery, fix 21/8) — closePending/expectingPopRemoval TRƯỚC ĐÂY CHỈ được dọn ở cleanup
  // unmount. Nếu 1 handler CHẠY do popstate nhưng KHÔNG unmount overlay → cleanup không chạy → closePending kẹt
  // true VĨNH VIỄN → mọi back sau bị nuốt (back hỏng). FIX = setTimeout(0) trong listener popstate dọn cờ nếu
  // stack KHÔNG đổi (không unmount = wedge). LOGIC NÀY nằm HẲN trong listener 'popstate' + cờ module-private
  // (closePending/expectingPopRemoval KHÔNG export), CHỈ gắn khi USE_HISTORY=true (web có History/DOM). Env 'node'
  // này USE_HISTORY=false → popstate/pushState/setTimeout-reset đều KHÔNG chạy → KHÔNG unit-test được ở đây.
  // Verify hành vi thật (wedge → back kế chạy lại handler) bằng Playwright/APK. Ở đây chỉ khẳng định: sau nhiều
  // lượt chạy handler KHÔNG-gỡ (mô phỏng handler no-op), stack THUẦN vẫn không hỏng (handler trên cùng vẫn chạy được).
  it('handler no-op (không tự gỡ) lặp nhiều lần → stack thuần KHÔNG kẹt, vẫn chạy được (phần cờ popstate verify bằng Playwright)', () => {
    let ran = 0;
    const off = pushBackHandler(() => ran++); // KHÔNG gọi off() trong handler → mô phỏng overlay không unmount.
    expect(runTopBackHandler()).toBe(true);
    expect(runTopBackHandler()).toBe(true); // lần 2 vẫn chạy được (không bị nuốt ở tầng stack thuần).
    expect(ran).toBe(2);
    off();
    expect(hasBackHandler()).toBe(false);
  });
});
