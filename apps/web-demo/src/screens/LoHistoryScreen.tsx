// SIGMA Phase 1+ bước 4 (24/7) — nối THẬT vào bot-api (GET /v1/me/lo, apps/bot-api/src/routes/me.ts),
// thay mock LO_RECORDS của Phase 0. Giữ NGUYÊN bố cục/style bảng đã duyệt — CHỈ đổi nguồn dữ liệu.
import { useEffect, useState, type JSX } from 'react';
import { ChevronRight } from 'lucide-react';
import { StatusBadge } from '../components/StatusBadge';
import { DotsLoader } from '../components/DotsLoader';
import { usePagination } from '../components/Pagination';
import { listMyLo, type MyLoListItem } from '../lib/agent-api-client';

export function LoHistoryScreen({ onOpenDetail }: { onOpenDetail: (loId: number) => void }): JSX.Element {
  const [items, setItems] = useState<MyLoListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    listMyLo({ limit: 100 }).then((r) => {
      if (cancelled) return;
      if (!r.ok) setError(r.message);
      else setItems(r.data.items);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const { pageRows, bar } = usePagination(items, 20);

  return (
    <div className="h-full overflow-auto bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
      <h1 className="mb-4 text-base font-bold text-slate-800">Lô & Đối soát</h1>

      {loading && (
        <p className="flex items-center gap-2 text-sm text-slate-400">
          <DotsLoader /> Đang tải danh sách Lô...
        </p>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      {!loading && !error && items.length === 0 && <p className="text-sm text-slate-400">Chưa có Lô nào — tạo Lô mới từ màn "Bán TID".</p>}

      {!loading && !error && items.length > 0 && (
        <div className="overflow-hidden rounded-lg-mac border border-line">
          <table className="w-full text-sm">
            <thead className="bg-appbg text-xs uppercase text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">Lô #</th>
                <th className="px-3 py-2 text-left">Số lô ngân hàng</th>
                <th className="px-3 py-2 text-left">Thời gian</th>
                <th className="px-3 py-2 text-right">Tổng tiền</th>
                <th className="px-3 py-2 text-center">Trạng thái</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {pageRows.map((lo) => (
                <tr key={lo.id} className="cursor-pointer hover:bg-appbg" onClick={() => onOpenDetail(lo.id)}>
                  <td className="px-3 py-2.5 font-medium text-slate-700">#{lo.id}</td>
                  <td className="px-3 py-2.5 text-slate-500">{lo.bankReportedLoNumber ?? '—'}</td>
                  <td className="px-3 py-2.5 text-slate-500">{new Date(lo.createdAt).toLocaleString('vi-VN')}</td>
                  <td className="px-3 py-2.5 text-right text-slate-700">{Number(lo.expectedTotalAmount).toLocaleString('vi-VN')} đ</td>
                  <td className="px-3 py-2.5 text-center">
                    <StatusBadge entity="lo" code={lo.status} />
                  </td>
                  <td className="px-3 py-2.5 text-right text-slate-300">
                    <ChevronRight className="ml-auto h-4 w-4" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!loading && !error && items.length > 0 && bar}
    </div>
  );
}
