// SIGMA (1/8) — panel xem trước OCR khi bấm "Quét bill" trong khung chat (MessageComposer.tsx), RIÊNG với
// nút "Ảnh" thường (ảnh thường KHÔNG chạy OCR, đúng yêu cầu tường minh Admin Demo). Luồng: chụp/chọn ảnh (component
// cha tự lo, xem MessageComposer.tsx handleScanBillClick()) -> mở panel này -> gọi previewLoOcr()
// (agent-api-client.ts, route bot-api POST /v1/me/lo/ocr-preview ĐÃ CÓ SẴN từ B70-71, generic không gắn Lô cụ
// thể nào) -> deriveOcrPreviewUiState() (ocr-preview-ui.ts, ĐÃ CÓ SẴN + có test riêng ocr-preview-ui.test.ts từ
// ReconcileDetailScreen.tsx) quyết định autofill/cảnh báo đỏ/cảnh báo nhẹ/lỗi dịch vụ -> người dùng xác
// nhận/sửa tay số tiền -> "Gửi" mới thật sự upload ảnh + gửi tin nhắn. Component này KHÔNG tự upload gì lên
// server ngoài gọi /ocr-preview để ĐỌC — ảnh chỉ hiện qua object URL cục bộ (`previewUrl`, cha tạo/thu hồi qua
// `URL.createObjectURL`/`revokeObjectURL`), CHƯA từng lưu vào hệ chat cho tới khi bấm "Gửi" thật.
//
// Dùng chung `Modal` (components/Modal.tsx — CÙNG khung UI mọi modal khác trong app: title bar + nút X + Esc để
// đóng, createPortal ra document.body) để giữ đồng bộ thiết kế toàn app (đúng nguyên tắc "UI đồng bộ tuyệt
// đối"), KHÔNG tự dựng khung modal riêng.
//
// Logic quyết định nhánh cảnh báo TÁI DÙNG NGUYÊN XI `deriveOcrPreviewUiState()` — component này CHỈ gọi hàm đó
// rồi render theo `kind`, giống HỆT pattern đã có ở ReconcileDetailScreen.tsx (xem block `ocrUi.kind` ở đó).
// KHÔNG viết lại logic quyết định mới trùng lặp ở đây.
import { useEffect, useRef, useState, type JSX } from 'react';
import { AlertTriangle } from 'lucide-react';
import { DotsLoader } from './DotsLoader';
import { Modal } from './Modal';
import { Button } from './Button';
import { Field, inputCls } from './Field';
import { BillSettlementRiskBanner, BillFieldsTable } from './BillFieldsTable';
import { previewLoOcr, getTidCardOptions, recordBillSaleWithDupGuard, type OcrBillPreview, type TidCardOptions } from '../lib/agent-api-client';
import { CardTypeSelect } from './CardTypeSelect';
import { useFeePreview, isRefundTextStale } from '../lib/use-fee-preview';
import { deriveOcrPreviewUiState, type OcrPreviewUiState } from '../lib/ocr-preview-ui';
import { parseGroupedMoneyValue, useGroupedMoneyField } from '../lib/grouped-money-input';
import { buildBillFieldDisplayRows } from '../lib/ocr-bill-fields-display';
import { composeBillImage, buildBillFileName, buildBillCaption } from '../lib/bill-table-image';
// B112 (2/8) — `formatVndGrouped`/`buildRefundText` TÁCH RA module dùng chung (bill-refund-text.ts) —
// EditBillMessageModal.tsx (panel "Sửa" bill đã gửi, mới) TÁI DÙNG NGUYÊN 2 hàm này, tránh lệch công thức 2
// nơi (đúng bài học "sửa 1 nơi quên nơi khác" chính B111 đã ghi ở đây TRƯỚC B112 — hàm cũ viết inline tại
// component này, giờ chuyển ra ngoài KHÔNG đổi hành vi).
import { formatVndGrouped, buildRefundText } from '../lib/bill-refund-text';
import { buildBillMetadataJson, type BillMessageMeta } from '../lib/bill-message-meta';

export function OcrBillPreview({
  file,
  previewUrl,
  onCancel,
  onConfirm
}: {
  /** Ảnh vừa chụp/chọn — dùng làm input gọi `/ocr-preview` để ĐỌC (KHÔNG upload lưu chat ở bước này). */
  file: File;
  /** Object URL cục bộ (`URL.createObjectURL(file)`, cha tạo/thu hồi — xem MessageComposer.tsx) hiện ảnh xem
   * trước. KHÔNG phải URL server — ảnh CHƯA từng lên server cho tới khi bấm Gửi. */
  previewUrl: string;
  onCancel: () => void;
  /** Gọi ĐÚNG 1 lần lúc bấm "Gửi" (chỉ khi số tiền đã nhập hợp lệ, xem `canSend`) kèm 2 tham số:
   * - `amountCaption`: caption NGẮN GỌN CHỈ số tiền đã format sẵn (VD "Bill: 52.700.000đ") — caption DUY NHẤT
   *   của ẢNH GỬI ĐI (KHÔNG còn dồn 6 dòng chữ vào đây, đúng yêu cầu Admin Demo "chữ rất xấu" 1/8).
   * - `file`: 1 File ẢNH DUY NHẤT sẵn sàng gửi thẳng — NẾU ít nhất 1 trong 6 trường mở rộng đọc được, đây là
   *   ẢNH GHÉP (`composeBillImage()`, bill-table-image.ts: ảnh bill gốc TRÊN + bảng kẻ ô Số tiền/7 dòng
   *   `buildBillFieldDisplayRows()` DƯỚI, CÙNG 1 canvas — đúng yêu cầu tường minh Admin Demo "1 tin nhắn không
   *   tách", tên file theo mẫu Admin Demo chốt — xem docstring `buildBillFileName()` (bill-table-image.ts) cho
   *   mẫu CHÍNH XÁC, KHÔNG lặp lại ở đây tránh lệch nhau nếu sau này đổi mẫu); nếu KHÔNG có field mở rộng nào đọc
   *   được HOẶC ghép ảnh lỗi (cực hiếm), đây là NGUYÊN `file` prop gốc (ảnh bill chưa qua chỉnh sửa, tên file
   *   giữ nguyên `bill-<timestamp>.<ext>` đặt lúc chụp). Cha (MessageComposer.tsx `handleConfirmBillSend()`)
   *   chỉ còn upload+gửi ĐÚNG 1 tin nhắn ảnh qua `uploadAndSend()` (KHÔNG còn gửi 2 tin nhắn liên tiếp như
   *   trước 1/8).
   * Cha tự đóng panel này NGAY sau khi nhận callback rồi mới upload+gửi tin chạy NỀN qua `uploadAndSend()`
   * (CÙNG hạ tầng upload dùng chung ảnh thường, hiện spinner ở icon "Ảnh" hàng chính — xem
   * `attachBusy==='image'`) — panel này KHÔNG tự giữ trạng thái "đang gửi" (ngoại trừ `sending` cục bộ CHỈ để
   * chặn bấm "Gửi" lặp trong lúc đang ghép ảnh, xem `handleSend()`).
   * - `billMeta` (B112, 2/8): KHÔNG NULL khi ảnh ĐÃ GHÉP (`file` ở trên là ảnh ghép) — mang billFields/amount/
   *   imageHeightPx để lưu vào `metadataJson` lúc gửi (xem `buildBillMetadataJson()` bill-message-meta.ts),
   *   cho phép "Sửa" lại sau này KHÔNG cần chạy lại OCR. `null` khi KHÔNG có field mở rộng nào đọc được/ghép
   *   ảnh lỗi (CÙNG điều kiện `file` là NGUYÊN ảnh gốc chưa ghép) — tin gửi ra sẽ KHÔNG sửa được qua đường
   *   "Sửa bill" (đúng, vì không có gì để hiện lại: không billFields, không ranh giới ảnh/bảng). */
  onConfirm: (amountCaption: string, file: File, billMeta: BillMessageMeta | null) => void;
}): JSX.Element {
  const [ocrState, setOcrState] = useState<OcrPreviewUiState>({ kind: 'loading' });
  // 6 trường mở rộng (1/8, TID/tên HKD/ngày giờ/số lô/số hóa đơn/tên ngân hàng) — ĐỘC LẬP với ocrState (vốn
  // chỉ quyết định nhánh SỐ TIỀN) vì brief yêu cầu CHỈ HIỂN THỊ 6 trường này, không gắn vào luồng
  // autofill/needs_review của số tiền. null khi đang tải/lỗi (không có gì để hiện).
  const [billFields, setBillFields] = useState<OcrBillPreview | null>(null);
  // Loại thẻ + giá bán (21/8) — danh sách thẻ khả dụng của TID đọc được + loại thẻ đang chọn. Bill quẹt KHÔNG tự
  // nhận diện loại thẻ; backend nhận diện SƠ BỘ từ OCR (detectedCardScheme/detectedBin6) để PRE-chọn, đại lý
  // chỉnh lại nếu sai. null = chưa fetch/TID ngoài scope → ẩn ô chọn thẻ (CardTypeSelect tự trả null).
  const [cardOptions, setCardOptions] = useState<TidCardOptions | null>(null);
  const [selectedCardTypeId, setSelectedCardTypeId] = useState<number | null>(null);
  // Live-grouping + chặn ký tự lạ (vấn đề 2+3, Admin Demo 1/8) — CÙNG hook ReconcileDetailScreen.tsx dùng, xem
  // lib/grouped-money-input.ts.
  const amountField = useGroupedMoneyField('');
  // Tránh setState sau khi unmount/đổi ảnh giữa lúc đang chờ fetch (bấm Hủy rồi quét ảnh khác rất nhanh).
  const cancelledRef = useRef(false);
  // Chặn bấm "Gửi" lặp trong khoảng ngắn `handleSend()` đang `await renderBillTableImage()` (vẽ canvas, xem
  // bill-table-image.ts) — KHÔNG phải trạng thái "đang upload" (đó là việc `attachBusy` của MessageComposer
  // sau khi callback `onConfirm` trả về, panel này đã đóng rồi).
  const [sending, setSending] = useState(false);

  useEffect(() => {
    cancelledRef.current = false;
    setOcrState({ kind: 'loading' });
    setBillFields(null);
    setCardOptions(null);
    setSelectedCardTypeId(null);
    amountField.setValue('');
    // loId=0 — route bot-api /v1/me/lo/ocr-preview CHƯA scope theo Lô cụ thể (xem chú thích previewLoOcr(),
    // agent-api-client.ts: "loId hiện KHÔNG được gửi trong request"), tham số này server KHÔNG dùng tới — giữ
    // 0 hợp lệ chỉ để khớp chữ ký hàm, KHÔNG mang ý nghĩa nghiệp vụ nào ở ngữ cảnh chat (không có Lô).
    void previewLoOcr(0, file).then((r) => {
      if (cancelledRef.current) return;
      const state = deriveOcrPreviewUiState(r);
      setOcrState(state);
      setBillFields(r.ok ? r.data : null);
      if (state.kind === 'autofilled') {
        amountField.setValue(String(state.parsedAmount));
      } else if (state.kind === 'needs_review' && state.suggestedAmount != null) {
        // Bug thật 1/8 (Admin Demo báo "chấp nhận dấu phẩy mà sao không ra số tiền?") — server vẫn TÍNH ĐÚNG số
        // tiền song song với cờ cảnh báo (vd rawText có dấu phẩy, xem ocr-bridge.ts B93), KHÔNG được vứt bỏ
        // giá trị đã tính đúng chỉ vì cần xác nhận tay — điền sẵn để người dùng XÁC NHẬN/sửa, không phải gõ
        // lại từ đầu.
        amountField.setValue(String(state.suggestedAmount));
      }
    });
    return () => {
      cancelledRef.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file]);

  // (21/8) — sau khi OCR ra `billFields` (có tid + gợi ý loại thẻ), lấy danh sách loại thẻ + giá bán của TID đó.
  // Dùng detectedCardScheme/detectedBin6 làm gợi ý để backend PRE-chọn `detectedCardTypeId`. TID rỗng/ngoài scope
  // → backend trả field null/rỗng → CardTypeSelect tự ẩn. Chạy lại khi tid đổi (đổi ảnh → OCR tid khác).
  const billTid = billFields?.tid?.value;
  useEffect(() => {
    if (!billTid) {
      setCardOptions(null);
      setSelectedCardTypeId(null);
      return;
    }
    let cancelled = false;
    void getTidCardOptions(billTid, billFields?.detectedCardScheme, billFields?.detectedBin6).then((r) => {
      if (cancelled) return;
      const opts = r.ok ? r.data : null;
      setCardOptions(opts);
      // Pre-chọn: thẻ nhận-diện > mặc định (Visa-Master) > thẻ ĐẦU (bất biến "cards không rỗng ⟹ có phần tử" —
      // tránh select hiện card[0] mà phí lại tính theo default backend, review MEDIUM #2). null nếu TID ngoài scope.
      setSelectedCardTypeId(opts ? (opts.detectedCardTypeId ?? opts.defaultCardTypeId ?? opts.cards[0]?.cardTypeId ?? null) : null);
    });
    return () => {
      cancelled = true;
    };
    // Phụ thuộc tid + scheme/bin nhận-diện: 2 bill CÙNG TID nhưng khác loại thẻ (Visa vs Napas) phải PRE-chọn lại
    // đúng (review MEDIUM #3 — trước chỉ dep tid nên đổi ảnh cùng TID giữ pre-chọn cũ).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [billTid, billFields?.detectedCardScheme, billFields?.detectedBin6]);

  const parsedAmount = parseGroupedMoneyValue(amountField.value);
  const canSend = parsedAmount != null && parsedAmount > 0;

  // "Hoàn tiền sau phí" (2/8, Admin Demo yêu cầu tường minh: "số tiền hoàn sau phí... nền xanh chữ trắng rõ như
  // số tiền quét được") — GET /v1/me/fee-preview KHÔNG BAO GIỜ lỗi (xem docstring useFeePreview()). B112 (2/8)
  // tách effect debounce ra lib/use-fee-preview.ts (dùng chung với "Sửa" bill).
  const feeState = useFeePreview(billFields?.tid?.value, parsedAmount, selectedCardTypeId ?? undefined);

  // Text hàng "Hoàn tiền" — DÙNG CHUNG cho cả render trên màn hình lẫn ảnh ghép gửi đi (composeBillImage
  // refundText param, xem handleSend()), TRÁNH lệch 2 nơi (đúng bài học "sửa 1 nơi quên nơi khác" rút ra 2/8,
  // xem BUGS_FIXED.md retro) — B112 (2/8) tách hàm ra lib/bill-refund-text.ts (dùng chung với "Sửa" bill).
  const refundText = buildRefundText(parsedAmount, feeState.feePreview);

  // 20/8 (fix bug tiền) — dòng "Hoàn tiền" đang LỖI THỜI so với số tiền hiện tại (preview còn đang tính cho số
  // tiền mới) → CHẶN Gửi để KHÔNG nướng dòng hoàn tiền sai vào ẢNH GHÉP vĩnh viễn. Chỉ chặn khi thật sự đang
  // chờ mạng cho số tiền HIỆN TẠI — TID lạ/không cấu hình phí vẫn trả kết quả tươi (phí 0%/chưa cấu hình), gửi
  // bình thường (xem isRefundTextStale()).
  const feeStale = isRefundTextStale({
    // CÙNG điều kiện truthiness với `useFeePreview` (guard `if (!tid …)`): TID rỗng '' = KHÔNG có TID → hook
    // KHÔNG fetch → nếu ở đây coi '' là "có TID" thì isRefundTextStale kẹt `true` mãi (nút Gửi treo "đang tính
    // phí…"). Dùng `!!…value` để khớp hook.
    hasTid: !!billFields?.tid?.value,
    parsedAmount,
    pending: feeState.pending,
    previewAmount: feeState.previewAmount
  });

  /** Field mở rộng ĐỌC ĐƯỢC ít nhất 1 trong 6 trường (khác dòng "Số tiền", luôn có sẵn vì `canSend` đã đảm
   * bảo) — điều kiện để dựng + gửi bảng ảnh, tránh gửi 1 bảng gần như trống (chỉ "Số tiền" + 7 dòng "Không
   * đọc được") vô nghĩa cho người nhận (yêu cầu tường minh trong brief). */
  function hasAnyExtendedFieldRead(fields: OcrBillPreview): boolean {
    return (
      fields.bankName != null ||
      fields.hkdName != null ||
      fields.tid != null ||
      fields.dateTime != null ||
      fields.batchNumber != null ||
      fields.invoiceNumber != null
    );
  }

  async function handleSend(): Promise<void> {
    // `feeStale` (belt-and-suspenders với nút disabled) — CẤM ghép ảnh khi dòng Hoàn tiền chưa khớp số tiền.
    if (parsedAmount == null || sending || feeStale) return;
    setSending(true);
    try {
      const amountText = `${formatVndGrouped(parsedAmount)}đ`;
      // B106 (2/8, Admin Demo xác nhận LẶP LẠI 3 lần khi test thật: "thay dòng này bằng tên file đã thống nhất")
      // — caption DUY NHẤT của ảnh gửi đi (ghép hay không ghép) ĐỔI từ "Bill: <số tiền>đ" cố định sang mẫu
      // "POS <TênHKD> - <TID> - Lô <SốLô> - <Ngày> <Giờ>" (buildBillCaption(), bill-table-image.ts — CÙNG mẫu
      // đúng logic buildBillFileName() dùng đặt tên file, tránh lệch 2 nơi). Field thiếu → hàm TỰ fallback về
      // "Bill: <số tiền>đ" cũ, không cần xử lý thêm ở đây.
      const amountCaption = billFields
        ? buildBillCaption(billFields.hkdName, billFields.tid, billFields.batchNumber, billFields.dateTime, amountText)
        : `Bill: ${amountText}`;
      // Mặc định: gửi NGUYÊN ảnh bill gốc (tên file giữ nguyên đặt lúc chụp, xem MessageComposer.tsx
      // handleScanBillClick()) — dùng khi KHÔNG có field mở rộng nào đọc được (bảng gần như trống vô nghĩa,
      // tránh ghép) HOẶC ghép ảnh lỗi bên dưới (cực hiếm). `billMeta` GIỮ null trong 2 trường hợp này — KHÔNG
      // có gì để lưu (không billFields, không ranh giới ảnh/bảng để tính imageHeightPx) — tin gửi ra sẽ KHÔNG
      // "Sửa" được sau này (đúng, xem canEditBillMessage() chat-client.ts).
      let sendFile: File = file;
      let billMeta: BillMessageMeta | null = null;
      if (billFields && hasAnyExtendedFieldRead(billFields)) {
        try {
          // B123 (2/8, fix BUG THẬT Admin Demo phát hiện: "cảnh báo mã đóng lô rủi ro CHỈ hiện lúc xem trước rồi
          // biến mất sau khi gửi") — LƯU LẠI VĨNH VIỄN cảnh báo settlementRisk vào ẢNH GHÉP gửi đi (hàng
          // `warning` đỏ, composeBillImage()), KHÔNG chỉ hiện thoáng qua ở BillSettlementRiskBanner (React,
          // TRÊN màn hình preview) như trước đây.
          const composed = await composeBillImage(file, buildBillFieldDisplayRows(billFields), amountText, refundText ?? undefined, billFields.settlementRisk?.message);
          const fileName = buildBillFileName(billFields.hkdName, billFields.tid, billFields.batchNumber, billFields.dateTime, Date.now());
          sendFile = new File([composed.blob], fileName, { type: 'image/jpeg' });
          // LƯU loại thẻ đã chọn (review HIGH #1): để mở "Sửa" sau này khôi phục ĐÚNG thẻ gốc → dòng "Hoàn tiền"
          // KHÔNG bị reset về Visa-Master mặc định (làm lệch giá thực tế của giao dịch gốc).
          billMeta = { billFields, amount: parsedAmount, imageHeightPx: composed.billImageHeightPx, cardTypeId: selectedCardTypeId ?? undefined };
        } catch {
          // Ghép ảnh lỗi (cực hiếm — canvas 2D context không tạo được/ảnh không giải mã được/canvas.toBlob
          // trả null) KHÔNG được chặn luồng gửi — âm thầm fallback về gửi NGUYÊN ảnh gốc (sendFile/billMeta
          // giữ giá trị mặc định = file/null), vẫn có caption số tiền bình thường.
        }
      }
      onConfirm(amountCaption, sendFile, billMeta);
      // NỐI BILL → DOANH SỐ (Admin Demo 21/8): sau khi ảnh bill đã gửi, ghi Lô doanh số 1-dòng cho TID khớp khách
      // + loại thẻ đã chọn. Best-effort, KHÔNG chặn/đợi luồng gửi (recordBillSale không bao giờ ném — lỗi mạng/
      // NO_ACTUAL_SELL_FEE tự nuốt, dòng "Hoàn tiền" trên bill đã báo trạng thái giá bán). Chỉ ghi khi TID KHỚP
      // đúng khách (tidMatched) — TID lạ/không khớp thì backend cũng chặn TID_NOT_IN_AGENT_SCOPE, tránh gọi thừa.
      if (billFields?.tidMatched && billFields.tid?.value && parsedAmount > 0) {
        // Khóa dedup nhiều tầng: số lô/số HĐ (tầng 1) + hash ảnh gốc (tầng 2, chống Lô trùng khi gửi lại cùng ảnh
        // bill không đọc được số lô/HĐ). recordBillSaleWithDupGuard tự hỏi đại lý khi server nghi trùng (tầng 3).
        void recordBillSaleWithDupGuard({
          tid: billFields.tid.value,
          amountBeforeFee: parsedAmount,
          cardTypeId: selectedCardTypeId ?? undefined,
          batchNumber: billFields.batchNumber?.value ?? null,
          invoiceNumber: billFields.invoiceNumber?.value ?? null,
          billImageHash: billFields.billImageHash ?? null
        });
      }
    } finally {
      setSending(false);
    }
  }

  return (
    <Modal title="Quét bill — xem trước" onClose={onCancel} width="max-w-sm">
      <div className="flex flex-col gap-3">
        <img src={previewUrl} alt="Ảnh bill vừa chụp" className="max-h-64 w-full rounded-lg-mac border border-line object-contain" />

        {/* Cảnh báo mã đóng lô rủi ro (1/8, Admin Demo "đóng (95) là... cảnh báo rủi ro hoàn tiền sau", "báo đỏ,
            mức cảnh báo cao nhất", "cảnh báo NGAY khi quét OCR ra thông tin") — đặt NGAY dưới ảnh, TRƯỚC cả
            nhánh ocrState (số tiền), vì đây là cảnh báo GIAN LẬN ưu tiên cao nhất, không phải phụ chú của số
            tiền. B112 (2/8) — TÁCH ra BillFieldsTable.tsx (dùng chung với panel "Sửa" bill đã gửi). */}
        {billFields && <BillSettlementRiskBanner billFields={billFields} />}

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
            {/* Text thuần TUYỆT ĐỐI KHÔNG dangerouslySetInnerHTML — reasons[] từ OCR đọc ảnh do chính đại lý tự
                chụp/tải lên (attacker-influenceable), CÙNG nguyên tắc ReconcileDetailScreen.tsx/ocr-bridge.ts. */}
            <ul className="list-disc space-y-0.5 pl-4">
              {ocrState.reasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
        {ocrState.kind === 'not_found' && <p className="text-xs text-slate-400">Không tự đọc được số tiền từ ảnh, vui lòng nhập tay.</p>}
        {ocrState.kind === 'error' && <p className="text-xs text-danger">{ocrState.message}</p>}

        {/* 6 trường mở rộng (1/8: Bank/tên HKD/TID/Ngày/Giờ/số lô/số hóa đơn) — bảng kẻ ô THẬT (Admin Demo yêu
            cầu tường minh "chỉ bảng kẻ ô đẹp rõ, màu rõ ràng... bảng ô từng trường riêng", tiếp theo "ô cột
            ngày riêng, giờ riêng") thay danh sách text đơn thuần cũ — đồng bộ TRỰC QUAN với bảng ảnh PNG sẽ
            gửi thật (`renderBillTableImage()`, xem `handleSend()`): hàng "Số tiền" nổi bật nền brand đầu
            bảng, 7 hàng còn lại zebra trắng/appbg xen kẽ, viền `border-line` mọi ô. CHỈ HIỂN THỊ (không cho
            sửa tay như số tiền), text THUẦN TUYỆT ĐỐI KHÔNG dangerouslySetInnerHTML (CÙNG nguyên tắc
            reasons[]/rawText — dữ liệu OCR đọc từ ảnh đại lý tự chụp, attacker-influenceable). */}
        {/* B112 (2/8) — TÁCH bảng ra BillFieldsTable.tsx (dùng chung với panel "Sửa" bill đã gửi, giữ ĐÚNG cùng
            classNames/cấu trúc bản gốc, không đổi hiển thị). */}
        {billFields && (
          <BillFieldsTable billFields={billFields} amountDisplay={amountField.value ? `${amountField.value}đ` : '—'} refundText={refundText} />
        )}

        {/* Loại thẻ + giá bán (21/8) — bill quẹt KHÔNG tự nhận diện loại thẻ; chọn đúng loại để dòng "Hoàn tiền"
            tính đúng phí. Ẩn khi TID ngoài scope/chưa cấu hình (CardTypeSelect tự trả null). */}
        <CardTypeSelect options={cardOptions} value={selectedCardTypeId} onChange={setSelectedCardTypeId} />

        <Field label="Số tiền (đ)" required hint="Có thể sửa tay nếu OCR đọc sai hoặc chưa chắc chắn.">
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

        {/* 20/8 — báo rõ vì sao nút Gửi tạm khoá (đang tính phí cho số tiền vừa nhập) — tránh người dùng tưởng
            treo. Chỉ hiện khi số tiền hợp lệ mà preview còn lỗi thời. */}
        {canSend && feeStale && (
          <p className="flex items-center gap-1.5 text-xs text-slate-500">
            <DotsLoader size="sm" /> Đang tính phí hoàn tiền…
          </p>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="neutral" onClick={onCancel}>
            Hủy
          </Button>
          <Button type="button" variant="confirm" onClick={() => void handleSend()} disabled={!canSend || sending || feeStale}>
            {sending ? <DotsLoader size="sm" color="white" /> : 'Gửi'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
