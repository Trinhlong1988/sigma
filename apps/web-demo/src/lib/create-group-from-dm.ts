// "Tạo nhóm chat cùng người này" (Admin Demo, mục mới 30/7) — từ 1 cuộc trò chuyện DIRECT (1-1), cho phép chọn
// thêm ≥1 bạn bè để biến thành phòng GROUP mới (DM peer + người(chọn) + chính mình). Backend ĐÃ ĐỦ (không cần
// migration schema): `createGroupRoom()` (chat-room-service.ts) validate "nhóm cần ≥3 người" (creator + ≥2
// thành viên khác SAU khi loại trùng/loại creator, xem comment ở đó) + gate `canMessageAgent()` từng thành viên
// (chặn/chưa bạn bè → ném `CANNOT_MESSAGE`). Route `POST /v1/chat/rooms/group` + wrapper FE
// `createGroupChatRoom()` (chat-client.ts) ĐÃ CÓ SẴN TỪ TRƯỚC (Phase 3, 29/7) — KHÔNG viết lại, chỉ còn thiếu
// UI gọi tới. File này giữ TOÀN BỘ logic thuần (không JSX/không network) để test được ở environment 'node'
// (repo này CHƯA cài jsdom/@testing-library/react — mọi test *.test.ts hiện có ở apps/web-demo/src/lib đều
// "pure-logic", xem comment đầu attachment-blob.test.ts) — UI (CreateGroupFromDmModal.tsx) chỉ gọi các hàm ở
// đây, không tự chứa logic quyết định để tránh 2 nơi có thể lệch nhau.
import type { ChatRoom } from '../mock-data/types';

/** Chỉ phòng DIRECT (1-1) mới có nút "Tạo nhóm chat cùng người này" — phòng GROUP đã sẵn nhiều người rồi, dùng
 * "Thêm thành viên" (GroupInfoPanel, luồng khác) thay vì tạo nhóm mới. `room` chỉ cần field `isGroup` (kiểu UI
 * rút gọn `mock-data/types.ts` — KHÔNG có `type:'DIRECT'|'GROUP'` như DTO backend). */
export function canCreateGroupFromRoom(room: Pick<ChatRoom, 'isGroup'>): boolean {
  return !room.isGroup;
}

/** Server (`createGroupRoom()`) yêu cầu nhóm có ÍT NHẤT 3 người: creator + ≥2 thành viên khác SAU khi loại
 * trùng/loại creator. Ở luồng "tạo nhóm từ DM", 1 người đã CHẮC CHẮN có sẵn (đối phương DM hiện tại) — nên FE
 * chỉ cần chặn khi người dùng chọn THÊM 0 bạn bè nữa (tổng thành viên khác creator = 1 (đối phương) + 0 = 1,
 * chưa đủ 2). Chọn ≥1 bạn nữa mới đủ. Hằng số tách riêng — ĐỔI Ở ĐÚNG 1 CHỖ nếu server đổi ngưỡng (hiện khớp
 * `distinctMembers.length < 2` trong chat-room-service.ts). */
export const MIN_ADDITIONAL_FRIENDS_TO_CREATE_GROUP = 1;

export interface GroupSelectionValidation {
  ok: boolean;
  message?: string;
}

/** Validate CLIENT-SIDE trước khi gọi server — CÙNG NGƯỠNG với server (xem comment trên) để tránh round-trip
 * vô ích, NHƯNG server VẪN là nguồn kiểm tra thật (race condition: 1 bạn vừa chọn có thể đã bị chặn/rời bạn bè
 * ngay trước lúc bấm "Tạo nhóm" — server sẽ tự ném `CANNOT_MESSAGE`/`VALIDATION`, xem
 * `formatCreateGroupErrorVi()` bên dưới xử lý hiển thị lỗi đó). */
export function validateGroupFriendSelection(selectedFriendCount: number): GroupSelectionValidation {
  if (selectedFriendCount < MIN_ADDITIONAL_FRIENDS_TO_CREATE_GROUP) {
    return {
      ok: false,
      message: 'Chọn ít nhất 1 người bạn để tạo nhóm — nhóm chat cần tối thiểu 3 người (bạn + đối phương + người vừa chọn).'
    };
  }
  return { ok: true };
}

/** Thành viên gửi cho `createGroupChatRoom()` = đối phương DM hiện tại + các bạn đã chọn (theo THỨ TỰ chọn,
 * đối phương LUÔN đứng đầu). Loại trùng phòng khi bạn được chọn trùng chính đối phương (KHÔNG NÊN xảy ra vì
 * UI phải tự loại đối phương khỏi danh sách chọn được — nhưng phòng ngừa double-submit/race lặp id vẫn dedupe
 * ở đây, an toàn hơn tin riêng UI). Server (`createGroupRoom()`) cũng tự dedupe + tự loại creator riêng, nên
 * dedupe ở đây KHÔNG bắt buộc phải hoàn hảo — chỉ để gửi payload sạch, dễ debug. */
export function buildCreateGroupMemberIds(dmPeerAgentId: number, selectedFriendAgentIds: number[]): number[] {
  const ids = [dmPeerAgentId, ...selectedFriendAgentIds];
  return [...new Set(ids)];
}

/** Server yêu cầu `name` (nhóm) không rỗng, tối đa 100 ký tự (xem `updateChatRoomSettings()`/`createGroupRoom()`
 * chat-room-service.ts) — brief KHÔNG có luồng nào tạo nhóm trước đây trong app để tái dùng UX đặt tên, nên tự
 * sinh tên GỢI Ý hợp lý (Admin Demo có thể sửa lại trong ô nhập trước khi bấm "Tạo nhóm", KHÔNG ép buộc): ghép tên
 * hiển thị mọi thành viên khác creator, cách nhau ", ", cắt bớt còn tối đa 100 ký tự kèm "..." nếu quá dài.
 * Mảng rỗng (hiếm — chưa tra được tên ai) → fallback "Nhóm mới" (KHÔNG để trống, server sẽ từ chối). */
export function buildDefaultGroupName(memberNames: string[]): string {
  const joined = memberNames.filter((n) => n && n.trim().length > 0).join(', ');
  if (!joined) return 'Nhóm mới';
  const MAX = 100;
  if (joined.length <= MAX) return joined;
  return `${joined.slice(0, MAX - 3)}...`;
}

// ── Tạo nhóm ĐỘC LẬP (nút "Tạo nhóm chat" ở ChatListScreen, Admin Demo 5/8) — KHÁC luồng "từ DM" ở chỗ KHÔNG có
// sẵn 1 thành viên (đối phương DM): người dùng TỰ chọn TOÀN BỘ thành viên từ danh sách bạn bè. Vì thế ngưỡng
// tối thiểu ở đây là ≥2 bạn (KHÔNG phải ≥1 như luồng DM) để tổng thành viên khác creator ≥2 — KHỚP CHÍNH XÁC
// điều kiện server `distinctMembers.length < 2` trong chat-room-service.ts::createGroupRoom() ("Nhóm chat cần
// ít nhất 3 người"). Ngưỡng 2 là GROUNDED từ mã server đã đọc, KHÔNG suy luận.
export const MIN_FRIENDS_TO_CREATE_STANDALONE_GROUP = 2;

/** Validate CLIENT-SIDE cho luồng tạo nhóm ĐỘC LẬP — cần chọn ≥2 bạn. Server VẪN là nguồn kiểm tra thật
 * (race: 1 bạn vừa chọn có thể bị chặn/rời bạn bè ngay trước lúc bấm Tạo — server tự ném CANNOT_MESSAGE,
 * `formatCreateGroupErrorVi()` hiển thị). Dùng lại CÙNG interface `GroupSelectionValidation`. */
export function validateStandaloneGroupSelection(selectedFriendCount: number): GroupSelectionValidation {
  if (selectedFriendCount < MIN_FRIENDS_TO_CREATE_STANDALONE_GROUP) {
    return {
      ok: false,
      message: 'Chọn ít nhất 2 người bạn để tạo nhóm — nhóm chat cần tối thiểu 3 người (bạn + 2 thành viên khác).'
    };
  }
  return { ok: true };
}

/** Payload `memberAgentIds` gửi cho `createGroupChatRoom()` ở luồng độc lập = CHỈ các bạn đã chọn (KHÔNG kèm
 * đối phương DM như luồng kia). Dedupe phòng double-click/race (server cũng tự dedupe + loại creator, xem
 * chat-room-service.ts) — chỉ để gửi payload sạch, dễ debug. */
export function buildStandaloneGroupMemberIds(selectedFriendAgentIds: number[]): number[] {
  return [...new Set(selectedFriendAgentIds)];
}

/** Banner lỗi hiển thị khi `createGroupChatRoom()` trả `{ok:false}` — CÙNG QUY ƯỚC "<Hành động> thất bại:
 * <message server>" đã dùng khắp ConversationScreen.tsx (`Xóa tin nhắn thất bại:`/`Gửi tin nhắn thất bại:`/
 * `Thả cảm xúc thất bại:`) — server (`ChatServiceError`) đã tự trả message tiếng Việt rõ ràng cho MỌI mã lỗi
 * liên quan (`VALIDATION` "Nhóm chat cần ít nhất 3 người..."/`CANNOT_MESSAGE` "Không thể mời agent id=...vào
 * nhóm — chưa là bạn bè hoặc đã chặn nhau." — bao gồm CẢ trường hợp race "1 bạn vừa chọn vừa bị chặn/rời bạn
 * bè ngay trước lúc bấm Tạo nhóm", server tự phát hiện lại), KHÔNG cần FE tự đoán/viết lại nội dung theo từng
 * mã — chỉ thêm tiền tố ngữ cảnh cho nhất quán UI. */
export function formatCreateGroupErrorVi(serverMessage: string): string {
  return `Tạo nhóm thất bại: ${serverMessage}`;
}
