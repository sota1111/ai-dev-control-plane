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
