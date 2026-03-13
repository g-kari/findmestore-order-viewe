(async () => {
  // 注文一覧テーブルの行を取得
  const rows = document.querySelectorAll('table.responsive-table tbody tr');
  if (rows.length === 0) return;

  // 注文情報を抽出
  const orders = [];
  for (const row of rows) {
    const link = row.querySelector(
      'th[data-label="注文"] a, td[data-label="注文"] a, th a, td a'
    );
    if (!link) continue;

    const orderNumber = link.textContent.trim();
    const url = link.href;

    // ローディング行を挿入
    const colspan = row.cells.length || 5;
    const loadingRow = createLoadingRow(colspan);
    row.parentNode.insertBefore(loadingRow, row.nextSibling);

    orders.push({ orderNumber, url, row, loadingRow });
  }

  if (orders.length === 0) return;

  // キャッシュから取得
  const cacheKeys = orders.map((o) => o.orderNumber);
  const cached = await getFromCache(cacheKeys);

  // キャッシュヒット分は即座に表示
  const uncached = [];
  for (const order of orders) {
    const cachedData = cached[order.orderNumber];
    if (cachedData && Array.isArray(cachedData)) {
      updateRow(order.loadingRow, cachedData);
    } else {
      uncached.push(order);
    }
  }

  // キャッシュミス分をフェッチ（最大3並列）
  await fetchInBatches(uncached, 3);
})();

/**
 * キャッシュからデータを取得
 * @param {string[]} keys
 * @returns {Promise<Object>}
 */
function getFromCache(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => {
      resolve(result || {});
    });
  });
}

/**
 * キャッシュにデータを保存
 * @param {string} key
 * @param {Array<{name: string, imageUrl: string}>} products
 */
function saveToCache(key, products) {
  chrome.storage.local.set({ [key]: products });
}

/**
 * バッチ処理でフェッチ（最大concurrency件並列）
 * @param {Array} orders
 * @param {number} concurrency
 */
async function fetchInBatches(orders, concurrency) {
  for (let i = 0; i < orders.length; i += concurrency) {
    const batch = orders.slice(i, i + concurrency);
    await Promise.all(batch.map((order) => fetchOrderItems(order)));
  }
}

/**
 * 注文詳細ページから商品情報（名前・画像）を取得してUI更新
 * @param {Object} order
 */
async function fetchOrderItems(order) {
  const { orderNumber, url, loadingRow } = order;
  try {
    const response = await fetch(url, { credentials: 'include' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const html = await response.text();
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    const products = extractProducts(doc);

    saveToCache(orderNumber, products);
    updateRow(loadingRow, products);
  } catch (err) {
    console.error(`[FINDME拡張] 注文 ${orderNumber} の取得に失敗:`, err);
    showError(loadingRow, order);
  }
}

/**
 * 詳細ページDOMから商品情報（名前・画像URL・商品URL）を抽出
 * @param {Document} doc
 * @returns {Array<{name: string, imageUrl: string, productUrl: string}>}
 */
function extractProducts(doc) {
  const seen = new Set();
  const products = [];

  // 商品リンクを含むtr行を走査（画像と名前を同一行から取得）
  const productLinkSelectors = [
    'table a[href*="/products/"]',
    '.order-detail__item a[href*="/products/"]',
    '.product-name a',
    'a[href*="/products/"]',
  ];

  for (const selector of productLinkSelectors) {
    const links = doc.querySelectorAll(selector);
    if (links.length === 0) continue;

    for (const a of links) {
      const name = a.textContent.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const productUrl = a.href || '';

      // 同じtr内の画像を探す
      const row = a.closest('tr');
      let imageUrl = '';
      if (row) {
        const img = row.querySelector('img');
        if (img) {
          imageUrl = img.src || img.dataset.src || '';
        }
      }

      // trが見つからない場合は近傍の親要素から画像を探す
      if (!imageUrl) {
        const parent = a.closest('td, li, .line-item, .product');
        if (parent) {
          const img = parent.querySelector('img');
          if (img) {
            imageUrl = img.src || img.dataset.src || '';
          }
        }
      }

      products.push({ name, imageUrl, productUrl });
    }

    if (products.length > 0) break;
  }

  return products;
}

/**
 * ローディング行を作成（DOM操作のみ）
 * @param {number} colspan
 * @returns {HTMLTableRowElement}
 */
function createLoadingRow(colspan) {
  const tr = document.createElement('tr');
  tr.className = 'order-items-row order-items-loading';

  const td = document.createElement('td');
  td.className = 'order-items-cell';
  td.setAttribute('colspan', String(colspan));

  const spinner = document.createElement('span');
  spinner.className = 'order-items-spinner';

  const text = document.createElement('span');
  text.className = 'order-items-loading-text';
  text.textContent = '読み込み中...';

  td.appendChild(spinner);
  td.appendChild(text);
  tr.appendChild(td);
  return tr;
}

/**
 * 商品情報リストで行を更新（DOM操作のみ）
 * @param {HTMLTableRowElement} row
 * @param {Array<{name: string, imageUrl: string}>} products
 */
function updateRow(row, products) {
  row.classList.remove('order-items-loading');
  row.classList.add('order-items-loaded');

  const cell = row.querySelector('.order-items-cell');
  if (!cell) return;

  while (cell.firstChild) {
    cell.removeChild(cell.firstChild);
  }

  if (products.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'order-items-empty';
    empty.textContent = '商品情報なし';
    cell.appendChild(empty);
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'order-items-list';

  for (const product of products) {
    const li = document.createElement('li');
    li.className = 'order-item';

    // 商品URLがあればa要素で囲んで商品詳細ページへ遷移
    const inner = product.productUrl ? document.createElement('a') : document.createElement('span');
    inner.className = 'order-item-inner';
    if (product.productUrl) {
      inner.href = product.productUrl;
      inner.target = '_blank';
      inner.rel = 'noopener noreferrer';
    }

    if (product.imageUrl) {
      const img = document.createElement('img');
      img.className = 'order-item-image';
      img.src = product.imageUrl;
      img.alt = product.name;
      img.loading = 'lazy';
      // 画像読み込みエラー時は非表示
      img.addEventListener('error', () => {
        img.style.display = 'none';
      });
      inner.appendChild(img);
    }

    const nameSpan = document.createElement('span');
    nameSpan.className = 'order-item-name';
    nameSpan.textContent = product.name;
    inner.appendChild(nameSpan);

    li.appendChild(inner);
    ul.appendChild(li);
  }

  cell.appendChild(ul);
}

/**
 * エラー表示（クリックで再試行）
 * @param {HTMLTableRowElement} row
 * @param {Object} order
 */
function showError(row, order) {
  row.classList.remove('order-items-loading');
  row.classList.add('order-items-error');

  const cell = row.querySelector('.order-items-cell');
  if (!cell) return;

  while (cell.firstChild) {
    cell.removeChild(cell.firstChild);
  }

  const btn = document.createElement('button');
  btn.className = 'order-items-retry';
  btn.textContent = '取得失敗（再試行）';
  btn.addEventListener('click', () => {
    row.classList.remove('order-items-error');
    row.classList.add('order-items-loading');

    while (cell.firstChild) {
      cell.removeChild(cell.firstChild);
    }

    const spinner = document.createElement('span');
    spinner.className = 'order-items-spinner';
    const loadingText = document.createElement('span');
    loadingText.className = 'order-items-loading-text';
    loadingText.textContent = '読み込み中...';
    cell.appendChild(spinner);
    cell.appendChild(loadingText);

    fetchOrderItems(order);
  });

  cell.appendChild(btn);
}
