// Trang chủ khi `npm run dev` (spec mục 4) — hiển thị TẤT CẢ màn hình trong DeviceFrame ở cả 3 khổ,
// cuộn xem được. Dùng tab chọn khổ máy (Desktop/Android/iPhone) thay vì render cả 3x13 khung cùng lúc
// (đỡ nặng máy) — mỗi tab vẫn liệt kê ĐỦ mọi màn hình ở đúng khổ đó.
import { useState, type JSX } from 'react';
import { Link } from 'react-router';
import { Laptop, Smartphone, Tablet } from 'lucide-react';
import { DeviceFrame, type DeviceVariant } from '../components/DeviceFrame';
import { TabBar, TabButton } from '../components/Tabs';
import { AlphaLogo } from '../components/AlphaLogo';
import { LoginScreen } from './LoginScreen';
import { OtpScreen } from './OtpScreen';
import { ChatListScreen } from './ChatListScreen';
import { ConversationScreen } from './ConversationScreen';
import { SellTidModalContent } from './SellTidModal';
import { LoHistoryScreen } from './LoHistoryScreen';
import { ReconcileDetailScreen } from './ReconcileDetailScreen';
import { QrDisplayScreen } from './QrDisplayScreen';
import { KpiReportScreen } from './KpiReportScreen';
import { SettingsScreen } from './SettingsScreen';
import { FraudAlertsScreen } from './FraudAlertsScreen';
import { ContactsScreen } from './ContactsScreen';
import { MyQrScreen } from './MyQrScreen';
import { AccountSecurityScreen } from './AccountSecurityScreen';
import { CallScreen } from './CallScreen';
import { IncomingCallScreen } from './IncomingCallScreen';
import { ProfileScreen } from './ProfileScreen';
import { DiaryScreen } from './DiaryScreen';
import { LockScreenPreview } from './LockScreenPreview';
import { BillFieldsTable } from '../components/BillFieldsTable';
import { CHAT_ROOMS } from '../mock-data/chats';
import { LO_RECORDS } from '../mock-data/lo';
import { ROUTES } from '../routes';
import type { OcrBillPreview } from '../lib/agent-api-client';

const noop = (): void => undefined;

// Preview tĩnh của SellTidModal — KHÔNG dùng Modal thật (createPortal + fixed inset-0) vì trong
// DeviceFrame thu nhỏ nó sẽ thoát ra phủ toàn trang thật thay vì nằm gọn trong khung xem trước.
function SellTidPreview(): JSX.Element {
  return (
    <div className="flex h-full items-center justify-center bg-slate-900/40 p-4">
      <div className="w-full max-w-lg rounded-xl border border-line bg-white shadow-2xl">
        <div className="border-b border-line px-5 py-3.5">
          <h3 className="text-base font-semibold text-slate-800">Bán TID</h3>
        </div>
        <div className="max-h-[70vh] overflow-auto p-5">
          <SellTidModalContent onClose={noop} />
        </div>
      </div>
    </div>
  );
}

const ENTRIES: Array<{ name: string; node: JSX.Element }> = [
  { name: 'Đăng nhập', node: <LoginScreen onSubmitEmail={noop} onLoggedIn={noop} /> },
  { name: 'Nhập mã OTP', node: <OtpScreen email="ban@vidu.com" onVerified={noop} onBack={noop} /> },
  { name: 'Danh sách chat', node: <ChatListScreen onOpenRoom={noop} /> },
  // Preview thiết kế thuần (trang gallery dev-only, KHÔNG phải luồng app thật) — Phase 3 (29/7) ConversationScreen
  // giờ nhận thẳng `ChatRoom` (mock-data/types), không cần field mở rộng nào nữa. Không có phiên đăng nhập
  // thật ở đây nên màn sẽ tự hiện banner lỗi "chưa đăng nhập"/tải lịch sử lỗi thay vì tin nhắn mock — chấp
  // nhận được vì trang này chỉ minh họa khung UI, không phải nơi verify luồng chat thật.
  { name: 'Cửa sổ chat', node: <ConversationScreen room={{ ...CHAT_ROOMS[0] }} onBack={noop} /> },
  { name: 'Bán TID (2 bước)', node: <SellTidPreview /> },
  { name: 'Lịch sử Lô', node: <LoHistoryScreen onOpenDetail={noop} /> },
  // Preview tĩnh (trang gallery dev-only) — KHÔNG có phiên đăng nhập RC/Lô thật ở đây nên màn sẽ tự hiện
  // banner lỗi (chưa đăng nhập/không tìm thấy Lô) thay vì dữ liệu mock, CÙNG hành vi đã chấp nhận ở
  // SellTidPreview phía trên (không giả lập dữ liệu giả cho preview).
  { name: 'Chi tiết đối soát (Quy tắc A-F)', node: <ReconcileDetailScreen loId="1" onBack={noop} /> },
  { name: 'Cảnh báo gian lận', node: <FraudAlertsScreen onOpenLo={noop} /> },
  { name: 'Hiển thị QR nhận tiền', node: <QrDisplayScreen /> },
  { name: 'Báo cáo / KPI', node: <KpiReportScreen /> },
  { name: 'Danh bạ (kết bạn/lời mời)', node: <ContactsScreen onChat={noop} /> },
  { name: 'Mã QR của tôi', node: <MyQrScreen /> },
  { name: 'Gọi thoại 1-1', node: <CallScreen kind="voice" room={CHAT_ROOMS[0]} onEnd={noop} /> },
  { name: 'Gọi video nhóm', node: <CallScreen kind="video" room={CHAT_ROOMS[1]} onEnd={noop} /> },
  { name: 'Cuộc gọi đến', node: <IncomingCallScreen room={CHAT_ROOMS[0]} onAccept={noop} onReject={noop} onQuickReply={noop} /> },
  { name: 'Tài khoản & bảo mật', node: <AccountSecurityScreen /> },
  { name: 'Hồ sơ của tôi', node: <ProfileScreen /> },
  { name: 'Nhật ký', node: <DiaryScreen /> },
  { name: 'Cài đặt', node: <SettingsScreen theme="light" onToggleTheme={noop} /> }
];

const VARIANTS: Array<{ key: DeviceVariant; label: string; icon: JSX.Element; scale: number }> = [
  { key: 'desktop', label: 'Máy tính', icon: <Laptop className="h-4 w-4" />, scale: 0.32 },
  { key: 'android', label: 'Android', icon: <Tablet className="h-4 w-4" />, scale: 0.55 },
  { key: 'iphone', label: 'iPhone', icon: <Smartphone className="h-4 w-4" />, scale: 0.55 }
];

export function GalleryPage(): JSX.Element {
  const [variant, setVariant] = useState<DeviceVariant>('desktop');

  return (
    <div className="h-full w-full overflow-auto bg-appbg p-6">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AlphaLogo className="h-9 w-9" />
            <div>
              <h1 className="text-xl font-bold text-slate-800">SigMa — Demo thiết kế (Phase 0)</h1>
              <p className="text-sm text-slate-500">Dữ liệu giả lập, không kết nối bot-api/Rocket.Chat thật.</p>
            </div>
          </div>
          <Link
            to={ROUTES.login}
            className="btn-primary px-4 py-2.5 text-sm font-semibold text-white shadow-soft"
          >
            Vào demo tương tác →
          </Link>
        </div>

        <TabBar>
          {VARIANTS.map((v) => (
            <TabButton key={v.key} active={variant === v.key} onClick={() => setVariant(v.key)} icon={v.icon}>
              {v.label}
            </TabButton>
          ))}
        </TabBar>

        <div className="flex flex-wrap gap-8">
          {ENTRIES.map((entry) => {
            const scale = VARIANTS.find((v) => v.key === variant)?.scale ?? 0.4;
            return (
              <div key={entry.name} className="flex flex-col items-center gap-2">
                <DeviceFrame variant={variant} scale={scale}>
                  {entry.node}
                </DeviceFrame>
                <span className="text-sm font-medium text-slate-600">{entry.name}</span>
              </div>
            );
          })}
        </div>

        {/* Mục 35 — preview push notification màn khóa điện thoại: LUÔN khung iphone (spec chỉ định). */}
        <h2 className="mb-4 mt-10 text-base font-bold text-slate-800">Push thông báo trên màn khóa (preview)</h2>
        <div className="flex flex-col items-center gap-2 self-start" style={{ width: 'fit-content' }}>
          <DeviceFrame variant="iphone" scale={0.55}>
            <LockScreenPreview />
          </DeviceFrame>
          <span className="text-sm font-medium text-slate-600">Màn khóa iPhone — thông báo SigMa</span>
        </div>

        {/* B121 (2/8) — preview bảng kết quả OCR "Lưới ô vuông" (Phương án B, Admin Demo yêu cầu trực tiếp đổi
            từ bảng 1-cột-8-hàng cũ). Dữ liệu fixture THẬT (bill MB Bank thật, TID 50550759, "HKD DEMOMAY 1" —
            xem apps/bot-api/test/ocr-bridge.test.ts REAL_BILL_COMMA_BUG_OCR_LINES/extractBillFields()), KHÔNG
            bịa — cùng bill đã verify OCR đọc đúng CẢ 6 field. */}
        <h2 className="mb-4 mt-10 text-base font-bold text-slate-800">Kết quả quét bill — Lưới ô vuông (preview)</h2>
        <div className="flex flex-col items-center gap-2 self-start" style={{ width: 'fit-content' }}>
          <div className="w-80 rounded-xl border border-line bg-white p-3 shadow-2xl">
            <BillFieldsTable billFields={GALLERY_BILL_FIELDS_FIXTURE} amountDisplay="140.000.000đ" refundText="138.460.000đ (phí 1,1%)" />
          </div>
          <span className="text-sm font-medium text-slate-600">Bảng OCR bill trong khung chat — dữ liệu mẫu bill thật</span>
        </div>
      </div>
    </div>
  );
}

// Fixture THẬT (KHÔNG bịa) — copy nguyên giá trị đã verify OCR đọc đúng từ bill MB Bank thật TID 50550759
// (apps/bot-api/test/ocr-bridge.test.ts REAL_BILL_COMMA_BUG_OCR_LINES). Chỉ dùng cho preview design gallery
// dev-only — KHÔNG phải luồng app thật (không gọi OCR/bot-api).
const GALLERY_BILL_FIELDS_FIXTURE: OcrBillPreview = {
  found: true,
  rawText: '140,000.000',
  parsedAmount: 140000000,
  needsManualReview: false,
  reasons: [],
  tid: { value: '50550759', uncertain: false },
  hkdName: { value: 'HKD DEMOMAY 1', uncertain: false },
  dateTime: { value: '21/11/2025 10:39:56', uncertain: false },
  batchNumber: { value: '000189', uncertain: false },
  invoiceNumber: { value: '001283', uncertain: false },
  bankName: { value: 'MB', uncertain: false },
  tidMatched: false,
  settlementRisk: null
};
