// Shared auth helpers for the /admin dashboard.
// A signed HMAC cookie (issued by login.js) OR a one-time ADMIN_KEY query param
// both grant access. Secrets never reach the browser.

export const COOKIE = 'paykit_admin';

export function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function hmac(value, secret) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const buf = await crypto.subtle.sign('HMAC', key, enc.encode(value));
  const b = new Uint8Array(buf);
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

export function getCookie(req, name) {
  const c = req.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : null;
}

export async function verifyCookie(request, env) {
  const pw = env.ADMIN_PASSWORD || env.ADMIN_KEY || '';
  if (!pw) return false;
  const cookie = getCookie(request, COOKIE);
  if (!cookie) return false;
  const [ts, sig] = cookie.split('.');
  if (!ts || !sig) return false;
  if (Date.now() - Number(ts) > 7 * 24 * 60 * 60 * 1000) return false; // 7-day expiry
  return (await hmac(ts, pw)) === sig;
}

export function adminOk(request, env) {
  const url = new URL(request.url);
  const key = url.searchParams.get('admin') || '';
  const envKey = String(env.ADMIN_KEY || '').trim();
  return !!envKey && String(key).trim() === envKey;
}

export async function requireAuth(request, env) {
  return (await verifyCookie(request, env)) || adminOk(request, env);
}
