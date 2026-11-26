// "Tạo nhóm chat" ĐỘC LẬP (Admin Demo 5/8) — mở TỪ DANH SÁCH CHAT (ChatListScreen.tsx) qua nút riêng, KHÔNG cần
// đang ở trong 1 cuộc trò chuyện 1-1 nào. KHÁC CreateGroupFromDmModal.tsx ở chỗ KHÔNG có "đối phương DM sẵn":
// người dùng tự chọn TOÀN BỘ ≥2 bạn bè từ danh sách + nhập TÊN nhóm → tạo phòng GROUP thật qua
// `createGroupChatRoom()` (chat-client.ts — wrapper CÓ SẴN từ Phase 3, KHÔNG viết lại). TÁI DÙNG logic thuần
// (validate ngưỡng ≥2 / build payload / tên mặc định / format lỗi tiếng Việt) ở lib/create-group-from-dm.ts —
// component này CHỈ gọi, không tự chứa quyết định (tránh lệch 2 nơi). Danh sách bạn bè lấy qua cache dùng chung
// `getCachedFriends()` (CÙNG nguồn ContactsScreen/ChatListScreen — không bắn request riêng).
import { useEffect, useMemo, useState, type CSSProperties, type JSX } from 'react';
import { Loader2, Search, Users, X } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';
import { inputCls } from './Field';
import { getCachedFriends } from '../lib/friends-cache';
import { assignChatRoomCategory, notifyChatCategoriesChanged, type ChatCategoryDto, type FriendListItem } from '../lib/agent-api-client';
import { getCachedChatCategories } from '../lib/categories-cache';
import { AgentAvatar } from './AgentAvatar';
import { createGroupChatRoom } from '../lib/chat-client';
import {
  buildDefaultGroupName,
  buildStandaloneGroupMemberIds,
  formatCreateGroupErrorVi,
  validateStandaloneGroupSelection
} from '../lib/create-group-from-dm';

/** CÙNG tiêu chí `isBlockedForMe()` CreateGroupFromDmModal.tsx: mình đã chặn HOẶC bị chặn → không mời được vào
 * nhóm (server tự ném CANNOT_MESSAGE nếu cố — disable ở đây chỉ tránh round-trip lỗi chắc chắn thất bại). */
function isBlockedForMe(f: FriendListItem): boolean {
  return f.blockedByMe || f.blockedThem;
}

function displayName(f: FriendListItem): string {
  return f.nickname ?? f.agentName;
}

/** So khớp không phân biệt hoa/thường cho ô tìm bạn trong nhóm (tên/biệt danh/mã đại lý). */
function matchesFriend(f: FriendListItem, q: string): boolean {
  const needle = q.toLowerCase();
  return (
    displayName(f).toLowerCase().includes(needle) ||
    (f.agentName ?? '').toLowerCase().includes(needle) ||
    (f.agentCode ?? '').toLowerCase().includes(needle)
  );
}

export function CreateGroupModal({
  onClose,
  onCreated
}: {
  onClose: () => void;
  /** Gọi khi tạo nhóm THÀNH CÔNG, kèm id phòng GROUP mới — ChatListScreen.tsx tự điều hướng (qua onOpenRoomId
   * → navigate(ROUTES.chatRoom(newRoomId)) ở App.tsx, CÙNG pattern onCreateGroupNavigate luồng DM). */
  onCreated: (newRoomId: string) => void;
}): JSX.Element {
  const [friends, setFriends] = useState<FriendListItem[] | null>(null);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [friendsLoading, setFriendsLoading] = useState(true);

  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [search, setSearch] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);

  // "phân loại nhóm ngay khi tạo" (Admin Demo 5/8) — KHÔNG bắt buộc (mặc định null = "Không phân loại"). Danh sách
  // phân loại lấy qua cache DÙNG CHUNG (getCachedChatCategories, CÙNG nguồn Sidebar/ChatListScreen). Sau khi tạo
  // nhóm xong + có chọn phân loại → gán qua assignChatRoomCategory() (endpoint CÓ SẴN, KHÔNG đổi schema).
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

  // Danh bạ bạn bè — tải 1 lần lúc mở modal (cache dùng chung, thường HIT ngay nếu vừa xem Danh bạ/Danh sách chat).
  useEffect(() => {
    let cancelled = false;
    setFriendsLoading(true);
    setFriendsError(null);
    getCachedFriends().then((r) => {
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

  const allFriends = friends ?? [];
  const visibleFriends = useMemo(() => {
    const q = search.trim();
    if (!q) return allFriends;
    return allFriends.filter((f) => matchesFriend(f, q));
  }, [allFriends, search]);

  // Tên nhóm GỢI Ý — tự cập nhật theo lựa chọn CHO TỚI KHI người dùng tự gõ (nameTouched), CÙNG UX modal luồng DM.
  useEffect(() => {
    if (nameTouched) return;
    const selectedNames = allFriends.filter((f) => selected.has(f.agentId)).map(displayName);
    setName(buildDefaultGroupName(selectedNames));
  }, [nameTouched, selected, allFriends]);

  function toggleSelect(agentId: number): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(agentId)) next.delete(agentId);
      else next.add(agentId);
      return next;
    });
  }

  const validation = validateStandaloneGroupSelection(selected.size);
  const canSubmit = validation.ok && name.trim().length > 0 && !submitBusy;

  async function handleCreate(): Promise<void> {
    if (!validation.ok) {
      setSubmitError(validation.message ?? null);
      return;
    }
    setSubmitBusy(true);
    setSubmitError(null);
    const memberIds = buildStandaloneGroupMemberIds([...selected]);
    const trimmedName = name.trim() || buildDefaultGroupName([]);
    const res = await createGroupChatRoom(trimmedName, memberIds);
    if (!res.ok) {
      setSubmitBusy(false);
      setSubmitError(formatCreateGroupErrorVi(res.message));
      return;
    }
    // Gán phân loại (nếu người dùng có chọn) NGAY sau khi tạo — nhóm đã tồn tại nên lỗi gán KHÔNG chặn việc mở
    // nhóm (chỉ là chưa phân loại được, có thể phân loại lại sau qua "Quản lý phân loại"). Thành công → báo bus
    // để Sidebar/ChatListScreen tự refetch chip lọc.
    if (categoryId) {
      const assign = await assignChatRoomCategory(res.data.id, categoryId);
      if (assign.ok) notifyChatCategoriesChanged();
    }
    setSubmitBusy(false);
    onCreated(res.data.id);
  }

  return (
    <Modal title="Tạo nhóm chat mới" onClose={onClose} width="max-w-sm">
      {friendsLoading && (
        <div className="flex items-center justify-center gap-2 py-8 text-sm text-slate-400">
          <Loader2 className="h-4 w-4 animate-spin" /> Đang tải danh sách bạn bè...
        </div>
      )}

      {friendsError && <p className="mb-3 text-sm text-danger">{friendsError}</p>}

      {!friendsLoading && !friendsError && (
        <>
          <label className="mb-3 flex flex-col gap-1.5">
            <span className="text-sm font-medium text-slate-700">Tên nhóm</span>
            <input
              data-testid="group-name-input"
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

          {/* Phân loại nhóm (Admin Demo 5/8) — KHÔNG bắt buộc. "Không phân loại" mặc định. Chip CÙNG hệ .filter-chip
              với thanh lọc ChatListScreen (đồng nhất): active mang màu phân loại (dữ liệu), "Không phân loại"
              active = brand. */}
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
            Chọn bạn bè <span className="font-normal text-slate-400">(cần ít nhất 2 người)</span>
          </p>

          {allFriends.length > 0 && (
            <div className="relative mb-2">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                data-testid="group-friend-search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Tìm bạn bè..."
                className="w-full rounded-full border border-line bg-appbg py-2 pl-9 pr-9 text-sm outline-none transition focus:border-brand focus:bg-white"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => setSearch('')}
                  aria-label="Xóa tìm kiếm"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-slate-400 hover:text-slate-600"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          )}

          {allFriends.length === 0 ? (
            <p className="rounded-lg-mac border border-dashed border-line px-3 py-6 text-center text-sm text-slate-400">
              Chưa có bạn bè nào để thêm vào nhóm.
            </p>
          ) : visibleFriends.length === 0 ? (
            <p className="rounded-lg-mac border border-dashed border-line px-3 py-6 text-center text-sm text-slate-400">
              Không tìm thấy bạn bè khớp "{search}".
            </p>
          ) : (
            <ul className="max-h-64 space-y-1 overflow-auto">
              {visibleFriends.map((f) => {
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
                      <AgentAvatar agentId={f.agentId} name={displayName(f)} size={32} textClassName="text-xs" />
                      <span className="flex-1 truncate text-sm text-slate-700">{displayName(f)}</span>
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
              data-testid="group-create-submit"
              onClick={handleCreate}
              disabled={!canSubmit}
              icon={submitBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Users className="h-4 w-4" />}
            >
              Tạo nhóm{selected.size > 0 ? ` (${selected.size + 1})` : ''}
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
