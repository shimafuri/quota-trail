# quota-trail 設計書（v1）

- 作成: 2026-09-07（設計者: Claude Fable 5.1。発注者指示により Codex CLI の 5h limit 枯渇中のため Fable が設計）
- 関連仮説: `docs/hypotheses/H-001-passive-codex-rollout-source.md`（却下・v2 候補）、`docs/hypotheses/H-002-no-idle-pause.md`（採用）

## 1. 目的と非目的

Claude Code と Codex CLI の **5h limit / Weekly limit、および Claude Fable 専用 Weekly limit の使用率（%）を 3 分ごとに記録**し、履歴を **読めるグラフ**（凡例・軸ラベル・データ点・欠測の明示）で見せる Windows 常駐アプリ。Agents Pulse の不満点（色に意味がない、凡例がない、軸ラベル崩壊、データ点不明）を解消する。

非目的（v1）:
- 消費レート（pp/h）や ETA の推定、通知、CSV 出力
- Claude / Codex 以外のプロバイダー
- OAuth トークンの自発的な refresh（§4.3）
- idle / ロック中のポーリング停止（H-002 で不採用）

## 2. 技術選定

| 項目 | 選定 | 理由 |
|---|---|---|
| ランタイム | Electron（最新安定版）+ Node ESM | 発注者指定。tray / loginItem / 単一 exe 化が標準機能 |
| 言語 | JavaScript（ESM, JSDoc 型注釈） | バンドラ・トランスパイル不要で `npm start` 直起動。renderer もバンドル無しの ES modules |
| 永続化 | SQLite: `better-sqlite3` + `@electron/rebuild` | 同期 API で単純。Electron ABI 向け prebuilt が配布されているため通常はダウンロードだけで済む。**ビルドに失敗する場合の代替**は Electron 同梱 Node の `node:sqlite`（Node >= 22.13 で unflag 済。実装者が確認し、使えるならこちらを優先してもよい。どちらでも同じ `db.mjs` の薄い抽象を通す） |
| グラフ | 自前 Canvas 2D 描画（ライブラリ無し） | 要件（ホイールズーム→カスタム連動、欠測の灰色帯、目盛り最小 50px、棒/折れ線切替、点の有無）はライブラリに合わせるより自前の方が短い。CDN 依存も無し |
| HTTP | Node `http` 標準 | 静的ファイル + JSON API のみ |
| テスト | `node:test` | 追加依存無し。純粋ロジック（正規化・ギャップ検出・目盛り計算・ポート選択）を対象 |
| パッケージ | `electron-builder --win dir`（`npm run build:dir` → `dist\win-unpacked\quota-trail.exe`）。portable + NSIS は後日 | **運用はパッケージ済み exe を使う**。開発起動の `electron.exe` は名前が汎用的なため、他プロジェクトの無差別な `Stop-Process electron` に巻き込まれて落ちる（2026-09-08 の事故）。`quota-trail.exe` なら巻き込まれない。`asar: false`（ローカル用途で最も単純）、`npmRebuild: false`（`prepare-native.mjs` の Node / Electron 2 種の `better_sqlite3-*.node` を壊さないため）。`electron-builder` は 26.13.0 に固定（26.14.0 以降は ESM 専用の `@noble/hashes` v2 を CJS から `require()` するため Node 20 でビルド不可） |

## 3. 構成

```
quota-trail/
  package.json               "type": "module", main: src/main/index.mjs
  src/
    main/
      index.mjs              Electron エントリ。single-instance lock、tray、scheduler、server 起動
      config.mjs             設定の読み書き（userData/config.json）。pollIntervalSec 既定 180
      db.mjs                 SQLite open / migrate / insertSamples / querySamples / latest
      scheduler.mjs          setTimeout ベースの周期実行（間隔は config から毎回読む）
      tray.mjs               トレイアイコンとメニュー
      autostart.mjs          app.setLoginItemSettings のラッパ（dev / packaged 両対応）
      server.mjs             localhost HTTP サーバ（ポート選択、静的配信、/api/*）
      logger.mjs             1 行 JSON ログ
      providers/
        claude.mjs           ~/.claude/.credentials.json → api.anthropic.com/api/oauth/usage
        codex.mjs            ~/.codex/auth.json → chatgpt.com/backend-api/codex/usage（401 時 app-server フォールバック）
        codex-app-server.mjs `codex app-server` を spawn して account/rateLimits/read を 1 回呼ぶ
      lib/
        normalize.mjs        各 API 応答 → {usedPercent, resetsAt} 正規化（純粋関数、テスト対象）
        ports.mjs            空きポート探索
    shared/
      gaps.mjs               欠測区間の算出（純粋関数。renderer と node:test 両方から import）
      ticks.mjs              時間軸目盛りの間隔決定（純粋関数。同上）
    renderer/
      index.html             ダッシュボード（2 列グリッド）
      app.mjs                データ取得・状態（期間/形式/点表示、ズーム連動）
      chart.mjs              Canvas 描画（軸・目盛り・系列・点・欠測帯・凡例）
      theme.mjs              色定義
      style.css
  tests/                     node:test（*.test.mjs）
  assets/icon.ico, icon.png  トレイアイコン（実装者が生成: 単色の簡素な円など。16/32px）
  scripts/codex-limits.mjs   （既存）
  docs/design.md, docs/hypotheses/
```

`src/shared/` は server が `/shared/*.mjs` として renderer にも配信する。

## 4. データ取得

### 4.1 共通の正規化サンプル

```ts
type Provider = 'claude' | 'codex';
type Window = '5h' | 'weekly' | 'weekly-fable';
interface Sample {
  observedAt: number;        // epoch ms（取得を開始した時刻。通常 5 行とも同じ値）
  provider: Provider;
  window: Window;
  usedPercent: number | null; // 0..100「使った割合」。取得失敗時 null
  resetsAt: number | null;    // epoch ms
  status: 'ok' | 'error';
  errorCode: string | null;   // 'no_credentials' | 'auth_expired' | 'http_<status>' | 'network' | 'parse' | 'timeout' | 'window_absent'
  intervalSec: number;        // その時点の設定間隔（3 分は変わりうるので行ごとに保存）
}
```

**表示は両プロバイダーとも「使用率 %」に統一する。** Codex CLI の `/status` は「残り %」を表示するが、API（`used_percent`）は「使用済み %」を返す。正規化層で `usedPercent = used_percent` とし、残りへの変換はしない。Claude の `utilization` も使用済み % なのでそのまま。値は 0..100 に clamp。

### 4.2 Claude Code

- 資格情報: `%CLAUDE_CONFIG_DIR%` または `~/.claude/.credentials.json` の `claudeAiOauth.accessToken`。**毎回ファイルを読み直す**（Claude Code が refresh して書き換えるため）
- 要求: `GET https://api.anthropic.com/api/oauth/usage`
  - `Authorization: Bearer <token>`、`anthropic-beta: oauth-2025-04-20`、`User-Agent: claude-code/<version>`（`claude --version` の結果を起動時に 1 回取得してキャッシュ、取れなければ `claude-code/2.1.263`）、`Accept: application/json`
  - タイムアウト 15 秒（`AbortController`）
- 応答: `five_hour.utilization`（%）/ `five_hour.resets_at`（ISO）/ `seven_day.utilization` / `seven_day.resets_at` → `5h` / `weekly`。`limits` 内の Fable 専用週次枠 → `weekly-fable`。通常 3 行（§14）
- 401 → `auth_expired`。`expiresAt` が過去でもまず送ってみる（サーバー判断に任せる）

### 4.3 トークン refresh 方針（重要）

**自発的に refresh しない。** OAuth の refresh は refresh_token を rotate するため、quota-trail が refresh して `.credentials.json` に書き戻さない、または書き戻しが Claude Code と競合すると、発注者の Claude Code ログインを壊しうる。Agents Pulse は `claude update` を subprocess で叩くことで refresh を誘発しているが、副作用（自己更新）が大きいので採用しない。

- Claude: 401 の間は `auth_expired` の error 行を記録し続け、Claude Code が次に使われて `.credentials.json` が更新されれば自然に回復する。トレイのツールチップに「Claude: 認証期限切れ（Claude Code を一度起動すると回復）」を出す
- Codex: 401 のとき **1 回だけ** `codex app-server` フォールバック（§4.4）を試す。Codex CLI 自身が `auth.json` を refresh して書き戻すので安全。フォールバックで取れた値をそのサンプルに使い、次回以降はまた HTTP から

### 4.4 Codex CLI

- 資格情報: `%CODEX_HOME%` または `~/.codex/auth.json` の `tokens.access_token`（`tokens.account_id` があれば `ChatGPT-Account-Id` ヘッダに付ける）。毎回読み直す
- 主経路: `GET https://chatgpt.com/backend-api/codex/usage`
  - `Authorization: Bearer <token>`、`User-Agent: codex-cli/<version>`（`codex --version` を起動時に 1 回取得、既定 `codex-cli/0.153.4`）、`Accept: application/json`、タイムアウト 15 秒
  - 応答 `rate_limit.primary_window.{used_percent, reset_at(epoch 秒)}` → `5h`、`rate_limit.secondary_window` → `weekly`。`secondary_window` が無い（null）場合は weekly 行を `status:'error', errorCode:'window_absent'` とする（プランによって週次枠が無いことがある）
- フォールバック（401、または応答形不一致のとき 1 回）: `codex app-server` を空の一時ディレクトリを cwd に spawn し、JSON-RPC（1 行 1 JSON）で `initialize`（`clientInfo: {name:'quota-trail', title:'quota-trail', version}`）→ `initialized` 通知 → `account/rateLimits/read` → 結果 `rateLimits.primary/secondary.{usedPercent, windowDurationMins, resetsAt(epoch 秒)}` を読む → プロセス終了（`kill()` → 5 秒で強制）。20 秒タイムアウト。stdout 上限 256 KiB。`fs/*` や `command/*` は呼ばない。Windows では `codex` は `.cmd` シムなので、`PATH` から `codex.cmd` を探して `spawn('cmd.exe', ['/d','/s','/c', 'codex app-server'], {windowsHide:true})` で起動する。実装者は true-vr-v2 の `packages/model-adapters/src/codex/codex-account-probe.ts` を参考にしてよい

### 4.5 スケジューラ

- `scheduler.mjs`: `setTimeout` の再帰。各 tick で `config.pollIntervalSec` を読み直すので設定変更が次回から効く。既定 180 秒。最小 30 秒
- tick: `observedAt = Date.now()` を決め、Claude と Codex を **並行** に取得（`Promise.allSettled`）。結果 5 行を 1 トランザクションで insert
- 起動直後に 1 回即時実行。トレイ「今すぐ取得」でも実行（進行中なら無視。single-flight）
- 取得失敗時も **間隔は変えない**（バックオフ無し）。欠測を作らないため。ただし HTTP 429 のときだけ次回まで 2 倍間隔にする（その tick は `error/http_429` 行を書く）
- PC スリープ復帰・ロック解除（`powerMonitor` の `resume` / `unlock-screen`）では `runNow()` を呼び、次のサンプルを即時取得する（欠測期間を短縮。single-flight のため実行中なら無視）。それでも `setTimeout` の予定発火時刻より 2 倍以上遅れて発火した場合は `tick が遅延`（warn、遅延秒数つき）をログに残す

## 5. 永続化（SQLite）

- ファイル: `app.getPath('userData')/quota-trail.sqlite`（`%APPDATA%/quota-trail/`）。WAL モード
- スキーマ v1:

```sql
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS samples (
  id INTEGER PRIMARY KEY,
  observed_at INTEGER NOT NULL,      -- epoch ms
  provider TEXT NOT NULL,            -- 'claude' | 'codex'
  win TEXT NOT NULL,                 -- '5h' | 'weekly' | 'weekly-fable'（値制約なし）
  used_percent REAL,                 -- NULL when status='error'
  resets_at INTEGER,                 -- epoch ms
  status TEXT NOT NULL,              -- 'ok' | 'error'
  error_code TEXT,
  interval_sec INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_samples_series_time ON samples (provider, win, observed_at);
```

- 保持期間: v1 は削除しない（3 分 × 5 行 = 1 日 2,400 行、1 年で約 87.6 万行。問題なし）。`config.retentionDays`（既定 null = 無制限）だけ用意し、値があれば起動時に古い行を削除
- `db.mjs` API: `openDb(path)`, `insertSamples(samples[])`, `querySamples({provider, win, from, to})`（`observed_at` 昇順、範囲外の直前 1 点・直後 1 点を含む）, `latest()`（各系列の最新 1 行）

## 6. ダッシュボード配信

- `server.mjs`: `127.0.0.1` にのみ bind。ポートは `config.port`（既定 **47811**）を試し、`EADDRINUSE` なら 47811..47899 を順に探し、それも駄目なら `listen(0)` の動的ポート。決まったポートは `config.json` に書き戻す（次回同じ URL になるよう）。トレイ「ダッシュボードを開く」は `shell.openExternal('http://127.0.0.1:<port>/')`
- 静的: `src/renderer/*` と `src/shared/*`（`/shared/` 配下）を配信。`Content-Type` は拡張子で（`.mjs` → `text/javascript`）。`Cache-Control: no-store`。パストラバーサル禁止
- API（JSON。CORS ヘッダは付けない）:
  - `GET /api/meta` → `{ providers:['claude','codex'], windows:['5h','weekly','weekly-fable'], pollIntervalSec, now, dbPath, backend, autostart }`。`weekly-fable` は Claude 専用。`autostart` は `autostart.isEnabled()` の値（読み取り専用。変更はトレイメニューのみ）
  - `GET /api/samples?from=<ms>&to=<ms>` → `{ series: { "claude/5h": Sample[], "claude/weekly": [...], "claude/weekly-fable": [...], "codex/5h": [...], "codex/weekly": [...] }, now }`。`from`/`to` 必須。1 系列あたり上限 50,000 行（超えたら等間隔に間引き、`decimated:true`）
  - `GET /api/latest` → 5 系列の最新 1 行（トレイのツールチップは現行 2 値表示）
- セキュリティ: localhost 限定・読み取り専用・トークン等は一切返さない

## 7. ダッシュボード UI

### 7.1 レイアウト

- 幅 320〜1920 dp。`grid-template-columns: repeat(auto-fit, minmax(300px, 1fr))` で 2 列（>= 660px）/ 1 列（< 660px）。各チャートは固定高 280px（幅 < 480px では 240px）
- 各パネル: ヘッダ左に **タイトル**（`Claude Code · 5h limit` など、系列色の丸付き）、右に 3 つの `<select>`（集計期間 / グラフ形式 / プロットの表示）。狭幅では select が折り返す
- ページ上部: 「quota-trail」タイトル、最終取得時刻、現在値 5 つの小さな数値（例 `Claude 5h 40%`）。下部: 取得間隔と DB パスの表示

### 7.2 コントロール（各パネル右上、`<select>`）

| コントロール | 選択肢 | 既定 | 連動 |
|---|---|---|---|
| 集計期間 | 24時間 / 7日間 / 30日間 / カスタム | 24時間 | **全パネル連動**（1 つ変えると 5 つ同じ範囲になる） |
| グラフ形式 | 折れ線 / 棒グラフ | 折れ線 | パネル個別 |
| プロットの表示 | あり / なし | あり | パネル個別 |

- 状態は `localStorage` に保存（期間・形式・点）。「カスタム」は範囲 `[from,to]` も保存
- 期間 24h/7d/30d は `to = now`、`from = now - N`。60 秒ごとに `now` を進めて再取得（追従）。カスタムのときは固定範囲で追従しない
- 「カスタム」を select で直接選んだ場合は現在の範囲をそのまま固定する

### 7.3 ズーム（マウスホイール）

- `wheel` イベント（`passive:false`、`preventDefault`）。前へ転がす（`deltaY < 0`）→ ズームイン、後ろ → ズームアウト。1 ノッチで範囲を ×0.8 / ×1.25。マウス X 位置を固定点にする（カーソル下の時刻が動かない）
- 最小範囲 1 分（技術的下限）。最大範囲・未来側の上限なし（発注者指示 2026-09-08）。`now` が表示範囲内にあるときは灰色の細い破線と「現在」ラベルを描く
- ズームすると集計期間 select を **「カスタム」** に切り替え、5 パネル全部の範囲を同じにする（連動）。API 再取得はデバウンス 150ms、描画は即時（手元のデータで）
- ドラッグでのパンは任意（実装コストが低ければ入れる）

### 7.4 描画（`chart.mjs`、Canvas 2D、devicePixelRatio 対応）

- 余白: 左 44px（Y ラベル）、右 12px、上 8px、下 28px（X ラベル）、凡例分の高さをさらに下に確保
- **Y 軸**: 0〜100% 固定。10% ごとに目盛り線（薄いグレー、50% は少し濃く）とラベル `0%`, `10%` … `100%`
- **X 軸**: `ticks.mjs` の `pickTimeStep(rangeMs, plotWidthPx, minPx=50)` が候補ステップ `[1m,2m,5m,10m,15m,30m,1h,2h,3h,6h,12h,1d,2d,7d,14d,30d,90d,365d]`（90d/365d は無制限パン対応として 2026-09-08 追加）から **目盛り間隔 >= 50px** を満たす最小のものを選ぶ。`timeTicks(from, to, step)` が目盛り時刻の配列を返す。目盛りはステップの倍数に揃える（ローカル時刻基準。1d 以上は 0:00 に揃える）。ラベル形式はステップで変える: `< 1d` → `HH:mm`（日付が変わる最初の目盛りは `M/D HH:mm`）、`>= 1d かつ < 90d` → `M/D`、`>= 90d` → `YYYY/M/D`。ラベルはグリッド線の下中央
- **系列**（1 パネル 1 系列）:
  - 折れ線: `ok` 点同士を線で結ぶ。ただし **隣接 2 点の間隔が `intervalSec × 2.5` を超える**か、間に `error` 行があるときは線を切る
  - 棒グラフ: 各 `ok` 点から底（0%）まで。幅 = `clamp(pxPerInterval × 0.7, 1, 12)`
  - プロット（点）: 半径 3px（点の間隔が 2px 未満のときは 1.5px）。`あり/なし` で切替。棒グラフ時も点は棒の頂点に描く
  - 線幅 2px。線・棒・点は同じ系列色
- **欠測区間（灰色）**: `gaps.mjs` の `computeGaps(samples, {from, to, now, factor:2.5})` が `[{from,to}]` を返す。(a) 隣接 ok 点の間隔が `intervalSec × factor` 超、(b) `error` 行の区間、(c) 表示範囲先頭から最初の点まで、(d) 最後の点から `now` まで（最後の点が閾値より古いとき）。灰色 `rgba(120,120,128,0.18)` の帯を全高に描き、上端に 4px の濃い灰色バーを置く。凡例に「欠測」を入れる
- **現在時刻線**（2026-09-08 追加、発注者指示）: パン/ズームの範囲上限を撤廃したため、表示範囲を未来側へパンすると `now` が範囲内に入りうる。`now` が `(from, to)` の内側にあるとき、`axisLabel` 色・透明度 0.6 の細い縦破線と、上端に小さな灰色テキスト「現在」を描く（`drawGaps` の後・`drawSeries` の前）
- **リセット**（2026-09-08 修正、発注者指示）: `shared/resets.mjs` の `pastResets(samples)` が検出した「実際に起きたリセット」の時刻に、細い点線の縦線を系列色の半透明で描く。未使用（`usedPercent` が 0 近辺）のウィンドウは `resetsAt` が `now + 窓長` をポーリングごとに返し続け前の点と毎回異なるため、単純な「前の点と `resetsAt` が違う」では誤検出になる（Codex 5h が典型）。そこで隣接する ok 点 a, b について: (1) a が予告した `resetsAt` が a, b の間に実際に経過していれば（`a.resetsAt > a.observedAt && a.resetsAt <= b.observedAt`）そこ（`a.resetsAt`）をリセットとみなす。(2) それに当てはまらなくても `b.resetsAt` が `a.resetsAt` より 60 秒超前進し、かつ使用率が目に見えて下がっていれば（`b.usedPercent < a.usedPercent - 5`）予告時刻が多少ずれていたリセットとみなし `b.observedAt` を使う。(3) それ以外は描かない。凡例に「リセット」
- **リセット予定**（2026-09-07 追加 / 2026-09-08 修正、発注者指示）: 最新 `ok` サンプルの `resetsAt` を Chrome DevTools Performance の Nav/FCP/DCL 風マーカーで描く。範囲内なら系列色の実線縦線 + 塗りつぶしタグ `リセット HH:mm`（今日以外は `M/D HH:mm`）。範囲より先（24h/7d/30d は `to = now` なので通常こちら）ならプロット右端に `▸ リセット HH:mm（あと 3h12m）` を固定表示。`resetsAt < now`（リセット済みだが新サンプル未取得）は灰色で `リセット済み`。残り時間の書式は `ticks.mjs` の `formatRemaining`（`1m未満` / `12m` / `3h12m` / `2d5h`）。ヘッダの現在値チップにも `· リセット HH:mm` を付記。タグはプロット下端・上端どちらに置くかを、タグの水平範囲に入るデータ点との「衝突」数で選ぶ（棒グラフは 0% から生えるため下端タグには常に衝突、上端タグは値が非常に高いときだけ；折れ線はどちらも点の y がタグ矩形に入れば衝突）。衝突が少ない側を採用し、同数なら下端。タグは `globalAlpha 0.92` + 白い 1px 外枠で描き、下の棒・線が薄く透けて見えるようにする。最新 ok サンプルの使用率が 0% のとき（リセットする対象が無い）はタグを描かない（凡例は残す）
- **凡例**: パネル下部。項目: `● Claude Code 5h limit 使用率`、`▬ 欠測`、`┆ リセット`、`▰ リセット予定`
- **ホバー**: 最も近い点に小さなツールチップ（`9/7 03:24  42.0%  リセット 9/7 08:37`）
- 描画は `requestAnimationFrame` でまとめ、`ResizeObserver` でリサイズに追従

### 7.5 色（`theme.mjs`）

| 系列 | 色 | 根拠 |
|---|---|---|
| Claude Code 5h | `#D97757` | Anthropic/Claude ブランドのテラコッタ |
| Claude Code Weekly | `#B4532F` | 同系の濃色（区別と「薄くしない」ため） |
| Claude Code Weekly Fable | `#8E3B63` | テラコッタと区別できる濃いプラム色 |
| Codex 5h | `#10A37F` | ChatGPT/OpenAI の緑 |
| Codex Weekly | `#0B7A5E` | 同系の濃色 |
| 欠測 | `rgba(120,120,128,0.18)` 帯 + `#8E8E93` 上端バー | |
| 目盛り線 | `#E5E7EB`（50% は `#CBD5E1`）、軸ラベル `#4B5563` | |
| 背景 | パネル `#FFFFFF`、ページ `#F5F6F8` | ライトテーマ固定（v1） |

## 8. トレイ

- アイコン: `assets/icon.ico`（16/32）。ツールチップ: `quota-trail\nClaude 5h 40% / W 36%\nCodex 5h 52% / W 59%\n最終取得 03:24`（error 時はその系列を `--` と短い理由）。トレイは現行の各プロバイダー 2 値表示を維持し、Fable は追加しない
- 右クリックメニュー:
  1. `ダッシュボードを開く`（左クリックでも同じ）
  2. `今すぐ取得`
  3. 区切り
  4. `Windows 起動時に実行する`（checkbox。`autostart.mjs` を呼び、`app.getLoginItemSettings().openAtLogin` を毎回読んで checked に反映）
  5. 区切り
  6. `終了`
- ウィンドウは持たない（`window-all-closed` で終了しない）。`app.requestSingleInstanceLock()` で二重起動を防ぎ、2 つ目は 1 つ目にダッシュボードを開かせて終了
- 自動起動: `app.setLoginItemSettings({ openAtLogin, path: process.execPath, args })`。開発時（未パッケージ）は `args: [app.getAppPath()]`、パッケージ時は `args: []`。Windows は HKCU `Run` に書かれる
  - パッケージ済み exe（`dist\win-unpacked\quota-trail.exe`）から登録した場合、`process.execPath` がその exe になるため **`quota-trail` という名前で登録される**（開発起動だと `electron` 名になり、他プロジェクトの `Stop-Process electron` に巻き込まれる）。運用ではパッケージ済み exe から登録すること
  - 現在の状態は `GET /api/meta` の `autostart` でも読める（読み取り専用。`index.mjs` が `getAutostart: () => autostart.isEnabled()` を `startServer` に渡す）

## 9. 設定（`userData/config.json`）

```json
{ "pollIntervalSec": 180, "port": 47811, "retentionDays": null }
```

- 無ければ既定で生成。壊れていれば既定値でログを出して続行。UI からの編集は v1 では無し（ファイル直接編集。次回 tick から反映）

## 10. ログ

- `userData/logs/quota-trail.log` に 1 行 JSON（時刻・レベル・メッセージ）。1 MB でローテーション（1 世代）。トークンやヘッダは絶対に出さない
- 異常終了の追跡用に app のライフサイクルイベント（`before-quit` / `will-quit` / `quit`（`exitCode` 付き）/ `powerMonitor` の `suspend` `resume` `lock-screen` `unlock-screen` `shutdown` `on-ac` `on-battery`（Linux では登録省略）/ `process` の `exit` `SIGINT` `SIGTERM` `SIGHUP`）を毎回ログする。`will-quit` には終了理由 `quitReason`（`tray-menu` / `second-instance` / `signal:<name>` / `power-shutdown` / `unknown`）を添える
- `userData/last-alive.json` を 60 秒ごとに `{ at, pid, uptimeSec }` で上書き（tmp に書いてから rename）。起動時にこのファイルの `at` が 3 分より古ければ、前回インスタンスが正常終了しなかったとみなして `前回のインスタンスは正常終了せずに消えた`（warn）をログする

## 11. テスト（`node:test`）

- `normalize.test.mjs`: Claude 応答（Fable を含む）/ Codex HTTP 応答 / Codex app-server 応答の正規化。`secondary_window` 無し、clamp、ISO と epoch 秒の変換
- `gaps.test.mjs`: 閾値超の間隔、error 連続、先頭・末尾、`intervalSec` が途中で変わるケース
- `resets.test.mjs`: 未使用ウィンドウの `resetsAt` スライド（誤検出しない）、秒未満のゆらぎ、実際のリセット（`resetsAt` 固定＋使用率低下）、予告時刻未経過だが使用率低下、ウィンドウ開始直後の使用率上昇（誤検出しない）
- `ticks.test.mjs`: 幅 300px で 24h → 6h ステップ、幅 1800px で 24h → 1h（>= 50px を満たす最小）、30d → 2d 等。目盛りのアライメント
- `ports.test.mjs`: 使用中ポートを避けること
- `db.test.mjs`: 一時ファイルで insert → query の往復、範囲外前後 1 点の包含、5 系列とアカウント分離

## 12. 受け入れ条件（v1）

1. `npm install && npm start` で Windows のトレイにアイコンが出る（ウィンドウは出ない）
2. 起動直後と 3 分ごとに `samples` に 5 行（または error 行）が増える。`config.json` の `pollIntervalSec` を変えると次回から間隔が変わる
3. 「ダッシュボードを開く」で既定ブラウザに `http://127.0.0.1:<port>/` が開き、5 つのグラフ、Y 目盛り 10% 刻み、X 目盛りが >= 50px 間隔、凡例、データ点、欠測の灰色帯が表示される。幅 320px と 1920px でレイアウトが崩れない
4. select で期間（連動）・形式・点表示を切り替えられ、ホイールでズームすると期間が「カスタム」になり 5 グラフが連動する
5. 「Windows 起動時に実行する」をチェックすると `HKCU\Software\Microsoft\Windows\CurrentVersion\Run` に登録され、外すと消える
6. `node --test` が通る
7. 認証切れ・ネットワーク断でもアプリは落ちず、error 行が記録され、グラフに灰色として出る

## 13. 仮説の判断

- H-001（Codex rollout の `rate_limits` を副次データ源にする）: **却下（v1）**。能動ポーリングで 3 分粒度が得られるため不要。Codex 使用直後の高頻度な値が欲しくなったら v2 で再検討
- H-002（idle / ロック中もポーリングを止めない）: **採用**。Agents Pulse の「操作なし 300 秒で停止・ロック中停止」は、CLI を回したまま離席する使い方で履歴に穴を空ける。quota-trail は API を呼ぶだけで枠を消費しないので常時取得する

## 14. Claude Fable 週次リミット（2026-09-27 追加）

### 14.1 系列と取得規則

`claude/weekly-fable` を Claude 専用の 3 番目の系列とする。`Sample.window` に `weekly-fable` を加え、通常の tick は Claude 3 行、Codex 2 行を同じ `observedAt` で記録する。既存の `five_hour → claude/5h` と `seven_day → claude/weekly` は維持する。

`limits` が配列なら、`kind === 'weekly_scoped'`、`group === 'weekly'`、`scope.surface == null`、`scope.model.display_name` の前後空白を除いた小文字が `fable` と完全一致する行だけを候補とする。`scope.model.id`、`severity`、配列順序は選択に使わない。候補 1 行なら `is_active:false` でも採用する。複数なら `is_active === true` がちょうど 1 行のときのみ採用し、他は `parse` error とする。

採用行の `percent` は `clampPercent`、`resets_at` は `isoToMs` で変換する。数値化できない `percent` は `parse` error、無効な `resets_at` は `resetsAt:null` の `ok` とする。`limits` が無い、null、空配列、候補無しなら Fable の `window_absent` error を 1 行記録し、非配列なら Fable の `parse` error を記録する。読めている既存 2 行は `ok` のまま。応答全体が不正なら Claude 3 行とも `parse` とする。

`errorSamples` と `allSeriesKeys` はプロバイダー別窓一覧から生成する。Claude は `5h`, `weekly`, `weekly-fable`、Codex は `5h`, `weekly` の順。認証、通信、タイムアウトの失敗時も Claude は 3 error 行、Codex は 2 error 行を作る。対象モデルは Fable 固定とし、未知のモデルから系列を自動生成しない。

### 14.2 永続化と API

`samples.win` は `TEXT NOT NULL` で値制約がない。既存の `(provider, win, observed_at)` と v2 の `(provider, account_id, win, observed_at, id)` のインデックスを使う。スキーマ、`schema_version`、既存行は変更しない。DB の `SERIES` に `['claude','weekly-fable']` を Claude weekly の直後へ追加し、`queryAllSeries()` と `latest()` は 5 キーを返す。

Fable 行は同じ Claude 取得結果と identity で `recordPoll()` に渡し、既存の `account_id` を付ける。v2 の旧行 backfill は移行時点で固定した sample ID 上限までなので、新行を旧アカウントへ遡及帰属しない。実装前の Fable 履歴も生成しない。`/api/samples` と `/api/latest` に Fable キーを加える。`/api/meta.windows` に `weekly-fable` を加えるが、Claude 専用である。アカウント選択キーは従来どおりプロバイダー単位の `claude` とする。

### 14.3 ダッシュボード

Claude Code グループは 5h、Weekly、Weekly Fable の順。既存の 2 列グリッドでは Fable は 2 行目の左側。Codex の 2 パネルはそのままとする。Fable の色は `#8E3B63`、タイトルは `Claude Code · Weekly Fable limit`、凡例は `Claude Code Weekly Fable limit 使用率`、上部の現在値名は `Claude Fable W`。

`SERIES_KEYS` に新キーを Claude weekly の直後に追加し、既存の期間変更、ズーム、形式、点表示、パネル設定、Claude アカウント切替と再取得に参加させる。旧 `localStorage` に新キーが無ければ折れ線・点ありで開始し、既存 4 パネルの設定を保持する。Fable の最新行が error のときは現在値を `--` とし、過去の `ok` 行からリセット予定時刻を復活表示しない。この判定は Fable に限る。`chart.mjs` の描画 API と凡例、トレイ表示は変更しない。

### 14.4 欠測・リセット・時間軸

Fable の `window_absent` を含む error 行は `computeGaps()` による灰色の欠測区間となる。記録開始前から最初の点までも既存規則で欠測とし、消えて再出現した間を線で結ばない。Fable の `resets_at` は独立した週次枠の予定時刻として使う。過去のリセットは `pastResets()`、予定マーカーは既存のチャート描画で扱う。`pastResets()` は error を除く `ok` 点を比較するため、欠測をまたいで予告時刻が経過した場合も検出し得るが、欠測帯は残す。`ticks.mjs` は変更しない。

### 14.5 変更ファイルと検証

対象は `src/main/lib/normalize.mjs`、`src/main/providers/claude.mjs`、`src/main/db.mjs`、`src/main/server.mjs`、`src/renderer/theme.mjs`、`src/renderer/app.mjs`、および `tests/normalize.test.mjs`、`tests/db.test.mjs`、`tests/server.test.mjs`、`tests/providers-accounts.test.mjs`、`tests/gaps.test.mjs`、`tests/resets.test.mjs`。実観測形式の `seven_day=56` と Fable `percent=80` を別系列に同時保存すること、順序違い、Opus 混在、欠落、重複、不正値、Claude 3 行と Codex 2 行の error、アカウント分離、API の 5 キー、欠測とリセットを検証する。`node --test` に加え、幅 320px と 1920px、Claude アカウント切替、Fable 行が消えた回の欠測表示を画面で確認する。

### 14.6 既存節との整合

§1、§4.1、§4.2、§4.5、§5、§6、§7.1–7.2、§7.5、§8、§11–12 の系列数、行数、パネル数、現在値数は 5 に更新した。既定 3 分間隔では 1 日 2,400 行、1 年約 87.6 万行。トレイの文例は現行 2 値表示を維持する。

### 14.7 設計仮説の判断

- **H-001: 対象外。** Codex rollout の副次データ源であり、Claude OAuth usage の Fable 行には適用しない。従来の却下判断は維持する。
- **H-002: 採用。** Fable を含む Claude 3 系列も idle・ロック中に同じ tick で記録する。停止すると Fable と all models の増加差の履歴に穴が空く。
