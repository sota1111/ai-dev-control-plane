# 4. 提出ツールと落とし穴

Kaggle/SIGNATE CLI・認証・提出まわりの実務ハマりどころ（実測済み）。

## T1. Kaggle 認証（KGAT / Bearer トークン）
- Kaggle CLI 2.2.4 は basic auth（username+key）だが、ローテーションされた **`KGAT_` トークンは Bearer 必須**。
  basic で投げると 401。
- 対策: トークンを `~/.kaggle/access_token` に書く（`kagglesdk` の `get_access_token_from_env` が
  `KAGGLE_API_TOKEN` env → `~/.kaggle/access_token` ファイルの順で読む）。`chmod 600`。
- kaggle CLI 一般: `KAGGLE_KEY=$KAGGLE_API_TOKEN` が要る場面がある（kaggriculture cycle2 実測）。

## T2. 提出の帰属マーカー
- 複数 repo/lineage が同一 Kaggle チームで提出するため、description に
  **`[repo:<name>] [lineage:<claude|gpt>]`** を必ず付ける。
- 材料収集（`submissionRowsForRepo`）はこのマーカーで自分の提出を絞る。**マーカー無し提出は帰属漏れ**で
  best スコアの取り違えを起こす（rogii で cron が best=8.739 と誤認 → 単一ターゲットは unmarked も
  credit する `singleTarget` 修正済み。だが**付けるのが正**）。

## T3. 提出スクリプトの dedup 誤爆
- `kaggle_targets_submit.sh` は可視 submission.csv を fingerprint して重複提出を弾く。
  **hidden path だけ変えて可視が不変**だと誤って dedup される。
- 回避: 直接 `kaggle competitions submit -c <comp> -k <kernel> -v <ver> -f submission.csv -m "..."`。
- **重要**: `kaggle_targets_submit.sh --execute` が registry の**古い champion**（例: rogii v8 LB8.739）を
  指したままだと、regression の再提出になる。registry champion を更新せずに --execute しない。

## T4. カーネル push → 提出のフロー
- 新提出は: `kaggle kernels push` → `COMPLETE` を待つ → registry bump → submit。
  **push 出力の version がauthoritative**（ローカルの想定 version とズレることがある）。
- `gh pr merge` がローカルで fatal（別 worktree に main がある等）でも **GitHub 側はマージ成功**していることがある。
  ローカルエラーだけで失敗と即断しない（GitHub を確認）。

## T5. GPU セッション / 日次提出上限
- 同時 GPU push は 2 枠（[ランタイム C6](02-code-competition-runtime.md)）。
- 日次提出上限あり（ROGII 5/日）。**締切当日は枠配分を計画**し、採点(数時間)を織り込む。
- 締切ギリギリ提出は「採点が締切後」になり最終選抜に含まれないことがある。**枠を1つ最後まで残し、
  drop-dead タイマー**で無条件提出する運用（rogii で実施）。

## T6. 提出 CSV の形式
- SIGNATE 実測: **CSV フィールド内の ASCII カンマは "引用" 必須**。未引用だと**無警告で未採点**（枠は消費されない）。
- Kaggle: `id,tvt` 等ヘッダ厳守、sample_submission の id 順・件数と一致させる（欠損 id で採点拒否）。
- リーダーボード CSV のパース: ヘッダ行が小文字 `score`、先頭に "Next Page Token" 等の前置き行が入ることがある。

## T7. importlib での動的実行
- Code コンペで `importlib.util` から exec_module する場合、**exec_module の前に
  `sys.modules[spec.name] = module`** を登録しないと dataclass 等で失敗する。

## チェックリスト
- [ ] 認証はトークン種別に合った方式（KGAT→Bearer→access_token ファイル）
- [ ] 提出 description に `[repo:] [lineage:]` マーカー
- [ ] registry champion が最新か（古いまま --execute しない）
- [ ] CSV は id 順・件数一致・カンマ引用
- [ ] 最終枠を残し drop-dead タイマーで確実に提出
