// CẤU HÌNH PHÍM TẮT (Admin Demo 24/11 — tab trong "Quản lý cấu hình hệ thống", brand SigMa).
//
// Lưu PER-USER bằng localStorage (lib/shortcut.ts) — KHÔNG đụng DB/backend. Mọi thay đổi phát sự kiện
// 'alpha-shortcut-config-changed' để màn Nhập bill đang mở nạp lại ngay. Màn gồm:
//   • CÔNG TẮC TỔNG (BẬT = bật tất cả · TẮT = tắt tất cả). Tắt tổng → mọi phím vô hiệu, badge/gợi ý ẩn.
//   • Bảng [Màn · Phím · Chức năng · Mục đích · Điều kiện/rủi ro] + bật/tắt LẺ từng phím + số LẦN bấm.
//   • Gán NGƯỜI HOÀN ↔ phím số 0–9 (mỗi phím 1 người, mỗi người 1 phím) — nguồn cho phím số chọn nhanh.
import { useEffect, useMemo, useState } from 'react';
import { Keyboard, Loader2, Info } from 'lucide-react';
import type { AuthUser } from '@sigma/shared';
import { useToast } from '../lib/toast.js';
import {
  loadConfig,
  saveConfig,
  isMasterOn,
  isKeyEnabled,
  confirmPressesFor,
  assignRefundKey,
  clearRefundKey,
  refundDigitForUser,
  SHORTCUT_CATALOG,
  MIN_PRESSES,
  MAX_PRESSES,
  type ShortcutConfig,
  type ShortcutKeyId
} from '../lib/shortcut.js';

/** Sự kiện phát khi lưu cấu hình phím tắt — màn khác (Nhập bill) nghe để nạp lại ngay. */
export const SHORTCUT_CFG_EVENT = 'alpha-shortcut-config-changed';

function Toggle({ on, onToggle, title }: { on: boolean; onToggle: () => void; title?: string }): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      title={title}
      onClick={onToggle}
      className={
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition ' +
        (on ? 'bg-brand' : 'bg-slate-300')
      }
    >
      <span className={'inline-block h-5 w-5 transform rounded-full bg-white shadow transition ' + (on ? 'translate-x-5' : 'translate-x-0.5')} />
    </button>
  );
}

export function ShortcutConfigPage({ user }: { user: AuthUser }): JSX.Element {
  const toast = useToast();
  const userId = (user as unknown as { id?: number }).id ?? null;
  const [cfg, setCfg] = useState<ShortcutConfig>(() => loadConfig(userId));
  const [people, setPeople] = useState<{ id: number; fullName: string }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    void window.api.refundPeople().then((r) => {
      if (r.ok && r.data) setPeople(r.data);
      setLoading(false);
    });
  }, []);

  function apply(next: ShortcutConfig): void {
    setCfg(next);
    const ok = saveConfig(userId, next);
    if (!ok) {
      toast.alert('Không lưu được cấu hình phím tắt (trình duyệt chặn localStorage).');
      return;
    }
    try {
      window.dispatchEvent(new CustomEvent(SHORTCUT_CFG_EVENT, { detail: { userId } }));
    } catch {
      /* môi trường không có window → bỏ qua */
    }
  }

  const masterOn = isMasterOn(cfg);
  const digits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
  // Phím đang bị người KHÁC chiếm (để disable trong dropdown gán).
  const userOfDigit = useMemo(() => {
    const m: Record<string, number> = {};
    for (const [k, v] of Object.entries(cfg.refundKeyMap)) m[k] = v;
    return m;
  }, [cfg.refundKeyMap]);

  return (
    <div>
      <div className="mb-4">
        <h2 className="flex items-center gap-2 text-lg font-semibold text-slate-800">
          <Keyboard className="h-5 w-5 text-brand" /> Phím tắt
        </h2>
        <p className="text-sm text-slate-500">
          Phím tắt giúp nhập bill NHANH, context-scoped (chỉ sống trong đúng ngữ cảnh) — không nuốt phím khi bạn đang gõ. Lưu riêng cho máy/tài khoản này.
        </p>
      </div>

      {/* CÔNG TẮC TỔNG */}
      <div className="mb-4 flex items-center justify-between rounded-xl border border-line bg-white p-4 shadow-sm">
        <div>
          <div className="font-semibold text-slate-800">Bật toàn bộ phím tắt</div>
          <div className="text-xs text-slate-500">
            TẮT = tắt tất cả phím tắt, màn về thao tác chuột + Tab thuần (Tab luôn chạy). BẬT = bật tất cả, rồi tắt lẻ từng phím ở bảng dưới nếu muốn.
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className={'text-sm font-semibold ' + (masterOn ? 'text-brand' : 'text-slate-400')}>{masterOn ? 'ĐANG BẬT' : 'ĐANG TẮT'}</span>
          <Toggle on={masterOn} onToggle={() => apply({ ...cfg, master: !masterOn })} title="Công tắc tổng" />
        </div>
      </div>

      {/* BẢNG PHÍM TẮT */}
      <div className="mb-4 overflow-hidden rounded-xl border border-line bg-white shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
                <th className="px-3 py-2">Màn</th>
                <th className="px-3 py-2">Phím</th>
                <th className="px-3 py-2">Chức năng</th>
                <th className="px-3 py-2">Mục đích</th>
                <th className="px-3 py-2">Điều kiện / rủi ro</th>
                <th className="px-3 py-2 text-center">Số lần bấm</th>
                <th className="px-3 py-2 text-center">Bật</th>
              </tr>
            </thead>
            <tbody>
              {SHORTCUT_CATALOG.map((it, i) => {
                const enabled = isKeyEnabled(cfg, it.id);
                return (
                  <tr key={it.id} className={(i % 2 === 1 ? 'bg-brand-tint ' : '') + (!masterOn ? 'opacity-50' : '')}>
                    <td className="px-3 py-2 align-top text-slate-700">{it.man}</td>
                    <td className="px-3 py-2 align-top">
                      <kbd className="rounded border border-slate-300 bg-slate-50 px-1.5 py-0.5 font-mono text-xs text-slate-700">{it.phim}</kbd>
                    </td>
                    <td className="px-3 py-2 align-top font-medium text-slate-800">{it.chucNang}</td>
                    <td className="px-3 py-2 align-top text-xs text-slate-600">{it.mucDich}</td>
                    <td className="px-3 py-2 align-top text-xs text-amber-700">{it.dieuKien}</td>
                    <td className="px-3 py-2 text-center align-top">
                      {it.choPhepDoiSoLan ? (
                        <input
                          type="number"
                          min={MIN_PRESSES}
                          max={MAX_PRESSES}
                          disabled={!masterOn || !enabled}
                          value={confirmPressesFor(cfg, it.id)}
                          onChange={(e) => {
                            const n = Number(e.target.value);
                            apply({ ...cfg, confirmPresses: { ...cfg.confirmPresses, [it.id as ShortcutKeyId]: n } });
                          }}
                          className="w-14 rounded-md border border-slate-300 px-2 py-1 text-center text-sm disabled:bg-slate-100 disabled:text-slate-400"
                          title="Số lần bấm phím để xác nhận (1–5). Thao tác nguy hiểm nên ≥ 2."
                        />
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center align-top">
                      <Toggle
                        on={enabled}
                        onToggle={() => {
                          const dis = { ...cfg.disabled };
                          if (enabled) dis[it.id] = true;
                          else delete dis[it.id];
                          apply({ ...cfg, disabled: dis });
                        }}
                        title={masterOn ? 'Bật/tắt riêng phím này' : 'Bật công tắc tổng trước'}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* GÁN NGƯỜI HOÀN ↔ PHÍM */}
      <div className="rounded-xl border border-line bg-white p-4 shadow-sm">
        <div className="mb-3 flex items-start gap-2">
          <Info className="mt-0.5 h-4 w-4 shrink-0 text-brand" />
          <div>
            <div className="font-semibold text-slate-800">Gán người hoàn ↔ phím số</div>
            <div className="text-xs text-slate-500">
              Gán 1 lần — khi dropdown Người hoàn (màn Nhập bill) đang mở và ô tìm rỗng, bấm phím số sẽ chọn đúng người đã gán. Danh sách người hoàn cũng xếp theo thứ tự phím. Mỗi phím 1 người, mỗi người 1 phím.
            </div>
          </div>
        </div>
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-slate-400" />
        ) : people.length === 0 ? (
          <p className="text-sm text-slate-500">Chưa có người được tích quyền hoàn tiền (màn Nhân sự).</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-slate-100 text-left text-xs uppercase tracking-wide text-slate-600">
                  <th className="px-3 py-2">Người hoàn</th>
                  <th className="px-3 py-2 w-40">Phím gán</th>
                </tr>
              </thead>
              <tbody>
                {people.map((p, i) => {
                  const cur = refundDigitForUser(cfg, p.id);
                  return (
                    <tr key={p.id} className={i % 2 === 1 ? 'bg-brand-tint' : ''}>
                      <td className="px-3 py-2 text-slate-700">{p.fullName}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <select
                            value={cur ?? ''}
                            onChange={(e) => {
                              const d = e.target.value;
                              apply(d === '' ? clearRefundKey(cfg, cur ?? '') : assignRefundKey(cfg, d, p.id));
                            }}
                            className="rounded-md border border-slate-300 px-2 py-1 text-sm"
                          >
                            <option value="">— chưa gán —</option>
                            {digits.map((d) => {
                              const owner = userOfDigit[d];
                              const takenByOther = owner != null && owner !== p.id;
                              return (
                                <option key={d} value={d} disabled={takenByOther}>
                                  Phím {d}{takenByOther ? ' (đã gán người khác)' : ''}
                                </option>
                              );
                            })}
                          </select>
                          {cur && (
                            <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded bg-brand px-1 text-xs font-bold text-white">{cur}</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
