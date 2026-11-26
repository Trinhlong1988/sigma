// SIGMA Phase 1+ bước 4 (24/7) — nối THẬT vào bot-api (GET/POST /v1/me/lo/:loId..., apps/bot-api/src/
// routes/me.ts), thay mock RECONCILE_DETAIL của Phase 0. CHƯA có pipeline OCR thật (đúng phạm vi kế hoạch
// mục D.4 — "input coi như đã OCR sẵn"), nên thêm form nhập tay summary + bill lẻ để gọi /reconcile thật —
// đây là cách thay thế tạm cho OCR chưa có, KHÔNG mở rộng phạm vi nghiệp vụ.
import { useEffect, useRef, useState, type ChangeEvent, type JSX } from 'react';
import { AlertTriangle, Camera, CheckCircle2, Plus, Trash2, XCircle } from 'lucide-react';
import { FraudFlagBadge } from '../components/FraudFlagBadge';
import { StatusBadge } from '../components/StatusBadge';
import { Button } from '../components/Button';
import { BackButton } from '../components/BackButton';
import { DotsLoader } from '../components/DotsLoader';
import { Field, inputCls } from '../components/Field';
import { getMyLoDetail, previewLoOcr, reconcileMyLo, type MyLoDetail, type MyLoViolation, type OcrBillPreview, type ReconcileResultDto } from '../lib/agent-api-client';
import { deriveOcrPreviewUiState, type OcrPreviewUiState } from '../lib/ocr-preview-ui';
import { parseGroupedMoneyValue, useGroupedMoneyField } from '../lib/grouped-money-input';
import { buildBillFieldDisplayRows, describeTidMatchWarning } from '../lib/ocr-bill-fields-display';
import type { FraudFlag, FraudRuleCode, FraudSeverity } from '../mock-data/types';

/** VND, nhóm 3 số bằng dấu chấm — hiển thị breakdown "sau khi trừ phí" (vấn đề 4, Admin Demo 1/8). Field
 * amountBeforeFee/feeApplied/amountAfterFee đã do BACKEND tính sẵn (fee-quote.ts quoteRow(), gọi lúc tạo Lô —
 * xem lo-service.ts createLo) — hàm này CHỈ format hiển thị, KHÔNG tính lại công thức phí ở frontend. */
function fmtVnd(v: string | number): string {
  return Number(v).toLocaleString('vi-VN');
}

// Map mã Rule THẬT (lo-service.ts) → chữ cái đơn A-F dùng cho FraudFlagBadge/FRAUD_RULE_LABEL. Severity
// KHÔNG có ở response server (chỉ có message) — ASSUMPTION hiển thị (build 24/7, chưa LEAD chốt riêng):
// A/E/F = vi phạm ngưỡng cứng/mẫu gian lận rõ ràng → "nghiêm trọng"; B/C/D = tín hiệu mềm cần xem xét thêm
// → "nhẹ". Thuần hiển thị, KHÔNG ảnh hưởng nghiệp vụ (status CONFIRMED/MISMATCH đã do server quyết).
const RULE_DISPLAY_MAP: Record<MyLoViolation['rule'], { code: FraudRuleCode; severity: FraudSeverity }> = {
  A_MAX_AMOUNT: { code: 'A', severity: 'nghiem_trong' },
  B_MAX_SWIPES_PER_DAY: { code: 'B', severity: 'nhe' },
  C_ROUND_AMOUNT: { code: 'C', severity: 'nhe' },
  D_MIN_GAP: { code: 'D', severity: 'nhe' },
  E_REPEATED_AMOUNT_NEARBY: { code: 'E', severity: 'nghiem_trong' },
  F_DAILY_TOTAL_PER_TID: { code: 'F', severity: 'nghiem_trong' }
};

function toFraudFlag(v: MyLoViolation): FraudFlag {
  const m = RULE_DISPLAY_MAP[v.rule];
  return { rule: m?.code ?? 'A', severity: m?.severity ?? 'nhe', description: v.message };
}

interface BillDraft {
  amount: string;
  cardLast4: string;
  swipeAt: string; // datetime-local value
}

function emptyBillDraft(): BillDraft {
  return { amount: '', cardLast4: '', swipeAt: new Date().toISOString().slice(0, 16) };
}

export function ReconcileDetailScreen({ loId, onBack }: { loId: string; onBack: () => void }): JSX.Element {
  const loIdNum = Number(loId);

  const [detail, setDetail] = useState<MyLoDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function reload(): void {
    if (!Number.isInteger(loIdNum)) {
      setError('Mã Lô không hợp lệ.');
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    getMyLoDetail(loIdNum).then((r) => {
      if (!r.ok) setError(r.message);
      else setDetail(r.data);
      setLoading(false);
    });
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loId]);

  // Form đối soát nhập tay (thay OCR chưa có) — chỉ hiện khi Lô còn ở trạng thái đối soát được (PENDING/MISMATCH).
  // summaryAmount: live-grouping + chặn ký tự lạ (vấn đề 2+3, Admin Demo 1/8) qua useGroupedMoneyField() —
  // xem lib/grouped-money-input.ts cho lý do KHÔNG dùng silent-strip kiểu GLB B87 ở đây.
  const summaryAmountField = useGroupedMoneyField('');
  const [bankLoNumber, setBankLoNumber] = useState('');
  const [bills, setBills] = useState<BillDraft[]>([emptyBillDraft()]);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<ReconcileResultDto | null>(null);

  // OCR preview (31/7 tiếp B71-part2) — CHỈ hỗ trợ điền sẵn "Tổng tiền OCR (bill tổng kết)", KHÔNG đổi luồng
  // handleSubmit()/reconcileMyLo() ở dưới. Toàn bộ logic quyết định nhánh nằm ở deriveOcrPreviewUiState()
  // (lib/ocr-preview-ui.ts, test thuần riêng) — ở đây chỉ gọi previewLoOcr() rồi set state theo kết quả.
  const ocrFileInputRef = useRef<HTMLInputElement>(null);
  const [ocrUi, setOcrUi] = useState<OcrPreviewUiState>({ kind: 'idle' });
  // 6 trường mở rộng (1/8, TID/tên HKD/ngày giờ/số lô/số hóa đơn/tên ngân hàng) — ĐỘC LẬP với ocrUi (vốn chỉ
  // quyết định nhánh SỐ TIỀN), CÙNG pattern OcrBillPreview.tsx (chat). CHỈ HIỂN THỊ, không cho sửa tay.
  const [billFields, setBillFields] = useState<OcrBillPreview | null>(null);

  async function handleOcrFileChange(e: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = e.target.files?.[0] ?? null;
    e.target.value = ''; // reset để chọn lại ĐÚNG file cũ vẫn kích hoạt onChange lần sau
    if (!file) return;
    setOcrUi({ kind: 'loading' });
    setBillFields(null);
    const r = await previewLoOcr(loIdNum, file);
    const state = deriveOcrPreviewUiState(r);
    if (state.kind === 'autofilled') {
      summaryAmountField.setValue(String(state.parsedAmount));
    }
    setOcrUi(state);
    setBillFields(r.ok ? r.data : null);
  }

  async function handleSubmit(): Promise<void> {
    setSubmitError(null);
    const amount = parseGroupedMoneyValue(summaryAmountField.value) ?? NaN;
    if (!Number.isFinite(amount) || amount <= 0) {
      setSubmitError('Tổng tiền OCR (bill tổng kết) phải là số hợp lệ.');
      return;
    }
    const individualBills = [];
    for (const b of bills) {
      const a = Number(b.amount.replace(/[.,\s]/g, ''));
      if (!Number.isFinite(a) || a <= 0) {
        setSubmitError('Mỗi bill lẻ phải có số tiền hợp lệ.');
        return;
      }
      if (!b.swipeAt) {
        setSubmitError('Mỗi bill lẻ phải có thời điểm quẹt.');
        return;
      }
      individualBills.push({
        amount: a,
        cardLast4: b.cardLast4.trim() || null,
        swipeAt: new Date(b.swipeAt).toISOString()
      });
    }
    setSubmitting(true);
    const r = await reconcileMyLo(loIdNum, {
      summaryOcr: { amount, bankReportedLoNumber: bankLoNumber.trim() ? Number(bankLoNumber.trim()) : null },
      individualBills
    });
    setSubmitting(false);
    if (!r.ok) {
      setSubmitError(r.message);
      return;
    }
    setLastResult(r.data);
    reload();
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-slate-400">
        <DotsLoader /> Đang tải chi tiết Lô...
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="h-full overflow-auto bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <BackButton className="mb-3" label="Quay lại danh sách Lô" onClick={onBack} />
        <p className="text-sm text-danger">{error ?? 'Không tải được chi tiết Lô.'}</p>
      </div>
    );
  }

  const reconcilable = detail.status === 'PENDING' || detail.status === 'MISMATCH';

  return (
    <div className="h-full overflow-auto bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <BackButton className="mb-3" label="Quay lại danh sách Lô" onClick={onBack} />

      <div className="mb-4 flex items-center justify-between">
        <div>
          <h1 className="text-base font-bold text-slate-800">Đối soát Lô #{detail.id}</h1>
          <p className="text-xs text-slate-400">{new Date(detail.createdAt).toLocaleString('vi-VN')}</p>
        </div>
        <StatusBadge entity="lo" code={detail.status} />
      </div>

      <div className="mb-4 space-y-2">
        <p className="text-sm font-semibold text-slate-700">Các dòng trong Lô</p>
        {/* Bảng tính sau khi trừ phí (vấn đề 4, Admin Demo 1/8): Gốc → Phí → Còn lại thực nhận, ĐÚNG số liệu
            backend đã tính sẵn lúc tạo Lô (quoteRow(), fee-quote.ts) — KHÔNG tính lại công thức phí ở đây. */}
        {detail.rows.map((r) => {
          const before = Number(r.amountBeforeFee);
          const fee = Number(r.feeApplied);
          const feePct = before > 0 ? (fee / before) * 100 : 0;
          return (
            <div key={r.id} className="rounded-lg-mac border border-line p-3 shadow-soft">
              <div className="mb-1.5 flex items-center justify-between text-sm">
                <span className="text-slate-600">TID #{r.tidId}</span>
                <span className="font-semibold text-slate-800">{fmtVnd(r.amountAfterFee)} đ</span>
              </div>
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-400">
                <span>Gốc {fmtVnd(before)} đ</span>
                <span>→</span>
                <span>
                  Phí {feePct.toFixed(2)}% ({fmtVnd(fee)} đ)
                </span>
                <span>→</span>
                <span className="font-medium text-slate-600">Còn lại {fmtVnd(r.amountAfterFee)} đ</span>
              </div>
            </div>
          );
        })}
        {detail.rows.length > 1 && (
          <div className="rounded-lg-mac border border-line bg-appbg p-3 text-sm">
            <div className="flex items-center justify-between font-semibold text-slate-700">
              <span>Tổng cả Lô</span>
              <span>{fmtVnd(detail.expectedTotalAmount)} đ</span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-slate-400">
              <span>Tổng gốc {fmtVnd(detail.rows.reduce((s, r) => s + Number(r.amountBeforeFee), 0))} đ</span>
              <span>→</span>
              <span>Tổng phí {fmtVnd(detail.rows.reduce((s, r) => s + Number(r.feeApplied), 0))} đ</span>
              <span>→</span>
              <span className="font-medium text-slate-600">Còn lại {fmtVnd(detail.expectedTotalAmount)} đ</span>
            </div>
          </div>
        )}
      </div>

      {/* AUDIT 24/7 (MEDIUM, đã fix): MISMATCH có thể do lệch tam giác/trùng số lô mà KHÔNG kèm violations[]
          nào — PHẢI hiện lý do riêng, không để trống gây hiểu nhầm "khớp hoàn toàn". */}
      {detail.status === 'MISMATCH' && detail.violations.length === 0 && (detail.triangulation || detail.loNumberReuse?.violated) && (
        <div className="mb-4 space-y-1 rounded-lg-mac border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
          <p className="font-semibold">Lệch — không phải do vi phạm Quy tắc A-F:</p>
          {detail.triangulation && detail.triangulation.blame !== 'NONE' && <p>{detail.triangulation.message}</p>}
          {detail.loNumberReuse?.violated && <p>{detail.loNumberReuse.message}</p>}
        </div>
      )}
      {detail.violations.length === 0 && detail.status !== 'PENDING' && detail.status !== 'MISMATCH' && (
        <div className="mb-4 rounded-lg-mac border border-line bg-appbg p-6 text-center text-sm text-slate-400">
          Lô này đối soát khớp hoàn toàn — không có cờ cảnh báo Quy tắc A-F.
        </div>
      )}
      {detail.violations.length > 0 && (
        <div className="mb-4 space-y-2">
          <p className="text-sm font-semibold text-slate-700">Cờ cảnh báo (Quy tắc A-F)</p>
          <div className="flex flex-wrap gap-2">
            {detail.violations.map((v, i) => (
              <FraudFlagBadge key={i} flag={toFraudFlag(v)} />
            ))}
          </div>
        </div>
      )}

      {detail.bills.length > 0 && (
        <div className="mb-4 space-y-1">
          <p className="text-sm font-semibold text-slate-700">Bill lẻ đã ghi nhận</p>
          {detail.bills.map((b) => (
            <div key={b.id} className="flex items-center justify-between rounded-md border border-line px-3 py-1.5 text-xs text-slate-600">
              <span>•••• {b.cardLast4 ?? '----'}</span>
              <span>{new Date(b.swipeAt).toLocaleString('vi-VN')}</span>
              <span className="font-medium text-slate-800">{Number(b.ocrAmount).toLocaleString('vi-VN')} đ</span>
            </div>
          ))}
        </div>
      )}

      {lastResult && (
        <div
          className={
            'mb-4 rounded-lg-mac border p-3 text-sm ' +
            (lastResult.status === 'CONFIRMED' ? 'border-success/30 bg-success/5 text-success' : 'border-danger/30 bg-danger/5 text-danger')
          }
        >
          <div className="mb-1 flex items-center gap-1.5 font-semibold">
            {lastResult.status === 'CONFIRMED' ? <CheckCircle2 className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}
            Kết quả đối soát vừa gửi: {lastResult.status === 'CONFIRMED' ? 'KHỚP — đã xác nhận' : 'LỆCH — cần kiểm tra'}
          </div>
          {lastResult.triangulation.blame !== 'NONE' && <p className="text-xs">{lastResult.triangulation.message}</p>}
          {lastResult.loNumberReuse.violated && <p className="text-xs">{lastResult.loNumberReuse.message}</p>}
        </div>
      )}

      {reconcilable && (
        <div className="rounded-lg-mac border border-line p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">
            Đối soát Lô (nhập tay thay OCR — chưa có pipeline OCR thật, xem ghi chú kế hoạch mục D.4)
          </p>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <Field label="Tổng tiền OCR (bill tổng kết)">
              <input
                ref={summaryAmountField.inputRef}
                value={summaryAmountField.value}
                onChange={summaryAmountField.onChange}
                placeholder="0"
                inputMode="numeric"
                className={inputCls}
              />
              {summaryAmountField.error && <p className="mt-1 text-xs text-danger">{summaryAmountField.error}</p>}
            </Field>
            <Field label="Số lô ngân hàng (tùy chọn)">
              <input value={bankLoNumber} onChange={(e) => setBankLoNumber(e.target.value)} placeholder="VD: 501" inputMode="numeric" className={inputCls} />
            </Field>
          </div>

          {/* OCR preview (31/7 tiếp B71-part2) — input file ẩn, trigger qua nút thật bên dưới (CÙNG pattern
              MessageComposer.tsx). accept="image/*" chỉ gợi ý trình chọn file trên thiết bị — sniff magic-bytes
              THẬT vẫn nằm ở server (ocr-bridge.ts), không tin riêng thuộc tính này. */}
          <input
            ref={ocrFileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => void handleOcrFileChange(e)}
          />
          <div className="mb-3 flex items-center gap-2">
            <button
              type="button"
              onClick={() => ocrFileInputRef.current?.click()}
              disabled={ocrUi.kind === 'loading'}
              className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs font-medium text-slate-600 hover:border-brand hover:text-brand disabled:cursor-not-allowed disabled:opacity-50"
            >
              {ocrUi.kind === 'loading' ? <DotsLoader size="sm" /> : <Camera className="h-3.5 w-3.5" />}
              {ocrUi.kind === 'loading' ? 'Đang đọc ảnh...' : 'Chụp/Tải ảnh bill'}
            </button>
          </div>
          {/* Cảnh báo mã đóng lô rủi ro (1/8, CÙNG nguyên tắc OcrBillPreview.tsx khung chat — "cảnh báo NGAY
              khi quét OCR ra thông tin", ĐẶT TRƯỚC nhánh ocrUi (số tiền) vì đây là cảnh báo gian lận ưu tiên
              cao nhất). Bill không vi phạm rule → báo "hợp lệ" theo yêu cầu tường minh Admin Demo. */}
          {billFields && billFields.settlementRisk && (
            <div className="mb-3 flex items-start gap-1.5 rounded-lg-mac border-2 border-danger bg-danger/10 p-2.5 text-xs font-semibold text-danger">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{billFields.settlementRisk.message}</span>
            </div>
          )}
          {billFields && !billFields.settlementRisk && (
            <p className="mb-3 flex items-center gap-1 text-xs font-medium text-success">Bill hợp lệ — không phát hiện mã rủi ro đóng lô.</p>
          )}
          {ocrUi.kind === 'autofilled' && (
            <p className="mb-3 text-xs font-medium text-success">Đã tự điền từ ảnh, vui lòng kiểm tra lại.</p>
          )}
          {ocrUi.kind === 'needs_review' && (
            <div className="mb-3 space-y-1 rounded-lg-mac border border-danger/30 bg-danger/5 p-2.5 text-xs text-danger">
              <p className="font-semibold">Không tự điền được — vui lòng tự nhập/kiểm tra tay:</p>
              {/* Text thuần TUYỆT ĐỐI KHÔNG dangerouslySetInnerHTML — reasons[] bắt nguồn từ OCR đọc ảnh đại lý
                  tự chụp/tải lên (attacker-influenceable, xem ocr-bridge.ts comment OcrAmountPreview). */}
              <ul className="list-disc space-y-0.5 pl-4">
                {ocrUi.reasons.map((reason, i) => (
                  <li key={i}>{reason}</li>
                ))}
              </ul>
            </div>
          )}
          {ocrUi.kind === 'not_found' && (
            <p className="mb-3 text-xs text-slate-400">Không tự đọc được số tiền từ ảnh, vui lòng nhập tay.</p>
          )}
          {ocrUi.kind === 'error' && <p className="mb-3 text-xs text-danger">{ocrUi.message}</p>}

          {/* 6 trường mở rộng (1/8: Bank/tên HKD/TID/ngày giờ quẹt/số lô/số hóa đơn) — CHỈ HIỂN THỊ (không cho
              sửa tay như số tiền), text THUẦN TUYỆT ĐỐI KHÔNG dangerouslySetInnerHTML (CÙNG nguyên tắc
              rawText/reasons[] — dữ liệu OCR đọc từ ảnh đại lý tự chụp/tải lên). */}
          {billFields && (
            <div className="mb-3 space-y-1 rounded-lg-mac border border-line bg-slate-50 p-2.5 text-xs">
              {buildBillFieldDisplayRows(billFields).map((row) => (
                <p key={row.key} className="flex justify-between gap-2">
                  <span className="text-slate-500">{row.label}</span>
                  <span className={row.muted ? 'text-slate-400' : 'font-medium text-slate-700'}>{row.text}</span>
                </p>
              ))}
              {describeTidMatchWarning(billFields) && (
                <p className="flex items-center gap-1 pt-1 text-amber-600">
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {describeTidMatchWarning(billFields)}
                </p>
              )}
            </div>
          )}

          <p className="mb-2 text-xs font-semibold uppercase text-slate-500">Bill lẻ</p>
          <div className="space-y-2">
            {bills.map((b, idx) => (
              <div key={idx} className="grid grid-cols-[1fr_1fr_1fr_auto] items-end gap-2">
                <Field label="Số tiền">
                  <input
                    value={b.amount}
                    onChange={(e) => setBills((prev) => prev.map((x, i) => (i === idx ? { ...x, amount: e.target.value } : x)))}
                    placeholder="0"
                    inputMode="numeric"
                    className={inputCls}
                  />
                </Field>
                <Field label="4 số cuối thẻ">
                  <input
                    value={b.cardLast4}
                    onChange={(e) => setBills((prev) => prev.map((x, i) => (i === idx ? { ...x, cardLast4: e.target.value } : x)))}
                    placeholder="1234"
                    maxLength={4}
                    className={inputCls}
                  />
                </Field>
                <Field label="Thời điểm quẹt">
                  <input
                    type="datetime-local"
                    value={b.swipeAt}
                    onChange={(e) => setBills((prev) => prev.map((x, i) => (i === idx ? { ...x, swipeAt: e.target.value } : x)))}
                    className={inputCls}
                  />
                </Field>
                <button
                  onClick={() => setBills((prev) => prev.filter((_, i) => i !== idx))}
                  disabled={bills.length <= 1}
                  className="mb-0.5 rounded-md border border-line p-2 text-slate-400 hover:text-danger disabled:opacity-30"
                  title="Xóa bill này"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <button
            onClick={() => setBills((prev) => [...prev, emptyBillDraft()])}
            className="mt-2 flex items-center gap-1.5 text-xs font-medium text-brand hover:text-brand-hover"
          >
            <Plus className="h-3.5 w-3.5" /> Thêm bill lẻ
          </button>

          {submitError && <p className="mt-3 text-sm text-danger">{submitError}</p>}
          <Button onClick={handleSubmit} disabled={submitting} className="mt-3 w-full">
            {submitting ? 'Đang đối soát...' : 'Chạy đối soát'}
          </Button>
        </div>
      )}
    </div>
  );
}
