// HARNESS TẠM (KHÔNG commit) — render ConversationScreen full-width mobile (không scale) để Playwright đo
// header px thật + chụp before/after bug header vỡ mobile. Backend không chạy → vùng tin nhắn hiện lỗi tải,
// nhưng HEADER render ngay từ prop `room` (độc lập fetch) nên đo được. Xoá sau khi xong Lane D.
import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConversationScreen } from './screens/ConversationScreen';
import { CHAT_ROOMS } from './mock-data/chats';
import { initFontLevel } from './font-scale';
import './styles.css';

initFontLevel();

// Tên DÀI + phòng DIRECT (isGroup=false) để hiện cả nút gọi/video — tái hiện đúng cảnh chật icon nhất.
const longRoom = { ...CHAT_ROOMS[0], name: 'Nguyễn Thị Hồng Ke Toan Demo Vương Quốc', isGroup: false };

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('#root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <div style={{ height: '100vh' }}>
      <ConversationScreen room={longRoom} onBack={() => undefined} onStartCall={() => undefined} />
    </div>
  </React.StrictMode>
);
