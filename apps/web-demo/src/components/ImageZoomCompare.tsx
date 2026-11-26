// XEM ẢNH PHÓNG TO + KHỐI ĐỐI CHIẾU — DÙNG CHUNG (Admin Demo 10/9: "màn sửa trong danh sách bill CK và danh sách bill
// POS vẫn phải có blog đối chiếu khi click vào ảnh"). Trước đây component này nằm CHÌM trong OcrSendScreen.tsx nên
// các màn SỬA bill (EditBillMessageModal / EditRefundMessageModal) không dùng lại được → soi ảnh phải nhớ số.
// Tách ra components/ để MỌI nơi mở ảnh bill đều có cùng khối đối chiếu, cùng vị trí, cùng bố cục.
// [Admin Demo 10/9] "click vào ảnh tăng kích thước blog... full blog tăng lên 50% ngang dọc, cỡ chữ, số" → mọi kích
// thước (đệm, bề rộng tối thiểu/tối đa, cỡ chữ nhãn và SỐ) đều nhân ~1,5 lần so với bản trước.
import { useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { RotateCcw, RotateCw, X } from 'lucide-react';

/** 1 mục trên khối đối chiếu. Giá trị rỗng vẫn hiện "—" để người soi biết là "OCR không đọc ra", không phải "quên in".
 *  [Admin Demo 11/9 — "màn đối chiếu cho phép sửa các trường luôn"] Mục nào có `sua` thì render Ô NHẬP ngay trong khối:
 *  gõ ở đây = gõ vào ĐÚNG state của thẻ review bên dưới (cùng setter) — không có nguồn giá trị thứ hai. `kieu='tien'`
 *  chỉ nhận chữ số (setter phía card tự format nhónghìn). Mục không có `sua` giữ nguyên chỉ-đọc (vd HKD suy từ TID). */
export interface MucDoiChieu {
  label: string;
  value: string;
  sua?: (v: string) => void;
  kieu?: 'text' | 'tien';
  /** [Admin Demo 11/9 — "thiếu sửa cả thẻ Visa hay thẻ khác"] Mục kiểu CHỌN: render <select> ngay trong khối
   *  (vd loại thẻ) — đổi là gọi setter của form (phí tính lại như đổi ở ngoài). */
  chon?: { value: string; options: { id: string; label: string }[]; sua: (id: string) => void };
}
/** Khối ĐỐI CHIẾU trong màn phóng to — DÙNG CHUNG cho bill POS / QR / CHUYỂN KHOẢN (Admin Demo 10/9: "bổ sung blog đối
 *  chiếu cho bill OCR QR và OCR bill CK chưa có"). Bố cục cố định để 3 loại bill nhìn ĐỒNG NHẤT:
 *    chinh (1 dòng LỚN xanh) → phu (mỗi mục 1 dòng) → hang (tối đa 3 mục nằm ngang) → tien (to, xanh) → duoi (hàng phụ). */
export interface KhoiDoiChieu {
  tieuDe?: string;
  chinh?: MucDoiChieu | null;
  phu?: MucDoiChieu[];
  hang?: MucDoiChieu[];
  tien: MucDoiChieu;
  duoi?: MucDoiChieu[];
}

/** Xem ảnh phóng to kiểu Zalo (Admin Demo): LĂN CHUỘT zoom + KÉO di chuyển; click nền/Esc đóng; nút Reset.
 *  `compare` (Admin Demo 1/9): block GHIM GIỮA-PHẢI mép ảnh hiện số tiền/số lô/ngày giờ để ĐỐI CHIẾU với bill NGAY
 *  trong màn zoom (khỏi mở-tắt-mở). Chỉ hiện khi mở zoom. */
export /** Ô NHẬP trong khối đối chiếu — nền tối, chữ to như bản chỉ-đọc; viền lộ rõ là "sửa được". */
function OSua({ m, lon }: { m: MucDoiChieu; lon?: boolean }): JSX.Element {
  // [Admin Demo 16/9 "sửa số ở giữa, số mới nhảy loạn ra cuối"] Ô 'tien' là input CÓ ĐỊNH DẠNG (setter regroup dấu
  // chấm) → React đặt lại value sau mỗi phím = caret văng về CUỐI khi sửa GIỮA số. Giữ caret CỤC BỘ theo SỐ CHỮ SỐ
  // đứng trước con trỏ (miễn nhiễm dấu chấm dịch chỗ) — không mượn inputRef của useGroupedMoneyField (ref đó đã
  // gắn ô form ngoài, gắn đôi sẽ tranh nhau).
  const ref = useRef<HTMLInputElement>(null);
  const soChuSoTruocCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (soChuSoTruocCaret.current == null || !ref.current) return;
    const muon = soChuSoTruocCaret.current; soChuSoTruocCaret.current = null;
    const v = ref.current.value;
    let dem = 0, pos = v.length;
    for (let i = 0; i < v.length; i++) { if (/[0-9]/.test(v[i])) dem += 1; if (dem >= muon) { pos = i + 1; break; } }
    if (muon === 0) pos = 0;
    ref.current.setSelectionRange(pos, pos);
  });
  return (
    <input
      ref={ref}
      value={m.value}
      onChange={(e) => {
        if (m.kieu === 'tien') {
          const raw = e.target.value;
          const caret = e.target.selectionStart ?? raw.length;
          soChuSoTruocCaret.current = raw.slice(0, caret).replace(/[^0-9]/g, '').length;
          m.sua?.(raw.replace(/[^0-9.,]/g, ''));
        } else m.sua?.(e.target.value);
      }}
      className={
        'w-full rounded-lg border border-white/30 bg-white/10 px-1.5 py-0.5 font-extrabold tabular-nums text-emerald-300 outline-none focus:border-emerald-300 ' +
        (lon ? 'text-[30px] leading-tight' : 'text-[18px]')
      }
      spellCheck={false}
    />
  );
}

// [Admin Demo 25/9 "dán thẳng dấu đóng 95 vào ảnh bill để cảnh báo"] `dauDe` = lớp dán ĐÈ lên ảnh (con dấu SOS lô 95).
// Phóng to là lúc người duyệt soi bill kỹ nhất — dấu PHẢI theo lên đây, không chỉ nằm ở thẻ cảnh báo bên cạnh.
export function ImageZoom({ src, onClose, compare, xoayBanDau = 0, dauDe }: { src: string; onClose: () => void; xoayBanDau?: number; compare?: KhoiDoiChieu; dauDe?: JSX.Element | null }): JSX.Element {
  const [scale, setScale] = useState(1);
  // [Admin Demo 10/9] Bill CHỤP NGANG → xoay 90° trái/phải ngay trong màn phóng to (nhận sẵn góc đang xoay ở thẻ review).
  const [deg, setDeg] = useState(xoayBanDau);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    // [Phản biện #3 — Esc đóng CẢ modal Sửa phía sau, mất số đang gõ] Bắt ở pha CAPTURE + chặn lan: 1 phím Esc chỉ
    // đóng LỚP TRÊN CÙNG (màn phóng to), Modal phía dưới không nhận sự kiện.
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [onClose]);
  function onWheel(e: React.WheelEvent): void { setScale((s) => Math.min(8, Math.max(1, s * (e.deltaY < 0 ? 1.15 : 0.87)))); }
  function onDown(e: React.MouseEvent): void { drag.current = { x: e.clientX - pos.x, y: e.clientY - pos.y }; }
  function onMove(e: React.MouseEvent): void { if (drag.current) setPos({ x: e.clientX - drag.current.x, y: e.clientY - drag.current.y }); }
  function onUp(): void { drag.current = null; }
  // Portal ra document.body — thoát khỏi .glass-panel (backdrop-filter) làm fixed bị chứa trong card (không full màn).
  // [Admin Demo 11/9 — "màn này che mất bill"] Có khối đối chiếu ⇒ chia 2 CỘT: ảnh chiếm phần TRÁI còn lại, khối là
  // CỘT PHẢI CỐ ĐỊNH 400px (không còn absolute đè lên ảnh). Không có compare → ảnh giữa màn như cũ.
  return createPortal(
    <div className="fixed inset-0 z-[100] flex select-none items-stretch overflow-hidden bg-black/90" onWheel={onWheel} onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp} onClick={(e) => { if (e.target === e.currentTarget && scale === 1) onClose(); }}>
      <div className="relative flex min-w-0 flex-1 items-center justify-center" onClick={(e) => { if (e.target === e.currentTarget && scale === 1) onClose(); }}>
        {/* Con dấu dán ĐÈ — KHÔNG ăn chuột (pointer-events-none) để kéo/zoom ảnh vẫn mượt. */}
        {dauDe && <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center">{dauDe}</div>}
        <img src={src} draggable={false} alt="bill" onMouseDown={onDown} onDoubleClick={() => { setScale(1); setPos({ x: 0, y: 0 }); }}
          // [Admin Demo 11/9 ảnh thật] marginLeft 4cm khi có khối đối chiếu → ảnh (đang căn giữa) DỊCH SANG PHẢI ~2cm,
          // đứng gần khối hơn (đối chiếu mắt khỏi phải đảo xa).
          style={{ marginLeft: compare ? '4cm' : undefined, transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale}) rotate(${deg}deg)`, cursor: scale > 1 ? 'grab' : 'zoom-in', maxHeight: deg % 180 === 0 ? '92vh' : '96vw', maxWidth: deg % 180 === 0 ? '96vw' : '92vh' }}
          className="object-contain" onClick={() => { if (scale === 1) setScale(2.5); }} />
      </div>
      <div className="absolute right-4 top-4 flex gap-2">
        <button type="button" title="Xoay trái 90°" onClick={(e) => { e.stopPropagation(); setDeg((d) => (d + 270) % 360); }} className="rounded-full bg-white/15 p-2 text-white hover:bg-white/25"><RotateCcw className="h-5 w-5" /></button>
        <button type="button" title="Xoay phải 90°" onClick={(e) => { e.stopPropagation(); setDeg((d) => (d + 90) % 360); }} className="rounded-full bg-white/15 p-2 text-white hover:bg-white/25"><RotateCw className="h-5 w-5" /></button>
        <button type="button" onClick={() => { setScale(1); setPos({ x: 0, y: 0 }); }} className="rounded-full bg-white/15 px-3 py-1.5 text-sm text-white hover:bg-white/25">Reset</button>
        <button type="button" onClick={onClose} className="rounded-full bg-white/15 p-2 text-white hover:bg-white/25"><X className="h-5 w-5" /></button>
      </div>
      {/* BLOCK ĐỐI CHIẾU ghim GIỮA-PHẢI mép ảnh (Admin Demo 1/9): số tiền/số lô/ngày giờ so trực tiếp với bill. stop
          mọi event (click/wheel/drag) để KHÔNG kích zoom/đóng khi thao tác trên block.
          [Admin Demo 10/9] "sát mép phải ngoài màn hình quá, di chuyển vào gần ảnh khoảng 1/2 chiều rộng của block"
          → thêm -translate-x-1/2: khối lùi vào trong ĐÚNG nửa bề rộng CỦA CHÍNH NÓ (không phụ thuộc cỡ màn). */}
      {compare && (
        <div data-testid="khoi-doi-chieu" className="z-[110] my-auto mr-3 flex max-h-[94vh] w-[470px] shrink-0 flex-col gap-4 overflow-y-auto rounded-2xl border border-white/15 bg-black/80 p-5 text-white shadow-2xl backdrop-blur-sm"
          onClick={(e) => e.stopPropagation()} onWheel={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
          <div className="text-[15px] font-semibold uppercase tracking-wider text-white/50">{compare.tieuDe ?? '📋 Đối chiếu bill'}{(compare.phu ?? []).concat(compare.hang ?? [], compare.tien).some((m) => m?.sua) ? <span className="ml-1 normal-case text-white/40">· ô có ✏ sửa được tại chỗ</span> : null}</div>
          {/* [Admin Demo 8/9] THỨ TỰ: dòng chính (HKD/người nhận — xanh, to ngang số tiền) → mục phụ → ngày/giờ/số lô → SỐ TIỀN → hàng dưới. */}
          {compare.chinh && (
            <div>
              <div className="text-[15px] uppercase text-white/50">{compare.chinh.label}</div>
              <div className="text-[27px] font-extrabold leading-tight text-emerald-300 break-words">{compare.chinh.value || '—'}</div>
            </div>
          )}
          {(compare.phu ?? []).map((m) => (
            <div key={m.label}>
              <div className="text-[15px] uppercase text-white/50">{m.label}{m.sua ? ' ✏' : ''}</div>
              {m.sua ? <OSua m={m} /> : <div className="text-2xl font-bold tabular-nums break-words">{m.value || '—'}</div>}
            </div>
          ))}
          {(compare.hang ?? []).length > 0 && (
            // [11/9 ảnh thật: "10/09/2026" bị cắt] Lưới cột đầu (Ngày) rộng 1,5 phần — đủ 10 ký tự ngày, không cắt.
            <div className="grid gap-3" style={{ gridTemplateColumns: (compare.hang ?? []).length === 3 ? '1.5fr 1fr 1fr' : `repeat(${(compare.hang ?? []).length}, 1fr)` }}>
              {(compare.hang ?? []).map((m) => (
                <div key={m.label} className="min-w-0">
                  <div className="text-[15px] uppercase text-white/50">{m.label}{m.sua ? ' ✏' : ''}</div>
                  {m.sua ? <OSua m={m} /> : <div className="text-[21px] font-semibold tabular-nums">{m.value || '—'}</div>}
                </div>
              ))}
            </div>
          )}
          <div className="border-t border-white/10 pt-2">
            <div className="text-[15px] uppercase text-white/50">{compare.tien.label}{compare.tien.sua ? ' ✏' : ''}</div>
            {compare.tien.sua
              ? <OSua m={compare.tien} lon />
              : <div className="text-[30px] font-extrabold tabular-nums leading-tight text-emerald-300">{compare.tien.value || '—'}</div>}
          </div>
          {/* [Admin Demo 11/9] NÚT XÁC NHẬN SỬA — như quy tắc form bên ngoài: sửa xong bấm xác nhận, giá trị đã nằm
              trong CHÍNH state của thẻ review (cùng setter) nên xác nhận = đóng phóng to về form đã mang số mới;
              các mốc "đã sửa lúc HH:MM" của form tự ghi như khi sửa ngoài form. */}
          {[...(compare.phu ?? []), ...(compare.hang ?? []), compare.tien].some((m) => m?.sua) && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); onClose(); }}
              className="mt-1 w-full rounded-xl bg-emerald-500 px-3 py-2 text-[16px] font-extrabold text-white shadow-lg transition hover:bg-emerald-400"
            >✓ Xác nhận sửa — ghi nhận giá trị mới</button>
          )}
          {/* [11/9 ảnh thật: dropdown thẻ "Ngo▾" tràn] LƯỚI 2 CỘT — mỗi mục nửa bề rộng, tên thẻ dài trọn dòng. */}
          {(compare.duoi ?? []).filter((m) => !!m.value || m.chon).length > 0 && (
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 border-t border-white/10 pt-2">
              {(compare.duoi ?? []).filter((m) => !!m.value || m.chon).map((m) => (
                <div key={m.label} className="min-w-0">
                  <div className="text-[15px] uppercase text-white/50">{m.label}{m.chon ? ' ✏' : ''}</div>
                  {m.chon ? (
                    <select
                      value={m.chon.value}
                      onChange={(e) => m.chon?.sua(e.target.value)}
                      className="w-full rounded-lg border border-white/30 bg-white/10 px-1.5 py-1 text-[15px] font-bold text-emerald-300 outline-none [&>option]:text-slate-800"
                    >
                      {m.chon.options.map((op) => <option key={op.id} value={op.id}>{op.label}</option>)}
                    </select>
                  ) : (
                    <div className="truncate text-[18px] font-medium text-white/90">{m.value}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1.5 text-xs text-white">Lăn chuột phóng to/thu nhỏ · kéo di chuyển · nháy đúp reset · {Math.round(scale * 100)}%</div>
    </div>,
    document.body
  );
}
