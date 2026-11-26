// HARNESS TẠM (KHÔNG commit) — render ChatBubble với các tin bill CHUYỂN KHOẢN (transferCk) 5 loại, để Playwright
// chụp ở 390px (mobile) + desktop, xác minh card ẢNH-trái + BẢNG-tham-số-phải, ô rõ, số tiền nổi bật, không tràn.
// Ảnh bill lấy qua AttachmentImage (proxyFetch) → Playwright chặn URL `http://ck.local/att/*` trả placeholder SVG.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ChatBubble } from './components/ChatBubble';
import type { ChatMessage, TransferCkMeta } from './mock-data/types';
import './styles.css';

let seq = 0;
function ckMsg(mine: boolean, transferCk: TransferCkMeta, senderName: string): ChatMessage {
  seq += 1;
  return {
    id: `ck-${seq}`,
    roomId: 'r1',
    senderId: mine ? 'me' : 'other',
    senderName,
    mine,
    type: 'image',
    imageUrl: `http://ck.local/att/${seq}.svg`,
    time: '14:32',
    status: 'seen',
    // caption thô cũ (nhiều dòng) — CỐ Ý gắn để chứng minh card MỚI KHÔNG còn hiện đoạn text lộn xộn này.
    text: '💸 Hoàn tiền đại lý\n🏦 Người gửi: KHACH HANG 01\n💰 Số tiền: 122.859.000đ\n🧾 Mã GD: ck|ref|FT24313ABC123',
    transferCk
  };
}

const MSGS: ChatMessage[] = [
  ckMsg(true, { kind: 'REFUND', amount: 122859000, billDate: '31/08/2026', ckTxnKey: 'ck|ref|FT24313ABC123', direction: 'SIGMA_TO_DEALER' }, 'Tôi'),
  ckMsg(false, { kind: 'ADVANCE', amount: 5000000, billDate: '01/09/2026', ckTxnKey: 'ck|ref|FT24999XY' }, 'Bot SigMa'),
  ckMsg(true, { kind: 'INVESTOR_ADVANCE', amount: 20000000, ckTxnKey: 'ck|hash|9f8a7b6c5d4e3f2a1b0c8d7e6f', direction: 'SIGMA_TO_INVESTOR' }, 'Tôi'),
  ckMsg(false, { kind: 'DEALER_REFUND_OVER', amount: -300000, billDate: '30/08/2026', ckTxnKey: 'ck|ref|FT24777QQ' }, 'Bot SigMa'),
  ckMsg(true, { kind: 'INVESTOR_REPAYMENT', amount: 1500000, ckTxnKey: 'ck|nat|1500000-20260901', direction: 'INVESTOR_TO_ALPHA' }, 'Tôi')
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
