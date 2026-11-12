'use strict';
/* 只读访客页：凭分享 key 看消息，不能发。想说话去注册。 */

const $ = (s) => document.querySelector(s);

const KEY = (function () {
  const q = new URLSearchParams(location.search).get('k');
  if (q) return q;
  const m = location.pathname.match(/^\/v\/([\w-]+)$/);
  return m ? m[1] : '';
})();

let pollTimer = 0;

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  const same = d.toDateString() === now.toDateString();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  return same ? hm : d.getMonth() + 1 + '/' + d.getDate() + ' ' + hm;
}

function msgNode(m) {
  const wrap = document.createElement('div');
  wrap.className =
    'msg-wrap' + (m.kind === 'system' ? ' system' : '') + (m.kind === 'bot' ? ' bot' : '');
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.textContent = m.kind === 'system' ? '·' : (m.senderName || '?').slice(0, 1);
  const body = document.createElement('div');
  body.className = 'bubble-wrap';
  const meta = document.createElement('div');
  meta.className = 'msg-meta';
  meta.textContent = (m.senderName || '?') + ' · ' + fmtTime(m.at);
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = m.text;
  body.appendChild(meta);
  body.appendChild(bubble);
  wrap.appendChild(avatar);
  wrap.appendChild(body);
  return wrap;
}

function showTip(text) {
  const box = $('#messages');
  box.innerHTML = '';
  const tip = document.createElement('div');
  tip.className = 'empty-tip';
  tip.textContent = text;
  box.appendChild(tip);
}

async function load() {
  if (!KEY) {
    showTip('这个链接不完整，让对方重新发一条');
    $('#roomTitle').textContent = '只读';
    return;
  }
  const res = await fetch('/api/room/view?k=' + encodeURIComponent(KEY) + '&limit=150');
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showTip((data.error && data.error.message) || '打不开，链接可能过期了');
    return;
  }
  const room = data.room || {};
  $('#roomTitle').textContent = (room.type === 'group' ? '#' : '') + (room.title || '会话');
  document.title = (room.title || '聊天室') + ' · 只读';
  const parts = [];
  if (data.members && data.members.length) parts.push(data.members.length + ' 人');
  if (data.bots && data.bots.length) parts.push(data.bots.map((b) => b.name).join('、'));
  parts.push('只读');
  $('#roomMeta').textContent = parts.join(' · ');

  const box = $('#messages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
  box.innerHTML = '';
  const list = data.messages || [];
  if (!list.length) {
    const tip = document.createElement('div');
    tip.className = 'empty-tip';
    tip.textContent = '这里还没有消息';
    box.appendChild(tip);
  } else {
    for (const m of list) box.appendChild(msgNode(m));
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    load().catch(() => {});
  }, 6000);
}

document.addEventListener('DOMContentLoaded', () => {
  load().catch(() => showTip('网断了，刷新一下'));
  startPolling();
});
