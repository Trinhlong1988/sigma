// Đường dẫn route dùng chung — cho phép Playwright (scripts/capture-frames.ts) và điều hướng nội bộ
// (Sidebar/AppShell) trỏ tới đúng 1 nơi, tránh string trần rải rác.
export const ROUTES = {
  // SigMa (27/7, phát hiện qua Admin Demo test thật trên máy khách) — TRƯỚC ĐÂY gallery='/' nên bản ship
  // thật cho khách mở app ra thấy ngay màn trưng bày thiết kế Phase 0 (100% mock) thay vì app thật. Tách
  // riêng khỏi root — '/' giờ tự chuyển hướng theo session (xem RootRedirect trong App.tsx), gallery chỉ còn
  // dùng nội bộ (Playwright capture-frames.ts), không có link nào trỏ tới từ UI thật.
  gallery: '/design-gallery',
  login: '/login',
  otp: '/otp',
  /** SIGMA (3/8) — đăng nhập bằng QR động phía MÁY TẠO QR (PC/web), public (chưa đăng nhập). */
  qrLogin: '/qr-login',
  /** SIGMA (3/8) — quét mã đăng nhập phía ĐIỆN THOẠI đã đăng nhập (trong AppShell, cần phiên). */
  qrScan: '/app/qr-scan',
  chat: '/app/chat',
  chatRoom: (id: string): string => `/app/chat/${id}`,
  /** "Doanh số theo nhóm chat" (1/8, B100 hạ tầng + UI) — báo cáo doanh số các TID đã gắn phòng `id`, mở từ
   * nút "Doanh số" trong GroupInfoPanel.tsx. */
  chatRoomRevenue: (id: string): string => `/app/chat/${id}/revenue`,
  /** NỐI TẮT doanh số RA NGOÀI cửa sổ chat (Admin Demo 21/8) — màn liệt kê nhóm đại lý để xem doanh số mà KHÔNG
   * phải mở hội thoại → tab thông tin → nút Doanh số (3 bước). Vào thẳng từ Sidebar. */
  revenue: '/app/revenue',
  lo: '/app/lo',
  loDetail: (id: string): string => `/app/lo/${id}`,
  fraud: '/app/fraud',
  kpi: '/app/kpi',
  investorRevenue: '/app/investor-revenue',
  contacts: '/app/contacts',
  settings: '/app/settings',
  qr: '/app/qr',
  sellTid: '/app/sell-tid',
  myQr: '/app/my-qr',
  security: '/app/security',
  call: (kind: 'voice' | 'video'): string => `/app/call/${kind}`,
  incomingCall: '/app/call/incoming',
  profile: '/app/profile',
  /** Link cá nhân (mục 24/34) — hồ sơ CÔNG KHAI của người khác theo username RC, KHÁC `profile` (hồ sơ CỦA
   * MÌNH, chỉnh sửa được). Route nội bộ — app KHÔNG deploy domain public thật ở Phase này, chỉ cần cơ chế
   * route+link hoạt động đúng trong app (xem PublicProfileScreen.tsx). */
  profileByUsername: (username: string): string => `/app/u/${encodeURIComponent(username)}`,
  /** "Quét bill gửi" (30/8) — menu OCR bill → gửi nhóm đại lý + cc NĐT. 2 chế độ thủ công/tự động. */
  ocrSend: '/app/ocr-send',
  /** "Tiền đại lý đang cầm" (17/9) — sổ theo dõi lô CHƯA hoàn theo TỪNG đại lý: ngày giờ · TID · HKD · số lô ·
   *  tiền, tách "chưa đối soát" và "chờ hoàn". CHỈ chủ SigMa (server owner-gate). */
  congNo: '/app/cong-no',
  /** "Tra soát sao kê" (7/9) — upload sao kê ngân hàng (xlsx) → khớp hoàn đại lý/NĐT + báo cáo. CHỈ 3 chủ SigMa. */
  statementRecon: '/app/statement-recon',
  /** "Tổng gộp SigMa" (5/9) — báo cáo tổng doanh số POS+QR + hoàn, theo NĐT & đại lý. CHỈ 3 chủ SigMa (server enforce). */
  alphaAggregate: '/app/alpha-aggregate',
  /** "Báo cáo Báo-có" (5/9) — đối soát báo-có ngân hàng Digistore (BVBank): bảng theo kỳ + lọc + dòng CHƯA đối soát.
   * Quyền: tạm mọi user (LEAD chốt owner-gate sau — server sẽ là lớp chặn thật). */
  baoCoReport: '/app/baoco-report',
  binCheck: '/app/bin-check',
  promoPrograms: '/app/promo-programs',
  diary: '/app/diary',
  /** Nhật ký của 1 đại lý khác (mục 40 — "Xem nhật ký" từ hồ sơ bạn bè ở ContactsScreen). Chỉ xem được nếu là
   * bạn bè/của mình (bot-api tự chặn NOT_VISIBLE). */
  diaryOf: (agentId: number): string => `/app/diary/${agentId}`,
  calendar: '/app/calendar',
  lockscreenPreview: '/preview/lockscreen'
} as const;
