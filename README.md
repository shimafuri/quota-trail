# quota-trail

Claude Code と Codex CLI の **5h limit / Weekly limit の使用率（%）を 3 分ごとに記録**し、
履歴をグラフで見せる Windows 常駐（トレイ）アプリです。ウィンドウは持たず、
ダッシュボードは localhost の HTTP サーバ経由で既定ブラウザに開きます。

設計の詳細は [`docs/design.md`](docs/design.md) を参照してください。

## 必要環境

- Windows 10 以降
- Node.js 20 以上（ネイティブモジュールのビルドに Visual Studio Build Tools と Python が必要）
- 使用率の取得には Claude Code / Codex CLI にログイン済みであること
  （`~/.claude/.credentials.json` と `~/.codex/auth.json` を **読むだけ** で、書き換えは一切しません）

## セットアップ

```sh
npm install
```

`postinstall`（`scripts/prepare-native.mjs`）が `better-sqlite3` を
**Node ABI 用** と **Electron ABI 用** の 2 通りビルドして
`node_modules/better-sqlite3/build/Release/` に保存します。
これにより `npm start`（Electron）でも `npm test`（素の Node）でも同じ `db.mjs` が動きます。

## 起動

```sh
npm start
```

トレイにアイコンが出ます。左クリックまたは右クリックメニューの
「ダッシュボードを開く」で `http://127.0.0.1:47811/` がブラウザで開きます。

メニュー: ダッシュボードを開く / 今すぐ取得 / Windows 起動時に実行する（チェックボックス）/ 終了

## テスト

```sh
npm test
```

`node --test tests/` を実行します（`node:test`、追加依存なし）。

## 設定ファイル

`%APPDATA%\quota-trail\config.json`

```json
{ "pollIntervalSec": 180, "port": 47811, "retentionDays": null }
```

- `pollIntervalSec`: 取得間隔（秒）。既定 180、最小 30。**次の tick から反映**されます（再起動不要）
- `port`: ダッシュボードのポート。使用中なら 47811〜47899 を順に探し、実際に bind した値を書き戻します
- `retentionDays`: 保持日数。`null` は無制限。値があれば起動時に古い行を削除します

そのほかのファイル:

| 用途 | パス |
|---|---|
| SQLite | `%APPDATA%\quota-trail\quota-trail.sqlite` |
| ログ（1 行 JSON、1 MB でローテーション） | `%APPDATA%\quota-trail\logs\quota-trail.log` |

## 自動起動について

トレイメニューの「Windows 起動時に実行する」は Electron の `app.setLoginItemSettings` を呼び、
`HKCU\Software\Microsoft\Windows\CurrentVersion\Run` に登録します（チェックを外すと削除）。
`npm start` の開発起動でも登録できますが、その場合は `electron.exe` にリポジトリのパスを渡す形になるため、
リポジトリを移動したら登録し直してください。

## API（読み取り専用・localhost 限定）

- `GET /api/meta` … プロバイダー / 窓の一覧、取得間隔、現在時刻、DB パス
- `GET /api/samples?from=<epoch ms>&to=<epoch ms>` … 4 系列の履歴（範囲外の直前・直後 1 点を含む）
- `GET /api/latest` … 4 系列の最新 1 行

## パッケージング（未検証）

```sh
npm run build   # electron-builder --win portable nsis
```

v1 の受け入れ条件は `npm start` で動くことなので、`electron-builder` は設定のみ用意しています。
