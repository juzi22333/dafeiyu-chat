'use strict';
/* 聊天室全链路冒烟测试（零依赖，node 直跑） */
const BASE = 'http://127.0.0.1:8710';

async function api(path, { token, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

function wsConnect(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:8710/api/room/ws?token=' + encodeURIComponent(token));
    const inbox = [];
    ws.addEventListener('message', (ev) => {
      try {
        inbox.push(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    });
    ws.addEventListener('open', () => resolve({ ws, inbox }));
    ws.addEventListener('error', () => reject(new Error('ws error')));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 账号规则要求纯数字 5 位以上，测试账号也用数字
const stamp = String(Date.now()).slice(-7);
const ACC = { a: '1' + stamp, b: '2' + stamp, c: '3' + stamp };

(async () => {
  const out = [];
  const ok = (k, v) => out.push(`${v ? 'PASS' : 'FAIL'} ${k}`);

  // 1 注册两个用户
  const a = await api('/api/room/register', { method: 'POST', body: { name: ACC.a, password: 'pass1234' } });
  ok('注册A', a.status === 200 && !!a.data.token);
  const b = await api('/api/room/register', { method: 'POST', body: { name: ACC.b, password: 'pass1234' } });
  ok('注册B', b.status === 200 && !!b.data.token);
  const A = a.data.token;
  const B = b.data.token;

  // 2 重名冲突
  const dup = await api('/api/room/register', { method: 'POST', body: { name: ACC.a, password: 'pass1234' } });
  ok('重名409', dup.status === 409);

  // 3 登录
  const login = await api('/api/room/login', { method: 'POST', body: { name: ACC.a, password: 'pass1234' } });
  ok('登录', login.status === 200 && !!login.data.token);

  // 4 未登录被拒
  const noauth = await api('/api/room/me');
  ok('未登录401', noauth.status === 401);

  // 5 加好友
  const fr = await api('/api/room/friends', { token: A, method: 'POST', body: { name: ACC.b } });
  ok('好友申请', fr.status === 200 && fr.data.pending);
  const meB = await api('/api/room/me', { token: B });
  const reqId = (meB.data.incoming || [])[0] && meB.data.incoming[0].id;
  ok('B收到申请', !!reqId);
  const acc = await api('/api/room/friends/respond', { token: B, method: 'POST', body: { id: reqId, accept: true } });
  ok('B同意好友', acc.status === 200);
  const meA = await api('/api/room/me', { token: A });
  const dm = (meA.data.rooms || []).find((r) => r.type === 'dm');
  ok('A看到私聊房间', !!dm);

  // 6 私聊发消息
  const m1 = await api('/api/room/messages', { token: A, method: 'POST', body: { room: dm.roomId, text: '你好B' } });
  ok('私聊发送', m1.status === 200 && m1.data.message.text === '你好B');
  const read1 = await api('/api/room/messages?room=' + encodeURIComponent(dm.roomId), { token: B });
  ok('B能读到', read1.status === 200 && read1.data.messages.length === 1);

  // 7 非成员不能读
  const c = await api('/api/room/register', { method: 'POST', body: { name: ACC.c, password: 'pass1234' } });
  const forbidden = await api('/api/room/messages?room=' + encodeURIComponent(dm.roomId), { token: c.data.token });
  ok('非成员403', forbidden.status === 403);

  // 8 建群
  const g = await api('/api/room/groups', { token: A, method: 'POST', body: { name: '测试群' + stamp } });
  ok('建群', g.status === 200 && !!g.data.roomId);
  const gid = g.data.group.id;
  const roomId = g.data.roomId;

  // 9 拉人
  const add = await api(`/api/room/groups/${gid}/members`, { token: A, method: 'POST', body: { name: ACC.b } });
  ok('拉人进群', add.status === 200);

  // 10 建鱼
  const bot = await api('/api/room/bots', { token: A, method: 'POST', body: { name: '测试鱼' } });
  ok('建鱼', bot.status === 200 && !!bot.data.token);
  const botToken = bot.data.token;
  const botId = bot.data.bot.id;

  // 11 鱼连 WS
  const conn = await wsConnect(botToken);
  await sleep(300);
  const hello = conn.inbox.find((m) => m.type === 'hello');
  ok('WS hello', !!hello && hello.bot.id === botId);

  // 12 拉鱼进群 -> 鱼收到 invite
  const inv = await api(`/api/room/groups/${gid}/bots`, { token: A, method: 'POST', body: { botId } });
  ok('拉鱼发邀请', inv.status === 200 && inv.data.pending);
  await sleep(300);
  const invite = conn.inbox.find((m) => m.type === 'invite');
  ok('鱼收到invite', !!invite && invite.invite.groupName === '测试群' + stamp);

  // 13 鱼不在群里发消息应被拒
  const early = conn.inbox.length;
  conn.ws.send(JSON.stringify({ type: 'send', roomId, text: '还没进群就说话' }));
  await sleep(300);
  const errFrame = conn.inbox.slice(early).find((m) => m.type === 'error');
  ok('未入群发消息被拒', !!errFrame);

  // 14 主人确认 -> 鱼收到 joined
  const before = conn.inbox.length;
  conn.ws.send(JSON.stringify({ type: 'confirm-invite', inviteId: invite.invite.id, approve: true }));
  await sleep(400);
  const joined = conn.inbox.slice(before).find((m) => m.type === 'joined' || m.type === 'confirm-result');
  ok('确认后鱼入群', !!joined);

  // 15 用户发群消息 -> 鱼收到
  const before2 = conn.inbox.length;
  const gm = await api('/api/room/messages', { token: A, method: 'POST', body: { room: roomId, text: '鱼你在吗' } });
  ok('群消息发送', gm.status === 200);
  await sleep(400);
  const pushed = conn.inbox.slice(before2).find((m) => m.type === 'message' && m.message.text === '鱼你在吗');
  ok('鱼收到群消息', !!pushed);

  // 16 鱼发言 -> 写进房间
  conn.ws.send(JSON.stringify({ type: 'send', roomId, text: '在的' }));
  await sleep(400);
  const after = await api('/api/room/messages?room=' + encodeURIComponent(roomId), { token: B });
  const botMsg = (after.data.messages || []).find((m) => m.kind === 'bot' && m.text === '在的');
  ok('鱼发言入库', !!botMsg);
  ok('系统消息入群', (after.data.messages || []).some((m) => m.kind === 'system' && m.text.includes('进群了')));

  // 17 邀请过期/重复处理
  const again = await api(`/api/room/groups/${gid}/bots`, { token: A, method: 'POST', body: { botId } });
  ok('已入群再拉是already', again.status === 200 && again.data.already);

  // 18 history 帧
  const before3 = conn.inbox.length;
  conn.ws.send(JSON.stringify({ type: 'history', roomId, limit: 10 }));
  await sleep(400);
  const hist = conn.inbox.slice(before3).find((m) => m.type === 'history');
  ok('鱼能拉历史', !!hist && hist.messages.length > 0);

  // 19 ping/pong
  const before4 = conn.inbox.length;
  conn.ws.send(JSON.stringify({ type: 'ping' }));
  await sleep(300);
  ok('ping/pong', !!conn.inbox.slice(before4).find((m) => m.type === 'pong'));

  // 20 错误 token 连不上
  let badRejected = false;
  try {
    await wsConnect('bad-token-xxx');
  } catch {
    badRejected = true;
  }
  ok('错token被拒', badRejected);

  conn.ws.close();
  console.log(out.join('\n'));
  const fails = out.filter((l) => l.startsWith('FAIL'));
  console.log(`\n${out.length - fails.length}/${out.length} passed`);
  process.exit(fails.length ? 1 : 0);
})().catch((err) => {
  console.error('测试崩了:', err);
  process.exit(2);
});
