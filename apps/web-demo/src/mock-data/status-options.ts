// Danh mục trạng thái tĩnh (thay cho IPC window.api.statusOptionList của GLB desktop — Phase 0 không
// có backend/Electron nên StatusBadge đọc thẳng bảng này thay vì gọi API). Xem ghi chú trong
// components/StatusBadge.tsx.
import type { StatusOptionDto } from './types';

export const STATUS_CATALOG: Record<string, StatusOptionDto[]> = {
  lo: [
    { code: 'DANG_XU_LY', label: 'Đang xử lý', tone: 'amber', active: true },
    { code: 'DA_DOI_SOAT', label: 'Đã đối soát', tone: 'emerald', active: true },
    { code: 'CO_CANH_BAO', label: 'Có cảnh báo', tone: 'rose', active: true },
    // Mã trạng thái THẬT của bot-api (Lo.status, Prisma) — bước 4 (24/7) nối Lịch sử Lô/Đối soát vào dữ
    // liệu thật, dùng SONG SONG mã tiếng Việt mock ở trên (mock vẫn giữ cho FraudAlertsScreen/GalleryPage
    // preview Phase 0 chưa nối, không xóa).
    { code: 'PENDING', label: 'Chờ đối soát', tone: 'amber', active: true },
    { code: 'CONFIRMED', label: 'Đã xác nhận', tone: 'emerald', active: true },
    { code: 'MISMATCH', label: 'Lệch/cảnh báo', tone: 'rose', active: true },
    { code: 'CANCELLED', label: 'Đã hủy', tone: 'slate', active: true }
  ],
  tid: [
    { code: 'HOAT_DONG', label: 'Hoạt động', tone: 'emerald', active: true },
    { code: 'TAM_KHOA', label: 'Tạm khóa', tone: 'slate', active: true }
  ],
  agent: [
    { code: 'DANG_HOAT_DONG', label: 'Đang hoạt động', tone: 'emerald', active: true },
    { code: 'MOI', label: 'Mới', tone: 'sky', active: true },
    { code: 'NGUNG', label: 'Ngừng hợp tác', tone: 'slate', active: true }
  ]
};

export function getStatusOption(entity: string, code: string | null | undefined): StatusOptionDto | undefined {
  if (!code) return undefined;
  return STATUS_CATALOG[entity]?.find((o) => o.code === code);
}
