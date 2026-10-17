(() => {
  'use strict';

  const ORIGIN = 'https://findmestore.thinkr.jp';
  const CACHE_VERSION = 2;
  const CACHE_PREFIX = 'findme:v2:';
  const CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;
  const MAX_CONCURRENT = 3;
  const queue = [];
  let active = 0;

  function normalizeText(text) {
    return (text || '').replace(/\s+/g, ' ').trim();
  }

  function safeUrl(value, baseUrl, kind) {
    if (!value) return '';
    try {
      const url = new URL(value, baseUrl);
      if (url.protocol !== 'https:' || url.username || url.password) return '';
      if (kind === 'image') {
        if (url.origin !== ORIGIN && url.hostname !== 'cdn.shopify.com') return '';
      } else {
        if (url.origin !== ORIGIN) return '';
        if (kind === 'order' && !/^\/account\/orders\/[^/]+\/?$/.test(url.pathname)) return '';
        if (kind === 'product' && !/\/products\/[^/]+\/?$/.test(url.pathname)) return '';
      }
      url.hash = '';
      if (kind === 'order') {
        url.search = '';
        url.pathname = url.pathname.replace(/\/$/, '');
      }
      return url.href;
    } catch {
      return '';
    }
  }

  function cacheKey(url) {
    return CACHE_PREFIX + url;
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(keys, (result) => {
          const failed = chrome.runtime && chrome.runtime.lastError;
          resolve(failed ? {} : result || {});
        });
      } catch {
        resolve({});
      }
    });
  }

  function cachedProducts(entry, baseUrl) {
    if (!entry || entry.version !== CACHE_VERSION || !Array.isArray(entry.products) || !entry.products.length ||
        !Number.isFinite(entry.cachedAt) || entry.cachedAt > Date.now() ||
        Date.now() - entry.cachedAt > CACHE_MAX_AGE) return null;
    const products = [];
    for (const product of entry.products) {
      if (!product || typeof product.name !== 'string' || !product.name.trim() ||
          typeof product.variant !== 'string' || typeof product.productUrl !== 'string' ||
          typeof product.imageUrl !== 'string') return null;
      const productUrl = safeUrl(product.productUrl, baseUrl, 'product');
      const imageUrl = safeUrl(product.imageUrl, baseUrl, 'image');
      if ((product.productUrl && !productUrl) || (product.imageUrl && !imageUrl)) return null;
      products.push({ name: product.name, variant: product.variant, productUrl, imageUrl });
    }
    return products;
  }

  function saveToCache(order, products) {
    try {
      chrome.storage.local.set({
        [cacheKey(order.url)]: { version: CACHE_VERSION, cachedAt: Date.now(), products },
      }, () => { void (chrome.runtime && chrome.runtime.lastError); });
    } catch {
      // Storage being unavailable must not prevent the current result from displaying.
    }
  }

  function productFromCell(cell, row, baseUrl) {
    const links = [...cell.querySelectorAll('a[href*="/products/"]')];
    const link = links.find((anchor) => normalizeText(anchor.textContent)) || null;
    const properties = cell.querySelector('.properties');
    const variant = normalizeText(properties && properties.textContent);
    let name = normalizeText(link && link.textContent);
    if (!name) {
      // Deleted products can remain as plain text in the product column.
      const textCell = cell.cloneNode(true);
      textCell.querySelectorAll('.properties, script, style').forEach((node) => node.remove());
      name = normalizeText(textCell.textContent);
    }
    if (!name) return null;
    const image = row.querySelector('img');
    const imageSource = image && (image.getAttribute('data-src') || image.getAttribute('src'));
    return {
      name,
      variant,
      productUrl: safeUrl(link && link.getAttribute('href'), baseUrl, 'product'),
      imageUrl: safeUrl(imageSource, baseUrl, 'image'),
    };
  }

  function extractProducts(doc, baseUrl) {
    if (doc.querySelector('#customer_login, input[name="customer[password]"]')) {
      throw new Error('authentication');
    }
    const modern = doc.querySelector('.customer.order table.order-details');
    if (modern) {
      const rows = [...modern.querySelectorAll(':scope > tbody > tr')];
      const cells = rows.map((row) => [row, row.querySelector('td[headers~="ColumnProduct"]')]);
      if (rows.length && cells.some(([, cell]) => !cell)) throw new Error('unsupported');
      const products = cells.map(([row, cell]) => productFromCell(cell, row, baseUrl));
      if (products.some((product) => !product)) throw new Error('unsupported');
      return products;
    }

    // Legacy tables must identify both a product and quantity column. Never fall
    // back to product links in the header, recommendations, or the whole document.
    const productLabel = /^(商品|商品名|製品|product|products)$/i;
    const quantityLabel = /^(数量|個数|quantity|qty)$/i;
    const detailRoot = doc.querySelector('main, #MainContent') || doc;
    for (const table of detailRoot.querySelectorAll('table.responsive-table, table#order_details, table.order-details')) {
      if (table.closest('aside, nav, header, footer')) continue;
      const headings = [...table.querySelectorAll('thead th')].map((th) => normalizeText(th.textContent));
      const productIndex = headings.findIndex((heading) => productLabel.test(heading));
      const labelledCell = table.querySelector('td[data-label="商品"], td[data-label="商品名"], td[data-label="Product"]');
      const labelledQuantity = table.querySelector('td[data-label="数量"], td[data-label="個数"], td[data-label="Quantity"], td[data-label="Qty"]');
      if (!((productIndex >= 0 && headings.some((heading) => quantityLabel.test(heading))) ||
          (labelledCell && labelledQuantity))) continue;
      const products = [];
      for (const row of table.querySelectorAll(':scope > tbody > tr')) {
        const cell = row.querySelector('td[data-label="商品"], td[data-label="商品名"], td[data-label="Product"]') || row.cells[productIndex];
        if (!cell) throw new Error('unsupported');
        const product = productFromCell(cell, row, baseUrl);
        if (!product) throw new Error('unsupported');
        products.push(product);
      }
      return products;
    }
    throw new Error('unsupported');
  }

  function createLoadingRow(colspan) {
    const row = document.createElement('tr');
    row.className = 'order-items-row';
    const cell = document.createElement('td');
    cell.className = 'order-items-cell';
    cell.colSpan = colspan;
    row.appendChild(cell);
    showLoading(row);
    return row;
  }

  function showLoading(row) {
    row.className = 'order-items-row order-items-loading';
    const cell = row.querySelector('.order-items-cell');
    cell.replaceChildren();
    const spinner = document.createElement('span');
    spinner.className = 'order-items-spinner';
    const text = document.createElement('span');
    text.className = 'order-items-loading-text';
    text.textContent = '読み込み中...';
    cell.append(spinner, text);
  }

  function updateRow(row, products) {
    row.className = 'order-items-row order-items-loaded';
    const cell = row.querySelector('.order-items-cell');
    cell.replaceChildren();
    if (!products.length) {
      const empty = document.createElement('span');
      empty.className = 'order-items-empty';
      empty.textContent = '商品情報なし';
      cell.appendChild(empty);
      return;
    }
    const list = document.createElement('ul');
    list.className = 'order-items-list';
    for (const product of products) {
      const item = document.createElement('li');
      item.className = 'order-item';
      const inner = document.createElement(product.productUrl ? 'a' : 'span');
      inner.className = 'order-item-inner';
      if (product.productUrl) {
        inner.href = product.productUrl;
        inner.target = '_blank';
        inner.rel = 'noopener noreferrer';
      }
      if (product.imageUrl) {
        const image = document.createElement('img');
        image.className = 'order-item-image';
        image.src = product.imageUrl;
        image.alt = product.name;
        image.loading = 'lazy';
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => { image.hidden = true; });
        inner.appendChild(image);
      }
      const label = document.createElement('span');
      const name = document.createElement('span');
      name.className = 'order-item-name';
      name.textContent = product.name;
      label.appendChild(name);
      if (product.variant) {
        const variant = document.createElement('span');
        variant.className = 'order-item-variant';
        variant.textContent = product.variant;
        label.appendChild(variant);
      }
      inner.appendChild(label);
      item.appendChild(inner);
      list.appendChild(item);
    }
    cell.appendChild(list);
  }

  function showError(order, reason) {
    order.loadingRow.className = 'order-items-row order-items-error';
    const cell = order.loadingRow.querySelector('.order-items-cell');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'order-items-retry';
    button.textContent = reason === 'authentication' ? 'ログインを確認して再試行' :
      reason === 'unsupported' ? '明細を確認できません（再試行）' : '取得失敗（再試行）';
    button.addEventListener('click', () => fetchOrderItems(order));
    cell.replaceChildren(button);
  }

  function drainQueue() {
    while (active < MAX_CONCURRENT && queue.length) {
      const { order, resolve } = queue.shift();
      active++;
      loadOrder(order).finally(() => {
        active--;
        order.pending = false;
        resolve();
        drainQueue();
      });
    }
  }

  function fetchOrderItems(order) {
    if (order.pending) return Promise.resolve();
    order.pending = true;
    showLoading(order.loadingRow);
    return new Promise((resolve) => {
      queue.push({ order, resolve });
      drainQueue();
    });
  }

  async function loadOrder(order) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(order.url, { credentials: 'include', signal: controller.signal });
      const finalUrl = new URL(response.url || order.url);
      if (/^\/account\/login\/?$/.test(finalUrl.pathname) || response.status === 401 || response.status === 403) {
        throw new Error('authentication');
      }
      if (!response.ok) throw new Error('network');
      if (safeUrl(finalUrl.href, order.url, 'order') !== order.url) throw new Error('unsupported');
      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const products = extractProducts(doc, finalUrl.href);
      // Empty tables may be a partial response; display them but always refetch.
      if (products.length) saveToCache(order, products);
      updateRow(order.loadingRow, products);
    } catch (error) {
      showError(order, error.message);
    } finally {
      clearTimeout(timeout);
    }
  }

  async function init() {
    if (location.origin !== ORIGIN || !/^\/account\/?$/.test(location.pathname)) return;
    const orders = [];
    const rows = document.querySelectorAll('.customer.account table.order-history tbody > tr, table.responsive-table tbody > tr');
    for (const row of rows) {
      if (row.classList.contains('order-items-row') || row.hasAttribute('data-findme-items')) continue;
      const link = [...row.querySelectorAll('th a[href], td a[href]')].find((anchor) => safeUrl(anchor.getAttribute('href'), location.href, 'order'));
      if (!link) continue;
      const url = safeUrl(link.getAttribute('href'), location.href, 'order');
      row.setAttribute('data-findme-items', 'v2');
      const loadingRow = createLoadingRow(row.cells.length || 5);
      row.after(loadingRow);
      orders.push({ url, loadingRow, pending: false });
    }
    if (!orders.length) return;
    const cached = await storageGet(orders.map((order) => cacheKey(order.url)));
    await Promise.all(orders.map((order) => {
      const products = cachedProducts(cached[cacheKey(order.url)], order.url);
      if (products !== null) {
        updateRow(order.loadingRow, products);
        return Promise.resolve();
      }
      return fetchOrderItems(order);
    }));
  }

  void init();
})();
