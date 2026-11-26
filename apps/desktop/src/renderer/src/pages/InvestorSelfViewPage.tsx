// TRANG SELF-VIEW NHÀ ĐẦU TƯ (Admin Demo 12/8) — để tài khoản NĐT + kế toán (role R_INVESTOR, chỉ INVESTOR_SELF_VIEW)
// ĐĂNG NHẬP XEM báo cáo CỦA CHÍNH MÌNH. Backend Phase D tự ép investorId theo user (resolveOwnInvestorId) khi caller
// KHÔNG có REVENUE_VIEW → 2 trang báo cáo bên dưới auto-scope, chỉ trả dữ liệu của NĐT đang đăng nhập (không thấy
// NĐT khác / không thấy dữ liệu nội bộ SigMa). Trang này chỉ là VỎ + tab, tái dùng nguyên InvestorReportPage /
// InvestorSettlementPage (không props). Menu gated INVESTOR_SELF_VIEW ở Dashboard.
import { useState } from 'react';
import { TrendingUp, Receipt } from 'lucide-react';
import { InvestorReportPage } from './InvestorReportPage.js';
import { InvestorSettlementPage } from './InvestorSettlementPage.js';
import { TabBar, TabButton } from '../components/Tabs.js';

export function InvestorSelfViewPage(): JSX.Element {
  const [tab, setTab] = useState<'report' | 'settlement'>('report');
  // Dùng TabBar/TabButton CHUNG (đồng bộ brand toàn app — dải bg-brand/20, viên active gradient) thay vì tab tự chế
  // (border bg-white) lệch ngôn ngữ màu (FONT/UI drift 12/8).
  return (
    <div>
      <div className="mb-4">
        <h2 className="text-lg font-semibold text-slate-800">Báo cáo Nhà đầu tư của tôi</h2>
        <p className="text-sm text-slate-500">Doanh thu · lãi · tiền về · phải trả · tạm ứng — chỉ hiển thị dữ liệu của bạn.</p>
      </div>
      <TabBar>
        <TabButton active={tab === 'report'} onClick={() => setTab('report')} icon={<TrendingUp className="h-4 w-4" />}>
          Doanh thu &amp; Lãi
        </TabButton>
        <TabButton active={tab === 'settlement'} onClick={() => setTab('settlement')} icon={<Receipt className="h-4 w-4" />}>
          Tất toán (phải trả)
        </TabButton>
      </TabBar>
      {tab === 'report' ? <InvestorReportPage /> : <InvestorSettlementPage />}
    </div>
  );
}
