// In TÊN FIELD JSON của transaction/va (để dựng adapter đúng field). Creds qua ENV. KHÔNG in dữ liệu nhạy cảm (chỉ keys + 1 bản ghi rút gọn).
const email = process.env.DIGI_EMAIL, pass = process.env.DIGI_PASS;
if (!email || !pass) { console.error('THIEU DIGI_EMAIL/DIGI_PASS'); process.exit(1); }
(async () => {
  const lr = await fetch('https://api-outscope-pos.bvbank.net.vn/v1/portal/user/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: pass }) });
  const lj = await lr.json();
  const tok = lj?.data?.access_token;
  if (!tok) { console.log('LOGIN FAIL', JSON.stringify(lj).slice(0, 200)); return; }
  const url = 'https://api-outscope-pos.bvbank.net.vn/v1/portal/transaction/va?start_time=1788541201&end_time=1788700000&page=1&page_size=5&status=success';
  const r = await fetch(url, { headers: { authorization: 'Bearer ' + tok } });
  console.log('tx HTTP', r.status);
  const j = await r.json();
  console.log('TOP KEYS:', Object.keys(j));
  console.log('PAGE META:', JSON.stringify(Object.fromEntries(Object.entries(j).filter(([k]) => /page|total|count/i.test(k)))));
  const arr = j.data || j.items || j.list || [];
  console.log('SO GD:', Array.isArray(arr) ? arr.length : typeof arr);
  if (arr[0]) {
    console.log('FIELD NAMES:', Object.keys(arr[0]).join(', '));
    // 1 bản ghi để em biết kiểu dữ liệu từng field (số tiền số hay chuỗi, thời gian epoch hay ISO, mô tả chứa tên người quẹt).
    console.log('REC1:', JSON.stringify(arr[0]));
  } else console.log('BODY:', JSON.stringify(j).slice(0, 400));
})().catch((e) => console.log('ERR', String(e).slice(0, 160)));
