---
id: H-001
title: Codex の rollout（~/.codex/sessions）に記録される rate_limits を副次データ源にすると、使用直後の値をコスト無しで補完できる
status: evaluated
origin: true-vr-v2 の scripts/codex-limits.mjs（rollout の token_count イベントに rate_limits が入る事実）
areas: design（データ取得）
decisions:
  - design.md v1（2026-09-07）: 却下。3 分の能動ポーリングで足りる。v2 候補
  - design-accounts.md v1（2026-09-22）: 却下。rollout の rate_limits と account ID の権威的な対応が確認できず、account 混在リスクが大きいため
---

## 仮説

Codex CLI は各 turn の `token_count` イベントに `rate_limits`（primary=5h、secondary=7d）を rollout jsonl へ書く。これを監視（fs.watch）すれば、Codex を使っている最中の使用率の急変を 3 分より細かい粒度で、API を叩かずに観測できる。

## 現状の診断

design.md v1 は 3 分ごとの HTTP ポーリングのみ。Codex を集中的に使うと 3 分の間に 10% 以上動くことがあり、急変の形が粗くなる。

## 採用したときの形

`providers/codex-rollout.mjs` が `~/.codex/sessions/**/rollout-*.jsonl` の末尾追記を watch し、`rate_limits` を見つけたら `source:'rollout'` のサンプルとして追加保存する。グラフでは通常サンプルと同じ系列に細い点で重ねる。

## 反証条件・コスト・リスク

- rollout の形式変更で壊れる（Codex のバージョン依存）。HTTP の値と乖離するなら捨てる
- ファイル監視の CPU コストと、セッション数が多いときの走査コスト
