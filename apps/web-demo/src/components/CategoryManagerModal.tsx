// Modal "Quản lý phân loại" (mục 21 — như Zalo): tạo/sửa/xóa phân loại (tên + bảng 10 swatch màu,
// preview đổi ngay khi chọn), gán nhóm chat vào phân loại. Xóa hỗ trợ đơn (từ form Sửa) và multi-select
// (bật "Chọn nhiều" trên danh sách chip, tick nhiều rồi xóa hàng loạt) — cả hai đều qua ConfirmDialog
// trước khi xóa thật. Xóa 1 phân loại đang gán cho phòng chat → phòng đó về "chưa phân loại", KHÔNG xóa
// phòng.
//
// CUTOVER (31/7, việc #4 — thay Phase 0 mock-only): dữ liệu nay gọi THẬT qua apps/bot-api/src/routes/me.ts
// (chat-category-service.ts) — bảng ChatCategory MỚI + cột ChatRoomMember.categoryId (KHÔNG mutate mảng mock
// CATEGORIES/CHAT_ROOMS nữa, KHÔNG import notifyCategoriesChanged mock cũ — xem bus MỚI
// subscribeChatCategoriesChanged/notifyChatCategoriesChanged, agent-api-client.ts). CHỜ LEAD `prisma migrate
// deploy`+`generate` trước khi các API này trả dữ liệu thật (xem BUGS_FIXED.md B74/việc #4) — modal build
// đúng luồng gọi lại API sau MỖI thao tác thay vì mutate local, giữ NGUYÊN 100% UI/UX/thao tác cũ.
import { useEffect, useMemo, useState, type JSX } from 'react';
import { Check, ListChecks, Plus, Trash2 } from 'lucide-react';
import { DotsLoader } from './DotsLoader';
import { Modal } from './Modal';
import { Button } from './Button';
import { ConfirmDialog } from './ConfirmDialog';
import { Field, inputCls } from './Field';
import { CATEGORY_SWATCHES } from '../mock-data/categories';
import {
  assignChatRoomCategory,
  createChatCategory,
  deleteChatCategory,
  listChatCategories,
  notifyChatCategoriesChanged,
  updateChatCategory,
  type ChatCategoryDto
} from '../lib/agent-api-client';
import { listChatRoomsWithNames } from '../lib/chat-client';
import type { ChatRoom } from '../mock-data/types';

export function CategoryManagerModal({ onClose }: { onClose: () => void }): JSX.Element {
  // categories/rooms=null = đang tải lần đầu (hiện spinner). loadError giữ nguyên dữ liệu cũ (nếu có) để
  // không giật UI khi 1 lượt tải lại gặp lỗi mạng thoáng qua (CÙNG pattern rcRooms/roomsError ở
  // ChatListScreen.tsx).
  const [categories, setCategories] = useState<ChatCategoryDto[] | null>(null);
  const [rooms, setRooms] = useState<ChatRoom[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // Lỗi từ 1 thao tác ghi (tạo/sửa/xóa/gán) — hiện banner nhỏ, tự dọn khi bắt đầu thao tác kế tiếp.
  const [actionError, setActionError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function loadCategories(): Promise<ChatCategoryDto[]> {
    const res = await listChatCategories();
    if (res.ok) {
      setCategories(res.data);
      return res.data;
    }
    setLoadError(res.message);
    return categories ?? [];
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [catRes, roomsRes] = await Promise.all([listChatCategories(), listChatRoomsWithNames()]);
      if (cancelled) return;
      if (catRes.ok) {
        setCategories(catRes.data);
        setEditingId(catRes.data[0]?.id ?? null);
        setName(catRes.data[0]?.name ?? '');
        setColor(catRes.data[0]?.color ?? CATEGORY_SWATCHES[0]);
      } else {
        setCategories([]);
        setLoadError(catRes.message);
      }
      if (roomsRes.ok) setRooms(roomsRes.data);
      else setRooms((prev) => prev ?? []);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [color, setColor] = useState(CATEGORY_SWATCHES[0]);

  // Chế độ chọn nhiều để xóa hàng loạt trên danh sách chip.
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  // Xác nhận xóa (đơn hoặc nhiều) — set = mở ConfirmDialog.
  const [confirmDelete, setConfirmDelete] = useState<{ ids: string[]; label: string } | null>(null);

  // roomId → categoryId (CỦA CHÍNH đại lý đang đăng nhập) — suy ra từ roomIds nhúng trong từng category (API
  // trả sẵn, KHÔNG cần field categoryId riêng trên UiChatRoom — xem chat-category-service.ts listCategories()).
  const categoryIdByRoomId = useMemo(() => {
    const map = new Map<string, string>();
    for (const cat of categories ?? []) {
      for (const roomId of cat.roomIds) map.set(roomId, cat.id);
    }
    return map;
  }, [categories]);

  function selectCategory(cat: ChatCategoryDto): void {
    if (selectMode) {
      setSelectedIds((prev) => (prev.includes(cat.id) ? prev.filter((id) => id !== cat.id) : [...prev, cat.id]));
      return;
    }
    setEditingId(cat.id);
    setName(cat.name);
    setColor(cat.color);
    setActionError(null);
  }

  function startCreate(): void {
    setEditingId(null);
    setName('');
    setColor(CATEGORY_SWATCHES[0]);
    setActionError(null);
  }

  async function save(): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    setActionError(null);
    const r = editingId ? await updateChatCategory(editingId, { name: trimmed, color }) : await createChatCategory(trimmed, color);
    setSaving(false);
    if (!r.ok) {
      setActionError(r.message);
      return;
    }
    setEditingId(r.data.id);
    await loadCategories();
    notifyChatCategoriesChanged();
  }

  async function toggleRoom(roomId: string): Promise<void> {
    if (!editingId) return;
    const current = categoryIdByRoomId.get(roomId);
    const nextCategoryId = current === editingId ? null : editingId;
    setActionError(null);
    const r = await assignChatRoomCategory(roomId, nextCategoryId);
    if (!r.ok) {
      setActionError(r.message);
      return;
    }
    await loadCategories();
    notifyChatCategoriesChanged();
  }

  function toggleSelectMode(): void {
    setSelectMode((v) => !v);
    setSelectedIds([]);
  }

  function requestDeleteOne(cat: ChatCategoryDto): void {
    setConfirmDelete({ ids: [cat.id], label: `phân loại "${cat.name}"` });
  }

  function requestDeleteSelected(): void {
    if (selectedIds.length === 0) return;
    setConfirmDelete({ ids: [...selectedIds], label: `${selectedIds.length} phân loại đã chọn` });
  }

  async function performDelete(ids: string[]): Promise<void> {
    setActionError(null);
    setConfirmDelete(null);
    // Xóa tuần tự (số lượng nhỏ, thao tác người dùng chủ động — KHÔNG cần Promise.all song song) — dừng ngay
    // và báo lỗi rõ nếu 1 cái xóa lỗi (vd đã bị xóa ở tab khác), KHÔNG âm thầm bỏ qua.
    for (const id of ids) {
      const r = await deleteChatCategory(id);
      if (!r.ok) {
        setActionError(r.message);
        break;
      }
    }
    const latest = await loadCategories();
    notifyChatCategoriesChanged();
    // Nếu đang sửa 1 phân loại vừa bị xóa, đưa form về trạng thái tạo mới / phân loại đầu tiên còn lại.
    if (editingId && ids.includes(editingId)) {
      const next = latest[0] ?? null;
      setEditingId(next?.id ?? null);
      setName(next?.name ?? '');
      setColor(next?.color ?? CATEGORY_SWATCHES[0]);
    }
    setSelectedIds([]);
    setSelectMode(false);
  }

  const loading = categories === null || rooms === null;

  return (
    <Modal title="Quản lý phân loại" onClose={onClose} width="max-w-xl">
      {loading ? (
        <div className="flex flex-col items-center gap-2 py-10 text-sm text-slate-400">
          <DotsLoader />
          Đang tải danh sách phân loại...
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {loadError && <div className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{loadError}</div>}
          {actionError && <div className="rounded-md bg-danger/10 px-3 py-2 text-xs text-danger">{actionError}</div>}

          {/* Danh sách phân loại hiện có + nút thêm + chọn nhiều để xóa */}
          <div>
            <div className="flex flex-wrap items-center gap-2">
              {categories.map((cat) => {
                const checked = selectedIds.includes(cat.id);
                return (
                  <button
                    key={cat.id}
                    onClick={() => selectCategory(cat)}
                    className={
                      'flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition ' +
                      (selectMode
                        ? checked
                          ? 'border-brand bg-brand-tint text-brand'
                          : 'border-line text-slate-600 hover:bg-appbg'
                        : editingId === cat.id
                          ? 'border-brand bg-brand-tint text-brand'
                          : 'border-line text-slate-600 hover:bg-appbg')
                    }
                  >
                    {selectMode && (
                      <span
                        className={
                          'flex h-4 w-4 items-center justify-center rounded border ' +
                          (checked ? 'border-brand bg-brand text-white' : 'border-line')
                        }
                      >
                        {checked && <Check className="h-3 w-3" />}
                      </span>
                    )}
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: cat.color }} />
                    {cat.name}
                  </button>
                );
              })}
              {!selectMode && (
                <button
                  onClick={startCreate}
                  className={
                    'flex items-center gap-1 rounded-full border border-dashed px-3 py-1.5 text-sm font-medium transition ' +
                    (editingId === null ? 'border-brand text-brand' : 'border-line text-slate-500 hover:text-brand')
                  }
                >
                  <Plus className="h-4 w-4" /> Thêm phân loại
                </button>
              )}
            </div>

            {/* Bật/tắt chế độ chọn nhiều để xóa hàng loạt */}
            {categories.length > 0 && (
              <div className="mt-2 flex items-center gap-2">
                <button
                  onClick={toggleSelectMode}
                  className={
                    'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium transition ' +
                    (selectMode ? 'text-brand' : 'text-slate-500 hover:text-brand')
                  }
                >
                  <ListChecks className="h-3.5 w-3.5" />
                  {selectMode ? 'Thoát chọn nhiều' : 'Chọn nhiều để xóa'}
                </button>
                {selectMode && (
                  <Button variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} disabled={selectedIds.length === 0} onClick={requestDeleteSelected} className="!px-3 !py-1.5 !text-xs">
                    Xóa ({selectedIds.length})
                  </Button>
                )}
              </div>
            )}
          </div>

          {/* Form tên + màu + preview */}
          {!selectMode && (
            <div className="rounded-lg-mac border border-line p-4">
              <div className="flex items-center justify-between">
                <Field label={editingId ? 'Sửa phân loại' : 'Tạo phân loại mới'} required>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Tên phân loại" className={inputCls + ' w-full'} />
                </Field>
              </div>
              <div className="mt-3">
                <span className="text-sm font-medium text-slate-700">Màu</span>
                <div className="mt-2 flex flex-wrap gap-2">
                  {CATEGORY_SWATCHES.map((sw) => (
                    <button
                      key={sw}
                      onClick={() => setColor(sw)}
                      aria-label={`Chọn màu ${sw}`}
                      className="flex h-8 w-8 items-center justify-center rounded-full transition hover:scale-110"
                      style={{ backgroundColor: sw }}
                    >
                      {color === sw && <Check className="h-4 w-4 text-white" />}
                    </button>
                  ))}
                </div>
              </div>
              <div className="mt-3 flex items-center justify-between">
                <span className="flex items-center gap-2 text-sm text-slate-500">
                  Xem trước:
                  <span className="rounded-full px-2 py-0.5 text-xs font-medium text-white" style={{ backgroundColor: color }}>
                    {name.trim() || 'Tên phân loại'}
                  </span>
                </span>
                <div className="flex items-center gap-2">
                  {editingId && (
                    <button
                      onClick={() => {
                        const cat = categories.find((c) => c.id === editingId);
                        if (cat) requestDeleteOne(cat);
                      }}
                      aria-label="Xóa phân loại này"
                      className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-2.5 text-sm font-medium text-danger transition hover:bg-danger/10"
                    >
                      <Trash2 className="h-4 w-4" /> Xóa
                    </button>
                  )}
                  <Button onClick={save} disabled={!name.trim() || saving}>
                    {saving ? <DotsLoader size="sm" color="white" /> : editingId ? 'Lưu' : 'Tạo'}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Gán nhóm chat vào phân loại đang chọn */}
          {!selectMode && editingId && (
            <div>
              <span className="text-sm font-medium text-slate-700">Gán nhóm vào phân loại này</span>
              <div className="mt-2 divide-y divide-line rounded-lg-mac border border-line">
                {/* CHỈ HIỆN nhóm/hội thoại CHƯA phân loại + nhóm đang thuộc phân loại NÀY (Admin Demo 16/8 "nhóm/user đã
                    được phân loại thì không hiện trong danh sách chọn nữa") — ẩn phòng đã gán phân loại KHÁC để
                    KHÔNG chọn trùng. Đổi/xóa phân loại của phòng đó làm ở nút "Phân loại" trong Thông tin nhóm. */}
                {(() => {
                  const selectable = rooms.filter((room) => {
                    const cid = categoryIdByRoomId.get(room.id);
                    return cid == null || cid === editingId;
                  });
                  if (selectable.length === 0) {
                    return <div className="px-3 py-2.5 text-sm text-slate-400">Mọi nhóm chat đã được phân loại.</div>;
                  }
                  return selectable.map((room) => {
                    const checked = categoryIdByRoomId.get(room.id) === editingId;
                    return (
                      <label key={room.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5 hover:bg-appbg">
                        <input type="checkbox" checked={checked} onChange={() => toggleRoom(room.id)} className="h-4 w-4 accent-brand" />
                        <span className="flex-1 text-sm text-slate-700">{room.name}</span>
                      </label>
                    );
                  });
                })()}
              </div>
            </div>
          )}
        </div>
      )}

      {confirmDelete && (
        <ConfirmDialog
          title="Xóa phân loại"
          message={`Xóa ${confirmDelete.label}? Phòng chat đang gán phân loại này sẽ chuyển về "chưa phân loại" (KHÔNG xóa phòng chat). Hành động không thể hoàn tác.`}
          confirmLabel="Xóa"
          danger
          onCancel={() => setConfirmDelete(null)}
          onConfirm={() => performDelete(confirmDelete.ids)}
        />
      )}
    </Modal>
  );
}
