// Adapted từ quan-ly-glb/apps/desktop/src/renderer/src/components/StatusBadge.tsx.
// LỆCH so với bản gốc (LEAD lưu ý xem lại): bản GLB đọc danh mục qua IPC `window.api.statusOptionList`
// (Electron preload nối DB thật). Phase 0 KHÔNG có Electron/backend nên không thể gọi IPC đó — thay
// bằng bảng tĩnh `mock-data/status-options.ts`. Props/API bề ngoài (`<StatusBadge entity code />`) giữ
// nguyên để khi nối backend thật ở Phase 1+ chỉ cần đổi lại nguồn dữ liệu bên trong, không đổi call site.
import { STATUS_CATALOG, getStatusOption } from '../mock-data/status-options';

import type { JSX } from "react";

export const STATUS_TONE_CLS: Record<string, string> = {
  emerald: 'bg-emerald-50 text-emerald-600',
  amber: 'bg-amber-50 text-amber-600',
  slate: 'bg-slate-100 text-slate-500',
  rose: 'bg-rose-50 text-rose-600',
  sky: 'bg-sky-50 text-sky-600',
  indigo: 'bg-indigo-50 text-indigo-600',
  violet: 'bg-violet-50 text-violet-600',
  brand: 'bg-brand-tint text-brand'
};

export function toneCls(tone: string | undefined): string {
  return STATUS_TONE_CLS[tone ?? 'slate'] ?? STATUS_TONE_CLS.slate;
}

export function StatusBadge({ entity, code }: { entity: string; code: string | null | undefined }): JSX.Element {
  const o = getStatusOption(entity, code);
  return <span className={'inline-flex rounded-full px-2 py-0.5 text-xs font-medium ' + toneCls(o?.tone)}>{o?.label ?? code ?? '—'}</span>;
}

export function statusSelectOptions(entity: string) {
  return STATUS_CATALOG[entity] ?? [];
}
