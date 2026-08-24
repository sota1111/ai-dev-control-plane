# Failure Log（運用失敗ログ・追記型）— SOT-1575

繰り返し起きた失敗を、単一の参照可能な時系列ログに集約する薄い層。**追記のみ**（過去エントリは書き換えない）。

## このファイルの役割と、他系統との分担

失敗情報は歴史的に3系統に分散していた。本ファイルはそれらを**リンクで束ねる時系列ログ**であり、
内容をコピーして重複管理しない。

| 系統 | 位置 | 役割 | 更新タイミング |
| --- | --- | --- | --- |
| **failure-log（本ファイル）** | `docs/ai/failure-log.md` | **運用ログ（時系列）**。起きた失敗を1行1エントリで生記録し、詳細調査へリンクする | 失敗に気づいた/対処した都度、追記 |
| `[OUTCOME]` 集計 | `docs/ai/auto_logs/auto_runner.log` → `scripts/ai/aggregate_outcomes.sh` | run 単位の成功/usage-limit/失敗**率**の機械集計。頻出 failure を**昇格候補**として提示 | 自動（run 毎にログ、集計は随時） |
| 調査ドキュメント | `docs/ai/investigations/*.md` | 1件の失敗の**深掘り調査**（再現・根本原因・実験） | 個別調査時 |
| **memory（昇格済の教訓）** | `~/.claude/.../memory/` + `MEMORY.md` | **昇格済**の恒久教訓（"don't re-investigate" 等）。次セッションが再調査/再失敗しないためのルール | 昇格が決まったとき |

**重複を避ける原則**: failure-log は「いつ・何が起きたか」の生ログ。深掘りは investigations へ**リンク**。
恒久化された教訓は memory / CLAUDE.md / harness-lint ルールへ**昇格**し、本ログの「昇格先」欄にその参照を書く。
同じ内容を2箇所に書かない。

## 昇格ワークフロー（半自動: 集計 → 候補提示 → 恒久化判断）

1. **集計** — `bash scripts/ai/aggregate_outcomes.sh 0 --promote`（`--threshold N` で閾値、既定3）。
   同種 failure（run の exit code をキーにグルーピング）が **N 回以上**なら「昇格候補」を出力する。
2. **記録** — 候補を本ファイルに1エントリ追記（下記テンプレ）。詳細調査があれば investigations へリンク。
3. **恒久化判断（人 / Claude）** — その失敗を繰り返さないための恒久対策を決め、**昇格先**を1つ選ぶ:
   - **memory**（`MEMORY.md` + memory ファイル）= セッションを跨ぐ教訓。
   - **CLAUDE.md ルール** = ハーネス運用の恒久ルール。
   - **harness-lint ルール** = 機械的に検出/防止できるチェック。
   昇格したら本エントリの「昇格先」欄にその参照（memory slug / CLAUDE.md の節 / lint ルール名）を記入する。

> 詳細は CLAUDE.md「Failure Log & 昇格ワークフロー」節も参照。

## エントリ・テンプレート（コピーして先頭に追記）

```markdown
### YYYY-MM-DD — <一言タイトル>
- **issue**: SOT-XXXX（複数可）
- **症状**: <観測された失敗。ログ行 / exit code / エラーメッセージ>
- **根本原因**: <特定できた真因。未特定なら「調査中」+ investigations へのリンク>
- **恒久対策**: <再発防止のために入れた/入れるべき対策>
- **昇格先**: memory:<slug> | CLAUDE.md:<節> | harness-lint:<ルール名> | （未昇格）
- **関連**: docs/ai/investigations/<file>.md / PR #NNN / commit <sha>
```

---

## 既存の調査ドキュメント（リンク・コピーしない）

- [SOT-1534 agy 認証エラー](investigations/SOT-1534-agy-auth-error.md)
- [SOT-1535 agy 認証 keyring](investigations/SOT-1535-agy-auth-error.md)
- [SOT-1536 agy 認証の永続化](investigations/SOT-1536-agy-auth-persistence.md)

---

## エントリ（新しいものを上に追記）

### 2026-08-08 — cron デーモン停止で Kaggle 自動起票が無言で全停止（registry を直しても起票されない）
- **issue**: Kaggle 定期起票（ptcg / agent-security 限定再開後）
- **症状**: registry を `enabled:true` + ptcg/agent-security pinned に正しく設定し dry-run も通ったのに、実際には全く起票されなかった。`docs/ai/auto_logs/kaggle_improve.jsonl` の最終実行が 2026-08-07T02:00Z（JST11）で以後停止、ログ mtime も 08-07 06:00 のまま（約1.5日 no-op）。
- **根本原因**: **cron デーモン自体が停止**（`ps aux | grep [c]ron` でプロセス無し）。crontab エントリ（`0 * * * * … kaggle_improvement_cycle.sh --only-scheduled --execute`）は登録済みだが、それを実行する daemon が落ちていた。devcontainer では cron は自動起動せず、コンテナ再起動やクラッシュで無言停止しうる。registry/コードをいくら直しても daemon が無ければ何も動かない。
- **恒久対策**: (1) `sudo service cron start` で復旧（`/usr/sbin/cron -P` 稼働確認）。(2) 落ちていた1.5日分を `bash scripts/ai/kaggle_improvement_cycle.sh --hour <H> --execute`（`--only-scheduled` 無し）で手動ブートストラップ（ptcg=hour0 / agent-security=hour6）→ SOT-2534..2537 起票。in-flight ガードで cron 再発火時も重複しない。(3) **cron 生存を webhook 同様に監視すべき**（自動起票が沈黙したらまず daemon 生存を疑う）。setup_cron.sh は `service cron status` を見て start するので、定期的な再実行 or ヘルスチェックが有効。
- **昇格先**: memory:rogii-medal-push-pause-other-autodrafting（限定再開の運用に cron 生存確認を追記）
- **関連**: crontab / scripts/ai/setup_cron.sh / docs/ai/auto_logs/kaggle_improve.{log,jsonl}

### 2026-08-08 — agent-security 全提出ERROR/未ランク・PTCG 維持で実LB低下（改善ループが実LBを見ていない）
- **issue**: agent-security-claude/gpt / ptcg-agent-claude/gpt（改善サイクル）
- **症状**: (a) **agent-security**: 全 Kaggle 提出が `SubmissionStatus.ERROR` または publicScore 0.000（07-31〜08-03）、sota1111 は 599 team の LB に**存在しない**＝一度も有効スコアなし。にもかかわらず cycle3-7 で数十子Issue がローカル `optimal_public`/OptimalGuardrail "faithful" 評価に非昇格判定を積んだ。(b) **PTCG**: 実 public が 570→505→502→492→481→468 と単調低下、なのに全 cycle が「non-promotion, champion maintained」。相対 rating comp で field 改善中の「維持」は実質後退。best 481.9=rank 5010/6574（下位24%）。
- **根本原因**: 改善ループの昇格判定が**ローカル proxy のみ**（agent-sec=faithful oracle / PTCG=elo_gauntlet の凍結内部field）で、**実LB（または提出が COMPLETE か）を一次シグナルにしていない**。rogii と同型の「local proxy を信じ実LBを見ない」欠陥が、agent-sec では提出が ERROR のまま気づかれず、PTCG では rating ドリフトを退行として検知できない形で発現。
- **恒久対策**: (1) 各サイクルの preflight に「**直近提出が COMPLETE かつ非ゼロ**」を必須化。ERROR/0.000 が続くコンペは新軸でなく **submit デバッグへ強制ピボット**。(2) rating/agent comp は**実LB順位トレンド**を一次監視に加え、順位低下＝退行として扱う（固定field R* 非劣化は昇格に不十分）。(3) SOT-2512 P1(検証階層) を rating/agent comp へ拡張し registry `validation` に submit-COMPLETE preflight と LB順位監視を足す。
- **昇格先**: memory:ptcg-agentsec-medal-gap-adversarial-review / （SOT-2512 の scope 拡張候補）
- **関連**: memory:agent-security-index / memory:kaggle-ptcg-ai-battle / SOT-2512（Kaggle起票CV一次化）

### 2026-07-25 — 子Issueが依存順に自動実装されない（In Review パーク）
- **issue**: SOT-1913（子 SOT-1932→{1933,1934}→1935）
- **症状**: 「実装を開始してください」後、依存順の先頭 SOT-1932 だけ実装/マージされ、残りは自動実装
  されず In Review に留まった。
- **根本原因**: 子Issueを In Review にパークしていたため、`fetchActiveIssues`（`name:{nin:["In Review"]}`）
  と `getIssueExecutionEligibility`（hold state）で自動対象外になり、そもそもキューに入らない。依存順
  トポロジカルソート（`queueOrdering.ts`）は enqueue 済み Todo/In Progress にしか効かないため未発火。
- **恒久対策**: 自動実装させたい子は **Todo + blockedBy** で登録する（In Review パーク禁止）。無効化は
  個々の status ではなく **system 全体の kill switch（default OFF）** で行う。cron の `createDraftIssue`
  は Todo で作成。運用ルールを docs に明記。
- **昇格先**: memory:child-issue-initial-status-todo（拡張）/ docs/kaggle-improvement-cycle.md「子Issueは Todo + blockedBy」節
- **関連**: docs/ai/investigations/SOT-1913-dependency-order.md / SOT-1933/1934/1935 実装

### 2026-08-12 — solo run 開始時に対象Issue自体がcap-archiveされLinear報告不能
- **issue**: SOT-2670（signate two-tier answer schema, solo=claude:opus）
- **症状**: 実装/検証/PR merge 完了後、`save_comment` が `Could not find referenced Issue`(400) で失敗。
  `save_issue`(state更新)は成功するが `archivedAt` が残存しコメント添付不可。
- **根本原因**: `run_auto.sh` 起動時の capacity preflight auto-archive が、対象Issueを In Progress 化する
  直前(08:12:26)にアーカイブ。Linear API はアーカイブ済Issueへの **comment 作成を拒否**（issue更新は許可）。
- **恒久対策**: solo/pipeline の Linear 報告前に `archivedAt` を確認し、アーカイブ済なら
  `scripts/ai/restore_linear_issues.py`（`issueUnarchive` mutation, `call_linear_api` 経由）で復元してから
  comment/state を反映する。preflight archive の In-Review 保護は既存だが「実行中の対象Issue」は未保護。
- **昇格先**: memory:cap-archive-swept-todo-children-0728（unarchive 手順を追記）
- **関連**: PR#186 / scripts/ai/archive_linear_issues.py の call_linear_api

### 2026-08-20 — nedo-loading完了駆動ループの直列ガード不全（ラベル未作成で二重起票）
- **issue**: SOT-2747 / SOT-2748（[NEDO-LOADING] 改善サイクル第1次/第2次）
- **症状**: cycle1 (SOT-2747) が未着手のまま 22分後に cycle2 (SOT-2748) が起票され、
  「前サイクル: SOT-2747（申し送りを必ず読むこと）」が虚偽参照に。
- **根本原因**: `nedo_loading_cycle_draft.ts` の直列ガード `findOpenCycleIssue` は
  ラベル `nedo-loading-cycle` でフィルタするが、**該当ラベルが Linear workspace に存在せず**、
  起票時のラベル付与が無言で失敗 → ガードが open cycle を永遠に検知できない。
- **恒久対策**: SOT-2748 実行中に team ラベル `nedo-loading-cycle` を作成し SOT-2748 へ付与
  （以後の起票はラベル付与が成功する前提で直列ガード有効）。SOT-2747 は duplicate として Canceled。
  drafter 側は「ラベル作成に失敗/未存在なら起票を abort する」ガードを入れるのが望ましい（未実装）。
- **昇格先**: memory:nedo-loading-algo-screening-prep（cycle2記録に追記）
- **関連**: scripts/ai/nedo_loading_cycle_draft.ts (PR#395)

## 2026-08-20 SOT-2764 二重solo並走（自動キューの再dispatch）
- **issue**: SOT-2764（nedo-loading cycle6 統合フェーズ）
- **症状**: 14:00起動のsolo run（統合評価実行中・生存）が inflight.json 非登録=追跡外のまま、14:32に自動キューが同一issueを再drainし二重soloが並走（lane lockは新run側が取得）。
- **根本原因**: 14:00 runの起動経路がinflight登録を経ておらず、キューのserialガードが「実行中」と認識できなかった（詳細未診断: cronリコンサイラの親再開→run起動経路とキューdrainの追跡不整合）。
- **恒久対策（暫定運用ルール）**: solo worker は起動時に同一issueの既存workerプロセスを必ず ps で確認。追跡（inflight/lane lock）保持側を正とし、旧チェーンは run_auto〜claude をまとめてSIGKILL（handoff=onの次worker起動・EXIT trapを発火させない）、nohup計算ジョブは接収。二重提出はsha256ガード＋submission_logで検証。要恒久修正: 全run起動経路のinflight登録一元化。
- **昇格先**: memory `solo-double-dispatch-takeover-gotcha`

## 2026-08-20 SOT-2764 正当な完了Doneをpremature-Done修復が差し戻し→完了駆動ループ膠着
- **issue**: SOT-2764（nedo-loading cycle6）
- **症状**: 統合フェーズ完了（PR#13マージ・台帳cycle6行・完了報告 16:00:52）後、16:00:29 の Done 遷移を
  webhook の repairPrematureDone が「autonomous run is active」と判定して In Review へ差し戻し。以後
  (a) キューからは 16:00:31 に removed（hold state）、(b) リコンサイラは RESUME_MARKER 既存のためスキップ、
  (c) auto-accept の再実行機会も無く、**どの機構も再昇格させない膠着**。完了駆動ドラフタの直列ガードは
  In Review を「進行中」と見るため cycle7 が永久に起票されない（30分停滞後に人間の質問で発覚）。
- **根本原因**: 直前の二重solo並走（上記エントリ）の残骸で「run実行中」追跡が残っており、正当な完了昇格を
  premature 扱いした。wasRecentlyAutoAccepted の保護が効かない経路（別プロセス/タイミング）だった可能性。
- **恒久対策（暫定）**: 完了エビデンス（完了報告コメント・PR・台帳）を検証の上、手動で Done へ再昇格
  （16:32 実施・差し戻し再発なしを監視で確認）。要恒久修正: (1) repairPrematureDone は完了報告コメント
  （## Completion Report）付き Done を差し戻さない、(2) リコンサイラに「In Review×全子完了×完了報告済み→
  auto-accept 再試行」の再昇格パスを追加、のいずれか。
- **昇格先**: memory:nedo-loading-algo-screening-prep（gotcha追記）

## 2026-08-20 SOT-2800 solo 二重(三重)dispatch — 共有working tree相互clobber
- issue: SOT-2800 (personal-child-context-agent, target repo)
- 症状: 単一 webhook runner が同一 issue へ run_auto を複数spawn。複数 solo claude が共有 `/workspaces/<repo>` を並走し config.py を相互上書き(重複 dataclass field→ruff F811)。document_tool.py が peer に元へ revert される事象も。
- 根本原因: runner の同一issue再dispatchガード(inflight/lane lock)が実装系 target repo で貫通し、複数 run_auto が同時稼働。
- 恒久対策: 検知時は canonicity 判定より **隔離 git worktree(`/tmp/<repo>-<issue>` from origin/main)で自成果を再適用→全緑→push/PR直前に競合(ls-remote/gh pr list)再確認→単一PRでmerge→worktree撤去**。peer kill不要で最も安全に単一PRへ収束。
- 昇格先: memory [[solo-double-dispatch-takeover-gotcha]](二報を追記) / 制御プレーン側の再dispatchガード修正は別途要検討

## 2026-08-21 SOT-2854 提出枠回復待ちのholdループでサイクル進行が~10h停止
- **issue**: SOT-2854（nedo-loading cycle8 統合フェーズ）
- **症状**: 全子完了・候補パッケージ済みなのに、worker（fable→usage limitでcodexへhandoff）が「JST 08-22 00:00の枠回復まで95分チャンクでsleepして提出する」holdループに入り、レーンロックを保持したままサイクルが停止。ローカル改善も止まった（ユーザー指摘で発覚）。
- **根本原因**: テンプレの「提出予算を使い切る」指示に対し、枠が無い場合の分岐（pending化して完了する）が未定義で、workerが「枠回復を待つ」を安全側と誤解した。
- **恒久対策**: PR#407 — 枠が無ければ `pending_submissions.jsonl` へ記録して即サイクル完了（hold/sleepでの枠待ちを明文で禁止）＋各サイクル冒頭の手順0で枠があればpendingベストを消化。復旧はSOT-2854へnewest-winsコメント→worker長期sleep中で非反応→確立手順どおり停止チェーンをSIGKILL（ロック解放確認）→キュー再dispatchで新workerがコメントを読んで完了処理。
- **昇格先**: memory:nedo-loading-algo-screening-prep（枠待ち禁止の項）

## 2026-08-22 nedo-loading 「改善しながら間違った路線を登る」を10サイクル検知できず
- **issue**: nedo-loading cycle2〜10（システム全体の判断欠陥）
- **症状**: LB上位に「4提出で64点」「18提出で68.35点」の少数提出高得点が存在（=上位帯は正しいアーキテクチャの初期値であり、~85%の途中終了は系統的な妥当性違反の疑い）にもかかわらず、通過ライン差32点に対して漸進チューニング（クリアランス・順序探索近傍・move比率）を積み続けた。人間の指摘で発覚。
- **根本原因**: (1) momentumバイアス — plateau/oracle-driftは停滞時にしか発火せず、毎サイクル改善が出ている限り警報ゼロ。「改善の存在」が「路線の正しさ」に化けた。(2) 競合構造の解釈規則の欠如 — 上位者の提出数は記録済みだったのに「少数提出高得点⇒漸進では埋まらない構造差」と読む規則がなかった。(3) gap-to-cutoff(32点)は記録されるだけで、どの機構も行動へ変換しなかった。
- **恒久対策**: PR#416 — 構造ギャップ・バナー（`deriveStructuralGapSignal`: cutoff−実LBベスト≥10で発火、few_shot_evidenceで強化）。掲出中は毎サイクル「構造仮説の検証」必須・漸進軸のみのサイクル禁止。戦略面はSOT-2913へnewest-winsで「never-NG完走保証policyへの再設計」を注入、cycle9 bestは基準線として提出済み(sha 2f7274c9…)。
- **昇格先**: memory:nedo-loading-algo-screening-prep（構造ギャップの項）・本質は[[autonomous-cycle-optimized-wrong-oracle]]と同族（自己参照の進捗指標を盲信し外部真値との構造差を見ない）
