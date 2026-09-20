// RCJ Shop · 通知通道自检
// GET|POST /api/admin/notify-test
//
// 用途：真实发一条测试提醒，逐个通道回报成败 —— 专治「改完 secret 静默失效没人知道」。
// 鉴权二选一：
//   ① 服务端调用（rcj-lab 聚合后台代理）：?key=<SELFTEST_KEY>
//   ② 人工/本地：?admin=<ADMIN_KEY> 或已登录的后台 cookie（见 _auth.js）
// 只返回「通道成/败」与「密钥是否存在」的布尔，绝不回显任何密钥值。

import { notifyTelegram, notifyOwner, notifyFeishu, beijing, json, corsOptions } from '../paypal/_lib.js';
import { requireAuth } from './_auth.js';

export async function onRequestOptions() { return corsOptions(); }

function keyOk(request, env) {
  const provided = (new URL(request.url).searchParams.get('key') || '').trim();
  const expect = String(env.SELFTEST_KEY || '').trim();
  return !!expect && provided === expect;
}

async function authed(request, env) {
  if (keyOk(request, env)) return true;
  try { return await requireAuth(request, env); } catch { return false; }
}

// 只回布尔：告知「这个密钥在不在」，值本身永远不出后端
function envFlags(env) {
  return {
    RESEND_API_KEY: !!env.RESEND_API_KEY,
    TG_BOT_TOKEN: !!env.TG_BOT_TOKEN,
    TG_CHAT_ID: !!env.TG_CHAT_ID,
    FEISHU_WEBHOOK_URL: !!env.FEISHU_WEBHOOK_URL,
    FEISHU_APP_ID: !!env.FEISHU_APP_ID,
    FEISHU_APP_SECRET: !!env.FEISHU_APP_SECRET,
    FEISHU_CHAT_ID: !!env.FEISHU_CHAT_ID,
  };
}

function norm(r) {
  if (!r) return { status: 'fail', detail: '无响应' };
  if (r.skipped) return { status: 'skip', detail: '未配置，按设计跳过' };
  if (r.ok) return { status: 'ok', detail: r.id ? ('已送达 · id ' + String(r.id).slice(0, 24)) : '已送达' };
  return { status: 'fail', detail: r.error || '未知错误' };
}

async function run(env) {
  const t = beijing();
  const text = `【通知自检】shop 订单提醒通道\n时间：${t}\n这是一条测试消息 —— 收到即代表 shop 提醒链路正常。`;
  const html = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;">
<p style="font-size:16px;font-weight:700;color:#0d9488;">RCJ shop · 通知自检</p>
<p style="font-size:14px;color:#374151;line-height:1.6;">时间：${t}<br>这是一封测试邮件 —— 收到即代表 shop 的邮件提醒通道正常。</p>
<p style="font-size:12px;color:#9ca3af;">由聚合后台「通知通道自检」按钮触发，可忽略。</p></div>`;

  const [tg, mail, feishu] = await Promise.all([
    notifyTelegram(env, text).catch(e => ({ error: e.message })),
    notifyOwner(env, '【通知自检】RCJ shop 邮件通道', html).catch(e => ({ error: e.message })),
    notifyFeishu(env, text).catch(e => ({ error: e.message })),
  ]);

  const channels = [
    { id: 'telegram', label: 'Telegram', ...norm(tg) },
    { id: 'email', label: '邮件 (Resend)', ...norm(mail) },
    { id: 'feishu', label: '飞书群', ...norm(feishu) },
  ];

  return {
    ok: true,
    target: 'shop',
    checkedAt: t,
    channels,
    failed: channels.filter(c => c.status === 'fail').length,
    env: envFlags(env),
  };
}

async function handle({ request, env }) {
  if (!(await authed(request, env))) return json({ ok: false, error: '未授权' }, 401);
  try { return json(await run(env)); }
  catch (e) { return json({ ok: false, error: e.message }, 500); }
}

export async function onRequestGet(ctx) { return handle(ctx); }
export async function onRequestPost(ctx) { return handle(ctx); }
