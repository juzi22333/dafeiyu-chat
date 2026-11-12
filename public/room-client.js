'use strict';
/* 聊天室前端：零依赖，只跟 /api/room/* 说话
 * 布局仿 QQ 手机端：底部四个 tab（聊天 / 联系人 / 设置 / 个人资料），
 * 聊天 tab 是会话列表，点进去是聊天页，返回列表。
 * 消息靠 WebSocket 实时推，断了自动重连，另有慢轮询兜底。
 */

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const TOKEN_KEY = 'room-token';
/* 本地缓存：上次的会话列表 + 每个会话最近几十条消息。
   打开页面先把这些铺出来（秒出、不用等网络），再让后台把新的盖上。 */
const CACHE_KEY = 'room-cache-v1';
const CACHE_MSG_MAX = 60;

const state = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  me: null,
  rooms: [],
  roomId: '',
  messages: [],
  bots: [],
  members: [],
  roomBots: [],
  friendCount: 0,
  tab: 'chats',
  unread: {},
  ws: null,
  wsTimer: 0,
  wsPing: 0,
  wsRetry: 0,
  pollTimer: 0,
  enterToSend: localStorage.getItem('room-enter-send') !== '0',
  cacheTimer: 0,
  route: 'list',
  /* 软件更新：壳子在 UA 里报自己的 versionCode（DafeiyuApp/3），
     拿它跟服务端 /api/app/latest 比，才知道要不要亮红点。 */
  appCode: 0,
  appLatest: null,
};

/* ------------------------------- 本地缓存 ------------------------------- */

function readCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (!c || typeof c !== 'object') return null;
    return c;
  } catch (_) {
    return null;
  }
}

function saveCache(now) {
  if (now) {
    clearTimeout(state.cacheTimer);
    state.cacheTimer = 0;
    return writeCache();
  }
  if (state.cacheTimer) return;
  state.cacheTimer = setTimeout(() => {
    state.cacheTimer = 0;
    writeCache();
  }, 500);
}

function writeCache() {
  try {
    const msgs = readCache();
    const byRoom = (msgs && msgs.messages) || {};
    if (state.roomId && state.messages.length) {
      byRoom[state.roomId] = state.messages.slice(-CACHE_MSG_MAX);
    }
    const rooms = state.rooms.slice(0, 40).map((r) => ({
      roomId: r.roomId,
      type: r.type,
      title: r.title,
      groupId: r.groupId,
      groupNo: r.groupNo,
      peerId: r.peerId,
      peerUid: r.peerUid,
      peerCrown: r.peerCrown,
      online: r.online,
      memberCount: r.memberCount,
      botCount: r.botCount,
      last: r.last || null,
    }));
    localStorage.setItem(
      CACHE_KEY,
      JSON.stringify({ at: new Date().toISOString(), me: state.me, rooms, messages: byRoom }),
    );
  } catch (_) {}
}

function cachedMessages(roomId) {
  const c = readCache();
  const list = (c && c.messages && c.messages[roomId]) || [];
  return Array.isArray(list) ? list : [];
}


/* ------------------------------- 网络 ------------------------------- */

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (state.token) headers.Authorization = 'Bearer ' + state.token;
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || '请求失败 ' + res.status);
  return data;
}

/* ------------------------------- 工具 ------------------------------- */

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return hm;
  const yest = new Date(now.getTime() - 86400000);
  if (d.toDateString() === yest.toDateString()) return '昨天';
  return d.getMonth() + 1 + '/' + d.getDate();
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(text) {
  const box = $('#hintBar');
  if (!box) return;
  box.hidden = false;
  box.textContent = text;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => (box.hidden = true), 2600);
}

/* ------------------------------- 页面切换 ------------------------------- */

/* 告诉 App 壳子现在停在哪一页（list / chat / info），
   这样手机返回键和右滑手势才知道该回会话列表还是真的退出。 */
function reportRoute() {
  let r = 'list';
  const ci = $('#pageChatInfo');
  const chat = $('#pageChat');
  if (ci && !ci.hidden) r = 'info';
  else if (chat && !chat.hidden && state.roomId) r = 'chat';
  state.route = r;
  try {
    if (window.DafeiyuHost && window.DafeiyuHost.setRoute) window.DafeiyuHost.setRoute(r);
  } catch (e) {
    /* 网页里跑的时候没有这个桥，忽略 */
  }
}

/* App 点返回 / 右滑时调这个：从聊天信息或聊天页退回会话列表 */
window.DafeiyuBack = function () {
  const ci = $('#pageChatInfo');
  if (ci && !ci.hidden) {
    closeChatInfo();
    reportRoute();
    return 'chat';
  }
  if (state.roomId) {
    backToList();
    reportRoute();
    return 'list';
  }
  return 'exit';
};

function showTab(name) {
  state.tab = name;
  for (const p of ['pageChats', 'pageContacts', 'pageSettings', 'pageMe', 'pageChatInfo']) {
    const el = $('#' + p);
    if (el) el.hidden = true;
  }
  const map = { chats: 'pageChats', contacts: 'pageContacts', settings: 'pageSettings', me: 'pageMe' };
  // 聊天 tab 里如果正开着某个会话，就显示聊天页而不是列表
  if (name === 'chats' && state.roomId) {
    $('#pageChat').hidden = false;
  } else {
    $('#pageChat').hidden = true;
    const el = $('#' + map[name]);
    if (el) el.hidden = false;
  }
  for (const btn of $$('.tab-item')) btn.classList.toggle('active', btn.dataset.tab === name);
  // 进了会话页就把底部 tab 栏收起来（跟 QQ 一样，聊天时全屏）
  const tb = $('#tabBar');
  if (tb) tb.hidden = !$('#pageChat').hidden;
  if (name === 'contacts') renderContacts();
  if (name === 'settings') renderSettings();
  if (name === 'me') renderMe();
  reportRoute();
}

function backToList() {
  state.roomId = '';
  state.messages = [];
  $('#pageChat').hidden = true;
  const ci = $('#pageChatInfo');
  if (ci) ci.hidden = true;
  $('#pageChats').hidden = false;
  renderRooms();
  showTab('chats');
  reportRoute();
}

function enterRoom(roomId) {
  state.roomId = roomId;
  state.unread[roomId] = 0;
  renderRooms();
  renderBadge();
  $('#pageChats').hidden = true;
  $('#pageContacts').hidden = true;
  $('#pageSettings').hidden = true;
  $('#pageMe').hidden = true;
  const ci = $('#pageChatInfo');
  if (ci) ci.hidden = true;
  $('#pageChat').hidden = false;
  const tabBar = $('#tabBar');
  if (tabBar) tabBar.hidden = true;
  for (const btn of $$('.tab-item')) btn.classList.toggle('active', btn.dataset.tab === 'chats');
  // 先用本地缓存把消息铺出来（点进去就有内容），网络回来了再覆盖
  const cached = cachedMessages(roomId);
  if (cached.length) {
    state.messages = cached.slice();
    const room = state.rooms.find((r) => r.roomId === roomId);
    if (room) $('#roomTitle').textContent = roomLabel(room);
    renderMessages({ stickBottom: true });
  }
  loadMessages({ stickBottom: true }).catch(() => {});
  reportRoute();
}

/* ------------------------------- 渲染：会话列表 ------------------------------- */

function roomAvatar(r) {
  if (r.type === 'group') return { text: '#', cls: 'group' };
  return { text: (r.title || '?').slice(0, 1), cls: 'dm' };
}

function crownSvg() {
  return (
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8l4.2 3.1L12 4.5l4.8 6.6L21 8l-1.7 10.2H4.7L3 8Z" fill="currentColor"/></svg>'
  );
}

/* 在线小灯：绿=在线，灰=离线 */
function presenceDot(online) {
  return '<i class="presence-dot ' + (online ? 'on' : 'off') + '"></i>';
}

function renderRooms() {
  const box = $('#roomList');
  if (!box) return;
  box.innerHTML = '';
  if (!state.rooms.length) {
    box.innerHTML =
      '<div class="list-empty"><div class="list-empty-title">还没有会话</div>' +
      '<div class="list-empty-sub">右上角「+」加好友、建群，或者搜索群号进群</div></div>';
    return;
  }
  for (const r of state.rooms) {
    const av = roomAvatar(r);
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'chat-row' + (r.roomId === state.roomId ? ' active' : '');
    const unread = state.unread[r.roomId] || 0;
    const last = r.last;
    const preview = last ? (r.type === 'group' ? last.senderName + '：' : '') + last.text : '还没有消息';
    const dot = r.type === 'dm' ? presenceDot(r.online) : '';
    const crown = r.type === 'dm' && r.peerCrown ? '<i class="name-crown">' + crownSvg() + '</i>' : '';
    row.innerHTML =
      '<div class="chat-avatar ' + av.cls + '">' + esc(av.text) + dot + '</div>' +
      '<div class="chat-main">' +
      '<div class="chat-line1"><span class="chat-title">' + esc(r.title) + crown + '</span>' +
      '<span class="chat-time">' + esc(last ? fmtTime(last.at) : '') + '</span></div>' +
      '<div class="chat-line2"><span class="chat-preview">' + esc(preview) + '</span>' +
      (unread ? '<span class="chat-badge">' + (unread > 99 ? '99+' : unread) + '</span>' : '') +
      '</div></div>';
    row.addEventListener('click', () => enterRoom(r.roomId));
    box.appendChild(row);
  }
}

function renderBadge() {
  const badge = $('#tabBadge');
  if (!badge) return;
  const total = Object.values(state.unread).reduce((a, b) => a + b, 0);
  badge.hidden = !total;
  badge.textContent = total > 99 ? '99+' : String(total);
}

/* ------------------------------- 渲染：消息 ------------------------------- */

/* 表情面板里可选的一排表情 */
const EMOJI_LIST = [
  '😀', '😄', '😁', '😂', '🤣', '😊', '😍', '🥰',
  '😘', '😎', '🤔', '😅', '😭', '🥺', '😠', '😑',
  '😴', '🤗', '💪', '👍', '👌', '🙏', '👋', '🎉',
  '🌙', '🔥', '💯', '❓', '🐟', '🐳', '🍚', '💤',
];

/* 表情包：文字里的 [表情: 得意] 换成一张大表情，单独一条表情就只显示图 */
const STICKER_MAP = {
  得意: '😎', 开心: '😄', 笑: '😂', 大笑: '🤣', 哭: '😭', 委屈: '🥺', 生气: '😠',
  无语: '😑', 汗: '😅', 疑惑: '🤔', 惊讶: '😮', 害羞: '😳', 亲亲: '😘', 爱你: '🥰',
  困: '😴', 饿: '🍚', 吃: '🍚', 白饭: '🍚', 鱼: '🐟', 鲸鱼: '🐳', 赞: '👍',
  强: '👍', 棒: '👍', ok: '👌', 好的: '👌', 抱抱: '🤗', 加油: '💪', 溜了: '🏃',
  再见: '👋', 拜拜: '👋', 晚安: '🌙', 摸鱼: '🐟', 问号: '❓', 无语子: '😑',
};

const STICKER_RE = /\[表情[:：]\s*([^\]]{1,12})\]/g;

function renderStickerText(text) {
  const s = String(text || '');
  const only = s.replace(/\s/g, '');
  const m = /^\[表情[:：]\s*([^\]]{1,12})\]$/.exec(only);
  if (m) {
    const face = STICKER_MAP[m[1]] || STICKER_MAP[m[1].trim()] || '🙂';
    return { html: '<span class="msg-sticker">' + face + '</span>', plain: '' };
  }
  if (!STICKER_RE.test(s)) return null;
  STICKER_RE.lastIndex = 0;
  const html = s
    .split(STICKER_RE)
    .map((part, i) => {
      if (i % 2 === 0) return esc(part);
      const face = STICKER_MAP[part] || STICKER_MAP[part.trim()] || '🙂';
      return '<span class="msg-sticker small">' + face + '</span>';
    })
    .join('');
  return { html, plain: '' };
}

function msgNode(m) {
  const self = m.kind === 'user' && state.me && m.senderId === state.me.id;
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrap' + (self ? ' self' : '') + (m.kind === 'system' ? ' system' : '') + (m.kind === 'bot' ? ' bot' : '');
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = m.kind === 'system' ? '·' : (m.senderName || '?').slice(0, 1);
  const body = document.createElement('div');
  body.className = 'bubble-wrap';
  if (m.kind !== 'system') {
    const meta = document.createElement('div');
    meta.className = 'msg-meta';
    meta.textContent = (m.senderName || '?') + ' · ' + fmtTime(m.at);
    body.appendChild(meta);
  }
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  const sticker = m.kind === 'system' ? null : renderStickerText(m.text);
  if (sticker) {
    bubble.innerHTML = sticker.html;
  } else {
    bubble.textContent = m.text;
  }
  body.appendChild(bubble);
  wrap.appendChild(avatar);
  wrap.appendChild(body);
  return wrap;
}

/* 重铺消息列表。
   关键：用户自己往上翻看历史时，重铺（轮询/新消息/回到前台）不能把他拽回底部。
   - opts.stickBottom：进会话、自己发消息时用，强制到底
   - 否则：原本就在底部附近才跟着到底，翻上去了就保持原来的位置 */
function renderMessages(opts) {
  const box = $('#messages');
  if (!box) return;
  const o = opts || {};
  const prevTop = box.scrollTop;
  const prevHeight = box.scrollHeight;
  const prevClient = box.clientHeight;
  const wasNearBottom = prevHeight - prevTop - prevClient < 120;
  const hadContent = box.childElementCount > 0;
  box.innerHTML = '';
  if (!state.messages.length) {
    const tip = document.createElement('div');
    tip.className = 'empty-tip';
    tip.textContent = '还没有消息，说点什么吧';
    box.appendChild(tip);
    return;
  }
  for (const m of state.messages) box.appendChild(msgNode(m));
  const stick = o.stickBottom || !hadContent || wasNearBottom;
  // 程序化滚动不要平滑动画，不然轮询一次就"自己滑一下"
  const smooth = box.style.scrollBehavior;
  box.style.scrollBehavior = 'auto';
  if (stick) box.scrollTop = box.scrollHeight;
  else box.scrollTop = prevTop + (box.scrollHeight - prevHeight);
  box.style.scrollBehavior = smooth || '';
}


function appendMessageToView(msg) {
  const box = $('#messages');
  if (!box) return;
  if (!state.messages.length) box.innerHTML = '';
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  state.messages.push(msg);
  box.appendChild(msgNode(msg));
  if (nearBottom) box.scrollTop = box.scrollHeight;
  saveCache();
}

async function loadMessages(opts) {
  if (!state.roomId) return;
  const data = await api('/api/room/messages?room=' + encodeURIComponent(state.roomId) + '&limit=150');
  state.messages = data.messages || [];
  state.members = data.members || [];
  state.roomBots = data.bots || [];
  $('#roomTitle').textContent = roomLabel(data.room);
  const parts = [];
  if (data.members && data.members.length) parts.push(data.members.length + ' 人');
  if (data.room && data.room.groupNo) parts.push('群号 ' + data.room.groupNo);
  if (data.bots && data.bots.length) parts.push('鱼 ' + data.bots.length + ' 条');
  $('#roomMeta').textContent = parts.join(' · ');
  renderMessages(opts);
  saveCache();
}

function roomLabel(room) {
  if (!room) return '会话';
  if (room.type === 'group') return room.title + (room.groupNo ? '（' + room.groupNo + '）' : '');
  return room.title;
}

/* ------------------------------- 渲染：联系人 ------------------------------- */

function renderContacts() {
  const friends = state.rooms.filter((r) => r.type === 'dm');
  const groups = state.rooms.filter((r) => r.type === 'group');
  const fb = $('#friendList');
  const gb = $('#groupList');
  if (fb) {
    fb.innerHTML = friends.length
      ? friends
          .map(
            (r) =>
              '<button class="contact-row" type="button" data-room="' + esc(r.roomId) + '">' +
              '<div class="chat-avatar dm">' + esc((r.title || '?').slice(0, 1)) + presenceDot(r.online) + '</div>' +
              '<div class="contact-name">' + esc(r.title) +
              (r.peerCrown ? '<i class="name-crown">' + crownSvg() + '</i>' : '') +
              '<span class="contact-sub ' + (r.online ? 'on' : '') + '">' + (r.online ? '在线' : '离线') + '</span>' +
              '</div></button>',
          )
          .join('')
      : '<div class="list-empty-sub pad">还没有好友，点右上角加一个</div>';
  }
  if (gb) {
    gb.innerHTML = groups.length
      ? groups
          .map(
            (r) =>
              '<button class="contact-row" type="button" data-room="' + esc(r.roomId) + '">' +
              '<div class="chat-avatar group">#</div>' +
              '<div class="contact-name">' + esc(r.title) +
              '<span class="contact-no">' + esc(r.groupNo || '') + '</span></div></button>',
          )
          .join('')
      : '<div class="list-empty-sub pad">还没有群，右上角建一个</div>';
  }
  renderInbox(state.lastMe || {});
}

function renderInbox(data) {
  const box = $('#inbox');
  if (!box) return;
  box.innerHTML = '';
  const items = [];
  for (const q of data.incoming || []) {
    const who = q.fromName ? q.fromName + (q.fromUid ? '（' + q.fromUid + '）' : '') : '有人';
    items.push({ kind: 'friend', id: q.id, text: who + ' 想加你好友' });
  }
  for (const i of data.invites || []) items.push({ kind: 'invite', id: i.id, text: i.invitedByName + ' 想拉你的鱼进「' + i.groupName + '」' });
  if (!items.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  for (const it of items) {
    const row = document.createElement('div');
    row.className = 'inbox-item';
    const span = document.createElement('span');
    span.textContent = it.text;
    const yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'mini-btn';
    yes.textContent = it.kind === 'friend' ? '同意' : '让它进';
    yes.addEventListener('click', () => respondInbox(it));
    const no = document.createElement('button');
    no.type = 'button';
    no.className = 'mini-btn ghost';
    no.textContent = '算了';
    no.addEventListener('click', () => respondInbox(it, false));
    row.appendChild(span);
    row.appendChild(yes);
    row.appendChild(no);
    box.appendChild(row);
  }
}

async function respondInbox(item, accept = true) {
  try {
    if (item.kind === 'friend') {
      await api('/api/room/friends/respond', { method: 'POST', body: JSON.stringify({ id: item.id, accept }) });
    } else {
      await api('/api/room/invites/' + item.id + '/respond', { method: 'POST', body: JSON.stringify({ approve: accept }) });
    }
    await refreshMe();
  } catch (err) {
    toast(err.message);
  }
}

/* ------------------------------- 渲染：设置 / 我的 ------------------------------- */

function renderSettings() {
  const me = state.me;
  if (!me) return;
  const auto = $('#setAuto');
  if (auto) auto.checked = !!me.autoAcceptFriend;
  const enter = $('#setEnter');
  if (enter) enter.checked = state.enterToSend !== false;
  const nick = $('#setNickVal');
  if (nick) nick.textContent = me.nick || '还没改过，用的账号名';
  renderAppUpdate();
}

/* ------------------------------- 软件更新 ------------------------------- */

/* 壳子（安卓 App）会在 UA 里报自己的版本号：... DafeiyuApp/1.2 code/3
   网页里打开时没有这段，appCode 就是 0 —— 那种情况不亮红点。 */
function detectAppCode() {
  const m = /DafeiyuApp\/[\d.]+\s+code\/(\d+)/.exec(navigator.userAgent || '');
  return m ? Number(m[1]) || 0 : 0;
}

function hasNewApp() {
  const latest = state.appLatest;
  if (!latest || !state.appCode) return false;
  return Number(latest.versionCode) > state.appCode;
}

function renderAppUpdate() {
  const latest = state.appLatest;
  const sub = $('#appSub');
  const dot = $('#appDot');
  const tabDot = $('#tabDot');
  const newer = hasNewApp();
  if (sub) {
    if (!latest) sub.textContent = '检查中…';
    else if (!state.appCode) sub.textContent = '当前 ' + (latest.versionName || '—') + '，点这里下载安装包';
    else if (newer) sub.textContent = '有新版本 ' + latest.versionName + '，点这里更新';
    else sub.textContent = '已是最新 ' + (latest.versionName || state.appCode);
  }
  if (dot) dot.hidden = !newer;
  if (tabDot) tabDot.hidden = !newer;
}

async function checkAppUpdate() {
  state.appCode = detectAppCode();
  try {
    state.appLatest = await api('/api/app/latest');
  } catch (_) {
    state.appLatest = null;
  }
  renderAppUpdate();
}

function openAppDownload() {
  const latest = state.appLatest;
  const url = (latest && latest.url) || '/download/dafeiyu.apk';
  const abs = /^https?:/.test(url) ? url : location.origin + url;
  try {
    if (window.DafeiyuHost && window.DafeiyuHost.openUpdate) {
      window.DafeiyuHost.openUpdate(abs);
      return;
    }
  } catch (_) {}
  location.href = abs;
}

function renderMe() {
  const me = state.me;
  if (!me) return;
  const myName = me.displayName || me.nick || me.name;
  if ($('#meAvatar')) $('#meAvatar').textContent = myName.slice(0, 1);
  if ($('#meName')) $('#meName').textContent = myName;
  if ($('#meMeta')) $('#meMeta').textContent = (me.nick ? '账号 ' + me.name : '点下面可以改个昵称');
  if ($('#meUid')) $('#meUid').textContent = me.uid || '—';
  const crown = $('#meCrown');
  if (crown) {
    crown.hidden = !me.crown;
    crown.innerHTML = crownSvg();
  }
  if ($('#meAccount')) $('#meAccount').textContent = me.name || '—';
  if ($('#meFriends')) $('#meFriends').textContent = String(state.friendCount || 0);
  if ($('#meBots')) $('#meBots').textContent = state.bots.length ? state.bots.map((b) => b.name).join('、') : '还没有鱼';
}

/* ------------------------------- 数据 ------------------------------- */

async function refreshMe() {
  const data = await api('/api/room/me');
  state.me = data.user;
  state.rooms = data.rooms || [];
  state.bots = data.bots || [];
  state.friendCount = data.friendCount || 0;
  state.lastMe = data;
  renderRooms();
  renderBadge();
  if (state.tab === 'contacts') renderContacts();
  if (state.tab === 'settings') renderSettings();
  if (state.tab === 'me') renderMe();
  // 群号变了 / 有人改昵称时，标题跟着更新
  if (state.roomId) {
    const room = state.rooms.find((r) => r.roomId === state.roomId);
    if (room) $('#roomTitle').textContent = roomLabel(room);
  }
  saveCache();
}

/* ------------------------------- WebSocket 实时 ------------------------------- */

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return proto + '//' + location.host + '/api/room/ws?token=' + encodeURIComponent(state.token);
}

function connectWS() {
  if (!state.token) return;
  if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
  let ws;
  try {
    ws = new WebSocket(wsUrl());
  } catch (_) {
    scheduleReconnect();
    return;
  }
  state.ws = ws;
  ws.onopen = () => {
    state.wsRetry = 0;
    clearInterval(state.wsPing);
    // 25 秒心跳：Cloudflare 公网空闲约 2 分钟会掐连接
    state.wsPing = setInterval(() => {
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch (_) {}
    }, 25000);
  };
  ws.onmessage = (evt) => {
    let data;
    try {
      data = JSON.parse(evt.data);
    } catch (_) {
      return;
    }
    handleWS(data);
  };
  ws.onclose = () => {
    clearInterval(state.wsPing);
    state.ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => {
    try {
      ws.close();
    } catch (_) {}
  };
}

function scheduleReconnect() {
  clearTimeout(state.wsTimer);
  const wait = Math.min(15000, 800 * Math.pow(2, Math.min(state.wsRetry++, 4)));
  state.wsTimer = setTimeout(connectWS, wait);
}

function handleWS(data) {
  if (!data || !data.type) return;
  if (data.type === 'message' && data.message) {
    const msg = data.message;
    if (msg.roomId === state.roomId) {
      if (!state.messages.some((m) => m.id === msg.id)) appendMessageToView(msg);
    } else {
      // 不在当前会话：算未读，红点跳出来
      state.unread[msg.roomId] = (state.unread[msg.roomId] || 0) + 1;
      renderBadge();
    }
    // 会话列表的最后一条跟着变（不用刷新）
    const room = state.rooms.find((r) => r.roomId === msg.roomId);
    if (room) {
      room.last = { text: msg.text, at: msg.at, senderName: msg.senderName };
      const idx = state.rooms.indexOf(room);
      if (idx > 0) {
        state.rooms.splice(idx, 1);
        state.rooms.unshift(room);
      }
      renderRooms();
      saveCache();
    } else {
      refreshMe().catch(() => {});
    }
    return;
  }
  if (data.type === 'last') {
    const room = state.rooms.find((r) => r.roomId === data.roomId);
    if (room) {
      room.last = data.last;
      renderRooms();
      saveCache();
    }
    return;
  }
  // 别人加你好友 / 拉鱼进群：刷新一下收件箱
  if (data.type === 'friend-request' || data.type === 'invite') {
    refreshMe().catch(() => {});
    return;
  }
  // 谁上线 / 下线了：列表里的灯跟着变
  if (data.type === 'presence' && data.userId) {
    let hit = false;
    for (const r of state.rooms) {
      if (r.type === 'dm' && r.peerId === data.userId) {
        r.online = !!data.online;
        hit = true;
      }
    }
    if (hit) {
      renderRooms();
      if (state.tab === 'contacts') renderContacts();
    }
    const modalBody = $('#modalBody');
    if (modalBody && !$('#modal').hidden) {
      const dot = modalBody.querySelector('.presence-dot[data-uid="' + data.userId + '"]');
      if (dot) {
        dot.classList.toggle('on', !!data.online);
        dot.classList.toggle('off', !data.online);
      }
    }
    const infoBody = $('#infoBody');
    if (infoBody && !$('#pageChatInfo').hidden) {
      for (const dot of infoBody.querySelectorAll('.presence-dot[data-uid="' + data.userId + '"]')) {
        dot.classList.toggle('on', !!data.online);
        dot.classList.toggle('off', !data.online);
      }
    }
  }
}

/* 慢轮询兜底：WebSocket 断了也不会漏消息 */
function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (document.hidden) return;
    if (state.roomId) loadMessages().catch(() => {});
    refreshMe().catch(() => {});
  }, 20000);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = 0;
}

/* ------------------------------- 弹窗 ------------------------------- */

function openModal(title, bodyHtml, onOk, okText) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = bodyHtml;
  $('#modalBody').onclick = null; // 上个弹窗绑的点击别留到这个弹窗上
  $('#modal').hidden = false;
  $('#modalOk').textContent = okText || '确定';
  $('#modalOk').onclick = async () => {
    try {
      await onOk();
      closeModal();
    } catch (err) {
      toast(err.message);
    }
  };
}
function closeModal() {
  $('#modal').hidden = true;
}

/* 弹窗里密码框右边的小眼睛：点一下切明文 / 密文 */
const EYE_OPEN_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';
const EYE_SHUT_SVG =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 6.1A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3 3.6"/><path d="M6.4 7.6A16.8 16.8 0 0 0 2 12s3.6 6.5 10 6.5c1.3 0 2.5-.2 3.5-.6"/></svg>';

function initPwdEyes(root) {
  const scope = root || document;
  for (const btn of scope.querySelectorAll('.pwd-eye')) {
    if (btn.dataset.ready === '1') continue;
    btn.dataset.ready = '1';
    btn.innerHTML = EYE_OPEN_SVG;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const input = document.getElementById(btn.dataset.for);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = show ? EYE_SHUT_SVG : EYE_OPEN_SVG;
      btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      try {
        input.focus({ preventScroll: true });
      } catch (_) {}
    });
  }
}

/* ------------------------------- 加好友 ------------------------------- */

async function searchUsers() {
  const box = $('#fResult');
  if (!box) return;
  const q = $('#fQuery').value.trim();
  if (!q) {
    box.innerHTML = '<div class="modal-tip">输UID更快，账号也行</div>';
    return;
  }
  box.innerHTML = '<div class="modal-tip">找一下…</div>';
  const data = await api('/api/room/users?q=' + encodeURIComponent(q));
  const users = data.users || [];
  if (!users.length) {
    box.innerHTML = '<div class="modal-tip">没找到，核对一下UID或账号</div>';
    return;
  }
  box.innerHTML = users
    .map(
      (u) =>
        '<div class="user-row"><div class="user-info">' +
        '<div class="user-name">' + esc(u.displayName || u.name) + '</div>' +
        '<div class="modal-tip">UID ' + esc(u.uid || '—') + '</div></div>' +
        (u.isFriend
          ? '<span class="modal-tip">已是好友</span>'
          : '<button class="mini-btn" type="button" data-add="' + esc(u.uid || '') + '">加好友</button>') +
        '</div>',
    )
    .join('');
}

async function addFriendByUid(btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const r = await api('/api/room/friends', { method: 'POST', body: JSON.stringify({ uid: btn.dataset.add }) });
    if (r.already) toast('已经是好友了');
    else if (r.auto) toast('加上了，对方开了自动同意');
    else toast('申请发了，等对方同意');
    await refreshMe();
    const tag = document.createElement('span');
    tag.className = 'modal-tip';
    tag.textContent = r.already ? '已是好友' : r.auto ? '已加上' : '已发送';
    btn.replaceWith(tag);
  } catch (err) {
    btn.disabled = false;
    toast(err.message);
  }
}

function friendModal() {
  openModal(
    '加好友',
    '<label class="auth-field"><span class="auth-label">UID或账号</span>' +
      '<input class="auth-input" id="fQuery" placeholder="输 6 位UID，或者对方的账号"></label>' +
      '<div id="fResult"><div class="modal-tip">输UID更快，账号也行</div></div>',
    async () => {},
    '完成',
  );
  const input = $('#fQuery');
  if (!input) return;
  input.addEventListener('input', () => {
    clearTimeout(state.fTimer);
    state.fTimer = setTimeout(() => searchUsers().catch(() => {}), 320);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchUsers().catch(() => {});
    }
  });
  const result = $('#fResult');
  if (result) {
    result.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('[data-add]');
      if (!btn) return;
      e.preventDefault();
      addFriendByUid(btn);
    });
  }
  input.focus();
}

function groupModal() {
  openModal('建群', '<input class="auth-input" id="gName" placeholder="群名">', async () => {
    const name = $('#gName').value.trim();
    if (!name) throw new Error('写个群名');
    const r = await api('/api/room/groups', { method: 'POST', body: JSON.stringify({ name }) });
    await refreshMe();
    enterRoom(r.roomId);
  });
}

/* 搜索进群：填群号（或群名）→ 列出群 → 点「加入」 */
async function searchGroups() {
  const box = $('#gResult');
  if (!box) return;
  const q = $('#gQuery').value.trim();
  if (!q) {
    box.innerHTML = '<div class="modal-tip">填群号最快，群名也行</div>';
    return;
  }
  box.innerHTML = '<div class="modal-tip">找一下…</div>';
  const data = await api('/api/room/groups/search?q=' + encodeURIComponent(q));
  const groups = data.groups || [];
  if (!groups.length) {
    box.innerHTML = '<div class="modal-tip">没找到这个群，核对一下群号</div>';
    return;
  }
  box.innerHTML = groups
    .map(
      (g) =>
        '<div class="group-row"><div class="user-info">' +
        '<div class="user-name">' + esc(g.name) + '</div>' +
        '<div class="modal-tip">群号 ' + esc(g.no || '—') + ' · ' + (g.memberCount || 0) + ' 人</div></div>' +
        (g.joined
          ? '<span class="modal-tip">已在群里</span>'
          : '<button class="mini-btn" type="button" data-join="' + esc(g.id) + '">加入</button>') +
        '</div>',
    )
    .join('');
}

async function joinGroup(btn) {
  if (btn.disabled) return;
  btn.disabled = true;
  try {
    const r = await api('/api/room/groups/' + btn.dataset.join + '/join', { method: 'POST' });
    toast(r.already ? '你本来就在这个群里' : '进群了');
    await refreshMe();
    closeModal();
    if (r.roomId) enterRoom(r.roomId);
  } catch (err) {
    btn.disabled = false;
    toast(err.message);
  }
}

function joinGroupModal() {
  openModal(
    '搜索进群',
    '<label class="auth-field"><span class="auth-label">群号或群名</span>' +
      '<input class="auth-input" id="gQuery" inputmode="numeric" placeholder="输 6 位群号，或者群名"></label>' +
      '<div id="gResult"><div class="modal-tip">填群号最快，群名也行</div></div>',
    async () => {},
    '完成',
  );
  const input = $('#gQuery');
  if (!input) return;
  input.addEventListener('input', () => {
    clearTimeout(state.gTimer);
    state.gTimer = setTimeout(() => searchGroups().catch(() => {}), 320);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      searchGroups().catch(() => {});
    }
  });
  const result = $('#gResult');
  if (result) {
    result.addEventListener('click', (e) => {
      const btn = e.target.closest && e.target.closest('[data-join]');
      if (!btn) return;
      e.preventDefault();
      joinGroup(btn);
    });
  }
  input.focus();
}

function botsModal() {
  const list = state.bots.length
    ? state.bots
        .map((b) => '<div class="bot-row"><span>' + esc(b.name) + '</span><span class="bot-state">' + (b.online ? '在线' : '离线') + '</span></div>')
        .join('')
    : '<div class="modal-tip">还没有鱼</div>';
  openModal(
    '我的鱼',
    list + '<input class="auth-input" id="bName" placeholder="给鱼起个名字，比如 小鱼">',
    async () => {
      const name = $('#bName').value.trim() || '小鱼';
      const r = await api('/api/room/bots', { method: 'POST', body: JSON.stringify({ name }) });
      await refreshMe();
      openModal(
        '这条鱼的凭证',
        '<div class="modal-tip">只显示这一次，复制走填到 DSH 那边：</div><textarea class="token-box" readonly>' +
          esc(r.bot.id + '\n' + r.token) +
          '</textarea><div class="modal-tip">WebSocket 地址：' + esc(location.origin.replace(/^http/, 'ws') + r.ws + '?token=' + r.token) + '</div>',
        async () => {},
      );
    },
  );
}

/* ------------------------- 聊天信息页（仿 QQ「聊天信息」） ------------------------- */

function infoRow(label, value, attrs, placeholder) {
  const val = value && String(value).trim() ? value : placeholder || '未设置';
  return (
    '<button class="info-row2" type="button" ' + (attrs || '') + '>' +
    '<span class="info-row2-label">' + esc(label) + '</span>' +
    '<span class="info-row2-value">' + esc(val) + '</span>' +
    '<span class="info-row2-arrow">›</span></button>'
  );
}

function infoSwitchRow(label, id, on, sub) {
  return (
    '<div class="info-row2 switch-row"><span class="info-row2-label">' + esc(label) + '</span>' +
    (sub ? '<span class="info-row2-value">' + esc(sub) + '</span>' : '') +
    '<label class="switch"><input type="checkbox" id="' + id + '"' + (on ? ' checked' : '') + '>' +
    '<span class="switch-track"></span></label></div>'
  );
}

function infoHead(room) {
  const av = roomAvatar(room);
  return (
    '<div class="info-head"><div class="info-head-avatar ' + av.cls + '">' + esc(av.text) + '</div>' +
    '<div class="info-head-main"><div class="info-head-name">' + esc(room.title) +
    (room.peerCrown ? '<i class="name-crown">' + crownSvg() + '</i>' : '') + '</div>' +
    '<div class="info-head-sub">' + (room.type === 'group' ? '群号 ' + esc(room.groupNo || '—') : 'UID ' + esc(room.peerUid || '—')) + '</div></div>' +
    '<div class="info-head-arrow">›</div></div>'
  );
}

async function openChatInfo() {
  if (!state.roomId) return;
  const room = state.rooms.find((r) => r.roomId === state.roomId);
  if (!room) return;
  $('#pageChat').hidden = true;
  const tb = $('#tabBar');
  if (tb) tb.hidden = true;
  $('#pageChatInfo').hidden = false;
  const box = $('#infoBody');
  box.innerHTML = '<div class="list-empty-sub pad">加载中…</div>';
  try {
    if (room.type === 'group') await renderGroupInfo(room, box);
    else renderDmInfo(room, box);
  } catch (err) {
    box.innerHTML = '<div class="list-empty-sub pad">' + esc(err.message) + '</div>';
  }
  reportRoute();
}

function closeChatInfo() {
  $('#pageChatInfo').hidden = true;
  $('#pageChat').hidden = false;
  if (state.roomId) loadMessages().catch(() => {});
  reportRoute();
}

/* 群聊的「聊天信息」 */
async function renderGroupInfo(room, box) {
  const d = await api('/api/room/groups/' + room.groupId);
  const g = d.group || {};
  const members = d.members || [];
  const bots = d.bots || [];
  const isOwner = !!g.isOwner;
  const pinKey = 'room-pin-' + room.roomId;
  const hideKey = 'room-hide-' + room.roomId;
  const muteKey = 'room-mute-' + room.roomId;

  const roleTag = (m) =>
    m.role === 'owner'
      ? '<i class="role-tag owner">群主</i>'
      : m.role === 'admin'
        ? '<i class="role-tag admin">管理员</i>'
        : '';
  const cell = (m) =>
    '<button class="info-member" type="button" data-uid="' + esc(m.id || '') + '">' +
    '<div class="info-member-avatar" data-uid="' + esc(m.id || '') + '">' +
    esc((m.displayName || m.name || '?').slice(0, 1)) +
    (m.badge ? '<i class="member-badge">' + esc(m.badge) + '</i>' : '') +
    '<i class="presence-dot ' + (m.online ? 'on' : 'off') + '" data-uid="' + esc(m.id || '') + '"></i></div>' +
    '<div class="info-member-name">' + esc(m.displayName || m.name || '?') + '</div>' +
    roleTag(m) +
    (m.title ? '<div class="info-member-title">' + esc(m.title) + '</div>' : '') +
    '</button>';
  const fishCell = (b) =>
    '<div class="info-member"><div class="info-member-avatar fish">鱼</div>' +
    '<div class="info-member-name">' + esc(b.name) + '</div></div>';
  const inviteCell =
    '<button class="info-member" type="button" id="infoInvite">' +
    '<div class="info-member-avatar invite">+</div><div class="info-member-name">邀请</div></button>';

  box.innerHTML =
    infoHead(room) +
    '<div class="info-sec"><div class="info-sec-title"><span>群成员</span><span>' +
    (members.length + bots.length) + ' 人 ›</span></div>' +
    '<div class="info-members">' + members.map(cell).join('') + bots.map(fishCell).join('') + inviteCell + '</div></div>' +
    '<div class="info-sec">' +
    infoRow('群名称', room.title, 'id="infoName"') +
    infoRow('群备注', g.remark, 'id="infoRemark"') +
    '</div>' +
    '<div class="info-sec"><div class="info-sec-title"><span>群公告</span>' +
    (isOwner ? '<span id="infoNoticeEdit">修改</span>' : '') + '</div>' +
    '<div class="info-notice' + (g.notice ? '' : ' empty') + '">' + esc(g.notice || '还没有群公告') + '</div></div>' +
    '<div class="info-sec">' +
    infoRow('查找聊天记录', '', 'id="infoSearch"', '图片、视频、文件等') +
    infoSwitchRow('设为置顶', 'infoPin', localStorage.getItem(pinKey) === '1') +
    infoSwitchRow('隐藏会话', 'infoHide', localStorage.getItem(hideKey) === '1') +
    infoSwitchRow('消息免打扰', 'infoMute', localStorage.getItem(muteKey) === '1') +
    '</div>' +
    /* 群应用：先藏起来（display:none），代码留着，后期接真功能直接放出来 */
    '<div class="info-sec" id="infoAppsSec" style="display:none">' +
    '<div class="info-sec-title"><span>群应用</span></div>' +
    '<div class="info-apps">' +
    [['📁', '文件'], ['🖼️', '相册'], ['⭐', '精华消息'], ['🎁', '玩家福利社']]
      .map(
        (a) =>
          '<button class="info-app" type="button" data-app="' + a[1] + '"><span class="info-app-ico">' + a[0] + '</span><span>' + a[1] + '</span></button>',
      )
      .join('') +
    '</div></div>' +
    '<div class="info-sec">' +
    infoRow('我在本群的昵称', g.myNick, 'id="infoMyNick"') +
    infoRow(
      '个性设置',
      [g.myTitle, g.myBadge].filter(Boolean).join(' · '),
      'id="infoStyle"',
      '群头衔、标识佩戴等'
    ) +
    '</div>' +
    '<div class="info-actions">' +
    '<button class="info-action blue" type="button" id="infoClear">删除聊天记录</button>' +
    '<button class="info-action danger" type="button" id="infoLeave">退出群聊</button>' +
    '</div>';

  bindChatInfoCommon(room);
  bindSwitch('infoPin', pinKey);
  bindSwitch('infoHide', hideKey);
  bindSwitch('infoMute', muteKey);

  const nameBtn = $('#infoName');
  if (nameBtn)
    nameBtn.addEventListener('click', () => {
      if (!isOwner) return toast('只有群主能改群名');
      editGroupField('改群名', '群名称', room.title, 30, (v) => ({ name: v }));
    });
  const remarkBtn = $('#infoRemark');
  if (remarkBtn) remarkBtn.addEventListener('click', () => editGroupField('群备注', '备注', g.remark || '', 20, (v) => ({ remark: v })));
  const nickBtn = $('#infoMyNick');
  if (nickBtn) nickBtn.addEventListener('click', () => editGroupField('我在本群的昵称', '昵称', g.myNick || '', 16, (v) => ({ myNick: v })));
  const styleBtn = $('#infoStyle');
  if (styleBtn) styleBtn.addEventListener('click', () => editStyleModal(room, g));

  /* 点成员：群主能管人（设/撤管理员、禁言、移出），其他人在 QQ 里是看资料 */
  for (const el of box.querySelectorAll('.info-member[data-uid]')) {
    const uid = el.getAttribute('data-uid');
    const m = members.find((x) => x.id === uid);
    if (!m) continue;
    el.addEventListener('click', () => memberActionModal(room, g, m));
  }
  const noticeEdit = $('#infoNoticeEdit');
  if (noticeEdit) noticeEdit.addEventListener('click', () => editGroupField('改群公告', '群公告', g.notice || '', 600, (v) => ({ notice: v }), true));

  const invite = $('#infoInvite');
  if (invite) invite.addEventListener('click', () => inviteMemberModal(room));

  const clear = $('#infoClear');
  if (clear)
    clear.addEventListener('click', () => {
      state.messages = [];
      renderMessages();
      toast('这边的聊天记录清掉了');
    });
  const leave = $('#infoLeave');
  if (leave)
    leave.addEventListener('click', async () => {
      try {
        await api('/api/room/groups/' + room.groupId + '/leave', { method: 'POST' });
        toast('已退出群聊');
        state.roomId = '';
        $('#pageChatInfo').hidden = true;
        await refreshMe();
        showTab('chats');
      } catch (err) {
        toast(err.message);
      }
    });
}

/* 私聊的「聊天信息」 */
function renderDmInfo(room, box) {
  const pinKey = 'room-pin-' + room.roomId;
  const muteKey = 'room-mute-' + room.roomId;
  box.innerHTML =
    infoHead(room) +
    '<div class="info-sec">' +
    infoRow('查找聊天记录', '', 'id="infoSearch"', '图片、视频、文件等') +
    infoSwitchRow('设为置顶', 'infoPin', localStorage.getItem(pinKey) === '1') +
    infoSwitchRow('消息免打扰', 'infoMute', localStorage.getItem(muteKey) === '1') +
    '</div>' +
    '<div class="info-sec">' +
    infoRow('在线状态', room.online ? '在线' : '离线', 'id="infoPresence"') +
    '</div>' +
    '<div class="info-sec">' +
    infoRow('复制只读链接', '', 'id="infoShareCopy"', '别人点开就能看') +
    infoRow('关掉分享', '', 'id="infoShareOff"', '之前的链接都失效') +
    '</div>' +
    '<div class="info-actions">' +
    '<button class="info-action blue" type="button" id="infoClear">删除聊天记录</button>' +
    '</div>';
  bindChatInfoCommon(room);
  bindSwitch('infoPin', pinKey);
  bindSwitch('infoMute', muteKey);
  const copy = $('#infoShareCopy');
  if (copy)
    copy.addEventListener('click', async () => {
      try {
        const r = await api('/api/room/share?room=' + encodeURIComponent(room.roomId));
        let key = r.key;
        if (!key) {
          const made = await api('/api/room/share', { method: 'POST', body: JSON.stringify({ room: room.roomId }) });
          key = made.key;
        }
        copyText(location.origin + '/v/' + key, '只读链接复制好了，发给别人就行');
      } catch (err) {
        toast(err.message);
      }
    });
  const off = $('#infoShareOff');
  if (off)
    off.addEventListener('click', async () => {
      try {
        await api('/api/room/share?room=' + encodeURIComponent(room.roomId), { method: 'DELETE' });
        toast('分享关掉了，之前的链接都失效');
      } catch (err) {
        toast(err.message);
      }
    });
  const clear = $('#infoClear');
  if (clear)
    clear.addEventListener('click', () => {
      state.messages = [];
      renderMessages();
      toast('这边的聊天记录清掉了');
    });
}

/* 两个页面共用：查找聊天记录 */
function bindChatInfoCommon(room) {
  const search = $('#infoSearch');
  if (!search) return;
  search.addEventListener('click', () => {
    openModal(
      '查找聊天记录',
      '<label class="auth-field"><span class="auth-label">关键词</span>' +
        '<input class="auth-input" id="sQ" placeholder="输入要搜的字"></label>' +
        '<div id="sHits" class="search-hits"><div class="modal-tip">搜到就列在这里</div></div>',
      async () => {},
      '关闭',
    );
    const input = $('#sQ');
    if (!input) return;
    input.focus();
    let timer = null;
    const run = async () => {
      const q = input.value.trim();
      const out = $('#sHits');
      if (!out) return;
      if (!q) {
        out.innerHTML = '<div class="modal-tip">搜到就列在这里</div>';
        return;
      }
      try {
        const r = await api('/api/room/search?room=' + encodeURIComponent(room.roomId) + '&q=' + encodeURIComponent(q));
        const hits = r.hits || [];
        out.innerHTML = hits.length
          ? hits
              .map(
                (h) =>
                  '<div class="search-hit"><div class="search-hit-meta">' +
                  esc(h.senderName || '') + ' · ' + esc(fmtTime(h.at)) + '</div>' + esc(h.text) + '</div>',
              )
              .join('')
          : '<div class="modal-tip">没搜到</div>';
      } catch (err) {
        out.innerHTML = '<div class="modal-tip">' + esc(err.message) + '</div>';
      }
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(run, 260);
    });
  });
}

function bindSwitch(id, key) {
  const el = $('#' + id);
  if (!el) return;
  el.addEventListener('change', () => {
    try {
      localStorage.setItem(key, el.checked ? '1' : '0');
    } catch (_) {}
  });
}

/* 群名 / 群备注 / 我在本群的昵称 / 群公告 的编辑弹窗 */
function editGroupField(title, label, value, maxLen, buildBody, multiline) {
  const room = state.rooms.find((r) => r.roomId === state.roomId);
  if (!room) return;
  const field = multiline
    ? '<textarea class="auth-input" id="gv" rows="5" maxlength="' + maxLen + '">' + esc(value || '') + '</textarea>'
    : '<input class="auth-input" id="gv" maxlength="' + maxLen + '" value="' + esc(value || '') + '">';
  openModal(
    title,
    '<label class="auth-field"><span class="auth-label">' + esc(label) + '</span>' + field + '</label>',
    async () => {
      const v = $('#gv').value.trim();
      await api('/api/room/groups/' + room.groupId, { method: 'POST', body: JSON.stringify(buildBody(v)) });
      toast('改好了');
      if (buildBody(v).name) {
        await refreshMe();
      }
      await openChatInfo();
    },
  );
  const input = $('#gv');
  if (input) input.focus();
}

/* 个性设置：群头衔 + 标识佩戴（都是自己的，改完自己看得到） */
function editStyleModal(room, g) {
  const badges = ['', '鲸', '鱼', '皇冠', '元老', '活跃', '潜水', '夜猫'];
  const chip = (b) =>
    '<button class="badge-chip' + ((g.myBadge || '') === b ? ' on' : '') + '" type="button" data-badge="' +
    esc(b) + '">' + esc(b || '不戴') + '</button>';
  openModal(
    '个性设置',
    '<label class="auth-field"><span class="auth-label">群头衔（最多 12 字）</span>' +
      '<input class="auth-input" id="gvTitle" maxlength="12" value="' + esc(g.myTitle || '') +
      '" placeholder="比如：看门的、掌勺的"></label>' +
      '<div class="modal-sub">标识佩戴</div>' +
      '<div class="badge-chips" id="gvBadges">' + badges.map(chip).join('') + '</div>',
    async () => {
      const title = $('#gvTitle').value.trim();
      await api('/api/room/groups/' + room.groupId, {
        method: 'POST',
        body: JSON.stringify({ myTitle: title, myBadge: state.pendingBadge === undefined ? (g.myBadge || '') : state.pendingBadge }),
      });
      state.pendingBadge = undefined;
      toast('改好了');
      await openChatInfo();
    }
  );
  state.pendingBadge = g.myBadge || '';
  const box = $('#gvBadges');
  if (box)
    box.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-badge]');
      if (!btn) return;
      state.pendingBadge = btn.dataset.badge || '';
      box.querySelectorAll('.badge-chip').forEach((el) => el.classList.toggle('on', el === btn));
    });
  const input = $('#gvTitle');
  if (input) input.focus();
}

/* 点群成员：群主能管人（设/撤管理员、禁言、移出群聊），跟 QQ 群一样 */
function memberActionModal(room, g, m) {
  const isOwner = g.myRole === 'owner';
  const isMe = state.me && m.id === state.me.id;
  const canAct = isOwner && !isMe && m.role !== 'owner';
  const roleText = m.role === 'owner' ? '群主' : m.role === 'admin' ? '管理员' : '群成员';
  const muted = m.mutedUntil && m.mutedUntil > Date.now();
  const rows = [];
  rows.push('<div class="modal-sub">' + esc(m.displayName || m.name || '') + ' · ' + roleText + (muted ? ' · 禁言中' : '') + '</div>');
  if (canAct) {
    rows.push(
      m.role === 'admin'
        ? '<button class="info-row2" type="button" data-act="unsetAdmin"><span class="info-row2-label">撤销管理员</span><span class="info-row2-arrow">›</span></button>'
        : '<button class="info-row2" type="button" data-act="setAdmin"><span class="info-row2-label">设为管理员</span><span class="info-row2-arrow">›</span></button>',
    );
    rows.push(
      muted
        ? '<button class="info-row2" type="button" data-act="unmute"><span class="info-row2-label">解除禁言</span><span class="info-row2-arrow">›</span></button>'
        : '<button class="info-row2" type="button" data-act="mute"><span class="info-row2-label">禁言</span><span class="info-row2-arrow">›</span></button>',
    );
    rows.push('<button class="info-row2" type="button" data-act="kick"><span class="info-row2-label" style="color:#e0574f">移出群聊</span><span class="info-row2-arrow">›</span></button>');
  } else if (isMe) {
    rows.push('<div class="modal-tip">这是你自己</div>');
  } else if (!isOwner) {
    rows.push('<div class="modal-tip">只有群主能管人</div>');
  } else {
    rows.push('<div class="modal-tip">群主管不了群主</div>');
  }
  openModal('成员管理', rows.join(''), async () => {}, '关闭');
  const body = $('#modalBody');
  if (!body) return;
  body.onclick = async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    try {
      if (act === 'mute') {
        const mins = Number(prompt('禁言多少分钟？（1–1440）', '10'));
        if (!mins || mins < 1) return;
        await api('/api/room/groups/' + room.groupId + '/members/' + m.id, {
          method: 'POST',
          body: JSON.stringify({ act: 'mute', minutes: mins }),
        });
        toast('禁言 ' + mins + ' 分钟');
      } else if (act === 'unmute') {
        await api('/api/room/groups/' + room.groupId + '/members/' + m.id, {
          method: 'POST',
          body: JSON.stringify({ act: 'mute', minutes: 0 }),
        });
        toast('禁言解除了');
      } else if (act === 'kick') {
        if (!confirm('把 ' + (m.displayName || m.name) + ' 移出群聊？')) return;
        await api('/api/room/groups/' + room.groupId + '/members/' + m.id, {
          method: 'POST',
          body: JSON.stringify({ act: 'kick' }),
        });
        toast('已移出');
      } else {
        await api('/api/room/groups/' + room.groupId + '/members/' + m.id, {
          method: 'POST',
          body: JSON.stringify({ act }),
        });
        toast(act === 'setAdmin' ? '设成管理员了' : '管理员撤了');
      }
      closeModal();
      await openChatInfo();
    } catch (err) {
      toast(err.message);
    }
  };
}

/* 拉人进群：人填 UID，鱼直接点 */
async function inviteMemberModal(room) {
  let inGroup = [];
  try {
    const d = await api('/api/room/groups/' + room.groupId);
    inGroup = (d.bots || []).map((b) => String(b.id));
  } catch (e) {}
  const mine = state.bots || [];
  const fishHtml = mine.length
    ? mine
        .map((b) => {
          const inIt = inGroup.includes(String(b.id));
          return (
            '<div class="user-row"><div class="user-info"><div class="user-name">' +
            esc(b.name) +
            '</div><div class="modal-tip">' +
            (inIt ? '已经在群里' : b.online ? '在线' : '离线') +
            '</div></div>' +
            (inIt
              ? '<button class="mini-btn ghost" type="button" disabled>已在群</button>'
              : '<button class="mini-btn" type="button" data-pull="' + esc(b.id) + '">拉进来</button>') +
            '</div>'
          );
        })
        .join('')
    : '<div class="modal-tip">你还没有鱼，先去「我的鱼」建一条</div>';
  openModal(
    '邀请进群',
    '<label class="auth-field"><span class="auth-label">对方 UID</span>' +
      '<input class="auth-input" id="mUid" inputmode="numeric" placeholder="填对方的 UID（6 位数字）"></label>' +
      '<div class="modal-sub">我的鱼</div>' +
      fishHtml +
      '<div class="modal-tip">也可以把群号 ' + esc(room.groupNo || '—') + ' 发给他，让他自己搜进来</div>',
    async () => {
      const uidRaw = $('#mUid').value.trim();
      if (!uidRaw) throw new Error('填一下 UID，或者点上面的鱼');
      await api('/api/room/groups/' + room.groupId + '/members', { method: 'POST', body: JSON.stringify({ uid: uidRaw }) });
      toast('拉进来了');
      await openChatInfo();
    },
  );
  $('#modalBody').onclick = async (e) => {
    const btn = e.target.closest('[data-pull]');
    if (!btn || btn.disabled) return;
    const botId = btn.getAttribute('data-pull');
    btn.disabled = true;
    try {
      const r = await api('/api/room/groups/' + room.groupId + '/bots', { method: 'POST', body: JSON.stringify({ botId }) });
      toast(r && r.joined ? '鱼进群了' : r && r.already ? '它已经在了' : '已经邀请了，等鱼那边确认');
      closeModal();
      await openChatInfo();
    } catch (err) {
      btn.disabled = false;
      toast(err.message);
    }
  };
  const input = $('#mUid');
  if (input) input.focus();
}
/* 只读链接：生成 / 复制 / 关掉 */
function copyText(text, okText) {
  const done = () => toast(okText);
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
    done();
  } catch (_) {
    toast('复制不了，手动选一下吧：' + text);
  }
  ta.remove();
}

function bindShareButtons() {
  const box = $('#modalBody');
  if (!box) return;
  for (const btn of box.querySelectorAll('[data-share]')) {
    btn.addEventListener('click', async () => {
      const roomId = state.roomId;
      try {
        if (btn.dataset.share === 'copy') {
          const r = await api('/api/room/share?room=' + encodeURIComponent(roomId));
          let key = r.key;
          if (!key) {
            const made = await api('/api/room/share', { method: 'POST', body: JSON.stringify({ room: roomId }) });
            key = made.key;
          }
          copyText(location.origin + '/v/' + key, '只读链接复制好了，发给别人就行');
        } else {
          await api('/api/room/share?room=' + encodeURIComponent(roomId), { method: 'DELETE' });
          toast('分享关掉了，之前的链接都失效');
        }
      } catch (err) {
        toast(err.message);
      }
    });
  }
}

async function send(text) {
  if (!state.roomId) return;
  const r = await api('/api/room/messages', { method: 'POST', body: JSON.stringify({ room: state.roomId, text }) });
  if (!state.messages.some((m) => m.id === r.message.id)) appendMessageToView(r.message);
}

/* ------------------------------ 设置里的两个弹窗 ------------------------------ */

function nickModal() {
  if (!state.me) return;
  openModal(
    '改昵称',
    '<label class="auth-field"><span class="auth-label">昵称</span>' +
      '<input class="auth-input" id="pNick" maxlength="16" placeholder="别人看到的名字，最多 16 字" value="' +
      esc(state.me.nick || '') + '"></label>' +
      '<div class="modal-tip">不改就还是用账号名显示</div>',
    async () => {
      const nick = $('#pNick').value.trim();
      if (!nick) throw new Error('昵称不能空');
      await api('/api/room/settings', { method: 'POST', body: JSON.stringify({ nick }) });
      toast('昵称改好了');
      await refreshMe();
      if (state.roomId) await loadMessages();
    },
  );
  const input = $('#pNick');
  if (input) input.focus();
}

function passwordModal() {
  openModal(
    '更新密码',
    '<label class="auth-field"><span class="auth-label">原密码</span>' +
      '<span class="pwd-wrap"><input class="auth-input" id="oldPwd" type="password" autocomplete="current-password">' +
      '<button class="pwd-eye" type="button" data-for="oldPwd" aria-label="显示密码" tabindex="-1"></button></span></label>' +
      '<label class="auth-field"><span class="auth-label">新密码</span>' +
      '<span class="pwd-wrap"><input class="auth-input" id="newPwd" type="password" autocomplete="new-password" placeholder="至少 6 位，数字字母符号都行">' +
      '<button class="pwd-eye" type="button" data-for="newPwd" aria-label="显示密码" tabindex="-1"></button></span></label>',
    async () => {
      const oldPassword = $('#oldPwd').value;
      const newPassword = $('#newPwd').value;
      if (!newPassword) throw new Error('新密码没填');
      await api('/api/room/password', { method: 'POST', body: JSON.stringify({ oldPassword, newPassword }) });
      toast('密码改好了');
    },
  );
  initPwdEyes($('#modalBody'));
}

/* ------------------------------- 启动 ------------------------------- */

async function boot() {
  if (!state.token) {
    location.replace('/login');
    return;
  }
  // 先把上次的列表铺出来，页面不用等网络就有东西看
  const cache = readCache();
  if (cache) {
    if (cache.me) state.me = cache.me;
    if (Array.isArray(cache.rooms) && cache.rooms.length) {
      state.rooms = cache.rooms;
      renderRooms();
      renderBadge();
      showTab('chats');
      document.documentElement.dataset.cached = '1';
    }
  }
  try {
    await refreshMe();
    showTab('chats');
    connectWS();
    startPolling();
    checkAppUpdate();
    showVersion();
  } catch (err) {
    localStorage.removeItem(TOKEN_KEY);
    state.token = '';
    location.replace('/login');
  }
}

/* ------------------------------- 下拉刷新 -------------------------------
   站里 body 是 position:fixed、页面本身不会原生滚动，所以浏览器自带的下拉刷新
   永远不会触发；这里自己实现：在消息列表和各个滚动区顶部往下拽，松手就重新拉数据。
   只在下拉到顶（scrollTop === 0）时起手，横着划直接放弃（交给 App 壳子的右滑返回）。 */
const PULL_TRIGGER = 58;
const PULL_MAX = 104;

function pullTip() {
  let tip = document.getElementById('pullTip');
  if (!tip) {
    tip = document.createElement('div');
    tip.className = 'pull-tip';
    tip.id = 'pullTip';
    tip.innerHTML = '<i class="pull-spin"></i><span id="pullTipTxt">下拉刷新</span>';
    document.body.appendChild(tip);
  }
  return tip;
}

function pullTxt(t) {
  const el = document.getElementById('pullTipTxt');
  if (el) el.textContent = t;
}

async function pullRefresh() {
  const tip = pullTip();
  tip.classList.add('on', 'busy');
  pullTxt('刷新中…');
  try {
    await refreshMe();
    if (state.roomId) await loadMessages({ stickBottom: false });
  } catch (err) {
    tip.classList.remove('busy');
    pullTxt('没刷新成功');
    setTimeout(() => tip.classList.remove('on'), 800);
    return;
  }
  tip.classList.remove('busy');
  pullTxt('已刷新');
  setTimeout(() => tip.classList.remove('on'), 520);
}

function bindPull(el) {
  if (!el || el.dataset.pullBound === '1') return;
  el.dataset.pullBound = '1';
  let startY = 0;
  let startX = 0;
  let dist = 0;
  let dragging = false;
  let dead = false;

  el.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 1) {
        dead = true;
        return;
      }
      dead = el.scrollTop > 0;
      dragging = false;
      dist = 0;
      startY = e.touches[0].clientY;
      startX = e.touches[0].clientX;
    },
    { passive: true }
  );

  el.addEventListener(
    'touchmove',
    (e) => {
      if (dead || e.touches.length !== 1) return;
      const dy = e.touches[0].clientY - startY;
      const dx = e.touches[0].clientX - startX;
      if (dy <= 0) {
        if (dragging) {
          dragging = false;
          dist = 0;
          pullTip().classList.remove('on', 'ready');
        }
        return;
      }
      if (!dragging) {
        if (Math.abs(dx) > Math.abs(dy) * 0.8) {
          dead = true;
          return;
        }
        if (el.scrollTop > 0) {
          dead = true;
          return;
        }
        dragging = true;
      }
      e.preventDefault();
      dist = Math.min(PULL_MAX, dy * 0.55);
      const tip = pullTip();
      tip.classList.add('on');
      tip.classList.toggle('ready', dist >= PULL_TRIGGER);
      tip.style.transform = 'translate(-50%, ' + Math.round(dist - 46) + 'px)';
      pullTxt(dist >= PULL_TRIGGER ? '松手刷新' : '下拉刷新');
    },
    { passive: false }
  );

  el.addEventListener(
    'touchend',
    () => {
      if (!dragging) return;
      dragging = false;
      const tip = pullTip();
      tip.style.transform = '';
      tip.classList.remove('ready');
      if (dist >= PULL_TRIGGER) pullRefresh();
      else {
        tip.classList.remove('on');
        dist = 0;
      }
    },
    { passive: true }
  );

  el.addEventListener(
    'touchcancel',
    () => {
      dragging = false;
      dist = 0;
      const tip = pullTip();
      tip.style.transform = '';
      tip.classList.remove('on', 'ready', 'busy');
    },
    { passive: true }
  );
}

function initPullRefresh() {
  pullTip();
  bindPull($('#messages'));
  bindPull($('#roomList'));
  for (const el of $$('.scroll-area')) bindPull(el);
}

/* 设置页底部那行版本号：直接问服务端要，这样用户那边是不是最新一眼就看出来，
   不用再靠「你重装一下试试」。拿不到就退回一个模糊的说明，别显示错版本。 */
async function showVersion() {
  const el = $('#setVersion');
  if (!el) return;
  try {
    const v = await api('/api/version');
    const parts = ['大肥鱼聊天室', 'v' + (v.version || '?')];
    if (v.commit) parts.push(v.commit);
    el.textContent = parts.join(' · ');
    el.dataset.version = v.version || '';
    el.dataset.commit = v.commit || '';
  } catch {
    el.textContent = '大肥鱼聊天室';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  /* 底部 tab */
  for (const btn of $$('.tab-item')) {
    btn.addEventListener('click', () => {
      const name = btn.dataset.tab;
      if (name === 'chats') {
        state.roomId = '';
        state.messages = [];
        $('#pageChat').hidden = true;
      }
      showTab(name);
      renderRooms();
    });
  }

  /* 聊天页返回 */
  const back = $('#btnBack');
  if (back) back.addEventListener('click', backToList);

  /* 手机实体返回键 / 右滑（App 壳子里才有这个桥） */
  document.addEventListener('backbutton', () => {
    window.DafeiyuBack();
  });

  /* 会话信息：右上角「…」点进去就是 QQ 那种聊天信息页 */
  const info = $('#btnRoomInfo');
  if (info) info.addEventListener('click', openChatInfo);
  const title = $('#roomTitle');
  if (title) title.addEventListener('click', openChatInfo);
  const infoBack = $('#btnInfoBack');
  if (infoBack) infoBack.addEventListener('click', closeChatInfo);

  /* 右上角「+」下拉菜单 */
  const plusBtn = $('#btnPlus');
  const plusMenu = $('#plusMenu');
  function closePlus() {
    if (!plusMenu) return;
    plusMenu.hidden = true;
    if (plusBtn) plusBtn.setAttribute('aria-expanded', 'false');
  }
  if (plusBtn && plusMenu) {
    plusBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const willOpen = plusMenu.hidden;
      plusMenu.hidden = !willOpen;
      plusBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    });
    plusMenu.addEventListener('click', (e) => {
      const item = e.target.closest && e.target.closest('[data-act]');
      if (!item) return;
      e.preventDefault();
      closePlus();
      const act = item.dataset.act;
      if (act === 'friend') friendModal();
      else if (act === 'group') groupModal();
      else if (act === 'join') joinGroupModal();
      else if (act === 'bots') location.assign('/bots');
    });
    document.addEventListener('click', (e) => {
      if (plusMenu.hidden) return;
      if (e.target.closest && (e.target.closest('#plusMenu') || e.target.closest('#btnPlus'))) return;
      closePlus();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closePlus();
    });
  }

  /* 联系人页 */
  const addFriend = $('#btnAddFriend');
  if (addFriend) addFriend.addEventListener('click', friendModal);
  document.addEventListener('click', (e) => {
    const row = e.target.closest && e.target.closest('[data-room]');
    if (!row) return;
    e.preventDefault();
    enterRoom(row.dataset.room);
  });

  /* 设置页 */
  const auto = $('#setAuto');
  if (auto) {
    auto.addEventListener('change', async () => {
      try {
        await api('/api/room/settings', { method: 'POST', body: JSON.stringify({ autoAcceptFriend: auto.checked }) });
        toast(auto.checked ? '以后别人加你直接通过' : '以后加你要你点同意');
        await refreshMe();
      } catch (err) {
        auto.checked = !auto.checked;
        toast(err.message);
      }
    });
  }
  const setEnter = $('#setEnter');
  if (setEnter) {
    setEnter.addEventListener('change', () => {
      state.enterToSend = setEnter.checked;
      try {
        localStorage.setItem('room-enter-send', setEnter.checked ? '1' : '0');
      } catch (_) {}
      toast(setEnter.checked ? '回车直接发出去' : '回车换成换行');
    });
  }
  const rowNick = $('#rowNick');
  if (rowNick) rowNick.addEventListener('click', nickModal);
  const rowPwd = $('#rowPassword');
  if (rowPwd) rowPwd.addEventListener('click', passwordModal);
  const rowBots = $('#rowBots');
  if (rowBots) rowBots.addEventListener('click', () => location.assign('/bots'));
  const rowApp = $('#rowApp');
  if (rowApp) rowApp.addEventListener('click', openAppDownload);
  const logout = $('#setLogout');
  if (logout) {
    logout.addEventListener('click', () => {
      localStorage.removeItem(TOKEN_KEY);
      location.replace('/login');
    });
  }

  /* 个人资料页 */
  const meNick = $('#meEditNick');
  if (meNick) meNick.addEventListener('click', nickModal);
  const meBots = $('#meGotoBots');
  if (meBots) meBots.addEventListener('click', () => location.assign('/bots'));

  /* 弹窗关闭 */
  const close = $('#modalClose');
  if (close) close.addEventListener('click', closeModal);
  const modal = $('#modal');
  if (modal) {
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });
  }

  /* 发消息 */
  const composer = $('#composer');
  if (composer) {
    composer.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = $('#input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      input.style.height = 'auto';
      try {
        await send(text);
      } catch (err) {
        toast(err.message);
      }
    });
  }
  const input = $('#input');
  if (input) {
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(140, input.scrollHeight) + 'px';
    });
    /* 回车发送：Shift+回车换行；手机上还是点发送键 */
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey || e.isComposing || e.keyCode === 229) return;
      if (state.enterToSend === false) return;
      e.preventDefault();
      if (composer) {
        if (typeof composer.requestSubmit === 'function') composer.requestSubmit();
        else composer.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      }
    });
  }

  /* 表情面板 */
  const btnEmoji = $('#btnEmoji');
  const emojiPanel = $('#emojiPanel');
  if (emojiPanel && !emojiPanel.dataset.ready) {
    emojiPanel.dataset.ready = '1';
    emojiPanel.innerHTML = EMOJI_LIST.map(
      (e) => '<button class="emoji-item" type="button" data-emoji="' + e + '">' + e + '</button>',
    ).join('');
    emojiPanel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-emoji]');
      if (!btn) return;
      const box = $('#input');
      if (!box) return;
      const face = btn.dataset.emoji;
      const start = box.selectionStart == null ? box.value.length : box.selectionStart;
      const end = box.selectionEnd == null ? box.value.length : box.selectionEnd;
      box.value = box.value.slice(0, start) + face + box.value.slice(end);
      const pos = start + face.length;
      try {
        box.focus();
        box.setSelectionRange(pos, pos);
      } catch (_) {}
      box.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  if (btnEmoji && emojiPanel) {
    btnEmoji.addEventListener('click', (e) => {
      e.preventDefault();
      const atPanelNow = $('#atPanel');
      if (atPanelNow) atPanelNow.hidden = true;
      emojiPanel.hidden = !emojiPanel.hidden;
    });
    document.addEventListener('click', (e) => {
      if (emojiPanel.hidden) return;
      if (emojiPanel.contains(e.target) || btnEmoji.contains(e.target)) return;
      emojiPanel.hidden = true;
    });
  }

  /* @ 面板：把群成员和群里的鱼列出来，点一下就把 @名字 插到光标处 */
  const btnAt = $('#btnAt');
  const atPanel = $('#atPanel');
  if (atPanel && !atPanel.dataset.ready) {
    atPanel.dataset.ready = '1';
    atPanel.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-at]');
      if (!btn) return;
      const box = $('#input');
      if (!box) return;
      const name = btn.dataset.at;
      const start = box.selectionStart == null ? box.value.length : box.selectionStart;
      const end = box.selectionEnd == null ? box.value.length : box.selectionEnd;
      const before = box.value.slice(0, start);
      const sep = before && !/\s$/.test(before) ? ' ' : '';
      const piece = sep + '@' + name + ' ';
      box.value = before + piece + box.value.slice(end);
      const pos = start + piece.length;
      try {
        box.focus();
        box.setSelectionRange(pos, pos);
      } catch (_) {}
      box.dispatchEvent(new Event('input', { bubbles: true }));
      atPanel.hidden = true;
    });
  }
  function renderAtPanel() {
    if (!atPanel) return;
    const seen = new Set();
    const items = [];
    for (const u of state.members || []) {
      if (!u || u.id === (state.me && state.me.id)) continue;
      const name = u.displayName || u.nick || u.name || '';
      if (!name || seen.has(name)) continue;
      seen.add(name);
      items.push(
        '<button class="at-item" type="button" data-at="' +
          esc(name) +
          '"><span class="at-avatar">' +
          esc(name.slice(0, 1)) +
          '</span><span class="at-name">' +
          esc(name) +
          '</span>' +
          (u.crown ? '<span class="crown-badge">皇冠</span>' : '') +
          '</button>',
      );
    }
    for (const b of state.roomBots || []) {
      const name = (b && b.name) || '';
      if (!name || seen.has(name)) continue;
      seen.add(name);
      items.push(
        '<button class="at-item" type="button" data-at="' +
          esc(name) +
          '"><span class="at-avatar bot">鱼</span><span class="at-name">' +
          esc(name) +
          '</span><span class="at-tag">鱼</span></button>',
      );
    }
    atPanel.innerHTML = items.length
      ? items.join('')
      : '<div class="at-empty">这里还没有别人，@ 不了谁</div>';
  }
  if (btnAt && atPanel) {
    btnAt.addEventListener('click', (e) => {
      e.preventDefault();
      if (emojiPanel) emojiPanel.hidden = true;
      renderAtPanel();
      atPanel.hidden = !atPanel.hidden;
      if (!atPanel.hidden) {
        const box = $('#input');
        if (box) box.focus();
      }
    });
    document.addEventListener('click', (e) => {
      if (atPanel.hidden) return;
      if (atPanel.contains(e.target) || btnAt.contains(e.target)) return;
      atPanel.hidden = true;
    });
  }

  /* 回到前台：立刻补一次，别等轮询 */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      if (state.roomId) loadMessages().catch(() => {});
      refreshMe().catch(() => {});
    } else {
      connectWS();
    }
  });

  initPullRefresh();

  boot();
  reportRoute();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});
