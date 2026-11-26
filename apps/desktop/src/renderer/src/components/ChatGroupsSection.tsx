// KHỐI "Nhóm chat theo loại phí" của FORM KHÁCH HÀNG (Admin Demo 5/8) — DÙNG CHUNG Thêm mới + Sửa (cross-cutting).
// Tách riêng khỏi CustomersPage để tái dùng + kiểm thử render độc lập. Mỗi dòng = 1 NHÓM CHAT SigMa
// (dropdown to, có ô tìm kiếm) + 1 loại phí + link. Nhóm đã gán (khi Sửa) hiện thành 1 dòng có sẵn nhóm;
// "Đổi nhóm" = mở dropdown chọn nhóm khác, "Hủy gán" = xóa dòng (khi Lưu → đóng kỳ nhóm cũ, mô hình KỲ ở
// service). Tùy chọn (có thể trống). Thứ tự cột (Admin Demo 5/8): [Nhóm chat] [Loại phí] [Link] [xóa]. KHÔNG có QR.
import { useEffect, useRef, useState } from 'react';
import { Plus, Trash2, Search, ChevronDown, X } from 'lucide-react';
import { inputCls } from './Field.js';
import { Button } from './Button.js';

// 1 dòng cấu hình nhóm chat trong form khách (state cục bộ, chưa lưu). `roomName` = tên phòng đang chọn (hiển thị
// mà KHÔNG cần nằm trong danh sách picker — picker chỉ trả nhóm CHƯA gán). key ổn định để React reconcile input.
export interface ChatGroupRow {
  key: string;
  feeTypeId: number; // 0 = chưa chọn
  roomId: string | null;
  roomName: string | null;
  link: string;
  qr: string; // GIỮ trong model để tương thích service (input optional) — KHÔNG còn ô nhập trên UI (Admin Demo 5/8).
  zaloGroupId: string; // groupId Zalo dán tay (Admin Demo 25/8) — watcher lấy bill nhóm Zalo này → phòng + doanh số khách.
}

/**
 * DROPDOWN CHỌN NHÓM CHAT — nút bấm TO, RÕ (KHÔNG phải icon kính lúp tí xíu). Nút hiển thị "id · tên nhóm" đã chọn
 * hoặc placeholder "Chọn nhóm chat SigMa ▾". Bấm → mở panel: Ô TÌM KIẾM ở đầu (gợi ý lọc, debounce 250ms gọi
 * window.api.chatGroupsForPicker) + danh sách nhóm "id · tên". Server CHỈ trả nhóm GROUP CHƯA gán khách nào → đã gán
 * KHÔNG xuất hiện (muốn đổi/hủy thao tác ở dòng bên ngoài). `exclude` = roomId đã chọn ở DÒNG KHÁC trong cùng form
 * (chống trùng nhóm nội-form, vì chưa lưu nên server chưa biết). Trạng thái rỗng hiển thị NỔI BẬT, phân biệt rõ.
 */
export function ChatGroupPicker({
  value,
  valueLabel,
  exclude,
  onPick,
  disabled,
  fetchGroups
}: {
  value: string | null;
  valueLabel: string | null;
  exclude: string[];
  onPick: (roomId: string | null, name: string | null) => void;
  disabled?: boolean;
  /** Nguồn danh sách nhóm (mặc định picker KHÁCH HÀNG = chatGroupsForPicker, loại phòng đã gán khách). NĐT truyền
   * `window.api.investorChatGroupsForPicker` (liệt kê MỌI phòng GROUP, không loại) — CÙNG shape trả về {roomId,name}. */
  fetchGroups?: (search?: string, limit?: number) => Promise<{ ok: boolean; data?: { roomId: string; name: string }[] }>;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ roomId: string; name: string }[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false); // đã có ≥1 phản hồi từ server (phân biệt "chưa load" vs "load ra rỗng")
  const boxRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e: MouseEvent): void {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) { setOpen(false); setQuery(''); }
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  // Mở panel → tự focus ô tìm kiếm để gõ ngay.
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  // DEBOUNCE 250ms — gõ liên tục KHÔNG bắn request mỗi phím. Nạp lại khi mở hoặc đổi query.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      void (async () => {
        const r = await (fetchGroups ?? window.api.chatGroupsForPicker)(query.trim() || undefined, 50);
        if (!alive) return;
        setResults(r.ok && r.data ? r.data.map((g) => ({ roomId: g.roomId, name: g.name })) : []);
        setLoading(false);
        setLoaded(true);
      })();
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [open, query]);

  const filtered = results.filter((r) => !exclude.includes(r.roomId));
  const hasQuery = query.trim().length > 0;

  // Trạng thái rỗng NỔI BẬT + phân biệt: chưa load / không có nhóm trống nào / khớp query rỗng / bị dòng khác giữ hết.
  function emptyMessage(): string {
    if (!loaded) return 'Đang tải danh sách nhóm…';
    if (hasQuery) return `Không tìm thấy nhóm chat khớp "${query.trim()}".`;
    if (results.length === 0) return 'Chưa có nhóm chat SigMa trống nào để gán.';
    return 'Các nhóm còn trống đã được chọn ở dòng khác.'; // results>0 nhưng đều bị exclude (chọn ở dòng khác trong form)
  }

  // Admin Demo 19/8 ("nhóm chọn rồi lại ra MÃ nhóm không hiện TÊN") — TRƯỚC đây hiện `<id> · <tên>`: id dài ~24 ký
  // tự đứng TRƯỚC + ô hẹp truncate → chỉ thấy MÃ, tên bị cắt. Đổi: hiện TÊN nhóm (thứ người dùng cần), chỉ rơi về
  // mã khi thật sự thiếu tên (nhóm bị xoá/đổi tên chưa đồng bộ). Dropdown vẫn kèm mã để tra cứu.
  const trimmedLabel = valueLabel?.trim();
  const closedLabel = value ? (trimmedLabel && trimmedLabel.length > 0 ? trimmedLabel : value) : '';

  return (
    <div className="relative" ref={boxRef}>
      {/* NÚT DROPDOWN TO, RÕ — không phải ô tìm kiếm. Hiện nhóm đã chọn hoặc placeholder rõ ràng. */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => { if (!disabled) setOpen((v) => !v); }}
        className={
          'flex w-full items-center gap-2 rounded-md border px-3 py-2.5 text-left text-sm outline-none transition ' +
          (disabled
            ? 'cursor-not-allowed border-line bg-slate-50 text-slate-400'
            : 'border-line bg-white hover:border-brand/60 focus:border-brand focus:ring-2 focus:ring-brand/20 ' +
              (open ? 'border-brand ring-2 ring-brand/20 ' : ''))
        }
      >
        <span className={'min-w-0 flex-1 truncate ' + (value ? 'text-slate-800' : 'text-slate-400')}>
          {value ? closedLabel : 'Chọn nhóm chat SigMa'}
        </span>
        {value && !disabled ? (
          <span
            role="button"
            tabIndex={-1}
            title="Bỏ chọn nhóm"
            onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onPick(null, null); }}
            className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <X className="h-4 w-4" />
          </span>
        ) : (
          <ChevronDown className={'h-4 w-4 shrink-0 text-slate-400 transition ' + (open ? 'rotate-180' : '')} />
        )}
      </button>

      {open && (
        <div className="absolute z-30 mt-1 w-full min-w-[16rem] overflow-hidden rounded-md border border-line bg-white shadow-lg">
          {/* Ô TÌM KIẾM ở đầu panel — kính lúp nằm ĐÂY (trong dropdown), không còn là toàn bộ ô ngoài. */}
          <div className="border-b border-line p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
              <input
                ref={searchRef}
                className={inputCls + ' w-full pl-9'}
                value={query}
                placeholder="Gõ id hoặc tên nhóm để tìm…"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          <ul className="max-h-64 overflow-auto py-1">
            {loading && <li className="px-3 py-3 text-center text-sm text-slate-400">Đang tải…</li>}
            {!loading && filtered.length === 0 && (
              <li className="px-3 py-4 text-center text-sm font-medium text-slate-500">{emptyMessage()}</li>
            )}
            {!loading && filtered.map((o) => (
              <li key={o.roomId}
                onMouseDown={(e) => { e.preventDefault(); onPick(o.roomId, o.name); setOpen(false); setQuery(''); }}
                className={'cursor-pointer px-3 py-2.5 text-sm transition hover:bg-brand-tint hover:text-brand ' + (o.roomId === value ? 'bg-brand-tint/50 font-medium text-brand' : 'text-slate-700')}>
                <span className="font-mono text-xs text-slate-400">{o.roomId}</span> · {o.name}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * KHỐI "Nhóm chat theo loại phí" — DÙNG CHUNG Thêm mới + Sửa. Loại phí đã dùng ở dòng khác bị vô hiệu để tránh trùng.
 * `disabled` = true khi (Sửa mà) cấu hình cũ CHƯA tải xong (tránh thao tác trên state rỗng).
 * Thứ tự cột: [Nhóm chat] [Loại phí] [Link] [xóa] — KHÔNG có QR (Admin Demo 5/8).
 */
export function ChatGroupsSection({
  feeTypes,
  rows,
  onChange,
  disabled
}: {
  feeTypes: { id: number; name: string }[];
  rows: ChatGroupRow[];
  onChange: (rows: ChatGroupRow[]) => void;
  disabled?: boolean;
}): JSX.Element {
  const usedFeeIds = new Set(rows.filter((r) => r.feeTypeId > 0).map((r) => r.feeTypeId));
  const usedRoomIds = rows.map((r) => r.roomId).filter((x): x is string => !!x);

  function addRow(): void {
    onChange([...rows, { key: `new-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, feeTypeId: 0, roomId: null, roomName: null, link: '', qr: '', zaloGroupId: '' }]);
  }
  function patchRow(key: string, patch: Partial<ChatGroupRow>): void {
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  }
  function removeRow(key: string): void {
    onChange(rows.filter((r) => r.key !== key));
  }

  // Lưới cột dùng chung header + mỗi dòng để căn thẳng hàng. Nhóm chat RỘNG NHẤT (1.4fr), loại phí + link + Zalo 1fr.
  const gridCls = 'grid grid-cols-[minmax(180px,1.4fr)_minmax(130px,0.9fr)_minmax(130px,0.9fr)_minmax(150px,1fr)_auto] items-center gap-3';

  return (
    <div className="mt-5 rounded-lg border border-line bg-slate-50/60 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-slate-700">Nhóm chat theo loại phí</div>
          <div className="text-xs text-slate-400">Không bắt buộc · mỗi loại phí gán 1 nhóm chat SigMa (chỉ hiện nhóm chưa gán khách nào).</div>
        </div>
        <Button variant="neutral" onClick={addRow} disabled={disabled} icon={<Plus className="h-4 w-4" />}>Thêm nhóm</Button>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-md border border-dashed border-line bg-white px-3 py-5 text-center text-sm text-slate-500">
          Chưa gán nhóm chat nào. Bấm “Thêm nhóm” để gán.
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {/* Header cột — nhãn RÕ cho từng field (Admin Demo: "nhìn không thấy gì"). */}
          <div className={gridCls + ' px-2 text-xs font-semibold uppercase tracking-wide text-slate-500'}>
            <span className="truncate whitespace-nowrap">Nhóm chat SigMa</span>
            <span className="truncate whitespace-nowrap">Loại phí</span>
            <span className="truncate whitespace-nowrap">Link nhóm (tùy chọn)</span>
            <span className="truncate whitespace-nowrap" title="Dán groupId nhóm Zalo (từ zalo-watcher list-groups) để tự lấy bill">Zalo groupId (tùy chọn)</span>
            <span className="w-8" />
          </div>
          {rows.map((r) => (
            <div key={r.key} className={gridCls + ' rounded-md border border-line bg-white p-2.5'}>
              <ChatGroupPicker
                value={r.roomId}
                valueLabel={r.roomName}
                exclude={usedRoomIds.filter((id) => id !== r.roomId)}
                disabled={disabled}
                onPick={(roomId, name) => patchRow(r.key, { roomId, roomName: name })}
              />
              <select
                className={inputCls + ' w-full'}
                value={r.feeTypeId || ''}
                disabled={disabled}
                onChange={(e) => patchRow(r.key, { feeTypeId: Number(e.target.value) || 0 })}
              >
                <option value="">— Chọn loại phí —</option>
                {feeTypes.map((f) => (
                  <option key={f.id} value={f.id} disabled={f.id !== r.feeTypeId && usedFeeIds.has(f.id)}>{f.name}</option>
                ))}
              </select>
              <input className={inputCls + ' w-full'} placeholder="Dán link nhóm…" value={r.link} disabled={disabled} onChange={(e) => patchRow(r.key, { link: e.target.value })} />
              <input className={inputCls + ' w-full font-mono text-xs'} placeholder="vd 9135320275466171227_group" value={r.zaloGroupId} disabled={disabled} onChange={(e) => patchRow(r.key, { zaloGroupId: e.target.value })} />
              <button type="button" title="Hủy gán (xóa dòng)" disabled={disabled}
                onClick={() => removeRow(r.key)}
                className="justify-self-center rounded-md p-2 text-slate-400 transition hover:bg-danger/10 hover:text-danger disabled:opacity-40">
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
