// B112 (2/8, Admin Demo "bill sau khi đã gửi chưa có nút sửa?") — panel "Sửa" ảnh bill ĐÃ GỬI, mở từ "Sửa" trong
// menu ngữ cảnh ChatBubble (ConversationScreen.tsx, gate `canEditBillMessage()`). Cùng KHUNG UI/mức nổi bật
// với `OcrBillPreview.tsx` (bảng Số tiền/Hoàn tiền — TÁI DÙNG `BillFieldsTable`/`BillSettlementRiskBanner`
// (BillFieldsTable.tsx) + `buildRefundText`/`formatVndGrouped` (bill-refund-text.ts) + `useFeePreview` (lib/
// use-fee-preview.ts), KHÔNG viết lại logic quyết định trùng lặp) NHƯNG khác 3 điểm:
//   1. KHÔNG chạy lại OCR — `billFields` đọc THẲNG từ `message.billMeta` (đã lưu sẵn lúc gửi lần đầu, xem
//      bill-message-meta.ts), chỉ hiển thị, KHÔNG cho sửa 6 trường (đúng thiết kế OcrBillPreview cũ).
//   2. "Ảnh gốc" (để ghép lại) KHÔNG có sẵn — tin nhắn chỉ còn giữ ẢNH GHÉP cuối cùng (bill+bảng) — phải fetch
//      lại ảnh ghép qua `message.imageUrl` rồi CẮT phần TRÊN (`cropTopOfImage()`, bill-table-image.ts, dùng
//      `billMeta.imageHeightPx` đã lưu — biết CHÍNH XÁC ranh giới, KHÔNG đoán).
//   3. Bấm "Lưu" → ghép ảnh MỚI (composeBillImage với số tiền mới) → upload thành ATTACHMENT MỚI
//      (`uploadChatAttachment()`, CÙNG hạ tầng upload MessageComposer.tsx dùng) → PATCH tin nhắn HIỆN CÓ
//      (`editChatMessage()` với billPatch, chat-client.ts) — GIỮ NGUYÊN id tin nhắn, KHÔNG tạo tin nhắn mới.
import { useEffect, useRef, useState, type JSX } from 'react';
import { ImagePlus } from 'lucide-react';
import { ImageZoom } from './ImageZoomCompare';
import { Modal } from './Modal';
import { Button } from './Button';
import { Field, inputCls } from './Field';
import { DotsLoader } from './DotsLoader';
import { BillSettlementRiskBanner, BillFieldsTable } from './BillFieldsTable';
import type { ChatMessage } from '../mock-data/types';
import { fetchAttachmentObjectUrl } from '../lib/attachment-blob';
import { composeBillImage, buildBillCaption, cropTopOfImage } from '../lib/bill-table-image';
import { buildBillFieldDisplayRows } from '../lib/ocr-bill-fields-display';
import { buildBillMetadataJson, type BillEditHistoryEntry } from '../lib/bill-message-meta';
import { parseGroupedMoneyValue, useGroupedMoneyField } from '../lib/grouped-money-input';
import { formatVndGrouped, buildRefundText } from '../lib/bill-refund-text';
import { useFeePreview, isRefundTextStale } from '../lib/use-fee-preview';
import { editChatMessage } from '../lib/chat-client';
import { uploadChatAttachment, attachRoomToChatAttachment } from '../lib/rc-realtime';
import { fetchAuthenticatedAgent } from '../lib/bot-api-client';
import { previewLoOcr, getTidCardOptions, recordBillSale, type OcrBillPreview, type TidCardOptions } from '../lib/agent-api-client';
import { CardTypeSelect } from './CardTypeSelect';
import { pickImage, PickImageCancelledError } from '../lib/pick-image';

export function EditBillMessageModal({
  message,
  roomId,
  onClose
}: {
  /** Tin nhắn ẢNH bill đang sửa — caller (ConversationScreen.tsx) ĐÃ gate `canEditBillMessage(message)===true`
   * trước khi mở panel này (mine + billMeta có giá trị + còn trong cửa sổ sửa), component này KHÔNG kiểm lại
   * (server tự kiểm LẦN NỮA khi PATCH, belt-and-suspenders — panel chỉ tin caller cho UI, không tin cho bảo
   * mật). */
  message: ChatMessage;
  roomId: string;
  onClose: () => void;
}): JSX.Element {
  const billMeta = message.billMeta!; // caller đã gate — xem docstring `message` trên.
  // B123 (2/8) — `billFields` giờ là STATE (không còn `const` thẳng từ `billMeta`) — "Đổi ảnh" chạy lại OCR
  // trên ảnh MỚI, cần GHI ĐÈ được 6 trường hiển thị (KHÔNG chỉ đổi ảnh preview mà giữ nguyên field cũ sai).
  const [billFields, setBillFields] = useState<OcrBillPreview>(billMeta.billFields);
  const [zoom, setZoom] = useState(false); // [Admin Demo 10/9] bấm ảnh → phóng to + khối đối chiếu (như màn review OCR).

  const [loadState, setLoadState] = useState<{ kind: 'loading' } | { kind: 'ready'; blob: Blob; previewUrl: string } | { kind: 'error'; message: string }>(
    { kind: 'loading' }
  );
  const amountField = useGroupedMoneyField(String(billMeta.amount));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const [ocrReloading, setOcrReloading] = useState(false);
  const [myAgent, setMyAgent] = useState<{ id: number; name: string } | null>(null);
  // Loại thẻ + giá bán (21/8) — CÙNG tính năng OcrBillPreview.tsx. Bill đã gửi không có gợi ý nhận diện thẻ từ
  // OCR (billMeta cũ), nên chỉ lấy DANH SÁCH thẻ + loại mặc định để đại lý chọn lại giá bán khi sửa. tid lấy từ
  // billFields.tid?.value (billFields = billMeta.billFields, có thể đổi khi "Đổi ảnh"). TID không hợp lệ → ẩn ô.
  const [cardOptions, setCardOptions] = useState<TidCardOptions | null>(null);
  const [selectedCardTypeId, setSelectedCardTypeId] = useState<number | null>(null);

  useEffect(() => {
    void fetchAuthenticatedAgent().then((r) => {
      if (r.ok) setMyAgent({ id: r.data.agent.id, name: r.data.agent.name });
    });
  }, []);

  // Fetch lại ẢNH GHÉP hiện có (message.imageUrl, qua CSRF-aware fetch CÙNG cơ chế AttachmentImage dùng) rồi
  // cắt phần TRÊN (ảnh bill gốc, bỏ bảng cũ) — xem docstring đầu file điểm 2. Chạy LẠI mỗi khi đổi tin nhắn
  // đang sửa (message.id đổi — hiếm khi xảy ra vì panel unmount/remount theo `editingBillMessage` state, nhưng
  // giữ dep đúng thói quen).
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
        const croppedBlob = await cropTopOfImage(composedBlob, billMeta.imageHeightPx);
        if (cancelledRef.current) return;
        localPreviewUrl = URL.createObjectURL(croppedBlob);
        setLoadState({ kind: 'ready', blob: croppedBlob, previewUrl: localPreviewUrl });
      } catch {
        if (!cancelledRef.current) setLoadState({ kind: 'error', message: 'Không tải được ảnh bill gốc để sửa — vui lòng thử lại.' });
      }
    }
    void run();
    return () => {
      cancelledRef.current = true;
      if (localPreviewUrl) URL.revokeObjectURL(localPreviewUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.id]);

  // (21/8) — lấy danh sách loại thẻ + giá bán của TID bill đang sửa (KHÔNG kèm scheme/bin: bill đã gửi không có
  // gợi ý nhận diện thẻ). tid không hợp lệ/ngoài scope → cardOptions=null → CardTypeSelect tự ẩn. Chạy lại khi
  // tid đổi (đại lý bấm "Đổi ảnh" → OCR ra tid khác).
  const billTid = billFields.tid?.value;
  useEffect(() => {
    if (!billTid) {
      setCardOptions(null);
      setSelectedCardTypeId(null);
      return;
    }
    let cancelled = false;
    // Truyền scheme/bin đã lưu trong billMeta.billFields (nếu có) để backend PRE-chọn lại như lúc quét.
    void getTidCardOptions(billTid, billFields.detectedCardScheme, billFields.detectedBin6).then((r) => {
      if (cancelled) return;
      const opts = r.ok ? r.data : null;
      setCardOptions(opts);
      // Init (review HIGH #1): ưu tiên LOẠI THẺ GỐC đã lưu (billMeta.cardTypeId) → mở "Sửa" KHÔNG reset về Visa-Master
      // làm lệch giá thực tế; thiếu (bill cũ) → nhận-diện > mặc định > thẻ đầu. Chỉ dùng cardTypeId gốc nếu còn trong
      // danh sách thẻ hiện tại của TID (phòng thẻ bị xóa/đổi bank sau khi gửi).
      const orig = billMeta.cardTypeId != null && opts?.cards.some((c) => c.cardTypeId === billMeta.cardTypeId) ? billMeta.cardTypeId : null;
      setSelectedCardTypeId(opts ? (orig ?? opts.detectedCardTypeId ?? opts.defaultCardTypeId ?? opts.cards[0]?.cardTypeId ?? null) : null);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billTid, billFields.detectedCardScheme, billFields.detectedBin6]);

  const parsedAmount = parseGroupedMoneyValue(amountField.value);

  const feeState = useFeePreview(billFields.tid?.value, parsedAmount, selectedCardTypeId ?? undefined);
  const refundText = buildRefundText(parsedAmount, feeState.feePreview);
  // 20/8 (fix bug tiền, CÙNG bug OcrBillPreview.tsx) — CHẶN "Lưu" khi dòng Hoàn tiền còn LỖI THỜI (preview đang
  // tính cho số tiền vừa sửa) để KHÔNG ghép + PATCH ảnh mang dòng hoàn tiền sai. Xem isRefundTextStale().
  const feeStale = isRefundTextStale({
    // CÙNG truthiness với `useFeePreview` (guard `if (!tid …)`): TID rỗng '' = KHÔNG có TID → hook không fetch,
    // dùng `!!…value` để tránh isRefundTextStale kẹt `true` mãi (nút Lưu treo "đang tính phí…").
    hasTid: !!billFields.tid?.value,
    parsedAmount,
    pending: feeState.pending,
    previewAmount: feeState.previewAmount
  });
  const canSave = parsedAmount != null && parsedAmount > 0 && loadState.kind === 'ready' && !saving && !feeStale;

  /** "Đổi ảnh" (Admin Demo 2/8, chốt bổ sung "cả 2 chỗ Sửa bill gốc VÀ Sửa hoàn tiền đều phải cho đổi ảnh") — chọn
   * ẢNH HOÀN TOÀN MỚI (KHÔNG phải crop ảnh cũ như lúc mở panel), chạy LẠI OCR (previewLoOcr(), CÙNG endpoint
   * "Quét bill" gốc — KHÔNG viết lại logic OCR), ghi đè `billFields`/preview + gợi ý số tiền mới. Người dùng
   * vẫn sửa tay tiếp được nếu OCR đọc sai/không chắc chắn (CÙNG UX OcrBillPreview.tsx). */
  async function handleReplaceImage(): Promise<void> {
    if (ocrReloading || saving) return;
    let file: File;
    try {
      file = await pickImage({ header: 'Chọn ảnh bill mới', photo: 'Thư viện ảnh', picture: 'Chụp ảnh', cancel: 'Hủy' });
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
      const r = await previewLoOcr(0, file);
      if (r.ok) {
        setBillFields(r.data);
        if (r.data.parsedAmount != null) amountField.setValue(String(r.data.parsedAmount));
      }
    } finally {
      setOcrReloading(false);
    }
  }

  async function handleSave(): Promise<void> {
    // `feeStale` (belt-and-suspenders với nút disabled) — CẤM ghép/PATCH ảnh khi dòng Hoàn tiền chưa khớp số tiền.
    if (loadState.kind !== 'ready' || parsedAmount == null || saving || feeStale) return;
    setSaving(true);
    setSaveError(null);
    try {
      const amountText = `${formatVndGrouped(parsedAmount)}đ`;
      // B123 (2/8) — CÙNG fix settlementRisk-persisted-vào-ảnh áp cho OcrBillPreview.tsx (xem comment ở đó) —
      // "Sửa" bill KHÔNG được làm MẤT cảnh báo đã có trong ảnh gốc nếu bill đó có rủi ro đóng lô.
      const composed = await composeBillImage(loadState.blob, buildBillFieldDisplayRows(billFields), amountText, refundText ?? undefined, billFields.settlementRisk?.message);
      const caption = buildBillCaption(billFields.hkdName, billFields.tid, billFields.batchNumber, billFields.dateTime, amountText);
      const fileName = `bill-sua-${Date.now()}.jpg`;
      const file = new File([composed.blob], fileName, { type: 'image/jpeg' });

      const uploadRes = await uploadChatAttachment(file);
      if (!uploadRes.ok) {
        setSaveError(uploadRes.message);
        return;
      }
      // Audit trail (Admin Demo 2/8) — APPEND entry MỚI vào editHistory ĐÃ CÓ (KHÔNG ghi đè lịch sử cũ).
      const editHistory: BillEditHistoryEntry[] = [
        ...(billMeta.editHistory ?? []),
        { editedByAgentId: myAgent?.id ?? -1, editedByName: myAgent?.name ?? 'Không rõ', editedAt: new Date().toISOString() }
      ];
      // GIỮ loại thẻ đã chọn qua lần sửa (review HIGH #1) — nếu không, mỗi lần Sửa sẽ rơi mất cardTypeId đã lưu.
      const metadataJson = buildBillMetadataJson({ billFields, amount: parsedAmount, imageHeightPx: composed.billImageHeightPx, cardTypeId: selectedCardTypeId ?? undefined, editHistory });
      const patchRes = await editChatMessage(message.id, caption, { attachmentId: uploadRes.data.id, metadataJson });
      if (!patchRes.ok) {
        setSaveError(patchRes.message);
        return;
      }
      // NỐI BILL → DOANH SỐ khi SỬA (Admin Demo 21/8) — cùng khóa bill (số lô/số HĐ không đổi) → server UPSERT CÙNG Lô:
      // cập nhật số tiền/loại thẻ mới (KHÔNG tạo Lô trùng). Best-effort, chỉ khi TID khớp khách.
      if (billFields.tidMatched && billFields.tid?.value && parsedAmount > 0) {
        // SỬA bill = cập nhật CÙNG Lô (khóa số lô/số HĐ không đổi → UPSERT), hoặc hash ảnh khớp nếu gửi lại cùng
        // ảnh. KHÔNG dùng dup-guard ở đây: sửa là chủ đích cập nhật, không phải tạo giao dịch mới; nếu không khớp
        // khóa nào (hiếm, bill không số lô + ảnh mới) server trả DUP_SUSPECT → best-effort bỏ qua (KHÔNG đếm trùng).
        void recordBillSale({
          tid: billFields.tid.value,
          amountBeforeFee: parsedAmount,
          cardTypeId: selectedCardTypeId ?? undefined,
          batchNumber: billFields.batchNumber?.value ?? null,
          invoiceNumber: billFields.invoiceNumber?.value ?? null,
          billImageHash: billFields.billImageHash ?? null
        });
      }
      // Best-effort, CÙNG khuôn sendAttachment() ConversationScreen.tsx — gán roomId cho attachment mới (dọn
      // rác/kiểm quyền phía sau), KHÔNG chặn UI đợi kết quả.
      void attachRoomToChatAttachment(uploadRes.data.id, roomId);
      // `messages` state của ConversationScreen tự cập nhật qua real-time `message-edited`
      // (subscribeMessageEdited đã subscribe sẵn) — panel chỉ cần tự đóng.
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Sửa bill đã gửi" onClose={onClose} width="max-w-sm">
      <div className="flex flex-col gap-3">
        {loadState.kind === 'loading' && (
          <div className="flex h-64 w-full items-center justify-center rounded-lg-mac border border-line bg-appbg">
            <DotsLoader size="md" />
          </div>
        )}
        {loadState.kind === 'error' && <p className="text-xs text-danger">{loadState.message}</p>}
        {/* [Admin Demo 10/9] "màn sửa trong danh sách bill POS vẫn phải có blog đối chiếu khi click vào ảnh" — bấm ảnh
            mở phóng to KÈM khối đối chiếu (số đang sửa), khỏi vừa soi ảnh vừa nhớ số. */}
        {zoom && loadState.kind === 'ready' && (
          <ImageZoom src={loadState.previewUrl} onClose={() => setZoom(false)} compare={{
            chinh: { label: 'HKD', value: billFields.hkdName?.value ?? '' },
            phu: [{ label: 'TID', value: billFields.tid?.value ?? '' }],
            hang: [
              { label: 'Ngày/giờ', value: billFields.dateTime?.value ?? '' },
              { label: 'Số lô', value: billFields.batchNumber?.value ?? '' },
              { label: 'Số HĐ', value: billFields.invoiceNumber?.value ?? '' }
            ],
            tien: { label: 'Số tiền (đang sửa)', value: amountField.value, kieu: 'tien', sua: (v) => amountField.setValue(v) },
            duoi: [
              { label: 'Thẻ', value: (cardOptions?.cards ?? []).find((c) => c.cardTypeId === selectedCardTypeId)?.name ?? '' },
              { label: 'Ngân hàng', value: billFields.bankName?.value ?? '' }
            ]
          }} />
        )}
        {loadState.kind === 'ready' && (
          <div className="relative">
            <button type="button" onClick={() => setZoom(true)} title="Bấm để phóng to + xem khối đối chiếu" className="block w-full">
              <img src={loadState.previewUrl} alt="Ảnh bill gốc" className="max-h-64 w-full rounded-lg-mac border border-line object-contain" />
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

        <BillSettlementRiskBanner billFields={billFields} />

        <BillFieldsTable billFields={billFields} amountDisplay={amountField.value ? `${amountField.value}đ` : '—'} refundText={refundText} />

        {/* Loại thẻ + giá bán (21/8) — chọn lại loại thẻ để dòng "Hoàn tiền" tính đúng phí. Ẩn khi TID không hợp
            lệ/ngoài scope (CardTypeSelect tự trả null). */}
        <CardTypeSelect options={cardOptions} value={selectedCardTypeId} onChange={setSelectedCardTypeId} />

        <Field label="Số tiền (đ)" required hint="Sửa lại số tiền — bảng/ảnh gửi đi sẽ được ghép lại với số tiền mới.">
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

        {/* Audit trail (Admin Demo 2/8) — liệt kê MỌI lần sửa trước (append-only), KHÔNG chỉ lần cuối. */}
        {billMeta.editHistory && billMeta.editHistory.length > 0 && (
          <div className="rounded-lg-mac border border-line bg-appbg p-2 text-[11px] text-slate-500">
            {billMeta.editHistory.map((h, i) => (
              <p key={i}>
                Đã sửa bởi {h.editedByName} lúc {new Date(h.editedAt).toLocaleString('vi-VN')}
              </p>
            ))}
          </div>
        )}

        {saveError && <p className="text-xs text-danger">{saveError}</p>}

        {/* 20/8 — báo rõ vì sao nút Lưu tạm khoá (đang tính lại phí cho số tiền vừa sửa). */}
        {parsedAmount != null && parsedAmount > 0 && loadState.kind === 'ready' && feeStale && (
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <DotsLoader size="sm" /> Đang tính phí hoàn tiền…
          </p>
        )}

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
