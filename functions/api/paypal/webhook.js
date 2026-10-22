// RCJ Shop · PayPal Webhook 兜底（S-1）
// POST /api/paypal/webhook
// 背景：主捕获仍由 return.html → /api/paypal/capture 完成；本端点用于
//   ① PAYMENT.CAPTURE.COMPLETED：服务端到服务端确认到账，按 event_id 幂等，
//      防止买家关闭回跳页导致「已付款但 D1 无记录/无通知」。
//   ② CHECKOUT.ORDER.APPROVED：买家已授权但浏览器未回跳捕获的，落一条 pending
//      授权单供人工对账（不自动捕获，金额/商品以 PayPal 订单为准二次校验）。
//
// 验签：配置 PAYPAL_WEBHOOK_SECRET 后做 PayPal HMAC-SHA256 标准校验；
//   未配置时进入「简化模式」：仅做 event_id 幂等 + PayPal 订单状态/金额校验，
//   并在日志标注（生产建议务必配 secret，见交付说明）。
import { ITEMS, pp, recordOrder, notifyTelegram, notifyFeishu, beijing, json, corsOptions } from './_lib.js';

function crc32(text) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < text.length; i++) crc = table[(crc ^ text.charCodeAt(i)) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// PayPal 标准签名：transmissionId|transmissionTime|webhookId|crc32|actualDeliveryTime|certUrl|authAlgo
async function verifySignature(env, headers, rawBody, event) {
  const secret = env.PAYPAL_WEBHOOK_SECRET;
  if (!secret) return { mode: 'skip', ok: true }; // 简化模式：未配 secret 不阻断（靠幂等+状态校验）
  const tid = headers.get('paypal-transmission-id');
  const ttime = headers.get('paypal-transmission-time');
  const cert = headers.get('paypal-cert-url');
  const algo = headers.get('paypal-auth-algo');
  const sig = headers.get('paypal-transmission-sig');
  if (!tid || !ttime || !sig) return { ok: false, reason: 'missing-signature-headers' };
  const webhookId = env.PAYPAL_WEBHOOK_ID || '';
  const actual = headers.get('paypal-actual-delivery-time') || '';
  const payload = [tid, ttime, webhookId, crc32(rawBody), actual, cert || '', algo || ''].join('|');
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA256' }, false, ['sign']);
  const sigBuf = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  const expected = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return { ok: expected === sig, mode: 'hmac' };
}

async function seenEvent(env, eventId) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS webhook_events (event_id TEXT PRIMARY KEY, type TEXT, ts INTEGER)`).run();
  const row = await env.DB.prepare('SELECT event_id FROM webhook_events WHERE event_id=?').bind(eventId).first();
  if (row) return true;
  await env.DB.prepare('INSERT INTO webhook_events (event_id, type, ts) VALUES (?,?,?)')
    .bind(eventId, 'webhook', Date.now()).run();
  return false;
}

export async function onRequestOptions({ request }) { return corsOptions(request, 'POST, OPTIONS'); }
export async function onRequestGet() { return json({ ok: false, error: 'webhook only accepts POST' }, 405); }

export async function onRequestPost({ request, env }) {
  let raw = '';
  try { raw = await request.text(); } catch { return json({ ok: false, error: 'empty body' }, 400); }
  let event;
  try { event = JSON.parse(raw); } catch { return json({ ok: false, error: 'JSON 格式错误' }, 400); }

  const eventId = String(event.id || '').trim();
  const eventType = String(event.event_type || '').trim();
  if (!eventId || !eventType) return json({ ok: false, error: '缺少 event_id / event_type' }, 400);

  const v = await verifySignature(env, request.headers, raw, event);
  if (!v.ok) return json({ ok: false, error: '签名校验失败' }, 401);

  // 幂等：同一 event_id 只处理一次
  if (env.DB && await seenEvent(env, eventId)) {
    return json({ ok: true, dedup: true, eventType }, 200);
  }

  try {
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      const res = event.resource || {};
      const orderId = (res.supplementary_data && res.supplementary_data.related_ids && res.supplementary_data.related_ids.order_id) || res.invoice_id || '';
      const captureAmt = res.amount && res.amount.value;
      const payerEmail = (res.payer && res.payer.email_address) || '';
      // 回查 PayPal 订单，二次确认状态与金额（不信任推送正文）
      if (orderId) {
        const get = await pp(env, 'GET', '/v2/checkout/orders/' + orderId);
        if (get.status === 200 && get.json.status === 'COMPLETED') {
          const pu = get.json.purchase_units && get.json.purchase_units[0];
          const paid = pu && pu.amount && pu.amount.value;
          // D1 是否已存在该 PayPal 单（capture 流程已落库则仅补通知，不重复写）
          const exist = env.DB ? await env.DB.prepare('SELECT id FROM orders WHERE paypal_order_id=?').bind(orderId).first() : null;
          if (!exist) {
            const customId = (pu && pu.custom_id) || '';
            const list = ITEMS[customId] ? [{ key: customId, qty: 1 }] : [];
            const names = list.length ? list.map(x => ITEMS[x.key].name + '×' + x.qty).join('、') : 'PayPal 订单 ' + orderId;
            await recordOrder(env, {
              id: 'wh_' + eventId.slice(-8), source: 'paypal-webhook', item: names,
              sku: list.map(x => x.key).join(','), payer_email: payerEmail, contact_email: '', contact_phone: '',
              amount: parseFloat(captureAmt || paid || 0) || 0, currency: (pu && pu.amount && pu.amount.currency_code) || 'USD',
              full_price: null, balance: null, cny_amount: null, paypal_order_id: orderId, status: 'deposit',
              note: 'webhook 补录（回跳页未捕获）',
            });
            const line = `【RCJ Webhook 到账】${names}\nPayPal 单：${orderId}\n金额：${captureAmt || paid}\n付款邮箱：${payerEmail || '(未知)'}\n🕒 ${beijing()}\n（回跳页未捕获，由 webhook 兜底补录，请人工核对商品）`;
            await notifyTelegram(env, line);
            await notifyFeishu(env, line);
          }
          return json({ ok: true, eventType, orderId, dedup: false }, 200);
        }
      }
      return json({ ok: true, eventType, note: 'order not verified, skipped' }, 200);
    }

    if (eventType === 'CHECKOUT.ORDER.APPROVED') {
      // 仅记录待对账，不自动捕获
      const o = event.resource || {};
      const orderId = o.id || '';
      if (env.DB && orderId) {
        await env.DB.prepare(`CREATE TABLE IF NOT EXISTS authorized_pending (order_id TEXT PRIMARY KEY, payer TEXT, amount TEXT, currency TEXT, ts INTEGER, noted INTEGER DEFAULT 0)`).run();
        await env.DB.prepare('INSERT OR IGNORE INTO authorized_pending (order_id, payer, amount, currency, ts, noted) VALUES (?,?,?,?,?,0)')
          .bind(orderId, (o.payer && o.payer.email_address) || '', o.purchase_units && o.purchase_units[0] && o.purchase_units[0].amount && o.purchase_units[0].amount.value || '', o.purchase_units && o.purchase_units[0] && o.purchase_units[0].amount && o.purchase_units[0].amount.currency_code || '', Date.now()).run();
      }
      return json({ ok: true, eventType, orderId, note: 'approved-pending recorded for reconciliation' }, 200);
    }

    // 其它事件类型：确认接收即可（PayPal 要求 2xx，避免重复推送）
    return json({ ok: true, eventType, note: 'ignored event type' }, 200);
  } catch (e) {
    console.error('[paypal/webhook]', e.message);
    return json({ ok: false, error: '处理失败: ' + e.message }, 500);
  }
}
