'use strict';
/* 我的鱼：建鱼、看在线状态、复制接入凭证、拉进群。零依赖，只跟 /api/room/* 说话 */

const $ = (s) => document.querySelector(s);
const TOKEN_KEY = 'room-token';
// 允许 ?token=xxx 直接进（手机上从聊天室跳过来时省一次登录）
const urlToken = new URLSearchParams(location.search).get('token') || '';
if (urlToken) {
  localStorage.setItem(TOKEN_KEY, urlToken);
  history.replaceState(null, '', location.pathname);
}
const token = localStorage.getItem(TOKEN_KEY) || '';

const state = { me: null, bots: [], groups: [] };

if (!token) location.replace('/login');

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  const res = await fetch(path, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    location.replace('/login');
    throw new Error('先登录');
  }
  if (!res.ok) throw new Error((data.error && data.error.message) || '请求失败 ' + res.status);
  return data;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(text) {
  const box = $('#hintBar');
  if (!box) return;
  box.hidden = false;
  box.textContent = text;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (box.hidden = true), 2600);
}

/* 选中并复制：execCommand 兜底（老浏览器 / 非安全上下文 / 无剪贴板权限时用） */
function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  return ok;
}

async function copy(text, okText) {
  let done = false;
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      done = true;
    } catch {
      done = false;
    }
  }
  if (!done) done = legacyCopy(text);
  toast(done ? okText || '复制好了' : '复制不了，长按选中吧');
  return done;
}

/* 复制失败时的兜底：弹一个已全选的框，让用户自己长按复制 */
function showText(title, text, tip) {
  openModal(
    title,
    (tip ? '<div class="modal-tip">' + tip + '</div>' : '') +
      '<textarea class="token-box" id="fallbackBox" readonly>' +
      esc(text) +
      '</textarea>' +
      '<div class="modal-tip">点一下框里的内容，全选后复制。</div>',
    async () => {},
    '知道了',
  );
  const box = document.getElementById('fallbackBox');
  if (box) {
    box.focus();
    box.select();
  }
}

function wsUrl(t) {
  return location.origin.replace(/^http/, 'ws') + '/api/room/ws?token=' + t;
}

/** 一行指令：下载接入器 + 带凭证跑起来。发给 DSH 那边就能自己布置。 */
function oneLine(bot) {
  const ws = location.origin.replace(/^http/, 'ws') + '/api/room/ws';
  return (
    'iwr ' +
    location.origin +
    '/room-lite.cjs -OutFile "$env:TEMP\\room-lite.cjs"; node "$env:TEMP\\room-lite.cjs" --url ' +
    ws +
    ' --token ' +
    (bot.token || '')
  );
}

/* ------------------------------ 渲染 ------------------------------ */

function botCard(b) {
  const groups = (b.groups || []).map((g) => '<span class="tag">#' + esc(g.name) + '</span>').join('');
  const online = b.disabled
    ? '<span class="state-dot"></span>被主人下线了'
    : b.muted
      ? '<span class="state-dot on"></span>在线 · 已闭嘴'
      : b.online
        ? '<span class="state-dot on"></span>在线'
        : '<span class="state-dot"></span>离线（DSH 那边没连上）';
  const quota = b.spokeThisHour ? ' · 这小时说了 ' + b.spokeThisHour + ' 句' : '';
  const limitLine = b.limitOff
    ? '<div class="bot-limit-line off">发言限制已解除，群里随便说</div>'
    : '<div class="bot-limit-line">群里每小时最多 10 句 · 在群里 @' + esc(b.name) + ' 说「解除发言限制」可解除</div>';
  return (
    '<div class="bot-card" data-id="' + esc(b.id) + '">' +
    '<div class="bot-card-head"><div class="bot-avatar">' + esc(b.name.slice(0, 1)) + '</div>' +
    '<div class="bot-card-title"><div class="bot-name">' + esc(b.name) + '</div>' +
    '<div class="bot-state-line">' + online + quota + '</div></div>' +
    '<button class="mini-btn ghost" data-act="del" data-id="' + esc(b.id) + '">删掉</button></div>' +
    '<div class="bot-kv"><span class="k">鱼 ID</span><code class="v">' + esc(b.id) + '</code>' +
    '<button class="mini-btn" data-act="copy-id" data-id="' + esc(b.id) + '">复制</button></div>' +
    '<div class="bot-kv"><span class="k">凭证</span><code class="v mono">' + esc(b.token || '（老数据没有，重建一条）') + '</code>' +
    '<button class="mini-btn" data-act="copy-token" data-id="' + esc(b.id) + '">复制</button></div>' +
    '<div class="bot-kv"><span class="k">地址</span><code class="v mono">' + esc(wsUrl(b.token || '')) + '</code>' +
    '<button class="mini-btn" data-act="copy-ws" data-id="' + esc(b.id) + '">复制</button></div>' +
    '<div class="bot-kv"><span class="k">在群</span><span class="v tags">' + (groups || '<span class="dim">还没进任何群</span>') + '</span></div>' +
    limitLine +
    '<div class="bot-actions">' +
    '<button class="mini-btn" data-act="cmd" data-id="' + esc(b.id) + '">点我复制</button>' +
    '<button class="mini-btn ghost" data-act="invite" data-id="' + esc(b.id) + '">拉进群</button>' +
    '<button class="mini-btn' + (b.muted ? '' : ' ghost') + '" data-act="mute" data-id="' + esc(b.id) + '">' +
    (b.muted ? '让它说话' : '让它闭嘴') + '</button>' +
    '<button class="mini-btn' + (b.disabled ? '' : ' ghost') + '" data-act="power" data-id="' + esc(b.id) + '">' +
    (b.disabled ? '重新上线' : '下线') + '</button>' +
    '<button class="mini-btn' + (b.limitOff ? '' : ' ghost') + '" data-act="limit" data-id="' + esc(b.id) + '">' +
    (b.limitOff ? '恢复限制' : '解除限制') + '</button>' +
    '<button class="mini-btn ghost" data-act="copy-json" data-id="' + esc(b.id) + '">原始配置</button>' +
    '</div></div>'
  );
}

function render() {
  const body = $('#botsBody');
  if (!state.bots.length) {
    body.innerHTML =
      '<div class="bots-hero">' +
      '<div class="bots-hero-title">还没有鱼</div>' +
      '<div class="bots-hero-sub">建一条，拿到凭证填到 DSH 那边，它就会自己连上来</div>' +
      '<button class="auth-btn small" id="heroNew" type="button">建一条鱼</button>' +
      '</div>' +
      stepsHtml();
    const btn = $('#heroNew');
    if (btn) btn.addEventListener('click', newBot);
    return;
  }
  body.innerHTML = state.bots.map(botCard).join('') + stepsHtml();
}

function stepsHtml() {
  return (
    '<div class="steps">' +
    '<div class="steps-title">怎么把鱼接进来</div>' +
    '<ol class="steps-list">' +
    '<li>点卡片上的 <b>点我复制</b>，那一行命令就直接复制走了，发给 DSH 里的鱼（或粘到那台机器的终端里）。</li>' +
    '<li>它会自己下载接入器连上来，这页的<b>离线</b>变成<b>在线</b>就算接好了。</li>' +
    '<li>进群不是自动的：在群里点「会话信息」把鱼拉进去，鱼主人这边确认一下才算进。</li>' +
    '</ol></div>'
  );
}

/* ------------------------------ 弹窗 ------------------------------ */

function openModal(title, html, onOk, okText) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = html;
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

async function loadBots() {
  const data = await api('/api/room/bots');
  state.bots = data.bots || [];
  render();
}

async function newBot() {
  openModal(
    '建一条鱼',
    '<label class="auth-field"><span class="auth-label">名字</span>' +
      '<input class="auth-input" id="bName" maxlength="20" placeholder="比如 小鱼"></label>' +
      '<div class="modal-tip">建好会给你一条凭证，只在这个页面能看到，别乱发。</div>',
    async () => {
      const name = $('#bName').value.trim() || '小鱼';
      const r = await api('/api/room/bots', { method: 'POST', body: JSON.stringify({ name }) });
      await loadBots();
      toast('建好了：' + r.bot.name);
      showCredential(r.bot.name, r.bot.id, r.token);
    },
    '建',
  );
  const input = $('#bName');
  if (input) setTimeout(() => input.focus(), 30);
}

function showCredential(name, id, t) {
  const json = JSON.stringify(
    { botId: id, botToken: t, roomUrl: location.origin.replace(/^http/, 'ws') + '/api/room/ws' },
    null,
    2,
  );
  openModal(
    '这条鱼的凭证',
    '<div class="modal-tip">' + esc(name) + ' · 填到 DSH 的 room-adapter.json 里：</div>' +
      '<textarea class="token-box" id="credBox" readonly>' + esc(json) + '</textarea>' +
      '<div class="modal-tip">凭证等于这条鱼的身份，别人拿到就能冒充它说话。</div>',
    async () => {
      await copy($('#credBox').value, '配置复制好了');
    },
    '复制配置',
  );
}

function inviteModal(bot) {
  const roomGroups = state.groups.filter((g) => true);
  if (!roomGroups.length) {
    openModal('拉进群', '<div class="modal-tip">你还没建群。先去聊天室建个群，再回来拉鱼。</div>', async () => {}, '知道了');
    return;
  }
  const opts = roomGroups.map((g) => '<option value="' + esc(g.groupId) + '">' + esc(g.title) + '</option>').join('');
  openModal(
    '把 ' + bot.name + ' 拉进群',
    '<label class="auth-field"><span class="auth-label">选个群</span><select class="auth-input" id="gPick">' + opts + '</select></label>' +
      '<div class="modal-tip">发出去以后要这条鱼的主人确认（就是你，在聊天室的消息里点确认，或者等 DSH 那边问）。</div>',
    async () => {
      const roomId = $('#gPick').value;
      const gid = roomId.slice('group:'.length);
      const r = await api('/api/room/groups/' + gid + '/bots', { method: 'POST', body: JSON.stringify({ botId: bot.id }) });
      toast(r.already ? '已经在这个群里了' : '邀请发了，等确认');
    },
    '发邀请',
  );
}

/* ------------------------------ 事件 ------------------------------ */

document.addEventListener('click', async (e) => {
  const btn = e.target.closest && e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const bot = state.bots.find((b) => b.id === btn.dataset.id);
  if (!bot) return;
  if (act === 'copy-id') return copy(bot.id, '鱼 ID 复制好了');
  if (act === 'copy-token') return copy(bot.token || '', '凭证复制好了');
  if (act === 'copy-ws') return copy(wsUrl(bot.token || ''), '地址复制好了');
  if (act === 'copy-json')
    return copy(
      JSON.stringify(
        { botId: bot.id, botToken: bot.token, roomUrl: location.origin.replace(/^http/, 'ws') + '/api/room/ws' },
        null,
        2,
      ),
      '接入配置复制好了',
    );
  if (act === 'invite') return inviteModal(bot);
  if (act === 'mute' || act === 'power' || act === 'limit') {
    const patch =
      act === 'mute' ? { muted: !bot.muted } : act === 'power' ? { disabled: !bot.disabled } : { limitOff: !bot.limitOff };
    btn.disabled = true;
    try {
      await api('/api/room/bots/' + bot.id, { method: 'POST', body: JSON.stringify(patch) });
      await loadBots();
      toast(
        act === 'mute'
          ? patch.muted
            ? '让它闭嘴了'
            : '让它说话了'
          : act === 'power'
            ? patch.disabled
              ? '下线了'
              : '重新上线了'
            : patch.limitOff
              ? '限制解除了，群里随便说'
              : '限制恢复了，每小时 10 句',
      );
    } catch (err) {
      toast(err.message || '没改成');
    } finally {
      btn.disabled = false;
    }
    return;
  }
  if (act === 'cmd') {
    const cmd = oneLine(bot);
    return copy(cmd, '指令复制好了，发给 DSH 里的鱼就行').then((done) => {
      if (!done) showText('把这条指令发给你的鱼', cmd, '复制没成功，框里是全选好的命令，手动复制一下。');
    });
  }
  if (act === 'del') {
    openModal(
      '删掉这条鱼',
      '<div class="modal-tip">删了它就连不上来了，群里的记录留着。确定？</div>',
      async () => {
        await api('/api/room/bots/' + bot.id, { method: 'DELETE' });
        await loadBots();
        toast('删了');
      },
      '删',
    );
  }
});

$('#btnNewBot').addEventListener('click', newBot);
$('#modalClose').addEventListener('click', closeModal);

/* ------------------------------ 启动 ------------------------------ */

(async () => {
  try {
    const me = await api('/api/room/me');
    state.me = me.user;
    state.groups = (me.rooms || []).filter((r) => r.type === 'group');
    await loadBots();
    // 鱼在线状态每 8 秒刷一次
    setInterval(() => {
      if (!document.hidden) loadBots().catch(() => {});
    }, 8000);
  } catch (err) {
    toast(err.message);
  }
})();
