// Cài đặt — ThemeToggle, cỡ chữ toàn app (mục 22), Mã QR của tôi (mục 24), Tài khoản & bảo mật
// (mục 25 — màn riêng), Tự động lưu ảnh (mục 26), Đồng bộ & Sao lưu (mục 32), thông tin tài khoản.
// B83 (31/7) — ĐÃ XÓA khối "Quyền ứng dụng (giả lập)" (Micro/Camera/Danh bạ toggle) — Admin Demo xác nhận
// component không có tác dụng thật (chỉ useState cục bộ, không gọi API/không ảnh hưởng quyền OS thật nào).
// Quyền mic/camera THẬT giờ do chính trình duyệt/OS tự xin lúc dùng tính năng (ghi âm B76, chụp ảnh camera,
// chụp màn hình B79) — app KHÔNG có cách nào tự thu hồi/cấp quyền OS từ UI web, giữ khối giả chỉ gây hiểu lầm.
import { useEffect, useState, type JSX } from 'react';
import {
  Bell,
  CheckCircle2,
  ChevronRight,
  CloudUpload,
  FolderOpen,
  ImageDown,
  LogOut,
  QrCode,
  RefreshCw,
  ScanLine,
  ShieldCheck,
  UserX,
  X
} from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { ThemeToggle } from '../components/ThemeToggle';
import { Button } from '../components/Button';
import { Switch } from '../components/Switch';
import { isSigMaPc } from '../components/PcTitleBar';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { HiddenChatsModal } from '../components/HiddenChatsModal';
import { EyeOff } from 'lucide-react';
import { FONT_LEVELS, applyFontLevel, currentFontLevel, type FontLevel } from '../font-scale';
import { isAudioEnabled, setAudioEnabled } from '../lib/audio-player';
import { isDesktopOsNotifEnabled, setDesktopOsNotifEnabled } from '../lib/os-notification';
import {
  useNotificationSettings,
  setMessageNotifEnabled,
  setCallNotifEnabled,
  setToastStyle,
  setToastDurationSec,
  TOAST_DURATION_OPTIONS,
  type ToastStyle
} from '../lib/notification-settings';
import { fetchAuthenticatedAgent, getCachedAuthenticatedAgent } from '../lib/bot-api-client';
import { getSession } from '../lib/session';
import { avatarColorForAgent } from '../lib/avatar-color';
import { AgentAvatar } from '../components/AgentAvatar';
import { connectGoogleDriveBackup, getGoogleDriveBackupStatus, runGoogleDriveBackupNow, listMyFriends, unblockFriend, type FriendListItem } from '../lib/agent-api-client';
import { requestDriveBackupAuthorizationCode } from '../lib/google-drive-backup';

function botApiBaseUrl(): string {
  return import.meta.env.VITE_BOT_API_URL || 'http://localhost:8788';
}

// SigMa PC (Electron) — bridge cập nhật phần mềm (window.SigMaPC.*, KHÁC SigMa Quản Lý window.api.*).
// Chỉ dùng trong mục "Cập nhật phần mềm" (render khi isSigMaPc()). Web/APK → undefined, mục KHÔNG hiện.
interface PcUpdateBridge {
  checkUpdate: () => Promise<unknown>;
  getLastAvailableUpdate: () => Promise<{ version: string } | null>;
  appGetVersion: () => Promise<string>;
}
function pcUpdateBridge(): PcUpdateBridge | undefined {
  return (window as unknown as { SigMaPC?: PcUpdateBridge }).SigMaPC;
}

// 5/8 (Admin Demo "button trượt bật/tắt vẫn cũ") — nút gạt nay là component CHUNG <Switch> (toggle-3d, bật =
// brand cyan) DÙNG CHUNG toàn app. Giữ alias `Toggle` (API on/onChange y hệt) để mọi call-site trong màn
// này không phải sửa — chỉ đổi ĐIỂM ĐỊNH NGHĨA sang Switch, hết 2 kiểu toggle lệch nhau.
function Toggle({ on, onChange, disabled }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean }): JSX.Element {
  return <Switch on={on} onChange={onChange} disabled={disabled} />;
}

/** Hàng toggle quyền riêng tư / thông báo dùng chung trong Settings. */
function ToggleRow({ label, note, initial }: { label: string; note?: string; initial: boolean }): JSX.Element {
  const [on, setOn] = useState(initial);
  return (
    <div className="flex items-center justify-between py-2.5">
      <div>
        <div className="text-sm text-slate-700">{label}</div>
        {note && <div className="text-xs text-slate-400">{note}</div>}
      </div>
      <Toggle on={on} onChange={setOn} />
    </div>
  );
}

/** Hàng "Âm thanh" (mục 35, hạ tầng audio Admin Demo 24/7) — KHÁC các ToggleRow khác trong màn này (vẫn
 * là mock cục bộ chưa lưu): đây là công tắc DUY NHẤT trong toàn app điều khiển playRingtone/
 * playHoldMusic/playBusyTone/playMessageSound/playNotificationChime (đọc lib/audio-player.ts), nối
 * THẬT vào localStorage riêng của audio-player — KHÔNG tạo thêm hệ thống cài đặt song song. */
function SoundToggleRow(): JSX.Element {
  const [on, setOn] = useState(() => isAudioEnabled());
  return (
    <div className="flex items-center justify-between py-2.5">
      <div className="text-sm text-slate-700">Âm thanh</div>
      <Toggle
        on={on}
        onChange={(v) => {
          setOn(v);
          setAudioEnabled(v);
        }}
      />
    </div>
  );
}

/** Mục 35 — Cài đặt thông báo THẬT (item 2, Admin Demo chốt 6/8) — nối lib/notification-settings (GLOBAL
 * per-device, localStorage). Thay các ToggleRow MOCK cũ: tắt thông báo tin nhắn / tắt thông báo cuộc gọi +
 * chọn kiểu toast (góc phải-dưới | thả từ trên) + thời gian tự ẩn. SoundToggleRow (âm thanh) giữ nguyên (đã thật). */
/** Hàng "Thông báo desktop" (web-only) — Admin Demo 8/8 "phải là toggle trượt bật/tắt, không phải nút Gửi thử".
 * Toggle THẬT: bật → xin quyền trình duyệt (nếu 'default') + cho phép app bắn popup desktop; tắt → app NGỪNG bắn
 * popup desktop (cờ isDesktopOsNotifEnabled, trình duyệt không cho code thu hồi quyền nên tắt = app tự chặn).
 * 'denied' (đã bị chặn ở trình duyệt) → toggle không bật lên được, chú thích hướng dẫn mở khóa 🔒.
 * EXE (isSigMaPc) / APK (Capacitor native) → KHÔNG render (dùng popup tự-vẽ / FCM, không cần quyền web). */
function WebDesktopNotificationRow(): JSX.Element | null {
  const isWeb = !isSigMaPc() && !Capacitor.isNativePlatform() && typeof window !== 'undefined' && 'Notification' in window;
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(() =>
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported'
  );
  const [appEnabled, setAppEnabled] = useState<boolean>(() => isDesktopOsNotifEnabled());
  useEffect(() => {
    const onVis = (): void => {
      if (typeof window !== 'undefined' && 'Notification' in window) setPerm(Notification.permission);
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);
  if (!isWeb || perm === 'unsupported') return null;

  const on = perm === 'granted' && appEnabled;

  async function toggle(next: boolean): Promise<void> {
    if (next) {
      let p = perm;
      if (p === 'default') {
        try {
          p = await Notification.requestPermission();
        } catch {
          /* bỏ qua */
        }
        setPerm(p);
      }
      if (p === 'granted') {
        setDesktopOsNotifEnabled(true);
        setAppEnabled(true);
      }
      // 'denied' → không bật được bằng code; chú thích hướng dẫn 🔒 hiển thị.
    } else {
      setDesktopOsNotifEnabled(false);
      setAppEnabled(false);
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-slate-700">Thông báo desktop</div>
        {perm === 'denied' ? (
          <div className="text-xs text-amber-600">
            Đang bị chặn — bấm 🔒 cạnh địa chỉ web → <b>Thông báo</b> → <b>Cho phép</b>, rồi tải lại trang
          </div>
        ) : (
          <div className="text-xs text-slate-400">Hiện popup khi thu nhỏ / đang ở tab hoặc ứng dụng khác</div>
        )}
      </div>
      <Toggle on={on} onChange={(v) => void toggle(v)} />
    </div>
  );
}

function NotificationSettingsSection(): JSX.Element {
  const settings = useNotificationSettings();
  const styleOptions: Array<{ value: ToastStyle; label: string }> = [
    { value: 'corner', label: 'Góc phải-dưới' },
    { value: 'top-drop', label: 'Thả từ trên' }
  ];
  return (
    <div className="divide-y divide-line">
      <WebDesktopNotificationRow />
      <SoundToggleRow />
      <div className="flex items-center justify-between py-2.5">
        <div>
          <div className="text-sm text-slate-700">Thông báo tin nhắn</div>
          <div className="text-xs text-slate-400">Tắt thông báo trên thiết bị này (khi đang mở app)</div>
        </div>
        <Toggle on={settings.messagesEnabled} onChange={setMessageNotifEnabled} />
      </div>
      <div className="flex items-center justify-between py-2.5">
        <div>
          <div className="text-sm text-slate-700">Thông báo cuộc gọi đến</div>
          <div className="text-xs text-slate-400">Tắt chuông báo cuộc gọi trên thiết bị này</div>
        </div>
        <Toggle on={settings.callsEnabled} onChange={setCallNotifEnabled} />
      </div>
      {/* Kiểu toast + thời gian — CHỈ có ý nghĩa khi thông báo tin nhắn đang BẬT. */}
      {settings.messagesEnabled && (
        <div className="space-y-3 py-3">
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm text-slate-700">Kiểu hiển thị</span>
              <span className="text-xs text-slate-400">Điện thoại luôn thả từ trên</span>
            </div>
            <div className="grid grid-cols-2 gap-1.5">
              {styleOptions.map((o) => (
                <button
                  key={o.value}
                  onClick={() => setToastStyle(o.value)}
                  aria-pressed={settings.toastStyle === o.value}
                  className={
                    'min-w-0 whitespace-nowrap rounded-full px-2 py-2 text-center text-xs font-bold ' +
                    (settings.toastStyle === o.value ? 'btn-primary text-white' : 'btn-soft')
                  }
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm text-slate-700">Thời gian hiển thị</span>
              <span className="text-xs text-slate-400">tự ẩn sau {settings.toastDurationSec}s</span>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {TOAST_DURATION_OPTIONS.map((sec) => (
                <button
                  key={sec}
                  onClick={() => setToastDurationSec(sec)}
                  aria-pressed={settings.toastDurationSec === sec}
                  className={
                    'min-w-0 whitespace-nowrap rounded-full px-2 py-2 text-center text-xs font-bold ' +
                    (settings.toastDurationSec === sec ? 'btn-primary text-white' : 'btn-soft')
                  }
                >
                  {sec}s
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsScreen({
  theme,
  onToggleTheme,
  onOpenMyQr,
  onOpenSecurity,
  onLogout,
  onOpenProfile,
  onOpenQrScan
}: {
  theme: 'light' | 'dark';
  onToggleTheme: () => void;
  onOpenMyQr?: () => void;
  onOpenSecurity?: () => void;
  onLogout?: () => void;
  onOpenProfile?: () => void;
  /** SIGMA (3/8) — mở màn quét mã đăng nhập cho máy khác (QrScannerScreen). */
  onOpenQrScan?: () => void;
}): JSX.Element {
  // SigMa (27/7, Admin Demo phát hiện qua test thật) — TRƯỚC ĐÂY thẻ hồ sơ đầu trang đọc thẳng CURRENT_AGENT
  // (mock cứng "Nguyễn Văn Long") — chính là màn Admin Demo báo "vào cài đặt lại luôn là hồ sơ của long.nguyễn"
  // dù đăng ký tài khoản khác. Sửa cùng cách ProfileScreen.tsx/MyQrScreen.tsx: gọi fetchAuthenticatedAgent()
  // thật, fallback getSession() nếu lỗi. Xem BUGS_FIXED.md B37.
  // PERF (15/8, Admin Demo "mở Cài đặt profile tên/user/avatar load chậm, giật mới hiện") — KHỞI TẠO ĐỒNG BỘ từ
  // /auth/me ĐÃ CACHE (getCachedAuthenticatedAgent — AppShell tải sẵn khi vào app, sống suốt phiên) → tên + username
  // + agentId có NGAY lúc mount ⇒ AgentAvatar render tức thời (persist-cache), KHÔNG chờ /auth/me rồi mới hiện.
  // Fallback getSession().agentName (localStorage, sống qua reload) cho tên khi cache in-memory nguội (mở app mới).
  const cachedMe = getCachedAuthenticatedAgent();
  const [meName, setMeName] = useState(getSession()?.agentName ?? cachedMe?.name ?? '');
  const [meUsername, setMeUsername] = useState<string | null>(cachedMe?.rcUsername ?? null);
  // Item 7 (6/8) — agentId CHÍNH MÌNH để tô màu fallback avatar theo avatarColorForAgent (CÙNG màu mọi người thấy).
  const [meAgentId, setMeAgentId] = useState<number | null>(cachedMe?.id ?? null);
  // PERF (15/8) — avatar hồ sơ mini nay render bằng <AgentAvatar> (persist-cache) theo meAgentId → KHÔNG còn tự
  // fetch/giữ meAvatarUrl+avatarResolved ở đây (bỏ để hết "load 1 lúc lâu" mỗi lần mở Cài đặt).
  useEffect(() => {
    fetchAuthenticatedAgent().then((res) => {
      if (res.ok) {
        setMeName(res.data.agent.name);
        setMeUsername(res.data.agent.rcUsername);
        setMeAgentId(res.data.agent.id); // AgentAvatar (persist-cache) tự tải + hiện avatar theo agentId (item 7 màu đồng nhất).
      }
    });
  }, []);

  const [fontLevel, setFontLevel] = useState<FontLevel>(() => currentFontLevel());
  // Mục 26 — tự động lưu ảnh (mock: bật sẵn).
  const [autoSave, setAutoSave] = useState(true);
  const [wifiOnly, setWifiOnly] = useState(true);

  // Mục 32 — Đồng bộ & Sao lưu (1/8, THẬT — thay mock cũ). "Đồng bộ đa thiết bị" ở trên vẫn LUÔN true (tin nhắn
  // đã lưu vĩnh viễn trên server, không có khái niệm mất/khôi phục — xem comment đầu drive-backup-service.ts).
  // "Sao lưu" ở đây là xuất lịch sử chat CỦA MÌNH ra 1 file JSON, đẩy lên Google Drive CÁ NHÂN — bản sao độc
  // lập ngoài app, KHÔNG phải disaster-recovery, nên KHÔNG có nút "Khôi phục ghi đè" (đã bỏ theo Admin Demo xác
  // nhận). "Tự động sao lưu hằng ngày" GIỮ NGUYÊN MOCK (chưa xây lịch chạy nền thật — ngoài phạm vi đợt này,
  // cần Scheduled Task riêng, LEAD quyết định đợt sau) nhưng khoá tương tác + đổi nhãn "(sắp có)" để KHÔNG gây
  // hiểu lầm là đã hoạt động thật.
  const [driveConnected, setDriveConnected] = useState(false);
  const [driveLastBackupAt, setDriveLastBackupAt] = useState<string | null>(null);
  const [driveStatusLoaded, setDriveStatusLoaded] = useState(false);
  const [driveConnecting, setDriveConnecting] = useState(false);
  const [driveBackingUp, setDriveBackingUp] = useState(false);
  const [autoBackup] = useState(false); // mock, khoá cứng — xem comment trên.
  // "Trò chuyện đã ẩn" (7/8) — đưa VÀO khu "Quyền riêng tư" có sẵn (Mục 34), KHÔNG hiện phẳng (Admin Demo).
  const [hiddenChatsOpen, setHiddenChatsOpen] = useState(false);
  const [backupToast, setBackupToast] = useState('');
  // Mục 34 — danh sách chặn THẬT (FIX-DEMOCK 4/8): trước đây dùng BLOCKED_USERS (mock-data/friends.ts) — 2 người
  // BỊA "Trương Quốc Bảo"/"Lý Thanh Sơn", nút "Bỏ chặn" chỉ xóa khỏi mảng cục bộ, KHÔNG gọi backend. Nay nối
  // API thật: GET /v1/me/friends (listMyFriends) → lọc `blockedByMe`, "Bỏ chặn" gọi POST /v1/me/friends/:id/unblock
  // (unblockFriend) rồi refetch. Danh sách rỗng khi chưa chặn ai (KHÔNG hiện người giả).
  const [blocked, setBlocked] = useState<FriendListItem[]>([]);
  const [blockedLoading, setBlockedLoading] = useState(true);
  const [blockedError, setBlockedError] = useState('');
  const [unblockingId, setUnblockingId] = useState<number | null>(null);
  const [blockedOpen, setBlockedOpen] = useState(false);

  async function loadBlocked(): Promise<void> {
    setBlockedLoading(true);
    setBlockedError('');
    const r = await listMyFriends();
    if (r.ok) {
      setBlocked(r.data.friends.filter((f) => f.blockedByMe));
    } else {
      setBlockedError(r.message);
      setBlocked([]);
    }
    setBlockedLoading(false);
  }

  useEffect(() => {
    void loadBlocked();
  }, []);

  async function handleUnblock(friendAgentId: number): Promise<void> {
    setUnblockingId(friendAgentId);
    const r = await unblockFriend(friendAgentId);
    if (r.ok) {
      setBlocked((prev) => prev.filter((x) => x.agentId !== friendAgentId));
    } else {
      setBlockedError(r.message);
    }
    setUnblockingId(null);
  }
  // Mục 35 — đăng xuất.
  const [confirmLogout, setConfirmLogout] = useState(false);

  // SigMa PC — mục "Cập nhật phần mềm" (CHỈ hiện trong vỏ EXE). Phiên bản hiện tại + nút kiểm tra cập nhật.
  // Có bản mới → UpdateBanner (main.tsx) tự hiện qua onUpdateAvailable; không có → dòng "đang dùng bản mới nhất".
  const isPc = isSigMaPc();
  const [pcVersion, setPcVersion] = useState('');
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [updateCheckMsg, setUpdateCheckMsg] = useState('');

  useEffect(() => {
    const api = pcUpdateBridge();
    if (!api) return;
    api.appGetVersion().then((v) => setPcVersion(String(v ?? ''))).catch(() => setPcVersion(''));
  }, []);

  async function handleCheckUpdate(): Promise<void> {
    const api = pcUpdateBridge();
    if (!api) return;
    setCheckingUpdate(true);
    setUpdateCheckMsg('');
    try {
      await api.checkUpdate();
      // Sau khi feed trả về: có bản mới → main đã bắn 'update-available' (banner tự hiện), lastAvailable != null.
      const latest = await api.getLastAvailableUpdate();
      if (latest && latest.version) {
        // Banner góc dưới-phải tự hiện — không lặp lại thông báo ở đây.
        setUpdateCheckMsg('');
      } else {
        setUpdateCheckMsg('Bạn đang dùng bản mới nhất.');
      }
    } catch {
      setUpdateCheckMsg('Không kiểm tra được cập nhật. Vui lòng thử lại.');
    } finally {
      setCheckingUpdate(false);
    }
  }

  // Nhãn nền tảng cho "Tự động lưu ảnh": APK (điện thoại) vs web/exe (máy tính). Capacitor native = điện thoại;
  // còn lại (trình duyệt web hoặc vỏ EXE Electron) lưu vào THƯ MỤC TRÊN MÁY TÍNH — KHÔNG ghi "áp dụng trên điện thoại".
  const isPhone = Capacitor.isNativePlatform();

  useEffect(() => {
    getGoogleDriveBackupStatus().then((res) => {
      if (res.ok) {
        setDriveConnected(res.data.connected);
        setDriveLastBackupAt(res.data.lastBackupAt);
      }
      setDriveStatusLoaded(true);
    });
  }, []);

  function showBackupToast(message: string): void {
    setBackupToast(message);
    setTimeout(() => setBackupToast(''), 3000);
  }

  function formatVnDateTime(iso: string): string {
    const d = new Date(iso);
    return (
      `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()} ` +
      `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
    );
  }

  /** Mở popup Google (lib/google-drive-backup.ts) → gửi code lên bot-api đổi lấy refresh_token thật. Người
   * dùng tự đóng popup (`canceled:true`) → im lặng, KHÔNG hiện toast lỗi (CÙNG quy ước LoginScreen.tsx với
   * nativeGoogleSignIn()). */
  async function connectDrive(): Promise<void> {
    setDriveConnecting(true);
    const outcome = await requestDriveBackupAuthorizationCode();
    if (!outcome.ok) {
      setDriveConnecting(false);
      if (!outcome.canceled) showBackupToast(outcome.message || 'Kết nối Google Drive thất bại.');
      return;
    }
    const res = await connectGoogleDriveBackup(outcome.code);
    setDriveConnecting(false);
    if (!res.ok) {
      showBackupToast(res.message || 'Kết nối Google Drive thất bại.');
      return;
    }
    setDriveConnected(true);
    showBackupToast('Đã kết nối Google Drive.');
  }

  /** Chạy 1 lượt sao lưu THẬT — build JSON lịch sử chat + upload Google Drive (POST /v1/me/drive-backup/run). */
  async function backupNow(): Promise<void> {
    setDriveBackingUp(true);
    const res = await runGoogleDriveBackupNow();
    setDriveBackingUp(false);
    if (!res.ok) {
      showBackupToast(res.message || 'Sao lưu thất bại, vui lòng thử lại.');
      return;
    }
    setDriveLastBackupAt(res.data.uploadedAt);
    showBackupToast('Đã sao lưu xong lên Google Drive.');
  }

  function pickFont(level: FontLevel): void {
    setFontLevel(level);
    applyFontLevel(level); // wire THẬT: đổi root font-size → cả app đổi ngay.
  }

  return (
    // B41 (27/7, Admin Demo báo "Cài đặt cũng bị che") — CÙNG gốc Sidebar.tsx/MessageComposer.tsx: màn cuộn dài,
    // nút "Đăng xuất" gần cuối danh sách chạm mép dưới màn hình thật, thiếu safe-area đáy.
    // 7/8 (Admin Demo — Cài đặt tràn/cuộn ngang trên Fold cover): overflow-y-auto (KHÔNG cuộn NGANG).
    <div className="h-full overflow-y-auto overflow-x-hidden bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <h1 className="mb-4 text-base font-bold text-slate-800">Cài đặt</h1>

      {/* Mục 39 — block hồ sơ bấm được → màn "Hồ sơ của tôi". */}
      <button
        onClick={onOpenProfile}
        className="mb-6 flex w-full items-center gap-4 rounded-lg-mac border border-line p-4 text-left transition hover:bg-appbg"
      >
        {/* avatar shrink-0 để không bị ép méo; cụm tên min-w-0+truncate để tên dài không đẩy tràn (Fold cover). */}
        {/* PERF (15/8, Admin Demo "mở Cài đặt avatar load 1 lúc lâu") — dùng AgentAvatar (persist-cache sessionStorage,
            CÙNG danh bạ/chat) → avatar HIỆN NGAY khi mở lại Cài đặt/reload, KHÔNG tải lại mỗi lần (trước đây tự
            fetchAttachmentObjectUrl KHÔNG persist → chờ mạng mỗi lần). meAgentId chưa có → skeleton trung tính. */}
        {meAgentId != null ? (
          <AgentAvatar agentId={meAgentId} name={meName} size={56} className="shrink-0 ring-2 ring-brand/20" textClassName="text-lg" title={meName} />
        ) : (
          <div className="h-14 w-14 shrink-0 animate-pulse rounded-full bg-slate-200 ring-2 ring-brand/20" />
        )}
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-slate-800">{meName}</div>
          {meUsername && <div className="truncate text-xs text-slate-500">@{meUsername}</div>}
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-slate-300" />
      </button>

      {/* Mục 24 — Mã QR của tôi + Mục 25 — Tài khoản & bảo mật (điều hướng màn riêng). */}
      <div className="mb-6 divide-y divide-line rounded-lg-mac border border-line">
        <button onClick={onOpenMyQr} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-appbg">
          <QrCode className="h-4 w-4 text-brand" />
          <span className="flex-1 text-sm text-slate-700">Mã QR của tôi</span>
          <ChevronRight className="h-4 w-4 text-slate-300" />
        </button>
        <button onClick={onOpenSecurity} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-appbg">
          <ShieldCheck className="h-4 w-4 text-brand" />
          <span className="flex-1 text-sm text-slate-700">Tài khoản & bảo mật</span>
          <ChevronRight className="h-4 w-4 text-slate-300" />
        </button>
        {/* SIGMA (3/8) — quét mã QR để đăng nhập máy tính khác (dùng điện thoại đã đăng nhập). */}
        <button onClick={onOpenQrScan} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-appbg">
          <ScanLine className="h-4 w-4 text-brand" />
          <span className="flex-1 text-sm text-slate-700">Quét mã đăng nhập</span>
          <ChevronRight className="h-4 w-4 text-slate-300" />
        </button>
      </div>

      <div className="mb-6 flex items-center justify-between rounded-lg-mac border border-line px-4 py-3">
        <span className="text-sm text-slate-700">Giao diện</span>
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
      </div>

      {/* Mục 22 — cỡ chữ toàn app (segmented control 4 mức, wire thật qua root font-size). */}
      <div className="mb-6 rounded-lg-mac border border-line px-4 py-3">
        <div className="mb-2.5 flex items-center justify-between">
          <span className="text-sm text-slate-700">Cỡ chữ</span>
          <span className="text-xs text-slate-400">áp dụng toàn ứng dụng ngay</span>
        </div>
        {/* 5/8 (Admin Demo "nhỏ vừa lớn rất lớn cài đặt vẫn cũ") — segmented ĐỒNG NHẤT hệ nút: mức đang chọn =
            .btn-primary (pill cyan glass), các mức còn lại = .btn-soft (pill nhạt) — CÙNG cao/bo/độ đậm với
            mọi <Button> khác, thay khối `bg-brand/15` phẳng cũ. */}
        {/* 5/8 (Admin Demo — Samsung Fold gập ~320-360px: nút "Rất lớn" wrap xuống 2 dòng lệch xấu). Cho 4 nút co
            nhỏ ĐỀU: min-w-0 (cho ô lưới co dưới bề rộng nội dung), whitespace-nowrap + text-[clamp] (thu nhỏ cỡ
            chữ theo bề rộng, LUÔN 1 dòng), px co nhẹ. KHÔNG đụng phần khác của SettingsScreen. */}
        <div className="grid grid-cols-4 gap-1.5">
          {FONT_LEVELS.map((f) => (
            <button
              key={f.level}
              onClick={() => pickFont(f.level)}
              aria-pressed={fontLevel === f.level}
              className={
                'min-w-0 whitespace-nowrap rounded-full px-1 py-2 text-center font-bold text-[clamp(0.7rem,2.7vw,0.875rem)] ' +
                (fontLevel === f.level ? 'btn-primary text-white' : 'btn-soft')
              }
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Cập nhật phần mềm — CHỈ hiện trong vỏ EXE (SigMa PC). Web/APK KHÔNG có mục này. */}
      {isPc && (
        <div className="mb-6 rounded-lg-mac border border-line px-4 py-3">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
            <RefreshCw className="h-4 w-4 text-brand" /> Cập nhật phần mềm
          </h2>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm text-slate-700">
              Phiên bản hiện tại: <b>{pcVersion ? `v${pcVersion}` : '—'}</b>
            </div>
            <Button
              variant="soft"
              icon={<RefreshCw className={`h-4 w-4 ${checkingUpdate ? 'animate-spin' : ''}`} />}
              onClick={() => void handleCheckUpdate()}
              disabled={checkingUpdate}
            >
              {checkingUpdate ? 'Đang kiểm tra…' : 'Kiểm tra cập nhật'}
            </Button>
          </div>
          {updateCheckMsg && <div className="mt-2 text-xs text-slate-500">{updateCheckMsg}</div>}
        </div>
      )}

      {/* Mục 26 — tự động lưu ảnh (như Zalo). */}
      <div className="mb-6 rounded-lg-mac border border-line px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3 text-sm text-slate-700">
            <ImageDown className="h-4 w-4 text-brand" />
            Tự động lưu ảnh về máy
          </div>
          <Toggle on={autoSave} onChange={setAutoSave} />
        </div>
        {autoSave && (
          <div className="mt-3 space-y-3 border-t border-line pt-3">
            <div className="flex items-center justify-between pl-7">
              <div>
                <div className="text-sm text-slate-700">Chỉ tải qua Wi-Fi</div>
                {/* Nhãn ĐÚNG nền tảng: điện thoại (APK) vs máy tính (web/exe). */}
                <div className="text-xs text-slate-400">
                  {isPhone ? 'Áp dụng trên điện thoại' : 'Chỉ tải ảnh khi máy tính đang dùng mạng Wi-Fi'}
                </div>
              </div>
              <Toggle on={wifiOnly} onChange={setWifiOnly} />
            </div>
            <div className="flex min-w-0 items-center gap-2 pl-7">
              <div className="min-w-0 flex-1">
                {/* Web/exe lưu vào thư mục TRÊN MÁY TÍNH (không phải điện thoại). */}
                <div className="mb-1 text-sm text-slate-700">
                  {isPhone ? 'Thư mục lưu trên điện thoại' : 'Thư mục Tải xuống trên máy tính'}
                </div>
                {/* 7/8 (Admin Demo "tràn Cài đặt") — min-w-0 cho ô đường dẫn (flex item mặc định min-width:auto = min-content
                    của đường dẫn font-mono → KHÔNG co được → tràn 375px trên Fold 344). min-w-0 → truncate hoạt động.
                    Nút "Đổi" shrink-0 để không bị bóp méo. */}
                <div className="flex min-w-0 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate rounded-md border border-line bg-appbg px-3 py-2 font-mono text-xs text-slate-600">
                    {isPhone ? 'Bộ nhớ trong/SigMa/Ảnh' : 'Thư mục Tải xuống\\SigMa'}
                  </span>
                  <button className="flex shrink-0 items-center gap-1 rounded-md border border-line px-2.5 py-2 text-xs text-slate-600 hover:bg-appbg">
                    <FolderOpen className="h-3.5 w-3.5" /> Đổi
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Mục 32 — Đồng bộ & Sao lưu (1/8, THẬT — kết nối Google Drive cá nhân). */}
      <div className="mb-6 rounded-lg-mac border border-line px-4 py-3">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
          <CloudUpload className="h-4 w-4 text-brand" /> Đồng bộ & Sao lưu
        </h2>
        <div className="mb-3 flex items-center gap-2 rounded-lg bg-success/10 px-3 py-2.5">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-success" />
          <div>
            <div className="text-sm font-medium text-success">Đồng bộ đa thiết bị: Đang hoạt động</div>
            <div className="text-xs text-slate-500">Tin nhắn tự đồng bộ mọi thiết bị đăng nhập</div>
          </div>
        </div>

        {!driveConnected ? (
          <div className="mb-3">
            <div className="mb-2 text-xs text-slate-500">
              Chưa kết nối Google Drive — kết nối để sao lưu lịch sử chat của bạn ra Drive cá nhân (chỉ tạo được file mới, không đọc dữ liệu Drive khác của bạn).
            </div>
            <Button icon={<CloudUpload className="h-4 w-4" />} onClick={connectDrive} disabled={driveConnecting || !driveStatusLoaded}>
              {driveConnecting ? 'Đang kết nối…' : 'Kết nối Google Drive'}
            </Button>
          </div>
        ) : (
          <>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-sm text-slate-700">
                Sao lưu gần nhất: <b>{driveLastBackupAt ? formatVnDateTime(driveLastBackupAt) : 'Chưa sao lưu lần nào'}</b>
              </div>
              <Button icon={<RefreshCw className="h-4 w-4" />} onClick={backupNow} disabled={driveBackingUp}>
                {driveBackingUp ? 'Đang sao lưu…' : 'Sao lưu ngay'}
              </Button>
            </div>
            <div className="mb-3 text-xs text-slate-400">
              Xem file đã sao lưu trong Google Drive của bạn (thư mục gốc hoặc tìm "SigMa-backup").
            </div>
          </>
        )}

        <div className="flex items-center justify-between border-t border-line pt-3 opacity-50">
          <div>
            <div className="text-sm text-slate-700">Tự động sao lưu hằng ngày (sắp có)</div>
            <div className="text-xs text-slate-400">Chưa hoạt động — hiện chỉ sao lưu được bằng cách bấm "Sao lưu ngay"</div>
          </div>
          <div className="pointer-events-none">
            {/* nut-khong-lam-gi: chỉ HIỂN THỊ trạng thái sao lưu do máy chủ quyết định; cả khối đã chặn
                bấm bằng `pointer-events-none` nên không có chuyện người dùng bấm mà tưởng đổi được. */}
            <Toggle on={autoBackup} onChange={() => {}} />
          </div>
        </div>
      </div>

      {/* Mục 34 — Quyền riêng tư kết bạn (như Zalo). */}
      <div className="mb-6 rounded-lg-mac border border-line px-4 py-3">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700">
          <UserX className="h-4 w-4 text-brand" /> Quyền riêng tư
        </h2>
        <p className="mb-1 text-xs text-slate-400">Cho phép người lạ tìm thấy & kết bạn với tôi qua:</p>
        <div className="divide-y divide-line">
          <ToggleRow label="Qua số điện thoại" initial={true} />
          <ToggleRow label="Qua username" initial={true} />
          <ToggleRow label="Qua mã QR" initial={true} />
          <ToggleRow label="Qua nhóm chung" initial={true} />
          <ToggleRow label="Từ gợi ý tìm kiếm" initial={false} />
        </div>
        {/* Trò chuyện đã ẩn (7/8, Admin Demo) — trong khu Quyền riêng tư như Zalo (không hiện phẳng). Mở HiddenChatsModal. */}
        <button
          onClick={() => setHiddenChatsOpen(true)}
          className="mt-1 flex w-full items-center justify-between border-t border-line pt-3 text-left"
        >
          <span className="flex items-center gap-2 text-sm text-slate-700"><EyeOff className="h-4 w-4 text-slate-400" /> Trò chuyện đã ẩn</span>
          <ChevronRight className="h-4 w-4 text-slate-300" />
        </button>
        <button
          onClick={() => setBlockedOpen(true)}
          className="mt-2 flex w-full items-center justify-between border-t border-line pt-3 text-left"
        >
          <span className="text-sm text-slate-700">Danh sách chặn ({blocked.length}) <span className="text-xs text-slate-400">· tin nhắn &amp; cuộc gọi</span></span>
          <ChevronRight className="h-4 w-4 text-slate-300" />
        </button>
      </div>

      {/* Mục 35 — Cài đặt thông báo. */}
      <div className="mb-6 rounded-lg-mac border border-line px-4 py-3">
        <h2 className="mb-1 flex items-center gap-2 text-sm font-semibold text-slate-700">
          <Bell className="h-4 w-4 text-brand" /> Cài đặt thông báo
        </h2>
        <NotificationSettingsSection />
      </div>

      {/* Mục 35 — đăng xuất (ConfirmDialog → về Login). */}
      <Button variant="danger" icon={<LogOut className="h-4 w-4" />} className="mt-6 w-full" onClick={() => setConfirmLogout(true)}>
        Đăng xuất
      </Button>

      {backupToast && (
        <div className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 rounded-full bg-success px-4 py-2 text-sm font-medium text-white shadow-card">
          {backupToast}
        </div>
      )}

      {/* Mục 34 — modal danh sách chặn. */}
      {blockedOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-900/40 p-4" onClick={() => setBlockedOpen(false)}>
          <div className="w-full max-w-xs rounded-lg-mac border border-line bg-white shadow-card" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between border-b border-line px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-800">Danh sách chặn ({blocked.length})</h3>
              <button onClick={() => setBlockedOpen(false)} className="rounded p-1 text-slate-400 hover:text-slate-600">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="divide-y divide-line p-1">
              {blocked.map((b) => {
                const displayName = b.nickname?.trim() || b.agentName;
                return (
                  <div key={b.agentId} className="flex items-center gap-3 px-3 py-2.5">
                    <div
                      className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold text-white"
                      style={{ backgroundColor: avatarColorForAgent(b.agentId) }}
                    >
                      {displayName[0]}
                    </div>
                    <div className="flex-1">
                      <div className="text-sm font-medium text-slate-700">{displayName}</div>
                      {b.rcUsername && <div className="text-xs text-slate-400">@{b.rcUsername}</div>}
                    </div>
                    <button
                      onClick={() => void handleUnblock(b.agentId)}
                      disabled={unblockingId === b.agentId}
                      className="rounded-md border border-line px-2.5 py-1.5 text-xs text-slate-600 hover:bg-appbg disabled:opacity-50"
                    >
                      {unblockingId === b.agentId ? 'Đang bỏ…' : 'Bỏ chặn'}
                    </button>
                  </div>
                );
              })}
              {blockedLoading && <div className="p-4 text-center text-sm text-slate-400">Đang tải…</div>}
              {!blockedLoading && blockedError && <div className="p-4 text-center text-sm text-danger">{blockedError}</div>}
              {!blockedLoading && !blockedError && blocked.length === 0 && (
                <div className="p-4 text-center text-sm text-slate-400">Bạn chưa chặn ai.</div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Mục 35 — xác nhận đăng xuất. */}
      {confirmLogout && (
        <ConfirmDialog
          title="Đăng xuất"
          message="Bạn chắc chắn muốn đăng xuất khỏi SigMa trên thiết bị này?"
          confirmLabel="Đăng xuất"
          danger
          onCancel={() => setConfirmLogout(false)}
          onConfirm={() => {
            setConfirmLogout(false);
            onLogout?.();
          }}
        />
      )}

      {hiddenChatsOpen && <HiddenChatsModal onClose={() => setHiddenChatsOpen(false)} />}
    </div>
  );
}
