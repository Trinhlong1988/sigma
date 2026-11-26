// LANE A Vòng 2 (3/8) — chống rò file descriptor / DoS 24/7 qua upgrade path lạ.
//
// VẤN ĐỀ: mỗi endpoint WebSocket tự đăng ký 1 listener `server.on('upgrade')` RIÊNG và RETURN sớm cho path nó
// KHÔNG sở hữu (xem attachChatRealtimeProxy/attachCallSignaling — `if (!url.startsWith(PATH)) return;`). Vì vậy
// 1 upgrade request tới path KHÔNG endpoint nào sở hữu (vd `/v1/khong-ton-tai`, hoặc dò quét) sẽ KHÔNG có
// listener nào gọi handleUpgrade() HAY socket.destroy() → Node để nguyên socket TCP nửa-mở (server đã nhận
// header `Upgrade` nhưng không bao giờ trả lời), GIỮ 1 file descriptor tới khi timeout tầng OS/proxy. Kẻ tấn
// công mở hàng loạt kết nối kiểu này để cạn FD (DoS) — process bot-api chạy 24/7 nên rò tích lũy.
//
// GIẢI PHÁP: đăng ký guard này CUỐI CÙNG (sau MỌI endpoint WS thật) — mọi upgrade có url KHÔNG khớp path WS
// hợp lệ nào → đóng NGAY (fail-closed). Upgrade tới path hợp lệ KHÔNG bị đụng ở đây (listener chuyên trách của
// endpoint đó tự xử lý; guard chỉ RETURN, để nguyên). Node phát sự kiện 'upgrade' cho MỌI listener nên thứ tự
// đăng ký không đổi tính đúng đắn — nhưng đăng ký cuối cho rõ ý đồ "lưới an toàn sau cùng".
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import type { Socket } from 'node:net';
import { CHAT_REALTIME_PATH } from './chat-realtime-proxy.js';
import { CALL_SIGNALING_PATH } from './call-signaling-server.js';

/** Danh sách path WebSocket HỢP LỆ đang phục vụ. Thêm endpoint WS mới → thêm path vào đây (nếu không, upgrade
 * tới endpoint mới sẽ bị guard đóng nhầm). rc-realtime-proxy (relay Rocket.Chat) ĐÃ XÓA (Phase 6, 30/7) — nếu
 * khôi phục, thêm lại path của nó. */
export const KNOWN_WS_UPGRADE_PATHS: readonly string[] = [CHAT_REALTIME_PATH, CALL_SIGNALING_PATH];

export function attachUnknownUpgradeGuard(server: HttpServer): void {
  server.on('upgrade', (req: IncomingMessage, socket: Socket) => {
    const url = req.url ?? '';
    if (KNOWN_WS_UPGRADE_PATHS.some((p) => url.startsWith(p))) return; // endpoint chuyên trách tự xử lý.
    try {
      socket.destroy();
    } catch {
      // socket đã đóng — bỏ qua.
    }
  });
}
