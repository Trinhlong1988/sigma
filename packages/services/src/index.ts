// @sigma/services — business logic THUẦN (ctx-based) dùng chung cho CẢ apps/desktop (IPC) LẪN apps/quanly-api (HTTP).
// KHÔNG import Electron. Adapter tự dựng ServiceCtx = { db, user } (desktop: current-user + Prisma; API: session→user).
export * from './audit.js';
// Tìm kiếm không phân biệt hoa/thường (DB collation "C" làm ILIKE/mode:'insensitive' vô dụng với tiếng Việt).
export * from './tim-kiem-hoa-thuong.js';
export * from './optimistic-lock.js';
export * from './code.js';
export * from './customer.js';
export * from './investor.js';
export * from './investor-report.js';
export * from './investor-detail-workbook.js';
export * from './lot-revenue.js';
export * from './revenue-reconcile.js';
export * from './investor-advance.js';
export * from './investor-settlement.js';
export * from './investor-clear.js';
export * from './investor-chat-group.js';
export * from './investor-scope.js';
export * from './investor-subuser.js';
export * from './industry.js';
export * from './cash-category.js';
export * from './settings.js';
export * from './status-catalog.js';
// pos-supply/warehouse/handover/fund/tid-sell-fee (agent 2)
export * from './pos-supply.js';
export * from './warehouse.js';
export * from './handover.js';
export * from './fund.js';
export * from './tid-sell-fee.js';
// role/user/audit/dashboard/global-search/message (agent 3)
export * from './role.js';
export * from './user.js';
export * from './audit-log.js';
export * from './dashboard.js';
export * from './global-search.js';
export * from './message.js';

// bank/fee/tid-config (agent 1) — 3 màn cấu hình migrate desktop→API. Không re-export MutationResult/ServiceCtx
// (đã export từ customer) và AuditTrail (đã export từ industry) — các module này IMPORT chúng, không khai lại.
export * from './bank-config.js';
export * from './fee-config.js';
export * from './tid-config.js';
// [Admin Demo 4/9] QR bán hàng + giá cuối tuần — CRUD 3 bảng phụ (raw SQL) + resolver giá QR (MÃ đè ĐỐI TÁC). KHÔNG
// re-export MutationResult/ServiceCtx (đã export từ customer) hay AuditTrail (đã export từ industry) — module IMPORT chúng.
export * from './qr-fee-config.js';

// pos/cash-entry/deposit/device-sale (agent B2) — 4 màn nhóm B (tx tiền/công nợ/state-machine) migrate desktop→API.
// KHÔNG re-export MutationResult/ServiceCtx (đã export từ customer) — các module này IMPORT chúng, không khai lại.
export * from './pos.js';
export * from './cash-entry.js';
export * from './deposit.js';
export * from './device-sale.js';

// approval/entity-cancel/export-request/trash (agent B3) — nhóm DUYỆT HỦY + đa-entity migrate desktop→API. Không
// re-export MutationResult/ServiceCtx (đã export từ customer) — các module này IMPORT chúng. export-request tái dùng
// money-tier của agent B2 (bookSaleCashEntries/applyHandoverTx/openDepositTx) — KHÔNG nhân bản semantics tiền.
export * from './approval-service.js';
export * from './entity-cancel-service.js';
export * from './export-request-service.js';
export * from './trash-service.js';

// tid/transaction (agent B1) — 2 màn PHỨC TẠP nhóm B (tx lớn + optimistic-lock nhiều version + công nợ) migrate
// desktop→API. KHÔNG re-export MutationResult/ServiceCtx (đã export từ customer) — 2 module IMPORT chúng, không khai
// lại. Handover helper tái dùng deposit.js (agent B2). chat-room-tid.js = helper phòng chat SigMa (nhận db).
export * from './tid.js';
export * from './transaction.js';
// PHA 2 — engine RECALC doanh số theo kỳ (quyết định 1A/3a). Gọi trong setFeeRate/setTidSellFees (atomic cùng tx đổi phí).
export * from './revenue-recalc.js';
export * from './chat-room-tid.js';
// Cấu hình "Nhóm chat theo loại phí của khách hàng" (5/8) — CustomerChatGroup upsert/list. IMPORT ServiceCtx/
// MutationResult từ customer.js + assertChatRoomExists từ chat-room-tid.js (KHÔNG khai lại).
export * from './customer-chat-group.js';

// realtime/notification (agent cuối) — 2 màn ĐỌC đặc thù poll/scheduler migrate desktop→API. realtime = poll thuần
// (ChangeToken version + badge chờ duyệt). notification = CHỈ getUndeliveredSummary (badge in-app); push Zalo +
// scheduler nền GIỮ ở desktop/tiến-trình-nền, KHÔNG export ở đây. notification tái dùng listUndeliveredTids (tid.js).
// KHÔNG re-export MutationResult/ServiceCtx (đã export từ customer) — 2 module IMPORT chúng, không khai lại.
export * from './realtime.js';
export * from './notification.js';
// R201 (dead-IPC 21/8) — QR đại lý (staff xem QR 1 đại lý), phần ĐỌC. IMPORT ServiceCtx từ customer.js (không khai lại).
export * from './agent-qr.js';

// dossier/rcv/bill-explain/import (agent thuần-server-2) — 4 CRUD domain còn lại migrate desktop→API. KHÔNG re-export
// MutationResult/ServiceCtx (đã export từ customer) hay AuditTrail (đã export từ industry) — 4 module này IMPORT chúng,
// không khai lại. bill-explain = chỉ CRUD dữ liệu (generateBills/file-template GIỮ ở desktop — TENTATIVE storage).
// import = dryRunImport/runImport nhận `rows` đã parse (parse .xlsx ở client). Đính kèm ảnh dossier/rcv = TENTATIVE
// (chỉ port metadata; upload bytes cần route multipart riêng — LEAD chốt cơ chế storage).
export * from './dossier.js';
export * from './receive-account.js';
export * from './bill-explain.js';
export * from './import.js';

// KHO FILE SERVER (thuần server, KHÔNG Electron) — Admin Demo chốt: ảnh ĐKKD/CCCD/QR lưu file riêng trên máy chủ,
// DB giữ path/tên (KHÔNG BLOB). Lõi sniff magic-bytes + store/read/trash + DTO AttachmentUpload/Download. Dùng
// bởi setDossierAttachment/getDossierAttachment (dossier.js) + setRcvAccountAttachment/... (receive-account.js).
export * from './file-store.js';

// storage/health/backup (agent thuần-server-3) — 3 domain SERVER-OPS (phụ thuộc máy chủ: disk/pg_dump/vacuum)
// migrate desktop→API. Chạy SERVER-SIDE là ĐÚNG (app-mạng gọi API, server làm việc máy chủ). KHÔNG re-export
// MutationResult/ServiceCtx (đã export từ customer) — 3 module IMPORT chúng, không khai lại. backup.systemBackup
// (nhận db) được storage.runCleanup + health.runHealthScan(autoFix) tái dùng làm "backup an toàn trước khi xóa".
// KHÔNG migrate route: backup.restoreBackup/systemBackup(scheduler) + storage schedulers (systemBackupIfDue/
// backupWatchdog/weeklyMaintenance) — giữ IPC/tiến-trình-nền ở desktop.
export * from './storage.js';
export * from './health.js';
export * from './backup.js';
export * from './schema-ensure.js';

// MÃ HOÁ MẬT KHẨU DIGISTORE per-mã (AES-256-GCM) — MOVE 5/9 từ apps/bot-api để bot-api + quanly-api dùng chung 1 nguồn.
export * from './digistore-secret.js';
export * from './ca-tien.js';
// KPI Doanh Số (tab full-view màn Doanh Số, Admin Demo 24/11) — ĐỌC THUẦN. IMPORT ServiceCtx từ customer.js
// (KHÔNG khai lại). 1 nguồn công thức cho route /v1/kpi/doanh-so.
export * from './kpi-doanh-so.js';
export * from './tien-cho.js';
export * from './nhan-bank.js';
