// Màn "Cảnh báo gian lận" (nav item sidebar) — tổng hợp mọi cờ Rule A-F từ RECONCILE_DETAIL trên
// TOÀN BỘ lô, không chỉ 1 lô. KHÔNG có trong danh sách screens tường minh của spec mục 4 — tự thêm để
// nav item có nội dung riêng biệt với "Lô & Đối soát" (LEAD xem lại quyết định này).
import { FraudFlagBadge } from '../components/FraudFlagBadge';
import { LO_RECORDS, RECONCILE_DETAIL } from '../mock-data/lo';

import type { JSX } from "react";

export function FraudAlertsScreen({ onOpenLo }: { onOpenLo: (loId: string) => void }): JSX.Element {
  const rows = Object.entries(RECONCILE_DETAIL).flatMap(([loId, lines]) =>
    lines
      .filter((l) => l.flags.length > 0)
      .map((l) => ({ loId, loCode: LO_RECORDS.find((lo) => lo.id === loId)?.code ?? loId, line: l }))
  );

  return (
    <div className="h-full overflow-auto bg-white p-4">
      <h1 className="mb-1 text-base font-bold text-slate-800">Cảnh báo gian lận</h1>
      <p className="mb-4 text-xs text-slate-400">Tổng hợp cờ Quy tắc A-F đang mở trên toàn bộ Lô.</p>

      {rows.length === 0 && (
        <div className="rounded-lg-mac border border-line bg-appbg p-6 text-center text-sm text-slate-400">
          Không có cờ cảnh báo nào đang mở.
        </div>
      )}

      <div className="space-y-3">
        {rows.map(({ loId, loCode, line }) => (
          <button
            key={line.id}
            onClick={() => onOpenLo(loId)}
            className="block w-full rounded-lg-mac border border-line p-3 text-left shadow-soft hover:border-brand"
          >
            <div className="mb-2 flex items-center justify-between text-sm">
              <span className="font-semibold text-slate-700">
                {loCode} · {line.tid}
              </span>
              <span className="text-slate-500">{line.amount.toLocaleString('vi-VN')} đ</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {line.flags.map((f, i) => (
                <FraudFlagBadge key={i} flag={f} />
              ))}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
