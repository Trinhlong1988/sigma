// SIGMA (3/8) — Màn "Đăng nhập bằng QR" phía MÁY TẠO QR (PC/web). Hiện QR động (thư viện `qrcode` — ĐÃ có
// sẵn trong web-demo, nạp ĐỘNG như MyQrScreen.tsx) + MÃ XÁC NHẬN 2 chữ số TO cạnh QR. Xoay token mỗi ~60s
// (gọi lại /create), poll /status mỗi ~2.5s. Khi 'approved' → server đã set cookie phiên `sigma_ws`; lấy
// hồ sơ (fetchAuthenticatedAgent) lưu session cục bộ để UI biết đã đăng nhập → onLoggedIn().
//
// LUỒNG BẢO MẬT (người dùng phải hiểu): người quét QR = ĐIỆN THOẠI CỦA CHÍNH BẠN (đã đăng nhập). Sau khi quét,
// điện thoại hiện thông tin máy này + BẮT gõ đúng mã 2 chữ số đang hiện ở đây. Mã KHÔNG gửi qua QR (chỉ hiện
// trên màn này) — buộc người cầm điện thoại phải NHÌN màn hình này, chống quét nhầm/relay.
import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../components/Button';
import { BackButton } from '../components/BackButton';
import { DotsLoader } from '../components/DotsLoader';
import { qrCreate, qrStatus, encodeQrPayload } from '../lib/qr-login-api';
import { fetchAuthenticatedAgent } from '../lib/bot-api-client';
import { saveSession } from '../lib/session';

const ROTATE_MS = 60_000; // xoay token mỗi 60s (khớp rotateIn server, nhưng dùng hằng cục bộ cho bộ đếm UI)
const POLL_MS = 2_500;

export function QrLoginScreen({ onLoggedIn, onBack }: { onLoggedIn: () => void; onBack: () => void }): JSX.Element {
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [matchCode, setMatchCode] = useState<string>('');
  const [status, setStatus] = useState<'loading' | 'waiting' | 'approving' | 'expired' | 'error'>('loading');
  const [errorMsg, setErrorMsg] = useState('');
  // Cờ để dừng mọi vòng lặp khi đã đăng nhập/unmount.
  const doneRef = useRef(false);
  // Bộ đếm hết hạn 60s (Admin Demo 6/8): KHÔNG auto-xoay (spam) — mã sống 60s rồi hiện ĐỎ "hết hạn, tải lại",
  // user bấm mới tạo mã mới. Giữ ref để clear khi tạo mã mới/unmount.
  const expiryRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sinh 1 challenge mới (create) + vẽ QR. `manual` = do user bấm "làm mới" (từ trạng thái hết hạn/lỗi) →
  // hiện 'loading' NGAY để xóa màu đỏ (đỏ→xanh, Admin Demo 6/8); auto-xoay 60s để `manual=false` → KHÔNG đổi
  // trạng thái (tránh "tự nhảy load" — chỉ thay ảnh QR im lặng khi vẫn đang 'waiting').
  const refresh = useCallback(async (manual = false): Promise<void> => {
    if (doneRef.current) return;
    if (expiryRef.current) { clearTimeout(expiryRef.current); expiryRef.current = null; }
    if (manual) setStatus('loading');
    // manual = user bấm "làm mới" khi hết hạn → fresh=true để server cấp MÃ MỚI (không reuse pollSecret cũ).
    const res = await qrCreate(manual);
    if (doneRef.current) return;
    if (!res.ok) {
      setStatus('error');
      setErrorMsg(res.message);
      return;
    }
    setMatchCode(res.data.matchCode);
    try {
      const { default: QRCode } = await import('qrcode');
      const payload = encodeQrPayload(res.data.token);
      const url = await QRCode.toDataURL(payload, { width: 320, margin: 1, color: { dark: '#0f172a', light: '#ffffff' } });
      if (doneRef.current) return;
      setQrDataUrl(url);
      setStatus('waiting');
      // Hết hạn sau 60s → ĐỎ "hết hạn, tải lại" (KHÔNG tự tạo mã mới — chống spam). User bấm mới refresh(true).
      expiryRef.current = setTimeout(() => {
        if (!doneRef.current) setStatus((s) => (s === 'waiting' ? 'expired' : s));
      }, ROTATE_MS);
    } catch (err) {
      console.error('[QrLoginScreen] sinh mã QR thất bại:', err);
      setStatus('error');
      setErrorMsg('Không tạo được mã QR trên thiết bị này.');
    }
  }, []);

  // Khởi tạo (1 lần). KHÔNG auto-xoay định kỳ nữa (Admin Demo 6/8 "tránh spam") — mã sống 60s (bộ đếm trong
  // refresh) rồi hiện ĐỎ "hết hạn, tải lại"; user chủ động bấm mới tạo mã mới.
  useEffect(() => {
    doneRef.current = false;
    void refresh();
    return () => {
      doneRef.current = true;
      if (expiryRef.current) clearTimeout(expiryRef.current);
    };
  }, [refresh]);

  // Poll trạng thái. Khi approved → lấy hồ sơ + lưu session → onLoggedIn.
  useEffect(() => {
    const poll = setInterval(async () => {
      if (doneRef.current) return;
      const res = await qrStatus();
      if (doneRef.current || !res.ok) return;
      if (res.data.status === 'approved') {
        doneRef.current = true;
        setStatus('approving');
        const me = await fetchAuthenticatedAgent();
        // rcUserId có thể null (tài khoản chưa link RC) → PHẢI `?? ''` nếu không getSession từ chối phiên →
        // văng lại màn đăng nhập ngay sau khi quét duyệt (cùng lớp lỗi đã sửa ở LoginScreen 5/8).
        if (me.ok) saveSession({ userId: me.data.agent.rcUserId ?? '', agentName: me.data.agent.name });
        else saveSession({ userId: '', agentName: '' });
        onLoggedIn();
      } else if (res.data.status === 'expired') {
        // Hết hạn nhưng bộ xoay token định kỳ sẽ tự tạo mã mới ở nhịp kế — chỉ hiện trạng thái tạm.
        setStatus((s) => (s === 'waiting' ? 'expired' : s));
      }
    }, POLL_MS);
    return () => clearInterval(poll);
  }, [onLoggedIn]);

  return (
    <div className="flex h-full w-full items-center justify-center overflow-y-auto bg-gradient-to-br from-brand-tint via-white to-appbg p-6">
      <div className="w-full max-w-sm rounded-lg-mac border border-line bg-white/90 p-6 shadow-card glass-panel">
        <BackButton className="mb-3" onClick={onBack} />
        <h1 className="mb-1 text-center text-base font-bold text-slate-800">Đăng nhập bằng mã QR</h1>
        <p className="mb-4 text-center text-xs text-slate-500">
          Mở SigMa trên điện thoại đã đăng nhập → <b>Quét mã QR</b> → nhập mã xác nhận bên dưới.
        </p>

        <div className="flex flex-col items-center gap-3">
          <div className="flex aspect-square w-full max-w-56 items-center justify-center rounded-lg bg-white p-3 shadow-card ring-1 ring-line">
            {status === 'loading' || (!qrDataUrl && status !== 'error') ? (
              <DotsLoader size="lg" />
            ) : status === 'error' ? (
              <p className="px-2 text-center text-xs text-danger">{errorMsg}</p>
            ) : qrDataUrl ? (
              <img src={qrDataUrl} alt="Mã QR đăng nhập" className="h-full w-full object-contain" data-testid="qr-login-image" />
            ) : null}
          </div>

          {/* Mã xác nhận 2 chữ số — hiển thị TO, RÕ. Người dùng đọc TỪ ĐÂY để gõ vào điện thoại. */}
          {matchCode && (
            <div className="flex flex-col items-center gap-1" data-testid="qr-login-matchcode">
              <span className="text-xs text-slate-500">Mã xác nhận</span>
              <span className="rounded-lg bg-brand/10 px-4 py-1.5 text-3xl font-extrabold tracking-widest text-brand">{matchCode}</span>
              <span className="text-center text-[11px] text-slate-400">Nhập đúng mã này trên điện thoại để hoàn tất</span>
            </div>
          )}

          {status === 'approving' && <p className="text-sm font-medium text-brand">Đã xác nhận — đang đăng nhập...</p>}
          {status === 'expired' && (
            <button onClick={() => void refresh(true)} className="flex items-center gap-1.5 text-xs font-semibold text-brand underline">
              <RefreshCw className="h-3.5 w-3.5" /> Mã đã hết hạn — làm mới
            </button>
          )}
          {status === 'error' && (
            <Button variant="soft" icon={<RefreshCw className="h-4 w-4" />} onClick={() => void refresh(true)} className="w-full">
              Thử lại
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
