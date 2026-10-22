// RCJ Shop · 站外下单一次性通知令牌
// POST /api/order/token  → { ok:true, token, exp:600 }
// 用途：前端在调用 /api/order/notify 前先取一枚一次性随机令牌；
//   服务端落 D1 并绑定 IP，notify 校验通过后立即作废，杜绝匿名刷通知/刷买家邮件。
// 无 body、无鉴权（公开自助领取），靠 per-IP 限流收口。
import { json, corsOptions, clientIp, rateLimited } from '../paypal/_lib.js';

const TTL_MS = 10 * 60 * 1000; // 10 分钟有效

function randomToken() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function ensureTable(env) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS notify_tokens (
    token TEXT PRIMARY KEY, ip TEXT, created INTEGER, used INTEGER DEFAULT 0
  )`).run();
}

export async function onRequestOptions({ request }) { return corsOptions(request); }

export async function onRequestPost({ request, env }) {
  const ip = clientIp(request);
  // 同一 IP 10 分钟内最多领 20 枚（正常下单一人一枚，余量给重试）
  if (await rateLimited(env, 'order-token', ip, 20, TTL_MS)) {
    return json({ ok: false, error: '请求过于频繁，请稍后再试' }, 429, request);
  }
  try {
    await ensureTable(env);
    const token = randomToken();
    await env.DB.prepare('INSERT INTO notify_tokens (token, ip, created, used) VALUES (?,?,?,0)')
      .bind(token, ip, Date.now()).run();
    // 清理过期/已用旧令牌
    await env.DB.prepare('DELETE FROM notify_tokens WHERE used=1 OR created < ?')
      .bind(Date.now() - TTL_MS).run();
    return json({ ok: true, token, exp: TTL_MS / 1000 }, 200, request);
  } catch (e) {
    console.error('[order/token]', e.message);
    return json({ ok: false, error: '令牌生成失败' }, 500, request);
  }
}
