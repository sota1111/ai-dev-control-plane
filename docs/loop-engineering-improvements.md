# Loop Engineering 性能改善提案 (SOT-1556)

> PLAN 成果物。最新の "loop engineering" 議論（Peter Steinberger / Addy Osmani / Boris Cherny,
> 2026年6月）を、この repo（ai-dev-control-plane）の実装に接地させた **性能改善提案**。
> 本ドキュメントは提案であり、実装は承認後に個別 Issue へ分割する。

## 0. 要約（TL;DR）

「エージェントにプロンプトを打つ人」ではなく「打つループの方を設計する」という loop engineering の
核に対し、この repo は既に doer/checker 分離・外部メモリ・自動起動を備えた教科書的実装になっている。
研究が示す残りのレバーは 3 つで、優先度順に:

| # | レバー | 期待効果 | 主対象 | 優先度 |
| --- | --- | --- | --- | --- |
| 1 | 検証をループの心臓に（別コンテキスト完了判定 + 実動作検証） | 品質 2〜3× | acceptance/verification ロール | ★★★ 最優先 |
| 2 | サーキットブレーカー／停止条件の明示化 | 無人運転の暴走コスト防止 | `run_auto.sh` | ★★★ 最優先（安全） |
| 3 | worktree による真の並列隔離 | multi-repo/並列スループット | runner lane 実装 | ★★ 中 |

1 と 2 は「即効・低リスク・小差分」で先に入れる価値が高い。3 は効果は大きいが実装量とリスクも大きい
ため段階導入する。

---

## 1. 現状マッピング（Osmani 5 ブロック + worktrees）

Osmani のフレームワークにこの repo の実体を対応付ける。★=強み、△=改善余地。

| Osmani 構成要素 | この repo の実装 | 評価 |
| --- | --- | --- |
| Automations（起動・discovery/triage） | `scripts/ai/scheduler.sh` ポーリング + `webhook-server.ts` イベント駆動 + runner queue | ★ 強い |
| Sub-agents（doer/checker 分離） | `config/worker_roles.json` の役割別チェーン（実装=Antigravity / 検証=Codex / 判断=Claude） | ★ 最大の強み |
| External memory | Linear=状態の真実源、GitHub=成果物、`docs/ai/*` 中間レポート | ★ Osmani がまさに例示する形 |
| Connectors（MCP） | `.mcp.json` の Linear MCP ほか | ○ |
| Skills | `CLAUDE.md` / `prompts/roles/*.md` | △ 改善余地 |
| Worktrees（並列隔離） | `runnerLock.ts` の default/lane ロック + `laneNotifier.ts` detach 実行 | △ 改善余地（ロックで直列化） |

**含意**: 弱点は Skills の体系化と Worktrees の隔離。だが研究が「品質の単一最大要因」と呼ぶのは
検証ループなので、まずそこに投資する（レバー1）。

---

## 2. レバー(1) 検証をループの心臓に据える — 最大レバレッジ

### 現状
- 品質ゲートは `run_auto.sh` の lint/typecheck/test（`## Quality Gate`）と、verification ロール
  （既定 Codex）が担う。停止判定は各ワーカーが自身のレポートに書く `## Next Action` 行を
  `run_auto.sh:300` 付近が grep して駆動する。
- `## Implementation: NOT_REQUIRED`（SOT-1555）では残りロールが **同一ワーカーに固定** される。
  これは prompt-cache の観点では良いが、「完了判定を別コンテキスト・別モデルで行う」という
  loop engineering の原則とは緊張関係にある（doer 自身が採点しうる）。

### 提案
1. **完了判定の doer/checker 分離を明文化する（低リスク・高効果）**
   acceptance ロールは、直前に実装したワーカーとは **別ワーカー／別セッション** で走ることを既定にする。
   `worker_roles.json` の `acceptance` チェーンを実装チェーンと意図的に食い違わせ（例: implementation が
   codex の回は acceptance を claude 先頭に）、SOT-1555 の NOT_REQUIRED ピン留めは
   「非コード生成タスク（DOC/REVIEW/PLAN 等）」に限定して、コードを構築した IMPLEMENT/FIX/DEBUG では
   acceptance を別コンテキストに保つ。
   - 対象: `config/worker_roles.json`, `src/lib/workerRoles.ts`, `run_auto.sh` のピン留め条件。
   - リスク: 小。cache 温度は下がるが品質が主目的。

2. **acceptance を "テスト pass" から "実ユーザー動作検証" へ拡張する（中リスク・高効果）**
   現行 acceptance はレポート整合の確認が中心。これを、UI を持つ target repo では実際に動かして
   確認するレベルへ引き上げる:
   - 既存 `snapshot` ラベル導線（CLAUDE.md）と e2e/Playwright モックハーネスを acceptance ロールの
     標準ステップに組み込み、after スクリーンショット取得＋主要導線の E2E を「受け入れ条件の証跡」として要求。
   - バックエンド/ライブラリは E2E 不要。UI を持つ repo のみ発火（`docs/screenshots/` の有無や repo 種別で判定）。
   - 対象: `prompts/roles/acceptance.md`, `prompts/roles/verification.md`, `docs/ai/70_acceptance_check.md` の様式。
   - リスク: 中（実行時間増）。レバー2の実時間上限で暴走は抑える。

3. **受け入れ判定の機械可読化**
   acceptance レポートに `## Acceptance: PASS|FAIL`（criteria 単位の [x]/[ ]）を必須化し、
   `run_auto.sh` のゲートがそれを直接読む。曖昧な自然文完了宣言を排除する。

---

## 3. レバー(2) サーキットブレーカー／停止条件の明示化 — 安全最優先

### 現状
- `run_auto.sh` は `PIPELINE_MAX_DEBUG_CYCLES`（既定 2, `run_auto.sh:258`）で debug ループを bound。
- usage-limit resume（`docs/usage-limit-and-resume.md`）と cooldown（`run_codex.sh` の account-global
  cooldown）で使用上限には対応済み。
- しかし「**実時間の絶対上限**」「**連続失敗ブレーカー**」「**issue 単位のトークン/コスト予算**」
  「**no-progress 検知**」は無い。明示的終了ロジックのないループは最も高コストな失敗モード。

### 提案（小差分で段階導入。既定は現行挙動を変えない値に）
新設 `config/circuit_breaker.json`（`incident_response.json` と同じ best-effort/既定安全の流儀）で束ねる:

| ノブ | 意味 | 既定 |
| --- | --- | --- |
| `max_runtime_min` | issue パイプライン1本の実時間上限（トークンと独立）。超過で安全停止＋Linear通知 | 例 90（無効化=0） |
| `max_consecutive_failures` | 同一ロールの連続 NEEDS_DEBUG/exit≠0 上限。超過で（更新起因のみ）ロールバック＋通知 | 3 |
| `issue_token_budget` | issue 単位の概算トークン/コスト上限。超過で停止＋通知 | 0=無効 |
| `no_progress` | 直近 N サイクルで diff/commit・レポート差分が無ければ停止 | 2 |

- 実装は `run_auto.sh` のロール駆動ループ（`run_auto.sh:300`〜`:360`）に「1ループごとに開始時刻・
  連続失敗数・直近レポートハッシュを見るガード」を挿入。判定不能はフェイルセーフで **停止側** に倒す。
- 純粋ロジック（経過分の算出、連続失敗カウント、no-progress 判定）は `src/lib/circuitBreaker.ts` に
  切り出して単体テスト（incidentResponse.ts と同型）。shell は薄い tsx CLI 経由で呼ぶ。
- 既存 `PIPELINE_MAX_DEBUG_CYCLES` はこのブレーカー群の1つとして整理し、usage-limit resume/cooldown
  とは独立（resume は「上限で中断→続きから」、ブレーカーは「異常で止める」で役割が違う点を doc 明記）。
- 通知は Linear コメント（唯一の報告経路）+ 既存 `laneNotifier.ts` の Discord を再利用。
- 対象: `scripts/ai/run_auto.sh`, `config/circuit_breaker.json`(新), `src/lib/circuitBreaker.ts`(新) + test。
- リスク: 小（既定値を現行到達しない緩さにすれば no-op から始められる）。

---

## 4. レバー(3) worktree による真の並列隔離

### 現状
- 並列は `runnerLock.ts` の default ロック + lane ロック（SOT-933 の N-slot pool）+ `laneNotifier.ts` の
  detach 実行で表現。だが同一 repo/branch では **グローバルロックが全実行を直列化** する既知問題があり、
  lane はレポート/prompt ファイルの衝突回避（`run_codex.sh` の `lane_path`）にとどまる。
- CLAUDE.md の並列方針: writes（実装/git/PR）は single-lane、lane 並列は **異なる repo 間のみ**許可。

### 提案（段階導入）
1. **git worktree ベースの作業ディレクトリ隔離**
   各 lane/issue に `git worktree add ../wt/<issue-id> <branch>` で専用作業ツリーを与え、
   同一 repo でも別ディレクトリで並列作業させ、ファイル衝突とインデックス競合を構造的に排除する。
   完了・失敗時に `git worktree remove` でクリーンアップ（変更なしなら自動削除）。
2. **ロックの粒度を下げる**
   「repo 全体の直列化」から「worktree（=branch）単位の直列化」へ。異なる issue/branch は並列可、
   同一 branch は従来通り直列。`runnerLock.ts` のロックキーを repo → worktree パスに拡張。
3. **段階導入**: まず read-only 調査 lane を worktree 化（低リスク）、次に単一 repo 内の複数 issue の
   実装 lane へ拡大。CLAUDE.md の「same repo/branch は serial」規則は branch 単位に緩める形で更新。
   - 対象: runner lane 生成箇所, `src/lib/runnerLock.ts`, `laneNotifier.ts`, CLAUDE.md 並列方針節。
   - リスク: 中〜大（ディスク・クリーンアップ・ロック意味論の変更）。効果は multi-repo/多 issue 時に最大。

---

## 5. 追加（研究の副次示唆・任意）

- **Skills の体系化（Osmani の弱点△）**: `prompts/roles/*` と CLAUDE.md に散る手順を、再利用可能な
  「skill」単位（例: snapshot 取得, Linear 同期, issue 分解）へ切り出すと、ループの各ステップが
  差し替え可能になり保守性が上がる。効果は中・緊急度は低。

---

## 6. 推奨導入順（ロードマップ）

1. **P1（即効・低リスク）**: レバー2のサーキットブレーカー骨組み（純粋ロジック+単体テスト+既定 no-op 値）
   と、レバー1の「acceptance の completion を機械可読 PASS/FAIL 化 + doer/checker 分離明文化」。
2. **P2（高効果・中リスク）**: レバー1の実ユーザー動作検証（snapshot/E2E）を UI repo の acceptance に統合。
3. **P3（構造改善・中大リスク）**: レバー3の worktree 隔離を read-only lane → 実装 lane へ段階導入。

各項目は本 PLAN 承認後に個別 Issue へ分割し、実装 Issue として PR→merge のフローに載せる。

---

## 参考
- Issue 本文（SOT-1556）に引用の Steinberger / Osmani "Loop Engineering" / Cherny の各主張。
- repo 実体: `scripts/ai/run_auto.sh`, `config/worker_roles.json`, `src/lib/runnerLock.ts`,
  `src/lib/laneNotifier.ts`, `prompts/roles/*.md`, `docs/usage-limit-and-resume.md`, `docs/scheduler.md`。
