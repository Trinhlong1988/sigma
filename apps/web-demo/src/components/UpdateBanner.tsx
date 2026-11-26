import { useEffect, useRef, useState, type JSX } from 'react';
import { Download, RefreshCw, CheckCircle2, AlertTriangle, X, Loader2 } from 'lucide-react';
import { isSigMaPc } from './PcTitleBar';

/** So sánh semver: true nếu `next` MỚI HƠN `cur` (0.4.7 > 0.4.6). Dùng CHẶN banner khi feed KHÔNG mới hơn bản
 * đang chạy — Admin Demo "cấm xuất hiện 2 lần nếu đã update": sau khi cập nhật xong, bản đang chạy = bản feed →
 * KHÔNG còn hiện "có bản mới" nữa (kể cả lastAvailable còn cache cũ trong tiến trình). */
function isNewerVersion(cur: string, next: string): boolean {
  const parse = (v: string): number[] => String(v).trim().replace(/^v/i, '').split(/[-+]/)[0].split('.').map((x) => { const n = parseInt(x, 10); return Number.isFinite(n) ? n : 0; });
  const a = parse(cur), b = parse(next), len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) { const x = a[i] ?? 0, y = b[i] ?? 0; if (y > x) return true; if (y < x) return false; }
  return false;
}

// SigMa PC (Electron) — Banner cập nhật tích hợp (điều phối luồng 6 bước Admin Demo chốt).
// KHÁC SigMa Quản Lý (window.api.*): SigMa dùng bridge window.SigMaPC.* (preload sigma-pc).
// - CHỈ render khi chạy trong vỏ EXE (isSigMaPc()). Web/APK → return null (KHÔNG có object SigMaPC).
// - "có bản mới vX" + [Cập nhật ngay]/[Để sau]  → thanh % khi tải
// - tải xong → modal cảnh báo "lưu công việc" → cài + tự mở lại
// - sau mở lại: PULL bootResult → thông báo THÀNH CÔNG (version + ngày) hoặc THẤT BẠI + [Cập nhật lại]
// - listener cleanup lúc unmount.
// Class/màu BRAND: .btn-primary (cyan glass), .btn-soft (pill nhạt); token text-brand/success/danger.

// ── Kiểu dữ liệu bridge SigMaPC.* (shape khớp apps/sigma-pc/src/update-service.js) ──
type UpdateBootResult =
  | { kind: 'success'; version: string; at: string }
  | { kind: 'failed'; fromVersion: string; targetVersion: string };

interface SigMaPcUpdateApi {
  checkUpdate: () => Promise<unknown>;
  startUpdate: () => Promise<unknown>;
  installUpdateNow: () => Promise<unknown>;
  getUpdateBootResult: () => Promise<UpdateBootResult | null>;
  getLastAvailableUpdate: () => Promise<{ version: string } | null>;
  appGetVersion: () => Promise<string>;
  onUpdateAvailable: (cb: (p: { version: string }) => void) => () => void;
  onDownloadProgress: (cb: (p: { percent: number }) => void) => () => void;
  onUpdateDownloaded: (cb: (p: { version: string }) => void) => () => void;
  onUpdateError: (cb: (p: { message: string }) => void) => () => void;
}

function pcUpdateApi(): SigMaPcUpdateApi | undefined {
  return (window as unknown as { SigMaPC?: SigMaPcUpdateApi }).SigMaPC;
}

/** Định dạng ISO → "dd/mm/yyyy HH:mm" (chuẩn VN, không toLocaleString). */
function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

type Phase = 'idle' | 'available' | 'downloading' | 'error';

export function UpdateBanner(): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('idle');
  const [version, setVersion] = useState('');
  const [percent, setPercent] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [downloadedVersion, setDownloadedVersion] = useState<string | null>(null);
  const [boot, setBoot] = useState<UpdateBootResult | null>(null);
  const [bootDismissed, setBootDismissed] = useState(false);
  const [installing, setInstalling] = useState(false); // chống bấm cài nhiều lần (nhiều lần quit-and-install).
  // Bản đang chạy — dùng CHẶN banner khi feed không mới hơn (Admin Demo "cấm xuất hiện 2 lần nếu đã update").
  const curVerRef = useRef('');

  useEffect(() => {
    const api = pcUpdateApi();
    if (!api) return; // web/APK — không có bridge, không đăng ký gì.
    let alive = true;

    // Lấy bản đang chạy TRƯỚC (IPC nhanh ~ms) để guard isNewer cho pull/push bên dưới.
    api.appGetVersion().then((v) => { if (alive) curVerRef.current = v || ''; });

    // PULL kết quả cập nhật lần khởi động này (không nghe push — push rơi trước mount).
    api.getUpdateBootResult().then((r) => {
      if (!alive || !r) return;
      // #24 (Admin Demo 8/8) "cấm mở lại thông báo" — thông báo THÀNH CÔNG chỉ hiện MỘT LẦN cho mỗi bản: nhớ version
      // đã hiện vào localStorage, remount/reload KHÔNG hiện lại. (Thất bại thì KHÔNG chặn — cần anh thấy để bấm
      // "Cập nhật lại".)
      if (r.kind === 'success') {
        try {
          if (localStorage.getItem('sigma-update-boot-seen') === r.version) return;
          localStorage.setItem('sigma-update-boot-seen', r.version);
        } catch {
          /* localStorage chặn (chế độ riêng tư) — vẫn hiện, chấp nhận có thể hiện lại, không phá app */
        }
      }
      setBoot(r);
    });
    // PULL bản mới nhất đã biết — check() ở main chạy NGAY lúc app ready, có thể xong (network) trước khi
    // React kịp mount + đăng ký onUpdateAvailable → push rơi mất. Pull bù cho đúng race-class, không đợi push.
    // CHẶN: chỉ hiện nếu feed MỚI HƠN bản đang chạy (đã update xong → không hiện lại).
    api.getLastAvailableUpdate().then((p) => {
      if (alive && p && isNewerVersion(curVerRef.current, p.version)) {
        setVersion(p.version);
        setErrorMsg('');
        setPhase((cur) => (cur === 'idle' ? 'available' : cur));
      }
    });

    // Đăng ký sự kiện realtime — mỗi hàm trả về unsubscribe (cleanup lúc unmount).
    const offAvail = api.onUpdateAvailable((p) => {
      if (!isNewerVersion(curVerRef.current, p.version)) return; // không mới hơn → bỏ qua (chống hiện lại).
      setVersion(p.version);
      setErrorMsg('');
      setPhase('available');
    });
    const offProg = api.onDownloadProgress((p) => {
      setPercent(Math.max(0, Math.min(100, Math.round(p.percent))));
      setPhase('downloading');
    });
    const offDone = api.onUpdateDownloaded((p) => {
      setDownloadedVersion(p.version);
      setPhase('idle');
    });
    const offErr = api.onUpdateError((p) => {
      setErrorMsg(p.message);
      setPhase('error');
    });

    return () => {
      alive = false;
      offAvail();
      offProg();
      offDone();
      offErr();
    };
  }, []);

  // #24 (Admin Demo 8/8) — thông báo "Đã cập nhật thành công" chỉ hiện ~5s rồi TỰ ẨN (không treo, không phải tắt tay).
  // CHỈ auto-ẩn nhánh THÀNH CÔNG; nhánh THẤT BẠI giữ nguyên để anh thấy + bấm "Cập nhật lại".
  useEffect(() => {
    if (boot?.kind !== 'success' || bootDismissed) return;
    const t = setTimeout(() => setBootDismissed(true), 5000);
    return () => clearTimeout(t);
  }, [boot, bootDismissed]);

  // Web/APK → KHÔNG render gì (bảo vệ tầng render, ngoài cleanup useEffect ở trên).
  if (!isSigMaPc()) return null;

  const doStart = (): void => {
    setPercent(0);
    setPhase('downloading');
    void pcUpdateApi()?.startUpdate();
  };
  const doRetry = (): void => {
    setErrorMsg('');
    setPhase('idle');
    void pcUpdateApi()?.checkUpdate();
  };
  const doInstall = (): void => {
    if (installing) return; // chống bấm nhiều lần → nhiều lần quit-and-install.
    setInstalling(true);
    void pcUpdateApi()?.installUpdateNow();
  };

  // ── Modal "đã tải xong — cảnh báo lưu công việc" (no-data-loss) ──
  if (downloadedVersion !== null) {
    return (
      <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4">
        <div className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-2xl">
          <div className="flex items-center gap-3 bg-brand px-6 py-4 text-white">
            <Download className="h-6 w-6 shrink-0" />
            <h3 className="text-lg font-bold">Đã tải xong bản cập nhật</h3>
          </div>
          <div className="px-6 py-5">
            <p className="text-[15px] leading-relaxed text-slate-700">
              Bản cập nhật <span className="font-semibold">v{downloadedVersion}</span> đã sẵn sàng. Ứng dụng sẽ
              <span className="font-semibold"> đóng để cài đặt</span> rồi tự mở lại. Vui lòng
              <span className="font-semibold text-danger"> lưu công việc đang làm dở</span> trước khi tiếp tục.
            </p>
          </div>
          <div className="flex justify-end gap-2 border-t border-line px-6 py-4">
            <button onClick={() => setDownloadedVersion(null)} className="btn-soft px-4 py-2.5 text-sm">
              Để sau
            </button>
            <button
              onClick={doInstall}
              disabled={installing}
              className="btn-primary px-5 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
            >
              {installing ? 'Đang cài…' : 'Cài đặt & khởi động lại'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const showBoot = boot && !bootDismissed;
  const showFlow = phase !== 'idle';
  if (!showBoot && !showFlow) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-96 max-w-[calc(100vw-2rem)] flex-col gap-3">
      {/* Kết quả cập nhật lần khởi động — thành công */}
      {showBoot && boot.kind === 'success' && (
        <div className="pointer-events-auto flex items-start gap-3 rounded-xl border border-success/30 bg-white px-4 py-3 shadow-lg">
          <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-success" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-slate-800">Đã cập nhật thành công</p>
            <p className="mt-0.5 text-sm text-slate-600">
              Phiên bản <span className="font-semibold">v{boot.version}</span> — lúc {fmtDateTime(boot.at)}
            </p>
          </div>
          <button onClick={() => setBootDismissed(true)} className="text-slate-400 transition hover:text-slate-600" title="Đóng">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
      {/* Kết quả cập nhật lần khởi động — thất bại */}
      {showBoot && boot.kind === 'failed' && (
        <div className="pointer-events-auto flex items-start gap-3 rounded-xl border border-danger/30 bg-white px-4 py-3 shadow-lg">
          <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-danger" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-slate-800">Cập nhật thất bại</p>
            <p className="mt-0.5 text-sm text-slate-600">
              Chưa cài được bản <span className="font-semibold">v{boot.targetVersion}</span> — vẫn đang chạy v{boot.fromVersion}.
            </p>
            <button
              onClick={() => {
                setBootDismissed(true);
                void pcUpdateApi()?.checkUpdate();
              }}
              className="btn-primary mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Cập nhật lại
            </button>
          </div>
          <button onClick={() => setBootDismissed(true)} className="text-slate-400 transition hover:text-slate-600" title="Đóng">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Có bản mới */}
      {phase === 'available' && (
        <div className="pointer-events-auto flex items-start gap-3 rounded-xl border border-brand/30 bg-white px-4 py-3 shadow-lg">
          <Download className="mt-0.5 h-6 w-6 shrink-0 text-brand" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-slate-800">Có bản cập nhật mới</p>
            <p className="mt-0.5 text-sm text-slate-600">
              Hệ thống có bản <span className="font-semibold">v{version}</span>. Cập nhật để nhận tính năng mới nhất.
            </p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={doStart}
                className="btn-primary inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white"
              >
                <Download className="h-3.5 w-3.5" /> Cập nhật ngay
              </button>
              <button onClick={() => setPhase('idle')} className="btn-soft px-3 py-1.5 text-xs">
                Để sau
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Đang tải — thanh % */}
      {phase === 'downloading' && (
        <div className="pointer-events-auto flex items-start gap-3 rounded-xl border border-brand/30 bg-white px-4 py-3 shadow-lg">
          <Loader2 className="mt-0.5 h-6 w-6 shrink-0 animate-spin text-brand" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-slate-800">Đang tải bản cập nhật… {percent}%</p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-appbg">
              <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${percent}%` }} />
            </div>
          </div>
        </div>
      )}

      {/* Lỗi + [Cập nhật lại] */}
      {phase === 'error' && (
        <div className="pointer-events-auto flex items-start gap-3 rounded-xl border border-danger/30 bg-white px-4 py-3 shadow-lg">
          <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-danger" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-slate-800">Cập nhật thất bại</p>
            <p className="mt-0.5 text-sm text-slate-600">{errorMsg}</p>
            <button
              onClick={doRetry}
              className="btn-primary mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Cập nhật lại
            </button>
          </div>
          <button onClick={() => setPhase('idle')} className="text-slate-400 transition hover:text-slate-600" title="Đóng">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
