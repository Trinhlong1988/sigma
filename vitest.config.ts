import { defineConfig } from 'vitest/config';

// Root Vitest config — runs pure-logic tests in packages/shared + packages/business-rules.
// These packages have NO Electron/Prisma-client runtime dependency, so tests run in plain Node.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: [
      'packages/shared/**/*.test.ts',
      'packages/business-rules/**/*.test.ts',
      // @sigma/services — LỚP SERVICE LIVE (core ctx-based, Db GIẢ in-memory ĐÚNG SHAPE Prisma, KHÔNG cần
      // Postgres/Electron — xem packages/services/vitest.config.ts). TRƯỚC ĐÂY root `npm test` KHÔNG include
      // glob này → toàn bộ ~53 file test lớp service (pos/customer/tid/investor/handover/fee-config/...) ÂM
      // THẦM bị bỏ (false-coverage: `vitest run` báo xanh mà KHÔNG chạy 1 test service nào). Glob-hoá vì các
      // test này chạy được ở env 'node' thuần (cùng environment root), KHÔNG cần jsdom.
      'packages/services/**/*.test.ts',
      // Static-source guards (fs-scan only, KHÔNG import Electron/Prisma runtime).
      'apps/desktop/src/main/**/*.test.ts',
      // Renderer helper THUẦN (không React/DOM) — anySellFeeCustom (sell-fee-entries.ts): suy anyCustom theo GIÁ
      // TRỊ chống wipe override giá bán thực tế (audit 21/8 FE-2). Chạy env node như các pure-logic test khác.
      'apps/desktop/src/renderer/src/lib/sell-fee-entries.test.ts',
      // [PHÍM TẮT 24/11] Logic THUẦN hệ phím tắt màn Nhập bill: công tắc tổng/tắt lẻ, Enter-N-lần + reset
      // timeout, Esc 2 nấc, map người hoàn ↔ phím + sắp xếp theo phím, localStorage per-user; + suy thương
      // hiệu thẻ (cardBrand). Không React/DOM → chạy env 'node' như các pure-logic test khác.
      'apps/desktop/src/renderer/src/lib/shortcut.test.ts',
      // Lịch vạn niên (mục "Lịch", 25/7) — ĐÃ CHUYỂN sang packages/shared/src/lunar-calendar.test.ts (việc #31,
      // promote lịch sang @sigma/shared để CẢ web-demo lẫn bot-api dùng 1 nguồn) → tự động chạy qua glob
      // 'packages/shared/**/*.test.ts' ở trên, KHÔNG cần liệt kê tay ở đây nữa.
      // Tách tin nhắn dài theo ngưỡng ký tự (B29-tiếp, 26/7) — splitMessageIntoChunks() trong rc-realtime.ts
      // là hàm thuần (không gọi RC/DOM), cùng lớp "pure-logic test" của config gốc này.
      // [17/9] Tiền hoàn: nội dung CK VietQR + luật LÀM TRÒN XUỐNG nghìn (2 bản client/server phải ra y hệt).
      'apps/web-demo/src/lib/digistore-noidung-ck.test.ts',
      'apps/web-demo/src/lib/lam-tron-nghin-xuong.test.ts',
      'apps/web-demo/src/lib/rc-message-split.test.ts',
      // B49 (29/7) — fetchAttachmentObjectUrl() phải luôn đi qua proxyFetch (credentials+CSRF header), không
      // dùng URL/document thật nên chạy được ở environment 'node' này.
      'apps/web-demo/src/lib/attachment-blob.test.ts',
      'apps/web-demo/src/lib/revenue-lot-xls.test.ts',
      // [Admin Demo 2/9] dò LÔ NHẢY SỐ (sự cố KHACH HANG 62 3 thiếu lô 94 câm) — hàm thuần, chống sót bill.
      'apps/web-demo/src/lib/lot-gap.test.ts',
      // [Admin Demo 2/9] theo dõi giờ-sửa từng trường (log "đã sửa lúc HH:mm" dưới trường) — hàm thuần.
      'apps/web-demo/src/lib/edit-stamp.test.ts',
      // [Admin Demo 2/9] chứng minh gốc review-loạn-lô = keyOf trùng → pool dedup lẫn; fix index.
      'apps/web-demo/src/lib/ocr-prefetch-pool-collision.test.ts',
      // Item 14 (6/8) — coerceAudioBlob ép MIME video/webm→audio/webm cho voice cũ phát được (thuần, KHÔNG DOM).
      'apps/web-demo/src/lib/attachment-audio-coerce.test.ts',
      // Cụm Nhật ký (6/8) — diary-ui.ts: clampGalleryIndex/shouldTriggerPullRefresh (lightbox + pull-to-refresh), thuần.
      'apps/web-demo/src/lib/diary-ui.test.ts',
      // #32 (6/8) — diary realtime bell: parseDiaryNotifyPayload + applyRealtimeDiaryPost (+1 optimistic, dedupe postId), thuần.
      'apps/web-demo/src/lib/diary-notify.test.ts',
      // Nợ độ tin cậy đánh thức cuộc gọi (30/7) — buildIncomingCallNavigation() (call-signaling-client.ts) là
      // hàm thuần dùng bởi AppShell.tsx global listener 'incoming_call', cùng lớp "pure-logic test" ở trên.
      // fix-call-wiring (31/7) — file này CŨNG giờ test buildStartCallNavigation() (thêm cùng đợt fix bug
      // "Gọi thoại/Gọi video từ hội thoại thật không đổ chuông").
      'apps/web-demo/src/lib/call-signaling-navigation.test.ts',
      // fix-call-wiring (31/7) — resolveDirectPeerAgentId() (chat-client.ts) là hàm thuần dùng bởi
      // ConversationScreen.tsx để tự tra agentId đối phương cho phòng DIRECT, cùng lớp "pure-logic test" ở trên.
      'apps/web-demo/src/lib/call-peer-resolution.test.ts',
      // "BẢNG TIN" / GHIM KHÔNG GIỚI HẠN (5/8) — pinnedMessagePreview() (chat-client.ts) là hàm thuần dựng nhãn
      // xem trước tin đã ghim (banner + PinBoardPanel), KHÔNG DOM — cùng lớp "pure-logic test" ở trên.
      'apps/web-demo/src/lib/pinned-message-preview.test.ts',
      // B71-part3 (31/7) — previewLoOcr() (agent-api-client.ts) là hàm thuần dùng fetch/FormData built-in (Node
      // 24, không DOM thật), test mock global.fetch — cùng lớp "pure-logic test" ở trên.
      'apps/web-demo/src/lib/agent-api-client.test.ts',
      // B71-part3 (31/7) — deriveOcrPreviewUiState() (ocr-preview-ui.ts) là hàm thuần quyết định UI state của
      // form OCR preview ReconcileDetailScreen.tsx, KHÔNG DOM — cùng lớp "pure-logic test" ở trên (repo CHƯA
      // có jsdom/@testing-library/react để render-test component thật, xem comment đầu ocr-preview-ui.ts).
      'apps/web-demo/src/lib/ocr-preview-ui.test.ts',
      // 31/7 — lookupAgentByContact() (agent-api-client.ts, tìm bạn qua email/SĐT) là hàm thuần mock
      // global.fetch, KHÔNG DOM — cùng lớp "pure-logic test" ở trên. File TÁCH RIÊNG khỏi
      // agent-api-client.test.ts (đợt B71-part3 OCR song song, tránh đụng file chưa commit của đợt khác — xem
      // comment đầu file test).
      'apps/web-demo/src/lib/agent-api-client.contact-lookup.test.ts',
      // SIGMA (31/7, việc #5 — ghi âm/phát tin nhắn thoại THẬT) — formatSecondsToDurationLabel()/
      // parseDurationLabelToSeconds() + nhánh mapChatMessage() kind VOICE (chat-client.ts) là hàm THUẦN, cùng
      // lớp "pure-logic test" ở trên.
      'apps/web-demo/src/lib/voice-message-mapping.test.ts',
      // Mục 23 (31/7 — chụp màn hình gửi vào chat THẬT, thay mock cũ) — screen-capture.ts: phần THUẦN
      // (feature-detect/dịch lỗi/sinh tên file) không phụ thuộc DOM thật, cùng lớp "pure-logic test" ở trên
      // (repo CHƯA có jsdom/@testing-library/react — phần DOM/getDisplayMedia() thật verify bằng Playwright).
      'apps/web-demo/src/lib/screen-capture.test.ts',
      // B115-tiếp (2/8) — parseChatNotifyPayload() (chat-realtime.ts) là hàm THUẦN validate shape sự kiện
      // server 'chat-notify' (banner "có tin nhắn mới" khi app mở nhưng KHÔNG đúng phòng, xem AppShell.tsx) —
      // cùng lớp "pure-logic test" ở trên (repo CHƯA có jsdom/@testing-library/react để mock WebSocket thật).
      'apps/web-demo/src/lib/chat-notify-payload.test.ts',
      // 8/8 (đồng bộ push đếm mọi nền) — parseAgentNotifyPayload() (chat-realtime.ts) validate shape sự kiện
      // 'agent-notify' (kết bạn/nhóm). Hàm THUẦN, KHÔNG WS/DOM — cùng lớp "pure-logic test" (guard bắt mồ côi).
      'apps/web-demo/src/lib/agent-notify-payload.test.ts',
      // LAG-FIX (12/8) — computeResizedDimensions/encodeResizedJpegBlob/resizeImageForUpload (image-resize.ts):
      // phần THUẦN (tính kích thước giữ tỉ lệ) + nhánh fallback/Worker giả (vi.stubGlobal) chạy env node, KHÔNG
      // cần DOM thật (createImageBitmap/OffscreenCanvas verify bằng Playwright) — cùng lớp "pure-logic test".
      'apps/web-demo/src/lib/image-resize.test.ts',
      // Wiring nén ảnh vào MessageComposer (12/8) — sendResizedImage(): hàm THUẦN (mock resize/upload), chọn
      // đường ảnh/không-ảnh, env node — cùng lớp "pure-logic test".
      'apps/web-demo/src/lib/composer-image-send.test.ts',
      // Lane D vòng 2 (3/8, việc 2 — WS reconnect backoff) — computeReconnectDelay() (chat-realtime.ts) là hàm
      // THUẦN (nhận rng tất định, không WebSocket/DOM), cùng lớp "pure-logic test" ở trên.
      'apps/web-demo/src/lib/chat-realtime-backoff.test.ts',
      // Bug E (6/8) — applyIncomingMessageToRooms() (chat-list-live.ts) là hàm THUẦN (biến đổi danh sách phòng
      // khi có tin mới realtime: +1 chưa đọc, đổi preview/giờ, đưa lên đầu, found=false nếu vắng mặt), cùng lớp
      // "pure-logic test" ở trên (không DOM/WebSocket).
      'apps/web-demo/src/lib/chat-list-live.test.ts',
      // Đồng bộ đã-đọc đa thiết bị (7/8) — pub-sub emitRoomRead/emitAllRead (room-read-self/all-read-self WS).
      'apps/web-demo/src/lib/chat-read-events.test.ts',
      // Fix số chưa đọc cộng dồn per-message (1-1 & nhóm) — AppShell đồng bộ cache khi ChatListScreen unmount.
      'apps/web-demo/src/lib/appshell-cache-sync.test.ts',
      // PERF SWR (15/8) — danh sách chat render stale-first (getStaleRoomsListCache + persist).
      'apps/web-demo/src/lib/rooms-list-cache.test.ts',
      'apps/web-demo/src/lib/diary-feed-cache.test.ts',
      // (6/8) — wire test THUẦN mapChatRoomSummary() avatar/màu phòng (chat-client.ts) đang MỒ CÔI (guard bắt):
      // kiểm màu/avatar DIRECT theo agentId — cùng lớp pure-logic, không DOM.
      'apps/web-demo/src/lib/chat-client-room-avatar.test.ts',
      // Lane D vòng 2 (3/8, việc 3 — cache friends dùng chung) — getCachedFriends()/invalidateFriendsCache()
      // (friends-cache.ts) test THUẦN logic cache (hit=0-network/dedupe/invalidate/race), mock agent-api-client,
      // KHÔNG DOM. Test này ĐÃ TỒN TẠI ở base (B86-tiếp) nhưng CHƯA được wire vào include (test mồ côi — không
      // chạy) → Lane D wire vào để nó thật sự chạy trong `npm test`.
      'apps/web-demo/src/lib/friends-cache.test.ts',
      // AUDIT-6 (3/8) — smart-search.ts (normalizeForSearch/smartIncludes) là hàm THUẦN bỏ dấu tiếng Việt +
      // không phân biệt hoa/thường (lọc tin nhắn/panel nhóm), TRƯỚC đợt này KHÔNG có test (vùng trắng). Cùng
      // lớp "pure-logic test" ở trên (không DOM/Postgres).
      'apps/web-demo/src/lib/smart-search.test.ts',
      // AUDIT-6 (3/8) — WIRE 12 test web-demo TỪNG là "test mồ côi" (tồn tại + PASS nhưng KHÔNG nằm trong
      // include allowlist này nên `npm test` KHÔNG BAO GIỜ chạy → 146 test âm thầm bị bỏ, false-coverage).
      // Đã chạy độc lập xác nhận cả 12 file PASS ở environment 'node' (không DOM). Guard vitest-include-guard
      // .test.ts (dưới) chống tái diễn: fail nếu có *.test.ts web-demo pure-logic nào KHÔNG được liệt kê ở đây.
      'apps/web-demo/src/components/DateOfBirthPicker.test.ts',
      // #16 (8/8, Admin Demo "Xem nhật ký ra trang trắng") — isChunkLoadError (ChunkErrorBoundary.tsx) nhận đúng lỗi
      // TẢI CHUNK lazy mọi trình duyệt (để boundary tự reload thay vì trắng xoá) + KHÔNG nhầm lỗi logic. Hàm THUẦN.
      'apps/web-demo/src/components/ChunkErrorBoundary.test.ts',
      'apps/web-demo/src/lib/avatar-color.test.ts',
      'apps/web-demo/src/lib/bill-edit-mapping.test.ts',
      // Bill CHUYỂN KHOẢN trong chat (1/9) — parseTransferCkMeta() + nhánh mapChatMessage() gắn transferCk
      // (chat-client.ts): suy loại CK (hoàn/ứng đại lý, tạm ứng/hoàn-thừa NĐT, hoàn-thừa đại lý) từ metadata
      // backend ocr-send-service.ts. Hàm THUẦN, KHÔNG DOM — cùng lớp "pure-logic test" ở trên.
      'apps/web-demo/src/lib/transfer-ck-meta.test.ts',
      'apps/web-demo/src/lib/pos-bill-meta.test.ts',
      'apps/web-demo/src/components/bill-card-layout.guard.test.ts',
      'apps/web-demo/src/screens/transfer-card-date.guard.test.ts',
      // Bug "đăng xuất bị KẸT" (11/9) — guard source: performLogout PHẢI closeOverlayForNavigation() trước
      // navigate (sentinel back-intercept nuốt entry /login) + RequireAuth useLocation() + rcLogout timeout.
      // Tái hiện/verify hành vi thật: apps/web-demo/scripts/harness-logout.ts (Playwright).
      'apps/web-demo/src/lib/logout-navigation.guard.test.ts',
      'apps/web-demo/src/lib/brand-icons.test.ts',
      'apps/web-demo/src/lib/bill-message-meta.test.ts',
      'apps/web-demo/src/lib/bill-refund-text.test.ts',
      'apps/web-demo/src/lib/bill-table-image.test.ts',
      // 20/8 (fix bug tiền) — isRefundTextStale() (use-fee-preview.ts): chốt chặn nướng dòng Hoàn tiền lỗi thời
      // vào ảnh khi preview chưa khớp số tiền hiện tại. Hàm THUẦN (phần hook React/timer verify bằng Playwright).
      'apps/web-demo/src/lib/use-fee-preview.test.ts',
      'apps/web-demo/src/lib/categories-cache.test.ts',
      // FIX GIẬT 11/9 (Admin Demo "bubble bill BÓP HẸP xong mới load về đúng kích thước") — image-dims-cache.ts:
      // nhớ kích thước thật attachment (localStorage) để AttachmentImage reserveDims giữ chỗ đúng aspect-ratio.
      // Logic THUẦN (stub window.localStorage) — lớp render/pixel verify Playwright harness-chat-image-cls.ts.
      'apps/web-demo/src/lib/image-dims-cache.test.ts',
      'apps/web-demo/src/lib/context-menu-position.test.ts',
      'apps/web-demo/src/lib/create-group-from-dm.test.ts',
      'apps/web-demo/src/lib/grouped-money-input.test.ts',
      'apps/web-demo/src/lib/ocr-bill-fields-display.test.ts',
      'apps/web-demo/src/lib/refund-bill-status.test.ts',
      'apps/web-demo/src/lib/reply-preview.test.ts',
      // 3 bug chat 5/8 (Admin Demo) — tin gửi hiện ngay + số chưa đọc clear + tick đã gửi/đã đọc (logic thuần).
      'apps/web-demo/src/lib/chat-message-status.test.ts',
      // Item 2 (6/8) — notification-settings.ts (cài đặt thông báo GLOBAL per-device): clamp thời gian + getter/
      // setter localStorage. Hàm THUẦN, giả lập window.localStorage — cùng lớp "pure-logic test" ở trên.
      'apps/web-demo/src/lib/notification-settings.test.ts',
      // Item 3 (6/8) — toast-store.ts (store toast tin nhắn kiểu Zalo): insertAndCap/shouldChimeNow + stack/cap/
      // auto-ẩn (vi.useFakeTimers). Không DOM — cùng lớp "pure-logic test" ở trên.
      'apps/web-demo/src/lib/toast-store.test.ts',
      // Item 12 (6/8) — notify-avatar.ts (resolve avatar thông báo push): DIRECT=người gửi / GROUP=nhóm, màu/chữ
      // fallback đúng nguồn. Hàm THUẦN (inject deps URL) — không DOM.
      'apps/web-demo/src/lib/notify-avatar.test.ts',
      // Badge-fix (6/8) — unread-badge.ts (map roomId→unreadCount cho badge icon): baseline/đọc-phòng-optimistic/
      // tin-mới +1/đọc-hết=0. Hàm THUẦN (Map), không DOM.
      'apps/web-demo/src/lib/unread-badge.test.ts',
      // Presence LIVE (6/8) — presence-store.ts (Map agentId→{online,lastSeenAt} + parse + formatLastSeen "X phút
      // trước"): set/seed/emit/parse/format mọi mốc. Hàm THUẦN, không DOM.
      'apps/web-demo/src/lib/presence-store.test.ts',
      // FCM-ping-on-view (6/8) — presence-check.ts pickDuePresenceCheckIds (dedupe + throttle 30s/id). Hàm THUẦN.
      'apps/web-demo/src/lib/presence-check.test.ts',
      // #23 chống nháy avatar reload (6/8) — avatar-persist-cache.ts: pickAvatarRender (image/color/skeleton) +
      // round-trip sessionStorage (inject fake). Hàm THUẦN, không DOM.
      'apps/web-demo/src/lib/avatar-persist-cache.test.ts',
      // P3+P5 (6/8, tối ưu tốc độ mở khung chat) — messages-cache.ts (cache tin nhắn theo phòng + SWR): hàm
      // THUẦN Map module-level (hit/miss/set/ghi-đè/lọc-tin-cục-bộ/clear/LRU), KHÔNG DOM — cùng lớp "pure-logic
      // test" ở trên.
      'apps/web-demo/src/lib/messages-cache.test.ts',
      // P1 (6/8) — SWR cache danh tính /auth/me (bot-api-client.ts): write-through + getCachedAgentId đồng bộ +
      // dedupe in-flight + clear lúc đăng xuất. Mock './proxy-fetch', KHÔNG DOM — cùng lớp "pure-logic test".
      'apps/web-demo/src/lib/bot-api-client.auth-cache.test.ts',
      // PRESENCE real-time (6/8) — presence-heartbeat.ts (startPresenceHeartbeat/sendPresenceOffline): lịch ping +
      // offline/online event → /offline|/ping. Test tự giả lập window/document + inject post, KHÔNG DOM thật/fetch.
      'apps/web-demo/src/lib/presence-heartbeat.test.ts',
      // Việc #24 Part B (6/8) — os-notification.ts shouldAttemptNativeClear (gate hủy notification native theo
      // phòng khi đọc): hàm THUẦN, KHÔNG DOM/native (registerPlugin lúc load trả proxy vô hại ở env node).
      'apps/web-demo/src/lib/os-notification.test.ts',
      // Việc #2 (6/8) — push-notifications.ts resolvePushDeepLinkTarget (bấm push → chat/Lịch/danh sách): hàm
      // THUẦN, plugin capacitor lúc load chỉ đăng ký proxy vô hại ở env node.
      'apps/web-demo/src/lib/push-deeplink.test.ts',
      // VIỆC #4 (6/8) — phone-format.ts: chọn mã vùng quốc gia + chuẩn hoá E.164 (toE164/isValidPhone/
      // splitPhone/phoneLoginCandidates/COUNTRIES). Hàm THUẦN dùng libphonenumber-js/min, KHÔNG DOM.
      'apps/web-demo/src/lib/phone-format.test.ts',
      // #3 (6/8, đá phiên cũ CÙNG NỀN kiểu Zalo) — resolvePlatform() (platform.ts) là hàm THUẦN dò nền
      // web/exe/apk để gửi header X-Sigma-Platform lúc đăng nhập. Cùng lớp "pure-logic test" (nhận cờ đã dò,
      // KHÔNG cần Capacitor/DOM thật).
      'apps/web-demo/src/lib/platform.test.ts',
      // Menu thao tác tin nhắn THEO LOẠI + hover (7/8) — message-menu-actions.ts: menuActionsForMessage/
      // extractFirstUrl/messageHasLink là hàm THUẦN (không DOM), cùng lớp "pure-logic test" ở trên.
      'apps/web-demo/src/lib/message-menu-actions.test.ts',
      // Bug push EXE (7/8, Admin Demo "exe không nhận push") — guard TĨNH bất biến main process SigMa PC:
      // backgroundThrottling:false (renderer nhận WS + bắn push khi ở nền/tray) + AUMID khớp appId + giữ IPC
      // notify/badge. Đọc thẳng apps/sigma-pc/src/main.js + electron-builder.yml (fs-scan, KHÔNG import Electron).
      'apps/web-demo/src/lib/sigma-pc-main-invariants.test.ts',
      // Tag @ mention kiểu Zalo (13/8) — mention.ts: dò token @ tại caret / lọc thành viên không dấu / trích
      // mention còn trong text / build+parse metadataJson / chia đoạn tô đậm. Hàm THUẦN, KHÔNG DOM.
      'apps/web-demo/src/lib/mention.test.ts',
      // (17/8, Admin Demo "vào phòng chat từ phân loại → back phải về đúng phân loại, đang bị về Tất cả") —
      // chat-category-filter-persist.ts: ghi nhớ/khôi phục/xóa phân loại đang lọc qua remount ChatListScreen.
      // Hàm THUẦN (sessionStorage mock), KHÔNG DOM.
      'apps/web-demo/src/lib/chat-category-filter-persist.test.ts',
      // (18/8, Admin Demo "back chỉ được lùi 1 bước; info hội thoại back phải về phòng chat") — back-intercept.ts
      // stack chặn-back LIFO: overlay (info/pin/modal/lightbox) đóng trước, nuốt back, không lùi route. Hàm THUẦN.
      'apps/web-demo/src/lib/back-intercept.test.ts',
      // AUDIT-6 (3/8) — guard chống "test mồ côi" web-demo tái diễn.
      'apps/web-demo/src/lib/vitest-include-guard.test.ts',
      // [9/9] guard lối tắt nội bộ trỏ route có thật (bug "click cảnh báo không tới đâu")
      'apps/web-demo/src/lib/internal-link-guard.test.ts',
      // [9/9] cấm window.prompt (Electron không hỗ trợ → bấm không hiện gì)
      'apps/web-demo/src/lib/no-window-prompt.test.ts',
      // [10/9] thứ tự nhóm ở màn Doanh số theo nhóm (NĐT → đại lý → QR)
      'apps/web-demo/src/lib/revenue-group-order.test.ts',
      'apps/web-demo/src/lib/ck-classify-kinds.test.ts',
      // [Admin Demo 8/9] đặt tên file ảnh sau OCR + lối tắt từ log + lý do dòng log + phân loại khi tải lại folder
      'apps/web-demo/src/lib/bill-file-name.test.ts',
      'apps/web-demo/src/lib/log-shortcut.test.ts',
      'apps/web-demo/src/screens/ocr-log-row-reason.test.ts',
      'apps/web-demo/src/screens/reload-folder-categorize.test.ts'
    ],
    reporters: ['default']
  }
});
