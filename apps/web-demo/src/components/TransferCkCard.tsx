// Bill CHUYỂN KHOẢN (CK) trong phòng chat (1/9, Admin Demo "cấm text lộn xộn") — THAY ảnh-thô+caption nhiều dòng
// bằng CARD 2 cột: ẢNH bill bên TRÁI (object-contain, bấm mở lightbox) · BẢNG THAM SỐ bên PHẢI chia Ô rõ từng
// phần (Loại · Số tiền · Ngày · Mã GD) như card review lúc OCR. Dữ liệu lấy từ `message.transferCk` (parse ở
// chat-client.ts parseTransferCkMeta() từ metadataJson backend ocr-send-service.ts). Mobile (<640px): 2 phần
// XẾP DỌC gọn (flex-col), KHÔNG tràn khung bong bóng 390px. TÁI DÙNG AttachmentImage (fetch blob có CSRF) +
// downloadAttachment/shareAttachment sẵn có — KHÔNG tự viết lại luồng tải/chia sẻ ảnh.
import { ArrowLeftRight, Download, Share2, CheckCircle2, XCircle } from 'lucide-react';
import { FieldIcon } from '../lib/brand-icons';
import type { JSX } from 'react';
import type { ChatMessage, TransferCkKind } from '../mock-data/types';
import { AttachmentImage, isRealImageUrl } from './ChatBubble';
import { downloadAttachment, shareAttachment } from '../lib/attachment-blob';

/** Nhãn tiếng Việt cho từng loại bill CK (khớp thuật ngữ nghiệp vụ đại lý/NĐT hiện dùng ở OcrSendScreen). */
const KIND_LABEL_VI: Record<TransferCkKind, string> = {
  REFUND: 'Hoàn tiền đại lý',
  DEALER_REFUND_OVER: 'Đại lý hoàn tạm ứng trong ngày',
  ADVANCE: 'Đại lý ứng trước',
  INVESTOR_ADVANCE: 'Tạm ứng nhà đầu tư',
  INVESTOR_REPAYMENT: 'NĐT hoàn thừa tạm ứng'
};

/** Tông màu ô "Loại" — hoàn/ứng bình thường = brand xanh; các bill "hoàn thừa" (tiền chảy NGƯỢC về SigMa) = hổ
 *  phách để phân biệt bằng mắt. */
const KIND_TONE: Record<TransferCkKind, string> = {
  REFUND: 'border-brand/30 bg-brand-tint text-brand-deep',
  DEALER_REFUND_OVER: 'border-amber-300 bg-amber-50 text-amber-700',
  ADVANCE: 'border-brand/30 bg-brand-tint text-brand-deep',
  INVESTOR_ADVANCE: 'border-brand/30 bg-brand-tint text-brand-deep',
  INVESTOR_REPAYMENT: 'border-amber-300 bg-amber-50 text-amber-700'
};

const fmtVnd = (n: number): string => Math.round(Math.abs(n)).toLocaleString('vi-VN') + ' đ';

/** Ngày hiển thị chuẩn NGÀY/THÁNG/NĂM (Admin Demo 1/9 "định dạng bill bị ngược năm-tháng-ngày"). billDate backend có
 *  thể là ISO "YYYY-MM-DD" (hoặc "YYYY-MM-DDT...") → ĐẢO thành "DD/MM/YYYY". Nếu đã đúng "dd/MM/yyyy" hoặc dạng
 *  khác thì GIỮ NGUYÊN (không phá). */
export function fmtBillDate(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim());
  return m ? `${m[3]}/${m[2]}/${m[1]}` : raw.trim();
}

/** Rút gọn mã GD `ckTxnKey` (backend dạng `ck|ref|FT24...` / `ck|hash|<sha>` / `ck|nat|...`) — bỏ tiền tố
 *  `ck|<loại>|`, mã còn lại quá dài (hash) thì cắt còn 16 ký tự đầu + "…". Hiển thị để đối chiếu, KHÔNG dùng
 *  làm khóa nghiệp vụ ở UI. */
function shortTxnKey(key: string): string {
  const stripped = key.replace(/^ck\|(ref|hash|nat)\|/i, '');
  return stripped.length > 18 ? `${stripped.slice(0, 16)}…` : stripped;
}

/** 1 Ô tham số (nhãn nhỏ trên, giá trị dưới) — viền/nền nhạt như card review OCR. */
function ParamCell({ label, children, valueClass }: { label: string; children: React.ReactNode; valueClass?: string }): JSX.Element {
  return (
    <div className="rounded-lg border border-line bg-appbg px-2.5 py-1.5">
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-slate-400"><FieldIcon label={label} className="h-3 w-3" />{label}</div>
      <div className={'mt-0.5 text-slate-700 ' + (valueClass ?? 'text-sm')}>{children}</div>
    </div>
  );
}

export function TransferCkCard({
  message,
  onImageClick
}: {
  message: ChatMessage;
  onImageClick?: (message: ChatMessage) => void;
}): JSX.Element {
  const ck = message.transferCk!;
  const hasImage = isRealImageUrl(message.imageUrl);

  const handleDownload = (): void => {
    if (!isRealImageUrl(message.imageUrl)) return;
    downloadAttachment(message.imageUrl, `bill-ck-${message.id}.jpg`, { isImage: true }).catch((err) => {
      console.warn('[TransferCkCard] Không tải được ảnh:', err);
    });
  };
  const handleShare = (): void => {
    if (!isRealImageUrl(message.imageUrl)) return;
    shareAttachment(message.imageUrl, `bill-ck-${message.id}.jpg`).catch((err) => {
      console.warn('[TransferCkCard] Không chia sẻ được ảnh:', err);
    });
  };

  // Nền NỔI 3D tách nền phòng chat — ĐỒNG NHẤT PosBillCard (Admin Demo 1/9 "card CK+POS lẫn nền, nổi 3D ~15%").
  // FIX GIẬT 11/9 — `w-full max-w-[460px]` → `w-[460px] max-w-full`: card xin THẲNG bề ngang ngay từ lúc ảnh chưa
  // về (bubble cha shrink-to-fit làm card bị bóp hẹp rồi phình ra khi ảnh về = giật ngang). CÙNG lý do/cách sửa
  // PosBillCard.tsx (xem comment ở đó + đo harness-chat-image-cls.ts).
  return (
    <div className="w-[460px] max-w-full overflow-hidden rounded-xl border border-[#b8c4d6] bg-gradient-to-b from-white to-[#f5f8fc] shadow-[0_14px_32px_-8px_rgba(15,23,42,0.40),0_4px_10px_-2px_rgba(15,23,42,0.22)] ring-1 ring-inset ring-white/50">
      {/* Tiêu đề card */}
      <div className="flex items-center gap-1.5 border-b border-line bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand-deep">
        <ArrowLeftRight className="h-3.5 w-3.5" />
        Bill chuyển khoản
      </div>

      {/* Thân card: ẢNH trái · BẢNG tham số phải — CAO BẰNG NHAU (items-stretch, Admin Demo 1/9 "chiều cao blog=ảnh").
          Ảnh rộng ~46% (+20% so bản cũ w-40), object-contain căn giữa, nền lấp. Mobile (<640px) xếp DỌC gọn. */}
      {/* NGANG LUÔN (Admin Demo 1/9 "bill CK cũ vẫn blog dọc"): bỏ gate sm: → màn hẹp (APK) không xếp dọc nữa. */}
      <div className="flex flex-row items-stretch">
        {/* ẢNH bill — bấm mở lightbox; 2 nút Tải/Chia sẻ overlay góc trên-phải. h-full lấp bằng chiều cao cột phải. */}
        <div className="relative shrink-0 bg-slate-50 w-[40%] flex items-center justify-center min-h-[168px]">
          {hasImage ? (
            <>
              {/* Admin Demo 2/9 "card bill trong chat bị THU HẸP hết": trả lại ảnh in-flow (ảnh dọc tự cao → card TO
                  đọc được).
                  FIX GIẬT 11/9: reserveDims — placeholder giữ chỗ đúng aspect-ratio THẬT (image-dims-cache.ts),
                  h-[220px] chỉ còn fallback khi máy chưa từng thấy ảnh. CÙNG cách PosBillCard.tsx. */}
              <button type="button" onClick={() => onImageClick?.(message)} className="flex h-full w-full items-center justify-center" aria-label="Xem ảnh bill">
                <AttachmentImage
                  url={message.imageUrl!}
                  alt="Bill chuyển khoản"
                  className="max-h-full w-full rounded-none object-contain"
                  loadingClassName="h-[220px] w-full animate-pulse bg-slate-200"
                  failedClassName="flex h-[220px] w-full items-center justify-center bg-slate-200 text-xs text-slate-500"
                  reserveDims
                />
              </button>
              <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleShare(); }}
                  aria-label="Chia sẻ ảnh"
                  title="Chia sẻ ảnh"
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-black/45 text-white shadow-soft transition hover:bg-black/65"
                >
                  <Share2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); handleDownload(); }}
                  aria-label="Tải ảnh"
                  title="Tải ảnh"
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-black/45 text-white shadow-soft transition hover:bg-black/65"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              </div>
            </>
          ) : (
            <div className="flex h-full min-h-[168px] w-full items-center justify-center bg-slate-200 text-xs text-slate-500">
              Không có ảnh bill
            </div>
          )}
        </div>

        {/* BẢNG THAM SỐ — mỗi tham số 1 Ô riêng, KHÔNG dồn 1 đoạn text. */}
        <div className="flex flex-1 flex-col gap-1.5 p-2.5">
          <div className={'rounded-lg border px-2.5 py-1.5 ' + KIND_TONE[ck.kind]}>
            <div className="text-[10px] font-medium uppercase tracking-wide opacity-70">Loại</div>
            <div className="mt-0.5 text-sm font-semibold">{KIND_LABEL_VI[ck.kind]}</div>
          </div>

          {/* Tên đại lý/NĐT (Admin Demo 1/9 "hiện tên trên card"): ưu tiên partyName; else Gửi → Nhận (từ OCR). */}
          {(ck.partyName || ck.senderName || ck.receiverName) && (
            <ParamCell label="Đối tác" valueClass="text-sm font-medium break-words">
              {ck.partyName ?? `${ck.senderName ?? '—'} → ${ck.receiverName ?? '—'}`}
            </ParamCell>
          )}

          {/* SỐ TIỀN nổi bật (Admin Demo 1/9 "tiền nổi bật") — block riêng, chữ to, màu brand, tách khỏi các ô nhỏ. */}
          <div className="rounded-lg border border-brand/40 bg-brand-tint px-2.5 py-2">
            <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-brand-deep/70"><FieldIcon label="Số tiền" className="h-3 w-3" />Số tiền</div>
            <div className="mt-0.5 text-xl font-extrabold tabular-nums text-brand-deep">{fmtVnd(ck.amount)}</div>
          </div>

          {ck.billDate && <ParamCell label="Ngày">{fmtBillDate(ck.billDate)}</ParamCell>}

          {ck.ckTxnKey && (
            <ParamCell label="Mã GD" valueClass="text-xs font-mono break-all">
              {shortTxnKey(ck.ckTxnKey)}
            </ParamCell>
          )}

          {/* Trạng thái chuyển khoản (Admin Demo 1/9) — thành công = xanh + tích; thất bại = đỏ + X. Card CK chỉ post
              sau khi ghi GD thành công nên mặc định success; 'failed' để dành cho post-lỗi/partial về sau. */}
          {ck.status === 'failed' ? (
            <div className="flex items-center gap-1.5 rounded-lg border border-red-300 bg-red-50 px-2.5 py-1.5 text-sm font-semibold text-red-700">
              <XCircle className="h-4 w-4 shrink-0" /> Chuyển khoản thất bại
            </div>
          ) : (
            <div className="flex items-center gap-1.5 rounded-lg border border-emerald-300 bg-emerald-50 px-2.5 py-1.5 text-sm font-semibold text-emerald-700">
              <CheckCircle2 className="h-4 w-4 shrink-0" /> Đã chuyển khoản thành công
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
