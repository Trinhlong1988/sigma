// CHẶN NÚT BACK theo TỪNG BƯỚC (Admin Demo 18/8: "back chỉ được lùi 1 bước; đang ở thông tin hội thoại bấm back
// phải về phòng chat, KHÔNG nhảy thẳng về danh sách phân loại").
//
// GỐC: nút back cứng Android (AndroidBackButtonWatcher, App.tsx) chỉ biết ROUTE — `navigate(-1)`. Các OVERLAY mở
// bằng state React (panel Thông tin hội thoại `showInfo`, Bảng tin ghim `showPinBoard`, các modal…) KHÔNG phải
// history entry của router → back bỏ qua chúng, lùi thẳng 1 route (phòng chat → danh sách) = nhảy 2 bước.
//
// GIẢI PHÁP: 1 STACK handler chặn-back toàn cục. Overlay lúc mở đăng ký 1 handler đóng-chính-nó (LIFO); nút back
// chạy handler TRÊN CÙNG trước (đóng overlay = lùi ĐÚNG 1 bước) và "nuốt" sự kiện; hết overlay mới tới logic
// route cũ. Đăng ký khi overlay MOUNT (chỉ mount khi đang hiển thị), gỡ khi unmount (đóng) → luôn phản ánh đúng
// overlay đang mở.
//
// ĐỒNG BỘ WEB (Admin Demo 18/8 "xử lý đồng bộ đi"): trên native (Capacitor) đường back là sự kiện `backButton`
// (App.tsx gọi runTopBackHandler). Trên WEB (trình duyệt/mobile-web) nút back là history.back của trình duyệt —
// KHÔNG qua Capacitor. Để khớp hành vi "back đóng overlay trước": mỗi overlay mở trên web ĐẨY 1 history entry
// "sentinel" (CÙNG URL, không đổi route → react-router không điều hướng); nút back trình duyệt → `popstate` →
// đóng overlay trên cùng, nuốt bước đó. Đóng overlay bằng cách KHÁC (nút X/Esc) → tự gỡ sentinel bằng
// history.back() có cờ bỏ-qua để popstate đó không đóng nhầm overlay khác. Native KHÔNG dùng history (tránh lẫn
// với navigate(-1) của Capacitor path) — chỉ dùng stack.
import { useEffect, useRef } from 'react';
import { Capacitor } from '@capacitor/core';

type BackHandler = () => void;
const stack: BackHandler[] = [];

const USE_HISTORY = typeof window !== 'undefined' && !Capacitor.isNativePlatform();
// `expectingPopRemoval`: popstate (back trình duyệt) VỪA đóng 1 overlay → lần GỠ handler kế tiếp là do pop đó
// (React unmount cleanup chạy BẤT ĐỒNG BỘ sau setState), KHÔNG được history.back lần nữa (trình duyệt đã nuốt
// entry rồi). Giữ cờ TỒN TẠI qua khe async cho tới khi việc gỡ thật sự xảy ra (không clear đồng bộ như trước —
// đó là lỗi double-pop khiến back nhảy 2 bước tới /login).
let expectingPopRemoval = false;
let ignoreNextPop = false; // popstate do CHÍNH ta gọi history.back (gỡ sentinel lúc đóng bằng X) → bỏ qua.
let popstateAttached = false;
// BUG 1 (web): overlay đóng vì ĐIỀU HƯỚNG đi nơi khác (`onClose(); navigate(...)`). Khi đó cleanup KHÔNG được
// chạy `history.back()` gỡ sentinel — vì navigate() ĐÃ push 1 route THẬT mới lên trên sentinel; history.back sẽ
// pop nhầm route thật đó và react-router (popstate của nó KHÔNG bị ignoreNextPop chặn) sẽ lùi người dùng về
// phòng cũ.
// FIX ĐẾM (thay cờ set-once — audit 20/8 bắt lỗi giải-tán-nhóm): navigate-away có thể unmount NHIỀU overlay chồng
// trong CÙNG 1 tick (vd Giải tán: ConfirmDialog + panel cùng đóng). Cờ boolean set-once bị cleanup ĐẦU nuốt →
// cleanup SAU (panel) vẫn history.back → lùi nhầm về phòng vừa giải tán. Dùng BỘ ĐẾM = số overlay đang mở tại lúc
// điều hướng (stack.length, đọc TRƯỚC khi unmount) → mỗi cleanup trong lượt này giảm 1 và BỎ history.back. Không
// phụ thuộc timing microtask/effect (deterministic) — khác đề xuất queueMicrotask (clear quá sớm vì useEffect
// cleanup là passive, chạy SAU microtask). Reset về 0 khi mở overlay MỚI (pushBackHandler) để chặn rò sang lượt sau.
let skipHistoryBackCount = 0;
// BUG 2 (web): stack chỉ giảm ở cleanup unmount BẤT ĐỒNG BỘ. Bấm back trình duyệt 2 lần thật nhanh → popstate
// thứ 2 tới TRƯỚC khi cleanup của lần 1 commit (stack.length vẫn ≥1) → chạy LẠI cùng handler + set lại
// expectingPopRemoval trong khi trình duyệt đã pop thêm 1 route THẬT ⇒ dư 1 bước. Cờ này bật khi popstate vừa
// chạy handler trên cùng, tắt khi việc gỡ handler đó hoàn tất (cleanup) → popstate thứ 2 trong khe async bị bỏ qua.
let closePending = false;

function ensurePopstateListener(): void {
  if (popstateAttached || !USE_HISTORY) return;
  popstateAttached = true;
  window.addEventListener('popstate', () => {
    if (ignoreNextPop) { ignoreNextPop = false; return; } // sentinel do ta tự gỡ — không đóng gì.
    if (closePending) return; // BUG 2: overlay trên cùng ĐANG đóng (cleanup chưa commit) → bỏ qua pop lặp.
    if (stack.length === 0) return; // không còn overlay → để react-router điều hướng route như thường.
    expectingPopRemoval = true; // việc gỡ handler kế tiếp là do pop này (đừng history.back thêm).
    closePending = true; // chặn re-entrancy tới khi cleanup của handler này chạy xong.
    const stackLenAtPop = stack.length; // dấu vết để phát hiện handler KHÔNG unmount (wedge) ở lượt phòng vệ dưới.
    runTopBackHandler(); // đóng overlay trên cùng (trình duyệt đã nuốt đúng 1 entry sentinel của nó).
    // PHÒNG VỆ WEDGE (BUG 3, fix 21/8): closePending/expectingPopRemoval CHỈ được dọn ở cleanup unmount. Nếu handler
    // CHẠY nhưng KHÔNG unmount overlay (handler no-op / không đóng / điều hướng không gỡ) → cleanup KHÔNG BAO GIỜ
    // chạy → closePending KẸT true VĨNH VIỄN → MỌI lần back sau bị nuốt im (back hỏng hẳn). setTimeout(0) chạy SAU
    // khi React flush passive cleanup (scheduler MessageChannel ưu tiên hơn timer 0): ca đóng BÌNH THƯỜNG →
    // cleanup đã GIẢM stack + dọn cờ TRƯỚC khi timer chạy → điều kiện dưới SAI → no-op, KHÔNG đụng BUG 2 (pop lặp
    // nhanh nằm trong khe TRƯỚC cleanup, đã bị closePending nuốt xong). CHỈ ca WEDGE (stack KHÔNG đổi ⇒ không
    // unmount + cờ còn kẹt) mới dọn cờ, để lần back kế chạy LẠI handler thay vì nuốt im mãi.
    setTimeout(() => {
      if (closePending && stack.length === stackLenAtPop) {
        closePending = false;
        expectingPopRemoval = false;
      }
    }, 0);
  });
}

/** BUG 1 (web) — overlay báo "tôi đóng vì ĐANG điều hướng đi nơi khác" TRƯỚC khi gọi onClose(): cleanup kế tiếp
 * sẽ BỎ QUA `history.back()` gỡ sentinel (navigate() đã push route thật; back sẽ pop nhầm nó). No-op trên native
 * (USE_HISTORY=false — native chỉ dùng stack, không có sentinel). Gọi ĐÚNG 1 lần ngay trước mỗi onClose-để-điều-hướng. */
export function closeOverlayForNavigation(): void {
  if (!USE_HISTORY) return;
  // Đọc stack.length NGAY BÂY GIỜ (trước onClose/setState flush → chưa overlay nào unmount) = đúng số cleanup sắp
  // chạy trong lượt này; đánh dấu bấy nhiêu cleanup BỎ history.back. navigate() sắp push route thật lên trên MỌI
  // sentinel → không overlay nào được history.back (sẽ pop nhầm route thật).
  skipHistoryBackCount = stack.length;
}

/** Đăng ký 1 handler chặn-back; trả hàm gỡ. Handler mới nằm TRÊN CÙNG (đóng trước). */
export function pushBackHandler(handler: BackHandler): () => void {
  if (USE_HISTORY) {
    ensurePopstateListener();
    window.history.pushState({ __sigmaOverlay: true }, ''); // entry sentinel CÙNG URL (không đổi route).
    skipHistoryBackCount = 0; // mở overlay MỚI = lượt tương tác mới → dọn bộ đếm điều-hướng-đi còn sót (chống rò).
  }
  stack.push(handler);
  return () => {
    const i = stack.lastIndexOf(handler);
    if (i === -1) return;
    stack.splice(i, 1);
    if (!USE_HISTORY) return;
    if (skipHistoryBackCount > 0) {
      // BUG 1: overlay đóng để ĐIỀU HƯỚNG đi — KHÔNG history.back (navigate đã push route thật lên trên sentinel,
      // back sẽ pop nhầm nó). Giảm bộ đếm để MỌI overlay chồng cùng unmount lượt này đều bỏ history.back (không
      // consume-once → tránh lỗi giải-tán-nhóm: cleanup sau vẫn lùi nhầm).
      skipHistoryBackCount -= 1;
      closePending = false; // an toàn: dọn luôn (đóng lập trình không đi qua popstate, nhưng tránh kẹt cờ).
      expectingPopRemoval = false; // dọn nốt: tránh rò cờ nếu pop+navigate chồng nhau.
      return;
    }
    if (expectingPopRemoval) {
      expectingPopRemoval = false; // đóng do nút back trình duyệt — entry đã bị nuốt, KHÔNG history.back.
      closePending = false; // BUG 2: việc gỡ do popstate đã hoàn tất → cho phép popstate kế tiếp chạy handler dưới.
    } else {
      // Đóng bằng cách KHÁC (nút X/Esc/lập trình) → gỡ entry sentinel còn thừa (guard ignoreNextPop để popstate
      // đó không đóng nhầm overlay khác đang mở bên dưới).
      ignoreNextPop = true;
      window.history.back();
    }
  };
}

/** Chạy handler trên cùng (nếu có). Trả true = đã "nuốt" back (caller KHÔNG được navigate route). */
export function runTopBackHandler(): boolean {
  const handler = stack[stack.length - 1];
  if (!handler) return false;
  handler();
  return true;
}

/** Còn overlay nào đang chặn back không (dùng cho web/popstate nếu cần). */
export function hasBackHandler(): boolean {
  return stack.length > 0;
}

/** Hook tiện: khi `active` (mặc định true — dùng cho component CHỈ mount lúc mở), đăng ký `onBack` làm handler
 * chặn-back; tự gỡ khi unmount/`active`=false. Handler đọc `onBack` mới nhất qua closure mỗi lần đăng ký. */
export function useBackIntercept(active: boolean, onBack: BackHandler): void {
  const onBackRef = useRef(onBack);
  onBackRef.current = onBack; // luôn trỏ tới handler mới nhất — tránh stale closure khi state đổi.
  useEffect(() => {
    if (!active) return undefined;
    return pushBackHandler(() => onBackRef.current());
  }, [active]);
}
