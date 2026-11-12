'use strict';
/**
 * 聊天室模块（零第三方依赖）
 *  - 用户：注册 / 登录 / 会话令牌
 *  - 好友：按用户名申请 + 对方同意
 *  - 群组：建群 / 拉人 / 拉鱼（bot）
 *  - 消息：私聊房间 + 群房间，网页轮询
 *  - Bot 通道：WebSocket /api/room/ws?token=<botToken>
 *    鱼在别人拉群时不吭声，先收到 {type:'invite'}，由它在 DSH 那边私聊主人确认，
 *    主人同意后鱼回 {type:'confirm-invite', inviteId, approve:true} 才真正入群。
 */

const crypto = require('node:crypto');

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_ROOM_MESSAGES = 500;
const INVITE_TTL_MS = 5 * 60 * 1000;
const MAX_TEXT = 4000;
const ACCOUNT_RULE = /^[0-9]{5,20}$/;
// 密码：6~64 位，数字 / 字母（不限大小写）/ 符号随便组合，不能有空格
const PASSWORD_RULE = /^[\x21-\x7E]{6,64}$/;
const PASSWORD_HINT = '密码至少 6 位，数字、字母、符号都能用（不能有空格）';
// 默认群：新用户注册 / 登入直接进这个群，老用户也全拉进来（自己主动退过的除外）
const DEFAULT_GROUP_NO = '471746';
// 群里的「标识佩戴」：只收这几个字，别让人乱写脏东西
const BADGES = ['', '鲸', '鱼', '皇冠', '元老', '活跃', '潜水', '夜猫'];

const nowIso = () => new Date().toISOString();

/* ------------------------------- 存储结构 ------------------------------- */

// 展示用UID：6 位数字，全局唯一（跟内部 id 分开，内部 id 太长不好念）
function nextUserNo(r) {
  const used = new Set(Object.values(r.users || {}).map((u) => String(u.uid || '')));
  for (let i = 0; i < 200; i++) {
    const n = String(crypto.randomInt(100000, 1000000));
    if (!used.has(n)) return n;
  }
  return String(Date.now()).slice(-6);
}

// 群号：6 位数字，全局唯一（跟内部 id 分开，方便口头报给群友）
function nextGroupNo(r) {
  const used = new Set(Object.values(r.groups || {}).map((g) => String(g.no || '')));
  for (let i = 0; i < 200; i++) {
    const n = String(crypto.randomInt(100000, 1000000));
    if (!used.has(n)) return n;
  }
  return String(Date.now()).slice(-6);
}

function ensureStore(db) {
  if (!db.room || typeof db.room !== 'object') db.room = {};
  const r = db.room;
  r.users = r.users || {};
  // 老用户补一个展示用的数字 uid（6 位，全局唯一）
  for (const u of Object.values(r.users)) {
    if (!u.uid) u.uid = nextUserNo(r);
  }
  // 老群补群号
  r.groups = r.groups || {};
  for (const g of Object.values(r.groups)) {
    if (!g.no) g.no = nextGroupNo(r);
    if (typeof g.notice !== 'string') g.notice = '';
    if (!g.nicks || typeof g.nicks !== 'object') g.nicks = {};
    // 管理员名单（群主之外的人）：跟 QQ 群一样，群主能设/撤管理员
    if (!Array.isArray(g.adminIds)) g.adminIds = [];
    g.adminIds = g.adminIds.filter((id) => id !== g.ownerId && (g.memberIds || []).includes(id));
  }
  r.sessions = r.sessions || {};
  r.friends = r.friends || {};
  r.friendRequests = r.friendRequests || {};
  r.groups = r.groups || {};
  r.bots = r.bots || {};
  r.invites = r.invites || {};
  r.messages = r.messages || {};
  r.shares = r.shares || {};
  // 主人的号：UID 固定 88888，带一枚黑金皇冠（别人没有）
  for (const u of Object.values(r.users)) {
    if (String(u.name) === '95147699') {
      u.uid = '88888';
      u.crown = true;
    }
  }
  // 默认群：老用户一次性全拉进来（自己主动退过的打 leftDefaultGroup 标记，不再拉）
  const dg = Object.values(r.groups).find((g) => String(g.no) === DEFAULT_GROUP_NO);
  if (dg) {
    dg.memberIds = dg.memberIds || [];
    for (const u of Object.values(r.users)) {
      if (u.leftDefaultGroup) continue;
      if (!dg.memberIds.includes(u.id)) dg.memberIds.push(u.id);
    }
  }
  return r;
}

function dmRoomId(a, b) {
  return `dm:${[String(a), String(b)].sort().join('|')}`;
}
const groupRoomId = (gid) => `group:${gid}`;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 32).toString('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/* ------------------------------ 最小 WebSocket ----------------------------- */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function wsAcceptKey(key) {
  return crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.alloc(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function createFrameParser(onText, onPing, onClose) {
  let buf = Buffer.alloc(0);
  return function push(chunk) {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const b0 = buf[0];
      const b1 = buf[1];
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskLen = masked ? 4 : 0;
      if (buf.length < off + maskLen + len) return;
      let payload = buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = buf.subarray(off, off + 4);
        const out = Buffer.alloc(len);
        for (let i = 0; i < len; i++) out[i] = payload[i] ^ mask[i & 3];
        payload = out;
      } else {
        payload = Buffer.from(payload);
      }
      buf = buf.subarray(off + maskLen + len);
      if (opcode === 0x8) {
        onClose();
        return;
      }
      if (opcode === 0x9) {
        onPing(payload);
        continue;
      }
      if (opcode === 0xa) continue;
      if (opcode === 0x1 || opcode === 0x2) onText(payload.toString('utf8'));
    }
  };
}

/* -------------------------------- 主体 -------------------------------- */

function createRoom(ctx) {
  const { getDb, saveDb, uid, sendJson, readBody } = ctx;
  const sockets = new Map(); // botId -> ws 包装
  const userSockets = new Map(); // userId -> Set<socket>（网页端实时推送用）

  const db = () => getDb();
  const store = () => ensureStore(db());

  function send(socket, obj) {
    try {
      if (socket && !socket.destroyed) socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj))));
    } catch {
      /* 忽略发送失败 */
    }
  }

  function pushToBot(botId, obj) {
    const sock = sockets.get(botId);
    if (sock) send(sock, obj);
  }

  // 网页端实时推送：给会话里的每个在线用户都推一条
  function pushToRoom(roomId, obj) {
    const members = roomMembers(roomId);
    for (const userId of members.userIds) {
      const set = userSockets.get(userId);
      if (!set) continue;
      for (const sock of set) send(sock, obj);
    }
  }

  // 在线判断：网页端还挂着 WebSocket 就算在线（关掉页面 / 断网就变灰）
  function isOnline(userId) {
    const set = userSockets.get(userId);
    return !!(set && set.size);
  }

  // 上下线广播：只推给跟这个人有交集的（好友 + 同群的人），别人的列表跟着变灯
  function broadcastPresence(userId) {
    const r = store();
    const frame = { type: 'presence', userId, online: isOnline(userId) };
    const targets = new Set();
    for (const fid of r.friends[userId] || []) targets.add(fid);
    for (const g of Object.values(r.groups)) {
      if ((g.memberIds || []).includes(userId)) for (const id of g.memberIds) targets.add(id);
    }
    targets.delete(userId);
    for (const id of targets) {
      const set = userSockets.get(id);
      if (!set) continue;
      for (const sock of set) send(sock, frame);
    }
  }

  // 有新消息时：推消息本身 + 顺手把会话列表的「最后一条」推过去，列表不用刷新
  function broadcastMessage(roomId, msg) {
    pushToRoom(roomId, { type: 'message', roomId, roomType: roomId.split(':')[0], message: msg });
    pushToRoom(roomId, { type: 'last', roomId, last: { text: msg.text, at: msg.at, senderName: msg.senderName } });
  }

  function botsInRoom(roomId) {
    const r = store();
    const ids = [];
    if (roomId.startsWith('group:')) {
      const g = r.groups[roomId.slice(6)];
      if (g) ids.push(...(g.botIds || []));
    } else if (roomId.startsWith('dm:')) {
      // 私聊里也能有一条鱼：房间 id 是 dm:<userId>|<botId>，把鱼那一半认出来
      for (const part of roomId.slice(3).split('|')) {
        if (r.bots[part]) ids.push(part);
      }
    }
    return ids.filter((id) => r.bots[id]);
  }

  // 显示名：改过昵称就用昵称，没改过就用账号
  function displayName(u) {
    if (!u) return '';
    return u.nick || u.name || '';
  }

  // 群里的身份：owner 群主 / admin 管理员 / member 成员（跟 QQ 群一样三级）
  function roleOf(g, userId) {
    if (!g) return 'member';
    if (g.ownerId === userId) return 'owner';
    if ((g.adminIds || []).includes(userId)) return 'admin';
    return 'member';
  }

  function canManage(g, userId) {
    return roleOf(g, userId) === 'owner';
  }

  function isMuted(g, userId) {
    const until = g && g.muted && g.muted[userId];
    return !!until && until > Date.now();
  }

  function publicUser(u) {
    if (!u) return null;
    return {
      id: u.id,
      uid: u.uid || '',
      name: u.name,
      nick: u.nick || '',
      displayName: displayName(u),
      autoAcceptFriend: !!u.autoAcceptFriend,
      online: isOnline(u.id),
      crown: !!u.crown,
      createdAt: u.createdAt,
    };
  }

  function publicBot(b, withToken) {
    if (!b) return null;
    const out = {
      id: b.id,
      name: b.name,
      ownerId: b.ownerId,
      online: sockets.has(b.id) && !b.disabled,
      createdAt: b.createdAt,
      // 主人手里的两个开关：闭嘴（还能看，只是不开口）、下线（连接直接断，重连也拒）
      muted: !!b.muted,
      disabled: !!b.disabled,
      // 鱼主人 @鱼 说一句「解除发言限制」就把它关掉，说「开启发言限制」再打开
      limitOff: !!b.limitOff,
      spokeThisHour: spokeThisHour(b),
    };
    // token 只在鱼主人自己查看「我的鱼」时给出，其它地方一律不带
    if (withToken) out.token = b.token;
    return out;
  }

  /* 鱼说话的限额：群里一小时 10 句，私聊不限。按整点分桶，跨小时自动清零。 */
  const BOT_GROUP_LIMIT_PER_HOUR = 10;

  function hourKey(d = new Date()) {
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate() + 'T' + d.getHours();
  }

  function spokeThisHour(bot) {
    const s = bot && bot.spoke;
    return s && s.hour === hourKey() ? s.count : 0;
  }

  /** 记一句；返回 false 表示这小时已经说满了 */
  function countBotSpeech(bot) {
    const key = hourKey();
    if (!bot.spoke || bot.spoke.hour !== key) bot.spoke = { hour: key, count: 0 };
    // 主人解除了限制就只管记数，不拦
    if (!bot.limitOff && bot.spoke.count >= BOT_GROUP_LIMIT_PER_HOUR) return false;
    bot.spoke.count += 1;
    return true;
  }

  /* 主人 @自己的鱼 说「解除发言限制」/「开启发言限制」。
     必须点名（@鱼 或 打出鱼的名字），免得闲聊里一句「不限制」就把开关翻了。
     返回被操作的鱼，没命中就返回 null。 */
  const LIMIT_OFF_RE = /(解除|取消|关掉|关闭|放开)(一下)?(发言)?限制|不限(制)?发言/;
  const LIMIT_ON_RE = /(开启|恢复|打开|重新开启)(一下)?(发言)?限制/;

  function applyBotLimitCommand(sender, roomId, text) {
    const t = String(text || '');
    const wantOff = LIMIT_OFF_RE.test(t);
    const wantOn = !wantOff && LIMIT_ON_RE.test(t);
    if (!wantOff && !wantOn) return null;
    const r = store();
    const mine = roomMembers(roomId)
      .botIds.map((id) => r.bots[id])
      .filter((b) => b && b.ownerId === sender.id);
    if (!mine.length) return null;
    const target = mine.find((b) => t.includes('@' + b.name) || t.includes(b.name));
    if (!target) return null;
    target.limitOff = wantOff;
    return target;
  }

  // 这条鱼现在在哪些群里（给「我的鱼」页面显示用）
  function groupsOfBot(botId) {
    const r = store();
    return Object.values(r.groups)
      .filter((g) => (g.botIds || []).includes(botId))
      .map((g) => ({ id: g.id, name: g.name, roomId: groupRoomId(g.id) }));
  }

  function tokenOf(req, url) {
    const h = req.headers.authorization || '';
    if (h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
    return url.searchParams.get('token') || '';
  }

  function authUser(req, url) {
    const r = store();
    const token = tokenOf(req, url);
    if (!token) return null;
    const sess = r.sessions[token];
    if (!sess) return null;
    if (sess.expiresAt < Date.now()) {
      delete r.sessions[token];
      return null;
    }
    return r.users[sess.userId] || null;
  }

  function newSession(userId) {
    const r = store();
    const token = crypto.randomBytes(24).toString('base64url');
    r.sessions[token] = { userId, createdAt: nowIso(), expiresAt: Date.now() + SESSION_TTL_MS };
    return token;
  }

  function roomMembers(roomId) {
    const r = store();
    if (roomId.startsWith('group:')) {
      const g = r.groups[roomId.slice(6)];
      if (!g) return { userIds: [], botIds: [] };
      return { userIds: g.memberIds || [], botIds: g.botIds || [] };
    }
    if (roomId.startsWith('dm:')) {
      const parts = roomId.slice(3).split('|');
      const bots = parts.filter((id) => r.bots[id]);
      const users = parts.filter((id) => r.users[id]);
      return { userIds: users, botIds: bots };
    }
    return { userIds: [], botIds: [] };
  }

  function canAccess(userId, roomId) {
    return roomMembers(roomId).userIds.includes(userId);
  }

  // 双向成为好友（同意申请、自动同意都走这里）
  function linkFriends(a, b) {
    const r = store();
    r.friends[a] = r.friends[a] || [];
    r.friends[b] = r.friends[b] || [];
    if (!r.friends[a].includes(b)) r.friends[a].push(b);
    if (!r.friends[b].includes(a)) r.friends[b].push(a);
  }

  // 默认群：注册 / 登入时自动入群（用户自己主动退过的除外）
  function joinDefaultGroup(user) {
    if (!user || user.leftDefaultGroup) return null;
    const r = store();
    const g = Object.values(r.groups).find((x) => String(x.no) === DEFAULT_GROUP_NO);
    if (!g) return null;
    g.memberIds = g.memberIds || [];
    if (g.memberIds.includes(user.id)) return g;
    g.memberIds.push(user.id);
    appendMessage(groupRoomId(g.id), {
      id: uid('m'),
      roomId: groupRoomId(g.id),
      kind: 'system',
      senderId: 'system',
      senderName: '系统',
      text: `${displayName(user)} 加入了群`,
      at: nowIso(),
    });
    return g;
  }

  function appendMessage(roomId, msg) {
    const r = store();
    if (!r.messages[roomId]) r.messages[roomId] = [];
    const list = r.messages[roomId];
    list.push(msg);
    if (list.length > MAX_ROOM_MESSAGES) list.splice(0, list.length - MAX_ROOM_MESSAGES);
    // 落地即推送：网页端不用刷新就能看到（用户、鱼、系统消息都走这里）
    try {
      broadcastMessage(roomId, msg);
    } catch {
      /* 推送失败不影响落库 */
    }
    return msg;
  }

  function roomTitle(roomId, viewerId) {
    const r = store();
    if (roomId.startsWith('group:')) {
      const g = r.groups[roomId.slice(6)];
      return g ? g.name : '群聊';
    }
    if (roomId.startsWith('dm:')) {
      const ids = roomId.slice(3).split('|');
      const other = ids.find((i) => i !== viewerId) || ids[0];
      const bot = r.bots[other];
      if (bot) return bot.name;
      const u = r.users[other];
      return u ? displayName(u) : '私聊';
    }
    return '会话';
  }

  function lastMessage(roomId) {
    const r = store();
    const list = r.messages[roomId] || [];
    return list.length ? list[list.length - 1] : null;
  }

  function listRoomsFor(userId) {
    const r = store();
    const out = [];
    for (const fid of r.friends[userId] || []) {
      const u = r.users[fid];
      if (!u) continue;
      const roomId = dmRoomId(userId, fid);
      const last = lastMessage(roomId);
      out.push({
        roomId,
        type: 'dm',
        title: displayName(u),
        peerId: u.id,
        peerUid: u.uid || '',
        peerCrown: !!u.crown,
        online: isOnline(u.id),
        last: last ? { text: last.text, at: last.at, senderName: last.senderName } : null,
        unread: 0,
      });
    }
    // 自己的鱼：单独一条私聊，跟 QQ 里「和机器人对话」一个意思
    for (const bot of Object.values(r.bots)) {
      if (!bot || bot.ownerId !== userId) continue;
      const botRoom = dmRoomId(userId, bot.id);
      const botLast = lastMessage(botRoom);
      out.push({
        roomId: botRoom,
        type: 'dm',
        title: bot.name,
        peerId: bot.id,
        peerUid: '',
        peerCrown: false,
        isBot: true,
        online: sockets.has(bot.id) && !bot.disabled,
        last: botLast ? { text: botLast.text, at: botLast.at, senderName: botLast.senderName } : null,
        unread: 0,
      });
    }
    for (const g of Object.values(r.groups)) {
      if (!(g.memberIds || []).includes(userId)) continue;
      const roomId = groupRoomId(g.id);
      const last = lastMessage(roomId);
      out.push({
        roomId,
        type: 'group',
        title: g.name,
        groupId: g.id,
        groupNo: g.no || '',
        memberCount: (g.memberIds || []).length,
        botCount: (g.botIds || []).length,
        last: last ? { text: last.text, at: last.at, senderName: last.senderName } : null,
        unread: 0,
      });
    }
    out.sort((a, b) => String(b.last ? b.last.at : '').localeCompare(String(a.last ? a.last.at : '')));
    return out;
  }

  /* ------------------------------ 路由处理 ------------------------------ */

  async function handle(req, res, pathname, url) {
    const r = store();
    const method = req.method;

    /* ---- 注册 / 登录 ---- */
    if (pathname === '/api/room/register' && method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      const password = String(body.password || '');
      if (!ACCOUNT_RULE.test(name)) return sendJson(res, 400, { error: { message: '账号要 5 位以上纯数字' } });
      if (!PASSWORD_RULE.test(password)) return sendJson(res, 400, { error: { message: PASSWORD_HINT } });
      const lower = name.toLowerCase();
      if (Object.values(r.users).some((u) => u.nameLower === lower)) {
        return sendJson(res, 409, { error: { message: '这个账号有人用了' } });
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const user = {
        id: uid('u'),
        uid: nextUserNo(r),
        name,
        nameLower: lower,
        salt,
        hash: hashPassword(password, salt),
        autoAcceptFriend: false,
        createdAt: nowIso(),
      };
      r.users[user.id] = user;
      r.friends[user.id] = [];
      joinDefaultGroup(user);
      const token = newSession(user.id);
      await saveDb();
      return sendJson(res, 200, { token, user: publicUser(user) });
    }

    if (pathname === '/api/room/login' && method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user = Object.values(r.users).find((u) => u.nameLower === name);
      if (!user || !safeEqual(hashPassword(password, user.salt), user.hash)) {
        return sendJson(res, 401, { error: { message: '账号或密码不对' } });
      }
      joinDefaultGroup(user);
      const token = newSession(user.id);
      await saveDb();
      return sendJson(res, 200, { token, user: publicUser(user) });
    }

    /* ---- 鱼的回复（用鱼的凭证调，不需要用户登录）---- */
    // DSH 那边只跑一个很薄的适配器：消息进来到这儿，站里用角色卡 + 记忆 + 站里的模型回话。
    if (pathname === '/api/room/reply' && method === 'POST') {
      const h = req.headers.authorization || '';
      const botToken = h.toLowerCase().startsWith('bearer ')
        ? h.slice(7).trim()
        : String(url.searchParams.get('botToken') || '');
      const bot = Object.values(r.bots).find((b) => b.token && safeEqual(b.token, botToken));
      if (!bot) return sendJson(res, 401, { error: { message: '鱼的凭证不对' } });
      const body = await readBody(req);
      const roomId = String(body.room || body.roomId || '');
      const text = String(body.text || '').slice(0, MAX_TEXT);
      if (!roomId || !text.trim()) return sendJson(res, 400, { error: { message: '缺房间或内容' } });
      if (!roomMembers(roomId).botIds.includes(bot.id)) {
        return sendJson(res, 403, { error: { message: '这条鱼不在这个会话里' } });
      }
      // 先看限额，别让接入器白花一次模型的 token
      if (bot.disabled) return sendJson(res, 403, { error: { message: '这条鱼被主人下线了' } });
      if (bot.muted) return sendJson(res, 403, { error: { message: '主人让这条鱼先闭嘴' } });
      if (roomId.startsWith('group:') && !bot.limitOff && spokeThisHour(bot) >= BOT_GROUP_LIMIT_PER_HOUR) {
        return sendJson(res, 429, {
          error: { message: `这条鱼这一小时说满 ${BOT_GROUP_LIMIT_PER_HOUR} 句了` },
          limit: BOT_GROUP_LIMIT_PER_HOUR,
        });
      }
      if (typeof ctx.replyAsBot !== 'function') {
        return sendJson(res, 501, { error: { message: '站里没接模型' } });
      }
      try {
        const out = await ctx.replyAsBot({
          bot,
          roomId,
          text,
          history: (r.messages[roomId] || []).slice(-20),
        });
        return sendJson(res, 200, { text: String((out && out.text) || '') });
      } catch (err) {
        return sendJson(res, 502, { error: { message: err.message || '模型调用失败' } });
      }
    }

    /* ---- 只读访客：凭分享 key 看消息，不需要注册登录 ---- */
    if (pathname === '/api/room/view' && method === 'GET') {
      const key = String(url.searchParams.get('k') || '');
      if (!key) return sendJson(res, 400, { error: { message: '缺 key' } });
      const hit = Object.entries(r.shares).find(([, s]) => s.key && safeEqual(s.key, key));
      if (!hit) return sendJson(res, 404, { error: { message: '这个链接已经失效了' } });
      const roomId = hit[0];
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 120)));
      const list = (r.messages[roomId] || []).slice(-limit);
      const members = roomMembers(roomId);
      const type = roomId.split(':')[0];
      const title = type === 'group' ? roomTitle(roomId, '') : '私聊';
      return sendJson(res, 200, {
        room: { id: roomId, title, type },
        messages: list,
        members: members.userIds.map((id) => publicUser(r.users[id])).filter(Boolean),
        bots: members.botIds.map((id) => publicBot(r.bots[id])).filter(Boolean),
      });
    }

    const me = authUser(req, url);
    if (!me) return sendJson(res, 401, { error: { message: '先登录' } });

    /* ---- 只读分享：给一条不用注册就能看的链接 ---- */
    if (pathname === '/api/room/share' && method === 'GET') {
      const roomId = String(url.searchParams.get('room') || '');
      if (!canAccess(me.id, roomId)) return sendJson(res, 403, { error: { message: '进不去这个会话' } });
      const s = r.shares[roomId];
      return sendJson(res, 200, { key: s ? s.key : '', room: roomId });
    }
    if (pathname === '/api/room/share' && method === 'POST') {
      const body = await readBody(req);
      const roomId = String(body.room || '');
      if (!canAccess(me.id, roomId)) return sendJson(res, 403, { error: { message: '进不去这个会话' } });
      let s = r.shares[roomId];
      if (!s) {
        s = { key: crypto.randomBytes(9).toString('base64url'), by: me.id, at: nowIso() };
        r.shares[roomId] = s;
        await saveDb();
      }
      return sendJson(res, 200, { key: s.key, room: roomId });
    }
    if (pathname === '/api/room/share' && method === 'DELETE') {
      const roomId = String(url.searchParams.get('room') || '');
      if (!canAccess(me.id, roomId)) return sendJson(res, 403, { error: { message: '进不去这个会话' } });
      delete r.shares[roomId];
      await saveDb();
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/room/me' && method === 'GET') {
      return sendJson(res, 200, {
        user: publicUser(me),
        rooms: listRoomsFor(me.id),
        friendCount: (r.friends[me.id] || []).length,
        bots: Object.values(r.bots).filter((b) => b.ownerId === me.id).map(publicBot),
        incoming: Object.values(r.friendRequests)
          .filter((q) => q.toId === me.id && q.status === 'pending')
          .map((q) => {
            const from = r.users[q.fromId];
            return Object.assign({}, q, {
              kind: 'friend',
              fromName: from ? displayName(from) : '有人',
              fromUid: from ? from.uid || '' : '',
            });
          }),
        invites: Object.values(r.invites).filter(
          (i) => i.status === 'pending' && r.bots[i.botId] && r.bots[i.botId].ownerId === me.id,
        ),
      });
    }

    /* ---- 改密码 ---- */
    if (pathname === '/api/room/password' && method === 'POST') {
      const body = await readBody(req);
      const oldPassword = String(body.oldPassword || '');
      const newPassword = String(body.newPassword || '');
      if (!safeEqual(hashPassword(oldPassword, me.salt), me.hash)) {
        return sendJson(res, 400, { error: { message: '原密码不对' } });
      }
      if (!PASSWORD_RULE.test(newPassword)) {
        return sendJson(res, 400, { error: { message: PASSWORD_HINT } });
      }
      me.salt = crypto.randomBytes(16).toString('hex');
      me.hash = hashPassword(newPassword, me.salt);
      // 改完密码把其他设备的登录踢掉，只留当前这个
      const current = tokenOf(req, url);
      for (const [tk, s] of Object.entries(r.sessions)) {
        if (s.userId === me.id && tk !== current) delete r.sessions[tk];
      }
      await saveDb();
      return sendJson(res, 200, { ok: true });
    }

    /* ---- 找人 / 好友 ---- */
    // 按 uid（6 位数字）或账号搜人；uid 是精确匹配，账号支持包含匹配
    if (pathname === '/api/room/users' && method === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 200, { users: [] });
      const lower = q.toLowerCase();
      const isUid = /^[0-9]{4,10}$/.test(q);
      const list = Object.values(r.users)
        .filter((u) => {
          if (u.id === me.id) return false;
          if (isUid && String(u.uid || '') === q) return true;
          return u.nameLower.includes(lower);
        })
        .slice(0, 20)
        .map((u) => Object.assign(publicUser(u), { isFriend: (r.friends[me.id] || []).includes(u.id) }));
      return sendJson(res, 200, { users: list });
    }

    // 加好友：body 可以传 { uid } 或 { name }
    if (pathname === '/api/room/friends' && method === 'POST') {
      const body = await readBody(req);
      const byUid = String(body.uid || '').trim();
      const byName = String(body.name || '').trim().toLowerCase();
      let target = null;
      if (byUid) {
        target = Object.values(r.users).find((u) => String(u.uid || '') === byUid) || null;
      } else if (byName) {
        target = Object.values(r.users).find((u) => u.nameLower === byName) || null;
      }
      if (!target) return sendJson(res, 404, { error: { message: '没找到这个人，核对一下UID或账号' } });
      if (target.id === me.id) return sendJson(res, 400, { error: { message: '不能加自己' } });
      if ((r.friends[me.id] || []).includes(target.id)) {
        return sendJson(res, 200, { ok: true, already: true, roomId: dmRoomId(me.id, target.id) });
      }
      // 对方开了「自动同意」就直接成为好友
      if (target.autoAcceptFriend) {
        linkFriends(me.id, target.id);
        await saveDb();
        return sendJson(res, 200, {
          ok: true,
          auto: true,
          roomId: dmRoomId(me.id, target.id),
          target: publicUser(target),
        });
      }
      const dup = Object.values(r.friendRequests).find(
        (q) => q.fromId === me.id && q.toId === target.id && q.status === 'pending',
      );
      if (dup) return sendJson(res, 200, { ok: true, pending: true });
      const reqId = uid('f');
      r.friendRequests[reqId] = { id: reqId, fromId: me.id, toId: target.id, status: 'pending', createdAt: nowIso() };
      await saveDb();
      return sendJson(res, 200, { ok: true, pending: true });
    }

    // 设置：自动同意好友申请 + 改昵称
    if (pathname === '/api/room/settings' && method === 'POST') {
      const body = await readBody(req);
      if (typeof body.autoAcceptFriend === 'boolean') me.autoAcceptFriend = body.autoAcceptFriend;
      if (typeof body.nick === 'string') {
        const nick = body.nick.trim().slice(0, 16);
        if (!nick) return sendJson(res, 400, { error: { message: '昵称不能空' } });
        me.nick = nick;
      }
      await saveDb();
      return sendJson(res, 200, { ok: true, user: publicUser(me) });
    }

    if (pathname === '/api/room/friends/respond' && method === 'POST') {
      const body = await readBody(req);
      const q = r.friendRequests[String(body.id || '')];
      if (!q || q.toId !== me.id || q.status !== 'pending') {
        return sendJson(res, 404, { error: { message: '没有这个申请' } });
      }
      q.status = body.accept ? 'accepted' : 'declined';
      if (body.accept) linkFriends(me.id, q.fromId);
      await saveDb();
      return sendJson(res, 200, { ok: true });
    }

    /* ---- 群组 ---- */
    if (pathname === '/api/room/groups' && method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim();
      if (!name) return sendJson(res, 400, { error: { message: '群名不能空' } });
      const g = {
        id: uid('g'),
        no: nextGroupNo(r),
        name: name.slice(0, 30),
        ownerId: me.id,
        memberIds: [me.id],
        botIds: [],
        createdAt: nowIso(),
      };
      r.groups[g.id] = g;
      await saveDb();
      return sendJson(res, 200, { group: g, roomId: groupRoomId(g.id) });
    }

    /* ---- 按群号搜群 / 加群 ---- */
    if (pathname === '/api/room/groups/search' && method === 'GET') {
      const q = String(url.searchParams.get('q') || '').trim();
      if (!q) return sendJson(res, 200, { groups: [] });
      const isNo = /^[0-9]{4,10}$/.test(q);
      const list = Object.values(r.groups)
        .filter((g) => (isNo ? String(g.no || '') === q : g.name.toLowerCase().includes(q.toLowerCase())))
        .slice(0, 20)
        .map((g) => ({
          id: g.id,
          no: g.no || '',
          name: g.name,
          memberCount: (g.memberIds || []).length,
          joined: (g.memberIds || []).includes(me.id),
        }));
      return sendJson(res, 200, { groups: list });
    }

    const joinMatch = pathname.match(/^\/api\/room\/groups\/([\w-]+)\/join$/);
    if (joinMatch && method === 'POST') {
      const g = r.groups[joinMatch[1]];
      if (!g) return sendJson(res, 404, { error: { message: '没有这个群，核对一下群号' } });
      if ((g.memberIds || []).includes(me.id)) {
        return sendJson(res, 200, { ok: true, already: true, roomId: groupRoomId(g.id) });
      }
      g.memberIds = g.memberIds || [];
      g.memberIds.push(me.id);
      appendMessage(groupRoomId(g.id), {
        id: uid('m'),
        roomId: groupRoomId(g.id),
        kind: 'system',
        senderId: 'system',
        senderName: '系统',
        text: `${displayName(me)} 加入了群`,
        at: nowIso(),
      });
      await saveDb();
      return sendJson(res, 200, { ok: true, roomId: groupRoomId(g.id), group: g });
    }

    const groupMatch = pathname.match(/^\/api\/room\/groups\/([\w-]+)$/);
    if (groupMatch && method === 'GET') {
      const g = r.groups[groupMatch[1]];
      if (!g || !(g.memberIds || []).includes(me.id)) return sendJson(res, 404, { error: { message: '没有这个群' } });
      const myRole = roleOf(g, me.id);
      return sendJson(res, 200, {
        group: Object.assign({}, g, {
          myNick: (g.nicks && g.nicks[me.id]) || '',
          remark: (g.remarks && g.remarks[me.id]) || '',
          myTitle: (g.titles && g.titles[me.id]) || '',
          myBadge: (g.badges && g.badges[me.id]) || '',
          isOwner: g.ownerId === me.id,
          myRole,
          notice: g.notice || '',
        }),
        members: (g.memberIds || [])
          .map((id) => {
            const u = publicUser(r.users[id]);
            if (!u) return null;
            u.title = (g.titles && g.titles[id]) || '';
            u.badge = (g.badges && g.badges[id]) || '';
            u.role = roleOf(g, id);
            u.mutedUntil = (g.muted && g.muted[id]) || 0;
            return u;
          })
          .filter(Boolean),
        bots: (g.botIds || []).map((id) => publicBot(r.bots[id])).filter(Boolean),
      });
    }

    /* ---- 群设置：群名 / 群公告 / 我在本群的昵称 / 群备注 ---- */
    if (groupMatch && method === 'POST') {
      const g = r.groups[groupMatch[1]];
      if (!g || !(g.memberIds || []).includes(me.id)) return sendJson(res, 404, { error: { message: '没有这个群' } });
      const body = await readBody(req);
      const isOwner = g.ownerId === me.id;
      if (typeof body.name === 'string' && body.name.trim()) {
        if (!isOwner) return sendJson(res, 403, { error: { message: '只有群主能改群名' } });
        g.name = body.name.trim().slice(0, 30);
        appendMessage(groupRoomId(g.id), {
          id: uid('m'),
          roomId: groupRoomId(g.id),
          kind: 'system',
          senderId: 'system',
          senderName: '系统',
          text: `群名改成了「${g.name}」`,
          at: nowIso(),
        });
      }
      if (typeof body.notice === 'string') {
        if (!isOwner) return sendJson(res, 403, { error: { message: '只有群主能改群公告' } });
        g.notice = body.notice.slice(0, 600);
      }
      if (typeof body.myNick === 'string') {
        g.nicks = g.nicks || {};
        g.nicks[me.id] = body.myNick.trim().slice(0, 16);
      }
      if (typeof body.remark === 'string') {
        g.remarks = g.remarks || {};
        g.remarks[me.id] = body.remark.trim().slice(0, 20);
      }
      /* 个性设置：群头衔 + 标识佩戴（自己的，谁都能设自己的） */
      if (typeof body.myTitle === 'string') {
        g.titles = g.titles || {};
        const t = body.myTitle.trim().slice(0, 12);
        if (t) g.titles[me.id] = t;
        else delete g.titles[me.id];
      }
      if (typeof body.myBadge === 'string') {
        g.badges = g.badges || {};
        const b = body.myBadge.trim();
        if (b && BADGES.includes(b)) g.badges[me.id] = b;
        else delete g.badges[me.id];
      }
      await saveDb();
      return sendJson(res, 200, { ok: true, group: g });
    }

    /* ---- 群成员管理：设/撤管理员、禁言、移出（跟 QQ 群一样，群主说了算） ---- */
    const memberActMatch = pathname.match(/^\/api\/room\/groups\/([\w-]+)\/members\/([\w-]+)$/);
    if (memberActMatch && method === 'POST') {
      const g = r.groups[memberActMatch[1]];
      if (!g || !(g.memberIds || []).includes(me.id)) return sendJson(res, 404, { error: { message: '没有这个群' } });
      if (!canManage(g, me.id)) return sendJson(res, 403, { error: { message: '只有群主能管人' } });
      const targetId = memberActMatch[2];
      if (!(g.memberIds || []).includes(targetId)) return sendJson(res, 404, { error: { message: '这人不在群里' } });
      if (targetId === g.ownerId) return sendJson(res, 403, { error: { message: '群主不能被管' } });
      const body = await readBody(req);
      const act = String(body.act || '');
      const tu = r.users[targetId];
      const tname = displayName(tu) || '有人';
      const sys = (text) =>
        appendMessage(groupRoomId(g.id), {
          id: uid('m'),
          roomId: groupRoomId(g.id),
          kind: 'system',
          senderId: 'system',
          senderName: '系统',
          text,
          at: nowIso(),
        });
      if (act === 'setAdmin') {
        g.adminIds = g.adminIds || [];
        if (!g.adminIds.includes(targetId)) g.adminIds.push(targetId);
        sys(`${tname} 被设为管理员`);
      } else if (act === 'unsetAdmin') {
        g.adminIds = (g.adminIds || []).filter((id) => id !== targetId);
        sys(`${tname} 的管理员被撤了`);
      } else if (act === 'mute') {
        g.muted = g.muted || {};
        const mins = Math.max(0, Math.min(1440, Number(body.minutes) || 0));
        if (mins > 0) {
          g.muted[targetId] = Date.now() + mins * 60000;
          sys(`${tname} 被禁言 ${mins} 分钟`);
        } else {
          delete g.muted[targetId];
          sys(`${tname} 的禁言解除了`);
        }
      } else if (act === 'kick') {
        g.memberIds = (g.memberIds || []).filter((id) => id !== targetId);
        g.adminIds = (g.adminIds || []).filter((id) => id !== targetId);
        if (g.muted) delete g.muted[targetId];
        if (g.nicks) delete g.nicks[targetId];
        if (g.titles) delete g.titles[targetId];
        if (g.badges) delete g.badges[targetId];
        sys(`${tname} 被移出了群`);
      } else {
        return sendJson(res, 400, { error: { message: '不认识这个操作' } });
      }
      await saveDb();
      return sendJson(res, 200, { ok: true });
    }

    /* ---- 退出群聊 ---- */
    const leaveMatch = pathname.match(/^\/api\/room\/groups\/([\w-]+)\/leave$/);
    if (leaveMatch && method === 'POST') {
      const g = r.groups[leaveMatch[1]];
      if (!g || !(g.memberIds || []).includes(me.id)) return sendJson(res, 404, { error: { message: '没有这个群' } });
      g.memberIds = g.memberIds.filter((id) => id !== me.id);
      // 主动退的是默认群：记一笔，别再被自动拉回去
      if (String(g.no) === DEFAULT_GROUP_NO) me.leftDefaultGroup = true;
      if (g.nicks) delete g.nicks[me.id];
      if (g.remarks) delete g.remarks[me.id];
      appendMessage(groupRoomId(g.id), {
        id: uid('m'),
        roomId: groupRoomId(g.id),
        kind: 'system',
        senderId: 'system',
        senderName: '系统',
        text: `${displayName(me)} 退出了群`,
        at: nowIso(),
      });
      await saveDb();
      return sendJson(res, 200, { ok: true });
    }

    /* ---- 查找聊天记录 ---- */
    if (pathname === '/api/room/search' && method === 'GET') {
      const roomId = String(url.searchParams.get('room') || '');
      const q = String(url.searchParams.get('q') || '').trim();
      if (!canAccess(me.id, roomId)) return sendJson(res, 403, { error: { message: '进不去这个会话' } });
      if (!q) return sendJson(res, 200, { hits: [] });
      const lower = q.toLowerCase();
      const hits = (r.messages[roomId] || [])
        .filter((m) => String(m.text || '').toLowerCase().includes(lower))
        .slice(-60)
        .reverse()
        .map((m) => ({ id: m.id, text: m.text, senderName: m.senderName, at: m.at }));
      return sendJson(res, 200, { hits });
    }

    const memberMatch = pathname.match(/^\/api\/room\/groups\/([\w-]+)\/members$/);
    if (memberMatch && method === 'POST') {
      const g = r.groups[memberMatch[1]];
      if (!g || !(g.memberIds || []).includes(me.id)) return sendJson(res, 404, { error: { message: '没有这个群' } });
      const body = await readBody(req);
      // 拉人按UID（6 位数字）找，老的按账号名也留着，别把人挡在外面
      const raw = String(body.uid || body.name || '').trim();
      if (!raw) return sendJson(res, 400, { error: { message: '填一下对方的UID' } });
      const target = /^[0-9]{4,10}$/.test(raw)
        ? Object.values(r.users).find((u) => String(u.uid || '') === raw)
        : Object.values(r.users).find((u) => u.nameLower === raw.toLowerCase());
      if (!target) return sendJson(res, 404, { error: { message: '没找到这个人，核对一下UID' } });
      if (!(g.memberIds || []).includes(target.id)) {
        g.memberIds.push(target.id);
        appendMessage(groupRoomId(g.id), {
          id: uid('m'),
          roomId: groupRoomId(g.id),
          kind: 'system',
          senderId: 'system',
          senderName: '系统',
          text: `${displayName(me)} 把 ${displayName(target)} 拉进了群`,
          at: nowIso(),
        });
        await saveDb();
      }
      return sendJson(res, 200, { ok: true });
    }

    /* ---- 拉鱼进群：先发邀请，等主人确认 ---- */
    const botInviteMatch = pathname.match(/^\/api\/room\/groups\/([\w-]+)\/bots$/);
    if (botInviteMatch && method === 'POST') {
      const g = r.groups[botInviteMatch[1]];
      if (!g || !(g.memberIds || []).includes(me.id)) return sendJson(res, 404, { error: { message: '没有这个群' } });
      const body = await readBody(req);
      const bot = r.bots[String(body.botId || '')];
      if (!bot) return sendJson(res, 404, { error: { message: '没这条鱼' } });
      if ((g.botIds || []).includes(bot.id)) return sendJson(res, 200, { ok: true, already: true });
      // 自己拉自己的鱼：直接进群，不用再确认一次
      // （那套「等主人确认」是给「别人想拉你的鱼」用的，自己点的没必要再问自己）
      if (bot.ownerId === me.id) {
        g.botIds = g.botIds || [];
        g.botIds.push(bot.id);
        appendMessage(groupRoomId(g.id), {
          id: uid('m'),
          roomId: groupRoomId(g.id),
          kind: 'system',
          senderId: 'system',
          senderName: '系统',
          text: `${bot.name} 进群了`,
          at: nowIso(),
        });
        pushToBot(bot.id, { type: 'joined', roomId: groupRoomId(g.id), groupId: g.id, groupName: g.name });
        await saveDb();
        return sendJson(res, 200, { ok: true, joined: true });
      }
      const dup = Object.values(r.invites).find(
        (i) => i.groupId === g.id && i.botId === bot.id && i.status === 'pending' && i.expiresAt > Date.now(),
      );
      if (dup) return sendJson(res, 200, { ok: true, invite: dup, pending: true });
      const inv = {
        id: uid('inv'),
        groupId: g.id,
        groupName: g.name,
        botId: bot.id,
        invitedBy: me.id,
        invitedByName: me.name,
        status: 'pending',
        createdAt: nowIso(),
        expiresAt: Date.now() + INVITE_TTL_MS,
      };
      r.invites[inv.id] = inv;
      pushToBot(bot.id, {
        type: 'invite',
        invite: {
          id: inv.id,
          groupId: g.id,
          groupName: g.name,
          invitedBy: me.name,
          expiresAt: new Date(inv.expiresAt).toISOString(),
        },
      });
      await saveDb();
      return sendJson(res, 200, { ok: true, invite: inv, pending: true });
    }

    /* ---- 邀请确认（网页端，主人自己点） ---- */
    if (pathname === '/api/room/invites' && method === 'GET') {
      const list = Object.values(r.invites).filter((i) => {
        const bot = r.bots[i.botId];
        return bot && bot.ownerId === me.id && i.status === 'pending' && i.expiresAt > Date.now();
      });
      return sendJson(res, 200, { invites: list });
    }

    const inviteMatch = pathname.match(/^\/api\/room\/invites\/([\w-]+)\/respond$/);
    if (inviteMatch && method === 'POST') {
      const body = await readBody(req);
      const result = await respondInvite(inviteMatch[1], me.id, Boolean(body.approve));
      if (!result.ok) return sendJson(res, 400, { error: { message: result.message } });
      return sendJson(res, 200, { ok: true, status: result.status });
    }

    /* ---- 鱼（bot）管理 ---- */
    if (pathname === '/api/room/bots' && method === 'GET') {
      return sendJson(res, 200, {
        bots: Object.values(r.bots)
          .filter((b) => b.ownerId === me.id)
          .map((b) => Object.assign(publicBot(b, true), { groups: groupsOfBot(b.id) })),
        ws: '/api/room/ws',
      });
    }
    if (pathname === '/api/room/bots' && method === 'POST') {
      const body = await readBody(req);
      const name = String(body.name || '').trim().slice(0, 20) || '小鱼';
      const bot = {
        id: uid('bot'),
        name,
        ownerId: me.id,
        token: crypto.randomBytes(24).toString('base64url'),
        createdAt: nowIso(),
      };
      r.bots[bot.id] = bot;
      await saveDb();
      return sendJson(res, 200, { bot: publicBot(bot), token: bot.token, ws: '/api/room/ws' });
    }
    const botMatch = pathname.match(/^\/api\/room\/bots\/([\w-]+)$/);
    if (botMatch && method === 'POST') {
      // 鱼主人手里的开关：闭嘴/开口、下线/上线
      const bot = r.bots[botMatch[1]];
      if (!bot || bot.ownerId !== me.id) return sendJson(res, 404, { error: { message: '没这条鱼' } });
      const body = await readBody(req);
      if (typeof body.muted === 'boolean') {
        bot.muted = body.muted;
        pushToBot(bot.id, { type: 'state', muted: !!bot.muted, disabled: !!bot.disabled, limitOff: !!bot.limitOff });
      }
      if (typeof body.disabled === 'boolean') {
        bot.disabled = body.disabled;
        pushToBot(bot.id, { type: 'state', muted: !!bot.muted, disabled: !!bot.disabled, limitOff: !!bot.limitOff });
        if (bot.disabled) {
          const sock = sockets.get(bot.id);
          if (sock) {
            try {
              send(sock, { type: 'error', message: '主人把这条鱼下线了' });
              sock.end();
            } catch {
              /* ignore */
            }
            sockets.delete(bot.id);
          }
        }
      }
      // 网页上也能直接开关每小时 10 句的限制（跟 @鱼 说一句等效）
      if (typeof body.limitOff === 'boolean') {
        bot.limitOff = body.limitOff;
        pushToBot(bot.id, { type: 'state', muted: !!bot.muted, disabled: !!bot.disabled, limitOff: !!bot.limitOff });
      }
      await saveDb();
      return sendJson(res, 200, { bot: publicBot(bot, true) });
    }

    if (botMatch && method === 'DELETE') {
      const bot = r.bots[botMatch[1]];
      if (!bot || bot.ownerId !== me.id) return sendJson(res, 404, { error: { message: '没这条鱼' } });
      const sock = sockets.get(bot.id);
      if (sock) {
        try {
          sock.end();
        } catch {
          /* ignore */
        }
        sockets.delete(bot.id);
      }
      delete r.bots[bot.id];
      await saveDb();
      return sendJson(res, 200, { ok: true });
    }

    /* ---- 消息 ---- */
    if (pathname === '/api/room/messages' && method === 'GET') {
      const roomId = String(url.searchParams.get('room') || '');
      if (!canAccess(me.id, roomId)) return sendJson(res, 403, { error: { message: '进不去这个会话' } });
      const limit = Math.min(300, Math.max(1, Number(url.searchParams.get('limit') || 100)));
      const list = (r.messages[roomId] || []).slice(-limit);
      const members = roomMembers(roomId);
      const g = roomId.startsWith('group:') ? r.groups[roomId.slice(6)] : null;
      return sendJson(res, 200, {
        room: {
          id: roomId,
          title: roomTitle(roomId, me.id),
          type: roomId.split(':')[0],
          groupNo: g ? g.no || '' : '',
        },
        messages: list,
        members: members.userIds.map((id) => publicUser(r.users[id])).filter(Boolean),
        bots: members.botIds.map((id) => publicBot(r.bots[id])).filter(Boolean),
      });
    }

    if (pathname === '/api/room/messages' && method === 'POST') {
      const body = await readBody(req);
      const roomId = String(body.room || '');
      if (!canAccess(me.id, roomId)) return sendJson(res, 403, { error: { message: '进不去这个会话' } });
      if (roomId.startsWith('group:')) {
        const g = r.groups[roomId.slice(6)];
        if (g && roleOf(g, me.id) === 'member' && isMuted(g, me.id)) {
          const left = Math.ceil((g.muted[me.id] - Date.now()) / 60000);
          return sendJson(res, 403, { error: { message: `你被禁言了，还有 ${left} 分钟` } });
        }
      }
      const text = String(body.text || '').slice(0, MAX_TEXT);
      if (!text.trim()) return sendJson(res, 400, { error: { message: '空消息' } });
      const msg = {
        id: uid('m'),
        roomId,
        kind: 'user',
        senderId: me.id,
        senderName: displayName(me),
        text,
        at: nowIso(),
      };
      appendMessage(roomId, msg);
      // 主人 @自己的鱼 说「解除发言限制 / 开启发言限制」——在这儿就把开关翻掉，
      // 并且不再把这条命令转给鱼，免得它自己去回一句废话。
      let limitCmd = null;
      if (roomId.startsWith('group:')) {
        try {
          limitCmd = applyBotLimitCommand(me, roomId, text);
        } catch {
          limitCmd = null;
        }
      }
      if (limitCmd) {
        pushToBot(limitCmd.id, { type: 'state', muted: !!limitCmd.muted, disabled: !!limitCmd.disabled, limitOff: !!limitCmd.limitOff });
        appendMessage(roomId, {
          id: uid('m'),
          roomId,
          kind: 'system',
          senderId: 'system',
          senderName: '系统',
          text: limitCmd.limitOff
            ? `${displayName(me)} 解除了 ${limitCmd.name} 的发言限制`
            : `${displayName(me)} 给 ${limitCmd.name} 重新开启了发言限制`,
          at: nowIso(),
        });
      } else {
        for (const botId of botsInRoom(roomId)) {
          pushToBot(botId, { type: 'message', roomId, roomType: roomId.split(':')[0], message: msg });
        }
      }
      await saveDb();
      return sendJson(res, 200, { message: msg, botLimit: limitCmd ? { id: limitCmd.id, limitOff: !!limitCmd.limitOff } : null });
    }

    return sendJson(res, 404, { error: { message: '接口不存在' } });
  }

  async function respondInvite(inviteId, ownerId, approve) {
    const r = store();
    const inv = r.invites[inviteId];
    if (!inv) return { ok: false, message: '没有这个邀请' };
    const bot = r.bots[inv.botId];
    if (!bot || bot.ownerId !== ownerId) return { ok: false, message: '这条鱼不是你的' };
    if (inv.status !== 'pending') return { ok: false, message: '这个邀请已经处理过了' };
    if (inv.expiresAt < Date.now()) {
      inv.status = 'expired';
      return { ok: false, message: '邀请过期了' };
    }
    inv.status = approve ? 'accepted' : 'declined';
    inv.respondedAt = nowIso();
    const g = r.groups[inv.groupId];
    if (approve && g) {
      g.botIds = g.botIds || [];
      if (!g.botIds.includes(bot.id)) g.botIds.push(bot.id);
      appendMessage(groupRoomId(g.id), {
        id: uid('m'),
        roomId: groupRoomId(g.id),
        kind: 'system',
        senderId: 'system',
        senderName: '系统',
        text: `${bot.name} 进群了`,
        at: nowIso(),
      });
      pushToBot(bot.id, { type: 'joined', roomId: groupRoomId(g.id), groupId: g.id, groupName: g.name });
    } else {
      pushToBot(bot.id, { type: 'invite-declined', inviteId: inv.id });
    }
    await saveDb();
    return { ok: true, status: inv.status };
  }

  /* --------------------------- WebSocket 接入 --------------------------- */

  function attachWS(server) {
    server.on('upgrade', (req, socket, head) => {
      let url;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        socket.destroy();
        return;
      }
      if (url.pathname !== '/api/room/ws') {
        socket.destroy();
        return;
      }
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.destroy();
        return;
      }
      const token = url.searchParams.get('token') || '';
      const r = store();
      const bot = Object.values(r.bots).find((b) => b.token && safeEqual(b.token, token));
      if (!bot) {
        // 不是鱼的凭证，就当成网页用户：用登录会话 token 认人，拿到实时消息
        const sess = token ? r.sessions[token] : null;
        if (!sess || !r.users[sess.userId]) {
          socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        const accept = wsAcceptKey(key);
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
            `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
        );
        const userId = sess.userId;
        if (!userSockets.has(userId)) userSockets.set(userId, new Set());
        userSockets.get(userId).add(socket);
        let dropped = false;
        const dropUser = () => {
          if (dropped) return;
          dropped = true;
          const set = userSockets.get(userId);
          if (set) {
            set.delete(socket);
            if (!set.size) userSockets.delete(userId);
          }
          try {
            broadcastPresence(userId);
          } catch {
            /* 广播失败不影响断开 */
          }
        };
        send(socket, { type: 'hello', userId });
        try {
          broadcastPresence(userId);
        } catch {
          /* ignore */
        }
        const pushUser = createFrameParser(
          (text) => {
            let data;
            try {
              data = JSON.parse(text);
            } catch {
              return;
            }
            // 心跳：网页端 25 秒发一次 ping，防 Cloudflare 掐空闲连接
            if (data && data.type === 'ping') send(socket, { type: 'pong', at: nowIso() });
          },
          (payload) => {
            try {
              socket.write(encodeFrame(0xa, payload));
            } catch {
              /* ignore */
            }
          },
          () => {
            dropUser();
            try {
              socket.end();
            } catch {
              /* ignore */
            }
          },
        );
        socket.on('data', pushUser);
        socket.on('error', dropUser);
        socket.on('close', dropUser);
        if (head && head.length) pushUser(head);
        return;
      }
      if (bot.disabled) {
        // 主人把这条鱼下线了：连也不让它连，免得接入器一断一重连刷日志
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      const accept = wsAcceptKey(key);
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const prev = sockets.get(bot.id);
      if (prev) {
        try {
          prev.end();
        } catch {
          /* ignore */
        }
      }
      sockets.set(bot.id, socket);
      console.log(`[room] bot 上线: ${bot.name} (${bot.id})`);

      send(socket, {
        type: 'hello',
        bot: publicBot(bot),
        groups: Object.values(r.groups)
          .filter((g) => (g.botIds || []).includes(bot.id))
          .map((g) => ({ id: g.id, name: g.name, roomId: groupRoomId(g.id) })),
      });

      const push = createFrameParser(
        (text) => {
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            return;
          }
          handleBotFrame(bot.id, data, socket).catch((err) => console.error('[room] bot 帧处理失败:', err.message));
        },
        (payload) => {
          try {
            socket.write(encodeFrame(0xa, payload));
          } catch {
            /* ignore */
          }
        },
        () => {
          sockets.delete(bot.id);
          try {
            socket.end();
          } catch {
            /* ignore */
          }
          console.log(`[room] bot 下线: ${bot.name}`);
        },
      );
      socket.on('data', push);
      socket.on('error', () => {
        sockets.delete(bot.id);
      });
      socket.on('close', () => {
        if (sockets.get(bot.id) === socket) sockets.delete(bot.id);
      });
      if (head && head.length) push(head);
    });
  }

  async function handleBotFrame(botId, data, socket) {
    const r = store();
    const bot = r.bots[botId];
    if (!bot) return;

    if (data.type === 'ping') {
      send(socket, { type: 'pong', at: nowIso() });
      return;
    }

    if (data.type === 'send') {
      const roomId = String(data.roomId || data.room || '');
      const members = roomMembers(roomId);
      if (!members.botIds.includes(botId)) {
        send(socket, { type: 'error', message: '这条鱼不在这个会话里', roomId });
        return;
      }
      if (bot.disabled) {
        send(socket, { type: 'error', message: '这条鱼被主人下线了', roomId });
        return;
      }
      if (bot.muted) {
        send(socket, { type: 'error', message: '主人让这条鱼先闭嘴', roomId });
        return;
      }
      const text = String(data.text || '').slice(0, MAX_TEXT);
      if (!text.trim()) return;
      // 群里一小时最多 10 句；私聊不限制。超了静默丢掉并告诉接入器，别刷屏。
      // 主人说过「解除发言限制」就只管记数，不再拦。
      if (roomId.startsWith('group:') && !bot.limitOff) {
        if (!countBotSpeech(bot)) {
          send(socket, {
            type: 'limited',
            roomId,
            limit: BOT_GROUP_LIMIT_PER_HOUR,
            message: `这条鱼这一小时说满 ${BOT_GROUP_LIMIT_PER_HOUR} 句了`,
          });
          await saveDb();
          return;
        }
      }
      const msg = {
        id: uid('m'),
        roomId,
        kind: 'bot',
        senderId: bot.id,
        senderName: bot.name,
        text,
        at: nowIso(),
      };
      appendMessage(roomId, msg);
      for (const other of botsInRoom(roomId)) {
        if (other !== botId) pushToBot(other, { type: 'message', roomId, roomType: roomId.split(':')[0], message: msg });
      }
      await saveDb();
      return;
    }

    if (data.type === 'confirm-invite') {
      const inv = r.invites[String(data.inviteId || '')];
      if (!inv || inv.botId !== botId) {
        send(socket, { type: 'error', message: '没有这个邀请' });
        return;
      }
      const result = await respondInvite(inv.id, bot.ownerId, Boolean(data.approve));
      send(socket, { type: 'confirm-result', inviteId: inv.id, ...result });
      return;
    }

    if (data.type === 'history') {
      const roomId = String(data.roomId || '');
      const members = roomMembers(roomId);
      if (!members.botIds.includes(botId)) {
        send(socket, { type: 'error', message: '这条鱼不在这个会话里' });
        return;
      }
      const limit = Math.min(200, Math.max(1, Number(data.limit || 50)));
      send(socket, { type: 'history', roomId, messages: (r.messages[roomId] || []).slice(-limit) });
    }
  }

  function state() {
    const r = store();
    return {
      users: Object.keys(r.users).length,
      groups: Object.keys(r.groups).length,
      bots: Object.keys(r.bots).length,
      online: sockets.size,
    };
  }

  return { handle, attachWS, state, respondInvite };
}

module.exports = { createRoom, ensureStore, dmRoomId, groupRoomId };
