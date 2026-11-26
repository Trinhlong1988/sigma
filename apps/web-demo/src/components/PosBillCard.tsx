// Bill POS trong phòng chat (Admin Demo 1/9 "bill POS và CK đều phải bố cục NGANG, đồng nhất; sửa cả bill đã render
// dọc thành ngang; gửi đại lý và NĐT phải đồng nhất") — THAY nhánh ảnh-ghép-DỌC (composeBillImage baked) bằng CARD
// 2 cột GIỐNG HỆT TransferCkCard: ẢNH bill bên TRÁI (object-contain, bấm mở lightbox) · BẢNG THAM SỐ bên PHẢI chia
// Ô rõ từng phần (Loại · Khách · Số tiền · Lô · Mã bill). Dữ liệu ĐỌC TỪ CAPTION (`message.text`, mẫu backend
// "🧾 Bill {TID} · [HKD tên ·] {số tiền}đ · lô {N}") — KHÔNG cần sửa server, KHÔNG cần structured-meta, nên áp
// được cho CẢ bill CŨ đã gửi (chúng đều có caption này). Cùng component → phòng đại lý và phòng NĐT render Y HỆT.
// TÁI DÙNG AttachmentImage (fetch blob có CSRF) + downloadAttachment/shareAttachment như TransferCkCard — KHÔNG
// tự viết lại luồng tải/chia sẻ ảnh.
import { Receipt, Download, Share2, Pencil } from 'lucide-react';
import { FieldIcon } from '../lib/brand-icons';
import { useState, type JSX } from 'react';
import type { ChatMessage } from '../mock-data/types';
import { AttachmentImage, isRealImageUrl } from './ChatBubble';
import { downloadAttachment, shareAttachment } from '../lib/attachment-blob';
import { BillParamEditModal } from './BillParamEditModal';

/** Dữ liệu bill POS. `null` = KHÔNG phải bill POS (thiếu số tiền) → giữ render ảnh cũ. Bank/dateTime/feeLabel/feePct
 *  CHỈ có khi lấy từ `message.posBillMeta` (server gắn) — bill CŨ (parse caption) không có → các Ô đó tự ẩn. */
export interface ParsedPosBill { tid?: string; amount: number; lo?: string; hkd?: string; bank?: string; dateTime?: string; feeLabel?: string; feePct?: number; netLabel?: string; netAmount?: number; title?: string; ref?: string; hideEdit?: boolean; voidAmount?: number; voidCount?: number }

/** Parse caption bill POS (mẫu backend "🧾 Bill {TID} · [HKD tên ·] {số tiền}đ · lô {N}"). Cả 2 dạng có/không tên
 *  HKD đều đọc được. Số tiền bắt buộc (đó là dữ liệu chính) — không có → trả `null` để KHÔNG chuyển sang card. */
export function parsePosBill(text?: string): ParsedPosBill | null {
  if (!text || !/bill/i.test(text)) return null;
  const amountM = /([\d.]+)\s*đ/.exec(text);
  if (!amountM) return null;
  const amount = Number(amountM[1].replace(/\./g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const tid = /bill\s+(\d+)/i.exec(text)?.[1];
  const lo = /lô\s+(\d+)/i.exec(text)?.[1];
  const hkd = /·\s*(HKD[^·]+?)\s*·/i.exec(text)?.[1]?.trim();
  return { tid, amount, lo, hkd };
}

const fmtVnd = (n: number): string => Math.round(Math.abs(n)).toLocaleString('vi-VN') + ' đ';

/** 1 Ô tham số (nhãn nhỏ trên, giá trị dưới) — GIỐNG HỆT ParamCell của TransferCkCard để đồng nhất bằng mắt. */
function ParamCell({ label, children, valueClass, bank }: { label: string; children: React.ReactNode; valueClass?: string; bank?: string | null }): JSX.Element {
  return (
    <div className="rounded-lg border border-line bg-appbg px-2.5 py-1.5">
      {/* Icon brand chung (brand-icons.tsx) đứng trước nhãn — đồng nhất mọi card/tab. Bank icon tô màu brand NH. */}
      <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-slate-400"><FieldIcon label={label} bank={bank} className="h-3 w-3" />{label}</div>
      <div className={'mt-0.5 text-slate-700 ' + (valueClass ?? 'text-sm')}>{children}</div>
    </div>
  );
}

export function PosBillCard({
  message,
  parsed,
  onImageClick
}: {
  message: ChatMessage;
  parsed: ParsedPosBill;
  onImageClick?: (message: ChatMessage) => void;
}): JSX.Element {
  const hasImage = isRealImageUrl(message.imageUrl);
  const [editing, setEditing] = useState(false); // Admin Demo 1/9: nút Sửa tham số (password-gate + đồng bộ chéo).

  const handleDownload = (): void => {
    if (!isRealImageUrl(message.imageUrl)) return;
    downloadAttachment(message.imageUrl, `bill-pos-${message.id}.jpg`, { isImage: true }).catch((err) => {
      console.warn('[PosBillCard] Không tải được ảnh:', err);
    });
  };
  const handleShare = (): void => {
    if (!isRealImageUrl(message.imageUrl)) return;
    shareAttachment(message.imageUrl, `bill-pos-${message.id}.jpg`).catch((err) => {
      console.warn('[PosBillCard] Không chia sẻ được ảnh:', err);
    });
  };

  // Nền NỔI 3D tách khỏi nền phòng chat (#f4f6fa) — Admin Demo 1/9 "card lẫn nền, cho nổi 3D ~15%": shadow đổ + viền
  // đậm hơn + highlight mép trên (ring-white/60 inset) = cảm giác nổi. Áp mọi tin (render live).
  // FIX GIẬT 11/9 (Admin Demo "khi load phòng chat, tin OCR bị BÓP HẸP xong mới load về đúng kích thước"): GỐC bề
  // ngang = `w-full max-w-[440px]` — bubble cha (ChatBubble `max-w-[78%]`) shrink-to-fit theo NỘI DUNG, lúc ảnh
  // CHƯA về cột ảnh (w-[40%]) không có bề rộng nội tại → card bị bóp còn ~210px (chữ đứt dòng), ảnh về mới phình
  // ra 440px = giật ngang. Đổi sang `w-[440px] max-w-full` — card XIN THẲNG 440px ngay từ đầu (placeholder hay
  // ảnh đều cùng khổ), màn hẹp (APK) max-w-full tự co theo bubble như cũ. Đo harness-chat-image-cls.ts.
  return (
    <div className="w-[440px] max-w-full overflow-hidden rounded-xl border border-[#b8c4d6] bg-gradient-to-b from-white to-[#f5f8fc] shadow-[0_14px_32px_-8px_rgba(15,23,42,0.40),0_4px_10px_-2px_rgba(15,23,42,0.22)] ring-1 ring-inset ring-white/50">
      {/* Tiêu đề card — tông brand như CK để đồng bộ. Nút "Sửa" bên phải (OCR sai → sửa tiền/lô/mã, password-gate). */}
      <div className="flex items-center justify-between border-b border-line bg-brand-tint px-3 py-1.5 text-xs font-semibold text-brand-deep">
        <span className="flex items-center gap-1.5"><Receipt className="h-3.5 w-3.5" /> {parsed.title ?? 'Bill POS'}</span>
        {!parsed.hideEdit && (
          <button type="button" onClick={() => setEditing(true)} className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium text-brand-deep/80 hover:bg-white/60" title="Sửa tham số bill (OCR sai)">
            <Pencil className="h-3 w-3" /> Sửa
          </button>
        )}
      </div>
      {editing && <BillParamEditModal messageId={message.id} parsed={parsed} onClose={() => setEditing(false)} />}

      {/* Thân card: ẢNH trái · BẢNG phải — NGANG LUÔN (Admin Demo 1/9 "bill cũ vẫn blog dọc"): trước dùng
          `flex-col sm:flex-row` nên màn HẸP (APK/panel <640px) xếp DỌC = "blog dọc bên dưới". Bỏ gate sm: → luôn
          ngang. items-stretch = ảnh cao bằng cột phải, ảnh ~40%. */}
      <div className="flex flex-row items-stretch">
        {/* ẢNH bill — bấm mở lightbox; nút Tải/Chia sẻ overlay. h-full lấp bằng chiều cao cột phải (giống CK). */}
        <div className="relative shrink-0 bg-slate-50 w-[40%] flex items-center justify-center min-h-[168px]">
          {hasImage ? (
            <>
              {/* Admin Demo 2/9 "card bill trong chat bị THU HẸP hết": bản trước ép ảnh absolute inset-0 → chiều cao
                  card = cột phải (~168px) → bill DỌC bị nén tí xíu. Nay TRẢ LẠI ảnh in-flow: ảnh dọc tự cao → card
                  TO đọc được (như cũ).
                  FIX GIẬT 11/9: reserveDims — placeholder GIỮ CHỖ đúng aspect-ratio THẬT của ảnh (đã biết từ lần
                  decode trước, xem image-dims-cache.ts) → chiều cao card TRƯỚC ảnh về == SAU ảnh về, hết giật dọc.
                  h-[220px] chỉ còn là fallback khi máy chưa từng thấy ảnh. */}
              <button type="button" onClick={() => onImageClick?.(message)} className="flex h-full w-full items-center justify-center" aria-label="Xem ảnh bill">
                <AttachmentImage
                  url={message.imageUrl!}
                  alt="Bill POS"
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

        {/* BẢNG THAM SỐ — mỗi tham số 1 Ô riêng, đồng nhất với card CK (chữ + ô cùng cỡ, tiền nổi bật). */}
        <div className="flex flex-1 flex-col gap-1.5 p-2.5">
          {/* KHÔNG lặp ô "Loại: Bill POS" (Admin Demo 1/9 "trùng 2 lần") — header card đã ghi "Bill POS" rồi. TID lên đầu. */}
          {parsed.tid && (
            <ParamCell label="TID" valueClass="text-sm font-mono font-medium break-all">{parsed.tid}</ParamCell>
          )}

          {parsed.hkd && (
            <ParamCell label="Khách" valueClass="text-sm font-medium break-words">{parsed.hkd}</ParamCell>
          )}

          {parsed.bank && (
            <ParamCell label="Ngân hàng" bank={parsed.bank} valueClass="text-sm font-medium break-words">{parsed.bank}</ParamCell>
          )}

          {parsed.dateTime && (
            <ParamCell label="Ngày giờ" valueClass="text-sm break-words">{parsed.dateTime}</ParamCell>
          )}

          {/* SỐ TIỀN nổi bật — block riêng, chữ to, màu brand (đồng nhất card CK). */}
          <div className="rounded-lg border border-brand/40 bg-brand-tint px-2.5 py-2">
            <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-brand-deep/70"><FieldIcon label="Số tiền" className="h-3 w-3" />Số tiền</div>
            <div className="mt-0.5 text-xl font-extrabold tabular-nums text-brand-deep">{fmtVnd(parsed.amount)}</div>
          </div>

          {/* Phí (bán / cài máy) — nhãn động theo phòng: đại lý='Phí bán', NĐT='Phí cài máy'. CHỈ hiện khi có meta. */}
          {parsed.feeLabel && parsed.feePct != null && (
            <ParamCell label={parsed.feeLabel} valueClass="text-sm font-medium tabular-nums">
              {parsed.feePct.toLocaleString('vi-VN', { maximumFractionDigits: 3 })}%
            </ParamCell>
          )}

          {/* TIỀN PHẢI HOÀN (sau phí) — nhãn động 'Phải hoàn' (đại lý) / 'Tiền về' (NĐT). Nổi bật (block viền xanh
              lá) vì đây là số Admin Demo cần thấy rõ nhất. CHỈ hiện khi server gắn netAmount (phí resolved). */}
          {parsed.netLabel && parsed.netAmount != null && (
            <div className="rounded-lg border border-success/40 bg-success/5 px-2.5 py-2">
              <div className="flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-success/80"><FieldIcon label={parsed.netLabel} className="h-3 w-3" />{parsed.netLabel}</div>
              <div className="mt-0.5 text-lg font-extrabold tabular-nums text-success">{fmtVnd(parsed.netAmount)}</div>
            </div>
          )}

          {parsed.lo && <ParamCell label="Lô">{parsed.lo}</ParamCell>}

          {/* Số giao dịch QR (Admin Demo 7/9) — bill QR có ref; bill POS không set → ẩn. */}
          {parsed.ref && <ParamCell label="Số GD" valueClass="text-sm font-mono break-all">{parsed.ref}</ParamCell>}
        </div>
      </div>
    </div>
  );
}
