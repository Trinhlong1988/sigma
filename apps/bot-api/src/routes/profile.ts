// Tra cứu công khai TỐI THIỂU 1 đại lý theo username Rocket.Chat (25/7 — mục "link cá nhân để kết bạn/nhắn
// tin", kế hoạch curried-plotting-hippo.md mục 24/34). Dùng khi người dùng bấm link `.../app/u/<rcUsername>`
// của người khác: frontend cần biết `agentId` để gọi tiếp `POST /v1/me/friends/request` (đã có sẵn ở
// friend-service.ts, KHÔNG đụng file đó — route này CHỈ đọc 1 hàng Agent, KHÔNG có nghiệp vụ kết bạn nào).
//
// FILE RIÊNG (không thêm vào routes/me.ts) — 25/7 có agent khác đang sửa song song đúng file me.ts (phần
// biệt danh/chặn bạn bè), tách riêng để tránh đụng độ chỉnh sửa đồng thời trên cùng 1 file.
import { Router } from 'express';
import { requireSession } from '../session-middleware.js';
import { getBotDb } from '../db.js';
import { asyncHandler } from '../async-handler.js';

export const profileRouter = Router();

// GET /v1/profile/by-rc-username/:username — trả {agentId, agentCode, agentName} tối thiểu. 404 nếu chưa có
// Agent nào (còn sống, deletedAt null) link đúng username RC này — KHÔNG suy đoán/bịa dữ liệu khi không tìm
// thấy (R9), trả lỗi rõ ràng để UI hiện đúng thông báo.
profileRouter.get(
  '/v1/profile/by-rc-username/:username',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    const username = req.params.username;
    const agent = await db.agent.findFirst({ where: { rcUsername: username, deletedAt: null } });
    if (!agent) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Không tìm thấy đại lý SigMa nào liên kết với tài khoản này.' });
      return;
    }
    res.json({ agentId: agent.id, agentCode: agent.code, agentName: agent.name });
  })
);

// GET /v1/profile/by-username/:username — hồ sơ CÔNG KHAI tối thiểu để hiển thị (tên/username/avatar), thay
// cho lời gọi RC `GET /api/v1/users.info` cũ (LOẠI SẠCH Rocket.Chat, 4/8). Đọc THẲNG bảng Agent nội bộ
// (rcUsername = tên đăng nhập link), KHÔNG còn phụ thuộc Rocket.Chat. Trả {name, username, avatarUrl?} —
// `avatarUrl` chỉ có khi đại lý ĐÃ tải avatar (avatarUpdatedAt != null), trỏ route đọc ảnh SẴN CÓ
// `GET /v1/agents/:id/avatar` (routes/me.ts, đọc theo :id nên NGƯỜI KHÁC xem được). CHỈ SELECT cột cần —
// KHÔNG kéo BLOB avatarImage/coverImage về (dùng avatarUpdatedAt làm cờ "có avatar", tránh tải ảnh nặng chỉ
// để biết có/không). 404 khi username chưa link Agent còn sống nào (R9 — không bịa dữ liệu).
//
// KHÔNG có khái niệm "trạng thái online/away/busy" trong hệ nội bộ (presence là của Rocket.Chat, đã loại) —
// client tự đặt trạng thái mặc định khi map (xem apps/web-demo/src/lib/rc-realtime.ts getRcUserInfoByUsername).
// CỜ CHO LEAD: nếu sau này cần presence thật thì phải xây riêng (WebSocket chat-realtime), ngoài phạm vi đợt dọn này.
profileRouter.get(
  '/v1/profile/by-username/:username',
  asyncHandler(requireSession),
  asyncHandler(async (req, res) => {
    const db = getBotDb();
    const username = req.params.username;
    const agent = await db.agent.findFirst({
      where: { rcUsername: username, deletedAt: null },
      select: { id: true, name: true, rcUsername: true, avatarUpdatedAt: true }
    });
    if (!agent || !agent.rcUsername) {
      res.status(404).json({ error: 'NOT_FOUND', message: 'Không tìm thấy người dùng này.' });
      return;
    }
    res.json({
      name: agent.name,
      username: agent.rcUsername,
      avatarUrl: agent.avatarUpdatedAt ? `/v1/agents/${agent.id}/avatar` : undefined
    });
  })
);
