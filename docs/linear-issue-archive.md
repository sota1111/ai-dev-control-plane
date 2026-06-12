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
bash scripts/ai/archive_linear_issues.sh --parent-target-count 150 --execute
```

子 Issue を古い順にローカル保存してから Linear 側をアーカイブします。
親 Issue が 150 件を超える場合のみ、親 Issue も整理対象になります。

## 動作仕様

- 子 Issue（parent が設定されている Issue）を古い順に退避対象とする
- 親 Issue は 150 件以下の場合、整理対象にしない
- ローカル保存に成功した Issue のみ Linear 側をアーカイブ
- 保存先: `.local/linear-issue-archive/<YYYY-MM-DD>/`

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
