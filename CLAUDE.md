# FINDME STORE 注文商品表示 Chrome拡張機能

## 概要

`findmestore.thinkr.jp/account` の注文一覧に、購入商品名・バリエーションと、注文明細に存在する場合のみ商品画像を追加する Manifest V3 拡張。Vanilla JS/CSS、ビルド不要。注文・アカウントの変更や追加APIの利用は行わない。

## ファイル

- `manifest.json`: バージョン、storage と既存FINDMEホストの権限。
- `content_script.js`: 一覧探索、限定した明細解析、描画、取得キュー、ローカルキャッシュ。
- `style.css`: 追加する商品行の表示。
- `tests/fixtures/`: 架空値だけの新旧合成HTML。
- `tests/content_script.test.cjs`: jsdom 回帰。
- `tests/browser.test.cjs`: Chromium 回帰。通信は合成レスポンスへ差し替える。

## DOM構造

### 2026年10月の新画面

- 一覧: `.customer.account table.order-history tbody > tr`
- 注文リンク: `td[headers~="ColumnOrder"] a[href*="/account/orders/"]`
- 注文行のセル数から追加行の colspan を決める。観測した画面は5列。
- 明細: `.customer.order table.order-details tbody > tr`
- 商品列: `td[headers~="ColumnProduct"]`
- 商品名リンク: 商品列の `a[href*="/products/"]`（テキストのあるもの）。
- バリエーション: 商品列の `.properties`。
- 商品URL: `/products/<handle>?variant=<id>` のような相対URLもある。
- ページング: `nav.pagination[role="navigation"]`、`/account?page=<page>`。既存リンクは変更しない。
- 観測した1件の明細には画像要素がなかった。画像のない商品をエラーにしない。

### 旧画面互換

- 一覧: `table.responsive-table tbody > tr`
- 注文リンク: 行内の `th` / `td` にある同一ホストの `/account/orders/<id>` リンク。
- 明細: `table.responsive-table` / `table#order_details` / `table.order-details` のうち、「商品 / 商品名 / Product」と「数量 / Quantity」等のヘッダーを持つテーブル、または商品列・数量列の両方を `data-label` で示すテーブルだけを解析。`main` / `#MainContent` があればその内部に限定し、aside / nav / header / footer 内を除外する。
- 画像は同じ商品行の `img` から取得する。
- 旧画面の完全な実HTMLは保存していない。既存資料に基づく合成fixtureで互換回帰を行う。

## 取得・安全性

- 詳細ページのみ同一originへ `fetch` + `credentials: include`。最大3並列、15秒の中断タイムアウト。
- HTTP失敗、ログインへの遷移、他の注文/ホストへの遷移、未知のHTMLは成功としてキャッシュしない。
- 既知の空テーブルは空表示とするが、部分応答の可能性があるためキャッシュしない。
- ページ全体の `/products/` リンクへ広げるフォールバックは禁止。おすすめ商品の混入を防ぐ。
- 同名商品も行単位で保持し、variantの異なる商品を削除しない。
- URLは明細URLを基準に解決する。注文/商品はHTTPSのFINDMEだけ、画像はHTTPSのFINDMEまたは `cdn.shopify.com` だけ。
- DOMは `createElement` / `textContent` で組み立てる。画像のリファラーは送らない。
- キャッシュキーは `findme:v2:` + 注文URL。形式バージョン・時刻・値の形を検証し、7日以内の空でない結果のみ再利用。旧注文番号キーは無視する。
- 注文行に処理済み印を付け、スクリプト再実行で行や取得を重複させない。

## 検証

```sh
npm ci --ignore-scripts
npm run check
npm test
npx playwright install chromium
npm run test:browser
```

Node.js 22 以降。Chromium が指定パスにある場合は `PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chromium` を設定できる。合成DOMとブラウザは別の検証段階として報告する。実サイトの拡張動作やraw server HTML取得は、別途確認していなければ未検証と明記する。

実注文の値・住所・氏名・金額・Cookie・token・HARはfixture、ログ、PRへ追加しない。インストール、マージ、公開、追加API、権限拡大は依頼の範囲を再確認する。
