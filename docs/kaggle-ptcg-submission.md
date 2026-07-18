# Pokémon TCG AI Battle の Kaggle CLI 提出手順

対象コンペは Simulation 部門の `pokemon-tcg-ai-battle`。Strategy / Hackathon 部門
（`pokemon-tcg-ai-battle-challenge-strategy`）へのレポート提出とは別である。

## 前提

- Kaggle の competition rules を承諾済みであること。
- `kaggle` CLI の認証が済んでいること（`KAGGLE_API_TOKEN` または
  `~/.kaggle/access_token`）。トークンはリポジトリやログへ記録しない。
- agent リポジトリに competition-use-only の `cg/` がセットアップ済みであること。
- 提出物のトップレベルに `main.py`、`deck.csv`、agent 実装、`cg/` が入ること。

認証と参加状態は、提出前に次で確認できる。

```bash
kaggle competitions list --search pokemon
kaggle competitions submissions -c pokemon-tcg-ai-battle
```

## 提出対象の決定

感覚ではなく、同一デッキ・先後交替の比較結果で戦術を選ぶ。SOT-1721 時点では、
25デッキ mirror-random の松竹梅 round-robin（各pairing N=96、計288戦、fault 0）で
松 MCTS が総合 152-40、勝率 0.792 と最上位だったため、`ptcg-agent-matsu` の
current champion と同リポジトリの `deck.csv` を採用した。

## ビルドとローカル検証

```bash
cd /workspaces/ptcg-agent-matsu
git status --short --branch
venv/bin/python -m unittest tests.test_submission
bash scripts/build_submission.sh
tar -tzf submission.tar.gz
sha256sum submission.tar.gz
```

`tar -tzf` で必要ファイルがトップレベルにあり、親ディレクトリで包まれていないことを
確認する。提出時に追跡できるよう、agent commit、deck SHA-256、archive SHA-256、
検証結果を Issue または提出メッセージへ残す。

## CLI 提出と受付確認

```bash
kaggle competitions submit pokemon-tcg-ai-battle \
  --file /workspaces/ptcg-agent-matsu/submission.tar.gz \
  --message "SOT-XXXX matsu champion MCTS; agent=<commit>; deck=<sha256-prefix>"

kaggle competitions submissions -c pokemon-tcg-ai-battle
```

`competitions submit` が成功しても評価完了とは限らない。直後の一覧で提出が登録された
ことを確認し、その後 `pending` から validation/scoring の状態へ進むことを追跡する。
Validation Error の場合は Kaggle の submission log を取得して原因を修正し、日次上限を
浪費しないようローカル検証後に再提出する。

## 運用上の注意

- Simulation 部門は提出回数と最終評価対象数に制約があるため、同一 artifact を重複提出しない。
- `cg/`、カードデータ、認証情報は competition-use-only / secret のため commit しない。
- 提出メッセージには秘密やローカル絶対パスを含めない。
- leaderboard のスコアは非同期で変化する。CLI受付、validation、score を区別して記録する。
