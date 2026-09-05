const { chromium } = require('C:/Users/小样儿/.workbuddy/binaries/node/workspace/node_modules/playwright-core');

(async () => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--no-sandbox', '--proxy-server=http://127.0.0.1:23177']
  });
  const ctx = await browser.newContext({
    viewport: { width: 1180, height: 900 },
    deviceScaleFactor: 1
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', e => errors.push(String(e)));

  await page.goto('https://dinner.955827.xyz/', { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForTimeout(3000);
  await page.screenshot({
    path: 'C:/Users/小样儿/Desktop/products/_repos/rcj-shop/assets/showcase-dinner.jpg',
    type: 'jpeg',
    quality: 72,
    fullPage: false
  });
  console.log('OK shot-dinner');
  console.log('CONSOLE_ERRORS:', JSON.stringify(errors));
  await browser.close();
})().catch(e => { console.error('SHOT_ERR', e); process.exit(1); });
