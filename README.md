# FINDME STORE 注文商品表示

FINDME STORE の注文一覧ページに、購入商品名・商品画像をインライン表示する Chrome 拡張機能です。

## 概要

FINDME STORE（findmestore.thinkr.jp）の注文一覧ページでは、注文番号・日付・金額しか表示されず、何を購入したか確認するには注文ごとに詳細ページを開く必要があります。

この拡張機能をインストールすると、注文一覧の各行に商品画像と商品名が自動表示され、一覧を見るだけで購入内容を把握できます。

## 機能

- 注文一覧の各注文の下に購入商品名・商品画像を表示
- 商品をクリックすると商品詳細ページへ遷移（別タブ）
- 取得済みの注文はキャッシュから即座に表示
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

- 外部サーバーへのデータ送信は一切行いません
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
- `chrome.storage.local` によるキャッシュ
- `fetch` + `DOMParser` による詳細ページ解析
- XSS 対策: DOM 操作は `textContent` / `createElement` のみ使用

## ライセンス

MIT
