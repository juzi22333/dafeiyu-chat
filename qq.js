'use strict';
/**
 * QQ 通道（OneBot 11）—— 让大肥鱼网站成为 QQ 的另一个前端
 *
 *  - 连 SnowLuma 的 WS(3001) 实时收消息
 *  - 发消息走 HTTP(3000) 的 send_group_msg / send_private_msg
 *  - 历史消息用 get_group_msg_history / get_friend_msg_history 现拉
 *  - 会话按 QQ 会话分（group:<群号> / private:<QQ号>），一个会话一个窗口
 *
 * 数据落在 db.json 的 db.qq.chats[key] 里，结构：
 *   { key, type:'group'|'private', id, title, messages:[{id, sender, senderId, text, at, self}], updatedAt }
 */

const fs = require('node:fs');
const path = require('node:path');

// SnowLuma（OneBot 网关）的配置文件。默认找 data/snowluma.json，
// 也可以指到你自己 SnowLuma 的 onebot_xxx.json 上。没有这个文件就不开 QQ 通道。
const SNOWLUMA_CONFIG =
  process.env.SNOWLUMA_CONFIG || path.join(__dirname, 'data', 'snowluma.json');

const MAX_MESSAGES_PER_CHAT = 400;
const MAX_CHATS = 120;

function loadSnowLumaNetworks() {
  try {
    const raw = JSON.parse(fs.readFileSync(SNOWLUMA_CONFIG, 'utf8'));
    const http = raw?.networks?.httpServers?.[0] || {};
    const ws = raw?.networks?.wsServers?.[0] || {};
    return {
      httpHost: http.host || '127.0.0.1',
      httpPort: Number(http.port || 3000),
      httpToken: http.accessToken || '',
      wsHost: ws.host || '127.0.0.1',
      wsPort: Number(ws.port || 3001),
      wsToken: ws.accessToken || '',
    };
  } catch (err) {
    console.error('[qq] 读 SnowLuma 配置失败，用默认值:', err.message);
    return { httpHost: '127.0.0.1', httpPort: 3000, httpToken: '', wsHost: '127.0.0.1', wsPort: 3001, wsToken: '' };
  }
}

/** 把 OneBot 的消息段数组压成纯文本 */
function flattenMessage(segments) {
  if (!Array.isArray(segments)) return String(segments || '');
  const out = [];
  for (const seg of segments) {
    const type = seg?.type;
    const data = seg?.data || {};
    if (type === 'text') out.push(data.text || '');
    else if (type === 'at') out.push(`@${data.qq === 'all' ? '全体成员' : data.qq}`);
    else if (type === 'image') out.push('[图片]');
    else if (type === 'face') out.push('[表情]');
    else if (type === 'mface') out.push('[表情]');
    else if (type === 'record') out.push('[语音]');
    else if (type === 'video') out.push('[视频]');
    else if (type === 'file') out.push('[文件]');
    else if (type === 'reply') continue;
    else if (type === 'forward') out.push('[转发消息]');
    else if (type === 'json') out.push('[卡片]');
    else if (type === 'xml') out.push('[卡片]');
    else if (data.text) out.push(data.text);
  }
  return out.join('').trim();
}

function createQQ(ctx) {
  const { getDb, saveDb, uid, sendJson, readBody } = ctx;
  const net = loadSnowLumaNetworks();
  const httpUrl = `http://${net.httpHost}:${net.httpPort}/`;
  const wsUrl = `ws://${net.wsHost}:${net.wsPort}/?access_token=${encodeURIComponent(net.wsToken)}`;

  const state = {
    connected: false,
    selfId: 0,
    nickname: '',
    ws: null,
    retry: 0,
    reconnectTimer: null,
    lastError: '',
    startedAt: null,
  };

  function db() {
    const d = getDb();
    if (!d.qq || typeof d.qq !== 'object') d.qq = { chats: {} };
    if (!d.qq.chats || typeof d.qq.chats !== 'object') d.qq.chats = {};
    return d.qq;
  }

  async function onebot(action, params = {}, timeoutMs = 15000) {
    const res = await fetch(httpUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${net.httpToken}`,
      },
      body: JSON.stringify({ action, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`OneBot 返回非 JSON（${res.status}）：${text.slice(0, 200)}`);
    }
    if (parsed.status === 'failed' || (parsed.retcode && parsed.retcode !== 0)) {
      throw new Error(parsed.wording || parsed.message || `OneBot 调用 ${action} 失败`);
    }
    return parsed.data;
  }

  function chatKeyOf(msg) {
    if (msg.message_type === 'group') return `group:${msg.group_id}`;
    if (msg.message_type === 'private') return `private:${msg.user_id === state.selfId ? msg.target_id : msg.user_id}`;
    return '';
  }

  function ensureChat(key, patch = {}) {
    const chats = db().chats;
    let chat = chats[key];
    if (!chat) {
      const [type, id] = key.split(':');
      chat = {
        key,
        type,
        id: Number(id),
        title: patch.title || (type === 'group' ? `群 ${id}` : `QQ ${id}`),
        messages: [],
        updatedAt: new Date().toISOString(),
      };
      chats[key] = chat;
    }
    if (patch.title && chat.title !== patch.title) chat.title = patch.title;
    return chat;
  }

  function ingest(msg) {
    const key = chatKeyOf(msg);
    if (!key) return;
    const self = msg.user_id === state.selfId;
    const chat = ensureChat(key, msg.message_type === 'group' ? { title: msg.group_name } : {});
    if (msg.message_type === 'private' && !self) {
      chat.title = msg.sender?.card || msg.sender?.nickname || `QQ ${msg.user_id}`;
    }
    const mid = String(msg.message_id ?? msg.real_id ?? `${Date.now()}`);
    if (chat.messages.some((m) => m.id === mid)) return;
    const at = new Date(Number(msg.time || Date.now() / 1000) * 1000).toISOString();
    chat.messages.push({
      id: mid,
      sender: self ? '我' : msg.sender?.card || msg.sender?.nickname || String(msg.user_id),
      senderId: msg.user_id,
      text: flattenMessage(msg.message) || msg.raw_message || '',
      at,
      self,
    });
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
      chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT);
    }
    chat.updatedAt = at;
    saveDb();
  }

  function handleEvent(evt) {
    if (!evt || typeof evt !== 'object') return;
    if (evt.post_type === 'message') {
      ingest(evt);
      return;
    }
    if (evt.post_type === 'meta_event' && evt.meta_event_type === 'lifecycle') {
      state.connected = true;
      return;
    }
  }

  function connect() {
    if (state.ws && (state.ws.readyState === 0 || state.ws.readyState === 1)) return;
    clearTimeout(state.reconnectTimer);
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      state.lastError = err.message;
      scheduleReconnect();
      return;
    }
    state.ws = ws;
    ws.addEventListener('open', () => {
      state.connected = true;
      state.retry = 0;
      state.lastError = '';
      console.log('[qq] OneBot WS 已连接');
      refreshIdentity();
    });
    ws.addEventListener('message', (event) => {
      let evt;
      try {
        evt = JSON.parse(typeof event.data === 'string' ? event.data : event.data.toString());
      } catch {
        return;
      }
      handleEvent(evt);
    });
    ws.addEventListener('close', () => {
      state.connected = false;
      console.warn('[qq] OneBot WS 断开，准备重连');
      scheduleReconnect();
    });
    ws.addEventListener('error', (err) => {
      state.connected = false;
      state.lastError = err?.message || 'ws error';
    });
  }

  function scheduleReconnect() {
    clearTimeout(state.reconnectTimer);
    state.retry += 1;
    const delay = Math.min(30000, 1000 * 2 ** Math.min(state.retry, 5));
    state.reconnectTimer = setTimeout(() => {
      connect();
    }, delay);
    if (state.reconnectTimer.unref) state.reconnectTimer.unref();
  }

  async function refreshIdentity() {
    try {
      const info = await onebot('get_login_info');
      state.selfId = Number(info?.user_id || 0);
      state.nickname = info?.nickname || '';
    } catch (err) {
      state.lastError = err.message;
    }
  }

  /* -------------------------------- 同步历史 -------------------------------- */

  async function syncChatHistory(key, count = 60) {
    const [type, rawId] = key.split(':');
    const id = Number(rawId);
    if (!id) return 0;
    const action = type === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
    const params = type === 'group' ? { group_id: id, count } : { user_id: id, count };
    const data = await onebot(action, params, 20000);
    const list = data?.messages || [];
    const chat = ensureChat(key);
    let added = 0;
    for (const msg of list) {
      const mid = String(msg.message_id ?? msg.real_id ?? '');
      if (!mid || chat.messages.some((m) => m.id === mid)) continue;
      const self = msg.user_id === state.selfId;
      chat.messages.push({
        id: mid,
        sender: self ? '我' : msg.sender?.card || msg.sender?.nickname || String(msg.user_id),
        senderId: msg.user_id,
        text: flattenMessage(msg.message) || msg.raw_message || '',
        at: new Date(Number(msg.time || Date.now() / 1000) * 1000).toISOString(),
        self,
      });
      added += 1;
    }
    chat.messages.sort((a, b) => (a.at < b.at ? -1 : 1));
    if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
      chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT);
    }
    if (chat.messages.length) chat.updatedAt = chat.messages.at(-1).at;
    if (added) await saveDb();
    return added;
  }

  async function refreshChatList() {
    const chats = db().chats;
    try {
      const groups = (await onebot('get_group_list')) || [];
      for (const g of groups) {
        const key = `group:${g.group_id}`;
        const chat = chats[key];
        if (chat) chat.title = g.group_name || chat.title;
      }
    } catch (err) {
      console.warn('[qq] 拉群列表失败:', err.message);
    }
    try {
      const friends = (await onebot('get_friend_list')) || [];
      for (const f of friends) {
        const key = `private:${f.user_id}`;
        const chat = chats[key];
        if (chat) chat.title = f.remark || f.nickname || chat.title;
      }
    } catch (err) {
      console.warn('[qq] 拉好友列表失败:', err.message);
    }
  }

  /** 把群/好友都先铺进会话列表，没聊过的也留个窗口，省得只能等消息进来才出现 */
  async function seedChats() {
    let changed = false;
    const add = (key, title) => {
      if (db().chats[key]) return;
      const [type, id] = key.split(':');
      db().chats[key] = {
        key,
        type,
        id: Number(id),
        title,
        messages: [],
        updatedAt: '',
        seeded: true,
      };
      changed = true;
    };
    try {
      for (const g of (await onebot('get_group_list')) || []) {
        add(`group:${g.group_id}`, g.group_name || `群 ${g.group_id}`);
      }
    } catch (err) {
      console.warn('[qq] 铺群会话失败:', err.message);
    }
    try {
      for (const f of (await onebot('get_friend_list')) || []) {
        // SnowLuma 自带的「我的电脑/我的手机/我的Pad」是设备会话，不是真人，发不出去
        if (/^我的(电脑|手机|Pad)$/.test(f.nickname || '')) {
          const key = `private:${f.user_id}`;
          if (db().chats[key] && !db().chats[key].messages.length) {
            delete db().chats[key];
            changed = true;
          }
          continue;
        }
        add(`private:${f.user_id}`, f.remark || f.nickname || `QQ ${f.user_id}`);
      }
    } catch (err) {
      console.warn('[qq] 铺好友会话失败:', err.message);
    }
    if (changed) await saveDb();
  }

  /* ---------------------------------- 发送 ---------------------------------- */

  async function sendToChat(key, text) {
    const [type, rawId] = key.split(':');
    const id = Number(rawId);
    if (!id) throw new Error('会话 id 不对');
    const action = type === 'group' ? 'send_group_msg' : 'send_private_msg';
    const params = type === 'group' ? { group_id: id, message: text } : { user_id: id, message: text };
    const data = await onebot(action, params, 20000);
    const chat = ensureChat(key);
    const mid = String(data?.message_id ?? `local-${Date.now()}`);
    if (!chat.messages.some((m) => m.id === mid)) {
      chat.messages.push({
        id: mid,
        sender: '我',
        senderId: state.selfId,
        text,
        at: new Date().toISOString(),
        self: true,
      });
      chat.updatedAt = chat.messages.at(-1).at;
      if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
        chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT);
      }
      await saveDb();
    }
    return { messageId: mid };
  }

  /* ---------------------------------- 路由 ---------------------------------- */

  function listChats() {
    const chats = Object.values(db().chats);
    const list = chats
      .map((c) => ({
        key: c.key,
        type: c.type,
        id: c.id,
        title: c.title,
        updatedAt: c.updatedAt,
        count: c.messages.length,
        preview: (c.messages.at(-1)?.text || '').slice(0, 60),
        unread: 0,
      }))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
      .slice(0, MAX_CHATS);
    return list;
  }

  async function handle(req, res, pathname, url) {
    if (pathname === '/api/qq/status' && req.method === 'GET') {
      return sendJson(res, 200, {
        connected: state.connected,
        selfId: state.selfId,
        nickname: state.nickname,
        lastError: state.lastError,
        startedAt: state.startedAt,
      });
    }
    if (pathname === '/api/qq/chats' && req.method === 'GET') {
      return sendJson(res, 200, { chats: listChats(), connected: state.connected, selfId: state.selfId });
    }
    if (pathname === '/api/qq/messages' && req.method === 'GET') {
      const key = String(url.searchParams.get('key') || '');
      if (!key) return sendJson(res, 400, { error: { message: '缺 key' } });
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 80)));
      const chat = db().chats[key];
      if (!chat) return sendJson(res, 404, { error: { message: '会话不存在' } });
      const sync = url.searchParams.get('sync') !== '0';
      if (sync && chat.messages.length < 30) {
        try {
          await syncChatHistory(key, 60);
        } catch (err) {
          console.warn('[qq] 同步历史失败:', err.message);
        }
      }
      const messages = chat.messages.slice(-limit);
      return sendJson(res, 200, { key: chat.key, title: chat.title, type: chat.type, messages });
    }
    if (pathname === '/api/qq/send' && req.method === 'POST') {
      const payload = await readBody(req);
      const key = String(payload.key || '');
      const text = String(payload.text || '').trim();
      if (!key || !text) return sendJson(res, 400, { error: { message: 'key 和 text 都要有' } });
      try {
        const out = await sendToChat(key, text);
        return sendJson(res, 200, { ok: true, ...out });
      } catch (err) {
        return sendJson(res, 502, { error: { message: err.message } });
      }
    }
    if (pathname === '/api/qq/sync' && req.method === 'POST') {
      const payload = await readBody(req);
      const key = String(payload.key || '');
      try {
        const added = key ? await syncChatHistory(key, 100) : 0;
        return sendJson(res, 200, { ok: true, added });
      } catch (err) {
        return sendJson(res, 502, { error: { message: err.message } });
      }
    }
    return sendJson(res, 404, { error: { message: '接口不存在' } });
  }

  async function start() {
    state.startedAt = new Date().toISOString();
    await refreshIdentity();
    connect();
    seedChats().catch(() => {});
    setTimeout(() => {
      refreshChatList().catch(() => {});
    }, 1500).unref?.();
  }

  return { start, handle, state, onebot, syncChatHistory, listChats, seedChats };
}

module.exports = { createQQ, flattenMessage, loadSnowLumaNetworks };
