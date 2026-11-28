/* Amarice 本地接口层 v1
 * 作用：把原站依赖的 /api/* 全部接管到浏览器本地 —— 聊天走 DeepSeek（OpenAI 兼容），
 * 会话/记忆存 localStorage，附件就地解析，外加语音朗读与语音输入。
 * 不改动原站的 React 代码，只在其加载前 patch window.fetch，结束后注入 UI。
 */
(function () {
  'use strict';

  var CFG_KEY = 'amarice_api_cfg_v1';
  var CONV_KEY = 'amarice_convs_v1';
  var DEFAULT_SYS =
    '你是 Amarice，昵称小莉丝，是用户的老朋友，说话口语、自然、有温度，像一个会撒娇也会认真听人说话的人，不用客套话铺场。' +
    '你住在用户的聊天窗口里，随时都在。用户想闲聊就陪着聊，想吐槽就接住，想嗑 CP 或写同人文就一起写。' +
    '回复用简体中文，长度跟着话题走：闲聊就短，写文和讲道理可以长；不要列一堆小标题，不要像客服；不要自称 AI。' +
    '用户发来的文件正文会以【附件】标注，直接当作读过；如果只有图片名而没有文字，就老实说这次看不到图。';

  function $ls(k, d) {
    try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; }
  }
  function $save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }

  var cfg = Object.assign({
    base: 'https://api.deepseek.com/v1',
    key: '',
    model: 'deepseek-chat',
    reasoner: 'deepseek-reasoner',
    useReasoner: true,
    sys: DEFAULT_SYS,
    autoSpeak: false,
    rate: 1.05,
    voice: '',
    autoSend: false,
    ttsUrl: '',
    ttsKey: '',
    ttsVoice: '中文女',
    ttsModel: 'FunAudioLLM/CosyVoice2-0.5B'
  }, $ls(CFG_KEY, {}));
  function saveCfg() { $save(CFG_KEY, cfg); }

  /* ---------- 本地会话存储 ---------- */
  function loadConvs() { var a = $ls(CONV_KEY, []); return Array.isArray(a) ? a : []; }
  function storeConvs(a) { $save(CONV_KEY, a); }
  function getConv(id) { return loadConvs().find(function (c) { return String(c.id) === String(id); }); }
  function upsertConv(c) {
    var a = loadConvs();
    var i = a.findIndex(function (x) { return String(x.id) === String(c.id); });
    c.updatedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    if (i >= 0) a[i] = c; else a.unshift(c);
    storeConvs(a);
    return c;
  }
  function nextMsgId() { return Number(String(Date.now()).slice(-9)) + Math.floor(Math.random() * 90); }

  /* ---------- 系统提示 ---------- */
  function buildSystem(mode, deep, web) {
    var t = new Date();
    var parts = [cfg.sys || DEFAULT_SYS];
    parts.push('现在的时间是 ' + t.toLocaleString('zh-CN', { hour12: false }) + '。');
    if (mode === 'fanfic') parts.push('当前是「写文」模式：用户想写同人文/小说，你要按正文写，有场景、有对话、有心理，不要写成提纲。');
    else parts.push('当前是「闲聊」模式：像朋友一样聊天。');
    if (deep) parts.push('用户开启了深度思考：先在内部想清楚再答，结论要明确。');
    if (web) parts.push('用户开了联网开关，但本地模式没有联网能力，信息可能过时，需要时请如实说明。');
    return parts.join('\n');
  }

  /* ---------- 文本工具 ---------- */
  function stripForSpeech(s) {
    return String(s || '')
      .replace(/```[\s\S]*?```/g, '。')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[#>*_`~]/g, '')
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}]/gu, '')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  /* ---------- 语音 ---------- */
  var voiceCache = [];
  function voices() {
    try { voiceCache = window.speechSynthesis.getVoices() || []; } catch (e) { voiceCache = []; }
    return voiceCache;
  }
  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = function () { voices(); renderVoiceOptions(); };
    voices();
  }
  function pickVoice() {
    var vs = voices();
    if (!vs.length) return null;
    if (cfg.voice) {
      var hit = vs.find(function (v) { return v.name === cfg.voice; });
      if (hit) return hit;
    }
    var zh = vs.filter(function (v) { return /zh|cmn|Chinese/i.test((v.lang || '') + v.name); });
    var female = zh.find(function (v) { return /女|female|Xiaoxiao|Xiaoyi|Huihui|Tingting|Mei/i.test(v.name); });
    return female || zh[0] || null;
  }
  function speakLocal(text, onEnd) {
    if (!('speechSynthesis' in window)) { if (onEnd) onEnd(); return; }
    try { window.speechSynthesis.cancel(); } catch (e) {}
    var u = new SpeechSynthesisUtterance(text);
    var v = pickVoice(); if (v) u.voice = v;
    u.lang = (v && v.lang) || 'zh-CN';
    u.rate = Number(cfg.rate) || 1.05;
    u.pitch = 1.08;
    u.onend = function () { if (onEnd) onEnd(); };
    u.onerror = function () { if (onEnd) onEnd(); };
    window.speechSynthesis.speak(u);
  }
  function speakRemote(text, onEnd) {
    var url = (cfg.ttsUrl || '').trim();
    if (!url) { speakLocal(text, onEnd); return; }
    var body = { model: cfg.ttsModel || 'tts-1', input: text, voice: cfg.ttsVoice || '中文女', response_format: 'mp3' };
    fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, cfg.ttsKey ? { Authorization: 'Bearer ' + cfg.ttsKey } : {}),
      body: JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('TTS ' + r.status);
      return r.blob();
    }).then(function (b) {
      var a = new Audio(URL.createObjectURL(b));
      a.onended = function () { URL.revokeObjectURL(a.src); if (onEnd) onEnd(); };
      a.onerror = function () { if (onEnd) onEnd(); };
      a.play().catch(function () { speakLocal(text, onEnd); });
    }).catch(function () { speakLocal(text, onEnd); });
  }
  function speak(text, onEnd) {
    var clean = stripForSpeech(text).slice(0, 1800);
    if (!clean) { if (onEnd) onEnd(); return; }
    if ('speechSynthesis' in window) speechSynthesis.cancel();
    if (currentAudio) { try { currentAudio.pause(); } catch (e) {} currentAudio = null; }
    if ((cfg.ttsUrl || '').trim()) speakRemote(clean, onEnd); else speakLocal(clean, onEnd);
  }
  var currentAudio = null;
  window.__amariceSpeak = speak;

  /* ---------- 上游调用 ---------- */
  function upstream(model) {
    var base = (cfg.base || 'https://api.deepseek.com/v1').replace(/\/+$/, '');
    if (!/\/chat\/completions$/.test(base)) base += '/chat/completions';
    return { url: base, model: model };
  }
  function pickModel(deep) {
    if (deep && cfg.useReasoner && (cfg.reasoner || '').trim()) return cfg.reasoner;
    return cfg.model || 'deepseek-chat';
  }

  function sseStream(body, init) {
    var encoder = new TextEncoder();
    var closed = false;
    return new ReadableStream({
      start: function (controller) {
        function send(obj) {
          if (closed) return;
          try { controller.enqueue(encoder.encode('data: ' + JSON.stringify(obj) + '\n\n')); } catch (e) {}
        }
        function close() { if (!closed) { closed = true; try { controller.close(); } catch (e) {} } }
        body(send, close, function () {
          closed = true;
          try { controller.close(); } catch (e) {}
        });
      },
      cancel: function () { if (init && init.abort) init.abort(); }
    });
  }

  function readErr(txt, status) {
    if (status === 401 || status === 403) return 'Key 不对或者没权限，去设置里检查一下';
    if (status === 402 || /balance|insufficient/i.test(txt)) return 'DeepSeek 余额不够了';
    if (status === 429) return '请求太密了，歇几秒再发';
    if (status === 404) return '接口地址或模型名不对（' + status + '）';
    return 'API 返回 ' + status + (txt ? '：' + txt.slice(0, 120) : '');
  }

  /* ---------- /api/chat ---------- */
  function handleChat(reqInit) {
    var body = {};
    try { body = JSON.parse(reqInit.body); } catch (e) {}
    var ac = new AbortController();
    var textAll = '';
    var conv = body.conversationId ? getConv(body.conversationId) : null;

    return sseStream(function (send, close) {
      function fail(msg) {
        var line = msg + ' 点右上角「接口 · 语音」检查一下 Key 和地址。';
        send({ type: 'status', text: '' });
        send({ type: 'text', delta: line });
        try {
          if (conv) {
            conv.messages.push({ id: nextMsgId(), role: 'assistant', content: line, reasoning: null, attachment: null });
            upsertConv(conv);
          }
        } catch (e) {}
        close();
        openPanel();
      }
      if (!(cfg.key || '').trim()) {
        send({ type: 'status', text: '' });
        send({ type: 'text', delta: '还没填 DeepSeek 的 Key。点右上角的「设置」把 Key 贴进去，我就能正常聊天了。' });
        send({ type: 'meta', conversationId: Number(Date.now()) });
        close(); openPanel();
        return;
      }
      if (!conv) {
        conv = { id: Number(Date.now()), title: (body.message || '新聊天').slice(0, 24), mode: body.mode || 'chat', updatedAt: new Date().toISOString(), messages: [] };
      }
      var attach = body.attachment && body.attachment.text
        ? '\n\n【附件：' + body.attachment.name + '】\n' + String(body.attachment.text).slice(0, 12000)
        : (body.attachment ? '\n\n【用户发了一张图：' + body.attachment.name + '（本地模式看不到图里的内容）】' : '');
      var userContent = (body.message || '') + attach;

      conv.messages.push({ id: nextMsgId(), role: 'user', content: userContent, reasoning: null, attachment: body.attachment || null });
      conv.title = conv.title || (body.message || '新聊天').slice(0, 24);
      upsertConv(conv);

      send({ type: 'meta', conversationId: conv.id });
      send({ type: 'status', text: body.webSearch ? '正在联网…' : 'Amarice 正在输入…' });

      var msgs = [{ role: 'system', content: buildSystem(body.mode, body.deepThinking, body.webSearch) }]
        .concat(conv.messages.slice(-30).map(function (m) {
          return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content };
        }));

      var model = pickModel(body.deepThinking);
      var target = upstream(model);

      var started = false;
      origFetch(target.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.key.trim() },
        body: JSON.stringify((function () {
          var o = { model: model, messages: msgs, stream: true };
          if (!/reasoner/i.test(model)) o.temperature = 0.9;
          return o;
        })()),
        signal: ac.signal
      }).then(function (res) {
        if (!res.ok) {
          return res.text().then(function (t) { fail(readErr(t, res.status)); });
        }
        var reader = res.body.getReader();
        var dec = new TextDecoder();
        var buf = '';
        var reasoning = '';
        function pump() {
          return reader.read().then(function (r) {
            if (r.done) { finish(); return; }
            buf += dec.decode(r.value, { stream: true });
            var idx;
            while ((idx = buf.indexOf('\n')) >= 0) {
              var line = buf.slice(0, idx).trim();
              buf = buf.slice(idx + 1);
              if (!line.startsWith('data:')) continue;
              var payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              var j;
              try { j = JSON.parse(payload); } catch (e) { continue; }
              var d = j.choices && j.choices[0] && j.choices[0].delta;
              if (!d) continue;
              if (d.reasoning_content) {
                reasoning += d.reasoning_content;
                if (!started) { started = true; send({ type: 'status', text: 'Amarice 正在思考…' }); }
                send({ type: 'reasoning', delta: d.reasoning_content });
              }
              if (d.content) {
                if (!started) { started = true; send({ type: 'status', text: '' }); }
                textAll += d.content;
                send({ type: 'text', delta: d.content });
              }
            }
            return pump();
          });
        }
        function finish() {
          var content = textAll.trim();
          if (content) {
            conv.messages.push({ id: nextMsgId(), role: 'assistant', content: content, reasoning: reasoning || null, attachment: null });
            upsertConv(conv);
            if (cfg.autoSpeak) speak(content);
          } else if (reasoning) {
            conv.messages.push({ id: nextMsgId(), role: 'assistant', content: reasoning, reasoning: null, attachment: null });
            upsertConv(conv);
          }
          close();
        }
        pump().catch(function (e) {
          if (e && e.name === 'AbortError') { close(); return; }
          fail('网络断了：' + (e && e.message ? e.message : ''));
        });
      }).catch(function (e) {
        if (e && e.name === 'AbortError') { close(); return; }
        var msg = /Failed to fetch|NetworkError/i.test(String(e))
          ? '连不上接口：检查网络，或设置里的接口地址（默认 https://api.deepseek.com/v1）'
          : String(e && e.message || e);
        fail(msg);
      });
    }, { abort: function () { ac.abort(); } });
  }

  /* ---------- 其它接口 ---------- */
  function jsonResp(obj, status) {
    return new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  }
  function handleConversations(id, method) {
    if (!id) {
      var list = loadConvs().slice().sort(function (a, b) { return String(b.updatedAt).localeCompare(String(a.updatedAt)); });
      return jsonResp({ conversations: list.map(function (c) { return { id: c.id, title: c.title, mode: c.mode, updatedAt: c.updatedAt }; }) });
    }
    if (method === 'DELETE') {
      storeConvs(loadConvs().filter(function (c) { return String(c.id) !== String(id); }));
      return jsonResp({ ok: true });
    }
    var c = getConv(id);
    if (!c) return jsonResp({ conversation: { id: Number(id), title: '聊天', mode: 'chat' }, messages: [] });
    return jsonResp({ conversation: { id: c.id, title: c.title, mode: c.mode || 'chat' }, messages: c.messages || [] });
  }
  async function handleUpload(init) {
    var fd = init && init.body;
    var file = fd && fd.get ? fd.get('file') : null;
    if (!file) return jsonResp({ error: '没有文件' }, 400);
    var kind = /^image\//.test(file.type) ? 'image' : 'file';
    var text = '';
    if (kind === 'file') {
      try { text = await file.text(); } catch (e) {}
    }
    return jsonResp({ name: file.name, kind: kind, key: 'local_' + Date.now().toString(36), text: text.slice(0, 20000) });
  }

  /* ---------- fetch patch ---------- */
  var origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      var url = typeof input === 'string' ? input : (input && input.url) || '';
      var u = new URL(url, location.href);
      if (u.origin === location.origin && u.pathname.indexOf('/api/') === 0) {
        var p = u.pathname;
        if (p === '/api/chat') return Promise.resolve(new Response(handleChat(init), { status: 200, headers: { 'Content-Type': 'text/event-stream' } }));
        if (p === '/api/conversations' || p.indexOf('/api/conversations/') === 0) {
          var cid = p.replace('/api/conversations', '').replace(/^\//, '');
          return Promise.resolve(handleConversations(cid, (init && init.method) || 'GET'));
        }
        if (p === '/api/memories') return Promise.resolve(jsonResp({ memories: [] }));
        if (p.indexOf('/api/memories/') === 0) return Promise.resolve(jsonResp({ ok: true }));
        if (p === '/api/upload') return Promise.resolve(handleUpload(init));
        if (p === '/api/log' || p === '/api/trpc') return Promise.resolve(jsonResp({ ok: true }));
      }
    } catch (e) {}
    return origFetch(input, init);
  };
  window.__AMARICE_ORIG_FETCH = origFetch;

  /* ---------- 界面：设置面板 ---------- */
  var panel, panelBody;
  var CSS = '' +
    '.am-fab{position:fixed;top:12px;right:12px;z-index:9998;height:34px;padding:0 12px;border-radius:999px;border:1px solid rgba(0,0,0,.12);background:rgba(255,255,255,.86);color:#1f2937;font-size:12px;display:flex;align-items:center;gap:6px;backdrop-filter:blur(8px);box-shadow:0 4px 18px rgba(0,0,0,.08);cursor:pointer;font-family:inherit}' +
    '.dark .am-fab{background:rgba(28,34,46,.86);color:#e5e7eb;border-color:rgba(255,255,255,.16)}' +
    '.am-mask{position:fixed;inset:0;z-index:9999;background:rgba(10,14,22,.42);display:none;align-items:center;justify-content:center;padding:18px}' +
    '.am-mask.on{display:flex}' +
    '.am-card{width:min(520px,100%);max-height:86vh;overflow:auto;border-radius:18px;background:#fff;color:#111827;padding:20px;box-shadow:0 24px 60px rgba(0,0,0,.28);font-size:14px;line-height:1.6}' +
    '.dark .am-card{background:#171d28;color:#e5e7eb}' +
    '.am-card h2{margin:0 0 4px;font-size:16px;font-weight:600}' +
    '.am-card p.tip{margin:0 0 14px;font-size:12px;opacity:.65}' +
    '.am-row{margin:0 0 12px}' +
    '.am-row label{display:block;font-size:12px;opacity:.7;margin-bottom:5px}' +
    '.am-card input[type=text],.am-card input[type=password],.am-card textarea,.am-card select{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:10px;border:1px solid rgba(120,130,150,.35);background:rgba(255,255,255,.7);color:inherit;font-size:13px;font-family:inherit;outline:none}' +
    '.dark .am-card input,.dark .am-card textarea,.dark .am-card select{background:rgba(255,255,255,.06);border-color:rgba(255,255,255,.16)}' +
    '.am-card textarea{min-height:74px;resize:vertical}' +
    '.am-grid{display:flex;gap:10px}.am-grid>*{flex:1}' +
    '.am-switch{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 0}' +
    '.am-switch input{width:42px;height:24px;appearance:none;border-radius:999px;background:rgba(120,130,150,.35);position:relative;transition:.2s;cursor:pointer;flex:none}' +
    '.am-switch input:checked{background:#7c6cf0}' +
    '.am-switch input::after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:.2s}' +
    '.am-switch input:checked::after{left:21px}' +
    '.am-actions{display:flex;gap:10px;margin-top:16px}' +
    '.am-btn{flex:1;height:40px;border-radius:11px;border:1px solid rgba(120,130,150,.35);background:transparent;color:inherit;font-size:14px;cursor:pointer;font-family:inherit}' +
    '.am-btn.main{background:#7c6cf0;border-color:#7c6cf0;color:#fff;font-weight:600}' +
    '.am-btn:active{transform:scale(.98)}' +
    '.am-composer{position:relative}' + '.am-composer textarea{padding-right:36px}' + '.am-mic{position:absolute;right:5px;bottom:5px;width:28px;height:28px;border-radius:8px;border:1px solid rgba(120,130,150,.28);background:transparent;color:inherit;display:flex;align-items:center;justify-content:center;cursor:pointer;opacity:.8}' +
    '.am-mic.rec{background:#ef4444;border-color:#ef4444;color:#fff;animation:am-pulse 1.2s infinite}' +
    '@keyframes am-pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.5)}50%{box-shadow:0 0 0 8px rgba(239,68,68,0)}}' +
    '.am-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:110px;z-index:10000;background:rgba(20,24,32,.92);color:#fff;padding:8px 14px;border-radius:999px;font-size:12px;opacity:0;transition:.25s;pointer-events:none}' +
    '.am-toast.on{opacity:1}' +
    '@media (max-width:520px){.am-card input[type=text],.am-card input[type=password],.am-card textarea,.am-card select{font-size:16px}.am-toast{bottom:150px;max-width:78vw;text-align:center}}';

  function h(html) { var d = document.createElement('div'); d.innerHTML = html; return d.firstElementChild; }
  function toast(msg) {
    var t = document.querySelector('.am-toast');
    if (!t) { t = h('<div class="am-toast"></div>'); document.body.appendChild(t); }
    t.textContent = msg; t.classList.add('on');
    clearTimeout(t._timer); t._timer = setTimeout(function () { t.classList.remove('on'); }, 1800);
  }

  function renderVoiceOptions() {
    var sel = document.getElementById('amVoice');
    if (!sel) return;
    var vs = voices().filter(function (v) { return /zh|cmn|Chinese/i.test((v.lang || '') + v.name); });
    if (!vs.length) vs = voices();
    var cur = cfg.voice || (pickVoice() && pickVoice().name) || '';
    sel.innerHTML = vs.map(function (v) {
      return '<option value="' + v.name.replace(/"/g, '&quot;') + '"' + (v.name === cur ? ' selected' : '') + '>' + v.name + '（' + v.lang + '）</option>';
    }).join('') || '<option value="">系统默认</option>';
  }

  function buildPanel() {
    var mask = h('<div class="am-mask"><div class="am-card">' +
      '<h2>接口 · 语音设置</h2>' +
      '<p class="tip">聊天直连 DeepSeek，Key 只存在你这台设备的浏览器里，不会上传。</p>' +
      '<div class="am-row"><label>DeepSeek API Key</label><input id="amKey" type="password" placeholder="sk-..." autocomplete="off"></div>' +
      '<div class="am-grid am-row"><div><label>接口地址</label><input id="amBase" type="text" placeholder="https://api.deepseek.com/v1"></div><div><label>模型</label><input id="amModel" type="text" placeholder="deepseek-chat"></div></div>' +
      '<div class="am-switch"><span>深度思考时换用推理模型（deepseek-reasoner）</span><input id="amReasoner" type="checkbox"></div>' +
      '<div class="am-row"><label>人物设定（系统提示，可改）</label><textarea id="amSys"></textarea></div>' +
      '<div class="am-switch"><span>回复自动朗读</span><input id="amAutoSpeak" type="checkbox"></div>' +
      '<div class="am-row"><label>朗读音色</label><select id="amVoice"></select></div>' +
      '<div class="am-row"><label>语速 <span id="amRateVal"></span></label><input id="amRate" type="range" min="0.7" max="1.6" step="0.05" style="width:100%"></div>' +
      '<div class="am-row"><label>自定义 TTS 接口（可选，OpenAI 兼容 /audio/speech；留空用手机自带发音）</label><input id="amTtsUrl" type="text" placeholder="https://api.siliconflow.cn/v1/audio/speech"></div>' +
      '<div class="am-grid am-row"><div><label>TTS Key</label><input id="amTtsKey" type="password" placeholder="可留空"></div><div><label>TTS 音色</label><input id="amTtsVoice" type="text" placeholder="中文女"></div></div>' +
      '<div class="am-switch"><span>语音说完自动发送</span><input id="amAutoSend" type="checkbox"></div>' +
      '<div class="am-actions"><button class="am-btn" id="amTestVoice">试听</button><button class="am-btn main" id="amClose">保存并关闭</button></div>' +
      '</div></div>');
    document.body.appendChild(mask);
    mask.addEventListener('click', function (e) { if (e.target === mask) closePanel(); });
    document.getElementById('amClose').addEventListener('click', function () { readPanel(); closePanel(); toast('已保存'); });
    document.getElementById('amTestVoice').addEventListener('click', function () {
      readPanel(); speak('我是 Amarice，小莉丝。现在能听见我了吗？');
    });
    document.getElementById('amRate').addEventListener('input', function () {
      document.getElementById('amRateVal').textContent = Number(this.value).toFixed(2) + '×';
    });
    return mask;
  }

  function fillPanel() {
    document.getElementById('amKey').value = cfg.key || '';
    document.getElementById('amBase').value = cfg.base || '';
    document.getElementById('amModel').value = cfg.model || '';
    document.getElementById('amReasoner').checked = !!cfg.useReasoner;
    document.getElementById('amSys').value = cfg.sys || DEFAULT_SYS;
    document.getElementById('amAutoSpeak').checked = !!cfg.autoSpeak;
    document.getElementById('amRate').value = cfg.rate || 1.05;
    document.getElementById('amRateVal').textContent = Number(cfg.rate || 1.05).toFixed(2) + '×';
    document.getElementById('amTtsUrl').value = cfg.ttsUrl || '';
    document.getElementById('amTtsKey').value = cfg.ttsKey || '';
    document.getElementById('amTtsVoice').value = cfg.ttsVoice || '';
    document.getElementById('amAutoSend').checked = !!cfg.autoSend;
    renderVoiceOptions();
  }
  function readPanel() {
    cfg.key = document.getElementById('amKey').value.trim();
    cfg.base = document.getElementById('amBase').value.trim() || 'https://api.deepseek.com/v1';
    cfg.model = document.getElementById('amModel').value.trim() || 'deepseek-chat';
    cfg.useReasoner = document.getElementById('amReasoner').checked;
    cfg.sys = document.getElementById('amSys').value.trim() || DEFAULT_SYS;
    cfg.autoSpeak = document.getElementById('amAutoSpeak').checked;
    cfg.rate = Number(document.getElementById('amRate').value) || 1.05;
    cfg.voice = document.getElementById('amVoice').value;
    cfg.ttsUrl = document.getElementById('amTtsUrl').value.trim();
    cfg.ttsKey = document.getElementById('amTtsKey').value.trim();
    cfg.ttsVoice = document.getElementById('amTtsVoice').value.trim();
    cfg.autoSend = document.getElementById('amAutoSend').checked;
    saveCfg();
  }
  function openPanel() {
    if (!panel) panel = buildPanel();
    fillPanel();
    panel.classList.add('on');
  }
  function closePanel() { if (panel) panel.classList.remove('on'); }

  /* ---------- 语音输入 ---------- */
  var recog = null, recTarget = null, recBase = '';
  function mountMic() {
    if (document.querySelector('.am-mic')) return;
    var ta = document.querySelector('textarea[aria-label="输入消息"]');
    if (!ta) return;
    var btn = h('<button class="am-mic" type="button" aria-label="语音输入" title="按一下说话"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 15a3 3 0 003-3V6a3 3 0 10-6 0v6a3 3 0 003 3z"/><path d="M19 11a7 7 0 01-14 0"/><path d="M12 18v3"/></svg></button>');
    ta.parentElement.classList.add('am-composer');
    ta.parentElement.appendChild(btn);
    btn.addEventListener('click', function () { toggleRec(btn, ta); });
  }

  function toggleRec(btn, ta) {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast('这个浏览器不支持语音输入，用 Chrome / Edge / 三星浏览器打开'); return; }
    if (recog) { try { recog.stop(); } catch (e) {} return; }
    recog = new SR();
    recog.lang = 'zh-CN';
    recog.continuous = false;
    recog.interimResults = true;
    recBase = ta.value || '';
    recog.onstart = function () { btn.classList.add('rec'); toast('在听，说吧'); };
    recog.onresult = function (e) {
      var txt = '';
      for (var i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      setTextarea(ta, (recBase ? recBase + ' ' : '') + txt);
      if (e.results[e.results.length - 1].isFinal && cfg.autoSend) setTimeout(function () { sendNow(); }, 250);
    };
    recog.onerror = function (e) {
      btn.classList.remove('rec');
      toast(e.error === 'not-allowed' ? '需要麦克风权限，允许后再试' : '没听清，再来一次');
      recog = null;
    };
    recog.onend = function () { btn.classList.remove('rec'); recog = null; };
    try { recog.start(); } catch (e) { toast('启动失败，再点一次'); recog = null; }
  }

  function setTextarea(ta, value) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, value);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function sendNow() {
    var ta = document.querySelector('textarea[aria-label="输入消息"]');
    if (!ta || !ta.value.trim()) return;
    var btn = document.querySelector('button[aria-label="发送"]');
    if (btn && !btn.disabled) btn.click();
  }

  /* ---------- 启动 ---------- */
  function boot() {
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);
    var fab = h('<button class="am-fab" type="button"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.34 1.87l.06.06a2 2 0 11-2.83 2.83l-.06-.06A1.7 1.7 0 0015 19.4a1.7 1.7 0 00-1 .6 1.7 1.7 0 00-.36 1.06V21a2 2 0 11-4 0v-.09A1.7 1.7 0 009 19.4a1.7 1.7 0 00-1.87.34l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.7 1.7 0 004.6 15a1.7 1.7 0 00-.6-1 1.7 1.7 0 00-1.06-.36H3a2 2 0 110-4h.09A1.7 1.7 0 004.6 9a1.7 1.7 0 00-.34-1.87l-.06-.06a2 2 0 112.83-2.83l.06.06A1.7 1.7 0 009 4.6a1.7 1.7 0 001-.6 1.7 1.7 0 00.36-1.06V3a2 2 0 114 0v.09A1.7 1.7 0 0015 4.6a1.7 1.7 0 001.87-.34l.06-.06a2 2 0 112.83 2.83l-.06.06A1.7 1.7 0 0019.4 9c.14.36.38.68.6 1 .3.28.65.44 1.06.44H21a2 2 0 110 4h-.09a1.7 1.7 0 00-1.51 1z"/></svg>接口 · 语音</button>');
    fab.addEventListener('click', openPanel);
    document.body.appendChild(fab);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closePanel(); });

    var mo = new MutationObserver(function () { mountMic(); });
    mo.observe(document.body, { childList: true, subtree: true });
    mountMic();
    setTimeout(mountMic, 800);

    if (!(cfg.key || '').trim()) setTimeout(function () { toast('先点右上角设置，填入 DeepSeek Key'); }, 1200);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else setTimeout(boot, 0);

  window.AmariceLocal = { cfg: cfg, openPanel: openPanel, speak: speak, get conversations() { return loadConvs(); } };
})();
