# quota-trail 設計書（v1）

- 作成: 2026-09-07（設計者: Claude Fable 5.1。発注者指示により Codex CLI の 5h limit 枯渇中のため Fable が設計）
- 関連仮説: `docs/hypotheses/H-001-passive-codex-rollout-source.md`（却下・v2 候補）、`docs/hypotheses/H-002-no-idle-pause.md`（採用）、`docs/hypotheses/H-003-probe-after-local-expiry.md`（§15.12 で部分採用）

## 1. 目的と非目的

Claude Code と Codex CLI の **5h limit / Weekly limit、および Claude Fable 専用 Weekly limit の使用率（%）を 3 分ごとに記録**し、履歴を **読めるグラフ**（凡例・軸ラベル・データ点・欠測の明示）で見せる Windows 常駐アプリ。Agents Pulse の不満点（色に意味がない、凡例がない、軸ラベル崩壊、データ点不明）を解消する。

非目的（v1）:
- 消費レート（pp/h）や ETA の推定、通知、CSV 出力（Claude 認証の案内通知に限り §15 で改訂）
- Claude / Codex 以外のプロバイダー
- OAuth トークンの自発的な refresh（§4.3。Claude CLI への更新委譲の条件は §15 で改訂）
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
- 401 → `auth_expired`。期限切れでも送信する旧方針は **§15 で改訂**し、Claude の usage/profile 双方にローカル期限判定を適用する。**2026-10-11 改訂**: 明示設定時の usage 1 回だけの例外を §15.12 に追加する。profile と `cached_401` に例外は設けない。

### 4.3 トークン refresh 方針（重要）

**Claude の期限判定・更新待ち・通知・条件付き CLI 委譲は §15 を正とする。** 以下は旧方針の背景であり、Codex の方針は維持する。

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

Claude のローカル認証判定と CLI 更新処理の分離を §15 で追加する。既存の tick、single-flight、実際の usage HTTP 429 による次回 2 倍、Codex 取得経路は維持する。

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
- **凡例**: パネル下部。項目: `● Claude Code 5h limit 使用率`、`▬ 欠測`、`┆ リセット`、`▰ リセット予定`（Claude パネルだけ、さらに `▯ 利用ポリシー改定（時刻不明の範囲）`。下記の小節）
- **ホバー**: 最も近い点に小さなツールチップ（`9/7 03:24  42.0%  リセット 9/7 08:37`）。利用ポリシー改定の四角形の上では、その説明を区切り線の下に追記する（近くに点が無ければ説明だけ）
- 描画は `requestAnimationFrame` でまとめ、`ResizeObserver` でリサイズに追従

#### 利用ポリシー改定の範囲（2026-10-21 追加）

Claude パネル（`claude/5h`・`claude/weekly`・`claude/weekly-fable`）にだけ、Anthropic の利用ポリシー改定（Anthropic 2026 Usage Policy update）の「発表」と「発効」を描く。Codex パネルには出さない。データは `src/shared/policy-events.mjs` の定数 `POLICY_EVENTS`（`{ id, kind:'announce'|'effective', label, start, end, sourceNote, sources, … }`、時刻は ISO UTC）で、根拠をコードのコメントにも残す。

**なぜ範囲にしたか**: 公式の表記はどちらも日付だけで、時刻・タイムゾーンの記載がない。1 本の線で描くと根拠のない精度を装うことになるため、「その日付をどのタイムゾーンで読んでも矛盾しない範囲」を半透明の四角形で描く。

| | 範囲（UTC） | 日本時間 | 始まりの意味 | 終わりの意味 |
|---|---|---|---|---|
| 発表 | `2026-10-08T00:00Z` 〜 `2026-10-08T21:53Z` | 10/8 09:00 〜 10/9 06:53 | 公式の「Oct 8, 2026」を UTC と読んだ場合の最早 | 報道による上限。MacRumors が 2026-10-08 2:53 pm PDT（= 21:53Z）に報道済み |
| 発効 | `2026-11-12T00:00Z` 〜 `2026-11-13T08:00Z` | 11/12 09:00 〜 11/13 17:00 | 「November 12」を UTC と読んだ場合の最早 | 米国太平洋時間と読んだ場合の 11/12 の終わり（11/12 は夏時間終了後なので PST = UTC−8） |

- 一次情報: 公式告知 <https://www.anthropic.com/news/2026-usage-policy-update>（表記は「Oct 8, 2026」、本文に "The updated policy takes effect on November 12."）、利用ポリシー本体 <https://www.anthropic.com/legal/aup>（「Effective Nov 12, 2026」）。報道: MacRumors <https://www.macrumors.com/2026/10/08/anthropic-user-guideline-update/>
- **CMS の値を採らなかった理由**: 告知 HTML の `datePublished` は `2026-10-08T00:00:00.000Z` で、日付だけを入力したときの既定値と判断し時刻の根拠にしない。AUP の HTML の機械可読値 `effectiveDate` は `2026-11-12T20:41:00Z`（日本時間 11/13 05:41）だが、過去版の値が `2025-09-15T16:00Z` / `2024-06-06T07:00Z` / `2023-09-15T07:00Z` とばらばらで、告知された時刻ではなく CMS の入力値と判断した。上の発効範囲に収まることだけを記す（テストで確認）
- **確認日**: 2026-10-21 に公式ページで確認。利用規約変更の通知メールは発注者の Gmail で見つからなかった。値を変えるときは `POLICY_EVENTS` とこの表、`tests/policy-events.test.mjs` を合わせて直す
- **描画**: プロットの上から下までの半透明の四角形と、両端の細い縦線（発表は薄い塗り + 破線、発効は濃い塗り + 実線）。系列より先に描く（背面）。範囲が 3px 未満になる表示範囲（例: 1 年表示の発表）では中心を保って 3px に広げる。四角形の見えている左端に、白地・青紫字の小さなラベル「規約発表」「規約発効」を置く
- **ラベルの衝突回避**: `drawNextReset` の流儀に合わせ、リセット予定タグ・「現在」ラベル・他の規約ラベルを描いた後に、プロット上端の 1 段目・2 段目（欠測・認証更新待ちの上端バーは隠さない）から、それらと重ならず、データ点との衝突数（`tagCollisions`）が少ない段を選ぶ（同数なら 1 段目）
- **表示範囲の外**: 24h/7d/30d は `to = now`（§7.2）なので、2026-10-21 時点の発効は常に範囲より右にある。範囲より右（未来側）にあるイベントは最も近い 1 件だけ、プロット右端に 3px の青紫の印と `規約発効まで 22 日 →` を出す（ローカル暦日差。同じ日のうちなら `規約発効まで 3h12m →`、過去を見ていて既に始まっているなら `規約発効 →`）。左に外れた過去のイベントは何も出さない（30d を超えて過去になった発表を毎回示すのはうるさいため）
- **吹き出し**: 四角形の上（プロット内）にカーソルがあると、次の行を追記する。日本時間は `Intl.DateTimeFormat` の `timeZone:'Asia/Tokyo'` で明示的に整形し（OS のタイムゾーンに依存させない）`JST` を付ける
  - `利用ポリシー改定 発効（Anthropic 2026 Usage Policy update）`
  - `日本時間の範囲: 11/12 09:00 〜 11/13 17:00 JST`
  - `公式表記: Nov 12, 2026（時刻・タイムゾーンの記載なし）`
  - `UTC と読んだ場合: 11/12 09:00 〜 11/13 09:00 JST`
  - `米国太平洋時間（PST）と読んだ場合: 11/12 17:00 〜 11/13 17:00 JST`
  - 発表だけ `報道による上限: 10/8 2:53 pm PDT（10/9 06:53 JST）`
- **純粋関数とテスト**: x 座標の切り出しと最小幅（`policyEventSpanX`）、ヒットテスト（`policyEventAt`）、範囲より右の判定（`nextPolicyEventAfter`）と「あと N 日」（`policyAheadLabel`）、JST 整形（`formatJst` / `formatJstRange`）、吹き出しの行（`policyEventTooltipLines`）を `shared/policy-events.mjs` に置き、`tests/policy-events.test.mjs` でデータ定数の妥当性（start < end、日本時間の端、各端の根拠との一致）と合わせて確認する

### 7.5 色（`theme.mjs`）

| 系列 | 色 | 根拠 |
|---|---|---|
| Claude Code 5h | `#D97757` | Anthropic/Claude ブランドのテラコッタ |
| Claude Code Weekly | `#B4532F` | 同系の濃色（区別と「薄くしない」ため） |
| Claude Code Weekly Fable | `#8E3B63` | テラコッタと区別できる濃いプラム色 |
| Codex 5h | `#10A37F` | ChatGPT/OpenAI の緑 |
| Codex Weekly | `#0B7A5E` | 同系の濃色 |
| 欠測 | `rgba(120,120,128,0.18)` 帯 + `#8E8E93` 上端バー | |
| 利用ポリシー改定 | `#5B5FE0` の線・文字、塗りは発表 `rgba(91,95,224,0.08)` / 発効 `rgba(91,95,224,0.16)` | 系列のテラコッタ・プラム・緑とも欠測の灰色とも色相が離れる青紫で、線（系列）と面（範囲）を取り違えないため |
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

Claude 認証状態の遷移ログ・継続ログは §15 で追加する。**2026-10-11 改訂**: 期限超過後の確認送信の専用イベントと実測の読み方は §15.12 を正とする。

- `userData/logs/quota-trail.log` に 1 行 JSON（時刻・レベル・メッセージ）。1 MB でローテーション（1 世代）。トークンやヘッダは絶対に出さない
- 異常終了の追跡用に app のライフサイクルイベント（`before-quit` / `will-quit` / `quit`（`exitCode` 付き）/ `powerMonitor` の `suspend` `resume` `lock-screen` `unlock-screen` `shutdown` `on-ac` `on-battery`（Linux では登録省略）/ `process` の `exit` `SIGINT` `SIGTERM` `SIGHUP`）を毎回ログする。`will-quit` には終了理由 `quitReason`（`tray-menu` / `second-instance` / `signal:<name>` / `power-shutdown` / `unknown`）を添える
- `userData/last-alive.json` を 60 秒ごとに `{ at, pid, uptimeSec }` で上書き（tmp に書いてから rename）。起動時にこのファイルの `at` が 3 分より古ければ、前回インスタンスが正常終了しなかったとみなして `前回のインスタンスは正常終了せずに消えた`（warn）をログする

## 11. テスト（`node:test`）

- `normalize.test.mjs`: Claude 応答（Fable を含む）/ Codex HTTP 応答 / Codex app-server 応答の正規化。`secondary_window` 無し、clamp、ISO と epoch 秒の変換
- `gaps.test.mjs`: 閾値超の間隔、error 連続、先頭・末尾、`intervalSec` が途中で変わるケース
- `resets.test.mjs`: 未使用ウィンドウの `resetsAt` スライド（誤検出しない）、秒未満のゆらぎ、実際のリセット（`resetsAt` 固定＋使用率低下）、予告時刻未経過だが使用率低下、ウィンドウ開始直後の使用率上昇（誤検出しない）
- `policy-events.test.mjs`: 利用ポリシー改定の定数（start < end、日本時間の端）、x 座標の切り出しと 3px の最小幅、ヒットテスト、範囲より右の判定と「あと N 日」、OS の TZ に依存しない JST 整形、吹き出しの行（§7.4）
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

## 15. Claude トークン期限切れ対策（2026-10-02 追加）

### 15.1 結論と到達範囲

**既定では資格情報を読み取るだけにし、期限切れの usage/profile 要求を止め、期限前と期限切れ時の案内で回復を促す。無人時間帯の自動回復は、安全性を確認した Claude Code CLI に更新を委譲できる場合だけ採用する。quota-trail 自身による refresh POST と `.credentials.json` への書き込みは採用しない。**

**2026-10-11 改訂**: 段階 A に、明示設定で期限超過後の usage を token ごとに最大 1 回確認する実測経路を追加する（§15.12、既定 OFF）。ローカル期限とサーバーでの受付を区別するための部分採用であり、200 でも期限を延長せず通常取得へ戻さない。profile の期限 gate、refresh token の読取禁止、無人回復を段階 B の到達条件とする判断は維持する。

実装を二段階に分ける。

1. **段階 A（採用・既定有効）**: ローカル期限判定、401 後の同一トークンの送信抑止、資格情報の定期再読込、期限前の案内、認証理由の表示とログ。期限切れトークンの反復要求をなくし、発注者が気付いて更新するまでの時間を短くする。
2. **段階 B（検証条件付き採用・既定 OFF）**: 更新と保存を完了することを検証した CLI コマンドで自動回復する。最初の候補は `claude auth status --json` だが、2026-10-02 時点で承認済み CLI は **0 件**。2.1.284 も未承認であり、設定を ON にしただけでは実行しない。

段階 A だけで「8 時間以上 Claude Code を使わなくても欠測しない」とは言えない。発注者が不在なら更新待ちは継続する。**無人の十数時間欠測の解消は段階 B のリリース条件とし、通知や 429 の減少だけを目的達成と数えない。** 安全な CLI 経路を実証できなかった場合は段階 A を提供し、無人回復は未達と報告する。ログイン保護の制約を緩めて危険な refresh に切り替えない。

本節は §1 の認証通知に関する非目的、§4.2–4.3、§10、および `design-accounts.md` §3.1 の期限切れ中の profile 再試行を改訂する。account 帰属・DB・実 ID 非公開の原則は維持する。§4.4 の Codex HTTP/app-server、Codex の正規化、idle/lock 中の tick は変更しない。

### 15.2 原因分析と確認の限界

発注者が DB と運用ログから確認した事実を設計入力とする。この設計作業では本番 DB、資格情報、ログを再取得せず、実トークンを使う CLI 実験も行っていない。

| 観測 | 設計上の判断 |
|---|---|
| ローカル `claudeAiOauth.expiresAt` まで約 8 時間。新 token の検知から期限までの追加実測は §15.12 を参照 | quota-trail の 3 分ごとの取得だけで認証寿命が延びる根拠はない |
| 9/30 09:01 JST–10/1 01:14 JST（16 時間 13 分）、10/1 09:16–10/2 00:57（15 時間 41 分）欠測。9/29 にも同様の期間 | 期限到来後の更新待ちと整合するが、利用・更新経路やサーバー側挙動の変化はこの記録だけでは確定しない |
| Claude Code 起動による資格情報更新直後に Claude 3 系列が回復。Codex は正常 | 全アプリの停止より Claude 認証経路の問題と整合する |
| 数回の 401 後に「429 約 1 時間、6 分おきに約 10 回 → 401 1 回」の反復 | 期限切れトークンへのレート制限という推測と整合するが、サーバー側の原因は未確証。429 を認証切れへ読み替えない |

**2026-10-11 改訂**: 以下の再送・表示の分析は段階 A 導入前（git HEAD）のコードを対象とする。未コミットの段階 A は §15.11、追加実測と未確証事項は §15.12 を参照。

旧 `providers/claude.mjs` の `readAccessToken()` は access token と organization だけを返し、`expiresAt` を捨てている。`fetchClaudeSamples()` はその token で usage と必要時の profile を並行要求する。HTTP 401 は `httpErrorCode()` により `auth_expired` になるが、次の tick でも再送する。profile も失敗後の 5 分 TTL で再要求するため、usage だけを抑止しても不十分である。

`scheduler.mjs` の 429 はアプリ共通の次回間隔を 2 倍にする。一度の指数バックオフではなく、毎回 429 なら毎回 6 分待つ。トークン失効を修復する処理はない。旧 `gaps.mjs` は error と行の不在を同じ灰色帯にまとめ、旧 renderer の `renderHeader()` は理由を出さず `--` にする。

当初は「ログに `auth_expired` が残っていない」と報告されたが、2026-10-11 の発注者の集計では 9/24・9/30・10/1 の tick に記録が確認された（§15.12）。ログレベルだけを原因としない。配布 exe のソース版、収集範囲、1 MB ローテーションを確認し、認証状態の遷移を専用 warn/info イベントとして残す。

### 15.3 選択肢の採否と根拠

| 案 | 採否 | リスク・理由・必要な検証 |
|---|---|---|
| (a) quota-trail が共有 refresh token を交換し書き戻す | **却下**。ON 設定も設けない | 原子的 rename はファイルの途中読込を防ぐだけで、サーバー上の rotate と保存を一体化しない。独自ロックは Claude Code が同じ契約を守らなければ効かない。失敗後の旧ファイル復元も、消費済み refresh token を復活させない |
| (b) `claude auth status --json` に更新を任せる | **検証条件付き採用、現状は不実行** | CLI が認証を所有する点は有利だが、「公式コマンドだから安全」とは言えない。終了前の refresh 保存、既存 Claude Code との競合、timeout/終了時を §15.9 で実証する |
| `claude update` の副作用として更新を誘発 | **却下** | 自己更新と認証回復が結合する。バイナリ・挙動変更、通信、既存利用環境への副作用が大きい |
| `claude -p`、`--init-only`、常駐対話 CLI 等で更新を誘発 | **却下（本変更）** | モデル消費、セッション作成、hooks/MCP/プロジェクト処理、強制終了時の rotate 問題を避けられる根拠がない。無害なプロンプトを送っても認証専用操作にはならない |
| `claude auth login` の自動実行（refresh token を環境に渡す方式を含む） | **却下** | login/アカウント選択・認証環境の上書きは通常の更新待ち対策として大きすぎる。手動の再ログインは、通常起動しても回復しない場合の案内に限る |
| (c) `claude setup-token` の長寿命 token を quota-trail 専用に保持 | **却下（本変更）** | 公式説明ではモデル要求用の長寿命 token であり、usage/profile に必要な権限と互換性は保証されていない。共有ファイルとの競合は避けられても、別 secret の保存と account 同定が増える。実トークンを発行して試すことを初期実装の必須手順にしない |
| quota-trail 用の別 OAuth grant / 別 config dir | **将来候補、現状は不採用** | 同一 grant の token をコピーするだけなら rotate 競合は残る。独立 grant の発行・失効関係と usage/profile 権限を公式仕様等で確認できるまで「隔離したから安全」としない |
| 期限前・期限切れ通知と外部更新の検知 | **採用** | 認証ファイルを書かず、非対話の案内だけを行う。発注者の不在中に自動回復できる保証はない |

2026-10-02 に確認した一次資料を判断の根拠として保存する。Web の現行説明がインストール済み 2.1.284 の契約と同一とは限らない。

- [公式 CLI reference](https://code.claude.com/docs/en/cli-reference): `auth status` は認証状態表示として説明されている。期限切れ時に refresh の永続化まで待つという保証は記載されていない。
- [公式リポジトリの issue #95822](https://github.com/anthropics/claude-code/issues/95822): 投稿者は macOS の 2.1.259 で問題を観測し、2.1.277 について短命コマンドが refresh 完了前に終了する経路を報告している。これは Windows 2.1.284 の確証ではなく、**安全性検証が必要という根拠**として扱う。終了コード 0 や `loggedIn:true` だけでは保存成功を証明できない。
- [公式 authentication 文書](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token): `setup-token` の出力は保存されず、モデル要求用と説明されている。長寿命だけを理由に usage 取得へ採用しない。

共有ファイルに書く案を将来再検討するなら、少なくとも以下を別設計で証明する必要がある。これは本変更で実装する仕様ではない。

1. 正確な CLI 版で、認証ファイルの書式・未知フィールド保持・ACL・ロックの場所/方式/待ち時間/stale 判定と、**全 writer がそのロックを共有すること**を確認する。issue 中のロック名をそのまま正しい契約として使わない。
2. ロック取得後に資格情報を再読し、同じ account/token 世代であることを検証してから交換する。CLI がメモリに古い token を保持した状態も検証する。
3. 新旧 token の compare-and-swap、同じディレクトリの一意な一時ファイル、flush、原子的置換、Windows の共有違反・権限・ディスク不足への対処を検証する。`expiresAt` は成功応答の寿命から計算し、未知フィールドと書式を保つ。
4. rotate 後の保存失敗、CAS 不一致、応答喪失、プロセス停止のときに、旧 token の再送や旧ファイル復元でログインを破壊しない回復契約を示す。ファイルロックだけで解決できないこの点が現在の不採用理由である。

### 15.4 ローカル認証判定と要求の抑止

#### 資格情報スナップショット

`readCredentialSnapshot()` を追加し、1 回の JSON 読込から `{token, expiresAt, organizationUuid, configDir, errorCode}` を得る。`refreshToken` は返さず、保持・コピー・ログ出力しない。`expiresAt` は **有限の正の数値・epoch ms** のみ有効とする。文字列、null、欠落、秒らしい値を暗黙変換しない。有効な epoch ms の下限は `2000-01-01T00:00:00Z` とし、それ未満は不正メタデータとする。これは token 寿命を 8 時間と固定する規則ではない。

access token の SHA-256 と解決済み config dir を内部キーにする。ディレクトリも fingerprint もメモリ内限定で、DB/ログ/公開 API へ渡さない。profile cache のキーにも config dir を含め、既存の最大 8 件・24 時間 idle 除去を維持する。401 抑止の解除には **access token 自体の変更**が必要であり、mtime や `expiresAt` だけの変更を新 token とみなさない。

既存 `readAccessToken()` は互換ラッパとして token/organization/error を返せるようにし、取得処理と認証監視は新 reader を使う。ファイル不存在・読み取り失敗は従来の `no_credentials`、JSON 破損は `parse`。外部の原子的置換中などの一時不在でも quota-trail が旧 token を復元・書き戻すことはない。

#### 判定順序

判定時刻は HTTP 開始直前の `Date.now()` を使う。tick 開始の `observedAt` は保存用であり、遅い profile 処理や CLI 処理で期限判定を古くしない。

| 条件 | usage/profile | Claude 3 行の error code / 状態 |
|---|---|---|
| token なし / JSON 破損 | 要求しない | 従来の `no_credentials` / `parse` |
| 同一 token がこのプロセス中に usage 401 を受けた | 両方要求しない | 従来の `auth_expired`。内部理由は `cached_401` |
| 有効な `expiresAt <= now` | 原則両方要求しない。明示設定・適格条件を満たす usage 1 回だけ §15.12 の例外 | 原則 **`auth_expired_local`**、`expired`。確認送信した tick は実際の正規化結果 |
| `now < expiresAt <= now + 30 秒` | 両方要求しない | **`auth_expiring`**、`expiring`。通信途中での失効を避ける安全余裕 |
| 有効期限が残る、または expiresAt 不明 | 通常取得。ただし既存の 15 秒 timeout を維持 | 正規化結果。期限不明は成功を妨げず、メタデータ不明の状態とログを別に持つ |

`auth_expired_local` は実際のローカル期限切れ、`auth_expiring` は 30 秒以内の期限到来を意味する。HTTP 401 は既存の `auth_expired` のままとし、期限切れ以外の失効・認証拒否も含むため表示は「認証エラー／更新待ち」とする。`http_429`、`network`、`timeout`、`parse`、`window_absent` の意味は変えない。

- usage 401 を受けたら同一 token を抑止する。起動時の identity probe、手動「今すぐ取得」、resume/unlock を含む全経路に同じ gate を適用する。profile が既に並行要求中なら結果を待つ/中断するが、追加再試行はしない。profile 単独の 401/403 は usage 成功を無効にせず、従来どおり identity の問題として扱う。
- 有効な期限切れ token は起動直後も要求ゼロ。expiresAt が不明な失効 token は最初の usage 401 まで要求し得るが、その後は送らない。401 抑止は secret を永続化しないため再起動をまたがない。期限不明の場合に再起動ごと最大一度の usage 401 が生じ得る限界を明示する。
- ローカル判定中も通常 tick ごとに `errorSamples('claude', ...)` で 3 行を記録する。`usedPercent` と `resetsAt` は null。過去の ok 値で埋めない。
- ローカル判定には、**同じ token に既に結び付いた** profile cache（有効な保持期間内の stale 権威 cache も可）を使って identity を返す。新 token、再起動後など結び付きがない場合は `identity:null` にする。この分岐では `.claude.json` の現 account を期限切れ token に推測帰属しない。organization 一致だけでも account 一致の証明にはならない。
- 有効 token の通常取得では既存の profile/local fallback 規則を維持する。新 token の usage/profile は新スナップショットだけを使う。
- 一度 expired/rejected と判定した同じ token は時計の後退で通常送信を再開しない。時刻補正・スリープ復帰では再読して判定し、新 token の出現で再開する。期限前の `expiring` は明白な時計補正があれば再評価できる。**2026-10-11 改訂**: expired latch は維持し、その外側に §15.12 の usage 専用予算を置く。monitor の判定だけでは予算を消費せず、`cached_401` は確認送信より常に優先する。

起動時の Claude identity probe は新しい `resolveInitialClaudeIdentity()` に置き換える。期限 gate を通して profile/cache だけを参照し、usage は取得しない。3 秒予算で待つことは維持する。予算終了後も未完了の profile Promise が残り得るため、通常 tick は同じ config dir/token の in-flight profile を共有し、二重要求しない。これにより初回 probe と最初の tick の usage 401 が重複する経路をなくす。Codex の起動 probe は従来どおり。

#### 間隔と資格情報更新の検知

通常の `pollIntervalSec`（既定 180 秒、最小 30 秒）を変えない。ローカル expiry/401 抑止/CLI エラーは 429 の 2 倍フラグを立てない。本物の usage `http_429` に対する既存の次回 2 倍規則は残す。

認証監視用に **30 秒ごと**のローカルファイル再読込を加える。ネットワーク要求も DB insert も行わない。idle/lock でも動き、`fs.watch` を必須にしない。失敗から復帰するため監視間隔を伸ばさない。新 token を検知したら旧 token の送信抑止を新 token に持ち越さず、次の通常 tick で取得する。既存の resume/unlock と手動取得は即時 tick を行う。

監視から共通 `runNow()` を呼んで Codex の追加取得を増やすことはしない。新 token の初回取得は **次の予定 tick まで**（通常 180 秒、直前が実際の 429 なら最大 360 秒、これに HTTP 処理時間）という上限とする。CLI が有効な場合は期限前に更新することでこの待ち時間を欠測にしない。休止・ネットワーク障害はこの上限の対象外。

**2026-10-03 改訂（発注者指示）**: blocked 中に新 token を検知したら即時 tick を 1 回行う。Codex usage 参照は枠を消費しないため追加取得 1 回は許容する。

### 15.5 条件付き CLI 自動回復

`claudeAuthRecovery: 'off' | 'verified-cli'` を設ける。既定 `off`。`verified-cli` の実効条件は設定、インストール済みバイナリ、検証済み capability、回復遮断状態の **すべて**が適合することとする。

capability はアプリに同梱する静的な allowlist とし、CLI の exact version、実行ファイル/必要な bundle の digest、固定 argv、更新開始閾値、検証記録のパスを含める。UA の既定値や `loggedIn` を allowlist 判定に使わない。CLI が自己更新され digest が変わった場合、未検証版として直ちに実効 OFF に戻る。現時点の allowlist は空。危険な CLI を発注者の設定だけで強制実行する escape hatch は設けない。

承認されたコマンドが `auth status --json` である場合の実行契約は以下とする。コマンドが更新しない版なら承認対象にしない。将来公式の認証更新専用コマンドが提供された場合も同じ検証を適用し、固定 argv を別 capability として追加する。

1. 30 秒監視で有効期限の **5 分前以内**（検証した CLI の更新開始条件）または既に期限切れ/401 抑止であることを検知し、起動直前に再読する。token/期限/config dir が変わって不要になっていれば実行を取りやめる。期限不明の token は HTTP 401 を契機とする。
2. 現在の config dir だけを対象とする。回復処理は全体で single-flight、同一 token/期限の世代につき一度だけ。トレイ操作や unlock の連打でも CLI を重複起動しない。
3. 固定の native exe を `spawn`、`shell:false`、`windowsHide:true` で起動する。プロジェクトのない専用 cwd、stdin 無効、stdout/stderr 各最大 64 KiB の廃棄可能なメモリバッファとする。トークンを argv/環境へ注入しない。`CLAUDE_CONFIG_DIR` は snapshot の dir を明示し、API key/OAuth token 等の認証上書き環境は子に渡さない。認証を変える proxy/設定も検証した条件以外では実行しない。
4. `.cmd` や shell alias しか解決できない場合は未対応として実効 OFF。既存 `lib/exec.mjs` の無制限 stdout・shell 起動・timeout kill を認証更新に流用しない。ユーザー操作を要求する CLI、hooks・モデル呼出し・更新処理を伴う CLI は capability を与えない。
5. 成功は終了コードではなく、CLI 自身が保存したファイルを読み直し、token が変わり、expiresAt が少なくとも **2 poll interval + 30 秒**先で、次の通常 usage/profile 取得で認証拒否がないことにより確定する。mtime だけの変更、`loggedIn:true`、期限だけの変更は更新成功としない。書き戻しはすべて CLI に任せる。
6. CLI の待機は poll の Promise に入れない。CLI 起動中も Codex と通常 tick を続け、Claude は有効なら取得、期限切れなら error 行を保存する。更新直後のファイルを次 tick が新 snapshot として扱う。
7. 60 秒で完了が確認できない場合は `uncertain` として回復を遮断する。**generic timeout kill、プロセス名での一括終了、古い refresh token の再送をしない。** 子の自然終了を監視し、遅れて保存された token は読み取り経路で利用できるが、自動 CLI 試行は再開しない。出力上限到達時も出力を捨てて遮断し、rotate 中か不明な子を強制終了しない。安全な終了が保証できない実行経路はそもそも承認しない。
8. nonzero、保存なし、JSON 不正、token/アカウント切替の競合、timeout、出力超過はすべて追加試行なしで通知経路へフォールバックする。保存検証を通った新 token の最初の usage が 401 の場合も回復を遮断し、CLI を再試行しない。新 token で自然回復しても失敗した CLI 経路の遮断は維持する。CLI の 429/失敗は usage の `http_429` と混ぜない。

再起動で不確定な rotate を反復しないよう、`userData/claude-auth-recovery-state.json` に `{blocked, reason, lastAttemptAt}` だけを原子的に保存する。token/fingerprint/account/config dir は保存しない。**spawn より前に** `blocked:true, reason:'in_progress'` を保存し、保存できなければ実行しない。正常終了と更新ファイル検証を通ったときだけ `blocked:false` にする。前回 in-progress のままなら起動時に `uncertain` とみなす。最後の試行から 15 分以内は世代が変わっても新規起動しない。

遮断解除は原因の検証後に発注者が設定を `off` に戻し、アプリ停止中にこの状態ファイルを削除してから `verified-cli` を設定する手順とする。再起動・ON/OFF の自動反復で遮断を解除しない。アプリ終了時も認証更新用子を kill せず、自然終了で保存を完了できる経路であることをリリース前に確認する。この契約を満たす CLI がなければ段階 B はリリースしない。

### 15.6 設定、表示、ログ

#### 設定

既存設定へ次の 4 項目を追加する（`claudeAuthRecovery` は段階 B）。**2026-10-11 改訂**: 段階 A の確認送信設定を追加した。HTTP/renderer から設定を変更する API は追加せず、既存どおり config.json 編集で反映する。

```json
{
  "claudeAuthRecovery": "off",
  "claudeAuthNotifications": true,
  "claudeAuthNoticeLeadSec": 600,
  "claudeExpiredUsageProbe": "off"
}
```

| 設定 | 健全化と意味 |
|---|---|
| `claudeAuthRecovery` | `off` または `verified-cli` のみ。不明値・欠落は `off`。実効 OFF の理由を UI/ログへ出す |
| `claudeAuthNotifications` | boolean のみ。欠落/不正値は true。false でもトレイ・dashboard・ログの理由表示は続ける |
| `claudeAuthNoticeLeadSec` | 有限数を整数化し 300–3600 秒に clamp。不正値は 600。案内の時刻だけを変え、30 秒の送信余裕や CLI の 5 分閾値は変えない |
| `claudeExpiredUsageProbe` | `off` / `once` のみ。欠落・不正値は `off`。`once` の適格条件・上限・終了規則は §15.12。段階 B や通常の取得間隔を有効化・変更する設定ではない |

設定変更時も polling の最小間隔・Codex の設定と動作は変えない。回復モードを OFF にしたら以後の spawn を止め、既に起動した CLI の rotate を中断しない。新版設定を旧版アプリで書き直すと追加項目が落ち得るが、失われた設定は安全側の OFF に戻る。

#### トレイと通知

- `buildTooltip()` の Claude 欄に `auth_expired_local` は「認証期限切れ」、`auth_expiring` は「期限間近・更新待ち」、従来 `auth_expired` は「認証エラー」を表示する。案内文は「Claude Code を通常起動して認証を更新してください。回復しない場合は再ログイン」に改め、必ず回復すると断言しない。
- 残り 10 分（設定値）以内で token 世代ごとに一度、期限切れ/401 時にも一度、Electron の通知で案内する。通知 click は dashboard を開く。CLI/login/browser を自動起動しない。回復 ON でも、検証済み経路が無効・失敗なら案内する。通知自体は成功サンプルを作らない。
- lock 中は OS 通知だけを保留して、unlock 時に最新 snapshot を再評価して一度案内する。idle を通知抑制や poll 停止に使わない。繰り返し unlock でも案内は 60 分に一度まで。OS が通知を抑制した場合も tooltip と dashboard で状態を確認できる。
- 重複抑止キーは config dir/token/期限の内部キー。メモリ内だけに置く。再起動時は一度案内し得る。通知に UUID、メール、認証ファイルのフルパスを含めない。

#### ダッシュボード

最小の変更として、現在の認証状態を示す Claude group の一行、現在値の理由、履歴の認証帯を追加する。

1. 読み取り専用 `GET /api/auth-status` を追加する。応答は `{claude:{state, accountKey, checkedAt, expiresAt, recoveryMode, recoveryEffective, recoveryReason}}`。state は `valid | expiring | expired | rejected | missing | invalid | unknown_expiry`、accountKey は匿名 key または null。実 token、fingerprint、実 ID、CLI 出力を返さない。既存 API と同じ localhost/no-CORS/no-store とする。
2. accountKey は認証 snapshot と現在 account の内部世代が一致する場合だけ返す。token 切替を監視したが account の同定前なら null。現在の認証一行は「現在の資格情報: 認証期限切れ／更新待ち」「自動更新は未検証のため無効」などと表示し、過去 account の状態と混同しない。null は「帰属未確認」を付ける。
3. 選択中 account の最新行が `auth_expired_local/auth_expiring/auth_expired` なら、3 系列とも現在値は `--` と理由。Claude 5h/weekly もこの場合は過去の ok 行からリセット予定を復活させない。Fable の既存 error 規則は維持する。古い error がある過去 account は「最終記録時: 認証…」とし、現在も期限切れだと断言しない。
4. `computeGaps()` の戻り値と灰色の欠測帯は維持し、追加の `computeAuthGaps()` が返す、根拠のある認証区間だけに琥珀色の上端バーを重ねる。凡例は「認証更新待ち」、hover は「ローカル期限切れ」「期限間近」「認証エラー」の理由と観測時刻を出す。`http_429` や行がない区間は灰色のまま。行がない理由を「アプリ停止」と断定せず「記録なし（停止・スリープ等）」とする。
5. 認証区間の開始は error 行の `observedAt`。終了は `min(次行の observedAt, 当該 intervalSec × 2.5 後, now, 表示終端)` とし、次行がない場合も同じ上限。区間は表示範囲に clip し、同じ理由で接する区間だけを merge する。観測前の時刻や、error 後にアプリが長時間停止した区間全部へ認証理由を延ばさない。旧 `auth_expired` は「認証エラー」であり、旧 429 を推測で期限切れに塗り替えない。
6. account filter 後、間引き前の生データからこの overlay を計算し、`/api/samples` へ任意の追加フィールド `authGaps`（Claude 3 キーの `{from,to,reason}` 配列）として渡す。`series` と既存 `decimated` は維持する。renderer はこのフィールドがなければ手元の samples から計算できるが、`decimated:true` かつ overlay 不在なら認証理由の帯を推測せず灰色だけを出す。

renderer は既存の 60 秒更新で auth-status も取得し、過去 account 選択中も現在資格情報の一行を更新する。samples/latest の選択世代チェックと即時 clear はそのまま使い、古い応答を新 account の header/overlay に表示しない。dashboard を閉じていてもメイン側の監視と通知は機能する。

#### error code とログ

DB の追加 error code は **`auth_expired_local` と `auth_expiring` の 2 個だけ**。CLI 自動回復の失敗は別の health 状態とログにし、usage の本来の原因を上書きしない。schema_version、テーブル、既存行、`status:'ok'|'error'`、Sample の構造は変えない。旧 renderer は新 code も通常の error/灰色欠測として扱える。

| イベント | レベル・抑制 | 安全な fields |
|---|---|---|
| `claude_auth_expiring` | info、期限前 threshold を初めて跨いだとき | `provider, accountKey?, checkedAt, expiresAt, source:'local'` |
| `claude_auth_blocked` | warn、期限切れまたは usage 401 への遷移時 | 上記 + `errorCode, source:'local'|'http_401'|'cached_401'` |
| `claude_auth_still_blocked` | warn、継続中は 60 分に一度 | 上記 + `blockedForSec`（このプロセス内の観測時間） |
| `claude_auth_metadata_unknown` | warn、その世代で一度 | `provider, reason:'missing_expiry'|'invalid_expiry'` |
| `claude_auth_credentials_changed` | info、token 変更検知時 | `provider, checkedAt`。identity 回復とは区別する |
| `claude_auth_recovered` | info、新 token の usage で認証が通ったとき | `provider, accountKey?, observedAt, blockedForSec`。Fable 枠なしは認証失敗としない |
| `claude_auth_recovery_start/result/disabled` | info、失敗/遮断は warn。設定・理由の変化時のみ | `provider, cliVersion, reason, durationMs?, recoveryEffective` |

`reason` は `unverified_cli / cli_missing / unsupported_launcher / cooldown / circuit_open / saved / no_update / nonzero_exit / malformed_output / timeout_uncertain / output_limit / credentials_changed` 等の固定コードだけ。profile 取得成功や mtime だけで recovered を出さない。3 error 行から同じ警告を 3 回出さず、provider の一遷移としてまとめる。既存 tick ログと 1 MB ローテーションは維持する。

`logger.mjs` の sanitize は防御として使うが、secret を含み得る JSON、CLI stdout/stderr、HTTP body、raw exception、headers、fingerprint を呼び出し側から渡さない。`sanitizeForLog()` に fingerprint と CLI raw-output 用の防御キーも追加する。ログに残してよい account は匿名 key のみ。

**2026-10-11 改訂**: probe の 200 は `claude_auth_recovered` の対象にしない。期限超過中の正常点・通知文・認証帯と専用ログの扱いを §15.12 に追加する。新しい error code や Sample 列は増やさない。

### 15.7 複数アカウントと変更ファイル・関数仕様

#### Claude アカウント1 / 2 の切替

取得対象は現在の credential file 一つだけ。renderer で過去 account を選んでも、その account をログイン・refresh しない。A → B → A では alias_no を変えず、token ごとの抑止/cache/通知を独立に扱う。別 token の identity を新 token に継承しない。同じ A の refresh 後も、新 token を profile で確認して A に帰属させる。

期限切れ token の同定ができる場合、Claude 3 行はその account に保存する。起動直後の期限切れなど同定不能なら unknown に 3 行を保存し、現在 account も unknown とする。unknown 行を後で A/B に移さず、v2 backfill の固定上限を変更しない。未アクティブな account の空白には認証帯を付けない。

CLI 実行中に account が切り替わる場合も、quota-trail は旧 snapshot の資格情報を送信/書き戻さない。終了後の snapshot から新たに usage/profile を取得する。CLI 出力の account や起動前の A を新 token の帰属に使わない。外部 account 切替との競合を CLI が安全に扱う根拠がない場合は段階 B を承認しない。回復遮断は全体に適用し、B への切替で不確定な rotate を再試行しない。

#### 段階 A の実装対象（この設計作業では変更しない）

| ファイル / 関数 | 仕様 |
|---|---|
| `src/main/lib/claude-auth-state.mjs`（新規） / `parseExpiresAt()`, `classifyClaudeAuth()`, `shouldNotifyClaudeAuth()` | 時刻・snapshot メタデータ・既知 401/expiry・前回通知を受ける純粋関数。I/O と account lookup は持たない。判定順序・通知重複を §15.4/15.6 に固定 |
| `src/main/providers/claude.mjs` / 新 `createClaudeProvider()`, `readCredentialSnapshot()`, `resolveInitialClaudeIdentity()`、既存 `readAccessToken()`, `fetchClaudeSamples()` | provider factory に read/fetch/clock を注入。snapshot 読込、全 HTTP 前の gate、3 error 行、同 token identity。profile cache/401 latch/in-flight profile は instance 内へまとめ、起動 probe と scheduler が同じ instance を使う。既存 export は既定 instance のラッパとして維持 |
| 同 / `initUserAgent()` | 認証を誘発しないと確認できた版だけ `--version` を実行する。確認不能ならファイル情報等の非実行の版検出か既存 DEFAULT_UA を使う。期限切れ本番 token で版の探査コマンドを増やさない。Codex の版検出は変更しない |
| `src/main/claude-auth-monitor.mjs`（新規） / `createClaudeAuthMonitor()`, `start()`, `checkNow()`, `publicStatus()`, `stop()` | 30 秒再読込、token 世代状態、状態遷移ログ、通知、公開 health DTO。HTTP/DB insert は行わない。read/clock/timer/notifier を注入。監視例外で tick を停止しない |
| `src/main/scheduler.mjs` / `createScheduler()`, 内部 `tick()` | Claude provider と health observer を依存として受け、同一 provider instance を呼ぶ。snapshot 世代を含む内部 batch を health observer に渡す。`recordPoll()` の 5 行保存と single-flight、予定間隔、Codex 呼出しは維持 |
| `src/main/account-manager.mjs` / `observeBatch()`、新 `currentCredentialGeneration()` | Claude batch の非公開世代キーをメモリで保持。auth health が currentAccountKey と一致するかを判定する用途だけ。DB/公開 accounts DTO に世代キーを入れない。Codex batch にこの情報を要求しない |
| `src/main/index.mjs` / `main()`, `registerPowerMonitorLogging()`, 終了処理 | provider/monitor を構築して起動 probe と scheduler に共有。認証状態を server/tray へ渡す。resume/unlock で再読と既存 runNow、lock は通知だけ保留。monitor timer を終了時に停止。3 秒の初回 identity 予算と unknown 縮退は維持 |
| `src/main/config.mjs` / `DEFAULTS`, `sanitizeConfig()`, `readConfig()`, `writeConfig()` | 新 3 設定を読み書きし健全化。既存 reveal 設定の migration と poll 設定を保持 |
| `src/main/lib/normalize.mjs` / Sample JSDoc、`errorSamples()` 利用箇所 | 新 code の文書化。`httpErrorCode()` の 401 mapping、Claude 3/Codex 2 行、純粋な正規化は維持 |
| `src/main/logger.mjs` / `sanitizeForLog()` 内部 sanitize | 新防御キー追加。状態ログの emit/60 分抑制は monitor の責務とし、logger に認証処理を置かない |
| `src/main/tray.mjs` / `buildTooltip()`, `createTray().refresh()` | 新 code の短い理由と current health の案内。Electron 通知は注入可能な notifier に分離し、通知 click は `openDashboard()`。既存 2 値表示とメニューを維持 |
| `src/shared/gaps.mjs` / 新 `computeAuthGaps()` | §15.6 の証拠範囲だけを返す純粋関数。`computeGaps()` の互換性を維持 |
| `src/main/server.mjs` / `startServer()` の request handler | `/api/auth-status` と生データ由来 `authGaps` を追加。account filter を先に適用。既存 `decimate()`、`series`、実 ID 開示 endpoint の境界は維持 |
| `src/renderer/app.mjs` / `fetchData()`, `renderHeader()`, `nextResetAtFor()`, `scheduleDraw()` | auth health を独立取得、選択 account の理由表示、Claude 認証 error 中の reset 抑止、overlay を chart へ渡す。account 切替時の overlay clear と stale 応答排除 |
| `src/renderer/chart.mjs` / `drawChart()`, `drawGaps()`, `drawTooltip()` | 任意の `authGaps`、琥珀バー/凡例、error 区間 hover を追加。ok 点だけを選ぶ従来 tooltip の前に gap hit-test を置く |
| `src/renderer/theme.mjs`, `index.html`, `style.css` | 認証帯の色、Claude group の短い状態行、320–1920px の折返し。実 ID や実装内部の資格情報は表示しない |

`db.mjs` の migration・schema・recordPoll の帰属処理は変更不要。追加の batch 非公開情報は DB が参照せず、Sample の既存列だけを保存する。`providers/codex*.mjs`、`lib/exec.mjs`、`shared/resets.mjs`、`shared/ticks.mjs` は変更対象外。

#### 段階 B の追加対象

§15.9 の検証を通った場合に限り、`src/main/claude-auth-recovery.mjs` を追加する。`createClaudeAuthRecovery({spawn, readSnapshot, readConfig, capability, clock, stateStore})` は `consider(snapshot)`, `status()`, `close()` を提供し、single-flight・allowlist・試行前の durable block・出力制限・自然終了・保存検証を担当する。stateStore の `read()/beginAttempt()/completeAttempt()/block()` は原子的な小ファイル更新だけを行い、認証ファイルへは書かない。monitor が `consider()` を呼ぶが、その終了を tick や monitor の再読込が待つことはない。`index.mjs` が起動/終了・設定更新を結線する。

### 15.8 テストと受け入れ条件

`node:test` と一時ファイルを使い、HTTP、clock/timer、CLI spawn、通知をモックする。ユニット/結合テストが本番資格情報、ブラウザ、実 CLI、ネットワークへ到達しない構成を必須にする。既存 tests の環境/Date.now/global fetch 差し替えは finally で戻す。以下は実装時の追加・変更予定であり、本依頼では tests を編集しない。

| テスト | 必須ケース |
|---|---|
| `tests/claude-auth-state.test.mjs`（新規） | expiresAt の ms 型、欠落/null/文字列/NaN/秒値、境界 `now` と +30 秒、時刻の前進/後退、local expiry と server 401 の区別、通知 threshold と重複 |
| `tests/providers-accounts.test.mjs`（拡張） | 期限切れは usage/profile **とも 0 回**で 3 行。未知期限は通常取得、usage 401 後は同 token 再送なし。mtime/期限だけの変更は latch を解除しない。新 token で回復、同 token の identity 維持、新 token/再起動/キャッシュ除去後は unknown |
| `tests/claude-auth-monitor.test.mjs`（新規） | 30 秒読込が idle/lock 中も継続。lock は通知だけ保留、unlock 重複、通知 OFF、期限前案内、外部更新検知。HTTP/DB 書込を呼ばない。世代が違う health に current accountKey が付かない |
| `tests/scheduler.test.mjs`（新規） | clock/provider を注入し 16 時間の期限切れを進め、全 tick の Claude 3 error + Codex 2 ok、同一トランザクション、local error は倍間隔なし。実際の 429 だけ既存 2 倍、manual/resume single-flight、起動 probe の usage 0 回・通常 tick との profile Promise 共有・latch 共有 |
| `tests/claude-auth-recovery.test.mjs`（段階 B・新規） | OFF/空 allowlist/版・digest 不一致/シムのみは spawn 0。固定 argv/env、spawn 前の永続 block、single-flight、世代ごと一度、15 分 cooldown、保存成功と「code 0 だが保存なし」の区別、遅延/非zero/破損/出力超過/自然終了/設定 OFF/再起動で遮断保持。CLI in-flight 中も Codex と error 記録継続 |
| `tests/config.test.mjs`, `tests/logger.test.mjs`（拡張） | 旧設定と新既定/不正値、OFF への安全縮退。認証 warn が一遷移につき一度、継続 60 分、回復 info。token/refresh/fingerprint/UUID/email/CLI 出力が JSON 全文にない |
| `tests/gaps.test.mjs`（拡張） | local expiry/expiring/401 の overlay、reason 切替、429 や記録不在は灰色、error 後の長い停止は証拠区間だけ、clip/先頭/末尾/未来/間隔変更。従来 computeGaps の結果は不変 |
| `tests/server.test.mjs`, `tests/db.test.mjs`（拡張） | schema 不変、2 code の往復、5 キー/series 互換、overlay が間引きで消えない、A/B/unknown フィルタ、匿名 auth-status、secret 非公開、v1 縮退 |
| `tests/startup-identity.test.mjs`, `tests/account-selection.test.mjs`、renderer 純粋表示 helper のテスト | 初期 expiry の unknown 縮退、初回予算、選択切替で古い health/overlay が混入しない、過去 account 表示と現在認証の区別、Claude 認証 error 時だけ reset 抑止。Codex の既存表示は不変 |

段階 A の受け入れ条件:

1. 確認送信 OFF、または起動時から期限切れの token で、起動直後・16 時間の通常 tick・manual・unlock を通して Claude usage/profile 要求がゼロ。3 error 行と Codex 2 行を予定 tick ごとに保存する。**2026-10-11 改訂**: `once` で期限を跨いだ場合の追加条件・テストは §15.12 を適用する。
2. 未知期限でも usage 401 を一度受けた同 token を、このプロセス中に再送しない。期限切れに起因した 401/429 の反復を再現モックで止められる。サーバー側 429 がすべて消えるとは保証しない。
3. 外部の新 token を 30 秒以内に検知する。**2026-10-11 整合改訂**: blocked からの切替は 2026-10-03 の指示どおり即時 tick を 1 回要求し、single-flight でスキップされた場合は次の予定 tick で取得する。通常の有効 token 切替と旧 429 の待ち時間は §15.4 どおり。
4. 期限前/期限切れの案内が dashboard を開かずに機能し、トレイ/現在値/履歴/ログで「認証更新待ち」と「記録なし」を区別できる。通知 OFF/OS 抑制時も状態は読める。
5. `.credentials.json`、`.claude.json`、refresh endpoint、Claude Code のログイン状態に quota-trail が変更を加えない。既定で認証回復 CLI を起動しない。既存 DB/旧 error code/匿名 account 選択/Codex/H-002 の回帰がない。

段階 B の追加受け入れ条件:

1. §15.9 の安全性検証を exact binary で通し、対応版・digest・検証記録を capability として固定できる。未確認版は実効 OFF。
2. Windows 11 で **Claude Code を対話利用せず、PC を起動したまま 24 時間以上（8 時間の寿命を少なくとも 2 回跨ぐ）**の試験を行う。平常ネットワークでは期限前更新と連続取得、期限切れ検知開始から最大 `監視 30 秒 + CLI 60 秒 + 2 poll interval + HTTP timeout`（既定 465 秒）内の最初の ok を確認する。起動直後は monitor の初回 check を即時に行う。Fable の契約上の `window_absent` は認証欠測から除外する。
3. Claude Code 同時利用、A→B→A、回復処理中の account 切替後にも通常起動で再ログインを要求されない。モデル要求を追加せず、設定/版/アカウントを勝手に変更しない。
4. 更新不能・保存失敗・不確定終了を反復せず、遮断と案内へ移る。失敗後も Codex の取得と Claude error 記録を続ける。

段階 A の試験合格と段階 B の合格は別に記録する。段階 B の条件を通らない限り「長時間無人欠測を解消済み」というリリース判定をしない。

### 15.9 実装時の検証手順と失敗時のフォールバック

1. **配布物の照合（読み取りのみ）**: 運用 exe のソース/版と現行 scheduler/logger を照合する。ログの `.1` と収集期間を確認して auth_expired が見えない理由を整理する。資格情報を全文出力せず expiresAt と観測時刻、DB の匿名化した status/error_code 集計だけで 8 時間境界を確認する。OS 時計の補正や suspend も区別する。
2. **CLI 安全性の調査**: 2.1.284 の配布ファイル・公式変更履歴・#95822 の状況を確認する。実 token で `auth status` や `--version` を実行して「調べる」のは避ける。更新開始条件、refresh を await する経路、保存確認、CLI 間の共通ロック、account 切替時の CAS、終了時の扱いを検証可能な証拠として残す。原子的書込だけで安全と判定しない。
3. **偽資格情報 + CLI 通信モックで検証**: 専用 `CLAUDE_CONFIG_DIR`、専用 cwd、実 account と関係しない token を使用する。CLI 通信を隔離したローカル HTTP/proxy モックへ向け、外部通信を拒否する。隔離方法が証明できなければこの実験を進めない。CLI コマンドがプロンプト/hook/モデル呼出し/ブラウザ/自己更新を行わないことを確認する。
4. **rotate を再現**: refresh モックは旧 refresh token を一回だけ受理し、新しい pair を返す。単なる access token 更新モックではなく、保存後の新 refresh token で **次の更新も成功する**ことまで確認する。応答遅延 0/0.5/3/15/60 秒、期限 5 分前/期限直前/失効済み、exit 0 なのに未保存を検証する。各条件を少なくとも 20 回実行し、再現しなかっただけで安全の証拠としない。特に短命 CLI の終了経路が保存を待つ根拠を必要とする。
5. **競合と障害**: 同じ config dir を使う二 CLI、対話 CLI が古い token をメモリ保持する状態、更新途中の A→B、ACL 読み取り専用、ディスク書込失敗、共有違反、ロック競合、通信途中の終了/応答喪失を偽 token で試す。ロック順序と CAS を確認し、共有認証を失い得る未処理ケースが残る版は承認しない。quota-trail の timeout kill で解決しようとしない。
6. **小規模な実動検証**: 上記を通った場合だけ、発注者の通常ログインと独立した検証用 account/grant/config dir で二度の refresh と同時 CLI 利用を確認する。本番 token のコピーは検証用 grant ではない。実 account を使う認証実験は、この設計書作成には含めず実装時の明示的な検証作業として扱う。通常ログインの復元を「古い credentials のコピーを戻す」で行わない。
7. **採否確定**: `auth status` が状態表示だけで更新しなければ能力不足、rotate 後に保存が欠ければ危険として却下する。別のコマンドを自動で順に試さない。安全な公式経路が確認できるまで allowlist は空のまま、段階 A の通知と更新検知へフォールバックする。必要な上流修正を検証課題として残す。
8. **段階 A を実装、モック回帰**: 期限 gate、monitor、表示/ログを先に実装する。`npm test`（package の `node --test`）で全 suite を確認し、schema 不変・5 行・Codex・account 分離を確認する。HTTP と CLI はモックのまま。
9. **段階 B の導入判定**: 証拠のある exact capability のみ同梱し、既定 OFF を維持する。検証用環境で ON にして §15.8 の 24 時間試験、幅 320/1920px、idle/lock/resume、通知抑制と回復遮断を確認する。平常時の期限前更新の成功、認証起因の欠測分数、401/429 件数、再ログイン要求の有無を測る。失敗時は実効 OFF とし、段階 A を維持する。

この手順の成果には、実行した/していない試験、版/digest、確認済み事項、未確証事項、段階 B の採否を残す。CLI 実験なしで「status が refresh する」「安全に保存される」と断定しない。

### 15.10 設計仮説の判断

- **H-002（idle / ロック中でもポーリングを止めない）: 採用。** 通常 tick、Claude error 記録、資格情報の 30 秒再読込は idle/lock 中も継続する。利用可能な token なら取得を続ける。失効 token の HTTP 抑止は認証状態によるもので、離席による停止ではない。段階 B が承認された場合も idle/lock は更新停止条件にしない。
- **H-001（Codex rollout の副次データ源）: 対象外。** Claude の認証欠測の回復には使えず、Codex は現行経路を維持する。既存の却下理由と account 混在への懸念を変更しない。
- **H-003（期限超過後の確認送信）: 部分採用（2026-10-11）。** 明示設定で usage を最大 1 回実測し、200 の点を保存する。期限後もサーバーが受け付けるという仮説自体は未確証。反復 probe、200 による通常取得再開、全 401 から利用不在を断定する判断は採用しない（§15.12）。

### 15.11 実装ノート（2026-10-02）

**2026-10-11 注記**: 本節は 10/2–10/3 の実装・検証記録である。§15.12 の確認送信は追加設計であり未実装。以下の 161 件成功は追加設計のテスト合格を意味しない。

段階 A を最小構成で実装した。段階 B（`claude-auth-recovery.mjs`、CLI spawn、`claudeAuthRecovery` 設定）は実装していない。

**実装したもの**

- `src/main/lib/claude-auth-state.mjs`（新規）: `parseExpiresAt()` / `classifyClaudeAuth()` / `shouldNotifyClaudeAuth()`。§15.4 の判定順序（資格情報なし/破損 → 同一 token の 401 → expired latch → `expiresAt <= now` → 30 秒以内 → 通常取得）を純粋関数に固定した。
- `src/main/providers/claude.mjs`: `readCredentialSnapshot()`（refreshToken を取り出さない。内部キーは解決済み config dir + access token の SHA-256）と `createClaudeProvider()`。profile cache・usage 401 latch・expired latch・in-flight profile をインスタンスに持ち、usage と profile の両方の前に gate を置く。ローカル判定中の identity は同じ token に結び付いた権威 profile cache だけで、無ければ `null`（`.claude.json` の local fallback は使わない）。起動 probe は `resolveInitialIdentity()`（usage を取得せず、未完了の profile を最初の tick と共有）。`fetchClaudeSamples()` / `readAccessToken()` は既定インスタンスの互換ラッパとして残した。usage 401 だけを latch し、403 は従来どおり `auth_expired` を記録して latch しない。
- `src/main/scheduler.mjs`: Claude provider・Codex 取得・時計・タイマー・logger・認証 observer を注入可能にした。倍間隔の契機は従来どおり `http_429` の行だけで、`auth_expired_local` / `auth_expiring` / 401 抑止は倍間隔にしない。
- `src/main/claude-auth-monitor.mjs`（新規）: 30 秒ごとのローカル再読込（HTTP / DB なし、idle・lock 中も継続）、token 世代ごとの §15.6 の状態遷移ログ（`claude_auth_expiring` / `_blocked` / `_still_blocked`（60 分ごと）/ `_metadata_unknown` / `_credentials_changed` / `_recovered`）、期限前と期限切れ/401 の案内通知（世代ごとに各 1 回）。lock 中は OS 通知だけを保留し、unlock 時に再評価して案内する（unlock 経由の案内は 60 分に 1 回まで。抑止した分は tooltip / dashboard で読める）。通知 click は dashboard を開く。Electron 通知は `tray.mjs` の `createElectronNotifier()` として注入する。2026-10-03 改訂: blocked だった token から新 token への切替を検知したら、注入された `requestImmediateTick()` を 1 回だけ呼ぶ（§15.4「間隔と資格情報更新の検知」参照）。
- `src/main/config.mjs`: `claudeAuthNotifications`（boolean 以外は true）、`claudeAuthNoticeLeadSec`（有限の数値を整数化して 300–3600 に clamp、それ以外は 600）。
- `src/main/logger.mjs`: fingerprint / 内部キー / CLI の stdout・stderr・raw 出力の防御キーと、文字列中の `sk-ant-` token・64 桁 hex の伏せ字を追加した。
- トレイ: `buildTooltip()` を `src/main/lib/tooltip.mjs` に切り出して node:test 対象にした。`認証期限切れ` / `期限間近・更新待ち` / `認証エラー` と、回復を断言しない案内文。Windows のツールチップ長（約 127 文字）に収めるため、5h と W が同じ理由の error なら `Claude 5h -- / W -- (理由)` と理由を 1 回だけ書く。監視が期限前の案内時間帯なら `Claude: 認証期限まで約 N 分` を出す。
- ダッシュボード: `computeAuthGaps()`（`src/shared/gaps.mjs`。`computeGaps()` は不変）、`/api/samples` の任意フィールド `authGaps`（Claude 3 キー、account filter 後・間引き前の生データから計算）、琥珀色の上端バー・凡例「認証更新待ち」・hover の理由と観測時刻。選択 account の最新行が認証 error なら、ヘッダの現在値は `--` の代わりに理由（認証期限切れ / 期限間近 / 認証エラー）を出し、Claude 5h / weekly のリセット予定を過去の ok 行から復活させない。過去 account を選択中は hover に「最終記録時」と明示する。`scripts/dev-renderer.mjs` に目視確認用の認証区間 fixture を追加した。

**レビューで範囲外とした項目（段階 A の最小構成として後回し）**

- `GET /api/auth-status` と Claude group の「現在の資格情報」一行: 追加していない。ヘッダの理由表示は選択 account の最新サンプル（`/api/latest`）から導出する方式に置き換えた。現在の資格情報の状態はトレイの tooltip と通知で確認する。
- `account-manager.currentCredentialGeneration()`: 追加していない（auth-status を出さないため、health と current account の世代突合が不要）。
- `initUserAgent()` の変更: 行っていない。現行どおり起動時に一度 `claude --version` を実行する。
- 段階 B 全体。

**新 token 検知後の再取得**

既定は設計どおり **次の予定 tick で取得する**（通常 180 秒、直前が実際の 429 なら最大 360 秒）。monitor は scheduler を直接 import しない。Claude だけの即時取得（3 行だけの batch・別の `observedAt`）は「1 tick = 5 行 = 1 トランザクション」の不変条件と `recordPoll()` / backfill の前提を崩すため採用しなかった。resume / unlock / 手動取得は従来どおり即時 tick を行う。

**2026-10-03 改訂（発注者指示）**: blocked（`expired` / `expiring` / `rejected`。errorCode は `auth_expired_local` / `auth_expiring` / latched 401 の `auth_expired`）だった token から新 token に切り替わったときだけ、次の予定 tick を待たず scheduler の既存 `runNow()`（resume/unlock/手動「今すぐ取得」と同じ経路。5 行 1 トランザクションの不変条件はそのまま）を 1 回だけ呼ぶ。有効なまま token が切り替わる proactive refresh では呼ばない。判定は generation 切替時点の直前の公開 state（`checkNow()` 冒頭で捕まえる `previousState`）で行うため、資格情報なし/破損（`missing`/`invalid`）からの復帰は対象外（要求どおり blocked 3 状態のみ）。`runNow()` は既存の single-flight のまま: 別 tick が進行中なら要求は **スキップ**（キューイングしない。`inFlight` なら `null` を返して何もしない）。スキップされても実行中の tick が終われば `scheduleNext()` が通常間隔でタイマーを張り直すため、定期 cadence は崩れない。新 token の generation につき 1 回だけ（同じ新 token を以後何度確認しても再要求しない）。monitor は `requestImmediateTick` という関数を注入される形のままで、scheduler を直接 import しない（テストを純粋に保つ）。`index.mjs` では tray の `onFetchNow` と同じ形で、scheduler 生成前に作る monitor からは module 内 `let scheduler` を閉包で参照する。

**検証**: `npm test` 161 件すべて成功（新規 `claude-auth-state` / `claude-auth-monitor` / `scheduler` / `tooltip`、拡張 `providers-accounts` / `config` / `logger` / `gaps` / `server`）。`claude-auth-monitor.test.mjs` に、blocked→新 token で即時 tick 要求が 1 回だけ起きること・有効なままの token 切替では起きないこと・同じ新 token を繰り返し確認しても再要求しないこと・401 latch（rejected）からの復帰でも起きることの 3 ケースを追加した。scheduler テストは注入した時計で 16 時間の期限切れを進め、全 321 tick で Claude 3 error + Codex 2 ok を 1 トランザクションで記録し、usage / profile 要求 0 回・倍間隔なしを確認した（本改訂による scheduler 自体のロジック変更はなし。既存の `runNow()` をそのまま呼ぶだけ）。renderer は dev-renderer の fixture で幅約 800px と 320px を目視確認した（1920px と実アプリでの通知表示は未確認）。実資格情報・本番 DB・実 CLI・ネットワークは使っていない。

**§15.12 の実装（2026-10-11 追記）**

- `src/main/lib/claude-auth-state.mjs`: 通常 gate とは別の純粋関数 `isPreexpiryBaselineLead()` / `probeWindowPosition()` / `checkProbeClock()` / `pickProbeStage()` / `summarizeProbeStage()`（分析用。未観測は null、4 件未満は件数不足）と段・上限の定数。
- `src/main/providers/claude-expiry-probe.mjs`（新規）: 予算台帳・段割当・セッション（7 日 / 段別 4・合計 20 / 429 / 128 件台帳）・専用ログを provider から分離した。`claude.mjs` は classify ごとに `observe()`、通常 usage の前後に `beginNormalUsage()` / `finishNormalUsage()`、期限切れ gate で `reserve()` → `runExpiryProbe()`（usage のみ・profile なし・権威 cache の帰属のみ）を呼ぶ。batch の非公開 `auth.requestKind` は `normal | expiry_probe | local_gate`。
- `src/main/lib/elapsed-clock.mjs`（新規）: 睡眠を含む経過時計 E。Windows は `os.uptime()`（libuv 経由の GetTickCount64 相当、小数秒）を ms に換算、他 OS は null（= `clock_unverified`）。
- `src/main/lib/power-events.mjs`（新規）: suspend/resume/lock/unlock の処理順（resume は provider 再評価 → monitor 再読込 → 既存の即時 tick）。`index.mjs` はこれを呼び、provider を `createClaudeProvider({readConfig, logger, elapsedNow, saveProbeOff})` で構築する。
- `config.mjs`: `claudeExpiredUsageProbe`（'once' 以外は 'off'）と `saveClaudeExpiredUsageProbeOff()`（保存成否を返す）。monitor: probe の 200 を回復に数えず、通知文を「継続して使用率を記録するため…」に変更。tooltip: 現在 credential が expired/rejected の間の ok 値に `(最終確認値)` を付ける。scheduler・DB・normalize・gaps・server・renderer は変更なし（結合試験で不足なし）。
- 解釈: 割当後の失効理由で config dir の切替は `token_replaced`、期限前の最後の通常 usage 失敗は `no_preexpiry_success`（401 なら `cached_401`）とした。段割当前に E が取れない token は `clock_unverified`・`stage:null` でカーソルを進めない。実測セッションの 7 日は E が使えれば E、使えなければ W で測る。セッション開始時にも `claude_auth_expiry_probe_disabled`（reason `configured_once`）を info で出す。台帳への記録は once のセッション中だけ（off では台帳を作らず旧挙動のまま）。
- 検証: `npm test` 203 件すべて成功（`node --test tests/` はディレクトリ指定が Node 22 で解決できないため package の glob 指定で実行）。実 sleep/hibernate での E の契約確認、幅 320/1920px の目視、運用での実測は未実施。

### 15.12 期限超過後の確認送信（2026-10-11 追加）

#### 判断と改訂範囲

2026-10-11 レビュー反映: 600 秒固定窓を token ごとの遅延ラダーへ改訂し、長時間待機の適格判定・段別集計・終了基準・テスト・受け入れ条件を更新した。

**H-003 は部分採用。`claudeExpiredUsageProbe:'once'` を明示した場合だけ、適格な token のローカル期限到来後に usage を最大 1 回確認する。既定は `off`。profile は送らず、200 を含む全結果で当該 token の確認送信を終了する。** サーバーでの受付を実測するためのハイブリッド判定であり、ローカル期限を無視した常時取得へ戻す案は採用しない。

改訂した既存節は §4.2、§10、§15.1–15.2、§15.4、§15.6、§15.8、§15.10。§15.11 は実装記録として残し、追加設計が未実装である旨を注記した。`design-accounts.md` §3.1 の期限切れ中の profile 再試行は引き続き抑止し、下記の帰属規則を優先する。§15.3 の refresh POST・資格情報書込・refresh token の読取禁止、段階 B の検証条件は変更しない。本変更で CLI コマンドを追加しない。

目的は、複数 token の測定を合わせて **期限後の経過時間別の受付状況（3 分〜8 時間の離散的な曲線）**を得ることとする。1 token の寿命を連続追跡する測定ではなく、1 回の 200 で補えるのはその tick の正常点だけである。十数時間の欠測全体や 8 時間を超える受付は測れず、段階 B の代替・無人回復の達成と数えない。既定 OFF は、受付の実証がなく、1 回でも認証拒否・レート制限を受け得るためとする。実測結果を得た後の上限増加・既定 ON 化は別の設計判断にする。

**長い遅延で 200 が出ても通常取得を再開しない方針を維持する。** 6h/8h での 200 は長時間後の一点の受付を示すが、その token の次回受付や継続期間は分からない。通常 tick を再開すると 1 token 1 回の安全境界を破り、後続の 401/429 と観測条件の変化を招く。今回は実測を優先し、正常点は保存しつつ更新待ちを継続する。連続取得への移行は段別結果をレビューした後の別設計とする。

#### 追加実測と未確証事項

発注者が `%APPDATA%\quota-trail\logs\quota-trail.log` と `.log.1` の `claude/5h=...` を日別集計した結果を設計入力とする。本作業で運用ログ、資格情報、token 値、transcript を再取得していない。tick 数は token 数・期限到来回数ではない。

| 観測 | 判断できること / 限界 |
|---|---|
| 9/20–9/22、9/25–9/28 はほぼ 24 時間稼働（約 478 tick/日、予定 480）。期限を見ない旧コードの 401 は 9/24 の 3 回だけ | アプリが動いていたことは確認できる。当時の token が期限超過していたことや、Claude Code が 8 時間以上不在だったことは未確証 |
| 9/30 は `auth_expired` 24・`http_429` 150、10/1 は 21・146 tick | §15.2 の反復と整合する。同じ失効 token の再送が原因という推測は維持するが、サーバー側の原因を確定しない |
| ローカル gate 後の `auth_expired_local`: 10/2:39、10/3:76、10/4:30、10/5:43、10/6:116、10/7:28、10/8:135、10/9:178、10/10:318、10/11:69 tick。401 は 0 | ローカル判定で送信を止めた時間が増えている。送っていないため、401 がないことは期限後の受付の証拠にならない。10/11 は集計時点までの値 |
| 10/2 以降、新 token 検知から次の expiresAt まで毎回約 28,790 秒（8h） | 観測範囲で寿命短縮は確認されない。検知時刻は厳密な発行時刻ではない |
| `claude_auth_recovered.blockedForSec` は 33–61,099 秒。長いものは夜間・不在時 | 更新待ちが長時間続く運用と整合する。ローカル抑止の観測時間であり、サーバー拒否の継続時間ではない |

transcript に記録されない利用・更新経路があるため、9 月の「8h 以上不在」をそこから判定できない。「9 月は期限切れ token がサーバーに受け付けられていた」は未確証。仕様変更を示す公式告知も、発注者の調査では見つかっていない。告知がないことから仕様不変とは断定しない。

#### 送信条件、回数、間隔

`once` は回数を利用者が増やせる数値設定にしない。`MAX_EXPIRY_PROBES_PER_TOKEN = 1` とし、以下の固定ラダーを使う。許容窓は **早送りなし、予定から 0〜300 秒の遅れのみ**。180 秒 tick の位相差と最大 120 秒の追加遅延を収め、段間の混同を避ける。8h 段の上限は 8h5m とする。

| 段 | 予定遅延 `targetDelaySec` | HTTP 開始を許す期限後経過秒（両端を含む） |
|---|---:|---|
| 3m | 180 | 180〜480（3〜8 分） |
| 30m | 1,800 | 1,800〜2,100（30〜35 分） |
| 2h | 7,200 | 7,200〜7,500（2h〜2h5m） |
| 6h | 21,600 | 21,600〜21,900（6h〜6h5m） |
| 8h | 28,800 | 28,800〜29,100（8h〜8h5m） |

割当は同一 provider instance の実測セッション内で **3m → 30m → 2h → 6h → 8h → 3m…** の順とする。各段の送信予算消費上限は異なる token 4 件（全段合計 20 件）。4 件を消費した段を飛ばして次の段を割り当てる。未送信の失効でも割当カーソルは進め、成功/拒否を見て段を選び直さない。割当と予約は同期的に行い、同プロセスの同 token には一段だけを割り当てる。pending は現在 credential の 1 件だけで、複数の旧 token を並行保持して送らない。

1. 比較対照は同じ provider instance・token・config dir の **期限前の最後の通常 usage 結果**とする。HTTP 200 かつ少なくとも 1 窓が正常で、要求開始時点の期限余裕が `30 秒 < expiresAt - requestStartedAt <= 2 × その tick の intervalSec + 30 秒` を満たすこと。180 秒設定なら 30 秒超〜390 秒。`once` がその成功要求開始時から有効なときに一段を割り当てる。期限前にさらに通常 usage があれば最後の結果で対照を更新し、失敗なら不適格にする。profile 成功・古い成功への巻戻しでは代用しない。**鮮度は期限に対して評価し、probe 開始に対しては評価しない。** 8h 待機で対照が約 8h 古くなっても、期限直前の成功と不変の snapshot が確認できれば比較対照となる。
2. 対照から HTTP 開始まで、token・解決済み config dir・有効な `expiresAt` と要求条件（UA/ヘッダ、pollIntervalSec）が同じであること。30 秒 monitor と全取得経路でローカル snapshot を再確認し、期限改変・欠落/不正化、資格情報の読取失敗、送信条件の設定変更、`off`、既知 401、時計補正疑いを検知したら未使用予算を永久失効させる。同じ値へ戻っても復活させない。通知や表示だけの設定変更は送信条件に含めない。mtime だけの変化は、値が同じなら不適格にしない。読取間隔の間に変わって戻る改変までは検出できず、実測条件の保証も観測できた範囲に限る。
3. **新 token が来たら旧 token の未使用予算は送らずに失効させる判断を採用する。** config dir の切替も旧 pending を失効させ、A→B→A でも再予約しない。旧 secret を長時間保持して現在のアカウントから離れた要求を送る複雑さを避ける。新 token は新しい対照が得られれば次段の候補となる。更新されやすい token が長時間段から脱落する選択偏りは、`token_replaced` 件数として段別に報告し、失効を 401 に数えない。
4. `fetchSamples()` の HTTP 開始直前に credential と時計を再確認し、割当段の `targetDelaySec <= now - expiresAt <= targetDelaySec + 300` を満たす最初の呼出しで usage を 1 回送る。下限前は `auth_expired_local`、上限超過は `late_probe` として未使用予算を失効させる。スリープ・オフライン・イベントループ遅延も同じ窓を使い、別段へ振り替えたり追い付き送信したりしない。通常 tick、手動、resume/unlock は共通 gate/予算を通り、専用タイマーや期限到来による `runNow()` は追加しない。poll 間隔が 300 秒より長ければ窓を逃し得るが、窓を拡大せず skip とする。
5. 資格情報なし/parse、**`cached_401` は待機・送信判断より先に適用**する。起動時から expired、ON 時点で既に expired、期限前の対照なしの token は要求ゼロ。既存の期限前 30 秒 gate は維持する。monitor の 30 秒再読込と期限切れ中の起動 identity probe は HTTP を送らず、予算も消費しない。有効 token の起動時 profile は従来どおり。
6. token と段の予算を **fetch 呼出し前に同期的に消費**する。HTTP は通常と同じ GET URL・ヘッダと 15 秒 timeout。provider 内でも予約を共有し、同時呼出し・手動連打で重複させない。失敗・送信成否不明・設定 OFF→ON でも予算を返さず、全結果で終了する。

送信予算は access token 単体の SHA-256 で記憶し、profile/cache の config dir を含む内部キーとは分ける。台帳には対照、割当段、pending/spent/失効理由、既知 401、期限超過履歴を保持する。profile の 8 件 LRU/24 時間 idle 除去や既存 latch の 16 件除去と連動して捨てず、台帳の既知 401 は通常 gate にも `cached_401` として渡す。**128 件上限は保持する。** 観測結果の保存量ではなく、A→B→A・cache 除去で予算や 401 禁止が復活しないための非削除台帳であり、安全性に寄与する。上限時は既存記録を捨てず、そのプロセスの確認送信を停止して設定 off にする。送信済み 20 件だけに縮めて未送信の失効履歴を捨てる簡素化はしない。

期限を一度跨いだ token は 200 後も expired latch を維持し、期限だけ未来へ書き換えたり時計が戻ったりしても通常要求へ戻さない。キー・fingerprint・token はメモリ内限定。再起動は pending と対照を破棄し、起動時に expired の token へ再配布しない。プロセスを跨ぐ時計巻戻し・期限改変を含む厳密な同一 token 検出は保証できず、そうした実測は除外する。

#### 長時間待機、スリープと時計の検証

壁時計 `W` に加えて、**スリープ/休止時間を含み、壁時計の補正に影響されない経過時計 `E`** を注入する。Windows では `GetTickCount64` 相当の OS 経過時計を薄いアダプターから読む方針とする（[Microsoft: GetTickCount64](https://learn.microsoft.com/en-us/windows/win32/api/sysinfoapi/nf-sysinfoapi-gettickcount64)）。稼働中だけを測る時計は睡眠分を含まないため、この用途の代用にしない（[Microsoft: QueryUnbiasedInterruptTime](https://learn.microsoft.com/en-us/windows/win32/api/realtimeapiset/nf-realtimeapiset-queryunbiasedinterrupttime)）。JS の単調時計にスリープ中の進行を仮定したり、壁時計の睡眠差を単調時計に足したりしない。

- 最初の適格な対照の要求開始で `(W0, E0)` を記録し、monitor、suspend/resume、HTTP 開始直前で読み直す。対照の通常 usage 結果を更新してもこの時計基準は更新しない。前回読取より `W` が後退、`E` が後退/取得不能、または **`abs((W - W0) - (E - E0)) >= 60 秒`** なら当該 token は不適格。対照を基準に累積差を検査し、tick ごとの小さな補正を見逃さない。後退・差は `clock_suspect`、経過時計取得不能は `clock_unverified` と分ける。
- `powerMonitor` の suspend/resume は pending に回数と、各対の `E_resume - E_suspend` を足した累積睡眠時間を記録する。イベント対が欠けた場合の睡眠時間は null とし、0 と偽装しない。resume の gate 再評価を既存の即時 tick より先に済ませる。`E` が睡眠分も進み `W` と整合すれば、数時間の睡眠を **clockSuspect にしない**。resume が窓内なら送信可、窓を過ぎたら `late_probe`。unlock は睡眠とみなさない。
- resume のたびに時計の基準をリセットして差を免除することはしない。睡眠中の前進補正も上記累積差で検出する。sleep を含む `E` が利用できない環境は `clock_unverified` として送信ゼロにし、睡眠と補正を区別できない測定を 200/401 集計に混ぜない。OS アダプターの実装と対象 Windows での sleep/hibernate 検証を実装時の必須条件とする。
- `expiresAt` と比較する時刻は壁時計のまま。サーバー時計との絶対的な一致や 60 秒未満の補正の不存在までは保証しない。段別には予定値だけでなく実際の HTTP 開始時の超過秒、時計差、睡眠の有無を残す。長い待機自体や通常のイベントループ遅延を時計補正と判定しない。

#### 応答ごとの遷移と 429

ローカル分類 `state:'expired', blocked:true` は通常要求の抑止を表す。確認送信の可否・実際の結果は別に扱い、`classifyClaudeAuth()` を 200 で valid に変えない。batch の非公開 `auth.requestKind` に `normal | expiry_probe | local_gate` を加え、monitor が通常の回復と probe を区別できるようにする。キーと requestKind は Sample、DB、公開 accounts DTO に渡さない。

| 結果 | 当該 tick の Claude 3 行 | 次 tick 以降 / 認証状態 |
|---|---|---|
| HTTP 200・正規化可能 | 通常の `normalizeClaude()`。正常窓は `ok`、Fable 等のない窓は従来の `window_absent` | 予算終了、`expired` のまま。通常要求を再開せず `auth_expired_local` 3 行 |
| HTTP 200・JSON 不正/有効窓なし | 従来の `parse` 等の正規化結果。HTTP 受付と有用サンプルをログで分離 | 予算終了、`expired` のまま |
| HTTP 401 | 3 行 `auth_expired`、`source:'http_401'` | `rejected`。§15.4 の `cached_401` を最優先し、同 token の usage/profile とも以後ゼロ |
| HTTP 429 | 3 行 `http_429`。認証エラーへ読み替えない | 予算終了、ローカル状態は `expired`。次 tick は `auth_expired_local` |
| network / timeout | 3 行 `network` / `timeout` | 予算終了、`expired`。HTTP status 未確認なら受付可否は未判定。再試行なし |
| その他の HTTP エラー | 従来の `httpErrorCode()`。403 は従来の `auth_expired` | 予算終了、`expired`。401 latch との混同を避け、実 status を専用ログに保存 |

**probe の実際の HTTP 429 はアプリ共通の次回 2 倍間隔の対象とする。** `http_429` を隠したり、probe のためだけに scheduler の例外を増やしたりしない。Claude/Codex のどちらかが 429 なら次回だけ 2 倍。probe 後の local gate はフラグを立てないため、その token による 6 分間隔の反復は作らない。Codex 等の別経路の 429 は従来どおり対象になる。

旧コードの「401 の次 tick でも同じ token を送り、429 後も再送する」経路は、401 最優先の latch、送信前の 1 回予算消費、profile 禁止によりなくす。200 や network/timeout も再送の契機にしない。ただし **1 回の要求でも 429 を受け得る**し、他クライアントや新 token にも及ぶサーバー側制限の不存在は保証しない。probe で 429 が出たら provider は次の要求を許す前に実測セッションを停止し、設定を `off` に保存する。設定保存に失敗してもメモリ上の停止を解除しない。原因確認まで再開せず、20 件や 7 日の到達を待たない。

#### 200 の保存、帰属、表示

- 200 の正常値はその tick の `observedAt` と通常 `intervalSec` で保存する。Claude 3 行 + Codex 2 行を既存 `recordPoll()` の 1 トランザクションに入れ、追加の単独 sample や過去の穴埋めをしない。200 を error に偽装せず、`status:'ok', errorCode:null` とする。欠落窓の既存 error は維持する。
- DB の列、schema_version、Sample、samples/latest の公開 shape に期限超過フラグは追加しない。**過去の正常点は通常の点と同じ表示**とし、probe 由来であることの区別は専用ログの `observedAt`（provider/window と併用）で行う。ログがローテーションで失われれば DB だけからこの区別はできない。この限界を許容し、分析時には先に対象期間のログを保存する。
- 帰属は成功・失敗とも **同じ token/config dir に結び付いた権威 profile cache だけ**を使う。保持期間内の stale 権威 cache は可。profile 要求・再試行・`.claude.json` fallback は行わない。権威 cache がない/除去済みなら正常点でも `identity:null`（unknown）に保存する。以前の local fallback cache、organization 一致、現在 account、usage の内容を帰属の証拠にしない。unknown を後で移し替えない。
- 200 はローカル期限を書き換えず、通知済み状態、blockedAt、`blockedForSec` を解除しない。`claude_auth_recovered` は **新 token の通常 usage 成功だけ**とし、`requestKind:'expiry_probe'` を必ず除外する。要求中に新 token/account が現れても結果は要求開始 snapshot の帰属で保存し、現在世代の health を旧 batch で更新しない。次の取得は新 snapshot を使う。
- 現在値には実際に得られた数値を出す。トレイは現在 credential が expired の間、ok 数値を「最終確認値」として認証更新の案内を併記し、継続取得できるようには見せない。Windows の約 127 文字上限内に収める。dashboard の過去点は通常表示、次 tick の local error では既存の認証理由表示に戻る。§15.11 で後回しにした auth-status endpoint/group 行の追加は本改訂の必須範囲にしない。
- 通知文は「期限に達しました。継続して使用率を記録するため、Claude Code を通常起動して認証を更新してください」等とし、期限後の一度の受付を否定する「一切記録できません」という断言を避ける。通知回数・lock 時の保留・通知 OFF の扱いは変えない。

#### 専用ログ、切替、実測の終了

provider に logger を注入し、送信開始/完了を provider 単位で 1 回ずつ記録する。3 行分を重複 emit しない。既存 tick と auth 遷移ログ、1 MB/1 世代のローテーションは維持する。

| イベント | レベル・タイミング | fields |
|---|---|---|
| `claude_auth_expiry_probe_assigned` | info、一段の予約時に token ごとに一度 | `provider:'claude', mode:'once', checkedAt, expiresAt, stage, targetDelaySec, windowEndDelaySec, lastUsageOkAt` |
| `claude_auth_expiry_probe_start` | info、予算消費後・fetch 前 | `provider:'claude', mode:'once', probeNo:1, observedAt, requestStartedAt, expiresAt, stage, targetDelaySec, windowEndDelaySec, scheduleLateSec, expiredForSec, lastUsageOkAt, lastUsageOkAgeSec, preexpiryLeadSec, intervalSec, expiryStable:true, clockSuspect:false, clockDeltaSec, clockSource:'sleep_inclusive', suspendCount, suspendedForSec` |
| `claude_auth_expiry_probe_result` | info、401/429/通信失敗は warn、要求完了時 | start fields + `outcome, httpStatus, errorCode, durationMs, parseOk, okWindowCount, nextAction:'cached_401'\|'local_gate'` |
| `claude_auth_expiry_probe_skipped` | info、ON 中に不適格を確定したとき token ごとに一度 | `provider, mode, checkedAt, expiresAt?, expiredForSec?, stage?, targetDelaySec?, reason` |
| `claude_auth_expiry_probe_disabled` | info、設定の切替・上限停止時。429/台帳上限時は warn | `provider, checkedAt, mode, reason:'configured_off'\|'configured_once'\|'ledger_full'\|'probe_429'\|'time_limit'\|'budget_limit', sessionStartedAt, elapsedSec, stages`。`stages` は段別の assigned/spent/200/401/未判定/skip 理由別件数のみ |

`expiredForSec` は **HTTP 開始時刻からその snapshot の expiresAt を引いた秒数**（小数 3 桁まで）。完了時刻から計算しない。`lastUsageOkAt` は比較対照の HTTP 開始時刻、`lastUsageOkAgeSec` はそこから probe 開始までの秒数。`outcome` は `http_200 | http_401 | http_429 | http_other | network | timeout`、HTTP status 未確認なら `httpStatus:null`。HTTP 200 の `parseOk` と正常窓数 0–3 を別に残し、HTTP 受付とサンプル成功を混同しない。parse 未実施/未完了なら `parseOk:null`、正常窓数は 0。timeout が body 取得中なら判明済み status も残し、HTTP 200 が確認できた試行は body 失敗でも「HTTP 受付あり・有用サンプルなし」と数える。

`stage` は `3m | 30m | 2h | 6h | 8h`、`scheduleLateSec = expiredForSec - targetDelaySec`、`preexpiryLeadSec = (expiresAt - lastUsageOkAt) / 1000` とする。比較対照の古さと、期限に対する対照の近さを分けて記録する。対照を更新しても assigned を再発行せず、start/result には最終対照を入れる。

skip の reason は `cached_401 | no_preexpiry_success | late_probe | expiry_changed | clock_suspect | clock_unverified | token_replaced | config_changed | credential_unavailable | configured_off | already_spent | session_ended` 等の固定コード。段割当前の不適格は `stage:null` とし、段別の拒否に算入しない。下限を待っている tick や通常の OFF の tick ごとに skip を出さない。sleep 中に JS 単調時計が止まったという理由だけで `clock_suspect` を付けず、前述の sleep を含む経過時計で判定する。

**token、refresh token、fingerprint、内部キー、UUID、メール、config dir、HTTP body/headers、raw exception は全イベントへ渡さない。** probe のイベントには accountKey も不要とする。`sanitizeForLog()` の既存の秘匿キー除去・文字列の伏せ字は防御として通すが、それだけに依存しない。start/result は `observedAt` と `requestStartedAt` で照合でき、token の疑似 ID は追加しない。start のみで result がない試行は「未完了/記録範囲外」であり、拒否や受付なしに数えない。

「受付なし」の恒久自動判定は実装しない。**設定 off による手動停止に加え、実測の期間・予算の上限で自動停止する。** OFF 後の新要求はゼロ、進行中の GET は結果を記録して終了し、予算を戻さない。ON に戻しても既に期限を跨いだ/消費済み/失効済みの token を再配布しない。

7 日・20 token は **最大観測期間と送信予算**に改める。同一プロセスで最初に once を有効にした時点から、sleep を含む経過時計で 7 日（604,800 秒）、または各段 4 件・合計 20 token の予算消費の **早い方**で停止し、設定 off と pending 失効を確定する。7 日境界ちょうどから新要求は禁止し、最後の要求の結果は保存する。OFF の期間も 7 日に含め、OFF→ON で期間・カーソル・段別消費数をリセットしない。上限/429/台帳上限で閉じたセッションはそのプロセスでは再開しない。再起動は別セッションとし、比較対照を取り直す。7 日内に全段を揃えられない場合も上限を自動延長しない。

各段について assigned、未送信失効（理由別）、spent、HTTP 200、HTTP 401、受付未判定、有用サンプル数、実際の超過秒の最小/最大、sleep 有無を集計する。受付割合は **`200 / (200 + 401)`** と分母件数を並記する。HTTP 200 確認後の body timeout/JSON 不正も受付あり、有用性は別集計。429、status 未確認の network/timeout、その他 HTTP、start のみ、skip は 200/401 の分母に入れないが、送信前消費済みなら安全予算 20 件には含む。欠測の段は空欄/未観測とし、0% にしない。停止ログの `stages` はその時点の集計であり、進行中要求があれば暫定とする。評価用の最終集計は保存済み assigned/start/result/skipped ログを使い、停止後に完了した結果も加える。

**全 5 段それぞれで異なる token の判定済み 4 件が全て 401（合計 20 件）、200 ゼロ、適格な対照・時計・メタデータが確認できた場合**は「今回測った 3m〜8h の各窓では受付を観測せず、実測継続の価値は低い」として off を維持する基準にする。7 日終了時に一段でも 4 件未満なら、その段は「観測件数不足」。短時間段だけで 20 件を満たす停止判定は認めない。200 があっても資源上限で停止し、その段の実時間を添えて受付ありを報告する。再起動を跨ぐ集計は比較資料にできるが、ログに token 識別子がないため異なる 20 token の基準には合算しない。これらは統計的証明や仕様の確定ではない。

#### 発注者への回答に使う判定基準

下表の 200/401 は、割当窓・不変 snapshot・時計検証・期限前対照を満たした測定に限る。X は予定値ではなく HTTP 開始時の実際の期限後経過時間。200 は一件でもその受付の存在を示すが、401 一件で当該段全体を否定しない。

| 段（許容実時間） | 200 が出たら言えること | 401 が出たら言えること |
|---|---|---|
| 3m（3〜8 分） | この token は X 分後に受付。期限直後の数分の受付を確認 | この token は X 分後に拒否。数時間後の受付は未評価 |
| 30m（30〜35 分） | この token は X 分後にも受付。数十分のオーダーを確認 | この token は X 分後に拒否。他 token や 2h 以降の受付は未評価 |
| 2h（2h〜2h5m） | この token は X 時間後にも受付。期限直後だけの短い猶予では説明できない観測 | この token は X 時間後に拒否。数時間段の拒否を確認するが期限が原因とは未確定 |
| 6h（6h〜6h5m） | この token は X 時間後にも受付。夜間の数時間の欠測でも取得可能な一点があった | この token は X 時間後に拒否。夜間相当の長時間段で受付を得なかった |
| 8h（8h〜8h5m） | この token は X 時間後にも受付。期限後約 8h の受付を確認 | この token は X 時間後に拒否。約 8h 段で受付を得なかった。十数時間後は未評価 |

どの段でも正常窓を含む 200 なら、その一点は一律 local gate で欠測になっていたと確認できる。段間は異なる token なので、例えば 30m の全 200 と 2h の全 401 から「猶予は正確に 30m〜2h」とは言えない。6h/8h の 200 も、それまで途切れず受付が続いていた証拠にはならない。曲線は補間せず段別の点・件数・未観測・選択偏りを示し、全 token 共通の猶予や単調性は仮定しない。

| 実測結果 | 回答できること / 言えないこと |
|---|---|
| 安定した期限・時計のもとで同じ snapshot の probe が 200 | 「この観測ではローカル期限から X 秒後にも usage が受け付けられた」。JSON/正常窓も成功なら一律 gate による当該正常点の欠測が確認できる。全 token の猶予や公式寿命の延長を意味しない |
| 期限直前の同 token の通常 usage は 200、割当段では 401 | 「この token は期限後 X 秒時点で認証拒否された」。6h/8h は対照からも長時間離れ、外部での失効・利用条件の変化等もあり得る。期限との対応は測れても、期限が拒否原因・仕様変更とはまだ言えない |
| 比較可能な過去の期限後 200 と、現在の同じ段・重なる実際の経過秒帯での異なる token の反復 401、同等の CLI/UA/アカウント・外部更新条件・安定した時計が揃う | 「サーバー側の期限後受付が変わった可能性が高い」。数時間後の仕様変更を問うには過去と現在の数時間段の証拠が必要で、3m の結果で代用しない。確定には公式仕様/告知または他要因を除いた比較検証が必要。9 月の tick 成功だけでは過去の期限後 200 を証明できず、現在の実測だけで『拒否するようになった』とは言えない |
| 外部利用・更新の記録で 8h 以上更新されていないことが確認でき、同じ token の期限を跨いで抑止、新 token 更新後に回復 | 「その期間の直接の欠測理由は、8h の期限到来後に credential の更新がなかったこと」。CLI 不在を述べるには利用経路を網羅する記録が必要。transcript の空白や全 probe 401 だけでは不在を証明せず、仕様変更も排除しない |
| 全段各 4 件が 401、過去の期限後受付や利用不在の証拠なし | 「今回の 3m〜8h の各許容窓では受付を観測しなかった」。窓の間・8h 超・全 token の受付なし、Claude Code 不在、仕様変更はいずれも断定できない |
| 短時間段だけ全 401、6h/8h は更新・sleep 遅延等で未観測/不足 | 短時間段の拒否だけ回答できる。夜間数時間の問いは未解決。skip は拒否の証拠にしない |
| 429 / status 未確認の network・timeout / skip / 時計不適格 | 受付の有無や原因は判定保留。200 確認後の body 失敗は受付ありに数える。429 を token 寿命変更や認証拒否の証拠にしない |

現時点での回答は「観測されたローカル寿命は約 8h のまま。10/2 以降は送信前に止めるため、増えた認証期限切れ表示からサーバー側の変更は判断できない。9 月の期限後受付も未確証」とする。probe を導入しても、ローカル expiresAt はサーバーが実際に失効させる時刻の仕様そのものではない点を維持する。

#### 認証更新待ちの帯への影響

`computeAuthGaps()` は現在どおり認証 error 行だけを証拠にする。**probe の ok 点をオレンジ（琥珀）帯へ含めない。** `auth_expired_local → ok → auth_expired_local` なら前の帯は ok の `observedAt` で終わり、次の認証 error 時刻から帯を再開する。ローカル health が expired のままでも、正常に得た値を認証欠測として塗らない。

probe の 401 は `auth_expired` の帯、429/network/timeout/parse は灰色のみとし、次 tick の local error からオレンジへ戻す。Fable の `window_absent` はその系列だけ灰色。認証帯の `intervalSec × 2.5` 上限、clip、同理由 merge、account filter 後・間引き前の overlay、記録不在を推測で塗らない規則は維持する。`computeGaps()` の灰色帯は前後の点へ広がり得るが、ok 点そのものと認証帯の根拠を混同しない。unknown の正常点を A/B の帯の中断に使わない。

#### 対象ファイル、必要なテストと受け入れ条件

本レビュー反映の変更は **design.md §15.12 と H-003 の 2 文書だけ**。以下は **実装時の予定**であり、実装コード・テストは本作業で変更しない。

実装対象は `src/main/lib/claude-auth-state.mjs`（通常 gate と純粋な probe 適格判定の分離）、`src/main/providers/claude.mjs`（ラダー・対照・別予算台帳・段別上限・usage 専用分岐・専用ログ）、`src/main/claude-auth-monitor.mjs`（長時間待機中の失効検知・probe を回復から除外・通知文）、`src/main/config.mjs`（設定健全化・上限/429 停止の保存）、`src/main/index.mjs`（同 instance に設定/logger/時計・suspend/resume を注入し、resume 再評価を即時 tick より先に接続）、sleep を含む OS 経過時計の薄いアダプター、`src/main/lib/tooltip.mjs`（期限超過中の最終確認値）。scheduler、DB、normalize、gaps、server、renderer は既存の結果処理を原則維持し、下記の結合試験で不足が出た部分だけ調整する。Codex の取得経路は変更対象外。

| テストファイル | 必須ケース |
|---|---|
| `tests/claude-auth-state.test.mjs` | 有効な epoch ms、期限前 30 秒 gate を維持。全 5 段それぞれの下限直前/下限ちょうど/上限ちょうど/上限超。対照の期限前余裕 30 秒/390 秒の境界（180 秒設定）、8h 古い対照も適格、最後の通常失敗では不適格。401 優先、expired latch と独立予算、expiry 変更・時計後退/累積差 60 秒の境界 |
| `tests/providers-accounts.test.mjs` | OFF・起動時/ON 時から expired は usage/profile 0。異なる token への 3m→30m→2h→6h→8h→3m 割当、同 token の対照更新でも再割当なし。下限前は送信ゼロ、窓内だけ usage 1/profile 0、遅延上限超は失効し別段への振替ゼロ。全段で 200/401/429/network/timeout/JSON 不正/403/500/同期 fetch 例外でも予算消費と 2 回目ゼロ。manual/並行呼出しで token・段の予算重複なし |
| 同上 | 待機中の新 token・dir 切替で旧 pending 失効、A→B→A でも復活ゼロ。expiry 改変/欠落、読取失敗、OFF→ON・poll/UA 変更で失効、mtime だけ・通知/表示設定の変更なら維持。同 token の権威 identity/stale cache のみ、cache 除去/local fallback のみなら unknown、profile 再取得ゼロ。要求中の A→B では旧 snapshot へ保存。8 件 cache/16 件 latch の除去でも予算/401 禁止維持。128 件上限停止、再起動で expired を再 probe しない |
| 同上・経過時計アダプターの試験 | sleep を含む E が数時間進めば 6h/8h の resume 窓内は適格、窓超過は late_probe。稼働中だけの単調時計が止まっても E/W が整合すれば clockSuspect なし。睡眠中の ±60 秒補正、累積する小補正、後退、E 取得不能/後退は不適格。複数 suspend/resume の回数/時間、resume 再評価→即時 tick の順序、unlock を sleep と数えない。対象 Windows の実 sleep/hibernate で E の契約を確認（API/実資格情報は不要） |
| `tests/claude-auth-monitor.test.mjs` | monitor の 30 秒判定・lock/unlock で HTTP/DB/予算消費なし。probe 200 で state/blockedForSec/通知済み状態を解除せず recovered ゼロ。新 token の通常成功だけ回復 1 回。古い batch が現在世代に混入せず、blocked→新 token の即時 tick 要求を維持 |
| `tests/scheduler.test.mjs` | 各段で期限前成功から 16 時間を進め、割当窓だけ期限後 usage 最大 1、profile 0、200 後も再開なし、全予定 tick に 5 行 1 transaction。180 秒 tick の位相差と追加遅延、300 秒超の間隔では取り逃しを許容。probe 429 は次回だけ 2 倍、その後 local gate は倍間隔なし。Codex 429 は従来どおり。manual/resume/unlock single-flight、起動 identity probe との共有、idle/lock 方針の不変 |
| `tests/providers-accounts.test.mjs`, `tests/config.test.mjs` | 7 日ちょうど/20 予算消費の早い方で停止・pending 失効、各段最大 4・満杯段を飛ばす、skip はカーソルを進めても送信枠を消費しない。network/timeout/未完了も安全予算に含む。途中 OFF/再 ON で期間/カーソル/消費数をリセットせず、閉じたセッションは再開ゼロ。7 日内の不足段を 0%/全拒否と判定しない。429 一件で次の probe 禁止・off 保存失敗でも停止維持 |
| `tests/config.test.mjs`, `tests/logger.test.mjs` | 欠落/不正設定は off、once/off の読み書き。assigned/start/result の重複なし、段/予定遅延/実際の開始超過秒/遅れ/対照の余裕・古さ/時計差/sleep の記録、timeout/body 失敗・HTTP status・正常窓数が正しい。段別の受付分母と有用性、skip 理由別/未観測/上限停止ログ。sanitize 後も安全 fields が残り、token/refresh/fingerprint/内部キー/UUID/email/本文/headers は JSON 全文にない |
| `tests/gaps.test.mjs`, `tests/server.test.mjs` | local error→probe ok→local error の帯分割、probe 401 の理由、429/network/parse と Fable window_absent は灰色、長い停止・clip・now 上限。account/unknown 分離、生データの帯が間引きで消えない、series の既存 shape と秘密非公開 |
| `tests/db.test.mjs`, `tests/normalize.test.mjs` | probe の正常値/混在窓/error を既存列で往復、unknown を後から移さない、schema 不変、Claude 3/Codex 2 行の正規化・帰属・既存 backfill の回帰 |
| `tests/tooltip.test.mjs`, `tests/startup-identity.test.mjs` | 正常値と expired health の併記、認証回復と誤表示しない、127 文字上限。期限切れ起動は unknown/usage 0/profile 0。通常の有効 token の tooltip と初回 identity 予算は維持 |

実装時は偽資格情報・注入 fetch/壁時計/sleep を含む経過時計/稼働中だけの単調時計/電源イベント/タイマー/logger/DB を用い、`node --test tests/` を実行する。API・CLI・本番 DB・実資格情報には到達しない。手動表示試験は fixture で、幅 320/1920px、正常点を挟んだ認証帯と最終確認値、過去 account/unknown の分離を確認する。OS 経過時計の sleep/hibernate 試験、運用 probe の実測、node:test の合否は別に報告する。

受け入れ条件は (1) OFF の旧段階 A に回帰がない、(2) ON でも適格 token 当たり期限後 usage 最大 1・profile 0・401 後ゼロ、(3) 全 5 段の順次割当と各窓が成立し、未使用予算は新 token/不適格/窓超過で復活しない、(4) sleep を補正疑いと誤判定せず、補正・時計未検証は送信前に除外する、(5) 長時間段の 200 も正しい値・帰属で保存し通常取得/回復を再開しない、(6) 429 即時中止・既存の次回 2 倍・全 tick の 5 行を維持する、(7) 7 日/段別 4・合計 20 の上限を守り、受付/拒否/有用性/skip/不足段を秘密なしで区別し OFF へ戻せる、(8) オレンジ帯が取得失敗の証拠範囲だけに付く、(9) refresh/資格情報書込/CLI 自動起動を追加せず、Codex と H-002 に回帰がないこと。実測の 200 や全段の件数充足は機構の試験合格とは分け、仮説を確認済みとは報告しない。

#### 各仮説の判断（2026-10-11）

- **H-001: 対象外。** Codex rollout は Claude の期限後受付を実測できない。Codex の経路と従来の却下理由を維持する。
- **H-002: 採用。** idle/lock 中も通常 tick、3 error 行、30 秒再読込を続ける。認証と送信予算による抑止は離席判定ではない。probe 429 の次回 2 倍以外に間隔を変えない。
- **H-003: 部分採用。** 設定で token ごとに一段を割り当て、usage の 1 回実測と正常点保存を許す。3m/30m/2h/6h/8h を段別評価し、全段各 4 件が全 401 なら継続の価値を見直す。期限後受付の存在は未確証のまま、反復試行や長時間段の 200 による通常取得再開は採用しない。CLI 不在や仕様変更を全 401 だけから断定する反証規則も採用しない。
