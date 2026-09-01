// Admin support console API for the shop. Uses the SAME auth as /api/admin/*.
//
//   GET  /api/support/admin            → list threads (most recent first)
//   GET  /api/support/admin?threadId=x → all messages of one thread
//   POST /api/support/admin            → { threadId, content } reply as agent
import { requireAuth, json } from '../admin/_auth.js';
import { dbRun, dbAll, BRAND } from './_db.js';

const esc = s => String(s == null ? '' : s).replace(/'/g, "''");

export async function onRequest({ request, env }) {
  if (!(await requireAuth(request, env))) return json({ error: 'Unauthorized' }, 401);
  const url = new URL(request.url);

  // ensure tables (idempotent — visitor endpoint also creates them)
  await dbRun(env, `CREATE TABLE IF NOT EXISTS support_threads (
    id TEXT PRIMARY KEY, name TEXT DEFAULT '', email TEXT DEFAULT '', page_url TEXT DEFAULT '',
    status TEXT DEFAULT 'open', created INTEGER, updated_at INTEGER)`);
  await dbRun(env, `CREATE TABLE IF NOT EXISTS support_messages (
    id TEXT PRIMARY KEY, thread_id TEXT, role TEXT, content TEXT, created INTEGER)`);

  // list threads
  if (request.method === 'GET' && !url.searchParams.get('threadId')) {
    const rows = await dbAll(env, `SELECT t.id, t.name, t.email, t.status, t.created, t.updated_at,
        (SELECT content FROM support_messages m WHERE m.thread_id=t.id ORDER BY created DESC LIMIT 1) AS last,
        (SELECT COUNT(*) FROM support_messages m WHERE m.thread_id=t.id) AS msg_count
      FROM support_threads t ORDER BY t.updated_at DESC LIMIT 100`);
    if (rows.error) return json({ error: rows.error }, 500);
    return json({ ok: true, threads: rows.map(r => ({
      id: r.id, name: r.name, email: r.email, status: r.status,
      created: r.created, updatedAt: r.updated_at, last: r.last, msgCount: r.msg_count,
    })) });
  }

  // one thread's messages
  if (request.method === 'GET' && url.searchParams.get('threadId')) {
    const tid = String(url.searchParams.get('threadId') || '').replace(/'/g, "''");
    const rows = await dbAll(env,
      `SELECT role, content, created FROM support_messages WHERE thread_id='${tid}' ORDER BY created ASC`);
    if (rows.error) return json({ error: rows.error }, 500);
    return json({ ok: true, messages: rows.map(r => ({ role: r.role, content: r.content, created: r.created })) });
  }

  // agent reply
  if (request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return json({ ok: false, error: 'Invalid JSON' }, 400); }
    const tid = String(body.threadId || '').trim();
    const content = String(body.content || '').trim().slice(0, 2000);
    if (!tid || !content) return json({ ok: false, error: 'threadId & content required' }, 400);
    const now = Date.now();
    const mid = 'sm_' + now.toString(36) + Math.random().toString(36).slice(2, 8);
    const ins = await dbRun(env,
      `INSERT INTO support_messages (id, thread_id, role, content, created)
       VALUES ('${mid}','${esc(tid)}','admin','${esc(content)}',${now})`);
    if (ins.error) return json({ ok: false, error: ins.error }, 500);
    await dbRun(env, `UPDATE support_threads SET updated_at=${now} WHERE id='${esc(tid)}'`);
    return json({ ok: true, id: mid });
  }

  return json({ ok: false, error: 'Method not allowed' }, 405);
}
