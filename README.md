# FINDME STORE 注文商品表示

FINDME STORE の注文一覧ページに、購入商品名・商品画像をインライン表示する Chrome 拡張機能です。

## 概要

FINDME STORE（findmestore.thinkr.jp）の注文一覧ページでは、注文番号・日付・金額しか表示されず、何を購入したか確認するには注文ごとに詳細ページを開く必要があります。

この拡張機能をインストールすると、注文一覧の各行に商品名が自動表示され、一覧を見るだけで購入内容を把握できます。注文明細に商品画像が含まれている場合は画像も表示します。商品ページや追加APIへ画像補完のためのアクセスは行いません。

## 機能

- 2026年10月リニューアル後と旧レイアウトの注文一覧に対応
- 注文一覧の各注文の下に購入商品名・バリエーションを表示
- 注文明細に画像がある場合のみ商品画像を表示（画像がない新明細でも商品名を表示）
- 商品をクリックすると商品詳細ページへ遷移（別タブ）
- 取得済みの注文はバージョン付きキャッシュから表示（7日間）
- 認証切れ・未知の明細HTML・空の明細を正常な商品キャッシュとして保存しない
- 並列フェッチ（最大3件同時）による高速ロード

## 対応ページ

`https://findmestore.thinkr.jp/account*`

## インストール

### Chrome Web Store（推奨）

*(公開後にリンクを追加)*

### 手動インストール（デベロッパーモード）

1. このリポジトリをダウンロード（[ZIP](https://github.com/g-kari/findmestore-order-viewe/archive/refs/heads/main.zip)）して解凍
2. Chrome で `chrome://extensions/` を開く
3. 右上の「デベロッパーモード」をオン
4. 「パッケージ化されていない拡張機能を読み込む」をクリック
5. 解凍したフォルダを選択

## 使い方

1. FINDME STORE にログインした状態で注文一覧ページ（マイアカウント）を開く
2. 自動的に各注文の下に商品情報が読み込まれて表示される
3. 商品名または画像をクリックすると商品詳細ページへ遷移

## プライバシー・権限

| 権限 | 用途 |
|------|------|
| `storage` | 取得済み注文情報のキャッシュ（ローカル保存のみ） |
| `https://findmestore.thinkr.jp/*` | 注文詳細ページの取得 |

- 注文情報を独自の外部サーバーへ送信しません
- 明細に含まれる画像のみ、同一サイトまたは Shopify CDN から読み込みます（リファラーなし）
- 追加のAPI・認証情報・ホスト権限は不要です
- 取得したデータはブラウザ内にのみ保存されます

### Chrome Web Store 申請用：権限の説明

**単一用途**

> FINDME STORE（findmestore.thinkr.jp）の注文一覧ページに、購入商品名と商品画像をインライン表示する単一機能の拡張機能です。

**Storage が必要な理由**

> 注文詳細ページから取得した商品情報（商品名・画像URL）をブラウザのローカルストレージにキャッシュするために使用します。キャッシュにより、同じ注文の情報を再取得せず即座に表示できます。外部への送信は行いません。

**ホスト権限（findmestore.thinkr.jp）が必要な理由**

> 注文一覧ページ（/account）に表示されない商品情報を取得するため、同一ドメインの注文詳細ページ（/account/orders/:id）にfetchでアクセスします。ログイン済みセッションのクッキーを使用して取得するため、このホスト権限が必要です。アクセスするのは findmestore.thinkr.jp のみです。

## ファイル構成

```
findme-extension/
├── manifest.json       # Manifest V3 拡張機能定義
├── content_script.js   # メインロジック
├── style.css           # スタイル
└── icons/
    ├── icon.svg        # アイコンソース
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 技術仕様

- Manifest V3
- `chrome.storage.local` による注文URL単位・形式バージョン付きキャッシュ（7日間、旧形式は参照しない）
- `fetch` + `DOMParser` による詳細ページ解析
- XSS 対策: DOM 操作は `textContent` / `createElement` のみ使用

## 開発とテスト

Node.js 22.13 以降と pnpm 11.25.0 を使用します。拡張本体はビルド不要です。テスト依存は拡張の実行に使用しません。

pnpm は package.json の packageManager で固定しています。未導入の場合は `npm install --global pnpm@11.25.0` で指定版を導入してください（npm は pnpm 自体の初回導入にのみ使用）。依存の変更時は pnpm-lock.yaml を更新・コミットし、package-lock.json は作成しません。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm run check
pnpm test
pnpm exec playwright install chromium
pnpm run test:browser
```

- `pnpm test`: jsdom で DOMParser、描画、キャッシュ、取得制御を確認する合成DOMテスト。
- `pnpm run test:browser`: Chromium で同じ主要フローを確認するブラウザ回帰テスト。全URLを合成HTMLへ差し替え、外部へのリクエストを遮断します。
- 必要な場合は `PLAYWRIGHT_CHROMIUM_EXECUTABLE` で既存Chromiumのパスを指定できます。
- GitHub Actions で構文チェック、合成DOMテスト、Chromium回帰テストを実行します。
- fixtures の注文・商品・金額・日付はすべて架空です。実注文HTML、Cookie、認証情報、HARを追加しないでください。

### 検証範囲と未確認事項

新レイアウトのセレクタはログイン後の一覧と1件の明細のDOM構造で確認しました。旧レイアウトは既存開発資料に基づく合成fixtureで回帰を確認します。合成テストの成功は、実サイトでの拡張動作や取得されるサーバーHTMLまで検証したことを意味しません。

新明細で画像が存在しない場合は商品名だけを表示します。ログイン切れや未知のHTMLでは再試行ボタンを表示し、ページ全体のおすすめ商品へ抽出範囲を広げません。空の既知明細は「商品情報なし」と表示しますが、部分応答の可能性があるためキャッシュせず次回再取得します。

## ライセンス

MIT
