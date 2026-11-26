// HÀM DÙNG CHUNG CHO CÁC CỔNG GIAO DIỆN.
//
// [23/11 — 20/40 cổng ĐỎ cùng lúc, tất cả "locator.click: Timeout 30000ms"] App bật hộp thoại
// "Bộ nhớ sắp đầy" (ổ D: 80,5% ≥ ngưỡng 80%) ngay khi mở màn. Hộp thoại dùng lớp phủ `fixed inset-0`
// nên NUỐT mọi cú bấm ⇒ cổng nào cũng treo 30 giây rồi đỏ vì lý do CHẲNG LIÊN QUAN tới thứ nó kiểm.
// Sai lầm quy trình ở đây: mỗi cổng tự lo phần "vào màn", không ai lo phần "có gì che màn không".
//
// Dùng: `await dongHopThoaiChe(p)` NGAY SAU khi trang nạp xong, TRƯỚC cú bấm đầu tiên.
// Trả về danh sách nội dung các hộp thoại đã đóng (để cổng in ra log, không nuốt im).

/**
 * Đóng mọi hộp thoại đang che màn (tối đa `lan` vòng).
 * KHÔNG dùng Escape làm chính: nhiều hộp của app không nghe phím Escape — phải bấm đúng nút.
 */
const HOP_NHIEU = /Bộ nhớ sắp đầy|ngưỡng \d+%|Cập nhật thất bại|Có bản cập nhật mới/i;

export async function dongHopThoaiChe(p, lan = 4) {
  const daDong = [];
  for (let i = 0; i < lan; i++) {
    const co = await p.evaluate((mau) => {
      const re = new RegExp(mau, 'i');
      const el = [...document.querySelectorAll('div.fixed.inset-0')]
        .find((x) => x.getClientRects().length && re.test(x.textContent || ''));
      return el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 140) : null;
    }, HOP_NHIEU.source);
    if (!co) break;
    daDong.push(co);
    const bam = await p.evaluate((mau) => {
      const re = new RegExp(mau, 'i');
      const el = [...document.querySelectorAll('div.fixed.inset-0')]
        .find((x) => x.getClientRects().length && re.test(x.textContent || ''));
      if (!el) return false;
      const bs = [...el.querySelectorAll('button')];
      // Ưu tiên nút ĐÓNG/HOÃN; không thấy thì lấy nút CUỐI (thường là nút phụ, không phải nút hành động).
      const n = bs.find((b) => /Để sau|Đóng|Bỏ qua|Đã hiểu|Hủy|OK/i.test(b.textContent || ''))
        ?? bs[bs.length - 1];
      if (!n) return false;
      n.click();
      return true;
    }, HOP_NHIEU.source);
    if (!bam) await p.keyboard.press('Escape');
    await p.waitForTimeout(700);
  }
  if (daDong.length) console.log('      đã đóng hộp thoại che màn:', daDong.map((x) => JSON.stringify(x.slice(0, 60))).join(' · '));
  return daDong;
}

/**
 * CÀI "NGƯỜI GÁC" tự đóng hộp thoại che màn MỌI LÚC — không chỉ lúc vừa nạp trang.
 *
 * Vì sao cần: hộp "Bộ nhớ sắp đầy" bật SAU khi dữ liệu tải xong, tức SAU lần dọn đầu tiên ⇒ cổng nào
 * bấm muộn vẫn treo 30 giây (đo thật 23/11: _kiem-ten-dai-ly-ten-dat, _kiem-dai-xen-ke-o-loc).
 * `addLocatorHandler` của Playwright sinh ra đúng cho việc này: hễ một cú bấm BỊ CHẶN bởi lớp phủ,
 * nó chạy hàm dưới đây để dẹp rồi bấm lại — không phải rải lệnh dọn khắp nơi.
 */
// Những hộp thoại NHIỄU được phép tự đóng. KHÔNG để trống danh sách này: hộp thoại NGHIỆP VỤ
// (chọn khách, xuất Excel, xác nhận hoàn…) cũng là `div.fixed.inset-0` — gác bừa là tự bấm nút trong
// hộp của chính phép kiểm rồi phá luồng (đo thật 23/11: 11 cổng đỏ, trong đó có cổng vừa xanh xong).

export async function gacHopThoai(p) {
  await p.addLocatorHandler(
    p.locator('div.fixed.inset-0').filter({ hasText: /Bộ nhớ sắp đầy|Có bản cập nhật mới/ }).first(),
    async () => {
      const chu = await p.evaluate(() => {
        const el = [...document.querySelectorAll('div.fixed.inset-0')].find((x) => x.getClientRects().length);
        return el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
      });
      const bam = await p.evaluate((mau) => {
        const re = new RegExp(mau, 'i');
        const el = [...document.querySelectorAll('div.fixed.inset-0')]
          .find((x) => x.getClientRects().length && re.test(x.textContent || ''));
        if (!el) return false; // không phải hộp nhiễu → KHÔNG đụng vào
        const bs = [...el.querySelectorAll('button')];
        const n = bs.find((b) => /Để sau|Đóng|Bỏ qua|Đã hiểu|Hủy|OK/i.test(b.textContent || '')) ?? bs[bs.length - 1];
        if (!n) return false;
        n.click();
        return true;
      }, HOP_NHIEU.source);
      if (bam && chu) console.log('      [gác] dẹp hộp thoại nhiễu:', JSON.stringify(chu));
    },
    { noWaitAfter: true }
  );
}

/** Đọc rồi ĐÓNG hộp báo lỗi của app (data-kiem="hop-bao-loi"). Trả nội dung đã đọc.
 *  Không đóng là hộp này chắn mọi cú bấm sau đó ⇒ cổng treo 30s rồi đỏ vì lý do chẳng liên quan. */
export async function docVaDongHopBaoLoi(p) {
  const chu = await p.evaluate(() => {
    const el = document.querySelector('[data-kiem="hop-bao-loi"]');
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '';
  });
  if (chu) {
    await p.evaluate(() => {
      const el = document.querySelector('[data-kiem="hop-bao-loi"]');
      const nut = el?.querySelector('button');
      if (nut) nut.click(); else el?.click();
    });
    await p.waitForTimeout(400);
  }
  return chu;
}
