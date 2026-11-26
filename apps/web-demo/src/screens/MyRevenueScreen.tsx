// NỐI TẮT DOANH SỐ RA NGOÀI CỬA SỔ CHAT (Admin Demo 21/8) — vào THẲNG từ Sidebar, liệt kê các NHÓM (NĐT + đại lý +
// QR) để bấm 1 phát mở doanh số phòng (RoomRevenueScreen qua ROUTES.chatRoomRevenue).
//
// [Admin Demo 10-11/9] Bảng KPI 1 dòng/nhóm, chốt theo loạt chỉ đạo mới nhất:
//   · CHỌN CHU KỲ ở ĐẦU màn (hôm nay/hôm qua/tuần/tháng/30 ngày) — server nhận from/to, cùng engine màn phòng.
//   · CHỈ 4 Ô: Trước phí · Sau phí · Đã hoàn · Thừa/thiếu (BỎ số lô, đã ứng, hoàn ứng). NĐT: Doanh thu · Tiền về.
//   · SỐ ĐẦY ĐỦ đúng định dạng vi-VN (100.000.000đ) — KHÔNG viết tắt "100 tr".
//   · Ô rộng bằng nhau, căn PHẢI, thẳng cột dọc (lưới 4 cột đều, dồn về mép phải).
//   · SẮP ĐẠI LÝ theo DOANH SỐ trước phí CAO→THẤP theo chu kỳ đang chọn; NHÓM NĐT GHIM TRÊN cố định.
//   · Vào lại màn KHÔNG GIẬT: nhớ danh sách + KPI trong phiên (hiện ngay số cũ, tải mới thay vào) — cùng cách đã
//     làm cho màn Tra soát sao kê; danh sách cuộn được; lề 2 bên 1,5cm; hiệu ứng 3D khi chọn.
// SỐ LẤY TỪ SERVER (getRoomsRevenueKpi → cùng engine với màn doanh số phòng) — màn này KHÔNG tự tính tiền.
import { useEffect, useMemo, useState, type JSX } from 'react';
import { useNavigate } from 'react-router';
import { BarChart3, ChevronRight, AlertTriangle } from 'lucide-react';
import { DotsLoader } from '../components/DotsLoader';
import { BackButton } from '../components/BackButton';
import { listChatRoomsWithNames, getRoomsRevenueKpi, type RoomRevenueKpi } from '../lib/chat-client';
import { xepNhomDoanhSo, hangNhom } from '../lib/revenue-group-order';
import type { ChatRoom } from '../mock-data/types';
import { ROUTES } from '../routes';

/** CÙNG bộ chu kỳ + CÙNG cách tính biên [from,to) với màn doanh số phòng (RoomRevenueScreen) → 2 màn ra 1 số. */
type KyKey = 'today' | 'yesterday' | 'week' | 'month' | '30d';
const KY_NHAN: Record<KyKey, string> = { today: 'Hôm nay', yesterday: 'Hôm qua', week: 'Tuần này', month: 'Tháng này', '30d': '30 ngày qua' };
const KY_DS: KyKey[] = ['today', 'yesterday', 'week', 'month', '30d'];
export function kyRange(key: KyKey, now = new Date()): { from: Date; to: Date } {
  const dauHomNay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const to = new Date(dauHomNay.getTime() + 86400000);
  switch (key) {
    case 'today': return { from: dauHomNay, to };
    case 'yesterday': return { from: new Date(dauHomNay.getTime() - 86400000), to: dauHomNay };
    case 'week': { const t = now.getDay() === 0 ? 7 : now.getDay(); return { from: new Date(dauHomNay.getTime() - (t - 1) * 86400000), to }; }
    case 'month': return { from: new Date(now.getFullYear(), now.getMonth(), 1), to };
    case '30d': return { from: new Date(dauHomNay.getTime() - 29 * 86400000), to };
  }
}

/** SỐ TIỀN ĐẦY ĐỦ định dạng vi-VN (Admin Demo 11/9 "không viết tắt 100tr — số đủ đúng định dạng"). */
export function tienDu(n: number | null | undefined): string {
  if (n == null) return '—';
  return `${n.toLocaleString('vi-VN')}đ`;
}

/** Màu trạng thái đối soát — bảng màu màn "Doanh số" phòng chat: đủ=xanh · thừa=hổ phách · thiếu=đỏ · chưa hoàn=xám. */
export function mauThuaThieu(thuaThieu: number | null | undefined, daHoan: number | null | undefined): string {
  if (thuaThieu == null) return '#334155';
  if (Math.abs(thuaThieu) <= 3000) return '#16a34a';
  if (thuaThieu > 0) return '#d97706';
  return (daHoan ?? 0) > 0 ? '#dc2626' : '#94a3b8';
}

/** SẮP DANH SÁCH (thuần, test được): NĐT ghim TRÊN cố định (giữ thứ tự tên), rồi ĐẠI LÝ + nhóm QR theo DOANH SỐ
 *  trước phí CAO→THẤP của chu kỳ đang chọn (chưa có số → 0; hoà thì theo tên cho ổn định). */
export function xepTheoDoanhSo(rooms: readonly ChatRoom[], kpi: Map<string, RoomRevenueKpi> | null): ChatRoom[] {
  // [Admin Demo 11/9 — "sao không ưu tiên ghim 2 NĐT trên cùng?"] GHIM = HỢP của 2 tín hiệu: server bảo là NĐT
  // (laNdt=true) HOẶC tên nhóm thuộc hạng NĐT (hangNhom=0). TRƯỚC dùng `??` — server trả lỗi 1 phòng NĐT
  // (laNdt=false trong bản lỗi) là phòng đó RỚT khỏi ghim, rơi xuống giữa danh sách đại lý.
  const laNdt = (r: ChatRoom): boolean => kpi?.get(r.id)?.laNdt === true || hangNhom(r.name) === 0;
  const ndt = rooms.filter(laNdt);
  const conLai = [...rooms.filter((r) => !laNdt(r))].sort((a, b) => {
    const ga = kpi?.get(a.id)?.grossHomNay ?? 0;
    const gb = kpi?.get(b.id)?.grossHomNay ?? 0;
    if (gb !== ga) return gb - ga;
    return (a.name ?? '').localeCompare(b.name ?? '', 'vi');
  });
  return [...ndt, ...conLai];
}

/** BẢN NHỚ TRONG PHIÊN (Admin Demo 11/9 "quay về menu doanh số bị giật màn cũ xong mới load"): vào lại màn là có
 *  ngay danh sách + số cũ của kỳ đó, rồi lượt tải mới lặng lẽ thay vào — không màn trắng, không nhảy bố cục. */
const boNhoKpi = new Map<string, { at: number; kpi: Map<string, RoomRevenueKpi> }>();
let boNhoRooms: { at: number; rooms: ChatRoom[] } | null = null;

/** 1 Ô KPI — khuôn ô tổng màn doanh số phòng: nhãn in hoa + SỐ ĐẦY ĐỦ căn PHẢI. `dangTai` = giữ chỗ xám. */
function O({ nhan, so, mauHex, nhan1, title, dangTai }: { nhan: string; so?: string; mauHex?: string; nhan1?: boolean; title?: string; dangTai?: boolean }): JSX.Element {
  return (
    // [Agent3 11/9] px-2 → px-1.5: thêm 4px cho SỐ — ở 1150px ô chỉ ~100px, "1.248.500.000đ" (≈96px @11.5px) bị cắt.
    // Ô là CSS container (inline-size) để cỡ chữ số tự co THEO BỀ RỘNG Ô THẬT (cqw) — ngưỡng tĩnh theo độ dài
    // (11.5/13/14) đã LỌT cắt số ở 1150px (ảnh harness agent3): mỗi bề rộng màn cần cỡ khác nhau.
    <div className={'flex h-[46px] w-full flex-col justify-center rounded-lg-mac border px-1.5 py-1 text-right ' + (nhan1 ? 'border-brand/30 bg-brand-tint' : 'border-line bg-white')} title={title} style={{ containerType: 'inline-size' }}>
      <div className={'truncate text-[9px] font-bold uppercase tracking-wide ' + (nhan1 ? 'text-brand/70' : 'text-slate-400')}>{nhan}</div>
      {dangTai
        ? <div className="ml-auto mt-1 h-3.5 w-20 animate-pulse rounded bg-slate-200" />
        : (
          // SỐ PHẢI ĐỦ, KHÔNG CẮT (Admin Demo): font = min(14px, bề-rộng-ô ÷ (số-ký-tự × 0.64em)) — ô hẹp/số dài
          // tự co (sàn 8.5px), ô rộng giữ 14px. 0.64 = bề rộng trung bình 1 ký tự đo thật (extrabold tabular).
          <div
            className={'whitespace-nowrap font-extrabold tabular-nums leading-tight ' + (nhan1 ? 'text-brand' : 'text-slate-800')}
            style={{ fontSize: `clamp(8.5px, calc(100cqw / ${(Math.max((so ?? '').length, 1) * 0.64).toFixed(2)}), 14px)`, ...(mauHex ? { color: mauHex } : {}) }}
          >{so}</div>
        )}
    </div>
  );
}

export function MyRevenueScreen(): JSX.Element {
  const navigate = useNavigate();
  const [rooms, setRooms] = useState<ChatRoom[] | null>(boNhoRooms?.rooms ?? null);
  const [error, setError] = useState<string | null>(null);
  const [ky, setKy] = useState<KyKey>('today');
  const [kpi, setKpi] = useState<Map<string, RoomRevenueKpi> | null>(boNhoKpi.get('today')?.kpi ?? null);
  const [kpiErr, setKpiErr] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listChatRoomsWithNames().then((r) => {
      if (cancelled) return;
      if (!r.ok) { if (!boNhoRooms) setError('Không tải được danh sách nhóm — vui lòng thử lại.'); return; }
      const ds = xepNhomDoanhSo(r.data.filter((room) => room.isGroup));
      setRooms(ds);
      boNhoRooms = { at: Date.now(), rooms: ds };
    });
    return () => { cancelled = true; };
  }, []);

  // KPI theo KỲ: có bản nhớ của kỳ đó → hiện ngay (không xoá số cũ), rồi tải mới thay vào.
  const dsId = useMemo(() => (rooms ?? []).map((r) => r.id).join(','), [rooms]);
  useEffect(() => {
    if (!rooms || rooms.length === 0) return;
    let cancelled = false;
    const nho = boNhoKpi.get(ky);
    setKpi(nho && Date.now() - nho.at < 5 * 60_000 ? nho.kpi : null);
    setKpiErr(null);
    const { from, to } = kyRange(ky);
    void getRoomsRevenueKpi(rooms.map((r) => r.id), { from, to }).then((kq) => {
      if (cancelled) return;
      if (kq.ok) {
        const m = new Map(kq.data.map((k) => [k.roomId, k]));
        setKpi(m);
        boNhoKpi.set(ky, { at: Date.now(), kpi: m });
      } else setKpiErr(`Không tải được KPI các nhóm: ${kq.message}`);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dsId, ky]);

  // [Admin Demo 11/9] Đại lý sắp theo doanh số CAO→THẤP của kỳ; NĐT ghim trên. Chưa có KPI → giữ thứ tự nhóm cũ.
  const dsSap = useMemo(() => (rooms ? xepTheoDoanhSo(rooms, kpi) : null), [rooms, kpi]);

  return (
    // "2 bên cách lề 1,5 cm" — đơn vị cm thật (từ lg trở lên; màn hẹp/điện thoại lề 12px, 1,5cm×2 nuốt 114px
    // của màn 390px làm ô số văng khỏi màn — bắt được bằng ảnh harness agent3 11/9). `min-h-0` để danh sách CUỘN.
    <div data-testid="man-doanh-so-nhom" className="flex h-full min-h-0 w-full flex-col px-3 py-3 lg:px-[1.5cm]">
      <div className="mb-2 flex items-center gap-2">
        <BackButton variant="icon-only" onClick={() => navigate(-1)} className="shrink-0" />
        <h1 className="flex items-center gap-1.5 text-base font-semibold text-slate-800">
          <BarChart3 className="h-5 w-5 text-brand" /> Doanh số theo nhóm
        </h1>
      </div>

      {/* CHỌN CHU KỲ — ĐẦU MÀN. */}
      <div data-testid="chon-ky" className="mb-2 flex flex-wrap items-center gap-1.5 rounded-lg-mac border border-line bg-white px-2 py-1.5">
        {KY_DS.map((k) => (
          <button key={k} type="button" onClick={() => setKy(k)}
            className={'rounded-full px-3 py-1 text-xs font-bold transition ' + (ky === k ? 'bg-brand text-white shadow-sm' : 'text-slate-500 hover:bg-brand/10')}>
            {KY_NHAN[k]}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-slate-400">Đại lý xếp theo doanh số cao → thấp · NĐT ghim trên · bấm nhóm để mở chi tiết</span>
      </div>

      {rooms == null && !error && <div className="flex justify-center py-10"><DotsLoader /></div>}
      {error && <p className="text-sm text-danger">{error}</p>}
      {kpiErr && (
        <p className="mb-2 flex items-start gap-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-xs font-semibold text-amber-800">
          <AlertTriangle className="h-4 w-4 shrink-0" /> {kpiErr}
        </p>
      )}
      {rooms && rooms.length === 0 && <p className="text-sm text-slate-500">Chưa có nhóm đại lý nào.</p>}

      {/* DANH SÁCH CUỘN — phần đầu màn đứng yên. */}
      <ul data-testid="ds-nhom" className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pb-4" style={{ perspective: '1200px' }}>
        {dsSap?.map((room, i) => {
          const k = kpi?.get(room.id);
          const dangTai = kpi == null && !kpiErr;
          const laNdt = k?.laNdt === true || hangNhom(room.name) === 0;
          const nhanLoai = laNdt ? 'Nhà đầu tư' : hangNhom(room.name) === 2 ? 'Nhóm QR' : 'Đại lý';
          return (
            <li key={room.id}>
              <button
                type="button"
                onClick={() => navigate(ROUTES.chatRoomRevenue(room.id))}
                // Hiệu ứng 3D khi chọn: chỉ transform/shadow (GPU) — không giật bố cục.
                // [Agent3 11/9 — ảnh 1150/390 lộ số bị CẮT] Màn hẹp (<lg): cho hàng GẬP (flex-wrap) — tên trên,
                // lưới ô xuống dòng full-width; từ lg giữ nguyên 1 hàng như spec.
                className="group flex w-full flex-wrap items-center gap-2 rounded-lg-mac border border-line bg-white px-3 py-2.5 text-left shadow-sm transition-all duration-200 ease-out will-change-transform hover:-translate-y-0.5 hover:border-brand/40 hover:shadow-xl lg:flex-nowrap hover:[transform:translateY(-2px)_rotateX(6deg)] active:[transform:translateY(0)_rotateX(0deg)_scale(0.995)]"
                style={{ transformStyle: 'preserve-3d' }}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand/10 text-[12px] font-extrabold tabular-nums text-brand">{i + 1}</span>
                {/* [11/9] Cột tên CỐ ĐỊNH (không min/max co giãn theo tên) → mọi dòng, lưới ô bắt đầu CÙNG
                    một mép trái — hết cảnh cột "lệch xô do dồn trái". [Agent3 11/9] 230px chỉ từ xl; màn lg-xl
                    (vd 1150px) thu còn 150px — nếu giữ 230 thì ô số chỉ còn ~84px, "1.248.500.000đ" bị cắt (ảnh). */}
                <span data-testid="cot-ten" className="flex min-w-0 flex-1 flex-col lg:w-[150px] lg:flex-none xl:w-[230px]">
                  <span className="truncate text-sm font-extrabold text-slate-800" title={room.name ?? ''}>{room.name || 'Nhóm không tên'}</span>
                  <span className={'text-[10px] font-bold uppercase ' + (laNdt ? 'text-brand' : 'text-slate-400')}>{nhanLoai}</span>
                </span>

                {/* [Admin Demo 11/9] LƯỚI 5 CỘT ĐỀU, chiếm 85% phần còn lại và DỒN PHẢI ("giảm chiều ngang các ô
                    15%, căn chuẩn 2 mép") — cột tên cố định 230px nên mép trái/phải của lưới THẲNG ở mọi dòng.
                    ĐẠI LÝ 4 ô (cột đầu trống) · NĐT đủ 5 ô: Trước phí · Sau phí cài · Đã tạm ứng · Đã hoàn lại ·
                    Lợi nhuận. */}
                {/* [Agent3 11/9] <lg: lưới GẬP xuống dòng riêng, full-width, 2 cột (ô đủ rộng cho số tỷ);
                    lg trở lên: 5 cột 85% dồn phải như spec. */}
                <div className="ml-auto grid w-full min-w-0 grid-cols-2 items-center gap-1.5 lg:w-[85%] lg:grid-cols-5">
                  {k?.error ? (
                    <span className="col-span-5 flex items-center gap-1 rounded-lg border border-danger/40 bg-danger/10 px-2 py-1 text-[11px] font-semibold text-danger" title={k.error}>
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" /> {k.error.slice(0, 60)}
                    </span>
                  ) : laNdt ? (
                    <>
                      <O nhan="Trước phí" so={tienDu(k?.grossHomNay)} nhan1 dangTai={dangTai} title="Doanh thu NĐT (trước phí) trong kỳ" />
                      <O nhan="Sau phí cài" so={tienDu(k?.netHomNay)} dangTai={dangTai} title="Tiền về NĐT (sau phí cài máy) trong kỳ" />
                      <O nhan="Đã tạm ứng" so={tienDu(k?.ndtDaTamUng)} dangTai={dangTai} title="Σ tạm ứng NĐT trong kỳ" />
                      <O nhan="Đã hoàn lại" so={tienDu(k?.ndtDaHoanLai)} dangTai={dangTai} title="Σ SigMa hoàn lại NĐT trong kỳ" />
                      <O nhan="Lợi nhuận" so={tienDu(k?.ndtLoiNhuan)} mauHex="#16a34a" dangTai={dangTai} title="Lãi NĐT (0,1% doanh thu) trong kỳ" />
                    </>
                  ) : (
                    <>
                      <div aria-hidden className="hidden lg:block" />
                      <O nhan="Trước phí" so={tienDu(k?.grossHomNay)} nhan1 dangTai={dangTai} title="Doanh số trước phí trong kỳ" />
                      <O nhan="Sau phí" so={tienDu(k?.netHomNay)} dangTai={dangTai} title="Sau phí (thực nhận) trong kỳ" />
                      <O nhan="Đã hoàn" so={tienDu(k?.daHoan)} mauHex={k ? mauThuaThieu(k.thuaThieu, k.daHoan) : undefined} dangTai={dangTai} title="Đã hoàn trong kỳ" />
                      <O nhan="Thừa/thiếu" dangTai={dangTai}
                        so={k?.thuaThieu == null ? '—' : (k.thuaThieu > 0 ? '+' : '') + tienDu(k.thuaThieu)}
                        mauHex={k ? mauThuaThieu(k.thuaThieu, k.daHoan) : undefined}
                        title="Dương = đã trả thừa · âm = còn thiếu" />
                    </>
                  )}
                </div>
                <ChevronRight className="hidden h-4 w-4 shrink-0 text-slate-400 transition-transform group-hover:translate-x-0.5 lg:block" />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
