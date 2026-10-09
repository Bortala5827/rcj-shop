import { ITEMS, pp, recordOrder, notifyTelegram, notifyOwner, notifyFeishu, notifyBuyer, beijing, resolveCurrency, toCurrency, CNY_PER_USD, json, corsOptions } from './_lib.js';

export async function onRequestOptions() { return corsOptions(); }

// POST /api/paypal/capture  { orderId, items?, item?, email?, currency?, note? }
// 用户从 PayPal 回跳后，服务端二次确认金额并捕获，再写订单 + 通知（Telegram + 邮件）
// 支持多商品：items=[{key,qty}]；兼容旧单商品 {item}
export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON 格式错误' }, 400); }
  const orderId = String(body.orderId || '');
  const email = String(body.email || '').slice(0, 120);
  const phone = String(body.phone || '').slice(0, 40);
  const note = String(body.note || '').slice(0, 160);
  // 与建单保持同一套回落规则，避免「建单 USD / 校验 CNY」导致金额不符被拦截
  const currency = resolveCurrency(env, body.currency === 'CNY' || body.currency === 'USD' ? body.currency : 'CNY');
  if (!orderId) return json({ ok: false, error: '参数缺失' }, 400);

  // 解析商品清单：优先 body.items（数组或 JSON 字符串），兼容旧单商品 body.item
  let list = [];
  if (Array.isArray(body.items)) list = body.items;
  else if (typeof body.items === 'string' && body.items) {
    try { list = JSON.parse(body.items); } catch { list = []; }
  }
  if (!list.length && body.item) list = [{ key: body.item, qty: 1 }];
  list = list.map(x => ({ key: String(x.key || ''), qty: Math.max(1, Math.floor(Number(x.qty) || 1)) }));

  try {
    // 1) 查询订单，还原商品（custom_id 兜底：新单=订单号、旧单=商品 key）
    const get = await pp(env, 'GET', '/v2/checkout/orders/' + orderId);
    if (get.status !== 200) return json({ ok: false, error: '订单查询失败' }, 400);
    if (!list.length) {
      const cid = (get.json.purchase_units && get.json.purchase_units[0] && get.json.purchase_units[0].custom_id) || '';
      if (ITEMS[cid]) list = [{ key: cid, qty: 1 }];
      else return json({ ok: false, error: '商品不匹配' }, 400);
    }
    if (!list.every(x => ITEMS[x.key])) return json({ ok: false, error: '商品不匹配' }, 400);

    const depSum = list.reduce((s, x) => s + ITEMS[x.key].deposit * x.qty, 0);
    const fullSum = list.reduce((s, x) => s + ITEMS[x.key].price * x.qty, 0);
    const balSum = list.reduce((s, x) => s + ITEMS[x.key].balance * x.qty, 0);

    // 2) 二次确认金额（应与定金合计一致，防止篡改；金额按本单货币校验）
    const pu = get.json.purchase_units && get.json.purchase_units[0];
    const amt = pu && pu.amount && pu.amount.value;
    const expected = toCurrency(depSum, currency).toFixed(2);
    if (amt !== expected) return json({ ok: false, error: '金额不符，已拦截(' + amt + '≠' + expected + ')' }, 400);

    // 3) 捕获
    const cap = await pp(env, 'POST', '/v2/checkout/orders/' + orderId + '/capture');
    if (cap.status !== 201) return json({ ok: false, error: '捕获失败: ' + JSON.stringify(cap.json).slice(0, 200) }, 500);

    // 4) 金额换算：本单以 currency 计，cny_amount 统一折算人民币便于后台汇总
    const payerEmail = (cap.json.payer && cap.json.payer.email_address) || '';
    const paidAmt = toCurrency(depSum, currency);
    const cnyAmt = currency === 'CNY' ? paidAmt : +(paidAmt * CNY_PER_USD).toFixed(2);
    const names = list.map(x => ITEMS[x.key].name + '×' + x.qty).join('、');
    const skus = list.map(x => x.key).join(',');
    const id = 'or_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const d1r = await recordOrder(env, {
      id, source: 'paypal', item: names, sku: skus,
      payer_email: payerEmail, contact_email: email, contact_phone: phone,
      amount: paidAmt, currency,
      full_price: toCurrency(fullSum, currency), balance: toCurrency(balSum, currency), cny_amount: cnyAmt,
      paypal_order_id: orderId, status: 'deposit', note,
    });
    if (d1r && d1r.error) return json({ ok: false, error: '订单存档失败: ' + d1r.error }, 500);

    const t = beijing();
    const curSym = currency === 'CNY' ? '¥' : '$';
    const line = `【RCJ 收款】${names} 定金 ${curSym}${paidAmt}（${currency}）\n🕒 ${t}\n商品：${names}\n已收定金：${curSym}${paidAmt}（余款 ${curSym}${toCurrency(balSum, currency)} 待交付时收）\n付款邮箱：${payerEmail || '(未知)'}\n联系邮箱：${email || '(未填)'}\n联系手机：${phone || '(未填)'}\nPayPal 单：${orderId}${note ? '\n备注：' + note : ''}`;
    // 订单通知：Telegram + 邮件（失败仅记录，不阻断支付结果）
    const tgRes = await notifyTelegram(env, line);
    if (tgRes && tgRes.error) console.error('[capture] Telegram 通知失败', tgRes.error);
    if (tgRes && tgRes.skipped) console.warn('[capture] Telegram 未发送（未配置）');
    const fsRes = await notifyFeishu(env, line);
    if (fsRes && fsRes.error) console.error('[capture] 飞书通知失败', fsRes.error);
    if (fsRes && fsRes.skipped) console.warn('[capture] 飞书未发送（未配置）');
    const mailHtml = `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:20px;">
<p style="font-size:16px;font-weight:700;color:#0d9488;">RCJ 收到新订单</p>
<table style="width:100%;font-size:14px;color:#374151;">
<tr><td style="padding:4px 0;color:#6b7280;width:80px;">商品</td><td>${names}</td></tr>
<tr><td style="padding:4px 0;color:#6b7280;">定金</td><td>${curSym}${paidAmt}（${currency}）</td></tr>
<tr><td style="padding:4px 0;color:#6b7280;">余款</td><td>${curSym}${toCurrency(balSum, currency)} 待交付时收</td></tr>
<tr><td style="padding:4px 0;color:#6b7280;">时间</td><td>${t}</td></tr>
<tr><td style="padding:4px 0;color:#6b7280;">付款邮箱</td><td>${payerEmail || '(未知)'}</td></tr>
<tr><td style="padding:4px 0;color:#6b7280;">联系邮箱</td><td>${email || '(未填)'}</td></tr>
<tr><td style="padding:4px 0;color:#6b7280;">联系手机</td><td>${phone || '(未填)'}</td></tr>
<tr><td style="padding:4px 0;color:#6b7280;">PayPal 单</td><td>${orderId}</td></tr>
${note ? '<tr><td style="padding:4px 0;color:#6b7280;">备注</td><td>' + note + '</td></tr>' : ''}
</table></div>`;
    const mailRes = await notifyOwner(env, `【RCJ 收款】${names} 定金 ${curSym}${paidAmt}`, mailHtml);
    if (mailRes && mailRes.error) console.error('[capture] 邮件通知失败', mailRes.error);
    if (mailRes && mailRes.skipped) console.warn('[capture] 邮件未发送（未配置）');

    // 4.5) 买家确认邮件（PayPal 路径补上双向水单：识别到联系邮箱才发）
    if (email) {
      const buyerHtml = `<div style="margin:0;padding:24px 12px;background:#f6f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e7dfd5;border-radius:14px;overflow:hidden;">
<div style="padding:22px 24px 16px;border-bottom:1px solid #f0e9e0;">
<div style="font-size:19px;font-weight:600;color:#23201c;">订单已收到 · Order received</div>
<div style="margin-top:6px;font-size:13px;color:#8a8078;">${t}</div></div>
<div style="padding:8px 24px 4px;">
${[['商品', names], ['定金', curSym + paidAmt + '（' + currency + '）'], ['余款', curSym + toCurrency(balSum, currency) + ' 待交付时收']].filter(p => p[1]).map(p => `<div style="display:block;padding:9px 0;border-bottom:1px solid #f6f1ea;"><span style="display:inline-block;min-width:78px;font-size:12px;color:#9a9088;">${p[0]}</span><span style="font-size:14px;color:#23201c;">${p[1]}</span></div>`).join('')}
</div>
<div style="padding:20px 24px 24px;"><a href="https://shop.955827.xyz/" style="display:inline-block;padding:12px 22px;background:#c2543c;color:#ffffff;text-decoration:none;border-radius:9px;font-size:14px;font-weight:600;">返回商城</a></div>
<div style="padding:0 24px 22px;font-size:13px;color:#6f675e;line-height:1.7;">我们已收到你的订单（PayPal 定金支付成功），定制音频将在 24 小时内发送到你填写的邮箱${note ? '。备注已记录：' + note : ''}。如需修改或加急，回复本邮件即可。</div>
<div style="padding:14px 24px;background:#fbf7f2;border-top:1px solid #f0e9e0;font-size:11px;color:#a89e94;">RCJ Lab · shop.955827.xyz · 每笔订单创作者都会获得对应分成</div>
</div></div>`;
      const bm = await notifyBuyer(env, email, '【RCJ】订单已收到 · ' + (body.rcjOrderNo || id), buyerHtml);
      if (bm && bm.error) console.error('[capture] 买家邮件发送失败', bm.error);
      if (bm && bm.skipped) console.warn('[capture] 买家邮件未发送（未配置/无收件人）');
    }

    return json({ ok: true, status: 'paid', id });
  } catch (e) {
    return json({ ok: false, error: e.message }, 500);
  }
}
