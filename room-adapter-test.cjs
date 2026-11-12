'use strict';
/* adapter 端到端：建鱼 → 邀请 → 主人确认 → 群里说话 → 鱼回话 */
const BASE = 'http://127.0.0.1:8710';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const NODE = process.execPath;
const stamp = Date.now().toString(36);

async function api(p, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + p, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const t = await res.text();
  let d;
  try {
    d = JSON.parse(t);
  } catch {
    d = t;
  }
  return { status: res.status, data: d };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const owner = await api('/api/room/register', { method: 'POST', body: { name: 'O' + stamp, password: 'pass1234' } });
  const T = owner.data.token;
  const g = await api('/api/room/groups', { token: T, method: 'POST', body: { name: 'adapter群' + stamp } });
  const gid = g.data.group.id;
  const roomId = g.data.roomId;
  const bot = await api('/api/room/bots', { token: T, method: 'POST', body: { name: '小测鱼' } });
  const botToken = bot.data.token;
  const botId = bot.data.bot.id;

  const dir = path.join(__dirname, '_adapter-test');
  fs.mkdirSync(dir, { recursive: true });
  const cfg = {
    roomUrl: 'ws://127.0.0.1:8710/api/room/ws',
    botToken,
    llm: {
      baseUrl: 'https://ai.xtvacnl.cn/v1',
      apiKey: require('./data/config.json').apiKey,
      model: 'deepseek-v4.1-flash',
      systemPrompt: '你是一条叫小测鱼的鱼，回答不超过15个字。',
    },
    ownerQQ: '',
    onebotHttp: 'http://127.0.0.1:3000/',
    onebotToken: '',
    replyRooms: [roomId],
    contextMessages: 6,
  };
  fs.writeFileSync(path.join(dir, 'room-adapter.json'), JSON.stringify(cfg, null, 2), 'utf8');
  fs.copyFileSync(path.join(__dirname, 'room-adapter.cjs'), path.join(dir, 'room-adapter.cjs'));

  const child = spawn(NODE, ['room-adapter.cjs'], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d.toString()));
  child.stderr.on('data', (d) => (out += '[err] ' + d.toString()));

  await sleep(2500);
  console.log('--- 启动后 ---');
  console.log(out.trim());

  // 拉鱼进群 -> adapter 应收到 invite 并打印
  await api(`/api/room/groups/${gid}/bots`, { token: T, method: 'POST', body: { botId } });
  await sleep(1500);
  console.log('--- 收到邀请 ---');
  console.log(out.trim());

  // 从 /api/room/invites 取邀请（用 bot token 不行，得 owner）
  const me = await api('/api/room/me', { token: T });
  const inv = (me.data.invites || [])[0];
  console.log('邀请:', inv && inv.id, inv && inv.groupName);
  if (inv) {
    const r = await api('/api/room/invites/' + inv.id + '/respond', { token: T, method: 'POST', body: { approve: true } });
    console.log('确认结果:', r.status, JSON.stringify(r.data).slice(0, 120));
  }
  await sleep(1200);

  // 群里说话，等鱼回
  const before = out.length;
  await api('/api/room/messages', { token: T, method: 'POST', body: { room: roomId, text: '小测鱼，在吗' } });
  await sleep(9000);
  console.log('--- 说话之后 ---');
  console.log(out.slice(before).trim());

  const msgs = await api('/api/room/messages?room=' + encodeURIComponent(roomId), { token: T });
  console.log('--- 房间消息 ---');
  for (const m of msgs.data.messages || []) console.log(`[${m.kind}] ${m.senderName}: ${m.text}`);

  child.kill();
  await sleep(500);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
