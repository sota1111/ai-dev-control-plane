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

<!-- ここに上記テンプレートで1エントリずつ追記していく。最初の実エントリが入るまでは空。 -->
