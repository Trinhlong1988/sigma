import { useState } from 'react';
import { Users, ShieldCheck, UserRound, Wallet, QrCode, TrendingUp } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { hasPermission } from '@sigma/shared';
import { StaffPage } from './StaffPage.js';
import { RolesPage } from './RolesPage.js';
import { CustomersPage } from './CustomersPage.js';
import { InvestorsPage } from './InvestorsPage.js';
import { ReceiveAccountPage } from './ReceiveAccountPage.js';
import { AgentQrPage } from './AgentQrPage.js';
import { TabBar, TabButton } from '../components/Tabs.js';

/**
 * Quản lý Nhân sự — gộp các tab con (LEAD 9/7 + R24 + R31 11/7):
 *  • Danh sách nhân sự (USER_READ)
 *  • Khách hàng (CUSTOMER_VIEW) — R24 Admin Demo: đưa cạnh danh sách nhân sự
 *  • Vai trò & Quyền (ROLE_READ)
 *  • Tài khoản nhận tiền (CONFIG_RCV_ACCT_VIEW) — R31 Admin Demo: đưa cạnh vai trò và quyền
 *  • QR nhận tiền đại lý (CONFIG_RCV_ACCT_VIEW) — SIGMA Tier 2 (23/7, CMD_BUILD): tái dùng cùng nhóm
 *    quyền "Tài khoản nhận tiền" vì bankAccountLabel/QR đại lý CHÍNH LÀ thông tin tài khoản nhận tiền, không
 *    có mã quyền "sửa đại lý" riêng nào trong codebase để noi theo (xem agent-qr-service.ts).
 */
export function StaffManagementPage({ user }: { user: AuthUser }): JSX.Element {
  const canStaff = hasPermission(user, 'USER_READ');
  const canCustomer = hasPermission(user, 'CUSTOMER_VIEW');
  const canInvestor = hasPermission(user, 'INVESTOR_VIEW');
  const canRoles = hasPermission(user, 'ROLE_READ');
  const canRcvAcct = hasPermission(user, 'CONFIG_RCV_ACCT_VIEW');
  const canAgentQr = hasPermission(user, 'CONFIG_RCV_ACCT_VIEW');
  const [tab, setTab] = useState<'staff' | 'customers' | 'investors' | 'roles' | 'rcvacct' | 'agentqr'>(
    canStaff ? 'staff' : canCustomer ? 'customers' : canInvestor ? 'investors' : canRoles ? 'roles' : canRcvAcct ? 'rcvacct' : 'agentqr'
  );

  return (
    <div>
      <div className="mb-1">
        <h2 className="text-lg font-semibold text-slate-800">Quản Lý Nhân Sự &amp; Khách Hàng</h2>
        <p className="text-sm text-slate-500">Nhân sự, khách hàng và phân quyền vai trò trong cùng một khu vực quản lý.</p>
      </div>
      <TabBar>
        {canStaff && (
          <TabButton active={tab === 'staff'} onClick={() => setTab('staff')} icon={<Users className="h-4 w-4" />}>
            Danh sách nhân sự
          </TabButton>
        )}
        {canCustomer && (
          <TabButton active={tab === 'customers'} onClick={() => setTab('customers')} icon={<UserRound className="h-4 w-4" />}>
            Khách hàng
          </TabButton>
        )}
        {canInvestor && (
          <TabButton active={tab === 'investors'} onClick={() => setTab('investors')} icon={<TrendingUp className="h-4 w-4" />}>
            Nhà đầu tư
          </TabButton>
        )}
        {canRoles && (
          <TabButton active={tab === 'roles'} onClick={() => setTab('roles')} icon={<ShieldCheck className="h-4 w-4" />}>
            Vai trò và Quyền
          </TabButton>
        )}
        {canRcvAcct && (
          <TabButton active={tab === 'rcvacct'} onClick={() => setTab('rcvacct')} icon={<Wallet className="h-4 w-4" />}>
            Tài khoản nhận tiền
          </TabButton>
        )}
        {canAgentQr && (
          <TabButton active={tab === 'agentqr'} onClick={() => setTab('agentqr')} icon={<QrCode className="h-4 w-4" />}>
            QR nhận tiền đại lý
          </TabButton>
        )}
      </TabBar>

      {tab === 'staff' && canStaff && <StaffPage user={user} />}
      {tab === 'customers' && canCustomer && <CustomersPage user={user} />}
      {tab === 'investors' && canInvestor && <InvestorsPage user={user} />}
      {tab === 'roles' && canRoles && <RolesPage user={user} />}
      {tab === 'rcvacct' && canRcvAcct && <ReceiveAccountPage user={user} />}
      {tab === 'agentqr' && canAgentQr && <AgentQrPage user={user} />}
    </div>
  );
}
