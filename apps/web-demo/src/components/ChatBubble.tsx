// Bong bóng chat — tick trạng thái (đã gửi/đã nhận/đã xem = tick xanh), hỗ trợ text/ảnh/location/qr/
// file, menu chuột-phải/long-press qua onContextMenu (Chuyển tiếp/Thu hồi ở ConversationScreen),
// thả cảm xúc kiểu Zalo (mục 29): hover desktop hiện thanh emoji nổi + nút smile nhỏ cho mobile,
// badge cảm xúc góc dưới bong bóng.
import { AlertCircle, Check, CheckCheck, Clock, Download, Forward, MoreHorizontal, Pin, Reply, Share2, SmilePlus } from 'lucide-react';
import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';
import type { ChatMessage } from '../mock-data/types';
import { downloadAttachment, fetchAttachmentObjectUrl, shareAttachment } from '../lib/attachment-blob';
import { getKnownImageDims, rememberImageDims } from '../lib/image-dims-cache';
import { replyPreviewText } from '../lib/reply-preview';
import { LocationShareCard } from './LocationShareCard';
import { QrCard } from './QrCard';
import { FileMessageCard } from './FileMessageCard';
import { VoiceMessageBubble } from './VoiceMessageBubble';
import { TransferCkCard } from './TransferCkCard';
import { PosBillCard, parsePosBill, type ParsedPosBill } from './PosBillCard';
import { splitMentionSegments } from '../lib/mention';

export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '😡'];

/** Tag @ mention kiểu Zalo (13/8) — render nội dung tin TEXT, tô đậm/nổi bật các `@Tên` (theo danh sách
 * `mentions` = tên hiển thị đã nhắc, xem mention.ts splitMentionSegments()). KHÔNG mention → trả nguyên chuỗi
 * (splitMentionSegments tự trả 1 đoạn thường). An toàn với emoji/xuống dòng (chỉ so khớp chuỗi con literal,
 * `whitespace-pre-line` ở thẻ cha giữ nguyên xuống dòng). */
function renderTextWithMentions(text: string | undefined, mentions: string[] | undefined): ReactNode {
  if (!text) return text ?? '';
  if (!mentions || mentions.length === 0) return text;
  const segments = splitMentionSegments(text, mentions);
  return segments.map((seg, i) =>
    seg.isMention ? (
      <span key={i} className="font-semibold text-brand">
        {seg.text}
      </span>
    ) : (
      <span key={i}>{seg.text}</span>
    )
  );
}

/** true nếu `imageUrl` là 1 URL THẬT (đính kèm ảnh thật, 27/7 — trỏ tới `botApiBaseUrl()/v1/chat/
 * attachments/:id`) — CHỈ khi đó mới render `<img>` thật. Ảnh chụp màn hình (mục 23, 31/7 — nay đi qua CÙNG
 * luồng upload/gửi ảnh thật `sendAttachment(kind:'image', ...)`, xem `MessageComposer.tsx`
 * `handleCaptureScreenClick()`/`screen-capture.ts`) CŨNG khớp điều kiện này như ảnh thường, KHÔNG còn mock
 * filename `chup-man-hinh-N.png` không trỏ file thật nào như trước — hộp xám placeholder dưới đây giờ chỉ
 * còn dùng cho các tính năng KHÁC thật sự chưa nối (vd `confirmForward` mock, xem ConversationScreen.tsx). */
// B83 (31/7, CMD_BUILD — lightbox ConversationScreen.tsx tái dùng, xem BUGS_FIXED.md) — EXPORT `isRealImageUrl`
// (không đổi hành vi, chỉ cho phép nơi khác dùng ĐÚNG 1 định nghĩa, không tự chép lại regex).
export function isRealImageUrl(url: string | undefined): url is string {
  return !!url && /^https?:\/\//i.test(url);
}

/** B49 (29/7) — endpoint đính kèm bắt buộc header CSRF mà `<img src>` không tự gắn được (xem attachment-
 * blob.ts) → phải tự fetch() có credentials rồi đổi sang blob: URL, KHÔNG thể gắn thẳng `url` gốc vào `src`.
 * B83 (31/7) — EXPORT + thêm `className`/`loadingClassName`/`failedClassName` optional (mặc định GIỮ NGUYÊN
 * style thumbnail cũ trong khung chat — KHÔNG đổi hành vi hiện có) để `ConversationScreen.tsx` lightbox tái
 * dùng ĐÚNG cơ chế fetch-blob này với khung/kích thước riêng (phóng to toàn màn hình), KHÔNG viết lại 1 bản
 * fetch riêng thứ 2. `onClick` đổi type sang `React.MouseEventHandler<HTMLImageElement>` (nhận event thật,
 * trước đây `() => void` không cho lightbox gọi `e.stopPropagation()` để tránh đóng lightbox khi bấm vào
 * chính ảnh) — chỉ nới kiểu, KHÔNG đổi cách gọi ở ChatBubble (không truyền onClick nào ở đây). */
export function AttachmentImage({
  url,
  alt,
  onClick,
  className,
  loadingClassName,
  failedClassName,
  reserveDims
}: {
  url: string;
  alt: string;
  onClick?: React.MouseEventHandler<HTMLImageElement>;
  className?: string;
  loadingClassName?: string;
  failedClassName?: string;
  /** FIX GIẬT (Admin Demo 11/9 "bubble ảnh bill BÓP HẸP xong mới load về đúng kích thước") — true = GIỮ CHỖ đúng
   * aspect-ratio THẬT của ảnh cho CẢ placeholder LẪN ảnh (kích thước bubble TRƯỚC ảnh về == SAU ảnh về, hết
   * layout shift). Kích thước thật lấy từ image-dims-cache.ts (nhớ từ lần decode đầu tiên — mọi lần "load phòng
   * chat" sau đó giữ chỗ đúng ngay từ đầu). CHỈ bật cho khung ảnh co theo nội dung (bill/refund/PosBillCard/
   * TransferCkCard) — khung CỐ ĐỊNH sẵn (h-40 w-52 mặc định, avatar, lightbox) KHÔNG cần và không được đổi. */
  reserveDims?: boolean;
}): JSX.Element {
  // Gộp objectUrl + kích thước THẬT vào 1 state — commit CÙNG 1 nhịp render (ảnh đã decode xong mới chèn <img>,
  // không còn nhịp <img> chưa biết kích thước chen vào layout).
  const [loaded, setLoaded] = useState<{ objectUrl: string; w: number; h: number } | null>(null);
  const [failed, setFailed] = useState(false);
  // Fade-in khi ảnh sẵn sàng (mượt kiểu Zalo) — bật sau khi <img> đã vào DOM 1 frame (transition cần điểm đầu).
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(null);
    setFailed(false);
    setVisible(false);
    fetchAttachmentObjectUrl(url)
      .then(async (u) => {
        // Decode TRƯỚC khi commit — đọc naturalWidth/Height để giữ chỗ + nhớ vào cache cho lần load phòng sau.
        // decode() lỗi (ảnh hỏng 1 phần vẫn hiển thị được) → vẫn commit, dims 0 = không reserve được lần này.
        const probe = new Image();
        probe.src = u;
        await probe.decode().catch(() => undefined);
        if (cancelled) return;
        if (probe.naturalWidth > 0 && probe.naturalHeight > 0) rememberImageDims(url, probe.naturalWidth, probe.naturalHeight);
        setLoaded({ objectUrl: u, w: probe.naturalWidth, h: probe.naturalHeight });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    if (!loaded) return;
    // 2 frame để chắc chắn <img> đã paint trạng thái opacity-0 rồi mới chuyển 100 (1 frame có thể bị gộp).
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    return () => cancelAnimationFrame(raf);
  }, [loaded]);

  // Kích thước đã biết: từ chính ảnh vừa decode (ưu tiên) hoặc từ cache lần trước (placeholder giữ chỗ đúng
  // NGAY TỪ ĐẦU khi mở lại phòng). style height:auto để đè height cố định trong loadingClassName (vd h-[220px]
  // — chỉ còn là fallback khi CHƯA từng biết kích thước ảnh này).
  const known = reserveDims ? (loaded && loaded.w > 0 ? { w: loaded.w, h: loaded.h } : getKnownImageDims(url)) : null;
  const reserveStyle = known ? { aspectRatio: `${known.w} / ${known.h}`, height: 'auto' as const } : undefined;

  if (failed) {
    return (
      <div className={failedClassName ?? 'flex h-40 w-52 items-center justify-center rounded-lg bg-slate-200 text-xs text-slate-500'}>
        Không tải được ảnh
      </div>
    );
  }
  if (!loaded) {
    return <div className={loadingClassName ?? 'h-40 w-52 animate-pulse rounded-lg bg-slate-200'} style={reserveStyle} />;
  }
  return (
    <img
      src={loaded.objectUrl}
      alt={alt}
      loading="lazy"
      className={(className ?? 'h-40 w-52 rounded-lg object-cover') + ' transition-opacity duration-200 ' + (visible ? 'opacity-100' : 'opacity-0')}
      style={reserveStyle}
      onClick={onClick}
      onError={() => setFailed(true)}
    />
  );
}

function StatusTick({ status }: { status: ChatMessage['status'] }): JSX.Element {
  // 'sending' (5/8) — tin lạc quan chưa được server xác nhận: đồng hồ mờ (kiểu Zalo). 'failed' — lỗi gửi:
  // dấu than nổi bật (đỏ nhạt trên nền brand) để người dùng biết cần thử lại.
  // 7/8 — bong bóng mình giờ nền XANH NHẸ → tick màu ĐẬM (trước là text-white trên nền brand đậm).
  if (status === 'sending') return <Clock className="h-3.5 w-3.5 text-slate-400" />;
  if (status === 'failed') return <AlertCircle className="h-3.5 w-3.5 text-rose-500" />;
  if (status === 'sent') return <Check className="h-3.5 w-3.5 text-slate-400" />;
  if (status === 'delivered') return <CheckCheck className="h-3.5 w-3.5 text-slate-500" />;
  // seen = tick xanh (đã xem) — brand nổi rõ trên nền xanh nhẹ.
  return <CheckCheck className="h-3.5 w-3.5 text-brand" />;
}

export function ChatBubble({
  message,
  repliedMessage,
  onContextMenu,
  onImageClick,
  onReact,
  selectMode,
  selected,
  onToggleSelect,
  pickerOpen,
  onSetPickerOpen,
  onJumpToMessage,
  highlighted,
  onReply,
  onForward
}: {
  message: ChatMessage;
  /** Tin nhắn GỐC mà `message` đang trả lời (1/8, tính năng "Trả lời") — ConversationScreen.tsx tự resolve
   * từ `messages` đã tải trong state theo `message.replyToMessageId` (KHÔNG gọi thêm API) rồi truyền xuống
   * đây. `undefined` khi `message.replyToMessageId` không có giá trị, HOẶC có giá trị nhưng KHÔNG tìm thấy
   * trong state hiện có (tin gốc quá cũ, chưa load) — 2 trường hợp phân biệt bằng field `message.replyToMessageId`
   * (xem JSX khối trích dẫn dưới: có replyToMessageId nhưng repliedMessage undefined → hiện "Tin nhắn gốc" mờ). */
  repliedMessage?: ChatMessage;
  /** BUG THẬT (1/8, Admin Demo "bấm vào tin nhắn trả lời... không trôi lên tin nhắn được trả lời như Zalo") —
   * TRƯỚC ĐÂY khối trích dẫn tin gốc CHỈ hiển thị, KHÔNG có onClick nào. Bấm được CHỈ khi `repliedMessage` đã
   * resolve (tin gốc còn trong `messages` đã tải — xem comment trên); tin gốc quá cũ chưa tải (hiện "Tin nhắn
   * gốc" mờ) KHÔNG bấm được, không có gì để cuộn tới. ConversationScreen.tsx tự cuộn (`scrollIntoView`) + nổi
   * bật tạm 1 nhịp (CÙNG `highlighted` prop dưới đây), CHỈ nhận id qua callback này — component KHÔNG tự biết
   * cách cuộn (không có ref danh sách tin nhắn ở tầng này). */
  onJumpToMessage?: (messageId: string) => void;
  /** true = đang trong nhịp "nổi bật" ngắn sau khi bị `onJumpToMessage` nhảy tới (ConversationScreen.tsx tự
   * tắt lại sau ~1.5s) — viền/nền nhấn nhá NGẮN, KHÔNG phải trạng thái chọn/pin lâu dài. */
  highlighted?: boolean;
  /** Vị trí menu ngữ cảnh (1/8) — ĐỔI từ nhận `React.MouseEvent` (tọa độ con trỏ/ngón tay thô, nguồn gốc bug
   * vị trí menu cũ — xem context-menu-position.ts đầu file đó) sang nhận thẳng `DOMRect` của BUBBLE tin nhắn
   * (đo bằng `bubbleRef.current.getBoundingClientRect()` ngay bên dưới) — CẢ click-chuột-phải desktop LẪN
   * long-press mobile đều đi qua ĐÚNG 1 hàm `openContextMenu()` nội bộ, không còn nhánh nào đọc
   * clientX/clientY của sự kiện gốc nữa. */
  onContextMenu?: (rect: DOMRect, message: ChatMessage) => void;
  onImageClick?: (message: ChatMessage) => void;
  onReact?: (message: ChatMessage, emoji: string) => void;
  /** Chế độ "Chọn nhiều để xóa" (mục 5, 24/7) — CHỈ tin nhắn CỦA MÌNH (message.mine) hiện checkbox, không
   * cho chọn/xóa hàng loạt tin của người khác. */
  selectMode?: boolean;
  selected?: boolean;
  onToggleSelect?: (message: ChatMessage) => void;
  /** B41 (27/7, Admin Demo báo thật: bấm thả cảm xúc ở NHIỀU tin nhắn khác nhau → mở được ĐỒNG THỜI nhiều thanh
   * emoji cùng lúc, không tự đóng cái cũ) — TRƯỚC ĐÂY `pickerOpen` là state RIÊNG từng ChatBubble
   * (`useState` cục bộ), mỗi bong bóng tự nhớ trạng thái mở/đóng ĐỘC LẬP, không ai biết bong bóng khác đang
   * mở. Nâng state lên ConversationScreen (CHỈ 1 nơi nhớ "tin nào đang mở thanh cảm xúc", xem
   * ConversationScreen.tsx `openReactionPickerId`) — mở tin MỚI tự đóng tin CŨ, bấm ra vùng khác cũng đóng
   * được (window click listener ở ConversationScreen). */
  pickerOpen: boolean;
  onSetPickerOpen: (open: boolean) => void;
  /** Nút lối tắt khi HOVER 1 tin (7/8, kiểu Zalo — thanh nhỏ nổi cạnh bong bóng: Trả lời/Chuyển tiếp/Tải/⋯).
   *  TÁI DÙNG đúng handler menu ngữ cảnh sẵn có ở ConversationScreen.tsx (setReplyingTo/setForwardTarget) —
   *  KHÔNG thêm luồng mới. `undefined` = ngữ cảnh không hỗ trợ (ẩn nút tương ứng), giữ component vẫn dùng được. */
  onReply?: (message: ChatMessage) => void;
  onForward?: (message: ChatMessage) => void;
}): JSX.Element {
  const { mine, type } = message;
  // Bill POS (Admin Demo 1/9 "POS + CK đều bố cục NGANG, đồng nhất; sửa cả bill cũ; đại lý+NĐT giống nhau") — tin ẢNH
  // có `isBillImage` (KHÔNG phải CK, KHÔNG phải hoàn-tiền) → render CARD 2 cột như CK (PosBillCard) THAY ảnh-ghép-dọc.
  // ƯU TIÊN `posBillMeta` (server gắn, ĐỦ tham số Bank/Ngày/Phí) → fallback parse caption (bill CŨ chỉ có caption,
  // thiếu Bank/Ngày/Phí — các Ô đó tự ẩn). Cả 2 fail → giữ ảnh cũ.
  const isPosBillMsg = type === 'image' && message.isBillImage && !message.transferCk && !message.isRefundImage;
  const posBill: ParsedPosBill | null = isPosBillMsg
    ? (message.posBillMeta
        ? {
            tid: message.posBillMeta.tid ?? undefined, amount: message.posBillMeta.amount,
            lo: message.posBillMeta.lo ?? undefined, hkd: message.posBillMeta.hkd ?? undefined,
            bank: message.posBillMeta.bank ?? undefined, dateTime: message.posBillMeta.dateTime ?? undefined,
            feeLabel: message.posBillMeta.feeLabel ?? undefined, feePct: message.posBillMeta.feePct ?? undefined,
            netLabel: message.posBillMeta.netLabel ?? undefined, netAmount: message.posBillMeta.netAmount ?? undefined,
            title: message.posBillMeta.title ?? undefined, ref: message.posBillMeta.ref ?? undefined, hideEdit: message.posBillMeta.hideEdit ?? undefined,
            voidAmount: message.posBillMeta.voidAmount ?? undefined, voidCount: message.posBillMeta.voidCount ?? undefined
          }
        : parsePosBill(message.text))
    : null;

  if (type === 'system') {
    return (
      <div className="my-2 flex justify-center">
        <span className="rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-500">{message.text}</span>
      </div>
    );
  }

  // BUG vị trí menu (Admin Demo báo thật kèm ảnh chụp màn hình, 1/8) — xem comment đầy đủ ở context-menu-
  // position.ts đầu file đó: TRƯỚC ĐÂY cast `TouchEvent` thành `React.MouseEvent` rồi đọc `e.clientX`/
  // `e.clientY` (KHÔNG tồn tại trên TouchEvent) → luôn undefined → menu rơi lệch vị trí. FIX (đồng thời là
  // yêu cầu đổi cách neo menu kiểu Zalo): bỏ HẲN việc đọc tọa độ con trỏ/ngón tay — cả long-press (mobile)
  // LẪN chuột-phải (desktop) đều đo `bubbleRef.current.getBoundingClientRect()` NGAY lúc mở menu rồi gọi
  // `onContextMenu(rect, message)`, ConversationScreen.tsx tự tính vị trí menu bám theo rect đó (xem
  // computeContextMenuPosition()).
  const bubbleRef = useRef<HTMLDivElement>(null);
  const openContextMenu = (): void => {
    if (!bubbleRef.current) return;
    onContextMenu?.(bubbleRef.current.getBoundingClientRect(), message);
  };

  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  const handleTouchStart = (): void => {
    longPressTimer = setTimeout(openContextMenu, 500);
  };
  const clearLongPress = (): void => {
    if (longPressTimer) clearTimeout(longPressTimer);
  };

  // item 15 (6/8) — nút TẢI VỀ cho ảnh trong chat (như file). CHỈ khi ảnh THẬT (isRealImageUrl); ảnh mock cũ
  // (placeholder xám, không có url thật) không hiện. Tên file: message không kèm tên riêng cho ảnh → đặt
  // `anh-<id>.jpg`. R198: KHÔNG nuốt lỗi câm — console.warn rõ để LEAD nối toast (component thuần không có toast).
  // B-DL/SHARE (11/8) — TẢI = LƯU về máy/thư viện (ảnh→thư viện ảnh trên APK giống Zalo, isImage=true), KHÔNG
  // mở share sheet. R198: KHÔNG nuốt lỗi câm — console.warn rõ để LEAD nối toast (component thuần không có toast).
  const handleImageDownload = (): void => {
    if (!isRealImageUrl(message.imageUrl)) return;
    downloadAttachment(message.imageUrl, `anh-${message.id}.jpg`, { isImage: true }).catch((err) => {
      console.warn('[ChatBubble] Không tải được ảnh:', err);
    });
  };

  // Tải FILE (7/8, cho thanh hover + menu theo loại) — CÙNG cơ chế downloadAttachment (web/exe/apk) mà
  // FileMessageCard.tsx đã dùng, KHÔNG tự bịa endpoint. Chỉ khi file có `url` THẬT (mock cũ không có → ẩn nút).
  const handleFileDownload = (): void => {
    if (!message.file?.url) return;
    downloadAttachment(message.file.url, message.file.name).catch((err) => {
      console.warn('[ChatBubble] Không tải được tệp:', err);
    });
  };

  // CHIA SẺ (B-DL/SHARE 11/8) — hành động RIÊNG khỏi Tải: gửi ảnh/file sang ứng dụng khác (share sheet / Web
  // Share API). TÁCH icon Share2 khỏi Download để không lẫn "tải" với "chia sẻ".
  const handleImageShare = (): void => {
    if (!isRealImageUrl(message.imageUrl)) return;
    shareAttachment(message.imageUrl, `anh-${message.id}.jpg`).catch((err) => {
      console.warn('[ChatBubble] Không chia sẻ được ảnh:', err);
    });
  };
  const handleFileShare = (): void => {
    if (!message.file?.url) return;
    shareAttachment(message.file.url, message.file.name).catch((err) => {
      console.warn('[ChatBubble] Không chia sẻ được tệp:', err);
    });
  };

  // Đính kèm TẢI ĐƯỢC thật (ảnh có URL thật / file có url) — quyết định hiện nút "Tải" trên thanh hover.
  const downloadableAttachment =
    type === 'image' && isRealImageUrl(message.imageUrl)
      ? handleImageDownload
      : type === 'file' && message.file?.url
        ? handleFileDownload
        : null;
  // Đính kèm CHIA SẺ ĐƯỢC (cùng điều kiện tải được) — quyết định hiện nút "Chia sẻ" trên thanh hover.
  const shareableAttachment =
    type === 'image' && isRealImageUrl(message.imageUrl)
      ? handleImageShare
      : type === 'file' && message.file?.url
        ? handleFileShare
        : null;

  const reactionTotal = (message.reactions ?? []).reduce((s, r) => s + r.count, 0);

  const canSelect = selectMode && mine; // chỉ tin CỦA MÌNH mới cho chọn nhiều để xóa (mục 5 — 24/7)

  return (
    // id neo cho scrollIntoView (1/8, xem onJumpToMessage phía trên) — ConversationScreen.tsx cuộn tới ĐÚNG
    // bong bóng này qua `document.getElementById`, KHÔNG cần truyền thêm ref danh sách xuống từng ChatBubble.
    <div id={`msg-${message.id}`} className={'flex items-center gap-2 ' + (mine ? 'justify-end' : 'justify-start')}>
      {canSelect && (
        <button
          type="button"
          onClick={() => onToggleSelect?.(message)}
          aria-label={selected ? 'Bỏ chọn tin nhắn' : 'Chọn tin nhắn'}
          className={
            'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border transition ' +
            (selected ? 'border-brand bg-brand text-white' : 'border-line bg-white text-transparent hover:border-brand')
          }
        >
          <Check className="h-3 w-3" />
        </button>
      )}
      <div
        className="group relative flex max-w-[78%] flex-col gap-1"
        onClick={canSelect ? () => onToggleSelect?.(message) : undefined}
      >
        {message.pinned && (
          <div className="flex items-center gap-1 text-xs font-medium text-brand">
            <Pin className="h-3 w-3" /> Đã ghim
          </div>
        )}
        {!mine && <span className="px-1 text-xs text-slate-400">{message.senderName}</span>}

        <div
          ref={bubbleRef}
          onContextMenu={(e) => {
            e.preventDefault();
            openContextMenu();
          }}
          onTouchStart={handleTouchStart}
          onTouchEnd={clearLongPress}
          onTouchMove={clearLongPress}
          className={
            'select-none rounded-2xl px-3.5 py-2.5 text-sm transition-shadow duration-300 ' +
            (mine ? 'chat-bubble-mine rounded-br-md text-slate-800' : 'rounded-bl-md border border-line bg-white text-slate-700 shadow-soft') +
            (highlighted ? ' msg-jump-highlight' : '')
          }
        >
          {/* Trích dẫn tin nhắn GỐC (1/8, tính năng "Trả lời" kiểu Zalo) — hiện NGAY TRÊN nội dung tin, trong
              CÙNG bong bóng. `repliedMessage` đã resolve sẵn từ ConversationScreen.tsx (tra trong `messages`
              state theo id, KHÔNG gọi thêm API) — nếu KHÔNG tìm thấy (tin gốc quá cũ, chưa load trong 50 tin
              gần nhất) vẫn hiện khối này với nhãn mờ "Tin nhắn gốc" thay vì ẩn hẳn, để người dùng biết tin
              đang trả lời 1 tin khác dù chưa xem được nội dung. Bấm được (cursor-pointer + onClick) CHỈ khi
              `repliedMessage` đã resolve — cuộn tới + nổi bật tin gốc kiểu Zalo (xem onJumpToMessage). */}
          {message.replyToMessageId && (
            <div
              onClick={
                repliedMessage
                  ? (e) => {
                      e.stopPropagation(); // không kích hoạt onClick chọn-nhiều của bubble cha khi đang selectMode.
                      onJumpToMessage?.(repliedMessage.id);
                    }
                  : undefined
              }
              className={
                'mb-1.5 rounded-lg border-l-2 px-2 py-1 text-xs ' +
                (repliedMessage ? 'cursor-pointer hover:brightness-95' : '') +
                ' ' +
                (mine ? 'border-brand/40 bg-white/60 text-slate-600' : 'border-brand/50 bg-slate-100 text-slate-600')
              }
            >
              {repliedMessage ? (
                <>
                  <div className={'truncate font-medium ' + (mine ? 'text-brand' : 'text-brand')}>
                    {repliedMessage.mine ? 'Bạn' : repliedMessage.senderName || 'Người dùng'}
                  </div>
                  <div className="truncate opacity-90">{replyPreviewText(repliedMessage)}</div>
                </>
              ) : (
                <div className="truncate italic opacity-70">Tin nhắn gốc</div>
              )}
            </div>
          )}

          {type === 'text' && <p className="whitespace-pre-line">{renderTextWithMentions(message.text, message.mentions)}</p>}

          {/* Bill CHUYỂN KHOẢN (CK, 1/9) — tin IMAGE có `transferCk` (parse từ metadataJson backend, xem
              chat-client.ts parseTransferCkMeta()) render CARD ẢNH-trái + BẢNG-tham-số-phải THAY cho ảnh-thô+
              caption text nhiều dòng lộn xộn (bug cũ: CK KHÔNG có flag riêng → rơi vào nhánh ảnh thường dưới).
              Giữ onImageClick để bấm ảnh trong card vẫn mở lightbox như ảnh thường. */}
          {type === 'image' && message.transferCk && (
            <TransferCkCard message={message} onImageClick={onImageClick} />
          )}

          {posBill && (
            <PosBillCard message={message} parsed={posBill} onImageClick={onImageClick} />
          )}

          {type === 'image' && !message.transferCk && !posBill && (
            // `relative inline-block` bọc NGOÀI để đặt nút Tải overlay LÀ ANH EM (KHÔNG lồng trong) nút mở
            // lightbox — tránh `<button>` lồng `<button>` (HTML không hợp lệ). item 15 (6/8).
            <div className="relative inline-block">
            <button type="button" onClick={() => onImageClick?.(message)} className="block">
              {isRealImageUrl(message.imageUrl) ? (
                // 27/7 — đính kèm ảnh THẬT (xem chat-attachment-service.ts + rc-realtime.ts mapRcMessage()).
                // 29/7 (B49) — đổi sang AttachmentImage (fetch blob có CSRF header) thay `<img src>` trực tiếp,
                // xem attachment-blob.ts đầu file cho lý do.
                //
                // BUG THẬT (1/8, Admin Demo chụp màn hình thật: ảnh gửi sau khi quét bill "bị ẩn phải ấn vào mới
                // hiện") — className MẶC ĐỊNH của AttachmentImage (`h-40 w-52 object-cover`, khung CỐ ĐỊNH nhỏ
                // + crop) đúng cho ảnh thường (gần vuông) nhưng SAI cho ảnh GHÉP bill+bảng
                // (`composeBillImage()`, bill-table-image.ts — B97): ảnh ghép CAO hơn nhiều (bill + bảng xếp
                // dọc), bị "cover" cắt cụt chỉ còn thấy phần bill, bảng kết quả nằm ngoài khung 208px bị cắt
                // mất hoàn toàn khỏi tầm nhìn trong bong bóng chat — phải bấm mở lightbox mới thấy đủ. Nhận
                // diện ảnh ghép qua `message.isBillImage` (B106, 2/8 — ĐỔI từ heuristic cũ đọc
                // `message.text?.startsWith('Bill: ')`: caption đổi sang mẫu "POS ..." khiến heuristic cũ vỡ
                // hoàn toàn — field boolean riêng từ `metadataJson` giờ KHÔNG còn phụ thuộc đúng nguyên văn
                // caption, xem chat-client.ts mapChatMessage()) → dùng khung RỘNG HẲN, KHÔNG crop
                // (`object-contain`, không giới hạn chiều cao) để hiện ĐỦ CẢ ảnh bill LẪN bảng NGAY trong tin
                // nhắn, đúng yêu cầu tường minh "show trên dưới... không phải như hiện tại click vào mới thấy
                // bảng". Ảnh thường (không phải bill) GIỮ NGUYÊN khung cũ 160×208 cover.
                <AttachmentImage
                  url={message.imageUrl}
                  alt={message.text || 'Ảnh đính kèm'}
                  // B123 (2/8, tính năng "Hoàn tiền" MỚI) — tin nhắn HOÀN TIỀN (`isRefundImage`) CŨNG là ảnh
                  // GHÉP bảng (composeRefundImage(), bill-table-image.ts — CÙNG cấu trúc bill+bảng CAO như bill
                  // gốc) → dùng CHUNG khung rộng-không-crop với `isBillImage`, KHÔNG viết điều kiện/khung riêng.
                  className={message.isBillImage || message.isRefundImage ? 'w-full max-w-[260px] rounded-lg object-contain' : undefined}
                  // FIX GIẬT 11/9 (Admin Demo "bubble bill BÓP HẸP xong mới load về đúng kích thước") — placeholder
                  // thêm max-w-full (không tràn bubble hẹp, ĐỒNG BỘ bề rộng với ảnh thật; GIỮ w-[260px] cố định
                  // vì cha inline-block shrink-to-fit — w-full ở đây sẽ sập về 0), + reserveDims giữ chỗ đúng
                  // aspect-ratio thật (xem AttachmentImage) — h-72 chỉ còn là fallback khi máy CHƯA TỪNG thấy
                  // ảnh này (chưa có kích thước trong image-dims-cache.ts).
                  loadingClassName={message.isBillImage || message.isRefundImage ? 'h-72 w-[260px] max-w-full animate-pulse rounded-lg bg-slate-200' : undefined}
                  failedClassName={message.isBillImage || message.isRefundImage ? 'flex h-72 w-[260px] max-w-full items-center justify-center rounded-lg bg-slate-200 text-xs text-slate-500' : undefined}
                  reserveDims={message.isBillImage || message.isRefundImage}
                />
              ) : (
                <div className="flex h-40 w-52 items-center justify-center rounded-lg bg-slate-200 text-xs text-slate-500">
                  {message.imageUrl ?? 'anh.jpg'}
                </div>
              )}
              {message.text && <p className="mt-1.5">{message.text}</p>}
            </button>
            {isRealImageUrl(message.imageUrl) && (
              // B-DL/SHARE (11/8) — 2 nút TÁCH BẠCH góc trên-phải ảnh: Tải (Download, LƯU về máy/thư viện) +
              // Chia sẻ (Share2, gửi sang ứng dụng khác). Trước đây CHỈ có nút Tải mà trên APK lại mở share sheet.
              <div className="absolute right-1.5 top-1.5 flex items-center gap-1">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleImageShare();
                  }}
                  aria-label="Chia sẻ ảnh"
                  title="Chia sẻ ảnh"
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-black/45 text-white shadow-soft transition hover:bg-black/65"
                >
                  <Share2 className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation(); // KHÔNG mở lightbox / KHÔNG kích hoạt chọn-nhiều khi bấm nút Tải.
                    handleImageDownload();
                  }}
                  aria-label="Tải ảnh"
                  title="Tải ảnh"
                  className="flex h-7 w-7 items-center justify-center rounded-full bg-black/45 text-white shadow-soft transition hover:bg-black/65"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            </div>
          )}

          {type === 'location' && message.location && (
            <LocationShareCard lat={message.location.lat} lng={message.location.lng} label={message.location.label} />
          )}

          {type === 'qr' && message.qr && <QrCard amount={message.qr.amount} tid={message.qr.tid} bank={message.qr.bank} />}

          {type === 'file' && message.file && (
            <FileMessageCard name={message.file.name} size={message.file.size} kind={message.file.kind} url={message.file.url} />
          )}

          {type === 'voice' && message.voice && (
            <VoiceMessageBubble seed={message.id} duration={message.voice.duration} mine={mine} url={message.voice.url} />
          )}

          {/* Time gửi (Admin Demo 1/9 "time bị chìm bé, tăng 30% rõ, lui xuống không chìm, đồng nhất"): 11px→14px +
              font-medium + màu đậm hơn (slate-600/500) + mt-1.5. DÙNG CHUNG mọi loại tin → đồng nhất time gửi. */}
          <div className={'mt-1.5 flex items-center justify-end gap-1 text-[14px] font-medium ' + (mine ? 'text-slate-600' : 'text-slate-500')}>
            {/* B112 (2/8) — "(đã chỉnh sửa)" kiểu Zalo, CHỈ khi `editedAt` có giá trị (tin TEXT sửa qua nút đã
                có sẵn từ 29/7 KHÔNG có UI gọi tới cho tới B112, VÀ ảnh bill sửa qua EditBillMessageModal.tsx —
                CẢ 2 luồng đi qua CÙNG `editMessage()` server nên field này set đúng cho cả 2, hiển thị dùng
                CHUNG 1 nhãn, không cần phân biệt loại tin). */}
            {message.editedAt && <span className="italic opacity-80">(đã chỉnh sửa)</span>}
            {message.time}
            {mine && <StatusTick status={message.status} />}
          </div>
        </div>

        {/* Badge cảm xúc đã thả (mục 29) — góc dưới bong bóng, VD "👍❤️ 3". */}
        {reactionTotal > 0 && (
          <div className={'-mt-2 flex ' + (mine ? 'justify-end pr-2' : 'justify-start pl-2')}>
            <span className="z-[1] flex items-center gap-0.5 rounded-full border border-line bg-white px-1.5 py-0.5 text-[11px] shadow-soft">
              {(message.reactions ?? []).map((r) => (
                <span key={r.emoji}>{r.emoji}</span>
              ))}
              <span className="ml-0.5 font-medium text-slate-500">{reactionTotal}</span>
            </span>
          </div>
        )}

        {/* THANH LỐI TẮT KHI HOVER (7/8, kiểu Zalo — GIỮ brand SigMa: icon lucide + border-line/bg-white/
            shadow-soft như các menu-pill sẵn có). CHỈ desktop (hover) — mobile dùng long-press mở menu như cũ.
            Neo tuyệt đối cạnh NGOÀI bong bóng (tin mình→trái, người khác→phải) như thanh reaction picker đã có
            (`right-full`/`left-full`), KHÔNG che nội dung + KHÔNG gây layout-shift (absolute). Ẩn khi đang chọn
            nhiều (selectMode). "⋯ Thêm" mở ĐÚNG menu chuột-phải theo loại qua openContextMenu() sẵn có; Trả lời/
            Chuyển tiếp/Tải TÁI DÙNG handler cũ (không luồng mới). */}
        {!selectMode && (onReply || onForward || onContextMenu || onReact || downloadableAttachment || shareableAttachment) && (
          <div
            className={
              'absolute top-1/2 z-10 hidden -translate-y-1/2 items-center gap-0.5 rounded-full border border-line bg-white px-1 py-0.5 opacity-0 shadow-soft transition-opacity lg:flex lg:group-hover:opacity-100 ' +
              (mine ? 'right-full mr-1' : 'left-full ml-1')
            }
          >
            {onReply && (
              <button
                type="button"
                aria-label="Trả lời"
                title="Trả lời"
                onClick={(e) => {
                  e.stopPropagation();
                  onReply(message);
                }}
                className="flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition hover:bg-appbg hover:text-brand"
              >
                <Reply className="h-3.5 w-3.5" />
              </button>
            )}
            {onForward && (
              <button
                type="button"
                aria-label="Chuyển tiếp"
                title="Chuyển tiếp"
                onClick={(e) => {
                  e.stopPropagation();
                  onForward(message);
                }}
                className="flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition hover:bg-appbg hover:text-brand"
              >
                <Forward className="h-3.5 w-3.5" />
              </button>
            )}
            {downloadableAttachment && (
              <button
                type="button"
                aria-label="Tải xuống"
                title="Tải xuống"
                onClick={(e) => {
                  e.stopPropagation();
                  downloadableAttachment();
                }}
                className="flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition hover:bg-appbg hover:text-brand"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            )}
            {shareableAttachment && (
              <button
                type="button"
                aria-label="Chia sẻ"
                title="Chia sẻ"
                onClick={(e) => {
                  e.stopPropagation();
                  shareableAttachment();
                }}
                className="flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition hover:bg-appbg hover:text-brand"
              >
                <Share2 className="h-3.5 w-3.5" />
              </button>
            )}
            {onReact && (
              <button
                type="button"
                aria-label="Thả cảm xúc"
                title="Thả cảm xúc"
                onClick={(e) => {
                  e.stopPropagation();
                  onSetPickerOpen(!pickerOpen);
                }}
                className="flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition hover:bg-appbg hover:text-brand"
              >
                <SmilePlus className="h-3.5 w-3.5" />
              </button>
            )}
            {onContextMenu && (
              <button
                type="button"
                aria-label="Thêm"
                title="Thêm"
                onClick={(e) => {
                  e.stopPropagation();
                  openContextMenu();
                }}
                className="flex h-7 w-7 items-center justify-center rounded-full text-slate-500 transition hover:bg-appbg hover:text-brand"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}

        {/* Nút mở thanh emoji trên MOBILE (không có hover): luôn hiện mờ. Desktop dùng thanh lối tắt ở trên
            (`lg:hidden` ở đây) để tránh 2 nút cảm xúc chồng nhau. */}
        {onReact && (
          <button
            type="button"
            aria-label="Thả cảm xúc"
            onClick={(e) => {
              e.stopPropagation();
              onSetPickerOpen(!pickerOpen);
            }}
            className={
              'absolute top-1/2 -translate-y-1/2 rounded-full border border-line bg-white p-1 text-slate-400 shadow-soft transition hover:text-brand ' +
              'opacity-60 lg:hidden ' +
              (mine ? '-left-8' : '-right-8')
            }
          >
            <SmilePlus className="h-3.5 w-3.5" />
          </button>
        )}

        {/* Thanh emoji nổi (mục 29). B41 (27/7). Lịch sử 3 lần sửa vị trí (Admin Demo báo thật + Playwright tự
            tái hiện mỗi lần):
            1. `-top-9` (nổi TRÊN bong bóng) → chạm header khi tin gần đầu danh sách (Playwright: "header
               intercepts pointer events").
            2. `bottom-0 right-0/left-0` (chân bằng chân NHƯNG mép trong khớp mép bong bóng) → tự ĐÈ LÊN chữ
               tin nhắn (Admin Demo chỉ đúng qua ảnh chụp thật: "nó phải ở cạnh mép NGOÀI bên trái").
            3. (hiện tại) `bottom-0 right-full/left-full` — chân bằng chân + nằm HẲN ra ngoài mép bong bóng
               (KHÔNG che chữ). Đánh đổi đã biết: bong bóng RẤT rộng (gần 78% màn hình hẹp) có thể làm thanh
               emoji tràn sát/qua mép màn hình — chấp nhận được vì đa số tin nhắn thật ngắn hơn nhiều (như
               "Hello"/"Halo" trong ảnh Admin Demo gửi), thêm `max-w-[70vw] overflow-x-auto` làm lưới an toàn
               (tin CỰC dài vẫn cuộn ngang xem được, không mất hẳn ra ngoài màn hình). */}
        {onReact && pickerOpen && (
          <div
            className={
              'absolute bottom-0 z-10 flex max-w-[70vw] items-center gap-0.5 overflow-x-auto rounded-full border border-line bg-white px-2 py-1 shadow-card ' +
              (mine ? 'right-full mr-2' : 'left-full ml-2')
            }
          >
            {REACTION_EMOJIS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                onClick={() => {
                  onReact(message, emoji);
                  onSetPickerOpen(false);
                }}
                className="rounded-full px-1 text-base transition hover:scale-125"
              >
                {emoji}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
