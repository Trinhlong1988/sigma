// SIGMA Phase 3+ (25/7, Admin Demo yêu cầu nguyên văn): "tính năng xóa tài khoản, tài khoản kể từ ngày xóa
// đến ngày có hiệu lực là 48h" — đại lý bấm "Xóa tài khoản" → có 48h ÂN HẠN (trong lúc đó có thể HỦY yêu cầu,
// đăng nhập lại bình thường) → sau ĐÚNG 48h mới THỰC SỰ xóa (vô hiệu hóa RC + đánh dấu Agent đã xóa).
//
// 25/7 (Admin Demo chốt: "xây worker" thay vì chỉ dựa lazy-check) — THÊM worker nền quét định kỳ
// (startDeletionSweepWorker, gọi từ index.ts lúc boot process thật, KHÔNG chạy trong test vì test chỉ
// import createApp() từ app.ts, không import file này theo đường index.ts). Lazy-check ở
// rc-auth-middleware.ts VẪN GIỮ NGUYÊN làm lưới an toàn thứ 2 (agent đăng nhập đúng lúc giữa 2 lần worker
// quét vẫn bị chặn ngay lập tức, không cần đợi worker) — 2 cơ chế dùng CHUNG 1 hàm thực thi
// (performAccountDeletion) để không lệch logic.
export const DELETION_GRACE_PERIOD_MS = 48 * 60 * 60 * 1000;

/** Mốc thời gian sẽ bị xóa THẬT, tính từ lúc yêu cầu xóa được ghi nhận. */
export function computeDeletionDeadline(deletionRequestedAt: Date): Date {
  return new Date(deletionRequestedAt.getTime() + DELETION_GRACE_PERIOD_MS);
}

/** true nếu đã quá 48h kể từ lúc yêu cầu xóa — dùng ở rc-auth-middleware.ts (lazy-check), worker, VÀ me.ts (hiển thị). */
export function isPastDeletionDeadline(deletionRequestedAt: Date, now: Date = new Date()): boolean {
  return now.getTime() >= computeDeletionDeadline(deletionRequestedAt).getTime();
}

// BUG "Nam đã xóa vẫn gửi được tin + vẫn 'đang hoạt động'" (5/8, Admin Demo báo) — GỐC: trong 48h ân hạn
// `deletedAt=null` nên auth (deletedAt:null) VẪN pass → gửi được + hiện active. Admin Demo chốt: 48h ân hạn CHỈ để
// UNDO việc purge dữ liệu, KHÔNG cho phép tài khoản HOẠT ĐỘNG. => coi tài khoản ĐÃ VÔ HIỆU HÓA cho mục đích
// GỬI TIN + REALTIME + HIỂN THỊ/PRESENCE ngay khi có `deletionRequestedAt` (đang chờ xóa) HOẶC `deletedAt` (đã
// xóa thật). 1 NGUỒN DUY NHẤT — mọi nơi enforce/hiển thị đọc hàm này, không tự viết lại điều kiện (tránh lệch).
//
// LƯU Ý (ghi rõ điểm spec 48h): CỐ Ý KHÔNG chặn ở `requireSession` (session-middleware.ts) — chủ tài khoản vẫn
// phải ĐĂNG NHẬP được để bấm HỦY yêu cầu xóa (POST /v1/me/cancel-deletion) trong 48h ân hạn. Vô hiệu hóa nằm ở
// tầng GỬI TIN (sendMessage 403) + REALTIME (từ chối WS) + cờ `deactivated` trong danh sách, KHÔNG ở tầng auth.
export function isAccountDeactivated(agent: { deletedAt: Date | null; deletionRequestedAt: Date | null }): boolean {
  return agent.deletedAt !== null || agent.deletionRequestedAt !== null;
}

/** Tên hiển thị THAY THẾ cho tài khoản đã vô hiệu hóa/đã xóa — dùng CHUNG ở mọi API/nơi hiển thị (danh bạ,
 * thành viên nhóm, header DM, người gửi tin cũ). 1 chuỗi duy nhất, KHÔNG bịa biến thể khác nhau giữa các màn. */
export const DEACTIVATED_DISPLAY_NAME = 'Tài khoản đã bị vô hiệu hóa';

type DeletableAgent = { id: number; rcUsername: string | null };

/**
 * Thực hiện xóa THẬT 1 Agent đã quá hạn 48h: soft-delete (deletedAt/deletedBy có sẵn) + nhường quyền chủ
 * phòng chat. DÙNG CHUNG bởi session-middleware.ts (lazy-check) VÀ sweep worker bên dưới — TÁCH RA ĐÂY để 2
 * nơi gọi không lệch logic. KHÔNG throw.
 *
 * LOẠI SẠCH Rocket.Chat (4/8) — TRƯỚC ĐÂY còn gọi `rcDeleteUser()` xóa tài khoản Rocket.Chat thật. RC đã bị
 * loại hoàn toàn (đăng nhập/đăng ký/hồ sơ đều độc lập RC, KHÔNG còn tạo RC user), nên việc xóa RC user vô
 * nghĩa → ĐÃ GỠ tham số `rcDeleteUser` + toàn bộ nhánh gọi RC. Xóa mềm Agent + nhường quyền chủ phòng là đủ.
 */
export async function performAccountDeletion(
  db: { agent: { update: (args: { where: { id: number }; data: { deletedAt: Date; deletedBy: number } }) => Promise<unknown> } },
  agent: DeletableAgent,
  // Phase 2 chat lõi (29/7, Admin Demo chốt "tài khoản bị xóa tự động nhường" quyền chủ phòng) — callback tùy
  // chọn, KHÔNG import thẳng chat-room-service.ts ở đây (giữ file này không phụ thuộc Phase 2/Db đầy đủ, đúng
  // kiểu structural-type tối giản đã có từ đầu) — nơi gọi performAccountDeletion() tự truyền hàm thật
  // (autoTransferOwnershipOnDeletion(db, agentId)) vì họ đã sẵn có `db` kiểu đầy đủ trong scope.
  transferChatOwnership?: (agentId: number) => Promise<void>
): Promise<void> {
  await db.agent.update({ where: { id: agent.id }, data: { deletedAt: new Date(), deletedBy: agent.id } });
  if (transferChatOwnership) {
    try {
      await transferChatOwnership(agent.id);
    } catch (err) {
      console.error(`[deletion-service] transferChatOwnership thất bại cho agent id=${agent.id} (best-effort, KHÔNG chặn xóa tài khoản):`, err);
    }
  }
}

export const DELETION_SWEEP_INTERVAL_MS = 15 * 60 * 1000; // quét mỗi 15 phút — đủ gần "đúng giờ" mà không dồn tải DB/RC liên tục.

/**
 * Worker nền: quét MỌI Agent còn sống (deletedAt null) có deletionRequestedAt đã quá hạn 48h → xóa thật.
 * Gọi 1 lần NGAY khi start (không đợi interval đầu tiên trôi qua) rồi lặp lại mỗi DELETION_SWEEP_INTERVAL_MS.
 * Trả về hàm `stop()` để test/shutdown có thể dừng interval (tránh leak timer giữ process sống mãi).
 */
export function startDeletionSweepWorker(
  db: {
    agent: {
      findMany: (args: { where: { deletedAt: null; deletionRequestedAt: { not: null } } }) => Promise<DeletableAgent[]>;
      update: (args: { where: { id: number }; data: { deletedAt: Date; deletedBy: number } }) => Promise<unknown>;
    };
  },
  intervalMs: number = DELETION_SWEEP_INTERVAL_MS,
  transferChatOwnership?: (agentId: number) => Promise<void>
): { stop: () => void } {
  async function sweep(): Promise<void> {
    // KHÔNG lọc deletionRequestedAt quá hạn ngay trong query Prisma (cần so sánh với deadline TÍNH TOÁN, không
    // phải cột thô) — lấy hết ứng viên "có yêu cầu xóa, còn sống" rồi lọc bằng isPastDeletionDeadline() cho
    // NHẤT QUÁN tuyệt đối với lazy-check (CÙNG 1 hàm tính hạn, không lệch logic giữa 2 nơi).
    const candidates = await db.agent.findMany({ where: { deletedAt: null, deletionRequestedAt: { not: null } } });
    for (const agent of candidates as unknown as Array<DeletableAgent & { deletionRequestedAt: Date }>) {
      if (isPastDeletionDeadline(agent.deletionRequestedAt)) {
        await performAccountDeletion(db, agent, transferChatOwnership);
      }
    }
  }

  // Quét ngay lúc start (không đợi 15 phút đầu) — bắt kịp các trường hợp đã quá hạn TỪ TRƯỚC KHI process này
  // khởi động (vd server restart sau khi đã có agent quá hạn chờ sẵn).
  sweep().catch((err) => console.error('[deletion-service] sweep worker lỗi (lần chạy đầu):', err));
  const timer = setInterval(() => {
    sweep().catch((err) => console.error('[deletion-service] sweep worker lỗi:', err));
  }, intervalMs);
  // unref() — timer KHÔNG giữ process sống nếu mọi việc khác đã xong (vd test runner) — chỉ có tác dụng khi
  // KHÔNG có gì khác giữ event loop (server thật luôn có app.listen() giữ sống, nên hành vi thật không đổi).
  timer.unref();

  return { stop: () => clearInterval(timer) };
}
