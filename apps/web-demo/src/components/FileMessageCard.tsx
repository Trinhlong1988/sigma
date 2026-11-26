// Card tài liệu trong chat (mục 30 — Admin Demo bổ sung 23/7): icon theo loại file (PDF đỏ/Excel xanh
// lá/Word xanh/ZIP xám), tên file, dung lượng, nút Tải xuống (giả lập — Phase 0 không tải thật).
import { Download, FileArchive, FileSpreadsheet, FileText, File } from 'lucide-react';
import type { FileKind } from '../mock-data/types';
import { downloadAttachment } from '../lib/attachment-blob';

import type { JSX } from "react";

const KIND_STYLE: Record<FileKind, { icon: JSX.Element; bg: string; label: string }> = {
  pdf: { icon: <FileText className="h-5 w-5 text-white" />, bg: '#dc2626', label: 'PDF' },
  xlsx: { icon: <FileSpreadsheet className="h-5 w-5 text-white" />, bg: '#16a34a', label: 'Excel' },
  docx: { icon: <File className="h-5 w-5 text-white" />, bg: 'var(--color-brand)', label: 'Word' },
  zip: { icon: <FileArchive className="h-5 w-5 text-white" />, bg: '#64748b', label: 'ZIP' }
};

// 27/7 — `url` optional: khi có (đính kèm file THẬT, trỏ tới GET /v1/chat/attachments/:id bot-api, xem
// ChatBubble.tsx/rc-realtime.ts mapRcMessage()) nút "Tải xuống" gọi downloadAttachment(); không có (mock
// cũ, "Phase 0 không tải thật" — comment gốc đầu file) giữ nguyên `<button>` cosmetic không làm gì, KHÔNG đổi
// hành vi của bất kỳ tin nhắn mock nào đã có từ trước.
// 29/7 (B49) — ĐỔI từ `<a href={url} download>` sang gọi downloadAttachment() (fetch blob có CSRF header):
// endpoint bắt buộc header `x-sigma-client` (requireSession) mà `<a href>` điều hướng trực tiếp KHÔNG tự
// gắn được → mọi lần tải file thật trước đây đều 403 (cùng gốc bug ảnh, xem attachment-blob.ts).
export function FileMessageCard({ name, size, kind, url }: { name: string; size: string; kind: FileKind; url?: string }): JSX.Element {
  const style = KIND_STYLE[kind];
  // BUG#6 (6/8) — Admin Demo "bấm file không mở được": TRƯỚC ĐÂY chỉ nút Download icon nhỏ mới bấm được; bấm vào
  // THÂN card (icon/tên/dung lượng) KHÔNG làm gì → người dùng tưởng hỏng. Nay CẢ card là 1 nút tải/mở (kiểu
  // Zalo) khi có `url` thật, giữ thêm nút Download bên phải cho rõ affordance. url không có (mock cũ) → card
  // tĩnh như trước.
  const triggerDownload = (e: React.MouseEvent): void => {
    e.stopPropagation();
    if (!url) return;
    downloadAttachment(url, name).catch((err) => {
      // R198 (6/8) — KHÔNG nuốt lỗi câm: log rõ để LEAD nối toast "Không tải được tệp". Component thuần chưa có
      // hạ tầng toast tại chỗ; console.warn rõ (không throw ra ngoài gây crash UI, người dùng vẫn thử lại được).
      console.warn('[FileMessageCard] Không tải được tệp:', err);
    });
  };
  const inner = (
    <>
      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg" style={{ backgroundColor: style.bg }}>
        {style.icon}
      </div>
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate text-sm font-semibold text-slate-800" title={name}>
          {name}
        </div>
        <div className="text-xs text-slate-400">
          {style.label} · {size}
        </div>
      </div>
      <span className="rounded-full p-2 text-brand" title="Tải xuống">
        <Download className="h-4 w-4" />
      </span>
    </>
  );
  if (url) {
    return (
      <button
        type="button"
        title="Mở / Tải xuống"
        onClick={triggerDownload}
        className="flex w-64 items-center gap-3 rounded-lg-mac border border-line bg-white p-3 text-left shadow-soft transition hover:bg-brand-tint"
      >
        {inner}
      </button>
    );
  }
  return <div className="flex w-64 items-center gap-3 rounded-lg-mac border border-line bg-white p-3 shadow-soft">{inner}</div>;
}
