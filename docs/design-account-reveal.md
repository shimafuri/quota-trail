# quota-trail アカウントメニュー内実 ID 表示設計書

- 対象: `docs/design-accounts.md` のアカウント選択 UI と実 ID 開示方式
- 作成日: 2026-09-22
- 対応環境: Windows 11 / Electron 38 / Chromium
- 本書は設計書であり、実装コードは含まない。
- 本書は `docs/design-accounts.md` を直接変更しない。
- 本書と `docs/design-accounts.md` が衝突する場合、アカウント選択 UI、実 ID 配信、実 ID の renderer 内ライフサイクル、関連設定について本書を優先する。

## 1. 目的と決定事項

アカウント選択メニューを開いている間だけ、匿名ラベルとログイン識別情報の対応を確認できるようにする。

閉じたトリガーには、選択中のアカウントについても `アカウント1` のような匿名ラベルだけを表示する。

この条件は画面公開時の身バレ防止に直結するため、実 ID の取得失敗、再描画、フォーカス移動、アニメーション中を含めて例外を設けない。

本変更の決定は次のとおりとする。

1. ネイティブ `<select>` を廃止し、匿名表示の `<button>` とカスタム listbox に置き換える。
2. 既存の単件 `/api/account-identifier` を廃止し、全既知アカウントの表示用識別情報を返す `/api/account-identifiers` を新設する。
3. 実 ID は `/api/accounts` へ混ぜない。
4. 実 ID は account 一覧取得直後に先読みし、専用の renderer メモリキャッシュへ置く。
5. 中央の通常 `state`、永続化 state、閉じた DOM には実 ID を置かない。
6. 表示はメールアドレスを優先し、メールがないアカウントだけ UUID の短縮表示を使う。
7. 既存の実 ID dialog と `revealAccountIdentifiers` は廃止する。
8. 新しい opt-out 設定 `revealAccountIdentifiersInAccountMenu` を導入し、既定値を `true` とする。
9. 旧設定が `false` の既存環境でも新設定が未定義なら `true` へ移行する。
10. 追加の npm 依存は導入しない。

## 2. 論点 1: UI 方式の選定

### 2.1 決定

方式 B のカスタム listbox を採用する。

閉じた状態と開いた状態を別々の DOM として構築できることが決定理由である。

閉じた `<button>` は匿名 DTO の `label` だけから生成する。

開いた listbox の option は、匿名 DTO と専用実 ID キャッシュを `accountKey` で結合して生成する。

この構造なら、開いた option の文言を変更しても閉じたボタンの text node は変化しない。

したがって、閉じた表示へ実 ID が一瞬だけ現れる経路自体を作らずに済む。

### 2.2 方式 A を採用しない理由

`mousedown` や `keydown` で `<option>.textContent` を差し替える方式は採用しない。

ネイティブ `<select>` の閉じた表示は選択中 option の text に依存するため、差し替えから OS popup の表示までの間に閉じたボックスへ実 ID が描画される可能性がある。

`change`、`blur`、`pointerup` のいずれを復元契機にしても、選択確定から復元まで実 ID が残るフレームを排除できない。

Escape で閉じる場合、外側クリックで閉じる場合、ウィンドウが非アクティブになる場合は、`change` が発生しない。

Alt+Down、F4、Space、文字キーによる typeahead では、pointer 系イベントを経由しない。

Chromium が `<option>` の内容を OS popup 用に取得する時点は Web API の契約ではない。

差し替え後すぐ匿名へ戻す方法も、popup が実 ID 版と匿名版のどちらを取得するかを保証できない。

以上から、方式 A は「閉じた状態に実 ID が一瞬でも出ない」という絶対条件を証明できない。

### 2.3 その他の方式を採用しない理由

ネイティブ `<select>` の横に tooltip や補助 popup を出す方式は、実 ID が選択肢の一覧内にないため要件を満たさない。

非標準または実験的な select styling API に依存する方式は、Electron 38 の更新で挙動が変わる面積に対して利点がない。

匿名のネイティブ `<select>` と実 ID 入りの別 overlay を重ねる方式は、二つのフォーカス、選択、スクロール位置を同期する必要があり、アクセシビリティツリーも重複する。

その方式は実質的にカスタム listbox より複雑であるため採用しない。

### 2.4 カスタム listbox の構造

概念構造は次のとおりとする。

```html
<label id="claude-account-label">表示アカウント:</label>
<button aria-haspopup="listbox"
        aria-expanded="false"
        aria-controls="claude-account-listbox">
  アカウント1
</button>
<div role="listbox" tabindex="0" aria-labelledby="claude-account-label">
  <div role="option" aria-selected="true">
    <span>アカウント1</span>
    <span>user@example.com</span>
  </div>
</div>
```

この断片は意味構造を示すものであり、実装を指定する完成コードではない。

listbox は開いている間だけ `document.body` 直下へ追加する。

閉じるときは `hidden` にせず node 自体を `remove()` する。

option の `id` は provider と匿名 `accountKey` だけから作る。

実 ID を DOM 属性へ埋め込まない。

## 3. 論点 2: 実 ID の配信

### 3.1 `/api/accounts` を維持する理由

`GET /api/accounts` は引き続き匿名 DTO だけを返す。

UUID、メール、内部整数 ID は含めない。

通常表示、閉じたトリガー、選択復元、data API の selector はこの匿名応答だけで完結させる。

実 ID を `/api/accounts` へ加えると、通常 account state と実 ID state を分離できなくなるため採用しない。

### 3.2 新しい endpoint

次の endpoint を新設する。

```text
GET /api/account-identifiers
X-Quota-Trail-Identifier-Token: <process-scoped nonce>
```

成功応答は次の形とする。

```json
{
  "providers": {
    "claude": {
      "claude:1": { "kind": "email", "value": "user@example.com" },
      "claude:2": { "kind": "uuid", "value": "01234567-89ab-cdef-0123-456789abcdef" }
    },
    "codex": {
      "codex:1": { "kind": "email", "value": "user@example.net" }
    }
  },
  "now": 0
}
```

レスポンスには内部整数 ID、`identity_source`、氏名、organization、token、JWT、profile 全体を含めない。

各アカウントについてメールが存在すればメールだけを返す。

メールが存在しない場合だけ UUID を返す。

`unknown` は実 ID を持たないため応答へ含めない。

匿名 label と current marker は `/api/accounts` を正とし、この endpoint では重複して返さない。

レスポンスには `Cache-Control: no-store` と `Referrer-Policy: no-referrer` を付ける。

### 3.3 認可条件

endpoint が実 ID を返す条件をすべて満たす必要がある。

1. HTTP method が `GET` である。
2. `revealAccountIdentifiersInAccountMenu === true` である。
3. account dimension が利用可能である。
4. `X-Quota-Trail-Identifier-Token` が、main process 起動時に `node:crypto` で生成した process-scoped nonce と一致する。

nonce は `GET /api/accounts` の top-level `identifierAccessToken` として、設定が有効な場合だけ同一 origin の renderer へ渡す。

nonce は実 ID ではないため匿名 account DTO の性質を壊さない。

nonce は URL、localStorage、ログへ入れない。

custom header にすることで、外部 Web ページからの単純な cross-origin GET では利用できず、CORS を許可しない現行方針も維持できる。

これはローカル OS 上の別プロセスに対する認証ではない。

DB と loopback API へアクセスできるローカルプロセスは従来どおり信頼境界内とする。

条件不成立時は理由を区別せず 404 `{ "error": "not found" }` を返す。

入力値、nonce、実 ID をエラー本文または access log に反射しない。

### 3.4 DB API

`db.accountIdentifier(provider, accountId)` は廃止する。

代わりに `db.listAccountIdentifiers()` を追加する。

戻り値は `provider`、匿名 `accountKey`、優先済みの `kind`、`value` だけとする。

DB 層でメール優先、UUID fallback を決める。

これにより server が account 行全体を受け取ることを避ける。

この処理は既存 schema の読み取りだけで実現し、DB migration は追加しない。

### 3.5 既存 endpoint、設定、dialog の扱い

単件 `GET /api/account-identifier` は廃止し、常に 404 とする。

`実IDを確認` ボタン、確認ダイアログ、modal dialog、`revealIdentifier`、`showIdentifierDialog`、`discardIdentifierDialog` は削除する。

開いたアカウントメニューが新しい明示操作であり、別 dialog は操作を重複させるためである。

既存の `revealAccountIdentifiers` は廃止する。

代わりに `revealAccountIdentifiersInAccountMenu` を導入する。

新設定の既定値は `true` とする。

既存 `config.json` に新設定がない場合は、旧 `revealAccountIdentifiers` の値にかかわらず `true` として一回 migration し、正規化した設定を書き戻す。

この決定により、直前リリースが生成した既定 `false` のままでも今回の機能が有効になる。

利用者が新設定を明示的に `false` にした場合だけ、endpoint を無効化してメニューを匿名表示へ縮退する。

`/api/meta.canRevealAccountIdentifiers` は廃止し、`canRevealAccountIdentifiersInAccountMenu` に置き換える。

### 3.6 取得タイミングとキャッシュ

renderer は `/api/meta` と `/api/accounts` の取得後、`identifierAccessToken` を受け取った時点で `/api/account-identifiers` を直ちに先読みする。

サンプルと latest の取得は実 ID の先読みによって待たせない。

アカウントメニューボタンは、初回先読みが成功するか、2 秒で失敗扱いになるまで disabled とする。

通常のローカル DB 読み取りでは、利用者が最初にメニューを開く前に実 ID が揃う。

先読み中のボタンには匿名文言 `アカウント情報を準備中` を可視 status として添える。

2 秒を超えた場合は選択操作自体を可能にし、option には匿名 label と `識別情報を取得できません` を表示する。

この失敗文言に provider response や識別子を含めない。

メニューを開く操作とフォーカス取得時に再試行する。

実 ID は中央の `state` とは別の専用メモリキャッシュへ保存する。

キャッシュキーは匿名 `accountKey` とする。

成功応答は全件を atomic に差し替える。

通常の 60 秒 account 一覧更新の直後にもバックグラウンドで再取得する。

一時的な失敗時は直前の成功値を最大 5 分だけ利用し、5 分を超えた値は破棄する。

`/api/accounts` から消えた account key は即時破棄する。

設定無効化、account dimension の縮退、ページ unload ではキャッシュ全体を破棄する。

メニューが開いている間に 60 秒更新が到着した場合、account DTO と実 ID キャッシュの表示反映は閉じるまで保留する。

操作中の active option と可視文言を非同期に入れ替えないためである。

## 4. renderer 内の実 ID ライフサイクルと新しい不変条件

### 4.1 通常 state との境界

`docs/design-accounts.md` §8.1 の「renderer の通常 state に実 ID が入らない」は、そのままの意味では維持できない。

起動時先読みを行うため、実 ID はメニューを開く前から renderer process のメモリに存在する。

ただし、現行 `state`、panel state、account selection state、永続化対象には入れない。

実 ID を保持できるのは account menu controller の閉じた専用キャッシュだけとする。

fetch の JSON 応答参照は正規化してキャッシュへ移した後に保持しない。

JavaScript の garbage collection 時点は保証対象にしない。

### 4.2 新しい身バレ防止の不変条件

次を新しい不変条件とする。

1. 閉じたトリガーの text node は匿名 `/api/accounts` DTO の `label` だけから作る。
2. 閉じたトリガーの生成処理は実 ID キャッシュを参照しない。
3. 実 ID を含む DOM node は listbox が開いている間だけ存在する。
4. listbox を閉じる処理は実 ID node を非表示にするのではなく remove する。
5. 実 ID は `title`、`data-*`、`aria-label`、`aria-description`、`id`、class 名、CSS custom propertyへ入れない。
6. 実 ID は localStorage、sessionStorage、URL、query parameter、履歴 state、clipboard へ自動保存しない。
7. 実 ID は chart、canvas、tooltip、凡例、header、footer、tray、通知、エラーメッセージへ入れない。
8. 実 ID と nonce はログへ入れない。
9. account 選択値は従来どおり匿名 `accountKey` だけとする。
10. listbox の close が完了した同一 task の終端で、DOM 全体を走査しても実 ID 文字列が存在しない。
11. disabled または migration 縮退時は専用 endpoint を呼ばず、専用キャッシュを空にする。
12. option の可視 text はスクリーンリーダーから読めるが、重複した実 ID 属性は作らない。

### 4.3 確認方法

自動試験では、匿名 endpoint、通常 endpoint、閉じた表示モデル、永続化 payload に fixture のメールと UUID が含まれないことを文字列検索する。

手動試験では DevTools の Elements、Properties、Accessibility、Local Storage、Session Storage を確認する。

閉じた状態、開く直前、選択直後、Escape、外側クリック、window blur、60 秒更新、設定無効化の各時点でスクリーン録画を 1 frame 単位で確認する。

閉じた DOM に fixture の実 ID がないことを `document.documentElement.textContent` と全属性値の走査で確認する。

ログ、HTTP 通常応答、canvas tooltip、tray tooltip も fixture 値で検索する。

## 5. 論点 3: 表示内容と書式

### 5.1 表示情報

known account の標準書式は次とする。

```text
アカウント1 — user@example.com                       現在ログイン中
```

メールがない場合は次とする。

```text
アカウント2 — UUID 01234567…cdef
```

UUID は先頭 8 文字、末尾 4 文字だけを表示する。

メールと UUID の両方がある場合、UUID は表示しない。

同じ provider 内ではメールを account identity の照合にも使っているため、通常の識別用途にはメールだけで足りる。

`identity_source` と `assurance` は利用者がアカウントを見分ける情報ではないため表示しない。

current marker は匿名 DTO の `isCurrent` から作り、option 右端へ `現在ログイン中` と表示する。

閉じたトリガーには current marker も付けず、`アカウントN` または `不明なアカウント` だけを表示する。

unknown option は次の書式とする。

```text
不明なアカウント — 実 ID なし
```

識別子取得失敗時は次の書式とする。

```text
アカウント1 — 識別情報を取得できません
```

### 5.2 長いメールと配置

option は匿名 label、識別情報、current marker の三領域を持つ CSS grid とする。

匿名 label と marker は折り返さない。

識別情報は `min-width: 0` と `overflow-wrap: anywhere` を使い、長いメールだけを必要に応じて複数行にする。

省略記号だけで全文を隠す方式は採用しない。

`title` に全文を複製できないためである。

listbox の幅はトリガー幅以上、推奨 360 CSS px、最大 `min(560px, viewport 幅 - 16px)` とする。

高さは viewport の空き領域と 320 CSS px の小さい方を上限にし、option 領域だけを縦スクロールさせる。

横スクロールは発生させない。

トリガーの `getBoundingClientRect()` を基準に、下側へ収まれば下へ置く。

下側に足りず上側の方が広ければ上へ置く。

左右は viewport から 8 CSS px 以上離れるよう clamp する。

window resize と scroll では再配置し、anchor が画面外へ出た場合は閉じる。

### 5.3 色とテーマ

現行 `style.css` はライトテーマ固定であり、`theme.mjs` の chart palette もライト値である。

本変更だけで dashboard 全体のダークテーマ化は行わない。

ただし listbox は色を直接指定せず、`--panel-bg`、`--panel-border`、`--text`、`--muted` と、新設する `--menu-active-bg`、`--focus-ring` の semantic token だけを使う。

ライト時は本文とのコントラスト比 4.5:1 以上、境界と focus ring は隣接色に対して 3:1 以上を受け入れ条件とする。

将来または downstream の dark token 上書きでは、背景を暗色、本文を明色、補助文字を本文より弱い明色、active row を背景と判別できる暗青系にする。

Windows の強制色モードでは `forced-colors: active` に従い、独自 background より system `Canvas`、`CanvasText`、`Highlight`、`HighlightText` を優先する。

この構造により dark token を導入したときも実 ID だけが低コントラストになることを防ぐ。

手動試験では Chromium DevTools の dark emulation と forced colors emulation の双方で文字、active row、selected marker、focus ring を確認する。

## 6. アクセシビリティ仕様

### 6.1 role とフォーカス

閉じたトリガーは native `<button type="button">` とする。

button に `aria-haspopup="listbox"`、`aria-expanded`、`aria-controls` を付ける。

可視 `<label>` は button と listbox の双方へ関連付ける。

開いた listbox は `role="listbox"` と `tabindex="0"` を持ち、開いた直後にフォーカスを受け取る。

listbox は `aria-activedescendant` で active option を示す。

option は `role="option"` と `aria-selected` を持つ。

selected と active は別状態とする。

矢印移動だけでは account 選択を変更しない。

スクリーンリーダーは option の可視 text から `アカウント1、user@example.com、現在ログイン中` を読めるようにする。

実 ID を別の `aria-label` へ複製しない。

### 6.2 キーボード操作

閉じた button では次を実装する。

- Enter、Space、Alt+Down、F4: listbox を開き、選択中 option を active にする。
- ArrowDown: listbox を開き、選択中の次を active にする。
- ArrowUp: listbox を開き、選択中の前を active にする。
- Home、End: listbox を開き、先頭または末尾を active にする。
- 文字入力: listbox を開き、typeahead を開始する。

開いた listbox では次を実装する。

- ArrowDown、ArrowUp: active option を一つ移動する。
- Home、End: 先頭または末尾へ移動する。
- PageDown、PageUp: 可視 option 数を基準に移動する。
- Enter、Space: active option を確定し、listbox を閉じ、button へフォーカスを戻す。
- Escape: 変更せず閉じ、button へフォーカスを戻す。
- Alt+Up、F4: 変更せず閉じ、button へフォーカスを戻す。
- Tab、Shift+Tab: 変更せず閉じ、通常の次または前の focusable element へ移動する。
- 文字入力: 700 ms の入力バッファで、匿名 label と現在表示中の識別情報を先頭一致検索する。

typeahead は Unicode の小文字化後に比較する。

一致しない入力は選択を変えない。

active option が scroll container 外へ出た場合は `scrollIntoView({block:'nearest'})` 相当で表示する。

### 6.3 pointer と終了条件

option の primary pointer click はその option を確定する。

listbox 外の `pointerdown`、Escape、window blur、別 provider のメニューを開く操作で閉じる。

一度に開ける listbox は一つだけとする。

外側クリックで閉じた後も、クリック先が本来受け取る操作を妨げない。

選択確定時だけ既存の `selectAccount` 相当処理を呼ぶ。

## 7. 既存機能への影響

### 7.1 選択の永続化

localStorage `quota-trail.ui.v2.selectedAccounts` の形と値は変えない。

保存するのは匿名 `accountKey` だけである。

初回 current、保存選択の復元、無効 key の fallback は既存 `chooseAccountSelection` を維持する。

### 7.2 account 切替時のクリア

active option の移動中は chart を clear せず、fetch もしない。

Enter、Space、pointer click で別 account を確定した時だけ、対象 provider の二系列、latest、hover を同期的に clear する。

その後で localStorage 保存、進行中 fetch の abort、sequence 更新、再取得を行う。

listbox は clear 処理より先に remove する。

同じ account を確定した場合は閉じるだけとし、再取得しない。

### 7.3 60 秒更新

`/api/meta`、`/api/accounts`、samples、latest の 60 秒更新は維持する。

実 ID batch も account 一覧成功後に更新する。

listbox が開いている間は account/identifier の UI 反映を保留し、閉じた直後に最新世代を反映する。

実 ID fetch の失敗は chart fetch の成功を失敗扱いにしない。

### 7.4 migration 縮退と unknown

`accountDimensionAvailable:false` では匿名の disabled button `アカウント情報を利用できません` を表示する。

listbox は開かず、実 ID endpoint も呼ばない。

`unknown` は通常どおり選択可能とし、開いた option に `実 ID なし` と表示する。

unknown を選んでも実 ID cache は参照しない。

### 7.5 tray、chart、データ API

tray は account manager の current account と匿名 label を使う現行仕様を変えない。

tray tooltip に実 ID を出さない。

chart、header、reset、gap、decimation の処理は変更しない。

`/api/samples` と `/api/latest` の `series["provider/window"]` 形は変更しない。

account selector query も匿名 key のままとする。

### 7.6 純粋関数境界

`src/shared/*` と `src/main/lib/normalize.mjs` の I/O 禁止を維持する。

DOM、fetch、timer、localStorage は renderer controller に置く。

表示行の結合、UUID 短縮、typeahead、index 移動、viewport 配置計算は `src/shared/account-menu.mjs` の純粋関数へ切り出せる。

## 8. `docs/design-accounts.md` への差分指示

`docs/design-accounts.md` 自体は今回編集しない。

将来統合するときは、次の節を本書の内容で上書きする。

| 節 | 差分指示 |
|---|---|
| §1.1 | 「通常の画面、DOMに実 ID を出さない」を「閉じた通常表示には出さず、開いた account listbox に限って出す」へ変更する。 |
| §5 | 匿名採番規則は維持し、匿名 label が閉じたトリガーと開いた行の対応キーであることを追記する。 |
| §6.2 | `/api/accounts` は匿名のまま維持し、top-level の process-scoped `identifierAccessToken` だけを条件付きで追加する。 |
| §6.3 | 単件 `/api/account-identifier` と旧 gate を削除し、本書 §3 の batch endpoint、認可、応答へ全面置換する。 |
| §7.1 | native `<select>` の記述を削除し、button + listbox、配置、viewport clamp へ置換する。 |
| §7.2 | accountKey の初期選択と永続化は維持し、閉じた button が匿名 label だけであることを追記する。 |
| §7.3 | change event を確定 event に読み替え、起動時先読み、専用 cache、60 秒更新中の適用保留を追加する。 |
| §7.4 | native select の keyboard 記述を削除し、本書 §6 の listbox 操作と ARIA へ全面置換する。 |
| §7.5 | 実 ID dialog の節を削除し、本書 §3.5 と開いた listbox 内表示へ置換する。 |
| §8.1 | 「renderer の通常 state に実 ID が入らない」を削除し、本書 §4 のメモリ境界と 12 個の不変条件へ置換する。 |
| §8.2 | batch endpoint、nonce、cache のログ禁止を追加する。 |
| §8.3 | DB 保存方針は維持し、renderer では永続化しないことを明記する。 |
| §9 | tray と chart は不変、60 秒更新と account 確定時だけ clear することを追記する。 |
| §10 | dialog テストを削除し、本書 §9 の API、純粋関数、DOM 手動試験へ置換する。 |
| §11 | renderer と server の実装順を本書 §10 で上書きする。 |
| §13.4 | 「dropdown の開閉にかかわらず匿名」を削除し、「閉じたトリガーは常に匿名、開いた listbox だけ実 ID」に変更する。 |
| §13.5 | dialog 完了条件を削除し、先読み、listbox remove、キャッシュ非永続化の完了条件へ置換する。 |

上表の該当節については、本書が統合前から実装判断上の優先仕様となる。

## 9. テスト計画

既存 85 件をすべて維持し、次の試験を追加または変更する。

DOM ライブラリの npm 依存は追加しない。

### 9.1 `tests/account-menu.test.mjs` を追加

`node --test` から直接実行できる `src/shared/account-menu.mjs` の純粋関数を検証する。

- 匿名 account DTO と識別子 DTO が `accountKey` で結合される。
- メールが UUID より優先される。
- メールなし時だけ UUID が `先頭8…末尾4` になる。
- unknown が `実 ID なし` になる。
- 欠落と取得失敗が一般文言になる。
- current marker が匿名 DTO だけから決まる。
- 行モデルの closed label が常に匿名 label だけになる。
- Up、Down、Home、End、PageUp、PageDown の index 計算が範囲外へ出ない。
- typeahead が匿名 label と可視識別情報へ先頭一致し、700 ms 超過で buffer をリセットする。
- viewport の上下左右端で placement が 8 px margin 内に clamp される。

純粋関数は実 ID をログ、storage、DOM へ書かず、文字列と配置値を返すだけとする。

### 9.2 `tests/server.test.mjs` を変更

- `/api/accounts` が UUID、メール、内部 ID を返さない。
- 設定有効時だけ `identifierAccessToken` を返す。
- batch endpoint は設定、account dimension、nonce の全条件が揃った場合だけ 200 になる。
- nonce なし、不一致、設定無効、縮退時は同じ 404 になる。
- 成功応答は provider/accountKey ごとにメール優先、UUID fallback となる。
- unknown、identity source、内部 ID、余分な profile field が応答にない。
- `Cache-Control: no-store` と `Referrer-Policy: no-referrer` が付く。
- 旧単件 endpoint は 404 になる。
- エラー応答が request header、query、fixture の実 ID を反射しない。
- `/api/samples` と `/api/latest` の既存 `series` shape が不変である。

### 9.3 `tests/db.test.mjs` を変更

- `listAccountIdentifiers()` が alias 順の匿名 key を返す。
- メールあり行はメールだけ、メールなし行は UUID だけを返す。
- UUID とメールがない不正行を返さない。
- provider 間で同じ alias number があっても混同しない。
- v1 縮退では空配列を返す。
- 既存 account upsert、migration、query、latest の試験結果が変わらない。

### 9.4 `tests/config.test.mjs` を変更

- 新規設定の既定が `true` である。
- 新設定未定義かつ旧設定 `false` の config が `true` へ migration される。
- 新設定を明示的に `false` にした新形式 config は false を維持する。
- 旧 `revealAccountIdentifiers` は正規化後の設定から除去される。
- migration の再実行が冪等である。

### 9.5 `tests/account-selection.test.mjs` を変更

- listbox の active 移動だけでは保存選択を変えない。
- 確定時だけ account key が更新対象になる。
- 同じ key の再確定は no-op になる。
- invalid saved key、current、最小 alias、unknown の既存 fallback 順を維持する。

### 9.6 `tests/logger.test.mjs` を変更

- batch response、nonce、メール、UUID を logger に渡しても sanitize される。
- batch endpoint の 404 と 500 が header と response body をログへ含めない。
- 匿名 account key は従来どおりログ可能である。

### 9.7 renderer の手動試験

追加 DOM 依存を避けるため、フォーカスと accessibility tree は Windows 11 / Electron 38 で手動確認する。

1. マウス、Enter、Space、Arrow、Alt+Down、F4、typeahead から開く。
2. 開いている間だけ各行に識別情報が見える。
3. Escape、選択、外側クリック、Tab、window blur の直後に実 ID node がない。
4. どの開き方でも閉じた button に実 ID が 1 frame も出ない。
5. 長いメール、10 件以上の account、320 px 幅、1920 px 幅、上端、下端で配置と scroll を確認する。
6. スクリーンリーダーで label、selected、active、current、実 ID の順序を確認する。
7. dark emulation と forced colors で本文、active、selected、focus ring の可読性を確認する。
8. 60 秒更新、設定無効化、migration 縮退中に listbox と cache が安全に閉じることを確認する。
9. A→B→A を切り替え、確定時だけ二 chart が clear され、古い response が戻らないことを確認する。
10. `node --test tests/` で既存 85 件と追加試験を通す。

## 10. 実装手順

以下は将来の実装順であり、本書作成時には実装しない。

1. **`src/shared/account-menu.mjs` と `tests/account-menu.test.mjs` を追加する。** 受け入れ条件: 表示行、UUID 短縮、typeahead、index 移動、配置が I/O なしの純粋関数として `node --test` で通る。
2. **`src/main/config.mjs` と `tests/config.test.mjs` を更新する。** 受け入れ条件: 新設定が新規・旧 config の双方で既定 true になり、明示的な新設定 false だけを維持し、migration が冪等である。
3. **`src/main/db.mjs` と `tests/db.test.mjs` を更新する。** 受け入れ条件: schema 変更なしで最小の batch DTO を返し、メール優先、UUID fallback、縮退時空配列を保証する。
4. **`src/main/server.mjs` と `tests/server.test.mjs` を更新する。** 受け入れ条件: process nonce、設定 gate、batch endpoint、no-store、一般 404 が働き、通常 API と `series` shape が変わらない。
5. **`scripts/dev-renderer.mjs` を新契約へ追随させる。** 受け入れ条件: 識別情報表示を既定有効にし、`--no-reveal` で失敗・匿名縮退を再現でき、長いメール、UUID-only、unknown の fixture を持つ。
6. **`src/renderer/app.mjs` の native account select と dialog を除去し、account menu controller を接続する。** 受け入れ条件: 中央 `state` と localStorage に実 ID がなく、閉じた button が匿名 DTO だけから生成される。
7. **`src/renderer/app.mjs` に先読み、専用 cache、世代管理を追加する。** 受け入れ条件: 起動時先読み、2 秒縮退、60 秒 refresh、5 分 stale 上限、abort、設定無効時 purge が互いに chart fetch を失敗させない。
8. **`src/renderer/app.mjs` に keyboard、focus、pointer lifecycle を追加する。** 受け入れ条件: 本書 §6 の全操作、単一 open、確定時だけ切替、close 時 remove、focus 復帰を満たす。
9. **`src/renderer/style.css` を更新する。** 受け入れ条件: 320〜1920 px、上下配置、長いメール、縦 scroll、semantic colors、forced colors で崩れず、閉じた button の匿名文言を省略しない。
10. **不要になった reveal dialog と旧 API の参照をリポジトリ全体から除去する。** 受け入れ条件: `revealIdentifier`、`discardIdentifierDialog`、旧設定名、旧 endpoint の成功経路が残らず、旧 endpoint の 404 compatibility test だけが残る。
11. **自動・手動回帰試験を実行する。** 受け入れ条件: 既存 85 件を含む全 test、A→B→A、60 秒更新、unknown、migration 縮退、tray、全 close 経路、1 frame の画面録画確認が完了する。

各実装ファイルではリポジトリの流儀に従い、日本語コメント、JSDoc、1 行 1 文を維持する。

## 11. 仮説の判断

### H-001: Codex rollout の `rate_limits` を副次データ源にする

**対象外。**

今回の変更は保存済み account の選択 UI と実 ID 開示境界だけを扱い、usage の取得元、頻度、account 帰属方法を変更しない。

### H-002: idle / ロック中でもポーリングを止めない

**対象外。**

常時ポーリング、sleep 復帰、unlock 時の scheduler 動作は変更しない。

60 秒の dashboard 更新と実 ID cache 更新は renderer 表示更新であり、usage ポーリング方針の判断を変えない。

## 12. 完了条件

1. 閉じた account button は全状態で匿名 label だけを表示する。
2. 開いた listbox は既定設定のまま known account のメールまたは UUID fallback を表示する。
3. native `<select>` の文言差し替えに依存しない。
4. 実 ID endpoint は batch、no-store、process nonce、設定 gate を満たす。
5. 起動時先読み後は通常の最初の open で識別情報が即時表示される。
6. 実 ID は専用メモリ cache と開いている option text node 以外へ出ない。
7. close 後の DOM、属性、storage、URL、chart、tray、ログに実 ID が残らない。
8. keyboard、focus、pointer、screen reader の仕様を満たす。
9. account 選択永続化、60 秒更新、切替 clear、unknown、migration 縮退、tray の既存動作を維持する。
10. `/api/samples` と `/api/latest` の `series["provider/window"]` を変更しない。
11. 追加 npm 依存がなく、`src/shared/*` と `normalize.mjs` の純粋性を維持する。
12. `docs/design-accounts.md` は編集せず、本書だけを新規追加する。
