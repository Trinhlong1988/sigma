// ĐIỂM VÀO TRANG THỬ (harness-probe.html) — mount THẲNG 1 màn để chụp ảnh/đo bằng Playwright.
// Vì sao cần: 2 màn SỬA bill (POS / hoàn tiền) là MODAL nằm sâu trong luồng chat (phải có phòng + tin nhắn bill +
// quyền sửa) — dựng lại cả luồng chỉ để chụp 1 ảnh là tốn và giòn. Trang này nhận `?man=pos|ck` rồi render đúng
// modal với dữ liệu mẫu, KHÔNG đụng gì tới app thật (không được import ở đâu khác; build production chỉ lấy
// index.html nên file này KHÔNG vào bản phát hành).
import { createRoot } from 'react-dom/client';
import '../../src/styles.css';
import { EditBillMessageModal } from '../../src/components/EditBillMessageModal';
import { EditRefundMessageModal } from '../../src/components/EditRefundMessageModal';
import type { ChatMessage } from '../../src/mock-data/types';

const oO = (value: string): { value: string; confidence: number } => ({ value, confidence: 0.99 });

const BILL_MSG = {
  id: 'msg-pos', roomId: 'r1', senderId: 'u-me', senderName: 'Tôi', mine: true, type: 'image',
  text: '', time: '14:58', status: 'seen', attachmentId: 'att-1', imageUrl: '/files/bill-pos.jpg',
  billMeta: {
    amount: 19_998_000,
    imageHeightPx: 900, // modal cắt phần ảnh bill theo mốc này (thiếu là cắt lỗi → báo 'không tải được ảnh')
    billFields: {
      tid: oO('53590002'), hkdName: oO('HKD DEMO 5 2'), dateTime: oO('10/09/2026 14:58'),
      batchNumber: oO('72'), invoiceNumber: oO('001210'), bankName: oO('MB'),
      tidMatched: true, settlementRisk: null, amountCandidates: [], parsedAmount: 19_998_000, needsManualReview: false
    }
  }
} as unknown as ChatMessage;

const REFUND_MSG = {
  id: 'msg-ck', roomId: 'r1', senderId: 'u-me', senderName: 'Tôi', mine: true, type: 'image',
  text: '', time: '17:42', status: 'seen', attachmentId: 'att-2', imageUrl: '/files/bill-ck.jpg',
  refundMeta: {
    amount: 122_859_000,
    imageHeightPx: 900,
    refundFields: {
      bankName: oO('VPBank'), senderName: oO('KHACH HANG 01'), recipientName: oO('DLY HUY DAKLAK'),
      recipientAccountNumber: oO('0900000600'), dateTime: oO('09/09/2026 17:42'),
      recipientMatch: { status: 'matched' }, amountCandidates: [], parsedAmount: 122_859_000, needsManualReview: false
    }
  }
} as unknown as ChatMessage;

const man = new URLSearchParams(window.location.search).get('man') ?? 'pos';
const root = createRoot(document.getElementById('root')!);
root.render(
  man === 'ck'
    ? <EditRefundMessageModal message={REFUND_MSG} roomId="r1" onClose={() => { /* trang thử: không đóng */ }} />
    : <EditBillMessageModal message={BILL_MSG} roomId="r1" onClose={() => { /* trang thử: không đóng */ }} />
);
