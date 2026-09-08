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

### 運用（推奨）: パッケージ済み exe

```sh
npm run build:dir       # electron-builder --win dir → dist\win-unpacked\quota-trail.exe
```

```powershell
powershell -ExecutionPolicy Bypass -File scripts/start-detached.ps1
```

**運用では必ずパッケージ済み exe を使ってください。** `npm start` の開発起動は
プロセス名が汎用的な `electron.exe` になるため、他プロジェクトが行う無差別な
`Stop-Process electron` に巻き込まれて落ちます（2026-09-08 の事故）。
パッケージ済み exe はプロセス名が `quota-trail.exe` になるので巻き込まれません。

`scripts/start-detached.ps1` は `dist\win-unpacked\quota-trail.exe` があればそれを、
無ければ開発用の `electron.exe "<repo>"` を起動し、どちらを使ったかを表示します
（WMI 経由で起動するため、起動元のターミナルを閉じても巻き込まれません）。

**コードを変更したら `npm run build:dir` で作り直し**、既存インスタンスを終了してから
`scripts/start-detached.ps1` で起こし直してください。

### 開発

```sh
npm start
```

renderer をライブで編集しながら試すときはこちら（`electron.exe` として動きます）。

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
パッケージ済み exe から登録すると `quota-trail`（= `dist\win-unpacked\quota-trail.exe`）という名前で登録されます。
`npm start` の開発起動でも登録できますが、その場合は `electron.exe` にリポジトリのパスを渡す形になるため、
リポジトリを移動したら登録し直してください。
現在の登録状態は `GET /api/meta` の `autostart` でも確認できます（読み取り専用。変更はトレイメニューから）。

## API（読み取り専用・localhost 限定）

- `GET /api/meta` … プロバイダー / 窓の一覧、取得間隔、現在時刻、DB パス、SQLite バックエンド、自動起動の有無（`autostart`、読み取り専用）
- `GET /api/samples?from=<epoch ms>&to=<epoch ms>` … 4 系列の履歴（範囲外の直前・直後 1 点を含む）
- `GET /api/latest` … 4 系列の最新 1 行

## パッケージング

```sh
npm run build:dir   # electron-builder --win dir → dist\win-unpacked\quota-trail.exe（検証済み）
npm run build       # electron-builder --win portable nsis（未検証）
```

- `asar: false`（ローカル用途。ネイティブモジュールをそのまま置くのが最も単純）
- `npmRebuild: false`（`scripts/prepare-native.mjs` が用意した Node / Electron 2 種の
  `better_sqlite3-*.node` を electron-builder のリビルドで壊さないため）
- `electron-builder` は **26.13.0 に固定**しています。26.14.0 以降は `@noble/hashes` v2（ESM 専用）を
  CJS から `require()` するため、Node 20 系では `ERR_REQUIRE_ESM` でビルドできません
