// B105 (2/8) — splash mở app: phương án "Ánh sáng quét" đã duyệt qua demo Artifact (Admin Demo chốt 1/8), ĐỔI
// nền TRẮNG (demo mẫu dùng nền tối navy — Admin Demo yêu cầu đổi khi duyệt). Che ĐÚNG khoảng thời gian ngắn lúc
// JS boot (App() chỉ mount 1 lần/vòng đời trang — KHÔNG lặp lại khi điều hướng SPA nội bộ), chuyển tiếp mượt
// từ splash NATIVE tĩnh (Android drawable/splash.png, hiện trước khi WebView/JS chạy — không animate được) →
// hiệu ứng quét sáng này → nội dung app thật.
import { type JSX } from 'react';
import { AlphaLogo } from './AlphaLogo';

export function AppSplash(): JSX.Element {
  return (
    <div className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 bg-white" role="status" aria-label="Đang khởi động SigMa">
      {/* 2/8 — TÁCH filter drop-shadow ra khỏi div overflow-hidden/rounded (TRƯỚC ĐÂY 2 thứ CÙNG 1 div — tổ
          hợp `filter` + `overflow:hidden` + `border-radius` render KHÔNG NHẤT QUÁN giữa engine/WebView, gây
          logo trông như bị cắt cụt mép trên vài trình duyệt/thiết bị dù demo desktop bình thường trông ổn —
          CÙNG lớp lỗi vừa sửa ở artifact demo bản 3c, xem BUGS_FIXED.md B117-đính-chính). Wrapper NGOÀI chỉ lo
          shadow, wrapper TRONG (`tile`) chỉ lo bo góc/cắt viền — không phần tử nào gánh cả 2 cùng lúc nữa. */}
      <div style={{ filter: 'drop-shadow(0 8px 24px rgba(5,121,204,0.28))' }}>
        {/* 5/8 — logo master mới là tile kính bo góc + trong suốt góc; BỎ `bg-white` thừa (trang splash đã
            bg-white). Giữ overflow-hidden+rounded để CLIP dải sáng quét. Logo lấp đầy để đọc hình kính. */}
        <div className="relative flex h-24 w-24 items-center justify-center overflow-hidden rounded-[28px]">
          <AlphaLogo className="h-full w-full" />
          {/* Dải sáng quét — gradient chéo mờ dần 2 đầu, trượt từ ngoài-trái sang ngoài-phải qua logo. */}
          <div className="pointer-events-none absolute inset-0 -skew-x-12 animate-splash-sweep bg-gradient-to-r from-transparent via-white/90 to-transparent" />
        </div>
      </div>
      <div className="text-xl font-bold tracking-wide text-brand">SigMa</div>
    </div>
  );
}
