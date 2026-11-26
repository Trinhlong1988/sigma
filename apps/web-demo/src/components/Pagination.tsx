// Port nguyên từ quan-ly-glb/apps/desktop/src/renderer/src/components/Pagination.tsx (không đổi API).
import { useState, useMemo, useEffect, type JSX } from 'react';

export function usePagination<T>(rows: T[], pageSize = 50): { pageRows: T[]; bar: JSX.Element | null } {
  const [page, setPage] = useState(1);
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  useEffect(() => {
    setPage(1);
  }, [total]);
  const cur = Math.min(page, pageCount);
  const pageRows = useMemo(() => rows.slice((cur - 1) * pageSize, cur * pageSize), [rows, cur, pageSize]);
  const from = total === 0 ? 0 : (cur - 1) * pageSize + 1;
  const to = Math.min(cur * pageSize, total);

  const bar =
    total <= pageSize ? null : (
      <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
        <span>
          Hiển thị <b className="text-slate-700">{from}–{to}</b> / tổng <b className="text-slate-700">{total}</b>
        </span>
        <div className="flex items-center gap-1">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={cur <= 1}
            className="rounded-md border border-line px-3 py-1 text-slate-600 enabled:hover:bg-appbg disabled:opacity-40"
          >
            ← Trước
          </button>
          <span className="px-2">
            Trang <b className="text-slate-700">{cur}</b>/{pageCount}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            disabled={cur >= pageCount}
            className="rounded-md border border-line px-3 py-1 text-slate-600 enabled:hover:bg-appbg disabled:opacity-40"
          >
            Sau →
          </button>
        </div>
      </div>
    );
  return { pageRows, bar };
}
