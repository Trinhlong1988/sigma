// Phần ĐO dùng chung cho cổng ghim-tiêu-đề (bản web + bản EXE).
// Vì sao lăn CHUỘT chứ không gán scrollTop: đã đo 13/11 — đặt `overflow-y:hidden` thì gán `scrollTop`
// VẪN chạy (đúng chuẩn web: hidden chỉ chặn NGƯỜI DÙNG, không chặn script) ⇒ bài kiểm kiểu gán scrollTop
// XANH SUÔNG, không chứng minh được người dùng cuộn được. Lăn chuột có đối chứng âm đạt: 84px / 0px / 84px.
export const SEL = "[data-kiem='khung-bang']";

export async function doMotMan(p, ten, chot) {
  const soKhung = await p.evaluate((sel) => document.querySelectorAll(sel).length, SEL);
  if (soKhung === 0) { chot(false, ten + ': không thấy khung bảng'); return []; }
  const ra = [];
  for (let i = 0; i < soKhung; i++) {
    const nhan = soKhung > 1 ? ten + ' [bảng ' + (i + 1) + '/' + soKhung + ']' : ten;
    const r = await doMotKhung(p, nhan, chot, i);
    if (r) ra.push(r);
  }
  return ra;
}

async function doMotKhung(p, ten, chot, chiSo) {
  const t = await p.evaluate(([sel, i]) => {
    const k = document.querySelectorAll(sel)[i];
    if (!k) return { loi: 'không thấy khung bảng' };
    k.scrollIntoView({ block: 'center' });
    window.__khung = k;
    k.scrollTop = 0;
    const r = k.getBoundingClientRect();
    return {
      x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
      caoKhung: Math.round(r.height),
      tran: Math.max(0, k.scrollHeight - k.clientHeight),
      noiDungVuot: k.scrollHeight > k.clientHeight + 2,
      chuotTrungKhung: (() => { const e = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)); return !!e && (k === e || k.contains(e)); })()
    };
  }, [SEL, chiSo]);
  if (t.loi) { chot(false, ten + ': ' + t.loi); return null; }
  // Con trỏ phải nằm TRÊN khung bảng, không thì cú lăn rơi vào chỗ khác và số đo vô nghĩa.
  chot(t.chuotTrungKhung, ten + ': điểm lăn chuột nằm trong khung bảng');

  await p.mouse.move(t.x, t.y);
  let truoc = -1, nay = 0, vong = 0;
  while (vong < 80) {
    await p.mouse.wheel(0, 1200);
    await p.waitForTimeout(90);
    nay = await p.evaluate(() => Math.round(window.__khung.scrollTop));
    if (nay === truoc) break;
    truoc = nay; vong++;
  }
  await p.waitForTimeout(400);

  const d = await p.evaluate(() => {
    const k = window.__khung;
    const th = k.querySelector('thead');
    const rk = k.getBoundingClientRect();
    const rt = th ? th.getBoundingClientRect() : null;
    let chaCuon = false;
    for (let e = k.parentElement; e; e = e.parentElement) {
      const c = getComputedStyle(e);
      if ((c.overflowY === 'auto' || c.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 2) { chaCuon = true; break; }
      if (e.tagName.toLowerCase() === 'body') break;
    }
    return {
      daCuon: Math.round(k.scrollTop),
      tranNay: Math.max(0, k.scrollHeight - k.clientHeight),
      chaCuon,
      tieuDeTrongTam: !!rt && rt.top >= rk.top - 2 && rt.bottom <= rk.bottom + 2,
      tieuDeTop: rt ? Math.round(rt.top - rk.top) : -999,
      oCuon: (() => {
        const ds = [...document.querySelectorAll('main *')].filter((e) => {
          const c = getComputedStyle(e);
          return (c.overflowY === 'auto' || c.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 2;
        });
        return { tong: ds.length, long: ds.filter((e) => ds.some((o) => o !== e && o.contains(e))).length };
      })(),
      trangCuon: (document.querySelector('main')?.scrollHeight ?? 0) > (document.querySelector('main')?.clientHeight ?? 0) + 2
    };
  });

  console.log('     khung cao ' + t.caoKhung + 'px · lăn chuột xuống ' + d.daCuon + '/' + d.tranNay +
    'px · tiêu đề cách mép trên ' + d.tieuDeTop + 'px');
  if (t.noiDungVuot) {
    // NGƯỜI DÙNG phải lăn được, và phải lăn TỚI ĐÁY (không kẹt giữa chừng). Không đặt ngưỡng px tự chế:
    // màn ít dữ liệu (dư 85px) vẫn hợp lệ, chỉ cần tới đáy.
    chot(d.daCuon > 0, ten + ': NGƯỜI DÙNG lăn chuột cuộn được khung bảng (' + d.daCuon + 'px)');
    // Màn CUỘN TẢI DẦN (Doanh Thu): lăn tới đâu nạp thêm tới đó ⇒ đáy chạy xa dần, đòi "tới đáy" là SAI đề.
    // Phân biệt bằng chính số đo: trần nở ra trong lúc lăn = bảng đang nạp thêm.
    const noRa = d.tranNay > t.tran + 2;
    if (noRa) chot(d.daCuon >= t.tran, ten + ': lăn qua HẾT phần đã nạp rồi bảng nạp tiếp — cuộn tải dần (' +
      d.daCuon + 'px · trần ' + t.tran + '→' + d.tranNay + 'px)');
    else chot(d.daCuon >= d.tranNay - 2, ten + ': lăn được TỚI ĐÁY (' + d.daCuon + '/' + d.tranNay + 'px)');
  } else {
    console.log('     (ít dòng — không có gì để cuộn, bỏ qua 2 phép kiểm cuộn)');
  }
  chot(!(t.noiDungVuot && d.daCuon === 0 && !d.chaCuon), ten + ': KHÔNG bị cắt mất dòng');
  chot(d.tieuDeTrongTam, ten + ': hàng TIÊU ĐỀ vẫn trong tầm nhìn sau khi cuộn sâu (cách mép ' + d.tieuDeTop + 'px)');
  // Màn nhiều BẢNG thì nhiều ô cuộn là ĐÚNG (vd "duyệt hủy" có 2 bảng). Cái cấm là ô cuộn LỒNG trong ô cuộn
  // (người dùng kẹt giữa 2 thanh cuộn) — đó mới là ý định của bất biến này.
  chot(d.oCuon.long === 0, ten + ': không có ô cuộn LỒNG nhau (' + d.oCuon.tong + ' ô cuộn, ' + d.oCuon.long + ' lồng)');
  chot(!d.trangCuon, ten + ': TRANG không tự cuộn');
  return { ten, cuon: d.daCuon, tran: d.tranNay, top: d.tieuDeTop, cao: t.caoKhung };
}

// Chụp ảnh CHỊU ĐƯỢC chập chờn nhưng KHÔNG nuốt lỗi: đo thật thấy chụp màn Doanh Số bình thường ~3,1s
// (tắt animation ~1,3s) nhưng 13/11 có 2 lượt treo quá 20s — chưa chốt được nguyên nhân. Thử 2 lượt,
// hỏng CẢ HAI thì vẫn ĐỎ (cấm coi "không chụp được" là chuyện nhỏ — ảnh là bằng chứng của R200).
export async function chupAnh(p, duong, ten, chot) {
  for (let lan = 1; lan <= 2; lan++) {
    try {
      await p.screenshot({ path: duong, timeout: 30000, animations: 'disabled' });
      if (lan > 1) console.log('     (ảnh chụp được ở lượt thử ' + lan + ')');
      chot(true, ten + ': chụp được ảnh bằng chứng');
      return true;
    } catch (e) {
      if (lan === 2) { chot(false, ten + ': KHÔNG chụp được ảnh sau 2 lượt — ' + String(e.message).split(String.fromCharCode(10))[0].slice(0, 70)); return false; }
      await p.waitForTimeout(1500);
    }
  }
}
