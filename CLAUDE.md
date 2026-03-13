# FINDME STORE 注文商品表示 Chrome拡張機能

## プロジェクト概要

FINDME STORE（`findmestore.thinkr.jp`）の注文一覧ページ（`/account`）に、各注文の購入商品名をインライン表示するChrome拡張機能。

通常は注文番号・日付・支払い/配送状況・合計金額しか表示されないが、この拡張機能により各注文行の下に商品名が自動表示される。

## 対象ドメイン

`findmestore.thinkr.jp`

## 技術スタック

- Manifest V3 Chrome拡張機能
- Vanilla JavaScript（content_script.js）
- CSS（style.css）
- chrome.storage.local（キャッシュ）

## ファイル構成

```
findme-extension/
├── CLAUDE.md              # このファイル
├── manifest.json          # Manifest V3 拡張機能定義
├── content_script.js      # メインロジック（ページに注入）
└── style.css              # 追加UIのスタイル
```

## ページのDOMセレクタ情報

### 注文一覧ページ (`/account`)

- 注文テーブル: `table.responsive-table`
- 注文行: `table.responsive-table tbody tr`
- 注文番号リンク: `th[data-label="注文"] a`（または `td[data-label="注文"] a`）
- 注文番号テキスト: リンクのinnerText（例: `#1234`）
- 詳細ページURL: リンクのhref（例: `/account/orders/1234`）

### 注文詳細ページ (`/account/orders/:id`)

- 商品リンク: `table a[href*="/products/"]`（商品名テキストを含む）

## インストール手順

1. `chrome://extensions/` を開く
2. 右上「デベロッパーモード」をON
3. 「パッケージ化されていない拡張機能を読み込む」をクリック
4. このディレクトリ（`findme-extension/`）を選択

## 検証手順

1. `https://findmestore.thinkr.jp/account` にアクセス（要ログイン）
2. 各注文行の下に商品名が表示されることを確認
3. ページネーション（`?page=2` 以降）でも動作することを確認
4. ページ再読み込み時にキャッシュから即座に表示されることを確認
5. DevToolsのConsoleでエラーがないことを確認

## 機能仕様

- 注文一覧の各行から詳細ページURLを抽出
- `chrome.storage.local` でフェッチ結果をキャッシュ（注文番号をキー）
- 詳細ページへの並列フェッチ（最大3件同時）
- ローディング中は「読み込み中...」を表示
- エラー時は「取得失敗（再試行）」を表示（クリックで再試行）
