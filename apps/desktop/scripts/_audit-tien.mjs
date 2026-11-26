// AUDIT A — so CÔNG THỨC TIỀN của client (BillManualEntryPage) với backend marginToAmount thật.
// client:  Math.round((tienLo * pct * 1000) / 100000)
// backend: marginToAmount(amount, pctMilli)  (pctMilli = số NGUYÊN milli%)
function backend(amount, marginMilli) {
  if (!Number.isFinite(amount) || amount < 0) return 0;
  if (!Number.isFinite(marginMilli)) return 0;
  const prod = amount * marginMilli;
  if (!Number.isSafeInteger(prod)) {
    const a = BigInt(Math.round(amount)), m = BigInt(Math.round(marginMilli)), D = 100000n;
    const num = a * m; const q = num / D, r = num % D;
    const rounded = (r < 0n ? -r : r) * 2n >= D ? q + (num < 0n ? -1n : 1n) : q;
    return Number(rounded);
  }
  return Math.round(prod / 100000);
}
const client = (tienLo, pct) => Math.round((tienLo * pct * 1000) / 100000);

const PCTS = [1.25, 1.5, 1.17, 1.07, 1.42, 1.15, 1.155, 1.36, 1.13, 1.12, 1.05, 0.92, 1.02, 1.08, 1.1, 0.1];
console.log('=== A5a. quét lệch giữa client và backend (bước 1.000đ, 0 → 2 tỷ) ===');
let lech = [];
for (const p of PCTS) {
  const milli = Math.round(p * 1000);
  for (let a = 0; a <= 2_000_000_000; a += 1000) {
    const c = client(a, p), b = backend(a, milli);
    if (c !== b) { lech.push({ pct: p, amount: a, client: c, backend: b, delta: c - b }); break; }
  }
}
console.log(lech.length ? JSON.stringify(lech, null, 1) : '  → 0 lệch trong dải 0..2 tỷ bước 1.000đ');

console.log('\n=== A5b. quét bước 1đ quanh mốc .5 (0 → 50 triệu) ===');
let l2 = [];
for (const p of PCTS) {
  const milli = Math.round(p * 1000);
  for (let a = 0; a <= 50_000_000; a += 1) {
    const c = client(a, p), b = backend(a, milli);
    if (c !== b) { l2.push({ pct: p, amount: a, client: c, backend: b }); break; }
  }
}
console.log(l2.length ? JSON.stringify(l2, null, 1) : '  → 0 lệch trong dải 0..50tr bước 1đ');

console.log('\n=== A5c. SỐ CỰC LỚN (nghìn tỷ) — client KHÔNG có nhánh BigInt ===');
for (const a of [1e12, 1e13, 1e14, 9007199254740993, 99_999_999_999_999]) {
  for (const p of [1.15, 1.42]) {
    const c = client(a, p), b = backend(a, Math.round(p * 1000));
    console.log(`  amount=${a} pct=${p}%  client=${c}  backend=${b}  LỆCH=${c - b}đ`);
  }
}

console.log('\n=== A3. Number() trên chuỗi chữ số dài — mất độ chính xác TRƯỚC khi vào công thức ===');
for (const s of ['9007199254740993', '12345678901234567', '99999999999999999999']) {
  const n = Number(s);
  console.log(`  gõ "${s}" → Number=${n} · isInteger=${Number.isInteger(n)} · isSafeInteger=${Number.isSafeInteger(n)} · in lại="${n.toString()}" · LỆCH=${BigInt(s) - BigInt(n)}`);
}

console.log('\n=== A6. SỐ LÔ / SỐ HÓA ĐƠN có 0 dẫn đầu: khóa bill XEM TRƯỚC vs payload ===');
const loHienThi = (lo, ma) => { const b = lo.trim(); const sc = ma.replace(/[^0-9]/g, ''); return b ? (sc ? b + '(' + sc + ')' : b) : ''; };
for (const [lo, hd] of [['0021', '000777'], ['21', '000118'], ['0084', '0']]) {
  const keyXem = ['nat', 'DEMO-TID-03', loHienThi(lo, '').toLowerCase(), hd.toLowerCase()].join('|');
  const keyServer = ['nat', 'DEMO-TID-03', String(Number(lo)), String(Number(hd))].join('|');
  console.log(`  lô="${lo}" sốHĐ="${hd}"`);
  console.log(`     khóa HIỆN TRÊN MÀN : ${keyXem}`);
  console.log(`     payload gửi server : bankReportedLoNumber=${Number(lo)} · receiptNumber=${Number(hd)} → khóa server ≈ ${keyServer}`);
  console.log(`     ${keyXem === keyServer ? 'KHỚP' : '*** LỆCH KHÓA ***'}`);
}
