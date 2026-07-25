# Kaggle 改善サイクル自動化（SOT-1913）— 運用ドキュメント

Kaggle コンペの順位を自動で上げ続けるための「改善サイクル」システムの運用ガイド。設計の全体像は
`docs/ai/linear/SOT-1913.md`（v4）、実装子Issueは SOT-1932/1933/1934/1935。

## 全体像 — 2層 起案Issue方式（cron は LLM を呼ばない）

```
Layer 1: cron（決定的・LLM非呼出）  scripts/ai/kaggle_improvement_cycle.sh
  └─ この枠(JST hour)の当番コンペ(rotation)を解決し、その claude/gpt 2ターゲットだけを対象に
     ガードを評価。通過分に「改善方針の親Issue」を Linear に1本ずつ **Todo で** 起案する。

Layer 2: 既存パイプライン（起案Issueを処理）
  webhook/queue → run_auto.sh → task-check（分解判断）
    → plan worker が起案Issueを読み、そのリポジトリの順位向上「子Issue」を 2〜5本 作成
    → 各子の実装/検証/昇格判定 → 取り組み完了時に当該コンペの現 champion を提出
       （scripts/ai/kaggle_targets_submit.sh）
```

「AI does not call AI」「dispatcher 一元化」「Linear=唯一の人間IF」を崩さない。cron 側は
決定的処理（読み取り + ガード + Issue作成 + 提出）だけを行い、「どの改善軸を打つか」は起案Issueを
処理する既存 worker に委ねる。

## 単一スケジュール・1枠=1コンペ（ローテーション）

単一 cron を毎時起動し、`--only-scheduled` で **JST [0,4,8,12,16,20] の6枠**だけを処理する。各枠は
1コンペの当番で、6枠で6コンペを一巡する。各コンペは1日1回当番になるため **各コンペ1日1提出が自然に
成立**する（旧・要求「必ず1日1提出」を専用の提出/フロア cron 無しで担保）。

| JST hour | 当番コンペ | claude 系 repo | gpt 系 repo |
| --- | --- | --- | --- |
| 0  | ptcg           | ptcg-agent-claude    | ptcg-agent-gpt    |
| 4  | arc-agi-2      | arc-agi-2-claude     | arc-agi-2-gpt     |
| 8  | arc-agi-3      | arc-agi-3-claude     | arc-agi-3-gpt     |
| 12 | agent-security | agent-security-claude| agent-security-gpt|
| 16 | rogii          | rogii-claude         | rogii-gpt         |
| 20 | biohub         | biohub-claude        | biohub-gpt        |

ローテーション表・コンペ定義・提出物パスは `scripts/ai/kaggle_targets_registry.json`。
（`config/` は harness 保護下のため `scripts/ai/` に同居。）

## 提出は「取り組み完了時」（コンペ内選定機構なし）

- 提出対象は常にそのターゲットの **現 champion**（registry の `submit.file`）。SOT-1904 の
  「直近2提出収束ロジック／2枠選定ゲート」は **この経路では使わない**（コンペ内で提出内容を検討する
  機構は廃止）。
- 別スケジュールの提出ローテ cron・日次フロア cron は持たない。当番コンペの取り組み完了時に
  `scripts/ai/kaggle_targets_submit.sh --competition <key> --execute` を呼ぶ。
- **翌日の同じコンペ枠**では、起案材料の先頭に「前回提出結果（順位/スコア）」を含めてから次の改善
  方針を決める（材料収集は SOT-1932 側）。
- 冪等: 当日すでに提出済みなら二重提出しない。`submit.file` 未設定（提出物未整備）のコンペは
  **skip + Discord 通知**で安全側に倒す（提出物 wiring は各 repo の改善子Issueで整備）。

## ガード（暴走・空回りの防止・順位最優先に緩和）

`runner-cli kaggle-improve-run`（engine = `src/lib/kaggleImprovement.ts`）が全て AND で評価。
NG は黙って skip（+ Discord 通知）。

1. **active**: `registry.enabled && env KAGGLE_IMPROVE_ENABLED`（2段 kill switch）でなければ何もしない。
2. **Issue cap ガード**: workspace 総 Issue 数 ≥ `issue_cap_guard`（既定 240）なら起案せず archive を促す。
3. **cooldown ガード**: worker usage-limit cooldown 中は起案しない。
4. **前サイクル未完了ガード**: 対象プロジェクトに未終端の `auto-improve` 親 Issue が残っていれば
   重複起案しない（プロジェクト毎に常に高々1本）。execute 時は Linear で再確認する。
5. **新材料ガード**: 前回サイクル以降にそのプロジェクトで新しい完了 Issue が無ければ起案しない。

（撤廃済み: 全体日次上限ハードキャップ／「SOT-1904 提出ガード通過分だけ起案」制約。順位向上を阻害しない。）

## `auto-improve` ラベル

cron が起案する親Issueには workspace ラベル **`auto-improve`** が付く（機械識別・緊急時の一括把握用）。
Linear で `label:auto-improve` 検索すれば、この自動化が作った全 Issue を一望できる。

## 起案Issueテンプレート（系統別 directive）

本文は `buildIssueBody`（`src/lib/kaggleImprovement.ts`）が決定的に生成する。要点:

```markdown
workers: <claude系: solo=claude:opus | gpt系: solo=codex:gpt-5.6-sol>, handoff=off

## 目的         Kaggleコンペ <slug>（repo/系統）の順位を向上させる方針を決定し子Issueに分解して実施
## 入力材料     ### 前回提出結果（順位/スコア） / ### 直近の完了Issueダイジェスト / ### 失敗ログ・KPI抜粋
## 実施内容     1. 未着手の改善軸を選定 2. 2〜5子Issueへ分解（screen→confirm・非昇格revert・昇格時exec互換→Kaggle）
               3. 取り組み完了時に現 champion を提出 4. 子完了後、親を In Review にして完了報告
## 受け入れ条件  改善方針の記録 / 子Issue全て終端 / 昇格判定と champion 整合 / 完了時提出
```

このテンプレートは分解トリガー条件（複数独立軸・複数PR・逐次依存）を満たすので、task-check が
2〜5子Issueへ分解する（＝「plan が起案Issueを読んで順位向上子Issueを作る」要件）。

## 子Issueは Todo + blockedBy で作る（依存順自動実装の担保・SOT-1913 の依存順失敗の恒久対策）

**重要**: 起案親から分解した実装子Issue、および cron が作る親Issueは **Todo で登録し、依存は
`blockedBy` で連結する**。In Review にパークしてはならない。

理由: パイプラインの issue 選択は In Review を自動対象外にする（`fetchActiveIssues` が
`name: { nin: ["In Review"] }` で除外、`getIssueExecutionEligibility` が In Review を hold として
キューから外す）。依存順ソート（`src/lib/queueOrdering.ts` の `sortQueueByPriority` /
`selectNextReadyIndex`）は **enqueue された Todo/In Progress の Issue にしか効かない**。よって
子Issueを In Review にパークすると、そもそもキューに入らず依存順に自動実装されない。Todo +
blockedBy にすれば、既存の topological ソートがブロッカー完了まで依存側を保留し、依存順に処理する。
（詳細: `docs/ai/investigations/SOT-1913-dependency-order.md`）

## 有効化 / kill switch

**現状は計画段階で default OFF。** 実起動には2段 kill switch を両方 ON にする:

1. `scripts/ai/kaggle_targets_registry.json` の `"enabled": true`。
2. cron/実行時に `KAGGLE_IMPROVE_ENABLED=1`。

### cron 登録（devcontainer 再起動毎に要再実行）

```bash
bash scripts/ai/setup_cron.sh
# 実起案まで有効化するなら（既定はドライラン）:
KAGGLE_IMPROVE_EXECUTE=1 bash scripts/ai/setup_cron.sh
```

改善サイクルは毎時起動され、`--only-scheduled` により当番 JST 枠だけを処理する。実起案は
`KAGGLE_IMPROVE_ENABLED=1`（env）+ `registry.enabled=true` の両方が ON かつ `--execute` のときだけ。

### 手動実行（テスト/運用）

```bash
# ドライラン（起案しない・プラン表示のみ）
bash scripts/ai/kaggle_improvement_cycle.sh --hour 0
# 実起案（active 時のみ Linear に作成）
KAGGLE_IMPROVE_ENABLED=1 bash scripts/ai/kaggle_improvement_cycle.sh --hour 0 --execute
# 完了トリガ提出（当番コンペの champion 提出・ドライラン）
bash scripts/ai/kaggle_targets_submit.sh --competition ptcg
```

### 緊急停止

- `registry.enabled=false` に戻す or `KAGGLE_IMPROVE_ENABLED` を外す（起案・提出とも止まる）。
- cron を外す: `crontab -l | grep -v 'kaggle_improvement_cycle.sh' | crontab -`
- 走行中の自動 Issue は Linear で `label:auto-improve` から一括把握してキャンセル/クローズ。

## 記録（append-only ログ）

- 改善サイクル: `docs/ai/auto_logs/kaggle_improve.jsonl`（枠/当番コンペ/active/起案 identifier）。
- 提出: `docs/ai/kaggle/submission-history.jsonl`。

## 関連コマンド / ファイル

| 種別 | パス |
| --- | --- |
| 起案エンジン（純粋関数） | `src/lib/kaggleImprovement.ts` |
| 起案プラン CLI（dry-run） | `runner-cli kaggle-improve-plan` |
| 起案 実行 CLI（--execute で Linear 作成） | `runner-cli kaggle-improve-run` |
| 提出プラン CLI（champion・収束なし） | `runner-cli kaggle-champion-plan` |
| 改善サイクル cron | `scripts/ai/kaggle_improvement_cycle.sh` |
| 完了トリガ提出 | `scripts/ai/kaggle_targets_submit.sh` |
| レジストリ（6コンペ×2系統） | `scripts/ai/kaggle_targets_registry.json` |
| cron 登録 | `scripts/ai/setup_cron.sh` |
</content>
