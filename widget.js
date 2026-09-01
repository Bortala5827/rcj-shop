/*
 * RCJ Stack — drop-in support chat widget.
 * Embed on any page with:  <script src="/widget.js"></script>
 * It posts to same-origin /api/support/message and polls for agent replies.
 * For cross-origin embedding, enable CORS on that endpoint (already set to *).
 */
(function () {
  var API = '/api/support/message';
  var I18N = {
    en: { title: 'Support', intro: 'Hi! How can we help you today?', name: 'Your name (optional)',
          email: 'Your email (optional)', placeholder: 'Type your message…', send: 'Send',
          err: 'Could not send. Please try again.' },
    zh: { title: '客服', intro: '您好！有什么可以帮您？', name: '您的称呼（选填）',
          email: '您的邮箱（选填）', placeholder: '输入您的问题…', send: '发送',
          err: '发送失败，请重试。' },
    ja: { title: 'サポート', intro: 'こんにちは！ご質問はありますか？', name: 'お名前（任意）',
          email: 'メール（任意）', placeholder: 'メッセージを入力…', send: '送信',
          err: '送信できませんでした。もう一度お試しください。' },
  };
  function lang() { var l = (document.documentElement.lang || 'en').slice(0, 2); return I18N[l] ? l : 'en'; }
  function t(k) { return I18N[lang()][k]; }

  var KEY = 'rcj_support_thread';
  var threadId = localStorage.getItem(KEY) || '';
  var lastTs = 0;
  var timer = null;

  // ── styles ──
  var css = document.createElement('style');
  css.textContent = `
  #rcj-widget{position:fixed;right:20px;bottom:20px;z-index:2147483000;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
  #rcj-bubble{width:56px;height:56px;border-radius:50%;background:#0d9488;color:#fff;border:0;cursor:pointer;font-size:24px;box-shadow:0 8px 24px rgba(13,148,136,.4)}
  #rcj-panel{display:none;position:fixed;right:20px;bottom:88px;width:340px;max-width:calc(100vw - 40px);height:460px;max-height:calc(100vh - 120px);background:#fff;border:1px solid #e6e8ec;border-radius:16px;box-shadow:0 16px 48px rgba(15,23,42,.18);flex-direction:column;overflow:hidden}
  #rcj-head{background:#0d9488;color:#fff;padding:14px 16px;font-weight:700}
  #rcj-head small{display:block;font-weight:400;opacity:.85;font-size:.78rem}
  #rcj-msgs{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:#f7f8fa}
  .rcj-m{max-width:80%;padding:9px 12px;border-radius:12px;font-size:.9rem;line-height:1.45;white-space:pre-wrap;word-break:break-word}
  .rcj-vis{background:#fff;border:1px solid #e6e8ec;align-self:flex-end;border-bottom-right-radius:4px}
  .rcj-agn{background:#0d9488;color:#fff;align-self:flex-start;border-bottom-left-radius:4px}
  #rcj-form{border-top:1px solid #e6e8ec;padding:10px;display:flex;flex-direction:column;gap:6px;background:#fff}
  #rcj-form input,#rcj-form textarea{width:100%;border:1px solid #e6e8ec;border-radius:9px;padding:8px 10px;font-size:.88rem;font-family:inherit;resize:none}
  #rcj-form button{background:#0d9488;color:#fff;border:0;border-radius:9px;padding:9px;font-weight:700;cursor:pointer}
  #rcj-form button:disabled{opacity:.6}`;
  document.head.appendChild(css);

  // ── DOM ──
  var root = document.createElement('div'); root.id = 'rcj-widget';
  root.innerHTML = `
    <div id="rcj-panel">
      <div id="rcj-head">${t('title')}<small>${t('intro')}</small></div>
      <div id="rcj-msgs"></div>
      <div id="rcj-form">
        <input id="rcj-name" type="text" placeholder="${t('name')}" />
        <input id="rcj-email" type="email" placeholder="${t('email')}" />
        <textarea id="rcj-text" rows="2" placeholder="${t('placeholder')}"></textarea>
        <button id="rcj-send">${t('send')}</button>
      </div>
    </div>
    <button id="rcj-bubble" title="${t('title')}">💬</button>`;
  document.body.appendChild(root);

  var panel = document.getElementById('rcj-panel');
  var bubble = document.getElementById('rcj-bubble');
  var msgs = document.getElementById('rcj-msgs');
  var nameEl = document.getElementById('rcj-name');
  var emailEl = document.getElementById('rcj-email');
  var textEl = document.getElementById('rcj-text');
  var sendBtn = document.getElementById('rcj-send');

  bubble.addEventListener('click', function () {
    panel.style.display = panel.style.display === 'flex' ? 'none' : 'flex';
    if (panel.style.display === 'flex') { textEl.focus(); if (threadId) poll(true); }
  });

  function addMsg(role, content) {
    var d = document.createElement('div');
    d.className = 'rcj-m ' + (role === 'admin' ? 'rcj-agn' : 'rcj-vis');
    d.textContent = content;
    msgs.appendChild(d);
    msgs.scrollTop = msgs.scrollHeight;
  }

  async function send() {
    var content = textEl.value.trim();
    if (!content) return;
    sendBtn.disabled = true;
    addMsg('visitor', content);
    var payload = { message: content, threadId: threadId, name: nameEl.value.trim(), email: emailEl.value.trim() };
    try {
      var r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      var d = await r.json();
      if (d.ok && d.threadId) {
        threadId = d.threadId; localStorage.setItem(KEY, threadId);
        startPoll();
      } else { addMsg('admin', t('err')); }
    } catch (e) { addMsg('admin', t('err')); }
    textEl.value = ''; sendBtn.disabled = false; textEl.focus();
  }
  sendBtn.addEventListener('click', send);
  textEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });

  async function poll(initial) {
    if (!threadId) return;
    try {
      var r = await fetch(API + '?threadId=' + encodeURIComponent(threadId));
      var d = await r.json();
      if (!d.ok) return;
      (d.messages || []).forEach(function (m) {
        if (m.role === 'admin' && (!lastTs || m.created > lastTs)) {
          addMsg('admin', m.content);
          lastTs = m.created;
        }
      });
    } catch (e) {}
  }
  function startPoll() { if (timer) return; timer = setInterval(function () { poll(false); }, 4000); }

  // re-render copy when language changes (observer on <html lang>)
  var lastLang = lang();
  setInterval(function () {
    if (lang() !== lastLang) {
      lastLang = lang();
      document.getElementById('rcj-head').innerHTML = t('title') + '<small>' + t('intro') + '</small>';
      nameEl.placeholder = t('name'); emailEl.placeholder = t('email');
      textEl.placeholder = t('placeholder'); sendBtn.textContent = t('send'); bubble.title = t('title');
    }
  }, 1000);
})();
