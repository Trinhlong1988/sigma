// SIGMA Tier 2 (23/7, CMD_BUILD) — QR nhận tiền của đại lý. Codebase KHÔNG có trang quản lý/sửa đại lý
// nào sẵn có (agent:list trước đây chỉ phục vụ dropdown, chưa từng gắn UI) — trang này là UI ĐẠI LÝ ĐẦU TIÊN,
// thu hẹp đúng phạm vi task: chọn đại lý từ danh sách sẵn có + cấu hình QR nhận tiền + nhãn TK. Permission
// TÁI DÙNG CONFIG_RCV_ACCT_VIEW/MANAGE (nhóm "Tài khoản nhận tiền" đã có — xem agent-qr-service.ts).
//
// GHI CHÚ HÀNH VI (chưa Admin Demo chốt, theo ĐÚNG hợp đồng IPC task yêu cầu — agent:setQrImage bắt buộc có
// ảnh): mỗi lần Lưu PHẢI đi kèm 1 ảnh QR (mới chọn) — không có đường sửa RIÊNG nhãn TK mà không đổi ảnh QR.
// Nếu Admin Demo muốn sửa nhãn độc lập, cần thêm IPC riêng (ngoài phạm vi task này).
import { useEffect, useState } from 'react';
import { QrCode, Upload, Loader2, RefreshCw } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission, fmtDate, fmtTime } from '@sigma/shared';
import type { AgentDto, AgentQrDto } from '../../../preload/index.d';
import { useToast } from '../lib/toast.js';
import { Field, inputCls } from '../components/Field.js';
import { Button } from '../components/Button.js';
// MẪU CHỐT 6/11 — kiểu bảng lấy TỪ MODULE DÙNG CHUNG, cấm chép chuỗi class vào trang.
import { thChuan, tdChuan, trChuan, KhungBang } from '../components/BangChuan.js';

/** SỐ CỘT bảng chọn đại lý — dùng chung cho hàng rỗng / hàng đệm (§1). */
const SO_COT = 2;

export function AgentQrPage({ user }: { user: AuthUser }): JSX.Element {
  const toast = useToast();
  const canView = hasPermission(user, 'CONFIG_RCV_ACCT_VIEW');
  const canManage = hasPermission(user, 'CONFIG_RCV_ACCT_MANAGE');
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.agentList();
    if (res.ok && res.data) setAgents(res.data);
    else if (res.message) toast.alert(res.message);
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, []);

  const selected = agents.find((a) => a.id === selectedId) ?? null;

  return (
    <div data-nut-vuong data-trang-full className="flex h-full min-h-0 w-full flex-col">
      <div className="mb-4 shrink-0">
        <h2 className="text-lg font-semibold text-slate-800">QR nhận tiền đại lý</h2>
        <p className="text-sm text-slate-500">Ảnh QR + nhãn tài khoản nhận tiền cho từng đại lý — bot Rocket.Chat sẽ đăng kèm bảng kết toán trong nhóm chat đại lý (wiring bot ở tier sau).</p>
      </div>
      <div className="grid min-h-0 flex-1 gap-4 md:grid-cols-[280px_1fr]">
        {/* MẪU CHỐT 6/11 — KhungBang dùng chung; tiêu đề ghim trên. Bảng chọn (không cột tiền) ⇒ không tổng. */}
        <KhungBang>
          <table className="h-full w-full min-w-[260px] text-xs">
            <thead className="sticky top-0 z-20 bg-slate-200">
              <tr>
                <th className={thChuan + ' w-[96px]'}>Mã</th>
                <th className={thChuan}>Đại lý</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={SO_COT} className="px-3 py-8 text-center text-slate-400"><Loader2 className="mx-auto h-5 w-5 animate-spin" /></td></tr>}
              {!loading && agents.length === 0 && <tr><td colSpan={SO_COT} className="px-3 py-8 text-center text-slate-400">Chưa có đại lý.</td></tr>}
              {!loading && agents.map((a, i) => (
                <tr key={a.id} className={trChuan(i, selectedId === a.id) + ' cursor-pointer'} onClick={() => setSelectedId(a.id)}>
                  <td className={tdChuan + ' font-medium text-slate-800'}>{a.code ?? '—'}</td>
                  <td className={tdChuan + ' text-slate-600'}>{a.name}</td>
                </tr>
              ))}
              {/* HÀNG ĐỆM (§1). */}
              <tr aria-hidden className="h-full"><td colSpan={SO_COT} className="h-9" /></tr>
            </tbody>
          </table>
        </KhungBang>
        <div className="min-h-0 overflow-auto rounded-xl border border-line bg-white p-5 shadow-sm">
          {!selected && <div className="flex h-40 items-center justify-center text-sm text-slate-400">Chọn 1 đại lý bên trái để cấu hình QR.</div>}
          {selected && canView && <AgentQrPanel key={selected.id} agent={selected} canManage={canManage} />}
          {selected && !canView && <div className="text-sm text-danger">Bạn không có quyền xem QR đại lý.</div>}
        </div>
      </div>
    </div>
  );
}

function AgentQrPanel({ agent, canManage }: { agent: AgentDto; canManage: boolean }): JSX.Element {
  const toast = useToast();
  const [dto, setDto] = useState<AgentQrDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [label, setLabel] = useState('');
  const [srcPath, setSrcPath] = useState<string | null>(null);
  const [pickedName, setPickedName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reload(): Promise<void> {
    setLoading(true);
    const res = await window.api.agentGetQrImage(agent.id);
    if (res.ok && res.data) { setDto(res.data); setLabel(res.data.bankAccountLabel ?? ''); }
    else if (res.message) toast.alert(res.message);
    setSrcPath(null);
    setPickedName(null);
    setLoading(false);
  }
  useEffect(() => { void reload(); /* eslint-disable-next-line */ }, [agent.id]);

  async function pick(): Promise<void> {
    const r = await window.api.pickImage();
    if (r.ok && r.path) { setSrcPath(r.path); setPickedName(r.path.split(/[\\/]/).pop() ?? r.path); }
    else if (!r.canceled) toast.alert('Không chọn được ảnh.', 'Lỗi');
  }

  async function save(): Promise<void> {
    if (!srcPath) return toast.alert('Chưa chọn ảnh QR mới.', 'Thiếu thông tin');
    setBusy(true);
    const res = await window.api.agentSetQrImage({ agentId: agent.id, srcPath, bankAccountLabel: label });
    setBusy(false);
    if (res.ok) { toast.success(`Đã cập nhật QR nhận tiền cho ${agent.name}`); await reload(); }
    else toast.alert(res.message ?? 'Cập nhật QR thất bại', 'Không lưu được');
  }

  if (loading) return <div className="flex h-40 items-center justify-center"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></div>;

  return (
    <div className="grid gap-5 md:grid-cols-[220px_1fr]">
      <div className="flex flex-col items-center gap-2">
        <div className="flex h-48 w-48 items-center justify-center overflow-hidden rounded-lg border border-line bg-appbg">
          {srcPath ? (
            <div className="p-3 text-center text-xs text-success">✓ ảnh mới đã chọn<br />{pickedName}<br />(bấm Lưu để áp dụng)</div>
          ) : dto?.dataUrl ? (
            <img src={dto.dataUrl} alt="QR nhận tiền" className="h-full w-full object-contain" />
          ) : (
            <div className="flex flex-col items-center gap-1 text-slate-300"><QrCode className="h-8 w-8" /><span className="text-xs">Chưa có QR</span></div>
          )}
        </div>
        {canManage && <Button variant="neutral" icon={<Upload className="h-4 w-4" />} onClick={pick}>{dto?.hasQr || srcPath ? 'Đổi ảnh QR' : 'Chọn ảnh QR'}</Button>}
        {dto?.qrUpdatedAt && <span className="text-xs text-slate-400">Cập nhật lúc {fmtDate(dto.qrUpdatedAt)} {fmtTime(dto.qrUpdatedAt)}</span>}
      </div>
      <div className="flex flex-col gap-4">
        <Field label="Đại lý"><input className={inputCls} value={`${agent.code ?? ''} — ${agent.name}`} disabled /></Field>
        <Field label="Nhãn tài khoản nhận tiền" hint='Ví dụ: "Vietcombank - 0123456789 - NGUYEN VAN A"'>
          <input className={inputCls} value={label} onChange={(e) => setLabel(e.target.value)} disabled={!canManage} placeholder="Vietcombank - 0123456789 - NGUYEN VAN A" />
        </Field>
        {canManage && (
          <div className="flex gap-2">
            <Button variant="confirm" onClick={save} disabled={busy || !srcPath} icon={busy ? <Loader2 className="h-4 w-4 animate-spin" /> : undefined}>Lưu</Button>
            <Button data-nut="lammoi" variant="neutral" onClick={() => void reload()} icon={<RefreshCw className="h-4 w-4" />}>Tải lại</Button>
          </div>
        )}
        {!canManage && <div className="text-xs text-slate-400">Bạn chỉ có quyền xem — không sửa được.</div>}
      </div>
    </div>
  );
}
