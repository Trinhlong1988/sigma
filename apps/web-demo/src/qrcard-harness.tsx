// HARNESS TẠM (KHÔNG commit) — render ChatBubble với tin QR gửi group (posBillMeta) để Playwright chụp, xác minh
// card 2 cột GIỐNG POS/CK (title động, Số GD, ẩn Sửa, Phải hoàn nổi). Ảnh qua AttachmentImage → Playwright chặn
// URL http://qr.local/att/* trả placeholder SVG.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ChatBubble } from './components/ChatBubble';
import type { ChatMessage, PosBillMeta } from './mock-data/types';
import './styles.css';

let seq = 0;
function qrMsg(posBillMeta: PosBillMeta, caption: string): ChatMessage {
  seq += 1;
  return {
    id: `qr-${seq}`, roomId: 'r1', senderId: 'me', senderName: 'SigMa', mine: true,
    type: 'image', imageUrl: `http://qr.local/att/${seq}.svg`, time: '16:29', status: 'seen',
    text: caption, isBillImage: true, posBillMeta
  };
}

const MSGS: ChatMessage[] = [
  // QR hoàn tiền đại lý (đúng data screenshot anh gửi)
  qrMsg(
    { title: 'Hoàn tiền đại lý (QR)', tid: null, hkd: 'HKD Trà My Nguyễn', bank: null, dateTime: '05/09/2026 16:29:53', amount: 49_583_000, lo: null, feeLabel: 'Phí bán', feePct: 1.4, netLabel: 'Phải hoàn', netAmount: 49_042_588, ref: '6248VNIB024XSW4W', hideEdit: true },
    '💸 HOÀN TIỀN ĐẠI LÝ (QR) · 49.042.588đ · 05/09/2026\n🏪 HKD: HKD Trà My Nguyễn\n🔖 Số GD: 6248VNIB024XSW4W'
  ),
  // QR cc NĐT (không phí/hoàn)
  qrMsg(
    { title: 'Bill QR (NĐT)', tid: null, hkd: 'HKD Trà My Nguyễn', bank: null, dateTime: '05/09/2026 16:29:53', amount: 49_583_000, lo: null, ref: '6248VNIB024XSW4W', hideEdit: true },
    '🧾 Bill QR · HKD Trà My Nguyễn · 49.583.000đ · 05/09/2026\n🔖 Số GD: 6248VNIB024XSW4W'
  ),
  // POS để so sánh (title mặc định 'Bill POS', có Sửa, có Lô/TID/Ngân hàng)
  qrMsg(
    { tid: '58123', hkd: 'HKD Trà My Nguyễn', bank: 'MB', dateTime: '05/09/2026 16:29:53', amount: 36_597_000, lo: '51', feeLabel: 'Phí bán', feePct: 1.4, netLabel: 'Phải hoàn', netAmount: 36_084_642 },
    '🧾 Bill 58123 · HKD Trà My Nguyễn · 36.597.000đ · lô 51'
  )
];

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <div style={{ background: 'var(--color-appbg)', minHeight: '100vh', padding: '16px' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '18px', maxWidth: 760, margin: '0 auto' }}>
        {MSGS.map((m) => (
          <ChatBubble key={m.id} message={m} pickerOpen={false} onSetPickerOpen={() => undefined} onImageClick={() => undefined} />
        ))}
      </div>
    </div>
  </React.StrictMode>
);
