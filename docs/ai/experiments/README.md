# SOT-1531 worker性能比較 — 実験キット

このディレクトリは、`docs/ai/20_design.md`(計画)を**実行可能な形**にした最小キットです。
「3つの worker(claude / codex / antigravity)で簡単なベンチマークを1件実行し、評価する」ための
再現可能なタスク定義・結果表・採点ツールをまとめます。

## 構成
- `tasks/T4-doc.md` — 最も簡単で再現可能なベンチマークタスク1件(DOC種別)の固定仕様。
- `SOT-1531-results.md` — 実行結果の記録表(run×worker×M1–M8×合成スコア)。
- `../../../src/lib/benchmarkScore.ts` — 記録した M1–M8 から合成スコアを算出する純粋関数
  (`scoreBenchmarkRun`)＋decomposition ルーブリック採点(`scoreDecompositionRubric`)。
  → **後から**メトリクスを埋めて再計算・再評価できる(要求「後から評価できるように」を満たす中核)。
- `SOT-1531-analysis.md` — ベンチマーク実施後のシステム改善点洗い出し＋評価方法の見直し。

## 実行手順(オーケストレータが実施)
ベンチマークの実 run は worker 実ディスパッチ(`run_worker.sh`)を伴うため、**制約付きワーカーでは実行できず、
オーケストレータ側で行う**(`run_benchmark.sh` は `RUN_WORKER_DISPATCH=1` のとき自身を拒否する)。

### 推奨: `scripts/ai/run_benchmark.sh`(1コマンドで3 worker を直列実行＋M4/M5/M6 自動採取)
固定タスクを1つの role で回し、worker だけを入れ替えて metrics JSON を出力する:
```bash
# prompts/roles/implementation.md に固定タスク(T4-doc の課題文)を書いてから:
scripts/ai/run_benchmark.sh \
  --repo /workspaces/window-runner \
  --role implementation \
  --workers "claude codex antigravity" \
  --sha <FIXED_SHA> --reset \
  --task T4-doc
# → docs/ai/auto_logs/metrics/benchmark-<ts>.json に
#    run 毎の {exitCode, m1GatePass, m4DurationMs, m5Interruptions, m6Diff{files,ins,del}, reportPath}
```
`--reset` は対象リポを固定 SHA に戻す(破壊的なので opt-in)。未指定時はクリーンな作業ツリーを要求する。
自動採取できない M2(受入充足率)・M8(定性)はレポートを読んで手採点し、`scoreBenchmarkRun()` に渡す。

### 代替: 手動ディスパッチ / Linear ディレクティブ
```bash
WORKER_ROLES_FILE=<claude固定> TARGET_REPO=<fixed> scripts/ai/run_worker.sh implementation   # worker=claude
WORKER_ROLES_FILE=<codex固定>  TARGET_REPO=<fixed> scripts/ai/run_worker.sh implementation   # worker=codex
WORKER_ROLES_FILE=<agy固定>    TARGET_REPO=<fixed> scripts/ai/run_worker.sh implementation   # worker=antigravity
```
または Linear ディレクティブ(1 Issue 単位、newest wins): `workers: implementation=claude` 等。

各 run 後、metrics JSON(または `git diff --stat`・`docs/ai/auto_logs/` タイムスタンプ・handoff 数)から
M1–M8 を `SOT-1531-results.md` に記入 → `scoreBenchmarkRun()` で合成スコアを算出して表に反映。

## スコア再計算(いつでも)
```bash
node --input-type=module -e "
import { scoreBenchmarkRun } from './src/lib/benchmarkScore.ts';
console.log(scoreBenchmarkRun({ m1GatePassed:true, m2AcceptanceRate:1, m3DebugCycles:0,
  m4DurationMs:600000, m5Interruptions:0, m6DiffAppropriate:true, m7HumanIntervention:false, m8Quality:4 }));
"
```
(TS 直実行は `tsx` 経由。CI/verification では jest 経由で `src/__tests__/benchmarkScore.test.ts` が回る。)
