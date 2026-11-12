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

// 每个房间自己记一份最近聊天记录。DSH 会话虽然也有上下文，
// 但它一次只看到「当前这一句」，群里几个人同时说话就接不上茬；
// 而且生成期间新来的消息以前是直接丢掉的，鱼等于没听见。
const HIST = new Map(); // roomId -> [{ name, text, self }]
const HIST_MAX = 24;
const PENDING = new Map(); // roomId -> [{ name, text }]  攒着还没答的
const DEBOUNCE_MS = 1500; // 这么短时间内连着来的几句，合成一次回
const debounceTimers = new Map();

// 跟 QQ 群一个脾气：被点名/被问才答，别每句都插嘴。
// 两条鱼互相接话会无限刷屏，所以别的鱼说的话只在被点名时才接。
let BOT_NAME = '小鱼';
const REPLY_PROB = 0.06;

function looksAddressed(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (BOT_NAME && t.includes(BOT_NAME)) return true;
  if (BOT_NAME && t.includes('@' + BOT_NAME)) return true;
  if (/[?？]\s*$/.test(t)) return true;
  if (/(吗|呢|怎么|为什么|啥|多少|哪个|谁|能不能|可不可以|有没有|是不是)/.test(t)) return true;
  return Math.random() < REPLY_PROB;
}

function pushHist(roomId, name, text, self) {
  let arr = HIST.get(roomId);
  if (!arr) {
    arr = [];
    HIST.set(roomId, arr);
  }
  arr.push({ name, text, self });
  if (arr.length > HIST_MAX) arr.splice(0, arr.length - HIST_MAX);
}

// 最近聊天记录；skip = 末尾要跳过的条数（正在问的那批已经进历史了，别重复）
function histText(roomId, skip) {
  const all = HIST.get(roomId) || [];
  const arr = skip ? all.slice(0, Math.max(0, all.length - skip)) : all;
  if (!arr.length) return '';
  return arr.map((m) => `${m.self ? '我' : m.name}：${m.text}`).join('\n');
}

async function askDsh(roomId, batch) {
  const now = batch.map((m) => `${m.name}：${m.text}`).join('\n');
  const recent = histText(roomId, batch.length);
  const parts = [];
  if (recent) parts.push('【刚才群里在聊】\n' + recent);
  parts.push('【现在要回的消息】\n' + now);
  parts.push('（你在一个网页聊天室的群里，像群友一样接着聊，别复述上面的记录，别用 Markdown。）');
  const line = parts.join('\n\n');
  try {
    const out = await brainClient().ask(roomId, line, { timeoutMs: 150000 });
    if (out && out.trim()) return out.trim();
  } catch (err) {
    log('DSH 没接上，改问站里:', err.message);
  }
  return askStation(roomId, line);
}

// 把一个房间攒着的消息一次性答掉；答完再看有没有新的
async function drain(roomId) {
  if (busy.has(roomId)) return;
  busy.add(roomId);
  try {
    for (;;) {
      const batch = PENDING.get(roomId) || [];
      if (!batch.length) break;
      PENDING.set(roomId, []);
      const answer = DSH_ON ? await askDsh(roomId, batch) : await askStation(roomId, batch.map((m) => `${m.name}：${m.text}`).join('\n'));
      if (answer) {
        send({ type: 'send', roomId, text: answer });
        pushHist(roomId, '', answer, true);
        log(`回 ${roomId}: ${answer.slice(0, 50)}`);
      }
    }
  } catch (err) {
    log('站里没回上:', err.message);
  } finally {
    busy.delete(roomId);
    // 收尾这瞬间又来了消息的话，别让它一直躺在队列里
    if ((PENDING.get(roomId) || []).length) setTimeout(() => drain(roomId), 50);
  }
}

function queueMessage(roomId, msg) {
  const name = msg.senderName || '有人';
  const text = String(msg.text || '');
  const isBot = msg.kind === 'bot';
  pushHist(roomId, name, text, false);
  // 私聊一定回；群里像 QQ 那样，被点名/被问才回，别的鱼说话只在叫到我时接
  const isDm = roomId.startsWith('dm:');
  const addressed = looksAddressed(text);
  if (!isDm) {
    if (isBot && !(BOT_NAME && text.includes(BOT_NAME))) return;
    if (!isBot && !addressed) return;
  }
  let arr = PENDING.get(roomId);
  if (!arr) {
    arr = [];
    PENDING.set(roomId, arr);
  }
  arr.push({ name, text });
  const t = debounceTimers.get(roomId);
  if (t) clearTimeout(t);
  const timer = setTimeout(() => {
    debounceTimers.delete(roomId);
    drain(roomId);
  }, DEBOUNCE_MS);
  if (timer.unref) timer.unref();
  debounceTimers.set(roomId, timer);
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

function onMessage(data) {
  const msg = data.message;
  if (!msg || msg.senderId === data.botId) return;
  const roomId = data.roomId;
  if (!roomId) return;
  if (msg.kind === 'system') return;
  queueMessage(roomId, msg);
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
      if (d.bot && d.bot.name) BOT_NAME = String(d.bot.name);
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
    if (d.type === 'message') {
      try {
        onMessage(d);
      } catch (e) {
        log('处理消息失败:', e.message);
      }
    }
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
