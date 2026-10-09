// RCJ Shop · 统一下单通知（支付宝 / 闲鱼 / 其它站外支付路径）
// POST /api/order/notify  { orderNo, items:[{key,qty}], total, currency, note, pay, email? }
// 用途：前端站外支付（支付宝码 / 闲鱼）下单后调用一次——
//   ① 写 D1 orders 表（卖家后台可查）
//   ② 飞书 + Telegram 通知卖家（含订单号 / 明细 / 邮箱）
//   ③ Resend 邮件水单给卖家
//   ④ Resend 订单确认邮件给买家（邮箱从 body.email 或备注中识别）
// 任一环节失败只记录日志，绝不阻断下单主流程。
import { ITEMS, recordOrder, notifyTelegram, notifyOwner, notifyFeishu, notifyBuyer, beijing, json, corsOptions } from '../paypal/_lib.js';

export async function onRequestOptions() { return corsOptions(); }

function pickEmail(body, note) {
  const direct = String(body.email || '').trim().slice(0, 120);
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(direct)) return direct;
  const m = String(note || '').match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  return m ? m[0].slice(0, 120) : '';
}

export async function onRequestPost({ request, env }) {
  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: 'JSON 格式错误' }, 400); }

  const orderNo = String(body.orderNo || '').trim().slice(0, 40);
  const note = String(body.note || '').slice(0, 200);
  const pay = String(body.pay || 'alipay').slice(0, 20);
  // 订单号：兼容历史 RCJ-YYYYMMDD-NN 与新随机查询码 RCJ-XXXX-XXXX
  if (!orderNo || !/^RCJ-[A-Z0-9-]{4,20}$/.test(orderNo)) return json({ ok: false, error: '订单号格式错误' }, 400);
  // 闲鱼路径：闲鱼店铺自身可见订单，不触发 D1/飞书/TG/邮件，避免重复通知
  if (pay === 'xianyu') return json({ ok: true, skipped: true, reason: '闲鱼店铺可见，不重复通知' });

  // 商品清单
  let list = [];
  if (Array.isArray(body.items)) {
    list = body.items.map(x => ({ key: String(x.key || ''), qty: Math.max(1, Math.floor(Number(x.qty) || 1)) }));
  }
  if (!list.length) return json({ ok: false, error: '商品为空' }, 400);
  if (!list.every(x => ITEMS[x.key])) return json({ ok: false, error: '商品不匹配' }, 400);

  const names = list.map(x => ITEMS[x.key].name + '×' + x.qty).join('、');
  const skus = list.map(x => x.key).join(',');
  const total = String(body.total || '').slice(0, 30);
  const email = pickEmail(body, note);
  const t = beijing();
  const payLabel = { alipay: '支付宝', xianyu: '闲鱼', paypal: 'PayPal' }[pay] || pay;

  const results = [];
  try {
    // ① D1 存档（id 用 RCJ 订单号，源=站外支付）
    const d1r = await recordOrder(env, {
      id: orderNo, source: pay, item: names, sku: skus,
      payer_email: '', contact_email: email, contact_phone: '',
      amount: parseFloat(String(total).replace(/[^0-9.]/g, '')) || 0,
      currency: String(body.currency || 'CNY').slice(0, 8), full_price: null, balance: null, cny_amount: null,
      paypal_order_id: '', status: 'pending', note,
    });
    if (d1r && d1r.error) results.push('d1:' + d1r.error); else results.push('d1:ok');
  } catch (e) { results.push('d1:' + e.message); }

  // ② 卖家通知：飞书 + Telegram（一条文本）
  const line = `【RCJ 新订单】${payLabel}
订单号：${orderNo}
商品：${names}
金额：${total}${email ? '\n买家邮箱：' + email : ''}\n备注：${note || '(无)'}\n🕒 ${t}`;
  const tg = await notifyTelegram(env, line);
  if (tg && tg.error) results.push('tg:' + tg.error); else results.push(tg && tg.skipped ? 'tg:skip' : 'tg:ok');
  const fs = await notifyFeishu(env, line);
  if (fs && fs.error) results.push('fs:' + fs.error); else results.push(fs && fs.skipped ? 'fs:skip' : 'fs:ok');

  // ③ 卖家邮件水单（含订单号）
  const ownerHtml = `<div style="margin:0;padding:24px 12px;background:#f6f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e7dfd5;border-radius:14px;overflow:hidden;">
<div style="padding:22px 24px 16px;border-bottom:1px solid #f0e9e0;">
<div style="font-size:19px;font-weight:600;color:#23201c;">RCJ 收到新订单 · ${payLabel}</div>
<div style="margin-top:6px;font-size:13px;color:#8a8078;">${t}</div></div>
<div style="padding:8px 24px 4px;">
${[['订单号', orderNo], ['商品', names], ['金额', total], ['买家邮箱', email || '(备注中未识别)'], ['备注', note || '(无)']].filter(p => p[1]).map(p => `<div style="display:block;padding:9px 0;border-bottom:1px solid #f6f1ea;"><span style="display:inline-block;min-width:78px;font-size:12px;color:#9a9088;">${p[0]}</span><span style="font-size:14px;color:#23201c;">${p[1]}</span></div>`).join('')}
</div>
<div style="padding:14px 24px 22px;font-size:13px;color:#6f675e;line-height:1.7;">买家付款在站外完成，收到付款后再交付音频；交付后记得在订单备注里核对邮箱。</div>
<div style="padding:14px 24px;background:#fbf7f2;border-top:1px solid #f0e9e0;font-size:11px;color:#a89e94;">RCJ Lab · shop.955827.xyz · 每笔订单创作者都会获得对应分成</div>
</div></div>`;
  const mail = await notifyOwner(env, `【RCJ 新订单】${payLabel} · ${names}`, ownerHtml);
  if (mail && mail.error) results.push('mail:' + mail.error); else results.push(mail && mail.skipped ? 'mail:skip' : 'mail:ok');

  // ④ 买家确认邮件（识别到邮箱才发）
  if (email) {
    const buyerHtml = `<div style="margin:0;padding:24px 12px;background:#f6f1ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;">
<div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e7dfd5;border-radius:14px;overflow:hidden;">
<div style="padding:22px 24px 16px;border-bottom:1px solid #f0e9e0;">
<div style="font-size:19px;font-weight:600;color:#23201c;">订单已收到 · Order received</div>
<div style="margin-top:6px;font-size:13px;color:#8a8078;">${t}</div></div>
<div style="padding:8px 24px 4px;">
${[['订单号', orderNo], ['商品', names], ['金额', total], ['支付方式', payLabel]].filter(p => p[1]).map(p => `<div style="display:block;padding:9px 0;border-bottom:1px solid #f6f1ea;"><span style="display:inline-block;min-width:78px;font-size:12px;color:#9a9088;">${p[0]}</span><span style="font-size:14px;color:#23201c;">${p[1]}</span></div>`).join('')}
</div>
<div style="padding:20px 24px 24px;"><a href="https://shop.955827.xyz/" style="display:inline-block;padding:12px 22px;background:#c2543c;color:#ffffff;text-decoration:none;border-radius:9px;font-size:14px;font-weight:600;">返回商城</a></div>
<div style="padding:0 24px 22px;font-size:13px;color:#6f675e;line-height:1.7;">我们已收到你的订单，定制音频将在 24 小时内发送到你填写的邮箱${note ? '。备注已记录：' + note : ''}。如需修改或加急，回复本邮件即可。</div>
<div style="padding:14px 24px;background:#fbf7f2;border-top:1px solid #f0e9e0;font-size:11px;color:#a89e94;">RCJ Lab · shop.955827.xyz · 每笔订单创作者都会获得对应分成</div>
</div></div>`;
    const bm = await notifyBuyer(env, email, '【RCJ】订单已收到 · ' + orderNo, buyerHtml);
    if (bm && bm.error) results.push('buyer:' + bm.error); else results.push(bm && bm.skipped ? 'buyer:skip' : 'buyer:ok');
  } else {
    results.push('buyer:skip(未识别邮箱)');
  }

  console.log('[order/notify]', orderNo, results.join(' / '));
  return json({ ok: true, orderNo, results });
}
