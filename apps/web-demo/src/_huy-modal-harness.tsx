// HARNESS DEV — mount ĐÚNG BillParamEditModal để LEAD NHÌN ảnh thật khối "Giao dịch HỦY" (R200).
// Không app nào import file này; chỉ harness playwright nạp qua ?harness=huy-modal.
import { createRoot } from 'react-dom/client';
import { BillParamEditModal } from './components/BillParamEditModal';
export function mount(): void {
  const d = document.createElement('div');
  d.id = 'huy-modal-h';
  document.body.appendChild(d);
  createRoot(d).render(
    <BillParamEditModal
      messageId="m-demo"
      parsed={{ tid: '67512202', amount: 41_256_000, lo: '115', hkd: 'HKD DEMO 27',
        bank: 'AB Bank', dateTime: '24/09/2026 14:21', voidAmount: 11_000, voidCount: 1 }}
      onClose={() => undefined}
    />
  );
}
