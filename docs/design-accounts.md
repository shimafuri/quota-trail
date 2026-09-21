# quota-trail アカウント別 usage 記録・表示設計書

- 対象: 現行 `docs/design.md` v1 に対するアカウント次元の追加
- スキーマ: v1 → v2
- 作成日: 2026-09-22
- 本書は実装仕様である。既存設計と衝突する場合、アカウント識別・保存・表示に限って本書を優先する。

## 1. 目的、用語、設計上の決定

### 1.1 目的

Claude Code と Codex CLI の usage を、取得時に確認したアカウントへ帰属させて保存する。ダッシュボードでは Claude と Codex を独立にアカウント選択でき、異なるアカウントの点を同じ系列として結ばない。

実 ID はローカル DB には保存する。閉じた通常表示、通常の HTTP API、tooltip、ログには出さないが、アカウントメニューを開いている間の listbox に限って表示する（`docs/design-account-reveal.md` §1・§4.2）。通常表示はプロバイダーごとの安定した匿名ラベルだけを使う。

### 1.2 用語

- **実 ID**: アカウント UUID、メールアドレス、およびそれらを含む profile/JWT/auth オブジェクト。
- **内部 account ID**: `accounts.id` の SQLite 整数主キー。実 IDではないが、通常 API には出さない。
- **account key**: UI/API 用の非機密キー。`claude:1`、`codex:2` のように `provider:alias_no` で構成する。
- **匿名ラベル**: `アカウント1`、`アカウント2`。番号はプロバイダーごとに独立する。
- **unknown**: 取得時にアカウントを安全に同定できなかったサンプル。DB では `samples.account_id IS NULL` とし、既知アカウントへ推測で結び付けない。
- **現在アカウント**: その時点の資格情報と、実際の usage 取得経路から同定したアカウント。DB の永続フラグにはせず、メインプロセスの現在状態として管理する。

### 1.3 主要な決定

1. 正規化済み `Sample` 自体にはアカウントを持たせない。プロバイダーは `{ samples, identity }` という取得バッチを返し、DB 保存境界で `identity` を `accounts.id` に解決する。これにより `normalize.mjs` の純粋性を維持する。
2. Claude は usage と profile に**同じ一回の資格情報スナップショット**を使う。両要求は並行実行してよいが、DB insert はアカウント解決完了後に行う。
3. Codex 主経路は usage 要求に送った `ChatGPT-Account-Id` を帰属先とする。追加 API 呼び出しはしない。
4. unknown は sentinel の `accounts` 行にまとめない。`NULL` のまま保存し、UI では `不明なアカウント` という疑似選択肢でのみ参照する。別々の未知アカウントを一つの既知アカウントとして扱う誤帰属を避けるためである。
5. account key と匿名ラベルは安定採番する。アカウント追加・再起動・表示順変更で既存番号を振り直さない。
6. v1 の既存行だけは、v2 移行直後に同定できた現在アカウントへ一括帰属させる。対象上限の `samples.id` を migration 時に固定し、移行後に生じた unknown 行を後から巻き込まない。
7. HTTP API は selector 未指定時に各プロバイダーの現在アカウントを使う。現在アカウントが不明なら unknown を使い、複数アカウントを暗黙に混ぜない。

## 2. 全体構成とデータフロー

追加する責務は次のとおりとする。

- `src/main/lib/account-identity.mjs`（新規）: UUID・メールの正規化、Codex JWT payload の base64url decode、identity 候補の選択を行う純粋関数。
- `src/main/account-manager.mjs`（新規）: Claude profile キャッシュ、現在アカウント状態、資格情報 fingerprint、DB account upsert の調停を行う。トークンそのものは保持・公開・ログ出力しない。
- 各 provider: 資格情報を一度だけ読み、usage と同じ資格情報に対応する `identity` を返す。
- `db.mjs`: v2 migration、accounts の安定採番、account 条件付き query/latest、旧データ backfill を担う。
- `server.mjs`: account selector を検証し、account 条件を必ず DB query に渡す。

1 tick の流れは次で固定する。

1. Claude/Codex がそれぞれ資格情報を一回読み、変更されないスナップショットを作る。
2. Claude は usage と必要時の profile を同じ access token で取得する。Codex は usage に送る account ID を auth スナップショットから決める。
3. 各 provider は `ProviderBatch` を返す。例外は外へ投げず、usage 失敗は従来どおり error サンプルにする。
4. scheduler は二つの batch を `db.recordPoll(batches)` に渡す。
5. DB は identity があれば account を upsert し、その内部 ID を同じ provider の 2 行へ設定する。identity がなければ `NULL` で保存する。4 行の insert は従来どおり一トランザクションとする。
6. account manager の現在状態とトレイを更新する。実 ID は renderer へ渡さない。

設計上の型は次を基準とする。

```ts
interface AccountIdentity {
  provider: 'claude' | 'codex';
  uuid: string | null;       // 小文字へ正規化
  email: string | null;      // trim + 小文字化
  source: 'claude_profile' | 'claude_local_fallback'
        | 'codex_auth' | 'codex_app_server';
  assurance: 'authoritative' | 'local_fallback';
}

interface ProviderBatch {
  provider: 'claude' | 'codex';
  samples: Sample[];         // 既存の純粋な Sample
  identity: AccountIdentity | null;
}
```

UUID を優先し、UUID がないときだけメールを識別子として使う。`full_name`、`display_name`、organization 名は保存しない。

## 3. アカウント同定の仕組み

### 3.1 Claude Code

#### 権威的な経路

`src/main/providers/claude.mjs` は tick ごとに `~/.claude/.credentials.json`（`CLAUDE_CONFIG_DIR` 指定時はその配下）を一回だけ読み、access token とトップレベル `organizationUuid` をスナップショット化する。

profile が必要な場合は usage と同じヘッダで `GET https://api.anthropic.com/api/oauth/profile` を呼ぶ。`account.uuid` を第一識別子、UUID がない場合だけ `account.email` を識別子とする。`account.uuid` が得られた場合も、明示表示用として `account.email` があれば保存してよい。usage 応答自体からアカウントを推測しない。

usage と profile は同じ token スナップショットを使うため並行取得してよい。保存は両方が完了してから行う。この順序が「その access token の usage と、その token に対する profile を確認した上で記録する」を満たす。

#### キャッシュ

- キー: access token の SHA-256 fingerprint。Node 標準 `node:crypto` のみを使う。
- fingerprint と token はメモリ内限定で、DB・設定・ログへ保存しない。
- 権威的な profile 成功結果の TTL: 60 分。
- `~/.claude.json` fallback または失敗結果の再試行抑制 TTL: 5 分。
- 最大 8 エントリ。最終参照から 24 時間を超えたものを削除する。
- token fingerprint が変わった場合、以前の token の identity を新しい usage へ流用しない。新しい token は即時解決する。
- 同じ fingerprint の権威的キャッシュが期限切れ後に通信失敗した場合、その token と account の結び付き自体は変わらないため、期限切れキャッシュを今回の帰属に使ってよい。ただし次の profile 再試行は 5 分後とする。
- profile が成功して既存キャッシュと異なる UUID を返した場合は成功値へ置き換える。過去サンプルは自動で付け替えない。
- `no_credentials` では現在アカウント状態を unknown に戻す。401/403 では当該キャッシュを stale とし、5 分後に profile を再試行する。

profile は通常、起動時または token 変更時、その後 60 分ごとに最大一回だけ増える。3 分ごとの全 tick では呼ばない。

#### オフライン時の fallback と縮退

profile が得られない場合の順序を固定する。

1. 同じ token fingerprint に対する過去の権威的キャッシュ。
2. `~/.claude.json` の `oauthAccount.accountUuid`、なければ `emailAddress`。
3. identity `null`。

`.credentials.json.organizationUuid` と `~/.claude.json.oauthAccount.organizationUuid` が両方存在して不一致なら fallback を拒否する。片方が欠ける場合は fallback を許すが、`source:'claude_local_fallback'`、`assurance:'local_fallback'` として保存する。後に profile が得られて同じ UUID またはメールと一致すれば同じ account 行を更新する。不一致なら別 account とし、過去の fallback サンプルを推測で移さない。

profile の timeout、ネットワーク断、401、JSON 不正は usage 取得を中止させない。usage が成功すれば既知 identity または `NULL` で ok 行を保存し、usage が失敗すれば同じ帰属規則で error 行を保存する。

### 3.2 Codex CLI 主経路

`src/main/providers/codex.mjs` は tick ごとに `auth.json` を一回読み、usage 要求と identity に同じスナップショットを使う。

帰属先は次の順で決める。

1. `tokens.account_id`。
2. `id_token` payload の `https://api.openai.com/auth` 配下の
   `chatgpt_account_id`。
3. `id_token` payload の `email`。
4. identity `null`。

1 または 2 で account ID を得た場合、その値を `ChatGPT-Account-Id` に送り、その UUID を usage の帰属先とする。`tokens.account_id` と JWT claim が不一致なら、実際にヘッダへ送る `tokens.account_id` を採用し、値を含まない `codex_account_claim_mismatch` だけを warn ログに出す。JWT はローカル auth ファイル由来として payload のみを base64url decode し、署名検証は行わない。decode 失敗は usage 取得を失敗させない。

account ID がなくメールだけの場合は、ヘッダを追加せず従来の usage 要求を行い、同じ auth bundle のメールを fallback identity とする。追加 API 呼び出しは行わない。

### 3.3 Codex app-server fallback

app-server が返した rate limits を、主経路で読んだ古い account ID へ無条件に帰属させてはならない。`src/main/providers/codex-app-server.mjs` は一つの app-server プロセス内で次を行う。

1. spawn 直前の `auth.json` identity を読む。
2. `initialize` 後、`account/read` を要求する。未対応・エラーでも rate limit 取得は続ける。
3. 同じプロセスへ `account/rateLimits/read` を要求する。
4. 応答後の `auth.json` identity を再読する。app-server による refresh 書き戻しを反映する。

帰属は、同一プロセスの `account/read` が UUIDまたはメールを返した場合にそれを最優先する。UUID が返らずメールだけ返った場合、前後 auth のメールと一致すれば auth 側 UUIDまで昇格してよい。`account/read` で識別できない場合は、spawn 前後の canonical UUID（なければメール）が一致するときだけその identity を採用する。前後で account が変わった場合、片側しか読めない場合、値が矛盾する場合は `NULL` とする。

`account/read` の失敗は `account/rateLimits/read` の成功を無効にしない。rate limits は unknown として保存する。これにより fallback 中のログイン切替で系列を誤結合しない。
`account/read` は rate limits と別 JSON-RPC id（例: id 3）で要求する。method not found を含む error や無応答は identity を `null` にするだけであり、rate limits が先に返った場合は account/read を短い猶予（例: 2 秒）だけ待って settle し、全体 20 秒 timeout を消費しない。

### 3.4 現在アカウント状態

account manager は provider ごとに次の状態だけをメモリ保持する。

```ts
{ status: 'pending' | 'known' | 'unknown', accountId: number | null,
  accountKey: string | null, observedAt: number }
```

起動直後は `pending`。初回 identity 解決または初回取得で `known` / `unknown` にする。資格情報が消えた場合は過去の known を表示上の現在アカウントとして残さない。DB の account 行には `is_current` を置かない。アプリ異常終了後に古い current フラグが残ることを防ぐためである。

## 4. DB スキーマと v1 → v2 migration

### 4.1 v2 スキーマ

既存 v1 テーブルに次を追加する。SQL は better-sqlite3 と `node:sqlite` の共通同期 API（`exec`、`prepare().all()`、`prepare().run()`）だけを使う。

```sql
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  account_uuid TEXT,
  email TEXT,
  alias_no INTEGER NOT NULL,
  identity_source TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_provider_uuid
  ON accounts (provider, account_uuid);
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_provider_email
  ON accounts (provider, email);
CREATE UNIQUE INDEX IF NOT EXISTS ux_accounts_provider_alias
  ON accounts (provider, alias_no);

ALTER TABLE samples
  ADD COLUMN account_id INTEGER;

CREATE INDEX IF NOT EXISTS idx_samples_account_series_time
  ON samples (provider, account_id, win, observed_at, id);

CREATE TABLE IF NOT EXISTS account_backfill_v2 (
  provider TEXT PRIMARY KEY,
  through_sample_id INTEGER NOT NULL,
  state TEXT NOT NULL,
  target_account_id INTEGER,
  attempted_at INTEGER
);
```

`ALTER TABLE` は `PRAGMA table_info(samples)` で `account_id` がない場合だけ実行する。`account_uuid` と `email` はアプリ側で小文字化してから保存する。SQLite の `UNIQUE` が複数の `NULL` を許容する性質を利用し、UUIDなし・メールあり、および UUIDあり・メールなしの双方を扱う。

`PRAGMA foreign_keys = ON` は設定しない。既存 DB は foreign key OFF で運用されており、better-sqlite3 と node:sqlite の ALTER TABLE 制約差によるリスクに比べ、account を削除する機能がないため利得がない。参照整合性はアプリ側の upsert ロジックで担保する。既存の `idx_samples_series_time` は migration 失敗時の v1 縮退と旧クエリのため残す。

### 4.2 account upsert と安定採番

identity の照合順は provider + UUID、次に provider + email とする。

- UUID 一致行があればそれを使い、未使用の email と source、`last_seen_at` を更新する。
- UUID 一致がなく、email 一致行の `account_uuid` が `NULL` なら同じ行へ UUID を補完する。これにより email fallback から authoritative UUID へ昇格しても匿名番号を保つ。
- UUID 行と email 行が別々に既に存在する矛盾では、自動 merge しない。UUID 行を現在の帰属先とし、email が衝突する更新は行わず、値なしの警告コードだけをログする。誤った過去データ移動より重複表示を選ぶ。
- 一致がなければ同じ DB transaction 内で `MAX(alias_no) + 1` を provider 単位に採番して insert する。

`alias_no` は更新・再利用しない。account を削除しないため、番号は再起動や新規アカウント追加で変わらない。

### 4.3 migration の具体手順

`openDb()` は次の順で実行する。

1. DB を開き、WAL、`synchronous=NORMAL` を設定する（`foreign_keys=ON` は設定しない）。
2. v1 の `schema_version` と `samples` を `CREATE TABLE IF NOT EXISTS` で保証する。version は `SELECT MAX(version)` で読む。
3. 実スキーマを `PRAGMA table_info` で確認する。version 値だけを信用しない。
4. v2 が未完成なら `BEGIN`。`accounts` と unique indexes、`account_backfill_v2` を作る。
5. provider ごとに migration 開始時点の `MAX(samples.id)` を取得し、backfill 行を `INSERT OR IGNORE` する。既存行がゼロなら state を `assigned`、それ以外は `pending` とする。
6. `samples.account_id` がなければ一回だけ `ALTER TABLE ... ADD COLUMN` を実行する。
7. account-aware index を作る。
8. `schema_version` を一行に正規化するため `DELETE FROM schema_version` 後に version 2 を insert し、`COMMIT` する。
9. 起動時 account 解決を Claude/Codex 並行で一回行う。backfill state が `pending` の provider について、identity が既知なら account を upsert し、まず `target_account_id` と state `targeted` を transaction で固定する。その後、次を別 transaction で実行して state を `assigned` にする。

```sql
UPDATE samples
SET account_id = ?
WHERE provider = ?
  AND account_id IS NULL
  AND id <= ?;
```

10. 起動時に同定できなければ、state を `unresolved` として `attempted_at` を記録し、既存行は `NULL` のままにする。後日の別アカウントへ自動 backfill しない。

`targeted` は、更新途中でプロセスが終了しても次回起動時に同じ `target_account_id` で再開するための状態である。UPDATE と state 更新は冪等である。`assigned` / `unresolved` は再実行しない。これにより、migration 後の unknown 行や後日切り替えたアカウントを旧データへ誤適用しない。

### 4.4 migration 失敗時の起動継続

構造 migration の例外時は `ROLLBACK` し、v1 用 prepared statements で `accountDimensionAvailable:false` の縮退モードを構成する。アプリ、usage 取得、v1 形式での insert、既存ダッシュボード、トレイは起動を続ける。`/api/meta` は安全な boolean `accountDimensionAvailable:false` を返し、account selector は disabled の `アカウント情報を利用できません` とする。次回起動時に migration を再試行する。

失敗ログには migration の段階名と SQLite error code だけを出し、SQL parameter、DB 行、identity は出さない。v1 縮退中はアカウント混在を避けられないため、UI に `DB移行未完了のためアカウント別表示は無効` と明示する。

backfill だけが失敗した場合は v2 の通常記録を続ける。target が固定済みなら次回再開し、未固定のまま identity 解決が失敗した場合は `unresolved` とする。

### 4.5 `db.mjs` API

v2 の主 API を次で固定する。

```ts
recordPoll(batches: ProviderBatch[]): number
listAccounts(): AnonymousAccountRow[]
resolveAccountKey(provider, accountKey): number | null | 'invalid'
querySamples({ provider, win, accountId, from, to }): Sample[]
queryAllSeries({ from, to, accountIdsByProvider }): Record<string, Sample[]>
latest({ accountIdsByProvider }): Record<string, Sample | null>
finishV2Backfill(provider, identity): BackfillResult
```

`accountId:null` は unknown を意味し、SQL は `account_id IS NULL` を使う。既知 account は `account_id = ?` を使う。範囲内、直前 1 点、直後 1 点の三つすべてに同じ account 条件を付け、`ORDER BY observed_at, id` を使う。

## 5. 匿名ラベルの割り当て規則

匿名番号は**プロバイダーごとに独立**する。Claude の最初のアカウントと Codex の最初のアカウントはいずれも `アカウント1` である。二つの dropdown は別々であり、全体通し番号に利用者上の意味がないためである。

- 初見 identity を account table に insert した時点で `alias_no = provider 内の MAX + 1` を付ける。
- 表示順は `alias_no ASC`。
- UUID、メール、最終利用時刻による並べ替えや再採番はしない。
- `accountKey` は `provider:alias_no`、表示は `アカウント<alias_no>`。
- unknown は DB 採番外の `provider:unknown` / `不明なアカウント` とする。後に identity が判明しても過去の unknown 行は自動移動しない。
- 現在アカウントには UI が `（現在ログイン中）` を付ける。この文言も実 ID を含まない。
- 匿名 label は、閉じたトリガーの表示文言と、開いたアカウントメニュー内の行とを結び付ける対応キーでもある（`docs/design-account-reveal.md` §2.1）。

## 6. HTTP API の変更

### 6.1 account selector

既存 endpoint に任意 query parameter を追加する。

```text
GET /api/samples?from=<ms>&to=<ms>
                 &claude=claude%3A1
                 &codex=codex%3A2
GET /api/latest?claude=claude%3A1&codex=codex%3A2
```

- selector 省略時は request 処理開始時点の現在 account key を provider ごとに使う。
- 現在 account が unknown の場合は `provider:unknown` を使う。
- key が存在しない、または provider と prefix が一致しない場合は 400 とし、入力値を error 本文やログへ反射しない。
- `samples` と `latest` の既存レスポンス形 `series["provider/window"]` は変えない。旧 renderer は selector なしで現在アカウント分を受け取れる。
- Sample JSON に `account_id`、UUID、メールを追加しない。必要なら top-level に匿名の `selection: {claude:'claude:1', codex:'codex:2'}` だけを返す。
- 1 系列 50,000 行の間引きは account filter 後に行う。

selector なしの動作を「全 account の最新」にはしない。後方互換のレスポンス形を保ちながら、新版で最も安全な既定値である現在アカウントへ意味を変更する。

### 6.2 account 一覧

新設する通常 endpoint は次の形とする。

```json
{
  "providers": {
    "claude": {
      "resolution": "known",
      "currentAccountKey": "claude:1",
      "accounts": [
        { "accountKey": "claude:1", "label": "アカウント1", "isCurrent": true, "kind": "known" },
        { "accountKey": "claude:2", "label": "アカウント2", "isCurrent": false, "kind": "known" },
        { "accountKey": "claude:unknown", "label": "不明なアカウント", "isCurrent": false, "kind": "unknown" }
      ]
    },
    "codex": {
      "resolution": "unknown",
      "currentAccountKey": "codex:unknown",
      "accounts": [
        { "accountKey": "codex:unknown", "label": "不明なアカウント", "isCurrent": true, "kind": "unknown" }
      ]
    }
  },
  "now": 0
}
```

設定 `revealAccountIdentifiersInAccountMenu` が有効な場合（既定 true）、この応答の top level に process-scoped nonce `identifierAccessToken` を追加する。無効な場合はこのフィールドを含めない（`docs/design-account-reveal.md` §3.3・§3.6）。

`GET /api/accounts` は UUID、メール、DB の整数 ID、名前、organization を**設定にかかわらず一切返さない**。unknown 選択肢は unknown 行が存在する場合、または現在 resolution が unknown の場合に含める。migration 縮退時は `available:false` を返す。

`/api/meta` には `accountDimensionAvailable` と `canRevealAccountIdentifiersInAccountMenu` の boolean だけを追加する。実 ID は含めない。この boolean 名は旧 `canRevealAccountIdentifiers` を置き換えたものである（`docs/design-account-reveal.md` §3.5）。

### 6.3 実 ID を配信する endpoint

本節は `docs/design-account-reveal.md` §3 の内容へ全面置き換えられた。詳細は同書を参照する。要点は次のとおりである。

単件の `GET /api/account-identifier` は廃止し、常に 404 を返す。代わりに、全既知アカウントの表示用識別情報を一括で返す次の endpoint を新設する。

```text
GET /api/account-identifiers
X-Quota-Trail-Identifier-Token: <process-scoped nonce>
```

設定 `revealAccountIdentifiersInAccountMenu` が有効で、account dimension が利用可能で、この header が `/api/accounts` から渡された process-scoped nonce と一致する場合だけ 200 を返す。条件が一つでも不成立なら理由を区別せず 404 `{ "error": "not found" }` とする。

成功応答は provider ごと・匿名 accountKey ごとに `{kind:'email'|'uuid', value}` を返す。メールがあればメールだけを、なければ UUID だけを返す。`unknown` は実 ID を持たないため応答へ含めない。レスポンスには `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を付ける。

この endpoint はアカウントメニューを開く前の先読みと、開いている間の表示専用に使う。旧来の「利用者が個別 account の確認操作をした後に一件だけ取得する」明示的確認ダイアログの方式（`実IDを確認` ボタン、モーダルダイアログ、設定 `revealAccountIdentifiers`）は廃止した（`docs/design-account-reveal.md` §3.5）。

## 7. レンダラーの変更

### 7.1 配置

現行の一つの 2×2 grid を provider group 二つへ分ける。

```text
Claude Code                         [表示アカウント: アカウント1（現在ログイン中）]
┌ Claude 5h ───────────────────┐  ┌ Claude Weekly ───────────────┐
└──────────────────────────────┘  └──────────────────────────────┘

Codex CLI                           [表示アカウント: アカウント2]
┌ Codex 5h ────────────────────┐  ┌ Codex Weekly ────────────────┐
└──────────────────────────────┘  └──────────────────────────────┘
```

各 provider header に `<label>` と、匿名表示の `<button aria-haspopup="listbox">` を一つ置き、その直下に当該 provider の二つのグラフを置く。狭幅では header と二つのグラフを一列にする。

ネイティブ `<select>` は使わない。閉じたボタンの text node は常に匿名ラベルと現在項目の `（現在ログイン中）` だけから作り、開いたときだけカスタム listbox を `document.body` 直下へ追加する。listbox は button の `getBoundingClientRect()` を基準に viewport 内へ配置し、左右上下を viewport から 8 CSS px 以上離す形で clamp する（`docs/design-account-reveal.md` §2.4・§5.2）。

### 7.2 初期選択と永続化

`localStorage` を `quota-trail.ui.v2` に上げ、既存の期間・panel 設定を v1 key から一回読み継ぐ。追加する値は provider ごとの account key だけであり、実 ID は保存しない。

- 初回表示: 現在 account。現在 unknown なら `不明なアカウント`。
- 利用者が選択後: 選んだ account key を provider ごとに保存し、再起動・ブラウザ再表示後も同じ選択を復元する。
- 保存 key が一覧に存在しない場合: 現在 account、次に最小 alias の account、最後に unknown の順で選ぶ。
- ログイン account が後から変わっても、利用者が明示選択した過去 account を勝手に切り替えない。新しい現在 account は option の `（現在ログイン中）` と provider header の status で知らせる。

これにより「既定は現在ログイン中」と「過去 account を選んだ状態の再起動後保持」を両立する。

閉じたボタンの表示文言は、選択内容にかかわらず匿名 label（または `不明なアカウント`）と `（現在ログイン中）` だけから作り、実 ID を含まない（`docs/design-account-reveal.md` §5.1）。

### 7.3 取得と切替

起動時は `/api/meta` と `/api/accounts` を先に読み、選択を決めてから `/api/samples` と `/api/latest` を読む。`/api/accounts` から process-scoped nonce `identifierAccessToken` を受け取った場合、この先読みを待たせずに `/api/account-identifiers` も直ちに先読みし、結果を中央 `state` とは別の専用メモリキャッシュへ保存する（`docs/design-account-reveal.md` §3.6・§4.1）。

account listbox で選択を確定した時（Enter、Space、または option の pointer click。矢印移動などの active 移動だけでは確定しない）は次を同一処理で行う。

1. 対象 provider の 2 系列の `data` と `latest`、hover を即時 clear し、古い値を新ラベルの下に一瞬でも表示しない。
2. account key を localStorage に保存する。
3. 進行中 fetch を `AbortController` で中止し、既存の sequence 番号も進める。
4. Claude/Codex 両 selector を付けて samples/latest を再取得する。
5. 同じ response generation の結果だけを state へ反映し、2 chart を一度に再描画する。

listbox は clear 処理より先に remove する。

60 秒更新時には account 一覧に加え、実 ID の専用キャッシュもバックグラウンドで再取得する。現在 account の marker は更新するが、保存済み表示選択は上書きしない。listbox が開いている間に 60 秒更新が到着した場合、account 一覧と実 ID キャッシュの表示反映は閉じるまで保留する（`docs/design-account-reveal.md` §3.6）。

header の現在値 4 件とリセット予定は、各 provider で選択中の account の `/api/latest` を使う。「現在ログイン中」の account と「表示中」の account が違う場合、provider header に `現在ログイン中: アカウントN` と匿名表示する。

### 7.4 accessibility

- provider group は `section` + `aria-labelledby`、閉じたボタンと開いた listbox は可視 `<label>` で関連付ける。
- 現在 account status は `aria-live="polite"`。データ再取得中は group に `aria-busy="true"` を付ける。
- account の確定操作は標準 `<select>` の keyboard 操作ではなく、`docs/design-account-reveal.md` §6 のカスタム listbox 操作（`role="listbox"`、`aria-activedescendant`、Enter/Space/矢印/Home/End/PageUp/PageDown/typeahead/Escape/Tab）と ARIA 仕様に従う。
- unknown、読込中、migration 縮退、取得失敗を色だけで表現しない。
- option、`aria-label`、`aria-description`、`title` に実 ID を使わない。

### 7.5 アカウントメニュー内の実 ID 表示

本節は `docs/design-account-reveal.md` §3.5・§4 の内容へ全面置き換えられた。詳細は同書を参照する。

既存の実 ID 確認ダイアログ（`実IDを確認` ボタン、確認 dialog、modal dialog、`revealIdentifier`、`showIdentifierDialog`、`discardIdentifierDialog`）と設定 `revealAccountIdentifiers` は廃止した。代わりに、設定 `revealAccountIdentifiersInAccountMenu`（既定 true）が有効な間、アカウントメニューを開いている間だけ、開いた listbox の各行に実 ID（メール優先、なければ UUID の先頭 8 文字・末尾 4 文字表示）を表示する。閉じたボタンには実 ID を一切表示しない。

listbox を閉じる操作（確定、Escape、外側クリック、Tab、window blur）では、実 ID を含む DOM node を `hidden` にせず `remove()` する。実 ID は中央の通常 `state`、永続化 state、localStorage、canvas、tooltip、title、data attribute には複製しない。

## 8. 身バレ防止とログ方針

### 8.1 通常表示・DOM・API

- 閉じたトリガー（button）: `アカウントN` と任意の `（現在ログイン中）` だけ。実 ID キャッシュを参照せずに生成する。
- 開いたアカウントメニュー（listbox）: 各行に実 ID を表示する。option の `id` は provider と匿名 accountKey だけから作り、実 ID を DOM 属性へ埋め込まない。実 ID を含む DOM node は listbox が開いている間だけ存在し、閉じる操作では `remove()` する（`hidden` にしない）。この記述は「開閉にかかわらず匿名表示」だった旧仕様からの変更である。
- 通常 API: 実 ID を含めない。旧「renderer の通常 state に実 ID が入らない」という不変条件は、起動時先読みにより実 ID が事前に renderer メモリへ存在するため維持できない。renderer 内の実 ID メモリ境界と生存条件は `docs/design-account-reveal.md` §4（4.1 の境界、4.2 の 12 個の不変条件）に従う。
- chart tooltip、凡例、header chip、エラー文、footer、HTML `title`、ARIA、`data-*` に実 ID を入れない。
- UUID/メールを含む provider response や JWT payload を renderer へ丸ごと渡さない。
- DB path は現行互換の `/api/meta.dbPath` を当面維持するが、公開スクリーンショットで Windows user 名が出る副次リスクを避けるため、renderer footer はフルパスを表示せず `DB: quota-trail.sqlite` と backend 名だけを表示する。

### 8.2 ログ

通常ログで account を区別する必要がある場合は `provider` と匿名 `accountKey` / `アカウントN` だけを使う。実 ID の一部表示や末尾 4 桁表示は行わない。メールは短く総当たり可能であり、UUIDの一部も公開ログの相関キーになるためである。

`logger.mjs` の防御的 sanitize 対象に `account_id`、`accountId`、`account_uuid`、`accountUuid`、`email`、`emailAddress`、`id_token`、`sub`、`profile` を追加する。さらに string 値中の Bearer token、一般的な UUID、メール形式を `[REDACTED]` に置換する。ただし第一防衛は「provider が raw response、headers、auth JSON、例外本文を logger に渡さず、固定 error code へ変換する」ことである。

profile/JWT/auth の parse error、claim mismatch、fallback 不一致、account upsert 衝突は固定コードだけをログする。`GET /api/account-identifiers` の access log にも request header（nonce を含む）、query 値、response body を残さない。nonce と、renderer の実 ID 専用メモリキャッシュの内容はログへ入れない（`docs/design-account-reveal.md` §3.3・§4.2 不変条件 8）。

### 8.3 ローカル保存

実 ID は account 帰属のため SQLite に平文保存する。追加暗号化依存は導入しない。DB は既存どおり Electron `userData` 配下に置き、API は `127.0.0.1` bind、CORS なし、読み取り専用を維持する。token、token fingerprint、JWT 全文、profile 全文は DB に保存しない。

renderer 側では実 ID を永続化しない。localStorage、sessionStorage、URL、query parameter、履歴 state、clipboard のいずれにも実 ID を自動保存せず、実 ID を保持できるのは account menu controller の専用メモリキャッシュだけとする（`docs/design-account-reveal.md` §4.1・§4.2 不変条件 6）。

## 9. 既存機能への影響

アカウントメニューをカスタム listbox 化した変更（`docs/design-account-reveal.md`）後も、tray と chart（gaps、resets、decimation を含む）の挙動はこの節の記述のまま変わらない。listbox の active option 移動中は chart を clear せず fetch もしない。account 確定時（Enter、Space、pointer click）と 60 秒更新時だけ、対象 provider の系列を clear・再取得する（`docs/design-account-reveal.md` §7.2・§7.3）。

### 9.1 `latest()` とトレイ

`latest()` は account selection を必須引数にし、各 provider で選択された account の 5h/weekly だけを返す。トレイは renderer の保存選択ではなく、account manager の**現在 account**を使う。現在が unknown なら unknown 行だけを見る。過去 account の最新値を現在値として代用しない。

トレイ tooltip に account 実 ID は出さない。必要なら `Claude（アカウント1）` の匿名ラベルだけを付ける。migration 縮退時だけ従来の provider 全体 latest を使い、account 別表示が無効であることを短く示す。

### 9.2 gaps、resets、chart

`shared/gaps.mjs`、`shared/resets.mjs`、`renderer/chart.mjs` のアルゴリズムは変更しない。入力配列を DB/API で一 account に限定する。

- `querySamples` の範囲外直前・直後 1 点にも account 条件を付ける。
- account A の末尾と account B の先頭を折れ線で結ばない。
- account 切替期間は、選択した account にサンプルがなかった時間として `computeGaps` が欠測表示する。
- `pastResets` は同一 account の隣接点だけを見るため、account 切替による usage 低下をリセットと誤判定しない。
- 次回リセット線・header の reset 表示も選択 account の latest だけを使う。
- decimation は account filter 後に行う。

### 9.3 scheduler と正規化

scheduler の常時ポーリング、single-flight、429 時だけ次回 2 倍、resume/unlock の即時 tick は維持する。identity 解決失敗を理由に tick を延期・中止しない。

`normalize.mjs` の `Sample` と各 normalize 関数には I/O や account lookup を入れない。account identity の構文処理も I/O から分離した純粋関数としてテストする。既存の `seriesKey` は画面内の4パネル識別として維持し、DB の一意な系列概念だけを `(provider, account_id, win)` に拡張する。

### 9.4 account 切替時の境界動作

資格情報は tick ごとに読み直す。token/account ID が変わった tick から新 account へ保存する。同じ tick 内でファイルが書き換わっても、usage と identity は開始時の同一スナップショットを使う。

identity が解決できなかった tick は unknown に入り、後で判明した account へ自動移動しない。この保守的な欠測は許容し、誤った account の連続線を作らないことを優先する。

## 10. テスト計画

アカウントメニューと実 ID 開示ダイアログに関する試験は `docs/design-account-reveal.md` §9 へ置き換えられた（`tests/account-menu.test.mjs`、および `tests/server.test.mjs`・`tests/config.test.mjs`・`tests/db.test.mjs`・`tests/account-selection.test.mjs`・`tests/logger.test.mjs` の該当ケース）。本節はそれ以外（account 同定、DB migration、gaps/resets/chart、normalize）の試験を維持する。

### 10.1 `tests/account-identity.test.mjs`（新規）

- UUID優先、UUIDなし時のメール fallback、trim・小文字化。
- Codex JWT payload の base64url decode、padding 有無、不正 payload。
- `tokens.account_id` と claim 一致・不一致・欠落時の決定。
- Claude organization 一致・不一致時の local fallback 採否。
- identity 候補に token/profile の余分なフィールドが残らないこと。

### 10.2 `tests/providers-accounts.test.mjs`（新規）

一時 credential file、差し替え可能な `fetch`、時計を使い、追加依存なしで検証する。

- Claude usage/profile が同じ token snapshot を使い、profile の UUIDを返す。
- profile TTL 内は再要求せず、60 分後、token 変更時、stale 化後に再要求する。
- profile timeout/401/parse でも usage サンプルを返す。
- 同 token の権威キャッシュ、`.claude.json` fallback、最終 unknown の順序。
- Codex が送った account ID と返す identity が一致する。
- JWT decode 失敗・account ID 不一致でも token/ID をログへ出さない。
- app-server の `account/read` 成功、未対応、前後 auth 一致、不一致を検証し、不一致は unknown になる。

### 10.3 `tests/db.test.mjs`（拡張）

- 空 DB が v2 になり、再 open しても schema と version が変わらない。
- 実際の v1 fixture を作り、v2 へ migration して既存行が cutoff 以下だけ backfill される。
- migration 後に追加した unknown 行が backfill に巻き込まれない。
- 起動時 identity 不明なら旧行が NULL、state が `unresolved` になり、次回別 account で開いても移らない。
- `targeted` 状態からの再開が同じ account を使う。
- provider 独立採番、再起動後の番号安定、新 account 追加で既存番号不変。
- email fallback 行へ同一 UUID を補完しても alias 不変。
- UUID/email 衝突時に自動 merge しない。
- known/unknown の insert、query、latest が分離される。
- 範囲外前後 1 点が別 account から混入しない。
- migration を意図的に失敗させた fixture で v1 縮退 API が insert/query でき、次回再試行可能。

DB テストは backend 選択を注入できるようにし、better-sqlite3 と `node:sqlite` の双方で同じケースを実行する。利用不能な runtime の backend は理由付き skip とし、Windows/Electron の release 検証では両方を一度ずつ通す。

### 10.4 `tests/server.test.mjs`（拡張）

- selector あり/なし、provider 不一致、不明 key、unknown key。
- selector なしが現在 account を選び、複数 account を混ぜない。
- `/api/accounts` が安定 key・匿名 label・current marker を返す。
- 通常 endpoint（`/api/accounts`、`/api/samples`、`/api/latest`）の JSON 全文に fixture の UUID/メールが含まれない。
- 実 ID batch endpoint の試験は `docs/design-account-reveal.md` §9.2 を正とする（`GET /api/account-identifiers` の nonce・設定・account dimension gate、旧単件 `GET /api/account-identifier` の 404 化を含む）。
- `/api/latest` と `/api/samples` の従来 `series` shape が維持される。
- account filter 後の decimation。

### 10.5 既存テストの変更

- `tests/config.test.mjs`: `revealAccountIdentifiersInAccountMenu` の既定 true・旧 `revealAccountIdentifiers` からの migration・boolean 健全化は `docs/design-account-reveal.md` §9.4 を正とする。
- `tests/normalize.test.mjs`: Sample に account I/O を持ち込まず既存結果が不変である回帰。
- `tests/gaps.test.mjs` / `tests/resets.test.mjs`: DB で account ごとに分離した入力では、非アクティブ期間が gap になり、別 account の使用率低下を reset として渡さない結合テストを追加。
- `tests/logger.test.mjs`（新規）: token、UUID、メール、profile object、文字列中の実 ID がログに残らず、匿名 account key は残る。
- renderer の account 選択規則を小さな純粋 module に分け、`tests/account-selection.test.mjs`（新規）で初回 current、保存選択復元、無効 key fallback、URL selector 作成を検証する。

### 10.6 手動受け入れ試験（Windows 11 / PowerShell）

1. v1 DB のバックアップコピーで起動し、行数が減らず version 2 になることを確認する。
2. Claude/Codex をそれぞれ account A → B → A と切り替え、匿名番号が固定され、各 graph に他 account の点が現れないことを確認する。
3. オフラインで起動し、usage/error 行の記録とアプリ起動が継続し、unknown が選べることを確認する。
4. アカウントメニューを閉じた画面の screenshot、Elements、title、ARIA、canvas tooltip、ログ、通常 API response に UUID/メールがないことを検索する。開いた listbox の実 ID 表示と close 後の消去は `docs/design-account-reveal.md` §9.7 の手動試験を正とする。
5. `revealAccountIdentifiersInAccountMenu` 設定 false/true、listbox close 後の DOM 消去、再読込後に実 ID が残らないことを確認する（`docs/design-account-reveal.md` §9.7）。
6. `node --test tests/` を実行し、可能な環境では backend を切り替えて DB suite を二回実行する。

## 11. 実装手順（ファイル単位・受け入れ条件付き）

実装は次の順序で行う。各段階の受け入れ条件を満たしてから次へ進む。

1. **`src/main/lib/account-identity.mjs` を追加し、`tests/account-identity.test.mjs` を追加する。** 受け入れ条件: UUID/email/JWT/fallback の全決定が純粋関数で再現でき、token を返り値へ含めない。
2. **`src/main/db.mjs` に v2 schema、実スキーマ検査、migration 縮退、account upsert、backfill state を実装し、`tests/db.test.mjs` を拡張する。** 受け入れ条件: v1 DB の行を失わず v2 化でき、再実行して差分がなく、known/unknown/account 間 query と latest が完全分離し、両 backend の共通 API だけを使う。
3. **`src/main/account-manager.mjs` を追加する。** 受け入れ条件: provider ごとの pending/known/unknown、匿名 key、Claude cache TTL/無効化、起動時 backfill 調停を一か所で扱い、実 ID を公開用 DTO に含めない。
4. **`src/main/providers/claude.mjs` を batch 返却へ変更する。** 受け入れ条件: usage/profile が同じ credential snapshot を使い、profile 失敗でも usage/error samples を返し、60 分 cache と 5 分 retry がテストで確認できる。
5. **`src/main/providers/codex.mjs` と `src/main/providers/codex-app-server.mjs` を変更する。** 受け入れ条件: 主経路は送信 account ID に帰属し、app-server は同一 process の account/read または前後一致時だけ帰属し、判定不能時も unknown の rate-limit samples を返す。
6. **`src/main/scheduler.mjs` を `ProviderBatch` と `db.recordPoll` に接続する。** 受け入れ条件: 4 行一 transaction、identity 失敗時も insert、既存 single-flight/429/resume 動作が維持される。
7. **`src/main/config.mjs` と `src/main/logger.mjs` を更新し、関連テストを追加する。** 受け入れ条件: `revealAccountIdentifiersInAccountMenu` は既定 true（`docs/design-account-reveal.md` §3.5。旧 `revealAccountIdentifiers` の既定 false から変更された）、不正値は既定値へ丸める、固定 error code と匿名 key 以外の実 ID/secret がログに出ない。
8. **`src/main/index.mjs` の起動順を更新する。** DB 構造 migration 後、初回 identity 解決と backfill finalization を行い、その成否にかかわらず server/tray/scheduler を起動する。受け入れ条件: profile timeout、backfill 失敗、migration 縮退の各ケースで常駐アプリが終了しない。
9. **`src/main/server.mjs` と `tests/server.test.mjs` を更新する。** 受け入れ条件は `docs/design-account-reveal.md` §10 手順 4 に従う: account selector、匿名一覧、`GET /api/account-identifiers` の process nonce・設定 gate・batch 応答・no-store、旧単件 endpoint の 404、従来 response shape、入力値非反射がテストで保証される。
10. **`src/shared/account-menu.mjs`（純粋関数）と `src/renderer/index.html`、`app.mjs`、`style.css` を provider group とアカウントメニュー対応へ変更する。** 受け入れ条件は `docs/design-account-reveal.md` §10 手順 1・6〜9 に従う: ネイティブ `<select>` と実 ID dialog を除去し button + listbox に置き換える、各 provider の二 graph 上に一メニュー、初回 current、再起動後の選択復元、起動時先読み・専用 cache・60 秒更新中の適用保留、確定時だけの即時 clear と stale response 排除、keyboard/focus/pointer lifecycle、320〜1920px でのレイアウト維持。
11. **不要になった旧 reveal dialog と旧 API の参照をリポジトリ全体から除去する。** 受け入れ条件は `docs/design-account-reveal.md` §10 手順 10 に従う: `revealIdentifier`、`discardIdentifierDialog`、旧設定名 `revealAccountIdentifiers`、旧単件 endpoint `GET /api/account-identifier` の成功経路が残らず、旧 endpoint の 404 互換性試験だけが残る。
12. **`src/main/tray.mjs` と `src/main/index.mjs` の latest 呼び出しを現在 account 対応にする。** 受け入れ条件: renderer で過去 account を選んでも tray は現在 account を示し、実 ID を tooltip に含めない。
13. **結合・回帰試験を行う。** 受け入れ条件: `node --test tests/`、v1 DB コピー migration、A→B→A 切替、オフライン、通常/reveal privacy の手動試験をすべて満たす。失敗時も元 DB が開けることをバックアップコピーで確認する。

## 12. 仮説の判断

### H-001: Codex rollout の `rate_limits` を副次データ源にする

**却下。** 本変更では account 帰属を、usage を取得した資格情報または同一 app-server process へ結び付けられることを保存条件にする。rollout の `rate_limits` について、当該イベントと account ID の権威的な対応は本要件で確認されていない。採用すると高頻度データの利点より account 混在リスクが大きい。また現行 3 分ポーリングで本要件は満たせる。

将来再検討する場合も、rollout ごとに account ID を同じ信頼境界から得られ、`(provider, account, window)` へ確実に保存できることを先に実証条件とする。

### H-002: idle / ロック中でもポーリングを止めない

**採用。** account 次元を追加しても、idle/lock 中の取得を止める理由はない。停止すると選択 account の履歴に欠測が増え、CLI を動かしたまま離席する用途を損なう。現行どおり常時取得し、sleep による実際の欠測は gap として表示し、resume/unlock で即時 tick する。identity 解決失敗も停止条件にはしない。

## 13. 完了条件

1. 新規 sample は known account または明示的 unknown のいずれかで保存され、異なる known account が同一 query 系列へ混入しない。
2. v1 DB は行を失わず冪等に v2 化され、失敗時も v1 縮退で起動・記録を続ける。
3. Claude/Codex の二 graph ごとに一つの account dropdown があり、初回は現在 account、以後は利用者の選択を復元する。
4. 閉じたトリガーは常に匿名表示であり、開いたアカウントメニュー（listbox）だけが実 ID を表示する。通常 API、閉じた DOM の属性、tooltip、エラー、ログに UUID/メール/token が出ない（`docs/design-account-reveal.md` §12 完了条件 1・6・7）。
5. 実 ID は起動時先読み後、既定有効（`revealAccountIdentifiersInAccountMenu`）の設定のもとで通常の最初のメニュー open から即時表示される。実 ID は専用メモリキャッシュと開いている option の text node 以外へ出ず、listbox の remove により close 後の DOM/state から消える（`docs/design-account-reveal.md` §12 完了条件 5・6・7）。
6. latest、トレイ、gap、reset、境界点、decimation のすべてが account filter 後のデータだけを扱う。
7. 追加 npm 依存がなく、`normalize.mjs` と shared の純粋関数方針を維持する。
