// SIGMA (2/8, tính năng "Hoàn tiền" MỚI, Admin Demo yêu cầu trực tiếp) — panel xác nhận HOÀN TIỀN cho 1 bill
// gốc (ảnh bill quẹt thẻ ĐÃ GỬI). Mở từ nút "Hoàn tiền" trong menu ngữ cảnh pill ChatBubble
// (ConversationScreen.tsx, gate `canOpenRefund()` — CÙNG khuôn "Sửa" B112, xem chat-client.ts).
//
// LUỒNG (đúng brief + các lần Admin Demo chốt bổ sung 2/8):
//   1. Mở panel → TỰ ĐỘNG mở picker chọn/chụp ẢNH BIÊN LAI CHUYỂN KHOẢN HOÀN TIỀN (KHÁC hẳn bill quẹt thẻ gốc —
//      dùng `pickImage()` MỚI, KHÔNG qua MessageComposer.tsx billDraft — panel này mở TRỰC TIẾP từ menu ngữ
//      cảnh, không đi qua composer). Hủy picker → đóng panel luôn (không có gì để hiện).
//   2. Gọi `previewRefundOcr()` (agent-api-client.ts, route MỚI `/v1/me/refund/ocr-preview`) kèm `originalTid`
//      (đọc từ `originalMessage.billMeta.billFields.tid?.value`) → đọc 5 trường + số tiền + đối chiếu Người
//      nhận (`recipientMatch`, server tự tra `ReceiveAccount` cấu hình cho TID).
//   3. Tính "số tiền phải hoàn" qua `useFeePreview()` (CÙNG hook B111/B112 đã có — TÁI DÙNG NGUYÊN, không tính
//      lại công thức phí) trên TID+amount của BILL GỐC (KHÔNG phải ảnh hoàn tiền).
//   4. Tải TỔNG đã hoàn CỘNG DỒN từ TRƯỚC (Admin Demo 2/8: "cho phép hoàn tiền NHIỀU LẦN cho 1 bill") qua
//      `getRefundAggregate()` — cộng thêm số tiền LẦN NÀY (đang xem trước, CHƯA lưu) để tính trạng thái tổng
//      SỐNG ĐỘNG ngay trong panel xem trước (Admin Demo 2/8: "cảnh báo phải hiện NGAY LÚC XEM TRƯỚC").
//   5. Hiện RÕ mọi cảnh báo (số tiền lệch theo 4 trạng thái Chưa hoàn/Hoàn thiếu/Hoàn đủ/Hoàn thừa + tài khoản/
//      tên người nhận không khớp) NGAY TRONG PANEL, KHÔNG chặn cứng — đại lý vẫn được xác nhận gửi dù có cảnh
//      báo (chỉ báo cho biết trước).
//   6. Xác nhận gửi → ghép ảnh (composeRefundImage(), bill-table-image.ts — LƯU LẠI VĨNH VIỄN mọi cảnh báo vào
//      ảnh, KHÔNG chỉ hiện thoáng qua, Admin Demo 2/8 chốt rõ) → upload → gửi 1 tin nhắn ẢNH MỚI với
//      `replyToMessageId = originalMessage.id` (CƠ CHẾ TRÍCH DẪN/quote-reply ĐÃ CÓ SẴN — Admin Demo 2/8: "PHẢI
//      dùng cơ chế này, KHÔNG tự thiết kế UI mới" — đây CHÍNH LÀ cách "đánh dấu" tin nào đã hoàn cho bill nào,
//      KHÔNG cần trường liên kết/tick riêng nào khác).
//
// QUYỀN (Admin Demo 2/8 chốt trực tiếp): xác nhận hoàn tiền = quyền Y HỆT gửi tin nhắn thường trong phòng (bất kỳ
// thành viên ACTIVE nào, kể cả phòng readOnly — "khách hàng không tự ý hoàn tiền được vì họ không phải member
// có quyền thao tác") — KHÔNG thêm gate nào ở panel này, `sendChatMessage()` tự enforce ĐÚNG NHƯ tin thường.
import { useEffect, useRef, useState, type JSX } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Modal } from './Modal';
import { Button } from './Button';
import { Field, inputCls } from './Field';
import { DotsLoader } from './DotsLoader';
import type { ChatMessage } from '../mock-data/types';
import { previewRefundOcr, getRefundAggregate, type RefundReceiptPreview } from '../lib/agent-api-client';
import { useFeePreview } from '../lib/use-fee-preview';
import { deriveOcrPreviewUiState, type OcrPreviewUiState } from '../lib/ocr-preview-ui';
import { parseGroupedMoneyValue, useGroupedMoneyField } from '../lib/grouped-money-input';
import { buildRefundFieldDisplayRows } from '../lib/ocr-bill-fields-display';
import { formatVndGrouped } from '../lib/bill-refund-text';
import { composeRefundImage, type RefundImageWarningInput } from '../lib/bill-table-image';
import { computeRefundAggregate, describeRefundAggregate, REFUND_STATUS_COLOR_CLASS, REFUND_STATUS_LABEL_VI } from '../lib/refund-bill-status';
import { buildRefundMetadataJson } from '../lib/refund-message-meta';
import { pickImage, PickImageCancelledError } from '../lib/pick-image';
import { uploadChatAttachment } from '../lib/rc-realtime';
import { attachRoomToChatAttachment } from '../lib/rc-realtime';
import { sendChatMessage } from '../lib/chat-client';

const RECIPIENT_MATCH_LABEL_VI: Record<RefundReceiptPreview['recipientMatch']['status'], string> = {
  matched: 'Tài khoản người nhận khớp dữ liệu đã cấu hình.',
  mismatched: '', // dùng message từ server (chi tiết hơn — nêu rõ tên/STK lệch)
  not_configured: 'TID này CHƯA cấu hình tài khoản nhận tiền — KHÔNG đối chiếu tự động được, tự kiểm tra thủ công.',
  no_tid: 'Không xác định được TID của bill gốc — KHÔNG đối chiếu tài khoản tự động được.',
  unread: 'Không đọc đủ tên/số tài khoản người nhận từ ảnh — tự đối chiếu bằng mắt.'
};

export function RefundBillModal({
  originalMessage,
  roomId,
  onClose
}: {
  /** Tin nhắn bill GỐC (ảnh bill quẹt thẻ đã gửi) — caller (ConversationScreen.tsx) ĐÃ gate
   * `canOpenRefund(originalMessage)===true` trước khi mở panel này. */
  originalMessage: ChatMessage;
  roomId: string;
  onClose: () => void;
}): JSX.Element {
  const billMeta = originalMessage.billMeta!; // caller đã gate.
  const originalTid = billMeta.billFields.tid?.value;

  const [pickState, setPickState] = useState<{ kind: 'picking' } | { kind: 'ready'; file: File; previewUrl: string } | { kind: 'cancelled' }>({ kind: 'picking' });
  const [ocrState, setOcrState] = useState<OcrPreviewUiState>({ kind: 'loading' });
  const [refundFields, setRefundFields] = useState<RefundReceiptPreview | null>(null);
  const amountField = useGroupedMoneyField('');
  const cancelledRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Cộng dồn TỪ TRƯỚC (Admin Demo: cho phép hoàn tiền nhiều lần) — tải khi mount (KHÔNG đợi OCR ảnh mới xong, số
  // liệu này ĐỘC LẬP với ảnh đang xem trước).
  const [priorConfirmedTotal, setPriorConfirmedTotal] = useState<number | null>(null);
  const [aggregateError, setAggregateError] = useState<string | null>(null);

  // Bước 1 — mở picker do NGƯỜI DÙNG BẤM NÚT (KHÔNG tự động lúc mount qua useEffect) — CÙNG convention đã có
  // sẵn toàn bộ MessageComposer.tsx (handleScanBillClick()/handleAttachImageClick() đều chạy TRỰC TIẾP từ
  // onClick, KHÔNG qua effect). Lý do đổi khỏi thiết kế "tự mở ngay lúc mount" ban đầu: `main.tsx` bọc App
  // trong `React.StrictMode` (bật thật, xem CLAUDE.md quy ước) — StrictMode CHẠY 2 LẦN mọi effect lúc mount ở
  // môi trường DEV (vô hại ở PRODUCTION build, nhưng lộ RÕ khi tự verify bằng Playwright dev server: BUG THẬT
  // tự phát hiện — 2 lần gọi `pickImage()` tạo 2 input file ẩn/2 lượt mở Camera CÙNG LÚC, gây nhầm lẫn). Nút
  // bấm tường minh vừa khớp convention toàn app, vừa loại bỏ hẳn rủi ro double-invoke này (click chỉ xảy ra 1
  // lần thật do người dùng, StrictMode không double-invoke event handler, chỉ double-invoke effect).
  async function handlePickImage(): Promise<void> {
    try {
      const file = await pickImage({ header: 'Chọn ảnh biên lai hoàn tiền', photo: 'Thư viện ảnh', picture: 'Chụp ảnh', cancel: 'Hủy' });
      setPickState({ kind: 'ready', file, previewUrl: URL.createObjectURL(file) });
    } catch (err) {
      if (err instanceof PickImageCancelledError) {
        onClose(); // hủy picker — không có gì để hiện, đóng panel luôn (CÙNG hành vi thiết kế ban đầu).
        return;
      }
      setSendError(err instanceof Error ? err.message : 'Không mở được camera/thư viện ảnh.');
    }
  }

  // Tự bấm hộ 1 LẦN DUY NHẤT ngay khi panel vừa mở — vẫn giữ ĐÚNG trải nghiệm "mở panel là thấy picker ngay"
  // như thiết kế ban đầu, nhưng qua 1 ref chặn double-invoke CỦA CHÍNH StrictMode (KHÔNG dùng lại useEffect
  // rỗng gọi thẳng pickImage() — vẫn sẽ double-invoke y hệt; ref sống sót qua cả 2 lần StrictMode mount/
  // unmount/remount vì KHÔNG bị reset giữa 2 lần đó, chỉ guard đúng 1 lần gọi thật).
  const autoPickedRef = useRef(false);
  useEffect(() => {
    if (autoPickedRef.current) return;
    autoPickedRef.current = true;
    void handlePickImage();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- chỉ chạy 1 lần lúc mount (qua ref guard), KHÔNG lặp lại theo re-render.
  }, []);

  // Dọn object URL cục bộ lúc unmount.
  useEffect(() => {
    return () => {
      if (pickState.kind === 'ready') URL.revokeObjectURL(pickState.previewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Bước 2 — OCR ảnh biên lai hoàn tiền NGAY khi có file.
  useEffect(() => {
    if (pickState.kind !== 'ready') return;
    cancelledRef.current = false;
    setOcrState({ kind: 'loading' });
    setRefundFields(null);
    amountField.setValue('');
    void previewRefundOcr(pickState.file, originalTid).then((r) => {
      if (cancelledRef.current) return;
      const state = deriveOcrPreviewUiState(r);
      setOcrState(state);
      setRefundFields(r.ok ? r.data : null);
      if (state.kind === 'autofilled') {
        amountField.setValue(String(state.parsedAmount));
      } else if (state.kind === 'needs_review' && state.suggestedAmount != null) {
        amountField.setValue(String(state.suggestedAmount));
      }
    });
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pickState.kind === 'ready' ? pickState.file : null]);

  // Bước 3 — số tiền PHẢI HOÀN (công thức phí đã có, tính trên TID+SỐ TIỀN của BILL GỐC — KHÔNG phải ảnh vừa chụp).
  // 20/8 — hook nay trả object `{ feePreview, previewAmount, pending }`. Ở đây số tiền đầu vào CỐ ĐỊNH
  // (billMeta.amount, KHÔNG do người dùng sửa) nên KHÔNG có đua tranh "đổi số tiền" như OcrBillPreview — chỉ
  // lấy `feePreview` để tính requiredAmount, giữ NGUYÊN hành vi cũ.
  const { feePreview } = useFeePreview(originalTid, billMeta.amount);
  const requiredAmount = feePreview?.resolved === true ? feePreview.amountAfterFee : billMeta.amount;

  // Bước 4 — tổng ĐÃ hoàn TỪ TRƯỚC (không tính lần đang xem trước).
  useEffect(() => {
    let cancelled = false;
    void getRefundAggregate(originalMessage.id, requiredAmount).then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        setAggregateError(r.message);
        setPriorConfirmedTotal(0); // vẫn cho tiếp tục, KHÔNG chặn luồng — coi như chưa biết gì thêm, hiển thị rõ lỗi riêng.
        return;
      }
      setPriorConfirmedTotal(r.data.aggregate.totalConfirmed);
    });
    return () => {
      cancelled = true;
    };
  }, [originalMessage.id, requiredAmount]);

  const parsedAmount = parseGroupedMoneyValue(amountField.value);
  const canSend = parsedAmount != null && parsedAmount > 0 && pickState.kind === 'ready' && priorConfirmedTotal != null && !sending;

  // Trạng thái CỘNG DỒN SỐNG — cộng thêm số tiền LẦN NÀY (Admin Demo: "cảnh báo phải hiện NGAY LÚC XEM TRƯỚC").
  const liveTotal = (priorConfirmedTotal ?? 0) + (parsedAmount ?? 0);
  const liveAggregate = computeRefundAggregate(requiredAmount, liveTotal);

  async function handleSend(): Promise<void> {
    if (pickState.kind !== 'ready' || parsedAmount == null || sending) return;
    setSending(true);
    setSendError(null);
    try {
      const thisTimeAmountText = `${formatVndGrouped(parsedAmount)}đ`;
      const progressText = `${formatVndGrouped(liveTotal)}đ/${formatVndGrouped(requiredAmount)}đ`;

      // Warnings LƯU LẠI VĨNH VIỄN vào ảnh (Admin Demo 2/8, fix bug "cảnh báo biến mất sau khi gửi", ÁP DỤNG ngay
      // từ lúc XÂY tính năng này chứ không phải vá sau — CÙNG fix đã áp cho bill gốc, xem OcrBillPreview.tsx).
      const warnings: RefundImageWarningInput[] = [];
      if (liveAggregate.status === 'over' || liveAggregate.status === 'partial') {
        warnings.push({ label: 'Cảnh báo số tiền', text: describeRefundAggregate(liveAggregate), severity: liveAggregate.status === 'over' ? 'danger' : 'warning' });
      }
      const recipientMatch = refundFields?.recipientMatch;
      if (recipientMatch && (recipientMatch.status === 'mismatched' || recipientMatch.status === 'not_configured' || recipientMatch.status === 'no_tid' || recipientMatch.status === 'unread')) {
        const msg = recipientMatch.status === 'mismatched' ? recipientMatch.message : RECIPIENT_MATCH_LABEL_VI[recipientMatch.status];
        warnings.push({ label: 'Cảnh báo người nhận', text: msg, severity: recipientMatch.status === 'mismatched' ? 'danger' : 'warning' });
      }

      const displayRows = refundFields ? buildRefundFieldDisplayRows(refundFields) : [];
      const composed = await composeRefundImage(pickState.file, displayRows, thisTimeAmountText, progressText, warnings);
      const fileName = `hoan-tien-${Date.now()}.jpg`;
      const file = new File([composed.blob], fileName, { type: 'image/jpeg' });

      const uploadRes = await uploadChatAttachment(file);
      if (!uploadRes.ok) {
        setSendError(uploadRes.message);
        return;
      }

      const metadataJson = buildRefundMetadataJson({
        refundFields: refundFields ?? ({ found: false, rawText: null, parsedAmount: null, needsManualReview: false, reasons: [], bankName: null, senderName: null, recipientName: null, recipientAccountNumber: null, dateTime: null, recipientMatch: { status: 'no_tid', configuredAccountName: null, configuredAccountNumber: null, message: '' } } as RefundReceiptPreview),
        amount: parsedAmount,
        imageHeightPx: composed.billImageHeightPx,
        amountStatusAtConfirm: liveAggregate.status,
        amountDiffAtConfirm: liveAggregate.diff,
        requiredAmountAtConfirm: requiredAmount,
        recipientMatchStatus: recipientMatch?.status ?? 'no_tid',
        recipientMatchMessage: recipientMatch ? (recipientMatch.status === 'mismatched' ? recipientMatch.message : RECIPIENT_MATCH_LABEL_VI[recipientMatch.status]) : ''
      });

      const caption = `Hoàn tiền ${thisTimeAmountText} — ${REFUND_STATUS_LABEL_VI[liveAggregate.status]}`;
      const res = await sendChatMessage(roomId, { kind: 'IMAGE', attachmentId: uploadRes.data.id, body: caption, metadataJson, replyToMessageId: originalMessage.id });
      if (!res.ok) {
        setSendError(res.message);
        return;
      }
      void attachRoomToChatAttachment(uploadRes.data.id, roomId);
      onClose();
    } finally {
      setSending(false);
    }
  }

  if (pickState.kind !== 'ready') {
    // 'picking' — đang chờ dialog chọn ảnh (tự bấm hộ 1 lần lúc mount, xem autoPickedRef) HOẶC lỗi thật (picker
    // không mở được) — hiện nút "Chọn ảnh" để người dùng tự thử lại thay vì kẹt màn hình chờ vô thời hạn.
    return (
      <Modal title="Hoàn tiền" onClose={onClose} width="max-w-sm">
        <div className="flex h-40 flex-col items-center justify-center gap-3">
          {sendError ? (
            <>
              <p className="text-xs text-danger">{sendError}</p>
              <Button type="button" variant="confirm" onClick={() => void handlePickImage()}>
                Chọn ảnh biên lai hoàn tiền
              </Button>
            </>
          ) : (
            <DotsLoader size="md" />
          )}
        </div>
      </Modal>
    );
  }

  const recipientMatch = refundFields?.recipientMatch;

  return (
    <Modal title="Hoàn tiền" onClose={onClose} width="max-w-sm">
      <div className="flex flex-col gap-3">
        <img src={pickState.previewUrl} alt="Ảnh biên lai hoàn tiền" className="max-h-64 w-full rounded-lg-mac border border-line object-contain" />

        {ocrState.kind === 'loading' && (
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <DotsLoader size="sm" /> Đang đọc số tiền từ ảnh...
          </p>
        )}
        {ocrState.kind === 'autofilled' && <p className="text-xs font-medium text-success">Đã tự đọc số tiền, vui lòng kiểm tra lại.</p>}
        {ocrState.kind === 'needs_review' && (
          <div className="space-y-1 rounded-lg-mac border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger">
            <p className="flex items-center gap-1 font-semibold">
              <AlertTriangle className="h-3.5 w-3.5" /> Không tự đọc chắc chắn — vui lòng kiểm tra/nhập tay:
            </p>
            <ul className="list-disc space-y-0.5 pl-4">
              {ocrState.reasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
        {ocrState.kind === 'not_found' && <p className="text-xs text-slate-400">Không tự đọc được số tiền từ ảnh, vui lòng nhập tay.</p>}
        {ocrState.kind === 'error' && <p className="text-xs text-danger">{ocrState.message}</p>}

        <Field label="Số tiền hoàn LẦN NÀY (đ)" required hint="Có thể sửa tay nếu OCR đọc sai hoặc chưa chắc chắn.">
          <input
            ref={amountField.inputRef}
            type="text"
            inputMode="numeric"
            value={amountField.value}
            onChange={amountField.onChange}
            placeholder="0"
            className={inputCls}
          />
          {amountField.error && <p className="mt-1 text-xs text-danger">{amountField.error}</p>}
        </Field>

        {/* Trạng thái CỘNG DỒN SỐNG (Admin Demo: cảnh báo phải hiện NGAY LÚC XEM TRƯỚC) — 4 trạng thái Chưa hoàn/
            Hoàn thiếu/Hoàn đủ/Hoàn thừa, kèm SỐ TIỀN CHÊNH LỆCH CHÍNH XÁC khi lệch. */}
        <div className={`rounded-lg-mac border-2 p-2.5 text-xs font-semibold ${REFUND_STATUS_COLOR_CLASS[liveAggregate.status]}`}>
          <p>{describeRefundAggregate(liveAggregate)}</p>
          <p className="mt-1 font-normal opacity-90">
            Đã hoàn: {formatVndGrouped(liveTotal)}đ / Cần hoàn: {formatVndGrouped(requiredAmount)}đ
            {priorConfirmedTotal != null && priorConfirmedTotal > 0 && ` (đã có ${formatVndGrouped(priorConfirmedTotal)}đ từ trước, lần này ${formatVndGrouped(parsedAmount ?? 0)}đ)`}
          </p>
          {aggregateError && <p className="mt-1 text-[11px] font-normal text-danger">Không tải được lịch sử hoàn tiền trước đó: {aggregateError}</p>}
        </div>

        {/* Đối chiếu Người nhận — CẢNH BÁO NGAY, không tự tin kết luận "khớp" khi thiếu dữ liệu. */}
        {recipientMatch && (
          <div
            className={
              'flex items-start gap-1.5 rounded-lg-mac border-2 p-2.5 text-xs font-semibold ' +
              (recipientMatch.status === 'matched'
                ? 'border-success bg-success/10 text-success'
                : recipientMatch.status === 'mismatched'
                  ? 'border-danger bg-danger/10 text-danger'
                  : 'border-amber-400 bg-amber-50 text-amber-700')
            }
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{recipientMatch.status === 'mismatched' ? recipientMatch.message : RECIPIENT_MATCH_LABEL_VI[recipientMatch.status]}</span>
          </div>
        )}

        {refundFields && (
          <div className="overflow-hidden rounded-lg-mac border border-line text-xs">
            <div className="grid grid-cols-2 gap-px bg-line">
              {buildRefundFieldDisplayRows(refundFields).map((row) => (
                <div key={row.key} className="flex flex-col gap-0.5 bg-white px-3 py-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{row.label}</span>
                  <span className={row.muted ? 'text-slate-400' : 'font-medium text-slate-700'}>{row.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {sendError && <p className="text-xs text-danger">{sendError}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="neutral" onClick={onClose}>
            Hủy
          </Button>
          <Button type="button" variant="confirm" onClick={() => void handleSend()} disabled={!canSend}>
            {sending ? <DotsLoader size="sm" color="white" /> : 'Xác nhận đã hoàn tiền'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
