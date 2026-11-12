'use strict';
/**
 * 聊天室 · DSH 侧接入示例（参考实现，零第三方依赖）
 *
 * 用法：
 *   1) 网页 /room 里注册 → 建一条鱼 → 复制 botId 和 token
 *   2) 复制本文件到你自己的 DSH 机器，填下面的 config
 *   3) node room-adapter.mjs
 *
 * 它干三件事：
 *   - 用 bot token 连聊天室的 WebSocket，保持在线
 *   - 房间里有人说话 → 交给你的模型（或任何函数）生成回复 → 发回房间
 *   - 有人拉你进群 → 不吭声，先私聊你的主人确认；主人回「进」才进，回别的就不进
 *
 * 注意：token 等同于这条鱼的身份，别贴到公开仓库。
 */

const fs = require('node:fs');
const path = require('node:path');

/* ------------------------------ 配置 ------------------------------ */

const CONFIG_FILE = path.join(__dirname, 'room-adapter.json');

const DEFAULTS = {
  // 聊天室地址（换成你自己的域名）
  roomUrl: 'ws://127.0.0.1:8710/api/room/ws',
  botToken: '把 /room 里那条鱼的 token 填这里',

  // 回复用的模型（任何 OpenAI 兼容接口都行）
  llm: {
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    model: 'deepseek-chat',
    systemPrompt: '你是住在聊天室里的一条鱼，说话自然口语化，简短，不要客套。',
  },

  // 主人确认通道：用 SnowLuma 的 OneBot HTTP 私聊主人
  // 不填 ownerQQ 就只在终端里问
  ownerQQ: '',
  onebotHttp: 'http://127.0.0.1:3000/',
  onebotToken: '',

  // 只在这些房间自动回话（空数组 = 所有已加入的房间都回）
  replyRooms: [],

  // 每个房间保留多少条上下文给模型
  contextMessages: 12,
};

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULTS, null, 2) + '\n', 'utf8');
    console.log(`已生成配置模板: ${CONFIG_FILE}`);
    console.log('填好 botToken 和 llm.apiKey 再跑一次。');
    process.exit(0);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  return { ...DEFAULTS, ...raw, llm: { ...DEFAULTS.llm, ...(raw.llm || {}) } };
}

const config = loadConfig();

/* ------------------------------ 小工具 ------------------------------ */

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

async function onebot(action, params) {
  const res = await fetch(config.onebotHttp, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(config.onebotToken ? { Authorization: 'Bearer ' + config.onebotToken } : {}),
    },
    body: JSON.stringify({ action, params }),
  });
  const data = await res.json();
  if (data.status === 'failed' || data.retcode !== 0) throw new Error(data.wording || data.message || 'OneBot 调用失败');
  return data.data;
}

async function dmOwner(text) {
  if (!config.ownerQQ) {
    log('[主人确认]', text);
    return;
  }
  await onebot('send_private_msg', { user_id: Number(config.ownerQQ), message: text });
}

/* ------------------------------ 上下文 ------------------------------ */

const history = new Map(); // roomId -> [{role, content}]

function remember(roomId, role, content) {
  const list = history.get(roomId) || [];
  list.push({ role, content });
  const keep = Math.max(2, config.contextMessages);
  if (list.length > keep) list.splice(0, list.length - keep);
  history.set(roomId, list);
}

async function askModel(roomId, incoming) {
  const messages = [{ role: 'system', content: config.llm.systemPrompt }, ...(history.get(roomId) || [])];
  if (incoming) messages.push({ role: 'user', content: incoming });

  const res = await fetch(config.llm.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.llm.apiKey },
    body: JSON.stringify({ model: config.llm.model, messages, temperature: 0.8, max_tokens: 500 }),
  });
  if (!res.ok) throw new Error('模型 ' + res.status + ': ' + (await res.text()).slice(0, 200));
  const data = await res.json();
  const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
  return (text || '').trim();
}

/* ------------------------------ 主人确认 ------------------------------ */

const pending = new Map(); // inviteId -> { groupName, invitedBy, at }
const askingOwner = new Map(); // inviteId -> true

async function onInvite(invite) {
  pending.set(invite.id, invite);
  const text = `${invite.invitedBy} 想拉我进「${invite.groupName}」，进不进？回「进」或「不进」`;
  try {
    await dmOwner(text);
    askingOwner.set(invite.id, true);
    log('已私聊主人确认邀请:', invite.groupName);
  } catch (err) {
    log('私聊主人失败，改成终端确认:', err.message);
    log(text);
  }
}

function handleOwnerReply(text) {
  const t = text.trim();
  const yes = /^(进|进吧|进去|同意|可以|行|好|ok|yes)$/i.test(t);
  const no = /^(不进|别进|不要|拒绝|不行|no)$/i.test(t);
  if (!yes && !no) return false;
  // 一次只处理最早那条待确认
  const first = [...pending.keys()][0];
  if (!first) return false;
  const invite = pending.get(first);
  pending.delete(first);
  send({ type: 'confirm-invite', inviteId: first, approve: yes });
  log(`主人决定：${yes ? '进' : '不进'}「${invite.groupName}」`);
  return true;
}

/* ------------------------------ WebSocket ------------------------------ */

let ws = null;
let retry = 0;
let closedByUs = false;

function send(obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function connect() {
  const url = config.roomUrl + (config.roomUrl.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(config.botToken);
  ws = new WebSocket(url);

  ws.addEventListener('open', () => {
    retry = 0;
    log('已连上聊天室');
  });

  ws.addEventListener('message', (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleFrame(data).catch((err) => log('处理帧出错:', err.message));
  });

  ws.addEventListener('close', () => {
    if (closedByUs) return;
    const wait = Math.min(30000, 1000 * 2 ** Math.min(retry, 5));
    retry += 1;
    log(`断线了，${Math.round(wait / 1000)}s 后重连`);
    setTimeout(connect, wait);
  });

  ws.addEventListener('error', () => {
    /* close 会跟着来 */
  });
}

async function handleFrame(data) {
  if (data.type === 'hello') {
    log(`上线：${data.bot.name}，已在 ${(data.groups || []).length} 个群`);
    return;
  }
  if (data.type === 'invite') {
    await onInvite(data.invite);
    return;
  }
  if (data.type === 'joined') {
    log(`进群了：${data.groupName}`);
    return;
  }
  if (data.type === 'invite-declined') {
    pending.delete(data.inviteId);
    log('邀请被拒');
    return;
  }
  if (data.type === 'error') {
    log('聊天室报错:', data.message);
    return;
  }
  if (data.type !== 'message') return;

  const msg = data.message;
  if (!msg || msg.senderId === data.botId) return;
  if (config.replyRooms.length && !config.replyRooms.includes(data.roomId)) return;

  const who = msg.senderName || '有人';
  const line = `${who}：${msg.text}`;
  remember(data.roomId, 'user', line);

  let answer = '';
  try {
    answer = await askModel(data.roomId);
  } catch (err) {
    log('模型调用失败:', err.message);
    return;
  }
  if (!answer) return;
  remember(data.roomId, 'assistant', answer);
  send({ type: 'send', roomId: data.roomId, text: answer });
  log(`回复 ${data.roomId}: ${answer.slice(0, 60)}`);
}

/* ---------------------- 可选：接 OneBot 收主人回复 ---------------------- */

function watchOwnerReply() {
  if (!config.ownerQQ || !config.onebotToken) return;
  // SnowLuma 的 WS 事件口，收私聊消息里主人说的话
  const wsUrl = config.onebotHttp.replace(/^http/, 'ws').replace(/:3000\/?$/, ':3001/') + '?access_token=' + encodeURIComponent(config.onebotToken);
  const s = new WebSocket(wsUrl);
  s.addEventListener('message', (ev) => {
    let data;
    try {
      data = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (data.post_type !== 'message') return;
    if (String(data.user_id) !== String(config.ownerQQ)) return;
    const text = data.raw_message || '';
    handleOwnerReply(text);
  });
  s.addEventListener('close', () => setTimeout(watchOwnerReply, 5000));
}

/* ------------------------------ 启动 ------------------------------ */

if (!config.botToken || config.botToken.startsWith('把 ')) {
  console.error('还没填 botToken，去 /room 里建一条鱼，复制 token 填进 room-adapter.json');
  process.exit(1);
}

connect();
watchOwnerReply();

process.on('SIGINT', () => {
  closedByUs = true;
  try {
    ws && ws.close();
  } catch {
    /* ignore */
  }
  process.exit(0);
});
