// Visitor-facing support chat endpoint (pure Cloudflare Pages Functions).
//
//   POST { name?, email?, message, threadId? }
//        → creates/continues a conversation thread, stores the message in D1,
//          and alerts you on Telegram. Returns { ok, threadId }.
//   GET  ?threadId=xxx
//        → returns all messages for that thread (the widget polls this to
//          show agent replies — no WebSocket / Durable Object needed).
//
// Drop-in widget: see /widget.js. Tables are created on first use.
import { dbRun, dbAll, notifyTelegram, BRAND, json, corsOptions } from './_db.js';

const esc = s => String(s == null ? '' : s).replace(/'/g, "''");
const MAX = 2000;

export function onRequestOptions() { return corsOptions(); }

export async function onRequest({ request, env }) {
  const url = new URL(request.url);

  // ── visitor poll: fetch messages for a thread ──
  if (request.method === 'GET') {
    const threadId = url.searchParams.get('threadId');
    if (!threadId) return json({ error: 'threadId required' }, 400);
    const rows = await dbAll(env,
      `SELECT role, content, created FROM support_messages WHERE thread_id='${esc(threadId)}' ORDER BY created ASC`);
    if (rows.error) return json({ error: rows.error }, 500);
    return json({ ok: true, messages: rows.map(r => ({ role: r.role, content: r.content, created: r.created })) });
  }

  // ── visitor send: create/continue thread + alert admin ──
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }

    const message = String(body.message || '').trim().slice(0, MAX);
    if (!message) return json({ ok: false, error: 'Message is empty' }, 400);
    const name = String(body.name || '').trim().slice(0, 80);
    const email = String(body.email || '').trim().slice(0, 120);
    const threadId = String(body.threadId || '').trim().slice(0, 60);

    await dbRun(env, `CREATE TABLE IF NOT EXISTS support_threads (
      id TEXT PRIMARY KEY, name TEXT DEFAULT '', email TEXT DEFAULT '', page_url TEXT DEFAULT '',
      status TEXT DEFAULT 'open', created INTEGER, updated_at INTEGER)`);
    await dbRun(env, `CREATE TABLE IF NOT EXISTS support_messages (
      id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, created INTEGER)`);

    let tid = threadId;
    if (tid) {
      const ex = await dbAll(env, `SELECT id FROM support_threads WHERE id='${esc(tid)}'`);
      if (ex.error || !ex.length) tid = '';
    }
    const now = Date.now();
    if (!tid) {
      const ip = (request.headers.get('CF-Connecting-IP') || '0.0.0.0').replace(/'/g, "''");
      tid = 'sp_' + now.toString(36) + Math.random().toString(36).slice(2, 8);
      await dbRun(env,
        `INSERT INTO support_threads (id, name, email, page_url, status, created, updated_at)
         VALUES ('${tid}','${esc(name)}','${esc(email)}','${ip}','open',${now},${now})`);
    }
    const mid = 'sm_' + now.toString(36) + Math.random().toString(36).slice(2, 8);
    const ins = await dbRun(env,
      `INSERT INTO support_messages (id, thread_id, role, content, created)
       VALUES ('${mid}','${tid}','visitor','${esc(message)}',${now})`);
    if (ins.error) return json({ ok: false, error: 'Save failed' }, 500);
    await dbRun(env, `UPDATE support_threads SET updated_at=${now}, status='open' WHERE id='${tid}'`);

    const who = name || email || 'visitor';
    const line = `【${BRAND} 客服】新消息 from ${who}\n💬 ${message}\n🆔 会话 ${tid}`;
    await notifyTelegram(env, line);

    return json({ ok: true, threadId: tid });
  }

  return json({ ok: false, error: 'Method not allowed' }, 405);
}
