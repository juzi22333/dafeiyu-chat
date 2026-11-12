'use strict';
/**
 * dsh-brain.js —— 让聊天室的鱼用 DSH 会话当脑子（零第三方依赖）
 *
 * 干的事：
 *   1. 读本机 DSH 的 browser-session 密钥，自己铸一个鉴权 Cookie
 *   2. 给每条鱼在 DSH 里开一个会话（agentPreset = qq-chat，只有网页/记忆类工具，没有本地执行权）
 *   3. 有人说话 → 往那个会话里提一句 → 从 remote.mux 事件流里收这一回合的正文
 *
 * 为什么要自己铸 Cookie：DSH 的 HTTP/WS 接口都验这个 Cookie，裸 fetch 会 401。
 * 为什么不直接 require qq-bridge 的 dsh-client：那边带 js-yaml + apiproxy 依赖，这个站是零依赖的。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
const CRED_FILE = path.join(DSH_HOME, '.credentials.yaml');
const SESSION_FILE = path.join(__dirname, 'data', 'room-dsh-sessions.json');
const DEFAULT_BASE = process.env.DSH_BASE_URL || 'http://127.0.0.1:50390';
const DEFAULT_PRESET = process.env.DSH_ROOM_PRESET || 'qq-chat';

const COOKIE_LIFETIME_MS = 60 * 60 * 1000;
const COOKIE_REFRESH_MARGIN_MS = 5 * 60 * 1000;

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), '[dsh-brain]', ...args);

/* ------------------------------ 鉴权 ------------------------------ */

function b64u(input) {
  return Buffer.from(input).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function readBrowserSessionSecret() {
  let raw;
  try {
    raw = fs.readFileSync(CRED_FILE, 'utf8');
  } catch {
    return null;
  }
  // 只要 client-connection/browser-session 那一条里的 secret，避免为了一个字段去依赖 yaml
  const m = raw.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_\-+/=]+)/);
  if (!m) return null;
  const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
  return secret.length === 32 ? secret : null;
}

function mintCookie(baseUrl, secret, lifetimeMs = COOKIE_LIFETIME_MS) {
  const authority = new URL(baseUrl).host;
  const issuedAt = Date.now();
  const body = b64u(
    JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + lifetimeMs })
  );
  const signature = b64u(crypto.createHmac('sha256', secret).update(body).digest());
  const name = 'dsh-auth-' + b64u(crypto.createHash('sha256').update(authority).digest());
  return { cookie: `${name}=v1.${body}.${signature}`, expiresAt: issuedAt + lifetimeMs };
}

/* ------------------------------ RPC ------------------------------ */

// 哪些方法要包一层 request / _request（跟 DSH 的接口约定对齐）
const WRAPPER = {
  'session/list': '_request',
  'session/create': 'request',
  'session/prompt': 'request',
  'session/cancel': 'request',
  'session/selectModel': 'request',
  'session/rename': 'request',
  'session/fork': 'request',
  'session/page': 'request',
  'session/search': 'request',
  'session/follow': 'request',
  'session/projections': 'request',
  'workspace/create': 'request',
  'workspace/rename': 'request',
  'workspace/delete': 'request',
  'agentPresets/list': null,
  'settings/describe': null,
};

function endpointOf(method) {
  return method.replace(/\./g, '/');
}

function wrapArgs(method, payload) {
  const endpoint = endpointOf(method);
  const body = payload || {};
  const wrapper = Object.prototype.hasOwnProperty.call(WRAPPER, endpoint) ? WRAPPER[endpoint] : undefined;
  if (wrapper === null) return { args: {} };
  if (endpoint === 'session/prompt') {
    return { args: { request: { requestId: crypto.randomUUID(), ...body } } };
  }
  if (wrapper === undefined) return { args: body };
  return { args: { [wrapper]: body } };
}

class DshBrain {
  constructor(baseUrl = DEFAULT_BASE, preset = DEFAULT_PRESET) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.preset = preset;
    this._cookie = null;
    this._cookieExpiresAt = 0;
    this._sessions = loadSessions();
  }

  cookie() {
    if (this._cookie && Date.now() < this._cookieExpiresAt - COOKIE_REFRESH_MARGIN_MS) return this._cookie;
    const secret = readBrowserSessionSecret();
    if (!secret) throw new Error('读不到 DSH 的 browser-session 密钥（' + CRED_FILE + '）');
    const minted = mintCookie(this.baseUrl, secret);
    this._cookie = minted.cookie;
    this._cookieExpiresAt = minted.expiresAt;
    return this._cookie;
  }

  async call(method, payload, timeoutMs = 30000) {
    const endpoint = endpointOf(method);
    const message = {
      type: 'client-request',
      rpcId: crypto.randomUUID(),
      method: endpoint,
      payload: wrapArgs(method, payload),
    };
    const res = await fetch(`${this.baseUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: this.cookie() },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401) {
      this._cookie = null; // 过期或重启过，下一轮重新铸
      throw new Error('DSH 鉴权失败（401）');
    }
    const full = await res.json().catch(() => null);
    if (!full || full.type !== 'server-response' || !full.result) {
      throw new Error(`DSH 回了看不懂的东西（${endpoint}）`);
    }
    if (!full.result.ok) {
      const err = full.result.error || {};
      throw new Error(`DSH ${endpoint} 失败: ${err.code || ''} ${err.message || ''}`.trim());
    }
    return full.result.value;
  }

  /* ---- 会话 ---- */

  async ensureWorkspace() {
    const dir = path.join(__dirname, 'data', 'room-dsh');
    fs.mkdirSync(dir, { recursive: true });
    const value = await this.call('workspace.create', { path: dir });
    return value && value.workspace ? value.workspace.workspaceId : value.workspaceId;
  }

  async ensureSession(key) {
    const saved = this._sessions[key];
    if (saved && saved.sessionId && saved.workspaceId) {
      return saved;
    }
    const workspaceId = await this.ensureWorkspace();
    const value = await this.call('session.create', { workspaceId, agentPreset: this.preset });
    const sessionId = value && value.sessionId;
    if (!sessionId) throw new Error('DSH 没给 sessionId');
    const next = { sessionId, workspaceId, preset: this.preset, updatedAt: Date.now() };
    this._sessions[key] = next;
    saveSessions(this._sessions);
    log('新建 DSH 会话', key, sessionId, 'preset=' + this.preset);
    return next;
  }

  forget(key) {
    if (this._sessions[key]) {
      delete this._sessions[key];
      saveSessions(this._sessions);
    }
  }

  /* ---- 提问：开一条 WS，等这一回合说完 ---- */

  async ask(key, text, { timeoutMs = 150000 } = {}) {
    const sess = await this.ensureSession(key);
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this._promptOnce(sess.sessionId, text, timeoutMs);
      } catch (err) {
        lastError = err;
        // 会话被删/DSH 重启过 → 换一个新的再试一次
        log('提问失败，重开会话重试:', err.message);
        this.forget(key);
        return this._promptOnce((await this.ensureSession(key)).sessionId, text, timeoutMs);
      }
    }
    throw lastError || new Error('DSH 没回话');
  }

  _promptOnce(sessionId, text, timeoutMs) {
    return new Promise((resolve, reject) => {
      const url = new URL('/api/remote.mux', this.baseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      let ws;
      try {
        ws = new WebSocket(url, { headers: { cookie: this.cookie() } });
      } catch (err) {
        reject(err);
        return;
      }

      let opened = false;
      let followed = false;
      let turn = null;
      let out = '';
      let done = false;

      const timer = setTimeout(() => finish(new Error('DSH 超过 ' + Math.round(timeoutMs / 1000) + ' 秒没说完')), timeoutMs);

      function finish(err, value) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        if (err) reject(err);
        else resolve(value);
      }

      const sendPrompt = async () => {
        try {
          await this.call('session.prompt', {
            sessionId,
            mode: 'queue',
            content: [{ type: 'text', text }],
          });
        } catch (err) {
          finish(err);
        }
      };

      ws.addEventListener('open', () => {
        opened = true;
        ws.send(
          JSON.stringify({
            type: 'open',
            streamId: crypto.randomUUID(),
            endpoint: 'session/follow',
            payload: {
              args: {
                request: {
                  address: { kind: 'session', sessionId },
                  maxMessages: 20,
                },
              },
            },
          })
        );
        followed = true;
        sendPrompt();
      });

      ws.addEventListener('error', () => {
        if (!opened) finish(new Error('连不上 DSH 的事件流'));
      });

      ws.addEventListener('close', () => {
        if (!done) finish(new Error('DSH 事件流断了'));
      });

      ws.addEventListener('message', (ev) => {
        let msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8'));
        } catch {
          return;
        }
        if (msg.type !== 'item' || !msg.value || msg.value.type !== 'event') return;
        const event = msg.value.event;
        if (!event || !event.type) return;
        if (event.type === 'turn/start') {
          turn = event.data && event.data.turn;
          return;
        }
        if (event.type === 'assistant/message' && turn) {
          const content = (event.data && event.data.message && event.data.message.content) || [];
          for (const block of content) {
            if (block && block.type === 'text' && block.text) out += block.text;
          }
          return;
        }
        if (event.type === 'turn/end' && turn && event.data && event.data.turn === turn) {
          const reason = event.data.reason || {};
          if (reason.kind === 'error') {
            finish(new Error('DSH 这一回合出错: ' + (reason.message || reason.kind)));
          } else {
            finish(null, out.trim());
          }
        }
      });

      void followed;
    });
  }
}

/* ------------------------------ 会话表持久化 ------------------------------ */

function loadSessions() {
  try {
    const raw = fs.readFileSync(SESSION_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function saveSessions(map) {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(map, null, 2) + '\n', 'utf8');
  } catch (err) {
    log('会话表写不进去:', err.message);
  }
}

module.exports = {
  DshBrain,
  mintCookie,
  readBrowserSessionSecret,
  endpointOf,
  wrapArgs,
  DEFAULT_BASE,
  DEFAULT_PRESET,
};
