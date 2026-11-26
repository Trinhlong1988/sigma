// SIGMA (3/8) — Màn "Quét mã đăng nhập" phía ĐIỆN THOẠI (app di động đã đăng nhập). Quét QR bằng camera
// thật qua `@capacitor-mlkit/barcode-scanning` (ĐÃ có sẵn trong web-demo — CÙNG plugin MyQrScreen.tsx; chạy
// được trên APK ĐÃ REBUILD, KHÔNG chạy trên trình duyệt thường). Luồng:
//   1. Quét QR → validate ĐÚNG định dạng `sigma-login:v1:<token>` (parseQrPayload) — từ chối mọi QR khác
//      (chống QR độc).
//   2. GET /v1/auth/qr/info → hiện màn XÁC NHẬN: IP + vị trí gần đúng + thiết bị (user-agent) + thời gian của
//      bên yêu cầu + CẢNH BÁO TO "Chỉ đồng ý nếu CHÍNH BẠN đang đăng nhập máy này" + nút Từ chối.
//   3. Bắt người dùng GÕ LẠI mã 2 chữ số đang hiện trên PC (info KHÔNG trả mã) → POST /v1/auth/qr/approve
//      {token, code}. Sai mã → báo còn mấy lần; sai 3 lần → challenge bị hủy (server), phải làm mới trên PC.
//
// LƯU Ý REBUILD APK: plugin camera là native — thay đổi ở màn này cần `npx cap sync android` + build lại APK
// mới quét được trên máy thật (giống MyQrScreen). Trên trình duyệt/dev, hiện thông báo rõ thay vì giả vờ chạy.
import { useEffect, useState, type JSX } from 'react';
import { ScanLine, ShieldAlert, X } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { BarcodeScanner } from '@capacitor-mlkit/barcode-scanning';
import { Button } from '../components/Button';
import { BackButton } from '../components/BackButton';
import { DotsLoader } from '../components/DotsLoader';
import { qrInfo, qrApprove, parseQrPayload, type QrRequesterInfo } from '../lib/qr-login-api';

type Phase =
  | { kind: 'idle' }
  | { kind: 'scanning' }
  | { kind: 'loadingInfo'; token: string }
  | { kind: 'confirm'; token: string; info: QrRequesterInfo }
  | { kind: 'approving'; token: string; info: QrRequesterInfo }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('vi-VN');
}

export function QrScannerScreen({ onBack }: { onBack: () => void }): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');

  async function startScan(): Promise<void> {
    setCodeError('');
    if (!Capacitor.isNativePlatform()) {
      setPhase({ kind: 'error', message: 'Quét QR bằng camera chỉ dùng được trên app di động SigMa (đã cài từ APK), chưa hỗ trợ trên trình duyệt.' });
      return;
    }
    setPhase({ kind: 'scanning' });
    try {
      const perm = await BarcodeScanner.checkPermissions();
      if (perm.camera !== 'granted') {
        const req = await BarcodeScanner.requestPermissions();
        if (req.camera !== 'granted') {
          setPhase({ kind: 'error', message: 'Chưa được cấp quyền Camera — vào Cài đặt máy để cấp quyền cho SigMa.' });
          return;
        }
      }
      const result = await BarcodeScanner.scan();
      const raw = result.barcodes[0]?.rawValue;
      if (!raw) {
        setPhase({ kind: 'idle' });
        return;
      }
      const token = parseQrPayload(raw);
      if (!token) {
        // Chống QR độc — từ chối mọi mã không đúng định dạng đăng nhập SigMa.
        setPhase({ kind: 'error', message: 'Mã QR này không phải mã đăng nhập SigMa. Vui lòng quét đúng mã hiện trên màn hình đăng nhập.' });
        return;
      }
      await loadInfo(token);
    } catch (err) {
      setPhase({ kind: 'error', message: 'Không mở được camera: ' + (err instanceof Error ? err.message : String(err)) });
    }
  }

  async function loadInfo(token: string): Promise<void> {
    setPhase({ kind: 'loadingInfo', token });
    const res = await qrInfo(token);
    if (!res.ok) {
      setPhase({ kind: 'error', message: res.message });
      return;
    }
    setCode('');
    setCodeError('');
    setPhase({ kind: 'confirm', token, info: res.data });
  }

  async function submitApprove(): Promise<void> {
    if (phase.kind !== 'confirm') return;
    if (!/^\d{2}$/.test(code)) {
      setCodeError('Nhập đúng 2 chữ số hiện trên máy tính.');
      return;
    }
    setCodeError('');
    const token = phase.token;
    const info = phase.info;
    setPhase({ kind: 'approving', token, info });
    const res = await qrApprove(token, code);
    if (res.ok) {
      setPhase({ kind: 'done' });
      return;
    }
    // Sai mã → quay lại màn xác nhận, hiện lỗi + số lần còn lại nếu có.
    if (res.error === 'QR_WRONG_CODE') {
      setPhase({ kind: 'confirm', token, info });
      setCodeError(res.message);
      return;
    }
    // CANCELLED/EXPIRED/NOT_FOUND → không thể tiếp tục với mã này, buộc làm mới trên PC.
    setPhase({ kind: 'error', message: res.message });
  }

  return (
    <div className="flex h-full w-full flex-col overflow-y-auto bg-appbg p-6 pt-[calc(env(safe-area-inset-top)+1.5rem)]">
      <BackButton className="mb-3 self-start" onClick={onBack} />
      <h1 className="mb-4 text-base font-bold text-slate-800">Quét mã để đăng nhập máy khác</h1>

      {(phase.kind === 'idle' || phase.kind === 'scanning') && (
        <div className="flex flex-1 flex-col items-center justify-center gap-4">
          <p className="max-w-xs text-center text-sm text-slate-500">
            Trên máy tính, mở màn "Đăng nhập bằng QR" rồi bấm nút dưới để quét mã.
          </p>
          <Button icon={<ScanLine className="h-4 w-4" />} onClick={() => void startScan()} disabled={phase.kind === 'scanning'} className="w-full max-w-xs">
            {phase.kind === 'scanning' ? 'Đang mở camera...' : 'Bắt đầu quét'}
          </Button>
        </div>
      )}

      {phase.kind === 'loadingInfo' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <DotsLoader size="lg" />
          <p className="text-sm text-slate-500">Đang kiểm tra yêu cầu đăng nhập...</p>
        </div>
      )}

      {(phase.kind === 'confirm' || phase.kind === 'approving') && (
        <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
          {/* CẢNH BÁO TO — chống QRLJacking (không diệt tuyệt đối, giảm bằng cảnh báo rõ). */}
          <div className="flex items-start gap-2 rounded-lg border-2 border-danger/40 bg-danger/5 p-3" data-testid="qr-scan-warning">
            <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-danger" />
            <p className="text-sm font-semibold text-danger">
              Chỉ đồng ý nếu CHÍNH BẠN đang đăng nhập máy tính này. Nếu ai đó nhờ bạn quét mã hộ — hãy TỪ CHỐI.
            </p>
          </div>

          <div className="rounded-lg border border-line bg-white p-3 text-sm">
            <div className="mb-2 font-semibold text-slate-700">Thông tin máy đang yêu cầu đăng nhập</div>
            <dl className="space-y-1.5 text-slate-600">
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Địa chỉ IP</dt>
                <dd className="text-right font-medium">{phase.info.requesterIp ?? 'Không rõ'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Vị trí (gần đúng)</dt>
                <dd className="text-right font-medium">{phase.info.approxLocation}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="shrink-0 text-slate-400">Thiết bị</dt>
                <dd className="break-all text-right font-medium">{phase.info.requesterUa ?? 'Không rõ'}</dd>
              </div>
              <div className="flex justify-between gap-3">
                <dt className="text-slate-400">Thời gian</dt>
                <dd className="text-right font-medium">{formatTime(phase.info.createdAt)}</dd>
              </div>
            </dl>
          </div>

          <div>
            <label className="mb-1 block text-sm font-medium text-slate-700">Nhập mã 2 chữ số đang hiện trên máy tính</label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 2))}
              inputMode="numeric"
              maxLength={2}
              placeholder="00"
              disabled={phase.kind === 'approving'}
              data-testid="qr-scan-code-input"
              className="h-14 w-full rounded-lg border border-line text-center text-2xl font-bold tracking-widest outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
            />
            {codeError && <p className="mt-1 text-xs text-danger">{codeError}</p>}
          </div>

          <div className="flex gap-2">
            <Button variant="neutral" icon={<X className="h-4 w-4" />} onClick={onBack} disabled={phase.kind === 'approving'} className="flex-1">
              Từ chối
            </Button>
            <Button onClick={() => void submitApprove()} disabled={phase.kind === 'approving'} className="flex-1">
              {phase.kind === 'approving' ? 'Đang xác nhận...' : 'Đồng ý đăng nhập'}
            </Button>
          </div>
        </div>
      )}

      {phase.kind === 'done' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-brand/10 text-3xl">✓</div>
          <p className="text-base font-semibold text-slate-800">Đã xác nhận đăng nhập</p>
          <p className="max-w-xs text-sm text-slate-500">Máy tính của bạn sẽ tự động đăng nhập trong giây lát.</p>
          <Button variant="soft" onClick={onBack} className="mt-2 w-full max-w-xs">Xong</Button>
        </div>
      )}

      {phase.kind === 'error' && (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
          <p className="max-w-xs text-sm text-danger">{phase.message}</p>
          <Button variant="soft" icon={<ScanLine className="h-4 w-4" />} onClick={() => setPhase({ kind: 'idle' })} className="w-full max-w-xs">
            Quét lại
          </Button>
        </div>
      )}
    </div>
  );
}
