// Modal 2 bước — bán TID, giống luồng /tid-bill cũ (bot-api) nhưng UI riêng cho SigMa.
// SIGMA Phase 3 (24/7) — nối THẬT vào bot-api qua RC-auth mới (`apps/bot-api/src/routes/me.ts`), thay
// mock `TIDS` + tính phí tay của Phase 0. Giữ NGUYÊN toàn bộ UI/bố cục/style Phase 0 đã duyệt (Admin Demo yêu
// cầu — xem kế hoạch mục D.3/C) — CHỈ đổi nguồn dữ liệu + hành động 3 bước:
//   Bước 1: GET /v1/me/tids (danh sách TID thật của đại lý đang đăng nhập) thay mock TIDS.
//   Bước 1→2: POST /v1/me/quote (báo giá thật) thay `amount*feePercent/100` tính tay — hiển thị ĐÚNG 2 nhãn
//     mục A0 kế hoạch: "Giá bán" = feeApplied, "Số tiền phải hoàn khách" = amountAfterFee.
//   Bước 2→3: POST /v1/me/lo (tạo Lô thật) rồi GET /v1/me/qr (QR thật, xử lý 501 QR_NOT_CONFIGURED_YET bằng
//     thông báo rõ ràng thay vì lỗi vỡ UI).
// `SellTidModalContent` tách riêng để GalleryPage nhúng preview vào DeviceFrame mà không bị Modal
// (createPortal fixed inset-0) thoát ra phủ toàn khung trình duyệt thật — trong Gallery (không có session RC
// thật) bước 1 sẽ tự hiện lỗi "Chưa đăng nhập" thay vì mock, đây là hành vi ĐÚNG (không giả lập dữ liệu giả).
import { useEffect, useMemo, useState, type JSX } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { Modal } from '../components/Modal';
import { Button } from '../components/Button';
import { BackButton } from '../components/BackButton';
import { DotsLoader } from '../components/DotsLoader';
import { Field, inputCls } from '../components/Field';
import {
  listMyTids,
  quoteMyRows,
  createMyLo,
  getMyQr,
  type MyTidRow,
  type MyQuoteResult,
  type MyLoResult,
  type MyQrData
} from '../lib/agent-api-client';

export function SellTidModalContent({ onClose }: { onClose: () => void }): JSX.Element {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [amounts, setAmounts] = useState<Record<number, string>>({});

  // Bước 1 — danh sách TID THẬT của đại lý đang đăng nhập (thay mock TIDS Phase 0).
  const [tids, setTids] = useState<MyTidRow[]>([]);
  const [loadingTids, setLoadingTids] = useState(true);
  const [loadTidsError, setLoadTidsError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoadingTids(true);
    setLoadTidsError(null);
    listMyTids().then((r) => {
      if (cancelled) return;
      if (!r.ok) setLoadTidsError(r.message);
      else setTids(r.data);
      setLoadingTids(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(
    () =>
      tids
        .map((t) => {
          const raw = amounts[t.id] ?? '';
          const amountBeforeFee = Number(raw.replace(/[.,\s]/g, '')) || 0;
          return { tid: t, amountBeforeFee };
        })
        .filter((l) => l.amountBeforeFee > 0),
    [tids, amounts]
  );

  // Bước 1→2 — báo giá THẬT (POST /v1/me/quote), thay tính tay amount*feePercent/100 của Phase 0.
  const [quoting, setQuoting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [quoteResults, setQuoteResults] = useState<MyQuoteResult[]>([]);

  async function handlePreview(): Promise<void> {
    setQuoting(true);
    setQuoteError(null);
    const r = await quoteMyRows(rows.map((l) => ({ tidId: l.tid.id, amountBeforeFee: l.amountBeforeFee })));
    setQuoting(false);
    if (!r.ok) {
      setQuoteError(r.message);
      return;
    }
    setQuoteResults(r.data);
    setStep(2);
  }

  const totalFeeApplied = quoteResults.reduce((s, r) => s + r.feeApplied, 0);
  const totalAmountAfterFee = quoteResults.reduce((s, r) => s + r.amountAfterFee, 0);

  // Bước 2→3 — tạo Lô THẬT (POST /v1/me/lo) rồi lấy QR THẬT (GET /v1/me/qr, xử lý 501 = chưa cấu hình).
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [loResult, setLoResult] = useState<MyLoResult | null>(null);
  const [qrData, setQrData] = useState<MyQrData | null>(null);
  const [qrNotConfigured, setQrNotConfigured] = useState(false);

  async function handleConfirm(): Promise<void> {
    setConfirming(true);
    setConfirmError(null);
    const r = await createMyLo(rows.map((l) => ({ tidId: l.tid.id, amountBeforeFee: l.amountBeforeFee })));
    if (!r.ok) {
      setConfirming(false);
      setConfirmError(r.message);
      return;
    }
    setLoResult(r.data);
    const qr = await getMyQr();
    setConfirming(false);
    if (qr.ok) {
      setQrData(qr.data);
    } else if (qr.error === 'QR_NOT_CONFIGURED_YET') {
      setQrNotConfigured(true);
    } else {
      // Lô đã tạo thật thành công — lỗi lấy QR KHÔNG được xóa mất kết quả đã có, chỉ báo riêng bên cạnh.
      setConfirmError(`Lấy QR lỗi: ${qr.message}`);
    }
    setStep(3);
  }

  return (
    <>
      {step === 1 && (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-slate-500">Bước 1/2 — Nhập số tiền theo từng TID cần bán.</p>
          {loadingTids && <p className="text-sm text-slate-400">Đang tải danh sách TID...</p>}
          {loadTidsError && <p className="text-sm text-danger">{loadTidsError}</p>}
          {!loadingTids && !loadTidsError && tids.length === 0 && (
            <p className="text-sm text-slate-400">Đại lý chưa có TID nào khả dụng để bán.</p>
          )}
          {tids.map((t) => (
            <Field key={t.id} label={`${t.tid}${t.hkdName ? ' · ' + t.hkdName : ''} · ${t.bankName ?? 'Chưa gán ngân hàng'}`}>
              <input
                value={amounts[t.id] ?? ''}
                onChange={(e) => setAmounts((prev) => ({ ...prev, [t.id]: e.target.value }))}
                placeholder="0"
                inputMode="numeric"
                className={inputCls + ' w-full'}
              />
            </Field>
          ))}
          {quoteError && <p className="text-sm text-danger">{quoteError}</p>}
          {/* Lane D vòng 2 (3/8) — chặn tường minh khi đại lý CHƯA CÓ TID nào khả dụng (`tids.length === 0`):
              trước đây chỉ dựa gián tiếp vào `rows.length === 0` (rows lọc amount>0), gộp chung 2 lý do "chưa
              có TID" và "chưa nhập tiền". Tách rõ để nút không bao giờ bấm được khi danh sách TID trống. */}
          <Button onClick={handlePreview} disabled={tids.length === 0 || rows.length === 0 || quoting} className="mt-2 w-full">
            {quoting ? (
              <>
                <DotsLoader size="sm" color="white" /> Đang báo giá...
              </>
            ) : (
              'Xem trước giá bán'
            )}
          </Button>
        </div>
      )}

      {step === 2 && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-slate-500">Bước 2/2 — Xem trước trước khi xác nhận.</p>
          <div className="divide-y divide-line rounded-md border border-line">
            {quoteResults.map((r) => (
              <div key={r.tidId} className="flex items-center justify-between px-3 py-2 text-sm">
                <span className="text-slate-600">{tids.find((t) => t.id === r.tidId)?.tid ?? `TID#${r.tidId}`}</span>
                <span className="text-slate-800">{r.amountBeforeFee.toLocaleString('vi-VN')} đ</span>
                <span className="text-slate-400">giá bán {r.feeApplied.toLocaleString('vi-VN')} đ</span>
              </div>
            ))}
          </div>
          {/* 2 nhãn ĐÚNG mục A0 kế hoạch — KHÔNG dùng "phí"/"tổng cộng" mơ hồ như bản demo Phase 0 cũ. */}
          <div className="flex items-center justify-between rounded-md bg-brand-tint px-3 py-2.5 text-sm font-semibold text-brand">
            <span>Số tiền phải hoàn khách</span>
            <span>{totalAmountAfterFee.toLocaleString('vi-VN')} đ</span>
          </div>
          <div className="flex items-center justify-between px-3 text-xs text-slate-500">
            <span>Giá bán (tổng phí áp dụng)</span>
            <span>{totalFeeApplied.toLocaleString('vi-VN')} đ</span>
          </div>
          {confirmError && <p className="text-sm text-danger">{confirmError}</p>}
          <div className="flex gap-2">
            <BackButton className="flex-1" label="Sửa lại" onClick={() => setStep(1)} />
            <Button onClick={handleConfirm} disabled={confirming} className="flex-1">
              {confirming ? 'Đang xác nhận...' : 'Xác nhận bán'}
            </Button>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          {loResult ? (
            <>
              <CheckCircle2 className="h-12 w-12 text-success" />
              <h3 className="text-base font-semibold text-slate-800">Đã tạo Lô #{loResult.id}</h3>
              <p className="text-sm text-slate-500">
                Số tiền phải hoàn khách: {totalAmountAfterFee.toLocaleString('vi-VN')} đ trên {loResult.rows.length} TID.
              </p>
              {qrData && (
                <img
                  src={`data:${qrData.mime};base64,${qrData.imageBase64}`}
                  alt="QR nhận tiền"
                  className="h-40 w-40 rounded-md border border-line"
                />
              )}
              {qrNotConfigured && (
                <p className="text-xs text-warning">Đại lý chưa cấu hình QR nhận tiền — liên hệ quản trị để cấu hình.</p>
              )}
              {confirmError && <p className="text-xs text-danger">{confirmError}</p>}
            </>
          ) : (
            <p className="text-sm text-danger">{confirmError ?? 'Không tạo được Lô.'}</p>
          )}
          <Button onClick={onClose}>Đóng</Button>
        </div>
      )}
    </>
  );
}

export function SellTidModal({ onClose }: { onClose: () => void }): JSX.Element {
  return (
    <Modal title="Bán TID" onClose={onClose} width="max-w-lg">
      <SellTidModalContent onClose={onClose} />
    </Modal>
  );
}
