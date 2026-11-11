# CLAUDE.md

## モデルルーティング

- タスクを開始する前に、そのタスクに必要なモデルのランクを判断すること
- 設計を必要とするタスク（システム全体のアーキテクチャ設計、技術選定、誤った選択をするとやり直しコストが大きい設計判断など）では、**その時点で ECI（Epoch Capabilities Index）が最も高いモデル（Claude 系・GPT 系）**に設計させること。特定のモデルに設計を固定すると設計の品質が落ちるため（発注者指示 2026-11-12）。2026-11-12 時点の設計役は Claude Fable 5.2（effort: xhigh、難航時だけ max）。選び方と根拠は下の「設計モデルの選択」
- メインセッションが設計役のモデル・effort で動いているときは、メインセッションが自分で設計する。そうでないときは、Agent ツールか Codex CLI で設計役のモデルを呼ぶか、発注者にモデルの切り替えを依頼する
- 設計のレビューは、**次点で ECI が高い他ベンダーのモデル**に投げること。2026-11-12 時点のレビュー役は Codex CLI 経由の `gpt-6.1-sol`（reasoning effort: xhigh、難航時だけ max）
- 本格的な実装・テスト・リファクタリングは、Agent ツール経由で `model: opus` のサブエージェントに委譲すること
- 小さなバグ修正・テストの追加・ドキュメント作成は、Agent ツール経由で `model: sonnet` のサブエージェントに委譲すること
- ファイル探索・コード検索・ログの要約・定型的な調査は、Agent ツール経由で `model: haiku` のサブエージェントに委譲すること。すべてをメインモデルでやらないこと

### エマージェンシーモード

- Claude の weekly usage limit の使用率が 80% 以上であることを確認した場合、または発注者から 80% 以上であると申告された場合は、直ちにエマージェンシーモードへ移行すること
- エマージェンシーモード中は、このセクションを上記の通常時のモデルルーティングより優先すること。Claude の Agent ツールによる `opus` / `sonnet` / `haiku` サブエージェントへの委譲は原則として行わず、Claude はタスクの分解、Codex CLI への指示、成果物のレビューと統合に専念すること
- システム設計、技術選定、高リスクな変更、最終レビューは、Codex CLI 経由で `gpt-6.1-sol`（reasoning effort: high）に委譲すること
- 通常の実装、テスト、リファクタリング、設計に基づく複数ファイルの変更は、Codex CLI 経由で `gpt-6.1-sol`（reasoning effort: medium または high）に委譲すること
- ファイル探索、コード検索、ログの要約、定型的な調査、ドキュメント作成、小さく低リスクな修正は、Codex CLI 経由で `gpt-6-luna`（reasoning effort: low または medium）に委譲すること
- Codex CLI へ委譲する際は、目的、対象範囲、制約、受け入れ条件、必要な検証をプロンプトに含めること。設計から実装まで連続するタスクでは、先に `gpt-6.1-sol` の設計を確定し、その設計を入力として `gpt-6.1-sol` または `gpt-6-luna` に実装させること
- **Codex CLI を呼ぶたびに、その直後に `node scripts/codex-limits.mjs` を実行し、Codex の 5h limit と Weekly limit の残量・リセット時刻を Claude Code の出力（発注者への報告文）にそのまま含めること**（発注者指示 2026-09-04）。このスクリプトは `~/.codex/sessions` の最新 rollout から `rate_limits` を読むだけで Codex を呼ばない。rollout を書かない `codex exec --ephemeral` は使わないこと
- Claude の weekly usage limit がリセットされたこと、または使用率が 80% 未満であることを確認できるまで、エマージェンシーモードを継続すること

### 設計モデルの選択（ECI 最高のモデルが設計、次点の他ベンダーがレビュー。切り札はその都度選ぶ）

- 通常時の設計役は、その時点で ECI（https://epoch.ai/eci?view=table&tab=leaderboard ）が最も高いモデル（Claude 系・GPT 系）。レビュー役は、次点で ECI が高い**他ベンダー**のモデル（発注者指示 2026-11-12）。ECI はモデルごとの値で effort 別の値はないため、effort は発注者が決める
- **2026-11-12 時点**（Epoch AI の CSV https://epoch.ai/data/eci_scores.csv 、2026-11-11 更新）:
  - 設計役: Claude Fable 5.2（ECI 174.24、単独 1 位）。effort は xhigh、難航時だけ max
  - レビュー役: `gpt-6.1-sol`（ECI 168.87）。reasoning effort は xhigh、難航時だけ max。他ベンダーの次点は GPT-6 Astra（169.16）と GPT-6.1 Sol が表示上同点（169）で、発注者が Sol を選んだ
  - 参考: Claude Opus 5.5 168.67 / GPT-6.1 Terra 168.11 / Claude Fable 5.1 167.04 / Gemini 4 Argon 166.53
- 新しいモデルの公開や ECI の更新で順位が変わったら、設計役・レビュー役を選び直し、モデル名と effort を発注者に明示して確認を取ってから、この節と冒頭の「モデルルーティング」の値を更新する
- エマージェンシーモード中は変えない（発注者確認 2026-11-12）。Claude の枠を節約するため、設計・技術選定・高リスクな変更・最終レビューは従来どおり `gpt-6.1-sol`（reasoning effort: high）が担当する
- 経緯: 2026-11-12 までは通常時も設計の既定担当が `gpt-6.1-sol`（reasoning effort: high）で、Fable はそのレビュー役だった。2026-09-05 に Astra へ切り替えたが、2026-09-07 に 5h limit の消費速度が実用に耐えないため Sol 既定へ戻した（発注者指示 2026-09-07）。2026-10-11 に `gpt-6-sol` から `gpt-6.1-sol` へ移行した（発注者指示 2026-10-11。Codex CLI 0.159.2 で利用可能を確認。`gpt-6.1-astra` / `gpt-6.1-luna` は未提供のため `gpt-6-astra` / `gpt-6-luna` を継続）
- **設計のレビュー（エマージェンシーモード中は設計も）を Codex CLI へ依頼するたびに、先に Sol の利用可能性を確認すること**。確認手順は次のコマンド 1 回（ほぼトークンを消費しない。`--ephemeral` を付けないので直後に `node scripts/codex-limits.mjs` で利用枠も読める）:

  ```powershell
  codex exec -m gpt-6.1-sol -s read-only -c model_reasoning_effort=low "「ok」とだけ返答してください。ツールは使わないでください。"
  ```

  `ok` が返れば利用可能。`model is not supported` / `not found` / `requires a newer version of Codex` 等のエラーなら、Codex CLI の更新（`npm i -g @openai/codex@latest`。他プロジェクトの Codex 連携に影響するため発注者に確認する）を試みる
- **切り札は固定しない**（`gpt-6-astra` はもう切り札ではない。発注者指示 2026-11-12）。設計役の設計やそれに基づく実装が受け入れ条件を満たさない、レビューで設計役・レビュー役では解決できない根本的な欠陥が見つかる、同じ論点で 2 回以上やり直している、など設計役・レビュー役（エマージェンシーモード中は Sol）で行き詰まったときだけ切り札を使う
- 切り札が必要になったら、**その時点で** ECI（Epoch Capabilities Index、https://epoch.ai/eci?view=graph&tab=release-date ）が最も高いモデルのうち、**サブスク枠に響かないもの**を選定する。参考として ARC-AGI-3 のリーダーボード（https://arcprize.org/leaderboard?sort=v3 ）も見る
- 切り札を使う前に、**モデル名と reasoning effort を発注者に明示する**。選定の根拠（ECI の値と確認日、サブスク枠に響かないと判断した理由）も添える。Codex CLI 経由のモデルなら、その都度 `ok` だけを返させる確認コマンド（上の Sol と同じ形）で利用可能性を確かめる

## 設計仮説（docs/hypotheses/）

- `docs/hypotheses/` は「設計の改善に繋がる仮説」の置き場である（要件と設計書の間）。詳細は `docs/hypotheses/README.md`
- 設計するとき（自分で設計する場合も、Agent ツールや Codex CLI へ設計・レビューを依頼する場合も）は、対象領域に関係する仮説ファイルを読み（依頼するならパスをプロンプトに含め）、各仮説の採用 / 部分採用 / 却下 / 対象外を設計書に明記すること。判断が付いたら仮説ファイルの `status` と `decisions` を更新する
- 実装の最適化で設計書を読むときは、その設計が採用しなかった仮説も読み、逆行していないかを確認すること
- 会話・論文・製品から「設計を良くしそうな着眼」が出たら、Fable のメモリではなく `docs/hypotheses/` に `H-NNN-<slug>.md` として置くこと（メモリは発注者に見えない）
