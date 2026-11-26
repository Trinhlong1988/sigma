// Sidebar menu — theo đúng plan mục C (KHÔNG copy nguyên menu nội bộ GLB): Trò chuyện · Bán TID ·
// Lô & Đối soát · Cảnh báo gian lận · Báo cáo/KPI · Danh bạ · Cài đặt. MỚI cho web-demo.
import { useEffect, useState, type JSX } from 'react';
import { BadgePercent, CreditCard, BarChart3, BookOpen, CalendarDays, Contact, LogOut, MessageCircle, PiggyBank, Settings, Wallet, Layers, ScanLine, Coins, Landmark, QrCode, FileSpreadsheet, HandCoins } from 'lucide-react';
import { AlphaLogo } from './AlphaLogo';
import { ConfirmDialog } from './ConfirmDialog';
import { ROUTES } from '../routes';
import { subscribeChatCategoriesChanged, type ChatCategoryDto } from '../lib/agent-api-client';
import { getCachedChatCategories } from '../lib/categories-cache';
import { getCachedAuthenticatedAgent } from '../lib/bot-api-client';
import { isAlphaOwnerCode, isQrReconViewerCode } from '../lib/alpha-aggregate-client';

interface NavItem {
  path: string;
  label: string;
  icon: JSX.Element;
  badge?: number;
}

export function Sidebar({
  activePath,
  onNavigate,
  unreadChat,
  pendingFriendRequests,
  onOpenSellTid,
  onLogout
}: {
  activePath: string;
  onNavigate: (path: string) => void;
  unreadChat: number;
  /** B107-tiếp (2/8, Admin Demo: "phải có thông báo số lượng lời mời kết bạn") — số lời mời kết bạn ĐANG CHỜ,
   * hiện badge đỏ trên mục "Danh bạ" (CÙNG kiểu unreadChat). */
  pendingFriendRequests: number;
  onOpenSellTid: () => void;
  onLogout: () => void;
}): JSX.Element {
  // Port vị trí nút "Đăng xuất" từ GLB desktop (Dashboard.tsx góc dưới-trái sidebar, dưới <nav>, TRÊN
  // dòng số phiên bản) — trước đây web-demo chỉ có nút đăng xuất trong màn Cài đặt; nay THÊM cố định ở
  // đây, giữ nguyên nút cũ trong Cài đặt (đúng 2 điểm vào như GLB gốc: sidebar cố định + màn phụ).
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Cutover 31/7 (việc #4) — phân loại nay là dữ liệu THẬT (apps/bot-api /v1/me/categories, KHÔNG còn mảng
  // mock module-level). Tải lúc mount + subscribeChatCategoriesChanged() (agent-api-client.ts, bus MỚI thay
  // notifyCategoriesChanged mock cũ) để tự refetch khi CategoryManagerModal (sibling dưới AppShell, không
  // share state React) tạo/sửa/xóa phân loại. Lỗi tải KHÔNG chặn sidebar — coi như CHƯA có phân loại nào,
  // CÙNG nguyên tắc "lỗi phụ không chặn luồng chính" (buildAgentNameResolver, chat-client.ts).
  // B122 (2/8) — qua `getCachedChatCategories()` (categories-cache.ts, THAY gọi thẳng `listChatCategories()`)
  // — CÙNG cache ChatListScreen.tsx đang dùng, tránh 2 nơi mỗi bên tự bắn 1 request cho CÙNG dữ liệu lúc cả
  // 2 mount gần như đồng thời (đo THẬT: 4 request/lần mở màn chat rỗng trước khi sửa).
  const [categories, setCategories] = useState<ChatCategoryDto[]>([]);
  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      const r = await getCachedChatCategories();
      if (!cancelled && r.ok) setCategories(r.data);
    }
    load();
    const unsubscribe = subscribeChatCategoriesChanged(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);
  // Admin Demo 24/7: "Danh bạ" lên vị trí ĐẦU TIÊN (trước cả "Trò chuyện"). Chỉ đổi thứ tự hiển thị,
  // route/path giữ nguyên.
  const items: NavItem[] = [
    { path: ROUTES.contacts, label: 'Danh bạ', icon: <Contact className="h-5 w-5" />, badge: pendingFriendRequests },
    { path: ROUTES.chat, label: 'Trò chuyện', icon: <MessageCircle className="h-5 w-5" />, badge: unreadChat },
    // Nối tắt doanh số ra ngoài cửa sổ chat (Admin Demo 21/8) — vào thẳng, không phải mở hội thoại → tab thông tin.
    { path: ROUTES.revenue, label: 'Doanh số', icon: <Wallet className="h-5 w-5" /> },

    // FIX-DEMOCK (4/8) — ĐÃ ẨN mục "Cảnh báo gian lận": màn FraudAlertsScreen 100% đọc từ mock-data/lo
    // (RECONCILE_DETAIL) — mọi cảnh báo Quy tắc A-F + badge số cờ là dữ liệu BỊA, không phản ánh Lô thật của
    // đại lý. bot-api CHƯA có endpoint tổng hợp cờ gian lận toàn bộ Lô (chỉ có reconcile TỪNG Lô on-demand),
    // nên ẩn nav item + badge + route (App.tsx) cho tới khi có API thật. KHÔNG hiển thị cảnh báo giả cho khách.
    // Doanh số nhà đầu tư (Admin Demo 26/8) — thành viên nhóm NĐT (kể cả đại lý) xem doanh số NĐT + tải Excel.
    { path: ROUTES.investorRevenue, label: 'Doanh số NĐT', icon: <PiggyBank className="h-5 w-5" /> },
    // "Báo cáo Báo-có" + "Tổng gộp SigMa" (Admin Demo 5/9) — CHỈ 3 chủ SigMa (ẩn menu theo agent.code; server VẪN
    // chặn 403). Đại lý/NĐT KHÔNG thấy. Báo cáo Báo-có = đối soát báo-có ngân hàng Digistore.
    // [Admin Demo 14/9 "ngoài team alpha không xem được chức năng nội bộ"] Lô & Đối soát + Báo cáo/KPI + Quét bill
    // gửi chuyển vào nhóm CHỈ-TEAM-SIGMA (server các route nhạy vẫn 403). Non-owner còn: chat + doanh số phòng
    // được thêm (gồm QR của phòng) + Doanh số NĐT (scoped nhóm) + tiện ích.
    ...(isAlphaOwnerCode(getCachedAuthenticatedAgent()?.code)
      ? [
          { path: ROUTES.lo, label: 'Lô & Đối soát', icon: <Layers className="h-5 w-5" /> },
          { path: ROUTES.kpi, label: 'Báo cáo/KPI', icon: <BarChart3 className="h-5 w-5" /> },
          { path: ROUTES.ocrSend, label: 'Quét bill gửi', icon: <ScanLine className="h-5 w-5" /> },
          { path: ROUTES.baoCoReport, label: 'Báo cáo QR', icon: <QrCode className="h-5 w-5" /> },
          { path: ROUTES.congNo, label: 'Tiền ĐL đang cầm', icon: <HandCoins className="h-5 w-5" /> },
          { path: ROUTES.statementRecon, label: 'Tra soát sao kê', icon: <FileSpreadsheet className="h-5 w-5" /> },
          { path: ROUTES.alphaAggregate, label: 'Tổng gộp SigMa', icon: <Coins className="h-5 w-5" /> },
          { path: ROUTES.promoPrograms, label: 'Khuyến mại', icon: <BadgePercent className="h-5 w-5" /> }
        ]
      : []),
    // [Admin Demo 22/9] Viewer Báo cáo QR (DL65 Khach Demo F) — KHÔNG phải owner nhưng được XEM màn Báo cáo QR.
    ...(!isAlphaOwnerCode(getCachedAuthenticatedAgent()?.code) && isQrReconViewerCode(getCachedAuthenticatedAgent()?.code)
      ? [{ path: ROUTES.baoCoReport, label: 'Báo cáo QR', icon: <QrCode className="h-5 w-5" /> }]
      : []),
    { path: ROUTES.binCheck, label: 'Tra BIN thẻ', icon: <CreditCard className="h-5 w-5" /> }, // [Admin Demo 12/9] mọi user dùng được
    { path: ROUTES.diary, label: 'Nhật ký', icon: <BookOpen className="h-5 w-5" /> },
    // Mục "Lịch" (Admin Demo 24/7 — "thêm tính năng lịch vào menu"): lịch vạn niên âm+dương, đặt SAU "Nhật ký"
    // TRƯỚC "Cài đặt" — nhóm cùng các mục xem-thông-tin (KPI/Nhật ký), không lẫn vào nhóm nghiệp vụ bán TID.
    { path: ROUTES.calendar, label: 'Lịch', icon: <CalendarDays className="h-5 w-5" /> },
    { path: ROUTES.settings, label: 'Cài đặt', icon: <Settings className="h-5 w-5" /> }
  ];

  return (
    <div className="flex h-full w-60 shrink-0 flex-col bg-sidebar text-sidebar-text">
      <div className="flex items-center gap-2 px-4 pb-4 pt-[calc(env(safe-area-inset-top)+1rem)]">
        <AlphaLogo className="h-8 w-8" />
        <span className="text-base font-bold text-slate-700">SigMa</span>
      </div>

      <button
        type="button"
        onClick={onOpenSellTid}
        className="btn-primary mx-3 mb-3 flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-semibold text-white shadow-soft"
      >
        <Wallet className="h-4 w-4" />
        Bán TID
      </button>

      <nav className="flex-1 space-y-1 overflow-auto px-2">
        {items.map((item) => {
          const active = activePath.startsWith(item.path);
          const isChat = item.path === ROUTES.chat;
          return (
            <div key={item.path}>
              <button
                onClick={() => onNavigate(item.path)}
                // 6/8 (Admin Demo "nav-active LỆCH TÔNG với nút Bán TID", có ảnh) — mục đang chọn TRƯỚC ĐÂY chỉ set
                // `background: var(--gradient-accent)` (gradient TRƠN) + `text-white shadow-soft` tự chế → THIẾU
                // glass của `.btn-primary` (sheen ::before, viền rim #a3defd, box-shadow glow, text-shadow) mà nút
                // "Bán TID" (dùng .btn-primary) có. Nay active dùng CHÍNH `.btn-primary` (brand.css) — CÙNG
                // gradient + sheen + rim + glow + màu + text-shadow, ĐỒNG NHẤT tuyệt đối với "Bán TID" (cùng
                // px-3 py-2.5). Bỏ style gradient trơn + bỏ text-white/shadow-soft tự chế (để .btn-primary lo hết).
                className={
                  'flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm font-medium transition ' +
                  (active ? 'btn-primary text-white' : 'rounded-lg hover:bg-white/70')
                }
              >
                {item.icon}
                <span className="flex-1 truncate">{item.label}</span>
                {!!item.badge && (
                  <span
                    className={
                      'flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold ' +
                      // Active: nền TRẮNG đặc + chữ brand → đọc RÕ trên nền glass xanh (bg-white/25 cũ mờ khó đọc).
                      // Không-active: badge đỏ "chưa đọc/lời mời" nổi bật trên nền sidebar sáng.
                      (active ? 'bg-white text-brand shadow-soft' : 'bg-danger text-white')
                    }
                  >
                    {item.badge}
                  </span>
                )}
              </button>
              {/* Mục 21 — phân loại con dưới "Trò chuyện": chấm màu + tên, bấm lọc danh sách chat. */}
              {isChat && (
                <div className="mb-1 mt-0.5 space-y-0.5 pl-9 pr-2">
                  {categories.map((cat) => (
                    <button
                      key={cat.id}
                      onClick={() => onNavigate(`${ROUTES.chat}?cat=${cat.id}`)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-sidebar-text transition hover:bg-white/70"
                    >
                      <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: cat.color }} />
                      <span className="truncate">{cat.name}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {/* Port nguyên xi từ GLB desktop Dashboard.tsx (khối `px-3 py-3` dưới <nav>, nút LogOut + "Đăng
          xuất" cùng style, hover:bg-danger/20 hover:text-white).
          B41 (27/7, Admin Demo báo thật "menu/nút cuối app bị thanh điều hướng điện thoại che") — khối này là
          phần tử THẤP NHẤT của menu mobile (drawer AppShell.tsx `fixed inset-0`), trước đây KHÔNG cộng thêm
          safe-area đáy (chỉ TopBar.tsx có `pt-[env(safe-area-inset-top)]` cho đầu trang, chưa ai làm tương tự
          cho đáy) — nút "Đăng xuất" bị thanh cử chỉ/nav ảo của điện thoại đè lên, bấm trúng khó/không được. */}
      <div className="px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
        <button
          type="button"
          onClick={() => setConfirmOpen(true)}
          className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-sidebar-text transition hover:bg-danger/20 hover:text-white"
        >
          <LogOut className="h-[18px] w-[18px]" />
          Đăng xuất
        </button>
      </div>

      {confirmOpen && (
        <ConfirmDialog
          title="Đăng xuất"
          message="Bạn chắc chắn muốn đăng xuất khỏi SigMa trên thiết bị này?"
          confirmLabel="Đăng xuất"
          danger
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => {
            setConfirmOpen(false);
            onLogout();
          }}
        />
      )}
    </div>
  );
}
