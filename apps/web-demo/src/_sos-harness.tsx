// HARNESS DEV — mount ĐÚNG component Sos95Stamp để LEAD nhìn ảnh thật (R200). Không app nào import file này.
import { createRoot } from 'react-dom/client';
import { Sos95Stamp } from './components/Sos95Stamp';
export function mount(): void {
  const d = document.createElement('div');
  d.id = 'sos-h';
  d.className = 'flex items-center gap-3 rounded-xl border-2 border-danger bg-danger/10 p-3';
  d.style.maxWidth = '640px';
  document.body.appendChild(d);
  createRoot(d).render(
    <>
      <Sos95Stamp size={128} note={false} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="text-base font-extrabold leading-tight text-danger">BILL ĐÓNG LÔ 95 — DỪNG, KIỂM KỸ TRƯỚC KHI GỬI!</div>
        <div className="text-xs font-semibold text-danger/90">Khách có thể HOÀN TIỀN / HỦY GIAO DỊCH sau khi SigMa đã chuyển tiền — gửi ẩu là mất tiền thật.</div>
        <label className="mt-1 flex items-center gap-2 rounded-lg border border-danger/40 bg-white/70 px-2 py-1.5 text-xs font-bold text-danger">
          <input type="checkbox" className="h-5 w-5 accent-danger" /> Tôi đã kiểm tra rủi ro đóng lô 95 và xác nhận gửi.
        </label>
      </div>
    </>
  );
}
