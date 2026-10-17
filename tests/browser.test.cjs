const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const origin = 'https://findmestore.thinkr.jp';
const script = path.join(__dirname, '..', 'content_script.js');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name + '.html'), 'utf8');
const key = origin + '/account/orders/fixture-order-1';
const cacheKey = 'findme:v2:' + key;
const fresh = (products) => ({ version: 2, cachedAt: Date.now(), products });
const product = { name: 'キャッシュの架空商品', variant: '', productUrl: origin + '/products/synthetic-cache', imageUrl: '' };
let browser;
before(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined, args: ['--no-sandbox'] });
});
after(async () => { if (browser) await browser.close(); });

async function setup({ account = fixture('modern-account'), detail = fixture('modern-order'), storage = {}, url = '/account', respond, brokenStorage = false } = {}) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const requests = [];
  await page.addInitScript(({ storage, brokenStorage }) => {
    window.__storage = storage;
    window.chrome = { runtime: {}, storage: { local: {
      get(keys, callback) {
        if (brokenStorage) throw new Error('synthetic storage unavailable');
        callback(Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, storage[key]])));
      },
      set(values, callback) { Object.assign(storage, values); if (callback) callback(); },
    } } };
  }, { storage, brokenStorage });
  await page.route('**/*', async (route) => {
    const requestUrl = new URL(route.request().url());
    if (requestUrl.origin !== origin) return route.abort();
    if (requestUrl.pathname === '/account' || requestUrl.pathname === '/account/login') {
      return route.fulfill({ status: 200, contentType: 'text/html', body: requestUrl.pathname === '/account/login' ? '<form id="customer_login"></form>' : account });
    }
    if (requestUrl.pathname.startsWith('/account/orders/')) {
      requests.push(requestUrl.href);
      if (respond) return respond(route, requests.length);
      return route.fulfill({ status: 200, contentType: 'text/html', body: detail });
    }
    return route.abort();
  });
  await page.goto(origin + url);
  await page.addScriptTag({ path: script });
  return { context, page, requests, async close() { await context.close(); } };
}
async function loaded(page, count = 1) {
  await page.waitForFunction((count) => document.querySelectorAll('.order-items-loaded').length === count, count);
}
async function errored(page) { await page.waitForSelector('.order-items-error'); }

// All fixtures and account/order identifiers are invented. No live requests occur.
test('modern list/detail: names without images, variants and relative URLs, excludes recommendations', async () => {
  const app = await setup();
  try {
    await loaded(app.page);
    assert.deepEqual(await app.page.locator('.order-item-name').allTextContents(), ['架空テストシャツ', '架空テストシャツ']);
    assert.deepEqual(await app.page.locator('.order-item-variant').allTextContents(), ['サイズ: S', 'サイズ: M']);
    assert.equal(await app.page.locator('.order-item-image').count(), 0);
    assert.equal(await app.page.locator('.order-items-cell').getAttribute('colspan'), '5');
    assert.deepEqual(await app.page.locator('.order-item-inner').evaluateAll((nodes) => nodes.map((node) => node.href)), [origin + '/products/synthetic-shirt?variant=111', origin + '/products/synthetic-shirt?variant=222']);
    assert.equal(app.requests.length, 1);
    const cache = await app.page.evaluate(() => window.__storage);
    assert.equal(cache[cacheKey].version, 2);
    assert.equal(cache[cacheKey].products.length, 2);
  } finally { await app.close(); }
});

test('legacy list/detail remains supported with image and dynamic colspan', async () => {
  const app = await setup({ account: fixture('legacy-account'), detail: fixture('legacy-order') });
  try {
    await loaded(app.page);
    assert.equal(await app.page.locator('.order-item-name').textContent(), '架空テストカップ');
    assert.equal(await app.page.locator('.order-items-cell').getAttribute('colspan'), '4');
    assert.equal(await app.page.locator('.order-item-image').getAttribute('src'), origin + '/cdn/shop/files/synthetic-product.png');
  } finally { await app.close(); }
});

test('page 2 works without altering pagination', async () => {
  const app = await setup({ url: '/account?page=2' });
  try {
    await loaded(app.page);
    assert.equal(await app.page.locator('nav.pagination a').getAttribute('href'), '/account?page=2');
  } finally { await app.close(); }
});

test('repeated injection is idempotent, including while fetch is pending', async () => {
  const app = await setup({ respond: async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    return route.fulfill({ contentType: 'text/html', body: fixture('modern-order') });
  } });
  try {
    await app.page.addScriptTag({ path: script });
    await loaded(app.page);
    await app.page.addScriptTag({ path: script });
    assert.equal(await app.page.locator('.order-items-row').count(), 1);
    assert.equal(app.requests.length, 1);
  } finally { await app.close(); }
});

for (const [label, detail] of [
  ['login HTML', '<form id="customer_login"><input name="customer[password]"></form>'],
  ['unknown HTML with recommendations', '<main><table><tr><td><a href="/products/synthetic-recommendation">Not an order</a></td></tr></table></main>'],
  ['malformed modern detail', '<main class="customer order"><table class="order-details"><tbody><tr><td>No product header</td></tr></tbody></table></main>'],
]) {
  test(label + ' is an error and is not cached', async () => {
    const app = await setup({ detail });
    try {
      await errored(app.page);
      assert.equal(await app.page.locator('.order-item').count(), 0);
      assert.deepEqual(await app.page.evaluate(() => window.__storage), {});
    } finally { await app.close(); }
  });
}

test('login redirect is not treated as an empty order', async () => {
  const app = await setup({ respond: (route) => route.fulfill({ status: 302, headers: { location: origin + '/account/login' } }) });
  try {
    await errored(app.page);
    assert.equal(await app.page.locator('.order-items-retry').textContent(), 'ログインを確認して再試行');
    assert.deepEqual(await app.page.evaluate(() => window.__storage), {});
  } finally { await app.close(); }
});

test('recognized empty detail is distinct from unknown markup but is never cached', async () => {
  const app = await setup({ detail: '<main class="customer order"><table class="order-details"><tbody></tbody></table></main>' });
  try {
    await loaded(app.page);
    assert.equal(await app.page.locator('.order-items-empty').textContent(), '商品情報なし');
    assert.deepEqual(await app.page.evaluate(() => window.__storage), {});
  } finally { await app.close(); }
});

test('valid v2 cache is used without fetching', async () => {
  const app = await setup({ storage: { [cacheKey]: fresh([product]) } });
  try {
    await loaded(app.page);
    assert.equal(app.requests.length, 0);
    assert.equal(await app.page.locator('.order-item-name').textContent(), product.name);
  } finally { await app.close(); }
});

for (const [label, storage] of [
  ['legacy display-number key', { '#TEST-1001': [product] }],
  ['expired v2', { [cacheKey]: { ...fresh([product]), cachedAt: 0 } }],
  ['invalid v2 URL', { [cacheKey]: fresh([{ ...product, productUrl: 'javascript:alert(1)' }]) }],
]) {
  test(label + ' is not reused', async () => {
    const app = await setup({ storage });
    try { await loaded(app.page); assert.equal(app.requests.length, 1); }
    finally { await app.close(); }
  });
}

test('storage unavailable still displays fetched products', async () => {
  const app = await setup({ brokenStorage: true });
  try { await loaded(app.page); assert.equal(app.requests.length, 1); }
  finally { await app.close(); }
});

test('unsafe URLs are not rendered or fetched; plain deleted product name remains', async () => {
  const detail = '<main class="customer order"><table class="order-details"><tbody><tr><td headers="ColumnProduct"><div><a href="javascript:alert(1)//products/unsafe">架空安全テスト</a><div class="properties">S</div></div><img src="https://tracker.example.invalid/test.png"></td></tr><tr><td headers="ColumnProduct"><div>削除済み架空商品<div class="properties">M</div></div></td></tr></tbody></table></main>';
  const app = await setup({ detail });
  try {
    await loaded(app.page);
    assert.equal(await app.page.locator('.order-item a').count(), 0);
    assert.equal(await app.page.locator('.order-item-image').count(), 0);
    assert.deepEqual(await app.page.locator('.order-item-name').allTextContents(), ['架空安全テスト', '削除済み架空商品']);
  } finally { await app.close(); }
});

test('foreign order links are ignored', async () => {
  const app = await setup({ account: fixture('modern-account').replace('/account/orders/fixture-order-1', 'https://foreign.example.invalid/account/orders/fixture-order-1') });
  try {
    assert.equal(await app.page.locator('.order-items-row').count(), 0);
    assert.equal(app.requests.length, 0);
  } finally { await app.close(); }
});

test('empty account and login page do not fetch or inject', async () => {
  for (const options of [{ account: '<main class="customer account"><table class="order-history"><tbody></tbody></table></main>' }, { url: '/account/login' }]) {
    const app = await setup(options);
    try { assert.equal(await app.page.locator('.order-items-row').count(), 0); assert.equal(app.requests.length, 0); }
    finally { await app.close(); }
  }
});

test('all detail requests use at most three concurrent fetches', async () => {
  let active = 0;
  let maximum = 0;
  const rows = Array.from({ length: 7 }, (_, index) => `<tr><td headers="ColumnOrder"><a href="/account/orders/fixture-${index}">#TEST-${index}</a></td></tr>`).join('');
  const app = await setup({ account: `<main class="customer account"><table class="order-history"><tbody>${rows}</tbody></table></main>`, respond: async (route) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await route.fulfill({ contentType: 'text/html', body: fixture('modern-order') });
    active--;
  } });
  try { await loaded(app.page, 7); assert.equal(app.requests.length, 7); assert.equal(maximum, 3); }
  finally { await app.close(); }
});

test('HTTP failure can be retried and rapid repeated retries do not duplicate fetches', async () => {
  const app = await setup({ respond: async (route, count) => {
    if (count === 1) return route.fulfill({ status: 503, body: 'synthetic failure' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    return route.fulfill({ contentType: 'text/html', body: fixture('modern-order') });
  } });
  try {
    await errored(app.page);
    assert.deepEqual(await app.page.evaluate(() => window.__storage), {});
    await app.page.locator('.order-items-retry').evaluate((button) => { button.click(); button.click(); });
    await loaded(app.page);
    assert.equal(app.requests.length, 2);
    assert.equal(await app.page.locator('.order-items-row').count(), 1);
  } finally { await app.close(); }
});


test('image-only links do not discard the product-name link variant', async () => {
  const detail = fixture('legacy-order').replace('<img data-src=', '<a href="/products/synthetic-cup"><img data-src=').replace('alt=""><a href="/products/synthetic-cup">', 'alt=""></a><a href="/products/synthetic-cup?variant=333">');
  const app = await setup({ account: fixture('legacy-account'), detail });
  try { await loaded(app.page); assert.equal(await app.page.locator('.order-item-inner').getAttribute('href'), origin + '/products/synthetic-cup?variant=333'); }
  finally { await app.close(); }
});

test('empty cached arrays are refetched instead of poisoning results', async () => {
  const app = await setup({ storage: { [cacheKey]: fresh([]) } });
  try { await loaded(app.page); assert.equal(app.requests.length, 1); }
  finally { await app.close(); }
});


test('labelled recommendation-only response is unsupported and never cached', async () => {
  const app = await setup({ detail: '<aside><table class="responsive-table"><tbody><tr><td data-label="Product"><a href="/products/synthetic-recommendation">UNRELATED RECOMMENDATION</a></td></tr></tbody></table></aside>' });
  try { await errored(app.page); assert.deepEqual(await app.page.evaluate(() => window.__storage), {}); assert.equal(await app.page.locator('.order-item').count(), 0); }
  finally { await app.close(); }
});


test('legacy class with only a product label is not enough to recognize an order', async () => {
  const app = await setup({ detail: '<main><table class="responsive-table"><tbody><tr><td data-label="Product"><a href="/products/synthetic-recommendation">Recommendation</a></td></tr></tbody></table></main>' });
  try { await errored(app.page); assert.deepEqual(await app.page.evaluate(() => window.__storage), {}); }
  finally { await app.close(); }
});

test('legacy-looking recommendation table outside main cannot replace order products', async () => {
  const outside = '<aside><table class="responsive-table"><thead><tr><th>Product</th><th>Quantity</th></tr></thead><tbody><tr><td><a href="/products/synthetic-recommendation">Recommendation</a></td><td>1</td></tr></tbody></table></aside>';
  const app = await setup({ detail: outside + fixture('legacy-order') });
  try { await loaded(app.page); assert.deepEqual(await app.page.locator('.order-item-name').allTextContents(), ['架空テストカップ']); }
  finally { await app.close(); }
});
