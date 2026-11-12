'use strict';
/* 登录 / 注册页共用的前端脚本，零依赖 */

const TOKEN_KEY = 'room-token';
const ACCOUNT_RE = /^[0-9]{5,20}$/;
// 6~64 位，数字 / 字母（不限大小写）/ 符号都能用，不能有空格
const PASSWORD_RE = /^[\x21-\x7E]{6,64}$/;
const PASSWORD_HINT = '密码至少 6 位，数字、字母、符号都能用（不能有空格）';

const $ = (s) => document.querySelector(s);
const page = document.body.dataset.page;

const EYE_OPEN =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>';
const EYE_SHUT =
  '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 6.1A9.9 9.9 0 0 1 12 6c6.4 0 10 6 10 6a17 17 0 0 1-3 3.6"/><path d="M6.4 7.6A16.8 16.8 0 0 0 2 12s3.6 6.5 10 6.5c1.3 0 2.5-.2 3.5-.6"/></svg>';

function showErr(text) {
  const box = $('#err');
  box.hidden = false;
  box.textContent = text;
}

function hideErr() {
  $('#err').hidden = true;
}

/* 密码框右边的小眼睛：点一下切明文 / 密文 */
function initEyes() {
  for (const btn of document.querySelectorAll('.pwd-eye')) {
    btn.innerHTML = EYE_OPEN;
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const input = document.getElementById(btn.dataset.for);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      btn.innerHTML = show ? EYE_SHUT : EYE_OPEN;
      btn.setAttribute('aria-label', show ? '隐藏密码' : '显示密码');
      try {
        input.focus({ preventScroll: true });
      } catch (_) {}
    });
  }
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data.error && data.error.message) || '请求失败 ' + res.status);
  return data;
}

function go(token) {
  localStorage.setItem(TOKEN_KEY, token);
  location.replace('/room');
}

async function submit() {
  hideErr();
  const acc = $('#acc').value.trim();
  const pwd = $('#pwd').value;

  if (!ACCOUNT_RE.test(acc)) return showErr('账号要 5 位以上纯数字');
  if (!PASSWORD_RE.test(pwd)) return showErr(PASSWORD_HINT);

  const btn = $('#submit');
  btn.disabled = true;
  try {
    if (page === 'register') {
      const pwd2 = $('#pwd2').value;
      if (pwd !== pwd2) throw new Error('两次密码不一样');
      const r = await post('/api/room/register', { name: acc, password: pwd });
      go(r.token);
    } else {
      const r = await post('/api/room/login', { name: acc, password: pwd });
      go(r.token);
    }
  } catch (err) {
    showErr(err.message);
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  // 已经登录过就直接进聊天室
  if (localStorage.getItem(TOKEN_KEY)) {
    location.replace('/room');
    return;
  }
  initEyes();
  $('#submit').addEventListener('click', submit);
  for (const id of ['#acc', '#pwd', '#pwd2']) {
    const el = $(id);
    if (el) el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submit();
    });
  }
  $('#acc').focus();
});
