// "Tạo nhóm chat cùng người này" (Admin Demo, 30/7) — mở từ ConversationScreen.tsx khi đang xem 1 phòng DIRECT
// (1-1). Cho chọn ≥1 bạn bè khác (đối phương DM hiện tại LUÔN nằm trong nhóm mới, không cần chọn lại) rồi tạo
// phòng GROUP thật qua `createGroupChatRoom()` (chat-client.ts — wrapper ĐÃ CÓ SẴN từ Phase 3 29/7, KHÔNG viết
// lại). Logic quyết định (validate/build payload/tên mặc định/format lỗi) nằm ở lib/create-group-from-dm.ts
// (thuần, có test riêng) — component này CHỈ gọi, không tự chứa quyết định để tránh lệch 2 nơi.
//
// Dữ liệu cần mà `room` (kiểu UI mock-data/types.ts, KHÔNG có otherAgentId) không mang sẵn: agentId của đối
// phương DM — tự gọi `getChatRoomDetail(dmRoom.id)` lúc mở modal (CÙNG cách GroupInfoPanel.tsx tự gọi riêng khi
// cần field không có trong `room` prop, xem comment ở đó) để tìm thành viên KHÁC `myAgentId` trong
// `ChatRoomDetailDto.members` (phòng DIRECT chỉ có đúng 2 thành viên).
import { useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react';
import { Loader2, Users } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';
import { inputCls } from './Field';
import type { ChatRoom } from '../mock-data/types';
import { createGroupChatRoom, getChatRoomDetail } from '../lib/chat-client';
import { assignChatRoomCategory, listMyFriends, notifyChatCategoriesChanged, type ChatCategoryDto, type FriendListItem } from '../lib/agent-api-client';
import { getCachedChatCategories } from '../lib/categories-cache';
import { avatarColorForAgent } from '../lib/avatar-color';
import { buildCreateGroupMemberIds, buildDefaultGroupName, formatCreateGroupErrorVi, validateGroupFriendSelection } from '../lib/create-group-from-dm';

/** CÙNG tiêu chí `isBlockedForMe()` ContactsScreen.tsx (không export được từ đó — viết lại tối giản ở đây,
 * KHÔNG sửa file đó): mình đã chặn HOẶC bị chặn → không mời được vào nhóm (server sẽ tự ném `CANNOT_MESSAGE`
 * nếu cố gửi, disable ở đây chỉ để tránh round-trip lỗi chắc chắn thất bại). */
function isBlockedForMe(f: FriendListItem): boolean {
  return f.blockedByMe || f.blockedThem;
}

// Item 7 (6/8) — ĐÃ XÓA palette + hàm `colorForAgent()` RIÊNG (modulo THÔ, LỆCH với avatar-color.ts) là 1 trong
// các nguồn khiến CÙNG 1 agent (vd Hoài An #384 không ảnh) hiện MỖI NƠI 1 MÀU. Dùng `avatarColorForAgent(agentId)`
// (NGUỒN DUY NHẤT, avatar-color.ts) như mọi nơi khác.

export function CreateGroupFromDmModal({
  dmRoom,
  myAgentId,
  onClose,
  onCreated
}: {
  dmRoom: ChatRoom;
  /** agentId số của chính mình — ConversationScreen.tsx đã tự gọi fetchAuthenticatedAgent() 1 lần, truyền
   * xuống (KHÔNG tự gọi lại ở đây, CÙNG pattern GroupInfoPanel.tsx). `null` = chưa sẵn sàng — modal tự chờ. */
  myAgentId: number | null;
  onClose: () => void;
  /** Gọi khi tạo nhóm THÀNH CÔNG, kèm id phòng GROUP mới — ConversationScreen.tsx tự quyết định điều hướng
   * (App.tsx ConversationRoute truyền `onGroupCreated` xuống, gọi `navigate(ROUTES.chatRoom(newRoomId))`, CÙNG
   * pattern `onBack`/`onStartCall` hiện có: ConversationScreen KHÔNG tự import react-router, chỉ nhận callback). */
  onCreated: (newRoomId: string) => void;
}): JSX.Element {
  const [peerAgentId, setPeerAgentId] = useState<number | null>(null);
  const [peerName, setPeerName] = useState<string>(dmRoom.name);
  const [peerError, setPeerError] = useState<string | null>(null);
  const [peerLoading, setPeerLoading] = useState(true);

  const [friends, setFriends] = useState<FriendListItem[] | null>(null);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [friendsLoading, setFriendsLoading] = useState(true);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);

  // Phân loại nhóm ngay khi tạo (Admin Demo 5/8) — KHÔNG bắt buộc. CÙNG cơ chế CreateGroupModal.tsx.
  const [categories, setCategories] = useState<ChatCategoryDto[]>([]);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    getCachedChatCategories().then((r) => {
      if (!cancelled && r.ok) setCategories(r.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Tìm agentId đối phương DM — chỉ gọi khi ĐÃ biết myAgentId (tránh so sánh sai lúc chưa sẵn sàng).
  useEffect(() => {
    if (myAgentId == null) return;
    let cancelled = false;
    setPeerLoading(true);
    setPeerError(null);
    getChatRoomDetail(dmRoom.id).then((r) => {
      if (cancelled) return;
      setPeerLoading(false);
      if (!r.ok) {
        setPeerError(r.message);
        return;
      }
      const other = r.data.members.find((m) => m.agentId !== myAgentId);
      if (!other) {
        setPeerError('Không xác định được đối phương của cuộc trò chuyện này.');
        return;
      }
      setPeerAgentId(other.agentId);
    });
    return () => {
      cancelled = true;
    };
  }, [dmRoom.id, myAgentId]);

  // Danh bạ bạn bè để chọn thêm — tải 1 lần lúc mở modal.
  useEffect(() => {
    let cancelled = false;
    setFriendsLoading(true);
    setFriendsError(null);
    listMyFriends().then((r) => {
      if (cancelled) return;
      setFriendsLoading(false);
      if (!r.ok) {
        setFriendsError(r.message);
        return;
      }
      setFriends(r.data.friends);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Loại đối phương DM khỏi danh sách chọn được — đối phương LUÔN có sẵn trong nhóm mới, không cần chọn lại.
  const selectableFriends = useMemo(() => (friends ?? []).filter((f) => f.agentId !== peerAgentId), [friends, peerAgentId]);

  // Tên nhóm gợi ý — tự cập nhật theo lựa chọn CHO TỚI KHI người dùng tự gõ tay vào ô tên (nameTouched), CÙNG
  // UX "gợi ý không ép buộc" (Field required nhưng có sẵn giá trị hợp lý).
  useEffect(() => {
    if (nameTouched) return;
    const selectedNames = selectableFriends.filter((f) => selected.has(f.agentId)).map((f) => f.nickname ?? f.agentName);
    setName(buildDefaultGroupName([peerName, ...selectedNames]));
  }, [nameTouched, peerName, peerAgentId, selected, selectableFriends]);

  useEffect(() => {
    setPeerName(dmRoom.name);
  }, [dmRoom.name]);

  function toggleSelect(agentId: number): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  const validation = validateGroupFriendSelection(selected.size);
  const canSubmit = validation.ok && peerAgentId != null && name.trim().length > 0 && !submitBusy;

  async function handleCreate(): Promise<void> {
    if (peerAgentId == null) return;
    if (!validation.ok) {
      setSubmitError(validation.message ?? null);
      return;
    }
    setSubmitBusy(true);
    setSubmitError(null);
    const memberIds = buildCreateGroupMemberIds(peerAgentId, [...selected]);
    const trimmedName = name.trim() || buildDefaultGroupName([peerName]);
    const res = await createGroupChatRoom(trimmedName, memberIds);
    if (!res.ok) {
      setSubmitBusy(false);
      setSubmitError(formatCreateGroupErrorVi(res.message));
      return;
    }
    if (categoryId) {
      const assign = await assignChatRoomCategory(res.data.id, categoryId);
      if (assign.ok) notifyChatCategoriesChanged();
    }
    setSubmitBusy(false);
    onCreated(res.data.id);
  }

  return (
    <Modal title="Tạo nhóm chat cùng người này" onClose={onClose} width="max-w-sm">
      {(peerLoading || friendsLoading) && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Đang tải...
        </div>
      )}

      {peerError && <p className="mb-3 text-sm text-danger">{peerError}</p>}
      {friendsError && <p className="mb-3 text-sm text-danger">{friendsError}</p>}

      {!peerLoading && !friendsLoading && !peerError && !friendsError && (
        <>
          <label className="mb-3 flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-700">Tên nhóm</span>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setNameTouched(true);
              }}
              maxLength={100}
              placeholder="Đặt tên cho nhóm..."
              className={inputCls}
            />
          </label>

          {/* Phân loại nhóm (Admin Demo 5/8) — không bắt buộc, CÙNG chip .filter-chip với CreateGroupModal/ChatList. */}
          <div className="mb-3">
            <span className="mb-1.5 block text-sm font-medium text-slate-700">
              Phân loại nhóm <span className="font-normal text-slate-400">(không bắt buộc)</span>
            </span>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                data-testid="group-category-none"
                onClick={() => setCategoryId(null)}
                className={
                  'filter-chip rounded-full px-3 py-1 text-xs font-medium ' +
                  (categoryId === null ? 'filter-chip--active text-white' : 'bg-appbg text-slate-600')
                }
                style={categoryId === null ? ({ background: 'var(--gradient-accent)', ['--chip-c']: 'var(--color-brand)' } as CSSProperties) : undefined}
              >
                Không phân loại
              </button>
              {categories.map((cat) => {
                const active = categoryId === cat.id;
                return (
                  <button
                    key={cat.id}
                    type="button"
                    data-testid={`group-category-${cat.id}`}
                    onClick={() => setCategoryId(active ? null : cat.id)}
                    className={
                      'filter-chip flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ' +
                      (active ? 'filter-chip--active text-white' : 'bg-appbg text-slate-600')
                    }
                    style={active ? ({ backgroundColor: cat.color, ['--chip-c']: cat.color } as CSSProperties) : undefined}
                  >
                    <span className="h-2 w-2 rounded-full" style={{ backgroundColor: active ? '#ffffff' : cat.color }} />
                    {cat.name}
                  </button>
                );
              })}
            </div>
          </div>

          <p className="mb-2 text-sm font-medium text-slate-700">
            Chọn thêm bạn bè <span className="font-normal text-slate-400">(cần ít nhất 1 người)</span>
          </p>
          {selectableFriends.length === 0 ? (
            <p className="rounded-lg-mac border border-dashed border-line px-3 py-6 text-center text-sm text-slate-400">
              Chưa có bạn bè nào khác để thêm vào nhóm.
            </p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-auto">
              {selectableFriends.map((f) => {
                const disabled = isBlockedForMe(f);
                const checked = selected.has(f.agentId);
                return (
                  <li key={f.agentId}>
                    <button
                      type="button"
                      data-testid={`friend-pick-${f.agentId}`}
                      disabled={disabled}
                      onClick={() => toggleSelect(f.agentId)}
                      title={disabled ? 'Không thể mời — đã chặn hoặc chưa là bạn bè' : undefined}
                      className={
                        'flex w-full items-center gap-3 rounded-lg-mac px-2 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50 ' +
                        (checked ? 'bg-brand-tint' : 'hover:bg-appbg')
                      }
                    >
                      <input type="checkbox" readOnly checked={checked} disabled={disabled} className="h-4 w-4 accent-[var(--color-brand)]" />
                      <div
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-semibold text-white"
                        style={{ backgroundColor: avatarColorForAgent(f.agentId) }}
                      >
                        {(f.nickname ?? f.agentName)[0]}
                      </div>
                      <span className="flex-1 truncate text-sm text-slate-700">{f.nickname ?? f.agentName}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {!validation.ok && <p className="mt-3 text-xs text-slate-400">{validation.message}</p>}
          {submitError && <p className="mt-3 text-sm text-danger">{submitError}</p>}

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="neutral" size="sm" onClick={onClose}>
              Hủy
            </Button>
            <Button
              variant="confirm"
              size="sm"
              onClick={handleCreate}
              disabled={!canSubmit}
              icon={submitBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
            >
              Tạo nhóm{selected.size > 0 ? ` (${selected.size + 2})` : ''}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
