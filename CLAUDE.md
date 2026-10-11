# CLAUDE.md

## モデルルーティング

- タスクを開始する前に、そのタスクに必要なモデルのランクを判断すること
- 設計を必要とするタスク（システム全体のアーキテクチャ設計、技術選定、誤った選択をするとやり直しコストが大きい設計判断など）では、必ず Codex CLI 経由で `gpt-6.1-sol`（reasoning effort: high）に設計させること。設計が必要な場面では例外なく Codex CLI を呼び出すこと。Fable が自分で新しい設計を考えてはならない
- Codex CLI が作成した設計は Fable がレビューすること
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

### 設計モデルの選択（Sol 既定、Astra は切り札）

- 設計・技術選定・高リスクな変更・最終レビューの既定担当は `gpt-6.1-sol`（reasoning effort: high）。2026-09-05 に Astra へ切り替えたが、2026-09-07 に 5h limit の消費速度が実用に耐えないため Sol 既定へ戻した（発注者指示 2026-09-07）。2026-10-11 に `gpt-6-sol` から `gpt-6.1-sol` へ移行した（発注者指示 2026-10-11。Codex CLI 0.159.2 で利用可能を確認。`gpt-6.1-astra` / `gpt-6.1-luna` は未提供のため `gpt-6-astra` / `gpt-6-luna` を継続）
- **設計を Codex CLI へ依頼するたびに、先に Sol の利用可能性を確認すること**。確認手順は次のコマンド 1 回（ほぼトークンを消費しない。`--ephemeral` を付けないので直後に `node scripts/codex-limits.mjs` で利用枠も読める）:

  ```powershell
  codex exec -m gpt-6.1-sol -s read-only -c model_reasoning_effort=low "「ok」とだけ返答してください。ツールは使わないでください。"
  ```

  `ok` が返れば利用可能。`model is not supported` / `not found` / `requires a newer version of Codex` 等のエラーなら、Codex CLI の更新（`npm i -g @openai/codex@latest`。他プロジェクトの Codex 連携に影響するため発注者に確認する）を試みる
- `gpt-6-astra` は既定では使わない**切り札**とする。Sol の設計・実装が受け入れ条件を満たさない、レビューで Sol では解決できない根本的な欠陥が見つかる、同じ論点で 2 回以上やり直している、など Sol で行き詰まったときだけ使う。Astra を使うときの reasoning effort は既定 low（難航時のみ medium 以上）
- Astra を実際に呼ぶ前には、その都度次のコマンドで利用可能性を確認すること:

  ```powershell
  codex exec -m gpt-6-astra -s read-only -c model_reasoning_effort=low "「ok」とだけ返答してください。ツールは使わないでください。"
  ```

  `ok` が返れば利用可能。エラーが出たときは Sol での設計・レビューを継続する

## 設計仮説（docs/hypotheses/）

- `docs/hypotheses/` は「設計の改善に繋がる仮説」の置き場である（要件と設計書の間）。詳細は `docs/hypotheses/README.md`
- Codex CLI へ設計を依頼するときは、対象領域に関係する仮説ファイルのパスをプロンプトに含め、各仮説の採用 / 部分採用 / 却下 / 対象外を設計書に明記させること。判断が付いたら仮説ファイルの `status` と `decisions` を更新する
- 実装の最適化で設計書を読むときは、その設計が採用しなかった仮説も読み、逆行していないかを確認すること
- 会話・論文・製品から「設計を良くしそうな着眼」が出たら、Fable のメモリではなく `docs/hypotheses/` に `H-NNN-<slug>.md` として置くこと（メモリは発注者に見えない）
