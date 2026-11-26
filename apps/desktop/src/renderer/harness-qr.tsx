// HARNESS R200 (Admin Demo 5/9) — render CÔ LẬP FeeConfigPage (2 tab mới: giảm phí cuối tuần + giá QR đối tác) +
// TidPage (form "Thêm mã QR") với window.api MOCK, để LEAD tự nhìn ảnh TRƯỚC khi ship (R200). KHÔNG vào app thật.
// Mock: Proxy trả {ok:true,data:[]} cho mọi method chưa override + override các list cần dữ liệu để dropdown/bảng hiện.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './src/styles.css';
import { ToastProvider } from './src/lib/toast.js';
import { FeeConfigPage } from './src/pages/FeeConfigPage.js';
import { TidPage } from './src/pages/TidPage.js';

const nowISO = new Date().toISOString();
const OVERRIDES: Record<string, (...a: unknown[]) => Promise<unknown>> = {
  serverConfigGet: async () => ({ needsConfig: false, configured: true }),
  sessionHeartbeat: async () => ({ ok: true }),
  partnerList: async () => ({ ok: true, data: [ { id: 1, code: 'AQ', name: 'Anh Quốc' }, { id: 2, code: 'DT2', name: 'Đối tác 2' } ] }),
  bankLite: async () => ({ ok: true, data: [ { id: 1, code: 'ACB', name: 'ACB' }, { id: 2, code: 'MB', name: 'MB Bank' } ] }),
  bankList: async () => ({ ok: true, data: [ { id: 1, code: 'ACB', name: 'ACB' }, { id: 2, code: 'MB', name: 'MB Bank' } ] }),
  cardTypeList: async () => ({ ok: true, data: [ { id: 15, code: 'MB', name: 'MB' }, { id: 16, code: 'MBV', name: 'Ngoài MB-Visa-Master' }, { id: 17, code: 'NP', name: 'Ngoài MB-Napas' } ] }),
  feeTypeList: async () => ({ ok: true, data: [ { id: 1, name: 'Ủy quyền' }, { id: 2, name: 'Tiền nhanh' } ] }),
  feeRateList: async () => ({ ok: true, data: [] }),
  weekendSellAdjustList: async () => ({ ok: true, data: [
    { id: 1, cardTypeId: 15, cardTypeCode: 'MB', cardTypeName: 'MB', deltaPct: 0.02, effectiveFrom: nowISO, createdBy: 1, createdByName: 'Admin', createdAt: nowISO, updatedBy: 1, updatedByName: 'Admin', updatedAt: nowISO },
    { id: 2, cardTypeId: 16, cardTypeCode: 'MBV', cardTypeName: 'Ngoài MB-Visa-Master', deltaPct: 0.02, effectiveFrom: nowISO, createdBy: 1, createdByName: 'Admin', createdAt: nowISO, updatedBy: 1, updatedByName: 'Admin', updatedAt: nowISO }
  ] }),
  qrPartnerFeeList: async () => ({ ok: true, data: [
    { id: 1, partnerId: 1, partnerCode: 'AQ', partnerName: 'Anh Quốc', phiMuaThuongPct: 0.85, phiMuaCuoiTuanPct: 0.9, phiBanPct: 1.05, effectiveFrom: nowISO, createdBy: 1, createdByName: 'Admin', createdAt: nowISO, updatedBy: 1, updatedByName: 'Admin', updatedAt: nowISO }
  ] }),
  qrMerchantFeeList: async () => ({ ok: true, data: [] }),
  customerList: async () => ({ ok: true, data: [
    { id: 10, code: 'DL01', fullName: 'Đại lý Nguyễn SG', nickname: 'Nguyễn SG' },
    { id: 11, code: 'DL02', fullName: 'Đại lý Trung Cẩm Phả', nickname: 'Trung CP' }
  ] }),
  qrDealerSellFeeList: async () => ({ ok: true, data: [
    { id: 1, customerId: 11, customerName: 'Trung Cẩm Phả', phiBanPct: 1.10, effectiveFrom: nowISO }
  ] }),
  promoProgramList: async () => ({ ok: true, data: [
    { id: 4, kenh: 'POS', cardTypeId: 15, cardTypeName: 'MB', bankId: null, bankName: null, deltaPct: 0.02, fromDate: '2026-08-31T17:00:00.000Z', toDate: '2026-09-30T17:00:00.000Z', lich: 'RANGE', ngayCuThe: null, enabled: true, note: 'KM T9', createdBy: 1, createdByName: 'Admin', createdAt: nowISO, updatedBy: 1, updatedByName: 'Admin', updatedAt: nowISO },
    { id: 9, kenh: 'QR', cardTypeId: null, cardTypeName: null, bankId: 27, bankName: 'SmartPay', deltaPct: 0.05, fromDate: '2026-08-31T17:00:00.000Z', toDate: '2026-09-30T17:00:00.000Z', lich: 'WEEKEND', ngayCuThe: null, enabled: false, note: null, createdBy: 1, createdByName: 'Admin', createdAt: nowISO, updatedBy: 1, updatedByName: 'Admin', updatedAt: nowISO },
    { id: 11, kenh: 'POS', cardTypeId: 16, cardTypeName: 'Ngoài MB-Visa-Master', bankId: null, bankName: null, deltaPct: 0.03, fromDate: '2026-08-31T17:00:00.000Z', toDate: '2026-09-30T17:00:00.000Z', lich: 'DATES', ngayCuThe: ['2026-09-18', '2026-09-25'], enabled: true, note: null, createdBy: 1, createdByName: 'Admin', createdAt: nowISO, updatedBy: 1, updatedByName: 'Admin', updatedAt: nowISO }
  ] }),
  promoProgramSet: async () => ({ ok: true }),
  promoProgramDelete: async () => ({ ok: true }),
  qrDealerSellFeeSet: async () => ({ ok: true }),
  qrDealerSellFeeDelete: async () => ({ ok: true }),
  // TidPage refs
  tidRefs: async () => ({ ok: true, data: {
    banks: [ { id: 1, code: 'ACB', name: 'ACB' }, { id: 2, code: 'MB', name: 'MB Bank' } ],
    partners: [ { id: 1, code: 'AQ', name: 'Anh Quốc' } ],
    partnerBanks: { 1: [1] },
    industries: [ { id: 1, name: 'Bán lẻ' }, { id: 2, name: 'Ăn uống' } ],
    dossiers: [ { id: 1, hkdName: 'HKD DEMO 35 Ha Noi' } ],
    receiveAccounts: [ { id: 1, accountNumber: '11111111', bankId: 1, accountName: 'Anh Quốc', investorId: 1 } ],
    configStatuses: [], dossierSources: [], feeTypes: [ { id: 1, name: 'Ủy quyền' } ]
  } }),
  rcvAccountList: async () => ({ ok: true, data: [ { id: 1, accountNumber: '11111111', bankId: 1, accountName: 'Anh Quốc', investorId: 1, investorName: 'Anh Quốc' } ] }),
  industryList: async () => ({ ok: true, data: [ { id: 1, name: 'Bán lẻ' }, { id: 2, name: 'Ăn uống' } ] }),
  tidList: async () => ({ ok: true, data: [], total: 0, page: 1, pageSize: 100 }),
  tidConfigList: async () => ({ ok: true, data: [], total: 0, page: 1, pageSize: 100 })
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(window as any).api = new Proxy({}, {
  get: (_t, k: string) => OVERRIDES[k] ?? (async () => ({ ok: true, data: [] }))
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const USER: any = { id: 1, username: 'admin', fullName: 'Admin', roleCode: 'ADMIN', role: 'ADMIN', permissions: ['CONFIG_FEE_VIEW', 'CONFIG_FEE_MANAGE', 'CONFIG_TID_VIEW', 'CONFIG_TID_MANAGE', 'TID_VIEW', 'TID_MANAGE'], forceChangePassword: false };

function Harness(): React.JSX.Element {
  const [which, setWhich] = useState<'fee' | 'tid'>('fee');
  return (
    <div className="h-screen w-screen overflow-auto bg-appbg">
      <div className="flex gap-2 border-b border-line bg-white p-2" data-testid="harness-switch">
        <button className="rounded bg-brand px-3 py-1 text-white" onClick={() => setWhich('fee')}>FeeConfigPage</button>
        <button className="rounded bg-brand px-3 py-1 text-white" onClick={() => setWhich('tid')}>TidPage</button>
      </div>
      {which === 'fee' ? <FeeConfigPage user={USER} /> : <TidPage user={USER} />}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <ToastProvider>
    <Harness />
  </ToastProvider>
);
