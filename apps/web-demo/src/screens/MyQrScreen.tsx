// Màn "Mã QR của tôi" (mục 24 — QR cá nhân kết bạn như Zalo, Admin Demo bổ sung 23/7): avatar + tên +
// username phía trên QR cá nhân, nút "Lưu ảnh"/"Chia sẻ", nút "Quét QR" mở camera thật quét mã người khác.
// prop initialScanOpen: mở sẵn modal quét (từ ?scan=1 — cho capture-frames chụp).
//
// SigMa (27/7, Admin Demo phát hiện qua test thật) — 2 lỗi thật đã sửa ở đây, THEO ĐÚNG THỨ TỰ tự phát hiện:
// (1) TRƯỚC ĐÂY màn này 100% mock: `pseudoQrPattern()` tự vẽ ô vuông giả (KHÔNG phải QR thật, không quét
// được) từ `CURRENT_AGENT.username` cứng. (2) Sửa lần đầu bị NHẦM nguồn dữ liệu: gọi `GET /v1/me/qr`
// (agent-api-client.ts `getMyQr()`) — nhưng endpoint đó trả **QR NHẬN TIỀN NGÂN HÀNG** (`Agent.qrImage`, dùng
// cho luồng "Bán TID"/QrDisplayScreen.tsx), KHÔNG PHẢI QR "kết bạn" — tự phát hiện nhầm lẫn này khi rà lại
// `buildAgentQrResult` (routes/agents.ts) thấy trả `bankAccountLabel`, không liên quan hồ sơ/kết bạn gì cả.
// Sửa ĐÚNG: QR "kết bạn" phải tự sinh CLIENT-SIDE (thư viện `qrcode`, KHÔNG cần endpoint mới) từ URL hồ sơ
// công khai `/app/u/:username` đã có sẵn (PublicProfileScreen.tsx) — quét bằng BẤT KỲ app QR nào (không riêng
// SigMa) đều mở đúng trang hồ sơ, giống cách Zalo/LinkedIn share QR cá nhân.
// Nút "Quét QR": nối thật `@capacitor-mlkit/barcode-scanning` — CHỈ hoạt động trên app di động thật
// (Capacitor.isNativePlatform()), trình duyệt thường không có API camera-scan gốc tương đương, hiện thông báo
// rõ thay vì giả vờ hoạt động.
import { useEffect, useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { Download, ScanLine, Share2, X } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
// Lane D vòng 2 (3/8) — `qrcode` (~50KB) nạp ĐỘNG (import() ngay trước khi sinh mã, dưới) thay vì import tĩnh
// đầu file: chỉ màn "Mã QR của tôi" mới cần, kéo nó ra khỏi chunk chính (app khởi động nhẹ hơn, thư viện QR
// chỉ tải khi người dùng thật sự mở màn này).
import { Button } from '../components/Button';
import { BackButton } from '../components/BackButton';
import { DotsLoader } from '../components/DotsLoader';
import { fetchAuthenticatedAgent } from '../lib/bot-api-client';
import { fetchAttachmentObjectUrl } from '../lib/attachment-blob';
import { avatarColorForKey, avatarColorForAgent } from '../lib/avatar-color';
import { getSession } from '../lib/session';
import { ROUTES } from '../routes';

const PROFILE_BASE_URL = 'https://sigma.example.com';

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

function ScanQrModal({ onClose, onResult }: { onClose: () => void; onResult: (rawValue: string) => void }): JSX.Element {
  const [status, setStatus] = useState<'starting' | 'error'>('starting');
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function run(): Promise<void> {
      if (!Capacitor.isNativePlatform()) {
        setStatus('error');
        setError('Quét QR bằng camera chỉ dùng được trên app di động SigMa, chưa hỗ trợ trên trình duyệt.');
        return;
      }
      try {
        const perm = await BarcodeScanner.checkPermissions();
        if (perm.camera !== 'granted') {
          const req = await BarcodeScanner.requestPermissions();
          if (req.camera !== 'granted') {
            if (!cancelled) {
              setStatus('error');
              setError('Chưa được cấp quyền Camera — vào Cài đặt máy để cấp quyền cho SigMa.');
            }
            return;
          }
        }
        const result = await BarcodeScanner.scan();
        if (cancelled) return;
        const value = result.barcodes[0]?.rawValue;
        if (value) onResult(value);
        else onClose();
      } catch (err) {
        if (!cancelled) {
          setStatus('error');
          setError('Không mở được camera: ' + (err instanceof Error ? err.message : String(err)));
        }
      }
    }
    run();
    return () => {
      cancelled = true;
    };
  }, [onClose, onResult]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col items-center justify-center bg-black/90" onClick={onClose}>
      <button className="absolute right-5 top-5 text-white" onClick={onClose} aria-label="Đóng">
        <X className="h-7 w-7" />
      </button>
      {status === 'starting' ? (
        <>
          <DotsLoader size="lg" color="white" />
          <p className="mt-4 text-sm text-white/80">Đang mở camera...</p>
        </>
      ) : (
        <p className="mx-8 text-center text-sm text-white/80">{error}</p>
      )}
    </div>
  );
}

export function MyQrScreen({ initialScanOpen }: { initialScanOpen?: boolean }): JSX.Element {
  const navigate = useNavigate();
  const [scanOpen, setScanOpen] = useState(!!initialScanOpen);
  useEffect(() => setScanOpen(!!initialScanOpen), [initialScanOpen]);

  const [name, setName] = useState(getSession()?.agentName ?? '');
  const [username, setUsername] = useState<string | null>(null);
  // Item 7 (6/8) — agentId CHÍNH MÌNH để tô màu fallback avatar theo avatarColorForAgent (CÙNG màu mọi người thấy).
  const [meAgentId, setMeAgentId] = useState<number | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // [B181 19/11] 2 nút "Lưu ảnh" / "Chia sẻ" TRƯỚC ĐÂY là nút GIẢ (trình xử lý rỗng): bấm xong không có gì
  // xảy ra, người dùng tưởng máy lỗi. Nay làm thật — và khi máy không hỗ trợ thì NÓI RÕ, không im lặng.
  const tenTep = (username ? 'sigma-' + username : 'sigma-qr') + '.png';

  function luuAnh(): void {
    if (!qrDataUrl) return;
    const a = document.createElement('a');
    a.href = qrDataUrl;
    a.download = tenTep;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  async function chiaSe(): Promise<void> {
    if (!qrDataUrl) return;
    try {
      const blob = await (await fetch(qrDataUrl)).blob();
      const tep = new File([blob], tenTep, { type: blob.type || 'image/png' });
      const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
      if (typeof nav.share === 'function' && (!nav.canShare || nav.canShare({ files: [tep] }))) {
        await nav.share({ files: [tep], title: 'Mã QR SigMa của tôi' });
        return;
      }
      // Máy/trình duyệt không chia sẻ được tệp → chép ảnh vào bộ nhớ tạm, vẫn dùng được.
      if (navigator.clipboard && 'write' in navigator.clipboard && typeof ClipboardItem !== 'undefined') {
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || 'image/png']: blob })]);
        window.alert('Máy không chia sẻ trực tiếp được — đã CHÉP ảnh mã QR vào bộ nhớ tạm, bạn dán vào nơi cần gửi.');
        return;
      }
      luuAnh();
      window.alert('Máy không chia sẻ trực tiếp được — đã TẢI ảnh mã QR về máy để bạn gửi thủ công.');
    } catch (e) {
      window.alert('Chưa chia sẻ được mã QR: ' + String(e));
    }
  }

  // 5/8 (Admin Demo "màn Mã QR hiện chữ L thay vì ẢNH avatar; cover không hiện ảnh bìa") — TRƯỚC ĐÂY màn này CHƯA
  // TỪNG tải avatar/ảnh bìa THẬT (chỉ vẽ vòng tròn chữ cái đầu + gradient cứng). Nay nối ĐÚNG nguồn
  // ProfileScreen.tsx dùng: `GET /v1/agents/:id/avatar|cover` qua fetchAttachmentObjectUrl() (attachment-blob.ts
  // — proxyFetch + CSRF + cache blob). 404 (chưa đổi ảnh) → null → fallback chữ cái / gradient brand.
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [avatarResolved, setAvatarResolved] = useState(false);
  // SigMa (27/7, Admin Demo báo "vào xem QR báo chưa liên kết" dù tài khoản đăng ký bình thường) — TRƯỚC ĐÂY
  // gộp chung 2 trường hợp khác hẳn nhau vào 1 thông báo: (1) gọi API THẤT BẠI (vd rate-limit RC thoáng qua,
  // ĐÃ GHI NHẬN là hiện tượng thật lúc verify B37/B38 — requireRcAuth gọi RC thật mỗi request) và (2) tài
  // khoản THẬT SỰ chưa có rcUsername (hiếm, gần như không xảy ra vì đăng ký luôn gán rcUsername). Case (1) bị
  // hiện nhầm thành "chưa liên kết tài khoản" — sai hoàn toàn, khiến người dùng tưởng tài khoản lỗi trong khi
  // chỉ là mạng/API thoáng qua. Sửa: tách riêng state lỗi + tự động thử lại 1 lần sau 2s (khớp bài học
  // "rate-limit RC dồn dập" — B37/B38), có nút "Thử lại" thủ công nếu vẫn lỗi.
  const [fetchError, setFetchError] = useState(false);
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFetchError(false);
    fetchAuthenticatedAgent().then(async (res) => {
      if (cancelled) return;
      if (res.ok) {
        setName(res.data.agent.name);
        const rcUsername = res.data.agent.rcUsername;
        setUsername(rcUsername);
        // Tải avatar + ảnh bìa THẬT (CÙNG nguồn ProfileScreen.tsx) — 404/lỗi → null (fallback chữ/gradient).
        const agentId = res.data.agent.id;
        setMeAgentId(agentId); // item 7 — tô màu avatar CÙNG NGUỒN avatarColorForAgent.
        void fetchAttachmentObjectUrl(`${botApiBaseUrl()}/v1/agents/${agentId}/avatar`)
          .then((u) => !cancelled && setAvatarUrl(u))
          .catch(() => !cancelled && setAvatarUrl(null))
          .finally(() => !cancelled && setAvatarResolved(true));
        void fetchAttachmentObjectUrl(`${botApiBaseUrl()}/v1/agents/${agentId}/cover`)
          .then((u) => !cancelled && setCoverUrl(u))
          .catch(() => !cancelled && setCoverUrl(null));
        if (rcUsername) {
          const profileUrl = `${PROFILE_BASE_URL}${ROUTES.profileByUsername(rcUsername)}`;
          try {
            const { default: QRCode } = await import('qrcode');
            setQrDataUrl(await QRCode.toDataURL(profileUrl, { width: 400, margin: 1, color: { dark: '#0f172a', light: '#ffffff' } }));
          } catch (err) {
            console.error('[MyQrScreen] sinh mã QR thất bại:', err);
          }
        }
      } else {
        setFetchError(true);
        setAvatarResolved(true); // hết đường tải danh tính → thôi hiện skeleton avatar, về fallback chữ cái.
        // Tự thử lại 1 lần sau 2s — đủ để vượt qua rate-limit RC thoáng qua mà không cần người dùng tự bấm.
        if (retryTick === 0) setTimeout(() => !cancelled && setRetryTick((t) => t + 1), 2000);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [retryTick]);

  function handleScanResult(rawValue: string): void {
    setScanOpen(false);
    // Chấp nhận URL hồ sơ công khai thật (đúng format tự sinh ở trên) — trích username từ path `/app/u/:username`.
    const m = rawValue.match(/\/app\/u\/([^/?#]+)/);
    if (m) {
      navigate(ROUTES.profileByUsername(decodeURIComponent(m[1])));
    } else {
      navigate(ROUTES.profileByUsername(rawValue));
    }
  }

  return (
    <div className="flex h-full flex-col items-center overflow-auto bg-appbg p-6">
      {/* Việc 4 (1/8, Admin Demo "tất cả các trường sang bước kế tiếp phải có nút quay lại") — màn này KHÔNG nằm
          trong Sidebar (vào từ Danh bạ hoặc Cài đặt), `navigate(-1)` để luôn về ĐÚNG màn vừa mở từ đó. */}
      <div className="mb-3 w-full max-w-sm">
        <BackButton onClick={() => navigate(-1)} />
      </div>
      {/* B107-tiếp (2/8) — CÙNG bug class vừa fix ProfileScreen.tsx/PublicProfileScreen.tsx (thiếu `shrink-0`
          → flexbox co thẻ vừa khung nhìn + overflow-hidden cắt mất nội dung dư thay vì để cha overflow-auto
          cuộn) — quét thấy ở đây, cấu trúc lồng thêm 1 lớp (`shrink-0` cần đặt ở div NGOÀI, div `overflow-
          hidden` bên trong không phải flex-item trực tiếp của cha overflow-auto). */}
      <div className="w-full max-w-sm shrink-0">
        <div className="overflow-hidden rounded-lg-mac border border-line bg-white shadow-card">
          {/* Avatar + tên + username phía trên QR (spec mục 24). Ảnh bìa THẬT nếu đã đặt (coverUrl), ngược lại
              nền gradient brand ĐỒNG NHẤT (var(--gradient-brand), KHÔNG teal lệch — Admin Demo 5/8). Khi có ảnh bìa
              thật, phủ 1 lớp tối nhẹ để chữ/avatar trắng vẫn đọc rõ. */}
          <div
            className="relative flex flex-col items-center gap-2 bg-cover bg-center px-6 pb-6 pt-6 text-white"
            style={coverUrl ? { backgroundImage: `url(${coverUrl})` } : { background: 'var(--gradient-brand)' }}
          >
            {coverUrl && <div className="pointer-events-none absolute inset-0 bg-black/25" />}
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="relative h-16 w-16 rounded-full border-2 border-white/70 object-cover shadow" />
            ) : !avatarResolved ? (
              <div className="relative h-16 w-16 animate-pulse rounded-full border-2 border-white/60 bg-white/30" />
            ) : (
              <div
                className="relative flex h-16 w-16 items-center justify-center rounded-full border-2 border-white/60 text-2xl font-bold"
                // Item 7 (6/8) — agentId số → avatarColorForAgent (CÙNG màu mọi người thấy); chưa có → tạm theo tên.
                style={{ backgroundColor: meAgentId != null ? avatarColorForAgent(meAgentId) : name.trim() ? avatarColorForKey(name.trim()) : '#1877d6' }}
              >
                {name.trim()[0] ?? '?'}
              </div>
            )}
            <div className="relative text-lg font-semibold">{name}</div>
            {username && <div className="relative text-sm text-white/80">@{username}</div>}
          </div>
          {/* 5/8 (Admin Demo "ảnh bìa che mất QR") — BỎ chồng lấn `-mt-8` (trước dùng để QR "nổi" lên nền gradient;
              nay ảnh bìa là ẢNH thật nên chồng lấn khiến ảnh bìa che góc QR). QR nằm GỌN trong vùng trắng dưới
              ảnh bìa, KHÔNG đè lên ảnh. */}
          <div className="flex flex-col items-center gap-3 px-6 pb-6 pt-5">
            {/* QR kết bạn THẬT (27/7) — tự sinh từ URL hồ sơ công khai, quét được bằng bất kỳ app QR nào. */}
            <div className="flex aspect-square w-full max-w-48 items-center justify-center rounded-lg bg-white p-3 shadow-card ring-1 ring-line">
              {loading ? (
                <DotsLoader size="lg" />
              ) : qrDataUrl ? (
                <img src={qrDataUrl} alt="Mã QR của tôi" className="h-full w-full object-contain" />
              ) : fetchError ? (
                <div className="flex flex-col items-center gap-2 px-2 text-center">
                  <p className="text-xs text-slate-400">Không tải được — vui lòng thử lại.</p>
                  <button onClick={() => setRetryTick((t) => t + 1)} className="text-xs font-semibold text-brand underline">
                    Thử lại
                  </button>
                </div>
              ) : (
                <p className="text-center text-xs text-slate-400">Chưa liên kết tài khoản — không tạo được mã QR.</p>
              )}
            </div>
            <p className="text-center text-xs text-slate-400">Quét mã để kết bạn / nhắn tin với tôi trên SigMa</p>
            <div className="flex w-full gap-2">
              <Button variant="soft" icon={<Download className="h-4 w-4" />} className="flex-1" disabled={!qrDataUrl} onClick={luuAnh}>
                Lưu ảnh
              </Button>
              <Button variant="soft" icon={<Share2 className="h-4 w-4" />} className="flex-1" disabled={!qrDataUrl} onClick={chiaSe}>
                Chia sẻ
              </Button>
            </div>
          </div>
        </div>

        <Button onClick={() => setScanOpen(true)} icon={<ScanLine className="h-4 w-4" />} className="mt-4 w-full">
          Quét QR
        </Button>
      </div>

      {scanOpen && <ScanQrModal onClose={() => setScanOpen(false)} onResult={handleScanResult} />}
    </div>
  );
}
