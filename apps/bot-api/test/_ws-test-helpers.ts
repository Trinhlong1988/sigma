// SIGMA Phase 3 "real-time" (29/7) — helper DÙNG CHUNG cho chat-realtime-proxy.test.ts/chat-realtime-
// e2e.test.ts: buffer message WebSocket THẬT (KHÔNG mock).
//
// BUG THẬT tự bắt được lúc build test (KHÔNG suy đoán — verify bằng log timestamp thật): đăng ký
// `ws.on('open', resolve)` rồi SAU KHI `await` promise đó mới đăng ký `ws.on('message', handler)` (2 bước
// tách rời) có RACE THẬT — server gửi `{msg:'ready'}` NGAY trong callback `wss.handleUpgrade()` (đồng bộ),
// dữ liệu đó có thể tới và được `ws` (thư viện) phát sự kiện `'message'` CÙNG lượt đồng bộ ngay sau `'open'`,
// TRƯỚC KHI phần code sau `await` (đăng ký listener `'message'`) kịp chạy (đó là 1 microtask riêng, chạy SAU).
// Kết quả: message `ready` bị "trôi mất" — verify bằng debug log thật (`ws.on('message', ...)` đăng ký NGAY
// lúc tạo `ws` THẤY được message, còn code đăng ký SAU khi đợi `'open'` xong thì KHÔNG) — đây LÀ NGUYÊN NHÂN
// gốc khiến `chat-realtime-proxy.test.ts`/`chat-realtime-e2e.test.ts` treo tới hookTimeout lúc build đầu tiên,
// KHÔNG phải bug ở chat-realtime-proxy.ts/chat-realtime-hub.ts (server gửi đúng, gửi kịp — xác nhận qua debug
// log). FIX: đăng ký ĐÚNG 1 listener `'message'` NGAY LÚC TẠO `ws` (trước cả khi đợi `'open'`), buffer MỌI
// message parse được vào mảng — `waitFor()`/`expectNone()` tự tra buffer TRƯỚC (message đã tới từ sớm) rồi mới
// đăng ký waiter chờ message TƯƠNG LAI nếu chưa có — loại bỏ hoàn toàn khoảng hở race bất kể thứ tự gọi.
import type { WebSocket } from 'ws';

export interface WsMessageBuffer {
  /** Trả message ĐẦU TIÊN (đã tới từ trước HOẶC sẽ tới) khớp `predicate` — tự xóa khỏi buffer khi lấy ra (mỗi
   * message chỉ tiêu thụ được 1 lần bởi 1 lệnh gọi waitFor, giống hàng đợi FIFO theo predicate). */
  waitFor(predicate: (data: Record<string, unknown>) => boolean, timeoutMs?: number): Promise<Record<string, unknown>>;
  /** Xác nhận KHÔNG có/sẽ không có message nào khớp `predicate` trong `windowMs` — reject NGAY nếu buffer ĐÃ
   * có sẵn 1 message khớp (không cần đợi hết cửa sổ mới phát hiện). */
  expectNone(predicate: (data: Record<string, unknown>) => boolean, windowMs?: number): Promise<void>;
}

export function attachMessageBuffer(ws: WebSocket): WsMessageBuffer {
  const buffer: Record<string, unknown>[] = [];
  const waiters: Array<{ predicate: (data: Record<string, unknown>) => boolean; deliver: (data: Record<string, unknown>) => void }> = [];

  // Đăng ký NGAY — KHÔNG đợi 'open', KHÔNG đợi bất kỳ await nào trước đó (xem lý do ở comment đầu file).
  ws.on('message', (raw: unknown) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse((raw as Buffer).toString());
    } catch {
      return;
    }
    const idx = waiters.findIndex((w) => w.predicate(data));
    if (idx !== -1) {
      const [w] = waiters.splice(idx, 1);
      w.deliver(data);
      return;
    }
    buffer.push(data);
  });

  function waitFor(predicate: (data: Record<string, unknown>) => boolean, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const bufIdx = buffer.findIndex(predicate);
    if (bufIdx !== -1) {
      const [data] = buffer.splice(bufIdx, 1);
      return Promise.resolve(data);
    }
    return new Promise((resolve, reject) => {
      const entry = {
        predicate,
        deliver: (data: Record<string, unknown>) => {
          clearTimeout(timer);
          resolve(data);
        }
      };
      const timer = setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i !== -1) waiters.splice(i, 1);
        reject(new Error('waitFor: hết thời gian chờ'));
      }, timeoutMs);
      waiters.push(entry);
    });
  }

  function expectNone(predicate: (data: Record<string, unknown>) => boolean, windowMs = 800): Promise<void> {
    const already = buffer.find(predicate);
    if (already) return Promise.reject(new Error(`Đã có sẵn message KHÔNG được phép nhận trong buffer: ${JSON.stringify(already)}`));

    return new Promise((resolve, reject) => {
      const entry = {
        predicate,
        deliver: (data: Record<string, unknown>) => {
          clearTimeout(timer);
          reject(new Error(`Nhận được message KHÔNG được phép nhận: ${JSON.stringify(data)}`));
        }
      };
      waiters.push(entry);
      const timer = setTimeout(() => {
        const i = waiters.indexOf(entry);
        if (i !== -1) waiters.splice(i, 1);
        resolve();
      }, windowMs);
    });
  }

  return { waitFor, expectNone };
}
