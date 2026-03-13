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
    if (cached[order.orderNumber]) {
      updateRow(order.loadingRow, cached[order.orderNumber]);
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
 * @param {string[]} value
 */
function saveToCache(key, value) {
  chrome.storage.local.set({ [key]: value });
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
 * 注文詳細ページから商品名を取得してUI更新
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

    // 商品リンクから商品名を抽出（重複除去）
    const selectors = [
      'table a[href*="/products/"]',
      '.product-name a',
      '.order-detail__item a[href*="/products/"]',
      'a[href*="/products/"]',
    ];

    const seen = new Set();
    const productNames = [];

    for (const selector of selectors) {
      const links = doc.querySelectorAll(selector);
      for (const a of links) {
        const name = a.textContent.trim();
        if (name && !seen.has(name)) {
          seen.add(name);
          productNames.push(name);
        }
      }
      if (productNames.length > 0) break;
    }

    saveToCache(orderNumber, productNames);
    updateRow(loadingRow, productNames);
  } catch (err) {
    console.error(`[FINDME拡張] 注文 ${orderNumber} の取得に失敗:`, err);
    showError(loadingRow, order);
  }
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
 * 商品名リストで行を更新（DOM操作のみ）
 * @param {HTMLTableRowElement} row
 * @param {string[]} productNames
 */
function updateRow(row, productNames) {
  row.classList.remove('order-items-loading');
  row.classList.add('order-items-loaded');

  const cell = row.querySelector('.order-items-cell');
  if (!cell) return;

  // 既存の子要素をクリア
  while (cell.firstChild) {
    cell.removeChild(cell.firstChild);
  }

  if (productNames.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'order-items-empty';
    empty.textContent = '商品情報なし';
    cell.appendChild(empty);
    return;
  }

  const ul = document.createElement('ul');
  ul.className = 'order-items-list';

  for (const name of productNames) {
    const li = document.createElement('li');
    li.className = 'order-item';
    li.textContent = name; // textContent でXSSを回避
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
