'use strict';
/**
 * 聊天室 · 极简接入器（零依赖，只要两样东西）
 *
 *   node room-lite.cjs --url ws://dafeiyu.juzivpn.xyz/api/room/ws --token <鱼的凭证>
 *
 * 它不做任何模型调用——有人说话就 POST 回站里的 /api/room/reply，
 * 站里用角色卡 + 记忆 + 模型生成回复，它负责把回复发进房间。
 * 所以不需要 API Key，也不用管角色卡放哪。
 *
 * 可选：--owner <QQ号> --onebot http://127.0.0.1:3000/ --onebot-token <token>
 *       有这三个才会在有人拉鱼进群时私聊主人确认。
 */

const args = process.argv.slice(2);
function arg(name, fallback) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}

const ROOM_URL = arg('url', 'ws://127.0.0.1:8710/api/room/ws');
const BOT_TOKEN = arg('token', '');
const OWNER_QQ = arg('owner', '');
const ONEBOT = arg('onebot', 'http://127.0.0.1:3000/');
const ONEBOT_TOKEN = arg('onebot-token', '');
// 想让这条鱼用本机 DSH 当脑子（有上下文、有记忆、有联网），加 --dsh 就行；
// 不加、或者本机没跑 DSH，就还是回站里代答，行为跟以前一样。
const DSH_ON = args.includes('--dsh') || process.env.ROOM_DSH === '1';
const DSH_URL = arg('dsh-url', process.env.DSH_BASE_URL || 'http://127.0.0.1:50390');
const DSH_PRESET = arg('dsh-preset', process.env.DSH_ROOM_PRESET || 'qq-chat');

if (!BOT_TOKEN) {
  console.error('缺 --token，去 /bots 页面复制这条鱼的凭证');
  process.exit(1);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ws://host/path?token=  →  http://host/api/room/reply
function httpBase() {
  const u = new URL(ROOM_URL);
  const proto = u.protocol === 'wss:' ? 'https:' : 'http:';
  return proto + '//' + u.host;
}

let ws = null;
let retry = 0;
let closed = false;
let pingTimer = null;
const busy = new Set(); // 正在生成回复的房间，别叠着问

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// 公网 WebSocket 空闲会被掐（Cloudflare 约 100 秒），定期 ping 保住连接
function startPing() {
  stopPing();
  pingTimer = setInterval(() => send({ type: 'ping', at: Date.now() }), 25000);
  if (pingTimer.unref) pingTimer.unref();
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

// 让鱼用自己的 DSH 当脑子：一个房间一个会话，所以它有上下文、记得住前面聊的
let dshBrain = null;
function brainClient() {
  if (dshBrain) return dshBrain;
  const { DshBrain } = require('./dsh-brain.js');
  dshBrain = new DshBrain(DSH_URL, DSH_PRESET);
  return dshBrain;
}

async function askDsh(roomId, msg) {
  const line = `${msg.senderName || '有人'}：${msg.text}`;
  try {
    const out = await brainClient().ask(roomId, line, { timeoutMs: 150000 });
    if (out && out.trim()) return out.trim();
  } catch (err) {
    log('DSH 没接上，改问站里:', err.message);
  }
  return askStation(roomId, line);
}

async function askStation(roomId, text) {
  const res = await fetch(httpBase() + '/api/room/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + BOT_TOKEN },
    body: JSON.stringify({ room: roomId, text }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || 'HTTP ' + res.status);
  return String(data.text || '');
}

async function onebot(action, params) {
  const res = await fetch(ONEBOT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(ONEBOT_TOKEN ? { Authorization: 'Bearer ' + ONEBOT_TOKEN } : {}),
    },
    body: JSON.stringify({ action, params }),
  });
  const data = await res.json();
  if (data.retcode !== 0) throw new Error(data.wording || 'OneBot 失败');
  return data.data;
}

const pendingInvites = new Map();

async function onInvite(invite) {
  pendingInvites.set(invite.id, invite);
  const text = `${invite.invitedBy} 想拉我进「${invite.groupName}」，进不进？回「进」或「不进」`;
  if (!OWNER_QQ) {
    log(text);
    return;
  }
  try {
    await onebot('send_private_msg', { user_id: Number(OWNER_QQ), message: text });
    log('已私聊主人确认:', invite.groupName);
  } catch (err) {
    log('私聊主人失败:', err.message, '|', text);
  }
}

function handleOwnerReply(text) {
  const t = String(text || '').trim();
  const yes = /^(进|进吧|进去|同意|可以|行|好|ok|yes)$/i.test(t);
  const no = /^(不进|别进|不要|拒绝|不行|no)$/i.test(t);
  if (!yes && !no) return false;
  const first = [...pendingInvites.keys()][0];
  if (!first) return false;
  const inv = pendingInvites.get(first);
  pendingInvites.delete(first);
  send({ type: 'confirm-invite', inviteId: first, approve: yes });
  log(`主人决定：${yes ? '进' : '不进'}「${inv.groupName}」`);
  return true;
}

function watchOwner() {
  if (!OWNER_QQ || !ONEBOT_TOKEN) return;
  const u = new URL(ONEBOT);
  const wsProto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  const port = u.port === '3000' ? '3001' : u.port;
  const s = new WebSocket(`${wsProto}//${u.hostname}:${port}/?access_token=${encodeURIComponent(ONEBOT_TOKEN)}`);
  s.addEventListener('message', (ev) => {
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (d.post_type !== 'message') return;
    if (String(d.user_id) !== String(OWNER_QQ)) return;
    handleOwnerReply(d.raw_message || d.message);
  });
  s.addEventListener('close', () => setTimeout(watchOwner, 5000));
  s.addEventListener('error', () => {});
}

async function onMessage(data) {
  const msg = data.message;
  if (!msg || msg.senderId === data.botId) return;
  const roomId = data.roomId;
  if (!roomId || busy.has(roomId)) return;
  busy.add(roomId);
  try {
    const answer = DSH_ON ? await askDsh(roomId, msg) : await askStation(roomId, `${msg.senderName || '有人'}：${msg.text}`);
    if (answer) {
      send({ type: 'send', roomId, text: answer });
      log(`回 ${roomId}: ${answer.slice(0, 50)}`);
    }
  } catch (err) {
    log('站里没回上:', err.message);
  } finally {
    busy.delete(roomId);
  }
}

function connect() {
  const url = ROOM_URL + (ROOM_URL.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(BOT_TOKEN);
  ws = new WebSocket(url);
  ws.addEventListener('open', () => {
    retry = 0;
    startPing();
    log('已连上聊天室');
  });
  ws.addEventListener('message', (ev) => {
    let d;
    try {
      d = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (d.type === 'hello') {
      log(`上线：${d.bot.name}，已在 ${(d.groups || []).length} 个群`);
      return;
    }
    if (d.type === 'invite') {
      onInvite(d.invite).catch(() => {});
      return;
    }
    if (d.type === 'joined') {
      log('进群了:', d.groupName);
      return;
    }
    if (d.type === 'error') {
      log('聊天室报错:', d.message);
      return;
    }
    if (d.type === 'limited') {
      log(`这小时说满了（上限 ${d.limit} 句），先不回了`);
      return;
    }
    if (d.type === 'state') {
      const bits = [];
      if (d.muted) bits.push('被主人闭嘴');
      if (d.disabled) bits.push('被主人下线');
      if (d.limitOff) bits.push('发言限制已解除');
      log('状态变了:', bits.length ? bits.join('，') : '正常');
      return;
    }
    if (d.type === 'message') onMessage(d).catch((e) => log('处理消息失败:', e.message));
  });
  ws.addEventListener('close', () => {
    stopPing();
    if (closed) return;
    const wait = Math.min(30000, 1000 * 2 ** Math.min(retry, 5));
    retry += 1;
    log(`断线了，${Math.round(wait / 1000)}s 后重连`);
    setTimeout(connect, wait);
  });
  ws.addEventListener('error', () => {});
}

connect();
watchOwner();

process.on('SIGINT', () => {
  closed = true;
  try {
    ws && ws.close();
  } catch {}
  process.exit(0);
});
