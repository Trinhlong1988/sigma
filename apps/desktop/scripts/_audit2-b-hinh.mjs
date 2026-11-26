// AUDIT2-B — HÌNH HỌC: ma trận bề ngang 1920/1600/1440/1280/1279/1150 · bề ngang TỪNG cột · cỡ chữ cột số
// · cắt chữ · cuộn ngang + tiêu đề ghim + hàng TỔNG ghim · thanh cuộn 16px · 7 nút 119px · 5 ô KPI căn giữa.
// ĐO SỐ THẬT từ DOM + chụp ảnh. CHỈ ĐỌC trang 57912.
import { moTrang, anh, docBang, docKpi, finding, ok, FINDINGS } from './_audit2-lib.mjs';

const MA_TRAN = [1920, 1600, 1440, 1280, 1279, 1150];

// Bề ngang CHỐT theo lệnh 6/11 (đề bài giao việc).
const SPEC = {
  TID: 101, HKD: 214, 'Lô': 85, 'Số HĐ': 84, 'Đại lý': 122, Ca: 58, 'Ngày': 68,
  'Trước phí': 130, 'Sau phí bán': 130, 'Đã hoàn': 130, '% CM': 84, '% Bán': 84
};
const COT_SO = ['Ngày', 'Giờ', 'Ca', '% CM', 'Lô', 'Số HĐ', 'Trước phí', '% Bán', 'Sau phí bán', 'Đã hoàn'];

async function doMotBeNgang(w) {
  const { browser, page, log } = await moTrang(w, 900);
  console.log(`\n── bề ngang ${w}px ─────────────────────────────────────────────`);
  // mở toàn kỳ cho bảng dài (cần để thử cuộn)
  await page.locator('input[aria-label="Từ ngày"]').fill('2026-01-01');
  await page.locator('input[aria-label="Đến ngày"]').fill('2026-12-31');
  await page.waitForTimeout(300);

  const d = await page.evaluate(() => {
    const k = document.querySelector('[data-kiem="khung-bang"]');
    const t = k.querySelector('table');
    const ths = [...t.querySelectorAll('thead th')];
    const cot = ths.map((x) => {
      const cs = getComputedStyle(x);
      return {
        ten: (x.textContent || '').trim(),
        rong: +x.getBoundingClientRect().width.toFixed(2),
        chu: cs.fontSize, dam: cs.fontWeight, mau: cs.color, canh: cs.textAlign
      };
    });
    // cột DỮ LIỆU (dòng đầu) để đo cỡ chữ/độ đậm/màu/căn
    const tr = [...t.querySelectorAll('tbody tr')].find((r) => r.querySelectorAll('td').length > 3);
    const o = [...tr.querySelectorAll('td')].map((x, i) => {
      const cs = getComputedStyle(x);
      return {
        i, ten: cot[i]?.ten ?? '?', text: (x.textContent || '').trim(),
        rong: +x.getBoundingClientRect().width.toFixed(2),
        chu: cs.fontSize, dam: cs.fontWeight, mau: cs.color, canh: cs.textAlign,
        tranChu: x.scrollWidth - x.clientWidth,
        overflow: cs.overflow
      };
    });
    // MỌI ô bảng: ô nào nội dung rộng hơn ô (bị cắt / bị đẩy)
    const traiKhung = k.getBoundingClientRect().left;
    const catChu = [];
    for (const td of t.querySelectorAll('tbody td, tfoot td, thead th')) {
      const sw = td.scrollWidth, cw = td.clientWidth;
      if (sw > cw + 0.5) catChu.push({ text: (td.textContent || '').trim().slice(0, 40), sw, cw, thua: sw - cw });
      // .truncate con bên trong
      for (const sp of td.querySelectorAll('.truncate')) if (sp.scrollWidth > sp.clientWidth + 0.5)
        catChu.push({ text: (sp.textContent || '').trim().slice(0, 40), sw: sp.scrollWidth, cw: sp.clientWidth, thua: sp.scrollWidth - sp.clientWidth, con: true });
    }
    const tf = [...t.querySelectorAll('tfoot td')].map((x) => ({
      text: (x.textContent || '').trim(), colSpan: x.colSpan,
      trai: +(x.getBoundingClientRect().left - traiKhung).toFixed(2),
      rong: +x.getBoundingClientRect().width.toFixed(2)
    }));
    return {
      rongKhung: +k.getBoundingClientRect().width.toFixed(2),
      caoKhung: k.clientHeight,
      offsetH: k.offsetHeight,
      scrollW: k.scrollWidth, clientW: k.clientWidth,
      scrollH: k.scrollHeight,
      caoThanhCuonNgang: k.offsetHeight - k.clientHeight,
      rongThanhCuonDoc: k.offsetWidth - k.clientWidth,
      rongBang: +t.getBoundingClientRect().width.toFixed(2),
      minWidth: getComputedStyle(t).minWidth,
      soCot: cot.length,
      cot, o, catChu, tf,
      cuonDocTrang: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      tranNgangTrang: document.documentElement.scrollWidth - document.documentElement.clientWidth
    };
  });

  console.log(`  khung ${d.rongKhung}px · bảng ${d.rongBang}px (min-width khai ${d.minWidth}) · cuộn ngang trong khung ${d.scrollW - d.clientW}px`);
  console.log(`  thanh cuộn NGANG cao ${d.caoThanhCuonNgang}px · thanh cuộn DỌC rộng ${d.rongThanhCuonDoc}px`);
  console.log(`  trang: cuộn dọc ${d.cuonDocTrang}px · tràn ngang ${d.tranNgangTrang}px`);
  console.log('  bề ngang cột:', d.cot.map((c) => `${c.ten}=${c.rong}`).join(' · '));

  // 1) min-width khai báo
  if (w === 1920) {
    const mw = parseFloat(d.minWidth);
    if (Math.abs(mw - 2020) > 1)
      finding('NHẸ', 'B-MINW', 'Bề ngang tối thiểu bảng KHÔNG phải 2020px như chốt — mã khai min-w-[2142px] (BillManualEntryPage.tsx:1332)', `min-width thật = ${d.minWidth} (chốt 2020px) · lệch ${(mw - 2020).toFixed(0)}px`);
    // tổng bề ngang khai báo của 21 cột so với min-width → auto-layout DÃN cột
    const tongKhai = 32 + 66 + 64 + 56 + 119 + 98 + 208 + 66 + 72 + 82 + 83 + 82 + 126 + 82 + 126 + 126 + 122 + 86 + 130 + 110 + 150;
    finding('VỪA', 'B-DAN-COT', 'Tổng bề ngang KHAI BÁO của 21 cột (' + tongKhai + 'px + viền) NHỎ HƠN min-width bảng (' + d.minWidth + ') ⇒ bảng auto-layout DÃN mọi cột theo tỉ lệ: bề ngang thật KHÁC class w-[…] nên không thể khoá bằng class (BillManualEntryPage.tsx:1332-1360)', `khai ${tongKhai}px + 20 viền = ${tongKhai + 20}px vs min-width ${d.minWidth} → dãn ${(((parseFloat(d.minWidth) - tongKhai - 20) / (tongKhai + 20)) * 100).toFixed(2)}%; vd TID khai 98px đo thật ${d.cot.find((c) => c.ten === 'TID').rong}px`);
  }

  // 2) SPEC bề ngang từng cột
  const lechSpec = [];
  for (const [ten, mong] of Object.entries(SPEC)) {
    const c = d.cot.find((x) => x.ten === ten);
    if (!c) { lechSpec.push(`${ten}: KHÔNG THẤY cột`); continue; }
    if (Math.abs(c.rong - mong) > 1.5) lechSpec.push(`${ten}=${c.rong} (chốt ${mong}, lệch ${(c.rong - mong).toFixed(1)})`);
  }
  if (lechSpec.length) finding('VỪA', 'B-SPEC-COT@' + w, 'Bề ngang cột lệch số đã chốt', lechSpec.join(' · '));
  else ok('B-SPEC-COT@' + w, 'Bề ngang 12 cột chốt đúng (±1,5px)', Object.keys(SPEC).length + ' cột');

  // 3) 3 cột TIỀN bằng nhau · 2 cột % bằng nhau + GIỐNG HẲN
  const g = (n) => d.cot.find((x) => x.ten === n);
  const tien = ['Trước phí', 'Sau phí bán', 'Đã hoàn'].map(g);
  if (new Set(tien.map((x) => x.rong.toFixed(1))).size !== 1)
    finding('VỪA', 'B-TIEN-BANG@' + w, '3 cột tiền KHÔNG bằng nhau', tien.map((x) => `${x.ten}=${x.rong}`).join(' · '));
  else ok('B-TIEN-BANG@' + w, '3 cột tiền bằng nhau', tien[0].rong + 'px');
  const pcm = d.o.find((x) => x.ten === '% CM'), pban = d.o.find((x) => x.ten === '% Bán');
  const khacNhau = ['rong', 'chu', 'dam', 'mau', 'canh'].filter((k) => String(pcm[k]) !== String(pban[k]));
  if (khacNhau.length) finding('VỪA', 'B-PCT-GIONG@' + w, '% CM và % Bán KHÔNG giống hẳn nhau', khacNhau.map((k) => `${k}: ${pcm[k]} vs ${pban[k]}`).join(' · '));
  else ok('B-PCT-GIONG@' + w, '% CM ≡ % Bán (bề ngang/cỡ chữ/độ đậm/màu/căn)', `${pcm.rong}px · ${pcm.chu} · ${pcm.dam} · ${pcm.mau} · ${pcm.canh}`);

  // 4) Cỡ chữ MỌI cột số = 12px
  const saiChu = d.o.filter((x) => COT_SO.includes(x.ten) && x.chu !== '12px').map((x) => `${x.ten}=${x.chu}`);
  if (saiChu.length) finding('VỪA', 'B-CHU12@' + w, 'Cột số có cỡ chữ khác 12px', saiChu.join(' · '));
  else ok('B-CHU12@' + w, 'Mọi cột số cỡ chữ 12px', COT_SO.length + ' cột');

  // 5) CẮT CHỮ / TRÀN Ô
  if (d.catChu.length) {
    finding('NẶNG', 'B-CAT-CHU@' + w, 'Có ô bảng bị CẮT mất chữ/số (nội dung rộng hơn ô)', d.catChu.slice(0, 8).map((x) => `"${x.text}" thiếu ${x.thua}px (${x.cw}→${x.sw})`).join(' · '));
  } else ok('B-CAT-CHU@' + w, 'Không ô nào bị cắt chữ', 'quét toàn bộ thead+tbody+tfoot');

  // 6) Trang KHÔNG được cuộn dọc / tràn ngang
  if (d.cuonDocTrang > 0 || d.tranNgangTrang > 0)
    finding('VỪA', 'B-TRANG@' + w, 'Trang bị cuộn dọc hoặc tràn ngang (lệnh: gọn 1 trang)', `cuộn dọc ${d.cuonDocTrang}px · tràn ngang ${d.tranNgangTrang}px`);
  else ok('B-TRANG@' + w, 'Trang không cuộn dọc, không tràn ngang', '0px / 0px');

  // 7) Thanh cuộn ngang khai 16px
  if (d.caoThanhCuonNgang > 0 && Math.abs(d.caoThanhCuonNgang - 16) > 1)
    finding('NHẸ', 'B-SCROLLBAR@' + w, 'Thanh cuộn ngang không cao 16px như khai', `đo ${d.caoThanhCuonNgang}px`);
  else ok('B-SCROLLBAR@' + w, 'Thanh cuộn ngang đúng ~16px', d.caoThanhCuonNgang + 'px');

  // 8) HÀNG TỔNG — khớp cột? (so mép trái của ô tiền TỔNG với mép trái cột tương ứng)
  const mepCot = {};
  let x = 0;
  for (const c of d.cot) { mepCot[c.ten] = x; x += c.rong; }
  const tfTien = d.tf.filter((f) => /\d/.test(f.text) && !/TỔNG/.test(f.text));
  const lechTong = [];
  const canhTong = [['Trước phí', 0], ['Sau phí bán', 1], ['Đã hoàn', 2]];
  canhTong.forEach(([ten, idx]) => {
    const f = tfTien[idx];
    if (!f) { lechTong.push(`${ten}: thiếu ô TỔNG`); return; }
    if (Math.abs(f.rong - g(ten).rong) > 1.5) lechTong.push(`${ten}: ô TỔNG rộng ${f.rong} vs cột ${g(ten).rong}`);
  });
  if (lechTong.length) finding('NẶNG', 'B-TONG-COT@' + w, 'Ô hàng TỔNG không khớp bề ngang cột dữ liệu', lechTong.join(' · '));
  else ok('B-TONG-COT@' + w, 'Ô tiền hàng TỔNG khớp bề ngang 3 cột tiền', tfTien.map((f) => f.rong).join('/'));

  // 9) CUỘN NGANG tới mép phải + kiểm tiêu đề ghim / TỔNG ghim
  await page.evaluate(() => { const k = document.querySelector('[data-kiem="khung-bang"]'); k.scrollLeft = k.scrollWidth; });
  await page.waitForTimeout(250);
  const sauPhai = await page.evaluate(() => {
    const k = document.querySelector('[data-kiem="khung-bang"]');
    const kr = k.getBoundingClientRect();
    const th = [...k.querySelectorAll('thead th')].map((x) => +(x.getBoundingClientRect().left - kr.left).toFixed(1));
    const tdd = [...[...k.querySelectorAll('tbody tr')].find((r) => r.querySelectorAll('td').length > 3).querySelectorAll('td')].map((x) => +(x.getBoundingClientRect().left - kr.left).toFixed(1));
    const tf = [...k.querySelectorAll('tfoot td')].map((x) => +(x.getBoundingClientRect().left - kr.left).toFixed(1));
    return { scrollLeft: k.scrollLeft, th, tdd, tf, lechThTd: th.map((v, i) => +(v - tdd[i]).toFixed(1)).filter((v) => Math.abs(v) > 0.6) };
  });
  console.log(`  cuộn hết phải (scrollLeft=${sauPhai.scrollLeft}) · lệch th↔td: ${JSON.stringify(sauPhai.lechThTd)}`);
  if (sauPhai.lechThTd.length) finding('NẶNG', 'B-LECH-NGANG@' + w, 'Khi cuộn hết sang phải, tiêu đề ghim LỆCH cột so với dòng dữ liệu', JSON.stringify(sauPhai.lechThTd));
  else ok('B-LECH-NGANG@' + w, 'Cuộn hết phải: tiêu đề ghim thẳng cột với dữ liệu', '21/21 cột lệch ≤0,6px');
  await anh(page, `B-${w}-cuon-phai.png`);

  // 10) CUỘN XUỐNG ĐÁY — hàng TỔNG ghim có CHE dòng cuối không
  await page.evaluate(() => { const k = document.querySelector('[data-kiem="khung-bang"]'); k.scrollLeft = 0; k.scrollTop = k.scrollHeight; });
  await page.waitForTimeout(300);
  const day = await page.evaluate(() => {
    const k = document.querySelector('[data-kiem="khung-bang"]');
    const kr = k.getBoundingClientRect();
    const rows = [...k.querySelectorAll('tbody tr')].filter((r) => r.querySelectorAll('td').length > 3);
    const cuoi = rows[rows.length - 1].getBoundingClientRect();
    const tf = k.querySelector('tfoot tr').getBoundingClientRect();
    return {
      scrollTop: k.scrollTop, maxTop: k.scrollHeight - k.clientHeight,
      dongCuoiDuoi: +cuoi.bottom.toFixed(1), tongTren: +tf.top.toFixed(1),
      cheMatPx: +(cuoi.bottom - tf.top).toFixed(1),
      caoDong: +cuoi.height.toFixed(1), caoTong: +tf.height.toFixed(1)
    };
  });
  console.log(`  cuộn đáy: scrollTop ${day.scrollTop}/${day.maxTop} · dòng cuối đáy ${day.dongCuoiDuoi} · TỔNG ghim đỉnh ${day.tongTren} · CHE ${day.cheMatPx}px`);
  if (day.cheMatPx > 1)
    finding('NẶNG', 'B-TONG-CHE@' + w, 'Hàng TỔNG ghim CHE mất dòng dữ liệu cuối khi cuộn tới đáy', `che ${day.cheMatPx}px trên dòng cao ${day.caoDong}px (hàng đệm h-9=36px không đủ: hàng TỔNG cao ${day.caoTong}px)`);
  else ok('B-TONG-CHE@' + w, 'Hàng TỔNG ghim không che dòng cuối', `khoảng cách ${(-day.cheMatPx).toFixed(1)}px`);
  await anh(page, `B-${w}-cuon-day.png`);

  // 11) 7 NÚT thanh công cụ 119px + 5 ô KPI căn giữa
  const nut = await page.evaluate(() => [...document.querySelectorAll('[data-nut]')].map((b) => ({
    nut: b.getAttribute('data-nut'), text: (b.textContent || '').trim(),
    rong: +b.getBoundingClientRect().width.toFixed(2), cao: +b.getBoundingClientRect().height.toFixed(2)
  })));
  console.log('  nút:', nut.map((n) => `${n.nut}=${n.rong}`).join(' · '));
  const sai119 = nut.filter((n) => Math.abs(n.rong - 119) > 1).map((n) => `${n.nut}=${n.rong}`);
  if (sai119.length) finding('NHẸ', 'B-NUT119@' + w, 'Nút thanh công cụ không đều 119px', `${nut.length} nút · lệch: ${sai119.join(' · ')}`);
  else ok('B-NUT119@' + w, `${nut.length} nút đều 119px`, nut.map((n) => n.nut).join(','));

  const kpi = await docKpi(page);
  const saiKpi = kpi.filter((k) => k.textAlign !== 'center').map((k) => `${k.nhan}=${k.textAlign}`);
  console.log('  KPI:', kpi.map((k) => `${k.nhan}[${k.rong}px,${k.textAlign}]`).join(' · '));
  if (kpi.length !== 5) finding('NHẸ', 'B-KPI-SO@' + w, 'Số ô KPI không phải 5', `${kpi.length} ô`);
  if (saiKpi.length) finding('NHẸ', 'B-KPI-CANH@' + w, 'Ô KPI không căn giữa', saiKpi.join(' · '));
  else ok('B-KPI-CANH@' + w, '5 ô KPI căn giữa', kpi.map((k) => k.rong).join('/') + 'px');

  const loi = log.filter((x) => x.type === 'error' || x.type === 'pageerror');
  if (loi.length) finding('NẶNG', 'B-CONSOLE@' + w, 'Lỗi console khi đo hình học', loi.slice(0, 2).map((x) => x.text.slice(0, 150)).join(' | '));

  await browser.close();
  return d;
}

console.log('=== AUDIT2-B · HÌNH HỌC MA TRẬN BỀ NGANG ===');
const bang = {};
for (const w of MA_TRAN) bang[w] = await doMotBeNgang(w);

// 12) 20 CỘT CỐ ĐỊNH Ở MỌI BỀ NGANG
console.log('\n── 20 cột cố định ở mọi bề ngang ──');
const soCot = Object.entries(bang).map(([w, d]) => `${w}:${d.soCot}`);
console.log('  số cột:', soCot.join(' · '));
if (new Set(Object.values(bang).map((d) => d.soCot)).size !== 1)
  finding('NẶNG', 'B-SOCOT', 'Số cột ĐỔI theo bề ngang', soCot.join(' · '));
else ok('B-SOCOT', 'Số cột cố định ở mọi bề ngang', soCot.join(' · ') + ' (1 ô tích + 20 cột dữ liệu)');

// 13) Bề ngang cột có GIỐNG NHAU ở mọi bề ngang?
const base = bang[1920].cot.map((c) => c.rong.toFixed(1)).join(',');
const lechBn = Object.entries(bang).filter(([, d]) => d.cot.map((c) => c.rong.toFixed(1)).join(',') !== base).map(([w]) => w);
if (lechBn.length) finding('NHẸ', 'B-COT-DOI', 'Bề ngang cột đổi theo bề ngang màn', `khác 1920 ở: ${lechBn.join(', ')}`);
else ok('B-COT-DOI', 'Bề ngang cột y nguyên ở cả 6 bề ngang', MA_TRAN.join('/'));

console.log(`\n=== AUDIT2-B xong · ${FINDINGS.length} finding ===`);
