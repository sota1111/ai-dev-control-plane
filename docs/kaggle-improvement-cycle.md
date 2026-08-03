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
    → 各子の実装/検証 → 全子完了時に親IssueをTodoへ自動再開
    → 親Issueが全子の結果を集約し、検証済み candidate/champion artifact を提出
       （scripts/ai/kaggle_targets_submit.sh）→ In Review
```

「AI does not call AI」「dispatcher 一元化」「Linear=唯一の人間IF」を崩さない。cron 側は
決定的処理（読み取り + ガード + Issue作成）だけを行い、「どの改善軸を打つか」は起案Issueを
処理する既存 worker に委ねる。

## 単一スケジュール・1枠=1コンペ（ローテーション）

単一 cron を毎時起動し、`--only-scheduled` で **JST [0,3,6,9,12,15,18,21]** の8枠だけを処理する。各枠は
1コンペの当番で、対象4コンペを12時間間隔で1日2枠ずつ処理する。各当番では Claude/GPT の2系統を
独立に解決するため、各コンペは **2時刻×2系統=4提出枠/日** になる
（専用の提出/フロア cron は持たない）。1回の当番で何系統を提出するかは提出モード次第 — `both` は
claude/gpt を両方、`alternate`（ARC）は日替わりで交互に1系統（下記「提出上限と提出モード」）。

| JST hour | 当番コンペ | claude 系 repo | gpt 系 repo |
| --- | --- | --- | --- |
| 0 / 12  | ptcg           | ptcg-agent-claude     | ptcg-agent-gpt     |
| 3 / 15  | kaggriculture  | kaggriculture-claude  | kaggriculture-gpt  |
| 6 / 18  | agent-security | agent-security-claude | agent-security-gpt |
| 9 / 21  | biohub         | biohub-claude         | biohub-gpt         |

ローテーション表・コンペ定義・提出物パスは `scripts/ai/kaggle_targets_registry.json`。
（`config/` は harness 保護下のため `scripts/ai/` に同居。）

### 固定枠（pinned slot）— 締切接近コンペの一定間隔サイクル保証

コンペ定義に `pinned_hours_jst`（＋任意 `pinned_lineage`）を設定すると、その JST hour の枠は動的資源
配分（allocation）・rotation を無視して**そのコンペが確定当番**になる。`pinned_lineage` を設定すると
起案対象をその1系統に限定する（もう一方は `pinned slot: <lineage> lineage only` で skip）。pinned 枠の
起案は `state.recent_competitions`（動的配分のクールダウン履歴）に記録されないため、既存の動的8枠の
挙動には影響しない。pinned hour は `schedule_hours_jst` に含めること（`--only-scheduled` で捨てられる
のを防ぐため parse 時に fail-loud で検証）。コンペ間の hour 重複も不可。

現在の設定: **rogii は締切接近のため JST 1/7/13/19（6時間ごと）を claude 系統専用の固定枠**とし、
改善→提出サイクルを1日4回転させる（`daily_submissions_per_lineage: 4`）。他コンペは従来どおり
JST 0/3/6/9/12/15/18/21 の8枠を動的配分で回す。

## 提出は「取り組み完了時」（コンペ内選定機構なし）

- 提出対象はregistryの`submit`が指す **検証済みartifact**。candidateでもよく、champion昇格は不要。
  SOT-1904 の
  「直近2提出収束ロジック／2枠選定ゲート」は **この経路では使わない**（コンペ内で提出内容を検討する
  機構は廃止）。
- 別スケジュールの提出ローテ cron・日次フロア cron は持たない。改善サイクル cron はIssue起案だけを行い、
  起案直後の改善前artifactを提出しない。全子Issue完了後、Webhookが親Issueへ
  `<!-- auto-parent-resumed -->` を記録してTodoへ戻し、再開された親Issueだけが
  `scripts/ai/kaggle_targets_submit.sh --competition <key> --repo <repo> --execute` を実行する。
- **各枠の開始時**に Kaggle 提出履歴を取得し、直近の submission ref / status / public score と
  `YYYY-MM-DD-jst-HH` の slot id を `submission-history.jsonl` に記録する。履歴取得または認証に失敗した
  場合は短い間隔で3回まで再取得し、それでも失敗すれば実行モードでも **safe skip + Discord通知**とし、提出しない。
- 冪等: 提出メッセージの `[slot:<slot id>]` を履歴で照合する。同じ枠の再実行は、日次2枠目を消費せず
  skipする。日次lineage上限またはコンペ上限に達した場合もskipする。`submit.file` 未設定（未完成artifact）は
  **skip + Discord 通知**で安全側に倒す（提出物 wiring は各 repo の改善子Issueで整備）。
- `both` モードの2枠目は全コンペで新しいartifactだけを提出する。ファイルは内容SHA-256、Notebookは
  immutableな `kernel/version/output` のSHA-256を提出メッセージへ記録し、同一lineageで当日提出済みならskipする。
  過去提出のfingerprintを確認できない場合も、安全側にskipする。
- 提出結果とスコア改善トリガは `[repo:<repo>]` によりlineage別に帰属させる。Claudeの確定スコアはClaude側だけ、
  GPTの確定スコアはGPT側だけの新材料となり、帰属不能な履歴から改善Issueは起案しない。
- 定期枠の間隔を採点待機時間として扱い、lineageの最新提出がまだ`PENDING`でも次の改善サイクルを起案する。
  採点完了待ちでサイクルを停止せず、ローカル検証で改善した新artifactを次枠で提出する。同じ`PENDING`履歴は
  前回起案時刻との比較で一度だけ消費し、同一artifactの再提出はfingerprint gateで引き続き禁止する。
- 子Issueからの提出も `kaggle_targets_submit.sh --competition <key> --repo <repo> --execute` に統一する。
  Kaggle CLI/APIの直接呼出しは禁止し、定期枠外の完了時提出にも同じfingerprint・日次上限・履歴取得gateを適用する。

### 提出上限と提出モード（SOT-1913 提出cap補正）

各コンペの 1日提出上限（Kaggle 実制限）とモードを registry の `daily_submission_cap` /
`submission_mode` で持つ。

| コンペ | `daily_submission_cap` | `submission_mode` | 挙動 |
| --- | --- | --- | --- |
| ARC（arc-agi-2 / arc-agi-3） | **1** | **`alternate`** | 1日1提出のみ。claude/gpt を**日替わりで交互**に提出（前回提出系統の逆を選ぶ） |
| 他2コンペ（rogii / biohub） | **5** | **`both`** | claude/gpt を**両方提出**し、両系統の結果を確認する |
| kaggriculture | **5** | **`both`** | JST 2時・14時の2枠で各lineageを1回ずつ、計4提出/日まで受け付ける |
| agent-security | **5** | **`both`** | Claude/GPTの独立notebook lineageを共通`submission.csv`契約で各2回/日、計4提出/日まで受け付ける |
| ptcg | **5** | **`both`** | Claude/GPTの独立repo lineageを共通`submission.tar.gz`契約で各2回/日、計4提出/日まで受け付ける |
| biohub | **5** | **`both`** | `biohub-claude` / `biohub-gpt`の独立notebook lineageを共通`submission.csv`契約で各2回/日、計4提出/日まで受け付ける。提出・前回スコア証跡は`docs/ai/kaggle/biohub-lineages.json`に記録する |

- `alternate` の「次の系統」は UTC日付とregistryのanchorから決定する。履歴取得失敗時は推測せず、
  実提出をsafe skipする。
- `alternate` は共有 cap のため、当日そのコンペで（どちらの系統でも）すでに提出済みなら選ばれた系統も
  skip（冪等）。
- `both` の既定は2系統ぶん（=2提出/日）。`daily_submissions_per_lineage=2` のコンペは4提出/日で cap 5 に収まる。

## ガード（順位最優先・「基本は起案する」方針）

`runner-cli kaggle-improve-run`（engine = `src/lib/kaggleImprovement.ts`）は、起案を止めるガードを
**2つだけ**に絞る。それ以外は skip 理由にしない（＝当番枠なら基本的に毎回起案する）。

1. **active**: `registry.enabled && env KAGGLE_IMPROVE_ENABLED`（2段 kill switch）でなければ何もしない。
2. **前サイクル実行中ガード（唯一の抑制）**: 対象プロジェクトに現在 actionable（`Todo` / `In Progress`）な
   `auto-improve` 親 Issue があれば重複起案しない（プロジェクト毎に実行中は高々1本）。
   `In Review` を含む過去 Issue は次サイクルを妨げず、execute 時は Linear の現在状態で再確認する。

（撤廃済みのガード＝起案停止理由にしない: **新材料 / 測定不能 / worker cooldown / Issue cap** と、
全体日次上限ハードキャップ／「SOT-1904 提出ガード通過分だけ起案」制約。停滞・スコア低下も止めない。）

**Issue cap は「止める」代わりに「アーカイブして作る」**: `scripts/ai/kaggle_improvement_cycle.sh` が実起案
（`--execute`）の前に総 Issue 数を測り、`ISSUE_CAP_TRIGGER`（既定 245）以上なら
`archive_linear_issues.sh --execute`（親150/子50維持）でスペースを空けてから起案する（best-effort）。
registry の `issue_cap_guard` は engine の判定には使われない（歴史的フィールドとして保持）。

## `auto-improve` ラベル

cron が起案する親Issueには workspace ラベル **`auto-improve`** が付く（機械識別・緊急時の一括把握用）。
Linear で `label:auto-improve` 検索すれば、この自動化が作った全 Issue を一望できる。

## 起案Issueテンプレート（系統別 directive）

本文は `buildIssueBody`（`src/lib/kaggleImprovement.ts`）が決定的に生成する。要点:

```markdown
workers: <claude系: solo=claude:fable | gpt系: solo=codex:sol>, handoff=off
reasoning: <gpt系のみ: solo=ultra>

## 目的         Kaggleコンペ <slug>（repo/系統）の順位を向上させる方針を決定し子Issueに分解して実施
## 入力材料     ### 前回提出結果（順位/スコア） / ### 直近の完了Issueダイジェスト / ### 失敗ログ・KPI抜粋
## 実施内容     1. 未着手の改善軸を選定 2. 2〜5子Issueへ分解（screen→confirm・非昇格revert・昇格時exec互換）
               3. 全子完了後に親をTodoへ再開 4. 親が集約・提出して In Review にて完了報告
## 受け入れ条件  改善方針の記録 / 子Issue全て終端 / 昇格判定と champion 整合 / 完了時提出
```

このテンプレートは分解トリガー条件（複数独立軸・複数PR・逐次依存）を満たすので、task-check が
2〜5子Issueへ分解する（＝「plan が起案Issueを読んで順位向上子Issueを作る」要件）。
親Issueも分解まで同じAIが担当するsolo実行とする。子Issue本文にはClaude系なら
`workers: solo=claude:opus, handoff=off`、GPT系なら
`workers: solo=codex:gpt-5.6-sol, handoff=off` と `reasoning: solo=low` を必ず付ける。これにより、GPT系は
親Issueの方針検討・子Issue作成まではSol `ultra`、子Issueの実装・検証・GitHub・Linear報告はSol `low`へ
全周期で固定する。Claude系の子IssueはOpusへ固定する。

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

# 実起案を有効化する（提出は最終子Issueが実行）:
#   1) registry.enabled を true にする（scripts/ai/kaggle_targets_registry.json）
#   2) 下記コマンドで cron を実行モードで登録する
KAGGLE_IMPROVE_EXECUTE=1 KAGGLE_IMPROVE_ENABLED=1 bash scripts/ai/setup_cron.sh
```

改善サイクルは毎時起動され、`--only-scheduled` により当番 JST 枠だけを処理する。実起案は
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
bash scripts/ai/kaggle_targets_submit.sh --competition ptcg --hour 0

# 全8日次枠のdry-run（Kaggle履歴を読み、提出はしない）
for hour in 0 3 6 9 12 15 18 21; do
  bash scripts/ai/kaggle_improvement_cycle.sh --hour "$hour"
done
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
| 改善サイクル cron（起案のみ） | `scripts/ai/kaggle_improvement_cycle.sh` |
| artifact提出（再開された親Issueから呼ばれる／手動可） | `scripts/ai/kaggle_targets_submit.sh` |
| レジストリ（6コンペ×2系統） | `scripts/ai/kaggle_targets_registry.json` |
| cron 登録 | `scripts/ai/setup_cron.sh` |
</content>
