import { useEffect, useRef, useState, type JSX } from 'react';
import { Download, AlertTriangle, X, Loader2 } from 'lucide-react';
import { supportsApkUpdate, checkApkUpdate, installApkUpdate, type ApkUpdateInfo } from '../lib/apk-update';

// Việc #5 (6/8, Admin Demo "APK tự cập nhật trong app — ưu tiên tối cao"). Banner cập nhật RIÊNG cho nền APK — song
// song UpdateBanner.tsx (chỉ cho exe qua bridge SigMaPC). Web/exe → return null. Luồng: mở app kiểm bản mới
// (native, không CORS) → nếu có → "Có bản mới vX" + [Cập nhật ngay]/[Để sau] → tải (thanh %) → native bắn Intent
// cài (người dùng xác nhận). Lỗi UNKNOWN_SOURCES_BLOCKED → hướng dẫn bật "cài từ nguồn này" (native đã mở Settings).

type Phase = 'idle' | 'available' | 'downloading' | 'error';

export function ApkUpdateBanner(): JSX.Element | null {
  const [phase, setPhase] = useState<Phase>('idle');
  const [info, setInfo] = useState<ApkUpdateInfo | null>(null);
  const [percent, setPercent] = useState(0);
  const [errorMsg, setErrorMsg] = useState('');
  const [dismissed, setDismissed] = useState(false);
  const startedRef = useRef(false); // chống bấm cài nhiều lần.

  useEffect(() => {
    if (!supportsApkUpdate()) return;
    let alive = true;
    // Kiểm SAU khi app ổn định (không chặn khởi động). Im lặng nếu lỗi mạng (checkApkUpdate trả null).
    const t = setTimeout(() => {
      void checkApkUpdate().then((r) => {
        if (alive && r && r.available) { setInfo(r); setPhase('available'); }
      });
    }, 2500);
    return () => { alive = false; clearTimeout(t); };
  }, []);

  if (!supportsApkUpdate()) return null;
  if (dismissed || phase === 'idle' || !info) return null;

  const doInstall = async (): Promise<void> => {
    if (startedRef.current) return;
    startedRef.current = true;
    setPercent(0);
    setPhase('downloading');
    try {
      await installApkUpdate(info.url, (p) => setPercent(Math.max(0, Math.min(100, Math.round(p)))));
      // Thành công → Intent cài đã bật, hệ thống tiếp quản. Giữ nguyên trạng thái (app có thể bị thay thế).
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setErrorMsg(
        msg === 'UNKNOWN_SOURCES_BLOCKED'
          ? 'Hãy bật "Cài ứng dụng từ nguồn này" cho SigMa trong màn Cài đặt vừa mở, rồi bấm Cập nhật lại.'
          : msg
      );
      setPhase('error');
      startedRef.current = false;
    }
  };

  return (
    // Admin Demo 18/8 — TRƯỚC đây `bottom-4` KHÔNG trừ safe-area → banner đè lên thanh gesture/mép dưới điện thoại
    // (nút bị che). Trừ env(safe-area-inset-bottom) để LUÔN nằm trên vùng an toàn. + thu nhỏ ~10% (width/chữ/nút).
    <div
      className="pointer-events-none fixed right-3 z-[60] flex w-[21.5rem] max-w-[calc(100vw-1.5rem)] flex-col gap-2.5"
      style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.9rem)' }}
    >
      {phase === 'available' && (
        <div className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-brand/30 bg-white px-3.5 py-2.5 shadow-lg">
          <Download className="mt-0.5 h-5 w-5 shrink-0 text-brand" />
          <div className="flex-1">
            <p className="text-[13px] font-semibold text-slate-800">Có bản cập nhật mới</p>
            <p className="mt-0.5 text-[13px] text-slate-600">
              Bản <span className="font-semibold">v{info.versionName}</span> đã sẵn sàng. Cập nhật để nhận tính năng mới nhất.
            </p>
            {info.notes ? <p className="mt-1 text-[11px] text-slate-500">{info.notes}</p> : null}
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => void doInstall()}
                className="btn-primary inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold text-white"
              >
                <Download className="h-3 w-3" /> Cập nhật ngay
              </button>
              <button onClick={() => setDismissed(true)} className="btn-soft px-2.5 py-1 text-[11px]">
                Để sau
              </button>
            </div>
          </div>
        </div>
      )}

      {phase === 'downloading' && (
        <div className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-brand/30 bg-white px-3.5 py-2.5 shadow-lg">
          <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-brand" />
          <div className="flex-1">
            <p className="text-[13px] font-semibold text-slate-800">Đang tải bản cập nhật… {percent}%</p>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-appbg">
              <div className="h-full rounded-full bg-brand transition-all" style={{ width: `${percent}%` }} />
            </div>
          </div>
        </div>
      )}

      {phase === 'error' && (
        <div className="pointer-events-auto flex items-start gap-2.5 rounded-xl border border-danger/30 bg-white px-3.5 py-2.5 shadow-lg">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
          <div className="flex-1">
            <p className="text-[13px] font-semibold text-slate-800">Cập nhật thất bại</p>
            <p className="mt-0.5 text-[13px] text-slate-600">{errorMsg}</p>
            <button
              onClick={() => { setPhase('available'); setErrorMsg(''); }}
              className="btn-primary mt-2 inline-flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-semibold text-white"
            >
              Cập nhật lại
            </button>
          </div>
          <button onClick={() => setDismissed(true)} className="text-slate-400 transition hover:text-slate-600" title="Đóng">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
