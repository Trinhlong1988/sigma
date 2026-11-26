function backend(a, m) { const p = a * m; if (!Number.isSafeInteger(p)) { const A=BigInt(Math.round(a)),M=BigInt(Math.round(m)),D=100000n,n=A*M,q=n/D,r=n%D; return Number((r<0n?-r:r)*2n>=D?q+(n<0n?-1n:1n):q);} return Math.round(p/100000); }
const client = (t, p) => Math.round((t * p * 1000) / 100000);
console.log('=== A5d. ĐẾM số tiền bị lệch 1đ, dải 1.000đ → 60.000.000đ, bước 1.000đ (bill thật luôn chẵn nghìn) ===');
for (const p of [1.25,1.5,1.17,1.07,1.42,1.15,1.155,1.36,1.13,1.12,1.05]) {
  const m = Math.round(p*1000); let n=0; const vd=[];
  for (let a=1000;a<=60_000_000;a+=1000){ if(client(a,p)!==backend(a,m)){n++; if(vd.length<4)vd.push(a);} }
  console.log(`  pct ${p}%  → ${n} / 60.000 mức tiền bị lệch 1đ  ${n?('vd '+vd.join(', ')):''}`);
}
console.log('\n=== A5e. ví dụ TIỀN THẬT cỡ chục triệu bị lệch ===');
for (const p of [1.15,1.17,1.13,1.07]) { const m=Math.round(p*1000);
  for (let a=10_000_000;a<=60_000_000;a+=1000){ if(client(a,p)!==backend(a,m)){ console.log(`  pct ${p}% · lô ${a.toLocaleString('vi-VN')}đ → màn hiện phí ${client(a,p)}đ · server ghi ${backend(a,m)}đ · đại lý nhận lệch ${backend(a,m)-client(a,p)}đ`); break; } } }
