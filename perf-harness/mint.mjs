import pg from 'pg';
import crypto from 'node:crypto';
const { Client } = pg;
const agentId = Number(process.argv[2] || 384);
const uname = process.argv[3] || 'thiendi';
const sid = crypto.randomBytes(24).toString('base64url');
const c = new Client({ connectionString: 'postgresql://postgres:<DIEN_VAO>@localhost:5432/sigma' });
await c.connect();
await c.query(
  `INSERT INTO web_sessions (id,agent_id,rc_user_id,rc_username,expires_at) VALUES ($1,$2,null,$3,now()+interval '3 hour')`,
  [sid, agentId, uname]
);
await c.end();
console.log(sid);
