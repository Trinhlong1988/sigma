// Màn "Tài khoản & bảo mật" (mục 25 — Admin Demo bổ sung 23/7): đổi mật khẩu (3 ô + chỉ báo độ mạnh
// yếu/vừa/mạnh), danh sách thiết bị đang đăng nhập (3 mock, đăng xuất từng cái + tất cả), ghi chú
// đăng ký cần OTP email (khớp mục 16 kế hoạch). Phase 0: nút Lưu chỉ hiện toast thành công giả.
//
// Xóa tài khoản 48h ân hạn (25/7, Admin Demo yêu cầu nguyên văn) — KHÁC với 2 mục trên, đây gọi API THẬT
// (apps/bot-api/src/routes/me.ts qua lib/agent-api-client.ts), KHÔNG phải demo/mock: bấm "Xóa tài khoản" →
// ConfirmDialog giải thích rõ 48h ân hạn + hủy được → xác nhận → POST /v1/me/request-deletion → hiện trạng
// thái đang chờ xóa (đếm ngược + mốc giờ sẽ xóa hẳn) + nút "Hủy yêu cầu xóa" (POST /v1/me/cancel-deletion).
import { useEffect, useRef, useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { AlertOctagon, LogOut, Monitor, MonitorSmartphone, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { Button } from '../components/Button';
import { BackButton } from '../components/BackButton';
import { Field } from '../components/Field';
import { PasswordInput } from '../components/PasswordInput';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import {
  cancelAccountDeletion,
  confirmAccountDeletion,
  getDeletionStatus,
  listMySessions,
  revokeMySession,
  revokeOtherSessions,
  sendAccountDeletionOtp,
  type DeletionStatus,
  type MySessionItem
} from '../lib/agent-api-client';
import { subscribeSessionsUpdated } from '../lib/chat-realtime';

// "Thiết bị đang đăng nhập" — DỮ LIỆU THẬT (5/8, Admin Demo "chưa show thiết bị đang đăng nhập realtime"). Lịch
// sử: 4/8 khối này bị GỠ vì bản cũ hiển thị 3 thiết bị + IP BỊA cứng, nút "Đăng xuất" chỉ xóa khỏi mảng cục bộ
// (không thu hồi phiên thật) — cực nguy hiểm ở đúng màn "bảo mật". NAY nối vào API THẬT: GET /v1/me/sessions
// (liệt kê phiên còn hạn từ bảng web_sessions) + POST /v1/me/sessions/:id/revoke (đăng xuất 1 thiết bị khác).
// Realtime: subscribeSessionsUpdated() → refetch khi có thiết bị mới đăng nhập / 1 phiên bị revoke (server
// broadcastToAgent {msg:'sessions-updated'}). CHƯA có User-Agent trong schema (đề xuất cột user_agent đang chờ
// LEAD duyệt — R_SUPREME) nên nhãn thiết bị tạm là "Thiết bị web/app" + thời gian, KHÔNG bịa IP/tên máy.

/** Chỉ báo độ mạnh mật khẩu 3 mức (mock đơn giản cho demo): độ dài + đa dạng ký tự. */
function passwordStrength(pw: string): { level: 0 | 1 | 2 | 3; label: string; color: string } {
  if (!pw) return { level: 0, label: '', color: '' };
  let score = 0;
  if (pw.length >= 8) score += 1;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score += 1;
  if (/\d/.test(pw) && /[^A-Za-z0-9]/.test(pw)) score += 1;
  if (score <= 1) return { level: 1, label: 'Yếu', color: '#dc2626' };
  if (score === 2) return { level: 2, label: 'Vừa', color: '#f59e0b' };
  return { level: 3, label: 'Mạnh', color: '#16a34a' };
}

/** "còn X giờ Y phút Z giây" từ số mili-giây còn lại — làm tròn xuống, không hiện đơn vị = 0 ở đầu (vd còn
 * <1 giờ chỉ hiện "12 phút 03 giây", không hiện "0 giờ 12 phút 03 giây"). */
function formatCountdown(msRemaining: number): string {
  if (msRemaining <= 0) return 'sắp xóa';
  const totalSeconds = Math.floor(msRemaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pad = (n: number): string => String(n).padStart(2, '0');
  if (hours > 0) return `còn ${hours} giờ ${pad(minutes)} phút ${pad(seconds)} giây`;
  if (minutes > 0) return `còn ${minutes} phút ${pad(seconds)} giây`;
  return `còn ${seconds} giây`;
}

function formatDateTimeVi(iso: string): string {
  return new Date(iso).toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
}

/** Giờ:phút gọn (HH:mm) — dùng cho toast "Đã đăng xuất thiết bị lúc HH:mm". */
function formatHmVi(d: Date): string {
  return d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
}

/** Thời gian tương đối kiểu Zalo ("Vừa xong", "5 phút trước", "2 giờ trước", "3 ngày trước"); quá 30 ngày →
 * ngày/giờ tuyệt đối. Dùng cho "Hoạt động {lastUsedAt}" của mỗi thiết bị. */
function formatRelativeVi(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (diffMs < 0) return 'Vừa xong';
  const sec = Math.floor(diffMs / 1000);
  if (sec < 45) return 'Vừa xong';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${Math.max(1, min)} phút trước`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} giờ trước`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} ngày trước`;
  return formatDateTimeVi(iso);
}

export function AccountSecurityScreen(): JSX.Element {
  const navigate = useNavigate();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [toast, setToast] = useState('');

  // ── Xóa tài khoản 48h ân hạn — state THẬT (không mock), nạp lúc mở màn qua GET /v1/me/deletion-status.
  const [deletionStatus, setDeletionStatus] = useState<DeletionStatus | null>(null);
  const [deletionLoading, setDeletionLoading] = useState(true);
  const [deletionError, setDeletionError] = useState('');
  const [confirmCancelDelete, setConfirmCancelDelete] = useState(false);

  // ── Xóa tài khoản 2 BƯỚC có xác thực (bảo mật 6/8, Admin Demo "yêu cầu mật khẩu đăng nhập và otp kèm mã 2 số").
  // deleteStep: null = chưa mở; 'password' = nhập mật khẩu để gửi OTP; 'otp' = nhập OTP email + gõ lại mã 2 số.
  const [deleteStep, setDeleteStep] = useState<null | 'password' | 'otp'>(null);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteOtp, setDeleteOtp] = useState('');
  const [deleteConfirmInput, setDeleteConfirmInput] = useState('');
  // Mã xác nhận 2 số hiển thị ngẫu nhiên (10–99) — sinh khi chuyển sang bước OTP, người dùng phải gõ đúng lại.
  const [deleteConfirmNumber, setDeleteConfirmNumber] = useState('');
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteStepError, setDeleteStepError] = useState('');

  function resetDeleteFlow(): void {
    setDeleteStep(null);
    setDeletePassword('');
    setDeleteOtp('');
    setDeleteConfirmInput('');
    setDeleteConfirmNumber('');
    setDeleteBusy(false);
    setDeleteStepError('');
  }

  async function submitDeletePassword(): Promise<void> {
    if (!deletePassword || deleteBusy) return;
    setDeleteBusy(true);
    setDeleteStepError('');
    const r = await sendAccountDeletionOtp(deletePassword);
    setDeleteBusy(false);
    if (r.ok) {
      setDeleteConfirmNumber(String(Math.floor(10 + Math.random() * 90))); // 10..99
      setDeleteOtp('');
      setDeleteConfirmInput('');
      setDeleteStep('otp');
    } else {
      setDeleteStepError(r.message);
    }
  }

  async function submitDeleteConfirm(): Promise<void> {
    if (deleteBusy) return;
    if (deleteOtp.trim().length !== 6 || deleteConfirmInput.trim() !== deleteConfirmNumber) return;
    setDeleteBusy(true);
    setDeleteStepError('');
    const r = await confirmAccountDeletion(deleteOtp.trim(), deleteConfirmInput.trim());
    setDeleteBusy(false);
    if (r.ok) {
      setDeletionStatus(r.data);
      setDeletionError('');
      resetDeleteFlow();
    } else {
      setDeleteStepError(r.message);
    }
  }
  // Đếm ngược re-render mỗi giây — chỉ dùng để trigger re-render, giá trị thật tính lại từ deleteAt mỗi lần.
  const [, forceTick] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Thiết bị đang đăng nhập — state THẬT (5/8), nạp qua GET /v1/me/sessions + realtime sessions-updated.
  const [sessions, setSessions] = useState<MySessionItem[] | null>(null);
  const [sessionsError, setSessionsError] = useState('');
  const [revokingId, setRevokingId] = useState<string | null>(null); // id đang gọi revoke (khóa nút, tránh double)
  const [confirmRevokeId, setConfirmRevokeId] = useState<string | null>(null);
  const [confirmRevokeOthers, setConfirmRevokeOthers] = useState(false); // hỏi trước khi đăng xuất TẤT CẢ thiết bị khác
  const [revokingOthers, setRevokingOthers] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const r = await getDeletionStatus();
      if (cancelled) return;
      if (r.ok) {
        setDeletionStatus(r.data);
      } else {
        setDeletionError(r.message);
      }
      setDeletionLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Nạp danh sách thiết bị + đăng ký realtime. fetchSessions dùng lại cho lần đầu VÀ mỗi lần nhận
  // sessions-updated (đăng nhập thiết bị mới / revoke). Cờ `cancelled` chống setState sau unmount.
  useEffect(() => {
    let cancelled = false;
    async function fetchSessions(): Promise<void> {
      const r = await listMySessions();
      if (cancelled) return;
      if (r.ok) {
        setSessions(r.data);
        setSessionsError('');
      } else {
        setSessionsError(r.message);
      }
    }
    void fetchSessions();
    // Realtime: server phát sessions-updated → tải lại danh sách. Trả hàm hủy đăng ký lúc unmount.
    const unsubscribe = subscribeSessionsUpdated(() => {
      void fetchSessions();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  // Thời gian tương đối ("Hoạt động 5 phút trước") tự già đi — re-render nhẹ mỗi 30s khi đang hiển thị thiết bị.
  useEffect(() => {
    if (!sessions || sessions.length === 0) return undefined;
    const t = setInterval(() => forceTick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, [sessions]);

  function showToast(msg: string): void {
    setToast(msg);
    setTimeout(() => setToast(''), 3000);
  }

  async function confirmRevokeSession(sessionId: string): Promise<void> {
    setConfirmRevokeId(null);
    setRevokingId(sessionId);
    const r = await revokeMySession(sessionId);
    setRevokingId(null);
    if (r.ok) {
      // Cập nhật lạc quan ngay (broadcast realtime cũng sẽ refetch, nhưng bỏ ngay khỏi UI cho mượt).
      setSessions((prev) => (prev ? prev.filter((s) => s.id !== sessionId) : prev));
      setSessionsError('');
      // "Đã đăng xuất lúc nào" — không lưu lịch sử logout ở schema (revoke = xóa hàng), nên báo NGAY mốc giờ
      // vừa đăng xuất qua toast (đủ đáp ứng yêu cầu Admin Demo mà không phải giữ hàng đã revoke trong DB).
      showToast(`Đã đăng xuất thiết bị lúc ${formatHmVi(new Date())}.`);
    } else {
      setSessionsError(r.message);
    }
  }

  async function doRevokeOthers(): Promise<void> {
    setConfirmRevokeOthers(false);
    setRevokingOthers(true);
    const r = await revokeOtherSessions();
    setRevokingOthers(false);
    if (r.ok) {
      // Giữ lại đúng phiên hiện tại trong UI (broadcast realtime cũng refetch).
      setSessions((prev) => (prev ? prev.filter((s) => s.current) : prev));
      setSessionsError('');
      showToast(
        r.data.revokedCount > 0
          ? `Đã đăng xuất ${r.data.revokedCount} thiết bị khác lúc ${formatHmVi(new Date())}.`
          : 'Không có thiết bị nào khác đang đăng nhập.'
      );
    } else {
      setSessionsError(r.message);
    }
  }

  // Interval sống trong lúc CÓ yêu cầu xóa đang treo (để đếm ngược chạy) — dọn khi hủy/component unmount.
  useEffect(() => {
    if (deletionStatus?.deleteAt) {
      tickRef.current = setInterval(() => forceTick((n) => n + 1), 1000);
      return () => {
        if (tickRef.current) clearInterval(tickRef.current);
      };
    }
    return undefined;
  }, [deletionStatus?.deleteAt]);

  async function confirmCancelDeletion(): Promise<void> {
    const r = await cancelAccountDeletion();
    if (r.ok) {
      setDeletionStatus(r.data);
      setDeletionError('');
    } else {
      setDeletionError(r.message);
    }
    setConfirmCancelDelete(false);
  }

  const strength = passwordStrength(next);
  const mismatch = confirm.length > 0 && next !== confirm;
  const canSave = current.length > 0 && next.length > 0 && next === confirm;

  function save(): void {
    setToast('Đã đổi mật khẩu thành công (demo — chưa lưu thật).');
    setCurrent('');
    setNext('');
    setConfirm('');
    setTimeout(() => setToast(''), 3000);
  }

  return (
    <div className="h-full overflow-auto bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {/* Việc 4 (1/8, Admin Demo "các button quay lại ở cài đặt chưa thấy đâu") — màn này KHÔNG nằm trong Sidebar
          (chỉ vào được bằng cách drill-down từ Cài đặt), CÙNG lý do các màn "bước kế tiếp" khác cần nút quay
          lại tường minh trên màn hình, không chỉ dựa vào nút back phần cứng Android. `navigate(-1)` (thay vì
          route cứng) để luôn về ĐÚNG màn vừa mở từ đó (Cài đặt). */}
      <BackButton className="mb-3" onClick={() => navigate(-1)} />
      <h1 className="mb-4 text-base font-bold text-slate-800">Tài khoản & bảo mật</h1>

      {/* Đổi mật khẩu */}
      <div className="mb-6 max-w-md rounded-lg-mac border border-line p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
          <ShieldCheck className="h-4 w-4 text-brand" /> Đổi mật khẩu
        </h2>
        <div className="flex flex-col gap-3">
          <Field label="Mật khẩu hiện tại" required>
            <PasswordInput value={current} onChange={(e) => setCurrent(e.target.value)} placeholder="Nhập mật khẩu hiện tại" />
          </Field>
          <Field label="Mật khẩu mới" required>
            <PasswordInput value={next} onChange={(e) => setNext(e.target.value)} placeholder="Ít nhất 8 ký tự" />
          </Field>
          {/* Chỉ báo độ mạnh: 3 vạch + nhãn Yếu/Vừa/Mạnh. */}
          {next.length > 0 && (
            <div className="flex items-center gap-2">
              <div className="flex flex-1 gap-1">
                {[1, 2, 3].map((i) => (
                  <div
                    key={i}
                    className="h-1.5 flex-1 rounded-full"
                    style={{ backgroundColor: i <= strength.level ? strength.color : '#e5e9f0' }}
                  />
                ))}
              </div>
              <span className="text-xs font-medium" style={{ color: strength.color }}>
                {strength.label}
              </span>
            </div>
          )}
          <Field label="Xác nhận mật khẩu mới" required>
            <PasswordInput
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Nhập lại mật khẩu mới"
              className={
                mismatch
                  ? 'rounded-md border border-danger bg-white px-3 py-2.5 text-sm outline-none transition focus:ring-2 focus:ring-danger/20'
                  : undefined
              }
            />
          </Field>
          {mismatch && <p className="-mt-2 text-xs text-danger">Mật khẩu xác nhận chưa khớp.</p>}
          <Button onClick={save} disabled={!canSave} className="mt-1 w-full">
            Lưu mật khẩu mới
          </Button>
        </div>
      </div>

      {/* Thiết bị đang đăng nhập — DỮ LIỆU THẬT + realtime (5/8). */}
      <div className="mb-6 max-w-md rounded-lg-mac border border-line p-4">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700">
          <MonitorSmartphone className="h-4 w-4 text-brand" /> Thiết bị đang đăng nhập
        </h2>
        <p className="mb-3 text-xs leading-relaxed text-slate-500">
          Danh sách các phiên đang đăng nhập vào tài khoản của bạn. Nếu thấy thiết bị lạ, hãy đăng xuất thiết bị đó.
        </p>

        {sessionsError && <p className="mb-2 text-xs text-danger">{sessionsError}</p>}

        {sessions === null && !sessionsError && <p className="text-xs text-slate-400">Đang tải danh sách thiết bị…</p>}

        {sessions !== null && sessions.length === 0 && (
          <p className="text-xs text-slate-400">Không có phiên nào đang hoạt động.</p>
        )}

        {sessions !== null && sessions.length > 0 && (
          <>
            <ul className="flex flex-col gap-2">
              {sessions.map((s) => {
                const DeviceIcon = s.kind === 'mobile' ? Smartphone : Monitor;
                return (
                  <li key={s.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2.5">
                    <DeviceIcon className={`h-5 w-5 shrink-0 ${s.current ? 'text-brand' : 'text-slate-400'}`} />
                    <div className="min-w-0 flex-1">
                      <p className="flex items-center gap-2 text-sm font-medium text-slate-700">
                        <span className="truncate">{s.deviceLabel}</span>
                        {s.current && (
                          <span className="shrink-0 rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-semibold text-brand">
                            Thiết bị này
                          </span>
                        )}
                      </p>
                      <p className="mt-0.5 text-xs text-slate-400">
                        Đăng nhập lúc {formatDateTimeVi(s.createdAt)} · Hoạt động {formatRelativeVi(s.lastUsedAt)}
                      </p>
                    </div>
                    {!s.current && (
                      <Button
                        variant="soft"
                        icon={<LogOut className="h-4 w-4" />}
                        disabled={revokingId === s.id}
                        onClick={() => setConfirmRevokeId(s.id)}
                        className="shrink-0"
                      >
                        {revokingId === s.id ? 'Đang…' : 'Đăng xuất'}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
            {/* "Đăng xuất tất cả thiết bị khác" — chỉ hiện khi CÓ ≥1 thiết bị khác phiên hiện tại. */}
            {sessions.some((s) => !s.current) && (
              <Button
                variant="soft"
                icon={<LogOut className="h-4 w-4" />}
                disabled={revokingOthers}
                onClick={() => setConfirmRevokeOthers(true)}
                className="mt-3 w-full text-danger"
              >
                {revokingOthers ? 'Đang đăng xuất…' : 'Đăng xuất tất cả thiết bị khác'}
              </Button>
            )}
          </>
        )}
      </div>

      {/* Xóa tài khoản — 48h ân hạn (25/7). Gọi API THẬT (KHÔNG mock như 2 mục trên). */}
      <div className="mb-6 max-w-md rounded-lg-mac border border-danger/30 p-4">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-danger">
          <AlertOctagon className="h-4 w-4" /> Xóa tài khoản
        </h2>

        {deletionLoading && <p className="text-xs text-slate-400">Đang tải trạng thái…</p>}

        {!deletionLoading && deletionError && <p className="text-xs text-danger">{deletionError}</p>}

        {!deletionLoading && !deletionError && !deletionStatus?.deletionRequestedAt && (
          <>
            <p className="mb-3 text-xs leading-relaxed text-slate-500">
              Xóa tài khoản sẽ có <span className="font-semibold text-slate-700">48 giờ ân hạn</span> kể từ lúc bạn
              xác nhận — trong 48 giờ đó bạn vẫn đăng nhập bình thường và có thể hủy yêu cầu bất cứ lúc nào. Sau
              đúng 48 giờ, tài khoản sẽ bị xóa hẳn (kể cả tài khoản chat) và KHÔNG thể khôi phục.
            </p>
            <Button
              variant="danger"
              icon={<Trash2 className="h-4 w-4" />}
              className="w-full"
              onClick={() => {
                setDeletePassword('');
                setDeleteStepError('');
                setDeleteStep('password');
              }}
            >
              Xóa tài khoản
            </Button>
          </>
        )}

        {!deletionLoading && !deletionError && deletionStatus?.deletionRequestedAt && deletionStatus.deleteAt && (
          <>
            <div className="mb-3 rounded-md bg-danger/10 px-3 py-2.5 text-xs text-danger">
              <p className="font-semibold">Tài khoản đang trong 48 giờ ân hạn chờ xóa.</p>
              <p className="mt-1">Sẽ bị xóa hẳn lúc: {formatDateTimeVi(deletionStatus.deleteAt)}</p>
              <p className="mt-1 font-medium">{formatCountdown(new Date(deletionStatus.deleteAt).getTime() - Date.now())}</p>
            </div>
            <Button variant="soft" className="w-full" onClick={() => setConfirmCancelDelete(true)}>
              Hủy yêu cầu xóa
            </Button>
          </>
        )}
      </div>

      <p className="max-w-md text-xs text-slate-400">
        Đăng ký tài khoản mới yêu cầu xác thực OTP qua email (xem mục Đăng nhập).
      </p>

      {toast && (
        <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full bg-success px-4 py-2 text-sm font-medium text-white shadow-card">
          {toast}
        </div>
      )}

      {confirmRevokeId && (
        <ConfirmDialog
          title="Đăng xuất thiết bị"
          message="Thiết bị này sẽ bị đăng xuất khỏi tài khoản của bạn ngay lập tức và cần đăng nhập lại để tiếp tục. Bạn chắc chắn?"
          confirmLabel="Đăng xuất"
          danger
          onCancel={() => setConfirmRevokeId(null)}
          onConfirm={() => confirmRevokeSession(confirmRevokeId)}
        />
      )}

      {confirmRevokeOthers && (
        <ConfirmDialog
          title="Đăng xuất tất cả thiết bị khác"
          message="Tất cả thiết bị khác (trừ thiết bị bạn đang dùng) sẽ bị đăng xuất ngay lập tức và cần đăng nhập lại. Thiết bị hiện tại của bạn vẫn giữ nguyên. Bạn chắc chắn?"
          confirmLabel="Đăng xuất tất cả"
          danger
          onCancel={() => setConfirmRevokeOthers(false)}
          onConfirm={doRevokeOthers}
        />
      )}

      {/* Xóa tài khoản — 2 BƯỚC xác thực (bảo mật 6/8). Bước 1: mật khẩu → gửi OTP email. Bước 2: OTP 6 số +
          gõ lại mã xác nhận 2 số hiển thị trên màn. Nút "Xác nhận xóa" (đỏ) chỉ bật khi cả hai đúng. */}
      {deleteStep === 'password' && (
        <Modal title="Xóa tài khoản — Bước 1/2" width="max-w-md" onClose={resetDeleteFlow} onSubmit={submitDeletePassword}>
          <div className="flex flex-col gap-4">
            <div className="flex gap-3">
              <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger">
                <AlertOctagon className="h-5 w-5" />
              </div>
              <p className="flex-1 text-sm leading-relaxed text-slate-600">
                Để bảo vệ tài khoản, xóa tài khoản cần xác thực <span className="font-semibold text-slate-700">mật khẩu đăng nhập</span> và{' '}
                <span className="font-semibold text-slate-700">mã OTP gửi qua email</span>. Nhập mật khẩu của bạn để nhận mã OTP.
              </p>
            </div>
            <Field label="Mật khẩu đăng nhập" required>
              <PasswordInput
                value={deletePassword}
                autoFocus
                onChange={(e) => setDeletePassword(e.target.value)}
                placeholder="Nhập mật khẩu đăng nhập của bạn"
              />
            </Field>
            {deleteStepError && <p className="text-xs text-danger">{deleteStepError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={resetDeleteFlow}
                className="rounded-full border border-line px-4 py-2 text-sm font-medium text-slate-600 hover:bg-appbg"
              >
                Hủy
              </button>
              <Button variant="danger" disabled={!deletePassword || deleteBusy} onClick={submitDeletePassword}>
                {deleteBusy ? 'Đang gửi mã…' : 'Gửi mã OTP'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {deleteStep === 'otp' && (
        <Modal title="Xóa tài khoản — Bước 2/2" width="max-w-md" onClose={resetDeleteFlow} onSubmit={submitDeleteConfirm}>
          <div className="flex flex-col gap-4">
            <p className="text-sm leading-relaxed text-slate-600">
              Mã OTP đã gửi tới email của bạn. Nhập mã OTP <span className="font-semibold text-slate-700">6 số</span>, sau đó gõ lại{' '}
              <span className="font-semibold text-slate-700">mã xác nhận 2 số</span> bên dưới để xác nhận xóa.
            </p>
            <Field label="Mã OTP (6 số) trong email" required>
              <input
                value={deleteOtp}
                inputMode="numeric"
                maxLength={6}
                onChange={(e) => setDeleteOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="Ví dụ: 123456"
                className="w-full rounded-md border border-line px-3 py-2.5 text-sm tracking-widest outline-none transition focus:ring-2 focus:ring-brand/20"
              />
            </Field>
            <div className="rounded-md bg-danger/5 px-3 py-2.5">
              <p className="text-sm text-slate-600">
                Nhập số <span className="text-lg font-bold text-danger" data-testid="delete-confirm-number">{deleteConfirmNumber}</span> để xác nhận xóa
              </p>
              <input
                value={deleteConfirmInput}
                inputMode="numeric"
                maxLength={2}
                onChange={(e) => setDeleteConfirmInput(e.target.value.replace(/\D/g, '').slice(0, 2))}
                placeholder="Gõ lại 2 số ở trên"
                className="mt-2 w-full rounded-md border border-line px-3 py-2.5 text-sm outline-none transition focus:ring-2 focus:ring-danger/20"
              />
            </div>
            {deleteStepError && <p className="text-xs text-danger">{deleteStepError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={resetDeleteFlow}
                className="rounded-full border border-line px-4 py-2 text-sm font-medium text-slate-600 hover:bg-appbg"
              >
                Hủy
              </button>
              <Button
                variant="danger"
                icon={<Trash2 className="h-4 w-4" />}
                disabled={deleteBusy || deleteOtp.trim().length !== 6 || deleteConfirmInput.trim() !== deleteConfirmNumber}
                onClick={submitDeleteConfirm}
              >
                {deleteBusy ? 'Đang xóa…' : 'Xác nhận xóa'}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {confirmCancelDelete && (
        <ConfirmDialog
          title="Hủy yêu cầu xóa tài khoản"
          message="Tài khoản sẽ trở lại bình thường ngay lập tức, không còn nằm trong 48 giờ ân hạn nữa. Bạn chắc chắn?"
          confirmLabel="Hủy yêu cầu xóa"
          onCancel={() => setConfirmCancelDelete(false)}
          onConfirm={confirmCancelDeletion}
        />
      )}
    </div>
  );
}
