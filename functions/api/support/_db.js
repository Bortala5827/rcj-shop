// Self-contained DB + notify helpers for the shop support module.
// rcj-shop's paypal/_lib.js is a slimmer build without these exports, so the
// support module ships its own helpers instead of importing it.
export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export function corsOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

export async function dbRun(env, sql) {
  try {
    await env.DB.prepare(sql).run();
    return {};
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

export async function dbAll(env, sql) {
  try {
    const { results } = await env.DB.prepare(sql).all();
    return results || [];
  } catch (e) {
    return { error: String(e && e.message ? e.message : e) };
  }
}

export async function notifyTelegram(env, text) {
  const token = env.TG_BOT_TOKEN;
  const chat = env.TG_CHAT_ID;
  if (!token || !chat) return; // silent when not configured
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: String(text).slice(0, 4000) }),
    });
  } catch (_) {}
}

export const BRAND = 'RCJ';
