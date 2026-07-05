# Linear Issue Archive

Linear に登録されている Issue 数が上限に近づいた際に、Issue を親子分類してローカル退避・整理するスクリプトです。

## 使い方

### dry-run（確認のみ）

```bash
bash scripts/ai/archive_linear_issues.sh --dry-run
```

現在の Issue 数・分類・退避予定一覧を表示します。Linear は変更しません。

### 実行（アーカイブ）

```bash
bash scripts/ai/archive_linear_issues.sh --parent-target-count 150 --child-target-count 50 --execute
```

親 Issue・子 Issue をそれぞれ古い順にローカル保存してから Linear 側をアーカイブします。
親 Issue が 150 件、子 Issue が 50 件を超える場合のみ、超過分が整理対象になります。

### 自動実行 (auto-trigger)

autonomous runner (`scripts/ai/run_auto.sh`) は実行開始時に容量プリフライトを行う。
Linear のワークスペース上限（無料プランは 250 Issue）に達すると新規 Issue を追加でき
なくなるため、上限に近づいたら自動でアーカイブを実行して容量を確保する。

- 現在の総 Issue 数は `archive_linear_issues.sh --print-total`（整数のみ stdout 出力）で取得する。
- 総数が `ISSUE_CAP_TRIGGER`（環境変数・既定 `245`）以上なら「Issue を追加できない」と
  みなし、`archive_linear_issues.sh --execute` を自動実行して総数を 200 まで下げる。
- 250 に対し 245 を既定値とするのは、上限到達の直前に安全余裕を持って退避するため。
- `LINEAR_API_KEY` 未設定・件数取得失敗・アーカイブ失敗の場合は警告ログのみ出力し、
  run 自体は継続する（プリフライトで run を止めない）。

```bash
# 件数のみ取得（アーカイブしない）
bash scripts/ai/archive_linear_issues.sh --print-total

# トリガー閾値を変更して run
ISSUE_CAP_TRIGGER=240 ./scripts/ai/run_auto.sh
```

なお MCP `create_issue` が上限到達で失敗した場合の復旧フロー（アーカイブ後にリトライ）は
`CLAUDE.md` の Child Issue Registration Policy に定義している。

## 動作仕様

アーカイブは **親 Issue と子 Issue を独立した上限で** 判定する（総数一律ではない）。

- **親 Issue は 150 件以内**、**子 Issue は 50 件以内** に収める（`--parent-target-count` /
  `--child-target-count`、既定 150 / 50）。各カテゴリで上限を超えた **超過分のみ** を対象とする。
- 各カテゴリで **古い順（createdAt 昇順）** に退避する。新しい Issue が古い Issue より先に
  アーカイブされることはない。
- **In Progress（作業中）の Issue は退避対象から除外** する。容量プリフライトが処理中の
  子 Issue を巻き込む事故（SOT-1545 / SOT-1543）を防ぐため。
- ローカル保存に成功した Issue のみ Linear 側をアーカイブ
- 保存先: `.local/linear-issue-archive/<YYYY-MM-DD>/`
- `--total-target-count` は非推奨（後方互換のため引数は残るが選定には使用しない）。

## 保存ファイル構成

```
.local/linear-issue-archive/
  2026-06-12/
    children/
      SOT-xxx.json
      SOT-xxx.md
    parents/
      SOT-xxx.json
      SOT-xxx.md
    index.json
```

## 前提条件

- `.env` に `LINEAR_API_KEY` が設定されていること
- Python 3.x が利用可能であること
