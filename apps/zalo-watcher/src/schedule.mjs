// Giờ làm việc watcher (Admin Demo 25/8: "đêm cho nghỉ lúc 12h00 khi không còn bill, sáng 07h00 làm việc").
// Mặc định làm [07:00, 24:00) — nghỉ 00:00–06:59. Bill đến trong giờ nghỉ KHÔNG mất: watcher backfill lúc vào
// giờ làm (07:00) qua watermark mtime. THUẦN để test.

/** Có đang trong giờ làm không. startHour/endHour theo giờ ĐỊA PHƯƠNG. endHour=24 nghĩa nửa đêm.
 *  Hỗ trợ cả cửa sổ qua-đêm (start > end, ví dụ 22→6): khi đó làm nếu h>=start HOẶC h<end. */
export function isWorkingHours(date, startHour = 7, endHour = 24) {
  const h = date.getHours();
  if (startHour === endHour) return true; // 24/24
  if (startHour < endHour) return h >= startHour && h < endHour;
  return h >= startHour || h < endHour; // cửa sổ qua-đêm
}
