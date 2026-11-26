import pg from 'pg';
const { Client } = pg;
const ROOM = 'perftestroomZZZ01';
const N = 400;
const c = new Client({ connectionString: 'postgresql://postgres:<DIEN_VAO>@localhost:5432/sigma' });
await c.connect();
// clean any prior
await c.query('delete from chat_messages where room_id=$1', [ROOM]);
await c.query('delete from chat_room_members where room_id=$1', [ROOM]);
await c.query('delete from chat_rooms where id=$1', [ROOM]);
// create group room, member 384 only (avoid disturbing real users)
await c.query(
  `insert into chat_rooms (id,type,name,created_by,created_at,updated_at,read_only,require_approval)
   values ($1,'GROUP','PERF TEST (xoá sau)',384,now(),now(),false,false)`, [ROOM]);
await c.query(
  `insert into chat_room_members (room_id,agent_id,role) values ($1,384,'OWNER'),($1,270,'MEMBER')`, [ROOM]);
const samples = [
  'Chào anh, lô hàng hôm nay đã về đủ chưa ạ?',
  'Em vừa gửi bảng giá TID mới, anh xem giúp em nhé.',
  'Đối soát tháng này lệch khoảng 2 triệu, để em kiểm lại từng giao dịch.',
  'Ok anh, em xác nhận đã nhận đủ tiền chuyển khoản lúc 14:30.',
  'Khách bên Nam Hà báo máy POS lỗi kết nối, anh hỗ trợ giúp em với.',
  'Bảng kê chi tiết em để trong file đính kèm phía trên, anh tải về xem thử.',
  'Số dư còn lại của khách hàng này là 15.750.000đ tính đến cuối ngày.',
  'Em đã tạo nhóm riêng cho từng đại lý để tiện theo dõi công nợ hàng ngày.',
];
const CHUNK = 50;
let idx = 0;
const base = Date.now() - N * 60000;
for (let i = 0; i < N; i += CHUNK) {
  const vals = []; const params = []; let p = 1;
  for (let j = 0; j < CHUNK && i + j < N; j++) {
    const k = i + j;
    const sender = k % 3 === 0 ? 270 : 384;
    const body = samples[k % samples.length] + ' (#' + (k + 1) + ')';
    const ts = new Date(base + k * 60000).toISOString();
    vals.push(`($${p++},$${p++},$${p++},'TEXT',$${p++},$${p++})`);
    params.push('perftmsg' + String(k).padStart(4, '0'), ROOM, sender, body, ts);
  }
  await c.query(`insert into chat_messages (id,room_id,sender_id,kind,body,created_at) values ${vals.join(',')}`, params);
  idx += CHUNK;
}
await c.query('update chat_rooms set last_message_at=now() where id=$1', [ROOM]);
const cnt = await c.query('select count(*) n from chat_messages where room_id=$1', [ROOM]);
console.log('seeded room', ROOM, 'messages', cnt.rows[0].n);
await c.end();
