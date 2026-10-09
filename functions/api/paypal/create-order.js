import { ITEMS, pp, paypalCurrency, resolveCurrency, toCurrency, langCurrency, json, corsOptions } from './_lib.js';

export async function onRequestOptions() { return corsOptions(); }

// POST /api/paypal/create-order  { item|items, email, currency?, note?, orderId? }
// 服务端创建 PayPal 订单，返回 approveUrl 供前端直接跳转 PayPal 托管收银台
// 支持两种入参：
//   单商品（旧兼容）：{ item:'voice', qty:2 }
//   多商品（新）：{ items:[{key:'question-bank',qty:1},{key:'voice',qty:2}] }
// 金额 = Σ(商品定金 × 数量)；currency 跟随前端语言：zh→CNY，en/ja→USD
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON 格式错误' }, 400); }

  // 解析商品清单（多商品优先，兼容旧单商品）
  const list = [];
  if (Array.isArray(body.items) && body.items.length) {
    for (const it of body.items) {
      const key = String(it.key || '');
      const item = ITEMS[key];
      if (!item) return json({ ok: false, error: '商品不存在: ' + key }, 400);
      const qty = Math.max(1, Math.floor(Number(it.qty) || 1));
      list.push({ key, item, qty });
    }
  } else {
    const key = String(body.item || '');
    const item = ITEMS[key];
    if (!item) return json({ ok: false, error: '商品不存在' }, 400);
    const qty = Math.max(1, Math.floor(Number(body.qty) || 1));
    list.push({ key, item, qty });
  }

  const email = String(body.email || '').slice(0, 120);
  const phone = String(body.phone || '').slice(0, 40);
  const note = String(body.note || '').slice(0, 160);
  const orderId = String(body.orderId || '').slice(0, 40);

  // 定金合计 / 全款合计
  const depSum = list.reduce((s, x) => s + x.item.deposit * x.qty, 0);
  const fullSum = list.reduce((s, x) => s + x.item.price * x.qty, 0);
  const names = list.map(x => x.item.name + '×' + x.qty).join('、');
  const desc = 'RCJ · ' + names + '（定金）' + (note ? ' · 备注: ' + note : '');

  // 货币：前端语言决定；非法值回退到账户默认；账号不支持 CNY 时统一回落 USD
  const wanted = (body.currency === 'CNY' || body.currency === 'USD')
    ? body.currency
    : (langCurrency(body.lang) || paypalCurrency(env));
  const currency = resolveCurrency(env, wanted);
  const amountVal = toCurrency(depSum, currency).toFixed(2);
  const fullVal = toCurrency(fullSum, currency).toFixed(2);

  // 回跳地址：把商品清单/email/cur/order 带在 query 里，PayPal 会追加 &token=&PayerID=
  const itemsQ = encodeURIComponent(JSON.stringify(list.map(x => ({ key: x.key, qty: x.qty }))));
  const returnUrl = `https://shop.955827.xyz/return.html?items=${itemsQ}&email=${encodeURIComponent(email)}&phone=${encodeURIComponent(phone)}&cur=${encodeURIComponent(currency)}${orderId ? '&order=' + encodeURIComponent(orderId) : ''}${note ? '&note=' + encodeURIComponent(note) : ''}`;
  const cancelUrl = `https://shop.955827.xyz/return.html?cancel=1`;

  try {
    const res = await pp(env, 'POST', '/v2/checkout/orders', {
      intent: 'CAPTURE',
      purchase_units: [{
        description: desc,
        custom_id: orderId || list[0].key,
        amount: { currency_code: currency, value: amountVal },
      }],
      application_context: {
        return_url: returnUrl,
        cancel_url: cancelUrl,
        brand_name: 'RCJ Lab',
        user_action: 'PAY_NOW',
        shipping_preference: 'NO_SHIPPING',
      },
    });
    if (res.status !== 201) {
      return json({ ok: false, error: '创建订单失败: ' + ((res.json.error_description) || JSON.stringify(res.json)).slice(0, 200) }, 500);
    }
    const links = res.json.links || [];
    const approve = links.find(l => l.rel === 'approve');
    if (!approve) return json({ ok: false, error: '未返回支付链接' }, 500);
    return json({ ok: true, id: res.json.id, approveUrl: approve.href, email, phone, currency, amount: amountVal, full: fullVal, orderId });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}
