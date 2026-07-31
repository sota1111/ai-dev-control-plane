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
    → 各子の実装/検証 → 取り組み完了時に検証済み candidate/champion artifact を提出
       （scripts/ai/kaggle_targets_submit.sh）
```

「AI does not call AI」「dispatcher 一元化」「Linear=唯一の人間IF」を崩さない。cron 側は
決定的処理（読み取り + ガード + Issue作成 + 提出）だけを行い、「どの改善軸を打つか」は起案Issueを
処理する既存 worker に委ねる。

## 単一スケジュール・1枠=1コンペ（ローテーション）

単一 cron を毎時起動し、`--only-scheduled` で registry の JST 枠だけを処理する。各枠は
1コンペの当番で、Kaggriculture は1日2枠、他コンペは1日1枠で提出する
（専用の提出/フロア cron は持たない）。1回の当番で何系統を提出するかは提出モード次第 — `both` は
claude/gpt を両方、`alternate`（ARC）は日替わりで交互に1系統（下記「提出上限と提出モード」）。

| JST hour | 当番コンペ | claude 系 repo | gpt 系 repo |
| --- | --- | --- | --- |
| 0  | ptcg           | ptcg-agent-claude    | ptcg-agent-gpt    |
| 4  | arc-agi-2      | arc-agi-2-claude     | arc-agi-2-gpt     |
| 8  | arc-agi-3      | arc-agi-3-claude     | arc-agi-3-gpt     |
| 12 | agent-security | agent-security-claude| agent-security-gpt|
| 16 | rogii          | rogii-claude         | rogii-gpt         |
| 2 / 14 | kaggriculture | kaggriculture-claude | kaggriculture-gpt |
| 20 | biohub         | biohub-claude        | biohub-gpt        |

ローテーション表・コンペ定義・提出物パスは `scripts/ai/kaggle_targets_registry.json`。
（`config/` は harness 保護下のため `scripts/ai/` に同居。）

## 提出は「取り組み完了時」（コンペ内選定機構なし）

- 提出対象はregistryの`submit`が指す **検証済みartifact**。candidateでもよく、champion昇格は不要。
  SOT-1904 の
  「直近2提出収束ロジック／2枠選定ゲート」は **この経路では使わない**（コンペ内で提出内容を検討する
  機構は廃止）。
- 別スケジュールの提出ローテ cron・日次フロア cron は持たない。**改善サイクル cron が同じ当番枠で**
  当該コンペの設定済みartifact提出（`scripts/ai/kaggle_targets_submit.sh --competition <key>`）も行う
  （SOT-1913「日々提出できる状態」）。起案が guard で skip されても提出は独立に試みるので、有効化すれば
  各コンペ1日1回は提出しようとする。実提出は active(2段kill switch) かつ `--execute` のときだけ。
- **翌日の同じコンペ枠**では、起案材料の先頭に「前回提出結果（順位/スコア）」を含めてから次の改善
  方針を決める（材料収集は SOT-1932 側）。
- 冪等: 当日すでに提出済みなら二重提出しない。`submit.file` 未設定（提出物未整備）のコンペは
  **skip + Discord 通知**で安全側に倒す（提出物 wiring は各 repo の改善子Issueで整備）。

### 提出上限と提出モード（SOT-1913 提出cap補正）

各コンペの 1日提出上限（Kaggle 実制限）とモードを registry の `daily_submission_cap` /
`submission_mode` で持つ。

| コンペ | `daily_submission_cap` | `submission_mode` | 挙動 |
| --- | --- | --- | --- |
| ARC（arc-agi-2 / arc-agi-3） | **1** | **`alternate`** | 1日1提出のみ。claude/gpt を**日替わりで交互**に提出（前回提出系統の逆を選ぶ） |
| 他3コンペ（ptcg / rogii / biohub） | **5** | **`both`** | claude/gpt を**両方提出**し、両系統の結果を確認する |
| kaggriculture | **5** | **`both`** | JST 2時・14時の2枠で各lineageを1回ずつ、計4提出/日まで受け付ける |
| agent-security | **5** | **`both`** | Claude/GPTの独立notebook lineageを共通`submission.csv`契約で各2回/日、計4提出/日まで受け付ける |

- `alternate` の「次の系統」は Kaggle 提出履歴の最新提出（`kaggle_targets_submit.sh` が取得）から決める。
  最後に提出した repo の逆系統が今日の番。履歴が取れないときは claude 始まりで交互する。
- `alternate` は共有 cap のため、当日そのコンペで（どちらの系統でも）すでに提出済みなら選ばれた系統も
  skip（冪等）。
- `both` の既定は2系統ぶん（=2提出/日）。`daily_submissions_per_lineage=2` のコンペは4提出/日で cap 5 に収まる。

## ガード（暴走・空回りの防止・順位最優先に緩和）

`runner-cli kaggle-improve-run`（engine = `src/lib/kaggleImprovement.ts`）が全て AND で評価。
NG は黙って skip（+ Discord 通知）。

1. **active**: `registry.enabled && env KAGGLE_IMPROVE_ENABLED`（2段 kill switch）でなければ何もしない。
2. **Issue cap ガード**: workspace 総 Issue 数 ≥ `issue_cap_guard`（既定 240）なら起案せず archive を促す。
3. **cooldown ガード**: worker usage-limit cooldown 中は起案しない。
4. **前サイクル実行中ガード**: 対象プロジェクトに現在 actionable（`Todo` / `In Progress`）な
   `auto-improve` 親 Issue があれば重複起案しない（プロジェクト毎に実行中は高々1本）。
   `In Review` を含む過去 Issue は次サイクルを妨げず、execute 時は Linear の現在状態で再確認する。
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
               3. 取り組み完了時に検証済みartifactを提出 4. 子完了後、親を In Review にして完了報告
## 受け入れ条件  改善方針の記録 / 子Issue全て終端 / 昇格判定と champion 整合 / 完了時提出
```

このテンプレートは分解トリガー条件（複数独立軸・複数PR・逐次依存）を満たすので、task-check が
2〜5子Issueへ分解する（＝「plan が起案Issueを読んで順位向上子Issueを作る」要件）。

## 子Issueは Todo + blockedBy で作る（待機中は Blocked へ自動遷移）

**重要**: 起案親から分解した実装子Issue、および cron が作る親Issueは **Todo で登録し、依存は
`blockedBy` で連結する**。In Review にパークしてはならない。

理由: パイプラインの issue 選択は In Review を自動対象外にする（`fetchActiveIssues` が
`name: { nin: ["In Review"] }` で除外、`getIssueExecutionEligibility` が In Review を hold として
キューから外す）。依存順ソート（`src/lib/queueOrdering.ts` の `sortQueueByPriority` /
`selectNextReadyIndex`）は **enqueue された Todo/In Progress の Issue にしか効かない**。よって
子Issueを In Review にパークすると、そもそもキューに入らず依存順に自動実装されない。Todo +
blockedBy にすれば、既存の topological ソートが依存側を保留する。待機が確認されたIssueは Linear 上で
**Blocked** へ自動遷移するが、Blocked は自動スキャン対象に残るため、ブロッカー完了後は In Progress
へ進んで依存順に最後まで処理される。
（詳細: `docs/ai/investigations/SOT-1913-dependency-order.md`）

## 有効化 / kill switch

**現状は計画段階で default OFF。** 実起動には2段 kill switch を両方 ON にする:

1. `scripts/ai/kaggle_targets_registry.json` の `"enabled": true`。
2. cron/実行時に `KAGGLE_IMPROVE_ENABLED=1`。

### cron 登録（devcontainer 再起動毎に要再実行）

```bash
# ドライランで cron 登録（既定・何も起案/提出しない）:
bash scripts/ai/setup_cron.sh

# 実起案・実提出まで有効化する（＝「起動」ワンコマンド）:
#   1) registry.enabled を true にする（scripts/ai/kaggle_targets_registry.json）
#   2) 下記コマンドで cron を実行モードで登録する
KAGGLE_IMPROVE_EXECUTE=1 KAGGLE_IMPROVE_ENABLED=1 bash scripts/ai/setup_cron.sh
```

改善サイクルは毎時起動され、`--only-scheduled` により当番 JST 枠だけを処理する。実起案・実提出は
`KAGGLE_IMPROVE_ENABLED=1`（env）+ `registry.enabled=true` の両方が ON かつ `--execute` のときだけ。

> **cron の env について**: cron は登録時のシェル env を継承しない。`KAGGLE_IMPROVE_EXECUTE=1` で
> 登録すると、`setup_cron.sh` が enable フラグ（`KAGGLE_IMPROVE_ENABLED=1`。上書きしたい場合は登録時に
> `KAGGLE_IMPROVE_ENABLED=<値>` を渡す）を crontab 行へ **リテラルで焼き込む**ので、cron 実行時にも
> 実行モードが効く。ドライラン登録（`KAGGLE_IMPROVE_EXECUTE` 未設定）では env を焼き込まないので安全側。

### 手動実行（テスト/運用）

```bash
# ドライラン（起案しない・プラン表示のみ）
bash scripts/ai/kaggle_improvement_cycle.sh --hour 0
# 実起案（active 時のみ Linear に作成）
KAGGLE_IMPROVE_ENABLED=1 bash scripts/ai/kaggle_improvement_cycle.sh --hour 0 --execute
# 完了トリガ提出（当番コンペのartifact提出・ドライラン）
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
| 提出プラン CLI（candidate/champion共通） | `runner-cli kaggle-submission-plan` |
| 改善サイクル cron（起案＋当番枠artifact提出） | `scripts/ai/kaggle_improvement_cycle.sh` |
| artifact提出（当番枠から呼ばれる／手動可） | `scripts/ai/kaggle_targets_submit.sh` |
| レジストリ（6コンペ×2系統） | `scripts/ai/kaggle_targets_registry.json` |
| cron 登録 | `scripts/ai/setup_cron.sh` |
</content>
