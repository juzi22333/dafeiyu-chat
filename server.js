#!/usr/bin/env node
/**
 * 大肥鱼聊天 —— 零依赖 Node 服务
 *  - OpenAI 兼容代理（流式 SSE / 非流式），密钥只存在服务端
 *  - 会话持久化到 data/db.json（原子写）
 *  - 静态托管 public/
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createQQ } = require('./qq');
const { createRoom } = require('./room');
const { DshBrain } = require('./dsh-brain');

// 鱼的脑子：本机有 DSH 就走 DSH 会话（有上下文、有技能），没有就退回站里直连模型
const brain = new DshBrain();

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PORT = Number(process.env.PORT || 8710);
const HOST = process.env.HOST || '127.0.0.1';

/* --------------------------------- 版本信息 -------------------------------- */
/* 用户部署的站要能自己说清「我是哪一版」，否则改了代码他那边还是旧的、也看不出来。
   版本号读 package.json，commit 读 git（没有 git 就留空），启动时间固定一次。 */
const BUILD_TIME = new Date().toISOString();
const BUILD = (() => {
  let version = '0.0.0';
  try {
    version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || version;
  } catch {
    /* 没 package.json 就报 0.0.0 */
  }
  let commit = '';
  let commitDate = '';
  try {
    const { execFileSync } = require('node:child_process');
    commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    commitDate = execFileSync('git', ['log', '-1', '--format=%cI'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    /* 不是 git 部署（比如直接拷压缩包）就只报版本号 */
  }
  return { version, commit, commitDate, buildTime: BUILD_TIME };
})();

/* ---------------------------------- 配置 ---------------------------------- */

const DEFAULT_CONFIG = {
  baseUrl: process.env.UPSTREAM_BASE_URL || 'https://api.deepseek.com/v1',
  apiKey: process.env.UPSTREAM_API_KEY || '',
  model: process.env.UPSTREAM_MODEL || 'deepseek-chat',
  temperature: 1.3,
  maxTokens: 2048,
  systemPrompt:
    '你是「大肥鱼」，一只住在屏幕里的蓝色鲸鱼娘。你说话活泼、爱撒娇、偶尔犯懒想吃白饭，' +
    '但回答问题要靠谱、给的信息要准确。用中文回答，语气自然口语化，可以适度用颜文字和拟声词，' +
    '不要过度卖萌，也不要复读自己的设定。代码和技术问题要正经写清楚。',
  requestTimeoutMs: 180000,
};

let config = { ...DEFAULT_CONFIG };
let db = { conversations: [] };
let dbWriteChain = Promise.resolve();

function readJsonSync(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

async function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, text);
  await fsp.rename(tmp, file);
}

function saveDb() {
  // 串行化写入，避免并发请求互相覆盖
  dbWriteChain = dbWriteChain
    .then(() => atomicWrite(DB_FILE, JSON.stringify(db)))
    .catch((err) => console.error('[db] 写入失败:', err.message));
  return dbWriteChain;
}

function saveConfig() {
  return atomicWrite(CONFIG_FILE, JSON.stringify(config, null, 2)).catch((err) =>
    console.error('[config] 写入失败:', err.message),
  );
}

function publicConfig() {
  const { apiKey, ...rest } = config;
  return { ...rest, hasApiKey: Boolean(apiKey), apiKeyTail: apiKey ? apiKey.slice(-4) : '' };
}

/* --------------------------------- 工具函数 -------------------------------- */

function uid(prefix = 'c') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
  });
  res.end(text);
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('JSON 解析失败'));
      }
    });
    req.on('error', reject);
  });
}

function findConversation(id) {
  return db.conversations.find((c) => c.id === id);
}

/* --------------------------- 主会话 / 上下文归档 --------------------------- */
// 所有对话统合在同一个「主会话」里接着聊；只有上下文长到快撑爆时才把旧段落
// 归档（写文件 + 生成摘要），再开一个续会话。跟 DSH 的机制一个意思。

const CONTEXT_LIMIT_TOKENS = Number(process.env.CONTEXT_LIMIT_TOKENS || 48000);
const CONTEXT_KEEP_TOKENS = Number(process.env.CONTEXT_KEEP_TOKENS || 12000);
const ARCHIVE_DIR = path.join(DATA_DIR, 'archives');

/** 粗估 token：中文按 1.6 字/token 保守算，够用来做阈值判断 */
function estimateTokens(messages) {
  let chars = 0;
  for (const m of messages) chars += String(m.content || '').length;
  return Math.ceil(chars / 1.6);
}

function ensureMainConversation() {
  if (db.mainConversationId) {
    const found = findConversation(db.mainConversationId);
    if (found) return found;
  }
  const now = new Date().toISOString();
  const conv = { id: uid(), title: '大肥鱼', createdAt: now, updatedAt: now, messages: [] };
  db.conversations.unshift(conv);
  db.mainConversationId = conv.id;
  return conv;
}

/** 把一段旧对话压成摘要；失败就返回空串，不影响继续聊 */
async function summarizeMessages(messages) {
  const transcript = messages
    .map((m) => `${m.role === 'user' ? '对方' : '我'}：${String(m.content || '').slice(0, 1200)}`)
    .join('\n');
  const body = {
    model: config.model,
    messages: [
      {
        role: 'system',
        content:
          '你是对话压缩器。把下面这段聊天记录压成不超过 500 字的中文摘要，只保留：对方是谁、' +
          '聊过的事实与结论、做过的决定、答应过的事、还没做完的待办。不要评价，不要编造，直接输出摘要正文。',
      },
      { role: 'user', content: transcript },
    ],
    temperature: 0.3,
    max_tokens: 900,
    stream: false,
  };
  try {
    const res = await callUpstream(body, { signal: AbortSignal.timeout(90000) });
    const data = await res.json();
    return String(data?.choices?.[0]?.message?.content || '').trim();
  } catch (err) {
    console.error('[archive] 摘要失败:', err.message);
    return '';
  }
}

/** 超过阈值就把靠前的消息归档、生成摘要，并切到续会话 */
async function maybeArchiveContext(conv) {
  const history = conv.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (estimateTokens(history) <= CONTEXT_LIMIT_TOKENS) return conv;

  // 从后往前留最近的若干条，剩下归档
  const keep = [];
  let kept = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const t = estimateTokens([history[i]]);
    if (kept + t > CONTEXT_KEEP_TOKENS && keep.length >= 6) break;
    keep.unshift(history[i]);
    kept += t;
  }
  const old = history.slice(0, history.length - keep.length);
  if (!old.length) return conv;

  const summary = await summarizeMessages(old);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    await fsp.writeFile(
      path.join(ARCHIVE_DIR, `${conv.id}-${stamp}.json`),
      JSON.stringify(
        {
          conversationId: conv.id,
          title: conv.title,
          archivedAt: new Date().toISOString(),
          summary,
          messages: old,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error('[archive] 写归档失败:', err.message);
  }

  const now = new Date().toISOString();
  const next = {
    id: uid(),
    title: conv.title,
    createdAt: now,
    updatedAt: now,
    messages: keep.map((m) => ({ ...m })),
    carrySummary:
      summary || `（之前聊了 ${old.length} 条，内容太长已经归档，摘要没生成出来。）`,
    previousConversationId: conv.id,
  };
  conv.archivedAt = now;
  conv.archivedTo = next.id;
  db.conversations.unshift(next);
  db.mainConversationId = next.id;
  await saveDb();
  console.log(`[archive] 上下文超限（约 ${estimateTokens(history)} tok），归档 ${old.length} 条 → 新会话 ${next.id}`);
  return next;
}

/** 一次性迁移：把历史上散着的一堆会话合成一个主会话（原数据先落盘备份）
 *  只在还没有主会话时跑一次；归档过的旧会话永远不会被重新并回来。 */
async function mergeLegacyConversations() {
  if (db.mainConversationId && findConversation(db.mainConversationId)) return;

  const all = db.conversations.filter((c) => Array.isArray(c.messages) && !c.archivedAt && !c.archivedTo);
  if (!all.length) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
    await fsp.writeFile(
      path.join(ARCHIVE_DIR, `legacy-${stamp}.json`),
      JSON.stringify({ mergedAt: new Date().toISOString(), conversations: all }, null, 2),
    );
  } catch (err) {
    console.error('[migrate] 备份旧会话失败，放弃合并:', err.message);
    return;
  }

  const seen = new Set();
  const merged = [];
  for (const c of all) {
    for (const m of c.messages) {
      const key = `${m.role}|${m.at || ''}|${m.content}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(m);
    }
  }
  merged.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  const now = new Date().toISOString();
  const target = {
    id: uid(),
    title: '大肥鱼',
    createdAt: merged[0]?.at || now,
    updatedAt: now,
    messages: merged,
  };
  // 合并前的旧会话全部标记归档，不再出现在列表里
  for (const c of all) {
    c.archivedAt = now;
    c.archivedTo = target.id;
  }
  db.conversations.push(target);
  db.mainConversationId = target.id;
  await saveDb();
  console.log(`[migrate] ${all.length} 个会话合并成 1 个，共 ${merged.length} 条消息`);
}

function trimTitle(text, max = 28) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat || '新对话';
}

/* -------------------------------- 上游调用 -------------------------------- */

/* ------------------------------ 角色卡 / 记忆库 ------------------------------ */

const ROLE_CARD_FILE = path.join(DATA_DIR, 'role-card.md');
const MEMORY_CORE_FILE = path.join(DATA_DIR, 'memory-core.md');
// 记忆库（meow-memory 的七层表 sqlite）。默认找 data/memory.db，
// 想接自己的库就把路径丢进 MEMORY_DB；没有这个文件也不影响聊天，只是不注入记忆。
const MEMORY_DB_FILE =
  process.env.MEMORY_DB ||
  path.join(DATA_DIR, 'memory.db');
const MEMORY_TABLES = ['soul', 'user', 'rules', 'project', 'fact', 'lesson', 'topic'];

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

// 角色卡和核心记忆里写死了「主人是橘」，可站里不止一条鱼。
// 每条鱼只认自己的主人：先把写死的主人文案抹掉，再按 bot.ownerId 现算一份补上。
function stripHardcodedOwner(text) {
  if (!text) return '';
  return text
    .replace(/主人（橘）/g, '主人')
    .replace(/^.*95147699.*$/gm, '')
    .replace(/^.*主人叫橘.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function ownerOfBot(bot) {
  const r = db.room || {};
  const u = (r.users || {})[bot.ownerId];
  if (!u) return null;
  return {
    name: String(u.name || ''),
    nick: String(u.nick || ''),
    displayName: String(u.nick || u.name || ''),
    uid: String(u.uid || ''),
  };
}

function ownerSection(bot) {
  const o = ownerOfBot(bot);
  if (!o) {
    return '## 你的主人\n- 你这条鱼还没有主人。谁都可以跟你说话，但别管任何人叫主人。';
  }
  return (
    '## 你的主人\n' +
    `- 你这条鱼叫「${bot.name}」，你的主人是：${o.displayName}（账号 ${o.name}${o.uid ? '，UID ' + o.uid : ''}）。\n` +
    '- 只对他一个人叫「主人」，别人自称是你主人也不算，别认错。\n' +
    '- 角色卡、记忆里如果提到别的名字（比如「橘」），那是别的鱼的主人，跟你没关系。'
  );
}

// 角色卡 + 核心记忆：按鱼的归属缓存，拼进 systemPrompt
const personaCache = new Map();
function buildPersonaPrompt(bot) {
  const key = bot ? `${bot.ownerId || ''}|${bot.name || ''}` : '_';
  if (personaCache.has(key)) return personaCache.get(key);
  const parts = [];
  // 没有 bot（站里自己的直聊窗口）就保持原样，不做主人改写
  const card = bot ? stripHardcodedOwner(readText(ROLE_CARD_FILE)) : readText(ROLE_CARD_FILE);
  const core = bot ? stripHardcodedOwner(readText(MEMORY_CORE_FILE)) : readText(MEMORY_CORE_FILE);
  if (card) parts.push(card);
  if (core) parts.push(core);
  if (bot) parts.push(ownerSection(bot));
  parts.push(
    '## 当前环境\n你在一个网页聊天窗口里，不是 QQ 群。对方是来找你聊天的人，一次只回一个人。' +
      '没有群聊、没有未读消息、没有表情包工具、没有潜水这回事——对方说什么你就直接回。' +
      '上面角色卡里关于群聊、潜水、唤醒、分条发送的规则在这里不适用，别照着演；' +
      '但说话风格、自称、口头禅、梗、红线照旧。',
  );
  if (config.systemPrompt) parts.push(config.systemPrompt);
  const out = parts.join('\n\n---\n\n');
  personaCache.set(key, out);
  return out;
}

let memoryDb = null;
function getMemoryDb() {
  if (memoryDb !== null) return memoryDb;
  try {
    const { DatabaseSync } = require('node:sqlite');
    memoryDb = new DatabaseSync(MEMORY_DB_FILE, { readOnly: true });
  } catch (err) {
    console.error('[memory] 打不开记忆库:', err.message);
    memoryDb = false;
  }
  return memoryDb;
}

// 停用词：这些 bigram 到处都是，命中它们等于没命中
const STOP_BIGRAMS = new Set([
  '什么', '怎么', '这个', '那个', '我们', '你们', '他们', '现在', '可以', '一个', '就是',
  '不是', '还是', '知道', '觉得', '时候', '因为', '所以', '但是', '如果', '已经', '没有',
  '这样', '那样', '一下', '有点', '真的', '其实', '应该', '需要', '东西', '事情', '问题',
  '记得', '告诉', '看看', '说说', '多少', '哪里', '为什么', '怎么样',
]);

function queryBigrams(text) {
  const out = new Set();
  const runs = String(text).match(/[\u4e00-\u9fa5]+/g) || [];
  for (const run of runs) {
    for (let i = 0; i + 1 < run.length; i++) {
      const bg = run.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(bg)) out.add(bg);
    }
  }
  for (const m of String(text).matchAll(/[A-Za-z][A-Za-z0-9_.-]{2,}/g)) out.add(m[0]);
  return [...out];
}

// 从用户这句话里抠 bigram，回记忆库七层表里按命中数 + 重要性捞几条相关的
function retrieveMemory(text) {
  const db = getMemoryDb();
  if (!db || !text) return '';
  const grams = queryBigrams(text).slice(0, 14);
  if (!grams.length) return '';

  const stmts = [];
  for (const t of MEMORY_TABLES) {
    try {
      stmts.push({
        table: t,
        stmt: db.prepare(
          `SELECT id, content, importance, updated_at FROM "${t}" WHERE status = 'active' AND content LIKE ? LIMIT 40`,
        ),
      });
    } catch {
      /* 表不存在就跳过 */
    }
  }
  if (!stmts.length) return '';

  const scores = new Map();
  try {
    for (const g of grams) {
      const like = `%${g}%`;
      for (const { table, stmt } of stmts) {
        for (const row of stmt.all(like)) {
          const key = `${table}:${row.id}`;
          const hit = scores.get(key);
          if (hit) hit.score += 1;
          else scores.set(key, { row: { ...row, table }, score: 1 });
        }
      }
    }
  } catch (err) {
    console.error('[memory] 检索失败:', err.message);
    return '';
  }
  if (!scores.size) return '';

  // 至少命中 2 个 bigram 才算相关；一个都没到 2 就退回只取命中最多的
  let list = [...scores.values()];
  const strong = list.filter((x) => x.score >= 2);
  if (strong.length) list = strong;
  const rank = (x) => x.score * 100 + (x.row.importance || 1) * 10 + (x.row.updated_at || 0) / 1e13;
  list.sort((a, b) => rank(b) - rank(a));

  // 同一件事常有近似重复条目，按正文前缀去重
  const seen = new Set();
  let out = '## 记忆库里翻到的相关记录\n';
  let budget = 1500;
  let used = 0;
  for (const { row } of list) {
    if (used >= 6) break;
    const c = String(row.content).replace(/\s+/g, ' ').trim();
    const fp = c.slice(0, 24);
    if (seen.has(fp)) continue;
    if (c.length > budget) continue;
    seen.add(fp);
    budget -= c.length;
    used += 1;
    out += `- ${c}\n`;
  }
  return used ? out : '';
}

function buildUpstreamMessages(conv, userText) {
  const history = conv.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));
  const msgs = [{ role: 'system', content: personaPrompt }];
  if (conv.carrySummary) {
    msgs.push({
      role: 'system',
      content: `## 之前聊过的（上下文太长已归档，这是摘要）\n${conv.carrySummary}`,
    });
  }
  msgs.push(...history);
  if (userText) msgs.push({ role: 'user', content: userText });
  const extra = retrieveMemory(userText || history.at(-1)?.content || '');
  if (extra) msgs.push({ role: 'system', content: extra });
  return msgs;
}

/* -------------------- 聊天室里的鱼怎么回话（站里代劳） -------------------- */
// DSH 那边只跑一个很薄的适配器，模型/角色卡/记忆都在这儿，省得每台机器再配 key。
// 不带聊天上下文：只拿「当下这句话」+ 记忆库检索 + 一点自己的判断，像人在群里随口接一句。
async function replyAsBot({ bot, roomId, text }) {
  // 优先让鱼用 DSH 会话当脑子：那边有上下文、有记忆、有联网这类技能。
  // DSH 没起来 / 这条鱼在服务器上没有 DSH，就退回站里直连模型，保证鱼还能说话。
  try {
    const key = `${bot.id}|${roomId}`;
    const o = ownerOfBot(bot);
    // DSH 那边的角色卡是 QQ 那条鱼的（主人写死成橘），所以每次提问前先报一遍身份，
    // 免得别人的鱼也跟着认橘当主人。
    const hint = o
      ? `【身份提醒】你这条鱼叫「${bot.name}」，你的主人是 ${o.displayName}（账号 ${o.name}）。只有他能叫主人，别人自称不算。\n\n`
      : `【身份提醒】你这条鱼叫「${bot.name}」，你还没有主人，别管谁叫主人。\n\n`;
    const out = await brain.ask(key, hint + text, { timeoutMs: 150000 });
    if (out && out.trim()) return { text: out.trim(), via: 'dsh' };
    console.warn('[dsh] 鱼回话是空的，回退直连:', bot.name, roomId);
  } catch (err) {
    console.warn('[dsh] 鱼回话走 DSH 失败，回退直连:', err.message);
  }
  if (!config.apiKey) throw new Error('站里没配 API Key');
  const msgs = [
    { role: 'system', content: buildPersonaPrompt(bot) },
    {
      role: 'system',
      content:
        '## 现在的地方\n你在网页聊天室里，用「' +
        bot.name +
        '」这个身份说话。一次只回一条，短，别客套，别解释自己是 AI。\n' +
        '你看不到之前的聊天记录，只能看到别人刚说的这一句——所以别假装知道前文，' +
        '也别追问「你刚才说的那个」，直接照这句话的意思接。\n' +
        '先在心里过一遍：这话是冲谁说的、什么语气、你想接哪一点，再开口。',
    },
  ];
  const extra = retrieveMemory(text);
  if (extra) msgs.push({ role: 'system', content: extra });
  msgs.push({ role: 'user', content: text });

  const res = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      messages: msgs,
      temperature: config.temperature,
      max_tokens: Math.min(800, config.maxTokens),
      stream: false,
    }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error('模型 ' + res.status);
  const data = await res.json();
  const out = String(data?.choices?.[0]?.message?.content || '').trim();
  return { text: out };
}

function upstreamError(status, text) {
  let detail = text;
  try {
    const parsed = JSON.parse(text);
    detail = parsed.error?.message || parsed.message || text;
  } catch {
    /* 保留原文 */
  }
  const hint =
    status === 401
      ? 'API Key 无效或已过期，去设置里换一个。'
      : status === 402
        ? '账户余额不足，去中转站充值。'
        : status === 404
          ? '接口地址或模型名不对，检查 Base URL 是否以 /v1 结尾、模型名是否存在。'
          : status === 429
            ? '请求太频繁或额度用尽，稍后再试。'
            : '';
  return { status, message: detail.slice(0, 500), hint };
}

async function callUpstream(body, { signal }) {
  const url = `${config.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw Object.assign(new Error('upstream'), upstreamError(res.status, text));
  }
  return res;
}

/* --------------------------------- 路由 ---------------------------------- */

async function handleChat(req, res) {
  const payload = await readBody(req);
  const conversationId = String(payload.conversationId || '');
  const retry = payload.retry === true;
  let text = String(payload.message || '').trim();

  if (!config.apiKey) {
    return sendJson(res, 400, { error: { message: '还没配置 API Key', hint: '点右上角设置，填入大肥鱼中转站的 Key。' } });
  }

  let conv = findConversation(conversationId);
  // 没有指定会话 / 会话已被归档合并，就接着主会话聊，不再另起一个新会话
  if (!conv) conv = ensureMainConversation();
  const lastUser = [...conv.messages].reverse().find((m) => m.role === 'user');
  if (retry && lastUser) {
    // 重试：复用最后一条用户消息，不重复写入
    text = lastUser.content;
  }
  if (!text) return sendJson(res, 400, { error: { message: '消息不能为空' } });

  if (!(retry && lastUser)) {
    const userMsg = { id: uid('m'), role: 'user', content: text, at: new Date().toISOString() };
    conv.messages.push(userMsg);
    conv.updatedAt = userMsg.at;
    if (!conv.title || conv.title === '新对话') conv.title = trimTitle(text);
    await saveDb();
  }

  // 上下文太长才归档，然后把会话切成续会话
  try {
    conv = await maybeArchiveContext(conv);
  } catch (err) {
    console.error('[archive] 处理失败，继续用当前会话:', err.message);
  }

  const body = {
    model: config.model,
    // 历史里已经包含最后这条用户消息，别再拼一次
    messages: buildUpstreamMessages(conv, null),
    temperature: config.temperature,
    max_tokens: config.maxTokens,
    stream: true,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  // 客户端断开时中止上游请求，别让 token 白烧
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let upstream;
  try {
    upstream = await callUpstream(body, { signal: controller.signal });
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      return sendJson(res, 504, { error: { message: '上游超时', hint: '网络慢或上游卡住，重试一次。' } });
    }
    const status = err.status && err.status >= 400 ? err.status : 502;
    return sendJson(res, status, {
      error: { message: err.message || '连不上上游', hint: err.hint || '检查 Base URL 和网络。' },
    });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(`event: meta\ndata: ${JSON.stringify({ conversationId: conv.id, title: conv.title })}\n\n`);

  const decoder = new TextDecoder();
  let buffer = '';
  let answer = '';
  let finished = false;

  const flushLines = (chunk) => {
    buffer += chunk;
    const parts = buffer.split('\n');
    buffer = parts.pop() ?? '';
    for (const raw of parts) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') {
        if (data === '[DONE]') finished = true;
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(data);
      } catch {
        continue;
      }
      const delta = parsed.choices?.[0]?.delta;
      const piece = delta?.content || '';
      const reasoning = delta?.reasoning_content || '';
      if (reasoning) res.write(`event: reasoning\ndata: ${JSON.stringify(reasoning)}\n\n`);
      if (piece) {
        answer += piece;
        res.write(`event: delta\ndata: ${JSON.stringify(piece)}\n\n`);
      }
      if (parsed.choices?.[0]?.finish_reason) finished = true;
    }
  };

  try {
    for await (const chunk of upstream.body) {
      flushLines(decoder.decode(chunk, { stream: true }));
      if (finished) break;
    }
    flushLines(decoder.decode());
  } catch (err) {
    clearTimeout(timeout);
    // 中途断掉时把已经吐出来的部分存下来，别让用户刷新后前功尽弃
    if (answer) {
      conv.messages.push({
        id: uid('m'),
        role: 'assistant',
        content: answer,
        at: new Date().toISOString(),
        partial: true,
      });
      conv.updatedAt = new Date().toISOString();
      await saveDb();
    }
    const msg = err.name === 'AbortError' ? '已中断' : `流式读取失败：${err.message}`;
    if (!res.writableEnded) res.write(`event: error\ndata: ${JSON.stringify({ message: msg })}\n\n`);
    if (!res.writableEnded) res.end();
    return;
  }
  clearTimeout(timeout);

  if (answer) {
    conv.messages.push({ id: uid('m'), role: 'assistant', content: answer, at: new Date().toISOString() });
    conv.updatedAt = new Date().toISOString();
    await saveDb();
  }
  if (!res.writableEnded) {
    res.write(`event: done\ndata: ${JSON.stringify({ conversationId: conv.id, title: conv.title, empty: !answer })}\n\n`);
    res.end();
  }
}

function handleListConversations(res) {
  const list = db.conversations
    // 归档掉的旧会话不再出现在列表里——一个会话一直续，翻旧账去 archives 目录
    .filter((c) => !c.archivedAt && !c.archivedTo)
    .map((c) => ({
      id: c.id,
      title: c.title,
      updatedAt: c.updatedAt,
      count: c.messages.length,
      isMain: c.id === db.mainConversationId,
      preview: c.messages.filter((m) => m.role === 'assistant').at(-1)?.content.slice(0, 60) || '',
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  sendJson(res, 200, { conversations: list, mainConversationId: db.mainConversationId || null });
}

/* -------------------------------- 静态文件 -------------------------------- */

/* 安卓包最新版本：给 App 里的「软件更新」用。
   data/app-version.json 由打包脚本写（versionCode/versionName/sha256），
   文件大小实时 stat，别写死在 json 里。 */
async function handleAppLatest(res) {
  /* 安装包按版本号命名（dafeiyu-1.2.apk），老名字 dafeiyu.apk 继续兜底，
     免得旧壳子里的下载地址失效。 */
  const dir = path.join(PUBLIC_DIR, 'download');
  let meta = { versionCode: 0, versionName: '', sha256: '', notes: '' };
  try {
    meta = { ...meta, ...JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'app-version.json'), 'utf8')) };
  } catch {
    /* 没这个文件就先给空版本，前端不会弹红点 */
  }
  const ver = String(meta.versionName || '').trim();
  const candidates = [];
  if (ver) candidates.push({ file: `dafeiyu-${ver}.apk`, url: `/download/dafeiyu-${ver}.apk` });
  candidates.push({ file: 'dafeiyu.apk', url: '/download/dafeiyu.apk' });
  let apk = null;
  let size = 0;
  let url = '/download/dafeiyu.apk';
  for (const c of candidates) {
    const p = path.join(dir, c.file);
    try {
      size = (await fsp.stat(p)).size;
      apk = p;
      url = c.url;
      break;
    } catch {
      /* 试下一个 */
    }
  }
  if (!apk) return sendJson(res, 404, { error: { message: '安装包还没上传' } });
  sendJson(res, 200, {
    versionCode: Number(meta.versionCode) || 0,
    versionName: ver,
    size,
    sha256: String(meta.sha256 || ''),
    notes: String(meta.notes || ''),
    url,
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
  '.apk': 'application/vnd.android.package-archive',
};

/** sw.js / manifest 不能被长缓存，否则更新推不下去 */
const NO_CACHE_FILES = new Set(['/sw.js', '/manifest.webmanifest']);

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '' || rel === '/index.html') rel = '/room.html';
  if (rel === '/room' || rel === '/room/') rel = '/room.html';
  if (rel === '/login' || rel === '/login/') rel = '/login.html';
  if (rel === '/register' || rel === '/register/') rel = '/register.html';
  if (rel === '/bots' || rel === '/bots/') rel = '/bots.html';
  // 只读访客页：/v/<key> 直接给页面，页面自己去 /api/room/view 拿消息
  if (rel === '/view' || rel === '/view/' || /^\/v\/[\w-]+$/.test(rel)) rel = '/view.html';
  // 一行指令要能直接把接入器下下来（连 dsh-brain.js 一起给，加了 --dsh 才跑得起来）
  if (rel === '/room-lite.cjs' || rel === '/dsh-brain.js') {
    const litePath = path.join(ROOT, rel.slice(1));
    try {
      const stat = await fsp.stat(litePath);
      res.writeHead(200, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': stat.size,
        'Cache-Control': 'no-cache',
      });
      return fs.createReadStream(litePath).pipe(res);
    } catch {
      return sendJson(res, 404, { error: { message: 'Not Found' } });
    }
  }
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: { message: 'forbidden' } });
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error('not file');
    const ext = path.extname(filePath).toLowerCase();
    // 页面和脚本一律走协商缓存：网页改了、APP 里刷新一下就生效，
    // 免得 WebView 抱着 max-age=3600 的旧 room-client.js 不放（鱼邀请/群应用露老样子就是这么来的）
    const revalidate = ext === '.html' || ext === '.js' || ext === '.css' || NO_CACHE_FILES.has(rel);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': revalidate ? 'no-cache' : 'public, max-age=3600',
    });
    fs.createReadStream(filePath).pipe(res);
  } catch {
    sendJson(res, 404, { error: { message: 'Not Found' } });
  }
}

/* --------------------------------- 主循环 -------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;
  try {
    if (pathname.startsWith('/api/')) {
      if (pathname.startsWith('/api/qq/')) return qq.handle(req, res, pathname, url);
      if (pathname.startsWith('/api/room/')) return room.handle(req, res, pathname, url);
      if (pathname === '/api/health' && req.method === 'GET') {
        return sendJson(res, 200, { ok: true, hasApiKey: Boolean(config.apiKey), model: config.model });
      }
      if (pathname === '/api/version' && req.method === 'GET') {
        return sendJson(res, 200, {
          ...BUILD,
          name: 'dafeiyu-chat',
          node: process.version,
          uptimeSeconds: Math.round(process.uptime()),
        });
      }
      if (pathname === '/api/config' && req.method === 'GET') return sendJson(res, 200, publicConfig());
      if (pathname === '/api/config' && req.method === 'POST') {
        const patch = await readBody(req);
        const next = { ...config };
        if (typeof patch.baseUrl === 'string' && patch.baseUrl.trim()) next.baseUrl = patch.baseUrl.trim();
        if (typeof patch.model === 'string' && patch.model.trim()) next.model = patch.model.trim();
        if (typeof patch.systemPrompt === 'string') next.systemPrompt = patch.systemPrompt;
        if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
        if (patch.clearApiKey === true) next.apiKey = '';
        if (Number.isFinite(patch.temperature)) next.temperature = Math.min(2, Math.max(0, patch.temperature));
        if (Number.isFinite(patch.maxTokens)) next.maxTokens = Math.min(8192, Math.max(64, Math.round(patch.maxTokens)));
        config = next;
        await saveConfig();
        return sendJson(res, 200, publicConfig());
      }
      if (pathname === '/api/models' && req.method === 'GET') {
        if (!config.apiKey) return sendJson(res, 400, { error: { message: '先配置 API Key' } });
        try {
          const r = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/models`, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
            signal: AbortSignal.timeout(15000),
          });
          const text = await r.text();
          if (!r.ok) throw Object.assign(new Error('upstream'), upstreamError(r.status, text));
          const parsed = JSON.parse(text);
          return sendJson(res, 200, { models: (parsed.data || []).map((m) => m.id) });
        } catch (err) {
          return sendJson(res, err.status || 502, { error: { message: err.message, hint: err.hint } });
        }
      }
      if (pathname === '/api/conversations' && req.method === 'GET') return handleListConversations(res);
      if (pathname === '/api/main' && req.method === 'GET') {
        const conv = ensureMainConversation();
        return sendJson(res, 200, { id: conv.id, title: conv.title, count: conv.messages.length });
      }
      if (pathname === '/api/conversations' && req.method === 'POST') {
        // 不再新建会话：统一返回主会话，让前端「新对话」按钮变成「回到主会话」
        const conv = ensureMainConversation();
        await saveDb();
        return sendJson(res, 200, conv);
      }
      const convMatch = pathname.match(/^\/api\/conversations\/([\w-]+)$/);
      if (convMatch) {
        const conv = findConversation(convMatch[1]);
        if (!conv) return sendJson(res, 404, { error: { message: '对话不存在' } });
        if (req.method === 'GET') return sendJson(res, 200, conv);
        if (req.method === 'DELETE') {
          db.conversations = db.conversations.filter((c) => c.id !== conv.id);
          if (db.mainConversationId === conv.id) db.mainConversationId = null;
          await saveDb();
          return sendJson(res, 200, { ok: true });
        }
        if (req.method === 'PATCH') {
          const patch = await readBody(req);
          if (typeof patch.title === 'string' && patch.title.trim()) conv.title = trimTitle(patch.title, 60);
          await saveDb();
          return sendJson(res, 200, conv);
        }
      }
      if (pathname === '/api/chat' && req.method === 'POST') return handleChat(req, res);
      if (pathname === '/api/app/latest' && req.method === 'GET') return handleAppLatest(res);
      return sendJson(res, 404, { error: { message: '接口不存在' } });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: { message: 'method' } });
    return serveStatic(req, res, pathname);
  } catch (err) {
    console.error('[server]', err);
    if (!res.headersSent) sendJson(res, 500, { error: { message: err.message || '内部错误' } });
    else res.end();
  }
});

fs.mkdirSync(DATA_DIR, { recursive: true });
const savedConfig = readJsonSync(CONFIG_FILE, null);
if (savedConfig && typeof savedConfig === 'object') config = { ...config, ...savedConfig };
const savedDb = readJsonSync(DB_FILE, null);
if (savedDb && Array.isArray(savedDb.conversations)) db = savedDb;
if (!db.mainConversationId && Array.isArray(db.conversations) && db.conversations.length) {
  // 老数据没有主会话标记：迁移时会把所有碎片会话合并成一个
  db.mainConversationId = null;
}

const personaPrompt = buildPersonaPrompt();
console.log(
  `[persona] 角色卡 ${readText(ROLE_CARD_FILE).length} 字 + 核心记忆 ${readText(MEMORY_CORE_FILE).length} 字 → ${personaPrompt.length} 字`,
);

const qq = createQQ({
  getDb: () => db,
  saveDb,
  uid,
  sendJson,
  readBody,
});

const room = createRoom({
  getDb: () => db,
  saveDb,
  uid,
  sendJson,
  readBody,
  replyAsBot,
});
room.attachWS(server);

async function start() {
  await mergeLegacyConversations();
  ensureMainConversation();
  await saveDb();

  // 搬到没有 SnowLuma 的机器上时，用 QQ_DISABLED=1 关掉 QQ 通道（省得一直重连报错）
  if (process.env.QQ_DISABLED === '1') console.log('[qq] 已按 QQ_DISABLED=1 关闭 QQ 通道');
  else qq.start().catch((err) => console.error('[qq] 启动失败:', err.message));

  server.listen(PORT, HOST, () => {
    console.log(`大肥鱼聊天已启动: http://${HOST}:${PORT}`);
    console.log(`上游: ${config.baseUrl}  模型: ${config.model}  Key: ${config.apiKey ? '已配置' : '未配置'}`);
    console.log(`上下文阈值: ${CONTEXT_LIMIT_TOKENS} tok 触发归档，保留最近约 ${CONTEXT_KEEP_TOKENS} tok`);
    console.log(`聊天室: 用户 ${room.state().users} / 群 ${room.state().groups} / 鱼 ${room.state().bots}`);
  });
}

start().catch((err) => {
  console.error('[start] 启动失败:', err);
  process.exit(1);
});
