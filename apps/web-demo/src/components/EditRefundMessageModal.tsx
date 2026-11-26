// SIGMA (2/8, tính năng "Hoàn tiền" MỚI) — panel "Sửa" 1 LẦN HOÀN TIỀN đã gửi (đổi số tiền/ảnh) — mở từ
// nút "Sửa" trong menu ngữ cảnh ChatBubble khi tin đang chọn là tin nhắn HOÀN TIỀN (isRefundImage, KHÁC
// "Sửa" bill gốc B112/EditBillMessageModal.tsx). CÙNG khuôn EditBillMessageModal.tsx (fetch ảnh ghép hiện có →
// cropTopOfImage() → hiện lại + cho sửa số tiền → "Lưu" ghép lại + PATCH tin nhắn HIỆN CÓ, giữ nguyên id) —
// khác 2 điểm:
//   1. Recompute trạng thái CỘNG DỒN loại trừ CHÍNH lần hoàn tiền đang sửa (KHÔNG double-count) rồi cộng lại
//      giá trị MỚI — Admin Demo 2/8: "sửa 1 lần hoàn tiền phải tính lại đúng tổng, không tính nhầm 2 lần chính
//      nó".
//   2. Audit trail (Admin Demo 2/8, chốt bổ sung): "Sửa" PHẢI ghi lại "Đã sửa bởi <tên> lúc <giờ>" — APPEND vào
//      `editHistory[]` (refund-message-meta.ts), KHÔNG ghi đè — giữ MỌI lần sửa trước.
//   3. "Đổi ảnh" (Admin Demo 2/8, chốt bổ sung "cả 2 chỗ Sửa bill gốc VÀ Sửa hoàn tiền đều phải cho đổi ảnh") —
//      chọn ảnh MỚI HOÀN TOÀN (pickImage(), KHÔNG chỉ crop ảnh cũ) → chạy LẠI OCR (previewRefundOcr()) trên
//      ảnh mới, GHI ĐÈ refundFields/amount gợi ý (người dùng vẫn sửa tay tiếp được nếu cần).
import { useEffect, useRef, useState, type JSX } from 'react';
import { AlertTriangle, ImagePlus } from 'lucide-react';
import { ImageZoom } from './ImageZoomCompare';
import { Modal } from './Modal';
import { Button } from './Button';
import { Field, inputCls } from './Field';
import { DotsLoader } from './DotsLoader';
import type { ChatMessage } from '../mock-data/types';
import { fetchAttachmentObjectUrl } from '../lib/attachment-blob';
import { fetchAuthenticatedAgent } from '../lib/bot-api-client';
import { previewRefundOcr, getRefundAggregate, type RefundReceiptPreview } from '../lib/agent-api-client';
import { useFeePreview } from '../lib/use-fee-preview';
import { parseGroupedMoneyValue, useGroupedMoneyField } from '../lib/grouped-money-input';
import { buildRefundFieldDisplayRows } from '../lib/ocr-bill-fields-display';
import { formatVndGrouped } from '../lib/bill-refund-text';
import { composeRefundImage, cropTopOfImage, type RefundImageWarningInput } from '../lib/bill-table-image';
import { computeRefundAggregate, describeRefundAggregate, REFUND_STATUS_COLOR_CLASS, REFUND_STATUS_LABEL_VI } from '../lib/refund-bill-status';
import { buildRefundMetadataJson, type RefundEditHistoryEntry } from '../lib/refund-message-meta';
import { pickImage, PickImageCancelledError } from '../lib/pick-image';
import { uploadChatAttachment, attachRoomToChatAttachment } from '../lib/rc-realtime';
import { editChatMessage } from '../lib/chat-client';

const RECIPIENT_MATCH_LABEL_VI: Record<RefundReceiptPreview['recipientMatch']['status'], string> = {
  matched: 'Tài khoản người nhận khớp dữ liệu đã cấu hình.',
  mismatched: '',
  not_configured: 'TID này CHƯA cấu hình tài khoản nhận tiền — KHÔNG đối chiếu tự động được, tự kiểm tra thủ công.',
  no_tid: 'Không xác định được TID của bill gốc — KHÔNG đối chiếu tài khoản tự động được.',
  unread: 'Không đọc đủ tên/số tài khoản người nhận từ ảnh — tự đối chiếu bằng mắt.'
};

export function EditRefundMessageModal({
  message,
  roomId,
  /** Tin nhắn bill GỐC (nếu ConversationScreen tìm thấy trong `messages` đã tải theo `message.replyToMessageId`
   * — có thể `undefined` nếu bill gốc quá cũ chưa tải, xem comment ConversationScreen.tsx) — dùng để tính lại
   * "số tiền phải hoàn". Thiếu → vẫn cho sửa số tiền/ảnh bình thường, CHỈ ẨN banner trạng thái cộng dồn (không
   * đủ dữ liệu để tính, KHÔNG suy đoán). */
  originalMessage,
  onClose
}: {
  message: ChatMessage;
  roomId: string;
  originalMessage?: ChatMessage;
  onClose: () => void;
}): JSX.Element {
  const refundMeta = message.refundMeta!; // caller đã gate canEditRefundMessage().
  const originalTid = originalMessage?.billMeta?.billFields.tid?.value;
  const originalAmount = originalMessage?.billMeta?.amount;

  const [loadState, setLoadState] = useState<{ kind: 'loading' } | { kind: 'ready'; blob: Blob; previewUrl: string } | { kind: 'error'; message: string }>({ kind: 'loading' });
  const [refundFields, setRefundFields] = useState<RefundReceiptPreview | null>(refundMeta.refundFields);
  const [zoom, setZoom] = useState(false); // [Admin Demo 10/9] bấm ảnh → phóng to + khối đối chiếu.
  const amountField = useGroupedMoneyField(String(refundMeta.amount));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const [ocrReloading, setOcrReloading] = useState(false);
  const [myAgent, setMyAgent] = useState<{ id: number; name: string } | null>(null);

  const [priorConfirmedTotal, setPriorConfirmedTotal] = useState<number | null>(null);
  const [aggregateError, setAggregateError] = useState<string | null>(null);

  useEffect(() => {
    void fetchAuthenticatedAgent().then((r) => {
      if (r.ok) setMyAgent({ id: r.data.agent.id, name: r.data.agent.name });
    });
  }, []);

  // Fetch lại ẢNH GHÉP hiện có rồi cắt phần TRÊN (ảnh biên lai gốc, bỏ bảng cũ) — CÙNG cơ chế EditBillMessageModal.tsx.
  useEffect(() => {
    cancelledRef.current = false;
    setLoadState({ kind: 'loading' });
    let localPreviewUrl: string | null = null;
    async function run(): Promise<void> {
      if (!message.imageUrl) {
        setLoadState({ kind: 'error', message: 'Tin nhắn không có ảnh đính kèm — không thể sửa.' });
        return;
      }
      try {
        const composedObjectUrl = await fetchAttachmentObjectUrl(message.imageUrl);
        const composedBlob = await fetch(composedObjectUrl).then((r) => r.blob());
        const croppedBlob = await cropTopOfImage(composedBlob, refundMeta.imageHeightPx);
        if (cancelledRef.current) return;
        localPreviewUrl = URL.createObjectURL(croppedBlob);
        setLoadState({ kind: 'ready', blob: croppedBlob, previewUrl: localPreviewUrl });
      } catch {
        if (!cancelledRef.current) setLoadState({ kind: 'error', message: 'Không tải được ảnh gốc để sửa — vui lòng thử lại.' });
      }
    }
    void run();
    return () => {
      cancelledRef.current = true;
      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id]);

  // Số tiền PHẢI HOÀN — CHỈ tính được nếu tìm thấy bill gốc (originalMessage).
  // 20/8 — hook nay trả object `{ feePreview, previewAmount, pending }`. Số tiền đầu vào CỐ ĐỊNH
  // (originalAmount, KHÔNG do người dùng sửa) → KHÔNG có đua tranh "đổi số tiền", chỉ lấy `feePreview`, giữ
  // NGUYÊN hành vi cũ.
  const { feePreview } = useFeePreview(originalTid, originalAmount ?? null);
  const requiredAmount = originalAmount != null ? (feePreview?.resolved === true ? feePreview.amountAfterFee : originalAmount) : null;

  // Tổng ĐÃ hoàn từ CÁC LẦN KHÁC (loại trừ chính lần đang sửa) — CHỈ tải khi có requiredAmount + biết roomId gốc.
  useEffect(() => {
    if (requiredAmount == null || !message.replyToMessageId) return;
    let cancelled = false;
    void getRefundAggregate(message.replyToMessageId, requiredAmount).then((r) => {
      if (cancelled) return;
      if (!r.ok) {
        setAggregateError(r.message);
        setPriorConfirmedTotal(0);
        return;
      }
      const others = r.data.confirmations.filter((c) => c.messageId !== message.id);
      setPriorConfirmedTotal(others.reduce((sum, c) => sum + c.amount, 0));
    });
    return () => {
      cancelled = true;
    };
  }, [message.replyToMessageId, message.id, requiredAmount]);

  const parsedAmount = parseGroupedMoneyValue(amountField.value);
  const canSave = parsedAmount != null && parsedAmount > 0 && loadState.kind === 'ready' && !saving;

  const liveTotal = requiredAmount != null ? (priorConfirmedTotal ?? 0) + (parsedAmount ?? 0) : null;
  const liveAggregate = requiredAmount != null && liveTotal != null ? computeRefundAggregate(requiredAmount, liveTotal) : null;

  /** "Đổi ảnh" — chọn ảnh HOÀN TOÀN MỚI (KHÔNG phải crop ảnh cũ), chạy LẠI OCR, thay `loadState`/`refundFields`/
   * amount gợi ý — người dùng vẫn sửa tay tiếp được. */
  async function handleReplaceImage(): Promise<void> {
    if (ocrReloading || saving) return;
    let file: File;
    try {
      file = await pickImage({ header: 'Chọn ảnh biên lai hoàn tiền mới', photo: 'Thư viện ảnh', picture: 'Chụp ảnh', cancel: 'Hủy' });
    } catch (err) {
      if (err instanceof PickImageCancelledError) return; // hủy picker — im lặng, KHÔNG phải lỗi thật.
      setSaveError(err instanceof Error ? err.message : 'Không mở được camera/thư viện ảnh.');
      return;
    }
    setOcrReloading(true);
    setSaveError(null);
    try {
      const previewUrl = URL.createObjectURL(file);
      setLoadState({ kind: 'ready', blob: file, previewUrl });
      const r = await previewRefundOcr(file, originalTid);
      if (r.ok) {
        setRefundFields(r.data);
        if (r.data.parsedAmount != null) amountField.setValue(String(r.data.parsedAmount));
      }
    } finally {
      setOcrReloading(false);
    }
  }

  async function handleSave(): Promise<void> {
    if (loadState.kind !== 'ready' || parsedAmount == null || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const thisTimeAmountText = `${formatVndGrouped(parsedAmount)}đ`;
      const warnings: RefundImageWarningInput[] = [];
      if (liveAggregate && (liveAggregate.status === 'over' || liveAggregate.status === 'partial')) {
        warnings.push({ label: 'Cảnh báo số tiền', text: describeRefundAggregate(liveAggregate), severity: liveAggregate.status === 'over' ? 'danger' : 'warning' });
      }
      const recipientMatch = refundFields?.recipientMatch;
      if (recipientMatch && recipientMatch.status !== 'matched') {
        const msg = recipientMatch.status === 'mismatched' ? recipientMatch.message : RECIPIENT_MATCH_LABEL_VI[recipientMatch.status];
        warnings.push({ label: 'Cảnh báo người nhận', text: msg, severity: recipientMatch.status === 'mismatched' ? 'danger' : 'warning' });
      }
      const progressText = liveTotal != null && requiredAmount != null ? `${formatVndGrouped(liveTotal)}đ/${formatVndGrouped(requiredAmount)}đ` : undefined;

      const displayRows = refundFields ? buildRefundFieldDisplayRows(refundFields) : [];
      const composed = await composeRefundImage(loadState.blob, displayRows, thisTimeAmountText, progressText, warnings);
      const caption = liveAggregate ? `Hoàn tiền ${thisTimeAmountText} — ${REFUND_STATUS_LABEL_VI[liveAggregate.status]}` : `Hoàn tiền ${thisTimeAmountText}`;
      const fileName = `hoan-tien-sua-${Date.now()}.jpg`;
      const file = new File([composed.blob], fileName, { type: 'image/jpeg' });

      const uploadRes = await uploadChatAttachment(file);
      if (!uploadRes.ok) {
        setSaveError(uploadRes.message);
        return;
      }

      // Audit trail (Admin Demo 2/8) — APPEND entry MỚI vào editHistory ĐÃ CÓ (KHÔNG ghi đè lịch sử cũ).
      const editHistory: RefundEditHistoryEntry[] = [
        ...(refundMeta.editHistory ?? []),
        { editedByAgentId: myAgent?.id ?? -1, editedByName: myAgent?.name ?? 'Không rõ', editedAt: new Date().toISOString() }
      ];

      const metadataJson = buildRefundMetadataJson({
        refundFields: refundFields ?? refundMeta.refundFields,
        amount: parsedAmount,
        imageHeightPx: composed.billImageHeightPx,
        amountStatusAtConfirm: liveAggregate?.status ?? refundMeta.amountStatusAtConfirm,
        amountDiffAtConfirm: liveAggregate?.diff ?? refundMeta.amountDiffAtConfirm,
        requiredAmountAtConfirm: requiredAmount ?? refundMeta.requiredAmountAtConfirm,
        recipientMatchStatus: recipientMatch?.status ?? refundMeta.recipientMatchStatus,
        recipientMatchMessage: recipientMatch ? (recipientMatch.status === 'mismatched' ? recipientMatch.message : RECIPIENT_MATCH_LABEL_VI[recipientMatch.status]) : refundMeta.recipientMatchMessage,
        editHistory
      });

      const patchRes = await editChatMessage(message.id, caption, { attachmentId: uploadRes.data.id, metadataJson });
      if (!patchRes.ok) {
        setSaveError(patchRes.message);
        return;
      }
      void attachRoomToChatAttachment(uploadRes.data.id, roomId);
      onClose();
    } finally {
      setSaving(false);
    }
  }

  const recipientMatch = refundFields?.recipientMatch;

  return (
    <Modal title="Sửa lần hoàn tiền" onClose={onClose} width="max-w-sm">
      <div className="flex flex-col gap-3">
        {loadState.kind === 'loading' && (
          <div className="flex h-64 w-full items-center justify-center rounded-lg-mac border border-line bg-appbg">
            <DotsLoader size="md" />
          </div>
        )}
        {loadState.kind === 'error' && <p className="text-xs text-danger">{loadState.message}</p>}
        {/* [Admin Demo 10/9] "màn sửa trong danh sách bill CK vẫn phải có blog đối chiếu khi click vào ảnh". */}
        {zoom && loadState.kind === 'ready' && (
          <ImageZoom src={loadState.previewUrl} onClose={() => setZoom(false)} compare={{
            tieuDe: '📋 Đối chiếu bill CK',
            chinh: { label: 'Người nhận', value: refundFields?.recipientName?.value ?? '' },
            phu: [
              { label: 'Người gửi', value: refundFields?.senderName?.value ?? '' },
              { label: 'NH nhận', value: refundFields?.bankName?.value ?? '' }
            ],
            hang: [{ label: 'Ngày/giờ', value: refundFields?.dateTime?.value ?? '' }],
            tien: { label: 'Số tiền (đang sửa)', value: amountField.value, kieu: 'tien', sua: (v) => amountField.setValue(v) },
            duoi: [{ label: 'STK nhận', value: refundFields?.recipientAccountNumber?.value ?? '' }]
          }} />
        )}
        {loadState.kind === 'ready' && (
          <div className="relative">
            <button type="button" onClick={() => setZoom(true)} title="Bấm để phóng to + xem khối đối chiếu" className="block w-full">
              <img src={loadState.previewUrl} alt="Ảnh biên lai hoàn tiền" className="max-h-64 w-full rounded-lg-mac border border-line object-contain" />
            </button>
            <span className="pointer-events-none absolute right-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white">🔍 phóng to · đối chiếu</span>
            {ocrReloading && (
              <div className="absolute inset-0 flex items-center justify-center rounded-lg-mac bg-white/70">
                <DotsLoader size="md" />
              </div>
            )}
          </div>
        )}
        <Button type="button" variant="neutral" onClick={() => void handleReplaceImage()} disabled={ocrReloading || saving}>
          <ImagePlus className="mr-1.5 inline h-4 w-4" /> Đổi ảnh
        </Button>

        <Field label="Số tiền hoàn LẦN NÀY (đ)" required hint="Sửa lại số tiền — bảng/ảnh gửi đi sẽ được ghép lại.">
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

        {liveAggregate ? (
          <div className={`rounded-lg-mac border-2 p-2.5 text-xs font-semibold ${REFUND_STATUS_COLOR_CLASS[liveAggregate.status]}`}>
            <p>{describeRefundAggregate(liveAggregate)}</p>
            <p className="mt-1 font-normal opacity-90">
              Đã hoàn: {formatVndGrouped(liveTotal ?? 0)}đ / Cần hoàn: {formatVndGrouped(requiredAmount ?? 0)}đ
            </p>
            {aggregateError && <p className="mt-1 text-[11px] font-normal text-danger">Không tải được lịch sử hoàn tiền khác: {aggregateError}</p>}
          </div>
        ) : (
          <p className="text-xs text-slate-400">Chưa xác định được số tiền phải hoàn (bill gốc chưa tải trong khung chat) — vẫn lưu được, chỉ không hiện trạng thái cộng dồn.</p>
        )}

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

        {/* Audit trail (Admin Demo 2/8) — liệt kê MỌI lần sửa trước (append-only), KHÔNG chỉ lần cuối. */}
        {refundMeta.editHistory && refundMeta.editHistory.length > 0 && (
          <div className="rounded-lg-mac border border-line bg-appbg p-2 text-[11px] text-slate-500">
            {refundMeta.editHistory.map((h, i) => (
              <p key={i}>
                Đã sửa bởi {h.editedByName} lúc {new Date(h.editedAt).toLocaleString('vi-VN')}
              </p>
            ))}
          </div>
        )}

        {saveError && <p className="text-xs text-danger">{saveError}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="neutral" onClick={onClose}>
            Hủy
          </Button>
          <Button type="button" variant="confirm" onClick={() => void handleSave()} disabled={!canSave}>
            {saving ? <DotsLoader size="sm" color="white" /> : 'Lưu'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
