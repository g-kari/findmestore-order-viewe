const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const script = fs.readFileSync(path.join(__dirname, '..', 'content_script.js'), 'utf8');
const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name + '.html'), 'utf8');
const origin = 'https://findmestore.thinkr.jp';
const orderUrl = origin + '/account/orders/fixture-order-1';
const cacheKey = 'findme:v2:' + orderUrl;
const product = { name: 'キャッシュの架空商品', variant: '', productUrl: origin + '/products/synthetic-cache', imageUrl: '' };
const fresh = (products) => ({ version: 2, cachedAt: Date.now(), products });

function setup({ account = fixture('modern-account'), detail = fixture('modern-order'), storage = {}, url = '/account', respond, brokenStorage = false } = {}) {
  // outside-only executes only this repository's script, never scripts in fixtures.
  // No jsdom resource loader is enabled: fixtures cannot issue network requests.
  const dom = new JSDOM(account, { url: origin + url, runScripts: 'outside-only' });
  const { window } = dom;
  const requests = [];
  window.chrome = { runtime: {}, storage: { local: {
    get(keys, callback) {
      if (brokenStorage) throw new Error('synthetic storage unavailable');
      callback(Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, storage[key]])));
    },
    set(values, callback) { Object.assign(storage, values); if (callback) callback(); },
  } } };
  window.fetch = async (url, options) => {
    requests.push({ url, options });
    if (respond) return respond(url, options, requests.length);
    return response(detail, url);
  };
  window.eval(script);
  const document = window.document;
  return { window, document, storage, requests, close: () => window.close() };
}
function response(html, url = orderUrl, status = 200) {
  const result = new Response(html, { status, headers: { 'content-type': 'text/html' } });
  Object.defineProperty(result, 'url', { value: url });
  return result;
}
async function waitFor(check) {
  for (let i = 0; i < 300; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('Synthetic DOM did not reach the expected terminal state');
}
const loaded = (app, count = 1) => waitFor(() => app.document.querySelectorAll('.order-items-loaded').length === count);
const errored = (app) => waitFor(() => app.document.querySelector('.order-items-error'));
const text = (app, selector) => [...app.document.querySelectorAll(selector)].map((node) => node.textContent);

// All account/order/product values are invented. Tests never contact FINDME.
test('modern DOMParser flow: no images, duplicate names retain variants, relative URLs and no recommendations', async () => {
  const app = setup();
  try {
    await loaded(app);
    assert.deepEqual(text(app, '.order-item-name'), ['架空テストシャツ', '架空テストシャツ']);
    assert.deepEqual(text(app, '.order-item-variant'), ['サイズ: S', 'サイズ: M']);
    assert.equal(app.document.querySelectorAll('.order-item-image').length, 0);
    assert.equal(app.document.querySelector('.order-items-cell').colSpan, 5);
    assert.deepEqual([...app.document.querySelectorAll('a.order-item-inner')].map((node) => node.href), [origin + '/products/synthetic-shirt?variant=111', origin + '/products/synthetic-shirt?variant=222']);
    assert.equal(app.requests[0].options.credentials, 'include');
    assert.equal(app.storage[cacheKey].version, 2);
    assert.equal(app.storage[cacheKey].products.length, 2);
  } finally { app.close(); }
});

test('legacy table: image and product retained, four-column colspan, no recommendation', async () => {
  const app = setup({ account: fixture('legacy-account'), detail: fixture('legacy-order') });
  try {
    await loaded(app);
    assert.deepEqual(text(app, '.order-item-name'), ['架空テストカップ']);
    assert.equal(app.document.querySelector('.order-items-cell').colSpan, 4);
    assert.equal(app.document.querySelector('.order-item-image').src, origin + '/cdn/shop/files/synthetic-product.png');
  } finally { app.close(); }
});

test('page 2 is enhanced without changing pagination', async () => {
  const app = setup({ url: '/account?page=2' });
  try { await loaded(app); assert.equal(app.document.querySelector('nav.pagination a').getAttribute('href'), '/account?page=2'); }
  finally { app.close(); }
});

test('injection is idempotent before and after fetching', async () => {
  const app = setup({ respond: async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return response(fixture('modern-order'), url);
  } });
  try {
    app.window.eval(script);
    await loaded(app);
    app.window.eval(script);
    assert.equal(app.document.querySelectorAll('.order-items-row').length, 1);
    assert.equal(app.requests.length, 1);
  } finally { app.close(); }
});

for (const [label, detail] of [
  ['login HTML', '<form id="customer_login"><input name="customer[password]"></form>'],
  ['unknown table containing recommendation', '<table><tr><td><a href="/products/synthetic-recommendation">Not an order</a></td></tr></table>'],
  ['malformed modern table', '<main class="customer order"><table class="order-details"><tbody><tr><td>No product header</td></tr></tbody></table></main>'],
]) {
  test(label + ' fails without saving successful cache', async () => {
    const app = setup({ detail });
    try { await errored(app); assert.deepEqual(app.storage, {}); assert.equal(app.document.querySelectorAll('.order-item').length, 0); }
    finally { app.close(); }
  });
}

for (const [label, url, status] of [
  ['redirect to login', origin + '/account/login', 200],
  ['HTTP 401', orderUrl, 401],
  ['HTTP 403', orderUrl, 403],
  ['other order redirect', origin + '/account/orders/fixture-other', 200],
  ['foreign redirect', 'https://foreign.example.invalid/account/orders/fixture-order-1', 200],
]) {
  test(label + ' is not an empty success', async () => {
    const app = setup({ respond: async () => response(fixture('modern-order'), url, status) });
    try { await errored(app); assert.deepEqual(app.storage, {}); }
    finally { app.close(); }
  });
}

test('known empty table displays empty state but is never cached', async () => {
  const app = setup({ detail: '<main class="customer order"><table class="order-details"><tbody></tbody></table></main>' });
  try { await loaded(app); assert.deepEqual(text(app, '.order-items-empty'), ['商品情報なし']); assert.deepEqual(app.storage, {}); }
  finally { app.close(); }
});

test('valid versioned cache is a network-free hit', async () => {
  const app = setup({ storage: { [cacheKey]: fresh([product]) } });
  try { await loaded(app); assert.equal(app.requests.length, 0); assert.deepEqual(text(app, '.order-item-name'), [product.name]); }
  finally { app.close(); }
});

for (const [label, storage] of [
  ['legacy key', { '#TEST-1001': [product] }],
  ['expired entry', { [cacheKey]: { ...fresh([product]), cachedAt: 0 } }],
  ['future timestamp', { [cacheKey]: { ...fresh([product]), cachedAt: Date.now() + 100000 } }],
  ['empty entry', { [cacheKey]: fresh([]) }],
  ['unsafe product URL', { [cacheKey]: fresh([{ ...product, productUrl: 'javascript:alert(1)' }]) }],
  ['wrong version', { [cacheKey]: { ...fresh([product]), version: 1 } }],
]) {
  test(label + ' cache is refetched', async () => {
    const app = setup({ storage });
    try { await loaded(app); assert.equal(app.requests.length, 1); }
    finally { app.close(); }
  });
}

test('storage failure does not stop product display', async () => {
  const app = setup({ brokenStorage: true });
  try { await loaded(app); assert.equal(app.requests.length, 1); }
  finally { app.close(); }
});

test('image-only link is skipped so the named product variant URL survives', async () => {
  const detail = fixture('legacy-order').replace('<img data-src=', '<a href="/products/synthetic-cup"><img data-src=').replace('alt=""><a href="/products/synthetic-cup">', 'alt=""></a><a href="/products/synthetic-cup?variant=333">');
  const app = setup({ detail });
  try { await loaded(app); assert.equal(app.document.querySelector('.order-item-inner').href, origin + '/products/synthetic-cup?variant=333'); }
  finally { app.close(); }
});

test('unsafe product/image URLs are not rendered and deleted-product text is supported', async () => {
  const detail = '<main class="customer order"><table class="order-details"><tbody><tr><td headers="ColumnProduct"><a href="javascript:alert(1)//products/unsafe">架空安全テスト</a><img src="https://tracker.example.invalid/test.png"></td></tr><tr><td headers="ColumnProduct"><div>削除済み架空商品<div class="properties">M</div></div></td></tr></tbody></table></main>';
  const app = setup({ detail });
  try {
    await loaded(app);
    assert.equal(app.document.querySelectorAll('.order-item a, .order-item img').length, 0);
    assert.deepEqual(text(app, '.order-item-name'), ['架空安全テスト', '削除済み架空商品']);
  } finally { app.close(); }
});

test('foreign order links, empty account and login page cause no requests', async () => {
  for (const options of [
    { account: fixture('modern-account').replace('/account/orders/fixture-order-1', 'https://foreign.example.invalid/account/orders/fixture-order-1') },
    { account: '<main class="customer account"><table class="order-history"><tbody></tbody></table></main>' },
    { url: '/account/login' },
  ]) {
    const app = setup(options);
    try { assert.equal(app.requests.length, 0); assert.equal(app.document.querySelectorAll('.order-items-row').length, 0); }
    finally { app.close(); }
  }
});

test('seven orders never exceed three concurrent requests', async () => {
  let active = 0;
  let maximum = 0;
  const rows = Array.from({ length: 7 }, (_, index) => `<tr><td headers="ColumnOrder"><a href="/account/orders/fixture-${index}">#TEST-${index}</a></td></tr>`).join('');
  const app = setup({ account: `<main class="customer account"><table class="order-history"><tbody>${rows}</tbody></table></main>`, respond: async (url) => {
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active--;
    return response(fixture('modern-order'), url);
  } });
  try { await loaded(app, 7); assert.equal(maximum, 3); assert.equal(app.requests.length, 7); }
  finally { app.close(); }
});

test('failed request can retry; rapid retries do not duplicate requests', async () => {
  const app = setup({ respond: async (url, options, count) => {
    if (count === 1) return response('synthetic failure', url, 503);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return response(fixture('modern-order'), url);
  } });
  try {
    await errored(app);
    assert.deepEqual(app.storage, {});
    const button = app.document.querySelector('.order-items-retry');
    button.click(); button.click();
    await loaded(app);
    assert.equal(app.requests.length, 2);
    assert.equal(app.document.querySelectorAll('.order-items-row').length, 1);
  } finally { app.close(); }
});

test('untrusted names are rendered only as text', async () => {
  const detail = fixture('modern-order').replace('架空テストシャツ', '&lt;img src=x onerror=alert(1)&gt;');
  const app = setup({ detail });
  try { await loaded(app); assert.equal(app.document.querySelector('.order-item-name').textContent, '<img src=x onerror=alert(1)>'); assert.equal(app.document.querySelectorAll('.order-items-row img').length, 0); }
  finally { app.close(); }
});


test('unrelated labelled recommendation table is not a legacy order detail', async () => {
  const app = setup({ detail: '<main><table class="responsive-table"><tbody><tr><td data-label="Product"><a href="/products/synthetic-recommendation">Recommendation</a></td></tr></tbody></table></main>' });
  try { await errored(app); assert.deepEqual(app.storage, {}); }
  finally { app.close(); }
});

test('recommendation tables outside main cannot replace an order detail', async () => {
  const outside = '<aside><table class="responsive-table"><thead><tr><th>Product</th><th>Quantity</th></tr></thead><tbody><tr><td><a href="/products/synthetic-recommendation">Recommendation</a></td><td>1</td></tr></tbody></table></aside>';
  const app = setup({ detail: outside + fixture('legacy-order') });
  try { await loaded(app); assert.deepEqual(text(app, '.order-item-name'), ['架空テストカップ']); }
  finally { app.close(); }
});


test('review regression: recommendation-only aside is never rendered or cached', async () => {
  const app = setup({ detail: '<aside><table class="responsive-table"><tbody><tr><td data-label="Product"><a href="/products/synthetic-recommendation">UNRELATED RECOMMENDATION</a></td></tr></tbody></table></aside>' });
  try { await errored(app); assert.deepEqual(app.storage, {}); assert.equal(app.document.querySelectorAll('.order-item').length, 0); }
  finally { app.close(); }
});

test('unknown generic product/quantity table is not a legacy order', async () => {
  const detail = fixture('legacy-order').replace('class="responsive-table"', 'class="unknown-table"');
  const app = setup({ detail });
  try { await errored(app); assert.deepEqual(app.storage, {}); }
  finally { app.close(); }
});


test('same-order trailing slash canonicalization is accepted', async () => {
  const app = setup({ respond: async () => response(fixture('modern-order'), orderUrl + '/') });
  try { await loaded(app); assert.equal(app.storage[cacheKey].products.length, 2); }
  finally { app.close(); }
});
