// "Tạo nhóm chat cùng người này" (Admin Demo, 30/7) — test THUẦN cho lib/create-group-from-dm.ts + 1 test tích
// hợp mỏng xác nhận `createGroupChatRoom()` (chat-client.ts, wrapper ĐÃ CÓ SẴN từ Phase 3) gọi ĐÚNG endpoint +
// body khi được nạp payload do `buildCreateGroupMemberIds()` dựng ra.
//
// KHÔNG render `CreateGroupFromDmModal.tsx`/`ConversationScreen.tsx` ở đây — repo này CHƯA cài jsdom/
// @testing-library/react, mọi test *.test.ts hiện có ở apps/web-demo/src/lib (attachment-blob/lunar-calendar/
// rc-message-split/call-signaling-navigation) đều "pure-logic, environment node" (xem comment đầu
// attachment-blob.test.ts) — KHÔNG tự ý thêm dependency mới ngoài phạm vi fix/feature này. "Nút chỉ hiện cho
// phòng DIRECT" được test ở ĐÚNG lớp logic quyết định thật (`canCreateGroupFromRoom()`) mà
// ConversationScreen.tsx gọi để gate render — JSX chỉ là `{canCreateGroupFromRoom(room) && <button.../>}`,
// không còn logic nào khác đáng test riêng ở tầng render.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildCreateGroupMemberIds,
  buildDefaultGroupName,
  buildStandaloneGroupMemberIds,
  canCreateGroupFromRoom,
  formatCreateGroupErrorVi,
  MIN_ADDITIONAL_FRIENDS_TO_CREATE_GROUP,
  MIN_FRIENDS_TO_CREATE_STANDALONE_GROUP,
  validateGroupFriendSelection,
  validateStandaloneGroupSelection
} from './create-group-from-dm';
import { createGroupChatRoom } from './chat-client';

describe('canCreateGroupFromRoom', () => {
  it('true cho phòng DIRECT (isGroup:false) — nút "Tạo nhóm chat cùng người này" CHỈ hiện ở đây', () => {
    expect(canCreateGroupFromRoom({ isGroup: false })).toBe(true);
  });

  it('false cho phòng GROUP (isGroup:true) — nhóm đã sẵn nhiều người, không hiện nút tạo nhóm mới', () => {
    expect(canCreateGroupFromRoom({ isGroup: true })).toBe(false);
  });
});

describe('validateGroupFriendSelection', () => {
  it('0 bạn được chọn → KHÔNG hợp lệ, kèm thông báo tiếng Việt rõ ràng (nhóm cần tối thiểu 3 người)', () => {
    const r = validateGroupFriendSelection(0);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/ít nhất 1 người bạn/i);
    expect(r.message).toMatch(/tối thiểu 3 người/i);
  });

  it(`đúng ngưỡng MIN_ADDITIONAL_FRIENDS_TO_CREATE_GROUP (${MIN_ADDITIONAL_FRIENDS_TO_CREATE_GROUP}) → hợp lệ`, () => {
    expect(validateGroupFriendSelection(MIN_ADDITIONAL_FRIENDS_TO_CREATE_GROUP).ok).toBe(true);
  });

  it('chọn nhiều hơn ngưỡng vẫn hợp lệ', () => {
    expect(validateGroupFriendSelection(5).ok).toBe(true);
  });
});

// ── Luồng tạo nhóm ĐỘC LẬP (nút "Tạo nhóm chat" ở ChatListScreen, 5/8) — ngưỡng ≥2 bạn (KHÔNG có đối phương DM) ──
describe('validateStandaloneGroupSelection', () => {
  it(`ngưỡng MIN_FRIENDS_TO_CREATE_STANDALONE_GROUP = 2 (khớp server distinctMembers.length < 2)`, () => {
    expect(MIN_FRIENDS_TO_CREATE_STANDALONE_GROUP).toBe(2);
  });

  it('0 và 1 bạn → KHÔNG hợp lệ (cần tối thiểu 3 người)', () => {
    for (const n of [0, 1]) {
      const r = validateStandaloneGroupSelection(n);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/ít nhất 2 người bạn/i);
      expect(r.message).toMatch(/tối thiểu 3 người/i);
    }
  });

  it('2 bạn (đúng ngưỡng) và nhiều hơn → hợp lệ', () => {
    expect(validateStandaloneGroupSelection(2).ok).toBe(true);
    expect(validateStandaloneGroupSelection(7).ok).toBe(true);
  });
});

describe('buildStandaloneGroupMemberIds', () => {
  it('trả về CHỈ các bạn đã chọn (KHÔNG kèm đối phương DM) đúng thứ tự', () => {
    expect(buildStandaloneGroupMemberIds([202, 303])).toEqual([202, 303]);
  });

  it('dedupe id trùng (double-click race)', () => {
    expect(buildStandaloneGroupMemberIds([202, 202, 303])).toEqual([202, 303]);
  });
});

describe('buildCreateGroupMemberIds', () => {
  it('trả về [đối phương DM, ...bạn đã chọn] ĐÚNG THỨ TỰ — đây là payload gửi cho createGroupChatRoom()', () => {
    expect(buildCreateGroupMemberIds(101, [202, 303])).toEqual([101, 202, 303]);
  });

  it('dedupe nếu danh sách chọn LỠ trùng chính đối phương (phòng ngừa, dù UI phải tự loại đối phương khỏi picker)', () => {
    expect(buildCreateGroupMemberIds(101, [101, 202])).toEqual([101, 202]);
  });

  it('dedupe bạn được chọn trùng nhau (double-click race)', () => {
    expect(buildCreateGroupMemberIds(101, [202, 202])).toEqual([101, 202]);
  });
});

describe('buildDefaultGroupName', () => {
  it('ghép tên các thành viên khác creator cách nhau ", "', () => {
    expect(buildDefaultGroupName(['Nguyễn Văn A', 'Trần Thị B'])).toBe('Nguyễn Văn A, Trần Thị B');
  });

  it('mảng rỗng/toàn chuỗi trắng → fallback "Nhóm mới" (server từ chối tên rỗng)', () => {
    expect(buildDefaultGroupName([])).toBe('Nhóm mới');
    expect(buildDefaultGroupName(['', '   '])).toBe('Nhóm mới');
  });

  it('cắt còn tối đa 100 ký tự kèm "..." nếu tên ghép quá dài (server giới hạn 100 ký tự)', () => {
    const longNames = Array.from({ length: 20 }, (_, i) => `Thành viên số ${i} tên rất dài để test`);
    const name = buildDefaultGroupName(longNames);
    expect(name.length).toBe(100);
    expect(name.endsWith('...')).toBe(true);
  });
});

describe('formatCreateGroupErrorVi', () => {
  it('thêm tiền tố "Tạo nhóm thất bại:" CÙNG quy ước banner lỗi hiện có (Xóa tin nhắn thất bại:/Gửi tin nhắn thất bại:)', () => {
    expect(formatCreateGroupErrorVi('Không thể mời agent id=5 vào nhóm — chưa là bạn bè hoặc đã chặn nhau.')).toBe(
      'Tạo nhóm thất bại: Không thể mời agent id=5 vào nhóm — chưa là bạn bè hoặc đã chặn nhau.'
    );
  });
});

// ── Tích hợp mỏng: createGroupChatRoom() (chat-client.ts, wrapper CÓ SẴN từ Phase 3) gọi ĐÚNG endpoint/body ──
describe('createGroupChatRoom (tích hợp payload từ buildCreateGroupMemberIds)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('POST /v1/chat/rooms/group với {name, memberAgentIds} ĐÚNG [đối phương, ...đã chọn] khi tạo nhóm thành công', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        ({
          ok: true,
          status: 201,
          json: async () => ({ ok: true, data: { id: 'room-new-group-1', type: 'GROUP' } })
        }) as unknown as Response
    );
    vi.stubGlobal('fetch', fetchMock);

    const memberIds = buildCreateGroupMemberIds(101, [202, 303]);
    const res = await createGroupChatRoom('Nhóm test', memberIds);

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.data.id).toBe('room-new-group-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0];
    expect(String(calledUrl)).toBe('http://localhost:8788/v1/chat/rooms/group');
    expect(calledInit?.method).toBe('POST');
    expect(JSON.parse(String(calledInit?.body))).toEqual({ name: 'Nhóm test', memberAgentIds: [101, 202, 303] });
  });

  it('server từ chối (VALIDATION "nhóm cần ≥3 người"/CANNOT_MESSAGE bạn bị chặn) → {ok:false}, message hiển thị được qua formatCreateGroupErrorVi', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        ({
          ok: false,
          status: 403,
          json: async () => ({
            ok: false,
            error: 'CANNOT_MESSAGE',
            message: 'Không thể mời agent id=303 vào nhóm — chưa là bạn bè hoặc đã chặn nhau.'
          })
        }) as unknown as Response
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await createGroupChatRoom('Nhóm test', [101, 202, 303]);

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error).toBe('CANNOT_MESSAGE');
      expect(formatCreateGroupErrorVi(res.message)).toBe(
        'Tạo nhóm thất bại: Không thể mời agent id=303 vào nhóm — chưa là bạn bè hoặc đã chặn nhau.'
      );
    }
  });
});
