#!/usr/bin/env node
/**
 * 夢囈手帳 · 后端（零依赖即可运行）
 *
 * 启动：node server/server.js
 * 可选环境变量见 .env.example：
 *   MONGODB_URI     启用 MongoDB（需 npm i mongoose，未装则回落到文件存储）
 *   JWT_SECRET      签名密钥
 *   AI_API_KEY      大模型密钥（OpenAI / 通义千问兼容接口）
 *   QWEATHER_KEY    和风天气密钥
 *   OSS_*           阿里云 OSS（需 npm i ali-oss，未装则存本地 uploads/）
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const BACKUP_DIR = path.join(ROOT, 'backups');
const APP_HTML = path.join(ROOT, '..', 'index.html');
const PORT = Number(process.env.PORT || 5178);
const SECRET = process.env.JWT_SECRET || 'mengyi-dev-secret-change-me';
const KEEP_BACKUPS = Number(process.env.KEEP_BACKUPS || 7);

/* ---------- .env ---------- */
(function loadEnv() {
  const p = path.join(ROOT, '.env');
  if (!fs.existsSync(p)) return;
  fs.readFileSync(p, 'utf8').split(/\r?\n/).forEach(line => {
    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  });
})();

for (const d of [DATA_DIR, UPLOAD_DIR, BACKUP_DIR]) fs.mkdirSync(d, { recursive: true });

/* ---------- 工具 ---------- */
const json = (res, code, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-File-Name',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Cache-Control': 'no-store'
  });
  res.end(body);
};

const readBody = (req, limit = 24 * 1024 * 1024) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  req.on('data', c => {
    size += c.length;
    if (size > limit) { reject(new Error('payload too large')); req.destroy(); return; }
    chunks.push(c);
  });
  req.on('end', () => resolve(Buffer.concat(chunks)));
  req.on('error', reject);
});

const readJSON = async req => {
  const raw = await readBody(req);
  if (!raw.length) return {};
  return JSON.parse(raw.toString('utf8'));
};

function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return salt + ':' + hash;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function signToken(payload) {
  const body = Buffer.from(JSON.stringify(Object.assign({}, payload, { exp: Date.now() + 7 * 864e5 }))).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig !== expect) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}
function authUser(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return verifyToken(token);
}
const uid = p => p + crypto.randomBytes(6).toString('hex');

/* ---------- 存储层：MongoDB（可选） / JSON 文件 ---------- */
let mongo = null;
const memory = { users: [], states: {} };
let dirty = false;

async function loadFileStore() {
  try {
    const u = JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'users.json'), 'utf8'));
    memory.users = Array.isArray(u) ? u : [];
  } catch (e) { memory.users = []; }
  try {
    const s = JSON.parse(await fsp.readFile(path.join(DATA_DIR, 'states.json'), 'utf8'));
    memory.states = s && typeof s === 'object' ? s : {};
  } catch (e) { memory.states = {}; }
}
async function flushFileStore() {
  dirty = false;
  await fsp.writeFile(path.join(DATA_DIR, 'users.json'), JSON.stringify(memory.users, null, 1));
  await fsp.writeFile(path.join(DATA_DIR, 'states.json'), JSON.stringify(memory.states));
}
setInterval(() => { if (dirty && !mongo) flushFileStore().catch(() => {}); }, 3000);

async function initMongo() {
  if (!process.env.MONGODB_URI) return null;
  try {
    const mongoose = await import('mongoose');
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 4000 });
    const S = mongoose.Schema;
    const User = mongoose.model('User', new S({
      uid: { type: String, unique: true },
      email: { type: String, unique: true },
      pass: String,
      createdAt: Date
    }));
    const Notebook = mongoose.model('Notebook', new S({
      uid: String,
      state: Object,
      updatedAt: Date
    }));
    console.log('[store] MongoDB 已连接');
    return { User, Notebook };
  } catch (e) {
    console.warn('[store] MongoDB 不可用，回落文件存储：' + e.message);
    return null;
  }
}

async function findUser(email) {
  if (mongo) return (await mongo.User.findOne({ email })) || null;
  return memory.users.find(u => u.email === email) || null;
}
async function createUser(email, pass) {
  const rec = { uid: uid('u'), email, pass: hashPassword(pass), createdAt: new Date().toISOString() };
  if (mongo) {
    const doc = await mongo.User.create(rec);
    return { uid: doc.uid, email: doc.email };
  }
  memory.users.push(rec);
  dirty = true;
  return { uid: rec.uid, email: rec.email };
}
async function getUserById(id) {
  if (mongo) return (await mongo.User.findOne({ uid: id })) || null;
  return memory.users.find(u => u.uid === id) || null;
}
async function getNotebook(userId) {
  if (mongo) {
    const doc = await mongo.Notebook.findOne({ uid: userId });
    return doc ? doc.state : null;
  }
  return memory.states[userId] || null;
}
async function putNotebook(userId, state) {
  if (mongo) {
    await mongo.Notebook.findOneAndUpdate({ uid: userId }, { $set: { state, updatedAt: new Date() } }, { upsert: true });
    return;
  }
  memory.states[userId] = state;
  dirty = true;
}

/* ---------- 备份 ---------- */
function today() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

async function snapshotAll() {
  let states = {};
  if (mongo) {
    const docs = await mongo.Notebook.find({});
    docs.forEach(d => { states[d.uid] = d.state; });
  } else {
    states = memory.states;
  }
  return {
    createdAt: new Date().toISOString(),
    books: Object.values(states).reduce((n, s) => n + ((s && s.books) ? s.books.length : 0), 0),
    users: Object.keys(states).length,
    states
  };
}

async function backupNow() {
  try {
    const snap = await snapshotAll();
    const file = path.join(BACKUP_DIR, 'backup-' + today() + '.json');
    await fsp.writeFile(file, JSON.stringify(snap));
    const files = (await fsp.readdir(BACKUP_DIR)).filter(f => /^backup-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    const extra = files.slice(0, Math.max(0, files.length - KEEP_BACKUPS));
    for (const f of extra) await fsp.unlink(path.join(BACKUP_DIR, f)).catch(() => {});
    console.log('[backup] ' + path.basename(file) + ' 共 ' + snap.books + ' 本，保留最近 ' + KEEP_BACKUPS + ' 天');
    return file;
  } catch (e) {
    console.warn('[backup] 失败：' + e.message);
    return null;
  }
}

function scheduleDailyBackup() {
  const now = new Date();
  const next = new Date(now);
  next.setHours(3, 1, 0, 0); // 每日 03:01
  if (next <= now) next.setDate(next.getDate() + 1);
  const delay = next - now;
  setTimeout(async () => {
    await backupNow();
    scheduleDailyBackup();
  }, delay);
  const h = Math.floor(delay / 3600000);
  console.log('[backup] 下一次自动备份约 ' + h + ' 小时后');
}

/* ---------- 天气 ---------- */
async function fetchWeather(city, fallback) {
  const key = process.env.QWEATHER_KEY;
  if (!key || !city) return { text: fallback || '晴', temp: null, source: 'local' };
  try {
    const geo = await fetch('https://geoapi.qweather.com/v2/city/lookup?number=1&key=' + key + '&location=' + encodeURIComponent(city))
      .then(r => r.json());
    if (!geo.location || !geo.location.length) throw new Error('city not found');
    const loc = geo.location[0].id;
    const now = await fetch('https://devapi.qweather.com/v7/weather/now?key=' + key + '&location=' + loc).then(r => r.json());
    return { text: now.now.text, temp: Number(now.now.temp), source: 'qweather' };
  } catch (e) {
    return { text: fallback || '晴', temp: null, source: 'fallback' };
  }
}

/* ---------- 生命体征演算 ---------- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

function localVitals(persona, weather, date) {
  const base = (persona && persona.base) || { hr: 68, br: 14, sys: 118, dia: 76 };
  const hour = date.getHours() + date.getMinutes() / 60;
  const night = hour >= 22 || hour < 6;
  let mod = 7 * Math.sin((hour - 9) / 24 * Math.PI * 2);
  if (night) mod += (persona.chrono === 'night' ? -2 : -7);
  const wm = { '晴': 2, '阴': -1, '陰': -1, '雨': 3, '雪': -4, '雾': -2, '霧': -2, '雷雨': 7 }[weather] || 0;
  mod += wm;
  const traits = String((persona && persona.traits) || '');
  if (/危險|危险|佔有|占有|暴躁|易怒|躁|狂/.test(traits)) mod += 4;
  if (/溫柔|温柔|冷靜|冷静|安靜|安静/.test(traits)) mod -= 3;
  if (/疲憊|疲惫|虛弱|虚弱|舊傷|旧伤|失眠/.test(traits)) mod -= 5;

  const jitter = (Math.random() * 8 - 4);
  const hr = clamp(Math.round(base.hr + mod + jitter), 44, 136);
  const br = clamp(Math.round(base.br + Math.sin((hour - 9) / 24 * Math.PI * 2) * 2 + (wm > 0 ? 1 : -0.4)), 8, 26);
  const dh = hr - base.hr;
  const sys = clamp(Math.round(base.sys + dh * 0.9 + (Math.random() * 5 - 2)), 86, 168);
  const dia = clamp(Math.round(base.dia + dh * 0.45 + (Math.random() * 4 - 2)), 48, 112);
  return {
    heart_rate: hr,
    breath_rate: br,
    blood_pressure: sys + '/' + Math.max(48, Math.min(dia, sys - 20)),
    temperature: +(36.4 + Math.random() * 0.3 + (wm < 0 ? -0.2 : 0)).toFixed(1),
    mood: hr > 95 ? '心跳偏快' : hr > 78 ? '微熱' : '平靜',
    note: '由本地生理引擎推演（未接大模型）'
  };
}

async function aiVitals(persona, weather, date) {
  const key = process.env.AI_API_KEY;
  if (!key) return null;
  const base = (process.env.AI_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
  const model = process.env.AI_MODEL || 'qwen-plus';
  const hour = date.getHours();
  const prompt = [
    '角色名：' + ((persona && persona.name) || '他'),
    '世界观：' + ((persona && persona.world) || '未填写'),
    '性格标签：' + ((persona && persona.traits) || '未填写'),
    '人设补充：' + ((persona && persona.background) || '无'),
    '基线：心率 ' + (persona.base ? persona.base.hr : 68) + '，呼吸 ' + (persona.base ? persona.base.br : 14) + '，血压 ' + (persona.base ? persona.base.sys + '/' + persona.base.dia : '118/76'),
    '作息：' + ((persona && persona.chrono) || 'none'),
    '环境：' + date.toISOString() + '（当地 ' + hour + ' 点），天气 ' + weather,
    '要求：结合昼夜节律与性格，推演此刻最合理的生命体征。只输出 JSON：{"heart_rate":整数,"breath_rate":整数,"blood_pressure":"收缩/舒张","temperature":小数,"mood":"两个字的情绪","note":"一句不超过20字的状态描写"}'
  ].join('\n');

  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
    body: JSON.stringify({
      model,
      temperature: 0.4,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: '你是一个生理状态模拟器。输出严格 JSON，数值必须落在人类静息生理范围内，且与角色设定、时间、天气一致。' },
        { role: 'user', content: prompt }
      ]
    })
  });
  if (!res.ok) throw new Error('AI HTTP ' + res.status);
  const j = await res.json();
  const text = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
  const data = JSON.parse(String(text).replace(/```json|```/g, '').trim());
  return {
    heart_rate: clamp(Math.round(data.heart_rate), 40, 180),
    breath_rate: clamp(Math.round(data.breath_rate), 5, 40),
    blood_pressure: String(data.blood_pressure || '118/76'),
    temperature: Number(data.temperature || 36.6),
    mood: data.mood || '平静',
    note: data.note || '大模型推演'
  };
}

/* ---------- 对象存储 ---------- */
async function saveUpload(buffer, mime, name) {
  const ext = (mime && mime.includes('png')) ? '.png' : (mime && mime.includes('webp')) ? '.webp' : (mime && mime.includes('gif')) ? '.gif' : '.jpg';
  const key = 'uploads/' + (name || uid('img')) + ext;
  const OSS = process.env.OSS_ACCESS_KEY_ID && process.env.OSS_ACCESS_KEY_SECRET && process.env.OSS_BUCKET;
  if (OSS) {
    try {
      const { default: OSSClient } = await import('ali-oss');
      const client = new OSSClient({
        region: process.env.OSS_REGION,
        accessKeyId: process.env.OSS_ACCESS_KEY_ID,
        accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
        bucket: process.env.OSS_BUCKET
      });
      const r = await client.put(key, Buffer.from(buffer), { mime: mime || 'image/jpeg' });
      return { url: r.url, storage: 'oss' };
    } catch (e) {
      console.warn('[oss] 上传失败，改存本地：' + e.message);
    }
  }
  await fsp.writeFile(path.join(UPLOAD_DIR, key.replace('uploads/', '')), buffer);
  return { url: '/uploads/' + key.replace('uploads/', ''), storage: 'local' };
}

/* ---------- 路由 ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.json': 'application/json' };

async function serveFile(res, file) {
  try {
    const buf = await fsp.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=60' });
    res.end(buf);
  } catch (e) {
    json(res, 404, { error: 'not found' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-File-Name',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
    });
    return res.end();
  }

  try {
    if (p === '/api/health') return json(res, 200, { ok: true, store: mongo ? 'mongodb' : 'file', time: new Date().toISOString() });

    if (p === '/' || p === '/app') {
      if (fs.existsSync(APP_HTML)) {
        const html = await fsp.readFile(APP_HTML, 'utf8');
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return res.end(html);
      }
      return json(res, 404, { error: '未找到 梦呓手账本.html，请把它与本目录放在同一层' });
    }

    if (p.startsWith('/uploads/')) {
      const name = p.replace('/uploads/', '').replace(/\//g, '');
      return serveFile(res, path.join(UPLOAD_DIR, name));
    }

    if (p === '/api/auth/register' && req.method === 'POST') {
      const body = await readJSON(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { error: '邮箱格式不对' });
      if (password.length < 6) return json(res, 400, { error: '密码至少 6 位' });
      if (await findUser(email)) return json(res, 409, { error: '这个邮箱已注册' });
      const user = await createUser(email, password);
      return json(res, 200, { token: signToken({ uid: user.uid, email }), user: { email } });
    }

    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readJSON(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const user = await findUser(email);
      if (!user || !verifyPassword(password, user.pass)) return json(res, 401, { error: '邮箱或密码不正确' });
      return json(res, 200, { token: signToken({ uid: user.uid, email }), user: { email } });
    }

    if (p === '/api/state' && req.method === 'GET') {
      const au = authUser(req);
      if (!au) return json(res, 401, { error: '未登录' });
      const state = await getNotebook(au.uid);
      return json(res, 200, { state: state || null });
    }

    if (p === '/api/state' && req.method === 'PUT') {
      const au = authUser(req);
      if (!au) return json(res, 401, { error: '未登录' });
      const body = await readJSON(req);
      if (!body.state || !Array.isArray(body.state.books)) return json(res, 400, { error: 'state 不合法' });
      await putNotebook(au.uid, body.state);
      return json(res, 200, { ok: true, savedAt: new Date().toISOString() });
    }

    if (p === '/api/upload' && req.method === 'POST') {
      const au = authUser(req);
      if (!au) return json(res, 401, { error: '未登录' });
      const buf = await readBody(req);
      if (!buf.length) return json(res, 400, { error: '空文件' });
      const name = (req.headers['x-file-name'] || uid('img')).replace(/[^\w.-]/g, '').slice(0, 60);
      const r = await saveUpload(buf, req.headers['content-type'], name);
      return json(res, 200, { url: r.url, storage: r.storage });
    }

    if (p === '/api/vitals' && req.method === 'POST') {
      const au = authUser(req);
      if (!au) return json(res, 401, { error: '未登录' });
      const body = await readJSON(req);
      const persona = body.persona || {};
      const date = body.localTime ? new Date(body.localTime) : new Date();
      const w = await fetchWeather(body.city || process.env.DEFAULT_CITY || '', body.weather);
      try {
        const ai = await aiVitals(persona, w.text, date);
        if (ai) return json(res, 200, { data: Object.assign({}, ai, { weather: w.text }), source: 'llm' });
      } catch (e) {
        console.warn('[vitals] 大模型失败，使用本地引擎：' + e.message);
      }
      return json(res, 200, { data: Object.assign({}, localVitals(persona, w.text, date), { weather: w.text }), source: 'local' });
    }

    if (p === '/api/backup' && req.method === 'POST') {
      const au = authUser(req);
      if (!au) return json(res, 401, { error: '未登录' });
      const file = await backupNow();
      return json(res, 200, { ok: !!file, file: file ? path.basename(file) : null });
    }

    return json(res, 404, { error: 'no route' });
  } catch (e) {
    console.error(e);
    return json(res, 500, { error: e.message });
  }
});

(async () => {
  await loadFileStore();
  mongo = await initMongo();
  if (!fs.existsSync(path.join(BACKUP_DIR, 'backup-' + today() + '.json'))) await backupNow();
  scheduleDailyBackup();
  server.listen(PORT, () => {
    console.log('夢囈手帳 server 已启动 → http://localhost:' + PORT);
    console.log('存储：' + (mongo ? 'MongoDB' : 'JSON 文件 data/') + '；图片：' + (process.env.OSS_BUCKET ? '阿里云 OSS' : '本地 uploads/'));
    console.log('大模型：' + (process.env.AI_API_KEY ? (process.env.AI_MODEL || 'qwen-plus') : '未配置（本地生理引擎）'));
  });
})();

process.on('SIGINT', async () => {
  if (!mongo && dirty) await flushFileStore().catch(() => {});
  console.log('\nbye');
  process.exit(0);
});
