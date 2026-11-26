import { useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { QrCard } from '../components/QrCard';
import { BackButton } from '../components/BackButton';
import { Field, inputCls } from '../components/Field';
import { TIDS } from '../mock-data/tids';

export function QrDisplayScreen(): JSX.Element {
  const navigate = useNavigate();
  const [tidId, setTidId] = useState(TIDS[0].id);
  const [amount, setAmount] = useState('5000000');
  const tid = TIDS.find((t) => t.id === tidId) ?? TIDS[0];

  return (
    <div className="h-full overflow-auto bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      {/* Việc 4 (1/8, Admin Demo "tất cả các trường sang bước kế tiếp phải có nút quay lại") — màn này KHÔNG nằm
          trong Sidebar. */}
      <BackButton className="mb-3" onClick={() => navigate(-1)} />
      <h1 className="mb-4 text-base font-bold text-slate-800">Hiển thị QR nhận tiền</h1>
      <div className="flex flex-col items-center gap-6 lg:flex-row lg:items-start lg:justify-center">
        <div className="w-full max-w-xs space-y-3">
          <Field label="Chọn TID">
            <select value={tidId} onChange={(e) => setTidId(e.target.value)} className={inputCls + ' w-full'}>
              {TIDS.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.code} · {t.bank}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Số tiền cần nhận">
            <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="numeric" className={inputCls + ' w-full'} />
          </Field>
        </div>
        <QrCard amount={Number(amount) || 0} tid={tid.code} bank={tid.bank} note="Quét mã để chuyển khoản đúng số tiền" />
      </div>
    </div>
  );
}
